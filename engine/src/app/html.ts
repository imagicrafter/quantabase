import type { Context } from "hono";
import { esc } from "../status/page.js";
import { shell, type Area } from "./shell.js";
import { SETUP_CSP } from "../setup/page.js";
import { fillChrome, getChrome } from "./chrome.js";

/**
 * Plain server-rendered pages for the app screens, in the setup page's style:
 * one same-origin stylesheet, no script, no inline style. Every value from a
 * person, the database or a source goes through esc(). No secret is ever
 * written into a page.
 */

export { esc };
export { APP_NAV, SETUP_NAV, type Area, type NavItem } from "./shell.js";

export function appLayout(area: Area, here: string, title: string, body: string): string {
  return shell(area, here, title, body);
}

export function card(inner: string, extra = ""): string {
  return `<div class="card${extra ? ` ${extra}` : ""}">${inner}</div>`;
}

export function notice(kind: "ok" | "error", text: string): string {
  return kind === "error"
    ? `<div class="card errors" role="alert"><p>${esc(text)}</p></div>`
    : `<div class="card"><p><strong>${esc(text)}</strong></p></div>`;
}

export function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}

export function postForm(action: string, csrf: string, inner: string, button: string): string {
  return `<form method="post" action="${esc(action)}">${hidden("csrf", csrf)}${inner}<p><button type="submit">${esc(button)}</button></p></form>`;
}

export type PageStatus = 200 | 201 | 400 | 401 | 403 | 404 | 409 | 415 | 422 | 429 | 502 | 503;

/**
 * The CSP for a page that loads the one same-origin helper script
 * (/app/assets/copy.js: copy buttons). Still no inline script.
 */
export const SCRIPT_CSP = SETUP_CSP.replace("default-src 'none';", "default-src 'none'; script-src 'self';");

/** The tag for the copy-button helper; a page that uses it is sent with `{ script: true }`. */
export const COPY_SCRIPT = '<script src="/app/assets/copy.js" defer></script>';

export function sendPage(c: Context, status: PageStatus, html: string, opts: { readonly script?: boolean } = {}): Response {
  c.header("Content-Security-Policy", opts.script === true ? SCRIPT_CSP : SETUP_CSP);
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  c.header("Referrer-Policy", "same-origin");
  return c.html(fillChrome(html, getChrome(c)), status);
}

export function sendMessage(c: Context, area: Area, status: PageStatus, title: string, text: string): Response {
  return sendPage(c, status, appLayout(area, "", title, notice(status >= 400 ? "error" : "ok", text)));
}

export function when(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
