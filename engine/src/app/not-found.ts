import type { Context } from "hono";
import { esc } from "../status/page.js";
import { SETUP_CSP } from "../setup/page.js";
import { setupMenu, shell } from "./shell.js";

/**
 * Friendly answers for two dead ends a person can hit in a browser:
 * an unknown screen under /setup or /app, and the platform's own hostname
 * (e.g. *.ondigitalocean.app) once sign-in runs on the real one. Machines
 * (MCP, JSON callers) still get the short JSON answers.
 */

function htmlHeaders(c: Context): void {
  c.header("Content-Security-Policy", SETUP_CSP);
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  c.header("Referrer-Policy", "same-origin");
}

function wantsHtml(c: Context): boolean {
  const path = c.req.path;
  if (path === "/mcp" || path.startsWith("/.well-known/") || path.startsWith("/internal/")) return false;
  return (c.req.header("accept") ?? "").includes("text/html") || c.req.method === "GET";
}

export function notFoundPage(c: Context): Response {
  const path = c.req.path;
  const area = path === "/setup" || path.startsWith("/setup/") ? "setup" : path === "/app" || path.startsWith("/app/") ? "app" : null;
  if (!area) return c.text("404 Not Found", 404);
  htmlHeaders(c);
  const body =
    area === "setup"
      ? `<div class="card"><p>There is no setup screen at this address. Pick one below.</p></div>${setupMenu()}`
      : `<div class="card"><p>There is no screen at this address. <a href="/app">Go to the app's home</a>.</p></div>`;
  return c.html(shell(area, "", "Not found", body), 404);
}

/** A request on any hostname other than the Engine's own. */
export function wrongHost(c: Context, realHost: string): Response {
  if (!wantsHtml(c)) {
    return c.json({ error: { code: "forbidden", message: "Invalid host" } }, 421);
  }
  htmlHeaders(c);
  const path = c.req.path.startsWith("/") ? c.req.path : "/";
  const target = `https://${realHost}${path}`;
  const body = `<div class="card"><p>This Engine now answers only on its own address. This one (the hosting platform's) is no longer used.</p>
<p><a class="button" href="${esc(target)}">Go to ${esc(realHost)}</a></p>
<p class="hint">Update any bookmark to <span class="mono">https://${esc(realHost)}</span>.</p></div>`;
  return c.html(shell("app", "", "This Engine has moved", body, false), 421);
}
