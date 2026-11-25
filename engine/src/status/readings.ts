import { z } from "zod";
import { durationMs, type DashboardJob } from "./config.js";
import { currentSnapshotKey } from "../config/legacy-names.js";
import { V3_READINGS } from "./readings-v3.js";

/**
 * Readings: the shape workspace.engine_status() and the caretaker snapshot
 * return, plus the small pure helpers that turn one reading into one gauge.
 * Nothing here touches the network, so every rule is unit-tested.
 */

export type Light = "green" | "amber" | "red" | "grey";

const ts = z.string().nullable().optional();

const Job = z
  .object({
    profile: z.string(),
    name: z.string(),
    enabled: z.boolean().nullable().optional(),
    last_run_at: ts,
    last_status: z.string().nullable().optional(),
    next_run_at: ts,
    failure_streak: z.number().nullable().optional(),
    last_error: z.string().nullable().optional(),
  })
  .passthrough();

const WorkshopJob = z
  .object({
    id: z.string().optional(),
    card: z.string().nullable().optional(),
    lane: z.string().nullable().optional(),
    repo: z.string().nullable().optional(),
    plan_title: z.string().nullable().optional(),
    pr_number: z.number().nullable().optional(),
    pr_url: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    outcome: z.string().nullable().optional(),
    started_at: ts,
    ended_at: ts,
  })
  .passthrough();

const count = z.number().default(0);

const ClientInbox = z.object({
  open: count,
  carded: count,
  backlog: count,
  groups: z.array(z.object({ tag: z.string(), count: z.number() })).default([]),
  newest_at: ts,
});

/**
 * A caretaker written before these keys were renamed still sends the old
 * ones. Map them to today's names so its snapshot keeps reading:
 *   the keys in config/legacy-names.ts (LEGACY_SNAPSHOT_KEYS)
 *   <id>_inbox    -> client_inboxes.<id>
 */
function renameLegacySensorKeys(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const entries = Object.entries(raw as Record<string, unknown>);
  const inboxes = entries.flatMap(([key, value]) => {
    const id = /^([a-z0-9-]+)_inbox$/.exec(key)?.[1];
    return id ? [[id, value] as const] : [];
  });
  const rest = entries
    .filter(([key]) => !/^[a-z0-9-]+_inbox$/.test(key))
    .map(([key, value]) => [currentSnapshotKey(key), value]);
  const given = (raw as { client_inboxes?: Record<string, unknown> })
    .client_inboxes;
  return {
    ...Object.fromEntries(rest),
    client_inboxes: { ...Object.fromEntries(inboxes), ...(given ?? {}) },
  };
}

const SecurityReading = z
  .object({
    sentry: z
      .object({
        count,
        verdicts: z.record(z.number()).default({}),
      })
      .default({}),
    tool_results: z
      .object({ count, pass: count, suspicious: count, fail: count })
      .default({}),
    tool_blocks: z
      .object({
        count,
        top_rules: z
          .array(z.object({ rule: z.string(), count: z.number() }))
          .default([]),
      })
      .default({}),
  })
  .passthrough();

export const StatusDataSchema = z.object({
  generated_at: z.string(),
  connectors: z
    .array(
      z.object({
        source: z.string(),
        last_run_at: ts,
        last_success_at: ts,
        consecutive_failures: z.number().default(0),
        last_error: z.string().nullable().optional(),
      }),
    )
    .default([]),
  review_undecided: z.number().default(0),
  documents: z
    .array(
      z.object({
        source: z.string(),
        live: z.number().default(0),
        approved: z.number().default(0),
      }),
    )
    .default([]),
  runs_daily: z
    .array(
      z.object({
        day: z.string(),
        source: z.string(),
        ok: z.boolean(),
        checked: z.number().default(0),
        changed: z.number().default(0),
        minutes: z.number().default(0),
      }),
    )
    .default([]),
  review_waiting: z
    .array(
      z.object({
        title: z.string().nullable().optional(),
        source: z.string().nullable().optional(),
        domains: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  areas: z
    .array(
      z.object({
        domain: z.string(),
        sensitive: z.boolean().default(false),
        items: z.number().default(0),
        sources: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  people: z
    .array(
      z.object({
        handle: z.string(),
        display_name: z.string().nullable().optional(),
        role: z.string(),
        active: z.boolean(),
        email: z.string().nullable().optional(),
        updated_at: ts,
        domains: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  snapshot: z
    .object({
      ts: z.string(),
      attrs: z
        .object({
          summary: z.array(z.string()).default([]),
          findings: z
            .array(
              z.object({
                source: z.string().nullable(),
                title: z.string().nullable(),
                urgent: z.boolean(),
              }),
            )
            .default([]),
          sensors: z
            .preprocess(
              renameLegacySensorKeys,
              z.object({
                jobs: z.array(Job).default([]),
                workshop: z.array(WorkshopJob).default([]),
                slack: z
                  .object({ ok: z.boolean(), at: ts })
                  .nullable()
                  .optional(),
                security: SecurityReading.nullable().optional(),
                selfheal: z
                  .object({ fixed: count, carded: count })
                  .nullable()
                  .optional(),
                needs_you: z.number().nullable().optional(),
                /** One issue inbox per client Engine, keyed by client id. */
                client_inboxes: z.record(ClientInbox.nullable()).default({}),
              }),
            )
            .nullable()
            .optional(),
        })
        .passthrough(),
    })
    .nullable()
    .optional(),
  recent: z
    .array(
      z.object({
        ts: z.string(),
        service: z.string(),
        component: z.string(),
        event: z.string(),
        status: z.string().nullable().optional(),
        level: z.string(),
      }),
    )
    .default([]),
  /** Added by migration 0041; absent from an older database. */
  ...V3_READINGS,
});

export type StatusData = z.infer<typeof StatusDataSchema>;

export type Gauge = {
  readonly id: string;
  readonly label: string;
  readonly light: Light;
  readonly detail: string;
  readonly note?: string;
};

const RANK: Record<Light, number> = { grey: 0, green: 1, amber: 2, red: 3 };

/** Worst light among those given; grey only when nothing else is present. */
export function worst(lights: readonly Light[]): Light {
  return lights.reduce<Light>(
    (acc, l) => (RANK[l] > RANK[acc] ? l : acc),
    "grey",
  );
}

/** "3h ago", "2d ago", "just now". */
export function ago(iso: string | null | undefined, now: Date): string {
  if (!iso) return "never";
  const ms = now.getTime() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "unknown";
  if (ms < 60_000) return "just now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes}m ago`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export function ageMs(iso: string | null | undefined, now: Date): number {
  return iso
    ? now.getTime() - new Date(iso).getTime()
    : Number.POSITIVE_INFINITY;
}

/** What sourceGauge needs; both sources and the Search index fit. */
export type SourceLike = {
  readonly id?: string;
  readonly label: string;
  readonly sensor: string;
  readonly enabled?: boolean;
  readonly off_reason?: string;
  readonly fresh_within: string;
  readonly alert_after: string;
};

export const sensorKey = (sensor: string): string =>
  sensor.slice(sensor.indexOf(":") + 1);

export function sourceGauge(
  source: SourceLike,
  data: StatusData,
  now: Date,
): Gauge {
  const base = {
    id: source.id ?? sensorKey(source.sensor),
    label: source.label,
  };
  if (source.enabled === false) {
    return {
      ...base,
      light: "grey",
      detail: "Off on purpose",
      note: source.off_reason,
    };
  }
  const row = data.connectors.find(
    (c) => c.source === sensorKey(source.sensor),
  );
  if (!row) return { ...base, light: "grey", detail: "No reading yet" };
  const read = `read ${ago(row.last_success_at, now)}`;
  if (row.consecutive_failures > 0) {
    return {
      ...base,
      light: "red",
      detail: `Failing: ${row.consecutive_failures} runs in a row, last good ${ago(row.last_success_at, now)}`,
      note: row.last_error ?? undefined,
    };
  }
  const age = ageMs(row.last_success_at, now);
  if (age > durationMs(source.alert_after))
    return { ...base, light: "red", detail: `Stale: ${read}` };
  if (age > durationMs(source.fresh_within))
    return { ...base, light: "amber", detail: `Getting stale: ${read}` };
  return { ...base, light: "green", detail: `Fresh: ${read}` };
}

export type JobRow = NonNullable<
  NonNullable<NonNullable<StatusData["snapshot"]>["attrs"]["sensors"]>["jobs"]
>[number];

export function findJob(
  sensor: string,
  jobs: readonly JobRow[],
): JobRow | undefined {
  const [profile, name] = sensorKey(sensor).split("/");
  return jobs.find((j) => j.profile === profile && j.name === name);
}

export function jobGauge(
  job: Pick<DashboardJob, "sensor" | "late_after">,
  rows: readonly JobRow[],
  now: Date,
): Gauge {
  const name = sensorKey(job.sensor).split("/")[1] ?? job.sensor;
  const row = findJob(job.sensor, rows);
  if (!row)
    return { id: name, label: name, light: "grey", detail: "No reading yet" };
  const next = row.next_run_at
    ? ` · next ${new Date(row.next_run_at).toISOString().slice(5, 16).replace("T", " ")} UTC`
    : "";
  const last = `last run ${ago(row.last_run_at, now)}`;
  if (row.enabled === false)
    return { id: name, label: name, light: "grey", detail: `Paused · ${last}` };
  if (
    (row.failure_streak ?? 0) > 0 ||
    (row.last_status && row.last_status !== "ok")
  ) {
    return {
      id: name,
      label: name,
      light: "red",
      detail: `Failed: ${last}`,
      note: row.last_error ?? undefined,
    };
  }
  if (ageMs(row.last_run_at, now) > durationMs(job.late_after)) {
    return {
      id: name,
      label: name,
      light: "amber",
      detail: `Late: ${last}${next}`,
    };
  }
  return {
    id: name,
    label: name,
    light: "green",
    detail: `OK · ${last}${next}`,
  };
}
