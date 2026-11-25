import { entitySchema, TEMPLATE_NAMES, type DrawerDef } from "../entities/templates.js";
import { esc, when } from "./html.js";
import { drawerIcon, icon } from "./icons.js";
import type { Row } from "./store.js";

/**
 * The Knowledge menu under /app: one folder per drawer of the chosen
 * templates (base always included), each with its entity icon and page
 * count; then the pages in one drawer. Counts come from the person's own
 * pages (app_pages_list), so nobody sees counts of pages that are not theirs.
 */

export type Folder = { readonly id: string; readonly label: string; readonly count: number };

/** The drawers of base plus the chosen templates; unknown template names skipped. */
export function chosenDrawers(chosen: readonly string[]): readonly DrawerDef[] {
  const known = chosen.filter((n) => TEMPLATE_NAMES.includes(n));
  return entitySchema(known).drawers;
}

/** Folders for the chosen drawers, plus any drawer that holds pages but is no longer chosen. */
export function folders(drawers: readonly DrawerDef[], pages: readonly Row[]): Folder[] {
  const counts = new Map<string, number>();
  for (const p of pages) {
    const d = String(p["drawer"] ?? "");
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const chosen = drawers.map((d) => ({ id: d.id, label: d.label, count: counts.get(d.id) ?? 0 }));
  const extra = [...counts.entries()]
    .filter(([id]) => id !== "" && !drawers.some((d) => d.id === id))
    .map(([id, count]) => ({ id, label: id, count }));
  return [...chosen, ...extra];
}

export function foldersHtml(list: readonly Folder[]): string {
  const tiles = list
    .map(
      (f) =>
        `<li><a class="folder" href="/app/knowledge/${esc(f.id)}"><span class="folder-icon">${icon(drawerIcon(f.id), 24)}</span><span class="folder-name">${esc(f.label)}</span><span class="count">${esc(f.count)} ${f.count === 1 ? "page" : "pages"}</span></a></li>`,
    )
    .join("");
  return `<ul class="folders">${tiles}</ul>`;
}

export function drawerPagesHtml(drawer: Folder, pages: readonly Row[]): string {
  if (pages.length === 0) return `<div class="card"><p class="empty">No pages in ${esc(drawer.label)} yet.</p></div>`;
  const rows = pages
    .map(
      (p) =>
        `<li><a class="page-row" href="/app/pages/${esc(p["id"])}">${icon("document", 18)}<span class="page-title">${esc(p["title"])}</span><span class="hint mono">${esc(p["key"])}</span><span class="hint">${esc(when(p["updated_at"]))}</span></a></li>`,
    )
    .join("");
  return `<div class="card"><ul class="page-list">${rows}</ul></div>`;
}

export const DRAWER_ID = /^[a-z][a-z0-9-]{0,62}$/;
