#!/usr/bin/env python3
"""
Stamps a content hash onto local asset links, so a browser can never render
freshly deployed HTML against a stale stylesheet.

GitHub Pages serves style.css and script.js with `cache-control: max-age=600`
and no fingerprint in the filename. Within that window a visitor can hold a
cached stylesheet while fetching newly deployed HTML, which renders the new
markup unstyled -- the badge row is a good example, since the markup moved and
the CSS that positions it is new.

Rewriting the link as `style.css?v=<hash>` changes the URL exactly when the
file's bytes change, forcing a refetch then and allowing full caching the rest
of the time. Run after any change to an asset; it is idempotent.

No third-party dependencies -- stdlib only, so it runs unmodified in CI.
"""
import hashlib
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Local assets whose links should carry a hash. Remote assets (the Font Awesome
# CDN, Google Fonts) are versioned by their own URLs and are left alone.
ASSETS = ("style.css", "script.js")

HTML_FILES = ("index.html", "publications.html", "research.html")

HASH_LENGTH = 10


def content_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()[:HASH_LENGTH]


def stamp(text, asset, digest):
    """Point every href/src for `asset` at the current hash.

    Matches the bare link and an already-stamped one, so re-running replaces
    the old hash rather than appending a second query string.
    """
    pattern = re.compile(
        r'((?:href|src)=")' + re.escape(asset) + r'(?:\?v=[0-9a-f]+)?(")'
    )
    return pattern.subn(rf"\g<1>{asset}?v={digest}\g<2>", text)


def main():
    digests = {}
    for asset in ASSETS:
        path = REPO_ROOT / asset
        if not path.exists():
            print(f"Asset {asset} not found; aborting.", file=sys.stderr)
            return 1
        digests[asset] = content_hash(path)

    changed = []
    for name in HTML_FILES:
        path = REPO_ROOT / name
        if not path.exists():
            print(f"Warning: {name} not found, skipping.", file=sys.stderr)
            continue

        original = path.read_text(encoding="utf-8")
        text = original
        replacements = 0
        for asset, digest in digests.items():
            text, count = stamp(text, asset, digest)
            replacements += count

        if not replacements:
            print(f"Warning: no local asset links found in {name}.", file=sys.stderr)

        if text != original:
            path.write_text(text, encoding="utf-8")
            changed.append(name)

    stamps = ", ".join(f"{a}?v={d}" for a, d in digests.items())
    if changed:
        print(f"Stamped {stamps} into: {', '.join(changed)}")
    else:
        print(f"Asset stamps already current ({stamps}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
