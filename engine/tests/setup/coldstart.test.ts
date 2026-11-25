import { shown } from "../shown.js";
import { describe, it, expect } from "vitest";
import { GOOD_TOKEN } from "./fake-cloudflare.js";
import { CODE, createWorld, PLATFORM_HOST, previewed } from "./world.js";

// What the live cold-start test found on DigitalOcean.

const applyWith = async (
  world: ReturnType<typeof createWorld>,
  headers: Record<string, string> = {},
) => {
  const signed = await previewed(world);
  return world.post(
    "/setup/apply",
    { inputs: signed.inputs, sig: signed.sig, code: CODE, cf_token: GOOD_TOKEN },
    headers,
  );
};

describe("a failed apply is shown, not swallowed by the hosting edge", () => {
  it("answers 4xx, never 502, with the failed check and Cloudflare's words", async () => {
    const world = createWorld({ cloudflare: { zoneListEmpty: true } });
    const res = await applyWith(world);
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("Setup stopped");
    expect(html).toMatch(/Zone - Zone - Read/);
    expect(html).toMatch(/What Cloudflare answered/);
    expect(html).toMatch(/zones\?name=example\.com: no match/);
    expect(html).not.toContain(GOOD_TOKEN);
  });

  it("sends the same details as JSON", async () => {
    const world = createWorld({ cloudflare: { denied: ["zone"] } });
    const res = await applyWith(world, { Accept: "application/json" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      steps: { id: string; code?: string; details?: string[] }[];
    };
    const token = body.steps.find((s) => s.id === "token");
    expect(token?.code).toBe("zone_not_found");
    expect(token?.details?.join("\n")).toMatch(/403 \[10000\]/);
  });
});

describe("GET on the form-answer routes", () => {
  it.each(["/setup/preview", "/setup/apply"])(
    "%s opened directly starts over at /setup",
    async (path) => {
      const world = createWorld();
      const res = await world.app.fetch(
        new Request("http://" + PLATFORM_HOST + path, {
          headers: { Host: PLATFORM_HOST },
        }),
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("Location")).toBe("/setup");
    },
  );
});

describe("the apply step's token box", () => {
  it("has the link to Cloudflare's token screen and the short instructions", async () => {
    const world = createWorld();
    const { html } = await previewed(world);
    const step2 = html.slice(html.indexOf("Step 2 of 2"));
    expect(step2).toContain(
      'href="https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=',
    );
    expect(step2).toMatch(/Open Cloudflare's token screen/);
    expect(step2).toMatch(/Specific zone/);
    expect(step2).toMatch(/Zone policy: Zone - <strong>Read<\/strong>/);
    expect(step2).toMatch(/DNS - <strong>Write<\/strong>/);
  });
});

describe("the owner on the sign-in form", () => {
  it("shows the stored owner to a claimed session", async () => {
    const world = createWorld({ deps: { sessionCode: () => CODE } });
    const html = shown(await (await world.get()).text());
    expect(html).toContain("owner@example.com");
    expect(html).not.toContain("The owner named in your Engine config.");
  });

  it("does not show it to a page opened without a claim", async () => {
    const world = createWorld();
    const html = await (await world.get()).text();
    expect(html).not.toContain("owner@example.com");
  });
});
