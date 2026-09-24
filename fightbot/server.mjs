#!/usr/bin/env node
// FightBot — a Model Context Protocol server over stdio, zero dependencies.
//
// Add to an MCP client (Claude Desktop's claude_desktop_config.json, or
// `claude mcp add fightbot -- node /path/to/ufc-dashboard/fightbot/server.mjs`):
//
//   { "mcpServers": { "fightbot": { "command": "node",
//       "args": ["/path/to/ufc-dashboard/fightbot/server.mjs"] } } }
//
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. stdout carries
// protocol messages ONLY — anything else written there corrupts the stream, so
// every log line goes to stderr.
import { createInterface } from "node:readline";
import { TOOLS, callTool, meta } from "./core.mjs";

const PROTOCOL = "2025-06-18";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const log = (...a) => process.stderr.write("[fightbot] " + a.join(" ") + "\n");
console.log = console.info = console.warn = (...a) => log(...a.map(String));

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => id !== undefined && send({ jsonrpc: "2.0", id, result });
  const error = (code, message) => id !== undefined && send({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: (params && params.protocolVersion) || PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "fightbot", version: "1.0.0" },
        instructions: "UFC card, odds movement, fighter comparisons and the friend group's picks, from the UFC Dashboard's own data and scoring. Read-only.",
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
    case "tools/call": {
      const name = params && params.name;
      if (!TOOLS[name]) return error(-32602, `Unknown tool: ${name}`);
      try {
        const out = await callTool(name, (params && params.arguments) || {});
        return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 1) }], isError: !!(out && out.error) });
      } catch (e) {
        // A tool failure is a result the model can read and recover from, not a protocol error.
        return reply({ content: [{ type: "text", text: "FightBot error: " + (e && e.message ? e.message : String(e)) }], isError: true });
      }
    }
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  Promise.resolve(handle(msg)).catch((e) => log("handler crashed:", e && e.stack || e));
});
rl.on("close", () => process.exit(0));
try { const m = meta(); log(`ready — ${m.events} events, data generated ${m.generated_at}`); }
catch (e) { log("data failed to load:", e.message); }
