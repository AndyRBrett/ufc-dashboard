"""data.js is read once, edited as values, and written once (datafile.py).

The scraper used to edit the published file as text, and each of these was a
way that went wrong: a result spliced in by brace counting, a card read back by
a regex that depended on field order, a whole var swapped with `var X=.*?;`
(which stops at the first semicolon inside a value). These tests hold the
replacement: one strict parser, one renderer that reproduces the file byte for
byte, and a scraper that never matches data.js text.

No live data files: the frozen fight-week snapshot and inline cards only.
"""
import copy
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pytest

import datafile
import scrape

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "fight-week" / "data.js"
NOW = datetime(2026, 9, 26, 12, 0, tzinfo=timezone.utc)


def _fixture():
    return FIXTURE.read_text(encoding="utf-8")


# --- the file comes back byte for byte ---------------------------------------

def test_a_file_this_module_wrote_round_trips_byte_for_byte():
    # Every other reader of data.js (the app, health.py, write_status.py, the
    # edge functions) still reads the text. If a read-and-write changed one
    # byte of an untouched file, they would all see a different file.
    text = _fixture()
    assert datafile.dumps(datafile.loads(text)) == text
    assert datafile.checked_dumps(datafile.loads(text)) == text


def test_events_come_back_in_the_shape_the_scraper_builds():
    doc = datafile.loads(_fixture())
    assert list(doc)[-1] == "EVENTS"
    fight = doc["EVENTS"][0]["fights"][0]
    assert set(fight) == {"label", "wc", "title", "rematch", "odds", "winner",
                          "method", "round", "state", "f1", "f2"}
    assert set(fight["f1"]) == {"name", "record", "ranking"}
    # ...and render through the same serialiser a fresh rebuild uses.
    assert datafile.events_js(doc["EVENTS"]) in _fixture()


def test_the_json_view_is_what_the_edge_functions_parser_reads():
    # parseDataJs (supabase/functions/_shared/datajs.js) is the other parser of
    # this file. The two must agree on every value, or a reader that moves from
    # one to the other sees different data.
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    script = (
        "import {parseDataJs} from './supabase/functions/_shared/datajs.js';"
        "import {readFileSync} from 'node:fs';"
        f"process.stdout.write(JSON.stringify(parseDataJs(readFileSync({json.dumps(str(FIXTURE))},'utf8'))));"
    )
    out = subprocess.run([node, "--input-type=module", "-e", script], cwd=ROOT,
                         capture_output=True, text=True, check=True).stdout
    assert json.loads(out) == datafile.to_json(datafile.loads(_fixture()))


# --- only what the scraper writes is accepted --------------------------------

def _mini(fight_extra="", event_extra="", tail=""):
    return (
        'var GENERATED_AT="x";\n'
        'var EVENTS=[{name:"UFC 999: A vs. B",date:"2030-01-05",' + event_extra + 'fights:['
        '{lbl:"Main Event",wc:"Lightweight",title:false,rematch:false,odds:{f1:-150,f2:130},'
        'winner:"",method:"",round:null,state:"pre",' + fight_extra +
        'f1:{n:"A A",r:"1-0-0",rk:"",s:null},f2:{n:"B B",r:"0-1-0",rk:"",s:null}}]}];\n' + tail
    )


def test_the_minimal_card_reads():
    doc = datafile.loads(_mini())
    assert doc["GENERATED_AT"] == "x" and doc["EVENTS"][0]["fights"][0]["odds"] == {"f1": -150, "f2": 130}


@pytest.mark.parametrize("bad", [
    'var EVENTS=load();',                      # a call
    'var EVENTS=[1,];',                        # a trailing comma
    'var EVENTS=[undefined];',                 # an identifier that is not a literal
    'var X={"a":1,"a":2};',                    # a key given twice
    'var X=1;\nvar X=2;',                      # a var declared twice
    'var X=1',                                 # no terminator
    'var X="unterminated;',
    "var X='single';",
    'var X=1+1;',
    'let X=1;',
    'var X=1; alert(1);',
])
def test_anything_else_is_an_error_not_a_guess(bad):
    with pytest.raises(datafile.DataError):
        datafile.loads(bad)


@pytest.mark.parametrize("text", [
    _mini(fight_extra='bonus:true,'),          # a field fight_js does not write
    _mini(event_extra='sponsor:"x",'),         # a field events_js does not write
    _mini().replace('f1:-150', 'f1:"EVEN"'),   # a line that is not a number
    _mini().replace('round:null', 'round:"2"'),
    _mini().replace('name:"UFC 999: A vs. B",', ''),
    _mini().replace('n:"A A",', ''),
])
def test_a_card_field_the_renderer_would_lose_is_refused(text):
    # Read-and-write must never drop something silently: a field this module
    # does not know is a loud failure, so it gets added here on purpose.
    with pytest.raises(datafile.DataError):
        datafile.loads(text)


# --- values are values: nothing in them can break the file -------------------

HOSTILE = 'TKO; "doctor" stoppage \\ }]); var EVENTS=[];\n </script>'


def test_a_semicolon_or_quote_inside_a_value_cannot_corrupt_the_file():
    # `var NAME=.*?;` stopped at the first semicolon inside a value, so a
    # fighter stat or event name containing one truncated the var on the next
    # write. Nothing is matched as text any more.
    doc = datafile.loads(_fixture())
    name = next(iter(doc["FIGHTER_STATS"]))
    doc["FIGHTER_STATS"][name]["stn"] = HOSTILE
    doc["EVENTS"][0]["venue"] = HOSTILE
    doc["EVENTS"][0]["fights"][0]["f1"]["name"] = HOSTILE
    doc["RANKINGS"][HOSTILE] = 3
    back = datafile.loads(datafile.checked_dumps(doc))
    assert back == doc
    # A second read-and-write is stable, and every other var is untouched.
    assert datafile.dumps(back) == datafile.dumps(doc)
    assert back["RESULTS_ARCHIVE"] == datafile.loads(_fixture())["RESULTS_ARCHIVE"]


def test_a_new_var_lands_ahead_of_events():
    doc = datafile.loads(_mini())
    doc["FIGHTER_ALIASES"] = {"b": "c", "a": "b"}
    text = datafile.dumps(doc)
    assert 'var FIGHTER_ALIASES={"a":"b","b":"c"};\nvar EVENTS=[' in text
    assert text.startswith(datafile.HEADER)


@pytest.mark.parametrize("spoil", [
    lambda d: d["EVENTS"][0]["fights"][0].__setitem__("odds", {"f1": "EVEN", "f2": 100}),
    lambda d: d["EVENTS"][0]["fights"][0].__setitem__("odds", {"f1": float("nan"), "f2": 100}),
    lambda d: d.__setitem__("RANKINGS", {"A": float("inf")}),
    lambda d: d.__setitem__("FIGHTER_STATS", {"A": {1, 2}}),
    lambda d: d["EVENTS"][0]["fights"][0]["f1"].__setitem__("name", None),
    lambda d: d["EVENTS"][0].pop("name"),
])
def test_a_document_that_would_not_read_back_is_never_written(spoil):
    doc = datafile.loads(_mini())
    spoil(doc)
    with pytest.raises(datafile.DataError):
        datafile.checked_dumps(doc)


# --- the scraper edits values, and only publishes what reads back ------------

def test_a_result_is_one_edit_and_leaves_every_other_byte_alone():
    text = _fixture()
    doc = datafile.loads(text)
    fight = next(f for f in doc["EVENTS"][-1]["fights"] if f["state"] == "pre")
    a, b = fight["f1"]["name"], fight["f2"]["name"]
    n = scrape.inject_results(doc, [{"winner": b, "loser": a, "method": "KO/TKO", "round": 2}])
    assert n == 1
    old_line = datafile.fight_js(dict(fight, winner="", method="", round=None, state="pre"))
    new_line = datafile.fight_js(fight)
    assert f'winner:{json.dumps(b)},method:"KO/TKO",round:2,state:"post"' in new_line
    assert text.count(old_line) == 1
    assert datafile.dumps(doc) == text.replace(old_line, new_line)


def test_a_finished_bout_with_a_short_line_no_longer_hides_the_one_above_it():
    # The text version asked "is this bout already final?" by looking for
    # state:"post" in the 300 characters after the bout's opening brace. A bout
    # written short enough let that window reach the NEXT bout's state, and
    # since a card finishes from the bottom up, the bout below is usually
    # final already: the result above it was then never written.
    def fight(a, b, state="pre", winner=""):
        return {"label": "", "wc": "", "title": False, "rematch": False, "odds": None,
                "winner": winner, "method": "DQ" if winner else "", "round": None, "state": state,
                "f1": {"name": a, "record": "", "ranking": ""},
                "f2": {"name": b, "record": "", "ranking": ""}}
    doc = {"EVENTS": [{"name": "X", "date": "2030-01-05",
                       "fights": [fight("Li Mu", "Yi Ha"), fight("Bo Ra", "Cy Di", "post", "Bo Ra")]}]}
    assert len(datafile.fight_js(doc["EVENTS"][0]["fights"][0])) < 180
    n = scrape.inject_results(doc, [{"winner": "Li Mu", "loser": "Yi Ha", "method": "KO/TKO", "round": 1}])
    assert n == 1 and doc["EVENTS"][0]["fights"][0]["state"] == "post"


def _run_main(tmp_path, monkeypatch, text):
    (tmp_path / "data.js").write_text(text, encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(scrape.time, "sleep", lambda *_: None)
    pushes = []
    monkeypatch.setattr(scrape, "send_push_notifications", lambda r, *a, **k: pushes.append(r))
    code = 0
    try:
        scrape.main()
    except SystemExit as e:
        code = e.code
    return code, (tmp_path / "data.js").read_text(encoding="utf-8"), pushes


def test_an_unreadable_data_js_fails_the_run_and_is_left_alone(tmp_path, monkeypatch, capsys):
    # No fallback and no partial rewrite: the last file stays, the run is red.
    called = []
    monkeypatch.setattr(scrape, "fetch_event_wikitext", lambda *a, **k: called.append(a))
    bad = _fixture().replace("var EVENTS=[", "var EVENTS=[oops(),", 1)
    code, after, pushes = _run_main(tmp_path, monkeypatch, bad)
    assert code == 1 and after == bad and pushes == [] and called == []
    assert "cannot be read" in capsys.readouterr().err


def test_a_document_that_cannot_be_written_fails_the_run_and_is_left_alone(tmp_path, monkeypatch):
    text = _fixture()

    def spoiled_inject(doc, now):
        doc["EVENTS"][0]["fights"][0]["odds"] = {"f1": "EVEN", "f2": 100}
        return 1, [{"winner": "A", "loser": "B"}]
    monkeypatch.setattr(scrape, "step_inject_results", spoiled_inject)
    code, after, pushes = _run_main(tmp_path, monkeypatch, text)
    assert code == 1 and after == text
    assert pushes == []          # nothing published, so nothing announced


def test_a_rebuild_that_builds_nothing_leaves_the_document_untouched(monkeypatch):
    # Everything the rebuild reads from the published file is a copy: a run
    # that fetches, edits a kept card and then finds it has no events must not
    # have changed what the later steps write.
    doc = datafile.loads(_fixture())
    before = copy.deepcopy(doc)
    monkeypatch.setattr(scrape, "load_rematch_cache", lambda *a, **k: {})
    monkeypatch.setattr(scrape, "save_rematch_cache", lambda *a, **k: None)
    monkeypatch.setattr(scrape, "load_odds_state", lambda: {})
    monkeypatch.setattr(scrape, "should_fetch_odds", lambda *a, **k: False)
    monkeypatch.setattr(scrape, "discover_upcoming_events", lambda now: [])
    monkeypatch.setattr(scrape, "extract_recent_past_events", lambda *a, **k: [])
    monkeypatch.setattr(scrape, "load_official_times", lambda *a, **k: {})
    assert scrape.step_build_events(doc, NOW) is False
    assert doc == before
    # The copies are real ones.
    cards = scrape._extract_existing_cards(doc)
    next(iter(cards.values()))[0]["winner"] = "changed"
    scrape.extract_stats_cache(doc).clear()
    assert doc == before


def test_scrape_never_matches_data_js_as_text():
    # The whole point: no pattern in scrape.py reads or edits the published
    # file's text. These are the shapes the old readers were built from.
    src = (ROOT / "scrape.py").read_text(encoding="utf-8")
    for shape in ('\\{lbl:', 'f1:\\{n:', '\\{n:"', 'name:"(', 'date:"(', 'winner:"(', 'winner:"[',
                  'method:"[', 'method:"(', 'round:(', 'odds:\\{', '"var EVENTS=', 'var {',
                  '=(\\{.*?\\});', 'patch_js_var', 'set_js_var'):
        assert shape not in src, f"scrape.py matches data.js text again: {shape!r}"
