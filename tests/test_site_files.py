"""GitHub Pages publishes the site, not the repository (scripts/site_files.py).

Every tracked top-level path must be classified SITE or NOT_SITE, so a new page,
icon or data file is placed on purpose: left out, it would 404 in production
while every check served from the repo root still passed; let in by default, it
would ship source art, fixtures or scraper state with every deploy, as the old
`path: .` upload did (~43 MB a deploy, every ~5 minutes on fight night).
check:site (tests/check-site.mjs) boots the built site in a browser; this holds
the list itself.
"""
import importlib.util
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("site_files", ROOT / "scripts" / "site_files.py")
sf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sf)


def _top_level():
    out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return {line.split("/", 1)[0] for line in out.splitlines() if line}


def test_every_top_level_path_is_classified_exactly_once():
    assert not (sf.SITE & sf.NOT_SITE), "a path can't be both published and not"
    unclassified = _top_level() - sf.SITE - sf.NOT_SITE
    assert not unclassified, (
        f"classify {sorted(unclassified)} in scripts/site_files.py: SITE if the app, "
        "the Lab or the service worker loads it from Pages, NOT_SITE otherwise")


def test_heavy_non_site_trees_stay_out():
    for heavy in ("art", "tests", "native", "design", "docs", "odds-snapshots.jsonl", "supabase", "scrape.py"):
        assert heavy in sf.NOT_SITE


_REF = re.compile(r"""["'(]\.?/?((?:[\w.-]+/)*[\w.-]+\.(?:js|json|html|png|jpg|jpeg|svg|webp|mp3|woff2|css|ico))(?:\?[^"')]*)?["')]""")
_SOURCES = ["index.html", "lab.html", "sw.js", "privacy.html", "terms.html", "support.html",
            "manifest.json", "lab/engine.js", "lab/analytics.js"]


def test_everything_the_site_references_is_published():
    published = sf.SITE
    missing = set()
    for src in _SOURCES:
        for m in _REF.finditer((ROOT / src).read_text(encoding="utf-8")):
            path = m.group(1)
            if not (ROOT / path).exists():
                continue            # a generated download name (card-recap.png …), not a file
            top = path.split("/", 1)[0]
            if top not in published:
                missing.add(f"{path} (from {src})")
    assert not missing, f"referenced but not published: {sorted(missing)}"


def test_every_file_the_scraper_commits_is_classified():
    update = (ROOT / ".github" / "workflows" / "update.yml").read_text(encoding="utf-8")
    m = re.search(r"for f in (.*?); do", update, re.S)
    committed = set(m.group(1).replace("\\", " ").split())
    assert committed <= (sf.SITE | sf.NOT_SITE)


def test_pages_uploads_the_built_site_not_the_checkout():
    pages = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
    assert "python3 scripts/site_files.py _site" in pages
    up = pages[pages.index("actions/upload-pages-artifact"):]
    assert re.search(r"path:\s*_site\b", up.split("\n      - ", 1)[0]), "upload the built _site, never `.`"
    assert not re.search(r"path:\s*\.\s*$", pages, re.M)


def test_copy_site_builds_only_the_site(tmp_path):
    out = sf.copy_site(tmp_path / "_site")
    names = {p.name for p in out.iterdir()}
    assert names <= sf.SITE and "index.html" in names and "art" not in names
