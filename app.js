/* RCDAS Policy & Procedure Library - front end */

const S = {
  docs: [], glossary: [], faq: null, gaps: [],
  synonyms: new Map(),   // lowercased synonym -> canonical term words
  byId: new Map(),
  live: false,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- boot ---------- */

async function boot() {
  const [corpus, glossary, faq, gaps, guide, quiz, health] = await Promise.all([
    fetch("data/corpus.json").then((r) => r.json()),
    fetch("data/glossary.json").then((r) => r.json()),
    fetch("data/faq.json").then((r) => r.json()),
    fetch("data/gaps.json").then((r) => r.json()),
    fetch("data/guide.json").then((r) => r.json()),
    fetch("data/quiz.json").then((r) => r.json()).catch(() => ({ categories: [] })),
    fetch("api/health").then((r) => r.json()).catch(() => ({ live: false })),
  ]);
  S.guide = guide.map((g) => ({
    number: null, flag: null, dualListed: false,
    definitions: [], references: [], related: [], appendices: [],
    revisions: [], campusVariations: [],
    ...g,
    searchText: (g.purpose + " " + g.sections.map(
      (s) => s.heading + " " + s.steps.join(" ")).join(" ")).toLowerCase(),
  }));
  S.docs = corpus.documents.concat(S.guide);
  // section headings get their own search weight (between title and body)
  S.docs.forEach((d) => {
    const heads = [];
    const walk = (ss) => (ss || []).forEach((x) => { if (x.heading) heads.push(x.heading); walk(x.subsections); });
    walk(d.sections);
    d.headText = heads.join(" ").toLowerCase();
  });
  S.glossary = glossary;
  S.faq = faq;
  S.gaps = gaps;
  S.quiz = quiz.categories || [];
  S.live = !!health.live;
  S.docs.forEach((d) => S.byId.set(d.id, d));

  // synonym expansion map from glossary
  glossary.forEach((g) => {
    if (!g.synonyms) return;
    String(g.synonyms).split(";").forEach((syn) => {
      const k = syn.trim().toLowerCase();
      if (k) S.synonyms.set(k, String(g.term || "").toLowerCase());
    });
  });

  if (health.auth) $("#gateNote").textContent = "Sign in with your email and the department access password.";
  const mode = $("#modeChip");
  mode.textContent = S.live ? "AI: live" : "AI: demo mode (no API key configured)";
  mode.className = "mode-chip " + (S.live ? "live" : "demo");

  $("#glossBox").placeholder = `Search ${glossary.length} terms: intake types, outcome codes, SAC metrics, SOP definitions`;
  buildFilters();
  buildGlossaryFilters();
  renderAskExamples();
  renderHome();
  renderResults(searchDocs(""));
}

/* ---------- auth (mockup) ---------- */

function initAuth() {
  const user = sessionStorage.getItem("rcdas_user");
  if (user) showApp(user);
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#email").value.trim();
    const password = $("#password").value;
    if (!email || !password) return;
    let ok = true;
    try {
      const r = await fetch("api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      ok = (await r.json()).ok;
    } catch (_) { ok = true; }  // no server (shared preview): accept
    if (!ok) {
      $("#gateError").textContent = "That password is not correct. Check with your administrator.";
      return;
    }
    sessionStorage.setItem("rcdas_user", email);
    showApp(email);
  });
  $("#signOut").addEventListener("click", () => {
    sessionStorage.removeItem("rcdas_user");
    location.reload();
  });
}

function showApp(user) {
  $("#gate").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#userChip").textContent = user;
  switchTab("home");
}

/* ---------- search ---------- */

const STOP = new Set(["a","an","the","is","are","was","were","do","does","did","for","of","to","in","on","at","and","or","we","i","you","it","there","have","has","what","when","how","who","which","policy","procedure","sop","protocol"]);

function tokens(q) {
  return q.toLowerCase().replace(/[^a-z0-9\- ]/g, " ").split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

const rxCache = new Map();
function wordRx(t) {
  // exact word or common inflection: "hold" hits "holding", "cat" hits
  // "cats", but "pet" does not hit "petty" and "cat" not "certificate"
  if (!rxCache.has(t)) {
    const e = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // tokens of 4+ letters prefix-match ("parvo" hits "parvovirus", "hold"
    // hits "holding"); 3-letter tokens match exact or plural only, so "pet"
    // does not hit "petty" and "cat" does not hit "certificate"
    const rx = t.length >= 4 ? "\\b" + e : "\\b" + e + "(?:s|es)?\\b";
    rxCache.set(t, new RegExp(rx, "g"));
  }
  const rx = rxCache.get(t);
  rx.lastIndex = 0;
  return rx;
}

function countHits(text, t) {
  const m = text.match(wordRx(t));
  return m ? m.length : 0;
}

const dfCache = new Map();
function rarity(t) {
  // inverse document frequency: rare, specific tokens ("parvo") outweigh
  // common ones ("treatment") in every scoring bucket
  if (!dfCache.has(t)) {
    let df = 0;
    for (const d of S.docs) if (countHits(d.searchText, t)) df++;
    dfCache.set(t, Math.log(1 + S.docs.length / (df + 1)));
  }
  return dfCache.get(t);
}

function expand(toks, rawQuery) {
  const out = new Set(toks);
  const raw = rawQuery.toLowerCase();
  S.synonyms.forEach((term, syn) => {
    if (raw.includes(syn)) tokens(term).forEach((t) => out.add(t));
  });
  return [...out];
}

function searchDocs(query) {
  const q = query.trim();
  if (!q) return S.docs.slice().sort((a, b) => (a.number || "zzz").localeCompare(b.number || "zzz"));
  const toks = expand(tokens(q), q);
  const numQ = q.toLowerCase().match(/\b(\d{3}-\d{1,3}|cc-\d{3})\b/);
  const scored = [];
  for (const d of S.docs) {
    let score = 0, titleHits = 0;
    const title = (d.title || "").toLowerCase();
    if (numQ && (d.number || "").toLowerCase() === numQ[1]) score += 500;
    for (const t of toks) {
      const w = rarity(t);
      if (countHits(title, t)) { score += 24 * w; titleHits++; }
      if (countHits(d.headText || "", t)) score += 10 * w;
      if (countHits((d.purpose || "").toLowerCase(), t)) score += 5 * w;
      const n = countHits(d.searchText, t);
      if (n) score += (2 + Math.min(n, 4)) * w;
    }
    // every query token in the title: almost certainly the right document
    if (toks.length > 1 && titleHits === toks.length) score += 90;
    // full phrase bonus, title worth far more than body text
    if (q.length > 5 && title.includes(q.toLowerCase())) score += 120;
    else if (q.length > 5 && d.searchText.includes(q.toLowerCase())) score += 25;
    if (score > 0) scored.push([score, d]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.map((x) => x[1]);
}

function snippet(d, query) {
  const toks = tokens(query);
  let text = d.purpose || "";
  let idx = -1, hit = "";
  for (const t of toks) {
    idx = d.searchText.indexOf(t);
    if (idx >= 0) { hit = t; break; }
  }
  if (idx >= 0 && !(d.purpose || "").toLowerCase().includes(hit)) {
    text = "..." + d.searchText.slice(Math.max(0, idx - 60), idx + 160) + "...";
  }
  let out = esc(text.slice(0, 260));
  for (const t of toks) {
    if (t.length < 3) continue;
    out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"), "<mark>$1</mark>");
  }
  return out;
}

function badges(d) {
  let h = "";
  if (d.number) h += `<span class="badge num">${esc(d.number)}</span>`;
  const typeClass = { Policy: "policy", Procedure: "protocol", Guide: "guide" }[d.type] || "cat";
  h += `<span class="badge ${typeClass}">${esc(d.type)}</span>`;
  h += `<span class="badge cat">${esc(d.category)}</span>`;
  h += `<span class="badge status">${esc(d.status)}</span>`;
  if (d.dualListed) h += `<span class="badge warn">Status under review</span>`;
  return h;
}

// Provenance: whether staff updated each document, from the consolidation plan.
// Label text (short + full) is computed at build time; the front end only maps
// the state to a colour class.
const PROV_CLS = {
  "reviewed": "prov-reviewed",
  "in-progress": "prov-progress",
  "reformatted": "prov-reformatted",
  "reference": "prov-reference",
};

function provBadge(d) {
  const p = d.provenance;
  if (!p) return "";
  const cls = PROV_CLS[p.state] || PROV_CLS.reformatted;
  return `<span class="badge prov ${cls}" title="${esc(p.label)}">${esc(p.short)}</span>`;
}

function browseCategory(cat) {
  $("#catFilter").value = cat;
  renderResults(searchDocs($("#searchBox").value));
}

function renderCategoryBoxes() {
  const counts = new Map();
  S.docs.filter((d) => d.type !== "Guide").forEach((d) => {
    counts.set(d.category, (counts.get(d.category) || 0) + 1);
  });
  const cats = [...counts.keys()].sort();
  const gapCount = S.gaps.reduce((n, g) => n + g.items.length, 0);
  $("#results").innerHTML = `<div class="cat-grid">` + cats.map((c) => `
    <button class="cat-card" onclick="browseCategory(${JSON.stringify(c).replace(/"/g, "&quot;")})">
      <span class="cat-name">${esc(c)}</span>
      <span class="cat-count">${counts.get(c)} ${counts.get(c) === 1 ? "document" : "documents"}</span>
    </button>`).join("") + `
    <button class="cat-card cat-card--gaps" onclick="showGaps()">
      <span class="cat-name">Not Written Yet</span>
      <span class="cat-count">${gapCount} SOPs most shelters have</span>
    </button></div>`;
}

function showGaps() {
  $("#results").innerHTML = `
    <button class="back-link" onclick="renderCategoryBoxes()">&larr; All categories</button>
    <h3 class="gaps-title">SOPs most shelters have that RCDAS does not, yet</h3>
    <p class="hint">These topics are standard at comparable shelters (ASV Guidelines for Standards of Care) or were flagged by staff during the 2026 consolidation. Pick one and a research-based draft will be prepared for leadership review.</p>` +
    S.gaps.map((g) => `
      <h4 class="gap-group">${esc(g.group)}</h4>` +
      g.items.map((it) => `
        <div class="gap-card">
          <div class="gap-text"><b>${esc(it.topic)}</b><div class="gap-note">${esc(it.note)}</div></div>
          <button class="btn-draft" onclick="requestDraft('${esc(it.topic).replace(/'/g, "\\'")}')">Create a draft</button>
        </div>`).join("")).join("");
  window.scrollTo(0, 0);
}

function renderResults(list) {
  const q = $("#searchBox").value;
  const type = $("#typeFilter").value;
  const cat = $("#catFilter").value;
  // Landing state: no query, no filters. Show tidy category boxes instead of
  // a wall of 200 documents.
  if (!q.trim() && !type && !cat) { renderCategoryBoxes(); return; }
  let filtered = list.filter((d) => d.type !== "Guide");
  if (type) filtered = filtered.filter((d) => d.type === type);
  if (cat) filtered = filtered.filter((d) => d.category === cat);

  const box = $("#results");
  if (!filtered.length) {
    box.innerHTML = `
      <div class="noresult">
        <p><strong>No document found for "${esc(q)}".</strong><br>
        There is currently no RCDAS policy or procedure covering this topic.</p>
        <button class="btn-draft" onclick="requestDraft(${JSON.stringify(q).replace(/"/g, "&quot;")})">Create a draft</button>
        <p class="hint" style="margin-top:12px">A research-based draft will be prepared in the RCDAS SOP template for leadership review.</p>
      </div>`;
    return;
  }
  const cap = 40;
  box.innerHTML =
    `<p class="showing">Showing ${Math.min(cap, filtered.length)} of ${filtered.length} documents</p>` +
    filtered.slice(0, cap).map((d) => `
      <div class="result-card" onclick="openDoc('${d.id}')">
        <div class="result-head">${badges(d)}${provBadge(d)}</div>
        <div class="result-title">${esc(d.title)}</div>
        <div class="result-snip">${q ? snippet(d, q) : esc((d.purpose || "").slice(0, 220))}</div>
      </div>`).join("") +
    (q.trim() ? `
      <div class="noresult" style="margin-top:18px">
        <p>None of these covers <strong>${esc(q)}</strong> directly?</p>
        <button class="btn-draft" onclick="requestDraft(${JSON.stringify(q).replace(/"/g, "&quot;")})">Create a draft</button>
      </div>` : "");
}

function buildFilters() {
  const cats = [...new Set(S.docs.map((d) => d.category))].sort();
  $("#catFilter").innerHTML = '<option value="">All categories</option>' +
    cats.map((c) => `<option>${esc(c)}</option>`).join("");
}

/* ---------- document viewer ---------- */

function renderSteps(steps) {
  if (!steps || !steps.length) return "";
  return "<ol>" + steps.map((st) => {
    if (typeof st === "string") return `<li>${esc(st)}</li>`;
    const txt = st.text || st.step || "";
    let sub = "";
    if (st.substeps && st.substeps.length) sub = renderSteps(st.substeps);
    return `<li>${esc(txt)}${sub}</li>`;
  }).join("") + "</ol>";
}

// A. B. C. lettering for the procedure subsections, like the SOP template.
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function renderProcedure(sections) {
  if (!sections || !sections.length) return "";
  return sections.map((s, i) => `
    <div class="sop-sub">
      ${s.heading ? `<div class="sop-sub-head">${LETTERS[i] || (i + 1)}. ${esc(s.heading)}</div>` : ""}
      ${s.body ? `<p>${esc(s.body)}</p>` : ""}
      ${renderSteps(s.steps)}
      ${(s.subsections || []).map((ss) => `
        <div class="sop-subsub">
          ${ss.heading ? `<div class="sop-subsub-head">${esc(ss.heading)}</div>` : ""}
          ${ss.body ? `<p>${esc(ss.body)}</p>` : ""}
          ${renderSteps(ss.steps)}
        </div>`).join("")}
    </div>`).join("");
}

// Guide chapters keep the simpler heading layout (not SOP-template documents).
function renderGuideSections(sections) {
  if (!sections || !sections.length) return "";
  return sections.map((s) => `
    <div class="doc-section">
      ${s.heading ? `<h3>${esc(s.heading)}</h3>` : ""}
      ${s.body ? `<p>${esc(s.body)}</p>` : ""}
      ${renderSteps(s.steps)}
    </div>`).join("");
}

function openDoc(id) {
  const d = S.byId.get(id);
  if (!d) return;

  // Guide chapters are reference material, not SOP-template documents.
  if (d.type === "Guide") return openGuide(d);

  const relRows = (d.related || []).map((r) => {
    const type = typeof r === "string" ? "Related" : (r.type || "Related");
    const name = typeof r === "string" ? r : (r.name || r.title || r.number || "");
    const target = S.docs.find((x) => x.title === name || x.number === name);
    const cell = target
      ? `<a class="sop-link" onclick="event.stopPropagation();openDoc('${target.id}')">${esc(name)}</a>`
      : esc(name);
    return `<tr><td class="sop-td-type">${esc(type)}</td><td>${cell}</td></tr>`;
  }).join("");

  const defRows = (d.definitions || []).map((x) =>
    `<tr><td class="sop-td-term">${esc(x.term)}</td><td>${esc(x.def || x.definition || "")}</td></tr>`).join("");

  const campus = (d.campusVariations || []).map((c) =>
    `<li>${typeof c === "string" ? esc(c) : `<b>${esc(c.campus || "")}</b>: ${esc(c.variation || c.note || "")}`}</li>`).join("");

  const refRows = (d.references || []).map((r) =>
    `<li>${esc(typeof r === "string" ? r : (r.name || r.title || ""))}</li>`).join("");

  const appendices = (d.appendices || []).map((a) => `<li>${esc(a)}</li>`).join("");

  const revRows = (d.revisions || []).map((r) => typeof r === "string"
    ? `<tr><td colspan="4">${esc(r)}</td></tr>`
    : `<tr><td>${esc(r.date || "")}</td><td>${esc(r.version || "")}</td><td>${esc(r.author || "")}</td><td>${esc(r.desc || r.description || "")}</td></tr>`).join("");

  const p = d.provenance || { state: "reformatted", label: "", short: "" };
  const provCls = PROV_CLS[p.state] || PROV_CLS.reformatted;

  $("#viewerBody").innerHTML = `
    <div class="sop">
      <div class="sop-header">County of Riverside — Department of Animal Services<br><span>${d.type === "Policy" ? "Departmental Policy" : "Standard Operating Procedure"}</span></div>

      <div class="sop-provenance ${provCls}"><b>${esc(p.short)}.</b> ${esc(p.label)}</div>
      ${d.dualListed ? `<div class="doc-banner warn">This document appears on both the active and sunsetted tracker tabs; its status is unresolved. Confirm with leadership before relying on it.</div>` : ""}
      ${d.flag ? `<div class="doc-banner warn">Registry flag: ${esc(d.flag)}</div>` : ""}

      <table class="sop-meta">
        <tr><th>SOP Number</th><td>${d.number ? esc(d.number) : "To be assigned by administrator"}</td></tr>
        <tr><th>Subject</th><td>${esc(d.title)}</td></tr>
        <tr><th>Type</th><td>${esc(d.type)} &middot; ${esc(d.category)}</td></tr>
        <tr><th>Supersedes</th><td>${esc(d.supersedes || "N/A")}</td></tr>
        <tr><th>Effective Date</th><td>To be set upon final approval</td></tr>
        <tr><th>Approved By</th><td>${esc(d.authority || "Director of Animal Services")}</td></tr>
        <tr><th>Status</th><td>${esc(d.status)}</td></tr>
      </table>

      ${d.purpose ? `<div class="sop-section"><div class="sop-label">Purpose</div><p>${esc(d.purpose)}</p></div>` : ""}

      ${refRows ? `<div class="sop-section"><div class="sop-label">References</div><ul class="sop-bullets">${refRows}</ul></div>` : ""}

      <div class="sop-section">
        <div class="sop-label">Procedure</div>
        ${d.scope ? `<div class="sop-sub"><div class="sop-sub-head">Scope</div><p>${esc(d.scope)}</p></div>` : ""}
        ${defRows ? `<div class="sop-sub"><div class="sop-sub-head">Definitions</div>
          <table class="sop-table"><thead><tr><th>Term</th><th>Definition</th></tr></thead><tbody>${defRows}</tbody></table></div>` : ""}
        ${renderProcedure(d.sections)}
        ${campus ? `<div class="sop-sub"><div class="sop-sub-head">Campus-Specific Variations</div><ul>${campus}</ul></div>` : ""}
      </div>

      ${relRows ? `<div class="sop-section"><div class="sop-label">Related Documents and Systems</div>
        <table class="sop-table"><thead><tr><th>Type</th><th>Document / System Name</th></tr></thead><tbody>${relRows}</tbody></table></div>` : ""}

      ${appendices ? `<div class="sop-section"><div class="sop-label">Appendices</div><ul class="sop-bullets">${appendices}</ul></div>` : ""}

      ${revRows ? `<div class="sop-section"><div class="sop-label">Revision History</div>
        <table class="sop-table"><thead><tr><th>Date</th><th>Version</th><th>Author</th><th>Description of Changes</th></tr></thead><tbody>${revRows}</tbody></table></div>` : ""}
    </div>`;
  $("#viewer").classList.remove("hidden");
  $("#viewer").scrollTop = 0;
}

function openGuide(d) {
  $("#viewerBody").innerHTML = `
    <div class="doc-head">
      <div class="letterhead"><b>Riverside County Department of Animal Services</b>
      <span>New Staff Reference Guide</span></div>
      <div class="doc-badges">${badges(d)}</div>
      <h2>${esc(d.title)}</h2>
    </div>
    <div class="doc-banner info">Staff reference guide. Source: ${esc(d.source || "RCDAS New Staff Reference Guide")}.</div>
    ${d.purpose ? `<div class="doc-section"><h3>Purpose</h3><p>${esc(d.purpose)}</p></div>` : ""}
    ${renderGuideSections(d.sections)}`;
  $("#viewer").classList.remove("hidden");
  $("#viewer").scrollTop = 0;
}

/* ---------- AI endpoints ---------- */

function retrieve(query, n = 4) {
  return searchDocs(query).slice(0, n).map((d) => ({
    id: d.id,
    number: d.number,
    title: d.title,
    type: d.type,
    status: d.status,
    excerpt: [
      d.purpose ? "PURPOSE: " + d.purpose : "",
      d.scope ? "SCOPE: " + d.scope : "",
      sectionsText(d.sections).slice(0, 2600),
    ].filter(Boolean).join("\n"),
  }));
}

function sectionsText(sections) {
  const parts = [];
  const walk = (ss) => (ss || []).forEach((s) => {
    if (s.heading) parts.push(s.heading.toUpperCase());
    (s.steps || []).forEach((st) => parts.push(typeof st === "string" ? st : (st.text || st.step || "")));
    walk(s.subsections);
  });
  walk(sections);
  return parts.join("\n");
}

async function callAPI(path, payload, outEl, renderFn) {
  outEl.innerHTML = path.includes("draft")
    ? `<p class="thinking">Researching published best practices (ASV Guidelines, university shelter medicine programs) and writing the draft. This can take a few minutes...</p>`
    : `<p class="thinking">Reading the relevant documents...</p>`;
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let data = await r.json();
    if (data.error) throw new Error(data.error);
    // Long jobs (draft research) return a job id immediately; poll until done
    // so the request never outlives the host's proxy timeout.
    while (data.job) {
      await new Promise((res) => setTimeout(res, 5000));
      const s = await fetch(`api/draft/status?job=${encodeURIComponent(data.job)}`);
      const st = await s.json();
      if (st.error) throw new Error(st.error);
      if (st.status === "done") { data = st; break; }
    }
    renderFn(data);
  } catch (e) {
    outEl.innerHTML = `<div class="demo-note">Request failed: ${esc(e.message)}</div>`;
  }
}

function citeChips(docs) {
  return `<div class="cites">` + docs.map((d) =>
    `<button class="cite-chip" onclick="openDoc('${d.id}')">${esc(d.number ? d.number + " " : "")}${esc(d.title)}</button>`).join("") + `</div>`;
}

function ask() {
  const q = $("#askBox").value.trim();
  if (!q) return;
  const docs = retrieve(q, 5);
  callAPI("api/ask", { question: q, docs }, $("#askOut"), (data) => {
    $("#askOut").innerHTML = `
      <div class="answer"><h4>Answer</h4>${esc(data.text)}
      ${citeChips(docs)}</div>
      ${data.mode === "demo" ? `<div class="demo-note">Demo mode: this answer was generated without the AI service. Add an Anthropic API key to enable real grounded answers. The document retrieval above is real.</div>` : ""}`;
  });
}

function requestDraft(topic) {
  switchTab("draft");
  $("#gapBox").value = topic;
  draft();
}

function draft() {
  const topic = $("#gapBox").value.trim();
  if (!topic) return;
  const docs = retrieve(topic, 3);
  callAPI("api/draft", { topic, docs }, $("#draftOut"), (data) => {
    $("#draftOut").innerHTML = `
      <div class="draft-doc">
        <div class="letterhead"><b>Riverside County Department of Animal Services</b>
        <span>Standard Operating Procedure</span></div>${esc(data.text)}
      </div>
      <div class="demo-note">This is an AI-prepared draft based on published best practices. It has no effect until it completes the department approval flow and is signed by the Director.</div>
      ${data.mode === "demo" ? `<div class="demo-note">Demo mode: this is a template skeleton. With an API key, the tool researches published, research-based best practices (ASV Guidelines, shelter medicine literature) and writes a complete draft.</div>` : ""}
      <p style="margin-top:12px"><button class="btn-primary" onclick="downloadDraft()">Download draft (.md)</button></p>`;
    S.lastDraft = { topic, text: data.text };
  });
}

function downloadDraft() {
  if (!S.lastDraft) return;
  const head = "Riverside County Department of Animal Services\nStandard Operating Procedure\nDRAFT PENDING APPROVAL\n\n";
  const blob = new Blob([head + S.lastDraft.text], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "DRAFT " + S.lastDraft.topic.replace(/[^a-z0-9 \-]/gi, "") + ".md";
  a.click();
}

/* ---------- glossary ---------- */

function buildGlossaryFilters() {
  const cats = [...new Set(S.glossary.map((g) => g.category).filter(Boolean))].sort();
  const stats = [...new Set(S.glossary.map((g) => g.status).filter(Boolean))].sort();
  $("#glossCat").innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join("");
  $("#glossStatus").innerHTML = '<option value="">All statuses</option>' + stats.map((c) => `<option>${esc(c)}</option>`).join("");
  renderGlossary();
}

function renderGlossary() {
  const q = $("#glossBox").value.trim().toLowerCase();
  const cat = $("#glossCat").value;
  const status = $("#glossStatus").value;
  const sort = $("#glossSort").value;
  // Blank until the user searches, filters, or sorts; a wall of 600 terms
  // is overwhelming as a landing state.
  if (!q && !cat && !status && !sort) {
    $("#glossOut").innerHTML =
      `<p class="hint">Search for a term, pick a category or status, or choose a sort to browse all ${S.glossary.length} terms.</p>`;
    return;
  }
  let list = S.glossary;
  if (cat) list = list.filter((g) => g.category === cat);
  if (status) list = list.filter((g) => g.status === status);
  if (q) list = list.filter((g) =>
    (g.term || "").toLowerCase().includes(q) ||
    (g.definition || "").toLowerCase().includes(q) ||
    (g.synonyms || "").toLowerCase().includes(q));
  if (sort) {
    list = list.slice().sort((a, b) => (a.term || "").localeCompare(b.term || ""));
    if (sort === "za") list.reverse();
  }
  const cap = 60;
  $("#glossOut").innerHTML =
    `<p class="showing">Showing ${Math.min(cap, list.length)} of ${list.length} terms</p>` +
    list.slice(0, cap).map((g) => `
      <div class="gloss-card">
        <b>${esc(g.term)}</b>
        <div class="gloss-meta">
          ${g.category ? `<span class="badge cat">${esc(g.category)}</span>` : ""}
          ${g.status && g.status !== "Current" ? `<span class="badge warn">${esc(g.status)}</span>` : ""}
        </div>
        <div class="gloss-def">${esc(g.definition)}</div>
        ${g.synonyms ? `<div class="gloss-syn">Also called: ${esc(g.synonyms)}</div>` : ""}
      </div>`).join("");
}

/* ---------- gaps ---------- */

const ICONS = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.9A8 8 0 1 1 21 12z"/><line x1="9" y1="10" x2="15" y2="10"/><line x1="9" y1="13" x2="13" y2="13"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6c-1.5-1.6-3.7-2-6-2H4v14h2.5c2 0 4 .4 5.5 2 1.5-1.6 3.5-2 5.5-2H20V4h-2c-2.3 0-4.5.4-6 2z"/><line x1="12" y1="6" x2="12" y2="20"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  draft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>',
  quiz: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.1 9a3 3 0 1 1 4.6 2.5c-.9.6-1.7 1.3-1.7 2.5"/><line x1="12" y1="17" x2="12" y2="17"/><circle cx="12" cy="12" r="10"/></svg>',
};

const HOME_CARDS = [
  { action: "switchTab('search')", icon: "search", title: "Find a document", color: "teal" },
  { action: "switchTab('ask')", icon: "chat", title: "Ask a question", color: "navy" },
  { action: "switchTab('glossary')", icon: "book", title: "Look up a term", color: "yellow" },
  { action: "goDraft()", icon: "draft", title: "Draft a new SOP or policy", color: "brown" },
];

function renderHome() {
  $("#homeGrid").innerHTML = HOME_CARDS.map((c) => `
    <button class="home-card home-card--${c.color}" onclick="${c.action}">
      <span class="home-head"><span class="home-icon">${ICONS[c.icon]}</span>
      <span class="home-title">${c.title}</span></span>
    </button>`).join("") + (S.quiz.length ? `
    <button class="home-card quiz-banner" onclick="goQuiz()">
      <span class="home-icon">${ICONS.quiz}</span>
      <span class="quiz-banner-text">
        <span class="home-title">Test your knowledge</span>
        <span class="quiz-banner-sub">Think you know your SOPs? Take the five question challenge.</span>
      </span>
      <span class="quiz-banner-cta">Start</span>
    </button>` : "");
}

// Open the dedicated Draft screen and focus the topic box.
function goDraft() {
  switchTab("draft");
  const box = $("#gapBox");
  setTimeout(() => box.focus(), 100);
}

/* ---------- knowledge game ---------- */

const QUIZ_ROUND = 5;
let G = null; // current game: {cat, qs, i, score}

function goQuiz() {
  switchTab("quiz");
  renderQuizHome();
}

function renderQuizHome() {
  G = null;
  $("#quizArea").innerHTML = `
    <h2>Test your knowledge</h2>
    <p class="hint">Pick a category and answer ${QUIZ_ROUND} quick questions.</p>
    <div class="quiz-cats">${S.quiz.map((c, idx) => `
      <button class="home-card home-card--${c.color}" onclick="startQuiz(${idx})">
        <span class="home-head"><span class="home-title">${esc(c.title)}</span></span>
        <span class="quiz-banner-sub">${esc(c.tagline)}</span>
      </button>`).join("")}
    </div>`;
}

function startQuiz(catIdx) {
  const cat = S.quiz[catIdx];
  const qs = cat.questions.slice();
  for (let i = qs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [qs[i], qs[j]] = [qs[j], qs[i]];
  }
  G = { cat, qs: qs.slice(0, QUIZ_ROUND), i: 0, score: 0 };
  renderQuizQuestion();
}

function renderQuizQuestion() {
  const q = G.qs[G.i];
  $("#quizArea").innerHTML = `
    <div class="quiz-top">
      <button class="quiz-back" onclick="renderQuizHome()">&larr; Categories</button>
      <span class="quiz-progress">${esc(G.cat.title)} &middot; Question ${G.i + 1} of ${G.qs.length}</span>
      <span class="quiz-score">Score ${G.score}</span>
    </div>
    <div class="quiz-card">
      <h3 class="quiz-q">${esc(q.q)}</h3>
      <div class="quiz-choices">${q.choices.map((c, i) => `
        <button class="quiz-choice" onclick="answerQuiz(${i})">${esc(c)}</button>`).join("")}
      </div>
      <div id="quizFeedback"></div>
    </div>`;
}

function answerQuiz(picked) {
  const q = G.qs[G.i];
  const right = picked === q.answer;
  if (right) G.score++;
  document.querySelectorAll(".quiz-choice").forEach((b, i) => {
    b.disabled = true;
    if (i === q.answer) b.classList.add("quiz-right");
    else if (i === picked) b.classList.add("quiz-wrong");
  });
  const doc = S.byId.get(q.doc);
  const last = G.i + 1 >= G.qs.length;
  $("#quizFeedback").innerHTML = `
    <div class="quiz-why ${right ? "quiz-why--right" : "quiz-why--wrong"}">
      <b>${right ? "Correct!" : "Not quite."}</b> ${esc(q.why)}
      ${doc ? `<div class="cites"><button class="cite-chip" onclick="openDoc('${doc.id}')">${esc(doc.number ? doc.number + " " : "")}${esc(doc.title)}</button></div>` : ""}
    </div>
    <p style="margin-top:14px"><button class="btn-primary" onclick="${last ? "renderQuizDone()" : "nextQuiz()"}">${last ? "See my score" : "Next question"}</button></p>`;
  document.querySelector(".quiz-score").textContent = "Score " + G.score;
}

function nextQuiz() {
  G.i++;
  renderQuizQuestion();
}

function renderQuizDone() {
  const s = G.score, n = G.qs.length;
  const rank =
    s === n ? ["SOP Superstar", "Perfect score. The documents would be proud of you."] :
    s >= n - 1 ? ["Almost Expert", "So close! One quick review and you own this category."] :
    s >= 3 ? ["Solid Start", "Good foundation. The source documents below each question have the rest."] :
    ["Future Expert", "Everyone starts somewhere. Try Ask a Question to explore this topic, then come back for a rematch."];
  $("#quizArea").innerHTML = `
    <div class="quiz-card quiz-done">
      <div class="quiz-done-score">${s} / ${n}</div>
      <h3>${rank[0]}</h3>
      <p class="hint">${rank[1]}</p>
      <p style="margin-top:18px">
        <button class="btn-primary" onclick="startQuiz(${S.quiz.indexOf(G.cat)})">Play again</button>
        <button class="btn-primary quiz-alt" onclick="renderQuizHome()">Pick another category</button>
      </p>
    </div>`;
}

const ASK_EXAMPLES = [
  "Is there a policy for parvo treatment?",
  "What is the stray hold for a cat with no ID?",
  "A stray dog with a microchip was adopted on day 3 without a chip trace being run. Did that follow policy?",
  "How do I handle a bite report?",
  "What has to happen before an animal can be euthanized?",
];

function renderAskExamples() {
  $("#askExamples").innerHTML = ASK_EXAMPLES.map((q) =>
    `<button class="example-chip" onclick="askExample(${JSON.stringify(q).replace(/"/g, "&quot;")})">${esc(q)}</button>`).join("");
}

function askExample(q) {
  $("#askBox").value = q;
  ask();
}

/* ---------- tabs & events ---------- */

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  // The quiz panel renders on demand; show the category picker unless a
  // round is already on screen.
  if (name === "quiz" && !$("#quizArea").innerHTML) renderQuizHome();
}

function initEvents() {
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (b) switchTab(b.dataset.tab);
  });
  $("#searchBox").addEventListener("input", () => renderResults(searchDocs($("#searchBox").value)));
  $("#typeFilter").addEventListener("change", () => renderResults(searchDocs($("#searchBox").value)));
  $("#catFilter").addEventListener("change", () => renderResults(searchDocs($("#searchBox").value)));
  $("#askBtn").addEventListener("click", ask);
  $("#askBox").addEventListener("keydown", (e) => { if (e.key === "Enter") ask(); });
  $("#gapBtn").addEventListener("click", draft);
  $("#gapBox").addEventListener("keydown", (e) => { if (e.key === "Enter") draft(); });
  $("#glossBox").addEventListener("input", renderGlossary);
  $("#glossCat").addEventListener("change", renderGlossary);
  $("#glossStatus").addEventListener("change", renderGlossary);
  $("#glossSort").addEventListener("change", renderGlossary);
  $("#viewerClose").addEventListener("click", () => $("#viewer").classList.add("hidden"));
  $("#viewer").addEventListener("click", (e) => { if (e.target.id === "viewer") $("#viewer").classList.add("hidden"); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#viewer").classList.add("hidden"); });
}

initAuth();
initEvents();
boot();
