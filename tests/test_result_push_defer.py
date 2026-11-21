"""Result pushes from the scraper go out AFTER data.js is committed.

send-push rebuilds an anon-key result push from the committed data.js on main
and answers 409 when the result isn't there yet. scrape.py used to push from
inside the scrape, before update.yml's commit, so its push was refused every
time and never retried: on 2026-10-03 Soldic/Williams reached phones 12 minutes
after the result was in the app, via the slower backup senders. Now the scrape
defers its results to PUSH_DEFER_FILE and `scrape.py --send-pending` sends them
from a step after the commit, retrying a brief 409.
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

import scrape

ROOT = Path(__file__).resolve().parent.parent
# Relative to the clock, so the recency guard never ages this fixture out.
TODAY = datetime.now(timezone.utc).date().isoformat()
RESULT = {"winner": "Roberto Soldic", "loser": "Khaos Williams", "event_date": TODAY}
PICKS = [
    {"user_id": "u1", "f1": "Roberto Soldic", "f2": "Khaos Williams", "pick": "Roberto Soldic"},
    {"user_id": "u2", "f1": "Roberto Soldic", "f2": "Khaos Williams", "pick": "Khaos Williams"},
]


class Resp:
    def __init__(self, status):
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return {"status": self.status_code}


class Rows:
    def __init__(self, rows, status=200):
        self.rows, self.status_code = rows, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self.rows


def serve_picks(monkeypatch, table, gets=None, fail_at=None):
    """Stub the picks read like PostgREST: filters, order, and a 1,000-row cap."""
    def get(url, headers=None, timeout=None):
        if gets is not None:
            gets.append(url)
        q = dict(kv.split("=", 1) for kv in url.split("?", 1)[1].split("&"))
        offset, limit = int(q.get("offset", 0)), min(int(q.get("limit", 1000)), 1000)
        if fail_at is not None and offset >= fail_at:
            return Rows([], 503)
        dates = q["event_date"][len("in.("):-1].split(",") if "event_date" in q else None
        rows = [r for r in table if dates is None or r["event_date"] in dates]
        return Rows([{k: r[k] for k in ("user_id", "f1", "f2", "pick")} for r in rows[offset:offset + limit]])
    monkeypatch.setattr(scrape.requests, "get", get)


@pytest.fixture
def wire(monkeypatch):
    """Stub the network and the clock; returns (posts, statuses, sleeps)."""
    posts, statuses, sleeps = [], [], []
    monkeypatch.setattr(scrape, "SUPABASE_ANON", "anon")
    serve_picks(monkeypatch, [dict(p, event_date=TODAY) for p in PICKS])
    monkeypatch.setattr(scrape.time, "sleep", lambda s: sleeps.append(s))

    def post(url, headers=None, json=None, timeout=None):
        posts.append(json["type"])
        return Resp(statuses.pop(0) if statuses else 200)

    monkeypatch.setattr(scrape.requests, "post", post)
    return posts, statuses, sleeps


def test_scrape_defers_instead_of_pushing(wire, tmp_path, monkeypatch):
    posts, _, _ = wire
    f = tmp_path / "pending.json"
    monkeypatch.setattr(scrape, "PUSH_DEFER_FILE", str(f))
    scrape.send_push_notifications([RESULT])
    scrape.send_push_notifications([dict(RESULT, winner="Roman Kopylov", loser="Ateba Gautier")])
    assert posts == [], "a push sent before the commit is refused by send-push"
    assert [r["winner"] for r in json.loads(f.read_text())] == ["Roberto Soldic", "Roman Kopylov"]


def test_send_pending_pushes_both_groups(wire, tmp_path, monkeypatch):
    posts, _, sleeps = wire
    f = tmp_path / "pending.json"
    monkeypatch.setattr(scrape, "PUSH_DEFER_FILE", str(f))
    scrape.send_push_notifications([RESULT])
    scrape.send_pending_pushes(str(f))
    key = "result:roberto-soldic-khaos-williams"
    assert posts == [f"{key}:win", f"{key}:loss"]
    assert sleeps == []


def test_a_409_after_the_commit_is_retried_then_bounded(wire, tmp_path, monkeypatch):
    posts, statuses, sleeps = wire
    f = tmp_path / "pending.json"
    f.write_text(json.dumps([RESULT]))
    statuses.extend([409, 200])  # win: one 409 then sent
    scrape.send_pending_pushes(str(f))
    assert posts[:2] == [posts[0]] * 2 and posts[0].endswith(":win")
    assert sleeps == [scrape.PUSH_409_RETRY_WAITS_S[0]]

    posts.clear(); sleeps.clear()
    statuses.extend([409] * 10)  # never visible: give up, don't hang the run
    scrape.send_pending_pushes(str(f))
    assert sleeps[: len(scrape.PUSH_409_RETRY_WAITS_S)] == list(scrape.PUSH_409_RETRY_WAITS_S)
    assert sum(scrape.PUSH_409_RETRY_WAITS_S) <= 120, "must finish well inside the 5-minute dispatch"


def test_no_pending_file_is_a_no_op(wire, tmp_path):
    posts, _, _ = wire
    scrape.send_pending_pushes(str(tmp_path / "missing.json"))
    assert posts == []


def test_replay_sends_then_empties_without_waiting(wire, tmp_path):
    """A run cancelled after its commit left its queue committed: the next run replays it."""
    posts, statuses, sleeps = wire
    f = tmp_path / "pending.json"
    f.write_text(json.dumps([RESULT]))
    statuses.extend([409])  # a replay reads data.js a run old: no 409 worth waiting on
    scrape.send_pending_pushes(str(f), clear=True)
    assert len(posts) == 2 and sleeps == []
    assert json.loads(f.read_text()) == []
    posts.clear()
    scrape.send_pending_pushes(str(f), clear=True)  # empty queue: nothing sent, nothing written
    assert posts == []


def test_the_after_commit_send_keeps_the_queue_for_the_replay(wire, tmp_path):
    posts, _, _ = wire
    f = tmp_path / "pending.json"
    f.write_text(json.dumps([RESULT]))
    scrape.send_pending_pushes(str(f))
    assert len(posts) == 2
    assert json.loads(f.read_text()) == [RESULT], "cleared only by the next run's replay"


def test_a_picker_past_the_first_thousand_rows_still_gets_their_push(wire, tmp_path, monkeypatch):
    """2026-11-21: 1,254 UFC picks, one unpaged read, and one player's group was never asked for."""
    posts, _, _ = wire
    old = [{"user_id": f"o{i}", "f1": "A B", "f2": "C D", "pick": "A B", "event_date": "2026-01-01"}
           for i in range(1200)]
    today = [dict(p, event_date=TODAY) for p in PICKS]
    gets = []
    serve_picks(monkeypatch, old + today, gets)
    f = tmp_path / "pending.json"
    f.write_text(json.dumps([RESULT]))
    scrape.send_pending_pushes(str(f))
    key = "result:roberto-soldic-khaos-williams"
    assert posts == [f"{key}:win", f"{key}:loss"]
    assert all(f"event_date=in.({TODAY})" in u and "order=id" in u for u in gets), "only the announced card, in a stable order"

    # Paging: a card with more than one page of picks reads every page.
    many = [{"user_id": f"w{i}", "f1": "Roberto Soldic", "f2": "Khaos Williams", "pick": "Roberto Soldic",
             "event_date": TODAY} for i in range(1500)] + today
    gets.clear()
    serve_picks(monkeypatch, many, gets)
    assert len(scrape._result_picks({TODAY})) == 1502
    assert [re.search(r"offset=(\d+)", u).group(1) for u in gets] == ["0", "1000"]


def test_an_unreadable_page_sends_nothing(wire, tmp_path, monkeypatch):
    """A partial audience would be deduped for good: no push, check-results covers it."""
    posts, _, _ = wire
    many = [{"user_id": f"w{i}", "f1": "Roberto Soldic", "f2": "Khaos Williams", "pick": "Roberto Soldic",
             "event_date": TODAY} for i in range(1000)] + [dict(p, event_date=TODAY) for p in PICKS]
    serve_picks(monkeypatch, many, fail_at=1000)
    assert scrape._result_picks({TODAY}) is None
    f = tmp_path / "pending.json"
    f.write_text(json.dumps([RESULT]))
    scrape.send_pending_pushes(str(f))
    assert posts == []


def test_update_yml_queue_survives_a_cancelled_run():
    wf = (ROOT / ".github/workflows/update.yml").read_text(encoding="utf-8")
    replay = wf.index("python scrape.py --send-pending pending-pushes.json --clear")
    assert replay < wf.index("- run: python scrape.py"), "replay the last run's queue before scraping"
    assert re.search(r"PUSH_DEFER_FILE:\s*pending-pushes\.json\s*$", wf, re.M), \
        "the queue must be a committed file, not runner temp"
    add_list = wf[wf.index("- id: push"):wf.index("git diff --staged --quiet")]
    assert "pending-pushes.json" in add_list, "the queue must be committed with data.js"


def test_update_yml_sends_after_the_commit():
    wf = (ROOT / ".github/workflows/update.yml").read_text(encoding="utf-8")
    scrape_step = wf.index("- run: python scrape.py")
    push_step = wf.index("- id: push")
    send_step = wf.rindex("python scrape.py --send-pending pending-pushes.json\n")
    defer_at = wf.index("PUSH_DEFER_FILE:")
    assert scrape_step < defer_at < push_step, "the scrape step must defer its pushes"
    assert push_step < send_step, "pushes must go out after the commit"
    send_block = wf[wf.rindex("- name:", 0, send_step):send_step]
    assert re.search(r"if:\s*steps\.push\.outputs\.pushed == 'true'", send_block)
    assert "SUPABASE_ANON" in send_block
