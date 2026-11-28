import { ageDays, hasChoices, parseSuggestions, ruleCovering, startsTicked, STRONG_SENT, type Suggestion } from "../sources/mail-contacts.js";
import { parseRules, type Rule } from "../sources/rules.js";
import { card, esc, hidden, postForm, when } from "./html.js";
import { pickValue } from "./sources-suggest.js";
import { targetOptions } from "./sources-view.js";
import type { Row } from "./store.js";

/**
 * The "Suggested from your mail" card on a Gmail account's rule screen
 * (0080), and the prompt that starts the walkthrough in Claude. Every value goes through esc(). The copy button needs the
 * same-origin /app/assets/copy.js; without it the command is still shown.
 */

/** Older than this, the card says how old the suggestions are. */
export const STALE_DAYS = 30;
const SHOW_DOMAINS = 30;
const SHOW_PEOPLE = 50;

const num = (v: unknown) => Number(v ?? 0);

/** The prompt the person pastes into Claude to start the suggest-rules walkthrough for one Gmail account. */
export const suggestPrompt = (account: string) =>
  `/qb-engine:suggest-rules ${account}: suggest my Gmail rules from my mail headers and ask me which to keep.`;

/** The prompt with a Copy button (the button needs /app/assets/copy.js; the text can be selected without it). */
export function promptLine(account: string): string {
  const prompt = suggestPrompt(account);
  return `<p><code>${esc(prompt)}</code> <button type="button" class="copy" data-copy="${esc(prompt)}">Copy</button></p>`;
}

function countsText(s: Suggestion): string {
  const parts = [`sent ${s.sent_to}`, `received ${s.received_from}`, `${s.threads} threads`];
  if (s.replied > 0) parts.push(`you replied in ${s.replied}`);
  if (s.kind === "domain") parts.push(`${s.people} ${s.people === 1 ? "person" : "people"}`);
  if (s.free_mail) parts.push("free mail: person only, not the whole domain");
  if (s.last_seen) parts.push(`last ${when(s.last_seen).slice(0, 10)}`);
  return parts.join(" · ");
}

function choice(s: Suggestion, rules: readonly Rule[], ticked: (s: Suggestion) => boolean): string {
  const rule = ruleCovering(rules, s);
  const counts = `<span class="hint">${esc(countsText(s))}</span>`;
  if (rule) {
    return `<li>${esc(s.value)} <span class="badge">has a rule: ${esc(rule.name || "unnamed")}</span> ${counts}</li>`;
  }
  const checked = ticked(s) ? " checked" : "";
  return `<li><label><input type="checkbox" name="pick" value="${esc(pickValue(s))}"${checked}> ${esc(s.value)}</label> ${counts}</li>`;
}

function group(title: string, list: readonly Suggestion[], limit: number, rules: readonly Rule[], ticked: (s: Suggestion) => boolean): string {
  if (list.length === 0) return "";
  const more = list.length > limit ? `<p class="hint">and ${esc(list.length - limit)} more with fewer messages.</p>` : "";
  return `<fieldset><legend>${esc(title)}</legend><ul>${list.slice(0, limit).map((s) => choice(s, rules, ticked)).join("")}</ul>${more}</fieldset>`;
}

function ageNote(reportedAt: unknown, now: Date): string {
  const age = ageDays(reportedAt, now);
  return age !== null && age > STALE_DAYS
    ? `<p class="hint" role="status">These suggestions are ${esc(age)} days old. Run the command below again for fresh ones.</p>`
    : "";
}

function emptyCard(account: string): string {
  return card(`<h2>Suggested from your mail</h2>
<p>Let your Claude find who matters in your mail, so you do not have to dig through Gmail. Paste this into Claude, with this Gmail account connected:</p>
${promptLine(account)}
<p class="hint">Your Claude reads only who wrote to whom and when (from, to, cc, date, labels) for the last 90 days, counts it on your side, asks you a few questions about who to keep, and sends the Engine counts and your picks only: never a subject, text or message. Your picks then show here ticked; you save the rules here.</p>`);
}

/**
 * The card, or "" for an account that is not Gmail. `contacts` is null when
 * the database is older than 0080.
 */
export function mailSuggestionsCard(row: Row, contacts: Row | null, csrf: string, now: Date): string {
  if (String(row["source"]) !== "gmail") return "";
  const account = String(row["account"] ?? "");
  if (contacts === null) {
    return card('<h2>Suggested from your mail</h2><p>Your Engine\'s database needs an update before it can suggest rules from your mail. An administrator can <a href="/setup/database">update the database</a>.</p>');
  }
  const list = parseSuggestions(contacts["contacts"]);
  if (contacts["reported_at"] == null || list.length === 0) return emptyCard(account);
  const rules = parseRules(row["rules"]);
  const ticked = startsTicked(list);
  const base = `/app/sources/${String(row["account_id"])}`;
  const boxes =
    group("Domains", list.filter((s) => s.kind === "domain"), SHOW_DOMAINS, rules, ticked) +
    group("People", list.filter((s) => s.kind === "address"), SHOW_PEOPLE, rules, ticked);
  const form = postForm(`${base}/suggested`, csrf, `${hidden("version", String(num(row["version"])))}${boxes}
<label for="s-target">File the ticked ones under</label><select id="s-target" name="target">${targetOptions(Array.isArray(row["topics"]) ? row["topics"].map(String) : [])}</select>
<p class="hint">Each ticked domain becomes its own rule; the ticked people go into one rule, "People from your mail". Filing under a topic shows a dry-run first and asks for your yes.</p>`, "Add the ticked ones as rules");
  return card(`<h2>Suggested from your mail</h2>
<p class="hint">From ${esc(num(contacts["messages"]))} messages over the last ${esc(num(contacts["days"]))} days, counted by your own Claude ${esc(when(contacts["reported_at"]))}. ${hasChoices(list) ? "Ticked: what you picked in Claude." : `Ticked: you sent them mail ${STRONG_SENT} or more times.`} Nothing is added until you press the button.</p>
${ageNote(contacts["reported_at"], now)}${form}
<p class="hint">To refresh the suggestions, paste this into Claude:</p>${promptLine(account)}`);
}

/** The Sources home: one paste-into-Claude prompt per Gmail account, or "" with none. */
export function gmailPromptsCard(accounts: readonly Row[]): string {
  const gmail = accounts.filter((a) => String(a["source"]) === "gmail").map((a) => String(a["account"] ?? "")).filter((a) => a !== "");
  if (gmail.length === 0) return "";
  const items = gmail.map((account) => `<li>${esc(account)}${promptLine(account)}</li>`).join("");
  return card(`<h2>Set up Gmail rules with Claude</h2>
<p>Copy the prompt for an account and paste it into Claude. Claude looks only at who you mail and when (never the subject or text), asks you a few questions about who to keep, and sends your picks here. Then open the account below: your picks are ticked, and you save the rules there.</p>
<ul>${items}</ul>`);
}
