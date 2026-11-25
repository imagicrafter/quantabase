import { stringify } from "yaml";

/**
 * Pages as an Obsidian vault (Phase 10.7 "Backup files follow his
 * conventions"): one Markdown file per page, named by its title, in a folder
 * per drawer; the header as frontmatter; links as [[Title]]; a generated
 * index.md (pages by drawer) and log.md (change history).
 *
 * Pure: the same pages always give the same files, so an unchanged Engine
 * makes no commit. Titles are unique across the vault (case-insensitively); a
 * clash takes the owner's name, then the key, in brackets.
 */

export type BackupLink = { readonly target_key: string; readonly reason: string };

export type BackupPage = {
  readonly id: string;
  readonly key: string;
  readonly drawer: string;
  readonly template: string | null;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly description: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly topics: readonly string[];
  readonly status: string;
  readonly reviewed: string | null;
  readonly tags: readonly string[];
  readonly related: readonly string[];
  readonly sources: readonly unknown[];
  readonly generated: unknown;
  readonly verified: readonly unknown[];
  readonly body: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly owner: string;
  readonly links: readonly BackupLink[];
};

export type LogEntry = {
  readonly saved_at: string;
  readonly key: string | null;
  readonly title: string | null;
  readonly drawer: string | null;
  readonly by: string | null;
  readonly first: boolean;
  readonly deleted: boolean;
};

export type VaultInput = {
  readonly pages: readonly BackupPage[];
  readonly log: readonly LogEntry[];
  readonly now: Date;
  /** Drawer id -> label for index.md headings; unknown drawers use the id. */
  readonly labels: Readonly<Record<string, string>>;
};

const MAX_NAME = 120;
const HEADER_KEYS = new Set([
  "title", "aliases", "description", "type", "key", "owner", "topics", "template", "status",
  "reviewed", "created", "updated", "tags", "related", "sources", "generated", "verified",
]);

/** A title made safe as a file name everywhere Obsidian runs. Empty when nothing is left. */
export function fileName(title: string): string {
  return title
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim()
    .slice(0, MAX_NAME)
    .trim();
}

const lower = (s: string) => s.toLowerCase();
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);
const ownerName = (owner: string) => owner.split("@")[0] ?? owner;

function sortPages(pages: readonly BackupPage[]): BackupPage[] {
  const k = (p: BackupPage) => [p.drawer, lower(p.title), p.owner, p.key].join("\u0000");
  return [...pages].sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0));
}

/** page id -> unique vault name (no folder, no .md). */
function assignNames(pages: readonly BackupPage[]): ReadonlyMap<string, string> {
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const p of pages) {
    const base = fileName(p.title) || fileName(p.key) || "page";
    const tries = [base, `${base} (${fileName(ownerName(p.owner))})`, `${base} (${fileName(p.key)})`];
    let name = tries.find((t) => !taken.has(lower(t)));
    for (let n = 2; !name; n += 1) {
      const t = `${base} (${n})`;
      if (!taken.has(lower(t))) name = t;
    }
    taken.add(lower(name));
    names.set(p.id, name);
  }
  return names;
}

type Resolver = (text: string, owner: string) => string | null;

/** Link text (a key, title or alias) -> vault name, the writer's own pages first. */
function makeResolver(pages: readonly BackupPage[], names: ReadonlyMap<string, string>): Resolver {
  const byText = new Map<string, BackupPage[]>();
  const add = (text: string, p: BackupPage) => {
    const t = lower(text.trim());
    if (t) byText.set(t, [...(byText.get(t) ?? []), p]);
  };
  for (const p of pages) {
    add(p.key, p);
    add(p.title, p);
    p.aliases.forEach((a) => add(a, p));
  }
  return (text, owner) => {
    const found = byText.get(lower(text.trim())) ?? [];
    const best = found.find((p) => p.owner === owner) ?? found[0];
    return best ? (names.get(best.id) ?? null) : null;
  };
}

/** [[target#heading|shown]] -> [[Name#heading|shown]] when the target is a page. */
function rewriteBody(body: string, owner: string, resolve: Resolver): string {
  return body.replace(/\[\[([^\]|#\n]+)(#[^\]|\n]*)?(\|[^\]\n]*)?\]\]/g, (whole, target: string, head?: string, shown?: string) => {
    const name = resolve(target, owner);
    return name ? `[[${name}${head ?? ""}${shown ?? ""}]]` : whole;
  });
}

function relatedList(p: BackupPage, resolve: Resolver): string[] {
  const out: string[] = [];
  const push = (v: string) => {
    if (!out.includes(v)) out.push(v);
  };
  for (const l of p.links) {
    // Body links stay in the body and tags in tags: only `related` is header-only.
    if (l.reason === "wikilink" || l.reason === "tag") continue;
    const name = resolve(l.target_key, p.owner);
    if (name) push(`[[${name}]]`);
  }
  for (const r of p.related) {
    const name = resolve(r.replace(/^\[\[|\]\]$/g, ""), p.owner);
    if (!name) push(r);
  }
  return out;
}

const tag = (t: string) => t.trim().replace(/\s+/g, "-").replace(/^#/, "");

const EMAIL_KEY = /^[^@\s:]+@[^@\s:]+\.[^@\s:]+$/;
const DOMAIN_KEY = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * What the page's key stands for, written the way a wiki would (`email`,
 * `domain`, `fireflies_id`), so an import keeps the identity the Engine
 * matches new sources on. Never over a field of the same name.
 */
function identityHints(p: BackupPage): Record<string, string> {
  const out: Record<string, string> = {};
  if (EMAIL_KEY.test(p.key)) out["email"] = p.key;
  else if (DOMAIN_KEY.test(p.key)) out["domain"] = p.key;
  const fireflies = p.sources.find(
    (s): s is { source: string; source_id: string } =>
      typeof s === "object" && s !== null && (s as { source?: unknown }).source === "fireflies" &&
      typeof (s as { source_id?: unknown }).source_id === "string",
  );
  if (fireflies) out["fireflies_id"] = fireflies.source_id;
  return Object.fromEntries(Object.entries(out).filter(([k]) => !(k in p.fields)));
}

function header(p: BackupPage, related: readonly string[]): Record<string, unknown> {
  const fields = Object.fromEntries(
    Object.entries(p.fields).map(([k, v]) => [HEADER_KEYS.has(k) ? `field_${k}` : k, v]),
  );
  const out: Record<string, unknown> = {
    title: p.title,
    aliases: [...p.aliases],
    description: p.description ?? "",
    type: p.drawer,
    key: p.key,
    owner: p.owner,
    topics: [...p.topics],
    ...(p.template ? { template: p.template } : {}),
    status: p.status,
    reviewed: day(p.reviewed),
    created: day(p.created_at),
    updated: day(p.updated_at),
    tags: p.tags.map(tag).filter(Boolean),
    related: [...related],
    sources: [...p.sources],
    ...(p.generated ? { generated: p.generated } : {}),
    verified: [...p.verified],
  };
  return { ...out, ...identityHints(p), ...fields };
}

function pageFile(p: BackupPage, resolve: Resolver): string {
  const fm = stringify(header(p, relatedList(p, resolve)), { lineWidth: 0 }).trimEnd();
  const body = rewriteBody(p.body, p.owner, resolve).replace(/^\s+/, "");
  // A blank line first, so a body that itself starts with --- stays body.
  // One newline is always added at the end, so a restore takes exactly that
  // one off and the body comes back as it was.
  return `---\n${fm}\n---\n\n${body}\n`;
}

function indexFile(pages: readonly BackupPage[], names: ReadonlyMap<string, string>, input: VaultInput): string {
  const drawers = [...new Set(pages.map((p) => p.drawer))].sort();
  const sections = drawers.map((d) => {
    const lines = pages
      .filter((p) => p.drawer === d)
      .map((p) => `- [[${names.get(p.id)}]]${p.description ? ` -- ${p.description.replace(/\s+/g, " ")}` : ""}`);
    const label = input.labels[d] ?? d.charAt(0).toUpperCase() + d.slice(1);
    return `## ${label}\n${lines.join("\n")}`;
  });
  return [
    "# Knowledge Index",
    "",
    `Generated by the Engine's nightly backup on ${day(input.now.toISOString())}: ${pages.length} pages. ` +
      "This repository is a one-way copy; edits here are overwritten.",
    "",
    sections.join("\n\n"),
    "",
  ].join("\n");
}

function logFile(input: VaultInput, resolve: (e: LogEntry) => string | null): string {
  const byDay = new Map<string, string[]>();
  for (const e of input.log) {
    const d = day(e.saved_at) ?? "unknown";
    const name = e.deleted ? null : resolve(e);
    const what = name ? `[[${name}]]` : `${e.title ?? e.key ?? "a page"}${e.deleted ? " (since removed)" : ""}`;
    const line = `- ${e.saved_at.slice(11, 16)} ${e.first ? "created" : "updated"} ${what}${e.by ? ` by ${e.by}` : ""}`;
    byDay.set(d, [...(byDay.get(d) ?? []), line]);
  }
  const days = [...byDay.keys()].sort().reverse();
  return [
    "# Change log",
    "",
    "Generated by the Engine's nightly backup: recent page changes, newest first (UTC).",
    "",
    ...days.flatMap((d) => [`## ${d}`, "", ...(byDay.get(d) ?? []), ""]),
  ].join("\n");
}

/** The whole vault: path -> file text, paths sorted. */
export function renderVault(input: VaultInput): ReadonlyMap<string, string> {
  const pages = sortPages(input.pages);
  const names = assignNames(pages);
  const resolve = makeResolver(pages, names);
  const byKeyOwner = new Map(pages.map((p) => [`${p.owner}\u0000${p.key}`, names.get(p.id) ?? ""]));
  const files = new Map<string, string>();
  for (const p of pages) files.set(`${fileName(p.drawer) || "pages"}/${names.get(p.id)}.md`, pageFile(p, resolve));
  files.set("index.md", indexFile(pages, names, input));
  files.set(
    "log.md",
    logFile(input, (e) => (e.key ? (byKeyOwner.get(`${e.by ?? ""}\u0000${e.key}`) ?? resolve(e.key, e.by ?? "")) : null)),
  );
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
