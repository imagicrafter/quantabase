import { env } from "./env.js";
import { supabase } from "./supabase.js";

/**
 * The database client, scoped to the Engine's schema.
 *
 * Every query goes through here, so no call site names a schema. Which schema
 * that is comes from KB_SCHEMA (see env.ts and kb-schema.ts).
 */
export function db(): ReturnType<typeof supabase.schema> {
  return supabase.schema(env.KB_SCHEMA);
}
