"""
official_times.py (UFC.com card clocks, shadow mode) and the health.py checks
that read its output.

The page fixture mirrors UFC.com's event-page markup (segment sections with an
in-page id, a data-timestamp per broadcaster row, corner names per bout) and
carries UFC 332's real clocks: early prelims 16:00, prelims 18:00, main card
20:00 ET, the card the slot table shipped an hour late. The clock is pinned
(NOW), never read from the wall.

Run with:  python -m pytest -q
"""
from datetime import datetime, timezone

import health
import official_times as ot
from tests.test_health import data_js, fight, kinds

NOW = datetime(2026, 10, 2, 3, 0, tzinfo=timezone.utc)
CARD = {"name": "UFC 332: Silva vs. Wang", "date": "2026-10-03"}


def ts(iso):
    return int(datetime.fromisoformat(iso).timestamp())


def corner(given, family):
    return ('<div class="c-listing-fight__corner-name c-listing-fight__corner-name--red">'
            f'<a href="#"><span class="c-listing-fight__corner-given-name">{given}</span> '
            f'<span class="c-listing-fight__corner-family-name">{family}</span></a></div>')


def section(cls, sid, label, stamp, bouts):
    rows = "".join('<div class="c-listing-fight">' + corner(*a) + corner(*b) + "</div>"
                   for a, b in bouts)
    return (f'<div class="{cls}" id="{sid}">'
            '<div class="c-event-fight-card-broadcaster__container">'
            f'<div class="c-event-fight-card-broadcaster__mobile-wrapper"><strong>{label}</strong></div>'
            '<div class="c-event-fight-card-broadcaster__time tz-change-inner" '
            f'data-locale="en-usa" data-timestamp="{stamp}" '
            'data-format="D, M j / g:i A T">Sat, Oct 3 / 8:00 PM EDT</div></div>'
            f'<div class="l-listing__group">{rows}</div></div>')


MAIN = [(("Natalia", "Silva"), ("Cong", "Wang")),
        (("Deiveson", "Figueiredo"), ("Payton", "Talbott"))]
PRELIM = [(("Marcus", "McGhee"), ("Anthony", "Romero")),
          (("Anthony", "Wint"), ("Lucas", "Armand"))]
EARLY = [(("Johnny", "Walker"), ("Mick", "Parkin"))]


def page(main="2026-10-04T00:00:00+00:00", prelim="2026-10-03T22:00:00+00:00",
         early="2026-10-03T20:00:00+00:00", prelim_bouts=PRELIM, title="Silva vs Wang"):
    return ("<html><head><title>UFC 332: %s | UFC</title></head><body>" % title
            # The hero carries a timestamp of its own, outside any section.
            + '<div class="c-hero__headline-suffix tz-change-inner" '
              'data-timestamp="%d"></div>' % ts("2026-10-03T20:00:00+00:00")
            + '<nav><a href="#main-card">Main Card</a><a href="#prelims-card">Prelims</a></nav>'
            + section("main-card", "main-card", "Main Card", ts(main), MAIN)
            + section("fight-card-prelims", "prelims-card", "Prelims", ts(prelim), prelim_bouts)
            + section("fight-card-prelims-early", "early-prelims", "Early Prelims",
                      ts(early), EARLY)
            + "</body></html>")


# --- parsing ----------------------------------------------------------------

def test_reads_each_segment_clock_in_et():
    got = ot.parse_event_page(page())
    assert {s: v["et"] for s, v in got["segments"].items()} == {
        "main": "20:00", "prelim": "18:00", "early": "16:00"}
    # 00:00 UTC Sunday is still Saturday night in ET.
    assert got["segments"]["main"]["date"] == "2026-10-03"


def test_reads_which_bouts_sit_in_which_segment():
    got = ot.parse_event_page(page())
    assert got["bouts"]["main"][0] == ["Natalia Silva", "Cong Wang"]
    assert got["bouts"]["prelim"] == [["Marcus McGhee", "Anthony Romero"],
                                      ["Anthony Wint", "Lucas Armand"]]
    assert got["bouts"]["early"] == [["Johnny Walker", "Mick Parkin"]]


def test_et_follows_the_cards_own_date_across_dst():
    # A November card is EST (UTC-5): 01:00 UTC is 20:00 ET, not 21:00.
    got = ot.parse_event_page(page(main="2026-11-15T01:00:00+00:00"))
    assert got["segments"]["main"]["et"] == "20:00"


def test_heading_text_is_the_fallback_when_the_ids_go():
    html = page().replace('id="', 'data-x="').replace('class="main-card"', 'class="a"') \
                 .replace('class="fight-card-prelims-early"', 'class="b"') \
                 .replace('class="fight-card-prelims"', 'class="c"')
    got = ot.parse_event_page(html.replace("<nav>", "<x>").replace("</nav>", "</x>")
                              .replace('>Main Card</a>', '>MC</a>')
                              .replace('>Prelims</a>', '>P</a>'))
    assert got["segments"]["main"]["et"] == "20:00"
    assert got["segments"]["early"]["et"] == "16:00"


def test_a_page_without_segments_reads_as_nothing():
    assert ot.parse_event_page("<html>maintenance</html>") == {"segments": {}, "bouts": {}}


def test_only_the_cards_own_page_is_accepted():
    good = page()
    assert ot.page_is_card(good, ot.parse_event_page(good), CARD)
    other = page(title="Jones vs Miocic").replace("Silva", "Jones").replace("Wang", "Miocic")
    assert not ot.page_is_card(other, ot.parse_event_page(other), CARD)
    moved = page(main="2026-10-11T00:00:00+00:00")
    assert not ot.page_is_card(moved, ot.parse_event_page(moved), CARD)


def test_paths_cover_numbered_fight_night_and_sponsored_slugs():
    assert ot.candidate_paths(CARD)[0] == "/event/ufc-332"
    fn = {"name": "UFC Fight Night: Buckley vs. Malott", "date": "2026-10-17"}
    assert ot.candidate_paths(fn) == ["/event/ufc-fight-night-october-17-2026"]
    listing = ('<a href="/event/cryptocom-ufc-331">x</a><a href="/event/ufc-3310">y</a>'
               '<a href="/event/noche-ufc-september-12-2026">z</a>')
    assert ot.listing_paths(listing, {"name": "UFC 331: Van vs. Pantoja 2",
                                      "date": "2026-09-19"}) == ["/event/cryptocom-ufc-331"]
    assert ot.listing_paths(listing, {"name": "UFC Fight Night: Silva vs. Delgado",
                                      "date": "2026-09-12"}) == [
        "/event/noche-ufc-september-12-2026"]


# --- network, stubbed ---------------------------------------------------------

def fake_get(pages):
    calls = []

    def get(url):
        calls.append(url)
        body = pages.get(url)
        return (200, body) if body is not None else (404, "")
    get.calls = calls
    return get


def test_direct_slug_hit():
    get = fake_get({ot.BASE + "/event/ufc-332": page()})
    reading, _ = ot.read_card(CARD, get=get)
    assert reading["segments"]["main"]["et"] == "20:00"
    assert ot.EVENTS_LIST not in get.calls


def test_falls_back_to_the_events_listing():
    get = fake_get({ot.EVENTS_LIST: '<a href="/event/cryptocom-ufc-332">',
                    ot.BASE + "/event/cryptocom-ufc-332": page()})
    reading, _ = ot.read_card(CARD, get=get)
    assert reading["url"].endswith("/event/cryptocom-ufc-332")


def test_transport_errors_never_raise():
    def boom(url):
        raise ConnectionError("dns")
    import requests
    orig = requests.get
    requests.get = boom
    try:
        reading, _ = ot.read_card(CARD)
    finally:
        requests.get = orig
    assert reading["status"] == 0 and "error" in reading


def events():
    return [dict(CARD), {"name": "UFC 999: Far vs. Away", "date": "2027-03-01"}]


def test_update_records_a_reading_and_skips_far_cards():
    get = fake_get({ot.BASE + "/event/ufc-332": page()})
    state, changed, read = ot.update(events(), {}, NOW, get=get)
    assert changed and read == 1
    c = state["cards"]["UFC 332: Silva vs. Wang|2026-10-03"]
    assert c["segments"]["prelim"]["et"] == "18:00" and c["confirmed_at"]
    assert "UFC 999: Far vs. Away|2027-03-01" not in state["cards"]


def test_a_failed_read_keeps_the_last_good_reading():
    good, _, _ = ot.update(events(), {}, NOW, get=fake_get(
        {ot.BASE + "/event/ufc-332": page()}))
    later = NOW.replace(hour=5)
    state, _, read = ot.update(events(), good, later, get=fake_get({}))
    c = state["cards"]["UFC 332: Silva vs. Wang|2026-10-03"]
    assert read == 1
    assert c["segments"]["main"]["et"] == "20:00"       # kept
    assert c["error"] and c["confirmed_at"] == good["cards"][
        "UFC 332: Silva vs. Wang|2026-10-03"]["confirmed_at"]


def test_cadence_gate():
    good, _, _ = ot.update(events(), {}, NOW, get=fake_get(
        {ot.BASE + "/event/ufc-332": page()}))
    get = fake_get({})
    soon = NOW.replace(minute=30)
    state, changed, read = ot.update(events(), good, soon, get=get)
    assert read == 0 and not changed and get.calls == []
    _, _, read = ot.update(events(), good, soon, get=get, force=True)
    assert read == 1


# --- health.py --------------------------------------------------------------

def card_js(time="21:00", prelim="19:00", early="17:00", wint_lbl="Prelim"):
    text = data_js([(CARD["name"], CARD["date"], [
        fight("Natalia Silva", "Wang Cong", lbl="Main Event"),
        fight("Marcus McGhee", "Anthony Romero", lbl="Prelim"),
        fight("Anthony Wint", "Lucas Armand", lbl=wint_lbl),
        fight("Johnny Walker", "Mick Parkin", lbl="Early Prelim"),
    ])], loc="Salt Lake City", time=time, prelim=prelim)
    return text.replace('prelimTime:"%s",' % prelim,
                        'prelimTime:"%s",\n    earlyPrelimTime:"%s",' % (prelim, early))


def official():
    state, _, _ = ot.update([dict(CARD)], {}, NOW, get=fake_get(
        {ot.BASE + "/event/ufc-332": page()}))
    return state


def test_the_ufc_332_miss_is_reported_and_says_which_way():
    findings, summary = health.check(card_js(), now=NOW, official=official())
    msgs = [f["message"] for f in findings if f["check"] == "time-mismatch"]
    assert len(msgs) == 3
    assert any("main card is 21:00 ET here, UFC.com says 20:00 ET "
               "(picks lock 60 min AFTER the bell)" in m for m in msgs)
    assert summary["block"] == 0                      # never blocks a publish


def test_matching_clocks_are_quiet():
    findings, _ = health.check(card_js("20:00", "18:00", "16:00"), now=NOW,
                               official=official())
    assert not kinds(findings) & {"time-mismatch", "segment-mismatch",
                                  "time-unconfirmed", "time-stale"}


def test_a_bout_in_the_wrong_segment_is_reported():
    findings, _ = health.check(card_js("20:00", "18:00", "16:00", wint_lbl="Early Prelim"),
                               now=NOW, official=official())
    seg = [f for f in findings if f["check"] == "segment-mismatch"]
    assert len(seg) == 1 and "Anthony Wint" in seg[0]["message"]
    assert seg[0]["severity"] == "WARN"


def test_an_imminent_card_with_no_reading_is_unconfirmed():
    findings, summary = health.check(card_js(), now=NOW,
                                     official={"cards": {}})
    assert "time-unconfirmed" in kinds(findings, "WARN")
    assert summary["block"] == 0


def test_no_file_means_not_checking_yet():
    findings, _ = health.check(card_js(), now=NOW, official=None)
    assert not kinds(findings) & {"time-mismatch", "time-unconfirmed"}


def test_a_stale_reading_on_fight_eve_is_flagged():
    stale = official()
    later = datetime(2026, 10, 3, 12, 0, tzinfo=timezone.utc)
    findings, _ = health.check(card_js("20:00", "18:00", "16:00"), now=later,
                               official=stale)
    assert "time-stale" in kinds(findings, "WARN")


def test_the_same_clock_a_day_apart_is_a_mismatch():
    # A Sunday-local card airing Saturday ET: page_is_card allows the day, but
    # the app pins every clock to the card's own date, so 20:00 on the wrong
    # day locks picks 24 hours off.
    shifted = official()
    for seg in shifted["cards"]["UFC 332: Silva vs. Wang|2026-10-03"]["segments"].values():
        seg["date"] = "2026-10-04"
    findings, _ = health.check(card_js("20:00", "18:00", "16:00"), now=NOW,
                               official=shifted)
    msgs = [f["message"] for f in findings if f["check"] == "time-mismatch"]
    assert len(msgs) == 3
    assert any("picks lock 1440 min early" in m for m in msgs)


def test_a_partial_reading_leaves_the_missing_segment_unconfirmed():
    partial = official()
    del partial["cards"]["UFC 332: Silva vs. Wang|2026-10-03"]["segments"]["early"]
    findings, summary = health.check(card_js("20:00", "18:00", "16:00"), now=NOW,
                                     official=partial)
    unc = [f for f in findings if f["check"] == "time-unconfirmed"]
    assert [f["segment"] for f in unc] == ["early"]
    assert summary["block"] == 0
