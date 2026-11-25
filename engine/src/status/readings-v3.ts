import { z } from "zod";

/**
 * The four readings workspace.engine_status() gained in migration 0041:
 * tagging, issues, setup and config. Each is optional on purpose. A database
 * that has not had that migration yet returns none of them, and the page must
 * still draw: a missing reading is shown as "no reading", never as a zero.
 */

const count = z.number().default(0);
const when = z.string().nullable().optional();

export const TaggingReading = z.object({
  source: z.string(),
  total: count,
  by_tag_source: z
    .object({
      content: count,
      container: count,
      source_default: count,
      default: count,
      not_recorded: count,
    })
    .default({}),
  untagged: count,
  unknown_tag: count,
});

export const OpenIssue = z.object({
  category: z.string(),
  source: z.string().nullable().optional(),
  title: z.string(),
  status: z.string().default("open"),
  opened_at: when,
  occurrences: z.number().default(1),
  has_card: z.boolean().default(false),
});

export const IssuesReading = z.object({
  open: z.array(OpenIssue).default([]),
  fixed_last_30_days: count,
  care_plan_enabled: z.boolean().default(false),
});

export const SetupReading = z.object({
  setup_state: z.string().nullable().optional(),
  level: z.string().nullable().optional(),
  host: z.string().nullable().optional(),
  locked_until: when,
});

export const ConfigReading = z.object({
  applied_at: when,
  rejected: z.boolean().default(false),
});

/** Spread into StatusDataSchema. */
export const V3_READINGS = {
  tagging: z.array(TaggingReading).nullable().optional(),
  issues: IssuesReading.nullable().optional(),
  setup: SetupReading.nullable().optional(),
  config: ConfigReading.nullable().optional(),
} as const;

export type TaggingRow = z.infer<typeof TaggingReading>;
export type OpenIssueRow = z.infer<typeof OpenIssue>;
