"""scrape.record_odds_lines: the side file that hands PFL/RIZIN/DWCS their lines.

It rides on the Odds API pull scrape.py already makes, so it must cost nothing
(no call), must never fail a data update, and must never empty itself: a spent
key returns an empty index, and a partial pull is missing bouts, not withdrawing
them.
"""
import json
from datetime import datetime, timezone

import scrape

NOW = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc)


def entry(a, b, ao, bo, when):
    return {"f1_name": a, "f2_name": b, "f1_odds": ao, "f2_odds": bo, "source": "t", "commence_time": when}


def index(*entries):
    return {tuple(sorted([e["f1_name"].lower(), e["f2_name"].lower()])): e for e in entries}


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))["lines"]


def test_a_pull_is_recorded(tmp_path):
    p = tmp_path / "lines.json"
    n = scrape.record_odds_lines(index(entry("A One", "B Two", -150, 130, "2026-09-30T00:00:00Z")), NOW, p)
    assert n == 1
    assert read(p)[0] == {"a": "A One", "b": "B Two", "a_odds": -150, "b_odds": 130,
                          "commence_time": "2026-09-30T00:00:00Z", "seen_at": "2026-09-29T12:00:00Z"}


def test_an_empty_pull_leaves_the_file_alone(tmp_path):
    p = tmp_path / "lines.json"
    scrape.record_odds_lines(index(entry("A One", "B Two", -150, 130, "2026-09-30T00:00:00Z")), NOW, p)
    before = p.read_text()
    assert scrape.record_odds_lines({}, NOW, p) == 0          # a spent key returns nothing
    assert p.read_text() == before


def test_a_partial_pull_keeps_the_bouts_it_did_not_return(tmp_path):
    p = tmp_path / "lines.json"
    scrape.record_odds_lines(index(entry("A One", "B Two", -150, 130, "2026-09-30T00:00:00Z"),
                                   entry("C Three", "D Four", 200, -240, "2026-09-30T01:00:00Z")), NOW, p)
    scrape.record_odds_lines(index(entry("A One", "B Two", -170, 145, "2026-09-30T00:00:00Z")), NOW, p)
    got = {l["a"]: l for l in read(p)}
    assert got["A One"]["a_odds"] == -170 and got["C Three"]["a_odds"] == 200


def test_an_unchanged_pull_writes_nothing(tmp_path):
    p = tmp_path / "lines.json"
    idx = index(entry("A One", "B Two", -150, 130, "2026-09-30T00:00:00Z"))
    scrape.record_odds_lines(idx, NOW, p)
    before = p.read_text()
    later = datetime(2026, 9, 29, 18, 0, tzinfo=timezone.utc)
    scrape.record_odds_lines(idx, later, p)                    # same lines, six hours on
    assert p.read_text() == before                             # seen_at kept: no commit for nothing


def test_old_bouts_are_pruned_three_days_after_they_began(tmp_path):
    p = tmp_path / "lines.json"
    scrape.record_odds_lines(index(entry("Old One", "Old Two", -150, 130, "2026-09-20T00:00:00Z"),
                                   entry("New One", "New Two", 150, -170, "2026-09-30T00:00:00Z"),
                                   entry("Recent One", "Recent Two", 110, -130, "2026-09-27T12:00:00Z")), NOW, p)
    assert sorted(l["a"] for l in read(p)) == ["New One", "Recent One"]


def test_a_corrupt_file_is_replaced_not_fatal(tmp_path):
    p = tmp_path / "lines.json"
    p.write_text("{not json")
    assert scrape.record_odds_lines(index(entry("A One", "B Two", -150, 130, "2026-09-30T00:00:00Z")), NOW, p) == 1
    assert len(read(p)) == 1


def test_a_bout_without_a_start_time_ages_out_from_when_it_was_first_seen(tmp_path):
    p = tmp_path / "lines.json"
    scrape.record_odds_lines(index(entry("A One", "B Two", -150, 130, "")), NOW, p)
    later = datetime(2026, 10, 3, 13, 0, tzinfo=timezone.utc)   # 4 days on
    scrape.record_odds_lines(index(entry("C Three", "D Four", 200, -240, "2026-10-04T00:00:00Z")), later, p)
    assert [l["a"] for l in read(p)] == ["C Three"]
