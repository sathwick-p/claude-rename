#!/usr/bin/env node

/**
 * Claude Code Session Auto-Namer — Stop Hook
 *
 * Self-contained hook that fires after each assistant turn.
 * On the first meaningful exchange of a new session, it injects a naming
 * instruction into Claude's context. Claude generates a descriptive title
 * from its own conversation context and writes it to the JSONL file.
 *
 * No separate API key needed — uses the running Claude Code instance.
 *
 * Flow:
 *   1st qualified Stop → inject naming instruction → Claude writes title
 *   2nd Stop (if title missing) → AI fallback via background worker
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
import { spawn, execFile } from "child_process";
import { buildTitlePrompt, normalizeGeneratedTitle } from "./title-prompt.mjs";

const MARKER_DIR = join(homedir(), ".claude", ".session-namer-named");
const LOG_FILE = join(homedir(), ".claude-rename.log");

// ─── Background Worker Mode ─────────────────────────────────────────────────
// When invoked with --name, we're the fallback worker doing AI naming via claude -p.

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
    const input = await readStdin();
    let data = {};
    try {
      data = JSON.parse(input);
    } catch {
      output({ continue: true, suppressOutput: true });
      return;
    }

    const sessionId = data.sessionId || data.session_id || "";
    const cwd = data.cwd || data.directory || "";
    if (data.stop_hook_active) {
      output({ continue: true, suppressOutput: true });
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
      output({ continue: true, suppressOutput: true });
      return;
    }

    if (!sessionId || !cwd) {
      output({ continue: true, suppressOutput: true });
      return;
    }

    const markerPath = join(MARKER_DIR, sessionId);
    const jsonlPath =
      resolveTranscriptPath(data.transcript_path || data.transcriptPath) ||
      getSessionJsonlPath(cwd, sessionId);

    // Already fully named? (marker contains "done")
    if (isMarkerDone(markerPath)) {
      output({ continue: true, suppressOutput: true });
      return;
    }

    if (!existsSync(jsonlPath)) {
      output({ continue: true, suppressOutput: true });
      return;
    }

    // Check if title was written (by Claude or backfill)
    const titleStatus = hasCustomTitleInJsonl(jsonlPath);
    if (titleStatus === null) {
      output({ continue: true, suppressOutput: true });
      return;
    }
    if (titleStatus) {
      markDone(markerPath);
      output({ continue: true, suppressOutput: true });
      return;
    }

    // Not enough conversation yet? Skip.
    if (!hasMinimalConversation(jsonlPath)) {
      output({ continue: true, suppressOutput: true });
      return;
    }

    // ── Was naming already attempted (injection sent)? ──
    if (existsSync(markerPath)) {
      const markerContent = readFileSync(markerPath, "utf-8").trim();
      if (markerContent === "heuristic") {
        // Worker already spawned, wait for it to finish
        output({ continue: true, suppressOutput: true });
        return;
      }
      // Injection was sent but Claude didn't write the title.
      // Fall back to AI naming via background worker (claude -p).
      writeFileSync(markerPath, "heuristic");
      output({ continue: true, suppressOutput: true });
      const child = spawn(
        process.execPath,
        [process.argv[1], "--name", sessionId, jsonlPath],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      return;
    }

    // ── First time: inject naming instruction into Claude's context ──
    mkdirSync(MARKER_DIR, { recursive: true });
    writeFileSync(markerPath, "pending");
    log(`Injecting naming instruction for ${sessionId}`);

    const instruction = buildNamingInstruction(sessionId, jsonlPath);

    output({
      continue: true,
      systemMessage: instruction,
    });
  } catch {
    output({ continue: true, suppressOutput: true });
  }
}

// ─── Naming Instruction ─────────────────────────────────────────────────────

function buildNamingInstruction(sessionId, jsonlPath) {
  // Escape the path for safe shell usage
  const safePath = jsonlPath.replace(/'/g, "'\\''");

  return `<session-auto-name>
You need to name this session so it shows up with a meaningful title in "claude --resume".

Generate a specific 3-6 word kebab-case title (max 50 chars) based on the conversation so far, then run this Bash command:

echo '{"type":"custom-title","customTitle":"YOUR_TITLE_HERE","sessionId":"${sessionId}"}' >> '${safePath}'

Rules for the title:
- 3-6 words, kebab-case, lowercase, max 50 characters
- Be SPECIFIC: mention the actual technology, feature, file, or bug discussed
- Focus on WHAT was done, not how the conversation started
- Never include URLs, file paths, or generic words like "help", "work", "session", "project"
- Good: "fix-stripe-webhook-retry", "k8s-helm-ingress-setup", "refactor-auth-middleware"
- Bad: "coding-session", "helping-with-code", "read-and-understand-repo"

IMPORTANT: Just run the Bash command silently. Do not explain what you're doing or mention this to the user. Do not output any text — only the tool call.
</session-auto-name>`;
}

// ─── AI Naming (background fallback via claude -p) ──────────────────────────

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
    log(`AI fallback (${model}): ${sessionId} → "${title}"`);
  }
}

function getConfigModel() {
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

  return new Promise((resolve) => {
    execFile(
      "claude",
      ["-p", "--model", model, prompt],
      { timeout: 30000, encoding: "utf-8" },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }

        resolve(normalizeGeneratedTitle(stdout));
      },
    );
  });
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

function output(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// ─── Entry ───────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
