import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";

/**
 * Form protection for the signed-in screens.
 *
 * Cloudflare Access signs people in with a cookie, so a page on another site
 * could try to post a form here in their name. Three checks stop that:
 *   1. the browser says the post came from this same site (Sec-Fetch-Site,
 *      else Origin);
 *   2. the body is a plain form post (no JSON from a script);
 *   3. a hidden token, an HMAC of the signed-in email, the form's scope and
 *      the hour, made with a key derived from the project JWT secret (shared by
 *      every instance, never shown). A token is good for two hours.
 */

const HOUR_MS = 60 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type Csrf = {
  readonly token: (email: string, scope: string) => string;
  readonly check: (email: string, scope: string, token: unknown) => boolean;
};

export function createCsrf(secret: string, now: () => number = Date.now): Csrf {
  const key = createHmac("sha256", secret).update("kbe-app-forms-v1").digest();
  const mac = (email: string, scope: string, hour: number): string =>
    createHmac("sha256", key).update(`${email.toLowerCase()}|${scope}|${hour}`).digest("base64url");

  return {
    token: (email, scope) => mac(email, scope, Math.floor(now() / HOUR_MS)),
    check: (email, scope, token) => {
      if (typeof token !== "string" || !TOKEN.test(token)) return false;
      const hour = Math.floor(now() / HOUR_MS);
      return [hour, hour - 1].some((h) => {
        const want = Buffer.from(mac(email, scope, h));
        return timingSafeEqual(want, Buffer.from(token));
      });
    },
  };
}

/** The browser says this post came from a page on this same site. */
export function sameSite(c: Context): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = c.req.header("origin");
  if (!origin) return true; // not a browser
  try {
    return new URL(origin).host === c.req.header("host");
  } catch {
    return false;
  }
}

export function isFormPost(c: Context): boolean {
  return (c.req.header("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded");
}
