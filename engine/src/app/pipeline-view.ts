import { esc, hidden, when } from "./html.js";
import { icon, type IconName } from "./icons.js";
import type { Row } from "./store.js";
import { ticketHref } from "./tickets-routes.js";
import { cataloguerState, indexClerkState, searchBoxHtml } from "./cataloguer-view.js";

/**
 * The Pipeline screen's HTML (pipeline-routes.ts): the curator drawn as a
 * publishing line, and the owner's safe choices. Plain words for someone new;
 * every choice says what it does to cost and quality. No choice can switch a
 * check off (migration 0071 holds the same lists).
 */

export type Light = "ok" | "warn" | "bad" | "off";

export type Choice = { readonly value: string; readonly label: string; readonly effect: string };

export type SettingDef = {
  readonly id: string;
  readonly title: string;
  /** The short label on the step card. */
  readonly label: string;
  readonly choices: readonly Choice[];
};

/** The choices, in the order shown. The values match app_pipeline_set's lists. */
export const PIPELINE_SETTINGS: readonly SettingDef[] = [
  {
    id: "author", label: "Writing", title: "Author writing quality", choices: [
      { value: "best", label: "Best", effect: "Clearest pages, fewest missed facts. Costs more." },
      { value: "budget", label: "Budget", effect: "Much cheaper. Plainer pages, may miss details." },
    ],
  },
  {
    id: "desk_editor", label: "Pass on", title: "Desk editor: how much mail to pass on", choices: [
      { value: "keep_more", label: "Keep more", effect: "Passes on more. Costs more, misses less." },
      { value: "normal", label: "Normal", effect: "Recommended. A good balance." },
      { value: "keep_less", label: "Keep less", effect: "Passes on less. Cheaper, may skip small facts." },
    ],
  },
  {
    id: "archivist_bar", label: "New pages", title: "Archivist: when to start a new page", choices: [
      { value: "rarely_new", label: "Rarely make new", effect: "Fewer duplicates. Similar names may share a page." },
      { value: "normal", label: "Normal", effect: "Recommended. Same cost." },
    ],
  },
  {
    id: "publisher_ask", label: "Ask me before saving", title: "Publisher: ask me before saving", choices: [
      { value: "never", label: "Never", effect: "Saves on its own. Safety checks still ask you." },
      { value: "big_changes", label: "Big changes only", effect: "Also asks before big changes. Safer, more to approve." },
    ],
  },
  {
    id: "summary_length", label: "Summary length", title: "Cataloguer: how long each page summary is", choices: [
      { value: "short", label: "Short", effect: "Shorter summaries. A little cheaper, less for search." },
      { value: "standard", label: "Standard", effect: "Recommended. Fuller summaries help search." },
    ],
  },
  {
    id: "stale_days", label: "Stale after", title: "Librarian: call a page stale after", choices: [
      { value: "60", label: "60", effect: "More pages flagged. No extra cost." },
      { value: "90", label: "90", effect: "Recommended." },
      { value: "180", label: "180", effect: "Fewer pages flagged. No extra cost." },
    ],
  },
];

export const SETTING_IDS: ReadonlySet<string> = new Set([
  ...PIPELINE_SETTINGS.map((s) => s.id), "pause", "budget_usd", "budget_pct", "budget_action",
]);

const object = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const count = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "changed on 2026-11-22 14:05 UTC by x", or "". */
export function changedMarker(changes: Row, id: string): string {
  const c = object(changes[id]);
  return c["at"] ? `<span class="changed">changed on ${esc(when(c["at"]))} by ${esc(c["by"])}</span>` : "";
}

type Step = {
  /** The step id tickets use (0072). */
  readonly id: string;
  readonly name: string;
  readonly icon: IconName;
  readonly does: string;
  readonly light: Light;
  readonly status: string;
  readonly href?: string;
  /** The setting shown at the bottom of the card, if any. */
  readonly setting?: string;
};

function lightHtml(light: Light): string {
  const word = { ok: "running", warn: "needs a look", bad: "problem", off: "stopped" }[light];
  return `<span class="light ${light}" role="img" aria-label="${word}"></span>`;
}

/** The plain intro above the cards: what this screen is, for someone new. */
export const INTRO =
  "Your new mail, files and meetings move through these twelve steps in order, like a book going through a publishing house: " +
  "they arrive, an editor decides what is worth keeping, an author writes it up, a fact-checker checks it, and a publisher puts it on the shelf. " +
  "Then a cataloguer writes a short summary of each page and an index clerk files it, so you and Claude can find and read it. Each card shows what that step does, whether it is working, and any choice you can make for it. " +
  "A red “Needs you” badge means a person should look; an amber “Check and close” badge means a problem looks fixed and is waiting for you to close it.";

const badge = (cls: string, word: string, list: readonly Row[]): string => {
  if (!list.length) return "";
  const href = list.length === 1 ? ticketHref(list[0]?.["ref"]) : "/app/todo";
  const refs = list.map((t) => String(t["ref"] ?? "")).join(", ");
  return `<a class="${cls}" href="${esc(href)}" title="${esc(refs)}">${word} – ${list.length}</a>`;
};

/** A ticket whose cause is still there (not "looks fixed"). */
export const isActive = (t: Row): boolean => !t["cleared_at"];

/**
 * The badges on a step: red "Needs you" for tickets whose cause is still
 * there; calm amber "Check and close" for ones that look fixed. Each goes to
 * the one ticket, or to To do when there are several.
 */
export function needsYouHtml(tickets: readonly Row[]): string {
  return badge("needs-you", "Needs you", tickets.filter(isActive)) +
    badge("check-close", "Check and close", tickets.filter((t) => !isActive(t)));
}

export const introHtml = (): string => `<p class="pipeline-intro">${esc(INTRO)}</p>`;

const QUIET = `<div class="tune quiet"><p>Nothing to set here.</p></div>`;

function stepHtml(s: Step, n: number, lastRun: string, tickets: readonly Row[]): string {
  const name = s.href ? `<a href="${esc(s.href)}">${esc(s.name)}</a>` : esc(s.name);
  const mark = tickets.some(isActive) ? " has-needs" : tickets.length ? " has-check" : "";
  return `<li class="step${mark}"><span class="link" aria-hidden="true"></span>
<div class="step-top"><div class="step-head"><span class="step-no" aria-label="Step ${n}">${n}</span>${icon(s.icon)}<strong>${name}</strong>${lightHtml(s.light)}</div>
${needsYouHtml(tickets)}<p>${esc(s.does)}</p><p class="hint">${esc(s.status)}</p></div>
${s.setting ?? QUIET}<p class="step-foot">Last run: ${esc(lastRun)}</p></li>`;
}

const setForm = (csrf: string, setting: string, inner: string): string =>
  `<form method="post" action="/setup/pipeline/set">${hidden("csrf", csrf)}${hidden("setting", setting)}${inner}</form>`;

/**
 * One setting at the bottom of its step card: a segmented control for the
 * owner (each choice is its own submit button, so no script), the current
 * value read only for everyone else, and one line on what the choice does.
 */
export function settingHtml(def: SettingDef, current: string, changes: Row, csrf: string | null): string {
  const now = def.choices.find((c) => c.value === current);
  const effect = `<p class="effect">${esc(now?.effect ?? "")}</p>${changedMarker(changes, def.id)}`;
  const head = `<span class="tune-label">${esc(def.label)}</span>`;
  if (csrf === null) {
    return `<div class="tune">${head}<p class="tune-value"><strong>${esc(now?.label ?? current)}</strong></p>${effect}</div>`;
  }
  const buttons = def.choices
    .map((c) => c.value === current
      ? `<button type="button" aria-pressed="true" title="${esc(c.effect)}">${esc(c.label)}</button>`
      : `<button type="submit" name="value" value="${esc(c.value)}" aria-pressed="false" title="${esc(c.effect)}">${esc(c.label)}</button>`)
    .join("");
  return `<div class="tune">${head}${setForm(csrf, def.id, `<div class="seg" role="group" aria-label="${esc(def.title)}">${buttons}</div>`)}${effect}</div>`;
}

/** The pause switch, on the New mail alert card: a 24-hour pause, or resume. */
export function pauseHtml(p: Row, csrf: string | null): string {
  const s = object(p["settings"]);
  const paused = typeof s["paused_until"] === "string";
  const marker = changedMarker(object(p["changes"]), "pause");
  const state = paused ? `Paused until ${esc(when(s["paused_until"]))}.` : "Running.";
  const note = `<p class="effect">Ends by itself after a day. Mail waits; nothing is lost.</p>${marker}`;
  const head = `<span class="tune-label">Curator</span>`;
  if (csrf === null) return `<div class="tune">${head}<p class="tune-value"><strong>${state}</strong></p>${note}</div>`;
  const sw = `${hidden("value", paused ? "resume" : "pause")}<button type="submit" class="switch" role="switch" aria-checked="${paused ? "false" : "true"}"><span class="knob"></span>${paused ? "Resume now" : "Pause for 24 hours"}</button>`;
  return `<div class="tune">${head}<p class="tune-value">${state}</p>${setForm(csrf, "pause", sw)}${note}</div>`;
}

const SETTING_BY_ID: ReadonlyMap<string, SettingDef> = new Map(PIPELINE_SETTINGS.map((d) => [d.id, d]));

/** The Index clerk's try-a-search box: its form token (any administrator) and the last question. */
export type SearchBox = { readonly csrf: string; readonly query?: string };

/** The publishing line, left to right (top to bottom on a phone); each setting sits on its step. */
export function lineHtml(p: Row, csrf: string | null, tickets: readonly Row[] = [], search?: SearchBox): string {
  const s = object(p["settings"]);
  const changes = object(p["changes"]);
  const tune = (id: string): string => {
    const def = SETTING_BY_ID.get(id);
    return def ? settingHtml(def, String(s[id] ?? ""), changes, csrf) : "";
  };
  const run = object(p["last_run"]);
  const paused = typeof s["paused_until"] === "string";
  const on = p["curator_on"] === true;
  const runLight: Light = paused || !on ? "off" : run["status"] === "failed" ? "bad" : "ok";
  const lastRun = run["started_at"] ? `${when(run["started_at"])} (${String(run["status"] ?? "")})` : "never";
  const waiting = count(p["items_waiting"]);
  const reviews = count(p["reviews_pending"]);
  const dups = count(p["duplicates_open"]);
  const stale = count(p["pages_stale"]);
  const writer = s["author"] === "budget" ? "Budget" : "Best";
  const catalogue = cataloguerState(p, runLight);
  const index = indexClerkState(p, runLight);
  const steps: Step[] = [
    { id: "subscriptions", name: "Subscriptions", icon: "rss", does: "The mail, files, meetings and Claude Code sessions you chose to send in.", light: "ok", status: `${plural(count(p["items_in_month"]), "item")} came in this month.`, href: "/app/sources" },
    { id: "mailroom", name: "Mailroom", icon: "inbox", does: "New items wait here until the curator picks them up.", light: waiting > 100 ? "warn" : "ok", status: `${plural(waiting, "item")} waiting; ${plural(count(p["items_flagged"]), "item")} held for you.` },
    { id: "new_mail_alert", name: "New mail alert", icon: "bell", does: "Wakes the curator when new mail arrives.", light: on ? "ok" : "off", status: on ? "On." : "Off: the curator is not woken.", href: "/setup/timer", setting: pauseHtml(p, csrf) },
    { id: "desk_editor", name: "Desk editor", icon: "filter", does: "Reads each item first and sets aside ones with nothing worth keeping.", light: runLight, status: `${plural(count(p["skipped_month"]), "item")} set aside this month.`, setting: tune("desk_editor") },
    { id: "archivist", name: "Archivist", icon: "archive", does: "Finds the pages an item belongs to, so it updates them instead of making copies.", light: runLight, status: s["archivist_bar"] === "rarely_new" ? "Rarely makes new pages." : "Normal bar for new pages.", setting: tune("archivist_bar") },
    { id: "author", name: "Author", icon: "pencil", does: "Writes and updates the pages.", light: runLight, status: writer, setting: tune("author") },
    { id: "fact_checker", name: "Fact-checker", icon: "shield", does: "Checks new sentences against the original and cuts what it cannot back up.", light: runLight, status: "Runs with the Desk editor." },
    { id: "publisher", name: "Publisher", icon: "upload", does: "Saves the page and keeps earlier versions, so any change can be undone.", light: reviews > 0 ? "warn" : runLight, status: reviews > 0 ? `${plural(reviews, "change")} waiting for your yes.` : "Nothing waiting for you.", href: "/app/todo", setting: tune("publisher_ask") },
    { id: "cataloguer", name: "Cataloguer", icon: "tag", does: "Writes a short summary of each page after it is published.", light: catalogue.light, status: catalogue.status, setting: tune("summary_length") },
    { id: "index_clerk", name: "Index clerk", icon: "search", does: "Files each summary in the search index so Claude can find the page.", light: index.light, status: index.status, ...(search ? { setting: searchBoxHtml(search.csrf, search.query) } : {}) },
    { id: "librarian", name: "Librarian", icon: "collection", does: "Each night looks for look-alike and out-of-date pages.", light: dups > 0 || stale > 0 ? "warn" : runLight, status: `${plural(dups, "look-alike pair")}; ${plural(stale, "page")} not updated in ${String(s["stale_days"] ?? 90)} days.`, href: "/app/duplicates", setting: tune("stale_days") },
    { id: "reading_room", name: "Reading room", icon: "book", does: "Where you and Claude read the finished pages.", light: "ok", status: `${plural(count(p["pages"]), "page")}.`, href: "/app/knowledge" },
  ];
  const note = paused
    ? `<div class="card warnings" role="status"><p><strong>Paused</strong> until ${esc(when(s["paused_until"]))}. Mail keeps arriving and waits in the Mailroom.</p></div>`
    : "";
  const forStep = (id: string): Row[] => tickets.filter((t) => t["step"] === id && t["status"] !== "closed");
  return `${note}<ol class="line" aria-label="The publishing line, in order">${steps.map((x, i) => stepHtml(x, i + 1, lastRun, forStep(x.id))).join("")}</ol>`;
}
