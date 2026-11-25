import { esc, hidden, when } from "./html.js";
import type { Row } from "./store.js";

/**
 * The Ledger screen's HTML (pipeline-routes.ts): model spend this month
 * (UTC), the month-end projection, the budget and its rule, a daily bar
 * chart split by role with a marker on each day a setting changed, and a
 * small items table. The chart is inline SVG drawn on the server (no script,
 * no inline style; the colours come from the stylesheet's classes).
 */

export type Day = { readonly day: string; readonly author: number; readonly cataloguer: number; readonly other: number };
export type Change = { readonly at: string; readonly by: string; readonly setting: string; readonly old: string; readonly new: string };

const object = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
export const usd = (v: number): string => `$${v.toFixed(v > 0 && v < 1 ? 3 : 2)}`;

export function parseDays(v: unknown): Day[] {
  return (Array.isArray(v) ? v : [])
    .map(object)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d["day"] ?? "")))
    .map((d) => ({
      day: String(d["day"]),
      author: Math.max(0, num(d["author_usd"])),
      cataloguer: Math.max(0, num(d["cataloguer_usd"])),
      other: Math.max(0, num(d["other_usd"])),
    }));
}

export function parseChanges(v: unknown): Change[] {
  return (Array.isArray(v) ? v : []).map(object).map((c) => ({
    at: String(c["at"] ?? ""), by: String(c["by"] ?? ""), setting: String(c["setting"] ?? ""),
    old: String(c["old"] ?? ""), new: String(c["new"] ?? ""),
  }));
}

/** Days in the month of `since`, and how far into it `now` is (at least one day). */
export function monthProgress(since: Date, now: Date): { readonly days: number; readonly elapsed: number } {
  const days = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsed = Math.min(days, Math.max(1, (now.getTime() - since.getTime()) / 86_400_000));
  return { days, elapsed };
}

/** Month-end spend if the rest of the month goes like the days so far. */
export function projected(spent: number, since: Date, now: Date): number {
  const m = monthProgress(since, now);
  return (spent / m.elapsed) * m.days;
}

const SETTING_NAMES: Readonly<Record<string, string>> = {
  author: "Author", desk_editor: "Desk editor", archivist_bar: "Archivist", publisher_ask: "Publisher",
  stale_days: "Librarian", summary_length: "Cataloguer", redo_index: "Redo summaries and index", pause: "Pause", budget_usd: "Budget", budget_pct: "Budget rule", budget_action: "Budget rule",
};

export const settingName = (id: string): string => SETTING_NAMES[id] ?? id;

const W = 640;
const H = 160;
const PAD = 20;

/** Stacked daily bars (desk editor and fact-checker, then the cataloguer, then the author), one marker per changed day. */
export function chartSvg(days: readonly Day[], changes: readonly Change[], monthDays: number, monthStart: string): string {
  const max = Math.max(0.01, ...days.map((d) => d.author + d.cataloguer + d.other));
  const slot = (W - PAD) / monthDays;
  const bar = Math.max(2, slot * 0.7);
  const y = (v: number) => (v / max) * (H - PAD);
  const dayIndex = (iso: string) => Math.floor((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - Date.parse(monthStart)) / 86_400_000);
  const rect = (cls: string, x: string, bottom: number, h: number) =>
    `<rect class="${cls}" x="${x}" y="${(H - PAD - bottom - h).toFixed(1)}" width="${bar.toFixed(1)}" height="${h.toFixed(1)}"></rect>`;
  const bars = days.map((d) => {
    const i = dayIndex(d.day);
    if (i < 0 || i >= monthDays) return "";
    const x = (PAD + i * slot).toFixed(1);
    const ho = y(d.other);
    const hc = y(d.cataloguer);
    const ha = y(d.author);
    const label = `${d.day}: Author ${usd(d.author)}, Cataloguer ${usd(d.cataloguer)}, Desk editor and Fact-checker ${usd(d.other)}`;
    const cataloguer = d.cataloguer > 0 ? rect("bar-cataloguer", x, ho, hc) : "";
    return `<g><title>${esc(label)}</title>${rect("bar-other", x, 0, ho)}${cataloguer}${rect("bar-author", x, ho + hc, ha)}</g>`;
  });
  const marks = changes.map((c) => {
    const i = dayIndex(c.at);
    if (i < 0 || i >= monthDays) return "";
    const x = (PAD + i * slot + bar / 2).toFixed(1);
    return `<g><title>${esc(`${when(c.at)}: ${settingName(c.setting)} ${c.old} to ${c.new} (${c.by})`)}</title><line class="mark" x1="${x}" y1="0" x2="${x}" y2="${H - PAD}"></line></g>`;
  });
  const axis = `<line class="axis" x1="${PAD}" y1="${H - PAD}" x2="${W}" y2="${H - PAD}"></line><text class="tick" x="${PAD}" y="${H - 4}">1</text><text class="tick" x="${W - 16}" y="${H - 4}">${monthDays}</text><text class="tick" x="0" y="12">${esc(usd(max))}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Model cost each day this month, by role">${axis}${bars.join("")}${marks.join("")}</svg>
<p class="legend"><span class="key author"></span> Author <span class="key cataloguer"></span> Cataloguer <span class="key other"></span> Desk editor and Fact-checker <span class="key mark"></span> a setting changed</p>`;
}

/** The budget state in one sentence and a light. */
export function budgetState(spent: number, proj: number, budget: number, pct: number): { readonly light: "ok" | "warn" | "bad"; readonly text: string } {
  const used = budget > 0 ? (spent / budget) * 100 : 0;
  if (spent >= budget) return { light: "bad", text: `Over budget: ${usd(spent)} of ${usd(budget)}.` };
  if (used >= pct) return { light: "warn", text: `${Math.round(used)}% of the budget is used, past the ${pct}% rule.` };
  if (proj > budget) return { light: "warn", text: `On track to pass the budget by month end (${usd(proj)}).` };
  return { light: "ok", text: `${Math.round(used)}% of the budget is used. On track.` };
}

/** The owner's budget form; read only for everyone else. */
export function budgetForm(l: Row, csrf: string | null, changes: Row, marker: (changes: Row, id: string) => string): string {
  const budget = num(l["budget_usd"]);
  const pct = num(l["budget_pct"]);
  const action = l["budget_action"] === "switch" ? "switch" : "warn";
  const actionText = action === "switch" ? "switch the Author to Budget for the rest of the month" : "warn me on this page";
  if (csrf === null) {
    return `<p>Budget: <strong>${esc(usd(budget))}</strong> a month. At ${esc(pct)}% of it: ${esc(actionText)}.</p><p class="hint">Only the Engine owner changes the budget.</p>`;
  }
  const form = (setting: string, inner: string) =>
    `<form method="post" action="/setup/pipeline/set">${hidden("csrf", csrf)}${hidden("setting", setting)}${inner}<p><button type="submit">Save</button></p></form>`;
  const pcts = [50, 75, 80, 90, 100].map((p) => `<option value="${p}"${p === pct ? " selected" : ""}>${p}%</option>`).join("");
  const radio = (v: string, label: string, effect: string) =>
    `<label class="choice"><input type="radio" name="value" value="${v}"${v === action ? " checked" : ""} required><span><strong>${esc(label)}</strong><br><span class="hint">${esc(effect)}</span></span></label>`;
  return [
    form("budget_usd", `<label for="budget">Monthly budget (US dollars)</label>${marker(changes, "budget_usd")}<input id="budget" type="number" name="value" min="1" max="10000" step="0.01" value="${esc(budget.toFixed(2))}" required>`),
    form("budget_pct", `<label for="pct">Act when spending reaches</label>${marker(changes, "budget_pct")}<select id="pct" name="value">${pcts}</select>`),
    form("budget_action", `<fieldset><legend>Then</legend>${marker(changes, "budget_action")}${radio("warn", "Warn me", "Nothing changes on its own. Quality stays the same.")}${radio("switch", "Switch the Author to Budget", "Spending slows for the rest of the month; pages read plainer. Switch back on the Pipeline screen.")}</fieldset>`),
  ].join("");
}
