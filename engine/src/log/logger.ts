import pino from "pino";
import { env } from "../env.js";

/**
 * Secrets that must never reach a log line, whatever field they turn up in.
 * Only the setup code can be listed here: it is the one such secret this
 * process holds for its whole life. (The Cloudflare API token is different:
 * it exists for one request, as a function argument, and is never handed to
 * the logger at all. See setup/cloudflare-client.ts.)
 */
let SECRETS: readonly string[] = env.SETUP_CODE ? [env.SETUP_CODE] : [];

/**
 * Add a secret this process made itself (the first-run setup code, see
 * app/first-run.ts) so no later log line can carry it.
 */
export function addLogSecret(secret: string): void {
  if (secret.length >= 16 && !SECRETS.includes(secret)) SECRETS = [...SECRETS, secret];
}

function scrub(line: string): string {
  return SECRETS.reduce(
    (text, secret) => text.split(secret).join("[REDACTED]"),
    line,
  );
}

// Tests read log lines back to prove what is and is not written.
type Capture = { readonly lines: string[] };
let capture: Capture | undefined;

const testStream = {
  write(line: string): void {
    if (capture) capture.lines.push(line);
    else process.stdout.write(line);
  },
};

/** Collect log lines instead of printing them. Tests only. */
export function _captureLogsForTests(): {
  readonly lines: () => readonly string[];
  readonly stop: () => void;
} {
  const mine: Capture = { lines: [] };
  capture = mine;
  return {
    lines: () => [...mine.lines],
    stop: () => {
      if (capture === mine) capture = undefined;
    },
  };
}

export const logger = pino(
  {
    level: env.LOG_LEVEL,
    base: { service: "kb-engine" },
    // Redact sensitive fields from every log line. MCP request bodies carry the
    // user's search text; /mcp Authorization headers carry the bearer token.
    // DO purges run logs on deploy, so these are not an audit trail — restraint
    // at the log call is the only control.
    redact: {
      paths: [
        "authorization",
        "req.headers.authorization",
        "req.body",
        "query",
        "params.query",
        // The setup page: its code and the one-time Cloudflare token.
        "setup_code",
        "token",
        "cf_token",
        "api_token",
        "body",
        "form",
        "*.setup_code",
        "*.token",
        "*.cf_token",
        "*.api_token",
        "*.authorization",
        "*.Authorization",
        "*.*.setup_code",
        "*.*.token",
        "*.*.cf_token",
        "*.*.api_token",
        "*.*.authorization",
        // The app screens: secrets typed into a page.
        "access_token",
        "model_key",
        "*.access_token",
        "*.model_key",
      ],
      censor: "[REDACTED]",
    },
    // Last line of defence: the setup code is removed from the finished line
    // even if it arrives inside a message or an unexpected field.
    hooks: { streamWrite: scrub },
    ...(env.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  },
  ...(env.NODE_ENV === "test" ? [testStream] : []),
);
