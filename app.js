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
  const [corpus, glossary, faq, gaps, guide, health] = await Promise.all([
    fetch("data/corpus.json").then((r) => r.json()),
    fetch("data/glossary.json").then((r) => r.json()),
    fetch("data/faq.json").then((r) => r.json()),
    fetch("data/gaps.json").then((r) => r.json()),
    fetch("data/guide.json").then((r) => r.json()),
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

  $("#corpusStat").textContent =
    `${corpus.counts.documents} documents | ${corpus.counts.policies} policies | ${corpus.counts.procedures} procedures`;
  if (health.auth) $("#gateNote").textContent = "Sign in with your email and the department access password.";
  const mode = $("#modeChip");
  mode.textContent = S.live ? "AI: live" : "AI: demo mode (no API key configured)";
  mode.className = "mode-chip " + (S.live ? "live" : "demo");

  $("#glossBox").placeholder = `Search ${glossary.length} terms: intake types, outcome codes, SAC metrics, SOP definitions`;
  buildFilters();
  buildGlossaryFilters();
  renderFAQ();
  renderHome();
  renderGaps();
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
  $("#results").innerHTML = `<div class="cat-grid">` + cats.map((c) => `
    <button class="cat-card" onclick="browseCategory(${JSON.stringify(c).replace(/"/g, "&quot;")})">
      <span class="cat-name">${esc(c)}</span>
      <span class="cat-count">${counts.get(c)} ${counts.get(c) === 1 ? "document" : "documents"}</span>
    </button>`).join("") + `</div>`;
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
        <div class="result-head">${badges(d)}</div>
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
    const txt = st.text || st.step || JSON.stringify(st);
    let sub = "";
    if (st.substeps && st.substeps.length) sub = renderSteps(st.substeps);
    return `<li>${esc(txt)}${sub}</li>`;
  }).join("") + "</ol>";
}

function renderSections(sections, depth = 0) {
  if (!sections || !sections.length) return "";
  return sections.map((s) => {
    const head = depth === 0
      ? `<h3>${esc(s.heading || "")}</h3>`
      : `<div class="doc-sub">${esc(s.heading || "")}</div>`;
    return `<div class="doc-section">${s.heading ? head : ""}
      ${s.body ? `<p>${esc(s.body)}</p>` : ""}
      ${renderSteps(s.steps)}
      ${renderSections(s.subsections, depth + 1)}
    </div>`;
  }).join("");
}

function openDoc(id) {
  const d = S.byId.get(id);
  if (!d) return;
  const staleNote = "Consolidation draft. Fees, contact names, and statute citations may predate current law until substantive review completes. Confirm anything time-sensitive with your supervisor.";
  let banners = d.type === "Guide"
    ? `<div class="doc-banner info">Staff reference guide. Source: ${esc(d.source || "RCDAS New Staff Reference Guide")}.</div>`
    : `<div class="doc-banner">${esc(d.status)}. ${esc(staleNote)}</div>`;
  if (d.dualListed) banners += `<div class="doc-banner warn">This document appears on both the active and sunsetted tracker tabs. Its status is unresolved; confirm with leadership before relying on it.</div>`;
  if (d.flag) banners += `<div class="doc-banner warn">Registry flag: ${esc(d.flag)}</div>`;

  const defs = (d.definitions || []).map((x) =>
    `<div class="def-item"><b>${esc(x.term)}</b>: ${esc(x.def)}</div>`).join("");

  const rel = (d.related || []).map((r) => {
    const label = typeof r === "string" ? r : (r.number || r.title || "");
    const target = S.docs.find((x) => x.number === label || x.title === label || x.id === label);
    return target
      ? `<button class="cite-chip" onclick="openDoc('${target.id}')">${esc(target.number ? target.number + " " : "")}${esc(target.title)}</button>`
      : `<span class="badge cat">${esc(typeof r === "string" ? r : JSON.stringify(r))}</span>`;
  }).join("");

  const campus = (d.campusVariations || []).map((c) => {
    if (typeof c === "string") return `<li>${esc(c)}</li>`;
    return `<li><b>${esc(c.campus || "")}</b>: ${esc(c.variation || c.note || JSON.stringify(c))}</li>`;
  }).join("");

  const revs = (d.revisions || []).map((r) => {
    if (typeof r === "string") return `<div class="rev-item">${esc(r)}</div>`;
    return `<div class="rev-item">${esc(r.date || "")} ${esc(r.desc || r.description || "")}</div>`;
  }).join("");

  $("#viewerBody").innerHTML = `
    <div class="doc-head">
      <div class="letterhead"><b>Riverside County Department of Animal Services</b>
      <span>${d.type === "Policy" ? "Departmental Policy" : d.type === "Guide" ? "New Staff Reference Guide" : "Standard Operating Procedure"}</span></div>
      <div class="doc-badges">${badges(d)}</div>
      <h2>${esc(d.title)}</h2>
    </div>
    ${banners}
    <dl class="meta-grid">
      ${d.authority ? `<dt>Authority</dt><dd>${esc(d.authority)}</dd>` : ""}
      ${d.scope ? `<dt>Scope</dt><dd>${esc(d.scope)}</dd>` : ""}
      ${d.supersedes ? `<dt>Supersedes</dt><dd>${esc(d.supersedes)}</dd>` : ""}
    </dl>
    ${d.purpose ? `<div class="doc-section"><h3>Purpose</h3><p>${esc(d.purpose)}</p></div>` : ""}
    ${defs ? `<div class="doc-section"><h3>Definitions</h3>${defs}</div>` : ""}
    ${renderSections(d.sections)}
    ${campus ? `<div class="doc-section"><h3>Campus variations</h3><ul>${campus}</ul></div>` : ""}
    ${(d.references || []).length ? `<div class="doc-section"><h3>References</h3><ul>${d.references.map((r) => `<li>${esc(typeof r === "string" ? r : JSON.stringify(r))}</li>`).join("")}</ul></div>` : ""}
    ${rel ? `<div class="doc-section"><h3>Related documents</h3><div class="rel-chips">${rel}</div></div>` : ""}
    ${revs ? `<div class="doc-section"><h3>Revision history</h3>${revs}</div>` : ""}
  `;
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
  outEl.innerHTML = `<p class="thinking">Reading the relevant documents...</p>`;
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
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
  const docs = retrieve(q);
  callAPI("api/ask", { question: q, docs }, $("#askOut"), (data) => {
    $("#askOut").innerHTML = `
      <div class="answer"><h4>Answer</h4>${esc(data.text)}
      ${citeChips(docs)}</div>
      ${data.mode === "demo" ? `<div class="demo-note">Demo mode: this answer was generated without the AI service. Add an Anthropic API key to enable real grounded answers. The document retrieval above is real.</div>` : ""}`;
  });
}

function check() {
  const situation = $("#checkBox").value.trim();
  if (!situation) return;
  const docs = retrieve(situation, 5);
  callAPI("api/check", { situation, docs }, $("#checkOut"), (data) => {
    $("#checkOut").innerHTML = `
      <div class="answer"><h4>Policy comparison</h4>${esc(data.text)}
      ${citeChips(docs)}</div>
      <div class="demo-note">This comparison is informational and is not a disciplinary finding or legal advice. Personnel concerns follow the chain of command.</div>
      ${data.mode === "demo" ? `<div class="demo-note">Demo mode: add an Anthropic API key for real analysis. The document retrieval above is real.</div>` : ""}`;
  });
}

function requestDraft(topic) {
  switchTab("search");
  $("#gapBox").value = topic;
  $("#gapBox").scrollIntoView({ behavior: "smooth", block: "center" });
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
  let list = S.glossary;
  if (cat) list = list.filter((g) => g.category === cat);
  if (status) list = list.filter((g) => g.status === status);
  if (q) list = list.filter((g) =>
    (g.term || "").toLowerCase().includes(q) ||
    (g.definition || "").toLowerCase().includes(q) ||
    (g.synonyms || "").toLowerCase().includes(q));
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

/* ---------- FAQ / gaps ---------- */

function renderFAQ() {
  $("#faqNote").textContent = S.faq.note;
  $("#faqOut").innerHTML = S.faq.items.map((it, i) => `
    <div class="faq-item" id="faq-${i}" onclick="this.classList.toggle('open')">
      <div class="faq-q"><span>${esc(it.q)}</span><span>+</span></div>
      <div class="faq-a">${esc(it.a)}
        <div class="cites">${it.docs.map((id) => {
          const d = S.byId.get(id);
          return d ? `<button class="cite-chip" onclick="event.stopPropagation();openDoc('${id}')">${esc(d.number ? d.number + " " : "")}${esc(d.title)}</button>` : "";
        }).join("")}</div>
      </div>
    </div>`).join("");
}

const ICONS = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.9A8 8 0 1 1 21 12z"/><line x1="9" y1="10" x2="15" y2="10"/><line x1="9" y1="13" x2="13" y2="13"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6c-1.5-1.6-3.7-2-6-2H4v14h2.5c2 0 4 .4 5.5 2 1.5-1.6 3.5-2 5.5-2H20V4h-2c-2.3 0-4.5.4-6 2z"/><line x1="12" y1="6" x2="12" y2="20"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  draft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>',
};

const HOME_CARDS = [
  { tab: "search", icon: "search", title: "Find a document", color: "teal" },
  { tab: "ask", icon: "chat", title: "Ask a question", color: "navy" },
  { tab: "glossary", icon: "book", title: "Look up a term", color: "yellow" },
  { tab: "check", icon: "shield", title: "Check a situation", color: "brown" },
];

function renderHome() {
  $("#homeGrid").innerHTML = HOME_CARDS.map((c) => `
    <button class="home-card home-card--${c.color}" onclick="switchTab('${c.tab}')">
      <span class="home-head"><span class="home-icon">${ICONS[c.icon]}</span>
      <span class="home-title">${c.title}</span></span>
      ${c.desc ? `<span class="home-desc">${c.desc}</span>` : ""}
    </button>`).join("");
}

function renderGaps() {
  $("#gapsOut").innerHTML = S.gaps.map((g) => `
    <div class="gap-card">
      <div><b>${esc(g.topic)}</b><div class="gap-note">${esc(g.note)}</div></div>
      <button class="btn-draft" onclick="requestDraft('${esc(g.topic).replace(/'/g, "\\'")}')">Create a draft</button>
    </div>`).join("");
}

/* ---------- tabs & events ---------- */

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
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
  $("#checkBtn").addEventListener("click", check);
  $("#gapBtn").addEventListener("click", draft);
  $("#gapBox").addEventListener("keydown", (e) => { if (e.key === "Enter") draft(); });
  $("#glossBox").addEventListener("input", renderGlossary);
  $("#glossCat").addEventListener("change", renderGlossary);
  $("#glossStatus").addEventListener("change", renderGlossary);
  $("#viewerClose").addEventListener("click", () => $("#viewer").classList.add("hidden"));
  $("#viewer").addEventListener("click", (e) => { if (e.target.id === "viewer") $("#viewer").classList.add("hidden"); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#viewer").classList.add("hidden"); });
}

initAuth();
initEvents();
boot();
