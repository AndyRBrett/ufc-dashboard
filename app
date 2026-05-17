#!/usr/bin/env python3
# UFC Dashboard - Flask endpoint for cron-job.org
import os, subprocess, sys
from flask import Flask, request, jsonify

app = Flask(__name__)

SECRET = os.environ.get("SCRAPE_TOKEN", "")

@app.route("/")
def home():
    return "UFC Dashboard scraper running.", 200

@app.route("/scrape")
def scrape():
    # Token auth
    if SECRET and request.args.get("token") != SECRET:
        return jsonify({"error": "Unauthorized"}), 401

    # Determine trigger type
    trigger = request.args.get("trigger", "card")  # "card" or "results"

    try:
        env = os.environ.copy()
        result = subprocess.run(
            [sys.executable, "scrape.py"],
            capture_output=True, text=True, timeout=120, env=env
        )
        print(result.stderr, file=sys.stderr)
        success = result.returncode == 0
        return jsonify({
            "status": "ok" if success else "error",
            "trigger": trigger,
            "log": result.stderr[-2000:],  # last 2000 chars of log
        }), 200 if success else 500
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Scraper timed out"}), 504
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/health")
def health():
    return jsonify({"status": "ok"}), 200

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)