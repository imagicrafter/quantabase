import { parse } from "yaml";
import { z } from "zod";
import { DashboardSchema } from "./dashboard-schema.js";
import { dashboardProblems, resolveStatusConfig } from "./status-view.js";

/**
 * The Engine config (`.kb-engine/engine.yaml` in the owner's knowledge repo).
 *
 * One source of truth: this zod schema. config/schema.json is generated from
 * it, and the Python validator (scripts/knowledge/engine_config.py) checks a
 * file against that generated schema, so the two agree key for key. The
 * files in config/fixtures/ are judged by both test suites. The file is applied to the database and
 * read back from workspace.engine_settings; nothing here reads the disk.
 *
 * How the earlier, status-page-only file (version 2) maps onto this shape:
 *   engine.owner (a string)   -> engine.owner.email
 *   engine.connect            -> dashboard.connect
 *   engine.knowledge          -> dashboard.knowledge (optional; by default the
 *                                gauges are built from `sources`)
 *   engine.workers            -> dashboard.workers
 *   engine.tools              -> dashboard.tools
 *   engine.security           -> dashboard.security
 *   dashboard.title / menus   -> unchanged, now optional
 */

/** The fall-through topic. Always exists, sensitive, owner-only. */
export const UNCLASSIFIED = "unclassified";

const Slug = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*$/,
    "start with a letter; then lower-case letters, digits and dashes",
  );

/** A tag prefix such as "kx/": not empty, and it ends in a separator. */
const Prefix = z
  .string()
  .min(1, "prefix must not be empty")
  .regex(/[^A-Za-z0-9]$/, 'prefix must end in a separator such as "/" or "-"');

const Email = z.string().email();
const LowerEmail = Email.transform((value) => value.toLowerCase());
const DomainRef = Slug.nullable().default(null);

const Owner = z
  .object({
    email: Email,
    names: z.array(z.string().min(1)).default([]),
    emails: z.array(Email).default([]),
  })
  .strict();

const Domain = z
  .object({
    id: Slug,
    label: z.string().min(1),
    sensitive: z.boolean().default(false),
  })
  .strict();

const Sources = z
  .object({
    wiki: z
      .object({
        enabled: z.boolean().default(false),
        /** GitHub "owner/name" of the knowledge repo. */
        repo: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/, "use owner/name")
          .nullable()
          .default(null),
        default_domain: DomainRef,
      })
      .strict()
      .default({}),
    drive: z
      .object({
        enabled: z.boolean().default(false),
        default_domain: DomainRef,
        include_mime: z
          .array(z.enum(["docs", "sheets", "slides", "pdf"]))
          .default(["docs", "sheets", "slides"]),
        /** Whose description tags count: the signed-in account's own items, or any item. */
        trust_tags_from: z.enum(["owner", "anyone"]).default("owner"),
      })
      .strict()
      .default({}),
    fireflies: z
      .object({
        enabled: z.boolean().default(false),
        default_domain: DomainRef,
        /** Channel name -> topic id. */
        channels: z.record(Slug).default({}),
        write_meeting_pages: z.boolean().default(true),
        shared_meetings: z
          .object({
            enabled: z.boolean().default(false),
            /** The only organizer email domains whose meetings are taken. */
            trusted_domains: z
              .array(
                z
                  .string()
                  .regex(
                    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
                    "must be a domain such as example.com",
                  ),
              )
              .default([]),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    gmail: z
      .object({
        enabled: z.boolean().default(false),
        /** Overrides tagging.prefix for mail labels. */
        prefix: Prefix.nullable().default(null),
        /**
         * Whose mailbox is read, and who owns what comes from it. Empty means
         * one mailbox: the Engine owner's. One mailbox is supported for now.
         */
        mailboxes: z
          .array(
            z
              .object({
                /** The mailbox's own address; the stored sign-in must be for it. */
                email: LowerEmail,
                /** Who owns its threads. Defaults to the Engine owner. */
                owner_email: LowerEmail.nullable().default(null),
              })
              .strict(),
          )
          .max(1, "one mailbox is supported for now")
          .default([]),
      })
      .strict()
      .default({}),
  })
  .strict();

const EngineConfigObject = z
  .object({
    version: z.literal(1),
    engine: z
      .object({
        id: Slug,
        name: z.string().min(1),
        owner: Owner,
      })
      .strict(),
    domains: z.array(Domain).default([]),
    tagging: z
      .object({
        prefix: Prefix.default("kx/"),
        frontmatter_key: z.string().min(1).default("domains"),
      })
      .strict()
      .default({}),
    sources: Sources.default({}),
    models: z
      .object({
        distill: z
          .object({
            backend: z.string().min(1).default("do"),
            id: z.string().min(1).default("openai-gpt-oss-120b"),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    dashboard: DashboardSchema.optional(),
    support: z
      .object({
        care_plan: z
          .object({ enabled: z.boolean().default(false) })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
  })
  .strict();

type RawConfig = z.infer<typeof EngineConfigObject>;

function domainProblems(cfg: RawConfig): string[] {
  const ids = cfg.domains.map((d) => d.id);
  const declared = new Set(ids);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  const refs: [string, string | null][] = [
    ["sources.wiki.default_domain", cfg.sources.wiki.default_domain],
    ["sources.drive.default_domain", cfg.sources.drive.default_domain],
    ["sources.fireflies.default_domain", cfg.sources.fireflies.default_domain],
    ...Object.entries(cfg.sources.fireflies.channels).map(
      ([channel, id]): [string, string] => [
        `sources.fireflies.channels.${channel}`,
        id,
      ],
    ),
  ];
  return [
    ...dupes.map((id) => `domains: topic "${id}" is declared twice`),
    ...(declared.has(UNCLASSIFIED)
      ? [`domains: "${UNCLASSIFIED}" is reserved and always exists`]
      : []),
    ...refs.flatMap(([path, id]) =>
      id === null || declared.has(id)
        ? []
        : [`${path}: "${id}" is not a declared topic`],
    ),
    ...(cfg.sources.wiki.enabled && !cfg.sources.wiki.repo
      ? ["sources.wiki.repo: needed when the wiki source is enabled"]
      : []),
  ];
}

export const EngineConfigSchema = EngineConfigObject.superRefine((cfg, ctx) => {
  const problems = [
    ...domainProblems(cfg),
    ...dashboardProblems(resolveStatusConfig(cfg)),
  ];
  for (const message of problems) ctx.addIssue({ code: "custom", message });
});

/** The shape handed to zod-to-json-schema (cross-field rules are not in it). */
export const EngineConfigJsonShape = EngineConfigObject;

export type EngineConfig = z.infer<typeof EngineConfigSchema>;
export type DomainDef = EngineConfig["domains"][number];

export class EngineConfigError extends Error {}

/** Validate an already-parsed object. Throws with every problem listed. */
export function validateEngineConfig(raw: unknown): EngineConfig {
  const result = EngineConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) =>
      i.path.length ? `  ${i.path.join(".")}: ${i.message}` : `  ${i.message}`,
    );
    throw new EngineConfigError(
      `engine config is invalid:\n${issues.join("\n")}`,
    );
  }
  return result.data;
}

/** Paths of keys in `raw` that validation dropped from `kept` (unknown keys). */
function droppedKeys(raw: unknown, kept: unknown, path: string): string[] {
  if (Array.isArray(raw) && Array.isArray(kept)) {
    return raw.flatMap((item, i) => droppedKeys(item, kept[i], `${path}.${i}`));
  }
  if (!isPlainObject(raw) || !isPlainObject(kept)) return [];
  return Object.entries(raw).flatMap(([key, value]) =>
    Object.hasOwn(kept, key)
      ? droppedKeys(value, kept[key], `${path}.${key}`)
      : [`${path}.${key}`],
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a config FILE, as `kbe config validate` and the wiki job do: the
 * same rules as `validateEngineConfig`, and an unknown key inside `dashboard`
 * is an error too (config/schema.json says so, and the Python validator
 * checks against that file).
 *
 * The service reads the STORED config with `validateEngineConfig`, which
 * drops an unknown `dashboard` key instead: a config stored by an earlier
 * release must still load. Both validators judge every file in
 * config/fixtures/ with this function and its Python twin.
 */
export function validateEngineConfigFile(raw: unknown): EngineConfig {
  const config = validateEngineConfig(raw);
  const given = isPlainObject(raw) ? raw["dashboard"] : undefined;
  const unknown = droppedKeys(given, config.dashboard, "dashboard");
  if (unknown.length > 0) {
    throw new EngineConfigError(
      `engine config is invalid:\n${unknown.map((key) => `  ${key}: unknown key`).join("\n")}`,
    );
  }
  return config;
}

/** Parse YAML text. Throws EngineConfigError when it is not YAML. */
export function parseYaml(text: string): unknown {
  try {
    return parse(text);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new EngineConfigError(`engine config is not valid YAML: ${why}`);
  }
}

/** Parse and validate YAML text. */
export function parseEngineConfig(text: string): EngineConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new EngineConfigError(`engine config is not valid YAML: ${why}`);
  }
  return validateEngineConfig(raw);
}

/** Declared topics plus `unclassified`, which is always last and locked. */
export function effectiveDomains(cfg: EngineConfig): readonly DomainDef[] {
  return [
    ...cfg.domains,
    { id: UNCLASSIFIED, label: "Unclassified", sensitive: true },
  ];
}

/** Every address that is the owner, lower-cased, sign-in address first. */
export function ownerEmails(cfg: EngineConfig): readonly string[] {
  const all = [cfg.engine.owner.email, ...cfg.engine.owner.emails];
  return [...new Set(all.map((e) => e.toLowerCase()))];
}
