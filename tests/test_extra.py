"""extra.py — non-UFC cards for the Hub, built from Wikipedia in shadow mode.

The fixtures are shaped like the UFC wikitext scrape.py already parses (the
same {{MMAevent bout}} template and events-list table), since PFL articles use
the same templates. What these tests hold is the part that must be right
regardless of layout details: the window, the refusal to publish a stub, never
dropping a card on a failed fetch, the cadence gate, and shadow mode leaving
the live file alone.
"""
import json
from datetime import datetime, timezone

import pytest

import extra

NOW = datetime(2026, 9, 24, 12, 0, tzinfo=timezone.utc)

LIST = """
== Scheduled events ==
{| class="wikitable"
! Event !! Date !! Venue !! Location
|-
| [[PFL Chicago|PFL Chicago: Carmouche vs. Bishop]] || {{dts|2026|10|16}} || Wintrust Arena || Chicago, Illinois, U.S.
|-
| PFL Africa: Morocco || {{dts|2026|10|10}} || Salle Mohammed V || Casablanca, Morocco
|-
| [[PFL Far Future]] || {{dts|2027|6|1}} || TBD || TBD
|}

== Past events ==
{| class="wikitable"
|-
| [[PFL Old Card]] || {{dts|2026|8|1}} || Somewhere || Someplace
|}
"""

CHICAGO = """
==Fight card==
{{MMAevent bout
|Women's Flyweight
|Liz Carmouche (c)
|vs.
|Jena Bishop
}}
{{MMAevent bout
|Featherweight
|Timur Khizriev
|vs.
|Gabriel Braga
}}
{{MMAevent bout
|Bantamweight
|Some Fighter
|vs.
|TBD
}}
"""

YEAR = """
== PFL Africa: Morocco ==
{{MMAevent bout
|Lightweight
|Fighter Alpha
|vs.
|Fighter Bravo
}}
{{MMAevent bout
|Welterweight
|Fighter Charlie
|vs.
|Fighter Delta
}}
== Some Other Event ==
{{MMAevent bout
|Heavyweight
|Wrong Card
|vs.
|Not This One
}}
"""


def fetcher(pages):
    calls = []
    def fetch(slug):
        calls.append(slug)
        return pages.get(slug, "")
    fetch.calls = calls
    return fetch


def test_discovers_upcoming_in_window_only():
    evs = extra.discover(extra.PROMOTIONS[0], LIST, NOW)
    names = [e["name"] for e in evs]
    assert names == ["PFL Africa: Morocco", "PFL Chicago: Carmouche vs. Bishop"]   # soonest first
    assert "PFL Far Future" not in names and "PFL Old Card" not in names
    chi = evs[1]
    assert chi["slug"] == "PFL_Chicago" and chi["date"] == "2026-10-16"
    assert evs[0]["slug"] is None          # an unlinked card has no article


def test_card_parses_bouts_and_drops_tbd():
    bouts = extra.card_from_wikitext(CHICAGO)
    assert [(b["a"], b["b"]) for b in bouts] == [("Liz Carmouche", "Jena Bishop"), ("Timur Khizriev", "Gabriel Braga")]
    assert bouts[0]["label"] == "Main Event" and bouts[1]["label"] == ""
    assert bouts[0]["title"] is True and bouts[0]["winner"] == ""


def test_card_without_article_comes_from_its_own_year_page_section():
    feed, report = extra.build(fetcher({extra.PROMOTIONS[0]["list_page"]: LIST, "PFL_Chicago": CHICAGO,
                                        "2026_in_Professional_Fighters_League": YEAR}), NOW)
    mor = next(e for e in feed["events"] if e["name"] == "PFL Africa: Morocco")
    assert [(b["a"], b["b"]) for b in mor["bouts"]] == [("Fighter Alpha", "Fighter Bravo"), ("Fighter Charlie", "Fighter Delta")]
    assert any(r.get("source") == "year page" for r in report)


def test_a_stub_is_never_published():
    stub = "{{MMAevent bout\n|Lightweight\n|Only One\n|vs.\n|Fighter\n}}"
    feed, report = extra.build(fetcher({extra.PROMOTIONS[0]["list_page"]: LIST, "PFL_Chicago": stub}), NOW)
    assert all(e["name"] != "PFL Chicago: Carmouche vs. Bishop" for e in feed["events"])
    assert any("only 1 bout" in (r.get("problem") or "") for r in report)


def test_a_failed_fetch_keeps_the_previous_card():
    prev, _ = extra.build(fetcher({extra.PROMOTIONS[0]["list_page"]: LIST, "PFL_Chicago": CHICAGO}), NOW)
    assert any(e["name"].startswith("PFL Chicago") for e in prev["events"])
    # The whole list fails: keep every in-window event we had.
    feed, report = extra.build(fetcher({}), NOW, prev)
    assert [e["name"] for e in feed["events"]] == [e["name"] for e in prev["events"]]
    assert any(r.get("problem") == "events list unavailable" for r in report)
    # One article fails: keep that card's previous version.
    feed2, report2 = extra.build(fetcher({extra.PROMOTIONS[0]["list_page"]: LIST}), NOW, prev)
    chi = next(e for e in feed2["events"] if e["name"].startswith("PFL Chicago"))
    assert len(chi["bouts"]) == 2
    assert any(r.get("kept_previous") for r in report2)


def test_results_are_attached_to_the_right_bout():
    done = CHICAGO.replace("|Liz Carmouche (c)\n|vs.\n|Jena Bishop", "|Jena Bishop\n|def.\n|Liz Carmouche (c)\n|Decision (unanimous)\n|5\n|5:00")
    bouts = extra.card_from_wikitext(done)
    b = next(x for x in bouts if {x["a"], x["b"]} == {"Jena Bishop", "Liz Carmouche"})
    assert b["winner"] == "Jena Bishop" and b["method"] and b["round"] == 5


def test_output_matches_the_engine_feed_format():
    feed, _ = extra.build(fetcher({extra.PROMOTIONS[0]["list_page"]: LIST, "PFL_Chicago": CHICAGO,
                                   "2026_in_Professional_Fighters_League": YEAR}), NOW)
    assert feed["promotions"] == [{"id": p["id"], "name": p["name"], "sport": p["sport"]} for p in extra.PROMOTIONS]
    assert feed["promotions"][0] == {"id": "pfl", "name": "PFL", "sport": "mma"}
    for e in feed["events"]:
        assert e["promotion"] == "pfl" and len(e["date"]) == 10 and e["name"] and e["bouts"]
        for b in e["bouts"]:
            assert b["a"] != b["b"] and set(b) >= {"a", "b", "label", "division", "title", "odds", "winner", "method", "round"}


def test_cadence_gate(monkeypatch):
    monkeypatch.delenv("EXTRA_FORCE", raising=False)
    assert extra.should_fetch({}, {}, NOW)[0]
    recent = {"last_fetch": "2026-09-24T06:00:00Z"}
    assert not extra.should_fetch(recent, {}, NOW)[0]                       # 6h < 12h
    assert extra.should_fetch({"last_fetch": "2026-09-23T23:00:00Z"}, {}, NOW)[0]   # 13h
    soon = {"events": [{"date": "2026-09-27"}]}
    assert extra.should_fetch(recent, soon, NOW)[0]                          # fight week: 4h
    monkeypatch.setenv("EXTRA_FORCE", "1")
    assert extra.should_fetch({"last_fetch": "2026-09-24T11:59:00Z"}, {}, NOW)[0]


def test_shadow_mode_never_touches_the_live_file(tmp_path, monkeypatch):
    live, cand, state = tmp_path / "events-extra.json", tmp_path / "cand.json", tmp_path / "state.json"
    live.write_text('{"promotions": [], "events": []}\n')
    monkeypatch.setattr(extra, "LIVE_JSON", live)
    monkeypatch.setattr(extra, "CANDIDATE_JSON", cand)
    monkeypatch.setattr(extra, "STATE_JSON", state)
    monkeypatch.setattr(extra.scrape, "fetch_wikitext", fetcher({extra.PROMOTIONS[0]["list_page"]: LIST, "PFL_Chicago": CHICAGO}))
    monkeypatch.delenv("EXTRA_PUBLISH", raising=False)
    monkeypatch.setenv("EXTRA_FORCE", "1")
    assert extra.main(NOW) == 0
    assert live.read_text() == '{"promotions": [], "events": []}\n'
    assert json.loads(cand.read_text())["events"]
    assert json.loads(state.read_text())["publish"] is False
    monkeypatch.setenv("EXTRA_PUBLISH", "1")
    assert extra.main(NOW) == 0
    assert json.loads(live.read_text())["events"]


def test_a_just_finished_card_in_the_past_table_is_kept():
    listing = LIST.replace("| [[PFL Old Card]] || {{dts|2026|8|1}}",
                           "| [[PFL Last Night]] || {{dts|2026|9|23}} || Arena || City\n|-\n| [[PFL Old Card]] || {{dts|2026|8|1}}")
    names = [e["name"] for e in extra.discover(extra.PROMOTIONS[0], listing, NOW)]
    assert "PFL Last Night" in names and "PFL Old Card" not in names


YEARS = """
== PFL World Tournament 1 ==
{{MMAevent bout
|Lightweight
|One A
|vs.
|One B
}}
{{MMAevent bout
|Lightweight
|One C
|vs.
|One D
}}
== PFL World Tournament 5 ==
{{MMAevent bout
|Welterweight
|Five A
|vs.
|Five B
}}
== PFL 10 ==
{{MMAevent bout
|Heavyweight
|Ten A
|vs.
|Ten B
}}
== PFL 1 ==
{{MMAevent bout
|Heavyweight
|Uno A
|vs.
|Uno B
}}
"""


def test_year_page_sections_are_told_apart_by_their_numbers():
    first = lambda name: extra.card_from_wikitext(extra.section_for_event(YEARS, name))[0]["a"]
    assert first("PFL World Tournament 5") == "Five A"      # not Tournament 1's card
    assert first("PFL World Tournament 1") == "One A"
    assert first("PFL 1") == "Uno A"                         # not PFL 10's
    assert first("PFL 10") == "Ten A"
    assert extra.section_for_event(YEARS, "PFL World Tournament 7") == ""


def test_switching_on_publish_is_due_immediately(monkeypatch):
    monkeypatch.delenv("EXTRA_FORCE", raising=False)
    recent = {"last_fetch": "2026-09-24T11:00:00Z", "publish": False}
    assert not extra.should_fetch(recent, {}, NOW, publish=False)[0]
    assert extra.should_fetch(recent, {}, NOW, publish=True) == (True, "publish mode changed")


def test_an_inaugural_title_is_a_title_fight_and_eliminators_are_not():
    wt = """
{{MMAevent bout
|Women's Flyweight
|Liz Carmouche
|vs.
|Jena Bishop
|For the inaugural PFL Women's Flyweight World Championship.
}}
{{MMAevent bout
|Featherweight
|Timur Khizriev
|vs.
|Gabriel Braga
|Winner earns a championship shot (title eliminator).
}}
{{MMAevent bout
|Welteweight
|Patrick Habirora
|vs.
|Omar El Dafrawy
}}
"""
    bouts = extra.card_from_wikitext(wt)
    by = {b["a"]: b for b in bouts}
    assert by["Liz Carmouche"]["title"] is True
    assert by["Timur Khizriev"]["title"] is False
    assert by["Patrick Habirora"]["title"] is False
    assert by["Patrick Habirora"]["division"] == "Welterweight"


# The real 2026-09-27 shape (checked against Wikipedia via the Diagnose
# workflow): the events list names two new cards as plain text, while the year
# page's events table links their articles, one with a disambiguating year.
# Both cards used to be dropped as "only 0 bout(s) parsed".
PLAIN_LIST = """
==Scheduled events==
{| class="sortable wikitable succession-box"
! Event !! Date !! Venue !! Location
|-
|PFL Africa 3
|{{dts|2026|October|10}}
|[[Salle Mohammed V|Mohammed V Sports Complex]]
|[[Casablanca]], Morocco
|-
|PFL MENA 11
|{{dts|2026|October|02}}
|[[Boulevard City]]
|[[Riyadh]], Saudi Arabia
|}
"""

YEAR_TABLE = """
==Events list==
{| class="wikitable"
|-
|19
|[[PFL MENA 11|PFL MENA 11: Last Man Standing]]
|{{dts|2026|Oct|2}}
|[[Boulevard City]]
|[[Riyadh]], Saudi Arabia
|
|-
|20
|[[PFL Africa 3 (2026)|PFL Africa 3: Morocco]]
|{{dts|2026|Oct|10}}
|[[Salle Mohammed V|Mohammed V Sports Complex]]
|[[Casablanca]], Morocco
|
|}
"""

MENA_11 = """==Fight card==
{{MMAevent}}
{{MMAevent card|Main card (YouTube / Vice TV)}}
{{MMAevent bout
|Light Heavyweight
|Mostafa Rashed Neda
|vs.
|Osama Elsaidy
|
|
|
|
}}
{{MMAevent bout
|Welterweight
|Badreddine Diani
|vs.
|Hazem Kayyali
|
|
|
|[[2026 in Professional Fighters League#2026 PFL MENA Welterweight Tournament|2026 PFL MENA Welterweight Tournament]] Semifinal.
}}
{{MMAevent end|notes=yes}}
"""

AFRICA_3 = MENA_11.replace("Mostafa Rashed Neda", "Abdoulaye Kane").replace("Osama Elsaidy", "Badr Medkouri") \
                  .replace("Badreddine Diani", "Karim Henniène").replace("Hazem Kayyali", "Raphael Uchegbu")


def test_an_unlinked_list_row_finds_its_article_through_the_year_page():
    fetch = fetcher({"List_of_Professional_Fighters_League_events": PLAIN_LIST,
                     "2026_in_Professional_Fighters_League": YEAR_TABLE,
                     "PFL_MENA_11": MENA_11, "PFL_Africa_3_(2026)": AFRICA_3})
    feed, report = extra.build(fetch, NOW)
    got = {e["name"]: e for e in feed["events"]}
    assert set(got) == {"PFL MENA 11", "PFL Africa 3"}
    assert got["PFL MENA 11"]["bouts"][0]["a"] == "Mostafa Rashed Neda"
    assert got["PFL Africa 3"]["bouts"][0]["a"] == "Abdoulaye Kane"
    assert all(r.get("source") == "article" for r in report if r["promotion"] == "pfl")
    assert fetch.calls.count("2026_in_Professional_Fighters_League") == 1   # one year-page fetch per year


def test_the_year_page_link_needs_the_same_numbers_and_a_close_date():
    link = extra.link_from_year_page
    assert link(YEAR_TABLE, "PFL MENA 11", "2026-10-02") == "PFL_MENA_11"
    # The year page and the list drift by a day or so (PFL Chicago: Oct 16 vs 17).
    assert link(YEAR_TABLE, "PFL Africa 3", "2026-10-11") == "PFL_Africa_3_(2026)"
    # "PFL Africa 3" was also a 2025 card; a name alone is not an identity.
    assert link(YEAR_TABLE, "PFL Africa 3", "2025-10-18") is None
    # A different number is a different card, however close the date.
    assert link(YEAR_TABLE, "PFL MENA 1", "2026-10-02") is None
    assert link(YEAR_TABLE, "PFL MENA 11", "not a date") is None


# ---------------------------------------------------------------- RIZIN --
# Trimmed from the real 2026 page (2026-09-28): the year page IS the events
# list (rows link to in-page anchors) and every card is a section of it, below
# a tournament section and a past card whose infobox carries its own date.
RIZIN_YEAR = """
== List of events ==
{| class="sortable wikitable succession-box"
|-
! # !! Event !! Date !! Venue !! Location !! Atten.
|-
| align=center| 7
| [[#Super Rizin 5|Super Rizin 5]]
| {{dts|2026|Sep|10}}
| [[Kyocera Dome Osaka]]
| [[Osaka]], Japan
| 48,968
|-
| align=center| 8
| [[#Rizin Landmark 16|Rizin Landmark 16]]
| {{dts|2026|Oct|3}}
| Happiness Arena
| [[Nagasaki]], Japan
|
|-
| align=center| 9
| [[#Rizin 55|Rizin 55]]
| {{dts|2026|Nov|8}}
| LaLa Arena Tokyo-Bay
| [[Funabashi]], Japan
|
|-
| align=center| 10
| Rizin: New Year's Eve Event
| {{dts|2026|Dec|31}}
| [[Vantelin Dome Nagoya]]
| [[Nagoya]], Japan
|
|-
|}

==Rizin Japan Heavyweight Grand Prix==
A Rizin tournament whose final was on {{dts|2026|10|1}}.

==Rizin Landmark 16==
{{Infobox MMA event
| name= Rizin Landmark 16 in Nagasaki
|date= {{dts|2026|10|03}}
}}
===Fight card===
{{MMAevent}}
{{MMAevent card|Main card (Rizin.tv)}}
{{MMAevent bout
|Lightweight
|Yoshinori Horie
|vs.
|Sho Patrick Usami
|
|
|
|
}}
{{MMAevent bout
|Women's Super Atomweight
|Kate Oyama
|vs.
|Noeru Narita
|
|
|
|
}}
{{MMAevent end|notes=yes}}

==Rizin 55==
===Fight card===
{{MMAevent bout
|Flyweight
|[[Makoto Takahashi (fighter)|Makoto Takahashi]] (c)
|vs.
|Tony Laramie
|
|
|
|For the [[Rizin Fighting Federation#Flyweight Championship|Rizin Flyweight Championship]].
}}
{{MMAevent bout
|Bantamweight
|Ryuya Fukuda
|vs.
|[[Soo Chul Kim|Kim Soo-chul]]
|
|
|
|
}}
{{MMAevent end|notes=yes}}

==See also==
"""

RIZIN = next(p for p in extra.PROMOTIONS if p["id"] == "rizin")
DWCS = next(p for p in extra.PROMOTIONS if p["id"] == "dwcs")


def test_rizin_cards_come_from_the_sections_of_its_year_page():
    feed, report = extra.build(fetcher({"2026_in_Rizin_Fighting_Federation": RIZIN_YEAR}), NOW)
    got = {e["name"]: e for e in feed["events"] if e["promotion"] == "rizin"}
    # Super Rizin 5 is past the window, New Year's Eve beyond it, and nothing
    # outside the events table (the tournament's date) is read as a card.
    assert set(got) == {"Rizin Landmark 16", "Rizin 55"}
    lm = got["Rizin Landmark 16"]
    assert lm["date"] == "2026-10-03" and lm["venue"] == "Happiness Arena"
    assert [(b["a"], b["b"]) for b in lm["bouts"]] == [("Yoshinori Horie", "Sho Patrick Usami"), ("Kate Oyama", "Noeru Narita")]
    assert lm["bouts"][1]["division"] == "Women's Super Atomweight"      # not the lighter atomweight
    r55 = got["Rizin 55"]["bouts"]
    assert r55[0]["a"] == "Makoto Takahashi" and r55[0]["title"] is True and r55[1]["b"] == "Kim Soo-chul"
    assert all(r["source"] == "year page" for r in report if r["promotion"] == "rizin")


def test_rizin_reads_next_years_page_once_the_window_reaches_it():
    late = datetime(2026, 12, 20, 12, 0, tzinfo=timezone.utc)
    nxt = RIZIN_YEAR.replace("2026", "2027")
    fetch = fetcher({"2026_in_Rizin_Fighting_Federation": RIZIN_YEAR, "2027_in_Rizin_Fighting_Federation": nxt})
    evs = extra.discover(RIZIN, "\n".join([RIZIN_YEAR, nxt]), late)
    assert [e["date"] for e in evs] == ["2026-12-31"]           # 2027's cards are Sep+ (outside 60 days)
    extra.build(fetch, late)
    assert "2027_in_Rizin_Fighting_Federation" in fetch.calls
    assert fetch.calls.count("2026_in_Rizin_Fighting_Federation") == 1   # list page = year page: one fetch


# ----------------------------------------------------------------- DWCS --
# Trimmed from the real main article and season 10 page (2026-09-28).
DWCS_MAIN = """
==List of seasons==
{| class="wikitable sortable"
|-
!scope="col" |Name
!scope="col" |Start date
!scope="col" |End date
|-
![[Dana White's Contender Series season 10|Season 10]] (87-96)
|<ref>{{Cite web|url=https://example.com/a|date=2026-07-15}}</ref>
|{{dts|2026|August|11}}
|{{dts|2026|October|13}}
|34
|-
![[Dana White's Contender Series season 9|Season 9]] (77-86)
|{{dts|2025|August|12}}
|{{dts|2025|October|14}}
|46
|-
|}

==List of contract winners==
"""

DWCS_S10 = """{{Infobox television season
| first_aired = {{Start date|2026|08|11}}
}}
== Week 7 – September 22 ==
{{Infobox MMA event
|name=Dana White's Contender Series 93
|date=September 22, 2026
|venue=[[UFC Apex|Meta Apex]]
|city=[[Las Vegas, Nevada]], United States
}}
===Results===
{{MMAevent bout
|Middleweight
|[[Norbert Növényi Jr.]]
|def.
|Theo Haig
|Decision (unanimous) (29–28, 29–28, 29–28)
|3
|5:00
|
}}
{{MMAevent bout
|Welterweight
|Alvi Dasuyev
|def.
|Jaden Ortega
|Decision (unanimous) (30–27, 30–27, 29–28)
|3
|5:00
|
}}
== Week 8 – September 29 ==
{{Infobox MMA event
|name=Dana White's Contender Series 94
|date=September 29, 2026
|venue=[[UFC Apex|Meta Apex]]
|city=[[Las Vegas, Nevada]], United States
}}
===Background===
Announced on August 11, 2026.<ref>{{Cite web|title=Week 8 set|date=August 11, 2026}}</ref>
{{MMAevent bout
|Lightweight
|George Staines
|vs.
|Loai Abushaar
|
|
|
|
}}
{{MMAevent bout
|Featherweight
|[[Ilias Bulaid]]
|vs.
|Erick Visconde
|
|
|
|
}}
{{MMAevent bout
|Flyweight
|Jarrett Betancourt
|vs.
|TBA
|
|
|
|
}}
{{MMAevent end|notes=yes}}
== Week 10 – October 13 ==
{{MMAevent bout
|Middleweight
|Douglas da Lapa
|vs.
|Davi Cabral
|
|
|
|
}}
{{MMAevent bout
|Women's Bantamweight
|[[Aline Pereira]]
|vs.
|[[Smilla Sundell]]
|
|
|
|
}}
== References ==
"""

DWCS_PAGES = {"Dana_White's_Contender_Series": DWCS_MAIN, "Dana_White's_Contender_Series_season_10": DWCS_S10}


def test_dwcs_finds_the_running_season_and_one_card_per_week():
    assert [s["slug"] for s in extra.current_seasons(DWCS_MAIN, NOW)] == ["Dana_White's_Contender_Series_season_10"]
    feed, report = extra.build(fetcher(DWCS_PAGES), NOW)
    got = [e for e in feed["events"] if e["promotion"] == "dwcs"]
    # Week 7 (Sep 22) is past the two-day window; week 8 and week 10 are in.
    assert [(e["date"], e["name"]) for e in got] == [
        ("2026-09-29", "Dana White's Contender Series 94"),
        # No infobox yet: dated from the heading and the season's year.
        ("2026-10-13", "Dana White's Contender Series, Week 10")]
    w8 = got[0]
    # The infobox date, not the reference's "August 11, 2026" further down.
    assert w8["venue"] == "Meta Apex" and w8["location"] == "Las Vegas, Nevada, United States"
    # An opponent still "TBA" is not a bout.
    assert [(b["a"], b["b"]) for b in w8["bouts"]] == [("George Staines", "Loai Abushaar"), ("Ilias Bulaid", "Erick Visconde")]
    assert all(r["source"] == "season page" for r in report if r["promotion"] == "dwcs")


def test_dwcs_results_attach_and_a_past_season_is_ignored():
    late = datetime(2026, 9, 23, 12, 0, tzinfo=timezone.utc)
    feed, _ = extra.build(fetcher(DWCS_PAGES), late)
    w7 = next(e for e in feed["events"] if e["name"] == "Dana White's Contender Series 93")
    assert w7["bouts"][0]["winner"] == "Norbert Novenyi Jr." and w7["bouts"][0]["round"] == 3
    off = datetime(2027, 3, 1, tzinfo=timezone.utc)
    assert extra.current_seasons(DWCS_MAIN, off) == []


def test_dwcs_keeps_its_cards_when_the_season_page_fails():
    prev, _ = extra.build(fetcher(DWCS_PAGES), NOW)
    feed, report = extra.build(fetcher({"Dana_White's_Contender_Series": DWCS_MAIN}), NOW, prev)
    was = [e for e in prev["events"] if e["promotion"] == "dwcs"]
    now_ = [e for e in feed["events"] if e["promotion"] == "dwcs"]
    assert was and now_ == was
    assert any("season page unavailable" in (r.get("problem") or "") for r in report)


# ------------------------------------------------------ per-promotion publish --
def test_only_published_promotions_reach_the_live_file(tmp_path, monkeypatch):
    live, cand, state = tmp_path / "events-extra.json", tmp_path / "cand.json", tmp_path / "state.json"
    monkeypatch.setattr(extra, "LIVE_JSON", live)
    monkeypatch.setattr(extra, "CANDIDATE_JSON", cand)
    monkeypatch.setattr(extra, "STATE_JSON", state)
    pages = dict(DWCS_PAGES, **{extra.PROMOTIONS[0]["list_page"]: LIST, "PFL_Chicago": CHICAGO,
                                "2026_in_Rizin_Fighting_Federation": RIZIN_YEAR})
    monkeypatch.setattr(extra.scrape, "fetch_wikitext", fetcher(pages))
    monkeypatch.setattr(extra, "PROMOTIONS", [dict(p, publish=(p["id"] == "pfl")) for p in extra.PROMOTIONS])
    monkeypatch.setenv("EXTRA_PUBLISH", "1")
    monkeypatch.setenv("EXTRA_FORCE", "1")
    assert extra.main(NOW) == 0
    lv, cd = json.loads(live.read_text()), json.loads(cand.read_text())
    # The switcher never offers a sport that isn't published, not even empty.
    assert [p["id"] for p in lv["promotions"]] == ["pfl"]
    assert {e["promotion"] for e in lv["events"]} == {"pfl"}
    # The candidate carries everything, so a shadowed promotion can be checked.
    assert {e["promotion"] for e in cd["events"]} == {"pfl", "rizin", "dwcs"}
    # Flipping one flag publishes it, and only it.
    monkeypatch.setattr(extra, "PROMOTIONS", [dict(p, publish=(p["id"] in ("pfl", "rizin"))) for p in extra.PROMOTIONS])
    assert extra.main(NOW) == 0
    lv = json.loads(live.read_text())
    assert {e["promotion"] for e in lv["events"]} == {"pfl", "rizin"}
    assert [p["id"] for p in lv["promotions"]] == ["pfl", "rizin"]


def test_every_promotion_says_whether_it_is_published():
    # A new promotion is added with publish=False and flipped only after a real
    # candidate card has been checked against the actual card (CLAUDE.md,
    # "Non-UFC cards"). A missing flag reads as unpublished, never as published.
    assert all(isinstance(p.get("publish"), bool) for p in extra.PROMOTIONS)
    assert extra.published_ids() == {p["id"] for p in extra.PROMOTIONS if p["publish"] is True}
    assert {p["id"]: p["publish"] for p in extra.PROMOTIONS} == {"pfl": True, "rizin": True, "dwcs": True}
