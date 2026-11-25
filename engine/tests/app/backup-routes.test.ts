import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { makeBackupRoutes } from "../../src/app/backup-routes.js";
import { AppDeniedError } from "../../src/app/store.js";
import { _captureLogsForTests } from "../../src/log/logger.js";
import { ASSERT, client, createScreens, csrfIn } from "./fakes.js";

function world(over: Parameters<typeof createScreens>[0] = {}) {
  const screens = createScreens(over);
  const app = new Hono();
  app.route("/setup", makeBackupRoutes(() => screens.deps));
  return { ...screens, http: client(app) };
}

describe("the Backup screen", () => {
  it("refuses no sign-in, a reader and a stranger", async () => {
    const w = world();
    expect((await w.http.get("/setup/backup")).status).toBe(401);
    expect((await w.http.get("/setup/backup", ASSERT.reader)).status).toBe(403);
    expect((await w.http.get("/setup/backup", ASSERT.stranger)).status).toBe(403);
  });

  it("shows the state and the one-way warning, with no script", async () => {
    const w = world();
    const html = await (await w.http.get("/setup/backup", ASSERT.owner)).text();
    expect(html).toContain("private");
    expect(html).toMatch(/one way/i);
    expect(html).toMatch(/Token saved<\/td><td>no/);
    expect(html).not.toMatch(/<script/i);
  });

  it("an administrator who is not the owner gets 'No access' (the database refuses)", async () => {
    const w = world();
    const denied = async () => {
      throw new AppDeniedError("not allowed");
    };
    w.fake.store.backup = denied;
    expect((await w.http.get("/setup/backup", ASSERT.owner)).status).toBe(403);
  });

  it("stores the token in the vault and never shows or logs it", async () => {
    const w = world();
    const token = "github_pat_SECRET_0123456789abcdef";
    const csrf = csrfIn(await (await w.http.get("/setup/backup", ASSERT.owner)).text());
    const logs = _captureLogsForTests();
    try {
      const res = await w.http.post("/setup/backup/token", { csrf, backup_token: token }, ASSERT.owner);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/setup/backup?done=token");
      expect(res.headers.get("location")).not.toContain(token);
      expect(await res.text()).not.toContain(token);
      expect(logs.lines().join("\n")).not.toContain(token);
    } finally {
      logs.stop();
    }
    expect(w.fake.state.backupToken).toBe(token);
    const after = await (await w.http.get("/setup/backup?done=token", ASSERT.owner)).text();
    expect(after).toMatch(/Token saved<\/td><td>yes/);
    expect(after).not.toContain(token);
    expect(after).toContain("Token saved.");
    expect(after).toContain("Next: enter the private repository");
    expect(after).toContain('id="repo"');
  });

  it("refuses a token with spaces without echoing it", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/backup", ASSERT.owner)).text());
    const res = await w.http.post("/setup/backup/token", { csrf, backup_token: "two words token" }, ASSERT.owner);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).not.toContain("two words token");
    expect(html).toContain("Paste the whole token");
    expect(html).toContain('id="repo"');
  });

  it("saves the repository and switches the backup on once a token is saved", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/backup", ASSERT.owner)).text());
    const early = await w.http.post("/setup/backup", { csrf, repo: "acme/kb-backup", branch: "main", enabled: "yes" }, ASSERT.owner);
    expect(early.status).toBe(400);
    const earlyHtml = await early.text();
    expect(earlyHtml).toMatch(/save the GitHub token/);
    expect(earlyHtml).toContain('value="acme/kb-backup"');
    await w.http.post("/setup/backup/token", { csrf, backup_token: "github_pat_0123456789abcdef" }, ASSERT.owner);
    const res = await w.http.post("/setup/backup", { csrf, repo: "acme/kb-backup", branch: "", enabled: "yes" }, ASSERT.owner);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/setup/backup?done=settings");
    expect(w.fake.state.backup).toMatchObject({ repo: "acme/kb-backup", branch: "main", enabled: true });
    const after = await (await w.http.get("/setup/backup?done=settings", ASSERT.owner)).text();
    expect(after).toContain("Backup settings saved.");
    expect(after).toContain("Next: run a backup now");
  });

  it("refuses a bad repository or branch before the database", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/backup", ASSERT.owner)).text());
    for (const form of [{ repo: "https://github.com/acme/kb" }, { repo: "acme/kb", branch: "../main" }, { repo: "acme/kb", branch: "a b" }]) {
      const res = await w.http.post("/setup/backup", { csrf, branch: "main", ...form }, ASSERT.owner);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("The repository is owner/name");
    }
    expect(w.fake.calls.filter((c) => c.fn === "setBackup")).toHaveLength(0);
  });

  it("needs the page's own form token", async () => {
    const w = world();
    const res = await w.http.post("/setup/backup/now", { csrf: "forged" }, ASSERT.owner);
    expect(res.status).toBe(403);
    expect(w.fake.calls.filter((c) => c.fn === "requestBackup")).toHaveLength(0);
    const csrf = csrfIn(await (await w.http.get("/setup/backup", ASSERT.owner)).text());
    // The form token is accepted (not 403); nothing is set up yet, so the page says what is missing.
    expect((await w.http.post("/setup/backup/now", { csrf }, ASSERT.owner)).status).toBe(400);
  });

  it("shows only known notices and never echoes the query", async () => {
    const w = world();
    const html = await (await w.http.get("/setup/backup?done=<script>x</script>", ASSERT.owner)).text();
    expect(html).not.toContain("<script>x");
    expect(html).toContain("Next: save a GitHub token");
  });

  async function readyWorld() {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/backup", ASSERT.owner)).text());
    await w.http.post("/setup/backup/token", { csrf, backup_token: "github_pat_0123456789abcdef" }, ASSERT.owner);
    await w.http.post("/setup/backup", { csrf, repo: "acme/kb-backup", branch: "main", enabled: "yes" }, ASSERT.owner);
    return { w, csrf };
  }

  it("Back up now makes the run due, wakes the curator and returns to the page", async () => {
    const { w, csrf } = await readyWorld();
    const res = await w.http.post("/setup/backup/now", { csrf }, ASSERT.owner);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/setup/backup?done=started");
    const order = w.fake.calls.map((c) => c.fn).filter((f) => f === "requestBackup" || f === "testTimer");
    expect(order).toEqual(["requestBackup", "testTimer"]);
    const html = await (await w.http.get("/setup/backup?done=started", ASSERT.owner)).text();
    expect(html).toContain("Backup started.");
    expect(html).toContain('action="/setup/backup/now"');
  });

  it("Back up now does not start a second run while one is running", async () => {
    const { w, csrf } = await readyWorld();
    w.fake.state.backup = { ...w.fake.state.backup, last_status: "running" };
    const res = await w.http.post("/setup/backup/now", { csrf }, ASSERT.owner);
    expect(res.headers.get("location")).toBe("/setup/backup?done=running");
    expect(w.fake.calls.filter((c) => c.fn === "testTimer")).toHaveLength(0);
    expect(await (await w.http.get("/setup/backup?done=running", ASSERT.owner)).text()).toContain("A backup is already running.");
  });

  it("Back up now without a timer asks for the next timer run and says so", async () => {
    const { w, csrf } = await readyWorld();
    w.fake.store.testTimer = async () => null;
    const res = await w.http.post("/setup/backup/now", { csrf }, ASSERT.owner);
    expect(res.headers.get("location")).toBe("/setup/backup?done=queued");
    expect(await (await w.http.get("/setup/backup?done=queued", ASSERT.owner)).text()).toContain("Timer screen");
  });

  it("Back up now before the backup is set up stays on the page with what is missing", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/backup", ASSERT.owner)).text());
    const res = await w.http.post("/setup/backup/now", { csrf }, ASSERT.owner);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Next: save a GitHub token");
    expect(w.fake.calls.filter((c) => c.fn === "requestBackup" || c.fn === "testTimer")).toHaveLength(0);
  });

  it("Back up now is the owner's only: an administrator who is not the owner is refused", async () => {
    const { w, csrf } = await readyWorld();
    w.fake.store.requestBackup = async () => {
      throw new AppDeniedError("only the Engine owner can do this");
    };
    const res = await w.http.post("/setup/backup/now", { csrf }, ASSERT.owner);
    expect(res.status).toBe(403);
    expect(w.fake.calls.filter((c) => c.fn === "testTimer")).toHaveLength(0);
  });
});
