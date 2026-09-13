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


def test_fingerprint_moves_when_a_fighter_is_replaced():
    # The Codex P1 / Jessie Rosas case: a late replacement inside the cadence
    # window used to leave intel.json describing a fighter who had withdrawn.
    evs = intel.parse_events(DATA)
    swapped = intel.parse_events(DATA.replace('n:"Gregory Rodrigues"', 'n:"Bo Nickal"'))
    assert intel.card_fingerprint(evs, NOW) != intel.card_fingerprint(swapped, NOW)


def test_fingerprint_moves_when_the_card_date_moves():
    evs = intel.parse_events(DATA)
    moved = intel.parse_events(DATA.replace('date:"2026-09-19"', 'date:"2026-09-20"'))
    assert intel.card_fingerprint(evs, NOW) != intel.card_fingerprint(moved, NOW)


def test_fingerprint_is_stable_when_nothing_relevant_changed():
    evs = intel.parse_events(DATA)
    assert intel.card_fingerprint(evs, NOW) == intel.card_fingerprint(evs, NOW)
    # A rename that nmKey folds away is the same roster, not a new card — this is
    # what stops a ufcstats spelling change from forcing a needless re-pull.
    renamed = intel.parse_events(DATA.replace('n:"Sean King III"', 'n:"Sean King"'))
    assert intel.card_fingerprint(evs, NOW) == intel.card_fingerprint(renamed, NOW)


def test_fingerprint_ignores_cards_outside_the_window():
    evs = intel.parse_events(DATA)
    far = intel.parse_events(DATA.replace('n:"Islam Makhachev"', 'n:"Justin Gaethje"'))
    assert intel.card_fingerprint(evs, NOW) == intel.card_fingerprint(far, NOW)


def test_a_changed_card_beats_the_cadence_interval():
    evs = intel.parse_events(DATA)
    # Pulled a minute ago — normally nowhere near due.
    state = {"last_fetch": (NOW - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "fingerprint": "stale000stale000"}
    go, why = intel.should_fetch(evs, state, NOW)
    assert go is True and "card changed" in why


def test_an_unchanged_card_still_respects_the_interval():
    evs = intel.parse_events(DATA)
    state = {"last_fetch": (NOW - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "fingerprint": intel.card_fingerprint(evs, NOW)}
    assert intel.should_fetch(evs, state, NOW)[0] is False


def test_a_state_file_with_no_fingerprint_does_not_force_a_pull():
    # Upgrading from the pre-fingerprint state file must not re-pull on every run.
    evs = intel.parse_events(DATA)
    state = {"last_fetch": (NOW - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")}
    assert intel.should_fetch(evs, state, NOW)[0] is False


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


def test_main_persists_the_fingerprint_for_the_next_run(one_feed, monkeypatch, tmp_path):
    monkeypatch.setenv("INTEL_FORCE", "1")
    monkeypatch.setattr(intel, "OUT_JSON", tmp_path / "intel.json")
    monkeypatch.setattr(intel, "STATE_JSON", tmp_path / "intel-state.json")
    monkeypatch.setattr(intel, "DATA_JS", tmp_path / "data.js")
    (tmp_path / "data.js").write_text(DATA, encoding="utf-8")
    assert intel.main() == 0
    state = json.loads((tmp_path / "intel-state.json").read_text())
    assert state["fingerprint"] == intel.card_fingerprint(
        intel.parse_events(DATA), intel.datetime.now(timezone.utc))


# --- the live fight window ------------------------------------------------
#
# `today` is UTC and US prime-time cards run past UTC midnight, so a bound of
# days_out >= 0 drops a Saturday card an hour BEFORE its main card. update.yml
# keeps pushing live results until 04:59 UTC the next day; the intel set has to
# survive at least that long, and the app keeps the event block on screen for two
# days, so the curator matches that.

SAT_CARD = DATA.replace('date:"2026-09-19"', 'date:"2026-09-19"')  # a Saturday


def _utc(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


@pytest.mark.parametrize("label,iso", [
    ("prelims start, Sat 17:00 ET",   "2026-09-19T21:00:00Z"),
    ("Sat 20:00 ET, UTC rolls over",  "2026-09-20T00:00:00Z"),
    ("MAIN CARD, Sat 21:00 ET",       "2026-09-20T01:00:00Z"),
    ("main event, Sat 23:30 ET",      "2026-09-20T03:30:00Z"),
    ("last live-results run, 04:59Z", "2026-09-20T04:59:00Z"),
])
def test_the_card_survives_its_own_live_window(one_feed, label, iso):
    out = intel.curate(intel.parse_events(SAT_CARD), now=_utc(iso))
    assert "UFC_331" in out["events"], "card dropped during %s" % label


def test_the_card_does_eventually_age_out(one_feed):
    out = intel.curate(intel.parse_events(SAT_CARD), now=_utc("2026-09-22T12:00:00Z"))
    assert "UFC_331" not in out["events"]


def test_a_live_card_does_not_read_as_no_card_at_all():
    # should_fetch must use the same lower bound, or mid-event it reports
    # "no card within 10d" and stops refreshing exactly when the card is on.
    evs = intel.parse_events(SAT_CARD)
    go, why = intel.should_fetch(evs, {}, _utc("2026-09-20T01:00:00Z"))
    assert go is True and "no card within" not in why


def test_the_fingerprint_still_covers_a_live_card():
    evs = intel.parse_events(SAT_CARD)
    swapped = intel.parse_events(SAT_CARD.replace('n:"Gregory Rodrigues"', 'n:"Bo Nickal"'))
    live = _utc("2026-09-20T01:00:00Z")
    # An empty fingerprint here would make every live card look identical, so a
    # late swap during the prelims would never trigger a refresh.
    assert intel.card_fingerprint(evs, live) != intel.card_fingerprint(swapped, live)
