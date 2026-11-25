/* Engine dashboard: draws the model the server embedded in #engine-data.
   The server decides every state, label and number. This file only draws,
   escapes every string it inserts, and handles menus, charts and the theme.
   View-only: the buttons copy a ready-made request to paste into Claude. */
(function () {
  "use strict";

  /* ---------- Data and helpers ---------- */
  let M;
  try {
    M = JSON.parse(document.getElementById("engine-data").textContent);
  } catch (_) {
    document.getElementById("page").innerHTML =
      '<div class="empty">The dashboard data could not be read. Reload the page.</div>';
    return;
  }
  const DAYS = M.days;
  const K = M.knowledge,
    W = M.workers,
    T = M.tools,
    S = M.security,
    U = M.support;

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const day = (iso) =>
    new Date(iso + "T12:00:00").toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  const fill = (s) => `var(--${s.color})`;
  const bg = (s) => `bg-${s.color}`;
  const ICON = {
    good: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2l2.3 2.3 4.7-4.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    crit: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    warn: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2.5v4.2M6 9.2v.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    off: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 6h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  };
  const pill = (p) =>
    `<span class="pill ${esc(p.state)}">${ICON[p.state] || ICON.off}${esc(p.text)}</span>`;
  const n = (v) => (typeof v === "number" ? v.toLocaleString() : esc(v));

  /* ---------- Charts (SVG, one scale each) ---------- */
  function niceMax(v) {
    if (v <= 5) return 5;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    return Math.ceil(v / p) * p;
  }

  function stackedBars(el, series, key, unit) {
    const W_ = Math.max(300, Math.min(1100, el.clientWidth || 680)),
      H = 230,
      L = 34,
      R = 22,
      T_ = 16,
      B = 26;
    const every = W_ < 480 ? 4 : 2;
    const totals = DAYS.map((_, i) => sum(series.map((s) => s[key][i])));
    const max = niceMax(Math.max(0, ...totals));
    const step = (W_ - L - R) / DAYS.length,
      bw = Math.min(28, step * 0.62);
    const y = (v) => T_ + (H - T_ - B) * (1 - v / max);
    let g = "";
    [0, max / 2, max].forEach((t) => {
      g += `<line x1="${L}" x2="${W_ - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${+t.toFixed(1)}</text>`;
    });
    DAYS.forEach((d, i) => {
      const x = L + step * i + (step - bw) / 2;
      let base = 0;
      const segs = series
        .map((s) => ({ s, v: s[key][i] }))
        .filter((p) => p.v > 0);
      segs.forEach((p, j) => {
        const y0 = y(base),
          y1 = y(base + p.v);
        base += p.v;
        const h = Math.max(0, y0 - y1 - (j < segs.length - 1 ? 2 : 0));
        const top = j === segs.length - 1;
        g +=
          top && h >= 8
            ? `<path d="M${x},${y0} V${y0 - h + 4} q0,-4 4,-4 h${bw - 8} q4,0 4,4 V${y0} Z" fill="${fill(p.s)}"/>`
            : `<rect x="${x}" y="${y0 - h}" width="${bw}" height="${h}" fill="${fill(p.s)}"/>`;
      });
      if (totals[i] > 0 && totals[i] === Math.max(...totals))
        g += `<text class="val" x="${x + bw / 2}" y="${y(totals[i]) - 5}" text-anchor="middle">${+totals[i].toFixed(1)}</text>`;
      if (
        i === DAYS.length - 1 ||
        (i % every === 0 && DAYS.length - 1 - i >= Math.ceil(every * 0.75))
      )
        g += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="${i === DAYS.length - 1 ? "end" : "middle"}">${day(d)}</text>`;
      g += `<rect class="hit" data-i="${i}" x="${L + step * i}" y="${T_}" width="${step}" height="${H - T_ - B}" fill="transparent"/>`;
    });
    el.innerHTML = `<svg viewBox="0 0 ${W_} ${H}" role="img" aria-label="Stacked bars per day">${g}</svg><div class="tip" hidden></div>`;
    hover(
      el,
      (i) =>
        `<b>${day(DAYS[i])}</b>` +
        series
          .map(
            (s) =>
              `<div><span><i class="${bg(s)}"></i>${esc(s.label)}</span><span>${+s[key][i].toFixed(1)}${unit}</span></div>`,
          )
          .join("") +
        `<div><span class="muted">Total</span><span>${+totals[i].toFixed(1)}${unit}</span></div>`,
    );
  }

  function healthGrid(el, series) {
    const W_ = Math.max(300, Math.min(1100, el.clientWidth || 680)),
      rowH = 30,
      L = W_ < 480 ? 74 : 96,
      T_ = 6,
      B = 22,
      H = T_ + rowH * series.length + B;
    const every = W_ < 480 ? 4 : 2;
    const step = (W_ - L - 8) / DAYS.length,
      sz = Math.min(22, step - 4);
    let g = "";
    series.forEach((s, r) => {
      const cy = T_ + r * rowH;
      g += `<text x="0" y="${cy + rowH / 2 + 4}">${esc(s.label)}</text>`;
      s.ok.forEach((ok, i) => {
        const x = L + step * i + (step - sz) / 2,
          yy = cy + (rowH - sz) / 2,
          c = ok ? "var(--good)" : "var(--crit)";
        g += `<rect x="${x}" y="${yy}" width="${sz}" height="${sz}" rx="4" fill="${c}" opacity="${ok ? 0.85 : 1}"/>`;
        g += ok
          ? `<path d="M${x + 6} ${yy + sz / 2} l3.5 3.5 l6 -7" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
          : `<path d="M${x + 7} ${yy + 7} l${sz - 14} ${sz - 14} M${x + sz - 7} ${yy + 7} l-${sz - 14} ${sz - 14}" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`;
        g += `<rect class="hit" data-i="${r * 100 + i}" x="${L + step * i}" y="${cy}" width="${step}" height="${rowH}" fill="transparent"/>`;
      });
    });
    DAYS.forEach((d, i) => {
      if (
        i === DAYS.length - 1 ||
        (i % every === 0 && DAYS.length - 1 - i >= Math.ceil(every * 0.75))
      )
        g += `<text x="${L + step * i + step / 2}" y="${H - 6}" text-anchor="${i === DAYS.length - 1 ? "end" : "middle"}">${day(d)}</text>`;
    });
    el.innerHTML = `<svg viewBox="0 0 ${W_} ${H}" role="img" aria-label="Nightly run results">${g}</svg><div class="tip" hidden></div>`;
    hover(el, (k) => {
      const s = series[Math.floor(k / 100)],
        i = k % 100;
      return `<b>${esc(s.label)} · ${day(DAYS[i])}</b><div><span>${s.ok[i] ? "Run succeeded" : "Run failed or did not run"}</span></div><div><span class="muted">Checked</span><span>${s.checked[i]}</span></div><div><span class="muted">Added or changed</span><span>${s.changed[i]}</span></div>`;
    });
  }

  function hover(el, html) {
    const tip = $(".tip", el);
    el.addEventListener("pointermove", (e) => {
      const t = e.target.closest(".hit");
      if (!t) {
        tip.hidden = true;
        return;
      }
      tip.innerHTML = html(+t.dataset.i);
      tip.hidden = false;
      const r = el.getBoundingClientRect(),
        x = e.clientX - r.left + el.scrollLeft,
        w = tip.offsetWidth;
      tip.style.left =
        Math.min(Math.max(4, x + 14), el.scrollWidth - w - 4) + "px";
      tip.style.top = Math.max(0, e.clientY - r.top - 20) + "px";
    });
    el.addEventListener("pointerleave", () => {
      tip.hidden = true;
    });
  }

  function tableView(series, key, unit) {
    return `<div class="table-wrap"><table><thead><tr><th>Day</th>${series.map((s) => `<th class="num">${esc(s.label)}</th>`).join("")}<th class="num">Total</th></tr></thead><tbody>${DAYS.map((d, i) => `<tr><td>${day(d)}</td>${series.map((s) => `<td class="num">${+s[key][i].toFixed(1)}</td>`).join("")}<td class="num">${+sum(series.map((s) => s[key][i])).toFixed(1)}${unit}</td></tr>`).join("")}</tbody></table></div>`;
  }

  /* ---------- Reusable page parts ---------- */
  const legend = (series) =>
    `<div class="legend">${series.map((s) => `<span><i class="${bg(s)}"></i>${esc(s.label)}</span>`).join("")}</div>`;
  const kpi = (label, value, sub) =>
    `<div class="kpi"><span class="label">${esc(label)}</span><span class="value">${value}</span><span class="sub">${sub || ""}</span></div>`;
  const header = (title, explain, badge) =>
    `<div class="page-head"><div><h2>${esc(title)}</h2><p>${esc(explain)}</p></div>${badge ? pill(badge) : ""}</div>`;
  const table = (heads, rows) =>
    `<div class="table-wrap"><table><thead><tr>${heads.map(([h, c]) => `<th${c ? ` class="${c}"` : ""}>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  const ask = (label, request) =>
    M.askClaude
      ? `<button class="btn" type="button" data-ask="${esc(request)}">${esc(label)}</button>`
      : "";
  const tellClaude = (text) =>
    M.askClaude
      ? `<p class="note">To change this, tell Claude: <i>"${esc(text)}"</i></p>`
      : "";
  const sub = (text) => `<div class="muted small">${esc(text)}</div>`;
  /* How a source's topics were decided, as one short line; "" on an older database. */
  function tagLine(t) {
    if (!t) return "";
    if (!t.total) return sub("No documents yet");
    const tagged = t.onItem + t.byContainer + t.byDefault;
    const how = [
      t.onItem ? `${n(t.onItem)} on the item` : "",
      t.byContainer ? `${n(t.byContainer)} from a folder or channel` : "",
      t.byDefault ? `${n(t.byDefault)} by the source default` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return `<div class="small"><b>${n(tagged)}</b> tagged${how ? `<span class="muted"> (${how})</span>` : ""}</div>
      <div class="small"><b>${n(t.untagged)}</b> untagged <span class="muted">(owner-only)</span></div>${
        t.notRecorded
          ? `<div class="small muted">${n(t.notRecorded)} not counted until the next run</div>`
          : ""
      }${t.unknown ? `<div class="small warn-text">${n(t.unknown)} with an unknown tag</div>` : ""}`;
  }
  const warnRow = (text) =>
    `<div class="warn-row" role="status">${ICON.warn}<span>${esc(text)}</span></div>`;
  function chartCard(id, title, explain, series) {
    return `<section class="card"><div class="card-head"><div><h3>${esc(title)}</h3><p class="explain">${esc(explain)}</p></div><button class="toggle" type="button" data-table="${id}">Show as table</button></div>${legend(series)}<div class="chart" id="${id}"></div></section>`;
  }

  /* ---- KNOWLEDGE ---- */
  function knowledgeOverview() {
    const k = K.kpis,
      hasReview = M.menus.some((m) =>
        m.tabs.some((t) => t.route === "knowledge-review"),
      );
    const index = K.index
      ? `<section class="card"><div class="card-head"><div><h3>${esc(K.index.label)}</h3><p class="explain">${esc(K.index.note)}</p>${tagLine(K.index.tagging)}</div>${pill(K.index.pill)}</div></section>`
      : "";
    return `<div class="kpis">
      ${kpi("In Knowledge", n(k.pages), `${k.approvedPercent}% approved by a person`)}
      ${kpi("Added or changed · 14 days", n(k.changed), "new and updated items")}
      ${kpi("Nightly runs succeeded", `${k.runsOk}<span class="muted sm16">/${k.runsTotal}</span>`, pill(k.runsPill))}
      ${kpi("Waiting for your OK", k.waiting, hasReview ? '<a href="#knowledge-review">See it</a>' : "")}
    </div>
    <div class="grid2">
      ${chartCard("c-changed", "Added or changed per day", "How much new knowledge came in each night.", K.series)}
      ${chartCard("c-minutes", "Processing time per day", "Minutes spent reading and distilling each night.", K.series)}
    </div>
    <section class="card"><div class="card-head"><div><h3>Nightly run results</h3><p class="explain">One square per source per night, plus the search index that makes Knowledge findable. Red means that night's run failed or did not happen.</p></div>
      <div class="legend"><span>${pill({ state: "good", text: "Succeeded" })}</span><span>${pill({ state: "crit", text: "Failed" })}</span></div></div>
      <div class="chart" id="c-health"></div></section>
    ${index}`;
  }
  function knowledgeSources() {
    const rows = K.sources.map(
      (
        s,
      ) => `<tr><td><span class="dotc ${bg(s)}"></span><b>${esc(s.label)}</b>${s.note ? `<div class="muted small w42">${esc(s.note)}</div>` : ""}</td>
      <td class="muted">${esc(s.connection)}</td><td class="w34">${esc(s.share)}</td><td>${tagLine(s.tagging) || '<span class="muted">No reading</span>'}</td><td>${pill(s.pill)}</td><td class="num">${n(s.pages)}</td></tr>`,
    );
    return `<section class="card"><div class="card-head"><div><h3>Sources</h3><p class="explain">Where knowledge comes from. Nothing is shared unless it is marked <b>${esc(M.tagPrefix)}[area]</b> in the tool you already use; Claude can mark it for you.</p></div>${ask("Ask Claude to add a source", "Add a new Knowledge source to my Engine: ")}</div>
      ${K.unknownTags ? warnRow(K.unknownTags.text) : ""}
      ${table([["Source"], ["Connected"], ["How sharing works"], ["Tagged"], ["Status"], ["Pages", "num"]], rows)}${tellClaude(`Label the pricing thread ${M.tagPrefix}${M.exampleTopic}`)}</section>`;
  }
  function knowledgeAreas() {
    const rows = K.areas.map(
      (
        a,
      ) => `<tr><td><b>${esc(a.domain)}</b> ${a.locked ? pill({ state: "warn", text: "Locked" }) : ""}${a.what ? `<div class="muted small w40">${esc(a.what)}</div>` : ""}</td><td class="num">${n(a.items)}</td>
      <td>${a.sources.map((s) => `<span class="dotc ${bg(s)}" title="${esc(s.label)}"></span>`).join("") || '<span class="muted">—</span>'}</td>
      <td class="muted">${a.who.length ? esc(a.who.join(", ")) : "Nobody yet"}</td></tr>`,
    );
    return `<section class="card"><div class="card-head"><div><h3>Knowledge areas</h3><p class="explain">Every page belongs to one area. Who can see each area is set in <a href="#security-access">Security · People</a>.</p></div>${ask("Ask Claude to sort unclassified pages", "Sort my unclassified pages into knowledge areas for my review")}</div>
      ${table([["Area"], ["Pages", "num"], ["Sources"], ["Who can see it"]], rows)}${K.lockedNote ? `<p class="note">${esc(K.lockedNote)}</p>` : ""}</section>`;
  }
  function knowledgeReview() {
    const rows = K.review.rows.map(
      (r) =>
        `<tr><td><b>${esc(r.title)}</b></td><td class="muted">${esc(r.from)}</td><td>${esc(r.area)}</td></tr>`,
    );
    return `<section class="card"><div class="card-head"><div><h3>Waiting for your OK</h3><p class="explain">New knowledge the Engine is not sure about. Nothing here is shared until you approve it.</p></div>${pill(K.review.pill)}</div>
      ${rows.length ? table([["Page"], ["From"], ["Suggested area"]], rows) : '<div class="empty">Nothing is waiting.</div>'}
      ${K.kpis.waiting > rows.length ? `<p class="note">Showing the first ${rows.length} of ${K.kpis.waiting}.</p>` : ""}${tellClaude("Approve the notes from Friday's planning meeting")}</section>`;
  }

  /* ---- WORKERS ---- */
  function workersTasks() {
    const k = W.kpis;
    const rows = W.tasks.map(
      (t) =>
        `<tr><td><b>${esc(t.what)}</b></td><td class="muted">${esc(t.when)}</td><td>${pill(t.pill)} <span class="muted small">${esc(t.last)}</span></td></tr>`,
    );
    return `<div class="kpis">${kpi("Tasks", k.total, "running for you")}${kpi("On time", `${k.onTime}<span class="muted sm16">/${k.total}</span>`, pill(k.onTimePill))}${kpi("Fixed itself · 7 days", k.fixedItself ?? "—", k.fixedItself == null ? "No reading yet" : "safe fixes, no help needed")}${kpi("Needs a look", k.needsLook, "being followed up")}</div>
      <section class="card"><div class="card-head"><div><h3>Tasks</h3><p class="explain">One worker does each task and a second checks it was really done before it shows as done.</p></div>${ask("Ask Claude to add a task", "Add a recurring task to my Engine: ")}</div>
      ${rows.length ? table([["Task"], ["How often"], ["Last result"]], rows) : '<div class="empty">No tasks are set up yet.</div>'}${tellClaude("Every Friday at 4 PM, email me a summary of open follow-ups")}</section>
      <section class="card"><h3>Tasks done per day</h3><div class="empty">${esc(W.emptyChart)}</div></section>`;
  }

  /* ---- TOOLS ---- */
  function toolsConnected() {
    const rows = T.connected.map(
      (t) =>
        `<tr><td><b>${esc(t.label)}</b></td><td>${esc(t.does)}</td><td>${pill(t.pill)}</td></tr>`,
    );
    return `<section class="card"><div class="card-head"><div><h3>Connect Claude</h3><p class="explain">Claude is how you use your Engine. Everything on this page is visible to Claude, and you change things by asking it.</p></div>${pill(T.connectPill)}</div>
      <ol class="steps"><li>${T.connectorUrl ? `Copy the connector address: <code>${esc(T.connectorUrl)}</code> <button class="btn" type="button" data-copy="${esc(T.connectorUrl)}">Copy</button>` : "Copy your Engine's connector address (its web address ending in <code>/mcp</code>)."}</li>
      <li>In Claude.ai open <b>Settings → Connectors → Add custom connector</b> and paste it.</li><li>Sign in with your email code.</li>
      <li>Ask something your Engine knows, like "What did we decide in last week's meeting?"</li></ol></section>
      <section class="card"><h3>Connected tools</h3>${table([["Tool"], ["What workers use it for"], ["Status"]], rows)}</section>`;
  }
  function toolsSupport() {
    const d = T.supportDesk;
    if (!d)
      return '<div class="empty">The Support Desk is not part of this Engine.</div>';
    const k = d.kpis;
    const issues = d.issues.length
      ? d.issues
          .map(
            (i) =>
              `<div><b>${esc(i.title)}</b> <span class="muted">· ${esc(i.source)} · ${i.urgent ? "urgent" : "open"}</span></div>`,
          )
          .join("")
      : '<div class="empty">No open issues.</div>';
    const clients = d.clients.map(
      (c) =>
        `<tr><td><b>${esc(c.label)}</b>${c.inbox ? sub(c.inbox) : ""}</td><td>${c.repo ? `<code>${esc(c.repo)}</code>` : '<span class="muted">not created yet</span>'}</td><td class="muted">${esc(c.feed)}</td><td>${pill(c.pill)}</td></tr>`,
    );
    const shop = d.workshop.map(
      (a) =>
        `<tr><td><code>${esc(a.card)}</code>${a.title ? sub(a.title) : ""}</td><td>${a.pr ? (a.prUrl && /^https:\/\//.test(a.prUrl) ? `<a href="${esc(a.prUrl)}" rel="noopener noreferrer" target="_blank">#${esc(a.pr)}</a>` : `#${esc(a.pr)}`) : '<span class="muted">none yet</span>'}</td><td class="muted">${esc(a.started)}</td><td>${pill(a.result)}</td></tr>`,
    );
    const gates = d.gates.map(
      (g) =>
        `<tr><td><b>${esc(g.label)}</b></td><td>${esc(g.does)}</td><td>${pill(g.pill)}</td></tr>`,
    );
    return `${d.note ? `<p class="proto solid">${esc(d.note)}</p>` : ""}
      <div class="kpis">${kpi("Client Engines", k.clients, esc(k.clientsNote))}${kpi("Open issues", k.issues, pill(k.issuesPill))}${kpi("Fixes started today", k.fixesToday, "in the workshop")}${kpi("Waiting for you", k.waiting ?? "—", k.waiting == null ? "No reading yet" : "pull requests")}</div>
      <section class="card"><div class="card-head"><div><h3>Issues</h3><p class="explain">Problems client Engines could not fix themselves.</p></div></div>${issues}</section>
      <section class="card"><h3>Client Engines</h3>${table([["Engine"], ["Repo"], ["Issue feed"], ["Status"]], clients)}</section>
      <section class="card"><h3>Workshop</h3>${shop.length ? table([["Card"], ["Pull request"], ["Started"], ["Result"]], shop) : '<div class="empty">No jobs recorded yet.</div>'}</section>
      <section class="card"><h3>Merge gate &amp; GitHub</h3>${table([["Part"], ["What it does"], ["Status"]], gates)}</section>`;
  }

  /* ---- SECURITY ---- */
  function securityLayers() {
    const layers = S.layers.map(
      (l) =>
        `<tr><td><b>${esc(l.title)}</b><div class="muted small w52">${esc(l.how)}</div></td><td>${pill(l.pill)}</td><td>${esc(l.stat)}${l.links.map((x) => ` · <a href="#${esc(x.route)}">${esc(x.label)}</a>`).join("")}</td></tr>`,
    );
    const blocked = S.blocked.map(
      (b) =>
        `<tr><td><code>${esc(b.what)}</code></td><td class="num">${n(b.times)}</td></tr>`,
    );
    const access = (S.access || []).map(
      (a) =>
        `<tr><td><b>${esc(a.label)}</b></td><td>${esc(a.value)}</td><td>${a.pill ? pill(a.pill) : ""}</td></tr>`,
    );
    return `<div class="kpis">${S.kpis.map((x) => kpi(x.label, esc(x.value), x.pill ? pill(x.pill) : esc(x.sub))).join("")}</div>
      <section class="card"><div class="card-head"><div><h3>How people sign in</h3><p class="explain">Set once on the setup page. Sign-in decides who reaches the Engine; knowledge areas decide what each person sees.</p></div></div>${table([["Setting"], ["Now"], [""]], access)}</section>
      <section class="card"><h3>The five layers</h3>${table([["Layer"], ["Status"], ["Last 7 days"]], layers)}</section>
      <section class="card"><h3>Most blocked commands this week</h3>${blocked.length ? table([["What a worker tried"], ["Times", "num"]], blocked) : '<div class="empty">Nothing was blocked, or no reading yet.</div>'}</section>`;
  }
  function securityAccess() {
    const rows = S.people.map(
      (
        p,
      ) => `<tr><td><b>${esc(p.name)}</b>${sub(p.email)}</td><td>${esc(p.role)}${p.active ? "" : " · inactive"}</td>
      <td><div class="chips">${p.areas.map((a) => (a.kind === "auto" ? `<span class="chip auto">${esc(a.domain)}</span>` : `<span class="chip ${a.locked ? "sensitive" : ""}" aria-pressed="true">${esc(a.domain)}</span>`)).join("")}</div></td></tr>`,
    );
    return `<section class="card"><div class="card-head"><div><h3>People</h3><p class="explain">Members use the Engine from Claude. Owners also approve knowledge and decide sharing, and see every unlocked area. Locked areas are shared only by name.</p></div>${ask("Ask Claude to add a person", "Give access to my Engine to: ")}</div>
      ${table([["Person"], ["Role"], ["Can see"]], rows)}${tellClaude(`Let Sam see ${M.exampleTopic} as a Member`)}</section>`;
  }
  function securitySystems() {
    const row = (m, owner) =>
      `<tr><td><b>${esc(m.name)}</b>${m.handle ? `<div class="muted small"><code>${esc(m.handle)}</code></div>` : ""}</td><td>${esc(m.what)}</td><td>${pill(m.pill)}</td><td class="muted">${esc(m.changed)}</td>${owner ? "" : ""}</tr>`;
    return `<section class="card"><div class="card-head"><div><h3>Source connections</h3><p class="explain">The logins your Engine uses to read your sources. Each belongs to one person and can only read, never send or delete.</p></div>${ask("Ask Claude to connect a source", "Connect a new source to my Engine: ")}</div>
      ${table(
        [["Connection"], ["Can do"], ["Status"], ["Owner"]],
        S.connections.map((c) => row(c)),
      )}</section>
      <section class="card"><div class="card-head"><div><h3>Engine systems</h3><p class="explain">Software inside your Engine that signs in to it. Each can do one narrow thing and changes only through a reviewed update. None can read private items.</p></div></div>
      ${
        S.systems.length
          ? table(
              [["System"], ["Can do"], ["Status"], ["Last changed"]],
              S.systems.map((m) => row(m)),
            )
          : '<div class="empty">No systems found.</div>'
      }${tellClaude("Turn off the Email connection until Monday")}</section>`;
  }

  /* ---- SUPPORT ---- */
  function supportIssues() {
    const rows = U.open.map(
      (i) =>
        `<tr><td><b>${esc(i.title)}</b>${sub(i.kind)}</td><td class="muted">${esc(i.source)}</td><td>${pill(i.pill)}</td><td class="muted">${esc(i.opened)}${sub(i.seen)}</td><td class="muted">${esc(i.card)}</td></tr>`,
    );
    const config = U.config
      ? `<section class="card"><div class="card-head"><div><h3>Engine config</h3><p class="explain">Applied ${esc(U.config.applied)} from your knowledge repo.</p></div>${pill(U.config.pill)}</div>${U.config.note ? warnRow(U.config.note) : ""}</section>`
      : "";
    return `<div class="kpis">${kpi("Open issues", U.available ? U.open.length : "—", U.available ? "" : "No reading yet")}${kpi("Fixed · 30 days", U.fixed30 == null ? "—" : n(U.fixed30), U.fixed30 == null ? "No reading yet" : "closed with proof")}${kpi("Care Plan access", pill(U.carePlan), esc(U.carePlanNote))}</div>
      <section class="card"><div class="card-head"><div><h3>Open issues</h3><p class="explain">Problems the Engine noticed itself, and problems people reported from Claude. A source's issue closes by itself after its next clean run.</p></div>${ask("Ask Claude to report a problem", "Report a problem with my Engine: ")}</div>
      ${rows.length ? table([["Issue"], ["Source"], ["Status"], ["Opened"], ["Follow-up"]], rows) : `<div class="empty">${esc(U.emptyText)}</div>`}</section>
      ${config}`;
  }

  /* ---------- Menu and routing ---------- */
  const PAGES = {
    "knowledge.overview": knowledgeOverview,
    "knowledge.sources": knowledgeSources,
    "knowledge.areas": knowledgeAreas,
    "knowledge.review": knowledgeReview,
    "workers.tasks": workersTasks,
    "tools.connected": toolsConnected,
    "tools.support_desk": toolsSupport,
    "security.layers": securityLayers,
    "security.people": securityAccess,
    "security.systems": securitySystems,
    "support.issues": supportIssues,
  };
  const ICONS = {
    knowledge:
      "M4 4h9l3 3v9a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1zM6 9h8M6 12h8M6 15h5",
    workers: "M10 10a3 3 0 100-6 3 3 0 000 6zM4 17c0-3 2.7-5 6-5s6 2 6 5",
    tools: "M12.5 3.5a4 4 0 00-5 5L3 13v4h4l4.5-4.5a4 4 0 005-5L14 10l-4-4z",
    security: "M10 2l6 2.5v5c0 4-2.7 6.8-6 8-3.3-1.2-6-4-6-8v-5z",
    support:
      "M10 17a7 7 0 100-14 7 7 0 000 14zM10 13a3 3 0 100-6 3 3 0 000 6zM5 5l2.9 2.9M12.1 12.1L15 15M15 5l-2.9 2.9M7.9 12.1L5 15",
  };
  const ROUTES = {};
  M.menus.forEach((m) =>
    m.tabs.forEach((t) => {
      ROUTES[t.route] = { menu: m, tab: t };
    }),
  );
  const FIRST =
    M.menus[0] && M.menus[0].tabs[0] ? M.menus[0].tabs[0].route : "";

  function renderNav(active) {
    $("#nav").innerHTML = M.menus
      .map(
        (m) =>
          `<a class="nav-item ${m === active ? "active" : ""}" href="#${esc(m.tabs[0].route)}" ${m === active ? 'aria-current="page"' : ""}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[m.id] || ""}"/></svg>${esc(m.label)}</a>`,
      )
      .join("");
    $("#overall").innerHTML =
      `${pill(M.overall)}<span><small>${esc(M.overall.detail)}</small></span>`;
  }

  function render() {
    const wanted = (location.hash || "#").slice(1);
    const id = ROUTES[wanted] ? wanted : FIRST;
    const route = ROUTES[id];
    if (!route) {
      $("#page").innerHTML =
        '<div class="empty">No menus are set up for this Engine.</div>';
      return;
    }
    const { menu, tab } = route;
    renderNav(menu);
    const tabs =
      menu.tabs.length > 1
        ? `<nav class="tabs" aria-label="${esc(menu.label)} sections">${menu.tabs.map((t) => `<a href="#${esc(t.route)}" class="${t.route === id ? "on" : ""}">${esc(t.label)}</a>`).join("")}</nav>`
        : "";
    const page = PAGES[`${menu.id}.${tab.key}`];
    $("#page").innerHTML =
      `<div class="stackpage">${header(menu.label, menu.blurb, menu.badge)}${tabs}${page ? page() : ""}</div>`;
    if (menu.id === "knowledge" && tab.key === "overview") {
      stackedBars($("#c-changed"), K.series, "changed", "");
      stackedBars($("#c-minutes"), K.series, "minutes", " min");
      healthGrid($("#c-health"), K.healthSeries);
    }
    labelTables();
    window.scrollTo(0, 0);
  }

  /* ---------- Interactions (view-only: copy, tables, theme, menu) ---------- */
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.table) {
      const el = $("#" + t.dataset.table),
        showing = t.textContent === "Show as chart",
        key = t.dataset.table === "c-minutes" ? "minutes" : "changed",
        unit = key === "minutes" ? " min" : "";
      t.textContent = showing ? "Show as table" : "Show as chart";
      if (showing) stackedBars(el, K.series, key, unit);
      else el.innerHTML = tableView(K.series, key, unit);
    }
    if (t.dataset.copy || t.dataset.ask) {
      const text = t.dataset.copy || t.dataset.ask,
        old = t.textContent;
      const done = () => {
        t.textContent = t.dataset.ask ? "Copied: paste into Claude" : "Copied";
        setTimeout(() => {
          t.textContent = old;
        }, 1800);
      };
      try {
        navigator.clipboard.writeText(text).then(done, () => {
          t.textContent = "Copy failed";
        });
      } catch (_) {
        t.textContent = "Copy failed";
      }
    }
    if (t.dataset.themeSet) setTheme(t.dataset.themeSet);
  });
  function labelTables() {
    document.querySelectorAll("#page .table-wrap").forEach((wrap) => {
      wrap.classList.add("stack");
      const heads = [...wrap.querySelectorAll("thead th")].map((th) =>
        th.textContent.trim(),
      );
      wrap
        .querySelectorAll("tbody tr")
        .forEach((tr) =>
          [...tr.children].forEach((td, i) =>
            td.setAttribute("data-label", heads[i] || ""),
          ),
        );
    });
  }
  $("#menu-btn").addEventListener("click", () => {
    const sb = $(".sidebar"),
      open = !sb.classList.contains("open");
    sb.classList.toggle("open", open);
    $("#menu-btn").setAttribute("aria-expanded", String(open));
  });
  $("#nav").addEventListener("click", (e) => {
    if (e.target.closest("a")) {
      $(".sidebar").classList.remove("open");
      $("#menu-btn").setAttribute("aria-expanded", "false");
    }
  });

  function setTheme(mode) {
    const root = document.documentElement;
    if (mode === "system") delete root.dataset.theme;
    else root.dataset.theme = mode;
    document
      .querySelectorAll("[data-theme-set]")
      .forEach((b) =>
        b.setAttribute("aria-pressed", String(b.dataset.themeSet === mode)),
      );
    try {
      localStorage.setItem("engine-theme", mode);
    } catch (_) {
      /* private window: theme just will not be remembered */
    }
  }
  let savedTheme = "system";
  try {
    savedTheme = localStorage.getItem("engine-theme") || "system";
  } catch (_) {
    /* no storage: use the system theme */
  }
  setTheme(
    ["light", "dark", "system"].includes(savedTheme) ? savedTheme : "system",
  );
  window.addEventListener("hashchange", render);
  render();
})();
