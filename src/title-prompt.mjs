/**
 * Shared title-generation prompt, normalization, and CLI invocation.
 * Keep the hook fallback and the CLI backfill logic aligned.
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

const TITLE_PROMPT_RULES = `Rules:
- 3-6 words, kebab-case, lowercase, max 50 characters
- Be SPECIFIC: mention the actual technology, feature, file, or bug
- Focus on WHAT was done, not how the conversation started
- Never include URLs, file paths, or generic words like "help", "work", "session", "project"
- Good: "fix-stripe-webhook-retry", "k8s-helm-ingress-setup", "refactor-auth-middleware"
- Bad: "coding-session", "helping-with-code", "read-and-understand-repo"`;

// Dedicated temp directory for claude -p worker sessions.
// Sessions created here are cleaned up after each call so they
// never appear in the user's `claude --resume` list.
const WORKER_CWD = join(tmpdir(), "claude-rename-worker");

export function buildTitlePrompt(userMessages, assistantMessages, options = {}) {
  const {
    replyInstruction = "Reply with ONLY the title, nothing else",
    includeQuotesNote = false,
  } = options;

  const userContext = userMessages.slice(0, 3).join("\n\n").slice(0, 1500);
  const assistantContext = assistantMessages
    .slice(0, 1)
    .join("\n")
    .slice(0, 500);

  const replyLine = includeQuotesNote
    ? `${replyInstruction} — no explanation, no quotes`
    : replyInstruction;

  return `You generate short session titles for Claude Code conversations.

${TITLE_PROMPT_RULES}
- ${replyLine}

User messages:
${userContext}

Assistant response:
${assistantContext}

Title:`;
}

export function normalizeGeneratedTitle(rawOutput) {
  if (typeof rawOutput !== "string") return null;

  let title = rawOutput.trim();
  const lines = title.split("\n").filter((line) => line.trim());
  if (lines.length > 0) {
    title = lines[lines.length - 1].trim();
  }

  title = title
    .replace(/[`'"'"'"*]/g, "")
    .replace(/^[^a-z0-9]*/i, "")
    .replace(/[.\s]+$/, "")
    .replace(/\s+/g, "-")
    .toLowerCase();

  if (title && title.length >= 5 && title.length <= 50 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(title)) {
    return title;
  }

  return null;
}

/**
 * Run `claude -p --model <model>` with the given prompt piped via stdin.
 * Runs from a temp directory and cleans up the session file afterwards
 * so worker sessions never appear in the user's `claude --resume` list.
 *
 * @param {string} prompt - The prompt to send
 * @param {string} model - Model name (e.g. "haiku", "sonnet")
 * @returns {Promise<string|null>} Normalized kebab-case title, or null
 */
export function generateTitleViaCLI(prompt, model) {
  mkdirSync(WORKER_CWD, { recursive: true });

  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;

    // --bare disables hooks/LSP in the worker, preventing cascade loops.
    // CLAUDE_RENAME_WORKER env var is a secondary guard checked by hook.mjs.
    const child = spawn("claude", ["-p", "--bare", "--model", model], {
      cwd: WORKER_CWD,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_RENAME_WORKER: "1" },
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        cleanupWorkerSessions();
        resolve(null);
      }
    }, 30000);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanupWorkerSessions();
        resolve(normalizeGeneratedTitle(stdout));
      }
    });

    child.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanupWorkerSessions();
        resolve(null);
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Remove session files created by `claude -p` in the worker directory.
 * The project directory is derived from WORKER_CWD the same way Claude Code
 * encodes cwd paths: replace / with -.
 */
function cleanupWorkerSessions() {
  try {
    const encoded = WORKER_CWD.replace(/\//g, "-");
    const projectDir = join(homedir(), ".claude", "projects", encoded);
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  } catch {}
}
