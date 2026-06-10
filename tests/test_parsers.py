"""
Unit tests for the pure parsing/normalisation helpers in scrape.py.

These are the brittle, format-sensitive functions that silently break when
Wikipedia / the Odds API change shape. They make no network calls, so they run
fast in CI and act as a safety net before the scraper can overwrite data.js.

Run with:  python -m pytest -q
"""
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
