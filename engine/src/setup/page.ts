import { esc } from "../status/page.js";
import { setupMenu, shell } from "../app/shell.js";
import { DEFAULT_SESSION, MAX_DOMAINS, MAX_EMAILS, SESSIONS, SESSION_NAMES, sessionSentence, type FormValues, type SessionLength } from "./inputs.js";
import { TOKEN_PERMISSIONS } from "./permissions.js";
import { tokenLink } from "./token-link.js";

/**
 * The setup page's HTML. Server-rendered, no script at all, one linked
 * stylesheet. Every value that came from a person or from Cloudflare goes
 * through esc(). Neither the setup code nor the Cloudflare token is ever
 * written back into a page.
 */

/**
 * Stricter than the status page's: no script source at all. Forms may post
 * only to this same origin.
 */
export const SETUP_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** `version` is the stylesheet version; left out, the shell reads it itself. */
export function layout(title: string, body: string, version?: string): string {
  return shell("setup", "/setup", title, body, true, version);
}

export function messagePage(
  title: string,
  message: string,
  version: string,
  backLink = false,
): string {
  const back = backLink
    ? `<p><a href="/setup">Back to the setup page</a></p>`
    : "";
  return layout(
    title,
    `<div class="card"><p>${esc(message)}</p>${back}</div>`,
    version,
  );
}

export function errorList(errors: readonly string[]): string {
  if (errors.length === 0) return "";
  const items = errors.map((e) => `<li>${esc(e)}</li>`).join("");
  return `<div class="card errors" role="alert"><ul>${items}</ul></div>`;
}

/** What the link cannot set: narrowing the two cards and the expiry. */
function narrowingSteps(): string {
  return `<li>The link cannot set these, so set them on that screen:
<ul>
<li><strong>Account policy</strong> card: click the pencil and narrow it to your one account.</li>
<li><strong>Zone policy</strong> card: click the pencil, pick <strong>Specific zone</strong>, and pick the domain your hostname is on.</li>
<li><strong>Expiration:</strong> pick <strong>Custom</strong> (or 7 days), so the token stops working by itself.</li>
</ul></li>`;
}

/** The short version, next to the token box on the apply step. */
export function tokenShortHelp(): string {
  const perms = TOKEN_PERMISSIONS.map(
    (p) =>
      `<li>${esc(p.scope)} policy: ${esc(p.name)} - <strong>${esc(p.level)}</strong></li>`,
  ).join("");
  return `<div class="hint">
<p><a href="${esc(tokenLink())}" target="_blank" rel="noopener noreferrer">Open Cloudflare's token screen</a> with the permissions filled in. Check its Policies cards list:</p>
<ul>${perms}</ul>
<ol>${narrowingSteps()}<li>Create the token, copy it, and paste it here.</li></ol>
</div>`;
}

/** How to make the one-time Cloudflare token. Shown above the form. */
export function tokenInstructions(): string {
  const rows = TOKEN_PERMISSIONS.map(
    (p) =>
      `<tr><td>${esc(p.scope)}</td><td>${esc(p.name)}</td><td>${esc(p.level)}</td><td class="hint">${esc(p.why)}</td></tr>`,
  ).join("");
  return `<div class="card">
<h2>Before you start: make a Cloudflare API token</h2>
<p>This page sets up Cloudflare sign-in for you. To do that it needs a Cloudflare API token, <strong>once</strong>. You paste it in at the last step. It is used for that one request and is not saved anywhere.</p>
<ol>
<li><a href="${esc(tokenLink())}" target="_blank" rel="noopener noreferrer">Open Cloudflare's token screen with the permissions filled in</a>. Sign in to Cloudflare if it asks.</li>
<li>Check that the <strong>Policies</strong> cards list exactly these ${TOKEN_PERMISSIONS.length} permissions (the screen says <strong>Write</strong>; older screens say Edit):
<table>
<thead><tr><th>Card</th><th>Permission</th><th>Level</th><th>Why</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<span class="hint">If one is missing, or the link opens an empty screen, add it by hand on the matching card (Account policy or Zone policy). Without <strong>Zone - Read</strong> Cloudflare will not tell setup which zone your hostname is on.</span></li>
${narrowingSteps()}
<li>Create the token and copy it. When setup is done, delete it in Cloudflare.</li>
</ol>
<p class="hint">Your domain must already be on this Cloudflare account, and Zero Trust must have been opened once (so the account has a team name).</p>
</div>`;
}

export type FormView = {
  readonly values: FormValues;
  readonly errors: readonly string[];
  /** The applied config names the owner; the form does not ask. */
  readonly ownerFromConfig: boolean;
  /** The app's own address, when the page knows it (setup mode). */
  readonly fixedOrigin: string | null;
  /** Setup mode, but the address this page was reached on is not usable. */
  readonly originUnusable: boolean;
  /** True when setup was reopened on an Engine that is already set up. */
  readonly reopened: boolean;
  /** The Engine was claimed with its first-run code: the claim stands in for the code. */
  readonly claimed?: boolean;
  /** The owner's address, shown only to a claimed session. */
  readonly knownOwner?: string | null;
};

function ownerField(view: FormView): string {
  if (view.ownerFromConfig && view.knownOwner) {
    // Only for a claimed Engine: the claim stands in for the setup code.
    return `<p class="label">Owner</p>
<p class="readonly">${esc(view.knownOwner)}</p>
<p class="hint">The owner you named on the Database screen. The owner can always sign in.</p>`;
  }
  if (view.ownerFromConfig) {
    // Not the address itself: this page opens without the setup code.
    return `<p class="label">Owner</p>
<p class="readonly">The owner named in your Engine config.</p>
<p class="hint">The owner can always sign in. The next page shows the address.</p>`;
  }
  return `<label for="owner_email">Owner email</label>
<input type="email" id="owner_email" name="owner_email" value="${esc(view.values.ownerEmail)}" autocomplete="off" required>
<p class="hint">The owner can always sign in, and is the only one who can open the status page.</p>`;
}

function levelChoice(
  value: string,
  current: string,
  label: string,
  hint: string,
): string {
  const checked = value === current ? " checked" : "";
  return `<label class="choice"><input type="radio" name="level" value="${esc(value)}"${checked} required><span><strong>${esc(label)}</strong><br><span class="hint">${esc(hint)}</span></span></label>`;
}

function levelFields(v: FormValues): string {
  return `<fieldset>
<legend>Who may sign in</legend>
${levelChoice("owner", v.level, "Owner only", "Just the owner.")}
${levelChoice("people", v.level, "Named people", "The owner and the people you list below.")}
${levelChoice("domain", v.level, "Company domain", "Anyone with an email address at the domains you list below.")}
</fieldset>
<label for="emails">People (for Named people)</label>
<textarea id="emails" name="emails" autocomplete="off" spellcheck="false">${esc(v.emails)}</textarea>
<p class="hint">One email address per line. At most ${MAX_EMAILS}.</p>
<label for="domains">Email domains (for Company domain)</label>
<textarea id="domains" name="domains" autocomplete="off" spellcheck="false">${esc(v.domains)}</textarea>
<p class="hint">One per line, like example.com. At most ${MAX_DOMAINS}. Signing in is not the same as seeing knowledge: what each person sees is still decided by their topic grants.</p>`;
}

/** How long a sign-in lasts (inputs.ts SESSIONS); the admin pages stay 12 hours. */
function sessionField(v: FormValues): string {
  const chosen = v.session && SESSIONS.includes(v.session as SessionLength) ? v.session : DEFAULT_SESSION;
  const options = SESSIONS.map(
    (s) => `<option value="${esc(s)}"${s === chosen ? " selected" : ""}>${esc(SESSION_NAMES[s])}</option>`,
  ).join("");
  return `<label for="session">How long a sign-in lasts</label>
<select id="session" name="session">${options}</select>
<p class="hint">For people and for Claude's connector. 1 year means Claude stays connected. The status and setup pages always ask again every 12 hours, with a second factor.</p>`;
}

function originField(view: FormView): string {
  if (view.fixedOrigin) {
    return `<p class="label">This app's own address</p>
<p class="readonly mono">${esc(view.fixedOrigin)}</p>
<p class="hint">The address you opened this page on. The hostname above will point here.</p>`;
  }
  if (view.originUnusable) {
    return `<p class="label">This app's own address</p>
<p class="readonly">This page was not opened on a usable address. Open it on the address your hosting gave the app.</p>`;
  }
  return `<label for="origin">This app's own address</label>
<input type="text" id="origin" name="origin" value="${esc(view.values.origin)}" autocomplete="off" spellcheck="false" required>
<p class="hint">The address your hosting gave the app, without https://. The hostname above will point here.</p>`;
}

export function formPage(view: FormView, version: string): string {
  const v = view.values;
  const reopened = view.reopened
    ? `<div class="card"><p>Setup has been reopened. The current sign-in settings stay in force until you finish.</p></div>`
    : "";
  const body = `${reopened}
${tokenInstructions()}
${errorList(view.errors)}
<form method="post" action="/setup/preview" class="card" autocomplete="off">
<h2>Step 1 of 2: your choices</h2>
${view.claimed ? "" : `<label for="code">Setup code</label>
<input type="password" id="code" name="code" autocomplete="one-time-code" required>
<p class="hint">The one-time code you were shown when the app was deployed.</p>`}
<label for="host">Hostname for your Engine</label>
<input type="text" id="host" name="host" value="${esc(v.host)}" placeholder="engine.example.com" autocomplete="off" spellcheck="false" required>
<p class="hint">Where people and Claude will reach it. It must be on a domain in your Cloudflare account.</p>
${originField(view)}
${ownerField(view)}
${levelFields(v)}
${sessionField(v)}
<label class="choice"><input type="checkbox" name="replace" value="yes"${v.replace ? " checked" : ""}><span><strong>Replace what is already there</strong><br><span class="hint">Leave this off for a new hostname. Tick it only if the hostname already has a DNS record or a Cloudflare application that you want this setup to take over.</span></span></label>
<button type="submit">Preview the changes</button>
<p class="hint">Nothing is changed yet. The next page shows exactly what will be done.</p>
</form>`;
  return layout("Set up sign-in", body, version);
}

export type InfoView = {
  readonly host: string;
  readonly level: string | null;
  /** The sign-in length stored by setup (also the connector's), if recorded. */
  readonly session?: string | null;
  readonly source: "environment" | "database";
  /** Why no form is shown. */
  readonly reason: "environment" | "complete" | "no_code";
  readonly email: string;
};

const LEVEL_NAMES: Readonly<Record<string, string>> = {
  owner: "Owner only",
  people: "Named people",
  domain: "Company domain",
};

function rerunHelp(view: InfoView): string {
  if (view.reason === "environment") {
    return `<p>This Engine takes its sign-in settings from the app's environment variables, so this page is not used. Change them where the app is deployed.</p>`;
  }
  const noCode =
    view.reason === "no_code"
      ? `<p><strong>Setup has been reopened, but the app has no setup code.</strong> Set <code>SETUP_CODE</code> on the app to the new code and redeploy.</p>`
      : "";
  return `${noCode}<p>To change who may sign in, or the hostname, run setup again:</p>
<ol>
<li>On the machine that holds the Engine's tooling, run <code>kbe access reopen</code>. It opens setup and shows a new one-time code. Set that code as <code>SETUP_CODE</code> on the app.</li>
<li>Make a fresh Cloudflare API token (the old one was never saved).</li>
<li>Open this page again. It will show the form.</li>
</ol>
<p class="hint">For a small change, such as adding one person, you can also edit the sign-in rule in the Cloudflare dashboard by hand.</p>`;
}

export function infoPage(view: InfoView, version: string): string {
  const level = view.level
    ? (LEVEL_NAMES[view.level] ?? view.level)
    : "Not recorded";
  const body = `<div class="card">
<table>
<tbody>
<tr><th>Hostname</th><td class="mono">${esc(view.host)}</td></tr>
<tr><th>Who may sign in</th><td>${esc(level)}</td></tr>
<tr><th>Connector address</th><td class="mono">https://${esc(view.host)}/mcp</td></tr>
<tr><th>How long it lasts</th><td>${esc(sessionSentence(view.session))}</td></tr>
</tbody>
</table>
</div>
<div class="card">
<h2>Changing this</h2>
${rerunHelp(view)}
</div>
${setupMenu()}
<p class="hint">Signed in as ${esc(view.email)}.</p>`;
  return layout("Sign-in is set up", body, version);
}
