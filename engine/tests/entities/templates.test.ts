import { describe, it, expect } from "vitest";
import {
  BASE_DRAWERS,
  TEMPLATE_NAMES,
  allDrawerIds,
  entitySchema,
  loadTemplates,
} from "../../src/entities/templates.js";
import { ICON_NAMES } from "../../src/app/icons.js";

describe("entity templates", () => {
  it("ships the base drawers and five business templates", () => {
    expect([...TEMPLATE_NAMES].sort()).toEqual(
      ["base", "consulting", "field-service", "membership-org", "property", "solo"].sort(),
    );
    expect(BASE_DRAWERS).toEqual([
      "people",
      "organisations",
      "projects",
      "meetings",
      "decisions",
      "concepts",
      "research",
      "playbooks",
    ]);
  });

  it("every template file parses and every list view names a real field", () => {
    for (const t of loadTemplates().values()) {
      for (const d of t.drawers) {
        const names = new Set(d.fields.map((f) => f.name));
        for (const v of d.list_views) {
          if (v.sort) expect(names.has(v.sort), `${t.name}/${d.id} sort ${v.sort}`).toBe(true);
          if (v.filter) expect(names.has(v.filter), `${t.name}/${d.id} filter ${v.filter}`).toBe(true);
        }
        for (const f of [...d.update_rules.auto, ...d.update_rules.needs_yes]) {
          expect(names.has(f), `${t.name}/${d.id} rule ${f}`).toBe(true);
        }
      }
    }
  });

  it("composes base plus the chosen templates, first definition of a drawer wins", () => {
    const s = entitySchema(["consulting", "property"]);
    expect(s.templates).toEqual(["base", "consulting", "property"]);
    expect(s.drawers.map((d) => d.id)).toEqual([
      ...BASE_DRAWERS,
      "deals",
      "offers",
      "properties",
      "vendors",
    ]);
    expect(entitySchema(["solo"]).drawers).toHaveLength(8);
  });

  it("refuses an unknown template name", () => {
    expect(() => entitySchema(["nope"])).toThrow(/Unknown template/);
  });

  it("knows every drawer any template defines", () => {
    const ids = allDrawerIds();
    for (const id of ["people", "deals", "sites", "vendors", "properties", "programs", "offers"]) {
      expect(ids.has(id)).toBe(true);
    }
    expect(ids.has("leases")).toBe(false);
  });

  it("every drawer names a real icon and links only to drawers that exist", () => {
    const ids = allDrawerIds();
    for (const t of loadTemplates().values()) {
      for (const d of t.drawers) {
        expect(d.icon, `${t.name}/${d.id} icon`).toBeDefined();
        expect(ICON_NAMES.has(d.icon ?? ""), `${t.name}/${d.id} icon ${d.icon}`).toBe(true);
        for (const to of d.curator?.links_to ?? []) {
          expect(ids.has(to), `${t.name}/${d.id} links_to ${to}`).toBe(true);
        }
      }
    }
  });

  it("the deal rule is template config, not code", () => {
    for (const name of ["consulting", "membership-org"]) {
      const deals = loadTemplates().get(name)?.drawers.find((d) => d.id === "deals");
      expect(deals?.signals.join(" ")).toMatch(/budget, price, fee or value/);
      expect(deals?.curator?.links_to).toEqual(expect.arrayContaining(["organisations", "people"]));
    }
  });

  it("a source-id key rule names the sources whose items carry that key", () => {
    const meetings = entitySchema([]).drawers.find((d) => d.id === "meetings");
    expect(meetings?.key_rule.kind).toBe("source_id");
    expect(meetings?.key_rule.sources).toEqual(expect.arrayContaining(["fireflies", "calendar"]));
  });
});
