"""
Unit tests for the pure parsing/normalisation helpers in scrape.py.

These are the brittle, format-sensitive functions that silently break when
Wikipedia / the Odds API change shape. They make no network calls, so they run
fast in CI and act as a safety net before the scraper can overwrite data.js.

Run with:  python -m pytest -q
"""
import hashlib
import json
import re

import scrape


# --- name helpers ----------------------------------------------------------

def test_last_name_strips_accents_and_parentheticals():
    assert scrape.last_name("Israel Adesanya") == "adesanya"
    assert scrape.last_name("Khabib Nurmagomedov (c)") == "nurmagomedov"
    assert scrape.last_name("José Aldo") == "aldo"


def test_asc_drops_letters_nfkd_cannot_decompose():
    """The ASCII form is load-bearing, not cosmetic.

    "ł" carries its stroke in the codepoint, so NFKD leaves it whole and asc()
    drops it: "Syguła" → "Sygua". That spelling is what data.js ships, what
    every stored pick is keyed on (`date|f1|f2`), and what the result-push
    `fight_key` is built from — index.html and check-results fold identically so
    a fight can only produce one `result:<fight_key>` type and one push.
    Changing this to transliterate ("Sygula") is a data migration, not a tweak:
    it orphans stored picks and re-opens the duplicate-notification bug.
    """
    assert scrape.asc("Klaudia Syguła") == "Klaudia Sygua"
    assert scrape.asc("José Aldo") == "Jose Aldo"
    assert scrape.asc("Søren Bak") == "Sren Bak"


def test_names_match_by_last_name_and_substring():
    assert scrape.names_match("Max Holloway", "Holloway")
    assert scrape.names_match("Conor McGregor", "conor mcgregor")
    assert not scrape.names_match("Jon Jones", "Stipe Miocic")


def test_clean_wiki_strips_markup():
    assert scrape.clean_wiki("[[Jon Jones|Jon Jones]]") == "Jon Jones"
    assert scrape.clean_wiki("Stipe Miocic{{flagicon|USA}}") == "Stipe Miocic"
    assert scrape.clean_wiki("Champion[1]") == "Champion"


def test_clean_wiki_strips_an_unclosed_template():
    # A template split across lines arrives without its closing braces, because
    # the caller only ever hands us one line. Those braces used to survive into a
    # fighter name in data.js and unbalance inject_results' brace scan (#97).
    assert scrape.clean_wiki("{{nowrap|Levi Rodrigues Jr.") == "Levi Rodrigues Jr."
    assert scrape.clean_wiki("{{nowrap|Levi Rodrigues Jr.}}") == ""
    assert "{" not in scrape.clean_wiki("{{sortname|Jon|Jones")
    assert "}" not in scrape.clean_wiki("Jon Jones}}")


def _fight_js(f1, f2):
    return (
        'var EVENTS=[{fights:[{lbl:"Main Card",wc:"Lightweight",title:false,'
        'rematch:false,odds:{f1:-192,f2:160},winner:"",method:"",round:null,'
        f'state:"pre",f1:{{n:"{f1}",r:"",rk:"",s:null}},f2:{{n:"{f2}",r:"",rk:"",s:null}}}}]}}];'
    )


def test_inject_results_marks_the_fight_finished():
    js = _fight_js("Liu Ce", "Levi Rodrigues Jr.")
    out, n = scrape.inject_results(
        js, [{"winner": "Liu Ce", "loser": "Levi Rodrigues Jr.",
              "method": "KO/TKO", "round": 1}])
    assert n == 1
    assert 'winner:"Liu Ce"' in out and 'state:"post"' in out and "round:1" in out


def test_inject_results_never_counts_an_edit_it_did_not_make():
    # An unbalanced name leaves the brace scan unable to delimit the fight. The
    # old code sliced an EMPTY string, changed nothing, and still returned 1 —
    # and main() exits on any non-zero count, so this one phantom result skipped
    # the odds/stats/rankings rebuild on every run for as long as the event
    # stayed in the results window.
    js = _fight_js("Liu Ce", "{{nowrap|Levi Rodrigues Jr.")
    out, n = scrape.inject_results(
        js, [{"winner": "Liu Ce", "loser": "Levi Rodrigues Jr.",
              "method": "KO/TKO", "round": 1}])
    assert n == 0
    assert out == js


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


def _card(*pairs):
    return [{"odds": None, "f1": {"name": a}, "f2": {"name": b}} for a, b in pairs]


def _idx(f1, f2, p1, p2):
    return scrape._index_odds_api([{
        "home_team": f1, "away_team": f2,
        "bookmakers": [{"key": "fanduel", "markets": [{"key": "h2h", "outcomes": [
            {"name": f1, "price": p1}, {"name": f2, "price": p2}]}]}],
    }], "the-odds-api:us")


def test_reprice_card_prices_a_card_the_guard_kept():
    # The regression guard keeps a fuller previous card when a parse comes back
    # short. Swapping the whole card also threw away the lines just fetched, so a
    # card that tripped the guard on every run could never be priced at all.
    card = _card(("Dan Hooker", "Salahdine Parnasse"))
    n = scrape.reprice_card(card, _idx("Dan Hooker", "Salahdine Parnasse", 425, -600), {})
    assert n == 1
    assert card[0]["odds"] == {"f1": 425, "f2": -600}


def test_reprice_card_keeps_an_existing_line_the_feed_lacks():
    # A bout the feed has nothing for must not lose the price it already had.
    card = _card(("Some Fighter", "Other Fighter"))
    card[0]["odds"] = {"f1": -200, "f2": 170}
    n = scrape.reprice_card(card, {}, {})
    assert n == 0
    assert card[0]["odds"] == {"f1": -200, "f2": 170}


def test_reprice_card_reports_only_real_changes():
    card = _card(("Dan Hooker", "Salahdine Parnasse"))
    idx = _idx("Dan Hooker", "Salahdine Parnasse", 425, -600)
    scrape.reprice_card(card, idx, {})
    # Same lines a second time is not a change.
    assert scrape.reprice_card(card, idx, {}) == 0


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


def test_name_tokens_match_fixes_dropped_leading_given_name():
    # UFCStats keeps only part of a multi-part given name, and not always the
    # leading one. Matching against the card's FIRST token only ("Carlos") meant
    # the row "Diego Ferreira" never matched "Carlos Diego Ferreira", so his
    # record rendered blank on the card he was actually fighting on.
    m = scrape._name_tokens_match
    assert m("Diego", "Ferreira", "Carlos Diego Ferreira")
    assert m("Carlos", "Ferreira", "Carlos Diego Ferreira")
    assert m("Carlos Diego", "Ferreira", "Carlos Diego Ferreira")
    # The reverse direction too: card carries the short name, UFCStats the long.
    assert m("Carlos Diego", "Ferreira", "Diego Ferreira")


def test_name_tokens_match_still_rejects_distinct_fighters():
    m = scrape._name_tokens_match
    assert not m("Stipe", "Miocic", "Jon Jones")             # unrelated
    assert not m("Michael", "Jones", "Michael Johnson")      # surname mismatch
    assert not m("Jane", "Smith", "John Smith")              # first-name mismatch
    assert not m("Islam", "Makhachev", "Ian Machado Garry")  # no shared surname
    # Widening the given-name comparison to a set must not conflate namesakes:
    # a shared surname alone is still not a match.
    assert not m("Anthony", "Johnson", "Michael Johnson")
    assert not m("Gilbert", "Burns", "Kevin Burns")


def test_search_ufcstats_applies_name_alias(monkeypatch):
    # A fighter whose UFCStats surname is a different word entirely (nickname
    # promoted to surname) shares no surname with the card name, so no token
    # matcher can bridge it — that's what the alias table is for.
    # Every letter returns a non-empty page so the empty-page retry (which
    # sleeps) never triggers — only the name matching is under test here.
    other = [("Someone", "Else", "http://x/else", 1, 1, 0)]
    rows = {"m": [("Jose", "Montanha", "http://x/mnt", 6, 1, 0)]}
    monkeypatch.setattr(scrape, "_load_ufcstats_letter", lambda letter: rows.get(letter, other))
    assert scrape._search_ufcstats("Jose Luiz") == ("http://x/mnt", "6-1-0")
    # Unaliased names are untouched by the lookup.
    assert scrape._search_ufcstats("Jose Aldo") is None


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

from datetime import date, datetime, timedelta, timezone

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


# --- Wikipedia results slug (PPV subtitle must be stripped) -----------------

def test_wiki_event_slug_strips_ppv_subtitle():
    assert scrape._wiki_event_slug("UFC 329: McGregor vs. Holloway 2") == "UFC_329"
    assert scrape._wiki_event_slug("UFC 330: Makhachev vs. Machado Garry") == "UFC_330"


def test_wiki_event_slug_keeps_fight_night_title():
    assert scrape._wiki_event_slug(
        "UFC Fight Night: Kape vs. Horiguchi") == "UFC_Fight_Night:_Kape_vs._Horiguchi"


# --- full-name normalisation for rematch matching --------------------------

def test_norm_full_distinguishes_shared_surnames():
    # Full-name normalisation is what stops two different fighters who share a
    # surname (the old last-name match) from being read as a rematch.
    assert scrape._norm_full("José Aldo") == "jose aldo"
    assert scrape._norm_full("  Max   Holloway ") == "max holloway"
    assert scrape._norm_full("Dricus du Plessis") != scrape._norm_full("Anderson du Plessis")
    assert scrape._norm_full("Jon Jones") != scrape._norm_full("Dustin Jones")


# --- event de-duplication (stub must not shadow the real card) -------------

def test_dedupe_events_keeps_richest_card():
    stub = {"name": "UFC 329: McGregor vs. Holloway 2", "date": "2026-07-11",
            "fights": [{"lbl": "Main Event"}]}
    full = {"name": "UFC 329: McGregor vs. Holloway 2", "date": "2026-07-11",
            "fights": [{"lbl": "Main Event"}] + [{"lbl": "Prelim"}] * 13}
    other = {"name": "UFC 330: X vs. Y", "date": "2026-08-15", "fights": [{"lbl": "Main Event"}]}
    # Stub appears first; the 14-fight card must win, and order is preserved.
    out = scrape._dedupe_events([stub, other, full])
    assert len(out) == 2
    names = [(e["name"], len(e["fights"])) for e in out]
    assert names == [("UFC 329: McGregor vs. Holloway 2", 14), ("UFC 330: X vs. Y", 1)]


def test_dedupe_events_noop_when_unique():
    evs = [{"name": "A", "date": "d1", "fights": []},
           {"name": "B", "date": "d2", "fights": []}]
    assert scrape._dedupe_events(evs) == evs


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


# --- _extract_existing_cards / card regression guard -------------------------

def _mini_data_js(fights_js):
    """Wrap fight literals in a minimal one-event data.js the parser can read."""
    return (
        'var EVENTS=[\n'
        '  {\n'
        '    name:"UFC 999: A vs. B",\n'
        '    date:"2026-07-11",\n'
        '    venue:"Arena",\n'
        '    loc:"Las Vegas",\n'
        '    tv:"Paramount+",\n'
        '    time:"21:00",\n'
        '    prelimTime:"19:00",\n'
        '    fights:[\n' + fights_js + '\n    ]\n'
        '  }\n'
        '];\n'
    )


def test_extract_existing_cards_roundtrips_fights():
    # Serialise real fight dicts, then read them back and confirm fidelity.
    f_pre = {"label": "Main Event", "wc": "Lightweight", "title": True, "rematch": False,
             "odds": {"f1": -150, "f2": 124}, "winner": "", "method": "", "round": None,
             "state": "pre", "f1": {"name": "Alice A", "record": "10-1-0", "ranking": "1"},
             "f2": {"name": "Bob B", "record": "9-2-0", "ranking": "3"}}
    f_post = {"label": "Prelim", "wc": "Bantamweight", "title": False, "rematch": True,
              "odds": None, "winner": "Cara C", "method": "KO", "round": 2, "state": "post",
              "f1": {"name": "Cara C", "record": "5-0-0", "ranking": ""},
              "f2": {"name": "Dora D", "record": "4-3-0", "ranking": ""}}
    js = scrape.fight_js(f_pre, ",") + "\n" + scrape.fight_js(f_post, "")
    cards = scrape._extract_existing_cards(_mini_data_js(js))
    got = cards[("UFC 999: A vs. B", "2026-07-11")]
    assert len(got) == 2
    assert got[0]["f1"]["name"] == "Alice A" and got[0]["f1"]["record"] == "10-1-0"
    assert got[0]["title"] is True and got[0]["odds"] == {"f1": -150, "f2": 124}
    assert got[1]["state"] == "post" and got[1]["winner"] == "Cara C"
    assert got[1]["round"] == 2 and got[1]["rematch"] is True and got[1]["odds"] is None


def test_card_regression_guard_keeps_richer_existing_card(monkeypatch):
    # A full card already in data.js; the fresh parse returns only a title stub.
    # step_build_events must keep the existing card rather than overwrite it.
    full = []
    for i in range(6):
        full.append({"label": "Main Card", "wc": "TBD", "title": False, "rematch": False,
                     "odds": None, "winner": "", "method": "", "round": None, "state": "pre",
                     "f1": {"name": f"Fighter {i}A", "record": "", "ranking": ""},
                     "f2": {"name": f"Fighter {i}B", "record": "", "ranking": ""}})
    js = "\n".join(scrape.fight_js(f, "," if k < len(full) - 1 else "")
                   for k, f in enumerate(full))
    data = _mini_data_js(js)
    existing_cards = scrape._extract_existing_cards(data)
    prev = existing_cards.get(("UFC 999: A vs. B", "2026-07-11"))
    assert prev is not None and len(prev) == 6
    # Simulate the stub the title-regex fallback would build post-event.
    stub = [{"label": "Main Event", "wc": "TBD", "title": False, "rematch": False,
             "odds": None, "winner": "", "method": "", "round": None, "state": "pre",
             "f1": {"name": "A", "record": "", "ranking": ""},
             "f2": {"name": "B", "record": "", "ranking": ""}}]
    kept = prev if prev and len(prev) > len(stub) else stub
    assert len(kept) == 6  # the six-fight card survives, not the one-bout stub


# --- event slug resolution (diacritic titles) ------------------------------

def test_fold_title_ignores_case_diacritics_punctuation():
    assert (scrape._fold_title("UFC Fight Night: Medić vs. Rodriguez")
            == scrape._fold_title("UFC Fight Night: Medic vs. Rodriguez"))
    assert scrape._fold_title("UFC 329") != scrape._fold_title("UFC 330")


def test_pick_search_title_matches_only_the_same_event():
    titles = ["UFC Fight Night: Medić vs. Rodriguez",
              "UFC Fight Night: Ankalaev vs. Guskov",
              "Uroš Medić"]
    assert (scrape._pick_search_title("UFC Fight Night: Medic vs. Rodriguez", titles)
            == "UFC Fight Night: Medić vs. Rodriguez")
    assert scrape._pick_search_title("UFC Fight Night: Gamrot vs. Salkilld", titles) == ""


def test_fetch_event_wikitext_falls_back_to_searched_slug(monkeypatch):
    # Direct (ASCII-derived) slug misses; the search-resolved slug must be fetched.
    fetched = []

    def fake_fetch(slug):
        fetched.append(slug)
        return "{{MMAevent}}" * 30 if "Medić" in slug else ""

    monkeypatch.setattr(scrape, "fetch_wikitext", fake_fetch)
    monkeypatch.setattr(scrape, "search_event_slug",
                        lambda name: "UFC_Fight_Night:_Medić_vs._Rodriguez")
    wt = scrape.fetch_event_wikitext(
        "UFC Fight Night: Medic vs. Rodriguez",
        "UFC_Fight_Night:_Medic_vs._Rodriguez")
    assert wt
    assert fetched == ["UFC_Fight_Night:_Medic_vs._Rodriguez",
                       "UFC_Fight_Night:_Medić_vs._Rodriguez"]


def test_fetch_event_wikitext_skips_search_when_direct_slug_works(monkeypatch):
    monkeypatch.setattr(scrape, "fetch_wikitext", lambda slug: "x" * 300)

    def boom(name):
        raise AssertionError("search should not run when the direct fetch works")

    monkeypatch.setattr(scrape, "search_event_slug", boom)
    assert scrape.fetch_event_wikitext("UFC 330", "UFC_330")


def test_search_event_slug_parses_both_api_shapes(monkeypatch):
    class FakeResp:
        status_code = 200
        def __init__(self, payload):
            self._payload = payload
        def json(self):
            return self._payload

    # opensearch finds nothing useful; full-text search has the real title.
    def fake_get(url, label="", headers=None, params=None, timeout=0, **kw):
        if params.get("action") == "opensearch":
            return FakeResp([params["search"], [], [], []])
        return FakeResp({"query": {"search": [
            {"title": "Uroš Medić"},
            {"title": "UFC Fight Night: Medić vs. Rodriguez"},
        ]}})

    monkeypatch.setattr(scrape, "get_with_retry", fake_get)
    monkeypatch.setattr(scrape.time, "sleep", lambda s: None)
    scrape._event_slug_cache.clear()
    assert (scrape.search_event_slug("UFC Fight Night: Medic vs. Rodriguez")
            == "UFC_Fight_Night:_Medić_vs._Rodriguez")
    # Result is cached — a second call must not re-hit the network.
    monkeypatch.setattr(scrape, "get_with_retry",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("cached")))
    assert (scrape.search_event_slug("UFC Fight Night: Medic vs. Rodriguez")
            == "UFC_Fight_Night:_Medić_vs._Rodriguez")
    scrape._event_slug_cache.clear()


# --- slug persistence (data.js round-trip) ----------------------------------

def _one_event(slug=None):
    ev = {"name": "UFC Fight Night: Medic vs. Rodriguez", "date": "2026-08-01",
          "venue": "Belgrade Arena", "loc": "Belgrade", "tv": "Paramount+",
          "time": "14:00", "prelimTime": "11:00", "fights": []}
    if slug:
        ev["slug"] = slug
    return ev


def test_events_js_slug_roundtrips_through_slug_map():
    js = "var EVENTS=" + scrape.events_js(
        [_one_event(slug="UFC_Fight_Night:_Medić_vs._Rodriguez")]) + ";\n"
    # Written form must be pure ASCII (json.dumps escapes the ć)...
    assert js == js.encode("ascii", "ignore").decode()
    # ...and the reader must decode it back to the real title.
    got = scrape._event_slug_map(js)
    assert got[("UFC Fight Night: Medic vs. Rodriguez", "2026-08-01")] \
        == "UFC_Fight_Night:_Medić_vs._Rodriguez"


def test_events_js_without_slug_yields_empty_map():
    js = "var EVENTS=" + scrape.events_js([_one_event()]) + ";\n"
    assert scrape._event_slug_map(js) == {}


def test_extract_recent_past_events_prefers_stored_slug():
    now = datetime(2026, 8, 1, 20, 0, tzinfo=timezone.utc)
    js = "var EVENTS=" + scrape.events_js(
        [_one_event(slug="UFC_Fight_Night:_Medić_vs._Rodriguez")]) + ";\n"
    got = scrape.extract_recent_past_events(js, now, set())
    assert len(got) == 1
    ev_date, slug, ev_name, venue, loc = got[0]
    assert slug == "UFC_Fight_Night:_Medić_vs._Rodriguez"
    assert (ev_date, ev_name, venue, loc) \
        == ("2026-08-01", "UFC Fight Night: Medic vs. Rodriguez",
            "Belgrade Arena", "Belgrade")


def test_extract_recent_past_events_falls_back_to_name_slug():
    now = datetime(2026, 8, 1, 20, 0, tzinfo=timezone.utc)
    js = "var EVENTS=" + scrape.events_js([_one_event()]) + ";\n"
    got = scrape.extract_recent_past_events(js, now, set())
    assert got[0][1] == "UFC_Fight_Night:_Medic_vs._Rodriguez"


def test_slug_line_does_not_break_existing_card_extraction():
    ev = _one_event(slug="UFC_Fight_Night:_Medić_vs._Rodriguez")
    ev["fights"] = [{"label": "Main Event", "wc": "Welterweight", "title": False,
                     "rematch": False, "odds": None, "winner": "", "method": "",
                     "round": None, "state": "pre",
                     "f1": {"name": "Uros Medic", "record": "", "ranking": ""},
                     "f2": {"name": "Daniel Rodriguez", "record": "", "ranking": ""}}]
    js = "var EVENTS=" + scrape.events_js([ev]) + ";\n"
    cards = scrape._extract_existing_cards(js)
    key = ("UFC Fight Night: Medic vs. Rodriguez", "2026-08-01")
    assert key in cards and len(cards[key]) == 1


# --- regional fallback start times (international cards, ESPN miss) ---------

def test_missing_north_american_cities_get_fixed_slots():
    # Glendale (AZ) and Edmonton were mis-classified as international, leaving
    # Glendale at TBD and letting a bogus ESPN time through for Edmonton.
    assert scrape._default_main_time("Glendale", "UFC Fight Night 288") == "20:00"
    assert scrape._default_main_time("Edmonton", "UFC Fight Night: B vs. M") == "20:00"
    assert scrape._default_prelim_time("Edmonton", "UFC Fight Night: B vs. M") == "17:00"


def test_regional_default_times_by_region():
    assert scrape._regional_default_times("Belgrade") == ("europe", "15:00", "12:00")
    assert scrape._regional_default_times("Abu Dhabi") == ("mideast", "14:00", "11:00")
    assert scrape._regional_default_times("Shanghai") == ("asia", "06:00", "03:00")
    assert scrape._regional_default_times("Perth") == ("oceania", "22:00", "19:00")
    assert scrape._regional_default_times("Rio de Janeiro") == ("latam", "20:00", "17:00")
    assert scrape._regional_default_times("Atlantis") == ("", "TBD", "TBD")


def test_resolve_times_regional_fallback_when_espn_misses(monkeypatch):
    # The Belgrade case: international card, ESPN has nothing -> regional slot,
    # never TBD.
    monkeypatch.setattr(scrape, "fetch_espn_times", lambda n, d: (None, None))
    assert scrape.resolve_event_times(
        "UFC Fight Night: Medic vs. Rodriguez", "2026-08-01",
        "TBD", "TBD", loc="Belgrade") == ("15:00", "12:00")


def test_resolve_times_espn_still_beats_regional_default(monkeypatch):
    """ESPN remains the primary source for international cards — the regional
    slot is a coarse fallback, not a replacement.

    The ESPN value here used to be ("12:00", "09:00"), which is 3h off the
    europe slot: that is now deliberately rejected as ESPN reporting an earlier
    segment (see test_resolve_times_rejects_espn_three_hours_off_the_regional_slot,
    the Paris regression). Precedence is unchanged for any time ESPN could
    plausibly mean as a main card, which is what this asserts.
    """
    monkeypatch.setattr(scrape, "fetch_espn_times", lambda n, d: ("14:00", "11:00"))
    assert scrape.resolve_event_times(
        "UFC Fight Night: Medic vs. Rodriguez", "2026-08-01",
        "TBD", "TBD", loc="Belgrade") == ("14:00", "11:00")


def test_resolve_times_unknown_international_loc_stays_tbd(monkeypatch):
    monkeypatch.setattr(scrape, "fetch_espn_times", lambda n, d: (None, None))
    assert scrape.resolve_event_times(
        "UFC Fight Night: Foo vs. Bar", "2026-06-27",
        "TBD", "TBD", loc="Atlantis") == ("TBD", "TBD")


def test_implausible_time_warning_skips_oceania_and_latam(capsys):
    # Sat 22:00 ET is Sunday morning local in Perth — expected, not an error.
    scrape._warn_if_implausible_time("UFC Fight Night: A vs. B", "Perth", "22:00")
    scrape._warn_if_implausible_time("UFC Fight Night: C vs. D", "Rio de Janeiro", "20:00")
    assert "WARNING" not in capsys.readouterr().err
    # An eastward region at 17:00+ ET still warns.
    scrape._warn_if_implausible_time("UFC Fight Night: E vs. F", "Belgrade", "18:00")
    assert "WARNING" in capsys.readouterr().err


# --- Odds API budget (should_fetch_odds) -----------------------------------
#
# The 5-minute fight-window cadence used to pull odds on every invocation, which
# burned ~1,200 API calls/month against a 500/month quota. Once the quota died,
# every call returned non-200 and get_odds_with_fallback silently reused the last
# good lines — the Aug 8 card showed Aug 1 odds for six days.

def test_odds_interval_tightens_as_the_card_approaches():
    f = scrape.odds_min_interval_hours
    assert f(0) == 3        # card today — lines all but closed
    assert f(1) == 2
    assert f(2) == 2
    assert f(5) == 6
    assert f(7) == 6
    assert f(20) == 24


def test_odds_not_pulled_for_cards_out_of_range():
    f = scrape.odds_min_interval_hours
    assert f(None) is None
    assert f(-1) is None                       # everything already past
    assert f(scrape.ODDS_PULL_MAX_DAYS_OUT + 1) is None


def test_should_fetch_odds_respects_the_interval():
    now = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc)
    # 1 day out → 2h interval.
    assert scrape.should_fetch_odds(now, "2026-08-07T11:59:00+00:00", 1) is False
    assert scrape.should_fetch_odds(now, "2026-08-07T09:00:00+00:00", 1) is True
    # A first-ever run has no previous pull to wait on.
    assert scrape.should_fetch_odds(now, None, 1) is True
    # No card in range → never spend a call.
    assert scrape.should_fetch_odds(now, None, 400) is False


def test_should_fetch_odds_suppresses_the_five_minute_cadence():
    # The exact regression: consecutive 5-minute fight-window runs must not each
    # spend two API calls.
    now = datetime(2026, 8, 8, 20, 0, tzinfo=timezone.utc)
    last = "2026-08-08T19:55:00+00:00"
    assert scrape.should_fetch_odds(now, last, 0) is False


def test_odds_force_env_overrides_the_budget(monkeypatch):
    monkeypatch.setenv("ODDS_FORCE", "1")
    now = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc)
    assert scrape.should_fetch_odds(now, "2026-08-07T11:59:00+00:00", 1) is True


# --- Odds API budget: activity backoff (#73) -------------------------------
#
# Proximity alone kept polling a card whose lines had not moved in days, which is
# how the quota died with five events still awaiting-card. Each unchanged pull
# now doubles the wait; one moved number puts it straight back on the proximity
# cadence.

def test_activity_multiplier_doubles_per_idle_pull_then_caps():
    f = scrape.odds_activity_multiplier
    assert f(0) == 1
    assert f(1) == 2
    assert f(2) == 4
    assert f(3) == 4                       # capped — a quiet market is when a
    assert f(99) == 4                      # late move matters most
    assert scrape.ODDS_IDLE_BACKOFF_MAX == 4


def test_activity_multiplier_ignores_junk_state():
    # odds-state.json is written by an earlier run; a missing or corrupt field
    # must degrade to the plain proximity cadence, never to a crash.
    f = scrape.odds_activity_multiplier
    assert f(None) == 1
    assert f("") == 1
    assert f("three") == 1
    assert f(-2) == 1


def test_idle_backoff_stretches_the_interval():
    now = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc)
    # 1 day out → 2h base. Three hours since the last pull.
    last = "2026-08-07T09:00:00+00:00"
    assert scrape.should_fetch_odds(now, last, 1, 0) is True     # 2h — due
    assert scrape.should_fetch_odds(now, last, 1, 1) is False    # 4h — not yet
    assert scrape.should_fetch_odds(now, last, 1, 2) is False    # 8h
    # Far enough back and even the capped backoff is due.
    assert scrape.should_fetch_odds(now, "2026-08-06T12:00:00+00:00", 1, 9) is True


def test_backoff_never_resurrects_an_out_of_range_card():
    now = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc)
    assert scrape.should_fetch_odds(now, None, 400, 0) is False
    assert scrape.should_fetch_odds(now, None, 400, 3) is False


def test_lines_digest_tracks_prices_not_sources():
    a = {("jones", "miocic"): {"f1_odds": -150, "f2_odds": 130, "source": "us"}}
    b = {("jones", "miocic"): {"f1_odds": -150, "f2_odds": 130, "source": "uk"}}
    c = {("jones", "miocic"): {"f1_odds": -160, "f2_odds": 140, "source": "us"}}
    # The fallback chain covering a bout from a different book is not a line move.
    assert scrape.odds_lines_digest(a) == scrape.odds_lines_digest(b)
    assert scrape.odds_lines_digest(a) != scrape.odds_lines_digest(c)
    # An empty index is a FAILED pull, not a quiet market.
    assert scrape.odds_lines_digest({}) is None


def test_failed_pull_does_not_count_as_a_quiet_market():
    # The exact trap: odds-state.json currently records last_status 401. If a dead
    # key counted as "nothing moved", the cadence would back off to its cap and
    # the outage would get quieter the longer it lasted.
    assert scrape.next_idle_pulls(2, "abc", None) == 2
    assert scrape.next_idle_pulls(0, None, None) == 0


def test_idle_pulls_increments_on_repeat_and_resets_on_movement():
    assert scrape.next_idle_pulls(0, "abc", "abc") == 1
    assert scrape.next_idle_pulls(1, "abc", "abc") == 2
    assert scrape.next_idle_pulls(3, "abc", "xyz") == 0     # market moved
    assert scrape.next_idle_pulls(3, None, "abc") == 0      # first-ever pull
    assert scrape.next_idle_pulls("junk", "abc", "abc") == 1


def test_next_event_days_out_picks_the_soonest_future_card():
    now = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc)
    data = 'date:"2026-07-11" date:"2026-08-08" date:"2026-09-19"'
    assert scrape._next_event_days_out(data, now) == 1
    assert scrape._next_event_days_out('date:"2026-07-11"', now) is None
    assert scrape._next_event_days_out("no dates here", now) is None


# --- urgent stats refetch --------------------------------------------------

def test_failed_lookup_retries_immediately_for_an_imminent_card():
    # Ferreira and Jose Luiz both failed on Aug 6 for an Aug 8 card. The flat
    # 3-day cooldown ran to Aug 9, so a blank record was guaranteed through the
    # event. Proximity has to beat the cooldown.
    now = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc)
    entry = {"fetch_failed": "2026-08-06T11:00:00+00:00"}
    assert scrape._needs_stats_fetch(entry, now) == (False, False)          # far card
    assert scrape._needs_stats_fetch(entry, now, urgent=True) == (True, True)


def test_urgent_refetch_also_repairs_a_blank_record():
    now = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc)
    entry = {"rec": "", "form": [], "opp": [], "fetched_at": "2026-08-07T00:00:00+00:00"}
    assert scrape._needs_stats_fetch(entry, now) == (False, False)
    assert scrape._needs_stats_fetch(entry, now, urgent=True) == (True, True)


def test_urgent_does_not_refetch_a_complete_fresh_entry():
    # Urgency must not turn every run into a full re-scrape of the whole card.
    now = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc)
    entry = {"rec": "10-0-0", "form": [{"r": "W"}], "opp": ["X"],
             "fetched_at": "2026-08-07T00:00:00+00:00"}
    assert scrape._needs_stats_fetch(entry, now, urgent=True) == (False, False)


# --- results archive carries bout labels -----------------------------------
#
# EVENTS only holds 30 days, so once a card ages out the archive is the only
# record of it. Without the label the frontend cannot tell a main-card pick from
# a prelim, which is what the leaderboard's main-card scope scores on.

def _archive_of(js):
    m = re.search(r"var RESULTS_ARCHIVE=(\{.*?\});", js, re.DOTALL)
    return json.loads(m.group(1))


def test_results_archive_records_the_bout_label():
    data = (
        'var RESULTS_ARCHIVE={};\n'
        'var EVENTS=[\n'
        '  {\n    name:"UFC Fight Night: A vs. B",\n    date:"2026-01-03",\n'
        '    venue:"Apex",\n    loc:"Las Vegas",\n    fights:[\n'
        '      {lbl:"Main Event",wc:"Lightweight",title:false,rematch:false,odds:null,'
        'winner:"A",method:"KO/TKO",round:1,state:"post",'
        'f1:{n:"A",r:"1-0-0",rk:"",s:null},f2:{n:"B",r:"0-1-0",rk:"",s:null}},\n'
        '      {lbl:"Prelim",wc:"Lightweight",title:false,rematch:false,odds:null,'
        'winner:"C",method:"Decision",round:3,state:"post",'
        'f1:{n:"C",r:"1-0-0",rk:"",s:null},f2:{n:"D",r:"0-1-0",rk:"",s:null}}\n'
        '    ]\n  }\n];\n'
    )
    out = scrape.update_results_archive(data, datetime(2026, 6, 1, tzinfo=timezone.utc))
    fights = _archive_of(out)["2026-01-03"]["fights"]
    assert [f["lbl"] for f in fights] == ["Main Event", "Prelim"]
    # The existing fields must survive the regex change that added lbl.
    assert fights[0] == {"f1": "A", "f2": "B", "winner": "A",
                         "method": "KO/TKO", "lbl": "Main Event"}


def test_results_archive_keeps_bouts_in_card_order():
    # The frontend falls back to bout ORDER for entries written before labels
    # existed (index < 5 == main card). That only holds if the archive preserves
    # the main-event-first ordering of the EVENTS block.
    bouts = []
    for i, lbl in enumerate(["Main Event", "Co-Main", "Main Card", "Prelim"]):
        bouts.append(
            f'      {{lbl:"{lbl}",wc:"Lightweight",title:false,rematch:false,odds:null,'
            f'winner:"W{i}",method:"Decision",round:3,state:"post",'
            f'f1:{{n:"W{i}",r:"1-0-0",rk:"",s:null}},f2:{{n:"L{i}",r:"0-1-0",rk:"",s:null}}}}'
        )
    data = ('var RESULTS_ARCHIVE={};\nvar EVENTS=[\n'
            '  {\n    name:"UFC 300: X vs. Y",\n    date:"2026-01-03",\n'
            '    venue:"Apex",\n    loc:"Las Vegas",\n    fights:[\n'
            + ",\n".join(bouts) + "\n    ]\n  }\n];\n")
    out = scrape.update_results_archive(data, datetime(2026, 6, 1, tzinfo=timezone.utc))
    fights = _archive_of(out)["2026-01-03"]["fights"]
    assert [f["f1"] for f in fights] == ["W0", "W1", "W2", "W3"]
    assert [f["lbl"] for f in fights] == ["Main Event", "Co-Main", "Main Card", "Prelim"]


# --- start-time sanity: ESPN vs the regional slot ---------------------------
#
# ESPN's scoreboard `date` has meant different segments on different cards, and
# every time it meant "prelims" the dashboard shipped a card three hours early
# (Paris and Shanghai both did). These pin the clamp that catches that class of
# error without a manual override.

def test_hours_apart_is_circular_across_midnight():
    assert scrape._hours_apart("15:00", "12:00") == 3
    assert scrape._hours_apart("12:00", "15:00") == 3
    assert scrape._hours_apart("23:00", "01:00") == 2   # not 22
    assert scrape._hours_apart("00:30", "23:30") == 1
    assert scrape._hours_apart("bogus", "12:00") is None


def test_espn_agrees_with_region_tolerates_small_gaps_only():
    assert scrape.espn_agrees_with_region("15:00", "15:00")
    assert scrape.espn_agrees_with_region("13:00", "15:00")   # 2h — allowed
    assert not scrape.espn_agrees_with_region("12:00", "15:00")  # 3h — a segment
    # No regional slot to compare against → believe ESPN over a "TBD".
    assert scrape.espn_agrees_with_region("12:00", "TBD")
    assert scrape.espn_agrees_with_region("12:00", "")


def test_resolve_times_rejects_espn_three_hours_off_the_regional_slot(monkeypatch):
    """The Paris regression: ESPN reported the prelim start (12:00 ET) as the
    main card, and the derived prelim went to 09:00 — both 3h early."""
    monkeypatch.setattr(scrape, "fetch_espn_times", lambda n, d: ("12:00", "09:00"))
    assert scrape.resolve_event_times(
        "UFC Fight Night: Someone vs. Other", "2026-09-05", "TBD", "TBD",
        loc="Paris") == ("15:00", "12:00")


def test_resolve_times_rejects_espn_three_hours_off_in_asia(monkeypatch):
    """Same failure in Shanghai: ESPN's 03:00 was the stream start."""
    monkeypatch.setattr(scrape, "fetch_espn_times", lambda n, d: ("03:00", "00:00"))
    assert scrape.resolve_event_times(
        "UFC Fight Night: Someone vs. Other", "2026-08-29", "TBD", "TBD",
        loc="Shanghai") == ("06:00", "03:00")


def test_resolve_times_keeps_espn_when_it_agrees_with_the_region(monkeypatch):
    """ESPN stays the primary source — the clamp must not flatten every
    international card onto the coarse regional slot."""
    monkeypatch.setattr(scrape, "fetch_espn_times", lambda n, d: ("16:00", "13:00"))
    assert scrape.resolve_event_times(
        "UFC Fight Night: Someone vs. Other", "2026-09-05", "TBD", "TBD",
        loc="Paris") == ("16:00", "13:00")


def test_resolve_times_keeps_espn_for_a_region_with_no_slot(monkeypatch):
    """An unmapped location has nothing to clamp against; ESPN beats TBD."""
    monkeypatch.setattr(scrape, "fetch_espn_times", lambda n, d: ("11:00", "08:00"))
    assert scrape.resolve_event_times(
        "UFC Fight Night: Someone vs. Other", "2026-09-05", "TBD", "TBD",
        loc="Reykjavik") == ("11:00", "08:00")


def test_paris_2026_override_pins_the_published_times():
    assert scrape._event_times(
        "UFC Fight Night: Hooker vs. Parnasse", "Paris") == ("15:00", "12:00")


# --- start-time cross-check: the odds feed's commence_time -----------------

def _odds_payload(commence, home, away):
    return [{
        "home_team": home, "away_team": away, "commence_time": commence,
        "bookmakers": [{"key": "fanduel", "markets": [{"key": "h2h", "outcomes": [
            {"name": home, "price": -150}, {"name": away, "price": 130}]}]}],
    }]


def test_index_odds_api_keeps_commence_time():
    idx = scrape._index_odds_api(
        _odds_payload("2026-09-05T16:00:00Z", "Dan Hooker", "Salahdine Parnasse"), "t")
    entry = next(iter(idx.values()))
    assert entry["commence_time"] == "2026-09-05T16:00:00Z"


def test_odds_card_start_et_takes_the_earliest_bout_on_the_date():
    idx = {}
    idx.update(scrape._index_odds_api(
        _odds_payload("2026-09-05T19:00:00Z", "Dan Hooker", "Salahdine Parnasse"), "t"))
    idx.update(scrape._index_odds_api(
        _odds_payload("2026-09-05T16:00:00Z", "Fares Ziam", "Axel Sola"), "t"))
    card = [
        {"f1": {"name": "Dan Hooker"}, "f2": {"name": "Salahdine Parnasse"}},
        {"f1": {"name": "Fares Ziam"}, "f2": {"name": "Axel Sola"}},
    ]
    # 16:00Z = 12:00 ET (EDT) — the first prelim, not the 15:00 ET main event.
    assert scrape.odds_card_start_et(idx, card, "2026-09-05") == "12:00"


def test_odds_card_start_et_ignores_bouts_from_another_date():
    idx = scrape._index_odds_api(
        _odds_payload("2026-09-12T16:00:00Z", "Fares Ziam", "Axel Sola"), "t")
    card = [{"f1": {"name": "Fares Ziam"}, "f2": {"name": "Axel Sola"}}]
    assert scrape.odds_card_start_et(idx, card, "2026-09-05") == ""


def test_odds_card_start_et_empty_without_a_match():
    assert scrape.odds_card_start_et({}, [
        {"f1": {"name": "Dan Hooker"}, "f2": {"name": "Salahdine Parnasse"}}], "2026-09-05") == ""


def test_reconcile_keeps_an_anchored_time_even_when_odds_disagree():
    """A venue with a real slot behind it is not overruled by commence_time —
    bookmakers stamp nominal starts, and the slot is deterministic."""
    assert scrape.reconcile_times_with_odds(
        "ev", "Paris", "15:00", "12:00", "09:00") == ("15:00", "12:00")
    assert scrape.reconcile_times_with_odds(
        "ev", "Las Vegas", "20:00", "17:00", "13:00") == ("20:00", "17:00")


def test_reconcile_corrects_an_unanchored_time_from_the_odds_feed():
    """The UFC 331 hole: a venue in no region has nothing checking ESPN, so a
    second independent source wins."""
    assert scrape.reconcile_times_with_odds(
        "UFC Fight Night: A vs. B", "Atlantis", "17:00", "15:00", "19:00"
    ) == ("22:00", "19:00")          # Fight Night → 3h main-card offset


def test_reconcile_uses_the_ppv_offset_when_correcting():
    assert scrape.reconcile_times_with_odds(
        "UFC 340: A vs. B", "Atlantis", "17:00", "15:00", "19:00"
    ) == ("21:00", "19:00")          # PPV → 2h offset


def test_reconcile_is_a_noop_within_tolerance_or_without_data():
    same = ("20:00", "17:00")
    assert scrape.reconcile_times_with_odds("ev", "Atlantis", *same, "18:00") == same
    assert scrape.reconcile_times_with_odds("ev", "Atlantis", *same, "17:00") == same
    assert scrape.reconcile_times_with_odds("ev", "Atlantis", *same, "") == same
    assert scrape.reconcile_times_with_odds(
        "ev", "Atlantis", "TBD", "TBD", "19:00") == ("TBD", "TBD")


def test_shift_hhmm_wraps_at_midnight():
    assert scrape._shift_hhmm("19:00", 2) == "21:00"
    assert scrape._shift_hhmm("23:30", 3) == "02:30"


# --- venue anchoring -------------------------------------------------------

def test_los_angeles_is_recognised_as_a_us_venue():
    """UFC 331 shipped 4h early because "Los Angeles" was missing and data.js
    stores a bare city, so the "California" alternative never matched."""
    assert scrape.classify_region("Los Angeles") == "us"
    assert scrape._event_times("UFC 331: Van vs. Pantoja 2", "Los Angeles") == \
        ("21:00", "19:00")


def test_classify_region_labels_each_slot_family():
    assert scrape.classify_region("Las Vegas") == "us"
    assert scrape.classify_region("Edmonton") == "us"      # Canada shares the ET slots
    assert scrape.classify_region("Paris") == "europe"
    assert scrape.classify_region("Shanghai") == "asia"
    assert scrape.classify_region("Abu Dhabi") == "mideast"
    # The dangerous case: anchored to nothing.
    assert scrape.classify_region("Atlantis") == ""
    assert scrape.classify_region("") == ""


# --- odds provider failover + per-provider quota (#94) ---------------------
#
# The failure this guards: the metered chain shares one monthly budget, so when
# it ran out, announced cards with a dozen parsed bouts sat odds-unavailable for
# days. The fallback only helps if a spent provider is actually skipped and the
# unmetered one still runs.

NOW_94 = datetime(2026, 9, 6, 12, 0, tzinfo=timezone.utc)


def _espn_payload(f1, f2, home_ml, away_ml, date="2026-09-12T23:00Z"):
    return {"events": [{"date": date, "competitions": [{
        "date": date,
        "competitors": [
            {"homeAway": "home", "athlete": {"displayName": f1}},
            {"homeAway": "away", "athlete": {"displayName": f2}},
        ],
        "odds": [{"provider": {"name": "ESPN BET"},
                  "homeTeamOdds": {"moneyLine": home_ml},
                  "awayTeamOdds": {"moneyLine": away_ml}}],
    }]}]}


def test_index_espn_odds_reads_a_moneyline_pair():
    idx = scrape._index_espn_odds(_espn_payload("Max Holloway", "Justin Gaethje", -150, 130))
    assert scrape.get_odds(idx, "Max Holloway", "Justin Gaethje") == {"f1": -150, "f2": 130}
    assert scrape.odds_source(idx, "Max Holloway", "Justin Gaethje") == "espn"


def test_index_espn_odds_tolerates_the_alternate_payload_shapes():
    # ESPN has shipped the price as a string and nested under `current`. Both
    # must read, because a shape change that throws would take the whole
    # unmetered fallback down with it.
    assert scrape._espn_moneyline({"moneyLine": "-165"}) == -165
    assert scrape._espn_moneyline({"current": {"moneyLine": {"american": "+140"}}}) == 140
    assert scrape._espn_moneyline({"moneyLine": None}) is None
    assert scrape._espn_moneyline({}) is None
    assert scrape._espn_moneyline("nonsense") is None


def test_index_espn_odds_drops_implausible_and_incomplete_bouts():
    # One-sided payload → no entry at all; a junk pair is rejected rather than
    # shipped, same bar the metered sources are held to.
    assert scrape._index_espn_odds(_espn_payload("A Fighter", "B Fighter", -150, None)) == {}
    # Both sides priced as dogs: implied total under 100%, so the pair is corrupt.
    assert scrape._index_espn_odds(_espn_payload("A Fighter", "B Fighter", 200, 200)) == {}
    assert scrape._index_espn_odds({}) == {}
    assert scrape._index_espn_odds({"events": [{"competitions": [{}]}]}) == {}


def test_quota_exhausted_distinguishes_a_spent_budget_from_a_bad_key():
    assert scrape.quota_exhausted({"last_status": 401, "requests_remaining": 0}) is True
    assert scrape.quota_exhausted({"last_status": 429}) is True
    # A rejected key with quota left never self-heals — keep calling it so the
    # outage stays loud instead of being silently skipped.
    assert scrape.quota_exhausted({"last_status": 401, "requests_remaining": 120}) is False
    assert scrape.quota_exhausted({}) is False


def test_quota_blocked_expires_on_cooldown_and_on_the_month_reset():
    spent = {"requests_remaining": 0, "last_status": 401,
             "exhausted_at": "2026-09-06T06:00:00+00:00"}
    assert scrape.quota_blocked(spent, NOW_94) is True
    assert scrape.quota_blocked(spent, NOW_94 + timedelta(hours=13)) is False
    # The Odds API resets monthly: a new month unblocks it whatever the timer says.
    assert scrape.quota_blocked(spent, datetime(2026, 10, 1, 0, 30, tzinfo=timezone.utc)) is False
    # An exhaustion with no timestamp (older state file) is probed, not muted.
    assert scrape.quota_blocked({"requests_remaining": 0}, NOW_94) is False


def test_select_odds_providers_skips_the_spent_budget_but_keeps_the_free_one():
    metered  = scrape.OddsProvider("paid", lambda: {}, quota="paid")
    sibling  = scrape.OddsProvider("paid-2", lambda: {}, quota="paid")   # same budget
    free     = scrape.OddsProvider("espn", lambda: {}, quota="espn", metered=False)
    state = {"providers": {"paid": {"requests_remaining": 0, "last_status": 401,
                                    "exhausted_at": "2026-09-06T06:00:00+00:00"}}}
    picked = scrape.select_odds_providers([metered, sibling, free], state, NOW_94)
    assert [p.name for p in picked] == ["espn"]
    # With budget left, the whole chain runs.
    state["providers"]["paid"] = {"requests_remaining": 300, "last_status": 200}
    picked = scrape.select_odds_providers([metered, sibling, free], state, NOW_94)
    assert [p.name for p in picked] == ["paid", "paid-2", "espn"]


def test_fetch_odds_prices_the_card_from_the_free_source_when_the_budget_is_spent():
    # The #94 scenario end to end: the paid provider is skipped entirely (not
    # even called), and the card still gets lines.
    calls = []

    def paid():
        calls.append("paid")
        return {}

    espn = lambda: _entry("Ilia Topuria", "Arman Tsarukyan", -180, 155, "espn")
    providers = [
        scrape.OddsProvider("paid", paid, quota="the-odds-api"),
        scrape.OddsProvider("espn", espn, quota="espn", metered=False),
    ]
    state = {"providers": {"the-odds-api": {
        "requests_remaining": 0, "last_status": 401,
        "exhausted_at": "2026-09-06T06:00:00+00:00"}}}
    idx = scrape.fetch_odds(sources=providers, state=state, now=NOW_94)
    assert calls == []
    assert scrape.get_odds(idx, "Ilia Topuria", "Arman Tsarukyan") == {"f1": -180, "f2": 155}
    assert scrape.odds_source(idx, "Ilia Topuria", "Arman Tsarukyan") == "espn"


def test_record_provider_state_stamps_and_clears_exhaustion():
    state = {}
    scrape.record_provider_state(
        state, NOW_94,
        stats={"the-odds-api": {"provider": "the-odds-api:primary",
                                "last_status": 401, "requests_remaining": 0}})
    entry = state["providers"]["the-odds-api"]
    assert entry["exhausted_at"] == NOW_94.isoformat()
    # A later run with quota back clears the block, so the skip self-heals.
    scrape.record_provider_state(
        state, NOW_94 + timedelta(days=1),
        stats={"the-odds-api": {"last_status": 200, "requests_remaining": 480, "bouts": 12}})
    entry = state["providers"]["the-odds-api"]
    assert "exhausted_at" not in entry
    assert entry["last_ok_at"] == (NOW_94 + timedelta(days=1)).isoformat()


def test_backup_key_provider_is_a_no_op_without_a_second_key(monkeypatch):
    monkeypatch.setattr(scrape, "ODDS_API_KEY_SECONDARY", "")
    assert scrape.fetch_odds_backup_key() == {}


def test_espn_windows_lead_with_one_range_query():
    windows = scrape.espn_odds_windows(NOW_94, days_ahead=14)
    assert windows[0] == "20260906-20260920"
    assert all(w.isdigit() for w in windows[1:])
    assert len(windows) <= 9


# --- same-name fighter disambiguation --------------------------------------
#
# UFCStats files several fighters under one name and the scraper has to pick.
# The old rule ("most total fights") picked the retired journeyman every time a
# prospect shared his name: Petr Yan resolved to an 11-13 fighter born in 1980
# and Jean Silva to a 48-year-old with one UFC bout. Nothing errored — a wrong
# but plausible record went onto a live card and into the fight model.

def test_ufcstats_dates_parse_in_both_formats_the_site_uses():
    assert scrape.parse_ufcstats_date("UFC 300: Pereira vs. Hill Apr. 13, 2024") == date(2024, 4, 13)
    assert scrape.parse_ufcstats_date("September 5, 2026") == date(2026, 9, 5)
    assert scrape.parse_ufcstats_date("no date at all") is None
    assert scrape.parse_ufcstats_date("Smarch 40, 2026") is None
    assert scrape.parse_ufcstats_date(None) is None


def test_the_recently_active_fighter_wins_over_the_bigger_record():
    # The real case: a 15-2 prospect fighting this year against a 19-12-3
    # namesake who last fought in 2012.
    prospect, veteran = ("/prospect", 15, 2, 0), ("/veteran", 19, 12, 3)
    ordered = scrape.order_ufcstats_matches(
        [veteran, prospect],
        {"/veteran": date(2012, 5, 1), "/prospect": date(2026, 8, 1)})
    assert ordered[0] == prospect


def test_an_undateable_candidate_never_outranks_a_dated_one():
    # A page we couldn't read tells us nothing; it must not win on record size.
    big_unknown, small_active = ("/unknown", 30, 5, 0), ("/active", 8, 1, 0)
    ordered = scrape.order_ufcstats_matches(
        [big_unknown, small_active],
        {"/unknown": None, "/active": date(2026, 6, 1)})
    assert ordered[0] == small_active


def test_with_no_dates_at_all_it_falls_back_to_the_old_experience_rule():
    # UFCStats unreachable for every candidate: keep the previous behaviour
    # rather than picking arbitrarily.
    a, b = ("/a", 19, 12, 3), ("/b", 15, 2, 0)
    assert scrape.order_ufcstats_matches([b, a], {}) == [a, b]


def test_candidates_are_gathered_from_every_letter_page(monkeypatch):
    # The Petr Yan case. UFCStats lists the wrong namesake surname-first ("Yan
    # Petr"), which files him under P — and P is searched before Y, so the old
    # loop returned from the P page and never loaded Y at all. Only one candidate
    # was ever seen, which is why the recency tie-break didn't fire.
    pages = {
        "p": [("Yan", "Petr", "/namesake", 11, 13, 0)],       # surname-first row
        "y": [("Petr", "Yan", "/real", 17, 6, 0)],
    }
    monkeypatch.setattr(scrape, "_load_ufcstats_letter", lambda ch: pages.get(ch, []))
    monkeypatch.setattr(scrape, "_ufcstats_last_fight_date",
                        lambda url: date(2010, 1, 1) if url == "/namesake" else date(2026, 6, 7))
    assert scrape._search_ufcstats("Petr Yan") == ("/real", "17-6-0")


def test_a_fighter_listed_under_both_initials_is_not_double_counted(monkeypatch):
    same = ("Petr", "Yan", "/real", 17, 6, 0)
    monkeypatch.setattr(scrape, "_load_ufcstats_letter", lambda ch: [same])
    probed = []
    monkeypatch.setattr(scrape, "_ufcstats_last_fight_date",
                        lambda url: probed.append(url) or date(2026, 6, 7))
    assert scrape._search_ufcstats("Petr Yan") == ("/real", "17-6-0")
    # One candidate after de-duplication → no disambiguation fetches at all.
    assert probed == []


def test_a_name_that_isnt_there_returns_nothing_without_retrying(monkeypatch):
    calls = []
    monkeypatch.setattr(scrape, "_load_ufcstats_letter",
                        lambda ch: calls.append(ch) or [("Some", "Body", "/x", 1, 0, 0)])
    assert scrape._search_ufcstats("Nobody Here") is None
    # Pages loaded fine, so the empty-page retry must not fire: 2 letters, once.
    assert len(calls) == 2


def test_espn_payload_shape_counts_each_layer():
    # Which layer is empty decides the fix, so the counts are reported separately.
    payload = {"events": [
        {"competitions": [{"odds": [{"homeTeamOdds": {"moneyLine": -150}}]}, {}]},
        {"competitions": [{"odds": []}]},
    ]}
    assert scrape.espn_payload_shape(payload) == (2, 3, 1)
    assert scrape.espn_payload_shape({}) == (0, 0, 0)
    assert scrape.espn_payload_shape(None) == (0, 0, 0)
