/**
 * The body of two pages merged into one (the owner's Merge on "Possible
 * duplicates"). Pure. The kept page's text stays as it is; each "## "
 * section of the other page is added: its lines go under the kept page's
 * section of the same name (lines already there are skipped), and a section
 * the kept page lacks is added at the end. The other page's title heading
 * and any text before its first section go under "## Merged from <title>".
 */

const H2 = /^##\s+(.*?)\s*#*\s*$/;

type Section = { readonly heading: string; readonly lines: readonly string[] };

function split(body: string): { readonly head: readonly string[]; readonly sections: readonly Section[] } {
  const head: string[] = [];
  const sections: Array<{ heading: string; lines: string[] }> = [];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const m = H2.exec(line);
    if (m) sections.push({ heading: (m[1] ?? "").trim(), lines: [] });
    else if (sections.length > 0) sections[sections.length - 1]!.lines.push(line);
    else head.push(line);
  }
  return { head, sections };
}

const trimEnds = (lines: readonly string[]): string[] => {
  const out = [...lines];
  while (out.length > 0 && out[0]!.trim() === "") out.shift();
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out;
};

const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

export function mergeBodies(keepBody: string, dropBody: string, dropTitle: string): string {
  const keep = split(keepBody);
  const drop = split(dropBody);
  const sections = keep.sections.map((s) => ({ heading: s.heading, lines: trimEnds(s.lines) }));
  const seen = new Set(sections.flatMap((s) => s.lines).map(norm).filter((l) => l !== ""));
  const intro = trimEnds(drop.head.filter((l) => !/^#\s/.test(l)));
  const incoming: Section[] = [
    ...(intro.length > 0 ? [{ heading: `Merged from ${dropTitle.trim()}`, lines: intro }] : []),
    ...drop.sections,
  ];
  for (const s of incoming) {
    const fresh = trimEnds(s.lines).filter((l) => l.trim() === "" || !seen.has(norm(l)));
    fresh.forEach((l) => seen.add(norm(l)));
    if (trimEnds(fresh).length === 0) continue;
    const at = sections.findIndex((x) => norm(x.heading) === norm(s.heading));
    if (at === -1) sections.push({ heading: s.heading, lines: trimEnds(fresh) });
    else sections[at] = { heading: sections[at]!.heading, lines: [...sections[at]!.lines, ...trimEnds(fresh)] };
  }
  const head = trimEnds(keep.head);
  return [
    ...head,
    ...sections.flatMap((s) => ["", `## ${s.heading}`, ...s.lines]),
    "",
  ].join("\n").replace(/^\n+/, "");
}
