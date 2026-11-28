import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { makeHookRoute, HOOK_PATH } from "../../src/fireflies/route.js";
import { sign } from "../../src/fireflies/signature.js";
import { HOOKS_PATH } from "../../src/setup/plan.js";
import { logger } from "../../src/log/logger.js";
import { API_KEY, HOOK, SECRET, createFakeClient, createFakeFirefliesStore, transcript } from "./fakes.js";

function world(meetings = { MEET01: transcript("MEET01") }) {
  const fake = createFakeFirefliesStore();
  const ff = createFakeClient(meetings);
  const pending: Promise<unknown>[] = [];
  const app = new Hono();
  app.route(HOOK_PATH, makeHookRoute(() => ({ store: fake.store, client: ff.client, background: (p) => pending.push(p) })));
  const post = async (body: string, signature: string | null, hook = HOOK) => {
    const res = await app.request(`${HOOK_PATH}/${hook}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(signature !== null ? { "X-Hub-Signature": signature } : {}) },
      body,
    });
    await Promise.all(pending.splice(0));
    return res;
  };
  return { fake, ff, post };
}

const v2 = (id: string, event = "meeting.summarized", extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event, timestamp: 1_795_000_000_000, meeting_id: id, ...extra });
const signed = (body: string, secret = SECRET) => `sha256=${sign(new TextEncoder().encode(body), secret)}`;

afterEach(() => vi.restoreAllMocks());

describe("POST /hooks/fireflies/<id>: the signature is the only check", () => {
  it("accepts a V2 signature (sha256=<hex>) and stores the meeting", async () => {
    const w = world();
    const body = v2("MEET01");
    const res = await w.post(body, signed(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, fetch: true });
    expect(w.fake.items.get("MEET01")).toHaveLength(1);
    expect(w.fake.deliveries.get("MEET01")?.status).toBe("done");
  });

  it("accepts the legacy bare-hex signature and the V1 payload", async () => {
    const w = world();
    const body = JSON.stringify({ meetingId: "MEET01", eventType: "Transcription completed" });
    const res = await w.post(body, sign(new TextEncoder().encode(body), SECRET));
    expect(res.status).toBe(200);
    expect(w.fake.items.get("MEET01")).toHaveLength(1);
  });

  it("refuses a missing, wrong or malformed signature with 401 and fetches nothing", async () => {
    const w = world();
    const body = v2("MEET01");
    for (const sig of [null, "", "sha256=", signed(body, "f".repeat(32)), `sha1=${"a".repeat(40)}`, signed(`${body} `), "sha256=zz"]) {
      const res = await w.post(body, sig);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toMatch(/secret|signature/i);
    }
    expect(w.ff.calls).toHaveLength(0);
    expect(w.fake.calls.some((c) => c.fn === "seen" || c.fn === "begin")).toBe(false);
  });

  it("signs the RAW bytes: the same JSON re-spaced fails", async () => {
    const w = world();
    const body = v2("MEET01");
    const respaced = JSON.stringify(JSON.parse(body), null, 2);
    expect((await w.post(respaced, signed(body))).status).toBe(401);
  });

  it("gives an unknown or malformed webhook id the same 401 as a bad signature", async () => {
    const w = world();
    const body = v2("MEET01");
    expect((await w.post(body, signed(body), "z".repeat(32))).status).toBe(401);
    expect((await w.post(body, signed(body), "short")).status).toBe(401);
    expect(w.fake.calls.filter((c) => c.fn === "lookup")).toHaveLength(1); // the malformed id never reaches the database
  });

  it("answers 503 (Fireflies retries) when the database cannot be read", async () => {
    const w = world();
    w.fake.failLookup();
    const body = v2("MEET01");
    expect((await w.post(body, signed(body))).status).toBe(503);
  });

  it("refuses a body that is not a JSON object", async () => {
    const w = world();
    expect((await w.post("[1,2]", signed("[1,2]"))).status).toBe(400);
  });
});

describe("deliveries: replays, duplicates, events", () => {
  it("stores the same meeting once when Fireflies delivers it twice", async () => {
    const w = world();
    const body = v2("MEET01");
    await w.post(body, signed(body));
    const again = await w.post(body, signed(body));
    expect(await again.json()).toEqual({ ok: true, fetch: false, duplicate: true });
    expect(w.ff.calls.filter((c) => c.fn === "meeting")).toHaveLength(1);
    expect(w.fake.items.get("MEET01")).toHaveLength(1);
  });

  it("fetches again for a newer re-send (reprocessed_at); the same text stays one version", async () => {
    const w = world();
    const first = v2("MEET01");
    await w.post(first, signed(first));
    const resend = v2("MEET01", "meeting.summarized", { reprocessed_at: 1_795_000_100_000 });
    expect(await (await w.post(resend, signed(resend))).json()).toEqual({ ok: true, fetch: true });
    expect(w.ff.calls.filter((c) => c.fn === "meeting")).toHaveLength(2);
    expect(w.fake.items.get("MEET01")).toHaveLength(1);
  });

  it("marks the webhook working on a test or a bot join, and fetches nothing for them", async () => {
    const w = world();
    const bot = v2("MEET01", "meeting.bot_joined");
    expect(await (await w.post(bot, signed(bot))).json()).toEqual({ ok: true, fetch: false });
    const odd = JSON.stringify({ event: "test" });
    expect((await w.post(odd, signed(odd))).status).toBe(200);
    expect(w.fake.calls.filter((c) => c.fn === "seen")).toHaveLength(2);
    expect(w.ff.calls).toHaveLength(0);
  });

  it("a test meeting id Fireflies does not know is not_found, not a missed meeting", async () => {
    const w = world();
    const body = v2("TESTID1");
    expect((await w.post(body, signed(body))).status).toBe(200);
    expect(w.fake.deliveries.get("TESTID1")?.status).toBe("not_found");
  });
});

describe("the owner's rules decide", () => {
  it("keeps a meeting a rule includes and leaves out one it does not (nothing stored)", async () => {
    const w = world({
      MEET01: transcript("MEET01"),
      MEET02: transcript("MEET02", { participants: ["lee@other.example"], meeting_attendees: [] }),
    });
    for (const id of ["MEET01", "MEET02"]) {
      const body = v2(id);
      await w.post(body, signed(body));
    }
    expect(w.fake.items.has("MEET01")).toBe(true);
    expect(w.fake.items.has("MEET02")).toBe(false);
    expect(w.fake.deliveries.get("MEET02")?.status).toBe("done");
    const item = w.fake.calls.find((c) => c.fn === "record")?.args[1] as { provider: { participants: string[]; channel_ids: string[] } };
    expect(item.provider).toMatchObject({ meeting_id: "MEET01", participants: ["pat@acme.example", "ann@meet.example"], channel_ids: ["chan-1"] });
    // A delivery can never name a topic or an owner.
    expect(item).not.toHaveProperty("topics");
    expect(item).not.toHaveProperty("owner");
  });

  it("a failed fetch is recorded as missed with a reason code, not lost", async () => {
    const w = world();
    w.fake.setKey(null);
    const body = v2("MEET01");
    expect((await w.post(body, signed(body))).status).toBe(200);
    expect(w.fake.deliveries.get("MEET01")).toMatchObject({ status: "failed", reason: "no_key" });
  });
});

describe("secrets stay out of logs and answers", () => {
  it("never logs the API key, the signing secret or meeting text", async () => {
    const info = vi.spyOn(logger, "info");
    const warn = vi.spyOn(logger, "warn");
    const w = world();
    const body = v2("MEET01");
    await w.post(body, signed(body));
    await w.post(body, "sha256=" + "0".repeat(64));
    const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("budget is 40");
    expect(logged).toContain("fireflies webhook rejected");
  });
});

describe("Cloudflare bypass and route agree", () => {
  it("the setup plan's bypass path is the route's path", () => {
    expect(HOOKS_PATH).toBe(HOOK_PATH);
  });
});
