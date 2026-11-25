import {
  currentAccess,
  currentSettings,
  SettingsUnavailableError,
  type AccessSettings,
} from "../config/settings.js";

/**
 * Is the Engine set up yet?
 *
 * SETUP MODE means it has no usable sign-in settings from either source: the
 * four Cloudflare variables are unset AND the database holds none. In setup
 * mode only GET /health and the /setup routes answer (see index.ts).
 *
 * A deployment that sets the variables is never in setup mode, whatever the
 * database says, and its database is not even read to decide.
 *
 * FAIL CLOSED: stored settings that are present but unusable are not "no
 * settings". An Engine in that state is broken, not new: it answers 503 on
 * every route (including /setup) until the stored settings are repaired.
 * Otherwise damaging the stored row would reopen the setup page without the
 * sign-in that guards it once the Engine is set up.
 *
 * The cache is the settings store's: a minute once set up, five seconds while
 * in setup mode, and dropped at once when setup completes in this process
 * (invalidateSettings). So the Engine leaves setup mode without a restart.
 */

export type EngineMode =
  | {
      readonly kind: "setup";
      /** The database has no Engine schema yet (the Database screen comes first). */
      readonly databaseMissing?: boolean;
    }
  | {
      readonly kind: "ready";
      readonly access: AccessSettings;
      /** The owner has reopened setup; the stored settings stay in force. */
      readonly setupOpen: boolean;
    };

/** Throws SettingsUnavailableError when the database cannot be read. */
export async function currentMode(): Promise<EngineMode> {
  const access = await currentAccess();
  if (access?.source === "environment") {
    return { kind: "ready", access, setupOpen: false };
  }
  const settings = await currentSettings();
  if (settings.databaseMissing) return { kind: "setup", databaseMissing: true };
  if (!access) {
    if (settings.accessInvalid) {
      throw new SettingsUnavailableError(
        "stored sign-in settings are present but unusable",
      );
    }
    return { kind: "setup" };
  }
  return {
    kind: "ready",
    access,
    setupOpen: settings.setupState === "open",
  };
}

/** The paths that answer in setup mode, besides /health. */
export function isSetupPath(path: string): boolean {
  return path === "/setup" || path.startsWith("/setup/");
}
