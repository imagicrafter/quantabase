import { MENU_TABS, type StatusConfig, type MenuId } from "./config.js";
import type { PageAccess } from "./model-access.js";
import { buildKnowledge, type KnowledgeModel } from "./model-knowledge.js";
import { bannerState, type Banner } from "./model-overall.js";
import { buildSecurity, type SecurityModel } from "./model-security.js";
import {
  pill,
  plural,
  windowDays,
  worstState,
  type Pill,
  type State,
} from "./model-shared.js";
import { buildSupport, type SupportModel } from "./model-support.js";
import { buildTools, type ToolsModel } from "./model-tools.js";
import { buildWorkers, type WorkersModel } from "./model-workers.js";
import { ago, sensorKey, type StatusData } from "./readings.js";

/**
 * buildModel: Engine config + database readings + caretaker snapshot -> the one
 * JSON object the page draws from. Every state, label and number is decided
 * here, in pure functions, so the browser code only draws.
 */

/** The caretaker writes a reading every 2h; older than this means it went quiet. */
const READING_STALE_MS = 3 * 3_600_000;

const MENU_COPY: Record<MenuId, { label: string; blurb: string }> = {
  knowledge: {
    label: "Knowledge",
    blurb:
      "What your Engine knows. Every night it reads your approved sources and keeps the originals.",
  },
  workers: {
    label: "Workers",
    blurb: "The work your Engine does for you, and whether it happened.",
  },
  tools: {
    label: "Tools",
    blurb: "Where your Engine connects: Claude, and the tools workers use.",
  },
  security: {
    label: "Security",
    blurb:
      "How your Engine guards what comes in, who sees what, and what needs your yes.",
  },
  support: {
    label: "Support",
    blurb:
      "Problems your Engine has noticed or people have reported, and what was fixed.",
  },
};

const TAB_LABEL: Record<string, string> = {
  overview: "Overview",
  sources: "Sources",
  areas: "Areas",
  review: "Waiting for your OK",
  tasks: "Tasks",
  connected: "Connected",
  support_desk: "Support Desk",
  layers: "Layers",
  people: "People",
  systems: "Systems",
  issues: "Issues",
};

const TAB_ROUTE: Record<string, string> = {
  overview: "knowledge",
  sources: "knowledge-sources",
  areas: "knowledge-areas",
  review: "knowledge-review",
  tasks: "workers",
  connected: "tools",
  support_desk: "tools-support",
  layers: "security",
  people: "security-access",
  systems: "security-systems",
  issues: "support",
};

export type MenuModel = {
  readonly id: MenuId;
  readonly label: string;
  readonly blurb: string;
  readonly badge: Pill;
  readonly tabs: readonly {
    readonly key: string;
    readonly route: string;
    readonly label: string;
  }[];
};

export type DashboardModel = {
  readonly title: string;
  readonly askClaude: boolean;
  /** The tag prefix from the config, e.g. "kx/". */
  readonly tagPrefix: string;
  /** A real topic id to use in the page's example requests. */
  readonly exampleTopic: string;
  readonly overall: Pill & {
    readonly detail: string;
    /** The two-state answer of the banner rule (model-overall.ts). */
    readonly banner: Banner["state"];
  };
  readonly days: readonly string[];
  readonly menus: readonly MenuModel[];
  readonly knowledge: KnowledgeModel;
  readonly workers: WorkersModel;
  readonly tools: ToolsModel;
  readonly security: SecurityModel;
  readonly support: SupportModel;
};

/** The facts the banner rule needs, read from the config and the readings. */
function bannerFor(config: StatusConfig, data: StatusData, now: Date): Banner {
  const k = config.engine.knowledge;
  const parts = [
    ...k.sources.map((s) => ({ ...s, enabled: s.enabled })),
    ...(k.index ? [{ ...k.index, enabled: true }] : []),
  ];
  return bannerState({
    openIssues: data.issues?.open ?? [],
    sources: parts.map((part) => {
      const row = data.connectors.find(
        (c) => c.source === sensorKey(part.sensor),
      );
      return {
        label: part.label,
        enabled: part.enabled,
        hasReading: row !== undefined,
        lastSuccessAt: row?.last_success_at,
        alertAfter: part.alert_after,
      };
    }),
    now,
  });
}

function overallOf(
  k: KnowledgeModel,
  w: WorkersModel,
  t: ToolsModel,
  s: SecurityModel,
  banner: Banner,
  expectsCaretaker: boolean,
  data: StatusData,
  now: Date,
): DashboardModel["overall"] {
  const snapshot = data.snapshot;
  const age = snapshot
    ? now.getTime() - new Date(snapshot.ts).getTime()
    : Number.POSITIVE_INFINITY;
  const checked = snapshot
    ? `checked ${ago(snapshot.ts, now)}`
    : expectsCaretaker
      ? "no caretaker reading yet"
      : `read ${ago(data.generated_at, now)}`;
  const needsYou = snapshot?.attrs.sensors?.needs_you ?? 0;

  const reasons: { state: State; text: string }[] = [];
  // Only an Engine that names workers has a caretaker to go quiet.
  if (expectsCaretaker && !(age < READING_STALE_MS)) {
    reasons.push({ state: "crit", text: "The caretaker has gone quiet" });
  }
  if (k.index?.pill.state === "crit") {
    reasons.push({
      state: "crit",
      text: `${k.index.label} ${k.index.pill.text.toLowerCase()}`,
    });
  }
  for (const src of k.sources) {
    if (src.pill.state === "crit") {
      reasons.push({
        state: "crit",
        text: `${src.label}: ${src.pill.text.toLowerCase()}`,
      });
    }
  }
  const stopped = w.tasks.filter((x) => x.pill.state === "crit").length;
  if (stopped) {
    reasons.push({ state: "crit", text: `${plural(stopped, "task")} stopped` });
  }
  if (t.badge.state === "crit") {
    reasons.push({ state: "crit", text: t.badge.text });
  }
  if (s.badge.state === "crit") {
    reasons.push({ state: "crit", text: s.badge.text });
  }
  for (const text of banner.reasons) reasons.push({ state: "crit", text });
  const drifting = k.sources.filter((x) => x.pill.state === "warn");
  for (const src of drifting) {
    reasons.push({ state: "warn", text: `${src.label}: ${src.pill.text}` });
  }
  if (needsYou > 0) {
    reasons.push({ state: "warn", text: `${needsYou} waiting for you` });
  }
  if (w.badge.state === "warn") {
    reasons.push({ state: "warn", text: w.badge.text });
  }

  const state = worstState(reasons.map((r) => r.state));
  const first = reasons.find((r) => r.state === state);
  const head =
    state === "crit"
      ? "Attention needed"
      : state === "warn"
        ? "Heads up"
        : "All working";
  return {
    ...pill(state === "off" ? "good" : state, head),
    detail: `${first ? `${first.text} · ` : ""}${checked}`,
    banner: state === "crit" ? "attention" : "working",
  };
}

export function buildModel(
  config: StatusConfig,
  data: StatusData,
  now: Date,
  page: PageAccess = {},
): DashboardModel {
  const days = windowDays(now);
  const knowledge = buildKnowledge(config, data, days, now);
  const workers = buildWorkers(config, data, now);
  const tools = buildTools(config, data, now);
  const security = buildSecurity(config, data, now, page);
  const support = buildSupport(config, data, now);
  const badges: Record<MenuId, Pill> = {
    knowledge: knowledge.badge,
    workers: workers.badge,
    tools: tools.badge,
    security: security.badge,
    support: support.badge,
  };

  const menus: MenuModel[] = (Object.keys(MENU_TABS) as MenuId[]).flatMap(
    (id) => {
      const tabs = config.dashboard.menus[id].map((key) => ({
        key,
        route: TAB_ROUTE[key] ?? id,
        label: TAB_LABEL[key] ?? key,
      }));
      return tabs.length
        ? [{ id, ...MENU_COPY[id], badge: badges[id], tabs }]
        : [];
    },
  );

  return {
    title: config.dashboard.title,
    askClaude: config.dashboard.ask_claude_buttons,
    tagPrefix: config.engine.tag_prefix,
    exampleTopic: data.areas.find((a) => !a.sensitive)?.domain ?? "topic",
    overall: overallOf(
      knowledge,
      workers,
      tools,
      security,
      bannerFor(config, data, now),
      config.engine.workers.length > 0,
      data,
      now,
    ),
    days,
    menus,
    knowledge,
    workers,
    tools,
    security,
    support,
  };
}
