"""A draw or no contest is a result: the bout is over without a winner.

Both result parsers used to need a "def." cell, so a draw ("A vs. B", method
"Draw (majority)") was dropped and the bout stayed state:"pre" for good. The
app's live view then sat on it as the bout in progress while the card fought on
(Kareckaite vs. Gatto opened Allen vs. Duncan on 2026-10-10 as a draw).
"""
import scrape

TEMPLATE = """{{MMAevent bout
|Women's Flyweight
|[[Ernesta Kareckaitė]]
|vs.
|Melissa Gatto
|Draw (majority) (29–27, 28–28, 28–28)
|3
|5:00
|
}}
{{MMAevent bout
|Women's Flyweight
|Alice Pereira
|def.
|Daria Zhelezniakova
|TKO (punches)
|1
|2:00
|
}}
{{MMAevent bout
|Lightweight
|Allen Frye Jr.
|vs.
|RJ Harris
|
|
|
|
}}"""

TABLE = """{| class="wikitable"
! Weight class !! !! !! !! Method !! Round !! Time
|-
| Lightweight || Bo Nickal || vs. || Joe Pyfer || No Contest (accidental eye poke) || 1 || 0:45
|-
| Lightweight || Allen Frye Jr. || vs. || RJ Harris || || ||
|}"""

FIGHT = ('{{lbl:"Prelim",wc:"Women\'s Flyweight",title:false,rematch:false,odds:null,'
         'winner:"",method:"",round:null,state:"pre",f1:{{n:"{a}",r:"9-3-2"}},'
         'f2:{{n:"{b}",r:"6-2-1"}}}}')


def test_template_draw_is_parsed_and_unfought_bout_is_not():
    res = scrape.parse_results(TEMPLATE)
    assert len(res) == 2
    d = res[0]
    assert d["undecided"] and d["winner"] == "" and d["method"] == "Draw" and d["round"] == 3
    assert {d["f1"], d["f2"]} == {"Ernesta Kareckaite", "Melissa Gatto"}
    assert res[1]["winner"] == "Alice Pereira" and not res[1].get("undecided")


def test_wikitable_no_contest():
    res = scrape._parse_results_wikitable(TABLE)
    assert len(res) == 1
    assert res[0]["method"] == "NC" and res[0]["undecided"] and res[0]["round"] == 1


def test_norm_method_draw_is_not_a_decision():
    assert scrape.norm_method("Draw (majority)") == "Draw"
    assert scrape.norm_method("Decision (majority)") == "Decision (Majority)"


def test_inject_marks_bout_over_without_winner_and_only_once():
    js = "[" + FIGHT.format(a="Melissa Gatto", b="Ernesta Kareckaite") + "," + \
        FIGHT.format(a="Allen Frye Jr.", b="RJ Harris") + "]"
    res = scrape.parse_results(TEMPLATE)
    out, n = scrape.inject_results(js, res)
    assert n == 1
    assert 'winner:"",method:"Draw",round:3,state:"post",f1:{n:"Melissa Gatto"' in out
    assert out.count('state:"post"') == 1          # Frye/Harris untouched
    again, n2 = scrape.inject_results(out, res)
    assert n2 == 0 and again == out


def test_draw_sends_no_result_push(monkeypatch):
    js = "var EVENTS=[{name:\"X\",date:\"2026-10-10\"," + \
        FIGHT.format(a="Melissa Gatto", b="Ernesta Kareckaite") + "}];"
    monkeypatch.setattr(scrape, "fetch_event_wikitext", lambda *a, **k: TEMPLATE)
    monkeypatch.setattr(scrape, "_event_slug_map", lambda d: {})
    monkeypatch.setattr(scrape.time, "sleep", lambda s: None)
    from datetime import datetime, timezone
    out, new = scrape.step_inject_results(js, datetime(2026, 10, 11, 2, tzinfo=timezone.utc))
    assert out is not None and 'method:"Draw"' in out
    assert new and not any(r.get("undecided") or not r["winner"] for r in new)
