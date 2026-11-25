/**
 * The tag provider interface: one small module per source says how its items
 * carry tags (mail labels, folders, channels), and turns what an ingest run
 * passed into clean tags. A tag only becomes a topic when the item's owner
 * switches it on (Topics and people, "Found in your sources"); until then an
 * item stays with its owner. See docs/source-tags.md.
 */

/** A tag as the ingest run passed it, unchanged from the source's connector. */
export type RawTag = {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly kind?: string | undefined;
};

/** A clean tag: stable id at the source, the name a person sees, and its kind. */
export type SourceTag = {
  readonly kind: string;
  readonly id: string;
  readonly name: string;
};

export type TagProvider = {
  /** The source name used in record_source_item, e.g. "gmail". */
  readonly source: string;
  /** The kinds of tag this provider can return, e.g. ["label"]. */
  readonly kinds: readonly string[];
  /** Plain words for the ingest run: what to pass in `tags` for each item. */
  readonly howToRead: string;
  /**
   * Clean tags from what the run passed. Drop anything that can never be a
   * topic (system labels, empty names). Must be deterministic: the same input
   * always gives the same output.
   */
  readonly normalize: (raw: readonly RawTag[]) => readonly SourceTag[];
};
