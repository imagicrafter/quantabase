import { McpAppError } from "../mcp/errors.js";

/** The parts of a PostgREST error this module reads. */
export type DbError = {
  readonly code?: string | null;
  readonly message?: string | null;
};

// SQLSTATEs raised on purpose by migrations 0032 and 0033. Their messages are
// written for people and hold nothing beyond what the caller sent, so they are
// passed on. Every other database error is hidden behind the fallback text.
const INVALID_ARGUMENT = "22023";
const NOT_ALLOWED = "42501";
const GUARD_REFUSED = "KB001";
const CODE_NOT_VALID = "KB002";
const RATE_LIMITED = "KB429";

function messageOr(error: DbError, fallback: string): string {
  const message = (error.message ?? "").trim();
  return message.length > 0 ? message : fallback;
}

/**
 * Turn a database error into the error a tool reports.
 *
 * `notAllowed` is the text for 42501. It is fixed by the caller, never taken
 * from the database, because 42501 is also what a missing grant produces.
 */
export function mapDbError(
  error: DbError,
  notAllowed: string,
  fallback: string,
): McpAppError {
  switch (error.code) {
    case NOT_ALLOWED:
      return new McpAppError("forbidden", notAllowed);
    case GUARD_REFUSED:
      return new McpAppError("forbidden", messageOr(error, "Refused"));
    case INVALID_ARGUMENT:
    case CODE_NOT_VALID:
      return new McpAppError(
        "invalid_argument",
        messageOr(error, "Invalid request"),
      );
    case RATE_LIMITED:
      return new McpAppError(
        "rate_limited",
        messageOr(error, "Too many requests; try again later"),
      );
    default:
      return new McpAppError("internal_error", fallback);
  }
}
