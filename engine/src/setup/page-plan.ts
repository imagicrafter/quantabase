import { esc } from "../status/page.js";
import type { ApplyReport, StepReport } from "./apply.js";
import type { SignedInputs } from "./inputs.js";
import { errorList, layout, tokenShortHelp } from "./page.js";
import type { Plan } from "./plan.js";
import { FINISH_STEP } from "./reply.js";

/** The preview (what will be done) and the result (what was done). */

function planList(plan: Plan): string {
  const items = plan.steps
    .map((step) => {
      const lines = step.lines.map((l) => `<li>${esc(l)}</li>`).join("");
      return `<li><span class="step-title">${esc(step.title)}</span><ul>${lines}</ul></li>`;
    })
    .join("");
  const finish = FINISH_STEP.lines.map((l) => `<li>${esc(l)}</li>`).join("");
  return `<ol class="steps">${items}
<li><span class="step-title">${esc(FINISH_STEP.title)}</span><ul>${finish}</ul></li>
</ol>`;
}

export function previewPage(
  plan: Plan,
  signed: SignedInputs,
  errors: readonly string[],
  version: string,
  askCode = true,
): string {
  const codeField = askCode
    ? `<label for="code">Setup code (again)</label>
<input type="password" id="code" name="code" autocomplete="one-time-code" required>`
    : "";
  const body = `${errorList(errors)}
<div class="card">
<h2>This is exactly what will be done</h2>
<p class="hint">Anything that already exists and is already right is left alone.</p>
${planList(plan)}
</div>
<form method="post" action="/setup/apply" class="card" autocomplete="off">
<h2>Step 2 of 2: apply</h2>
<input type="hidden" name="inputs" value="${esc(signed.payload)}">
<input type="hidden" name="sig" value="${esc(signed.signature)}">
${codeField}
<label for="cf_token">Cloudflare API token</label>
<input type="password" id="cf_token" name="cf_token" autocomplete="one-time-code" spellcheck="false" required>
${tokenShortHelp()}
<p class="hint">Used for this one request and then dropped. It is not saved and not written to any log. If your browser offers to save it as a password, say no.</p>
<button type="submit">Apply these changes</button>
<p class="hint">This can take up to a minute. <a href="/setup">Start over instead</a>.</p>
</form>`;
  return layout("Check the changes", body, version);
}

const STATUS_WORDS: Readonly<Record<StepReport["status"], string>> = {
  created: "Created",
  updated: "Updated",
  unchanged: "Already in place",
  failed: "Failed",
  not_run: "Not run",
};

function reportList(steps: readonly StepReport[]): string {
  const items = steps
    .map((step) => {
      const details = step.details?.length
        ? `<details><summary>What Cloudflare answered</summary><ul>${step.details.map((d) => `<li><code>${esc(d)}</code></li>`).join("")}</ul></details>`
        : "";
      const note = step.note ? `<p>${esc(step.note)}</p>${details}` : details;
      return `<li><span class="step-title">${esc(step.title)}</span><span class="badge ${esc(step.status)}">${esc(STATUS_WORDS[step.status])}</span>${note}</li>`;
    })
    .join("");
  return `<ol class="steps">${items}</ol>`;
}

function warningList(warnings: readonly string[]): string {
  if (warnings.length === 0) return "";
  const items = warnings.map((w) => `<li>${esc(w)}</li>`).join("");
  return `<div class="card warnings"><ul>${items}</ul></div>`;
}

/** What the read-back found not in place, each with where to click. */
function checkList(checks: NonNullable<ApplyReport["checks"]>): string {
  const open = checks.filter((check) => check.state !== "ok");
  if (open.length === 0) return "";
  const items = open
    .map((check) =>
      check.state === "missing"
        ? `<li><strong>Not in place: ${esc(check.title)}.</strong> ${esc(check.fix)}</li>`
        : `<li>Could not be checked: ${esc(check.title)}.</li>`,
    )
    .join("");
  return `<div class="card warnings"><h2>Needs a click in Cloudflare</h2><ul>${items}</ul></div>`;
}

/**
 * DigitalOcean's edge drops a request whose Host the app does not list
 * (seen live 2026-11-20: "not found" on the new hostname until the domain was
 * added). Setup cannot add it itself without a DigitalOcean token, which it
 * does not ask for (one more secret, with rights over every app on the
 * account); so it says exactly how.
 */
export function doDomainCard(host: string): string {
  const h = esc(host);
  return `<div class="card warnings">
<h2>Add ${h} to the app in DigitalOcean</h2>
<p>DigitalOcean only answers for hostnames listed on the app. Until ${h} is added there, it answers "not found".</p>
<ol>
<li>In DigitalOcean open your app, then <strong>Settings</strong>, then <strong>Domains</strong>, then <strong>Add domain</strong>.</li>
<li>Type <code>${h}</code>. Choose <strong>You manage your domain</strong> (Cloudflare holds its DNS; setup already pointed it at this app). Do not let DigitalOcean change the DNS.</li>
<li>Save. DigitalOcean redeploys the app; wait until it is live, then open <code>https://${h}/health</code>.</li>
</ol>
<p class="hint">Or on the command line: <code>doctl apps spec get APP_ID &gt; spec.yaml</code>, add <code>domains: [{domain: ${h}, type: PRIMARY}]</code> at the top level, then <code>doctl apps update APP_ID --spec spec.yaml</code>. The Health screen checks that ${h} reaches this app.</p>
</div>`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function successBody(connectorUrl: string): string {
  const host = hostOf(connectorUrl);
  return `${host ? doDomainCard(host) : ""}<div class="card">
<h2>Connect Claude</h2>
<p>Add this address as a custom connector in Claude:</p>
<p class="readonly mono">${esc(connectorUrl)}</p>
<p>Claude will send you to Cloudflare to sign in with a code emailed to you.</p>
</div>
<div class="card">
<h2>Now do these two things</h2>
<ol>
<li><strong>Delete the Cloudflare API token</strong> you made for this (My Profile, then API Tokens). It is no longer needed.</li>
<li>Remove <code>SETUP_CODE</code> from the app's settings. The code has been used and no longer works.</li>
</ol>
<p class="hint">Sign-in can take a minute or two to start working. Until then your hostname may answer "not found (404)". That is expected right after setup: wait two minutes and try again.</p>
<p class="hint">This page now needs sign-in with a second factor, like the status page.</p>
</div>`;
}

const FAILURE_BODY = `<div class="card errors" role="alert">
<p><strong>Setup did not finish.</strong> The steps marked Created, Updated or Already in place are done and stay done. Nothing was undone, and nothing after the failed step was started.</p>
<p>Setup is still open. Fix what the failed step says, then <a href="/setup">run setup again</a> with the same choices: finished steps are not repeated.</p>
</div>`;

export function resultPage(
  report: Pick<ApplyReport, "steps" | "warnings" | "checks">,
  ok: boolean,
  connectorUrl: string,
  version: string,
): string {
  const body = `${ok ? "" : FAILURE_BODY}
${warningList(report.warnings)}
${checkList(report.checks ?? [])}
<div class="card">
<h2>What was done</h2>
${reportList(report.steps)}
</div>
${ok ? successBody(connectorUrl) : ""}`;
  return layout(ok ? "Setup is complete" : "Setup stopped", body, version);
}
