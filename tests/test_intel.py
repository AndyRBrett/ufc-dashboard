"""Fight Week Intel curator — the matching and budget rules that keep it honest.

Two things can go wrong with a free, string-matched curator, and both are here:

  * mis-attribution — surfacing an item about a different fighter under this
    card (the app re-validates too, see tests/check-intel.mjs, but the curator
    should not be emitting it in the first place);
  * cost creep — this whole feature exists on the premise that it spends no
    metered budget, so the cadence gate is load-bearing, not a nicety.
"""
import json
from datetime import datetime, timedelta, timezone

import pytest

import intel

NOW = datetime(2026, 9, 13, 12, 0, tzinfo=timezone.utc)

DATA = '''
var EVENTS=[
  {
    name:"UFC 331: Hernandez vs. Rodrigues",
    date:"2026-09-19",
    slug:"UFC_331",
    fights:[
      {lbl:"Main Event",wc:"Middleweight",title:false,rematch:false,odds:null,winner:"",f1:{n:"Anthony Hernandez",r:"15-4-0",rk:"",s:null},f2:{n:"Gregory Rodrigues",r:"20-6-0",rk:"",s:null}},
      {lbl:"Prelim",wc:"Featherweight",title:false,rematch:false,odds:null,winner:"",f1:{n:"Sean King III",r:"8-0-0",rk:"",s:null},f2:{n:"TBD",r:"",rk:"",s:null}}
    ]
  },
  {
    name:"UFC Fight Night: Later",
    date:"2026-12-05",
    slug:"UFC_Later",
    fights:[
      {lbl:"Main Event",wc:"Lightweight",title:false,rematch:false,odds:null,winner:"",f1:{n:"Islam Makhachev",r:"29-1-0",rk:"",s:null},f2:{n:"Bruno Silva",r:"10-1-0",rk:"",s:null}}
    ]
  }
];
'''


def test_parse_events_reads_slug_fighters_and_weights():
    evs = intel.parse_events(DATA)
    assert [e["slug"] for e in evs] == ["UFC_331", "UFC_Later"]
    names = [f["name"] for f in evs[0]["fighters"]]
    # TBD is not a person and must never be matched against.
    assert names == ["Anthony Hernandez", "Gregory Rodrigues", "Sean King III"]
    weights = {f["name"]: f["weight"] for f in evs[0]["fighters"]}
    assert weights["Anthony Hernandez"] > weights["Sean King III"]


def test_nm_key_matches_the_apps_normalisation():
    # Must agree with nmKey() in index.html, or the app drops what the curator
    # emits and the section silently empties.
    assert intel.nm_key("Sean King III") == intel.nm_key("Sean King")
    assert intel.nm_key("Jessié  Rosas") == "jessie rosas"
    assert intel.nm_key("O'Malley") == "o malley"
    assert intel.nm_key("Sean King") != intel.nm_key("Sean Strickland")


def _match(text, event, events=None):
    events = events or intel.parse_events(DATA)
    return intel.match_fighters(
        intel.nm_key(text), event["fighters"], intel.build_matchers(events)
    )


def test_full_name_in_a_headline_is_a_strong_match():
    evs = intel.parse_events(DATA)
    hits = _match("Anthony Hernandez opens up on his camp", evs[0])
    assert [(n, strong) for n, _, strong in hits] == [("Anthony Hernandez", True)]


def test_a_common_surname_alone_is_never_a_strong_match():
    # "Silva" is the canonical mis-attribution: it identifies nobody on its own.
    evs = intel.parse_events(DATA)
    hits = _match("Silva says he is ready for anyone", evs[1])
    assert not any(strong for _, _, strong in hits)


def test_a_surname_shared_by_two_fighters_is_not_unique():
    data = DATA.replace('n:"Bruno Silva"', 'n:"Bruno Hernandez"')
    evs = intel.parse_events(data)
    # "hernandez" now belongs to two different people, so it identifies neither.
    assert "hernandez" not in intel.build_matchers(evs)


def test_a_distinctive_surname_matches_weakly_but_not_strongly():
    evs = intel.parse_events(DATA)
    hits = _match("Rodrigues talks title shot", evs[0])
    assert hits and all(not strong for _, _, strong in hits)
    # Weak hits are scored down so they can't outrank a full-name match.
    assert hits[0][1] < next(f["weight"] for f in evs[0]["fighters"]
                             if f["name"] == "Gregory Rodrigues")


def test_blurb_is_capped_and_stripped_of_markup():
    long = "<p>" + ("word " * 200) + "</p>"
    b = intel.blurb_of(long)
    assert "<" not in b
    assert len(b) <= intel.BLURB_MAX + 1     # +1 for the ellipsis
    assert b.endswith("…")


def test_blurb_unescapes_entities_without_reintroducing_tags():
    assert intel.blurb_of("Jones &amp; Silva &lt;b&gt;") == "Jones & Silva <b>"


# --- the cost premise ------------------------------------------------------

def test_no_fetch_when_the_nearest_card_is_outside_the_window():
    evs = intel.parse_events(DATA)
    go, why = intel.should_fetch(evs, {}, datetime(2026, 6, 1, tzinfo=timezone.utc))
    assert go is False and "no card within" in why


def test_no_fetch_inside_the_cadence_interval():
    evs = intel.parse_events(DATA)
    state = {"last_fetch": (NOW - timedelta(minutes=20)).strftime("%Y-%m-%dT%H:%M:%SZ")}
    go, _ = intel.should_fetch(evs, state, NOW)
    assert go is False


def test_fight_week_tightens_the_interval_but_still_gates():
    evs = intel.parse_events(DATA)
    near = datetime(2026, 9, 18, 12, 0, tzinfo=timezone.utc)   # card is tomorrow
    recent = {"last_fetch": (near - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")}
    older = {"last_fetch": (near - timedelta(hours=4)).strftime("%Y-%m-%dT%H:%M:%SZ")}
    assert intel.should_fetch(evs, recent, near)[0] is False
    assert intel.should_fetch(evs, older, near)[0] is True


def test_force_overrides_the_gate(monkeypatch):
    monkeypatch.setenv("INTEL_FORCE", "1")
    evs = intel.parse_events(DATA)
    assert intel.should_fetch(evs, {}, datetime(2026, 6, 1, tzinfo=timezone.utc))[0]


# --- end to end, with the network stubbed ----------------------------------

RSS = """<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>Anthony Hernandez breaks down his gameplan</title>
 <link>https://mmajunkie.test/hernandez</link>
 <description>&lt;p&gt;The middleweight talks camp.&lt;/p&gt;</description>
 <pubDate>Fri, 12 Sep 2026 10:00:00 +0000</pubDate></item>
<item><title>Islam Makhachev eyes a return</title>
 <link>https://mmajunkie.test/makhachev</link><description>x</description>
 <pubDate>Fri, 12 Sep 2026 10:00:00 +0000</pubDate></item>
<item><title>Relative link should be skipped</title>
 <link>/nope</link><description>Anthony Hernandez</description>
 <pubDate>Fri, 12 Sep 2026 10:00:00 +0000</pubDate></item>
</channel></rss>"""


class _Resp:
    status_code = 200
    content = RSS.encode()


@pytest.fixture
def one_feed(monkeypatch):
    monkeypatch.setenv("INTEL_FEEDS", json.dumps(
        [{"id": "t", "name": "Test", "kind": "article", "url": "https://feed.test/rss"}]))
    monkeypatch.setattr(intel.requests, "get", lambda *a, **k: _Resp())


def test_curate_puts_an_item_only_under_the_card_it_is_about(one_feed):
    out = intel.curate(intel.parse_events(DATA), now=NOW)
    assert list(out["events"]) == ["UFC_331"]          # the Dec card is out of window
    items = out["events"]["UFC_331"]["items"]
    assert [i["url"] for i in items] == ["https://mmajunkie.test/hernandez"]
    assert items[0]["fighters"] == ["Anthony Hernandez"]
    assert out["events"]["UFC_331"]["date"] == "2026-09-19"


def test_curate_records_every_feeds_status_so_a_dead_feed_is_not_silent(one_feed):
    out = intel.curate(intel.parse_events(DATA), now=NOW)
    assert out["sources"] == [{"id": "t", "name": "Test", "status": 200, "items": 2}]


def test_a_failing_feed_is_reported_rather_than_raising(monkeypatch):
    monkeypatch.setenv("INTEL_FEEDS", json.dumps(
        [{"id": "dead", "name": "Dead", "kind": "article", "url": "https://dead.test/rss"}]))

    def boom(*a, **k):
        raise intel.requests.ConnectionError("nope")
    monkeypatch.setattr(intel.requests, "get", boom)
    out = intel.curate(intel.parse_events(DATA), now=NOW)
    assert out["sources"][0]["status"].startswith("error:")
    assert out["events"]["UFC_331"]["items"] == []


def test_stale_items_are_dropped(one_feed):
    late = NOW + timedelta(days=intel.MAX_ITEM_AGE_DAYS + 2)
    # Far enough out that the card is gone from the window too, so assert on the
    # item filter directly via a card that is still near.
    out = intel.curate(intel.parse_events(
        DATA.replace('date:"2026-09-19"', late.strftime('date:"%Y-%m-%d"'))), now=late)
    key = list(out["events"])[0]
    assert out["events"][key]["items"] == []
