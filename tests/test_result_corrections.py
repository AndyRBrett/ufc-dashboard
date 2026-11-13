"""A finished bout's method and round follow a corrected Wikipedia reading.

inject_results never re-reads a bout once it is state:"post", so UFC 333's main
event went in as Submission R1 from an early edit and stayed there after the
page was fixed (TKO R2), scoring every KO/TKO pick on it as a method miss.
correct_results re-reads method and round, never the winner, and never a bout
pinned by hand. No live data files: every card here is built inline.
"""
import copy
from datetime import datetime, timezone

import datafile
import scrape


def _card(f1, f2, winner="", method="", rnd="null", state="pre"):
    return (
        'var EVENTS=[{name:"UFC 999: Test",\n  date:"2030-01-05",\n  fights:['
        '{lbl:"Main Event",wc:"Lightweight",title:false,rematch:false,'
        f'odds:{{f1:-150,f2:130}},winner:"{winner}",method:"{method}",round:{rnd},'
        f'state:"{state}",f1:{{n:"{f1}",r:"10-1-0",rk:"",s:null}},'
        f'f2:{{n:"{f2}",r:"9-2-0",rk:"",s:null}}}}]}}];'
    )


def _correct(js, results):
    """correct_results on the card `js` describes: (data.js after, count,
    whether anything in the document changed)."""
    doc = datafile.loads(js)
    before = copy.deepcopy(doc)
    n = scrape.correct_results(doc, results)
    return datafile.dumps(doc), n, doc != before


def _res(winner, loser, method, rnd):
    return [{"winner": winner, "loser": loser, "method": method, "round": rnd}]


def test_a_corrected_method_and_round_replace_the_early_reading():
    js = _card("Liu Ce", "Levi Rodrigues", "Liu Ce", "Submission", "1", "post")
    out, n, _ = _correct(js, _res("Liu Ce", "Levi Rodrigues", "KO/TKO", 2))
    assert n == 1
    assert 'method:"KO/TKO"' in out and "round:2" in out
    assert 'winner:"Liu Ce"' in out and 'state:"post"' in out
    # Only the result fields moved.
    assert (out.replace('method:"KO/TKO",round:2', 'method:"Submission",round:1')
            == datafile.dumps(datafile.loads(js)))


def test_a_reading_that_agrees_changes_nothing_and_counts_nothing():
    # main() skips the rebuild on any count, so a no-op must count zero.
    js = _card("Liu Ce", "Levi Rodrigues", "Liu Ce", "KO/TKO", "2", "post")
    _, n, changed = _correct(js, _res("Liu Ce", "Levi Rodrigues", "KO/TKO", 2))
    assert (n, changed) == (0, False)


def test_a_changed_winner_is_left_for_a_human():
    js = _card("Liu Ce", "Levi Rodrigues", "Liu Ce", "Submission", "1", "post")
    _, n, changed = _correct(js, _res("Levi Rodrigues", "Liu Ce", "KO/TKO", 2))
    assert (n, changed) == (0, False)


def test_a_blank_method_or_round_never_erases_a_known_one():
    js = _card("Liu Ce", "Levi Rodrigues", "Liu Ce", "Submission", "1", "post")
    _, n, changed = _correct(js, _res("Liu Ce", "Levi Rodrigues", "", None))
    assert (n, changed) == (0, False)
    out, n, _ = _correct(js, _res("Liu Ce", "Levi Rodrigues", "KO/TKO", None))
    assert n == 1 and 'method:"KO/TKO",round:1' in out


def test_an_unfinished_bout_is_left_to_inject_results():
    js = _card("Liu Ce", "Levi Rodrigues")
    _, n, changed = _correct(js, _res("Liu Ce", "Levi Rodrigues", "KO/TKO", 2))
    assert (n, changed) == (0, False)


def test_a_draw_is_never_corrected():
    js = _card("Liu Ce", "Levi Rodrigues", "", "Draw", "3", "post")
    und = [{"winner": "", "loser": "", "f1": "Liu Ce", "f2": "Levi Rodrigues",
            "method": "NC", "round": 1, "undecided": True}]
    assert _correct(js, und)[1:] == (0, False)


def test_a_pinned_bout_keeps_its_hand_correction():
    js = _card("Alexander Volkanovski", "Movsar Evloev",
               "Alexander Volkanovski", "KO/TKO", "2", "post")
    _, n, changed = _correct(
        js, _res("Alexander Volkanovski", "Movsar Evloev", "Submission", 1))
    assert (n, changed) == (0, False)


def test_a_hostile_method_stays_one_parseable_field():
    js = _card("Liu Ce", "Levi Rodrigues", "Liu Ce", "Submission", "1", "post")
    out, n, _ = _correct(
        js, _res("Liu Ce", "Levi Rodrigues", 'KO ("punches")\\\n', "2);x"))
    assert n == 1 and 'method:"KO (punches)",round:1' in out
    _, n2, changed = _correct(out, _res("Liu Ce", "Levi Rodrigues", "KO (punches)", 1))
    assert (n2, changed) == (0, False)


WIKI = """{{MMAevent bout
|Lightweight
|Liu Ce
|def.
|Levi Rodrigues
|TKO (punches)
|2
|4:54
|
}}"""


def test_step_inject_results_writes_a_correction_but_pushes_nothing(monkeypatch):
    js = _card("Liu Ce", "Levi Rodrigues", "Liu Ce", "Submission", "1", "post")
    monkeypatch.setattr(scrape, "fetch_event_wikitext", lambda *a, **k: WIKI)
    monkeypatch.setattr(scrape.time, "sleep", lambda *_: None)
    now = datetime(2030, 1, 5, 23, 0, tzinfo=timezone.utc)
    doc = datafile.loads(js)
    changed, new_results = scrape.step_inject_results(doc, now)
    assert changed == 1 and 'method:"KO/TKO",round:2' in datafile.dumps(doc)
    assert new_results == []
    # The next run reads the same page and finds nothing to do.
    after = copy.deepcopy(doc)
    assert scrape.step_inject_results(doc, now) == (0, [])
    assert doc == after
