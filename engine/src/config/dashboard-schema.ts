import { z } from "zod";
import { normalizeSensor } from "./legacy-names.js";

/**
 * The optional `dashboard` section of the Engine config: what the status page
 * shows. Each gauge names a `sensor` that reads real state; the page never
 * measures anything itself.
 *
 * Sensor kinds:
 *   connector_state:<source>     workspace.connector_state row (pullers)
 *   review_items:undecided       workspace.review_items count
 *   engine_health:<url>          HTTP /health of a deployed service
 *   agent_job:<profile>/<name>   a scheduled agent job (last run, result)
 *   host_state:<path>            a JSON state file on the agent host
 *   workshop_jobs                build-workshop job records
 *   github_prs:<owner>           open pull requests
 *   static                       no live check; shown as set up
 *   client_inbox:<client>        that client Engine's issue log
 *
 * Agent, workshop and client-engine sensors are add-ons fed by a caretaker
 * snapshot. An Engine that names none of them shows none of those panels.
 */

// Earlier sensor kind names are still accepted: see legacy-names.ts.
export { normalizeSensor };

const Sensor = z.string().min(1).transform(normalizeSensor);

export const Duration = z
  .string()
  .regex(/^\d+(m|h|d)$/, "use a duration like 30m, 26h or 7d");

const Source = z.object({
  id: z.string(),
  label: z.string(),
  sensor: Sensor,
  schedule: z.string().optional(),
  connection: z.string().optional(),
  owner: z.string().optional(),
  share: z.string().optional(),
  enabled: z.boolean().default(true),
  off_reason: z.string().optional(),
  fresh_within: Duration.default("26h"),
  alert_after: Duration.default("48h"),
});

const SearchIndex = z.object({
  label: z.string(),
  sensor: Sensor,
  schedule: z.string().optional(),
  fresh_within: Duration.default("26h"),
  alert_after: Duration.default("48h"),
});

const Job = z.object({
  sensor: Sensor,
  schedule: z.string().optional(),
  late_after: Duration.default("26h"),
  /** Outcome-style name shown under Workers. Jobs without one stay hidden. */
  task: z.string().optional(),
  /** Human schedule shown next to the task ("Every 2 hours"). */
  when: z.string().optional(),
});

const Worker = z.object({
  id: z.string(),
  role: z.enum(["caretaker", "worker"]).optional(),
  label: z.string(),
  does: z.string().optional(),
  jobs: z.array(Job).default([]),
  uses: z.array(z.string()).default([]),
  reports_to: z.string().optional(),
});

const Tool = z.object({
  id: z.string(),
  label: z.string(),
  does: z.string().optional(),
  can: z.array(z.string()).default([]),
  sensor: Sensor,
});

const ClientEngine = z.object({
  id: z.string(),
  label: z.string(),
  repo: z.string().nullable().default(null),
  status: z.string().default("active"),
  sensor: Sensor.optional(),
});

const SupportDesk = z.object({
  enabled: z.boolean().default(false),
  /** Shown above the desk, e.g. which Engine runs it. */
  note: z.string().optional(),
  /** Label used for an issue that names no source. */
  default_issue_source: z.string().optional(),
  tools: z.array(Tool).default([]),
  client_engines: z.array(ClientEngine).default([]),
});

const StaticSystem = z.object({
  handle: z.string(),
  name: z.string(),
  what: z.string(),
});

/** Tabs allowed under each menu. The shell has five menus and no others. */
export const MENU_TABS = {
  knowledge: ["overview", "sources", "areas", "review"],
  workers: ["tasks"],
  tools: ["connected", "support_desk"],
  security: ["layers", "people", "systems"],
  /** The Engine's own issue log. Shown unless set to an empty list. */
  support: ["issues"],
} as const;

export type MenuId = keyof typeof MENU_TABS;

const tabList = <K extends MenuId>(menu: K) =>
  z.array(z.enum(MENU_TABS[menu])).default([]);

const Menus = z.object({
  knowledge: tabList("knowledge"),
  workers: tabList("workers"),
  tools: tabList("tools"),
  security: tabList("security"),
  support: z.array(z.enum(MENU_TABS.support)).default(["issues"]),
});

const Connect = z.object({
  connector_url: z.string().url(),
  login: z.string().default("email-code"),
  status_page_url: z.string().url().optional(),
  status_page_login: z.string().optional(),
  /** AUD tag of the sign-in app guarding /status. Names the app; not a secret. */
  status_page_aud: z.string().optional(),
});

const Knowledge = z.object({
  index: SearchIndex.optional(),
  sources: z.array(Source),
  review_queue: z
    .object({
      label: z.string(),
      sensor: Sensor,
      warn_over: z.number().int().default(25),
    })
    .optional(),
  /** Plain-words description of each topic, keyed by topic id. */
  area_notes: z.record(z.string()).default({}),
});

export const DashboardSchema = z.object({
  /** Defaults to engine.name. */
  title: z.string().optional(),
  /** Defaults to Knowledge and Security. */
  menus: Menus.optional(),
  ask_claude_buttons: z.boolean().default(true),
  connect: Connect.optional(),
  /** Defaults to gauges built from the top-level `sources` section. */
  knowledge: Knowledge.optional(),
  workers: z.array(Worker).default([]),
  tools: z
    .object({
      connected: z.array(Tool).default([]),
      support_desk: SupportDesk.optional(),
    })
    .default({}),
  security: z
    .object({
      systems_static: z.array(StaticSystem).default([]),
      system_notes: z.record(z.string()).default({}),
      /** The job whose result is shown as the daily sign-in check. */
      login_check_sensor: Sensor.optional(),
    })
    .default({}),
});

export type Dashboard = z.infer<typeof DashboardSchema>;
export type DashboardKnowledge = z.infer<typeof Knowledge>;
export type DashboardMenus = z.infer<typeof Menus>;
export type DashboardJob = z.infer<typeof Job>;
export type DashboardTool = z.infer<typeof Tool>;

/** "26h" -> milliseconds. */
export function durationMs(value: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(value);
  if (!match) throw new Error(`bad duration ${value}`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as "m" | "h" | "d"
  ];
  return Number(match[1]) * unit;
}
