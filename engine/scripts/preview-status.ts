/**
 * Dev-only: render the dashboard from the test fixture into one self-contained
 * HTML file (CSS and JS inlined) for screenshot checks. Never deployed.
 *
 *   npx tsx scripts/preview-status.ts [out.html] [fixture.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fullStatusConfig } from "../tests/status/fixtures/config.js";
import { buildModel } from "../src/status/model.js";
import { renderPage } from "../src/status/page.js";
import { StatusDataSchema } from "../src/status/readings.js";

const here = (path: string) => new URL(path, import.meta.url);
const out = process.argv[2] ?? "/tmp/engine-status-preview.html";
const fixture =
  process.argv[3] ?? here("../tests/status/fixtures/readings.json");

const raw: unknown = JSON.parse(readFileSync(fixture, "utf8"));
const now = new Date("2026-11-07T18:00:00Z");
// What the route passes when the page is reached through its own sign-in app.
const page = {
  host: "engine.example.com",
  level: "people",
  ownSignInApp: true,
};
const model = buildModel(
  fullStatusConfig(),
  StatusDataSchema.parse(raw),
  now,
  page,
);

const css = readFileSync(here("../public/status/dashboard.css"), "utf8");
const js = readFileSync(here("../public/status/dashboard.js"), "utf8");
const html = renderPage(model, "preview", "owner@example.com")
  .replace(/<link rel="stylesheet"[^>]*>/, () => `<style>${css}</style>`)
  .replace(
    /<script src="[^"]*" defer><\/script>/,
    () => `<script>${js}</script>`,
  );

writeFileSync(out, html);
process.stdout.write(`wrote ${out}\n`);
