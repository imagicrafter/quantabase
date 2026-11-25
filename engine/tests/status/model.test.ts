import { LEGACY_SNAPSHOT_KEYS } from "../../src/config/legacy-names.js";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { exampleStatusConfig, fullStatusConfig } from "./fixtures/config.js";
import { buildModel } from "../../src/status/model.js";
import {
  StatusDataSchema,
  type StatusData,
} from "../../src/status/readings.js";

const NOW = new Date("2026-11-07T18:00:00Z");
const raw = JSON.parse(
  readFileSync(new URL("./fixtures/readings.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

function data(over: Record<string, unknown> = {}): StatusData {
  return StatusDataSchema.parse({ ...raw, ...over });
}

const model = (over: Record<string, unknown> = {}) =>
  buildModel(fullStatusConfig(), data(over), NOW);

describe("overall status", () => {
  it("is red with the failing search index named", () => {
    const m = model();
    expect(m.overall.state).toBe("crit");
    expect(m.overall.text).toBe("Attention needed");
    expect(m.overall.detail).toMatch(/search index failing/i);
    expect(m.overall.detail).toMatch(/checked 60m ago/);
  });

  it("is red when the caretaker snapshot is older than 3 hours", () => {
    const old = {
      ...(raw["snapshot"] as Record<string, unknown>),
      ts: "2026-11-07T10:00:00Z",
    };
    const m = model({ snapshot: old });
    expect(m.overall.detail).toMatch(/gone quiet/);
  });

  it("is red with no caretaker reading at all", () => {
    expect(model({ snapshot: null }).overall.state).toBe("crit");
  });
});

describe("Knowledge", () => {
  const k = model().knowledge;

  it("search index failing makes the Knowledge badge red", () => {
    expect(k.index?.pill).toEqual({
      state: "crit",
      text: "Failing all 14 nights",
    });
    expect(k.badge).toEqual({ state: "crit", text: "Search index failing" });
    expect(k.index?.note).toMatch(/refusing to remove 281/);
  });

  it("documents are healthy", () => {
    const docs = k.sources.find((s) => s.id === "documents");
    expect(docs?.pill).toEqual({ state: "good", text: "Healthy" });
    expect(docs?.pages).toBe(234);
  });

  it("meetings are amber after recent failed nights", () => {
    const meet = k.sources.find((s) => s.id === "meetings");
    expect(meet?.pill.state).toBe("warn");
    expect(meet?.pill.text).toMatch(/failed this week/);
  });

  it("email shows its reason and counts as off", () => {
    const email = k.sources.find((s) => s.id === "email");
    expect(email?.pill).toEqual({ state: "off", text: "Off on purpose" });
    expect(email?.note).toMatch(/kx\/ labels/);
    expect(k.series.map((s) => s.id)).not.toContain("email");
  });

  it("series are 14 days long, zero-filled and end today", () => {
    const m = model();
    expect(m.days).toHaveLength(14);
    expect(m.days[13]).toBe("2026-11-07");
    for (const s of k.healthSeries) {
      expect(s.ok).toHaveLength(14);
      expect(s.changed).toHaveLength(14);
    }
    expect(k.healthSeries.map((s) => s.id)).toEqual([
      "documents",
      "meetings",
      "index",
    ]);
  });

  it("a day with no run counts as not ok, not as a gap", () => {
    const runs = (
      raw["runs_daily"] as { day: string; source: string }[]
    ).filter((r) => !(r.source === "drive" && r.day === "2026-11-07"));
    const docs = model({ runs_daily: runs }).knowledge.series.find(
      (s) => s.id === "documents",
    );
    expect(docs?.ok[13]).toBe(false);
  });

  it("counts pages, approvals and the review queue from readings", () => {
    expect(k.kpis.pages).toBe(234 + 197 + 3 + 1956);
    expect(k.kpis.waiting).toBe(1);
    expect(k.review.rows[0]?.title).toBe("Pat & Sam Build Sessions");
  });

  it("Owner sees unlocked areas automatically but not locked ones", () => {
    const who = (d: string) => k.areas.find((a) => a.domain === d)?.who;
    expect(who("consulting")).toEqual(["Pat Owner"]);
    expect(who("private")).toEqual(["Pat Owner"]); // explicit grant
    expect(who("unclassified")).toEqual([]);
    expect(k.lockedNote).toMatch(/270 unclassified pages are locked/);
  });
});

describe("Workers", () => {
  it("shows only labelled jobs, as outcomes", () => {
    const w = model().workers;
    expect(w.tasks.map((t) => t.what)).toEqual([
      "Keep Knowledge fresh and fix what is safe",
      "Follow up on stuck work",
      "Write meeting notes into the wiki",
      "Sort new knowledge for your review",
      "Monday summary email",
      "Check Northwind's issue inbox",
      "Build, test and ship fixes",
    ]);
  });

  it("flags wiki-writer when its job failed, and leaves the rest on time", () => {
    const w = model().workers;
    const bad = w.tasks.filter((t) => t.pill.state !== "good");
    expect(bad.map((t) => t.what)).toEqual([
      "Write meeting notes into the wiki",
    ]);
    expect(bad[0]?.last).toMatch(/Stopped: blocked_config/);
    expect(w.kpis.onTime).toBe(6);
    expect(w.kpis.fixedItself).toBe(3);
    expect(w.badge.state).toBe("crit");
  });

  it("a weekly job is not late on a day it does not run", () => {
    const digest = model().workers.tasks.find(
      (t) => t.what === "Monday summary email",
    );
    expect(digest?.pill.state).toBe("good");
  });
});

describe("Tools", () => {
  it("lists connected tools with their readings", () => {
    const t = model().tools;
    const names = t.connected.map((c) => [c.label, c.pill.state]);
    expect(names).toEqual([
      ["Slack", "good"],
      ["Email", "good"],
      ["Google Drive", "good"],
    ]);
  });

  it("shows a building job only while state is running", () => {
    const shop = model().tools.supportDesk?.workshop ?? [];
    expect(shop.map((r) => r.result.text)).toEqual([
      "Building now",
      "PR opened",
      "Failed",
    ]);
    expect(shop[1]?.result.state).toBe("good");
    expect(shop[2]?.result.state).toBe("crit");
  });

  it("finished jobs are not 'building now' even without an end time field name match", () => {
    const m = model();
    const running = (m.tools.supportDesk?.workshop ?? []).filter(
      (r) => r.result.text === "Building now",
    );
    expect(running).toHaveLength(1);
  });

  it("support desk is hidden when the Engine has no desk", () => {
    const cfg = fullStatusConfig();
    const noDesk = {
      ...cfg,
      engine: {
        ...cfg.engine,
        tools: { ...cfg.engine.tools, support_desk: undefined },
      },
    };
    expect(buildModel(noDesk, data(), NOW).tools.supportDesk).toBeNull();
  });

  it("shows a client's inbox as counts under its Client Engines row", () => {
    const clients = model().tools.supportDesk?.clients ?? [];
    expect(clients[0]?.inbox).toBe(
      "4 open · 3 with a card · 1 old backlog · 2 batched (geofence_bad_pin) · newest 3h ago",
    );
    expect(clients[1]?.inbox).toBeNull(); // planned engine
  });

  it("no inbox reading means no inbox line, not a made-up zero", () => {
    const snap = JSON.parse(JSON.stringify(raw["snapshot"])) as {
      attrs: { sensors: Record<string, unknown> };
    };
    delete snap.attrs.sensors["client_inboxes"];
    const clients = model({ snapshot: snap }).tools.supportDesk?.clients ?? [];
    expect(clients[0]?.inbox).toBeNull();
  });

  it("still reads a snapshot that uses the earlier sensor key names", () => {
    const snap = JSON.parse(JSON.stringify(raw["snapshot"])) as {
      attrs: { sensors: Record<string, unknown> };
    };
    const sensors = snap.attrs.sensors;
    const inboxes = sensors["client_inboxes"] as Record<string, unknown>;
    sensors["northwind_inbox"] = inboxes["northwind"];
    const [oldKey] = Object.entries(LEGACY_SNAPSHOT_KEYS).find(
      ([, now]) => now === "workshop",
    )!;
    sensors[oldKey] = sensors["workshop"];
    delete sensors["client_inboxes"];
    delete sensors["workshop"];
    const desk = model({ snapshot: snap }).tools.supportDesk;
    expect(desk?.clients[0]?.inbox).toMatch(/^4 open/);
    expect(desk?.workshop).toEqual(model().tools.supportDesk?.workshop);
  });

  it("takes the desk note and the default issue source from the config", () => {
    const desk = model().tools.supportDesk;
    expect(desk?.note).toBe(
      "Support Desk is only on Acme's Engine. Client Engines do not show it.",
    );
    const snap = JSON.parse(JSON.stringify(raw["snapshot"])) as {
      attrs: { findings: { source: string | null }[] };
    };
    snap.attrs.findings = snap.attrs.findings.map((f) => ({
      ...f,
      source: null,
    }));
    expect(model({ snapshot: snap }).tools.supportDesk?.issues[0]?.source).toBe(
      "Acme",
    );
  });

  it("counts waiting pull requests and open issues", () => {
    const d = model().tools.supportDesk;
    expect(d?.kpis.waiting).toBe(1);
    expect(d?.kpis.issues).toBe(1);
    expect(d?.kpis.issuesPill.state).toBe("crit");
  });
});

describe("Security", () => {
  const s = model().security;

  it("puts machine principals under Systems, people under People", () => {
    expect(s.people.map((p) => p.email)).toEqual(["owner@example.com"]);
    expect(s.systems.map((x) => x.handle)).toEqual([
      "kb-engine",
      "watch-embed",
      "kb_ingest",
    ]);
  });

  it("maps database roles to Owner and Member", () => {
    expect(s.people[0]?.role).toBe("Owner");
    const reader = model({
      people: [
        {
          handle: "dana",
          display_name: "Dana",
          role: "reader",
          active: true,
          email: "dana@example.com",
          domains: ["consulting"],
        },
      ],
    }).security.people[0];
    expect(reader?.role).toBe("Member");
    expect(reader?.areas).toEqual([
      { domain: "consulting", kind: "granted", locked: false },
    ]);
  });

  it("security counts come from the snapshot", () => {
    expect(s.kpis[2]?.value).toBe("720");
    expect(s.blocked[0]).toEqual({
      what: "Open a password or credential file",
      times: 201,
    });
    expect(s.layers).toHaveLength(5);
  });

  it("says 'No reading' instead of inventing zeros when the snapshot is missing", () => {
    const m = model({ snapshot: null }).security;
    expect(m.kpis[0]?.value).toBe("—");
    expect(m.layers[1]?.pill.state).toBe("off");
  });
});

describe("menus", () => {
  it("five menus with route ids the browser code expects", () => {
    const m = model();
    expect(m.menus.map((x) => x.id)).toEqual([
      "knowledge",
      "workers",
      "tools",
      "security",
      "support",
    ]);
    expect(m.menus.flatMap((x) => x.tabs.map((t) => t.route))).toEqual([
      "knowledge",
      "knowledge-sources",
      "knowledge-areas",
      "knowledge-review",
      "workers",
      "tools",
      "tools-support",
      "security",
      "security-access",
      "security-systems",
      "support",
    ]);
  });
});

describe("an Engine with no add-ons (config/engine.example.yaml)", () => {
  const plain = buildModel(exampleStatusConfig(), data(), NOW);

  it("draws no Workers menu and no Support Desk", () => {
    expect(plain.menus.map((m) => m.id)).toEqual([
      "knowledge",
      "tools",
      "security",
      "support",
    ]);
    expect(plain.workers.tasks).toEqual([]);
    expect(plain.tools.supportDesk).toBeNull();
    expect(plain.menus.flatMap((m) => m.tabs.map((t) => t.key))).not.toContain(
      "support_desk",
    );
  });

  it("builds its Knowledge gauges from the sources that are on", () => {
    expect(plain.knowledge.index?.label).toBe("Search index");
    expect(plain.knowledge.sources.map((s) => s.id)).toEqual([
      "documents",
      "meetings",
    ]);
  });

  it("has no sign-in check reading when the config names no check", () => {
    const passwords = plain.security.layers.find(
      (l) => l.title === "Passwords",
    );
    expect(passwords?.stat).toBe("No reading yet");
  });

  it("uses the engine name, tag prefix and topic labels from the config", () => {
    expect(plain.title).toBe("Acme's Knowledge Base Engine");
    expect(plain.tagPrefix).toBe("kx/");
    expect(plain.tools.connectorUrl).toBe("https://engine.example.com/mcp");
  });
});

describe("the sign-in check", () => {
  it("reads the job the config names", () => {
    const passwords = model().security.layers.find(
      (l) => l.title === "Passwords",
    );
    expect(passwords?.stat).not.toBe("No reading yet");
  });
});
