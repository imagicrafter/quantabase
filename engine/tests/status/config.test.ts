import { LEGACY_SENSOR_KINDS } from "../../src/config/legacy-names.js";
import { describe, it, expect } from "vitest";
import { parse, stringify } from "yaml";
import { parseEngineConfig } from "../../src/config/engine-config.js";
import { normalizeSensor } from "../../src/config/dashboard-schema.js";
import { durationMs, statusConfigFrom } from "../../src/status/config.js";
import {
  EXAMPLE_YAML,
  FULL_YAML,
  exampleStatusConfig,
  fullStatusConfig,
} from "./fixtures/config.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

/** The full fixture as YAML text, with one change applied. */
function full(change: (raw: Loose) => void): string {
  const raw = parse(FULL_YAML) as Loose;
  change(raw);
  return stringify(raw);
}

/** The earlier name of a sensor kind, taken from the compatibility map. */
function oldKind(current: string): string {
  const found = Object.entries(LEGACY_SENSOR_KINDS).find(
    ([, now]) => now === current,
  );
  if (!found) throw new Error(`no earlier name for ${current}`);
  return found[0];
}

describe("the dashboard section of the Engine config", () => {
  it("the full fixture is valid", () => {
    const cfg = fullStatusConfig();
    expect(cfg.engine.id).toBe("acme");
    expect(cfg.engine.owner).toBe("owner@example.com");
    expect(cfg.dashboard.menus.security).toEqual([
      "layers",
      "people",
      "systems",
    ]);
    expect(cfg.engine.knowledge.index?.label).toBe("Search index");
    expect(cfg.engine.tools.support_desk?.enabled).toBe(true);
  });

  it("the wiki is the Search index, not a source", () => {
    const cfg = fullStatusConfig();
    const sensors = cfg.engine.knowledge.sources.map((s) => s.sensor);
    expect(sensors).not.toContain("connector_state:wiki");
    expect(cfg.engine.knowledge.index?.sensor).toBe("connector_state:wiki");
  });

  it("every labelled task is an agent job", () => {
    const tasks = fullStatusConfig()
      .engine.workers.flatMap((w) => w.jobs)
      .filter((j) => j.task);
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) expect(t.sensor).toMatch(/^agent_job:/);
  });

  it("applies defaults", () => {
    const cfg = fullStatusConfig();
    expect(cfg.engine.knowledge.sources[0]?.fresh_within).toBe("26h");
    expect(cfg.engine.knowledge.sources[0]?.enabled).toBe(true);
  });

  it("rejects a worker that uses a part that does not exist", () => {
    const bad = full((r) => {
      r["dashboard"].workers[0].uses = ["tools.nope"];
    });
    expect(() => parseEngineConfig(bad)).toThrow(
      /uses unknown part tools.nope/,
    );
  });

  it("rejects a source that is off without a reason", () => {
    const bad = full((r) => {
      delete r["dashboard"].knowledge.sources[2].off_reason;
    });
    expect(() => parseEngineConfig(bad)).toThrow(/off without an off_reason/);
  });

  it("rejects an unknown tab", () => {
    const bad = full((r) => {
      r["dashboard"].menus.knowledge = ["overview", "radio"];
    });
    expect(() => parseEngineConfig(bad)).toThrow();
  });

  it("rejects a Support Desk tab when the desk is not enabled", () => {
    const bad = full((r) => {
      r["dashboard"].tools.support_desk.enabled = false;
    });
    expect(() => parseEngineConfig(bad)).toThrow(/support_desk tab needs/);
  });

  it("rejects a task on a job that is not an agent job", () => {
    const bad = full((r) => {
      r["dashboard"].workers[0].jobs = [
        { sensor: "workshop_jobs", task: "Do a thing" },
      ];
    });
    expect(() => parseEngineConfig(bad)).toThrow(/needs an agent_job sensor/);
  });

  it("accepts the earlier sensor kind names and reads them as today's", () => {
    expect(normalizeSensor(`${oldKind("agent_job")}:watch/kb-health`)).toBe(
      "agent_job:watch/kb-health",
    );
    expect(normalizeSensor(oldKind("workshop_jobs"))).toBe("workshop_jobs");
    expect(normalizeSensor("constructor:x")).toBe("constructor:x");
    expect(normalizeSensor("connector_state:wiki")).toBe(
      "connector_state:wiki",
    );
    const old = full((r) => {
      r["dashboard"].workers[1].jobs[0].sensor =
        `${oldKind("agent_job")}:build/workshop-dispatch`;
    });
    const job = statusConfigFrom(parseEngineConfig(old)).engine.workers[1]
      ?.jobs[0];
    expect(job?.sensor).toBe("agent_job:build/workshop-dispatch");
  });

  it("parses durations", () => {
    expect(durationMs("30m")).toBe(1_800_000);
    expect(durationMs("26h")).toBe(26 * 3_600_000);
    expect(durationMs("7d")).toBe(7 * 86_400_000);
  });
});

describe("a config with no dashboard section", () => {
  const bare = () => {
    const raw = parse(EXAMPLE_YAML) as Loose;
    delete raw["dashboard"];
    return statusConfigFrom(parseEngineConfig(stringify(raw)));
  };

  it("still yields a page: Knowledge, Security and Support, titled with the engine name", () => {
    const cfg = bare();
    expect(cfg.dashboard.title).toBe("Acme's Knowledge Base Engine");
    expect(cfg.dashboard.menus).toEqual({
      knowledge: ["overview", "sources", "areas", "review"],
      workers: [],
      tools: [],
      security: ["layers", "people", "systems"],
      support: ["issues"],
    });
    expect(cfg.engine.connect.connector_url).toBeNull();
  });

  it("builds gauges only for the sources that are on", () => {
    const cfg = bare();
    expect(cfg.engine.knowledge.index?.sensor).toBe("connector_state:wiki");
    expect(cfg.engine.knowledge.sources.map((s) => s.sensor)).toEqual([
      "connector_state:drive",
      "connector_state:fireflies",
    ]);
    expect(cfg.engine.workers).toEqual([]);
    expect(cfg.engine.tools.support_desk).toBeUndefined();
  });

  it("describes each topic by its label", () => {
    const notes = bare().engine.knowledge.area_notes;
    expect(notes["properties"]).toBe("Rental Properties");
    expect(notes["unclassified"]).toMatch(/Locked to the owner/);
  });

  it("drops an empty Workers menu even when the config lists it", () => {
    expect(exampleStatusConfig().dashboard.menus.workers).toEqual([]);
  });

  it("the Support menu is on unless a config turns it off", () => {
    const withMenus = (support: string) =>
      statusConfigFrom(
        parseEngineConfig(
          EXAMPLE_YAML.replace(
            "    security: [layers, people, systems]",
            `    security: [layers, people, systems]${support}`,
          ),
        ),
      ).dashboard.menus.support;
    expect(withMenus("")).toEqual(["issues"]);
    expect(withMenus("\n    support: []")).toEqual([]);
  });
});
