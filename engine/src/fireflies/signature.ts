import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Fireflies webhook signatures (docs.fireflies.ai/graphql-api/webhooks-v2).
 *
 * Fireflies signs the RAW request body with HMAC-SHA256 and the signing
 * secret the person pasted, and sends it in X-Hub-Signature. V2 sends
 * `sha256=<hex>`; the older (V1) webhooks sent the bare hex. Both are
 * accepted; anything else, a missing header, or a wrong length is refused.
 * The compare is timing-safe. The secret and the signature are never logged.
 */

export const SIGNATURE_HEADER = "x-hub-signature";

const HEX_64 = /^[0-9a-f]{64}$/;

/** The hex digest in a header value, or null when it is not one of the two accepted shapes. */
export function parseSignature(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const value = header.trim().toLowerCase();
  const hex = value.startsWith("sha256=") ? value.slice("sha256=".length) : value;
  return HEX_64.test(hex) ? hex : null;
}

export function sign(rawBody: Uint8Array, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** True only when the header carries the HMAC-SHA256 of exactly these bytes under this secret. */
export function verifySignature(rawBody: Uint8Array, header: string | undefined, secret: string): boolean {
  const sent = parseSignature(header);
  if (sent === null || secret.length === 0) return false;
  const want = Buffer.from(sign(rawBody, secret), "hex");
  const got = Buffer.from(sent, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The id in the webhook URL: 32 URL-safe characters (192 random bits). */
export function newHookId(): string {
  return randomBytes(24).toString("base64url");
}

/** The signing secret the person pastes into Fireflies: 32 hex characters (128 random bits). */
export function newSigningSecret(): string {
  return randomBytes(16).toString("hex");
}

export const HOOK_ID = /^[A-Za-z0-9_-]{32,64}$/;
