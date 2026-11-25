import type { EngineConfig } from "../config/engine-config.js";
import {
  resolveStatusConfig,
  type StatusConfig,
} from "../config/status-view.js";

/**
 * What the status page needs from the Engine config.
 *
 * The page no longer has a file of its own: its definition is the optional
 * `dashboard` section of the one Engine config, read from the database
 * (config/settings.ts). This module turns that config into the page's view,
 * with every default filled in; turning readings into what the page shows
 * happens in readings.ts and model.ts.
 */

export {
  MENU_TABS,
  durationMs,
  type DashboardJob,
  type DashboardTool,
  type MenuId,
} from "../config/dashboard-schema.js";
export type { StatusConfig } from "../config/status-view.js";

/** The status page's view of a validated Engine config. */
export function statusConfigFrom(config: EngineConfig): StatusConfig {
  return resolveStatusConfig(config);
}
