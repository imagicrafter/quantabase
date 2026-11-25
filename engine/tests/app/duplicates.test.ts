import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { makeOwnerRoutes } from "../../src/app/owner-routes.js";
import { mergeBodies } from "../../src/entities/merge.js";
import { ASSERT, DUP_ID, H64, OTHER_PAGE_ID, OWNER, PAGE_ID, READER, client, createScreens, csrfIn } from "./fakes.js";

function world() {
  const screens = createScreens();
  const app = new Hono();
  app.route("/app", makeOwnerRoutes(() => screens.deps));
  return { ...screens, http: client(app) };
}

describe("mergeBodies", () => {
  it("folds the other page's sections into the kept page, skipping lines already there", () => {
    const keep = "# Route Density\n\n## Summary\nStops per mile.\n\n## How it works\n- Count stops.\n";
    const drop = "# Stop Clustering\nIntro line.\n\n## Summary\nStops per mile.\nGrouping stops.\n\n## Pitfalls\n- Rural routes.\n";
    expect(mergeBodies(keep, drop, "Stop Clustering")).toBe(
      "# Route Density\n\n## Summary\nStops per mile.\nGrouping stops.\n\n## How it works\n- Count stops.\n\n" +
      "## Merged from Stop Clustering\nIntro line.\n\n## Pitfalls\n- Rural routes.\n",
    );
  });

  it("keeps the kept page unchanged when the other adds nothing new", () => {
    const keep = "# A\n\n## Notes\n- one\n";
    expect(mergeBodies(keep, "# B\n\n## Notes\n- one\n", "B")).toBe(keep);
  });
});

describe("possible duplicates screen", () => {
  it("lists the person's own pairs with merge and keep-apart actions, escaped", async () => {
    const w = world();
    const html = await (await w.http.get("/app/duplicates", ASSERT.reader)).text();
    expect(html).toContain("Possible duplicates");
    expect(html).toContain(`/app/duplicates/${DUP_ID}/merge`);
    expect(html).toContain(`/app/duplicates/${DUP_ID}/dismiss`);
    expect(html).toContain("Route &lt;Density&gt;");
    expect(html).toContain("0.95");
    expect(html).toMatch(/Nothing is merged unless you choose it/);
  });

  it("another person sees none of them", async () => {
    const w = world();
    const html = await (await w.http.get("/app/duplicates", ASSERT.owner)).text();
    expect(html).toContain("No possible duplicates.");
    expect(w.fake.calls.find((c) => c.fn === "duplicates")?.args).toEqual([OWNER]);
  });

  it("merges, keeping the chosen page, with the merged body and both hashes", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/app/duplicates", ASSERT.reader)).text());
    const res = await w.http.post(`/app/duplicates/${DUP_ID}/merge`, { csrf, keep: PAGE_ID }, ASSERT.reader);
    expect(res.status).toBe(200);
    const call = w.fake.calls.find((c) => c.fn === "mergePages")!;
    expect(call.args).toEqual([READER, DUP_ID, PAGE_ID, "# Route Density\n\n## Summary\nStops per mile.\nGrouping stops.\n", H64("a"), H64("b")]);
    expect(await res.text()).toMatch(/concept:stop-clustering now leads to it/);
  });

  it("refuses a merge without the form token, or keeping a page outside the pair", async () => {
    const w = world();
    expect((await w.http.post(`/app/duplicates/${DUP_ID}/merge`, { keep: PAGE_ID }, ASSERT.reader)).status).toBe(403);
    const csrf = csrfIn(await (await w.http.get("/app/duplicates", ASSERT.reader)).text());
    expect((await w.http.post(`/app/duplicates/${DUP_ID}/merge`, { csrf, keep: "00000000-0000-4000-8000-000000000000" }, ASSERT.reader)).status).toBe(400);
    expect(w.fake.calls.some((c) => c.fn === "mergePages")).toBe(false);
  });

  it("keeps two pages apart, once", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/app/duplicates", ASSERT.reader)).text());
    expect((await w.http.post(`/app/duplicates/${DUP_ID}/dismiss`, { csrf }, ASSERT.reader)).status).toBe(200);
    expect((await w.http.post(`/app/duplicates/${DUP_ID}/merge`, { csrf, keep: OTHER_PAGE_ID }, ASSERT.reader)).status).toBe(409);
  });
});
