import { esc } from "../status/page.js";
import { setupAssetVersion } from "../setup/assets.js";
import { icon, type IconName } from "./icons.js";
import { guardEmails } from "./email-guard.js";
import { MARK_ADMIN, MARK_TREE, MARK_TREE_END, MARK_USER } from "./chrome.js";

/**
 * The one page shell for /app and /setup: a sidebar with icon links and a
 * main column. Server-rendered, no script, no inline style; one same-origin
 * stylesheet. Addresses are written so the edge's email obfuscation cannot
 * match them (email-guard.ts); the email_off markers stay as a second line.
 * The sidebar is the same everywhere: Home, the Library (Reading room, Find
 * a page, To do, Subscriptions), and for administrators and on /setup the
 * Engine (Pipeline, Ledger, Staff & settings > the setup screens).
 */

export const PRODUCT_NAME = "Quantabase";

export type Area = "setup" | "app";

export type NavItem = {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly group?: string;
};

/** The setup screens: the sub-items of "Staff & settings". */
export const SETUP_NAV: readonly NavItem[] = [
  { href: "/setup/people", label: "People and topics", icon: "users", group: "Settings" },
  { href: "/setup", label: "Sign-in", icon: "lock", group: "Settings" },
  { href: "/setup/model", label: "Model key", icon: "key", group: "Settings" },
  { href: "/setup/backup", label: "Backups", icon: "archive", group: "Settings" },
  { href: "/setup/database", label: "Database", icon: "database", group: "Settings" },
  { href: "/setup/updates", label: "Updates", icon: "upload", group: "Settings" },
  { href: "/setup/health", label: "Health", icon: "heart", group: "Settings" },
  { href: "/setup/template", label: "Template", icon: "template", group: "Settings" },
  { href: "/setup/timer", label: "Timer", icon: "clock", group: "Settings" },
];

export const PIPELINE_HREF = "/setup/pipeline";
export const LEDGER_HREF = "/setup/ledger";
/** The old address of the Pipeline screen; it redirects there. */
export const INDEXING_HREF = "/setup/indexing";

export const APP_NAV: readonly NavItem[] = [
  { href: "/app", label: "Home", icon: "home" },
  { href: "/app/knowledge", label: "Reading room", icon: "book", group: "Library" },
  { href: "/app/pages", label: "Find a page", icon: "search", group: "Library" },
  { href: "/app/todo", label: "To do", icon: "clipboard", group: "Library" },
  { href: "/app/sources", label: "Subscriptions", icon: "rss", group: "Library" },
];

/** Screens that belong to a menu item without being under its address. */
const ALSO: Readonly<Record<string, readonly string[]>> = {
  "/app/todo": ["/app/reviews", "/app/flagged", "/app/duplicates"],
  [PIPELINE_HREF]: [INDEXING_HREF],
};

/**
 * One plain sentence under each screen's title: what this screen is for.
 * Matched by the longest address prefix.
 */
const HELPERS: Readonly<Record<string, string>> = {
  "/app": "Your library at a glance: what is new and what needs you.",
  "/app/knowledge": "The reading room: each shelf is a topic or kind of thing, each book is a page.",
  "/app/pages": "Search every page you can read by its name or words in it.",
  "/app/todo": "Everything waiting for you in one list: changes to approve, held mail and look-alike pages.",
  "/app/reviews": "Changes the curator will not make without your yes.",
  "/app/flagged": "Mail that looked like it was giving orders. Nothing in it was acted on.",
  "/app/duplicates": "Pages that may be the same thing. Merge them or keep them apart.",
  "/app/sources": "Subscriptions: which mail, files, meetings and Claude Code sessions the library reads for you.",
  "/setup": "Staff and settings: who can sign in and how the Engine is set up.",
  "/setup/people": "Who can read the library, and which topics each person sees.",
  "/setup/model": "The key the curator uses to reach its AI models. It is stored, never shown.",
  "/setup/backup": "A copy of every page, saved to your own repository.",
  "/setup/database": "Database updates that this version of the app needs.",
  "/setup/updates": "Which version this Engine runs, what is new, and how to update it.",
  "/setup/health": "A quick check that every part of the Engine answers.",
  "/setup/template": "Which kinds of pages (shelves) this library keeps.",
  "/setup/timer": "The clock that wakes the curator to read new mail.",
  [PIPELINE_HREF]: "How new mail becomes pages, step by step, and the few safe choices you can make.",
  [INDEXING_HREF]: "How new mail becomes pages, step by step, and the few safe choices you can make.",
  [LEDGER_HREF]: "What the AI models cost this month, and the budget that keeps it in check.",
};

export function helperFor(here: string): string {
  const key = Object.keys(HELPERS)
    .filter((k) => here === k || here.startsWith(`${k}/`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? HELPERS[key] ?? "" : "";
}

/** True when `here` is this item or a screen under it ("/app" only matches itself). */
function isHere(item: NavItem, here: string): boolean {
  if (item.href === here) return true;
  if ((ALSO[item.href] ?? []).some((a) => here === a || here.startsWith(`${a}/`))) return true;
  if (item.href === "/app" || item.href === "/setup") return false;
  return here.startsWith(`${item.href}/`);
}

export function navHtml(items: readonly NavItem[], here: string): string {
  let group: string | undefined;
  const parts: string[] = [];
  for (const item of items) {
    if (item.group && item.group !== group) parts.push(`<div class="menu-header">${esc(item.group)}</div>`);
    group = item.group;
    const current = isHere(item, here);
    const link = `<a class="nav-item${current ? " active" : ""}" href="${esc(item.href)}"${current ? ' aria-current="page"' : ""}>${icon(item.icon)}<span>${esc(item.label)}</span></a>`;
    // On /app the Knowledge link is replaced by the drawer tree when the route knows it.
    parts.push(item.href === "/app/knowledge" ? `${MARK_TREE}${link}${MARK_TREE_END}` : link);
  }
  return `<nav class="nav-menu" aria-label="Menu">${parts.join("")}</nav>`;
}

function navLink(item: NavItem, here: string, extra = ""): string {
  const current = isHere(item, here);
  return `<a class="nav-item${extra}${current ? " active" : ""}" href="${esc(item.href)}"${current ? ' aria-current="page"' : ""}>${icon(item.icon)}<span>${esc(item.label)}</span></a>`;
}

/**
 * The administrators' section, the same on every page that shows it:
 * Pipeline, Ledger, and "Staff & settings", which opens (details/summary,
 * no script) to the setup screens. Open while one of them is the current screen.
 */
export function engineNavHtml(here: string): string {
  const pipeline = navLink({ href: PIPELINE_HREF, label: "Pipeline", icon: "filter" }, here);
  const ledger = navLink({ href: LEDGER_HREF, label: "Ledger", icon: "chart" }, here);
  const inSettings = SETUP_NAV.some((i) => isHere(i, here));
  const subs = SETUP_NAV.map((i) => navLink(i, here, " nav-subitem")).join("");
  return `<div class="menu-header">Engine</div>${pipeline}${ledger}<details class="nav-sub"${inSettings ? " open" : ""}><summary class="nav-item">${icon("users")}<span>Staff &amp; settings</span></summary>${subs}</details>`;
}

/** The setup screens as a card of links: what /setup shows once sign-in is done. */
export function setupMenu(): string {
  const links = SETUP_NAV.filter((i) => i.href !== "/setup")
    .map((i) => `<li><a class="tile" href="${esc(i.href)}">${icon(i.icon)}<span>${esc(i.label)}</span></a></li>`)
    .join("");
  return `<div class="card"><h2>Setup screens</h2><ul class="tiles">${links}</ul><p class="hint"><a href="/app">Open the app</a></p></div>`;
}

export function shell(area: Area, here: string, title: string, body: string, withNav = true, version: string = setupAssetVersion()): string {
  const css = area === "setup" ? "/setup/assets/setup.css" : "/app/assets/setup.css";
  const sub = area === "setup" ? "Setup" : "Your knowledge";
  return guardEmails(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex">
<title>${esc(title)} · ${PRODUCT_NAME}</title>
<link rel="stylesheet" href="${css}?v=${encodeURIComponent(version)}">
</head>
<body>
<!--email_off-->
<div class="app-shell">
<aside class="sidebar">
<a class="brand" href="${area === "setup" ? "/setup" : "/app"}"><span class="logo">${icon("book", 22)}</span><span class="brand-text"><span class="eyebrow">${PRODUCT_NAME}</span><strong>${sub}</strong></span></a>
${withNav ? navHtml(APP_NAV, here) : ""}
${withNav ? (area === "setup" ? engineNavHtml(here) : MARK_ADMIN) : ""}
${MARK_USER}
</aside>
<main class="content">
<header class="top-bar"><h1>${esc(title)}</h1></header>
${helperFor(here) ? `<p class="helper">${esc(helperFor(here))}</p>` : ""}
<div class="page">
${body}
</div>
</main>
</div>
<!--/email_off-->
</body>
</html>
`);
}
