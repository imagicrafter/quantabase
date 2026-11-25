import type { StatusConfig } from "./config.js";
import {
  chicagoDay,
  formatWhen,
  pill,
  stateOf,
  truncate,
  worstState,
  type Pill,
} from "./model-shared.js";
import { ago, jobGauge, sensorKey, type StatusData } from "./readings.js";

/** Tools menu: Connect Claude, connected tools, and the Support Desk. */

type ToolDef = StatusConfig["engine"]["tools"]["connected"][number];
type WorkshopJobRow = NonNullable<
  NonNullable<StatusData["snapshot"]>["attrs"]["sensors"]
>["workshop"][number];

export type ToolRow = {
  readonly label: string;
  readonly does: string;
  readonly pill: Pill;
};

export type WorkshopRow = {
  readonly card: string;
  readonly title: string | null;
  readonly pr: number | null;
  readonly prUrl: string | null;
  readonly started: string;
  readonly result: Pill;
};

export type SupportDeskModel = {
  /** A line shown above the desk, from the config. */
  readonly note: string | null;
  readonly kpis: {
    readonly clients: number;
    readonly clientsNote: string;
    readonly issues: number;
    readonly issuesPill: Pill;
    readonly fixesToday: number;
    readonly waiting: number | null;
  };
  readonly issues: readonly {
    readonly title: string;
    readonly source: string;
    readonly urgent: boolean;
  }[];
  readonly clients: readonly {
    readonly label: string;
    readonly repo: string | null;
    readonly feed: string;
    readonly pill: Pill;
    /** One line about the client's issue inbox, or null when nothing is read. */
    readonly inbox: string | null;
  }[];
  readonly workshop: readonly WorkshopRow[];
  readonly gates: readonly ToolRow[];
};

export type ToolsModel = {
  /** null when the config names no connector address. */
  readonly connectorUrl: string | null;
  readonly connectPill: Pill;
  readonly connected: readonly ToolRow[];
  readonly supportDesk: SupportDeskModel | null;
  readonly badge: Pill;
};

function sensorsOf(data: StatusData) {
  return data.snapshot?.attrs.sensors ?? null;
}

/** One tool, one pill, decided by the kind of sensor it names. */
export function toolPill(tool: ToolDef, data: StatusData, now: Date): Pill {
  const kind = tool.sensor.split(":")[0];
  const sensors = sensorsOf(data);
  if (kind === "static") return pill("good", "Set up");
  if (kind === "host_state" && tool.sensor.includes("slack")) {
    const s = sensors?.slack;
    if (!s) return pill("off", "No reading yet");
    return s.ok ? pill("good", "Connected") : pill("crit", "Posting failed");
  }
  if (kind === "connector_state") {
    const row = data.connectors.find(
      (c) => c.source === sensorKey(tool.sensor),
    );
    if (!row) return pill("off", "No reading yet");
    return row.consecutive_failures > 0
      ? pill("crit", "Failing")
      : pill("good", "Connected");
  }
  if (kind === "agent_job") {
    const g = jobGauge(
      { sensor: tool.sensor, late_after: "1h" },
      sensors?.jobs ?? [],
      now,
    );
    const word = {
      good: "On time",
      warn: "Late",
      crit: "Failed",
      off: "No reading yet",
    };
    const state = stateOf(g.light);
    return pill(state, word[state]);
  }
  if (kind === "github_prs") {
    return sensors?.needs_you == null
      ? pill("off", "No reading yet")
      : pill("good", "Connected");
  }
  return pill("off", "No reading yet");
}

const toRow = (tool: ToolDef, data: StatusData, now: Date): ToolRow => ({
  label: tool.label,
  does: tool.does ?? "",
  pill: toolPill(tool, data, now),
});

function titleCase(text: string): string {
  const spaced = text.replace(/[_-]+/g, " ").trim().replace(/^pr\b/i, "PR");
  return spaced ? spaced[0]?.toUpperCase() + spaced.slice(1) : spaced;
}

function workshopRow(a: WorkshopJobRow): WorkshopRow {
  const building = a.state === "running" && !a.ended_at;
  const outcome = a.outcome ?? a.state ?? "finished";
  const result = building
    ? pill("warn", "Building now")
    : /fail|error|abort|timeout|cancel/i.test(outcome)
      ? pill("crit", titleCase(outcome))
      : pill("good", titleCase(outcome));
  return {
    card: a.card ?? a.id ?? "unknown",
    title: a.plan_title ? truncate(a.plan_title, 90) : null,
    pr: a.pr_number ?? null,
    prUrl: a.pr_url ?? null,
    started: formatWhen(a.started_at),
    result,
  };
}

type ClientInbox = NonNullable<
  NonNullable<
    NonNullable<StatusData["snapshot"]>["attrs"]["sensors"]
  >["client_inboxes"][string]
>;

/** "3 open · 2 with a card · 1 old backlog · newest 2h ago". Counts only, never row text. */
export function inboxLine(
  inbox: ClientInbox | null | undefined,
  now: Date,
): string | null {
  if (!inbox) return null;
  const parts = [
    `${inbox.open} open`,
    `${inbox.carded} with a card`,
    ...(inbox.backlog ? [`${inbox.backlog} old backlog`] : []),
    ...inbox.groups.map((g) => `${g.count} batched (${g.tag})`),
    ...(inbox.newest_at ? [`newest ${ago(inbox.newest_at, now)}`] : []),
  ];
  return parts.join(" · ");
}

function buildSupportDesk(
  config: StatusConfig,
  data: StatusData,
  now: Date,
): SupportDeskModel | null {
  const desk = config.engine.tools.support_desk;
  if (!desk?.enabled) return null;
  const sensors = sensorsOf(data);
  const rows = sensors?.jobs ?? [];
  const raw = sensors?.workshop ?? [];
  const workshop = raw.map(workshopRow);
  const today = chicagoDay(now);
  const fixesToday = raw.filter(
    (a) => a.started_at && chicagoDay(new Date(a.started_at)) === today,
  ).length;
  const findings = data.snapshot?.attrs.findings ?? [];

  const clients = desk.client_engines.map((c) => {
    if (c.status === "planned") {
      return {
        label: c.label,
        repo: c.repo,
        feed: "—",
        pill: pill("off", "Planned"),
        inbox: null,
      };
    }
    const prefix = c.id.split("-")[0] ?? c.id;
    const job = config.engine.workers
      .flatMap((w) => w.jobs)
      .find((j) => sensorKey(j.sensor).split("/")[1] === `${prefix}-inbox`);
    const gauge = job ? jobGauge(job, rows, now) : null;
    const state = gauge ? stateOf(gauge.light) : "off";
    return {
      label: c.label,
      repo: c.repo,
      inbox: inboxLine(
        sensors?.client_inboxes[c.id] ?? sensors?.client_inboxes[prefix],
        now,
      ),
      feed: job?.when ?? "—",
      pill: pill(
        state,
        {
          good: "Connected",
          warn: "Feed late",
          crit: "Feed failing",
          off: "No reading yet",
        }[state],
      ),
    };
  });
  const planned = clients.filter((c) => c.pill.text === "Planned").length;
  const connected = clients.filter((c) => c.pill.state === "good").length;

  return {
    note: desk.note ?? null,
    kpis: {
      clients: clients.length,
      clientsNote: `${connected} connected · ${planned} planned`,
      issues: findings.length,
      issuesPill: findings.some((f) => f.urgent)
        ? pill("crit", "Urgent")
        : findings.length
          ? pill("warn", "Open")
          : pill("good", "None open"),
      fixesToday,
      waiting: sensors?.needs_you ?? null,
    },
    issues: findings.map((f) => ({
      title: f.title ?? "Issue",
      source: f.source ?? desk.default_issue_source ?? config.engine.name,
      urgent: f.urgent,
    })),
    clients,
    workshop,
    gates: desk.tools
      .filter((t) => !t.sensor.startsWith("workshop_jobs"))
      .map((t) => toRow(t, data, now)),
  };
}

export function buildTools(
  config: StatusConfig,
  data: StatusData,
  now: Date,
): ToolsModel {
  const connected = config.engine.tools.connected.map((t) =>
    toRow(t, data, now),
  );
  const supportDesk = buildSupportDesk(config, data, now);
  const states = [
    ...connected.map((r) => r.pill.state),
    ...(supportDesk?.gates.map((r) => r.pill.state) ?? []),
  ];
  const worst = worstState(states);
  return {
    connectorUrl: config.engine.connect.connector_url,
    connectPill: pill("good", "Connected"),
    connected,
    supportDesk,
    badge:
      worst === "crit"
        ? pill("crit", "A tool needs a look")
        : worst === "warn"
          ? pill("warn", "Check tools")
          : pill("good", "Connected"),
  };
}
