import { calendarProvider } from "./providers/calendar.js";
import { claudeCodeProvider } from "./providers/chat.js";
import { driveProvider } from "./providers/drive.js";
import { firefliesProvider } from "./providers/fireflies.js";
import { gmailProvider } from "./providers/gmail.js";
import type { RawTag, SourceTag, TagProvider } from "./types.js";

export { MAX_TAGS } from "./clean.js";
export type { RawTag, SourceTag, TagProvider } from "./types.js";

/**
 * Every tag provider, by source. To add a source, write one module in
 * providers/ that exports a TagProvider and list it here (docs/source-tags.md).
 */
export const PROVIDERS: ReadonlyMap<string, TagProvider> = new Map(
  [gmailProvider, driveProvider, firefliesProvider, calendarProvider, claudeCodeProvider].map((p) => [p.source, p] as const),
);

/**
 * Every source record_source_item takes. The database checks the same list
 * (source_item_record): mail handed over under another name would skip the
 * inclusion rules.
 */
export const RECORD_SOURCES = ["gmail", "fireflies", "drive", "calendar", "claude-code"] as const;
export type RecordSource = (typeof RECORD_SOURCES)[number];

export function providerFor(source: string): TagProvider | null {
  return PROVIDERS.get(source) ?? null;
}

/** Clean tags for one item. A source without a provider keeps no tags. */
export function sourceTags(source: string, raw: readonly RawTag[]): readonly SourceTag[] {
  return providerFor(source)?.normalize(raw) ?? [];
}
