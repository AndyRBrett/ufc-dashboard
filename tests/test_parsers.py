"""
Unit tests for the pure parsing/normalisation helpers in scrape.py.

These are the brittle, format-sensitive functions that silently break when
Wikipedia / the Odds API change shape. They make no network calls, so they run
fast in CI and act as a safety net before the scraper can overwrite data.js.

Run with:  python -m pytest -q
"""
import hashlib

import scrape


# --- name helpers ----------------------------------------------------------

def test_last_name_strips_accents_and_parentheticals():
    assert scrape.last_name("Israel Adesanya") == "adesanya"
    assert scrape.last_name("Khabib Nurmagomedov (c)") == "nurmagomedov"
    assert scrape.last_name("José Aldo") == "aldo"


def test_names_match_by_last_name_and_substring():
    assert scrape.names_match("Max Holloway", "Holloway")
    assert scrape.names_match("Conor McGregor", "conor mcgregor")
    assert not scrape.names_match("Jon Jones", "Stipe Miocic")


def test_clean_wiki_strips_markup():
    assert scrape.clean_wiki("[[Jon Jones|Jon Jones]]") == "Jon Jones"
    assert scrape.clean_wiki("Stipe Miocic{{flagicon|USA}}") == "Stipe Miocic"
    assert scrape.clean_wiki("Champion[1]") == "Champion"


# --- method normalisation --------------------------------------------------

def test_norm_method_canonical_forms():
    assert scrape.norm_method("KO") == "KO/TKO"
    assert scrape.norm_method("TKO (punches)") == "KO/TKO"
    assert scrape.norm_method("Submission (rear-naked choke)") == "Submission"
    assert scrape.norm_method("Decision (unanimous)") == "Decision (Unanimous)"
    assert scrape.norm_method("Decision (split)") == "Decision (Split)"
    assert scrape.norm_method("Decision") == "Decision"


# --- date parsing ----------------------------------------------------------

def test_parse_date_wiki_numeric_dts():
    assert scrape.parse_date_wiki("{{dts|2026|8|15}}") == "2026-08-15"


def test_parse_date_wiki_abbreviated_month():
    assert scrape.parse_date_wiki("{{dts|2026|Aug|15}}") == "2026-08-15"


def test_parse_date_wiki_start_date_template():
    assert scrape.parse_date_wiki("{{Start date|2025|11|9}}") == "2025-11-09"


def test_parse_date_wiki_plain_english():
    assert scrape.parse_date_wiki("held on August 15, 2026 at...") == "2026-08-15"


def test_parse_date_wiki_no_date_returns_empty():
    assert scrape.parse_date_wiki("no date here") == ""


# --- wikitable result rows -------------------------------------------------

def test_flush_row_explicit_method():
    row = ["Lightweight", "Max Holloway", "def.", "Justin Gaethje", "KO", "3"]
    res = scrape._flush_wikitable_row(row)
    assert res == {
        "winner": "Max Holloway",
        "loser": "Justin Gaethje",
        "method": "KO/TKO",
        "round": 3,
    }


def test_flush_row_decision_fallback_when_no_method_cell():
    row = ["Welterweight", "Leon Edwards", "def.", "Belal Muhammad", "5"]
    res = scrape._flush_wikitable_row(row)
    assert res["method"] == "Decision" and res["round"] == 5


def test_flush_row_skips_header_rows():
    assert scrape._flush_wikitable_row(["Weight class", "Winner", "Method"]) is None


def test_parse_results_wikitable_full_table():
    wt = "\n".join([
        '{| class="wikitable"',
        "|-",
        "! Weight class !! Winner !! !! Loser !! Method !! Round",
        "|-",
        "| Lightweight || Max Holloway || def. || Justin Gaethje || KO || 3",
        "|-",
        "| Welterweight || Leon Edwards || def. || Belal Muhammad || Decision || 5",
        "|}",
    ])
    results = scrape._parse_results_wikitable(wt)
    winners = [r["winner"] for r in results]
    assert winners == ["Max Holloway", "Leon Edwards"]
    assert results[0]["method"] == "KO/TKO"


# --- odds lookup -----------------------------------------------------------

def test_get_odds_direct_orientation():
    idx = {("holloway", "gaethje"): {"f1_odds": -150, "f2_odds": 130,
                                     "f1_name": "Max Holloway", "f2_name": "Justin Gaethje"}}
    assert scrape.get_odds(idx, "Max Holloway", "Justin Gaethje") == {"f1": -150, "f2": 130}


def test_get_odds_swapped_orientation():
    idx = {("holloway", "gaethje"): {"f1_odds": -150, "f2_odds": 130,
                                     "f1_name": "Max Holloway", "f2_name": "Justin Gaethje"}}
    # Querying with fighters in the opposite order flips the odds to stay aligned.
    assert scrape.get_odds(idx, "Justin Gaethje", "Max Holloway") == {"f1": 130, "f2": -150}


def test_get_odds_no_match_returns_none():
    idx = {("holloway", "gaethje"): {"f1_odds": -150, "f2_odds": 130,
                                     "f1_name": "Max Holloway", "f2_name": "Justin Gaethje"}}
    assert scrape.get_odds(idx, "Jon Jones", "Stipe Miocic") is None


def test_get_odds_key_sorted_opposite_to_home_away():
    # Regression for the O'Malley/Zahabi swap. fetch_odds keys the index with the
    # fighter names sorted alphabetically, while f1_odds/f2_odds are aligned to
    # home/away. Here the home fighter ("Sean O'Malley") sorts AFTER the away
    # fighter ("Aiemann Zahabi"), so the sorted key is the reverse of home/away —
    # orientation must follow the stored names, not the key.
    home, away = "Sean O'Malley", "Aiemann Zahabi"
    idx = {tuple(sorted([home.lower(), away.lower()])): {
        "f1_name": home, "f2_name": away, "f1_odds": -460, "f2_odds": 350}}
    assert scrape.get_odds(idx, "Sean O'Malley", "Aiemann Zahabi") == {"f1": -460, "f2": 350}
    assert scrape.get_odds(idx, "Aiemann Zahabi", "Sean O'Malley") == {"f1": 350, "f2": -460}


# --- secondary odds source + fallback chain (#18) --------------------------

def _entry(name1, name2, o1, o2, source):
    return {tuple(sorted([name1.lower(), name2.lower()])): {
        "f1_name": name1, "f2_name": name2, "f1_odds": o1, "f2_odds": o2,
        "source": source}}


def test_fetch_odds_primary_wins_over_secondary_for_same_bout():
    # Both sources cover the same fight; the higher-priority source's line is kept.
    primary   = lambda: _entry("Max Holloway", "Justin Gaethje", -150, 130, "primary")
    secondary = lambda: _entry("Max Holloway", "Justin Gaethje", -200, 170, "secondary")
    idx = scrape.fetch_odds(sources=[primary, secondary])
    assert scrape.get_odds(idx, "Max Holloway", "Justin Gaethje") == {"f1": -150, "f2": 130}
    assert scrape.odds_source(idx, "Max Holloway", "Justin Gaethje") == "primary"


def test_fetch_odds_falls_back_to_secondary_when_primary_empty():
    # Primary parsed zero bouts (the empty-payload failure from #14) — the
    # secondary backfills the line instead of leaving the card with no odds.
    primary   = lambda: {}
    secondary = lambda: _entry("Islam Makhachev", "Ian Garry", -300, 250, "secondary")
    idx = scrape.fetch_odds(sources=[primary, secondary])
    assert scrape.get_odds(idx, "Islam Makhachev", "Ian Garry") == {"f1": -300, "f2": 250}
    assert scrape.odds_source(idx, "Islam Makhachev", "Ian Garry") == "secondary"


def test_fetch_odds_merges_cross_book_coverage():
    # Each source covers a different fight; both end up in the combined index.
    primary   = lambda: _entry("Jon Jones", "Stipe Miocic", -110, -110, "primary")
    secondary = lambda: _entry("Alex Pereira", "Magomed Ankalaev", 120, -140, "secondary")
    idx = scrape.fetch_odds(sources=[primary, secondary])
    assert len(idx) == 2
    assert scrape.odds_source(idx, "Jon Jones", "Stipe Miocic") == "primary"
    assert scrape.odds_source(idx, "Alex Pereira", "Magomed Ankalaev") == "secondary"


def test_fetch_odds_skips_a_failing_source():
    # A source that raises must not abort the chain — later sources still run.
    def boom():
        raise RuntimeError("network down")
    secondary = lambda: _entry("Sean Strickland", "Dricus du Plessis", -125, 105, "secondary")
    idx = scrape.fetch_odds(sources=[boom, secondary])
    assert scrape.odds_source(idx, "Sean Strickland", "Dricus du Plessis") == "secondary"


def test_odds_source_none_when_no_match():
    idx = _entry("Jon Jones", "Stipe Miocic", -110, -110, "primary")
    assert scrape.odds_source(idx, "Conor McGregor", "Michael Chandler") is None


def test_index_odds_api_tags_source_and_averages_books():
    payload = [{
        "home_team": "Max Holloway", "away_team": "Justin Gaethje",
        "bookmakers": [
            {"key": "fanduel", "markets": [{"key": "h2h", "outcomes": [
                {"name": "Max Holloway", "price": -150},
                {"name": "Justin Gaethje", "price": 130}]}]},
            {"key": "draftkings", "markets": [{"key": "h2h", "outcomes": [
                {"name": "Max Holloway", "price": -170},
                {"name": "Justin Gaethje", "price": 150}]}]},
        ],
    }]
    idx = scrape._index_odds_api(payload, "the-odds-api:us")
    assert scrape.get_odds(idx, "Max Holloway", "Justin Gaethje") == {"f1": -160, "f2": 140}
    assert scrape.odds_source(idx, "Max Holloway", "Justin Gaethje") == "the-odds-api:us"


def test_index_odds_api_empty_payload_yields_empty_index():
    assert scrape._index_odds_api([], "the-odds-api:us") == {}


# --- odds sanity validation (_valid_odds / _index_odds_api rejection) -------

def test_valid_odds_accepts_standard_lines():
    assert scrape._valid_odds(-150, 130)    # clear favourite
    assert scrape._valid_odds(-110, -110)   # coin-flip, both negative
    assert scrape._valid_odds(-613, 435)    # heavy favourite


def test_valid_odds_rejects_impossible_lines():
    # These are the exact corrupted values seen in the June 25 scrape.
    assert not scrape._valid_odds(-120, -36)
    assert not scrape._valid_odds(-117, -39)
    assert not scrape._valid_odds(-118, -38)
    # "drop leading digit" positive-odds corruption (June 26 scrape: +29 for +129).
    assert not scrape._valid_odds(29, -116)
    assert not scrape._valid_odds(-116, 29)


def test_index_odds_api_drops_corrupt_line():
    # A payload where the away fighter's price produces an implied probability
    # below 100% total — the fight must be silently dropped, not indexed.
    payload = [{
        "home_team": "Abusupiyan Magomedov", "away_team": "Micha Oleksiejczuk",
        "bookmakers": [
            {"key": "somebook", "markets": [{"key": "h2h", "outcomes": [
                {"name": "Abusupiyan Magomedov", "price": -120},
                {"name": "Micha Oleksiejczuk",   "price": -36}]}]},
        ],
    }]
    idx = scrape._index_odds_api(payload, "the-odds-api:eu")
    assert idx == {}


def test_index_odds_api_drops_positive_drop_leading_digit():
    # +29 is the "drop leading digit" form of +129 — must be rejected.
    payload = [{
        "home_team": "Serhii Sidey", "away_team": "Kaio Borralho",
        "bookmakers": [
            {"key": "somebook", "markets": [{"key": "h2h", "outcomes": [
                {"name": "Serhii Sidey",   "price": 29},
                {"name": "Kaio Borralho",  "price": -116}]}]},
        ],
    }]
    idx = scrape._index_odds_api(payload, "the-odds-api:eu")
    assert idx == {}


def test_index_odds_api_accepts_near_even_both_negative():
    # -110/-112 is a legitimate near-coin-flip; both negative but total > 100%.
    payload = [{
        "home_team": "Rafael Fiziev", "away_team": "Manuel Torres",
        "bookmakers": [
            {"key": "fanduel", "markets": [{"key": "h2h", "outcomes": [
                {"name": "Rafael Fiziev",  "price": -110},
                {"name": "Manuel Torres", "price": -112}]}]},
        ],
    }]
    idx = scrape._index_odds_api(payload, "the-odds-api:us")
    assert scrape.get_odds(idx, "Rafael Fiziev", "Manuel Torres") == {"f1": -110, "f2": -112}


def _make_existing(f1n, f2n, o1, o2):
    import scrape as s
    key = frozenset([s.last_name(f1n), s.last_name(f2n)])
    return {key: {"f1_name": f1n, "f2_name": f2n, "f1_odds": o1, "f2_odds": o2}}


def test_get_odds_with_fallback_rejects_corrupt_existing_odds():
    # Live API returns nothing; existing odds in data.js are corrupted.
    # The fallback must return None rather than surfacing the bad values.
    existing = _make_existing("Abusupiyan Magomedov", "Micha Oleksiejczuk", -120, -36)
    result = scrape.get_odds_with_fallback({}, existing, "Abusupiyan Magomedov", "Micha Oleksiejczuk")
    assert result is None


def test_get_odds_with_fallback_accepts_valid_existing_odds():
    # Live API returns nothing but existing odds are legitimate — preserve them.
    existing = _make_existing("Abusupiyan Magomedov", "Micha Oleksiejczuk", -124, 101)
    result = scrape.get_odds_with_fallback({}, existing, "Abusupiyan Magomedov", "Micha Oleksiejczuk")
    assert result == {"f1": -124, "f2": 101}


# --- hoisted regexes -------------------------------------------------------

def test_rankings_regex_extracts_rank_and_name():
    wt = ("! 1\n| {{flagicon|USA}}\n| [[Islam Makhachev|Islam Makhachev]]\n"
          "! 2\n| {{flagicon|BRA}}\n| [[Charles Oliveira]]\n")
    got = {m.group(2): int(m.group(1)) for m in scrape.RANKINGS_RE.finditer(wt)}
    assert got["Islam Makhachev"] == 1
    assert got["Charles Oliveira"] == 2


def test_existing_odds_regex_extracts_embedded_odds():
    html = '...odds:{f1:-150,f2:130},f1:{n:"Jon Jones",a:1},f2:{n:"Stipe Miocic",a:2}...'
    m = scrape.EXISTING_ODDS_RE.search(html)
    assert m.groups() == ("-150", "130", "Jon Jones", "Stipe Miocic")


# --- UFCStats fighter disambiguation ---------------------------------------

def test_search_ufcstats_prefers_most_experienced_namesake(monkeypatch):
    # Two distinct fighters named "Diego Lopes" exist on UFCStats. The active
    # UFC contender (27-8) must win over the lesser-known namesake (19-3),
    # regardless of listing order — otherwise the wrong record/stats get cached.
    rows = [
        ("Diego", "Lopes", "http://ufcstats.com/fighter-details/aaa", 19, 3, 0),
        ("Diego", "Lopes", "http://ufcstats.com/fighter-details/bbb", 27, 8, 0),
    ]
    monkeypatch.setattr(scrape, "_load_ufcstats_letter", lambda letter: rows)
    assert scrape._search_ufcstats("Diego Lopes") == (
        "http://ufcstats.com/fighter-details/bbb", "27-8-0")


def test_name_tokens_match_regressions_still_hold():
    m = scrape._name_tokens_match
    # Plain names, namesakes, first-name abbreviations, accents, name order.
    assert m("Conor", "McGregor", "Conor McGregor")
    assert m("Diego", "Lopes", "Diego Lopes")
    assert m("Steve", "Garcia", "Steve Garcia")
    assert m("Jonathan", "Jones", "Jon Jones")              # first-name variant
    assert m("Khabib", "Nurmagomedov", "Khabib Nurmagomedov (c)")  # champ marker
    assert m("Jose", "Aldo", "José Aldo")                    # accent fold
    assert m("Weili", "Zhang", "Zhang Weili")                # reversed order


def test_name_tokens_match_fixes_particle_suffix_names():
    m = scrape._name_tokens_match
    assert m("Dricus", "Du Plessis", "Dricus du Plessis")
    assert m("Reinier", "De Ridder", "Reinier de Ridder")
    assert m("Ian", "Machado Garry", "Ian Machado Garry")
    assert m("Ian", "Garry", "Ian Machado Garry")            # UFCStats drops middle
    assert m("Khalil", "Rountree Jr.", "Khalil Rountree Jr.")
    assert m("Benoit", "Saint Denis", "Benoit Saint Denis")
    assert m("Benoit", "St. Denis", "Benoit Saint Denis")    # Saint/St. abbreviation


def test_name_tokens_match_still_rejects_distinct_fighters():
    m = scrape._name_tokens_match
    assert not m("Stipe", "Miocic", "Jon Jones")             # unrelated
    assert not m("Michael", "Jones", "Michael Johnson")      # surname mismatch
    assert not m("Jane", "Smith", "John Smith")              # first-name mismatch
    assert not m("Islam", "Makhachev", "Ian Machado Garry")  # no shared surname


def test_search_ufcstats_matches_particle_surname(monkeypatch):
    # "De Ridder" is filed under D on UFCStats; the search must look under the
    # particle's initial, not just the card's last token ("Ridder" → R).
    rows = {"d": [("Reinier", "De Ridder", "http://x/rdr", 21, 4, 0)]}
    monkeypatch.setattr(scrape, "_load_ufcstats_letter", lambda letter: rows.get(letter, []))
    assert scrape._search_ufcstats("Reinier de Ridder") == ("http://x/rdr", "21-4-0")


def test_search_ufcstats_single_match_unchanged(monkeypatch):
    # A unique name must still resolve to its one row (no behavior change).
    rows = [("Steve", "Garcia", "http://ufcstats.com/fighter-details/ccc", 19, 5, 0)]
    monkeypatch.setattr(scrape, "_load_ufcstats_letter", lambda letter: rows)
    assert scrape._search_ufcstats("Steve Garcia") == (
        "http://ufcstats.com/fighter-details/ccc", "19-5-0")


# --- fighter-stats fetch cadence (_needs_stats_fetch) ----------------------

from datetime import datetime, timedelta, timezone

_NOW = datetime(2026, 7, 10, tzinfo=timezone.utc)


def _iso(days_ago):
    return (_NOW - timedelta(days=days_ago)).isoformat()


def _complete(**over):
    # A fully-populated, freshly-fetched cache entry.
    e = {"rec": "20-1-0", "form": [{"r": "W", "m": "KO"}], "opp": ["Some Guy"],
         "url": "http://ufcstats.com/x", "fetched_at": _iso(1)}
    e.update(over)
    return e


def test_needs_fetch_brand_new_forces_search():
    # No cache entry at all → fetch via the search path (which carries the record).
    assert scrape._needs_stats_fetch(None, _NOW) == (True, True)
    assert scrape._needs_stats_fetch({}, _NOW) == (True, True)


def test_needs_fetch_recent_failure_is_skipped():
    # A fetch that failed inside the cooldown window must not be retried yet.
    entry = _complete(fetch_failed=_iso(1))
    assert scrape._needs_stats_fetch(entry, _NOW) == (False, False)


def test_needs_fetch_stale_failure_retries():
    # Past the cooldown, a previously-failed fighter is retried.
    entry = {"fetch_failed": _iso(scrape.STATS_RETRY_DAYS + 1)}
    assert scrape._needs_stats_fetch(entry, _NOW)[0] is True


def test_needs_fetch_incomplete_uses_cheap_cached_url():
    # Missing form/opp → refetch, but not via the (costly) search path.
    assert scrape._needs_stats_fetch({"rec": "5-0-0", "opp": []}, _NOW) == (True, False)
    assert scrape._needs_stats_fetch({"rec": "5-0-0", "form": []}, _NOW) == (True, False)


def test_needs_fetch_legacy_entry_without_timestamp_revalidates():
    # Entries written before the cadence existed carry no fetched_at — the case
    # that repairs a frozen wrong record or a failure-emptied opponent list.
    legacy = {"rec": "27-9-0", "form": [], "opp": []}   # no fetched_at
    assert scrape._needs_stats_fetch(legacy, _NOW) == (True, True)


def test_needs_fetch_stale_entry_revalidates_via_search():
    entry = _complete(fetched_at=_iso(scrape.STATS_REFRESH_DAYS + 1))
    assert scrape._needs_stats_fetch(entry, _NOW) == (True, True)


def test_needs_fetch_fresh_complete_entry_is_skipped():
    assert scrape._needs_stats_fetch(_complete(), _NOW) == (False, False)


def test_parse_ts_bad_value_is_long_stale():
    # Unparseable timestamps must read as stale so the entry gets refreshed,
    # never as "just fetched" (which would freeze a bad record forever).
    assert scrape._parse_ts("not-a-date") < _NOW - timedelta(days=3650)
    assert scrape._parse_ts(None) < _NOW - timedelta(days=3650)


def test_parse_ts_naive_value_is_normalised_to_utc():
    # A naive timestamp must not raise when subtracted from tz-aware now.
    parsed = scrape._parse_ts("2026-07-01T00:00:00")
    assert parsed.tzinfo is not None
    assert (_NOW - parsed).days == 9


# --- Wikipedia record fallback (_wiki_record) ------------------------------

def test_wiki_record_reads_infobox_fields():
    wt = ("{{Infobox martial artist\n| name = Robert Whittaker\n"
          "| wins = 26\n| losses = 9\n| draws = 0\n| ko = 6\n}}")
    assert scrape._wiki_record(wt) == "26-9-0"


def test_wiki_record_defaults_draws_to_zero():
    wt = "{{Infobox martial artist\n| wins = 27\n| losses = 9\n}}"
    assert scrape._wiki_record(wt) == "27-9-0"


def test_wiki_record_ignores_qualified_win_fields():
    # 'amateur wins' / 'ko' must not be mistaken for the pro win/loss totals.
    wt = ("{{Infobox martial artist\n| amateur wins = 3\n| amateur losses = 1\n"
          "| wins = 23\n| losses = 4\n| draws = 0\n| ko = 7\n}}")
    assert scrape._wiki_record(wt) == "23-4-0"


def test_wiki_record_returns_empty_without_fields():
    assert scrape._wiki_record("just some prose, no infobox") == ""
    assert scrape._wiki_record("{{Infobox martial artist\n| wins = 5\n}}") == ""  # no losses
    assert scrape._wiki_record("") == ""


# --- event start times (US default authoritative over ESPN) ----------------

def test_us_regions_now_cover_oklahoma_city_and_philadelphia():
    # Previously mis-classified as international → TBD + false past-midnight warns.
    assert scrape._default_main_time("Oklahoma City", "UFC Fight Night: A vs. B") == "20:00"
    assert scrape._default_prelim_time("Oklahoma City", "UFC Fight Night: A vs. B") == "17:00"
    assert scrape._default_main_time("Philadelphia", "UFC 330: A vs. B") == "21:00"
    assert scrape._default_prelim_time("Philadelphia", "UFC 330: A vs. B") == "19:00"


def test_resolve_times_us_default_beats_espn(monkeypatch):
    # A US card has a fixed, known ET slot; ESPN (whose 'date' is the early-prelim
    # start) must NOT override it — and must not even be consulted.
    def boom(*a, **k):
        raise AssertionError("ESPN must not be consulted for a US card with a fixed slot")
    monkeypatch.setattr(scrape, "fetch_espn_times", boom)
    assert scrape.resolve_event_times(
        "UFC 329: McGregor vs. Holloway 2", "2026-07-11", "21:00", "19:00") == ("21:00", "19:00")


def test_resolve_times_uses_espn_only_for_international(monkeypatch):
    # International cards have no ET default (TBD) → ESPN is the sole source.
    monkeypatch.setattr(scrape, "fetch_espn_times", lambda n, d: ("09:00", "06:00"))
    assert scrape.resolve_event_times(
        "UFC Fight Night: X vs. Y", "2026-07-25", "TBD", "TBD") == ("09:00", "06:00")


def test_time_override_pins_international_card_and_skips_espn(monkeypatch):
    # A verified _TIME_OVERRIDES entry is authoritative even for an international
    # card, and ESPN must not be consulted.
    def boom(*a, **k):
        raise AssertionError("ESPN must not be consulted for an overridden card")
    monkeypatch.setattr(scrape, "fetch_espn_times", boom)
    dm, dp = scrape._event_times("UFC Fight Night: Ankalaev vs. Rountree Jr.", "Abu Dhabi")
    assert (dm, dp) == ("15:00", "12:00")
    assert scrape.resolve_event_times(
        "UFC Fight Night: Ankalaev vs. Rountree Jr.", "2026-07-25", dm, dp) == ("15:00", "12:00")


# --- UFCStats proof-of-work interstitial (_parse/_solve) -------------------

# A trimmed copy of the real interstitial served by UFCStats (2026-07-10).
_INTERSTITIAL = (
    "<html><body><script>(function(){"
    "function sha256(msg){/* ... */}"
    'var nonce="eecec3fc625fd3ce",\n'
    "    target=new Array(2+1).join('0');"
    "var n=0;while(sha256(nonce+':'+n).slice(0,target.length)!==target){n++;}"
    "var xhr=new XMLHttpRequest();xhr.open('POST',\"/__c\",true);"
    "xhr.send('nonce='+encodeURIComponent(nonce)+'&n='+n);})();</script></body></html>"
)


def test_parse_ufcstats_challenge_extracts_nonce_difficulty_path():
    assert scrape._parse_ufcstats_challenge(_INTERSTITIAL) == ("eecec3fc625fd3ce", 2, "/__c")


def test_parse_ufcstats_challenge_none_on_real_page():
    assert scrape._parse_ufcstats_challenge(
        '<table class="b-statistics__table"><tr><td>Jon</td></tr></table>') is None
    assert scrape._parse_ufcstats_challenge("") is None


def test_solve_ufcstats_pow_matches_browser_solution():
    # The real challenge above was solved by the site's own JS at n=293.
    n = scrape._solve_ufcstats_pow("eecec3fc625fd3ce", 2)
    assert n == 293
    # And the solution genuinely satisfies the difficulty target.
    assert hashlib.sha256(f"eecec3fc625fd3ce:{n}".encode()).hexdigest().startswith("00")


def test_solve_ufcstats_pow_is_minimal():
    # No earlier n may satisfy the target (the site expects the smallest solution).
    for k in range(293):
        assert not hashlib.sha256(f"eecec3fc625fd3ce:{k}".encode()).hexdigest().startswith("00")


# --- last-known record preservation (extract_card_records) -----------------

def test_extract_card_records_maps_names_to_records():
    html = ('...f1:{n:"Dricus du Plessis",r:"23-3-0",rk:"",s:null},'
            'f2:{n:"Kamaru Usman",r:"20-4-0",rk:"",s:null}...')
    got = scrape.extract_card_records(html)
    assert got == {"Dricus du Plessis": "23-3-0", "Kamaru Usman": "20-4-0"}


def test_extract_card_records_skips_blank_and_keeps_first():
    # Blank records are ignored, and a fighter appearing twice keeps the first
    # non-empty value (so a later blank can't override a known record).
    html = ('f1:{n:"Benoit Saint Denis",r:"17-3-0",rk:"",s:null},'
            'f2:{n:"Blank Guy",r:"",rk:"",s:null},'
            'f1:{n:"Benoit Saint Denis",r:"",rk:"",s:null}')
    got = scrape.extract_card_records(html)
    assert got == {"Benoit Saint Denis": "17-3-0"}
    assert "Blank Guy" not in got


# --- ESPN start times ------------------------------------------------------

def test_event_surnames_parses_headliners():
    assert scrape._event_surnames("UFC Fight Night: Fiziev vs. Torres") == ("fiziev", "torres")
    assert scrape._event_surnames("UFC 330: Jones vs Aspinall") == ("jones", "aspinall")
    assert scrape._event_surnames("UFC 999") is None  # not yet titled


def test_utc_iso_to_et_handles_z_suffix_and_dst():
    # 19:00 UTC on a summer date is 15:00 EDT (UTC-4).
    assert scrape._utc_iso_to_et("2026-06-27T19:00Z").strftime("%H:%M") == "15:00"
    # Same clock time in winter is 14:00 EST (UTC-5) — DST handled by zoneinfo.
    assert scrape._utc_iso_to_et("2026-01-15T19:00Z").strftime("%H:%M") == "14:00"
    assert scrape._utc_iso_to_et("") is None
    assert scrape._utc_iso_to_et("not-a-date") is None


def test_parse_espn_times_baku_converts_utc_to_et():
    # Baku card (UTC+4): 7pm local = 15:00 UTC = 11:00 ET main card.
    # Prelims are derived 3h earlier (Fight Night offset) -> 08:00 ET.
    payload = {"events": [{
        "date": "2026-06-27T15:00Z",
        "name": "UFC Fight Night: Fiziev vs. Torres",
        "shortName": "Fiziev vs. Torres",
    }]}
    assert scrape.parse_espn_times(
        payload, "UFC Fight Night: Fiziev vs. Torres", "2026-06-27") == ("11:00", "08:00")


def test_parse_espn_times_ppv_uses_two_hour_prelim_offset():
    payload = {"events": [{
        "date": "2026-06-27T23:00Z",  # 19:00 ET main card
        "name": "UFC 330: Jones vs. Aspinall",
        "shortName": "Jones vs. Aspinall",
    }]}
    assert scrape.parse_espn_times(
        payload, "UFC 330: Jones vs. Aspinall", "2026-06-27") == ("19:00", "17:00")


def test_parse_espn_times_late_us_card_matches_on_et_date():
    # A 02:00 UTC start (next UTC day) is still "tonight" 22:00 ET on the event
    # date — matching must compare the ET calendar date, not the UTC one.
    payload = {"events": [{
        "date": "2026-06-28T02:00Z",
        "name": "UFC Fight Night: Smith vs. Jones",
        "shortName": "Smith vs. Jones",
    }]}
    assert scrape.parse_espn_times(
        payload, "UFC Fight Night: Smith vs. Jones", "2026-06-27") == ("22:00", "19:00")


def test_parse_espn_times_no_match_returns_none():
    payload = {"events": [{
        "date": "2026-06-27T19:00Z",
        "name": "UFC Fight Night: Fiziev vs. Torres",
        "shortName": "Fiziev vs. Torres",
    }]}
    # Wrong fighters -> no match.
    assert scrape.parse_espn_times(
        payload, "UFC Fight Night: Adesanya vs. Pereira", "2026-06-27") == (None, None)
    # Right fighters, wrong date -> no match.
    assert scrape.parse_espn_times(
        payload, "UFC Fight Night: Fiziev vs. Torres", "2026-07-04") == (None, None)
    # Empty payload -> no match.
    assert scrape.parse_espn_times({}, "UFC Fight Night: Fiziev vs. Torres", "2026-06-27") == (None, None)


def test_resolve_event_times_overrides_skip_espn(monkeypatch):
    # A manual override is authoritative and must not trigger an ESPN lookup.
    monkeypatch.setattr(scrape, "_TIME_OVERRIDES", {"UFC Freedom 250": ("20:00", "")})
    def boom(*a, **k):
        raise AssertionError("ESPN must not be consulted for an overridden card")
    monkeypatch.setattr(scrape, "fetch_espn_times", boom)
    assert scrape.resolve_event_times("UFC Freedom 250", "2026-07-04", "20:00", "") == ("20:00", "")


def test_resolve_event_times_falls_back_to_default_when_espn_misses(monkeypatch):
    monkeypatch.setattr(scrape, "fetch_espn_times", lambda n, d: (None, None))
    assert scrape.resolve_event_times(
        "UFC Fight Night: Foo vs. Bar", "2026-06-27", "TBD", "TBD") == ("TBD", "TBD")


def test_resolve_event_times_prefers_espn_over_default(monkeypatch):
    # Use an event with no manual override so the ESPN branch is exercised.
    monkeypatch.setattr(scrape, "fetch_espn_times", lambda n, d: ("15:00", "12:00"))
    assert scrape.resolve_event_times(
        "UFC Fight Night: Foo vs. Bar", "2026-06-27", "TBD", "TBD") == ("15:00", "12:00")


# --- _warn_if_implausible_time -----------------------------------------------

def test_warn_implausible_fires_for_late_international(capsys):
    # An international card resolving to 19:00 ET implies a midnight+ local start.
    scrape._warn_if_implausible_time("UFC Fight Night: Foo vs. Bar", "London", "19:00")
    assert "WARNING" in capsys.readouterr().err


def test_warn_implausible_silent_for_us_card(capsys):
    # US cards routinely start at 8pm ET — no warning expected.
    scrape._warn_if_implausible_time("UFC Fight Night: Foo vs. Bar", "Las Vegas", "20:00")
    assert capsys.readouterr().err == ""


def test_warn_implausible_silent_for_reasonable_international(capsys):
    # 11am ET for Baku (UTC+4) is 3pm UTC = 7pm local — fine.
    scrape._warn_if_implausible_time("UFC Fight Night: Fiziev vs. Torres", "Baku", "11:00")
    assert capsys.readouterr().err == ""


def test_warn_implausible_silent_for_tbd(capsys):
    scrape._warn_if_implausible_time("UFC Fight Night: Foo vs. Bar", "London", "TBD")
    assert capsys.readouterr().err == ""
