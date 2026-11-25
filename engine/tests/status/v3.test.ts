import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  EXAMPLE_YAML,
  exampleStatusConfig,
  fullStatusConfig,
} from "./fixtures/config.js";
import { parseEngineConfig } from "../../src/config/engine-config.js";
import { statusConfigFrom } from "../../src/status/config.js";
import { buildModel } from "../../src/status/model.js";
import {
  bannerState,
  type BannerFacts,
} from "../../src/status/model-overall.js";
import {
  StatusDataSchema,
  type StatusData,
} from "../../src/status/readings.js";

const NOW = new Date("2026-11-07T18:00:00Z");
const raw = JSON.parse(
  readFileSync(new URL("./fixtures/readings.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const V3_KEYS = ["tagging", "issues", "setup", "config"] as const;

function data(over: Record<string, unknown> = {}): StatusData {
  return StatusDataSchema.parse({ ...raw, ...over });
}

/** The fixture as a database from before migration 0041 would return it. */
function olderShape(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([key]) => !(V3_KEYS as readonly string[]).includes(key),
    ),
  );
}

const model = (over: Record<string, unknown> = {}) =>
  buildModel(fullStatusConfig(), data(over), NOW);
const plain = (over: Record<string, unknown> = {}) =>
  buildModel(exampleStatusConfig(), data(over), NOW);

const issue = (over: Record<string, unknown> = {}) => ({
  category: "source_failure",
  source: "drive",
  title: "Drive run failed",
  status: "open",
  opened_at: "2026-11-07T12:00:00Z",
  occurrences: 1,
  has_card: false,
  ...over,
});

describe("readings", () => {
  it("parses the four new readings", () => {
    const d = data();
    expect(d.tagging?.map((t) => t.source)).toEqual([
      "drive",
      "fireflies",
      "gmail",
      "wiki",
    ]);
    expect(d.issues?.open).toHaveLength(2);
    expect(d.setup?.setup_state).toBe("complete");
    expect(d.config?.rejected).toBe(false);
  });

  it("a database from before the new migration still parses", () => {
    const d = StatusDataSchema.parse(olderShape());
    expect(d.tagging).toBeUndefined();
    expect(d.issues).toBeUndefined();
    expect(d.setup).toBeUndefined();
    expect(d.config).toBeUndefined();
  });

  it("fills in counts a reading leaves out", () => {
    const d = data({
      tagging: [{ source: "drive" }],
      issues: {},
      setup: {},
      config: {},
    });
    expect(d.tagging?.[0]).toMatchObject({
      total: 0,
      untagged: 0,
      unknown_tag: 0,
      by_tag_source: { content: 0, container: 0, source_default: 0 },
    });
    expect(d.issues).toEqual({
      open: [],
      fixed_last_30_days: 0,
      care_plan_enabled: false,
    });
    expect(d.config?.rejected).toBe(false);
  });
});

describe("Knowledge: tagging per source", () => {
  it("gives each source its tagged and untagged counts", () => {
    const docs = model().knowledge.sources.find((s) => s.id === "documents");
    expect(docs?.tagging).toEqual({
      total: 234,
      onItem: 40,
      byContainer: 150,
      byDefault: 0,
      untagged: 44,
      notRecorded: 0,
      unknown: 2,
    });
  });

  it("gives the search index the wiki's counts", () => {
    expect(model().knowledge.index?.tagging?.untagged).toBe(12);
  });

  it("warns, with the count, when tags name unknown topics", () => {
    const warning = model().knowledge.unknownTags;
    expect(warning?.count).toBe(3);
    expect(warning?.text).toMatch(/^3 items carry a tag for a topic/);
    expect(warning?.text).toMatch(/Documents \(2\)/);
    expect(warning?.text).toMatch(/Search index \(1\)/);
  });

  it("says nothing when every tag names a known topic", () => {
    const clean = (raw["tagging"] as Record<string, unknown>[]).map((t) => ({
      ...t,
      unknown_tag: 0,
    }));
    expect(model({ tagging: clean }).knowledge.unknownTags).toBeNull();
  });

  it("a source with no documents yet has zero counts, not a missing row", () => {
    const m = model({ tagging: [] });
    const docs = m.knowledge.sources.find((s) => s.id === "documents");
    expect(docs?.tagging).toMatchObject({ total: 0, untagged: 0 });
    expect(m.knowledge.unknownTags).toBeNull();
  });

  it("an older database gives no tagging at all", () => {
    const m = buildModel(
      fullStatusConfig(),
      StatusDataSchema.parse(olderShape()),
      NOW,
    );
    expect(m.knowledge.sources.every((s) => s.tagging === null)).toBe(true);
    expect(m.knowledge.index?.tagging).toBeNull();
    expect(m.knowledge.unknownTags).toBeNull();
  });
});

describe("Support", () => {
  it("lists open issues in plain words", () => {
    const s = model().support;
    expect(s.available).toBe(true);
    expect(s.open.map((i) => [i.kind, i.source, i.title])).toEqual([
      ["Source failing", "wiki", "Wiki run failed"],
      ["Reported problem", "—", "Search misses the pricing notes"],
    ]);
    expect(s.open[0]?.pill).toEqual({ state: "crit", text: "Open" });
    expect(s.open[0]?.seen).toBe("14 times");
    expect(s.open[0]?.card).toBe("Being worked on");
    expect(s.open[1]?.card).toBe("Not picked up yet");
    expect(s.fixed30).toBe(4);
    expect(s.badge).toEqual({ state: "crit", text: "2 open" });
  });

  it("says so plainly when nothing is open", () => {
    const s = model({
      issues: { open: [], fixed_last_30_days: 0, care_plan_enabled: false },
    }).support;
    expect(s.open).toEqual([]);
    expect(s.emptyText).toBe("Nothing is open.");
    expect(s.badge).toEqual({ state: "good", text: "Nothing open" });
  });

  describe("Care Plan line: the config says intended, the database says actual", () => {
    const withPlan = (intended: boolean, actual: boolean) =>
      buildModel(
        {
          ...exampleStatusConfig(),
          engine: {
            ...exampleStatusConfig().engine,
            care_plan_intended: intended,
          },
        },
        data({
          issues: {
            open: [],
            fixed_last_30_days: 0,
            care_plan_enabled: actual,
          },
        }),
        NOW,
      ).support;

    it("off in both: off", () => {
      const s = withPlan(false, false);
      expect(s.carePlan).toEqual({ state: "off", text: "Off" });
      expect(s.carePlanNote).toContain("No outside support login exists");
    });

    it("on in both: on", () => {
      const s = withPlan(true, true);
      expect(s.carePlan).toEqual({ state: "good", text: "On" });
      expect(s.carePlanNote).toContain("cannot read your knowledge");
    });

    it("intended but no support login: says it is not set up", () => {
      const s = withPlan(true, false);
      expect(s.carePlan).toEqual({ state: "warn", text: "Not set up" });
      expect(s.carePlanNote).toContain("support.care_plan.enabled");
      expect(s.carePlanNote).toContain("kbe support enable");
    });

    it("a support login the config does not ask for: flagged, never shown as plain On", () => {
      const s = withPlan(false, true);
      expect(s.carePlan).toEqual({ state: "crit", text: "On, not in config" });
      expect(s.carePlanNote).toContain("kbe support disable");
    });

    it("reads the intent from support.care_plan.enabled", () => {
      expect(exampleStatusConfig().engine.care_plan_intended).toBe(false);
      const on = statusConfigFrom(
        parseEngineConfig(
          EXAMPLE_YAML.replace(
            "care_plan: { enabled: false }",
            "care_plan: { enabled: true }",
          ),
        ),
      );
      expect(on.engine.care_plan_intended).toBe(true);
    });

    it("no reading: says so, whatever the config intends", () => {
      const s = buildModel(
        exampleStatusConfig(),
        StatusDataSchema.parse(olderShape()),
        NOW,
      ).support;
      expect(s.carePlan).toEqual({ state: "off", text: "No reading" });
    });
  });

  it("an issue in progress is amber, not red", () => {
    const s = model({
      issues: { open: [issue({ status: "in_progress", has_card: true })] },
    }).support;
    expect(s.open[0]?.pill).toEqual({ state: "warn", text: "Being fixed" });
    expect(s.badge.state).toBe("warn");
  });

  it("an older database shows no reading, never a made-up zero", () => {
    const m = buildModel(
      fullStatusConfig(),
      StatusDataSchema.parse(olderShape()),
      NOW,
    );
    expect(m.support.available).toBe(false);
    expect(m.support.badge).toEqual({ state: "off", text: "No reading" });
    expect(m.support.emptyText).toMatch(/database has not been updated/);
  });

  it("is a menu of its own, also on a plain Engine", () => {
    expect(model().menus.map((m) => m.id)).toContain("support");
    const menu = plain().menus.find((m) => m.id === "support");
    expect(menu?.tabs).toEqual([
      { key: "issues", route: "support", label: "Issues" },
    ]);
  });
});

describe("Security: access", () => {
  const rows = (m: ReturnType<typeof model>) =>
    Object.fromEntries(m.security.access.map((r) => [r.label, r.value]));

  it("shows level, hostname, setup state and the second factor", () => {
    const m = buildModel(fullStatusConfig(), data(), NOW, {
      host: "engine.example.com",
      level: "people",
      ownSignInApp: true,
    });
    expect(rows(m)).toEqual({
      "Who can sign in": "Named people",
      Hostname: "engine.example.com",
      Setup: "Complete",
      "Second factor on this page": "On: this page has its own sign-in",
    });
  });

  it("falls back to what the database recorded", () => {
    expect(rows(model())).toMatchObject({
      "Who can sign in": "Named people",
      Hostname: "engine.example.com",
      "Second factor on this page": "Not known",
    });
  });

  it("names each access level and admits when none is recorded", () => {
    const level = (value: unknown) =>
      rows(model({ setup: { setup_state: "complete", level: value } }))[
        "Who can sign in"
      ];
    expect(level("owner")).toBe("Owner only");
    expect(level("domain")).toBe("Anyone at the company domains");
    expect(level(null)).toBe("Not recorded");
    expect(level("something-else")).toBe("Not recorded");
  });

  it("flags a reopened or locked setup", () => {
    const open = model({ setup: { setup_state: "open" } }).security.access;
    expect(open.find((r) => r.label === "Setup")).toMatchObject({
      value: "Open: the setup page is accepting its one-time code",
      pill: { state: "warn", text: "Open" },
    });
    const locked = model({
      setup: { setup_state: "open", locked_until: "2026-11-07T18:30:00Z" },
    }).security.access;
    expect(locked.find((r) => r.label === "Setup")?.value).toMatch(
      /^Locked after wrong codes until /,
    );
  });

  it("an older database shows what it can and nothing invented", () => {
    const m = buildModel(
      fullStatusConfig(),
      StatusDataSchema.parse(olderShape()),
      NOW,
    );
    expect(rows(m)).toEqual({
      "Who can sign in": "Not recorded",
      Hostname: "Not recorded",
      Setup: "No reading",
      "Second factor on this page": "Not known",
    });
  });
});

describe("the banner rule", () => {
  const facts = (over: Partial<BannerFacts> = {}): BannerFacts => ({
    openIssues: [],
    sources: [],
    now: NOW,
    ...over,
  });
  const source = (over: Partial<BannerFacts["sources"][number]> = {}) => ({
    label: "Documents",
    enabled: true,
    hasReading: true,
    lastSuccessAt: "2026-11-07T11:00:00Z",
    alertAfter: "48h",
    ...over,
  });

  it("all working with nothing open and every source fresh", () => {
    expect(bannerState(facts({ sources: [source()] }))).toEqual({
      state: "working",
      reasons: [],
    });
  });

  it("attention for an open source failure or a rejected config", () => {
    const failing = bannerState(
      facts({ openIssues: [{ category: "source_failure", source: "drive" }] }),
    );
    expect(failing).toEqual({
      state: "attention",
      reasons: ["drive is failing"],
    });
    const rejected = bannerState(
      facts({ openIssues: [{ category: "config_invalid", source: null }] }),
    );
    expect(rejected.state).toBe("attention");
    expect(rejected.reasons).toEqual(["The last config change was rejected"]);
  });

  it("other kinds of open issue do not raise the banner", () => {
    const quiet = bannerState(
      facts({
        openIssues: [
          { category: "unknown_tag", source: "wiki" },
          { category: "friction_point", source: null },
          { category: "data_quality_issue", source: null },
          { category: "feature_gap", source: null },
        ],
      }),
    );
    expect(quiet.state).toBe("working");
  });

  it("attention when a source is past its alert_after", () => {
    const stale = bannerState(
      facts({
        sources: [source({ lastSuccessAt: "2026-11-05T17:59:00Z" })],
      }),
    );
    expect(stale).toEqual({
      state: "attention",
      reasons: ["Documents has not been read in time"],
    });
    const edge = bannerState(
      facts({ sources: [source({ lastSuccessAt: "2026-11-05T18:00:00Z" })] }),
    );
    expect(edge.state).toBe("working");
  });

  it("a source that has run but never succeeded is past its limit", () => {
    const never = bannerState(
      facts({ sources: [source({ lastSuccessAt: null })] }),
    );
    expect(never.state).toBe("attention");
  });

  it("a source that is off, or has no reading yet, is not late", () => {
    const quiet = bannerState(
      facts({
        sources: [
          source({ enabled: false, lastSuccessAt: "2026-01-01T00:00:00Z" }),
          source({ hasReading: false, lastSuccessAt: null }),
        ],
      }),
    );
    expect(quiet.state).toBe("working");
  });

  it("names one issue per source once", () => {
    const twice = bannerState(
      facts({
        openIssues: [
          { category: "source_failure", source: "drive" },
          { category: "source_failure", source: "drive" },
          { category: "source_failure", source: null },
        ],
      }),
    );
    expect(twice.reasons).toEqual(["drive is failing", "A source is failing"]);
  });
});

describe("overall banner on the page", () => {
  const healthy = {
    connectors: [
      {
        source: "drive",
        last_run_at: "2026-11-07T11:20:00Z",
        last_success_at: "2026-11-07T11:23:00Z",
        consecutive_failures: 0,
      },
      {
        source: "fireflies",
        last_run_at: "2026-11-07T11:40:00Z",
        last_success_at: "2026-11-07T11:44:00Z",
        consecutive_failures: 0,
      },
      {
        source: "wiki",
        last_run_at: "2026-11-07T11:00:00Z",
        last_success_at: "2026-11-07T11:02:00Z",
        consecutive_failures: 0,
      },
    ],
    runs_daily: [],
    snapshot: null,
    issues: { open: [], fixed_last_30_days: 0, care_plan_enabled: false },
  };

  it("a plain Engine with nothing wrong is all working, with no caretaker", () => {
    const m = plain(healthy);
    expect(m.overall.banner).toBe("working");
    expect(m.overall).toMatchObject({ state: "good", text: "All working" });
    expect(m.overall.detail).not.toMatch(/caretaker/);
  });

  it("an open source failure asks for attention", () => {
    const m = plain({
      ...healthy,
      issues: { open: [issue()], fixed_last_30_days: 0 },
    });
    expect(m.overall.banner).toBe("attention");
    expect(m.overall).toMatchObject({
      state: "crit",
      text: "Attention needed",
    });
    expect(m.overall.detail).toMatch(/drive is failing/);
  });

  it("a rejected config asks for attention", () => {
    const m = plain({
      ...healthy,
      issues: { open: [issue({ category: "config_invalid", source: "wiki" })] },
    });
    expect(m.overall.banner).toBe("attention");
    expect(m.overall.detail).toMatch(/config change was rejected/);
  });

  it("a source past its alert_after asks for attention", () => {
    const stale = healthy.connectors.map((c) =>
      c.source === "drive"
        ? { ...c, last_success_at: "2026-11-04T11:00:00Z" }
        : c,
    );
    const m = plain({ ...healthy, connectors: stale });
    expect(m.overall.banner).toBe("attention");
    expect(m.overall.detail).toMatch(/Documents/);
  });

  it("an Engine that names workers still expects its caretaker", () => {
    const m = model({ snapshot: null });
    expect(m.overall.state).toBe("crit");
    expect(m.overall.detail).toMatch(/caretaker has gone quiet/);
  });

  it("an older database still gets a banner", () => {
    const older = StatusDataSchema.parse({
      ...olderShape(),
      ...healthy,
      issues: undefined,
    });
    const m = buildModel(exampleStatusConfig(), older, NOW);
    expect(m.overall.banner).toBe("working");
  });
});

describe("config reading", () => {
  it("shows when the config was applied and whether the last one was rejected", () => {
    expect(model().support.config).toEqual({
      applied: "Nov 6, 9:00 AM",
      pill: { state: "good", text: "In force" },
      note: null,
    });
    const rejected = model({
      config: { applied_at: "2026-11-06T15:00:00Z", rejected: true },
    }).support.config;
    expect(rejected?.pill).toEqual({
      state: "crit",
      text: "Last change rejected",
    });
    expect(rejected?.note).toMatch(/earlier config is still in force/);
  });

  it("is absent on an older database", () => {
    const m = buildModel(
      fullStatusConfig(),
      StatusDataSchema.parse(olderShape()),
      NOW,
    );
    expect(m.support.config).toBeNull();
  });
});
