import { LARGE_REMOVAL_SHARE } from "./policy.js";

/**
 * The owner's safe choices from the Pipeline screen (pipeline_settings,
 * migration 0071), as the curator uses them. Each one only moves a dial a
 * little; none switches a check off:
 *
 *   deskEditor     triage leans to keeping more or fewer items
 *   archivistBar   rarely_new lowers the name-match threshold by
 *                  ARCHIVIST_STEP, so a near name updates a page
 *                  instead of making a new one
 *   publisherAsk   big_changes also asks before an update that removes
 *                  BIG_CHANGE_SHARE or more of a page (the built-in
 *                  LARGE_REMOVAL_SHARE check is always on)
 *   paused         the run does nothing until the pause ends
 *   summaryLength  the Cataloguer's summary: short (1 or 2 sentences) or
 *                  standard (2 to 4); 0075
 */

export type DeskEditor = "keep_more" | "normal" | "keep_less";
export type ArchivistBar = "rarely_new" | "normal";
export type PublisherAsk = "never" | "big_changes";
export type SummaryLength = "short" | "standard";

export type Tuning = {
  readonly deskEditor: DeskEditor;
  readonly archivistBar: ArchivistBar;
  readonly publisherAsk: PublisherAsk;
  readonly paused: boolean;
  readonly summaryLength: SummaryLength;
};

export const DEFAULT_TUNING: Tuning = { deskEditor: "normal", archivistBar: "normal", publisherAsk: "never", paused: false, summaryLength: "standard" };

export const ARCHIVIST_STEP = 0.05;
/** The lowest threshold rarely_new may reach. */
export const ARCHIVIST_FLOOR = 0.5;
export const BIG_CHANGE_SHARE = 0.2;

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/** The row from curator_pipeline_get; anything unknown keeps its default. */
export function parseTuning(r: Record<string, unknown> | null | undefined): Tuning {
  return {
    deskEditor: pick(r?.["desk_editor"], ["keep_more", "normal", "keep_less"] as const, DEFAULT_TUNING.deskEditor),
    archivistBar: pick(r?.["archivist_bar"], ["rarely_new", "normal"] as const, DEFAULT_TUNING.archivistBar),
    publisherAsk: pick(r?.["publisher_ask"], ["never", "big_changes"] as const, DEFAULT_TUNING.publisherAsk),
    paused: r?.["paused"] === true,
    summaryLength: pick(r?.["summary_length"], ["short", "standard"] as const, DEFAULT_TUNING.summaryLength),
  };
}

/** One line for the triage prompt; empty for "normal". */
export function triageLean(d: DeskEditor | undefined): string {
  if (d === "keep_more") return "LEAN: when unsure whether something is durable, keep it (durable: true).";
  if (d === "keep_less") return "LEAN: keep only clear, lasting facts; when unsure, answer durable: false.";
  return "";
}

/** The name-match threshold after the archivist's bar. */
export function archivistThreshold(base: number, bar: ArchivistBar | undefined): number {
  if (bar !== "rarely_new") return base;
  return Math.min(base, Math.max(ARCHIVIST_FLOOR, base - ARCHIVIST_STEP));
}

/** The removal share that needs a yes: never above the built-in one. */
export function removalShare(ask: PublisherAsk | undefined): number {
  return ask === "big_changes" ? Math.min(BIG_CHANGE_SHARE, LARGE_REMOVAL_SHARE) : LARGE_REMOVAL_SHARE;
}
