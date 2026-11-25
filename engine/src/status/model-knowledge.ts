import type { StatusConfig } from "./config.js";
import {
  decodeEntities,
  pill,
  plural,
  sum,
  truncate,
  worstState,
  type Pill,
  type State,
} from "./model-shared.js";
import {
  tagBreakdown,
  unknownTagWarning,
  type TagBreakdown,
  type UnknownTagWarning,
} from "./model-tagging.js";
import {
  sensorKey,
  sourceGauge,
  type SourceLike,
  type StatusData,
} from "./readings.js";

/**
 * Knowledge menu: sources, the Search index, 14-day run history, areas and
 * the review queue. Every state is decided here; the browser only draws.
 */

export type Series = {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly changed: readonly number[];
  readonly minutes: readonly number[];
  readonly checked: readonly number[];
  readonly ok: readonly boolean[];
  readonly hasRuns: boolean;
};

export type SourceRow = {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly connection: string;
  readonly share: string;
  readonly note: string | null;
  readonly pill: Pill;
  readonly pages: number;
  /** How this source's topics were decided; null on an older database. */
  readonly tagging: TagBreakdown | null;
};

export type AreaRow = {
  readonly domain: string;
  readonly locked: boolean;
  readonly what: string;
  readonly items: number;
  readonly sources: readonly {
    readonly label: string;
    readonly color: string;
  }[];
  readonly who: readonly string[];
};

export type KnowledgeModel = {
  readonly kpis: {
    readonly pages: number;
    readonly approvedPercent: number;
    readonly changed: number;
    readonly runsOk: number;
    readonly runsTotal: number;
    readonly runsPill: Pill;
    readonly waiting: number;
  };
  readonly series: readonly Series[];
  readonly healthSeries: readonly Series[];
  readonly index: {
    readonly label: string;
    readonly pill: Pill;
    readonly note: string;
    readonly tagging: TagBreakdown | null;
  } | null;
  readonly sources: readonly SourceRow[];
  /** Set when any tag names a topic the config does not declare. */
  readonly unknownTags: UnknownTagWarning | null;
  readonly areas: readonly AreaRow[];
  readonly lockedNote: string | null;
  readonly review: {
    readonly pill: Pill;
    readonly rows: readonly {
      readonly title: string;
      readonly from: string;
      readonly area: string;
    }[];
  };
  readonly badge: Pill;
};

/** Chart colours are tokens (s-1..s-6); the stylesheet owns the actual colours. */
const colorAt = (i: number): string => `s-${(i % 6) + 1}`;

function buildSeries(
  id: string,
  label: string,
  color: string,
  key: string,
  days: readonly string[],
  data: StatusData,
): Series {
  const runs = data.runs_daily.filter((r) => r.source === key);
  const byDay = (day: string) => runs.find((r) => r.day === day);
  const pick = <T>(fn: (r: (typeof runs)[number]) => T, fallback: T): T[] =>
    days.map((d) => {
      const r = byDay(d);
      return r ? fn(r) : fallback;
    });
  return {
    id,
    label,
    color,
    changed: pick((r) => r.changed, 0),
    minutes: pick((r) => r.minutes, 0),
    checked: pick((r) => r.checked, 0),
    ok: pick((r) => r.ok, false),
    hasRuns: runs.length > 0,
  };
}

function trailingFails(ok: readonly boolean[]): number {
  let n = 0;
  for (let i = ok.length - 1; i >= 0 && !ok[i]; i--) n++;
  return n;
}

/** What the last 14 nights say, or null when the puller has never run. */
function runPill(series: Series): Pill | null {
  if (!series.hasRuns) return null;
  const last = series.ok[series.ok.length - 1];
  if (!last) {
    const n = trailingFails(series.ok);
    return pill(
      "crit",
      n >= series.ok.length
        ? `Failing all ${n} nights`
        : `Failing ${plural(n, "night")}`,
    );
  }
  const recent = series.ok.slice(-7).filter((x) => !x).length;
  return recent
    ? pill("warn", `Healthy now · ${recent} failed this week`)
    : pill("good", "Healthy");
}

/** Run history and the connector_state row, combined: the worse one wins. */
function partState(
  part: SourceLike,
  series: Series,
  data: StatusData,
  now: Date,
): Pill {
  if (part.enabled === false) return pill("off", "Off on purpose");
  const gauge = sourceGauge(part, data, now);
  const runs = runPill(series);
  if (gauge.light === "red") {
    return runs?.state === "crit" ? runs : pill("crit", gauge.detail);
  }
  if (gauge.light === "amber") return pill("warn", gauge.detail);
  if (runs) return runs;
  return gauge.light === "grey"
    ? pill("off", gauge.detail)
    : pill("good", "Healthy");
}

function canSee(
  person: StatusData["people"][number],
  area: StatusData["areas"][number],
): boolean {
  if (!person.active) return false;
  if (person.domains.includes(area.domain)) return true;
  return person.role === "administrator" && !area.sensitive;
}

function reviewFrom(data: StatusData, idToLabel: Map<string, string>) {
  return data.review_waiting.map((r) => ({
    title: decodeEntities(r.title ?? "Untitled"),
    from: idToLabel.get(r.source ?? "") ?? r.source ?? "Unknown",
    area: r.domains.length ? r.domains.join(", ") : "not sorted yet",
  }));
}

export function buildKnowledge(
  config: StatusConfig,
  data: StatusData,
  days: readonly string[],
  now: Date,
): KnowledgeModel {
  const k = config.engine.knowledge;
  const index = k.index;
  const indexSeries = index
    ? buildSeries(
        "index",
        index.label,
        colorAt(0),
        sensorKey(index.sensor),
        days,
        data,
      )
    : null;
  const allSources = k.sources.map((s, i) => ({
    source: s,
    series: buildSeries(
      s.id,
      s.label,
      colorAt(i + 1),
      sensorKey(s.sensor),
      days,
      data,
    ),
  }));
  const enabled = allSources.filter((x) => x.source.enabled);
  const series = enabled.map((x) => x.series);
  const healthSeries = indexSeries ? [...series, indexSeries] : series;

  const states = new Map(
    allSources.map((x) => [
      x.source.id,
      partState(x.source, x.series, data, now),
    ]),
  );
  const indexState =
    index && indexSeries ? partState(index, indexSeries, data, now) : null;

  const live = (key: string) =>
    data.documents.find((d) => d.source === key)?.live ?? 0;

  const pages = sum(data.documents.map((d) => d.live));
  const approvedPercent = pages
    ? Math.round((sum(data.documents.map((d) => d.approved)) / pages) * 100)
    : 0;
  const runsTotal = healthSeries.length * days.length;
  const runsOk = sum(healthSeries.map((s) => s.ok.filter(Boolean).length));
  const ratio = runsTotal ? runsOk / runsTotal : 0;

  const sourceRows: SourceRow[] = allSources.map(({ source, series: s }) => {
    const p = states.get(source.id) ?? pill("off", "No reading yet");
    return {
      id: source.id,
      label: source.label,
      color: s.color,
      connection: source.connection ?? "",
      share: source.share ?? "",
      note: source.enabled ? null : (source.off_reason ?? null),
      pill: p,
      pages: live(sensorKey(source.sensor)),
      tagging: tagBreakdown(data, sensorKey(source.sensor)),
    };
  });

  const keyToSource = new Map(
    allSources.map((x) => [sensorKey(x.source.sensor), x.series]),
  );
  const people = data.people.filter((p) => p.email);
  const areas: AreaRow[] = data.areas.map((a) => ({
    domain: a.domain,
    locked: a.sensitive,
    what: k.area_notes[a.domain] ?? "",
    items: a.items,
    sources: a.sources.flatMap((key) => {
      const s = keyToSource.get(key);
      return s ? [{ label: s.label, color: s.color }] : [];
    }),
    who: people
      .filter((p) => canSee(p, a))
      .map((p) => p.display_name || p.handle),
  }));
  const unclassified = data.areas.find((a) => a.domain === "unclassified");

  const sourceLabels = new Map(
    allSources.map((x) => [sensorKey(x.source.sensor), x.source.label]),
  );
  const waiting = data.review_undecided;

  const failing = [...states.values()].filter((p) => p.state === "crit");
  const badge: Pill =
    indexState?.state === "crit"
      ? pill("crit", `${index?.label ?? "Search index"} failing`)
      : failing.length
        ? pill("crit", `${plural(failing.length, "source")} failing`)
        : worstState([
              ...[...states.values()].map((p) => p.state),
              indexState?.state ?? "off",
            ]) === "warn"
          ? pill("warn", "Check sources")
          : pill("good", "Healthy");

  return {
    kpis: {
      pages,
      approvedPercent,
      changed: sum(series.map((s) => sum(s.changed))),
      runsOk,
      runsTotal,
      runsPill:
        ratio > 0.9
          ? pill("good", `${Math.round(ratio * 100)}%`)
          : ratio > 0.7
            ? pill("warn", `${Math.round(ratio * 100)}%`)
            : pill("crit", `${Math.round(ratio * 100)}%`),
      waiting,
    },
    series,
    healthSeries,
    index:
      index && indexSeries && indexState
        ? {
            label: index.label,
            pill: indexState,
            note: indexNote(data, sensorKey(index.sensor)),
            tagging: tagBreakdown(data, sensorKey(index.sensor)),
          }
        : null,
    sources: sourceRows,
    unknownTags: unknownTagWarning(
      data,
      (key) =>
        sourceLabels.get(key) ??
        (index && sensorKey(index.sensor) === key ? index.label : key),
    ),
    areas,
    lockedNote:
      unclassified?.sensitive && unclassified.items > 0
        ? `${unclassified.items} unclassified pages are locked on purpose: the Engine never guesses who should see something.`
        : null,
    review: {
      pill: waiting
        ? pill("warn", `${waiting} waiting`)
        : pill("good", "Nothing waiting"),
      rows: reviewFrom(data, sourceLabels),
    },
    badge,
  };
}

function indexNote(data: StatusData, key: string): string {
  const base = "Copies every Knowledge page into search each night.";
  const error = data.connectors.find((c) => c.source === key)?.last_error;
  return error
    ? `${base} Last problem: ${truncate(decodeEntities(error), 180)}`
    : base;
}

export type { State };
