"""Data-only commits deploy after the data gates; everything else after all of them.

scripts/deploy_scope.py decides. Its failure mode to fear is a code change
deploying on the short suite, so every path that isn't provably data-only on
top of a fully passed commit must come out `full`.
"""
import importlib.util
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WF = ROOT / ".github" / "workflows"
spec = importlib.util.spec_from_file_location("deploy_scope", ROOT / "scripts" / "deploy_scope.py")
ds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ds)

DATA_GATES = {"check:web", "smoke", "check:names", "check:lab", "check:fightbot"}


def test_data_files_are_exactly_what_the_scraper_commits():
    update = (WF / "update.yml").read_text(encoding="utf-8")
    m = re.search(r"for f in (.*?); do", update, re.S)
    staged = set(m.group(1).replace("\\", " ").split())
    assert staged == set(ds.DATA_FILES), "update.yml's commit list and DATA_FILES drifted"
    for f in ("index.html", "scoring.js", "sw.js", "lab/engine.js", "results.js", "package.json"):
        assert f not in ds.DATA_FILES


def test_decide_takes_the_data_path_only_when_proven():
    tip, base = "b" * 40, "a" * 40
    assert ds.decide(tip, base, ["data.js", "intel.json"], True)[0] == "data"
    assert ds.decide(tip, base, ["data.js", "index.html"], True)[0] == "full"
    assert ds.decide(tip, base, ["data.js"], False)[0] == "full"
    assert ds.decide(tip, base, ["data.js"], None)[0] == "full", "unknown is not passed"
    assert ds.decide(tip, tip, [], True)[0] == "full", "a code commit itself always runs everything"
    assert ds.decide(tip, None, [], True)[0] == "full"


def test_base_passed_prefers_ci_and_treats_unknown_as_unproven():
    assert ds.base_passed("x", lambda s, wf: wf == "ci.yml") is True
    assert ds.base_passed("x", lambda s, wf: wf == "pages.yml") is True, "a Pages full run proves it too"
    assert ds.base_passed("x", lambda s, wf: False) is False
    assert ds.base_passed("x", lambda s, wf: None) is None


def test_advance_only_across_data():
    v, t = "v" * 40, "t" * 40
    assert ds.advance_target(v, t, True, ["data.js"]) == t
    # Past code (or unprovable ancestry) the run is stale and skips: shipping v
    # could roll back a newer commit's deploy that already finished (Codex, #341).
    assert ds.advance_target(v, t, True, ["data.js", "scoring.js"]) is None, "never ship untested code, nor roll back"
    assert ds.advance_target(v, t, False, ["data.js"]) is None
    assert ds.advance_target(v, v, True, []) == v


def _repo(tmp_path):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t",
               GIT_COMMITTER_EMAIL="t@t")
    def git(*a):
        return subprocess.run(["git", *a], cwd=tmp_path, env=env, check=True,
                              capture_output=True, text=True).stdout.strip()
    git("init", "-q", "-b", "main")
    def commit(path, text):
        (tmp_path / path).write_text(text)
        git("add", path)
        git("commit", "-q", "-m", path)
        return git("rev-parse", "HEAD")
    return git, commit


def test_against_real_git_history(tmp_path, monkeypatch):
    git, commit = _repo(tmp_path)
    commit("data.js", "var EVENTS=[];")
    code = commit("index.html", "<p>")
    commit("data.js", "var EVENTS=[1];")
    commit("intel.json", "{}")
    monkeypatch.chdir(tmp_path)
    tip = git("rev-parse", "HEAD")
    assert ds._last_code_commit(tip) == code
    assert ds._changed(code, tip) == ["data.js", "intel.json"]
    # The validated data commit may advance to a newer data-only tip ...
    mid = git("rev-parse", "HEAD~1")
    newer = commit("data.js", "var EVENTS=[2];")
    out = subprocess.run(["python3", str(ROOT / "scripts" / "deploy_scope.py"), "advance", mid, newer],
                         capture_output=True, text=True, check=True).stdout
    assert f"sha={newer}" in out
    assert "skip=false" in out
    # ... but past a code commit it skips rather than republishing `mid`.
    code2 = commit("sw.js", "v2")
    out = subprocess.run(["python3", str(ROOT / "scripts" / "deploy_scope.py"), "advance", mid, code2],
                         capture_output=True, text=True, check=True).stdout
    assert "skip=true" in out and "sha=" not in out
    # Still the tip: deploy it.
    out = subprocess.run(["python3", str(ROOT / "scripts" / "deploy_scope.py"), "advance", code2, code2],
                         capture_output=True, text=True, check=True).stdout
    assert f"sha={code2}" in out and "skip=false" in out
    assert ds._last_code_commit(code2) == code2


def test_scope_mode_without_a_token_is_full(tmp_path, monkeypatch):
    git, commit = _repo(tmp_path)
    commit("index.html", "<p>")
    commit("data.js", "x")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("GH_TOKEN", raising=False)
    out = subprocess.run(["python3", str(ROOT / "scripts" / "deploy_scope.py")], capture_output=True,
                         text=True, check=True, env={k: v for k, v in os.environ.items() if k != "GH_TOKEN"}).stdout
    assert "scope=full" in out and "sha=" in out


def test_validate_web_skips_only_non_data_gates_in_data_scope():
    wf = (WF / "validate-web.yml").read_text(encoding="utf-8")
    assert re.search(r"scope:\n(?:\s+.*\n)*?\s+default: \"full\"", wf), "default must stay full (ci.yml relies on it)"
    steps = re.split(r"\n      - ", wf.split("\n    steps:\n", 1)[1])
    seen = set()
    for st in steps:
        gated = "if: inputs.scope != 'data'" in st
        for g in re.findall(r"npm run ([\w:]+)", st):
            seen.add(g)
            if g in DATA_GATES:
                assert not gated, f"{g} reads the data files and must run on a data-only deploy"
            else:
                assert gated, f"{g} would run on every data commit; gate it on inputs.scope"
    assert DATA_GATES <= seen
    # Chromium is needed by smoke / check:lab, so its install is never skipped.
    for st in steps:
        if "playwright install" in st:
            assert "inputs.scope" not in st


def test_pages_validates_and_deploys_the_scoped_commit():
    pages = (WF / "pages.yml").read_text(encoding="utf-8")
    assert "python3 scripts/deploy_scope.py)" in pages
    assert "ref: ${{ needs.scope.outputs.sha }}" in pages
    assert "scope: ${{ needs.scope.outputs.scope }}" in pages
    assert re.search(r"deploy_scope\.py advance \"\$validated\"", pages)
    assert "scope=full" in pages, "a crashed scope script must fall back to the full suite"


def test_a_stale_deploy_publishes_nothing():
    pages = (WF / "pages.yml").read_text(encoding="utf-8")
    deploy = pages[pages.index("\n  deploy:\n"):]
    after = deploy[deploy.index("id: pick"):]
    steps = re.split(r"\n      - ", after)[1:]
    assert steps, "no steps after the pick"
    for st in steps:
        assert "if: steps.pick.outputs.skip != 'true'" in st, "unguarded step after pick: " + st.splitlines()[0]
