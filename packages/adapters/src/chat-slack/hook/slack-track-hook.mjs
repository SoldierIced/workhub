#!/usr/bin/env node
// Claude Code PostToolUse hook (ported from Workhub 1's Bridge/slack-track-hook.mjs): when a Claude
// session sends a Slack message through a Slack MCP tool, append one line to Workhub's inbox so
// Workhub follows the thread and wakes that session when someone replies. It never gets in the way
// of the tool: nothing on stdout, errors only in a small log next to the inbox, exit code always 0.
//
// Workhub copies this file into its data folder; the inbox is always next to the copy, so each
// Workhub data folder (a dev run, a packaged install) has its own inbox.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const inbox = path.join(dir, "slack-track-inbox.jsonl");
const logFile = path.join(dir, "slack-track-hook.log");
const TS = /^\d{9,11}\.\d{6}$/;
const ARCHIVE = /https?:\/\/[\w.-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{16})(\?[^\s"'<>|)\]]*)?/;

function log(message) {
  try {
    try {
      if (fs.statSync(logFile).size > 100_000) fs.renameSync(logFile, logFile + ".1");
    } catch {}
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function parsePermalink(text) {
  const match = typeof text === "string" ? text.match(ARCHIVE) : null;
  if (!match) return null;
  const ts = `${match[2].slice(0, 10)}.${match[2].slice(10)}`;
  let threadTs = null;
  if (match[3]) {
    const value = new URLSearchParams(match[3].slice(1)).get("thread_ts");
    if (value && TS.test(value)) threadTs = value;
  }
  return { url: match[0], channelId: match[1], ts, threadTs };
}

/** At most 80 characters, cut at a word boundary with "…" (same rule as core `threadTitle`). */
function threadTitle(line, limit = 80) {
  const trimmed = line.trim();
  const chars = Array.from(trimmed);
  if (chars.length <= limit) return trimmed;
  const cut = chars.slice(0, limit).join("");
  const boundary = cut.search(/\s\S*$/);
  const kept = boundary >= cut.length / 2 ? cut.slice(0, boundary) : cut;
  return kept.replace(/[\s,;:-]+$/, "") + "…";
}

/** Walks the tool response (object, string, MCP content array, JSON inside text) for ts and permalink. */
function scan(value, found, depth = 0) {
  if (value == null || depth > 12) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 2_000_000) {
      try {
        scan(JSON.parse(trimmed), found, depth + 1);
      } catch {}
    }
    if (!found.permalink) {
      const link = parsePermalink(value);
      if (link) found.permalink = link;
    }
    if (!found.ts) {
      const match = value.match(/\b(?:message_)?ts\b["'\s:=]*["']?(\d{9,11}\.\d{6})/i);
      if (match) found.ts = match[1];
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scan(item, found, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (typeof item === "string" || typeof item === "number") {
      const text = String(item);
      if (!found.ts && (lower === "ts" || lower === "message_ts") && TS.test(text)) found.ts = text;
      if (!found.threadTs && lower === "thread_ts" && TS.test(text)) found.threadTs = text;
      if (!found.channelId && (lower === "channel" || lower === "channel_id") && /^[A-Z0-9]{8,}$/.test(text)) found.channelId = text;
      if (!found.permalink && (lower === "permalink" || lower === "message_link" || lower === "link" || lower === "url")) {
        const link = parsePermalink(text);
        if (link) found.permalink = link;
      }
    }
    scan(item, found, depth + 1);
  }
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    log("ignored: stdin is not JSON");
    return;
  }
  const tool = String(payload.tool_name ?? "");
  if (!/slack.*send_message$/i.test(tool) || /draft|schedule/i.test(tool)) return;

  const input = payload.tool_input ?? {};
  const found = {};
  scan(payload.tool_response, found);
  const link = found.permalink;
  const channelId = String(input.channel_id ?? input.channel ?? link?.channelId ?? found.channelId ?? "").trim();
  const ts = found.ts ?? link?.ts ?? null;
  const inputThread = input.thread_ts != null ? String(input.thread_ts).trim() : "";
  const threadTs = (TS.test(inputThread) ? inputThread : null) ?? link?.threadTs ?? found.threadTs ?? ts;
  if (!channelId || !threadTs) {
    log(`skipped ${tool}: no channel or ts found (session ${payload.session_id ?? "?"})`);
    return;
  }
  const text = String(input.text ?? input.message ?? "");
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const record = {
    sessionId: String(payload.session_id ?? ""),
    cwd: payload.cwd ?? process.cwd(),
    configDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    channelId,
    ts,
    threadTs,
    permalink: link?.url ?? null,
    title: threadTitle(firstLine),
    text: text.slice(0, 1500),
    sentAt: new Date().toISOString(),
  };
  fs.appendFileSync(inbox, JSON.stringify(record) + "\n");
}

main()
  .catch((error) => log(`error: ${error?.stack ?? error}`))
  .finally(() => process.exit(0));
