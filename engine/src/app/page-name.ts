/**
 * The names a person goes by (0077):
 *
 *   display name        shown on the Engine's screens (1 to 120 characters)
 *   name used on pages  what the curator calls them in page text, e.g. "Ann"
 *                       (1 to 60 characters). None set: the display name,
 *                       unless that is an email.
 *
 * Both are trimmed and one line: no line breaks or control characters, since
 * the page name goes into the curator's prompt. The database checks the same
 * (principals_page_name_shape, app_my_names_set).
 */

export const PAGE_NAME_MAX = 60;
export const DISPLAY_NAME_MAX = 120;

export type Cleaned<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** Control characters (newlines and tabs among them) and the Unicode line and paragraph separators. */
const NOT_ONE_LINE = /[\p{Cc}\u2028\u2029]/u;

const PAGE_NAME_RULE = `The name used on pages is 1 to ${PAGE_NAME_MAX} characters on one line.`;
const DISPLAY_NAME_RULE = `A name is 1 to ${DISPLAY_NAME_MAX} characters on one line.`;

/** Trimmed text, or null when it is not text at all. */
function text(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "";
  return typeof raw === "string" ? raw.trim() : null;
}

/** The name used on pages. Empty means none (the default), unless `required`. */
export function cleanPageName(raw: unknown, opts: { readonly required?: boolean } = {}): Cleaned<string | null> {
  const value = text(raw);
  if (value === null) return { ok: false, error: PAGE_NAME_RULE };
  if (value === "") return opts.required ? { ok: false, error: PAGE_NAME_RULE } : { ok: true, value: null };
  if ([...value].length > PAGE_NAME_MAX || NOT_ONE_LINE.test(value)) return { ok: false, error: PAGE_NAME_RULE };
  return { ok: true, value };
}

/** A display name: required. */
export function cleanDisplayName(raw: unknown): Cleaned<string> {
  const value = text(raw);
  if (!value || [...value].length > DISPLAY_NAME_MAX || NOT_ONE_LINE.test(value)) return { ok: false, error: DISPLAY_NAME_RULE };
  return { ok: true, value };
}

/** The page name used when none is set: the display name, unless it is an email. */
export function defaultPageName(displayName: string | null | undefined): string | null {
  const value = displayName?.trim() ?? "";
  return value === "" || value.includes("@") ? null : value;
}
