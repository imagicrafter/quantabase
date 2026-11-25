import { describe, it, expect } from "vitest";
import { TOKEN_PERMISSIONS } from "../../src/setup/permissions.js";
import {
  TOKEN_LINK_KEYS,
  TOKEN_LINK_NAME,
  tokenLink,
} from "../../src/setup/token-link.js";

// The link's form comes from Cloudflare's "API token template URLs" page.
// These tests pin what that page documents; they do not prove the dashboard.

describe("the Cloudflare token link", () => {
  const url = new URL(tokenLink());

  it("opens the documented user-token screen on dash.cloudflare.com", () => {
    expect(url.origin).toBe("https://dash.cloudflare.com");
    expect(url.pathname).toBe("/profile/api-tokens");
  });

  it("uses only the four documented parameters", () => {
    expect([...url.searchParams.keys()].sort()).toEqual([
      "accountId",
      "name",
      "permissionGroupKeys",
      "zoneId",
    ]);
    expect(url.searchParams.get("accountId")).toBe("*");
    expect(url.searchParams.get("zoneId")).toBe("all");
    expect(url.searchParams.get("name")).toBe(TOKEN_LINK_NAME);
  });

  it("asks for one key per permission the setup needs: edit, and zone at read", () => {
    const keys = JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "");
    expect(keys).toEqual([
      { key: "access", type: "edit" },
      { key: "access_acct", type: "edit" },
      { key: "dns", type: "edit" },
      { key: "zone", type: "read" },
    ]);
    expect(Object.keys(TOKEN_LINK_KEYS).sort()).toEqual(
      TOKEN_PERMISSIONS.map((p) => p.id).sort(),
    );
  });

  it("is encoded the way the documentation's examples are", () => {
    expect(tokenLink()).toContain(
      "permissionGroupKeys=%5B%7B%22key%22%3A%22access%22%2C%22type%22%3A%22edit%22%7D%2C",
    );
    expect(tokenLink()).toContain("&accountId=%2A&zoneId=all&name=KB%20Engine");
    expect(tokenLink()).not.toMatch(/[\s"<>]/);
  });
});
