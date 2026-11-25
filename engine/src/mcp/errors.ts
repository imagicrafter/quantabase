export type McpAppErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid_argument"
  | "not_found"
  | "rate_limited"
  | "internal_error";

const HTTP_BY_CODE: Record<McpAppErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_argument: 400,
  not_found: 404,
  rate_limited: 429,
  internal_error: 500,
};

export class McpAppError extends Error {
  readonly code: McpAppErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: McpAppErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "McpAppError";
    this.code = code;
    this.httpStatus = HTTP_BY_CODE[code];
    this.details = details;
  }
}

export function isMcpAppError(err: unknown): err is McpAppError {
  return err instanceof McpAppError;
}
