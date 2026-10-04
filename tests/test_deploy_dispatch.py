"""update.yml dispatches the Pages deploy instead of calling it.

As a `uses: ./.github/workflows/pages.yml` job, the deploy (validate ~3.5 min
plus deploy) ran inside the scrape's own run, and `update-main`'s
cancel-in-progress could not end that run until it finished: every new
dispatch waited behind it, so on 2026-10-03 a scrape started only every ~8-10
minutes on fight night. Dispatched as its own run, pages.yml keeps its validate
gate and its `github-pages` queue, and the scrape's run ends after its commit.
"""
import re
from pathlib import Path

WF = Path(__file__).resolve().parent.parent / ".github" / "workflows"


def job_block(text, name):
    m = re.search(rf"^  {name}:\n(.*?)(?=^  [A-Za-z_-]+:\n|\Z)", text, re.M | re.S)
    assert m, f"no `{name}` job"
    return m.group(1)


def test_update_dispatches_pages_rather_than_calling_it():
    update = (WF / "update.yml").read_text(encoding="utf-8")
    assert "uses: ./.github/workflows/pages.yml" not in update, \
        "a called deploy runs inside the scrape's run and holds up the next dispatch"
    deploy = job_block(update, "deploy")
    assert re.search(r"gh workflow run pages\.yml\b.*--ref main", deploy)
    assert re.search(r"actions:\s*write", deploy), "dispatching a workflow needs actions: write"
    # Still gated on a commit existing, whatever colour the update job ended.
    assert "if: always() && needs.update.outputs.pushed == 'true'" in deploy


def test_pages_still_accepts_a_dispatch_and_gates_on_validate():
    pages = (WF / "pages.yml").read_text(encoding="utf-8")
    on = pages[pages.index("\non:"):pages.index("\npermissions:")]
    assert "workflow_dispatch:" in on
    deploy = job_block(pages, "deploy")
    assert "needs: validate" in deploy
    assert re.search(r"group:\s*github-pages", deploy)
    assert "cancel-in-progress: false" in deploy, "never cancel an in-flight production deploy"


def test_a_slow_scrape_finishes_instead_of_being_cancelled():
    # 2026-10-03: runs that outlasted the 5-minute dispatch were cancelled
    # before committing, 97 in a row, and no data landed for 7 hours.
    update = (WF / "update.yml").read_text(encoding="utf-8")
    conc = update[update.index("\nconcurrency:"):update.index("\njobs:")]
    assert re.search(r"group:\s*update-main", conc)
    assert "cancel-in-progress: false" in conc
    assert "cancel-in-progress: true" not in update
