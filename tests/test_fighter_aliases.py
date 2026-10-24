"""FIGHTER_ALIASES: a respelled fighter keeps the picks made under the old name."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import scrape  # noqa: E402

DATE = "2026-10-24"


def old(*pairs):
    return {("UFC 333", DATE): [{"f1": {"name": a}, "f2": {"name": b}} for a, b in pairs]}


def new(*pairs, date=DATE):
    return [{"date": date, "fights": [{"f1": {"name": a}, "f2": {"name": b}} for a, b in pairs]}]


def seedless(m):
    return {k: v for k, v in m.items() if k not in scrape._SEED_FIGHTER_ALIASES}


def test_a_respelling_on_a_bout_is_recorded():
    # The UFC 333 incident: the other corner unchanged, one name respelled.
    got = scrape.update_fighter_aliases({}, old(("Iasmin Lucindo", "Nicole Caliari")),
                                        new(("Iasmin Lucindo", "Nicolle Caliari")))
    assert got["Nicole Caliari"] == "Nicolle Caliari"


def test_either_corner_and_a_flip_count():
    got = scrape.update_fighter_aliases({}, old(("Mahammadali Osmanli", "Joe Smith")),
                                        new(("Joe Smith", "Mehemmedeli Osmanli")))
    assert seedless(got) == {"Mahammadali Osmanli": "Mehemmedeli Osmanli"}


def test_a_real_replacement_is_not_an_alias():
    got = scrape.update_fighter_aliases({}, old(("Iasmin Lucindo", "Nicole Caliari")),
                                        new(("Iasmin Lucindo", "Tabatha Ricci")))
    assert seedless(got) == {}


def test_a_fighter_still_on_the_card_is_never_aliased_away():
    # Two bouts reshuffled: "John Smith" still fights, so he isn't renamed.
    got = scrape.update_fighter_aliases(
        {}, old(("A Fighter", "John Smith"), ("B Fighter", "Jake Smith")),
        new(("A Fighter", "Jake Smith"), ("B Fighter", "John Smith")))
    assert seedless(got) == {}


def test_an_unchanged_card_or_another_date_adds_nothing():
    same = old(("Iasmin Lucindo", "Nicolle Caliari"))
    assert seedless(scrape.update_fighter_aliases({}, same, new(("Iasmin Lucindo", "Nicolle Caliari")))) == {}
    assert seedless(scrape.update_fighter_aliases({}, old(("X Ab", "Nicole Caliari")),
                                                  new(("X Ab", "Nicolle Caliari"), date="2026-10-31"))) == {}


def test_the_map_only_grows_and_is_seeded():
    got = scrape.update_fighter_aliases({"Old Name": "New Name"}, {}, [])
    assert got["Old Name"] == "New Name"
    assert got["Nicole Caliari"] == "Nicolle Caliari"


def test_fold_matches_the_apps_nmkey():
    assert scrape._nm_fold("José O’Malley-Smith Jr.") == "jose o malley smith"
    assert scrape.looks_like_rename("Ilimbek Akylbek uulu", "Ilimbek Akylbek")
    assert not scrape.looks_like_rename("John Smith", "John Doe")


def test_round_trip_through_data_js():
    data = "var EVENTS=[];"
    data = scrape.set_js_var(data, "FIGHTER_ALIASES", '{"Nicole Caliari":"Nicolle Caliari"}')
    assert scrape.extract_fighter_aliases(data) == {"Nicole Caliari": "Nicolle Caliari"}
    assert scrape.extract_fighter_aliases("var EVENTS=[];") == {}
