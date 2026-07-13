#!/usr/bin/env python3
"""RCDAS Policy & Procedure Library server.

Serves the static app and provides the AI endpoints. If ANTHROPIC_API_KEY is
set in the environment, /api/ask, /api/check, and /api/draft call Claude;
otherwise they return clearly labeled demo-mode responses so the mockup works
end to end without a key.

Run:  python3 server.py  (port 8642)
"""
import json
import re
import os
import threading
import urllib.request
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_env():
    """Load KEY=VALUE pairs from a local .env (gitignored) into the
    environment, without overriding values already set by the host."""
    path = os.path.join(HERE, ".env")
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


_load_env()

# Render (and most hosts) inject PORT; bind publicly there, locally otherwise
PORT = int(os.environ.get("PORT", 8642))
HOST = "0.0.0.0" if "PORT" in os.environ else "127.0.0.1"
API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
MODEL = os.environ.get("RCDAS_MODEL", "claude-opus-4-8")
# Shared staff password. If unset (local dev), any sign-in is accepted.
PASSCODE = os.environ.get("RCDAS_PASSCODE", "").strip()

# Draft research runs for several minutes, longer than hosting proxies allow
# a single request to live (Render/Cloudflare cut off around 100s). So
# /api/draft returns a job id immediately, the work happens in a thread, and
# the client polls /api/draft/status. In-memory is fine: one instance, and a
# restart mid-job just means the client sees "unknown job" and can retry.
JOBS = {}
JOBS_LOCK = threading.Lock()


def run_draft_job(job_id, topic, docs):
    try:
        text = call_claude_research(
            SYSTEM_DRAFT,
            f"DRAFT REQUEST TOPIC: {topic}\n\nPOSSIBLY RELATED RCDAS DOCUMENTS:\n{doc_block(docs)}")
        with JOBS_LOCK:
            JOBS[job_id] = {"status": "done", "mode": "live", "text": text}
    except Exception as e:
        with JOBS_LOCK:
            JOBS[job_id] = {"status": "error", "error": str(e)}

STYLE = (
    "Write in measured, professional prose. Never use em dashes. "
    "Be direct and concrete. Address shelter staff who may be new to the field."
)

SYSTEM_ASK = (
    "You answer questions for staff of the Riverside County Department of Animal "
    "Services using ONLY the policy and procedure excerpts provided. Staff may "
    "ask a plain question (\"what is the stray hold for a cat with no ID?\") or "
    "describe a situation and ask whether it followed policy (\"a microchipped "
    "stray was adopted on day 3 without a chip trace; did that follow policy?\"). "
    "Rules: "
    "1) Answer from the excerpts alone; if they do not contain the answer, say no "
    "current RCDAS document covers it and suggest requesting a draft. "
    "2) Cite the document number or title for every claim. "
    "3) For a situation question, structure the reply: which documents apply, "
    "what they require, and where the described situation aligns with or differs "
    "from those requirements. Describe policy requirements and differences only. "
    "Never render a verdict of guilt, discipline, or legal liability; this is an "
    "informational comparison, and personnel matters follow the chain of command. "
    "4) All documents are consolidation drafts pending approval; if the question "
    "involves fees, named contacts, or statute citations, add a one-line caution "
    "that these may predate current law. "
    "5) For anything involving euthanasia, use of force, or public health, remind "
    "the reader to confirm with a supervisor. " + STYLE
)

SYSTEM_CHECK = (
    "You help Riverside County Department of Animal Services staff compare a "
    "described situation against department policy and procedure excerpts. Structure your reply: "
    "1) Which provided documents apply (cite number and title). "
    "2) What those documents require, quoted or closely paraphrased. "
    "3) Where the described situation aligns with or differs from those requirements. "
    "4) What the staff member should do next (typically notify a supervisor). "
    "Never render a verdict of guilt, discipline, or legal liability; you describe "
    "policy requirements and differences only. If the excerpts do not cover the "
    "situation, say so plainly. " + STYLE
)

SYSTEM_DRAFT = (
    "You draft Standard Operating Procedures for the Riverside County Department "
    "of Animal Services (RCDAS), a large open-intake municipal shelter system in "
    "Southern California (four campuses, 30,000+ animals a year). "
    "RESEARCH FIRST: before writing, use web search to ground the draft in "
    "published, research-based best practices. Search, at minimum: the "
    "Association of Shelter Veterinarians (ASV) Guidelines for Standards of Care "
    "in Animal Shelters (current edition), the UC Davis Koret Shelter Medicine "
    "Program, the University of Florida Maddie's Shelter Medicine Program, "
    "Maddie's Fund, AVMA and AAHA guidance, peer-reviewed shelter medicine "
    "literature (e.g. JAVMA, Journal of Shelter Medicine and Community Animal "
    "Health), and applicable California law and code where relevant. Prefer "
    "primary and university sources over blogs. Where sources conflict, follow "
    "the most current research-based guidance and note the divergence. "
    "THEN WRITE a complete, operational draft: concrete numbered steps a staff "
    "member could follow today, with specific criteria, timeframes, dosing or "
    "protocol parameters where the literature provides them, and documentation "
    "requirements. Use exactly this template structure with these headings: "
    "SUBJECT, PURPOSE, AUTHORITY (Director of Animal Services), SCOPE, "
    "DEFINITIONS, PROCEDURE (numbered steps grouped under lettered subheadings), "
    "CAMPUS VARIATIONS (note if none), RELATED DOCUMENTS, REFERENCES, "
    "REVISION HISTORY (single line: Draft prepared for review). "
    "REFERENCES must cite the actual sources you consulted, with titles, "
    "publishers, years, and URLs. "
    "Begin the draft with the line 'DRAFT PENDING APPROVAL. Prepared for "
    "leadership review; not in effect until approved and signed by the Director.' "
    "If related RCDAS documents are provided, align terminology with them "
    "(Chameleon codes, campus names, position titles) and list them under "
    "RELATED DOCUMENTS. " + STYLE
)


def _post_messages(body):
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode(),
        headers={
            "content-type": "application/json",
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
        },
    )
    with urllib.request.urlopen(req, timeout=480) as r:
        return json.loads(r.read())


def call_claude_research(system, user_text, max_tokens=16000):
    """Draft with live web research. Web search runs server-side at Anthropic.
    Resumes on pause_turn (server tool loop) and continues on max_tokens
    (thinking + research can consume a large share of the output budget)."""
    first_user = {"role": "user", "content": user_text}
    messages = [first_user]
    tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 8}]
    parts = []
    for i in range(8):
        data = _post_messages({
            "model": MODEL,
            "max_tokens": max_tokens,
            "system": system,
            "thinking": {"type": "adaptive"},
            "tools": tools,
            "messages": messages,
        })
        parts.append("".join(b.get("text", "") for b in data.get("content", [])))
        reason = data.get("stop_reason")
        print(f"draft research: iteration {i} stop_reason={reason}")
        if reason == "pause_turn":
            messages = [first_user, {"role": "assistant", "content": data["content"]}]
            continue
        if reason == "max_tokens":
            messages = [first_user,
                        {"role": "assistant", "content": data["content"]},
                        {"role": "user", "content": "You hit the output token limit. Continue the draft exactly where you left off. Do not repeat anything you already wrote and do not restart."}]
            continue
        break
    text = "".join(parts)
    # The model narrates its research before the letterhead; keep only the SOP,
    # from the DRAFT banner through the end of the revision history.
    m = re.search(r"DRAFT PENDING APPROVAL", text)
    if m:
        text = text[m.start():]
    m = re.search(r"REVISION HISTORY[:\s\S]*?Draft prepared for review\.", text)
    if m:
        text = text[:m.end()]
    return text.strip()


def call_claude(system, user_text, max_tokens=2500):
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps({
            "model": MODEL,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user_text}],
        }).encode(),
        headers={
            "content-type": "application/json",
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        data = json.loads(r.read())
    return "".join(b.get("text", "") for b in data.get("content", []))


def doc_block(docs):
    parts = []
    for d in docs or []:
        label = f"{d.get('number') or ''} {d.get('title','')}".strip()
        parts.append(f"=== {d.get('type','Document')}: {label} (status: {d.get('status','')}) ===\n{d.get('excerpt','')}")
    return "\n\n".join(parts) if parts else "(no documents retrieved)"


def demo_ask(q, docs):
    names = ", ".join(f"{(d.get('number') or d.get('title'))}" for d in (docs or [])[:4]) or "none"
    return (
        f"Demo answer for: \"{q}\"\n\n"
        f"In live mode, Claude reads the retrieved documents ({names}) and writes a "
        "plain-language answer citing each document it relies on, with cautions for "
        "stale fees, contacts, or statute citations. The retrieval shown below is real: "
        "these are the documents the answer would be grounded in. Open any of them to "
        "read the source directly."
    )


def demo_check(situation, docs):
    names = ", ".join(f"{(d.get('number') or d.get('title'))}" for d in (docs or [])[:5]) or "none"
    return (
        "Demo comparison.\n\n"
        f"In live mode, Claude compares the described situation against the retrieved "
        f"documents ({names}) and reports: which documents apply, what they require, "
        "where the situation aligns or differs, and recommended next steps. It never "
        "issues a disciplinary verdict. The retrieved documents below are real."
    )


def demo_draft(topic, docs):
    rel = "\n".join(f"- {(d.get('number') or '')} {d.get('title','')}".strip() for d in (docs or [])[:3])
    return (
        "DRAFT PENDING APPROVAL. Prepared for leadership review; not in effect until "
        "approved and signed by the Director.\n\n"
        f"SUBJECT: {topic}\n\n"
        "PURPOSE: To establish a uniform, research-based procedure for "
        f"{topic.lower()} at all department campuses.\n\n"
        "AUTHORITY: Director of Animal Services\n\n"
        "SCOPE: All DAS personnel involved in this activity.\n\n"
        "DEFINITIONS: (Populated in live mode from the master glossary and shelter "
        "medicine references.)\n\n"
        "PROCEDURE:\n  A. Preparation\n     1. (Live mode writes complete numbered "
        "steps here, grounded in the ASV Guidelines for Standards of Care and current "
        "shelter medicine literature.)\n  B. Execution\n     1. ...\n  C. Documentation\n"
        "     1. Record all actions in Chameleon per Policy 000-01.\n\n"
        "CAMPUS VARIATIONS: None identified; confirm during review.\n\n"
        f"RELATED DOCUMENTS:\n{rel or '- (none retrieved)'}\n\n"
        "REFERENCES: ASV Guidelines for Standards of Care in Animal Shelters, 2nd ed.; "
        "additional peer-reviewed sources added in live mode.\n\n"
        "REVISION HISTORY: Draft prepared for review."
    )


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def end_headers(self):
        # dev server: never let browsers cache a stale or half-written asset
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/api/health":
            return self._json({"live": bool(API_KEY), "auth": bool(PASSCODE),
                               "model": MODEL if API_KEY else None})
        if self.path.startswith("/api/draft/status"):
            from urllib.parse import urlparse, parse_qs
            job_id = parse_qs(urlparse(self.path).query).get("job", [""])[0]
            with JOBS_LOCK:
                job = JOBS.get(job_id)
                if job and job["status"] in ("done", "error"):
                    del JOBS[job_id]
            if job is None:
                return self._json({"error": "unknown job; the server may have restarted. Please try the draft again."}, 404)
            if job["status"] == "error":
                return self._json({"error": job["error"]}, 500)
            return self._json(job)
        return super().do_GET()

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "bad json"}, 400)
        docs = payload.get("docs", [])
        path = self.path.rstrip("/")
        if path == "/api/login":
            ok = (not PASSCODE) or payload.get("password", "") == PASSCODE
            return self._json({"ok": ok})
        try:
            if path == "/api/ask":
                q = payload.get("question", "").strip()
                if not q:
                    return self._json({"error": "empty question"}, 400)
                if API_KEY:
                    text = call_claude(SYSTEM_ASK, f"STAFF QUESTION: {q}\n\nDOCUMENT EXCERPTS:\n{doc_block(docs)}")
                    return self._json({"mode": "live", "text": text})
                return self._json({"mode": "demo", "text": demo_ask(q, docs)})

            if path == "/api/check":
                s = payload.get("situation", "").strip()
                if not s:
                    return self._json({"error": "empty situation"}, 400)
                if API_KEY:
                    text = call_claude(SYSTEM_CHECK, f"DESCRIBED SITUATION: {s}\n\nDOCUMENT EXCERPTS:\n{doc_block(docs)}")
                    return self._json({"mode": "live", "text": text})
                return self._json({"mode": "demo", "text": demo_check(s, docs)})

            if path == "/api/draft":
                t = payload.get("topic", "").strip()
                if not t:
                    return self._json({"error": "empty topic"}, 400)
                if API_KEY:
                    job_id = uuid.uuid4().hex
                    with JOBS_LOCK:
                        JOBS[job_id] = {"status": "running"}
                    threading.Thread(target=run_draft_job, args=(job_id, t, docs),
                                     daemon=True).start()
                    return self._json({"job": job_id})
                return self._json({"mode": "demo", "text": demo_draft(t, docs)})

            return self._json({"error": "not found"}, 404)
        except Exception as e:
            return self._json({"error": str(e)}, 500)


if __name__ == "__main__":
    mode = "LIVE (key found, model %s)" % MODEL if API_KEY else "DEMO (no ANTHROPIC_API_KEY)"
    auth = "shared password required" if PASSCODE else "open sign-in (no RCDAS_PASSCODE)"
    print(f"RCDAS SOP Library on {HOST}:{PORT}  AI mode: {mode}  Auth: {auth}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
