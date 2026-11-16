"""How much checking a Pages deploy needs, and which commit it may ship.

Every data commit (the scraper's, every ~5 minutes on fight night) used to run
the whole validate suite before it could deploy: ~5.5 minutes of tests on code
that hadn't changed since the last time they passed, so a result took ~6
minutes from commit to screen. A commit that only touches files the scraper
writes can only change the outcome of the checks that read those files
(`check:web`, both `smoke` runs, `check:names`, `check:fightbot`, `check:lab`),
so that is all `validate-web.yml` runs for one (`scope: data`), ~1.5 minutes.

The data path is taken only when it is provably safe; anything uncertain is
the full suite:

  * BASE is the newest commit on main's first-parent line that touched any
    file outside DATA_FILES (code, tests, workflows, this script).
  * BASE must already have passed the full suite: a successful ci.yml run
    on it (every human push; validates exactly that commit) or a successful
    Pages run (validated main's tip in full, which held BASE's code). Nothing
    but data has changed since. A BASE whose run is still going, failed, or
    can't be looked up means the full suite.
  * Every file in BASE..tip is re-checked against DATA_FILES, belt and braces.

`advance` is used by the deploy job: it ships the SHA that was validated, and
moves forward to main's newer tip only across data-only commits. Past a code
commit it skips the deploy: that commit's own run publishes it, and shipping
the older validated SHA could roll back a deploy that already finished. Before this,
deploy checked out main whatever validate had seen, so a code commit landing
mid-validate could ship untested; and always shipping exactly the validated
SHA would let a slow full run publish over a newer fast one (a result showing,
then vanishing). Data commits that ride along this way get their own run, and
the scraper's health gate refuses a broken data.js before it is ever committed.

Run in CI only; prints `key=value` lines for $GITHUB_OUTPUT. Exits 0 and says
`scope=full` on any error, so a broken lookup costs time, never a deploy.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request

# Exactly what update.yml's commit step stages (tests/test_deploy_dispatch.py
# holds the two lists equal). Nothing a person edits belongs here.
DATA_FILES = frozenset({
    "data.js", "fighter-stats.js", "stats-state.json", "overseer-status.json", "odds-snapshots.jsonl",
    "odds-series.json", "odds-state.json", "odds-alert-state.json", "odds-lines.json",
    "health-report.json", "intel.json", "intel-state.json",
    "events-extra.json", "events-extra.candidate.json", "extra-state.json",
    "official-times.json", "pending-pushes.json", "rematch-cache.json",
})


def data_only(files) -> bool:
    """True when every changed path is a scraper-written data file."""
    return all(f in DATA_FILES for f in files)


def decide(tip: str, base: str | None, changed, base_passed: bool | None) -> tuple[str, str]:
    """(scope, reason). `changed` is BASE..tip; `base_passed` None = unknown."""
    if not base:
        return "full", "no code commit found in the fetched history"
    if base == tip:
        return "full", "the tip itself changes code"
    if not data_only(changed):
        return "full", "non-data files changed since " + base[:7]
    if base_passed is not True:
        return "full", "last code commit %s has not passed the full suite yet" % base[:7]
    return "data", "only data files changed since %s, which passed in full" % base[:7]


def advance_target(validated: str, tip: str, is_ancestor: bool, changed) -> str | None:
    """The commit to deploy, or None to skip this deploy.

    The validated commit when it is still main's tip; main's newer tip when
    only data lies between. Past a code commit (or when the validated commit
    isn't provably behind the tip) this run is stale: the newer commit has its
    own Pages run, which carries everything this one validated. Publishing the
    validated commit here could roll production back from that run's deploy
    if it already finished (validation doesn't finish in commit order)."""
    if not tip or tip == validated:
        return validated
    if is_ancestor and data_only(changed):
        return tip
    return None


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout.strip()


def _changed(a: str, b: str) -> list[str]:
    return [f for f in _git("diff", "--name-only", a, b).splitlines() if f]


def _last_code_commit(tip: str) -> str | None:
    exclude = [":(exclude)" + f for f in sorted(DATA_FILES)]
    out = _git("log", "--first-parent", "-1", "--format=%H", tip, "--", ".", *exclude)
    return out or None


def _run_passed(sha: str, workflow: str) -> bool | None:
    repo, token = os.environ.get("GITHUB_REPOSITORY"), os.environ.get("GH_TOKEN")
    if not repo or not token:
        return None
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    url = f"{api}/repos/{repo}/actions/workflows/{workflow}/runs?head_sha={sha}&status=success&per_page=1"
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token,
                                               "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r).get("total_count", 0) > 0


def base_passed(sha: str, lookup=_run_passed) -> bool | None:
    """Did the full suite pass on BASE? ci.yml first: every human push runs the
    full validate on exactly that commit and nothing cancels it. A Pages run can
    be cancelled while its deploy waits in the `github-pages` queue, which would
    leave BASE looking unproven and every later data commit on the full suite."""
    seen_none = False
    for wf in ("ci.yml", "pages.yml"):
        r = lookup(sha, wf)
        if r:
            return True
        seen_none = seen_none or r is None
    return None if seen_none else False


def main(argv: list[str]) -> int:
    mode = argv[1] if len(argv) > 1 else "scope"
    try:
        if mode == "scope":
            tip = _git("rev-parse", "HEAD")
            print("sha=" + tip)
            base = _last_code_commit(tip)
            changed = _changed(base, tip) if base and base != tip else []
            passed = base_passed(base) if base and base != tip and data_only(changed) else None
            scope, reason = decide(tip, base, changed, passed)
        elif mode == "advance":
            validated, tip = argv[2], argv[3]
            try:
                subprocess.run(["git", "merge-base", "--is-ancestor", validated, tip], check=True)
                anc = True
            except subprocess.CalledProcessError:
                anc = False
            changed = _changed(validated, tip) if anc and tip != validated else []
            target = advance_target(validated, tip, anc, changed)
            if target is None:
                print("skip=true")
                print(f"::notice::main moved past {validated[:7]} across code; "
                      f"the newer commit's own run deploys it", file=sys.stderr)
            else:
                print("sha=" + target)
                print("skip=false")
            return 0
        else:
            print("usage: deploy_scope.py [scope | advance VALIDATED TIP]", file=sys.stderr)
            return 2
    except Exception as e:  # never block a deploy over the lookup itself
        if mode == "advance":
            print("sha=" + argv[2])
            print("skip=false")
            print(f"::warning::deploy_scope advance failed ({e}); deploying the validated commit", file=sys.stderr)
            return 0
        scope, reason = "full", f"scope lookup failed: {e}"
    print("scope=" + scope)
    print("reason=" + reason)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
