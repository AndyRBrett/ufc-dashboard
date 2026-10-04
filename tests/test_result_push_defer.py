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


@pytest.fixture
def wire(monkeypatch):
    """Stub the network and the clock; returns (posts, statuses, sleeps)."""
    posts, statuses, sleeps = [], [], []
    monkeypatch.setattr(scrape, "SUPABASE_ANON", "anon")
    monkeypatch.setattr(scrape, "sb_get", lambda path: PICKS)
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


def test_update_yml_sends_after_the_commit():
    wf = (ROOT / ".github/workflows/update.yml").read_text(encoding="utf-8")
    scrape_step = wf.index("- run: python scrape.py")
    push_step = wf.index("- id: push")
    send_step = wf.index("python scrape.py --send-pending")
    defer_at = wf.index("PUSH_DEFER_FILE:")
    assert scrape_step < defer_at < push_step, "the scrape step must defer its pushes"
    assert push_step < send_step, "pushes must go out after the commit"
    send_block = wf[wf.rindex("- name:", 0, send_step):send_step]
    assert re.search(r"if:\s*steps\.push\.outputs\.pushed == 'true'", send_block)
    assert "SUPABASE_ANON" in send_block
