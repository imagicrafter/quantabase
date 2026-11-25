import { fieldProblem } from "../curator/output.js";
import type { DrawerDef } from "../entities/templates.js";
import { esc, hidden, when } from "./html.js";
import { drawerIcon, icon } from "./icons.js";
import { renderMarkdown, wikiHref } from "./markdown.js";
import type { Row } from "./store.js";

/**
 * One page, Obsidian style: a Properties block (the header as typed fields),
 * the rendered body with clickable [[links]], and a links panel (what it
 * links to, what links to it). And its edit form: the properties as a form
 * checked against the drawer's field schema, plus the Markdown body.
 *
 * Read-only in the form: key, owner, created, drawer, topics (topics are
 * access labels, changed by an administrator, not here).
 */

export const MAX_BODY = 200_000;
const MAX_LIST = 50;
const LIST_ITEM = /^[^\s<>"]{1,200}$/;
const ALIAS_ITEM = /^[^<>"\n]{1,200}$/;
const STATUSES = ["draft", "unreviewed", "current"] as const;

const str = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const object = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});

function chip(text: string, href?: string, cls = "chip"): string {
  return href ? `<a class="${cls} link" href="${esc(href)}">${esc(text)}</a>` : `<span class="${cls}">${esc(text)}</span>`;
}

const chips = (values: readonly string[], link = false): string =>
  values.length === 0 ? '<span class="hint">none</span>' : values.map((v) => chip(v, link ? wikiHref(v) : undefined)).join(" ");

/** A field value shown by its kind: dates as dates, keys as link chips. */
function typedValue(def: DrawerDef["fields"][number] | undefined, value: unknown): string {
  if (value === null || value === undefined || value === "") return '<span class="hint">empty</span>';
  switch (def?.kind) {
    case "key":
      return chip(str(value), wikiHref(str(value)));
    case "date":
      return `<time datetime="${esc(value)}">${esc(value)}</time>`;
    case "url":
      return /^https?:\/\/\S+$/.test(str(value))
        ? `<a href="${esc(value)}" rel="noopener noreferrer nofollow">${esc(value)}</a>`
        : esc(value);
    case "enum":
      return chip(str(value), undefined, "chip enum");
    default:
      return esc(value);
  }
}

function propRow(name: string, kindLabel: string, value: string): string {
  return `<tr><th scope="row"><span class="prop-name">${esc(name)}</span><span class="prop-kind">${esc(kindLabel)}</span></th><td>${value}</td></tr>`;
}

export function propertiesHtml(p: Row, drawer: DrawerDef | undefined): string {
  const fields = object(p["fields"]);
  const defs = drawer?.fields ?? [];
  const known = defs.map((d) => propRow(d.name, d.kind, typedValue(d, fields[d.name])));
  const extra = Object.keys(fields)
    .filter((k) => !defs.some((d) => d.name === k))
    .map((k) => propRow(k, "text", esc(fields[k])));
  const rows = [
    propRow("key", "key", `<code>${esc(p["key"])}</code>`),
    propRow("drawer", "drawer", chip(str(p["drawer"]))),
    propRow("status", "enum", chip(str(p["status"]), undefined, "chip enum")),
    propRow("description", "text", p["description"] ? esc(p["description"]) : '<span class="hint">empty</span>'),
    propRow("aliases", "list", chips(strs(p["aliases"]))),
    propRow("tags", "list", chips(strs(p["tags"]))),
    propRow("related", "links", chips(strs(p["related"]), true)),
    propRow("topics", "access", chips(strs(p["topics"]))),
    ...known,
    ...extra,
    propRow("owner", "person", esc(p["owner"])),
    propRow("created", "date", esc(when(p["created_at"]))),
    propRow("updated", "date", esc(when(p["updated_at"]))),
    propRow("reviewed", "date", p["reviewed"] ? esc(when(p["reviewed"])) : '<span class="hint">not yet</span>'),
  ];
  return `<details class="card properties" open><summary>${icon("tag", 16)} Properties</summary><table class="props"><tbody>${rows.join("")}</tbody></table></details>`;
}

function linkItem(l: Row): string {
  const title = str(l["title"]) || str(l["key"]);
  const ic = icon(drawerIcon(str(l["drawer"])), 14);
  return l["id"]
    ? `<li><a href="/app/pages/${esc(l["id"])}">${ic}<span>${esc(title)}</span></a></li>`
    : `<li class="missing">${icon("document", 14)}<span>${esc(l["key"])}</span> <span class="hint">no page yet</span></li>`;
}

export function linksPanelHtml(links: Row | null): string {
  const out = Array.isArray(links?.["out"]) ? (links?.["out"] as Row[]) : [];
  const inn = Array.isArray(links?.["in"]) ? (links?.["in"] as Row[]) : [];
  const list = (rows: Row[]) => (rows.length === 0 ? '<p class="hint">None.</p>' : `<ul class="link-list">${rows.map(linkItem).join("")}</ul>`);
  return `<aside class="card links-panel"><h2>Links</h2><h3>Related (${esc(out.length)})</h3>${list(out)}<h3>Backlinks (${esc(inn.length)})</h3>${list(inn)}</aside>`;
}

/**
 * "Last change" at the top of a page: when, by whom (a person or the
 * curator), from which source item, and a link to that change's diff (the
 * version before the current one, compared with now) or to the history.
 */
export function lastChangeHtml(p: Row, history: readonly Row[]): string {
  const id = str(p["id"]);
  const latest = history[0];
  const before = history[1];
  const by = str(latest?.["saved_by"]) || (p["generated"] && typeof p["generated"] === "object" ? "the curator" : "");
  const sources = Array.isArray(p["sources"]) ? (p["sources"] as unknown[]) : [];
  const last = sources[sources.length - 1];
  const ref = last && typeof last === "object" ? (last as Row) : null;
  const item = ref ? ` · from ${esc(ref["source"])} ${esc(ref["source_id"])}${ref["version"] != null ? ` (version ${esc(ref["version"])})` : ""}` : "";
  const href = before ? `/app/history/${str(before["id"])}` : `/app/pages/${id}/history`;
  const when_ = str(latest?.["saved_at"]) || str(p["updated_at"]);
  return `<p class="hint last-change"><strong>Last change</strong> ${esc(when(when_))}${by ? ` by ${esc(by)}` : ""}${item} · <a href="${esc(href)}">${before ? "See what changed" : "History"}</a></p>`;
}

export type ViewActions ={ readonly pinForm: string; readonly reviewForm: string; readonly reindexForm: string };

export function pageViewHtml(p: Row, drawer: DrawerDef | undefined, links: Row | null, actions: ViewActions, history: readonly Row[] = []): string {
  const id = str(p["id"]);
  const pending = p["summary_pending"] === true ? ' <span class="badge warn">summary pending</span>' : "";
  const bar = `<div class="page-actions"><a class="button" href="/app/pages/${esc(id)}/edit">${icon("template", 16)}<span>Edit</span></a><a class="button secondary" href="/app/pages/${esc(id)}/history">${icon("clock", 16)}<span>History</span></a>${actions.pinForm}${actions.reviewForm}${actions.reindexForm}</div>`;
  const crumb = `<p class="hint crumbs"><a href="/app/knowledge">Knowledge</a> / <a href="/app/knowledge/${esc(p["drawer"])}">${esc(drawer?.label ?? p["drawer"])}</a>${pending}</p>`;
  return `${crumb}${bar}${lastChangeHtml(p, history)}<div class="page-grid"><div class="page-main">${propertiesHtml(p, drawer)}<article class="card markdown">${renderMarkdown(str(p["body"]))}</article></div>${linksPanelHtml(links)}</div>`;
}

// ── the edit form ───────────────────────────────────────────────────────────

function fieldInput(def: DrawerDef["fields"][number], value: unknown): string {
  const name = `f_${def.name}`;
  const v = esc(value ?? "");
  const label = `<label for="${esc(name)}">${esc(def.name)} <span class="prop-kind">${esc(def.kind)}</span></label>`;
  if (def.kind === "enum") {
    const opts = ["", ...(def.values ?? [])]
      .map((o) => `<option value="${esc(o)}"${str(value) === o ? " selected" : ""}>${esc(o || "(empty)")}</option>`)
      .join("");
    return `${label}<select id="${esc(name)}" name="${esc(name)}">${opts}</select>`;
  }
  const type = def.kind === "date" ? "date" : def.kind === "number" ? "number" : def.kind === "email" ? "email" : def.kind === "url" ? "url" : "text";
  return `${label}<input type="${type}" id="${esc(name)}" name="${esc(name)}" value="${v}" maxlength="300"${type === "number" ? ' step="any"' : ""}>`;
}

export function editFormHtml(p: Row, drawer: DrawerDef | undefined, csrf: string): string {
  const id = str(p["id"]);
  const fields = object(p["fields"]);
  const statusOpts = STATUSES.map((s) => `<option value="${s}"${p["status"] === s ? " selected" : ""}>${s}</option>`).join("");
  const drawerFields = drawer
    ? drawer.fields.map((d) => fieldInput(d, fields[d.name])).join("")
    : '<p class="hint">This drawer is not in the chosen templates, so its fields are kept as they are.</p>';
  return `<form method="post" action="/app/pages/${esc(id)}" class="edit-form">${hidden("csrf", csrf)}${hidden("expected_hash", str(p["content_hash"]))}${hidden("props", "1")}
<div class="card"><h2>Properties</h2>
<p class="hint">Key <code>${esc(p["key"])}</code> · owner ${esc(p["owner"])} · created ${esc(when(p["created_at"]))} (these do not change here).</p>
<label for="title">Title</label><input type="text" id="title" name="title" value="${esc(p["title"])}" maxlength="300" required>
<label for="description">Description</label><input type="text" id="description" name="description" value="${esc(p["description"])}" maxlength="500">
<label for="status">Status</label><select id="status" name="status">${statusOpts}</select>
<label for="aliases">Aliases <span class="prop-kind">comma separated</span></label><input type="text" id="aliases" name="aliases" value="${esc(strs(p["aliases"]).join(", "))}" maxlength="4000">
<label for="tags">Tags <span class="prop-kind">comma separated</span></label><input type="text" id="tags" name="tags" value="${esc(strs(p["tags"]).join(", "))}" maxlength="4000">
<label for="related">Related <span class="prop-kind">page keys, comma separated</span></label><input type="text" id="related" name="related" value="${esc(strs(p["related"]).join(", "))}" maxlength="10000">
${drawerFields}
</div>
<div class="card"><h2>Text</h2><label for="body">Markdown</label><textarea id="body" name="body" rows="24" maxlength="${MAX_BODY}">${esc(p["body"])}</textarea>
<p class="hint">Saving writes a new version (the old one stays in the history) and queues a new summary. If the page changed since you opened it, the save is refused and nothing is lost.</p>
<p><button type="submit">Save</button> <a href="/app/pages/${esc(id)}">Cancel</a></p></div>
</form>`;
}

function splitList(raw: string, what: string, lower: boolean, rule: RegExp = LIST_ITEM): string[] | string {
  const items = [...new Set(raw.split(/[,\n]/).map((s) => (lower ? s.trim().toLowerCase() : s.trim())).filter((s) => s !== ""))];
  if (items.length > MAX_LIST) return `At most ${MAX_LIST} ${what}.`;
  const bad = items.find((s) => !rule.test(s));
  return bad === undefined ? items : `"${bad}" is not a valid entry in ${what} (${rule === LIST_ITEM ? "no spaces, " : ""}at most 200 characters).`;
}

/**
 * The page's properties from the edit form, checked against the drawer's
 * field schema. Returns the changed header parts, or a message.
 */
export function editedProperties(
  current: Row,
  form: Readonly<Record<string, string>>,
  drawer: DrawerDef | undefined,
): Row | string {
  const status = form["status"] ?? str(current["status"]);
  if (!(STATUSES as readonly string[]).includes(status)) return "Status must be draft, unreviewed or current.";
  const aliases = splitList(form["aliases"] ?? "", "aliases", false, ALIAS_ITEM);
  if (typeof aliases === "string") return aliases;
  const tags = splitList(form["tags"] ?? "", "tags", false);
  if (typeof tags === "string") return tags;
  const related = splitList(form["related"] ?? "", "related keys", true);
  if (typeof related === "string") return related;
  if (related.includes(str(current["key"]))) return "A page cannot be related to itself.";

  const before = object(current["fields"]);
  let fields: Row = { ...before };
  if (drawer) {
    const next: Row = Object.fromEntries(Object.entries(before).filter(([k]) => !drawer.fields.some((d) => d.name === k)));
    for (const def of drawer.fields) {
      const raw = (form[`f_${def.name}`] ?? "").trim();
      if (raw === "") continue;
      const value = def.kind === "number" ? Number(raw) : raw;
      if (def.kind === "number" && !Number.isFinite(value)) return `"${def.name}" must be a number.`;
      const problem = fieldProblem(drawer, def.name, value);
      if (problem) return `${problem[0]?.toUpperCase() ?? ""}${problem.slice(1)}.`;
      next[def.name] = value;
    }
    fields = next;
  }
  return { status, aliases, tags, related, fields };
}
