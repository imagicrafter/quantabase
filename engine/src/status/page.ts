import type { DashboardModel } from "./model.js";
import { guardEmails } from "../app/email-guard.js";

/**
 * HTML shell for the dashboard. The page itself carries no script and no
 * style: it links the two static assets (served under /status/assets/) and
 * embeds the model as inert JSON the browser code reads and draws.
 */

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON that cannot close its <script> tag or break out through line separators. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** "Acme's Quantabase" (or the older "... AI Engine" or "... Knowledge Base Engine") -> "Acme". */
export function brandName(title: string): string {
  return title.replace(/['’]s (?:(?:AI|Knowledge Base) Engine|Quantabase)$/, "") || title;
}

export function renderPage(
  model: DashboardModel,
  version: string,
  email: string,
): string {
  const v = encodeURIComponent(version);
  return guardEmails(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${esc(model.title)}</title>
<link rel="stylesheet" href="/status/assets/dashboard.css?v=${v}">
</head>
<body>
<!--email_off-->
<div class="shell">
  <aside class="sidebar" aria-label="Engine menu">
    <div class="brand"><span class="eyebrow">Quantabase</span><h1>${esc(brandName(model.title))}</h1></div>
    <button class="btn menu-btn" type="button" id="menu-btn" aria-expanded="false" aria-controls="nav"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>Menu</button>
    <div class="overall" id="overall"></div>
    <nav class="nav" id="nav"></nav>
    <div class="sidebar-foot">
      <div class="theme" role="group" aria-label="Theme">
        <button type="button" data-theme-set="light">Light</button>
        <button type="button" data-theme-set="system">Auto</button>
        <button type="button" data-theme-set="dark">Dark</button>
      </div>
      <span>Signed in as ${esc(email)} · 2FA</span>
    </div>
  </aside>
  <main class="main" id="main">
    <noscript><p class="empty">This dashboard needs JavaScript to draw its charts and menus.</p></noscript>
    <div id="page"></div>
  </main>
</div>
<!--/email_off-->
<script type="application/json" id="engine-data">${safeJson(model)}</script>
<script src="/status/assets/dashboard.js?v=${v}" defer></script>
</body>
</html>
`);
}
