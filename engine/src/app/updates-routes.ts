import { Hono } from "hono";
import { adminMigrationState, updateBanner } from "./db-update.js";
import { card, esc } from "./html.js";
import type { ReleaseCheck } from "./release-check.js";
import { admin, page, type Handler } from "./settings-routes.js";

/**
 * /setup/updates, administrators only: the running version, the newest
 * release on the public repository's `stable` branch (release-check.ts), what
 * is new since, and how to update: Force Rebuild and Deploy in DigitalOcean,
 * then the Database screen. A one-click update (app and database together) is
 * a future requirement; today it is these two steps.
 *
 * Release notes come from the internet: they are shown as escaped plain text
 * and never as HTML or links.
 */

export type UpdatesDeps = {
  /** This app's version (VERSION, via engine/package.json). */
  readonly running: string;
  /** DigitalOcean's id for this app, when the platform passed it in. */
  readonly appId: string | null;
  readonly check: () => Promise<ReleaseCheck>;
};

const HERE = "/setup/updates";
const DO_APPS = "https://cloud.digitalocean.com/apps";

async function safeCheck(deps: UpdatesDeps | undefined): Promise<ReleaseCheck> {
  if (!deps) return { ok: false };
  try {
    return await deps.check();
  } catch {
    return { ok: false };
  }
}

function versionCard(running: string, r: ReleaseCheck): string {
  const now = `<p>This Engine runs version <strong>${esc(running)}</strong>.</p>`;
  if (!r.ok) return card(`<h2>Version</h2>${now}<p>Could not check for updates just now.</p>`);
  const latest = `<p>Latest release (<code>${esc(r.repo)}</code>, branch <code>stable</code>): <strong>${esc(r.latest)}</strong>.</p>`;
  const verdict =
    r.newer === null
      ? "<p>The running version could not be compared with it.</p>"
      : r.newer
        ? "<p><strong>A new version is available.</strong></p>"
        : "<p>You are on the latest version.</p>";
  const notes = r.notes.length
    ? `<h3>What's new</h3>${r.notes.map((n) => `<h4>${esc(n.version)}</h4><pre>${esc(n.text)}</pre>`).join("")}`
    : "";
  return card(`<h2>Version</h2>${now}${latest}${verdict}${notes}`);
}

function howCard(appId: string | null): string {
  const href = appId ? `${DO_APPS}/${appId}` : DO_APPS;
  const where = appId ? "your app in DigitalOcean" : "your apps in DigitalOcean, then this Engine's app";
  return card(`<h2>How to update</h2><ol>
<li>Open <a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${where}</a> and choose <strong>Actions → Force Rebuild and Deploy</strong>. It takes a few minutes.</li>
<li>When the deploy is done, open <a href="/setup/database">Database</a> and apply any pending update.</li>
</ol>`);
}

const show: Handler = async (c, me, deps) => {
  const updates = deps.updates;
  const [release, state] = await Promise.all([
    safeCheck(updates),
    adminMigrationState(deps.database, () => deps.store.health(me.email)).catch(() => null),
  ]);
  const banner = state ? updateBanner(state) : "";
  const body = banner + versionCard(updates?.running ?? "unknown", release) + howCard(updates?.appId ?? null);
  return page(c, HERE, "Updates", body);
};

export function makeUpdatesRoutes(use: Parameters<typeof admin>[0]): Hono {
  const app = new Hono();
  app.get("/updates", admin(use, show));
  return app;
}
