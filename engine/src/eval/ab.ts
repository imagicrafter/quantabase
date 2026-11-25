import { lineDiff } from "../app/diff.js";
import { curateItem, type CurateDeps, type ItemResult } from "../curator/curate.js";
import { identityList } from "../curator/identity.js";
import type { ModelBackend } from "../curator/model.js";
import type { IndexRow } from "../curator/page-index.js";
import type { ClaimedItem, NameMatch, PageRow, Store } from "../curator/store.js";
import type { EntitySchema } from "../entities/templates.js";
import type { AbRow } from "./ab-args.js";

/**
 * The blind A/B harness core (scripts/eval/curator_ab.ts is its command
 * line). Runs the curator on a folder of source items against a fixed page
 * snapshot, in memory: nothing is written anywhere but the returned Markdown,
 * and every item sees the same snapshot. The Markdown lists what the curator
 * would change, in the shape /update-docs wiki proposes (page, section,
 * the exact lines), so a person can compare the two blind.
 */

export type SnapshotPage = {
  readonly key: string;
  readonly drawer: string;
  readonly title: string;
  readonly body: string;
  readonly aliases?: readonly string[];
  readonly description?: string | null;
  readonly fields?: Record<string, unknown>;
};

export type EvalItem = Partial<ClaimedItem> & { readonly id: string; readonly body: string };

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function toRow(p: SnapshotPage, topics: readonly string[]): PageRow {
  return {
    id: `snap:${p.key}`, drawer: p.drawer, key: p.key, template: null, title: p.title, aliases: [...(p.aliases ?? [])],
    description: p.description ?? null, fields: { ...(p.fields ?? {}) }, topics: [...topics], status: "current",
    tags: [], related: [], sources: [], generated: null, verified: [], body: p.body, content_hash: `snap-${p.key}`, matched_on: "",
  };
}

function idsOf(p: PageRow): string[] {
  return [p.key, ...p.aliases.map((a) => a.toLowerCase()), ...identityList(p, "emails"), ...identityList(p, "domains")];
}

function namesOf(p: PageRow): string[] {
  const slug = /^[a-z][a-z-]*:(.+)$/.exec(p.key)?.[1] ?? "";
  return [p.title, ...p.aliases, slug].map(norm).filter((n) => n !== "");
}

export type Proposal = { readonly kind: "update" | "create" | "review"; readonly key: string; readonly page: Record<string, unknown>; readonly before: PageRow | null };

/** An in-memory Store over a fixed snapshot; records proposals instead of saving. */
export function snapshotStore(pages: readonly SnapshotPage[], topics: readonly string[] = []) {
  const rows = pages.map((p) => toRow(p, topics));
  const proposals: Proposal[] = [];
  const outcome: { value: string; error?: string } = { value: "" };
  const search = (query: string): PageRow[] => {
    const words = norm(query).split(" ").filter((w) => w.length > 3);
    return rows
      .map((p) => ({ p, hits: words.filter((w) => norm(`${p.title} ${p.body}`).includes(w)).length }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .map((x) => x.p);
  };
  const store = {
    candidates: async (_item: string, keys: readonly string[], query: string, limit = 8) => {
      const byKey = rows.filter((p) => idsOf(p).some((k) => keys.includes(k)));
      return [...byKey, ...search(query).filter((p) => !byKey.includes(p))].slice(0, limit);
    },
    pageIndex: async (_item: string, keys: readonly string[], query: string, _e: unknown, limit: number): Promise<IndexRow[]> => {
      const ranked = search(query);
      return [...rows]
        .sort((a, b) => (ranked.indexOf(a) === -1 ? 1e9 : ranked.indexOf(a)) - (ranked.indexOf(b) === -1 ? 1e9 : ranked.indexOf(b)))
        .slice(0, limit)
        .map((p) => ({
          key: p.key, drawer: p.drawer, title: p.title, aliases: p.aliases, description: p.description,
          identities: [...identityList(p, "emails"), ...identityList(p, "domains")],
          score: idsOf(p).some((k) => keys.includes(k)) ? 2 : 0, matched_on: idsOf(p).some((k) => keys.includes(k)) ? "key" : "search",
        }));
    },
    nameMatch: async (_item: string, drawer: string, names: readonly string[]): Promise<NameMatch[]> => {
      const wanted = names.map(norm);
      return rows.filter((p) => p.drawer === drawer && namesOf(p).some((n) => wanted.includes(n)))
        .map((p) => ({ id: p.id, key: p.key, title: p.title, score: 1, how: "name" }));
    },
    savePage: async (_item: string, page: Record<string, unknown>, hash: string | null) => {
      const before = hash === null ? null : rows.find((p) => p.key === page["key"]) ?? null;
      proposals.push({ kind: before ? "update" : "create", key: String(page["key"]), page, before });
      return { id: `saved:${String(page["key"])}`, changed: true, created: before === null };
    },
    queueReview: async (r: { pageKey: string; proposal: Record<string, unknown> }) => {
      proposals.push({ kind: "review", key: r.pageKey, page: r.proposal, before: null });
      return `review-${proposals.length}`;
    },
    done: async (_item: string, value: string, _pages: readonly string[], error?: string) => {
      outcome.value = value;
      if (error) outcome.error = error;
    },
    flag: async (_item: string, reason: string) => {
      outcome.value = "flagged";
      outcome.error = reason;
    },
    uncertain: async () => undefined,
  };
  return { store: store as unknown as Store, proposals, outcome };
}

function section(proposal: Proposal): string {
  const title = String(proposal.page["title"] ?? proposal.key);
  if (proposal.kind === "create") {
    return [`### Create: ${proposal.page["drawer"]}/${proposal.key} (${title})`, "", "```markdown", String(proposal.page["body"] ?? "").trim(), "```"].join("\n");
  }
  if (proposal.kind === "review") return `### Held for review: ${proposal.key}\n\n\`\`\`json\n${JSON.stringify(proposal.page, null, 2)}\n\`\`\``;
  const added = lineDiff(proposal.before?.body ?? "", String(proposal.page["body"] ?? "")).filter((l) => l.kind !== "same");
  const fields = Object.entries((proposal.page["fields"] ?? {}) as Record<string, unknown>)
    .filter(([k, v]) => JSON.stringify(proposal.before?.fields[k]) !== JSON.stringify(v))
    .map(([k, v]) => `- field ${k}: ${JSON.stringify(v)}`);
  return [
    `### Update: ${proposal.before?.drawer ?? ""}/${proposal.key} (${title})`, "",
    ...(added.length > 0 ? ["```diff", ...added.map((l) => `${l.kind === "add" ? "+" : "-"} ${l.text}`), "```"] : []),
    ...fields,
  ].join("\n");
}

/** The Markdown of one item's proposed changes (no model, page or key names beyond the item's own). */
export function renderProposals(item: EvalItem, result: ItemResult, proposals: readonly Proposal[]): string {
  return [
    `## ${item.title ?? item.id}`,
    "",
    `Outcome: ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`,
    // Each starts "Outcome: " so the blind pair drops it with the outcome line.
    ...(result.dropped ?? []).map((d) => `Outcome: left out: ${d}`),
    ...(result.repaired ?? []).map((d) => `Outcome: repaired: ${d}`),
    "",
    ...(proposals.length > 0 ? proposals.map(section).flatMap((s) => [s, ""]) : ["No change.", ""]),
  ].join("\n");
}

export type AbDeps = {
  readonly schema: EntitySchema;
  readonly model: ModelBackend;
  readonly modelName: string;
  readonly strong?: CurateDeps["strong"];
  readonly consensus?: CurateDeps["consensus"];
  /** The single writer (writer.ts): `model` is the writer. */
  readonly writer?: CurateDeps["writer"];
  /** The owner and account users (as curator_account_people): never a person page. */
  readonly people?: CurateDeps["people"];
  readonly now?: () => Date;
};

/** Curate every item against the same snapshot; Markdown per item id. */
export async function runAb(items: readonly EvalItem[], pages: readonly SnapshotPage[], deps: AbDeps): Promise<Map<string, string>> {
  return (await runAbDetailed(items, pages, deps)).markdown;
}

/** As runAb, with each item's result (outcome, consensus, agreement, routing, what was left out). */
export async function runAbDetailed(
  items: readonly EvalItem[], pages: readonly SnapshotPage[], deps: AbDeps,
): Promise<{ readonly markdown: Map<string, string>; readonly results: AbRow[] }> {
  const out = new Map<string, string>();
  const results: AbRow[] = [];
  for (const raw of items) {
    const item: ClaimedItem = {
      owner_email: null, source: "eval", source_id: raw.id, version: 1, title: null, topics: [], metadata: {},
      source_created_at: null, received_at: new Date(0).toISOString(), released: false, ...raw,
    };
    const s = snapshotStore(pages, item.topics);
    const result = await curateItem(item, {
      store: s.store, model: deps.model, modelName: deps.modelName, schema: deps.schema,
      now: deps.now ?? (() => new Date()),
      ...(deps.strong ? { strong: deps.strong } : {}),
      ...(deps.consensus ? { consensus: deps.consensus } : {}),
      ...(deps.writer ? { writer: deps.writer } : {}),
      ...(deps.people ? { people: deps.people } : {}),
    });
    out.set(raw.id, renderProposals(raw, result, s.proposals));
    results.push({ id: raw.id, ...result });
  }
  return { markdown: out, results };
}

/**
 * Pair the curator's Markdown with another's (/update-docs wiki) for one
 * item, in an order fixed by `coin` (true: curator is A). The key says which
 * is which and is kept apart from what the reader sees.
 */
export function blindPair(id: string, curator: string, other: string, coin: boolean): { readonly text: string; readonly key: string } {
  // The curator's outcome line would give it away.
  const plain = curator.split("\n").filter((l) => !l.startsWith("Outcome: ")).join("\n");
  const [a, b] = coin ? [plain, other] : [other, plain];
  return {
    text: `# Item ${id}\n\n## Version A\n\n${a.trim()}\n\n## Version B\n\n${b.trim()}\n`,
    key: coin ? "A=curator B=other" : "A=other B=curator",
  };
}
