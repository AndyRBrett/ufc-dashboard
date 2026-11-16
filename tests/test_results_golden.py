"""scrape.py's results parser against the golden that results.js is held to.

Wikipedia results pages are read twice: by scrape.py, which writes data.js, and
by results.js, which the open app's live poll and the check-results backup both
run. The two can't share code across languages, so they share an answer key:
tests/fixtures/results/expected.json, the output for every input in cases.json
(real page layouts plus a seeded batch of random ones). This test holds the
Python side to it; `npm run check:results` holds results.js to the same file.
Before results.js existed, the app's copy disagreed with scrape.py on 36% of
the random pages and check-results' copy on 50% (draws, no contests, unclosed
templates, round cells, and the PPV article name).

A change to the parsing rules goes into scrape.py AND results.js, then:

    python tests/test_results_golden.py --update

and the expected.json diff belongs in the same commit, called out. Never
regenerate it to make a failing side pass.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import scrape  # noqa: E402

FIX = ROOT / "tests" / "fixtures" / "results"


def answers(cases):
    return {
        "pages": {k: scrape.parse_results(v) for k, v in sorted(cases["pages"].items())},
        "clean": [scrape.clean_wiki(a) for a, _ in cases["names"]],
        "names_match": [scrape.names_match(a, b) for a, b in cases["names"]],
        "names_match_clean": [scrape.names_match(scrape.clean_wiki(a), scrape.clean_wiki(b)) for a, b in cases["names"]],
        "last_name": [scrape.last_name(a) for a, _ in cases["names"]],
        "norm_method": [scrape.norm_method(m) for m in cases["methods"]],
        "event_slug": [scrape._wiki_event_slug(e) for e in cases["events"]],
    }


def load():
    cases = json.loads((FIX / "cases.json").read_text(encoding="utf-8"))
    expected = json.loads((FIX / "expected.json").read_text(encoding="utf-8"))
    return cases, expected


def test_scrape_reads_every_page_as_the_golden_says():
    cases, expected = load()
    got = answers(cases)
    wrong = [k for k in got["pages"] if got["pages"][k] != expected["pages"].get(k)]
    assert not wrong, f"scrape.parse_results disagrees with expected.json on: {wrong[:10]}"
    assert set(got["pages"]) == set(expected["pages"])
    for key in ("clean", "names_match", "names_match_clean", "last_name", "norm_method", "event_slug"):
        assert got[key] == expected[key], f"scrape.py's {key} disagrees with expected.json"


def test_the_golden_covers_what_it_is_for():
    # A golden of empty answers would pass both sides and prove nothing.
    _, expected = load()
    results = [r for rs in expected["pages"].values() for r in rs]
    assert len(results) >= 200
    assert sum(1 for r in results if r.get("undecided")) >= 15          # draws and no contests
    assert any(r["round"] is None for r in results) and any(r["round"] == 5 for r in results)
    for name in ("ppv_template", "draws_and_no_contests", "unclosed_template_name", "accented_names",
                 "results_wikitable_inline", "results_wikitable_lines", "wikitable_draw_and_nc"):
        assert expected["pages"][name], f"{name} reads as nothing"
    assert expected["pages"]["redirect_stub"] == [] and expected["pages"]["announced_card"] == []
    assert "UFC_334" in expected["event_slug"]


if __name__ == "__main__" and sys.argv[1:] == ["--update"]:
    cases, _ = load() if (FIX / "expected.json").exists() else (json.loads((FIX / "cases.json").read_text(encoding="utf-8")), None)
    (FIX / "expected.json").write_text(
        json.dumps(answers(cases), ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print("wrote", FIX / "expected.json")
