"""ESPN headshot ids: matched to our exact names, verified, and never lost."""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import scrape  # noqa: E402

NOW = datetime(2026, 10, 1, 2, 0, tzinfo=timezone.utc)


def board(*pairs):
    comps = [{"competitors": [{"id": a_id, "athlete": {"displayName": a}},
                              {"id": b_id, "athlete": {"displayName": b}}]}
             for (a, a_id), (b, b_id) in pairs]
    return {"events": [{"competitions": comps}]}


def card(date, *pairs):
    return {"date": date, "fights": [{"f1": {"name": a}, "f2": {"name": b}} for a, b in pairs]}


def test_matches_case_accents_and_punctuation():
    sb = board((("Rafael Dos Anjos", "1"), ("Natália Silva", "2")))
    ev = card("2026-10-03", ("Rafael dos Anjos", "Natalia Silva"))
    got = scrape.update_espn_ids({}, [ev], NOW, scoreboard=lambda d: sb, exists=lambda i: True)
    assert got == {"Rafael dos Anjos": "1", "Natalia Silva": "2"}


def test_unverified_headshot_is_not_stored():
    sb = board((("Lucas Armand", "404"), ("Johnny Walker", "7")))
    ev = card("2026-10-03", ("Lucas Armand", "Johnny Walker"))
    got = scrape.update_espn_ids({}, [ev], NOW, scoreboard=lambda d: sb, exists=lambda i: i != "404")
    assert got == {"Johnny Walker": "7"}


def test_never_removes_or_changes_a_stored_id_and_skips_known_names():
    asked = []
    ev = card("2026-10-03", ("Johnny Walker", "Mick Parkin"))
    got = scrape.update_espn_ids({"Johnny Walker": "7", "Someone Old": "9"}, [ev], NOW,
                                 scoreboard=lambda d: asked.append(d) or {},
                                 exists=lambda i: True)
    assert got == {"Johnny Walker": "7", "Someone Old": "9"}
    assert asked == ["2026-10-03"]   # Parkin still missing → asked; failed fetch → nothing lost


def test_only_cards_near_now_and_only_that_dates_board():
    calls = []
    far = card("2026-12-30", ("A B", "C D"))
    old = card("2026-09-01", ("E F", "G H"))
    scrape.update_espn_ids({}, [far, old], NOW, scoreboard=lambda d: calls.append(d) or {}, exists=lambda i: True)
    assert calls == []


def test_unrelated_name_is_never_matched():
    sb = board((("John Smith", "1"), ("Jon Smyth", "2")))
    ev = card("2026-10-03", ("John Smithson", "J Smith"))
    assert scrape.update_espn_ids({}, [ev], NOW, scoreboard=lambda d: sb, exists=lambda i: True) == {}


def test_data_js_round_trip_and_insert():
    data = 'var GENERATED_AT="x";\nvar EVENTS=[];\n'
    data = scrape.set_js_var(data, "FIGHTER_ESPN", '{"A B":"12"}')
    assert 'var FIGHTER_ESPN={"A B":"12"};\nvar EVENTS=[]' in data
    assert scrape.extract_espn_ids(data) == {"A B": "12"}
    data = scrape.set_js_var(data, "FIGHTER_ESPN", '{"A B":"12","C D":"3"}')
    assert data.count("var FIGHTER_ESPN=") == 1 and scrape.extract_espn_ids(data)["C D"] == "3"
    assert scrape.extract_espn_ids('var FIGHTER_ESPN={"x":"<script>"};') == {}
