# RCDAS Policy & Procedure Library (working mockup)

A staff-facing web app over the consolidated Riverside County DAS document set.
Built July 9, 2026. Canonical corpus lives in
`/Users/kristenhassen/Documents/Claude/Projects/Riverside County DAS/OUTPUTS/SOP Consolidation/`.

The app lives here in `/Users/Shared/rcdas-sop-library/` because macOS privacy
controls block the preview server from reading Desktop and Documents. A symlink
"RCDAS SOP Library" on the Desktop points here.

## Files

- `build_corpus.py`  Compiles `data/corpus.json` (200 active documents,
  each with a `provenance` field from RCDAS_Live_Tracker.xlsx (a copy of
  the team's live "RCDAS Policies and Procedures" tracker): "Updated by staff"
  when the New Draft column is filled OR Status is Done, else "Not yet updated"),
  `data/glossary.json` (603 terms incl. extras), `data/gaps.json`. Filters
  against RCDAS_Document_Registry.xlsx (Active only), strips APET references
  (D-9), never touches `_Retired - do not publish/`. Re-run after any corpus
  change (run parse_docs.py first if the staff docs changed).
- `parse_docs.py`  Parses `source_docs/` (plain-text exports of the New Staff
  Reference Guide and the Cicconi Data Glossary v1.0 Google Docs, plus the
  hand-curated SAC Animal Welfare Glossary terms from Glossary_FINAL.pdf) into
  `data/guide.json` and `data/extra_terms.json` (terms missing from the master
  glossary). The guide has no tab of its own: its chapters feed the FAQ
  (citation chips open them in the viewer) and the Ask retrieval corpus, but
  they are hidden from search results per Kristen's direction.
  Refresh the exports with:
  curl -sL "https://docs.google.com/document/d/<id>/export?format=txt"
- `data/faq.json`  22 common questions informed by the New Staff Guide and the
  library, shown inside Ask a Question. Every entry cites document ids.
- `server.py`  Serves the app on port 8642 and provides /api/ask, /api/check,
  /api/draft. With ANTHROPIC_API_KEY set they call Claude (model override:
  RCDAS_MODEL); without it they return labeled demo responses.
- `index.html`, `styles.css`, `app.js`  The front end: mock sign-in, search
  (synonym expansion, IDF weighting, section-heading boosts), document viewer,
  Ask a Question (with the FAQ merged in), Compliance Check, and Glossary.
  Sign-in lands on a Home screen of four brand-colored option cards; Find a
  Document starts with category boxes, never a wall of documents. The last
  category box, "Not Written Yet", opens the curated list in data/gaps.json
  (SOPs most shelters have that RCDAS does not, grouped by domain, each with
  a Create a draft button); the Draft a procedure box below the categories
  takes free-form topics. Document types are Policy and Procedure (the
  registry's "Protocol" is relabeled at build time). Branding follows the DAS Brand Reference Sheet:
  Turquoise #00B5CC, Brown #572700, Navy #002858, Yellow #FDD963, Gray
  #C7C9D4, Montserrat. Logos: logo.jpg (round mark), logo-stacked.png
  (official stacked logo, sign-in page).

## Run locally

    python3 server.py            # demo mode, open sign-in
    ANTHROPIC_API_KEY=... python3 server.py   # live AI mode

## Hosting (Render + GitHub)

The repo deploys to Render as a Python web service (render.yaml is the
blueprint; no third-party dependencies). Render environment variables:

- RCDAS_PASSCODE  shared staff password for sign-in (unset = accept any)
- ANTHROPIC_API_KEY  enables live AI answers, checks, and drafts

## Publishing document changes

After editing documents in the SOP Consolidation folder (or the staff docs
in source_docs/), run:

    ./publish.sh

It recompiles the data files (parse_docs.py + build_corpus.py), commits, and
pushes to GitHub; Render redeploys the site automatically within a minute or
two. Note: publish.sh must run on a machine with access to the
SOP Consolidation folder (Kristen's Mac).

## Not yet done (production path)

- County SSO if required (shared password auth is in place via RCDAS_PASSCODE;
  mock sign-in accepts anything when unset).
- Document statuses beyond "Draft pending approval" (edit log has the data).
- Six dual-listed documents (000-36, 000-46, 000-51, 000-58, 000-76, Needs
  Rescue) are flagged in the UI pending leadership resolution.
