"""What GitHub Pages publishes: the site, not the repository.

pages.yml used to upload the whole checkout (`path: .`), so every deploy (every
~5 minutes on fight night) shipped ~43 MB: 15 MB of source art the site never
references, the test suite and its fixtures, the iOS shell, the Python, the
5.5 MB append-only odds log, the scraper's state files. The site itself is
~16 MB, nearly all of it the Lab's card art and the theme sounds.

Every top-level path in the repository is classified here, SITE or NOT_SITE,
and tests/test_site_files.py fails on one that is neither: a new page, icon or
data file has to be placed on purpose, so it can never silently go missing
from production (the failure an allow-list invites), and nothing new is
published by default either (the failure the old `path: .` had). The same test
scans what the pages, the Lab and the service worker reference and checks each
one is published.

    python3 scripts/site_files.py OUT_DIR    copy the site into OUT_DIR
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Published. A directory ships whole: sounds/ names its files at runtime
# (sounds/season-<month>.mp3), lab/ holds the Lab's modules and card art.
SITE = {
    # pages
    "index.html", "lab.html", "privacy.html", "terms.html", "support.html",
    # the app's scripts and its service worker
    "sw.js", "scoring.js", "kernel.js", "results.js",
    # data the app, the Lab or the service worker fetch from Pages
    "data.js", "fighter-stats.js", "intel.json", "odds-series.json",
    "events-extra.json", "overseer-status.json",
    # install / icons
    "manifest.json", "icon-192-v3.png", "icon-512-v3.png", "apple-touch-icon-180.png",
    # assets
    "fonts", "sounds", "lab",
}

# Not published, each for a reason. Server functions read the committed files
# from raw.githubusercontent (CLAUDE.md), never from Pages, so nothing here is
# fetched from the site.
NOT_SITE = {
    # repository / tooling
    ".github", ".gitignore", ".gitleaks.toml", ".gitleaksignore", ".nvmrc",
    "package.json", "package-lock.json", "eslint.config.mjs", "ruff.toml", "build.mjs",
    "requirements.in", "requirements.txt", "requirements-dev.in", "requirements-dev.txt",
    "scripts", "tests",
    # docs
    "CLAUDE.md", "NOTIFICATIONS.md", "README.md", "SECURITY.md", "TODO.md", "docs",
    # source art and design references the site never loads (15 MB)
    "art", "design",
    # other runtimes: the iOS shell, the MCP server, the edge functions
    "native", "fightbot", "supabase",
    # the scraper and its own state (read from the repo, not the site)
    "scrape.py", "datafile.py", "health.py", "write_status.py", "odds_series.py",
    "intel.py", "extra.py", "official_times.py", "alert_calibration.py", "make_icons.py",
    "odds-snapshots.jsonl", "odds-state.json", "odds-alert-state.json", "odds-lines.json", "stats-state.json",
    "intel-state.json", "extra-state.json", "events-extra.candidate.json",
    "official-times.json", "rematch-cache.json", "pending-pushes.json", "health-report.json",
}


def copy_site(out):
    out = Path(out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for name in sorted(SITE):
        src = ROOT / name
        if not src.exists():
            # A data file can be absent on a fresh checkout; a page or script cannot.
            if name.endswith((".json", ".js")) and name not in {"sw.js", "scoring.js", "kernel.js", "results.js"}:
                print(f"site: {name} absent, skipped", file=sys.stderr)
                continue
            raise SystemExit(f"site: required {name} is missing")
        if src.is_dir():
            shutil.copytree(src, out / name, ignore=shutil.ignore_patterns("__pycache__", ".DS_Store"))
        else:
            shutil.copy2(src, out / name)
    return out


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: site_files.py OUT_DIR")
    out = copy_site(sys.argv[1])
    total = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print(f"site: {sum(1 for p in out.rglob('*') if p.is_file())} files, {total / 1e6:.1f} MB -> {out}")
