"""A full rebuild stops re-fetching every fighter's Wikipedia page every run.

On 2026-10-04 a rebuild with no new results spent 175s of a 207s scrape on 171
per-fighter page fetches for the rematch check (Layer 4), 116s of it on the 51
fighters with no page at all (API 200 + raw 404 + two 1s sleeps each). With the
stats budget on top, runs passed the 5-minute dispatch and were cancelled having
committed nothing. Two fixes, held here:

- fetch_wikitext treats the API's `missingtitle` as final: one request, no sleep.
- Layer 4's own verdict is cached per bout for REMATCH_CACHE_TTL_H, and a
  verdict resting on a failed (not missing) fetch is never stored.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import scrape

NOW = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)
ROOT = Path(__file__).resolve().parent.parent

RECORD = """== Mixed martial arts record ==
{{MMA record start}}
|-
|Win |align=center|10–2 |{opp} |Decision (unanimous) |UFC 300 |{{{{dts|2024|04|13}}}} |align=center|3
{{{{end}}}}
""" + "x" * 300


class Resp:
    def __init__(self, status, body=None, text=""):
        self.status_code, self._body, self.text = status, body, text

    def json(self):
        return self._body


@pytest.fixture
def net(monkeypatch):
    """Stub get_with_retry and sleep; `pages` maps slug -> wikitext (None = missing)."""
    calls, sleeps, pages, broken = [], [], {}, set()
    scrape._WIKI_MISSING.clear()
    monkeypatch.setattr(scrape.time, "sleep", lambda s: sleeps.append(s))

    def get(url, *, label="", headers=None, params=None, timeout=None, **kw):
        slug = params.get("page") or params.get("title")
        api = "api.php" in url
        calls.append(("API" if api else "raw", slug))
        if slug in broken:
            return None  # every attempt raised: a network failure, not a miss
        page = pages.get(slug)
        if api:
            if page is None:
                return Resp(200, {"error": {"code": "missingtitle", "info": "x"}})
            return Resp(200, {"parse": {"wikitext": {"*": page}}})
        return Resp(404) if page is None else Resp(200, text=page)

    monkeypatch.setattr(scrape, "get_with_retry", get)
    return calls, sleeps, pages, broken


def test_a_missing_page_costs_one_request_and_no_sleep(net):
    calls, sleeps, _, _ = net
    assert scrape.fetch_wikitext("Nobody_Atall") == ""
    assert calls == [("API", "Nobody_Atall")], "the raw URL for a missing title only 404s"
    assert sleeps == []
    assert "Nobody_Atall" in scrape._WIKI_MISSING


def test_other_api_failures_still_fall_back_to_raw(net, monkeypatch):
    calls, _, pages, _ = net
    pages["Some_Page"] = "y" * 300
    real = scrape.get_with_retry

    def api_500(url, **kw):
        if "api.php" in url:
            calls.append(("API", kw["params"]["page"]))
            return Resp(500)
        return real(url, **kw)

    monkeypatch.setattr(scrape, "get_with_retry", api_500)
    assert scrape.fetch_wikitext("Some_Page") == "y" * 300
    assert [c[0] for c in calls] == ["API", "raw"]


def test_layer4_finds_a_rematch_then_answers_from_the_cache(net):
    calls, _, pages, _ = net
    pages["Ann_Able"] = RECORD.format(opp="[[Bea Bold]]")
    pages["Bea_Bold"] = RECORD.format(opp="[[Ann Able]]")
    cache = {}
    assert scrape._rematch_layer4("Ann Able", "Bea Bold", cache, NOW) is True
    n = len(calls)
    assert scrape._rematch_layer4("Bea Bold", "Ann Able", cache, NOW + timedelta(hours=1)) is True
    assert len(calls) == n, "a fresh verdict must not fetch again (either fighter order)"


def test_a_cached_verdict_expires(net):
    calls, _, pages, _ = net
    pages["Ann_Able"] = "z" * 300  # page exists, no past bout
    cache = {}
    assert scrape._rematch_layer4("Ann Able", "Bea Bold", cache, NOW) is False
    n = len(calls)
    later = NOW + timedelta(hours=scrape.REMATCH_CACHE_TTL_H, minutes=1)
    scrape._rematch_layer4("Ann Able", "Bea Bold", cache, later)
    assert len(calls) > n, "an expired verdict is re-checked, so a Wikipedia edit lands"


def test_a_missing_page_is_a_definite_no_and_is_cached(net):
    calls, _, _, _ = net
    cache = {}
    assert scrape._rematch_layer4("Cal Cee", "Dee Dot", cache, NOW) is False
    assert scrape._rematch_key("Cal Cee", "Dee Dot") in cache
    n = len(calls)
    scrape._rematch_layer4("Cal Cee", "Dee Dot", cache, NOW)
    assert len(calls) == n


def test_a_failed_fetch_is_never_cached(net):
    _, _, _, broken = net
    broken.add("Eve_Echo")
    cache = {}
    assert scrape._rematch_layer4("Eve Echo", "Fay Fox", cache, NOW) is False
    assert cache == {}, "a network failure must not freeze a 'no rematch' for a day"


def test_save_drops_expired_entries(tmp_path):
    p = tmp_path / "rc.json"
    cache = {
        "a|b": {"v": True, "at": NOW.isoformat()},
        "c|d": {"v": False, "at": (NOW - timedelta(hours=scrape.REMATCH_CACHE_TTL_H + 1)).isoformat()},
        "e|f": {"v": False, "at": "not a date"},
    }
    scrape.save_rematch_cache(cache, NOW, p)
    assert set(scrape.load_rematch_cache(p)) == {"a|b"}
    assert scrape.load_rematch_cache(tmp_path / "absent.json") == {}


def test_the_cache_is_committed_with_the_run():
    wf = (ROOT / ".github/workflows/update.yml").read_text(encoding="utf-8")
    add_list = wf[wf.index("- id: push"):wf.index("git diff --staged --quiet")]
    assert "rematch-cache.json" in add_list, "an uncommitted cache resets every run"
