import { ago, formatWhen, pill, plural, type Pill } from "./model-shared.js";
import type { StatusConfig } from "./config.js";
import type { StatusData } from "./readings.js";
import type { OpenIssueRow } from "./readings-v3.js";

/**
 * Support menu: the Engine's own issue log. What is open, how much was fixed
 * in the last 30 days, whether Care Plan access is on, and whether the config
 * in force is the latest one. View-only.
 */

export type IssueRow = {
  readonly kind: string;
  readonly source: string;
  readonly title: string;
  readonly pill: Pill;
  readonly opened: string;
  readonly seen: string;
  readonly card: string;
};

export type SupportModel = {
  /** False when the database predates the issue reading. */
  readonly available: boolean;
  readonly open: readonly IssueRow[];
  readonly fixed30: number | null;
  readonly carePlan: Pill;
  readonly carePlanNote: string;
  readonly emptyText: string;
  readonly config: {
    readonly applied: string;
    readonly pill: Pill;
    readonly note: string | null;
  } | null;
  readonly badge: Pill;
};

const KIND: Readonly<Record<string, string>> = {
  source_failure: "Source failing",
  config_invalid: "Config rejected",
  unknown_tag: "Unknown tag",
  data_quality_issue: "Reported problem",
  feature_gap: "Reported problem",
  friction_point: "Reported problem",
};

const URGENT = new Set(["source_failure", "config_invalid"]);

function statusPill(issue: OpenIssueRow): Pill {
  if (issue.status === "in_progress") return pill("warn", "Being fixed");
  if (issue.status === "fixed_pending_proof") {
    return pill("warn", "Fixed, waiting for proof");
  }
  return pill(URGENT.has(issue.category) ? "crit" : "warn", "Open");
}

function issueRow(issue: OpenIssueRow, now: Date): IssueRow {
  return {
    kind: KIND[issue.category] ?? "Problem",
    source: issue.source ?? "—",
    title: issue.title,
    pill: statusPill(issue),
    opened: issue.opened_at ? ago(issue.opened_at, now) : "unknown",
    seen: plural(issue.occurrences, "time"),
    card: issue.has_card ? "Being worked on" : "Not picked up yet",
  };
}

function configState(data: StatusData): SupportModel["config"] {
  if (!data.config) return null;
  const applied = data.config.applied_at
    ? formatWhen(data.config.applied_at)
    : "never";
  return data.config.rejected
    ? {
        applied,
        pill: pill("crit", "Last change rejected"),
        note: "The newest config in the knowledge repo was not valid, so the earlier config is still in force. Fix the file and the next run applies it.",
      }
    : { applied, pill: pill("good", "In force"), note: null };
}

function badgeFor(rows: readonly IssueRow[]): Pill {
  if (!rows.length) return pill("good", "Nothing open");
  const urgent = rows.some((r) => r.pill.state === "crit");
  return pill(urgent ? "crit" : "warn", `${rows.length} open`);
}

type CarePlan = Pick<SupportModel, "carePlan" | "carePlanNote">;

/**
 * The Care Plan line. `intended` is what the config says
 * (`support.care_plan.enabled`); `actual` is whether a support login really
 * exists in the database. When the two disagree the line says so: a support
 * login nobody asked for is never shown as a plain "On".
 */
export function carePlanLine(intended: boolean, actual: boolean): CarePlan {
  if (intended && actual) {
    return {
      carePlan: pill("good", "On"),
      carePlanNote:
        "A support login can read this issue list and nothing else. It cannot read your knowledge.",
    };
  }
  if (intended) {
    return {
      carePlan: pill("warn", "Not set up"),
      carePlanNote:
        "The config says this Engine is on a Care Plan (support.care_plan.enabled), but no support login exists yet. The owner runs `kbe support enable` to make one.",
    };
  }
  if (actual) {
    return {
      carePlan: pill("crit", "On, not in config"),
      carePlanNote:
        "A support login exists and can read this issue list (never your knowledge), but the config does not say this Engine is on a Care Plan. If nobody should have it, run `kbe support disable`; otherwise set support.care_plan.enabled to true.",
    };
  }
  return {
    carePlan: pill("off", "Off"),
    carePlanNote:
      "No outside support login exists. Nobody outside this Engine can read this list.",
  };
}

export function buildSupport(
  view: StatusConfig,
  data: StatusData,
  now: Date,
): SupportModel {
  const issues = data.issues;
  const config = configState(data);
  if (!issues) {
    return {
      available: false,
      open: [],
      fixed30: null,
      carePlan: pill("off", "No reading"),
      carePlanNote: "",
      emptyText:
        "No reading yet: this Engine's database has not been updated to record issues.",
      config,
      badge: pill("off", "No reading"),
    };
  }
  const open = issues.open.map((issue) => issueRow(issue, now));
  return {
    available: true,
    open,
    fixed30: issues.fixed_last_30_days,
    ...carePlanLine(view.engine.care_plan_intended, issues.care_plan_enabled),
    emptyText: "Nothing is open.",
    config,
    badge: badgeFor(open),
  };
}
