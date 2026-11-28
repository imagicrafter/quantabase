/**
 * What a Fireflies webhook delivery says, from its JSON body.
 *
 * V2 (docs.fireflies.ai/graphql-api/webhooks-v2):
 *   {"event": "meeting.summarized" | "meeting.transcribed" | "meeting.bot_joined",
 *    "timestamp": <ms>, "meeting_id": "...", "client_reference_id"?: "...",
 *    "reprocessed_at"?: <ms, on a re-send after the notes changed>}
 * V1 (legacy, read-only in Fireflies now):
 *   {"meetingId": "...", "eventType": "Transcription completed", "clientReferenceId"?: "..."}
 *
 * Only a finished meeting is fetched: meeting.summarized, meeting.transcribed
 * and the V1 "Transcription completed". Anything else (a bot joining, an
 * event Fireflies adds later) is acknowledged and ignored.
 */

export const MEETING_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const FETCH_EVENTS = new Set(["meeting.summarized", "meeting.transcribed", "Transcription completed"]);

export type HookEvent = {
  /** The event name as sent (V2 `event`, V1 `eventType`), or "unknown". */
  readonly event: string;
  /** The meeting (transcript) id, when it is a well-formed one. */
  readonly meetingId: string | null;
  /** V2 re-sends carry the time the notes changed; newer than the last one means fetch again. */
  readonly reprocessedAt: number | null;
  /** True for a finished meeting the Engine should fetch. */
  readonly fetch: boolean;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

function eventName(body: Record<string, unknown>): string {
  const name = str(body["event"]) ?? str(body["eventType"]);
  return name !== null && /^[A-Za-z0-9 ._-]{1,64}$/.test(name) ? name : "unknown";
}

/** The delivery's meaning, or null when the body is not a JSON object at all. */
export function parseHookEvent(raw: string): HookEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  const event = eventName(o);
  const id = str(o["meeting_id"]) ?? str(o["meetingId"]) ?? str(o["transcript_id"]);
  const meetingId = id !== null && MEETING_ID.test(id) ? id : null;
  const re = o["reprocessed_at"];
  const reprocessedAt = typeof re === "number" && Number.isSafeInteger(re) && re > 0 ? re : null;
  return { event, meetingId, reprocessedAt, fetch: meetingId !== null && FETCH_EVENTS.has(event) };
}
