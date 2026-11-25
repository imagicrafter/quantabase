import { durationMs } from "./config.js";

/**
 * The banner rule, in one place.
 *
 * The Engine is "working" unless one of these is true, in which case it needs
 * "attention":
 *
 *   1. an issue of category `source_failure` is open (a source's run failed
 *      and has not run clean since);
 *   2. an issue of category `config_invalid` is open (the last config read
 *      from the knowledge repo was rejected);
 *   3. a source that is on, and has run at least once, last succeeded longer
 *      ago than its `alert_after` (or has never succeeded).
 *
 * Other kinds of open issue (an unknown tag, a reported problem) are listed
 * under Support but do not raise the banner. A source that is off, or has no
 * reading at all yet, is not late.
 *
 * Pure: facts in, state out.
 */

export type BannerFacts = {
  readonly openIssues: readonly {
    readonly category: string;
    readonly source?: string | null | undefined;
  }[];
  readonly sources: readonly {
    readonly label: string;
    readonly enabled: boolean;
    /** False when the source has never reported a run. */
    readonly hasReading: boolean;
    readonly lastSuccessAt: string | null | undefined;
    readonly alertAfter: string;
  }[];
  readonly now: Date;
};

export type Banner = {
  readonly state: "working" | "attention";
  readonly reasons: readonly string[];
};

function issueReasons(issues: BannerFacts["openIssues"]): string[] {
  const failing = issues
    .filter((i) => i.category === "source_failure")
    .map((i) => (i.source ? `${i.source} is failing` : "A source is failing"));
  const rejected = issues.some((i) => i.category === "config_invalid")
    ? ["The last config change was rejected"]
    : [];
  return [...new Set(failing), ...rejected];
}

function isPastAlert(
  source: BannerFacts["sources"][number],
  now: Date,
): boolean {
  if (!source.enabled || !source.hasReading) return false;
  if (!source.lastSuccessAt) return true;
  const last = new Date(source.lastSuccessAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last > durationMs(source.alertAfter);
}

export function bannerState(facts: BannerFacts): Banner {
  const reasons = [
    ...issueReasons(facts.openIssues),
    ...facts.sources
      .filter((s) => isPastAlert(s, facts.now))
      .map((s) => `${s.label} has not been read in time`),
  ];
  return { state: reasons.length ? "attention" : "working", reasons };
}
