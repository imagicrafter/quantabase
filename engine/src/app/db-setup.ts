import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_KB_SCHEMA } from "../kb-schema.js";
import { MgmtError, type Mgmt } from "./mgmt.js";

/**
 * The Database setup screen's work, in order (test A2's steps):
 *
 *   project      the project answers and is healthy
 *   keys         the app's SUPABASE_JWT_SECRET and SUPABASE_ANON_KEY are this
 *                project's (compared as hashes; neither is shown)
 *   extensions   pg_cron and pg_net, for the curator timer (a warning if not)
 *   migrations   every file in supabase/migrations not yet applied, one
 *                request (one transaction) each, recorded in kbe_migrations
 *                exactly as `kbe db migrate` records them
 *   schema       the Engine's schema exposed to the Data API
 *   embed        the embed function deployed (no CLI, no Docker)
 *   embed_token  a new embed token: its hash on the kb-engine principal, the
 *                token itself in Supabase Vault (kbe_embed_token), only once
 *   owner        the claimant stored as the first administrator
 *   setup_code   the first-run code's hash stored, so the sign-in step that
 *                follows accepts this claim (engine_setup_reopen)
 *
 * Safe to run again: every step checks before it changes anything. Values go
 * to SQL as bound parameters, never pasted into the text, except file names
 * and hex checksums, which are checked first.
 */

export type StepStatus = "done" | "unchanged" | "warning" | "failed" | "not_run";
export type StepReport = {
  readonly id: string;
  readonly title: string;
  readonly status: StepStatus;
  readonly note?: string;
  /** How long the step took, for the log. */
  readonly ms?: number;
};

export const DB_STEPS: ReadonlyArray<{ readonly id: string; readonly title: string }> = [
  { id: "project", title: "Check the Supabase project" },
  { id: "keys", title: "Check the app's keys belong to this project" },
  { id: "extensions", title: "Switch on pg_cron and pg_net (for the timer)" },
  { id: "migrations", title: "Create or update the Engine's tables" },
  { id: "schema", title: "Make the Engine's schema reachable" },
  { id: "embed", title: "Deploy the embed function" },
  { id: "embed_token", title: "Make the embed token and keep it in Vault" },
  { id: "owner", title: "Store you as the owner" },
  { id: "setup_code", title: "Open the sign-in step for this claim" },
];

export const SCHEMA = DEFAULT_KB_SCHEMA;
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

export type DbSetupInputs = {
  readonly mgmt: Mgmt;
  readonly ownerEmail: string;
  /** What pages should call the owner (0077), e.g. a first name. Absent: their email stays the display name. */
  readonly ownerName?: string | null;
  readonly bootCode: string;
  readonly jwtSecret: string;
  readonly anonKey: string;
  readonly kbSchema: string;
  readonly files: SqlFiles;
  /** The clock for step timings. Default Date.now. */
  readonly now?: () => number;
};

export type SqlFiles = {
  /** `earlier`: checksums of the file before a comment-only rewording (supabase/migrations/reworded.json). */
  readonly migrations: () => ReadonlyArray<{ readonly name: string; readonly sql: string; readonly earlier?: readonly string[] }>;
  readonly embedSource: () => string;
};

const sha256Hex = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

const rows = (data: unknown): Array<Record<string, unknown>> =>
  Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];

/** Where the repository's SQL lives, from the engine folder; null when not shipped with the app. */
export function findRepoDir(start: URL = new URL("../../../", import.meta.url)): string | null {
  const base = fileURLToPath(start);
  return existsSync(`${base}supabase/migrations`) && existsSync(`${base}supabase/functions/embed/index.ts`)
    ? base
    : null;
}

/** {file: earlier checksums} from supabase/migrations/reworded.json; {} when absent or unreadable. */
function reworded(dir: string): Readonly<Record<string, readonly string[]>> {
  const path = `${dir}supabase/migrations/reworded.json`;
  if (!existsSync(path)) return {};
  try {
    const files = (JSON.parse(readFileSync(path, "utf8")) as { files?: unknown }).files;
    if (!files || typeof files !== "object") return {};
    return Object.fromEntries(
      Object.entries(files as Record<string, unknown>).map(([name, sums]) => [
        name,
        Array.isArray(sums) ? sums.filter((s): s is string => typeof s === "string" && /^[0-9a-f]{64}$/.test(s)) : [],
      ]),
    );
  } catch {
    return {};
  }
}

export function repoSqlFiles(dir: string): SqlFiles {
  return {
    migrations: () => {
      const earlier = reworded(dir);
      return readdirSync(`${dir}supabase/migrations`)
        .filter((f) => MIGRATION_FILE.test(f))
        .sort()
        .map((name) => ({ name, sql: readFileSync(`${dir}supabase/migrations/${name}`, "utf8"), earlier: earlier[name] ?? [] }));
    },
    embedSource: () => readFileSync(`${dir}supabase/functions/embed/index.ts`, "utf8"),
  };
}

// Same statements as scripts/kbe/pg.py tracking_sql(), so `kbe db migrate`
// later sees these files as applied.
const TRACKING_SQL = `
create schema if not exists ${SCHEMA};
create table if not exists ${SCHEMA}.kbe_migrations (
    filename   text        primary key,
    checksum   text        not null,
    applied_at timestamptz not null default now()
);
alter table ${SCHEMA}.kbe_migrations add column if not exists kb_schema text;
update ${SCHEMA}.kbe_migrations set kb_schema = '${SCHEMA}' where kb_schema is null;
alter table ${SCHEMA}.kbe_migrations alter column kb_schema set not null;
alter table ${SCHEMA}.kbe_migrations enable row level security;
revoke all on ${SCHEMA}.kbe_migrations from public;
do $$
declare v_role text;
begin
    foreach v_role in array array['anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = v_role) then
            execute format('revoke all on ${SCHEMA}.kbe_migrations from %I', v_role);
        end if;
    end loop;
end $$;
`;

type Step = (inputs: DbSetupInputs) => Promise<{ readonly status: StepStatus; readonly note?: string }>;
/** What the steps shared with the Database update screen (db-update.ts) need. */
export type CoreInputs = Pick<DbSetupInputs, "mgmt" | "files">;
type CoreStep = (inputs: CoreInputs) => Promise<{ readonly status: StepStatus; readonly note?: string }>;

export const projectStep: CoreStep = async ({ mgmt }) => {
  const p = (await mgmt.get("")) as Record<string, unknown> | null;
  const status = String(p?.["status"] ?? "unknown");
  if (status !== "ACTIVE_HEALTHY") {
    return { status: "failed", note: `The project is ${status}, not running. Wait for it in the Supabase dashboard, then try again.` };
  }
  let count = 0;
  try {
    count = await mgmt.projectCount();
  } catch {
    count = 0;
  }
  return count > 1
    ? { status: "warning", note: `This token can reach ${count} projects. It is used once and not kept, but a token for this one project is safer.` }
    : { status: "done" };
};

const keys: Step = async ({ mgmt, jwtSecret, anonKey }) => {
  const pg = (await mgmt.get("/postgrest")) as Record<string, unknown> | null;
  const secret = pg?.["jwt_secret"];
  if (typeof secret !== "string" || !sameSecret(secret, jwtSecret)) {
    return { status: "failed", note: "The app's SUPABASE_JWT_SECRET is not this project's JWT secret. Fix it on the app, then try again." };
  }
  const list = rows(await mgmt.get("/api-keys?reveal=true"));
  const anon = list.find((k) => k["name"] === "anon")?.["api_key"];
  const publishable = list.filter((k) => k["type"] === "publishable").map((k) => k["api_key"]);
  const known = [anon, ...publishable].filter((k): k is string => typeof k === "string");
  if (!known.some((k) => sameSecret(k, anonKey))) {
    return { status: "failed", note: "The app's SUPABASE_ANON_KEY is not one of this project's public keys. Fix it on the app, then try again." };
  }
  return { status: "done" };
};

const extensions: Step = async ({ mgmt }) => {
  try {
    await mgmt.sql("create extension if not exists pg_cron; create extension if not exists pg_net;");
    return { status: "done" };
  } catch (err) {
    return { status: "warning", note: `The timer will not work until pg_cron and pg_net are on (${err instanceof Error ? err.message : "error"}).` };
  }
};

export const migrationsStep: CoreStep = async ({ mgmt, files }) => {
  await mgmt.sql(TRACKING_SQL);
  const applied = new Map(
    rows(await mgmt.sql(`select filename, checksum from ${SCHEMA}.kbe_migrations`)).map((r) => [String(r["filename"]), String(r["checksum"])]),
  );
  let ran = 0;
  for (const file of files.migrations()) {
    const checksum = sha256Hex(Buffer.from(file.sql, "utf8"));
    const before = applied.get(file.name);
    if (before !== undefined) {
      if (before !== checksum && !(file.earlier ?? []).includes(before)) {
        return { status: "failed", note: `${file.name} was applied with different contents. Migrations are never edited; ask for help before going on.` };
      }
      continue;
    }
    const record =
      `insert into ${SCHEMA}.kbe_migrations (filename, checksum, kb_schema) values ('${file.name}', '${checksum}', '${SCHEMA}') ` +
      "on conflict (filename) do update set checksum = excluded.checksum, kb_schema = excluded.kb_schema, applied_at = now();";
    try {
      await mgmt.sql(`${file.sql}\n;\n${record}`);
    } catch (err) {
      return { status: "failed", note: `${file.name} did not apply (${err instanceof Error ? err.message : "error"}). Nothing from that file was kept.` };
    }
    ran += 1;
  }
  return ran === 0 ? { status: "unchanged" } : { status: "done", note: `${ran} file${ran === 1 ? "" : "s"} applied.` };
};

export const schemaStep: CoreStep = async ({ mgmt }) => {
  const pg = (await mgmt.get("/postgrest")) as Record<string, unknown> | null;
  const listed = String(pg?.["db_schema"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (listed.includes(SCHEMA)) return { status: "unchanged" };
  await mgmt.patch("/postgrest", { db_schema: [...listed, SCHEMA].join(",") });
  return { status: "done", note: "The Data API takes up to a minute to pick this up." };
};

const embed: Step = async ({ mgmt, files }) => {
  await mgmt.deployFunction("embed", files.embedSource());
  return { status: "done" };
};

const embedToken: Step = async ({ mgmt }) => {
  const have = rows(await mgmt.sql("select count(*)::int as n from vault.secrets where name = 'kbe_embed_token'"));
  if (Number(have[0]?.["n"] ?? 0) > 0) return { status: "unchanged" };
  const token = randomBytes(32).toString("base64url");
  const updated = rows(
    await mgmt.sql(`update ${SCHEMA}.principals set token_hash = $1 where handle = 'kb-engine' and active returning handle`, [sha256Hex(token)]),
  );
  if (updated.length !== 1) return { status: "failed", note: "The kb-engine principal is missing; the tables did not finish." };
  await mgmt.sql("select vault.create_secret($1, 'kbe_embed_token', 'KB Engine embed token (Database setup screen)')", [token]);
  return { status: "done" };
};

const owner: Step = async ({ mgmt, ownerEmail, ownerName }) => {
  const name = ownerName?.trim() || null;
  const admins = rows(
    await mgmt.sql(`select lower(email) as email from ${SCHEMA}.principals where role = 'administrator' and active`),
  ).map((r) => String(r["email"]));
  if (admins.includes(ownerEmail)) {
    if (!name) return { status: "unchanged" };
    // Run again with a name: name the owner. A display name that is still
    // the email becomes the name; one set by hand is kept.
    await mgmt.sql(
      `update ${SCHEMA}.principals set page_name = $2, ` +
        "display_name = case when lower(btrim(display_name)) = $1 then $2 else display_name end " +
        "where lower(btrim(email)) = $1 and role = 'administrator' and active",
      [ownerEmail, name],
    );
    return { status: "done" };
  }
  if (admins.length > 0) {
    return { status: "failed", note: "This Engine already has an owner, and it is someone else. Claim it with that owner's email." };
  }
  const handle = `owner-${sha256Hex(ownerEmail).slice(0, 8)}`;
  await mgmt.sql(
    `insert into ${SCHEMA}.principals (handle, display_name, role, email, active, page_name) values ($1, $3, 'administrator', $2, true, $4) ` +
      "on conflict (handle) do update set role = 'administrator', active = true, email = excluded.email, " +
      "display_name = excluded.display_name, page_name = excluded.page_name",
    [handle, ownerEmail, name ?? ownerEmail, name],
  );
  return { status: "done" };
};

const setupCode: Step = async ({ mgmt, bootCode }) => {
  await mgmt.sql(`select ${SCHEMA}.engine_setup_reopen($1)`, [sha256Hex(bootCode)]);
  return { status: "done" };
};

const RUNNERS: Readonly<Record<string, Step>> = {
  project: projectStep, keys, extensions, migrations: migrationsStep, schema: schemaStep, embed, embed_token: embedToken, owner, setup_code: setupCode,
};

/** Run every step in order; stop at the first failure. */
export async function runDbSetup(inputs: DbSetupInputs): Promise<{ readonly ok: boolean; readonly steps: readonly StepReport[] }> {
  if (inputs.kbSchema !== SCHEMA) {
    return {
      ok: false,
      steps: [{ id: "project", title: "Check the Supabase project", status: "failed", note: `This screen sets up the default schema only. For KB_SCHEMA=${inputs.kbSchema} use \`kbe db migrate\`.` }],
    };
  }
  return runSteps(DB_STEPS, RUNNERS, inputs, inputs.now ?? Date.now);
}

/** Run the named steps in order with their runners; stop at the first failure. */
export async function runSteps<I>(
  defs: ReadonlyArray<{ readonly id: string; readonly title: string }>,
  runners: Readonly<Record<string, (inputs: I) => Promise<{ readonly status: StepStatus; readonly note?: string }>>>,
  inputs: I,
  now: () => number,
): Promise<{ readonly ok: boolean; readonly steps: readonly StepReport[] }> {
  const steps: StepReport[] = [];
  let failed = false;
  for (const def of defs) {
    if (failed) {
      steps.push({ ...def, status: "not_run" });
      continue;
    }
    const run = runners[def.id];
    const started = now();
    try {
      const out = run ? await run(inputs) : { status: "failed" as const, note: "unknown step" };
      steps.push({ ...def, ...out, ms: now() - started });
      failed = out.status === "failed";
    } catch (err) {
      const note = err instanceof MgmtError ? err.message : "This step failed unexpectedly.";
      steps.push({ ...def, status: "failed", note, ms: now() - started });
      failed = true;
    }
  }
  return { ok: !failed, steps };
}
