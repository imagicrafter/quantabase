import { z } from "zod";
import { db } from "../db.js";
import { embedText } from "../supabase.js";
import { McpAppError } from "../mcp/errors.js";
import { logger } from "../log/logger.js";

export const whoKnowsSchema = z.object({
  topic: z.string().min(1).max(1000),
});

export type WhoKnowsInput = z.infer<typeof whoKnowsSchema>;

export type PersonRole = "author" | "participant";

export type PersonEvidence = {
  readonly id: string;
  readonly title: string;
  readonly role: PersonRole;
};

export type PersonEntry = {
  readonly name: string;
  readonly document_count: number;
  readonly evidence: readonly PersonEvidence[];
};

export type WhoKnowsResult = {
  readonly people: readonly PersonEntry[];
};

type Row = Readonly<Record<string, unknown>>;
type Mention = { readonly name: string; readonly role: PersonRole };

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 ? name : null;
}

/** The people one row names: the author first, each person once. */
function mentionsOf(row: Row): readonly Mention[] {
  const author = cleanName(row["author"]);
  const listed = Array.isArray(row["participants"])
    ? (row["participants"] as readonly unknown[])
    : [];
  const all: readonly Mention[] = [
    ...(author ? [{ name: author, role: "author" as const }] : []),
    ...listed
      .map(cleanName)
      .filter((name): name is string => name !== null)
      .map((name) => ({ name, role: "participant" as const })),
  ];
  const seen = new Set<string>();
  return all.filter((mention) => {
    const key = mention.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Count people across search rows: one count per document a person is named
 * in, most documents first. Names are matched without regard to case. Only
 * the rows passed in are counted; this reads nothing else.
 */
export function countPeople(rows: readonly Row[]): PersonEntry[] {
  const byKey = rows.reduce<ReadonlyMap<string, PersonEntry>>((acc, row) => {
    const id = String(row["id"] ?? "");
    const title = String(row["title"] ?? "");
    return mentionsOf(row).reduce<ReadonlyMap<string, PersonEntry>>(
      (inner, { name, role }) => {
        const key = name.toLowerCase();
        const prior = inner.get(key);
        const entry: PersonEntry = {
          name: prior?.name ?? name,
          document_count: (prior?.document_count ?? 0) + 1,
          evidence: [...(prior?.evidence ?? []), { id, title, role }],
        };
        return new Map([...inner, [key, entry]]);
      },
      acc,
    );
  }, new Map());
  return [...byKey.values()].sort(
    (a, b) => b.document_count - a.document_count,
  );
}

/**
 * People named as author or participant in the documents a topic search
 * returns to this caller, ranked by how many of those documents name them.
 *
 * Security rules:
 *   (a) Uses the SAME filtered RPC as `search` — never a privileged scan.
 *       A tempting optimisation is to search with a larger candidate pool to
 *       improve ranking; that would silently break the access model.
 *   (b) Returns only counts derived from the returned evidence — never a
 *       "total documents mentioning this person" figure across the full
 *       corpus, which would be a count over the unfiltered corpus.
 */
export async function whoKnows(
  input: WhoKnowsInput,
  sub: string,
): Promise<WhoKnowsResult> {
  logger.info(
    { sub, topic_length: input.topic.length },
    "who_knows tool called",
  );

  let embedding: number[];
  try {
    embedding = await embedText(input.topic);
  } catch (err) {
    if (err instanceof McpAppError) throw err;
    throw new McpAppError("internal_error", "Failed to embed topic query");
  }

  // Use the same filtered RPC as `search`. The access model is enforced
  // there, not at the aggregation layer.
  const { data, error } = await db().rpc("documents_search_by_oauth_subject", {
    p_oauth_subject: sub,
    query_text: input.topic,
    query_embedding: embedding,
    match_count: 50,
  });

  if (error) {
    logger.error({ code: error.code, sub }, "who_knows: search RPC failed");
    throw new McpAppError("internal_error", "Search failed");
  }

  const rows = Array.isArray(data) ? (data as Row[]) : [];
  const people = countPeople(rows);

  logger.info(
    { sub, person_count: people.length, result_count: rows.length },
    "who_knows completed",
  );
  return { people };
}
