#!/usr/bin/env python3
"""
Regenerates the auto-managed publication list in publications.html from
the author's ORCID record, enriched with Crossref metadata.

Data flow:
  ORCID public API  -> curated list of the author's own works (DOIs)
  Crossref API       -> full citation metadata for each DOI (authors, venue, etc.)

Only the HTML between the AUTO-PUBLICATIONS markers in publications.html is
replaced; everything else (hero, nav, Thesis section, footer) is untouched.

No third-party dependencies -- stdlib only, so it runs unmodified in CI.
"""
import html
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ORCID_ID = "0000-0003-2680-6371"
CONTACT_EMAIL = "arjun.chakravarthip@gmail.com"
AUTHOR_FAMILY_NAME = "Pogaku"

# DOIs for works not yet indexed on the ORCID record. Once a DOI here shows
# up in `fetch_orcid_works()`, remove it from this list -- ORCID has caught up.
EXTRA_DOIS = [
    "10.1007/s41060-026-01237-z",
    "10.1007/978-981-92-2885-0_3",
    "10.1109/mcsoc67473.2025.00024",
    "10.1109/bigdata66926.2025.11402218",
]

# Supplementary buttons (code repo, live demo, etc.) shown under specific
# publications, keyed by lowercase DOI (Crossref normalizes DOIs to lowercase
# in its responses, so lookups must match that).
EXTRA_LINKS = {
    "10.1007/978-981-92-2885-0_3": [
        ("fab fa-github", "Code", "https://github.com/arjunpogaku/traffic_kgs"),
    ],
    "10.1007/s41060-026-01237-z": [
        ("fab fa-github", "Code", "https://github.com/MadhaviPalla/PAMI-GPT"),
    ],
    "10.1109/mcsoc67473.2025.00024": [
        ("fa-solid fa-robot", "Try PAMI-GPT", "https://chatgpt.com/g/g-673d78e2ed608191a67fe61be430c641-pami"),
    ],
}

REPO_ROOT = Path(__file__).resolve().parent.parent
PUBLICATIONS_HTML = REPO_ROOT / "publications.html"

START_MARKER = "<!-- AUTO-PUBLICATIONS:START -->"
END_MARKER = "<!-- AUTO-PUBLICATIONS:END -->"

CROSSREF_TYPE_TO_BADGE = {
    "journal-article": "Journal",
    "book-chapter": "Book Chapter",
    "proceedings-article": "Conference",
    "conference-paper": "Conference",
}


def http_get_json(url, headers):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_orcid_works():
    url = f"https://pub.orcid.org/v3.0/{ORCID_ID}/works"
    data = http_get_json(url, {"Accept": "application/json"})
    dois = []
    for group in data.get("group", []):
        summary = group["work-summary"][0]
        doi = None
        for eid in summary.get("external-ids", {}).get("external-id", []):
            if eid.get("external-id-type") == "doi":
                doi = eid.get("external-id-value")
                break
        if doi:
            dois.append(doi)
    return dois


def fetch_crossref_work(doi):
    url = f"https://api.crossref.org/works/{doi}"
    headers = {
        "Accept": "application/json",
        "User-Agent": f"arjunpogaku.github.io-publication-updater (mailto:{CONTACT_EMAIL})",
    }
    data = http_get_json(url, headers)
    return data["message"]


def format_initials(given_name):
    tokens = given_name.split(" ")
    formatted = []
    for token in tokens:
        subparts = [p for p in token.split("-") if p]
        if not subparts:
            continue
        formatted.append("-".join(f"{p[0].upper()}." for p in subparts))
    return " ".join(formatted)


def format_authors(authors):
    parts = []
    for a in authors:
        given = a.get("given", "").strip()
        family = a.get("family", "").strip()
        if not family:
            continue
        if family.isupper():
            family = family.title()
        name = f"{format_initials(given)} {family}".strip() if given else family
        is_author = AUTHOR_FAMILY_NAME in family
        name_html = html.escape(name)
        parts.append(f"<strong>{name_html}</strong>" if is_author else name_html)
    return ", ".join(parts)


def format_venue(work):
    container = work.get("container-title") or []
    venue_title = container[-1] if container else ""
    publisher = work.get("publisher", "")
    volume = work.get("volume")
    issue = work.get("issue")
    page = work.get("page")
    year = extract_year(work)

    bits = []
    if venue_title:
        vt = venue_title
        if volume:
            vt += f", {volume}"
            if issue:
                vt += f"({issue})"
        if page:
            vt += f", {page}"
        bits.append(vt)
    elif publisher:
        bits.append(publisher)

    if work.get("type") in ("book-chapter", "proceedings-article", "conference-paper", "other") and publisher:
        bits.append(publisher)

    if year:
        bits.append(str(year))

    return ", ".join(b for b in bits if b) + "."


def extract_date(work):
    for key in ("published-print", "published-online", "published", "issued", "created"):
        date_parts = work.get(key, {}).get("date-parts")
        if date_parts and date_parts[0] and date_parts[0][0]:
            parts = date_parts[0]
            year = parts[0]
            month = parts[1] if len(parts) > 1 else 0
            day = parts[2] if len(parts) > 2 else 0
            return (year, month, day)
    return (0, 0, 0)


def extract_year(work):
    return extract_date(work)[0] or None


def badge_for(work):
    crossref_type = work.get("type", "")
    if crossref_type == "other" and work.get("container-title"):
        return "Book Chapter"
    return CROSSREF_TYPE_TO_BADGE.get(crossref_type, "Publication")


def render_extra_links(doi):
    links = EXTRA_LINKS.get(doi.lower())
    if not links:
        return ""
    buttons = "\n".join(
        f'            <a href="{html.escape(url)}" target="_blank"><i class="{icon}"></i> {html.escape(label)}</a>'
        for icon, label, url in links
    )
    return f'\n        <div class="pub-extra-links">\n{buttons}\n        </div>'


def render_pub_card(work, badge):
    title = html.escape(work.get("title", [""])[0])
    authors = format_authors(work.get("author", []))
    venue = html.escape(format_venue(work))
    doi = work.get("DOI", "")
    link = f"https://doi.org/{doi}" if doi else work.get("URL", "")
    extra_links = render_extra_links(doi)

    return f"""    <div class="pub-card">
        <span class="pub-type">{html.escape(badge)}</span>
        <div class="pub-title">
            {authors}. <em>{title}.</em>
        </div>
        <span class="pub-venue">
            <a href="{html.escape(link)}" class="paper-link" target="_blank">{venue}</a>
        </span>{extra_links}
    </div>"""


def render_year_group(year, cards):
    out = ['<div class="pub-year-group reveal">', f"    <h3>{year}</h3>", ""]
    out.extend(cards)
    out.append("</div>")
    return "\n".join(out)


def main():
    try:
        dois = fetch_orcid_works()
    except (urllib.error.URLError, KeyError) as e:
        print(f"Failed to fetch ORCID works: {e}", file=sys.stderr)
        sys.exit(1)

    dois_lower = {d.lower() for d in dois}
    all_dois = list(dict.fromkeys(dois + [d for d in EXTRA_DOIS if d.lower() not in dois_lower]))

    if not all_dois:
        print("No DOIs found; leaving publications.html untouched.")
        sys.exit(0)

    works_by_date = []
    fetched, failed = 0, 0

    for doi in all_dois:
        try:
            work = fetch_crossref_work(doi)
        except (urllib.error.URLError, KeyError, json.JSONDecodeError) as e:
            print(f"Warning: could not fetch Crossref metadata for {doi}: {e}", file=sys.stderr)
            failed += 1
            continue

        date = extract_date(work)
        works_by_date.append((date, work))
        fetched += 1

    works_by_date.sort(key=lambda item: item[0], reverse=True)

    year_groups = {}
    for date, work in works_by_date:
        year = date[0] or "n.d."
        badge = badge_for(work)
        year_groups.setdefault(year, []).append(render_pub_card(work, badge))

    generated_block = "\n\n".join(
        render_year_group(year, cards) for year, cards in year_groups.items()
    )

    text = PUBLICATIONS_HTML.read_text(encoding="utf-8")
    if START_MARKER not in text or END_MARKER not in text:
        print("Marker comments not found in publications.html; aborting.", file=sys.stderr)
        sys.exit(1)

    pattern = re.compile(
        re.escape(START_MARKER) + r".*?" + re.escape(END_MARKER), re.DOTALL
    )
    replacement = f"{START_MARKER}\n{generated_block}\n\n{END_MARKER}"
    new_text = pattern.sub(replacement, text, count=1)

    if new_text != text:
        PUBLICATIONS_HTML.write_text(new_text, encoding="utf-8")
        print(f"publications.html updated. Fetched {fetched} works ({failed} failed).")
    else:
        print(f"publications.html already up to date. Fetched {fetched} works ({failed} failed).")


if __name__ == "__main__":
    main()
