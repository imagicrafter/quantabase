import { createMiddleware } from "hono/factory";

/**
 * Security response headers on every request.
 * HSTS is not a platform setting — the app must send it.
 * Cache-Control: no-store on /mcp prevents caching of tool responses.
 */
export const securityHeaders = createMiddleware(async (c, next) => {
  await next();
  c.header(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload",
  );
  c.header("X-Content-Type-Options", "nosniff");
  // A route may set its own (the setup page needs `same-origin`, so its own
  // form posts carry an Origin header it can check).
  if (!c.res.headers.has("Referrer-Policy")) {
    c.header("Referrer-Policy", "no-referrer");
  }
  c.header("X-Frame-Options", "DENY");

  if (c.req.path.startsWith("/mcp")) {
    c.header("Cache-Control", "no-store");
  }
});
