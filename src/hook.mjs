#!/usr/bin/env node

/**
 * Claude Code Session Auto-Namer — Stop Hook
 *
 * Fires after each assistant turn. On the first meaningful exchange of a
 * new session, spawns a background worker that names it via `claude -p`.
 *
 * No separate API key needed — uses your existing Claude Code subscription.
 * Always outputs { continue: true, suppressOutput: true } so the user
 * never sees any hook output.
 *
 * Flow:
 *   Stop fires → session needs naming? → spawn background `claude -p` worker
 *   Worker generates title → writes to JSONL → marks done
 *
 * Install: claude-rename install
 * This file is copied to ~/.claude/hooks/ together with title-prompt.mjs.
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { buildTitlePrompt, generateTitleViaCLI } from "./title-prompt.mjs";

const MARKER_DIR = join(homedir(), ".claude", ".session-namer-named");
const LOG_FILE = join(homedir(), ".claude-rename.log");

// ─── Background Worker Mode ─────────────────────────────────────────────────
// When invoked with --name, we're the background worker doing AI naming via claude -p.

if (process.argv.includes("--name")) {
  const idx = process.argv.indexOf("--name");
  const sessionId = process.argv[idx + 1];
  const jsonlPath = process.argv[idx + 2];

  if (sessionId && jsonlPath) {
    try {
      await nameSessionAI(sessionId, jsonlPath);
    } catch (err) {
      log(`Worker error for ${sessionId}: ${err.message}`);
    }
  }
  process.exit(0);
}

// ─── Hook Mode (stdin) ──────────────────────────────────────────────────────

async function main() {
  try {
    // Guard: skip if running inside a worker process to prevent cascade loops
    if (process.env.CLAUDE_RENAME_WORKER) {
      output();
      return;
    }

    const input = await readStdin();
    let data = {};
    try {
      data = JSON.parse(input);
    } catch {
      output();
      return;
    }

    const sessionId = data.sessionId || data.session_id || "";
    const cwd = data.cwd || data.directory || "";

    // Guard: skip sessions from the worker temp directory
    if (cwd.includes("claude-rename-worker")) {
      output();
      return;
    }

    if (data.stop_hook_active) {
      output();
      return;
    }

    const stopReason = (
      data.stop_reason ||
      data.stopReason ||
      ""
    ).toLowerCase();

    // Never block context-limit, abort, or cancel stops
    if (
      stopReason.includes("context") ||
      stopReason.includes("abort") ||
      stopReason.includes("cancel")
    ) {
      output();
      return;
    }

    if (!sessionId || !cwd) {
      output();
      return;
    }

    const markerPath = join(MARKER_DIR, sessionId);
    const jsonlPath =
      resolveTranscriptPath(data.transcript_path || data.transcriptPath) ||
      getSessionJsonlPath(cwd, sessionId);

    // Already fully named? (marker contains "done")
    if (isMarkerDone(markerPath)) {
      output();
      return;
    }

    if (!existsSync(jsonlPath)) {
      output();
      return;
    }

    // Check if title was written (by backfill or a previous worker)
    const titleStatus = hasCustomTitleInJsonl(jsonlPath);
    if (titleStatus === null) {
      output();
      return;
    }
    if (titleStatus) {
      markDone(markerPath);
      output();
      return;
    }

    // Not enough conversation yet? Skip.
    if (!hasMinimalConversation(jsonlPath)) {
      output();
      return;
    }

    // Already spawned a worker? Don't spawn another.
    if (existsSync(markerPath)) {
      output();
      return;
    }

    // ── Spawn background AI naming worker ──
    mkdirSync(MARKER_DIR, { recursive: true });
    writeFileSync(markerPath, "naming");
    log(`Spawning background namer for ${sessionId}`);

    const child = spawn(
      process.execPath,
      [process.argv[1], "--name", sessionId, jsonlPath],
      { detached: true, stdio: "ignore" },
    );
    child.unref();

    output();
  } catch {
    output();
  }
}

// ─── AI Naming (background worker via claude -p) ────────────────────────────

async function nameSessionAI(sessionId, jsonlPath) {
  if (isMarkerDone(join(MARKER_DIR, sessionId))) return;
  const titleStatus = hasCustomTitleInJsonl(jsonlPath);
  if (titleStatus === null) return;
  if (titleStatus) {
    markDone(join(MARKER_DIR, sessionId));
    return;
  }

  const { userMessages, assistantMessages } = extractMessages(jsonlPath);
  if (userMessages.length === 0) return;

  const model = getConfigModel();
  const title = await generateTitleViaClaude(userMessages, assistantMessages, model);
  if (title) {
    writeTitle(jsonlPath, sessionId, title);
    markDone(join(MARKER_DIR, sessionId));
    log(`Named (${model}): ${sessionId} → "${title}"`);
  } else {
    log(`Failed to generate title for ${sessionId}`);
  }
}

export function getConfigModel() {
  try {
    const configPath = join(homedir(), ".claude-rename.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return config.model || "haiku";
  } catch {
    return "haiku";
  }
}

function generateTitleViaClaude(userMessages, assistantMessages, model) {
  const prompt = buildTitlePrompt(userMessages, assistantMessages, {
    replyInstruction: "Reply with ONLY the title, nothing else",
  });
  return generateTitleViaCLI(prompt, model);
}

// ─── Stdin Reader ────────────────────────────────────────────────────────────

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const done = (val) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };
    const timeout = setTimeout(() => {
      process.stdin.removeAllListeners();
      done(Buffer.concat(chunks).toString("utf-8"));
    }, timeoutMs);
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      clearTimeout(timeout);
      done(Buffer.concat(chunks).toString("utf-8"));
    });
    process.stdin.on("error", () => {
      clearTimeout(timeout);
      done("");
    });
    if (process.stdin.readableEnded) {
      clearTimeout(timeout);
      done(Buffer.concat(chunks).toString("utf-8"));
    }
  });
}

// ─── Path Utilities ──────────────────────────────────────────────────────────

function resolveTranscriptPath(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return null;
  if (transcriptPath.startsWith("~")) {
    return join(homedir(), transcriptPath.slice(2));
  }
  return transcriptPath;
}

function cwdToProjectDir(cwd) {
  return cwd.replace(/\//g, "-");
}

function getSessionJsonlPath(cwd, sessionId) {
  const encoded = cwdToProjectDir(cwd);
  return join(homedir(), ".claude", "projects", encoded, `${sessionId}.jsonl`);
}

// ─── Idempotency ─────────────────────────────────────────────────────────────

function isMarkerDone(markerPath) {
  try {
    return readFileSync(markerPath, "utf-8").trim() === "done";
  } catch {
    return false;
  }
}

function markDone(markerPath) {
  try {
    mkdirSync(MARKER_DIR, { recursive: true });
    writeFileSync(markerPath, "done");
  } catch {}
}

export function hasCustomTitleInJsonl(jsonlPath) {
  try {
    const stats = statSync(jsonlPath);
    let content;
    if (stats.size < 65536) {
      content = readFileSync(jsonlPath, "utf-8");
    } else {
      const fd = openSync(jsonlPath, "r");
      const bufSize = 65536;
      const buffer = Buffer.alloc(bufSize);
      readSync(fd, buffer, 0, bufSize, stats.size - bufSize);
      closeSync(fd);
      content = buffer.toString("utf-8");
    }
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.includes('"custom-title"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "custom-title") return true;
      } catch {
        return null;
      }
    }
    return false;
  } catch {
    return null;
  }
}

// ─── Conversation Extraction ─────────────────────────────────────────────────

function hasMinimalConversation(jsonlPath) {
  try {
    const lines = readFileSync(jsonlPath, "utf-8").split("\n");
    let hasUser = false;
    let hasAssistant = false;
    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "user" && entry.message?.content) {
          const text = extractText(entry.message.content);
          if (text && !isSystemMessage(text)) hasUser = true;
        }
        if (entry.type === "assistant" && entry.message?.content) {
          hasAssistant = true;
        }
      } catch {}
      if (hasUser && hasAssistant) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function extractMessages(jsonlPath) {
  const userMessages = [];
  const assistantMessages = [];

  try {
    const lines = readFileSync(jsonlPath, "utf-8").split("\n");
    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "user" && entry.message?.content) {
          const text = extractText(entry.message.content);
          if (text && !isSystemMessage(text)) {
            userMessages.push(text);
          }
        } else if (entry.type === "assistant" && entry.message?.content) {
          const text = extractText(entry.message.content);
          if (text) assistantMessages.push(text);
        }
      } catch {}
    }
  } catch {}

  return { userMessages, assistantMessages };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ");
  }
  return "";
}

function isSystemMessage(text) {
  return (
    text.startsWith("<command-message>") ||
    text.startsWith("<local-command-caveat>") ||
    text.startsWith("<system-reminder>") ||
    /^<[a-z-]+>/.test(text.trim())
  );
}

// ─── JSONL Writer ────────────────────────────────────────────────────────────

function writeTitle(jsonlPath, sessionId, title) {
  const entry = JSON.stringify({
    type: "custom-title",
    customTitle: title,
    sessionId,
  });
  appendFileSync(jsonlPath, entry + "\n");
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
  try {
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `${ts} ${msg}\n`);
  } catch {}
}

// ─── Output ──────────────────────────────────────────────────────────────────

function output() {
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + "\n");
}

// ─── Entry ───────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
