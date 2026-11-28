import { parseRules, type LabelRef, type Rule, type RuleSource } from "../sources/rules.js";
import { card, esc, hidden, postForm, when } from "./html.js";
import { describeRule } from "./sources-edit.js";
import type { Row } from "./store.js";

/**
 * The HTML of the Sources screens (sources-routes.ts). Every value from a
 * person, a source or the database goes through esc(); no script.
 */

export const SOURCE_LABEL: Readonly<Record<string, string>> = { gmail: "Gmail", fireflies: "Fireflies" };

const num = (v: unknown) => Number(v ?? 0);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export function pickerOf(row: Row): readonly LabelRef[] {
  return (Array.isArray(row["labels"]) ? (row["labels"] as Row[]) : []).map((l) => ({ id: String(l["id"]), name: String(l["name"] ?? l["id"]) }));
}

export function accountsCard(accounts: readonly Row[]): string {
  const rows = accounts
    .map(
      (a) => `<tr><td><a href="/app/sources/${esc(a["id"])}">${esc(SOURCE_LABEL[String(a["source"])] ?? a["source"])}: ${esc(a["account"])}</a></td>
<td>${esc(num(a["rules"]))}${num(a["broken"]) > 0 ? ` <span class="badge">${esc(num(a["broken"]))} broken</span>` : ""}</td>
<td>${esc(num(a["items_saved"]))} kept · ${esc(num(a["items_skipped"]))} left out</td>
<td>${num(a["recheck"]) > 0 ? `${esc(num(a["recheck"]))} to re-check` : ""}</td>
<td>${esc(when(a["last_received_at"]))}</td></tr>`,
    )
    .join("");
  const table = accounts.length
    ? `<table><thead><tr><th>Account</th><th>Rules</th><th>Items</th><th></th><th>Last item</th></tr></thead><tbody>${rows}</tbody></table>`
    : "<p>No source accounts yet. Add one below, or run an ingest for it from your Claude: it appears here on the first run.</p>";
  return card(`<h2>Your source accounts</h2>
<p>Nothing from a source is kept unless one of your rules includes it. Each rule files what it includes under one of your topics, or keeps it private (only you).</p>${table}`);
}

/** Claude Code sessions: sent by hand from Claude Code, so no account and no rules here. */
/** The plain-words intro at the top of the Sources screen. */
export function sourcesIntroCard(): string {
  return card(`<h2>How sources work</h2>
<p>Rules decide what your library keeps. Nothing is kept unless an include rule lets it in. An exclude rule keeps things out.</p>
<p>Rules replaced the old source tags: instead of tagging a source, you add a rule that says which mail or meetings to keep and which topic they go under (or private, only you).</p>
<p>For Gmail, the easy way to start is to let Claude suggest the rules: use the prompt for your account below.</p>`);
}

export function sessionsCard(summary: Row | null): string {
  if (!summary) {
    return card('<h2>Claude Code sessions</h2><p>Your Engine\'s database needs an update before it can take Claude Code sessions. An administrator can <a href="/setup/database">update the database</a>.</p>');
  }
  const items = num(summary["items"]);
  const versions = num(summary["versions"]);
  const sent = items > 0
    ? `<p>${esc(items)} ${items === 1 ? "session" : "sessions"} sent (${esc(versions)} ${versions === 1 ? "note" : "notes"} in all). Last one ${esc(when(summary["last_received_at"]))}.</p>`
    : "<p>No sessions sent yet.</p>";
  return card(`<h2>Claude Code sessions</h2>${sent}
<p>Send what a Claude Code session found worth keeping: at the end of it, run <code>/qb-engine:send-session</code> in Claude Code. Your Claude writes a short note (decisions, facts, status, how-tos and ideas, each with exact quotes from the session and the pages it concerns), shows it to you, and sends it only on your yes. Anything that looks like a key or password is cut out first.</p>
<p class="hint">The curator files the note like a mail: it keeps it, reads the pages it names first, writes an idea as an idea, and checks every new sentence against the quotes. Sending the same session again replaces its note with a new version. Notes stay yours (only you) unless an administrator files a project under a topic.</p>`);
}

export function addAccountCard(csrf: string): string {
  return card(`<h2>Add a source account</h2>${postForm("/app/sources/add", csrf, `<label for="source">Source</label><select id="source" name="source"><option value="gmail">Gmail</option><option value="fireflies">Fireflies</option></select>
<label for="account">The account's email address</label><input type="email" id="account" name="account" required maxlength="254">`, "Add")}`);
}

export function recheckPagesCard(pages: readonly Row[], csrf: string): string {
  if (pages.length === 0) return "";
  const items = pages
    .map((p) => `<li><a href="/app/pages/${esc(p["id"])}">${esc(p["title"])}</a> <span class="hint">${esc(strs(p["topics"]).join(", ") || "only you")} · ${esc(when(p["recheck_at"]))}</span>
${postForm(`/app/sources/pages/${esc(p["id"])}/done`, csrf, "", "Checked")}</li>`)
    .join("");
  return card(`<h2>Pages to re-check</h2><p>A rule change took items these pages were built from out of their topic. Check each page still belongs where it is, then mark it checked.</p><ul>${items}</ul>`);
}

function chips(values: readonly unknown[]): string {
  return values
    .map((v) => {
      const o = typeof v === "object" && v !== null ? (v as LabelRef) : null;
      const text = o ? (o.name ?? o.id) : String(v);
      return `<span class="chip${o?.deleted ? " deleted" : ""}">${esc(text)}${o?.deleted ? " (deleted)" : ""}</span>`;
    })
    .join(" ");
}

function ruleRow(r: Rule, i: number, last: number, base: string, csrf: string, version: number, topics: readonly string[]): string {
  const op = (name: string, label: string, extra = "") =>
    postForm(`${base}/rules`, csrf, `${hidden("op", name)}${hidden("index", String(i))}${hidden("version", String(version))}${extra}`, label);
  const target =
    r.kind === "include"
      ? `<form method="post" action="${esc(`${base}/rules`)}">${hidden("csrf", csrf)}${hidden("op", "target")}${hidden("index", String(i))}${hidden("version", String(version))}<label class="hint" for="t${i}">File under</label><select id="t${i}" name="target">${targetOptions(topics, r.private ? "private" : `topic:${r.topic ?? ""}`)}</select><button type="submit">Change</button></form>`
      : "";
  const fields = Object.entries(r.match)
    .map(([f, v]) => `<div><span class="hint">${esc(f.replace("_", " "))}:</span> ${chips(v as readonly unknown[])}</div>`)
    .join("");
  return `<tr><td>${i + 1}</td><td><strong>${esc(r.kind === "include" ? "Include" : "Exclude")}</strong>${r.name ? ` ${esc(r.name)}` : ""}${r.broken ? ' <span class="badge">broken: ingests nothing</span>' : ""}<br><span class="hint">${esc(describeRule(r))}</span>${fields}</td>
<td>${r.kind === "include" ? esc(r.private ? "private (only you)" : (r.topic ?? "")) : "left out"}<br>${target}</td>
<td>${i > 0 ? op("up", "Up") : ""}${i < last ? op("down", "Down") : ""}${op("delete", "Remove")}</td></tr>`;
}

export function targetOptions(topics: readonly string[], selected = ""): string {
  const opts = [`<option value="private"${selected === "private" ? " selected" : ""}>private (only you)</option>`]
    .concat(topics.map((t) => `<option value="topic:${esc(t)}"${selected === `topic:${t}` ? " selected" : ""}>${esc(t)}</option>`));
  return opts.join("");
}

export function rulesCard(row: Row, csrf: string): string {
  const rules = parseRules(row["rules"]);
  const version = num(row["version"]);
  const topics = strs(row["topics"]);
  const base = `/app/sources/${String(row["account_id"])}`;
  const body = rules.length
    ? `<table><thead><tr><th>#</th><th>Rule</th><th>Files under</th><th></th></tr></thead><tbody>${rules.map((r, i) => ruleRow(r, i, rules.length - 1, base, csrf, version, topics)).join("")}</tbody></table>`
    : "<p>No rules yet: nothing from this account is kept. Add one with the builder.</p>";
  return card(`<h2>Rules, in order</h2><p class="hint">Version ${esc(version)}</p>
<p class="hint">Exclude rules are checked first and always win. Then include rules are tried from the top; the first that matches decides the topic. Within a rule every field must match; within a field any value may. Anything no rule includes is left out and not kept.</p>${body}`);
}

export function suggestionsCard(row: Row, csrf: string): string {
  const sugg = Array.isArray(row["suggested_excludes"]) ? (row["suggested_excludes"] as Row[]) : [];
  if (sugg.length === 0) return "";
  const base = `/app/sources/${String(row["account_id"])}`;
  const items = sugg
    .map((s) => {
      const labels = Object.values((s["match"] ?? {}) as Record<string, Row[]>)[0] ?? [];
      const ids = labels.map((l) => hidden("label", String(l["id"]))).join("");
      return `<li>Leave out <strong>${esc(s["name"])}</strong>${postForm(`${base}/rules`, csrf, `${hidden("op", "add")}${hidden("kind", "exclude")}${hidden("name", String(s["name"] ?? ""))}${hidden("version", String(num(row["version"])))}${ids}`, "Add this exclude")}</li>`;
    })
    .join("");
  return card(`<h2>Suggested excludes</h2><p>These look private. Add an exclude so nothing carrying them is ever kept.</p><ul>${items}</ul>`);
}

export function addRuleCard(row: Row, csrf: string): string {
  const source = String(row["source"]) as RuleSource;
  const base = `/app/sources/${String(row["account_id"])}`;
  const picker = pickerOf(row);
  const text = (name: string, label: string) =>
    `<label for="f-${name}">${esc(label)}</label><input type="text" id="f-${name}" name="${name}" maxlength="4000" placeholder="name@company.com, company.com">`;
  const addressBoxes =
    source === "gmail"
      ? text("any_address", "Any address (from, to or cc)") + text("from", "From") + text("to", "To") + text("cc", "Cc")
      : text("participants", "Participants");
  const what = source === "gmail" ? "Labels" : "Channels";
  const boxes = picker.length
    ? picker.map((l) => `<label><input type="checkbox" name="label" value="${esc(l.id)}"> ${esc(l.name ?? l.id)}</label>`).join("")
    : `<p class="hint">No ${what.toLowerCase()} reported yet. They appear after the next ingest run for this account.</p>`;
  return card(`<h2>Add a rule</h2>${postForm(`${base}/rules`, csrf, `${hidden("op", "add")}${hidden("version", String(num(row["version"])))}
<label for="kind">Kind</label><select id="kind" name="kind"><option value="include">Include: keep and file it</option><option value="exclude">Exclude: never keep it</option></select>
<label for="rname">Name (for you)</label><input type="text" id="rname" name="name" maxlength="80">
${addressBoxes}<p class="hint">Addresses or domains, separated by commas. A domain also matches its subdomains.</p>
<fieldset><legend>${what}</legend>${boxes}</fieldset>
<label for="target">File under (include rules)</label><select id="target" name="target">${targetOptions(strs(row["topics"]))}</select>
<p class="hint">You can file only under topics you hold, or private. An administrator makes topics and gives them out.</p>`, "Add the rule")}`);
}

export function toolsCard(row: Row, csrf: string): string {
  const base = `/app/sources/${String(row["account_id"])}`;
  const sample = (row["sample"] ?? {}) as Row;
  const recheck = num(row["recheck"]);
  const recheckPart = recheck > 0
    ? `<h3>Re-check</h3><p>${esc(recheck)} items were taken out of their topic by a rule change and are only yours for now. Re-check files each under the rule in force now, and removes those no rule includes.</p>${postForm(`${base}/recheck`, csrf, "", "Re-check now")}`
    : "";
  return card(`<h2>Preview, history and backfill</h2>
<h3>Dry-run</h3><p>See what the current rules would keep from the last 7 days, using item metadata only (sample of ${esc(num(sample["count"]))} items${sample["reported_at"] ? `, ${esc(when(sample["reported_at"]))}` : ""}).</p>
<p><a href="${esc(`${base}/preview`)}">Run the dry-run</a> · <a href="${esc(`${base}/history`)}">Versions and audit</a></p>
${postForm(`${base}/sample`, csrf, "", sample["requested"] === true ? "A new sample is asked for" : "Ask the next run for a new sample")}
${recheckPart}
<h3>Backfill</h3><p>A widened rule applies to new items only. To pick up older items too, ask the next run to go back to a date.</p>
${postForm(`${base}/backfill`, csrf, '<label for="since">Back to</label><input type="date" id="since" name="since" required>', "Ask for a backfill")}`);
}

export function previewHtml(result: Row, rules: readonly Rule[]): string {
  const rows = (Array.isArray(result["rows"]) ? (result["rows"] as Row[]) : [])
    .map((r) => `<tr><td>${esc(when(r["date"]))}</td><td>${esc(strs(r["from"]).concat(strs(r["participants"])).join(", "))}</td><td>${esc(strs(r["labels"]).concat(strs(r["channels"])).join(", "))}</td><td>${esc(r["decision"] === "include" ? `kept: ${r["private"] === true ? "private" : String(r["topic"] ?? "")}` : r["decision"] === "exclude" ? "excluded" : "left out")}</td><td>${esc(r["rule"] ?? "")}</td></tr>`)
    .join("");
  const n = (k: string) => esc(num(result[k]));
  return `<p>Of ${n("total")} items in the sample: <strong>${n("included")} kept</strong>, ${n("excluded")} excluded, ${esc(num(result["not_included"]) - num(result["excluded"]))} matched no rule.</p>
<p class="hint">${esc(rules.length)} rules. The sample holds metadata only: addresses, label or channel ids and dates, never a subject or text.</p>
${rows ? `<table><thead><tr><th>Date</th><th>From / participants</th><th>Labels / channels</th><th>Result</th><th>Rule</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No sample yet. Ask the next run for one.</p>"}`;
}

export function historyHtml(row: Row): string {
  const versions = (Array.isArray(row["versions"]) ? (row["versions"] as Row[]) : [])
    .map((v) => `<details><summary>Version ${esc(v["version"])} · ${esc(when(v["created_at"]))} · ${esc(v["by"] ?? "migration")}</summary><ol>${parseRules(v["rules"]).map((r) => `<li>${esc(describeRule(r))}</li>`).join("")}</ol></details>`)
    .join("");
  const audit = (Array.isArray(row["audit"]) ? (row["audit"] as Row[]) : [])
    .map((a) => `<tr><td>${esc(when(a["at"]))}</td><td>${esc(a["action"])}</td><td>${esc(a["version"] ?? "")}</td><td>${esc(a["by"] ?? "")}</td><td>${esc(JSON.stringify(a["detail"] ?? {}))}</td></tr>`)
    .join("");
  return card(`<h2>Versions</h2>${versions || "<p>No versions yet.</p>"}`) +
    card(`<h2>Audit</h2>${audit ? `<table><thead><tr><th>When</th><th>What</th><th>Version</th><th>By</th><th>Detail</th></tr></thead><tbody>${audit}</tbody></table>` : "<p>Nothing yet.</p>"}`);
}
