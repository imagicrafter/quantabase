import { Hono } from "hono";
import { accessFromDatabase } from "../../src/config/settings.js";
import { McpAppError } from "../../src/mcp/errors.js";
import type { SetupDeps } from "../../src/setup/gate.js";
import type { EngineMode } from "../../src/setup/mode.js";
import { makeSetupRoutes } from "../../src/setup/route.js";
import { createFakeCloudflare, type FakeOptions } from "./fake-cloudflare.js";
import { createFakeDb } from "./fake-db.js";

/**
 * A whole pretend deployment for the route tests: a fake database row, a fake
 * Cloudflare API, a clock, and the /setup routes wired to them.
 */

export const CODE = "the-setup-code-is-long-and-random-000001";
export const PLATFORM_HOST = "app-abc12.ondigitalocean.app";
export const ENGINE_HOST = "engine.example.com";
/** What a signed-in administrator's request carries. */
export const ADMIN_ASSERTION = "assertion.for.owner";
export const READER_ASSERTION = "assertion.for.reader";

export type WorldOptions = {
  readonly setupCode?: string | null;
  readonly dbCode?: string | null;
  readonly owner?: string | null;
  readonly cloudflare?: FakeOptions;
  readonly deps?: Partial<SetupDeps>;
};

export function createWorld(options: WorldOptions = {}) {
  const clock = { now: 1_800_000_000_000 };
  const db = createFakeDb(
    options.dbCode === undefined ? CODE : options.dbCode,
    clock,
  );
  const cloudflare = createFakeCloudflare(options.cloudflare);
  const seen = {
    completed: 0,
    verify: [] as { audience: string; issuer: string }[],
  };

  const mode = async (): Promise<EngineMode> => {
    const access = accessFromDatabase(db.row.access);
    return access
      ? { kind: "ready", access, setupOpen: db.row.setup_state === "open" }
      : { kind: "setup" };
  };

  const deps: SetupDeps = {
    setupCode:
      options.setupCode === null ? undefined : (options.setupCode ?? CODE),
    mode,
    ownerEmail: async () =>
      options.owner === undefined ? "owner@example.com" : options.owner,
    lockout: {
      attemptCheck: db.attemptCheck,
      attemptFail: db.attemptFail,
      codeValid: db.codeValid,
    },
    complete: db.complete,
    cloudflareFetch: cloudflare.fetch,
    guard: {
      verify: async (assertion, audience, issuer) => {
        seen.verify.push({ audience, issuer });
        if (assertion === ADMIN_ASSERTION)
          return { email: "owner@example.com" };
        if (assertion === READER_ASSERTION)
          return { email: "reader@example.com" };
        throw new McpAppError("unauthenticated", "Invalid Access assertion");
      },
      isAdmin: async (email) => email === "owner@example.com",
      statusAudience: async (access) => access.statusAud,
      assertEmailAllowed: () => undefined,
    },
    onCompleted: () => {
      seen.completed += 1;
    },
    now: () => clock.now,
    ...options.deps,
  };

  const app = new Hono();
  app.route("/setup", makeSetupRoutes(deps));

  const get = (headers: Record<string, string> = {}, host = PLATFORM_HOST) =>
    app.fetch(
      new Request("http://" + host + "/setup", {
        headers: { Host: host, ...headers },
      }),
    );

  const post = (
    path: "/setup/preview" | "/setup/apply",
    fields: Record<string, string>,
    headers: Record<string, string> = {},
    host = PLATFORM_HOST,
  ) =>
    app.fetch(
      new Request("http://" + host + path, {
        method: "POST",
        headers: {
          Host: host,
          "Content-Type": "application/x-www-form-urlencoded",
          "Sec-Fetch-Site": "same-origin",
          ...headers,
        },
        body: new URLSearchParams(fields).toString(),
      }),
    );

  return { clock, db, cloudflare, deps, app, seen, get, post };
}

export type World = ReturnType<typeof createWorld>;

export const CHOICES = {
  host: ENGINE_HOST,
  origin: PLATFORM_HOST,
  level: "people",
  owner_email: "owner@example.com",
  emails: "amy@example.com",
  domains: "",
  replace: "",
};

/** Pull a hidden field's value out of a rendered page. */
export function hidden(html: string, name: string): string {
  const match = new RegExp('name="' + name + '" value="([^"]*)"').exec(html);
  if (!match?.[1]) throw new Error("no hidden field " + name);
  return match[1];
}

/** Run the preview step and return the signed fields for the apply step. */
export async function previewed(
  world: World,
  choices: Record<string, string> = CHOICES,
  headers: Record<string, string> = {},
  host = PLATFORM_HOST,
) {
  const res = await world.post(
    "/setup/preview",
    { code: CODE, ...choices },
    headers,
    host,
  );
  const html = await res.text();
  if (res.status !== 200) throw new Error("preview failed: " + res.status);
  return { inputs: hidden(html, "inputs"), sig: hidden(html, "sig"), html };
}
