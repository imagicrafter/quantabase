/**
 * The Engine's own Fireflies GraphQL client (https://api.fireflies.ai/graphql,
 * docs.fireflies.ai/graphql-api). Three calls only:
 *
 *   whoami         user { email name }: checks a pasted key, names its account
 *   meeting        transcript(id): one meeting in full (sentences, summary,
 *                  participants, date, title, channels)
 *   listSince      transcripts(fromDate, limit 50, skip): ids and dates, for
 *                  the owner's one-time backfill
 *
 * The key goes in the Authorization header and nowhere else: never in a log
 * line, an error message or a thrown value. Errors are reduced to a short
 * code (FirefliesError.code) the screens and the delivery table can hold.
 */

export const FIREFLIES_HOST = "api.fireflies.ai";
export const FIREFLIES_URL = `https://${FIREFLIES_HOST}/graphql`;
const TIMEOUT_MS = 20_000;
export const LIST_PAGE = 50;

export type FirefliesErrorCode = "unauthorized" | "not_found" | "rate_limited" | "unreachable" | "fireflies_error" | "bad_response";

export class FirefliesError extends Error {
  constructor(
    readonly code: FirefliesErrorCode,
    /** Fireflies refused the `channels` field (an older API). */
    readonly aboutChannels = false,
  ) {
    super(`Fireflies: ${code}`);
    this.name = "FirefliesError";
  }
}

export type Sentence = { readonly speaker_name?: string | null; readonly text?: string | null };
export type Attendee = { readonly displayName?: string | null; readonly email?: string | null; readonly name?: string | null };
export type Summary = Readonly<Record<string, unknown>>;

export type Transcript = {
  readonly id: string;
  readonly title?: string | null;
  readonly date?: number | string | null;
  readonly organizer_email?: string | null;
  readonly participants?: readonly (string | null)[] | null;
  readonly meeting_attendees?: readonly Attendee[] | null;
  readonly sentences?: readonly Sentence[] | null;
  readonly summary?: Summary | null;
  readonly channels?: readonly { readonly id?: string | null; readonly title?: string | null }[] | null;
};

export type ListedMeeting = { readonly id: string; readonly date: number | string | null };

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type FirefliesClient = {
  readonly whoami: (apiKey: string) => Promise<{ readonly email: string; readonly name: string | null }>;
  readonly meeting: (apiKey: string, id: string) => Promise<Transcript>;
  readonly listSince: (apiKey: string, fromIso: string, skip: number) => Promise<readonly ListedMeeting[]>;
};

const MEETING_FIELDS = `
    id
    title
    date
    organizer_email
    participants
    meeting_attendees { displayName email name }
    sentences { speaker_name text }
    summary { overview short_summary shorthand_bullet action_items keywords }`;

const meetingQuery = (channels: boolean) =>
  `query EngineMeeting($id: String!) { transcript(id: $id) {${MEETING_FIELDS}${channels ? "\n    channels { id title }" : ""}\n  } }`;

const USER_QUERY = "query EngineWhoami { user { email name } }";
const LIST_QUERY =
  "query EngineList($fromDate: DateTime, $limit: Int, $skip: Int) { transcripts(fromDate: $fromDate, limit: $limit, skip: $skip) { id date } }";

type GqlError = { readonly message?: unknown; readonly code?: unknown; readonly extensions?: { readonly code?: unknown } };

function codeOf(errors: readonly GqlError[]): FirefliesErrorCode {
  const words = errors
    .map((e) => `${String(e.code ?? "")} ${String(e.extensions?.code ?? "")} ${String(e.message ?? "")}`)
    .join(" ")
    .toLowerCase();
  if (/object_not_found|not found/.test(words)) return "not_found";
  if (/too_many_requests|rate limit|too many/.test(words)) return "rate_limited";
  if (/auth|forbidden|api key|unauthor|invalid_token/.test(words)) return "unauthorized";
  return "fireflies_error";
}

const mentionsChannels = (errors: readonly GqlError[]) => errors.some((e) => /channels/i.test(String(e.message ?? "")));

export function createFirefliesClient(fetcher: Fetch): FirefliesClient {
  // An API that does not know `channels` is asked again without it, once, and
  // never again in this process: the meeting is then untagged by channel, never dropped.
  let channelsOk = true;

  async function call(apiKey: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetcher(FIREFLIES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new FirefliesError("unreachable");
    }
    if (res.status === 401 || res.status === 403) throw new FirefliesError("unauthorized");
    if (res.status === 429) throw new FirefliesError("rate_limited");
    let json: { data?: Record<string, unknown> | null; errors?: GqlError[] };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new FirefliesError(res.ok ? "bad_response" : "fireflies_error");
    }
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      throw new FirefliesError(codeOf(json.errors), mentionsChannels(json.errors));
    }
    if (!res.ok) throw new FirefliesError("fireflies_error");
    return json.data ?? {};
  }

  return {
    whoami: async (apiKey) => {
      const user = (await call(apiKey, USER_QUERY, {}))["user"] as { email?: unknown; name?: unknown } | null | undefined;
      const email = typeof user?.email === "string" ? user.email.trim().toLowerCase() : "";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw new FirefliesError("bad_response");
      return { email, name: typeof user?.name === "string" ? user.name : null };
    },
    meeting: async (apiKey, id) => {
      const once = async (channels: boolean) => (await call(apiKey, meetingQuery(channels), { id }))["transcript"];
      let found: unknown;
      try {
        found = await once(channelsOk);
      } catch (err) {
        const refusedChannels = err instanceof FirefliesError && err.aboutChannels;
        if (!channelsOk || !refusedChannels) throw err;
        channelsOk = false;
        found = await once(false);
      }
      if (found === null || found === undefined) throw new FirefliesError("not_found");
      const t = found as Transcript;
      if (typeof t.id !== "string") throw new FirefliesError("bad_response");
      return t;
    },
    listSince: async (apiKey, fromIso, skip) => {
      const rows = (await call(apiKey, LIST_QUERY, { fromDate: fromIso, limit: LIST_PAGE, skip }))["transcripts"];
      if (!Array.isArray(rows)) throw new FirefliesError("bad_response");
      return rows
        .filter((r): r is { id: string; date?: unknown } => typeof r === "object" && r !== null && typeof (r as { id?: unknown }).id === "string")
        .map((r) => ({ id: r.id, date: typeof r.date === "number" || typeof r.date === "string" ? r.date : null }));
    },
  };
}
