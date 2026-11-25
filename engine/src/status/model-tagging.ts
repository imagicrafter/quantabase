import { plural } from "./model-shared.js";
import type { StatusData } from "./readings.js";

/**
 * Tagging health: for each source, how the topics of its documents were
 * decided. "Untagged" documents are indexed but only the owner can see them.
 */

export type TagBreakdown = {
  readonly total: number;
  /** A tag on the item itself. */
  readonly onItem: number;
  /** A tag on the folder or channel that holds it. */
  readonly byContainer: number;
  /** No tag; the source's default topic applied. */
  readonly byDefault: number;
  /** No tag and no default: unclassified, owner-only. */
  readonly untagged: number;
  /** Indexed before tags were recorded; the next run fills it in. */
  readonly notRecorded: number;
  /** Carries a tag naming a topic the config does not declare. */
  readonly unknown: number;
};

export type UnknownTagWarning = {
  readonly count: number;
  readonly text: string;
};

const EMPTY: TagBreakdown = {
  total: 0,
  onItem: 0,
  byContainer: 0,
  byDefault: 0,
  untagged: 0,
  notRecorded: 0,
  unknown: 0,
};

/** One source's counts; null when the database has no tagging reading. */
export function tagBreakdown(
  data: StatusData,
  sourceKey: string,
): TagBreakdown | null {
  if (!data.tagging) return null;
  const row = data.tagging.find((t) => t.source === sourceKey);
  if (!row) return EMPTY;
  return {
    total: row.total,
    onItem: row.by_tag_source.content,
    byContainer: row.by_tag_source.container,
    byDefault: row.by_tag_source.source_default,
    untagged: row.untagged,
    notRecorded: row.by_tag_source.not_recorded,
    unknown: row.unknown_tag,
  };
}

/** The warning shown above the sources when any tag names an unknown topic. */
export function unknownTagWarning(
  data: StatusData,
  labelFor: (sourceKey: string) => string,
): UnknownTagWarning | null {
  const rows = (data.tagging ?? []).filter((t) => t.unknown_tag > 0);
  const count = rows.reduce((total, t) => total + t.unknown_tag, 0);
  if (count === 0) return null;
  const where = rows
    .map((t) => `${labelFor(t.source)} (${t.unknown_tag})`)
    .join(", ");
  const carry = count === 1 ? "carries" : "carry";
  return {
    count,
    text: `${plural(count, "item")} ${carry} a tag for a topic that is not in the config, so only the owner can see ${count === 1 ? "it" : "them"}: ${where}. Fix the tag, or add the topic.`,
  };
}
