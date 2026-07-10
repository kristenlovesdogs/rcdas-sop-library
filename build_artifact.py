#!/usr/bin/env python3
"""Package the app as a single self-contained HTML file for Artifact hosting.

The artifact host blocks all external requests, so everything is inlined:
data as a JS object (searchText stripped and recomputed client-side to save
~40 percent), logos as data URIs, Montserrat as @font-face data URIs, and the
AI endpoints replaced with client-side demo responses.

Usage: python3 build_artifact.py <output.html> <font_dir>
"""
import base64
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = Path(sys.argv[1])
FONTS = Path(sys.argv[2])


def datauri(path, mime):
    return f"data:{mime};base64," + base64.b64encode(Path(path).read_bytes()).decode()


# ---------- data ----------
corpus = json.loads((HERE / "data/corpus.json").read_text())
for d in corpus["documents"]:
    d.pop("searchText", None)
data = {
    "corpus": corpus,
    "glossary": json.loads((HERE / "data/glossary.json").read_text()),
    "faq": json.loads((HERE / "data/faq.json").read_text()),
    "gaps": json.loads((HERE / "data/gaps.json").read_text()),
    "guide": json.loads((HERE / "data/guide.json").read_text()),
}
data_js = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")

# ---------- app.js ----------
js = (HERE / "app.js").read_text()

old = '''  const [corpus, glossary, faq, gaps, guide, health] = await Promise.all([
    fetch("data/corpus.json").then((r) => r.json()),
    fetch("data/glossary.json").then((r) => r.json()),
    fetch("data/faq.json").then((r) => r.json()),
    fetch("data/gaps.json").then((r) => r.json()),
    fetch("data/guide.json").then((r) => r.json()),
    fetch("api/health").then((r) => r.json()).catch(() => ({ live: false })),
  ]);'''
new = '''  const { corpus, glossary, faq, gaps, guide } = window.__DATA;
  const health = { live: false };'''
assert old in js
js = js.replace(old, new)

old = '''    walk(d.sections);
    d.headText = heads.join(" ").toLowerCase();
  });'''
new = '''    walk(d.sections);
    d.headText = heads.join(" ").toLowerCase();
    if (!d.searchText) {
      const parts = [d.purpose || "", d.scope || "", d.authority || ""];
      (d.definitions || []).forEach((t) => parts.push((t.term || "") + " " + (t.def || "")));
      const w2 = (ss) => (ss || []).forEach((x) => {
        parts.push(x.heading || "");
        (x.steps || []).forEach((st) => parts.push(typeof st === "string" ? st : (st.text || st.step || "")));
        w2(x.subsections);
      });
      w2(d.sections);
      (d.references || []).forEach((r) => parts.push(typeof r === "string" ? r : JSON.stringify(r)));
      d.searchText = parts.join(" ").toLowerCase();
    }
  });'''
assert old in js
js = js.replace(old, new)

old_call = '''async function callAPI(path, payload, outEl, renderFn) {
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
}'''
new_call = '''function demoAPI(path, payload) {
  const docs = payload.docs || [];
  const names = docs.slice(0, 5).map((d) => d.number || d.title).join(", ") || "none";
  if (path.includes("ask")) {
    return { mode: "demo", text: `Preview answer for: "${payload.question}"

In the full version, the assistant reads the retrieved documents (${names}) and writes a plain-language answer citing each document it relies on, with cautions where fees, contacts, or statute citations may be dated. The document retrieval below is real: open any citation to read the source directly.` };
  }
  if (path.includes("check")) {
    return { mode: "demo", text: `Preview comparison.

In the full version, the assistant compares the described situation against the retrieved documents (${names}) and reports: which documents apply, what they require, where the situation aligns or differs, and recommended next steps. It never issues a disciplinary verdict. The retrieved documents below are real.` };
  }
  const rel = docs.slice(0, 3).map((d) => ("- " + (d.number || "") + " " + d.title).trim()).join("\\n");
  return { mode: "demo", text: `DRAFT PENDING APPROVAL. Prepared for leadership review; not in effect until approved and signed by the Director.

SUBJECT: ${payload.topic}

PURPOSE: To establish a uniform, research-based procedure for ${payload.topic.toLowerCase()} at all department campuses.

AUTHORITY: Director of Animal Services

SCOPE: All DAS personnel involved in this activity.

DEFINITIONS: (Populated in the full version from the master glossary and shelter medicine references.)

PROCEDURE:
  A. Preparation
     1. (The full version writes complete numbered steps here, grounded in the ASV Guidelines for Standards of Care and current shelter medicine literature.)
  B. Execution
     1. ...
  C. Documentation
     1. Record all actions in Chameleon per Policy 000-01.

CAMPUS VARIATIONS: None identified; confirm during review.

RELATED DOCUMENTS:
${rel || "- (none retrieved)"}

REFERENCES: ASV Guidelines for Standards of Care in Animal Shelters, 2nd ed.; additional peer-reviewed sources added in the full version.

REVISION HISTORY: Draft prepared for review.` };
}

async function callAPI(path, payload, outEl, renderFn) {
  outEl.innerHTML = `<p class="thinking">Reading the relevant documents...</p>`;
  await new Promise((r) => setTimeout(r, 700));
  renderFn(demoAPI(path, payload));
}'''
assert old_call in js
js = js.replace(old_call, new_call)

# client-facing wording for demo notes
js = js.replace(
    "Demo mode: this answer was generated without the AI service. Add an Anthropic API key to enable real grounded answers. The document retrieval above is real.",
    "Shared preview: AI answers are illustrative here. The document search and retrieval are fully functional.")
js = js.replace(
    "Demo mode: add an Anthropic API key for real analysis. The document retrieval above is real.",
    "Shared preview: AI analysis is illustrative here. The document search and retrieval are fully functional.")
js = js.replace(
    "Demo mode: this is a template skeleton. With an API key, the tool researches published, research-based best practices (ASV Guidelines, shelter medicine literature) and writes a complete draft.",
    "Shared preview: this is the template skeleton. The full version researches published, research-based best practices (ASV Guidelines, shelter medicine literature) and writes a complete draft.")
js = js.replace('mode.textContent = S.live ? "AI: live" : "AI: demo mode (no API key configured)";',
                'mode.textContent = "Shared preview build. AI features shown in demo mode.";')

# ---------- styles ----------
css = (HERE / "styles.css").read_text()
faces = []
for w in ("400", "600", "700"):
    uri = datauri(FONTS / f"mont-{w}.woff2", "font/woff2")
    faces.append(f"@font-face {{ font-family: 'Montserrat'; font-style: normal; font-weight: {w}; font-display: swap; src: url({uri}) format('woff2'); }}")
css = "\n".join(faces) + "\n:root { color-scheme: light; }\nhtml, body { background: #f6f7f9; }\n" + css

# ---------- html body ----------
html = (HERE / "index.html").read_text()
body = html[html.index("<body>") + len("<body>"):html.index("</body>")]
body = re.sub(r'<script src="app\.js[^"]*"></script>', "", body)
body = body.replace('src="logo.jpg"', f'src="{datauri(HERE / "logo.jpg", "image/jpeg")}"')
body = body.replace('src="logo-stacked.png"', f'src="{datauri(HERE / "logo-stacked.png", "image/png")}"')
body = body.replace("Working mockup.", "Preview build for RCDAS review.")

out = (
    "<title>RCDAS Policy &amp; Procedure Library</title>\n"
    f"<style>\n{css}\n</style>\n"
    f"{body}\n"
    f"<script>window.__DATA = {data_js};</script>\n"
    f"<script>\n{js}\n</script>\n"
)
OUT.write_text(out)
print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")
