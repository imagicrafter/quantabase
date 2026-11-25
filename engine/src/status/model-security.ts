import type { StatusConfig } from "./config.js";
import {
  formatDay,
  pill,
  plural,
  stateOf,
  worstState,
  type Pill,
} from "./model-shared.js";
import {
  buildAccess,
  type AccessRow,
  type PageAccess,
} from "./model-access.js";
import { findJob, jobGauge, type StatusData } from "./readings.js";

/** Security menu: the five layers, who can see what, and the systems that sign in. */

export type Layer = {
  readonly title: string;
  readonly how: string;
  readonly pill: Pill;
  readonly stat: string;
  readonly links: readonly { readonly label: string; readonly route: string }[];
};

export type PersonRow = {
  readonly name: string;
  readonly email: string;
  readonly role: "Owner" | "Member";
  readonly active: boolean;
  readonly areas: readonly {
    readonly domain: string;
    readonly kind: "auto" | "granted";
    readonly locked: boolean;
  }[];
};

export type SystemRow = {
  readonly name: string;
  readonly handle: string | null;
  readonly what: string;
  readonly pill: Pill;
  readonly changed: string;
};

export type SecurityModel = {
  readonly kpis: readonly {
    readonly label: string;
    readonly value: string;
    readonly sub: string;
    readonly pill: Pill | null;
  }[];
  readonly layers: readonly Layer[];
  /** How people sign in: level, hostname, setup state, second factor. */
  readonly access: readonly AccessRow[];
  readonly blocked: readonly {
    readonly what: string;
    readonly times: number;
  }[];
  readonly people: readonly PersonRow[];
  readonly connections: readonly SystemRow[];
  readonly systems: readonly SystemRow[];
  readonly badge: Pill;
};

const PASS_VERDICTS = new Set(["pass", "ok", "clean", "allow", "allowed"]);

const layerCopy = (tag: string) => ({
  access: {
    title: "Who gets in, and what they see",
    how: "Email code to sign in, plus 2FA for this page. Each person sees only the knowledge areas shared with them; locked areas need their name.",
  },
  intake: {
    title: "What comes in",
    how: `Only items marked ${tag}[area] are shared: labeled email, meetings in a ${tag} channel, files in an area folder. Email to the workers is screened; web pages and tool results are treated as data, never as instructions.`,
  },
  actions: {
    title: "What the workers can do",
    how: "Workers run in sealed rooms that reach only approved websites. A guard checks every command first.",
  },
  passwords: {
    title: "Passwords",
    how: "Workers never see passwords. Logins live in a vault and are checked daily.",
  },
  approval: {
    title: "What needs your yes",
    how: "Anything touching money, clients, logins or security waits for you.",
  },
});

type AreaChip = PersonRow["areas"][number];

const personName = (p: StatusData["people"][number]): string =>
  p.display_name || p.handle;

function titleCase(text: string): string {
  return text ? (text[0]?.toUpperCase() ?? "") + text.slice(1) : text;
}

/** "owner@example.com" -> "Owner"; "acme" -> "Acme (shared)". */
function ownerLabel(owner: string | undefined): string {
  if (!owner) return "—";
  return owner.includes("@")
    ? titleCase(owner.split("@")[0] ?? owner)
    : `${titleCase(owner)} (shared)`;
}

function loginCheck(
  config: StatusConfig,
  data: StatusData,
  now: Date,
): { pill: Pill; stat: string } {
  // The config says which job is the daily sign-in check; none named, no reading.
  const sensor = config.engine.security.login_check_sensor;
  const job = sensor
    ? (config.engine.workers
        .flatMap((w) => w.jobs)
        .find((j) => j.sensor === sensor) ?? { sensor, late_after: "26h" })
    : undefined;
  const rows = data.snapshot?.attrs.sensors?.jobs ?? [];
  if (!job || !findJob(job.sensor, rows)) {
    return { pill: pill("off", "No reading"), stat: "No reading yet" };
  }
  const state = stateOf(jobGauge(job, rows, now).light);
  return state === "good"
    ? { pill: pill("good", "On"), stat: "Daily check passed" }
    : { pill: pill(state, "Check"), stat: "Daily check needs a look" };
}

function buildPeople(data: StatusData): PersonRow[] {
  return data.people
    .filter((p) => p.email)
    .map((p) => ({
      name: personName(p),
      email: p.email ?? "",
      role: p.role === "administrator" ? "Owner" : "Member",
      active: p.active,
      areas: p.active
        ? data.areas.flatMap((a): AreaChip[] =>
            p.domains.includes(a.domain)
              ? [
                  {
                    domain: a.domain,
                    kind: "granted" as const,
                    locked: a.sensitive,
                  },
                ]
              : p.role === "administrator" && !a.sensitive
                ? [{ domain: a.domain, kind: "auto" as const, locked: false }]
                : [],
          )
        : [],
    }));
}

function buildSystems(config: StatusConfig, data: StatusData) {
  const connections: SystemRow[] = config.engine.knowledge.sources.map((s) => ({
    name: `${s.label} connection`,
    handle: null,
    what: s.connection
      ? `Reads ${s.connection}. Takes in only items marked ${config.engine.tag_prefix}[area]`
      : "Reads this source",
    pill: s.enabled ? pill("good", "Active") : pill("off", "Paused"),
    changed: ownerLabel(s.owner),
  }));
  const notes = config.engine.security.system_notes;
  const principals: SystemRow[] = data.people
    .filter((p) => !p.email)
    .map((p) => ({
      name: personName(p),
      handle: p.handle,
      what: notes[p.handle] ?? "Signs in to the Engine",
      pill: p.active ? pill("good", "Active") : pill("off", "Paused"),
      changed: formatDay(p.updated_at),
    }));
  const fixed: SystemRow[] = config.engine.security.systems_static.map((s) => ({
    name: s.name,
    handle: s.handle,
    what: s.what,
    pill: pill("good", "Active"),
    changed: "—",
  }));
  return { connections, systems: [...principals, ...fixed] };
}

export function buildSecurity(
  config: StatusConfig,
  data: StatusData,
  now: Date,
  page: PageAccess = {},
): SecurityModel {
  const sensors = data.snapshot?.attrs.sensors ?? null;
  const sec = sensors?.security ?? null;
  const needsYou = sensors?.needs_you ?? null;
  const people = buildPeople(data);
  const { connections, systems } = buildSystems(config, data);
  const login = loginCheck(config, data, now);

  const sentryPassed = sec
    ? Object.entries(sec.sentry.verdicts)
        .filter(([v]) => PASS_VERDICTS.has(v.toLowerCase()))
        .reduce((a, [, n]) => a + n, 0)
    : 0;
  const notTrusted = sec
    ? sec.tool_results.suspicious + sec.tool_results.fail
    : 0;
  const lockedCount = data.areas.filter((a) => a.sensitive).length;

  const dash = "—";
  const kpis = [
    {
      label: "Emails screened · 7 days",
      value: sec ? String(sec.sentry.count) : dash,
      sub: sec
        ? `${sentryPassed} passed · ${sec.sentry.count - sentryPassed} stopped`
        : "No reading yet",
      pill: null,
    },
    {
      label: "Outside content checked",
      value: sec ? String(sec.tool_results.count) : dash,
      sub: sec ? "" : "No reading yet",
      pill: sec
        ? notTrusted
          ? pill("warn", `${notTrusted} not trusted`)
          : pill("good", "All clear")
        : null,
    },
    {
      label: "Risky commands blocked",
      value: sec ? String(sec.tool_blocks.count) : dash,
      sub: sec ? "the guard said no" : "No reading yet",
      pill: null,
    },
    {
      label: "Login check",
      value:
        login.pill.state === "good"
          ? "Passed"
          : login.stat === "No reading yet"
            ? dash
            : "Check",
      sub: "every login still works, daily",
      pill: login.pill.state === "good" ? pill("good", "On") : null,
    },
  ];

  const LAYER_COPY = layerCopy(config.engine.tag_prefix);
  const layers: Layer[] = [
    {
      ...LAYER_COPY.access,
      pill: pill("good", "On"),
      stat: `${plural(people.length, "person", "people")} · ${plural(systems.length + connections.length, "system")} · ${plural(data.areas.length, "area")} (${lockedCount} locked)`,
      links: [
        { label: "People", route: "security-access" },
        { label: "Systems", route: "security-systems" },
      ],
    },
    {
      ...LAYER_COPY.intake,
      pill: sec ? pill("good", "On") : pill("off", "No reading"),
      stat: sec
        ? `${plural(sec.sentry.count, "email")} · ${sec.tool_results.count} results checked · ${sec.tool_results.suspicious} suspicious · ${sec.tool_results.fail} failed`
        : "No reading yet",
      links: [],
    },
    {
      ...LAYER_COPY.actions,
      pill: sec ? pill("good", "On") : pill("off", "No reading"),
      stat: sec
        ? `${sec.tool_blocks.count} commands blocked`
        : "No reading yet",
      links: [],
    },
    { ...LAYER_COPY.passwords, pill: login.pill, stat: login.stat, links: [] },
    {
      ...LAYER_COPY.approval,
      pill:
        needsYou == null
          ? pill("off", "No reading")
          : needsYou > 0
            ? pill("warn", "Waiting")
            : pill("good", "On"),
      stat:
        needsYou == null
          ? "No reading yet"
          : needsYou
            ? `${needsYou} waiting for you`
            : "Nothing waiting",
      links: [],
    },
  ];

  const worst = worstState(layers.map((l) => l.pill.state));
  const onCount = layers.filter((l) => l.pill.state === "good").length;

  return {
    kpis,
    layers,
    access: buildAccess(data, now, page),
    blocked: (sec?.tool_blocks.top_rules ?? []).map((r) => ({
      what: r.rule,
      times: r.count,
    })),
    people,
    connections,
    systems,
    badge:
      worst === "crit"
        ? pill("crit", "A layer needs a look")
        : worst === "warn"
          ? pill("warn", "Something waits for you")
          : onCount === layers.length
            ? pill("good", `All ${layers.length} layers on`)
            : pill("warn", `${onCount} of ${layers.length} layers reporting`),
  };
}
