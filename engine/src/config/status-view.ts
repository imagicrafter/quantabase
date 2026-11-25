import type {
  Dashboard,
  DashboardKnowledge,
  DashboardMenus,
} from "./dashboard-schema.js";

/**
 * The status page's view of the Engine config: the optional `dashboard`
 * section with every default filled in. A config with no `dashboard` section
 * still yields a page (Knowledge and Security, built from `sources`); panels
 * whose parts are not configured are left out rather than drawn empty.
 */

/** The parts of the whole config this view is built from. */
export type StatusViewInput = {
  readonly engine: {
    readonly id: string;
    readonly name: string;
    readonly owner: { readonly email: string };
  };
  readonly domains: readonly { readonly id: string; readonly label: string }[];
  readonly tagging: { readonly prefix: string };
  readonly sources: {
    readonly wiki: { readonly enabled: boolean };
    readonly drive: { readonly enabled: boolean };
    readonly fireflies: { readonly enabled: boolean };
    readonly gmail: {
      readonly enabled: boolean;
      readonly prefix: string | null;
    };
  };
  readonly dashboard?: Dashboard | undefined;
  readonly support?:
    | { readonly care_plan: { readonly enabled: boolean } }
    | undefined;
};

export type StatusConfig = {
  readonly engine: {
    readonly id: string;
    readonly name: string;
    readonly owner: string;
    readonly tag_prefix: string;
    readonly connect: {
      readonly connector_url: string | null;
      readonly login: string;
      readonly status_page_url?: string | undefined;
      readonly status_page_login?: string | undefined;
      readonly status_page_aud?: string | undefined;
    };
    readonly knowledge: DashboardKnowledge;
    readonly workers: Dashboard["workers"];
    readonly tools: Dashboard["tools"];
    readonly security: Dashboard["security"];
    /**
     * `support.care_plan.enabled`: what the owner intends. Whether support
     * access really exists is read from the database (status/model-support).
     */
    readonly care_plan_intended: boolean;
  };
  readonly dashboard: {
    readonly title: string;
    readonly menus: DashboardMenus;
    readonly ask_claude_buttons: boolean;
  };
};

const FRESH = { fresh_within: "26h", alert_after: "48h" } as const;

function defaultSources(input: StatusViewInput): DashboardKnowledge["sources"] {
  const { sources, tagging, engine } = input;
  const tag = `${tagging.prefix}[topic]`;
  const mailTag = `${sources.gmail.prefix ?? tagging.prefix}[topic]`;
  const base = { enabled: true, owner: engine.owner.email };
  return [
    ...(sources.drive.enabled
      ? [
          {
            ...base,
            ...FRESH,
            id: "documents",
            label: "Documents",
            sensor: "connector_state:drive",
            connection: "Google Drive",
            share: `Put ${tag} in a file's or folder's description`,
          },
        ]
      : []),
    ...(sources.fireflies.enabled
      ? [
          {
            ...base,
            ...FRESH,
            id: "meetings",
            label: "Meetings",
            sensor: "connector_state:fireflies",
            connection: "Fireflies",
            share: `Fireflies channel ${tag}. Notes only`,
          },
        ]
      : []),
    ...(sources.gmail.enabled
      ? [
          {
            ...base,
            ...FRESH,
            id: "email",
            label: "Email",
            sensor: "connector_state:gmail",
            connection: "Gmail",
            share: `Label a thread ${mailTag}. Unlabeled mail never comes in`,
          },
        ]
      : []),
  ];
}

function defaultKnowledge(input: StatusViewInput): DashboardKnowledge {
  return {
    ...(input.sources.wiki.enabled
      ? {
          index: {
            ...FRESH,
            label: "Search index",
            sensor: "connector_state:wiki",
          },
        }
      : {}),
    sources: defaultSources(input),
    review_queue: {
      label: "Waiting for review",
      sensor: "review_items:undecided",
      warn_over: 25,
    },
    area_notes: {},
  };
}

function areaNotes(
  input: StatusViewInput,
  given: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    unclassified:
      "Items with no topic tag yet. Locked to the owner until each gets a topic.",
    ...Object.fromEntries(input.domains.map((d) => [d.id, d.label])),
    ...given,
  };
}

function resolveMenus(
  dash: Dashboard | undefined,
  hasTasks: boolean,
): DashboardMenus {
  const given = dash?.menus;
  const menus: DashboardMenus = given ?? {
    knowledge: ["overview", "sources", "areas", "review"],
    workers: ["tasks"],
    tools: dash?.connect ? ["connected"] : [],
    security: ["layers", "people", "systems"],
    support: ["issues"],
  };
  // A Workers menu with no task to show is left out, not drawn empty.
  return { ...menus, workers: hasTasks ? menus.workers : [] };
}

/** Fill in every default so the page code never deals with a missing part. */
export function resolveStatusConfig(input: StatusViewInput): StatusConfig {
  const dash = input.dashboard;
  const knowledge = dash?.knowledge ?? defaultKnowledge(input);
  const workers = dash?.workers ?? [];
  const hasTasks = workers.some((w) => w.jobs.some((j) => j.task));
  return {
    engine: {
      id: input.engine.id,
      name: input.engine.name,
      owner: input.engine.owner.email,
      tag_prefix: input.tagging.prefix,
      connect: dash?.connect ?? { connector_url: null, login: "email-code" },
      knowledge: {
        ...knowledge,
        area_notes: areaNotes(input, knowledge.area_notes),
      },
      workers,
      tools: dash?.tools ?? { connected: [] },
      security: dash?.security ?? { systems_static: [], system_notes: {} },
      care_plan_intended: input.support?.care_plan.enabled === true,
    },
    dashboard: {
      title: dash?.title ?? input.engine.name,
      menus: resolveMenus(dash, hasTasks),
      ask_claude_buttons: dash?.ask_claude_buttons ?? true,
    },
  };
}

/** Cross-field rules for the dashboard section; one message per problem. */
export function dashboardProblems(cfg: StatusConfig): string[] {
  const { knowledge, tools, workers } = cfg.engine;
  const known = new Set([
    ...(knowledge.index ? ["knowledge.index"] : []),
    ...knowledge.sources.map((s) => `knowledge.${s.id}`),
    ...tools.connected.map((t) => `tools.${t.id}`),
    ...(tools.support_desk?.tools ?? []).map((t) => `tools.${t.id}`),
  ]);
  return [
    ...workers.flatMap((w) =>
      w.uses
        .filter((use) => !known.has(use))
        .map((use) => `worker ${w.id} uses unknown part ${use}`),
    ),
    ...workers.flatMap((w) =>
      w.jobs
        .filter((j) => j.task && !j.sensor.startsWith("agent_job:"))
        .map((j) => `task "${j.task}" needs an agent_job sensor`),
    ),
    ...knowledge.sources
      .filter((s) => !s.enabled && !s.off_reason)
      .map((s) => `source ${s.id} is off without an off_reason`),
    ...(cfg.dashboard.menus.tools.includes("support_desk") &&
    !tools.support_desk?.enabled
      ? ["support_desk tab needs tools.support_desk.enabled: true"]
      : []),
  ];
}
