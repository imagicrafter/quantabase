import { formatWhen, pill, type Pill } from "./model-shared.js";
import type { StatusData } from "./readings.js";

/**
 * Security menu, "How people sign in": the access level chosen at setup, the
 * hostname, where setup stands, and whether this page has its second factor.
 * Only plain facts: never the setup code, its hash or the wrong-code counter.
 */

/** What the request itself knows about sign-in (from the settings in force). */
export type PageAccess = {
  readonly host?: string | undefined;
  readonly level?: string | undefined;
  /** True when this page was reached through a sign-in app of its own. */
  readonly ownSignInApp?: boolean | undefined;
};

export type AccessRow = {
  readonly label: string;
  readonly value: string;
  readonly pill: Pill | null;
};

const LEVELS: Readonly<Record<string, string>> = {
  owner: "Owner only",
  people: "Named people",
  named: "Named people",
  domain: "Anyone at the company domains",
};

function levelText(level: string | null | undefined): string {
  return (level && LEVELS[level]) || "Not recorded";
}

function setupRow(data: StatusData, now: Date): AccessRow {
  const setup = data.setup;
  const label = "Setup";
  if (!setup?.setup_state) return { label, value: "No reading", pill: null };
  const lockedUntil = setup.locked_until ? new Date(setup.locked_until) : null;
  if (lockedUntil && lockedUntil.getTime() > now.getTime()) {
    return {
      label,
      value: `Locked after wrong codes until ${formatWhen(setup.locked_until)}`,
      pill: pill("warn", "Locked"),
    };
  }
  if (setup.setup_state === "complete") {
    return { label, value: "Complete", pill: pill("good", "Done") };
  }
  return {
    label,
    value: "Open: the setup page is accepting its one-time code",
    pill: pill("warn", "Open"),
  };
}

export function buildAccess(
  data: StatusData,
  now: Date,
  page: PageAccess = {},
): readonly AccessRow[] {
  const host = page.host ?? data.setup?.host ?? null;
  return [
    {
      label: "Who can sign in",
      value: levelText(page.level ?? data.setup?.level),
      pill: null,
    },
    { label: "Hostname", value: host || "Not recorded", pill: null },
    setupRow(data, now),
    {
      label: "Second factor on this page",
      value: page.ownSignInApp
        ? "On: this page has its own sign-in"
        : "Not known",
      pill: page.ownSignInApp ? pill("good", "On") : null,
    },
  ];
}
