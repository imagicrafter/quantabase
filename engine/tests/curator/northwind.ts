import { item } from "./fixtures.js";

/**
 * The exact email from the 2026-11-20 G1 live curator run (test domain), and
 * the multi-entity plan a good model returns for it. Also the prompt-eval
 * fixture for fan-out: one item, four entities, linked.
 */

export const NORTHWIND_EMAIL = item({
  id: "item-nw",
  source_id: "thread-nw",
  title: "Northwind Logistics pilot - SOW",
  body:
    "From: pat.rivera@northwind-test.com\nTo: owner@example.com\nSubject: Northwind Logistics pilot - SOW\n\n" +
    "Hi,\n\nNorthwind Logistics would like to run a 6-week pilot starting December 1. Our budget is $12,000. " +
    "I will lead it on our side as COO. Could you send the SOW by November 25?\n\nThanks,\nPat Rivera\nCOO, Northwind Logistics",
  source_created_at: "2026-11-20T09:00:00Z",
  received_at: "2026-11-20T09:01:00Z",
});

const PERSON = "pat.rivera@northwind-test.com";
const ORG = "northwind-test.com";
const PROJECT = "project:northwind-pilot";
const DEAL = "deal:northwind-test.com-pilot";

/** What the eval expects: the drawer each key lands in, and whether it waits for a yes. */
export const NORTHWIND_EXPECTED = [
  { key: PERSON, drawer: "people", queued: false },
  { key: ORG, drawer: "organisations", queued: false },
  { key: PROJECT, drawer: "projects", queued: false },
  { key: DEAL, drawer: "deals", queued: false },
] as const;

export const NORTHWIND_PLAN = {
  updates: [] as Array<Record<string, unknown>>,
  new_pages: [
    {
      drawer: "people", key: PERSON, title: "Pat Rivera", description: "COO of Northwind Logistics; leads the pilot.",
      fields: { organisation: ORG, role: "COO", last_contact: "2026-11-20", next_step: "Send the SOW", next_date: "2026-11-25" },
      related: [ORG, PROJECT, DEAL],
      sections: [
        { heading: "Summary", text: "COO of Northwind Logistics and their lead for the 6-week pilot." },
        { heading: "Timeline", text: "- 2026-11-20: asked for a SOW by 2026-11-25 for a 6-week pilot from 2026-12-01." },
      ],
    },
    {
      drawer: "organisations", key: ORG, title: "Northwind Logistics", description: "Prospect running a 6-week pilot.",
      fields: { role: "prospect", last_contact: "2026-11-20", next_step: "Send the SOW", next_date: "2026-11-25" },
      related: [PERSON, PROJECT, DEAL],
      sections: [
        { heading: "Summary", text: "Logistics company; Pat Rivera (COO) leads a 6-week pilot." },
        { heading: "Timeline", text: "- 2026-11-20: asked for a 6-week pilot from 2026-12-01 with a $12,000 budget." },
      ],
    },
    {
      drawer: "projects", key: PROJECT, title: "Northwind Logistics pilot", description: "6-week pilot from 2026-12-01.",
      fields: { organisation: ORG, status: "proposed", start_date: "2026-12-01", next_step: "Send the SOW by 2026-11-25" },
      related: [PERSON, ORG, DEAL],
      sections: [
        { heading: "Summary", text: "A 6-week pilot for Northwind Logistics starting 2026-12-01, led by Pat Rivera." },
        { heading: "Timeline", text: "- 2026-11-20: Pat asked for the SOW by 2026-11-25, so the pilot can start 2026-12-01." },
      ],
    },
    {
      drawer: "deals", key: DEAL, title: "Northwind Logistics pilot deal", description: "$12,000 pilot; SOW due 2026-11-25.",
      fields: { organisation: ORG, stage: "lead", value: 12000, next_step: "Send the SOW", next_date: "2026-11-25", last_contact: "2026-11-20" },
      related: [PERSON, ORG, PROJECT],
      sections: [
        { heading: "Summary", text: "Pilot with a $12,000 budget." },
        { heading: "Timeline", text: "- 2026-11-20: Pat Rivera asked for the SOW by 2026-11-25." },
      ],
    },
  ],
  notes: "",
};
