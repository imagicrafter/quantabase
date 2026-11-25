import type { Context } from "hono";
import { esc } from "../status/page.js";
import { drawerIcon, icon } from "./icons.js";
import { guardEmails } from "./email-guard.js";
import { engineNavHtml } from "./shell.js";
import type { Row } from "./store.js";

/**
 * The per-request parts of the menu: who is signed in (bottom left), the
 * Knowledge tree (drawers with counts, Recent, Pinned) and the admin-only
 * items. The shell leaves a marker for each; sendPage fills them from what
 * the route's guard recorded for this request. No marker is ever filled with
 * unescaped text.
 *
 * The tree shows drawers only, never every page, so it stays small with
 * thousands of pages. Expanding and collapsing is <details>/<summary>: no
 * script.
 */

export const MARK_USER = "<!--kbe:user-->";
export const MARK_TREE = "<!--kbe:tree-->";
export const MARK_TREE_END = "<!--/kbe:tree-->";
export const MARK_ADMIN = "<!--kbe:admin-->";

export type TreeDrawer = { readonly id: string; readonly label: string; readonly count: number };
export type TreeLink = { readonly id: string; readonly title: string; readonly drawer: string };
export type Tree = {
  readonly drawers: readonly TreeDrawer[];
  readonly recent: readonly TreeLink[];
  readonly pinned: readonly TreeLink[];
};

export type Chrome = {
  readonly email: string;
  /** owner, administrator, reviewer or reader */
  readonly role: string;
  readonly isAdmin: boolean;
  readonly tree?: Tree;
  /** The drawer or page being shown, to mark it in the tree. */
  readonly here?: string;
};

const chromes = new WeakMap<Request, Chrome>();

export function setChrome(c: Context, chrome: Chrome): void {
  chromes.set(c.req.raw, chrome);
}

export function getChrome(c: Context): Chrome | undefined {
  return chromes.get(c.req.raw);
}

export function markHere(c: Context, here: string): void {
  const now = getChrome(c);
  if (now) chromes.set(c.req.raw, { ...now, here });
}

/** owner / administrator / reviewer / reader from app_whoami's row. */
export function roleLabel(who: Row | null | undefined, fallback = "reader"): string {
  if (who?.["is_owner"] === true) return "owner";
  const role = String(who?.["role"] ?? fallback);
  return ["administrator", "reviewer", "reader"].includes(role) ? role : fallback;
}

export function userHtml(ch: Chrome): string {
  return `<div class="sidebar-user">${icon("user", 18)}<span class="user-text"><span class="user-email">${esc(ch.email)}</span><span class="badge role-${esc(ch.role)}">${esc(ch.role)}</span></span></div>`;
}

function linkList(title: string, links: readonly TreeLink[], here: string | undefined): string {
  if (links.length === 0) return "";
  const items = links
    .map((l) => {
      const href = `/app/pages/${l.id}`;
      const cur = here === href;
      return `<li><a class="tree-link${cur ? " active" : ""}" href="${esc(href)}"${cur ? ' aria-current="page"' : ""}>${icon(drawerIcon(l.drawer), 14)}<span>${esc(l.title)}</span></a></li>`;
    })
    .join("");
  return `<details class="tree-sub" open><summary>${esc(title)}</summary><ul class="tree">${items}</ul></details>`;
}

export function treeHtml(tree: Tree, here: string | undefined): string {
  const drawers = tree.drawers
    .map((d) => {
      const href = `/app/knowledge/${d.id}`;
      const cur = here !== undefined && (here === href || here.startsWith(`${href}?`));
      return `<li><a class="tree-link${cur ? " active" : ""}" href="${esc(href)}"${cur ? ' aria-current="page"' : ""}>${icon(drawerIcon(d.id), 16)}<span>${esc(d.label)}</span><span class="count">${esc(d.count)}</span></a></li>`;
    })
    .join("");
  return `<details class="tree-root" open><summary>${icon("folder", 18)}<span>Reading room</span></summary><ul class="tree">${drawers}</ul>${linkList("Pinned", tree.pinned, here)}${linkList("Recent", tree.recent, here)}</details>`;
}

export function adminNavHtml(here: string | undefined): string {
  return engineNavHtml(here ?? "");
}

/** Fill the shell's markers for this request (empty when nothing is known). */
export function fillChrome(html: string, ch: Chrome | undefined, here?: string): string {
  const at = here ?? ch?.here;
  return guardEmails(html
    .replace(MARK_USER, () => (ch ? userHtml(ch) : ""))
    .replace(/<!--kbe:tree-->([\s\S]*?)<!--\/kbe:tree-->/, (_m, link: string) => (ch?.tree ? treeHtml(ch.tree, at) : link))
    .replace(MARK_ADMIN, () => (ch?.isAdmin ? adminNavHtml(at) : "")));
}

const asLinks = (v: unknown): TreeLink[] =>
  (Array.isArray(v) ? v : [])
    .filter((r): r is Row => r !== null && typeof r === "object")
    .map((r) => ({ id: String(r["id"] ?? ""), title: String(r["title"] ?? ""), drawer: String(r["drawer"] ?? "") }))
    .filter((l) => /^[0-9a-f-]{36}$/.test(l.id));

/** The tree from app_knowledge_tree's row and the chosen drawers. */
export function buildTree(row: Row, drawers: readonly { id: string; label: string }[]): Tree {
  const counts = row["counts"] && typeof row["counts"] === "object" ? (row["counts"] as Record<string, unknown>) : {};
  const chosen = drawers.map((d) => ({ id: d.id, label: d.label, count: Number(counts[d.id] ?? 0) }));
  const extra = Object.entries(counts)
    .filter(([id]) => /^[a-z][a-z0-9-]{0,62}$/.test(id) && !drawers.some((d) => d.id === id))
    .map(([id, n]) => ({ id, label: id, count: Number(n) }));
  return { drawers: [...chosen, ...extra], recent: asLinks(row["recent"]), pinned: asLinks(row["pinned"]) };
}
