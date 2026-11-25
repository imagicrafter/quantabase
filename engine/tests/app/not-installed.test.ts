import { describe, it, expect } from "vitest";
import { createSettingsStore, isNotInstalled } from "../../src/config/settings.js";

/** A fresh, empty project reads as "not set up", never as broken settings. */

describe("an empty database", () => {
  it("is recognised only by the answers an empty project gives", () => {
    expect(isNotInstalled({ code: "PGRST106", message: "Invalid schema" })).toBe(true);
    expect(isNotInstalled({ code: "PGRST202", message: "Could not find the function" })).toBe(true);
    expect(isNotInstalled({ code: "42883", message: "function does not exist" })).toBe(true);
    expect(isNotInstalled({ code: "22023", message: 'role "kb_engine" does not exist' })).toBe(true);
    expect(isNotInstalled({ code: "22023", message: "something else" })).toBe(false);
    expect(isNotInstalled({ code: "PGRST301", message: "JWT expired" })).toBe(false);
    expect(isNotInstalled({ code: "57014", message: "timeout" })).toBe(false);
    expect(isNotInstalled({})).toBe(false);
  });

  it("reads as no settings with the database marked missing", async () => {
    const store = createSettingsStore({ read: async () => ({ uninstalled: true }), envAccess: null });
    const got = await store.get();
    expect(got.databaseMissing).toBe(true);
    expect(got.access).toBeNull();
    expect(got.accessInvalid).toBe(false);
  });

  it("a normal row is not missing", async () => {
    const store = createSettingsStore({ read: async () => ({ config: null, access: null, setup_state: null }), envAccess: null });
    expect((await store.get()).databaseMissing).toBe(false);
  });
});
