import { ago, type Light } from "./readings.js";

/**
 * Pieces every dashboard menu shares: the four states, the pill, the 14-day
 * window and the small text helpers. Pure; nothing here reads the network.
 */

export type State = "good" | "warn" | "crit" | "off";
export type Pill = { readonly state: State; readonly text: string };

export const TIME_ZONE = "America/Chicago";
export const WINDOW_DAYS = 14;

const LIGHT_TO_STATE: Record<Light, State> = {
  green: "good",
  amber: "warn",
  red: "crit",
  grey: "off",
};

export const stateOf = (light: Light): State => LIGHT_TO_STATE[light];

export const pill = (state: State, text: string): Pill => ({ state, text });

const STATE_RANK: Record<State, number> = { off: 0, good: 1, warn: 2, crit: 3 };

/** Worst of the given states; "off" only when nothing else is present. */
export function worstState(states: readonly State[]): State {
  return states.reduce<State>(
    (acc, s) => (STATE_RANK[s] > STATE_RANK[acc] ? s : acc),
    "off",
  );
}

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD in the Engine's time zone. */
export function chicagoDay(date: Date): string {
  return dayFormat.format(date);
}

/** The last WINDOW_DAYS calendar days, oldest first, ending today. */
export function windowDays(now: Date): readonly string[] {
  const today = new Date(`${chicagoDay(now)}T12:00:00Z`);
  return Array.from({ length: WINDOW_DAYS }, (_, i) => {
    const d = new Date(today.getTime() - (WINDOW_DAYS - 1 - i) * 86_400_000);
    return d.toISOString().slice(0, 10);
  });
}

const whenFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const shortFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  month: "short",
  day: "numeric",
});

/** "Nov 6, 4:55 PM", or "unknown" when there is no usable time. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown" : whenFormat.format(d);
}

/** "Oct 28", or a dash when there is no usable time. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : shortFormat.format(d);
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/** Titles are stored HTML-escaped; the browser escapes again, so undo it once. */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
}

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

export const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export const sum = (values: readonly number[]): number =>
  values.reduce((a, b) => a + b, 0);

export { ago };
