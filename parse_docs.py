#!/usr/bin/env python3
"""Parse the two staff reference Google Docs into app data.

Inputs (in source_docs/, plain-text exports of the Google Docs):
  new_staff_guide.txt           RCDAS Call Center & Customer Service New Staff Reference Guide
  chameleon_data_glossary.txt   RCDAS Data Glossary v1.0 (Cicconi, Nov 2025)

Outputs (in data/):
  guide.json        Structured New Staff Guide: one entry per major section
  extra_terms.json  Glossary terms found in these docs that the master
                    glossary does not already contain (merged in by
                    build_corpus.py)
"""
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "source_docs"
OUT = HERE / "data"

GUIDE_SOURCE = "RCDAS New Staff Reference Guide (Call Center & Customer Service)"
CHAM_SOURCE = "RCDAS Data Glossary v1.0 (Cicconi, Nov 2025)"


# ---------- New Staff Guide ----------

# Major guide chapters -> ordered subheadings, exactly as they appear in the text.
CHAPTERS = [
    ("Welcome and Basics", ["Welcome to RCDAS", "About RCDAS", "What We Do",
                            "Roles and Responsibilities", "Expectations"]),
    ("Essential Information", ["Codes", "Definitions", "Required Programs",
                               "E-Resources Required", "Essential Keyboard Shortcuts",
                               "Service Area and Jurisdiction", "Reference:",
                               "Shelter Hours and Locations", "Fees", "Other Services:",
                               "Helpful Web Links", "Key Contact Information"]),
    ("Call Handling Procedures", ["Information Collection Standards",
                                  "Priority System for Field Activities",
                                  "Emergency Situations"]),
    ("Specific Call Types and Procedures", ["Lost and Found Animals", "Community Cat Program",
                                            "Animal Complaints", "Owner Surrender Services",
                                            "Diversion Resources to Offer:", "Healthy Pet Zone Services",
                                            "Dibs program (pre-adoption)", "Wildlife Issues",
                                            "Cat Calls (Updated Process)", "Owned Deceased Animal Removal",
                                            "Pet Services", "Adoptions", "Foster Program"]),
    ("Specialized Procedures", ["Citations and Violations", "Spay/Neuter Appointments",
                                "Bite Reports", "Media Requests"]),
    ("Standard Scripts", ["General Guidelines", "Scripts"]),
]

CHAPTER_PURPOSE = {
    "Welcome and Basics": "Orientation for new RCDAS staff: what the department does, the four campuses, staff roles, and expectations.",
    "Essential Information": "Codes, definitions, required software, jurisdiction rules, shelter hours, fees, and key contacts every staff member needs.",
    "Call Handling Procedures": "What to collect on every call and how field activities are prioritized, including emergencies.",
    "Specific Call Types and Procedures": "Step-by-step handling for the most common call types: lost and found, community cats, complaints, surrenders, HPZ, wildlife, adoptions, and foster.",
    "Specialized Procedures": "Citations, spay and neuter appointments, bite reports, and media requests.",
    "Standard Scripts": "Approved phone scripts and customer service guidelines for common situations.",
}


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def clean(s):
    return s.replace(" ", " ").replace("﻿", "").strip()


def parse_codes_table(raw):
    """The Codes table needs the raw text: tabs delimit the cells."""
    body = raw[raw.index("Welcome to RCDAS", raw.index("Welcome to RCDAS") + 1):]
    block = body.split("\nCodes\n", 1)[1].split("\nDefinitions", 1)[0]
    cells = [clean(c) for c in block.split("\t") if clean(c)]
    rows = []
    for i in range(3, len(cells) - 2, 3):  # skip the 3 header cells
        code, term, d = cells[i], cells[i + 1], cells[i + 2]
        rows.append(f"{code} ({term}): {d.replace(chr(10), ' ')}")
    return rows


def parse_guide():
    raw = (SRC / "new_staff_guide.txt").read_text()
    codes_rows = parse_codes_table(raw)
    lines = [clean(l) for l in raw.split("\n")]

    # Skip the table of contents: content starts at the second occurrence
    # of "Welcome to RCDAS" (first is the TOC entry, numbered).
    start = next(i for i, l in enumerate(lines)
                 if l == "Welcome to RCDAS" and i > 20)
    lines = lines[start:]

    # Build ordered heading list; "Section N:" lines are chapter markers we drop.
    all_heads = []
    for ch, subs in CHAPTERS:
        all_heads.extend(subs)
    headset = set(all_heads)

    # Collect content per subheading
    content = {}
    cur = None
    for l in lines:
        if l in headset:
            cur = l
            content[cur] = []
            continue
        if re.match(r"^Section \d+:", l) or l.startswith("____"):
            continue
        if cur and l:
            content[cur].append(l)

    def as_steps(head, ls):
        if head == "Codes":
            return codes_rows
        out = []
        for l in ls:
            l = l.lstrip("*").strip()
            if l:
                out.append(l)
        return out

    guide = []
    for order, (chapter, subs) in enumerate(CHAPTERS, 1):
        sections = []
        for h in subs:
            steps = as_steps(h, content.get(h, []))
            if steps:
                heading = h.rstrip(":")
                sections.append({"heading": heading, "steps": steps})
        guide.append({
            "id": "guide-" + slugify(chapter),
            "order": order,
            "title": chapter,
            "type": "Guide",
            "category": "New Staff Guide",
            "status": "Staff reference",
            "purpose": CHAPTER_PURPOSE[chapter],
            "source": GUIDE_SOURCE,
            "sections": sections,
        })
    return guide, content


# ---------- Glossary terms from both docs ----------

def parse_doc1_terms(content):
    """Terms from the guide's Codes table and Definitions section."""
    terms = []
    for row in (content.get("Codes") and as_rows(content["Codes"])) or []:
        pass  # handled below via guide steps instead
    return terms


def as_rows(ls):
    return ls


def guide_glossary_terms(guide):
    terms = []
    ess = next(g for g in guide if g["title"] == "Essential Information")
    for sec in ess["sections"]:
        if sec["heading"] == "Codes":
            for row in sec["steps"]:
                m = re.match(r"^(.{1,12}?) \((.+?)\): (.+)$", row)
                if m:
                    terms.append({
                        "term": m.group(1).strip(),
                        "definition": f"{m.group(2).strip()}. {m.group(3).strip()}",
                        "category": "Staff Code/Acronym",
                        "synonyms": m.group(2).strip(),
                        "source": GUIDE_SOURCE, "status": "Current", "notes": "",
                    })
        if sec["heading"] == "Definitions":
            for row in sec["steps"]:
                m = re.match(r"^([A-Za-z][^:]{1,60}?):\s+(.+)$", row)
                if m:
                    # source typo cleanup: "Community cat (aka ...)t"
                    name = m.group(1).strip().rstrip("t") if m.group(1).endswith(")t") else m.group(1).strip()
                    terms.append({
                        "term": name,
                        "definition": m.group(2).strip(),
                        "category": "Operational Term",
                        "synonyms": "",
                        "source": GUIDE_SOURCE, "status": "Current", "notes": "",
                    })
    return terms


def cham_glossary_terms():
    """Type - Subtype pairs from the data glossary, incl. obsolete codes."""
    raw = (SRC / "chameleon_data_glossary.txt").read_text()
    text = raw.replace(" ", " ")
    terms = []

    # Parse the per-type subtype tables. Table cells arrive tab-separated.
    # Sections look like: TYPE\nDefinition: ...\n...\nSubtype\n\tDefinition\n\tExample\n\tSUB\n\tdef\n\texample ...
    type_blocks = re.split(r"\n(?=(?:CONFISCATE|OWNER SUR \(Owner Surrender\)|RETURN|STRAY|TRANSFER \(Transfer In\)|ADOPTION|ADOPT EVNT \(Adoption Event\)|RTO \(Return to Owner\)|TRANSFER \(Transfer Out\)|EUTH \(Euthanasia\)|DIED \(Died In Care\))\n)", text)
    TERMINATORS = ["Other Intake Types", "Other Outcome Types", "Obsolete and Historical",
                   "Document Version History", "Quick Reference Guide", "Outcome Types\n"]
    for block in type_blocks:
        # cut the block at the first section terminator so tables that follow
        # a type's own subtype table are not swallowed into it
        for term_marker in TERMINATORS:
            pos = block.find(term_marker, 1)
            if pos > 0:
                block = block[:pos]
        lines = block.split("\n")
        name = clean(lines[0])
        m = re.match(r"^([A-Z][A-Z /()']+?)(?:\s*\((.*?)\))?$", name)
        if not m:
            continue
        base = m.group(1).strip()
        kind = "Chameleon Intake Type/Subtype" if ("Intake" in block[:400] or base in ("CONFISCATE", "STRAY", "RETURN") or "Transfer In" in name or "Owner Surrender" in name) else "Chameleon Outcome Type/Subtype"
        defm = re.search(r"Definition:\s*(.+)", block)
        basedef = clean(defm.group(1)) if defm else ""
        if basedef:
            terms.append({"term": base, "definition": basedef,
                          "category": kind, "synonyms": name if name != base else "",
                          "source": CHAM_SOURCE, "status": "Current", "notes": ""})
        # subtype cells: after the "Subtype/Definition/Example" header, groups of 3
        if "Subtype" in block:
            tail = block.split("Subtype", 1)[1]
            cells = [clean(c) for c in tail.split("\t")]
            cells = [c for c in cells if c and c not in ("Definition", "Example")]
            for i in range(0, len(cells) - 1, 3):
                sub = cells[i]
                # stop at the first cell that is not a valid ALL-CAPS subtype
                # code; anything after it belongs to a different table
                if not re.match(r"^[A-Z0-9>< ][A-Z0-9></ '&.-]{1,14}$", sub) or "\n" in sub:
                    break
                d = cells[i + 1] if i + 1 < len(cells) else ""
                ex = cells[i + 2] if i + 2 < len(cells) else ""
                definition = d + (f" Example: {ex}" if ex else "")
                terms.append({"term": f"{base} - {sub}", "definition": definition.replace("\n", " "),
                              "category": kind, "synonyms": "",
                              "source": CHAM_SOURCE, "status": "Current", "notes": ""})

    # Other intake/outcome types and MISSING/RELEASED subtypes are already in
    # the master glossary; obsolete codes carry status Obsolete there too.
    return terms



# ---------- SAC Animal Welfare Glossary (hand-curated from Glossary_FINAL.pdf) ----------

SAC_SOURCE = "Shelter Animals Count Animal Welfare Glossary (Jan 2025)"
ORG = "Animal Welfare Organization Type (SAC)"
GEN = "General Term (SAC)"
MET = "Data & Reporting Metric"

SAC_TERMS = [
    (ORG, "Government Animal Shelter", "A city or county-operated entity providing animal control services and housing services. Often named Animal Services or Animal Care and Control. RCDAS is this type of organization.", "animal services; animal care and control; pound"),
    (ORG, "Animal Shelter with Government Contract", "A private or nonprofit agency with a formal contract with a government entity for animal control or housing services.", ""),
    (ORG, "Animal Shelter without Government Contract", "A private or nonprofit agency with a physical facility but no government contract.", ""),
    (ORG, "Humane Society or SPCA", "Nonprofit organizations that may or may not have government contracts. Traditionally unaffiliated with national organizations of similar names.", ""),
    (ORG, "Animal Rescue", "Also called foster-based rescue. An animal welfare organization that houses animals exclusively in the homes of volunteers or staff. May be a 501(c)(3) nonprofit and can hold full or partial government contracts.", "foster-based rescue; rescue group"),
    (ORG, "Sanctuary", "A nonprofit that houses animals for the remainder of their lives. Some sanctuaries also function as rescue groups that adopt some animals out.", ""),
    (ORG, "Non-Sheltering Service Provider", "An agency providing direct or partnered services without sheltering animals.", "non-sheltering animal welfare organization"),
    (GEN, "Open Intake", "An organization required by government contract to accept all animals from a service area. Most open intake organizations are brick-and-mortar shelters. RCDAS is an open intake organization.", "open admission"),
    (GEN, "Limited Intake", "An organization that can choose which animals to accept and is not required to accept any from the public. Most rescue groups are limited intake.", "limited admission"),
    (GEN, "Managed Intake", "A structured approach to accepting animals where admission is guided by specific criteria or scheduled based on the organization's capacity to provide appropriate housing, medical, and behavioral care. May include offering alternatives or resources when immediate admission is not feasible.", ""),
    (GEN, "Finder Foster Intake", "A process where the organization conducts an intake assessment of a stray pet with its finder. The pet stays with the finder for the agreed hold period, preventing shelter overcrowding while keeping the pet in a home environment.", "finder to foster"),
    (MET, "Total Intake", "Total animals entering the organization, including transfers in from other organizations.", "gross intake"),
    (MET, "Community Intake", "Total animals entering the shelter minus transfers in from other organizations. Prevents double-counting when summing intakes across multiple organizations.", "net intake"),
    (GEN, "Relinquished by Owner", "SAC term for an animal admitted by its owner, including adoption returns. RCDAS records this as OWNER SUR.", "owner surrender"),
    (GEN, "Seizure/Confiscate", "Pets impounded by animal control or law enforcement due to neglect, cruelty, ordinance violations, police arrests, evictions, or other legal circumstances. RCDAS records this as CONFISCATE.", "seizure"),
    (GEN, "Transfer In", "Animal transferred into the organization's possession from another organization.", ""),
    (GEN, "From the Field", "Animal brought into the organization by an animal control officer or law enforcement. Can be strays, owner relinquishments, or seized animals.", ""),
    (MET, "Total Live Outcomes", "Sum of animals that left the organization's care through a live placement.", ""),
    (MET, "Community Live Outcomes", "Sum of animals that left through a live outcome type minus transfers to another animal welfare organization.", ""),
    (MET, "Total Non-Live Outcomes", "Sum of animals that left via a non-live outcome: died, missing, and euthanized.", ""),
    (MET, "Total Outcomes", "All outcomes: adoptions, return to owner or field, other live outcomes, transfers out, shelter euthanasia, and died or lost in care.", ""),
    (GEN, "Transfer Out", "Animal custody transitioned to another organization, such as local rescue partners or national groups.", ""),
    (GEN, "Lost in Care", "Animal outcome is unknown. Also referred to as missing; may include stolen animals. RCDAS records this as MISSING.", "missing"),
    (GEN, "Died in Care", "Animal died, unassisted, while in the custody of the organization. RCDAS records this as DIED.", ""),
    (GEN, "Shelter Euthanasia", "Animal euthanized in the custody of the organization.", ""),
    (GEN, "Owner Intended Euthanasia (OIE)", "An owner brings their pet specifically requesting euthanasia due to a medical or behavioral issue. SAC recommends treating OIE as a community service rather than an intake and outcome. RCDAS records this as EUTH REQ.", "owner requested euthanasia; ORE"),
    (GEN, "Return to Owner in Field", "A pet found by animal control or shelter staff in the community and returned to its owner without entering the organization or being processed as an intake. SAC reports this as a community service.", "RTO in field"),
    (MET, "Population Balance Calculation (PBC)", "Outcomes divided by intakes for a period. 100 percent means the population is stable; under 100 percent means the population is growing; over 100 percent means it is shrinking.", "PBC"),
    (MET, "Start Count", "The number of animals in care on the first day of the selected period.", "beginning count"),
    (MET, "End Count", "The number of animals in care on the last day of the selected period.", "ending count"),
    (MET, "Length of Stay (LOS)", "The number of days from intake to outcome for animals that have already had a permanent outcome.", "LOS"),
    (MET, "Days in Care", "The number of days an animal has been in the organization's care since intake, without a permanent outcome yet.", ""),
    (MET, "Save Rate", "The percentage of animals entering an organization that do not leave by a non-live outcome. Calculated as total intakes minus non-live outcomes, divided by total intakes.", ""),
    (MET, "Intake Type Rate", "The percentage of total intakes that are a specific intake type. Calculated as intake type divided by total gross intakes.", ""),
    (MET, "Outcome Type Rate", "The percentage of total outcomes that are a specific outcome type. Calculated as outcome type divided by total outcomes.", ""),
    (GEN, "Altered/Unaltered", "The animal's reproductive status. Also called sterilized/unsterilized or spayed/neutered/intact. May be updated during the stay.", "sterilized; intact; spayed; neutered"),
    (GEN, "Intake Subtype", "A more specific description of why the animal is in the organization's custody.", ""),
    (GEN, "Intake Reason", "The reported reason the animal is in the organization's custody. Possible reasons vary widely among shelters.", ""),
    (GEN, "Outcome Subtype", "A more specific description of why the animal is no longer in the organization's custody.", ""),
    (GEN, "Outcome Reason", "The reported reason the animal is no longer in the organization's custody.", ""),
    (GEN, "Breed (Primary/Secondary)", "The animal's primary and, if applicable, secondary breed, usually determined only by physical appearance and a breed guess.", ""),
    (GEN, "Date of Birth", "The reported or estimated birthdate of the animal, often a guess based on appearance and teeth.", ""),
    (GEN, "Intake Age (Group)", "The animal's age group at intake.", ""),
    (GEN, "Shelter Animals Count (SAC)", "A collaborative, industry-led nonprofit that maintains The National Database of sheltered animal statistics, used for trends and benchmarking across the country. RCDAS reports data to SAC.", "SAC; national database"),
]


def sac_glossary_terms():
    return [{"term": t, "definition": d, "category": c, "synonyms": syn,
             "source": SAC_SOURCE, "status": "Current", "notes": ""}
            for (c, t, d, syn) in SAC_TERMS]

def main():
    guide, content = parse_guide()
    extra = guide_glossary_terms(guide) + cham_glossary_terms() + sac_glossary_terms()

    # Deduplicate against the master glossary source (not data/glossary.json,
    # which already has extras merged in after a build)
    MASTER = Path("/Users/kristenhassen/Documents/Claude/Projects/Riverside County DAS/OUTPUTS/SOP Consolidation/Glossary/glossary.json")
    master = json.loads(MASTER.read_text())
    known = set()
    for t in master:
        known.add(re.sub(r"[^A-Z0-9]", "", t["term"].upper()))
        for s in str(t.get("synonyms") or "").split(";"):
            if s.strip():
                known.add(re.sub(r"[^A-Z0-9]", "", s.upper()))

    def key(term):
        return re.sub(r"[^A-Z0-9]", "", term.upper())

    fresh, seen = [], set()
    for t in extra:
        k = key(t["term"])
        if k and k not in known and k not in seen:
            seen.add(k)
            fresh.append(t)

    (OUT / "guide.json").write_text(json.dumps(guide, ensure_ascii=False))
    (OUT / "extra_terms.json").write_text(json.dumps(fresh, ensure_ascii=False, indent=1))
    print(f"guide chapters: {len(guide)}  sections: {sum(len(g['sections']) for g in guide)}")
    print(f"extra terms (not already in master glossary): {len(fresh)}")
    for t in fresh:
        print("  +", t["term"])


if __name__ == "__main__":
    main()
