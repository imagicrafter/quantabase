import { describe, expect, it } from "vitest";
import { curatorHealthCard, timerBrokenBanner, timerBrokenReason } from "../../src/app/curator-health.js";

describe("timerBrokenReason / the red card", () => {
  const job = (status: string | null, message?: string) => ({ name: "kbe-curator-wake", schedule: "* * * * *", active: true, last_start: status ? "2026-11-21T07:00:00Z" : null, last_status: status, last_message: message });

  it("names the failed job and the first line of its error, and turns the card red", () => {
    const h = { cron_available: true, jobs: [job("failed", "ERROR: function public.curator_wake(boolean) does not exist\nHINT: x")], pokes_24h: null };
    expect(timerBrokenReason(h)).toBe("Wake check (every minute) failed: ERROR: function public.curator_wake(boolean) does not exist");
    expect(curatorHealthCard(h)).toContain('class="card errors"');
    expect(timerBrokenBanner(h)).toContain("Timer is broken: Wake check");
  });

  it("is quiet when runs succeed, have not run, cron is missing, or health is unknown", () => {
    expect(timerBrokenReason({ cron_available: true, jobs: [job("succeeded"), job(null)] })).toBeNull();
    expect(timerBrokenReason({ cron_available: false, jobs: [job("failed")] })).toBeNull();
    expect(timerBrokenReason(null)).toBeNull();
    expect(timerBrokenBanner(null)).toBe("");
    expect(curatorHealthCard({ cron_available: true, jobs: [job("succeeded")] })).not.toContain("errors");
  });
});

describe("the 'Is the timer firing?' card", () => {
  it("shows both cron jobs, failed pokes, the last tick and the run holding the lease", () => {
    const html = curatorHealthCard({
      cron_available: true,
      jobs: [
        { name: "kbe-curator-tick", schedule: "0 * * * *", active: true, last_start: "2026-11-21T07:00:00Z", last_status: "failed", last_message: "connection <refused>" },
        { name: "kbe-curator-wake", schedule: "* * * * *", active: false, last_start: null },
      ],
      pokes_24h: { total: 16, failed: 3, last_error: "Timeout of 5000 ms reached", last_failure_at: "2026-11-21T08:00:00Z" },
      last_tick_at: "2026-11-21T06:30:00Z",
      last_tick_outcome: "busy",
      running: { started_at: "2026-11-21T22:19:00Z", lease_until: "2026-11-21T22:22:00Z" },
    });
    expect(html).toContain("Hourly safety tick");
    expect(html).toContain("Wake check (every minute)");
    expect(html).toContain("paused");
    expect(html).toContain("connection &lt;refused&gt;");
    expect(html).toContain("3 of 16 failed");
    expect(html).toContain("Timeout of 5000 ms reached");
    expect(html).toContain("(busy)");
    expect(html).toContain("lease until");
  });

  it("flags a missing cron job (the jobs were never created)", () => {
    const html = curatorHealthCard({ cron_available: true, jobs: [], pokes_24h: { total: 0, failed: 0 } });
    expect(html.match(/<strong>missing<\/strong>/g)).toHaveLength(2);
    expect(html).toContain("none received yet");
    expect(html).toContain("0 sent, none failed");
  });

  it("says when pg_cron or pg_net is not there, and when the database is too old", () => {
    const html = curatorHealthCard({ cron_available: false, jobs: [], pokes_24h: null });
    expect(html).toContain("pg_cron is not available");
    expect(html).toContain("pg_net is not available");
    expect(curatorHealthCard(null)).toContain("needs its latest update");
  });
});
