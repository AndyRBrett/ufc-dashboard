#!/usr/bin/env python3
import requests, sys

WIKI_HDR = {"User-Agent": "UFC-Dashboard/1.0 (https://github.com/AndyRBrett/ufc-dashboard; andyrbrett@gmail.com)"}

slug = "UFC_Fight_Night:_Allen_vs._Costa"
r = requests.get(
    "https://en.wikipedia.org/w/api.php",
    params={"action": "parse", "page": slug, "prop": "wikitext", "format": "json"},
    headers=WIKI_HDR, timeout=15
)
print("Status:", r.status_code, file=sys.stderr)
wt = r.json().get("parse", {}).get("wikitext", {}).get("*", "")
print("Length:", len(wt), file=sys.stderr)

# Print the full wikitext so we can see exact format
print(wt)