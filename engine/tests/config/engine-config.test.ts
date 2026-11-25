import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  EngineConfigError,
  UNCLASSIFIED,
  effectiveDomains,
  ownerEmails,
  parseEngineConfig,
  validateEngineConfig,
} from "../../src/config/engine-config.js";

const EXAMPLE = readFileSync(
  new URL("../../../config/engine.example.yaml", import.meta.url),
  "utf8",
);

/** The example as a plain object, with one change applied to a copy. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

function example(change: (raw: Loose) => void = () => {}): unknown {
  const raw = parse(EXAMPLE) as Loose;
  change(raw);
  return raw;
}

describe("engine config", () => {
  it("accepts config/engine.example.yaml", () => {
    const cfg = parseEngineConfig(EXAMPLE);
    expect(cfg.engine.id).toBe("acme");
    expect(cfg.engine.owner.email).toBe("owner@example.com");
    expect(cfg.domains.map((d) => d.id)).toEqual([
      "consulting",
      "properties",
      "private",
    ]);
    expect(cfg.sources.wiki.repo).toBe("acme/knowledge");
  });

  it("applies defaults to a minimal file", () => {
    const cfg = validateEngineConfig({
      version: 1,
      engine: { id: "t", name: "T", owner: { email: "o@example.com" } },
    });
    expect(cfg.tagging).toEqual({ prefix: "kx/", frontmatter_key: "domains" });
    expect(cfg.sources.wiki.enabled).toBe(false);
    expect(cfg.sources.fireflies.shared_meetings.enabled).toBe(false);
    expect(cfg.support.care_plan.enabled).toBe(false);
    expect(cfg.dashboard).toBeUndefined();
  });

  it("requires engine.owner.email", () => {
    expect(() =>
      validateEngineConfig(example((r) => delete r["engine"].owner.email)),
    ).toThrow(/engine\.owner\.email/);
  });

  it("rejects duplicate topic ids", () => {
    const bad = example((r) =>
      r["domains"].push({ id: "consulting", label: "Again" }),
    );
    expect(() => validateEngineConfig(bad)).toThrow(/declared twice/);
  });

  it("reserves unclassified, and always includes it", () => {
    const bad = example((r) =>
      r["domains"].push({ id: UNCLASSIFIED, label: "Mine" }),
    );
    expect(() => validateEngineConfig(bad)).toThrow(/reserved/);

    const all = effectiveDomains(parseEngineConfig(EXAMPLE));
    expect(all.at(-1)).toEqual({
      id: UNCLASSIFIED,
      label: "Unclassified",
      sensitive: true,
    });
  });

  it("rejects a default_domain that is not a declared topic", () => {
    for (const source of ["wiki", "drive", "fireflies"]) {
      const bad = example((r) => {
        r["sources"][source].default_domain = "nope";
      });
      expect(() => validateEngineConfig(bad)).toThrow(
        new RegExp(`sources\\.${source}\\.default_domain: "nope"`),
      );
    }
  });

  it("drive tag trust defaults to owner and takes two values", () => {
    expect(validateEngineConfig(example()).sources.drive.trust_tags_from).toBe("owner");
    const anyone = example((r) => {
      r["sources"].drive.trust_tags_from = "anyone";
    });
    expect(validateEngineConfig(anyone).sources.drive.trust_tags_from).toBe("anyone");
    for (const bad of ["everyone", "Owner", "", 1, null]) {
      const raw = example((r) => {
        r["sources"].drive.trust_tags_from = bad;
      });
      expect(() => validateEngineConfig(raw)).toThrow(/sources\.drive\.trust_tags_from/);
    }
  });

  it("drive file kinds allow pdf but do not default to it", () => {
    const minimal = example((r) => {
      delete r["sources"].drive.include_mime;
    });
    expect(validateEngineConfig(minimal).sources.drive.include_mime).toEqual([
      "docs",
      "sheets",
      "slides",
    ]);
    const pdf = example((r) => {
      r["sources"].drive.include_mime = ["docs", "pdf"];
    });
    expect(validateEngineConfig(pdf).sources.drive.include_mime).toEqual(["docs", "pdf"]);
    const bad = example((r) => {
      r["sources"].drive.include_mime = ["video"];
    });
    expect(() => validateEngineConfig(bad)).toThrow(/include_mime/);
  });

  it("rejects a channel mapped to a topic that is not declared", () => {
    const bad = example((r) => {
      r["sources"].fireflies.channels = { Sales: "nope" };
    });
    expect(() => validateEngineConfig(bad)).toThrow(/channels\.Sales: "nope"/);
    const ok = example((r) => {
      r["sources"].fireflies.channels = { Sales: "consulting" };
    });
    expect(() => validateEngineConfig(ok)).not.toThrow();
  });

  it("requires a prefix that ends in a separator", () => {
    for (const prefix of ["", "kx", "kx1"]) {
      const bad = example((r) => {
        r["tagging"].prefix = prefix;
      });
      expect(() => validateEngineConfig(bad)).toThrow(/prefix/);
    }
    for (const prefix of ["kx/", "topic-", "t:"]) {
      const ok = example((r) => {
        r["tagging"].prefix = prefix;
        r["sources"].gmail.prefix = prefix;
      });
      expect(() => validateEngineConfig(ok)).not.toThrow();
    }
    const badMail = example((r) => {
      r["sources"].gmail.prefix = "mail";
    });
    expect(() => validateEngineConfig(badMail)).toThrow(/prefix/);
  });

  it("gmail is off, with no mailbox named, by default", () => {
    const cfg = validateEngineConfig(example());
    expect(cfg.sources.gmail.enabled).toBe(false);
    expect(cfg.sources.gmail.mailboxes).toEqual([]);
  });

  it("accepts one gmail mailbox, lower-cased, owner optional", () => {
    const cfg = validateEngineConfig(
      example((r) => {
        r["sources"].gmail.mailboxes = [
          { email: "Shared@Example.com", owner_email: "Pat@Example.com" },
        ];
      }),
    );
    expect(cfg.sources.gmail.mailboxes).toEqual([
      { email: "shared@example.com", owner_email: "pat@example.com" },
    ]);
    const ownerless = validateEngineConfig(
      example((r) => {
        r["sources"].gmail.mailboxes = [{ email: "shared@example.com" }];
      }),
    );
    expect(ownerless.sources.gmail.mailboxes).toEqual([
      { email: "shared@example.com", owner_email: null },
    ]);
  });

  it("rejects a bad gmail mailbox list", () => {
    const bad = (mailboxes: unknown) =>
      example((r) => {
        r["sources"].gmail.mailboxes = mailboxes;
      });
    const cases: [unknown, RegExp][] = [
      [[{ email: "not-an-address" }], /mailboxes\.0\.email/],
      [
        [{ email: "a@example.com", owner_email: "nope" }],
        /mailboxes\.0\.owner_email/,
      ],
      [[{ owner_email: "a@example.com" }], /mailboxes\.0\.email/],
      [[{ email: "a@example.com", token: "x" }], /mailboxes\.0/],
      ["a@example.com", /sources\.gmail\.mailboxes/],
      [
        [{ email: "a@example.com" }, { email: "b@example.com" }],
        /one mailbox is supported/,
      ],
    ];
    for (const [mailboxes, problem] of cases) {
      expect(() => validateEngineConfig(bad(mailboxes))).toThrow(problem);
    }
  });

  it("requires a repo when the wiki source is on", () => {
    const bad = example((r) => {
      r["sources"].wiki.repo = null;
    });
    expect(() => validateEngineConfig(bad)).toThrow(/sources\.wiki\.repo/);
  });

  it("rejects keys it does not know", () => {
    const bad = example((r) => {
      r["sorces"] = {};
    });
    expect(() => validateEngineConfig(bad)).toThrow(EngineConfigError);
  });

  it("rejects text that is not YAML", () => {
    expect(() => parseEngineConfig("engine: [")).toThrow(EngineConfigError);
  });

  it("lists every owner address once, sign-in address first", () => {
    const cfg = validateEngineConfig(
      example((r) => {
        r["engine"].owner.emails = ["Owner@Example.com", "me@example.org"];
      }),
    );
    expect(ownerEmails(cfg)).toEqual(["owner@example.com", "me@example.org"]);
  });
});
