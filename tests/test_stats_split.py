"""FIGHTER_STATS lives in fighter-stats.js, its bookkeeping in stats-state.json.

It was ~73 KB of data.js's ~88 KB gzipped, and data.js changes on every scraper
commit, so every app open re-downloaded every fighter's stats though they change
in about one commit in twenty. datafile.py now splits it out on write and merges
it back on read, so the scraper still sees one document. What these hold:

  * nothing is lost or changed: legacy file -> split -> read back is the same
    document, and data.js is the old file minus one line, byte for byte;
  * the stats file's bytes depend only on the stats (sorted), so an unchanged set
    keeps its ETag and the app gets a 304;
  * the scraper's bookkeeping (fetch_failed, which churned on every run during a
    UFCStats outage) stays out of the file the app downloads;
  * the first run after the change performs the split, and reads data.js's own
    copy (the newest) when one is still there;
  * health.py still sees the stats.

Frozen fight-week snapshot only; no live data files.
"""
import json
from pathlib import Path

import pytest

import datafile
import health
import scrape

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "fight-week" / "data.js"


def _legacy():
    return FIXTURE.read_text(encoding="utf-8")


def _split_into(tmp_path, text):
    (tmp_path / "data.js").write_text(text, encoding="utf-8")
    files = datafile.checked_dump_files(datafile.read_files(tmp_path))
    for name, body in files.items():
        (tmp_path / name).write_text(body, encoding="utf-8")
    return files


def test_fixture_has_stats_and_bookkeeping_to_split():
    stats = datafile.loads(_legacy())["FIGHTER_STATS"]
    assert len(stats) > 100
    assert any("fetch_failed" in v for v in stats.values()), "fixture should exercise the bookkeeping split"


def test_split_then_read_back_is_the_same_document(tmp_path):
    files = _split_into(tmp_path, _legacy())
    assert datafile.to_json(datafile.read_files(tmp_path)) == datafile.to_json(datafile.loads(_legacy()))
    # data.js is the old file without its FIGHTER_STATS line, every other byte the same.
    old_minus = "".join(l for l in _legacy().splitlines(True) if not l.startswith("var FIGHTER_STATS="))
    assert files["data.js"] == old_minus
    assert "FIGHTER_STATS" not in files["data.js"]


def test_the_app_file_carries_no_bookkeeping_and_the_state_file_nothing_else(tmp_path):
    files = _split_into(tmp_path, _legacy())
    public = datafile.loads_stats(files[datafile.STATS_FILE])
    state = json.loads(files[datafile.STATS_STATE_FILE])
    assert not any(k in v for v in public.values() for k in datafile.STATS_BOOKKEEPING)
    assert state and all(set(v) <= set(datafile.STATS_BOOKKEEPING) for v in state.values())
    # Everything the app reads survived: url and fetched_at are shown / used.
    full = datafile.loads(_legacy())["FIGHTER_STATS"]
    for name, entry in full.items():
        assert public[name] == {k: v for k, v in entry.items() if k not in datafile.STATS_BOOKKEEPING}


def test_unchanged_stats_rewrite_to_identical_bytes_whatever_the_dict_order(tmp_path):
    files = _split_into(tmp_path, _legacy())
    doc = datafile.read_files(tmp_path)
    shuffled = dict(reversed(list(doc["FIGHTER_STATS"].items())))
    doc["FIGHTER_STATS"] = shuffled
    again = datafile.checked_dump_files(doc)
    assert again[datafile.STATS_FILE] == files[datafile.STATS_FILE]
    assert again[datafile.STATS_STATE_FILE] == files[datafile.STATS_STATE_FILE]


def test_bookkeeping_churn_never_touches_the_file_the_app_downloads(tmp_path):
    # 2026-11-07..13: fetch_failed was re-stamped on every run during a UFCStats
    # outage, and every commit changed the stats. Now only stats-state.json moves.
    files = _split_into(tmp_path, _legacy())
    doc = datafile.read_files(tmp_path)
    name = next(iter(doc["FIGHTER_STATS"]))
    doc["FIGHTER_STATS"][name]["fetch_failed"] = "2026-11-08T00:00:00+00:00"
    again = datafile.checked_dump_files(doc)
    assert again[datafile.STATS_FILE] == files[datafile.STATS_FILE]
    assert again[datafile.STATS_STATE_FILE] != files[datafile.STATS_STATE_FILE]


def test_a_legacy_data_js_copy_wins_over_stale_split_files(tmp_path):
    # Transition: the PR ships a snapshot of fighter-stats.js while data.js on
    # main still carries its own (newer) copy. The scraper must read that copy.
    _split_into(tmp_path, _legacy())
    legacy = datafile.loads(_legacy())
    name = next(iter(legacy["FIGHTER_STATS"]))
    legacy["FIGHTER_STATS"][name]["rec"] = "99-0-0"
    (tmp_path / "data.js").write_text(datafile.dumps(legacy), encoding="utf-8")
    assert datafile.read_files(tmp_path)["FIGHTER_STATS"][name]["rec"] == "99-0-0"


def test_no_stats_anywhere_reads_as_no_stats(tmp_path):
    doc = datafile.loads(_legacy())
    doc.pop("FIGHTER_STATS")
    (tmp_path / "data.js").write_text(datafile.dumps(doc), encoding="utf-8")
    back = datafile.read_files(tmp_path)
    assert "FIGHTER_STATS" not in back
    assert set(datafile.checked_dump_files(back)) == {"data.js"}


@pytest.mark.parametrize("bad", [
    "var FIGHTER_STATS=[];\n",
    "var FIGHTER_STATS={};\nvar X=1;\n",
    "var FIGHTER_STATS=(globalThis.x=1);\n",
    "var OTHER={};\n",
])
def test_a_stats_file_in_any_other_shape_is_an_error_not_a_guess(tmp_path, bad):
    _split_into(tmp_path, _legacy())
    (tmp_path / "data.js").write_text(
        "".join(l for l in _legacy().splitlines(True) if not l.startswith("var FIGHTER_STATS=")), encoding="utf-8")
    (tmp_path / datafile.STATS_FILE).write_text(bad, encoding="utf-8")
    with pytest.raises(datafile.DataError):
        datafile.read_files(tmp_path)


def test_a_stats_entry_that_is_not_an_object_is_never_written():
    doc = datafile.loads(_legacy())
    doc["FIGHTER_STATS"]["Someone"] = "not an object"
    with pytest.raises(datafile.DataError):
        datafile.checked_dump_files(doc)


def test_the_first_scraper_run_performs_the_split(tmp_path, monkeypatch):
    # Legacy data.js in, three files out, through scrape.main's own write path.
    (tmp_path / "data.js").write_text(_legacy(), encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(scrape.time, "sleep", lambda *_: None)
    monkeypatch.setattr(scrape, "send_push_notifications", lambda *a, **k: None)
    monkeypatch.setattr(scrape, "update_results_archive", lambda doc, now: None)

    def inject(doc, now):
        doc["GENERATED_AT"] = "split test"
        return 1, []
    monkeypatch.setattr(scrape, "step_inject_results", inject)
    with pytest.raises(SystemExit) as e:
        scrape.main()
    assert e.value.code == 0
    data = (tmp_path / "data.js").read_text(encoding="utf-8")
    assert "var FIGHTER_STATS=" not in data and "split test" in data
    assert (tmp_path / datafile.STATS_FILE).exists() and (tmp_path / datafile.STATS_STATE_FILE).exists()
    assert datafile.read_files(tmp_path)["FIGHTER_STATS"] == datafile.loads(_legacy())["FIGHTER_STATS"]


def test_a_refused_write_leaves_all_three_files_alone(tmp_path, monkeypatch):
    files = _split_into(tmp_path, _legacy())
    before = {n: (tmp_path / n).read_text(encoding="utf-8") for n in files}
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(scrape.time, "sleep", lambda *_: None)
    monkeypatch.setattr(scrape, "send_push_notifications", lambda *a, **k: None)
    monkeypatch.setattr(scrape, "update_results_archive", lambda doc, now: None)

    def spoil(doc, now):
        doc["FIGHTER_STATS"]["Broken"] = "not an object"
        return 1, []
    monkeypatch.setattr(scrape, "step_inject_results", spoil)
    with pytest.raises(SystemExit) as e:
        scrape.main()
    assert e.value.code == 1
    assert {n: (tmp_path / n).read_text(encoding="utf-8") for n in files} == before


def test_health_still_sees_the_stats_after_the_split(tmp_path):
    _split_into(tmp_path, _legacy())
    split_text = health.with_split_stats((tmp_path / "data.js").read_text(encoding="utf-8"), tmp_path / "data.js")
    assert health.parse_stats_cache(split_text) == health.parse_stats_cache(_legacy())
    assert health.parse_stats_cache(split_text)            # non-empty
    # A legacy data.js is passed through untouched.
    assert health.with_split_stats(_legacy(), tmp_path / "data.js") == _legacy()


def test_update_yml_commits_both_new_files():
    update = (ROOT / ".github" / "workflows" / "update.yml").read_text(encoding="utf-8")
    loop = update[update.index("for f in data.js"):update.index("; do", update.index("for f in data.js"))]
    assert datafile.STATS_FILE in loop and datafile.STATS_STATE_FILE in loop
