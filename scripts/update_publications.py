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
import datetime
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

# ---------------------------------------------------------------------------
# Venue metrics: impact factor, journal quartile, CORE conference rank.
#
# None of this is available programmatically. Crossref does not carry it, CORE
# publishes no JSON API (the portal is HTML only), Scimago blocks automated
# downloads, and JCR impact factors are licensed Clarivate data. So the numbers
# below are curated by hand.
#
# Refresh once a year, when the new JCR and CORE editions land, and keep the
# `year` fields accurate -- they are shown to readers in the badge tooltip.
# Leave a value as None to hide that badge; a venue with no entry, or an entry
# that is all None, simply renders no badges at all.

# Journals, keyed by ISSN. A work matches if any of its ISSNs is a key, so
# print and electronic ISSNs can both be listed.
JOURNAL_METRICS = {
    "2169-3536": {  # IEEE Access
        "name": "IEEE Access",
        "impact_factor": "3.4",
        "quartile": "Q2",
        "category": "Computer Science, Information Systems",
        "year": 2024,
    },
    "2052-4463": {  # Scientific Data
        "name": "Scientific Data",
        "impact_factor": "5.8",
        "quartile": "Q1",
        "category": "Multidisciplinary Sciences",
        "year": 2024,
    },
    "2405-9595": {  # ICT Express
        "name": "ICT Express",
        "impact_factor": "4.1",
        "quartile": "Q1",
        "category": "Telecommunications",
        "year": 2024,
    },
    "2364-415X": {  # International Journal of Data Science and Analytics
        "name": "International Journal of Data Science and Analytics",
        "impact_factor": "2.0",
        "quartile": "Q2",
        "category": None,
        "year": 2024,
    },
    "1530-8669": {  # Wireless Communications and Mobile Computing
        # Discontinued by Clarivate in 2023; no current impact factor exists.
        "name": "Wireless Communications and Mobile Computing",
        "impact_factor": None,
        "quartile": None,
        "category": None,
        "year": None,
    },
}

# Conferences, keyed by lowercase DOI rather than by name: proceedings titles
# change year to year, and papers from CORE-ranked conferences are often
# published as LNCS/LNEE book chapters whose container is the series, not the
# conference.
#
# `ranks` maps a CORE edition year to the rank in that edition, because a
# conference is credited with the rank it held when the paper appeared, not
# whatever it holds today. Record the rank from every edition the paper could
# be read against; the renderer picks the newest edition published on or before
# the paper's own year. Verify each value at
# https://portal.core.edu.au/conf-ranks/ against the matching `source=CORE<year>`.
CORE_EDITIONS = (2008, 2013, 2014, 2017, 2018, 2020, 2021, 2023, 2026)

CONFERENCE_RANKS = {
    "10.1109/bigdata66926.2025.11402218": {
        "name": "IEEE International Conference on Big Data",
        "ranks": {2023: "B", 2026: "B"},
    },
    "10.1007/978-981-92-2885-0_3": {
        "name": "IEA/AIE",
        "ranks": {2023: "C", 2026: "C"},
    },
    "10.1109/mcsoc67473.2025.00024": {
        # Not listed in any CORE edition; renders no badge.
        "name": "IEEE MCSoC",
        "ranks": {},
    },
}

REPO_ROOT = Path(__file__).resolve().parent.parent
PUBLICATIONS_HTML = REPO_ROOT / "publications.html"

START_MARKER = "<!-- AUTO-PUBLICATIONS:START -->"
END_MARKER = "<!-- AUTO-PUBLICATIONS:END -->"

# Crossref date fields, in the order we trust them to name the publication
# year. `published-online` leads: it is the date the work actually became
# readable, whereas `published-print` is the year the publisher stamps on the
# bound volume, which Springer routinely forward-dates.
DATE_KEYS = ("published-online", "issued", "published-print", "published", "created")

CURRENT_YEAR = datetime.date.today().year

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


def read_date(work, key):
    date_parts = work.get(key, {}).get("date-parts")
    if not (date_parts and date_parts[0] and date_parts[0][0]):
        return None
    parts = date_parts[0]
    year = parts[0]
    month = parts[1] if len(parts) > 1 else 0
    day = parts[2] if len(parts) > 2 else 0
    return (year, month, day)


def extract_date(work):
    """Publication date, preferring when the work actually became available.

    Springer forward-dates print volumes -- an LNCS chapter online in July 2026
    can carry a 2027 `published-print` date -- so the online date, not the
    print year, decides which year a work is listed under.

    The future-year guard below is a backstop for records that carry *only* a
    forward-dated print date, where there is no online date to prefer.
    """
    dates = [d for d in (read_date(work, k) for k in DATE_KEYS) if d]
    if not dates:
        return (0, 0, 0)

    preferred = dates[0]
    if preferred[0] > CURRENT_YEAR:
        available = [d for d in dates if d[0] <= CURRENT_YEAR]
        if available:
            return min(available)
    return preferred


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


def core_rank_at(entry, publication_year):
    """The conference's rank in the CORE edition current when the paper appeared.

    CORE re-ranks conferences every few years, so a 2021 paper should not
    inherit a rank the conference only earned in 2026. Picks the newest edition
    published on or before `publication_year`; returns (rank, edition) or None
    when the conference was unranked at that point.
    """
    ranks = entry.get("ranks") or {}
    applicable = [year for year in ranks if year <= publication_year]
    if not applicable:
        return None
    edition = max(applicable)
    rank = ranks[edition]
    return (rank, edition) if rank else None


def lookup_journal_metrics(work):
    for issn in work.get("ISSN") or []:
        metrics = JOURNAL_METRICS.get(issn.upper())
        if metrics:
            return metrics
    return None


def render_metrics(work):
    """Badges for venue standing, rendered only where a curated value exists."""
    badges = []

    conference = CONFERENCE_RANKS.get((work.get("DOI") or "").lower())
    if conference:
        ranked = core_rank_at(conference, extract_date(work)[0])
        if ranked:
            rank, edition = ranked
            badges.append((
                f"CORE {rank}",
                f'CORE {edition} rank for {conference["name"]}, the edition '
                f"current when this paper was published",
                "metric-core",
            ))

    metrics = lookup_journal_metrics(work)
    if metrics:
        if metrics.get("impact_factor"):
            badges.append((
                f'IF {metrics["impact_factor"]}',
                f'{metrics["name"]} journal impact factor, JCR {metrics["year"]}',
                "metric-if",
            ))
        if metrics.get("quartile"):
            category = metrics.get("category")
            label = f' in {category}' if category else ""
            badges.append((
                metrics["quartile"],
                f'JCR {metrics["year"]} quartile{label}',
                f'metric-quartile metric-{metrics["quartile"].lower()}',
            ))

    if not badges:
        return ""

    spans = "\n".join(
        f'            <span class="metric {cls}" title="{html.escape(tooltip)}">{html.escape(text)}</span>'
        for text, tooltip, cls in badges
    )
    return f'\n        <div class="pub-metrics">\n{spans}\n        </div>'


def render_pub_card(work, badge):
    title = html.escape(work.get("title", [""])[0])
    authors = format_authors(work.get("author", []))
    venue = html.escape(format_venue(work))
    doi = work.get("DOI", "")
    link = f"https://doi.org/{doi}" if doi else work.get("URL", "")
    extra_links = render_extra_links(doi)
    metrics = render_metrics(work)

    return f"""    <div class="pub-card">
        <span class="pub-type">{html.escape(badge)}</span>{metrics}
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
