import { describe, it, expect } from "vitest";
import { createFirefliesClient, FirefliesError, FIREFLIES_URL } from "../../src/fireflies/client.js";
import { backfill, createJobs, fetchMeeting, retryMissed } from "../../src/fireflies/fetch.js";
import { ACCOUNT, API_KEY, createFakeClient, createFakeFirefliesStore, transcript } from "./fakes.js";

type Sent = { url: string; headers: Record<string, string>; body: { query: string; variables: Record<string, unknown> } };

function fakeFetch(answer: (sent: Sent) => { status?: number; json: unknown }) {
  const sent: Sent[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const s = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Sent["body"] };
    sent.push(s);
    const a = answer(s);
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetcher, sent };
}

describe("the Fireflies client", () => {
  it("checks a key with one user query and sends the key only as a Bearer header", async () => {
    const f = fakeFetch(() => ({ json: { data: { user: { email: "Ann@Meet.example", name: "Ann" } } } }));
    const who = await createFirefliesClient(f.fetcher).whoami(API_KEY);
    expect(who).toEqual({ email: "ann@meet.example", name: "Ann" });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.url).toBe(FIREFLIES_URL);
    expect(f.sent[0]?.headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(JSON.stringify(f.sent[0]?.body)).not.toContain(API_KEY);
    expect(f.sent[0]?.body.query).toMatch(/user \{ email name \}/);
  });

  it("reduces failures to short codes that never carry the key", async () => {
    const cases: Array<[number, unknown, string]> = [
      [401, {}, "unauthorized"],
      [429, {}, "rate_limited"],
      [200, { errors: [{ message: "Invalid API key " + API_KEY, extensions: { code: "auth_failed" } }] }, "unauthorized"],
      [200, { errors: [{ message: "Transcript not found", code: "object_not_found" }] }, "not_found"],
      [500, { nope: true }, "fireflies_error"],
    ];
    for (const [status, json, code] of cases) {
      const c = createFirefliesClient(fakeFetch(() => ({ status, json })).fetcher);
      const err = await c.meeting(API_KEY, "M1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FirefliesError);
      expect((err as FirefliesError).code).toBe(code);
      expect(String((err as Error).message)).not.toContain(API_KEY);
    }
    const down = createFirefliesClient(async () => Promise.reject(new Error(`ECONNRESET ${API_KEY}`)));
    const err = await down.whoami(API_KEY).catch((e: unknown) => e);
    expect((err as FirefliesError).code).toBe("unreachable");
    expect(String(err)).not.toContain(API_KEY);
  });

  it("fetches one meeting in one call, and asks once more without channels only if the API refuses that field", async () => {
    const ok = fakeFetch(() => ({ json: { data: { transcript: transcript("M1") } } }));
    await createFirefliesClient(ok.fetcher).meeting(API_KEY, "M1");
    expect(ok.sent).toHaveLength(1);
    expect(ok.sent[0]?.body.variables).toEqual({ id: "M1" });
    expect(ok.sent[0]?.body.query).toMatch(/sentences \{ speaker_name text \}/);
    expect(ok.sent[0]?.body.query).toMatch(/channels \{ id title \}/);

    const old = fakeFetch((s) =>
      s.body.query.includes("channels")
        ? { json: { errors: [{ message: 'Cannot query field "channels" on type "Transcript".' }] } }
        : { json: { data: { transcript: transcript("M1", { channels: null }) } } },
    );
    const c = createFirefliesClient(old.fetcher);
    await c.meeting(API_KEY, "M1");
    await c.meeting(API_KEY, "M2");
    expect(old.sent).toHaveLength(3); // the refusal is remembered
  });
});

describe("fetching, retrying and the one-time backfill", () => {
  it("records a rate limit as missed and the retry fetches those meetings by id", async () => {
    const fake = createFakeFirefliesStore();
    let limited = true;
    const ff = createFakeClient({ M1: transcript("M1") }, {
      meeting: async (_k, id) => {
        if (limited) throw new FirefliesError("rate_limited");
        return transcript(id);
      },
    });
    const out = await fetchMeeting({ store: fake.store, client: ff.client }, ACCOUNT, "M1", "meeting.summarized", null);
    expect(out).toEqual({ status: "failed", reason: "rate_limited" });
    expect(await fake.store.missed("ann@example.com", ACCOUNT)).toEqual(["M1"]);

    limited = false;
    const r = await retryMissed({ store: fake.store, client: ff.client, pause: async () => {} }, ACCOUNT, ["M1"]);
    expect(r).toEqual({ fetched: 1, skipped: 0, failed: 0, stoppedFor: null });
    expect(fake.deliveries.get("M1")?.status).toBe("done");
    expect(await fake.store.missed("ann@example.com", ACCOUNT)).toEqual([]);
  });

  it("backfill: one list call, one fetch per meeting not yet stored, oldest first", async () => {
    const fake = createFakeFirefliesStore();
    const meetings = { M1: transcript("M1"), M2: transcript("M2"), M3: transcript("M3") };
    const ff = createFakeClient(meetings);
    await fetchMeeting({ store: fake.store, client: ff.client }, ACCOUNT, "M2", "meeting.summarized", null);
    ff.calls.length = 0;
    const r = await backfill({ store: fake.store, client: ff.client, pause: async () => {} }, ACCOUNT, "2026-08-29T00:00:00.000Z");
    expect(r).toEqual({ fetched: 2, skipped: 1, failed: 0, stoppedFor: null });
    expect(ff.calls.map((c) => c.fn)).toEqual(["listSince", "meeting", "meeting"]);
    expect(ff.calls.filter((c) => c.fn === "meeting").map((c) => c.arg)).toEqual(["M1", "M3"]);
  });

  it("backfill stops at a rate limit and marks the rest missed instead of hammering Fireflies", async () => {
    const fake = createFakeFirefliesStore();
    const ff = createFakeClient({ M1: transcript("M1"), M2: transcript("M2"), M3: transcript("M3") }, {
      meeting: async () => Promise.reject(new FirefliesError("rate_limited")),
    });
    const r = await backfill({ store: fake.store, client: ff.client, pause: async () => {} }, ACCOUNT, "2026-08-29T00:00:00.000Z");
    expect(r.stoppedFor).toBe("rate_limited");
    expect(r.failed).toBe(3);
    expect([...fake.deliveries.values()].every((d) => d.status === "failed" && d.reason === "rate_limited")).toBe(true);
  });

  it("runs one background job per account at a time", async () => {
    const jobs = createJobs();
    let release: () => void = () => {};
    const blocker = new Promise<void>((r) => { release = r; });
    const job = async () => { await blocker; return { fetched: 0, skipped: 0, failed: 0, stoppedFor: null }; };
    expect(jobs.start(ACCOUNT, job)).toBe(true);
    expect(jobs.start(ACCOUNT, job)).toBe(false);
    expect(jobs.isRunning(ACCOUNT)).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(jobs.isRunning(ACCOUNT)).toBe(false);
  });
});
