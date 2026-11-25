import { applyPatches, type Patch } from "../entities/sections.js";
import type { DrawerDef } from "../entities/templates.js";

/**
 * Real pages, imported from a wiki, use their own headings ("Role &
 * Context", "Open Items"), not the template's ("Timeline", "Notes"). A patch
 * that names a section the page lacks is repaired instead of failing the
 * item: it becomes a new section, placed after the template's nearest earlier
 * section the page has, else after the page's last section. A patch that
 * still cannot apply is dropped alone, with the reason. Pure functions.
 *
 * Dated events have one home per page (rules.page_shape.events_sections:
 * "Key Interactions" on an imported page, else the template's "Timeline").
 * When the page has one, a patch to a section the page lacks goes there, and
 * a new "Timeline"-like section becomes lines in it. Without one, only a
 * section the template names may be added; any other unknown section is
 * refused (that patch alone).
 */

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const norm = (s: string): string => s.trim().toLowerCase();

type Heading = { readonly level: number; readonly name: string };

/** The page's headings below the title, in order. */
export function pageHeadings(body: string): readonly Heading[] {
  return body.split("\n").flatMap((l) => {
    const m = HEADING.exec(l);
    const level = (m?.[1] ?? "").length;
    return m && level >= 2 ? [{ level, name: (m[2] ?? "").trim() }] : [];
  });
}

/** Top-level section names (the shallowest heading level below the title). */
export function sectionNames(body: string): readonly string[] {
  const hs = pageHeadings(body);
  const top = Math.min(...hs.map((h) => h.level));
  return hs.filter((h) => h.level === top).map((h) => h.name);
}

const has = (body: string, name: string): boolean => pageHeadings(body).some((h) => norm(h.name) === norm(name));

/** Where dated events go and which headings only the Engine writes. */
export type EventsRule = {
  /** Event section names, most preferred first. */
  readonly sections: readonly string[];
  /** The Engine's own updates heading ("Major updates"): never a patch target. */
  readonly updatesHeading?: string;
};

/** Headings that mean "a dated log" whatever the page calls its own. */
const LOG_HEADINGS = new Set(["timeline", "history", "log", "events", "key events", "updates", "recent updates", "key interactions", "interactions", "activity", "changelog", "key dates"]);

/** The page's own events section, if it has one. */
export function eventsSection(body: string, rule: EventsRule | undefined): string | null {
  if (!rule) return null;
  const names = sectionNames(body);
  for (const want of rule.sections) {
    const hit = names.find((n) => norm(n) === norm(want));
    if (hit) return hit;
  }
  return null;
}

const isLog = (name: string, rule: EventsRule | undefined): boolean =>
  LOG_HEADINGS.has(norm(name)) || (rule?.sections ?? []).some((s) => norm(s) === norm(name)) ||
  (rule?.updatesHeading !== undefined && norm(rule.updatesHeading) === norm(name));

const inTemplate = (name: string, drawer: DrawerDef | undefined): boolean => (drawer?.sections ?? []).some((s) => norm(s) === norm(name));

class Refused extends Error {}

/** Where a missing section goes: the template's nearest earlier section on the page, else the last one. */
function anchorFor(body: string, missing: string, drawer: DrawerDef | undefined): string | null {
  const names = sectionNames(body);
  if (names.length === 0) return null;
  const order = drawer?.sections ?? [];
  const at = order.findIndex((s) => norm(s) === norm(missing));
  for (let i = at - 1; i >= 0; i -= 1) {
    const hit = names.find((n) => norm(n) === norm(order[i]!));
    if (hit) return hit;
  }
  return names[names.length - 1] ?? null;
}

function blockOf(p: Extract<Patch, { op: "append-bullet" | "append-paragraph" }>): string {
  return p.op === "append-bullet" ? `- ${p.text.trim()}` : p.text.trimEnd();
}

/** A bullet or paragraph patch's text as lines for the events section. */
function asEvent(text: string, section: string): Patch {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const bullets = lines.length > 0 && lines.every((l) => /^[-*]\s+/.test(l));
  return bullets && lines.length === 1
    ? { op: "append-bullet", section, text: lines[0]!.replace(/^[-*]\s+/, "") }
    : { op: "append-paragraph", section, text: text.trim() };
}

/** The patch rewritten to fit the page, or the patch unchanged when it already fits. Throws Refused. */
function fit(body: string, p: Patch, drawer: DrawerDef | undefined, rule?: EventsRule): Patch {
  const events = eventsSection(body, rule);
  const engineOwned = (name: string): boolean => rule?.updatesHeading !== undefined && norm(rule.updatesHeading) === norm(name);
  switch (p.op) {
    case "append-bullet":
    case "append-paragraph": {
      if (has(body, p.section) && !engineOwned(p.section)) return p;
      if (events) return { ...p, section: events };
      if (engineOwned(p.section)) throw new Refused(`"${p.section}" is written by the Engine`);
      if (rule && !inTemplate(p.section, drawer)) throw new Refused(`the page has no section "${p.section}"`);
      const after = anchorFor(body, p.section, drawer);
      return after ? { op: "new-section-after", after, heading: p.section.trim(), text: blockOf(p) } : p;
    }
    case "new-section-after": {
      if (rule && isLog(p.heading, rule)) {
        if (events) return asEvent(p.text ?? "", events);
        if (engineOwned(p.heading) || !inTemplate(p.heading, drawer)) throw new Refused(`no new "${p.heading}" section: dated events go in the page's own section`);
      }
      if (has(body, p.after)) return p;
      const after = anchorFor(body, p.heading, drawer);
      return after ? { ...p, after } : p;
    }
    case "replace-line": {
      if (!p.section || has(body, p.section)) return p;
      // The line is looked for on the whole page instead.
      return { op: "replace-line", old: p.old, new: p.new };
    }
  }
}

function describe(p: Patch): string {
  return p.op === "new-section-after" ? `new section "${p.heading}"` : `${p.op}${"section" in p && p.section ? ` in "${p.section}"` : ""}`;
}

export type Repaired = {
  readonly patches: readonly Patch[];
  readonly body: string;
  /** One line per patch dropped, with why. */
  readonly dropped: readonly string[];
  /** One line per patch that was rewritten to fit. */
  readonly repaired: readonly string[];
};

/** Apply patches one at a time, repairing each to fit the page; never throws. */
export function repairPatches(body: string, patches: readonly Patch[], drawer: DrawerDef | undefined, rule?: EventsRule): Repaired {
  return patches.reduce<Repaired>(
    (acc, p) => {
      try {
        const fitted = fit(acc.body, p, drawer, rule);
        const next = applyPatches(acc.body, [fitted]);
        const note = fitted === p ? [] : [`${describe(p)} became ${describe(fitted)}${fitted.op === "new-section-after" ? ` after "${fitted.after}"` : ""}`];
        return { ...acc, patches: [...acc.patches, fitted], body: next, repaired: [...acc.repaired, ...note] };
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return { ...acc, dropped: [...acc.dropped, `${describe(p)}: ${why}`] };
      }
    },
    { patches: [], body, dropped: [], repaired: [] },
  );
}
