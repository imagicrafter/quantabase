import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { exampleStatusConfig, fullStatusConfig } from "./fixtures/config.js";
import { buildModel, type DashboardModel } from "../../src/status/model.js";
import { StatusDataSchema } from "../../src/status/readings.js";

/**
 * Runs the real browser script against a stand-in page, so what it draws for
 * each route is checked without a browser. The stand-in keeps only what the
 * script touches: a few elements by id, the hash, and event listeners.
 */

const NOW = new Date("2026-11-07T18:00:00Z");
const SCRIPT = readFileSync(
  new URL("../../public/status/dashboard.js", import.meta.url),
  "utf8",
);
const raw = JSON.parse(
  readFileSync(new URL("./fixtures/readings.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const V3_KEYS = ["tagging", "issues", "setup", "config"];
const older = Object.fromEntries(
  Object.entries(raw).filter(([key]) => !V3_KEYS.includes(key)),
);

type Element = {
  innerHTML: string;
  textContent: string;
  hidden: boolean;
  clientWidth: number;
  dataset: Record<string, string>;
  style: Record<string, string>;
  classList: {
    add(): void;
    remove(): void;
    toggle(): void;
    contains(): boolean;
  };
  addEventListener(): void;
  setAttribute(): void;
  querySelector(): Element;
  querySelectorAll(): Element[];
};

function element(text = ""): Element {
  const self: Element = {
    innerHTML: "",
    textContent: text,
    hidden: false,
    clientWidth: 680,
    dataset: {},
    style: {},
    classList: {
      add: () => undefined,
      remove: () => undefined,
      toggle: () => undefined,
      contains: () => false,
    },
    addEventListener: () => undefined,
    setAttribute: () => undefined,
    querySelector: () => self,
    querySelectorAll: () => [],
  };
  return self;
}

/** Draw one route and return the page's HTML. */
function draw(model: DashboardModel, route: string): string {
  const byId = new Map<string, Element>([
    ["engine-data", element(JSON.stringify(model))],
  ]);
  const get = (id: string): Element => {
    const found = byId.get(id) ?? element();
    byId.set(id, found);
    return found;
  };
  const document = {
    documentElement: element(),
    getElementById: get,
    querySelector: (selector: string) =>
      selector.startsWith("#") ? get(selector.slice(1)) : element(),
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  };
  const window = {
    addEventListener: () => undefined,
    scrollTo: () => undefined,
  };
  vm.runInNewContext(SCRIPT, {
    document,
    window,
    location: { hash: `#${route}` },
    localStorage: { getItem: () => null, setItem: () => undefined },
    navigator: {},
    setTimeout,
  });
  return get("page").innerHTML;
}

const full = (over: Record<string, unknown> = {}, source = raw) =>
  buildModel(
    fullStatusConfig(),
    StatusDataSchema.parse({ ...source, ...over }),
    NOW,
    { host: "engine.example.com", level: "people", ownSignInApp: true },
  );

const routesOf = (model: DashboardModel) =>
  model.menus.flatMap((m) => m.tabs.map((t) => t.route));

describe("what the browser script draws", () => {
  it("draws every route without leaking a missing value", () => {
    const model = full();
    for (const route of routesOf(model)) {
      const html = draw(model, route);
      expect(html.length, route).toBeGreaterThan(200);
      expect(html, route).not.toMatch(/undefined|\[object Object\]|NaN/);
    }
  });

  it("Sources: the tagged and untagged counts and the unknown-tag warning", () => {
    const html = draw(full(), "knowledge-sources");
    expect(html).toContain("<th>Tagged</th>");
    expect(html).toContain("<b>190</b> tagged");
    expect(html).toContain("40 on the item");
    expect(html).toContain("150 from a folder or channel");
    expect(html).toMatch(
      /<b>44<\/b> untagged <span class="muted">\(owner-only\)/,
    );
    expect(html).toContain("2 with an unknown tag");
    expect(html).toMatch(/class="warn-row"[^>]*>.*3 items carry a tag/s);
  });

  it("Sources: no warning row when every tag is known", () => {
    const clean = (raw["tagging"] as Record<string, unknown>[]).map((t) => ({
      ...t,
      unknown_tag: 0,
    }));
    const html = draw(full({ tagging: clean }), "knowledge-sources");
    expect(html).not.toContain("warn-row");
  });

  it("Support: open issues, fixed in 30 days and the Care Plan", () => {
    const html = draw(full(), "support");
    expect(html).toContain("Wiki run failed");
    expect(html).toContain("Source failing");
    expect(html).toContain("Search misses the pricing notes");
    expect(html).toMatch(/Fixed · 30 days<\/span><span class="value">4</);
    expect(html).toMatch(/Care Plan access.*<span class="pill off">.*Off/s);
    expect(html).toContain("Applied Nov 6, 9:00 AM");
  });

  it("Support: says plainly when nothing is open", () => {
    const html = draw(
      full({ issues: { open: [], fixed_last_30_days: 0 } }),
      "support",
    );
    expect(html).toContain('<div class="empty">Nothing is open.</div>');
  });

  it("Support: a rejected config is a visible warning", () => {
    const html = draw(
      full({ config: { applied_at: "2026-11-06T15:00:00Z", rejected: true } }),
      "support",
    );
    expect(html).toMatch(/warn-row.*earlier config is still in force/s);
  });

  it("Security: level, hostname, setup state and second factor", () => {
    const html = draw(full(), "security");
    expect(html).toContain("How people sign in");
    expect(html).toContain("Named people");
    expect(html).toContain("engine.example.com");
    expect(html).toContain("On: this page has its own sign-in");
  });

  it("escapes what an issue title carries", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const html = draw(
      full({
        issues: {
          open: [{ category: "friction_point", title: evil, status: "open" }],
        },
      }),
      "support",
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("an older database: every route still draws, with no made-up numbers", () => {
    const model = full({}, older);
    for (const route of routesOf(model)) {
      expect(draw(model, route), route).not.toMatch(/undefined|NaN/);
    }
    const support = draw(model, "support");
    expect(support).toContain("has not been updated to record issues");
    expect(draw(model, "knowledge-sources")).toContain("No reading");
  });

  it("a plain Engine draws its Support page too", () => {
    const model = buildModel(
      exampleStatusConfig(),
      StatusDataSchema.parse(raw),
      NOW,
    );
    expect(draw(model, "support")).toContain("Open issues");
  });
});
