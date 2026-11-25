import { z } from "zod";
import type { JsonObject } from "./merge.js";

/** What the step functions share: the context they pass along and small parsers. */

export type StepStatus = "created" | "updated" | "unchanged";

/** What the steps have learned so far. Each step returns a new one. */
export type ApplyContext = {
  readonly accountId: string;
  readonly zoneId: string;
  /** https://<team>.cloudflareaccess.com */
  readonly teamDomain?: string;
  readonly loginMethodId?: string;
  readonly authenticators?: readonly string[];
  readonly policyIds: Readonly<Record<string, string>>;
  readonly auds: Readonly<Record<string, string>>;
};

export type StepOutcome = {
  readonly status: StepStatus;
  readonly context: ApplyContext;
};

export const Id = z.string().regex(/^[a-f0-9-]{32,36}$/i);
const Passthrough = z.object({}).passthrough();
export const asObject = (value: unknown): JsonObject =>
  Passthrough.parse(value) as JsonObject;

/** Fields Cloudflare sets itself; sending them back is refused or ignored. */
export const READ_ONLY = ["id", "aud", "uid", "created_at", "updated_at"];

/** Written on the DNS record setup makes, so a later run knows it as its own. */
export const SETUP_MARK = "KB Engine (created by setup)";

/** What a person is told when something is in the way and they did not ask to replace it. */
export const HOW_TO_REPLACE =
  'If you mean to take it over, go back and tick "Replace what is already there". Otherwise remove it in Cloudflare, or choose another hostname.';
