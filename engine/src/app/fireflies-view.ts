import { HOOK_PATH } from "../fireflies/route.js";
import { card, esc, hidden, postForm, when } from "./html.js";
import type { Row } from "./store.js";

/**
 * The HTML of the Fireflies webhook cards on the Sources screens
 * (fireflies-routes.ts). Every value goes through esc(). The copy buttons use
 * the same-origin copy script (COPY_SCRIPT); no inline script.
 */

const num = (v: unknown) => Number(v ?? 0);

/** Plain words for a delivery's reason code (fireflies_deliveries.reason). */
const REASONS: Readonly<Record<string, string>> = {
  rate_limited: "Fireflies said too many calls for now",
  key_refused: "Fireflies no longer accepts the key (replace it below)",
  no_key: "no key is stored (replace it below)",
  unreachable: "Fireflies did not answer",
  fireflies_error: "Fireflies answered with an error",
  bad_response: "Fireflies sent something the Engine could not read",
  too_large: "the meeting is too large to store",
  store_refused: "the Engine refused the meeting",
  store_failed: "the Engine could not store the meeting",
  failed: "the fetch failed",
};

export const reasonWords = (code: unknown): string => REASONS[String(code ?? "")] ?? "the fetch did not finish";

export function hookUrl(host: string, hookId: string): string {
  return `https://${host}${HOOK_PATH}/${hookId}`;
}

const copyRow = (label: string, value: string) =>
  `<p>${esc(label)}: <code>${esc(value)}</code> <button type="button" class="copy" data-copy="${esc(value)}">Copy</button></p>`;

function keyForm(csrf: string, label: string, button: string): string {
  return postForm("/app/sources/fireflies/connect", csrf, `<label for="api_key">${esc(label)}</label>
<input type="password" id="api_key" name="api_key" autocomplete="off" spellcheck="false" required maxlength="4096">`, button);
}

/** On the Sources home: connect a Fireflies account by its API key. */
export function connectCard(csrf: string): string {
  return card(`<h2>Connect Fireflies</h2>
<p>Your meetings come in by themselves as soon as Fireflies finishes them: no scheduled task, nothing cut.</p>
<ol>
<li>In Fireflies, open <strong>Integrations</strong>, then <strong>Fireflies API</strong>, and copy your API key.</li>
<li>Paste it below and press <strong>Connect</strong>. The Engine checks it with Fireflies straight away.</li>
<li>Then you get a webhook address and a signing secret to paste back into Fireflies.</li>
</ol>
${keyForm(csrf, "Your Fireflies API key", "Connect")}
<p class="hint">The key is kept in Supabase Vault. Only its last 4 characters are ever shown.</p>`);
}

function statusLine(state: Row): string {
  if (state["first_delivery_at"]) {
    return `<p><strong>Webhook working.</strong> Last delivery ${esc(when(state["last_delivery_at"]))}. ${esc(num(state["done"]))} meetings fetched so far.</p>`;
  }
  return "<p><strong>Waiting for the first delivery.</strong> Do the steps below, then press <strong>Send test</strong> in Fireflies and refresh this page.</p>";
}

function missedHtml(state: Row, csrf: string, base: string, running: boolean): string {
  if (running) return "<p><strong>Fetching meetings now.</strong> Refresh this page in a minute.</p>";
  const missed = num(state["missed"]);
  if (missed === 0) return "";
  return `<div class="card errors" role="alert"><p><strong>${esc(missed)} ${missed === 1 ? "meeting" : "meetings"} missed</strong>: ${esc(reasonWords(state["last_reason"]))}.</p>
${postForm(`${base}/fireflies/retry`, csrf, "", "Fetch again")}</div>`;
}

function backfillHtml(csrf: string, base: string): string {
  const one = (days: number) => postForm(`${base}/fireflies/backfill`, csrf, hidden("days", String(days)), `Bring in the last ${days} days`);
  return `<h3>Older meetings</h3>
<p>Once, only when you press it: the Engine lists your Fireflies meetings from that far back and fetches each one it does not have yet. Your rules still decide what is kept.</p>
${one(30)}${one(90)}
<p class="hint">Fireflies limits how many calls a key may make. Anything it refuses shows here as missed, to fetch again later.</p>`;
}

/** On a Fireflies account's page: the webhook, its status, missed meetings and the one-time backfill. */
export function webhookCard(state: Row, csrf: string, host: string, base: string, running: boolean): string {
  if (state["connected"] !== true) {
    return card(`<h2>Fireflies webhook</h2><p>Not connected. Meetings reach this account only through a scheduled ingest in your Claude.</p>
${keyForm(csrf, "Connect by webhook: your Fireflies API key", "Connect")}
<p class="hint">In Fireflies: <strong>Integrations</strong>, then <strong>Fireflies API</strong>. The key is kept in Supabase Vault; only its last 4 characters are shown.</p>`);
  }
  const url = hookUrl(host, String(state["hook_id"] ?? ""));
  const secret = String(state["secret"] ?? "");
  return card(`<h2>Fireflies webhook</h2>
<p>Connected as <strong>${esc(state["fireflies_email"])}</strong>, key ending <code>${esc(state["key_last4"])}</code>.</p>
${statusLine(state)}
${missedHtml(state, csrf, base, running)}
${copyRow("Webhook address", url)}
${secret ? copyRow("Signing secret", secret) : "<p>The signing secret could not be read. Disconnect and connect again.</p>"}
<h3>In Fireflies</h3>
<ol>
<li>Open <strong>Integrations</strong>, then <strong>API</strong>, then <strong>Webhooks (V2)</strong>.</li>
<li>Paste the <strong>webhook address</strong> above into the address box.</li>
<li>Paste the <strong>signing secret</strong> above into the <strong>Signing Secret</strong> box.</li>
<li>Choose the event <strong>meeting.summarized</strong>. If it is not offered, choose <strong>meeting.transcribed</strong>.</li>
<li>Save, then press <strong>Send test</strong>. This page says <strong>Webhook working</strong> once the test arrives.</li>
</ol>
<p class="hint">Your rules on this page still decide what is kept: with no rule, nothing is. Turn off the scheduled Fireflies ingest in your Claude if you had one; it now skips this account on its own.</p>
${backfillHtml(csrf, base)}
<h3>Key</h3>
${keyForm(csrf, "Replace the key", "Save the new key")}
${postForm(`${base}/fireflies/disconnect`, csrf, "", "Disconnect the webhook")}
<p class="hint">Disconnecting removes the key and the secret from the Engine. Meetings already kept stay. Delete the webhook in Fireflies too.</p>`);
}
