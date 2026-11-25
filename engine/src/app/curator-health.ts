import { card, esc, notice, when } from "./html.js";
import type { Row } from "./store.js";

/**
 * The "Is the timer firing?" card on the Timer and Indexing screens, from
 * app_curator_health (0064): both cron jobs and their last run, failed pokes
 * in the last 24 hours (pg_net's response table), when the service last
 * received a poke, and the run that holds the curator's lease.
 *
 * null (an older database without 0064, or a read error) renders a hint
 * instead of the table.
 */

const JOB_LABEL: Readonly<Record<string, string>> = {
  "kbe-curator-tick": "Hourly safety tick",
  "kbe-curator-wake": "Wake check (every minute)",
};

const object = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});

function jobRow(job: Row): string {
  const name = String(job["name"] ?? "");
  const label = JOB_LABEL[name] ?? name;
  const state = job["active"] === false ? "paused" : "scheduled";
  const last = job["last_start"]
    ? `last ran ${esc(when(job["last_start"]))} (${esc(job["last_status"] ?? "unknown")})${job["last_message"] && job["last_status"] !== "succeeded" ? `: ${esc(job["last_message"])}` : ""}`
    : "has not run yet";
  return `<tr><td>${esc(label)}</td><td>${esc(job["schedule"] ?? "")} · ${state} · ${last}</td></tr>`;
}

function jobRows(h: Row): string {
  if (h["cron_available"] !== true) return `<tr><td>Cron jobs</td><td><strong>pg_cron is not available</strong></td></tr>`;
  const jobs = Array.isArray(h["jobs"]) ? (h["jobs"] as Row[]) : [];
  const names = new Set(jobs.map((j) => String(j["name"])));
  const missing = Object.keys(JOB_LABEL)
    .filter((n) => !names.has(n))
    .map((n) => `<tr><td>${esc(JOB_LABEL[n])}</td><td><strong>missing</strong>: save the timer with the curator on to create it</td></tr>`);
  return [...jobs.map(jobRow), ...missing].join("\n");
}

function pokeRow(h: Row): string {
  const p = h["pokes_24h"];
  if (!p || typeof p !== "object") return `<tr><td>Pokes (24 h)</td><td>pg_net is not available</td></tr>`;
  const pokes = object(p);
  const failed = Number(pokes["failed"] ?? 0);
  const total = Number(pokes["total"] ?? 0);
  const detail = failed > 0
    ? `<strong>${failed} of ${total} failed</strong>, last ${esc(when(pokes["last_failure_at"]))}: ${esc(pokes["last_error"] ?? "")}`
    : `${total} sent, none failed`;
  return `<tr><td>Pokes (24 h)</td><td>${detail}</td></tr>`;
}

/**
 * Why the timer is broken, or null when it is not: the most recent run of
 * either cron job failed (for example a command naming a function that does
 * not exist). One line, taken from that run's error message.
 */
export function timerBrokenReason(h: Row | null): string | null {
  if (!h || h["cron_available"] !== true || !Array.isArray(h["jobs"])) return null;
  const failed = (h["jobs"] as Row[]).find((j) => j["last_start"] && j["last_status"] === "failed");
  if (!failed) return null;
  const label = JOB_LABEL[String(failed["name"] ?? "")] ?? String(failed["name"] ?? "a cron job");
  const message = (String(failed["last_message"] ?? "").split("\n")[0] ?? "").trim();
  return `${label} failed${message ? `: ${message}` : ""}`;
}

/** The red one-line banner on Timer, Indexing and Health when the timer is broken. */
export function timerBrokenBanner(h: Row | null): string {
  const reason = timerBrokenReason(h);
  return reason ? notice("error", `Timer is broken: ${reason}`) : "";
}

export function curatorHealthCard(h: Row | null): string {
  if (!h) {
    return card(`<h2>Is the timer firing?</h2><p class="hint">Not available: the database needs its latest update (Engine &gt; Database).</p>`);
  }
  const running = object(h["running"]);
  const tick = h["last_tick_at"]
    ? `${esc(when(h["last_tick_at"]))} (${esc(h["last_tick_outcome"] ?? "")})`
    : "<strong>none received yet</strong>";
  const lease = running["started_at"]
    ? `started ${esc(when(running["started_at"]))}${running["lease_until"] ? `, lease until ${esc(when(running["lease_until"]))}` : ", no lease (an older service)"}`
    : "none";
  const broken = timerBrokenReason(h) !== null;
  return card(`<h2>Is the timer firing?${broken ? " No: the last run failed" : ""}</h2><table><tbody>
${jobRows(h)}
${pokeRow(h)}
<tr><td>Last poke received by the service</td><td>${tick}</td></tr>
<tr><td>Run in progress</td><td>${lease}</td></tr>
</tbody></table>`, broken ? "errors" : "");
}
