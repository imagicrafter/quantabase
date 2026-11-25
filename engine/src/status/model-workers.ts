import type { StatusConfig } from "./config.js";
import {
  pill,
  plural,
  truncate,
  stateOf,
  worstState,
  type Pill,
  type State,
} from "./model-shared.js";
import { ago, findJob, jobGauge, type StatusData } from "./readings.js";

/** Workers menu: labelled jobs shown as outcomes ("Monday summary email: sent"). */

export type Task = {
  readonly what: string;
  readonly when: string;
  readonly last: string;
  readonly pill: Pill;
};

export type WorkersModel = {
  readonly tasks: readonly Task[];
  readonly kpis: {
    readonly total: number;
    readonly onTime: number;
    readonly onTimePill: Pill;
    readonly fixedItself: number | null;
    readonly needsLook: number;
  };
  readonly emptyChart: string;
  readonly badge: Pill;
};

const PILL_TEXT: Record<State, string> = {
  good: "Done",
  warn: "Late",
  crit: "Needs a look",
  off: "Not reporting",
};

function lastResult(
  state: State,
  row: ReturnType<typeof findJob>,
  now: Date,
): string {
  if (!row) return "No reading yet";
  if (row.enabled === false) return "Paused";
  if (state === "crit") {
    return row.last_error
      ? `Stopped: ${truncate(row.last_error, 120)}`
      : "Stopped: the last run failed";
  }
  const when = ago(row.last_run_at, now);
  return state === "warn" ? `Late: last run ${when}` : `Done ${when}`;
}

export function buildWorkers(
  config: StatusConfig,
  data: StatusData,
  now: Date,
): WorkersModel {
  const rows = data.snapshot?.attrs.sensors?.jobs ?? [];
  const tasks: Task[] = config.engine.workers
    .flatMap((w) => w.jobs)
    .filter((j) => j.task)
    .map((job) => {
      const gauge = jobGauge(job, rows, now);
      const state = stateOf(gauge.light);
      return {
        what: job.task ?? gauge.label,
        when: job.when ?? job.schedule ?? "",
        last: lastResult(state, findJob(job.sensor, rows), now),
        pill: pill(state, PILL_TEXT[state]),
      };
    });

  const onTime = tasks.filter((t) => t.pill.state === "good").length;
  const needsLook = tasks.filter(
    (t) => t.pill.state === "crit" || t.pill.state === "warn",
  ).length;
  const worst = worstState(tasks.map((t) => t.pill.state));
  const ratio = tasks.length ? onTime / tasks.length : 0;

  return {
    tasks,
    kpis: {
      total: tasks.length,
      onTime,
      onTimePill: pill(
        onTime === tasks.length ? "good" : "warn",
        `${Math.round(ratio * 100)}%`,
      ),
      fixedItself: data.snapshot?.attrs.sensors?.selfheal?.fixed ?? null,
      needsLook,
    },
    emptyChart:
      "Daily history starts with the live version, so this chart fills in day by day.",
    badge:
      worst === "crit"
        ? pill(
            "crit",
            `${needsLook} ${needsLook === 1 ? "task needs" : "tasks need"} a look`,
          )
        : worst === "warn"
          ? pill("warn", `${plural(needsLook, "task")} running late`)
          : worst === "off"
            ? pill("off", "No readings yet")
            : pill("good", "All on time"),
  };
}
