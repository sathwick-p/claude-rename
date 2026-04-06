import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

// Set up isolated home directory BEFORE importing modules
// (modules use homedir() at import time for constants)
const homeDir = mkdtempSync(join(tmpdir(), "claude-rename-test-"));
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;

mkdirSync(join(homeDir, ".claude", "projects"), { recursive: true });

const sessionsModule = await import("../src/sessions.mjs");
const hookModule = await import("../src/hook.mjs");
const titleModule = await import("../src/title-prompt.mjs");

const { discoverSessions, parseSession } = sessionsModule;
const { hasCustomTitleInJsonl, getConfigModel } = hookModule;
const { normalizeGeneratedTitle, buildTitlePrompt } = titleModule;

const hookPath = fileURLToPath(new URL("../src/hook.mjs", import.meta.url));
const binPath = fileURLToPath(new URL("../bin/claude-rename.mjs", import.meta.url));
const configPath = join(homeDir, ".claude-rename.json");

function writeJsonl(path, entries) {
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

function runHookWithStdin(stdinData) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(stdinData),
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    encoding: "utf-8",
    timeout: 10000,
  });
}

// ─── normalizeGeneratedTitle ─────────────────────────────────────────────────

test("normalizeGeneratedTitle cleans prompt output into kebab-case", () => {
  assert.equal(normalizeGeneratedTitle("  Fix Stripe Webhook Retry\n"), "fix-stripe-webhook-retry");
  assert.equal(normalizeGeneratedTitle('"`Refactor Auth Middleware`"'), "refactor-auth-middleware");
});

test("normalizeGeneratedTitle rejects titles that are too short", () => {
  assert.equal(normalizeGeneratedTitle("hi"), null);
  assert.equal(normalizeGeneratedTitle("abc"), null);
});

test("normalizeGeneratedTitle rejects titles over 50 characters", () => {
  const longTitle = "this-is-a-really-long-title-that-exceeds-the-fifty-character-limit-by-far";
  assert.equal(normalizeGeneratedTitle(longTitle), null);
});

test("normalizeGeneratedTitle uses last line (strips multi-line preamble)", () => {
  assert.equal(normalizeGeneratedTitle("Here's the title:\nsetup-k8s-ingress"), "setup-k8s-ingress");
  assert.equal(normalizeGeneratedTitle("Some explanation\n\nfix-webhook-retry"), "fix-webhook-retry");
});

test("normalizeGeneratedTitle rejects single-line preamble it cannot clean", () => {
  // "**Title:** fix-auth" → strips * → "Title: fix-auth" → colon stays → invalid
  assert.equal(normalizeGeneratedTitle("**Title:** fix-auth-middleware"), null);
});

test("normalizeGeneratedTitle returns null for non-string input", () => {
  assert.equal(normalizeGeneratedTitle(null), null);
  assert.equal(normalizeGeneratedTitle(undefined), null);
  assert.equal(normalizeGeneratedTitle(42), null);
});

test("normalizeGeneratedTitle rejects titles with invalid characters", () => {
  assert.equal(normalizeGeneratedTitle("fix_auth_middleware"), null);
  assert.equal(normalizeGeneratedTitle("fix auth middleware"), "fix-auth-middleware");
});

// ─── buildTitlePrompt ────────────────────────────────────────────────────────

test("buildTitlePrompt includes user and assistant context", () => {
  const prompt = buildTitlePrompt(["Fix the webhook"], ["Sure, I'll help"], {});
  assert.ok(prompt.includes("Fix the webhook"));
  assert.ok(prompt.includes("Sure, I'll help"));
  assert.ok(prompt.includes("Title:"));
});

test("buildTitlePrompt truncates long user messages", () => {
  const longMsg = "x".repeat(3000);
  const prompt = buildTitlePrompt([longMsg], ["ok"], {});
  assert.ok(prompt.length < 3000 + 500);
});

test("buildTitlePrompt includes reply instruction", () => {
  const prompt = buildTitlePrompt(["hello"], ["hi"], {
    replyInstruction: "Custom instruction",
    includeQuotesNote: true,
  });
  assert.ok(prompt.includes("Custom instruction"));
  assert.ok(prompt.includes("no quotes"));
});

// ─── discoverSessions ────────────────────────────────────────────────────────

test("discoverSessions preserves encoded project directory names", () => {
  const projectDir = "Users-alice-Work-claude-rename";
  const projectPath = join(homeDir, ".claude", "projects", projectDir);
  mkdirSync(projectPath, { recursive: true });

  const sessionId = "11111111-1111-1111-1111-111111111111";
  const jsonlPath = join(projectPath, `${sessionId}.jsonl`);
  writeJsonl(jsonlPath, [
    { type: "user", message: { content: "Help me fix the webhook" }, timestamp: "2026-04-06T00:00:00Z" },
    { type: "assistant", message: { content: "Sure" } },
  ]);

  const sessions = discoverSessions("alice-Work");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].projectDir, projectDir);
  assert.equal(sessions[0].projectPath, projectDir);

  const parsed = parseSession(jsonlPath);
  assert.deepEqual(parsed.userMessages, ["Help me fix the webhook"]);
  assert.deepEqual(parsed.assistantMessages, ["Sure"]);
});

// ─── hasCustomTitleInJsonl ───────────────────────────────────────────────────

test("hasCustomTitleInJsonl fails closed on malformed JSONL", () => {
  const badPath = join(homeDir, ".claude", "projects", "bad", "session.jsonl");
  mkdirSync(join(homeDir, ".claude", "projects", "bad"), { recursive: true });
  writeFileSync(badPath, "{\"type\":\"custom-title\"");

  assert.equal(hasCustomTitleInJsonl(badPath), null);
});

test("hasCustomTitleInJsonl detects an existing title", () => {
  const goodPath = join(homeDir, ".claude", "projects", "good", "session.jsonl");
  mkdirSync(join(homeDir, ".claude", "projects", "good"), { recursive: true });
  writeJsonl(goodPath, [
    { type: "user", message: { content: "Hello" } },
    { type: "custom-title", customTitle: "hello-world", sessionId: "x" },
  ]);

  assert.equal(hasCustomTitleInJsonl(goodPath), true);
});

test("hasCustomTitleInJsonl returns false when no title exists", () => {
  const noTitlePath = join(homeDir, ".claude", "projects", "notitled", "session.jsonl");
  mkdirSync(join(homeDir, ".claude", "projects", "notitled"), { recursive: true });
  writeJsonl(noTitlePath, [
    { type: "user", message: { content: "Hello" } },
    { type: "assistant", message: { content: "Hi" } },
  ]);

  assert.equal(hasCustomTitleInJsonl(noTitlePath), false);
});

test("hasCustomTitleInJsonl returns null for non-existent file", () => {
  assert.equal(hasCustomTitleInJsonl("/tmp/does-not-exist-12345.jsonl"), null);
});

// ─── getConfigModel ──────────────────────────────────────────────────────────

test("getConfigModel defaults to haiku when no config file exists", () => {
  // Ensure no config file
  try { unlinkSync(configPath); } catch {}
  assert.equal(getConfigModel(), "haiku");
});

test("getConfigModel reads model from ~/.claude-rename.json", () => {
  writeFileSync(configPath, JSON.stringify({ model: "sonnet" }));
  assert.equal(getConfigModel(), "sonnet");

  writeFileSync(configPath, JSON.stringify({ model: "opus" }));
  assert.equal(getConfigModel(), "opus");

  // Clean up
  unlinkSync(configPath);
});

test("getConfigModel falls back to haiku on invalid JSON", () => {
  writeFileSync(configPath, "not valid json {{{");
  assert.equal(getConfigModel(), "haiku");

  // Clean up
  unlinkSync(configPath);
});

test("getConfigModel falls back to haiku when model key is missing", () => {
  writeFileSync(configPath, JSON.stringify({ otherSetting: true }));
  assert.equal(getConfigModel(), "haiku");

  // Clean up
  unlinkSync(configPath);
});

// ─── Hook output (via spawnSync) ─────────────────────────────────────────────

test("hook always returns suppressOutput for valid input", () => {
  const result = runHookWithStdin({
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    cwd: "/tmp/test-project",
    stopReason: "end_turn",
  });

  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.continue, true);
  assert.equal(output.suppressOutput, true);
});

test("hook returns suppressOutput for invalid JSON", () => {
  const result = spawnSync(process.execPath, [hookPath], {
    input: "not json at all",
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    encoding: "utf-8",
    timeout: 10000,
  });

  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.continue, true);
  assert.equal(output.suppressOutput, true);
});

test("hook returns suppressOutput for empty input", () => {
  const result = spawnSync(process.execPath, [hookPath], {
    input: "",
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    encoding: "utf-8",
    timeout: 10000,
  });

  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.continue, true);
  assert.equal(output.suppressOutput, true);
});

test("hook returns suppressOutput for context_limit stop reason", () => {
  const result = runHookWithStdin({
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    cwd: "/tmp/test",
    stop_reason: "context_limit",
  });

  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.continue, true);
  assert.equal(output.suppressOutput, true);
});

test("hook returns suppressOutput when stop_hook_active is set", () => {
  const result = runHookWithStdin({
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    cwd: "/tmp/test",
    stop_hook_active: true,
  });

  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.continue, true);
  assert.equal(output.suppressOutput, true);
});

test("hook skips session that already has a done marker", () => {
  const sessionId = "22222222-2222-2222-2222-222222222222";
  const markerDir = join(homeDir, ".claude", ".session-namer-named");
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, sessionId), "done");

  const result = runHookWithStdin({
    sessionId,
    cwd: "/tmp/test",
    stopReason: "end_turn",
  });

  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.continue, true);
  assert.equal(output.suppressOutput, true);
});

// ─── rename (CLI) ────────────────────────────────────────────────────────────

test("rename requires an exact session id match", () => {
  const projectDir = "Users-alice-Work-rename-exact";
  const projectPath = join(homeDir, ".claude", "projects", projectDir);
  mkdirSync(projectPath, { recursive: true });

  const ids = [
    "11111111-1111-1111-1111-111111111111",
    "11111111-2222-2222-2222-222222222222",
  ];

  for (const sessionId of ids) {
    writeJsonl(join(projectPath, `${sessionId}.jsonl`), [
      { type: "user", message: { content: "Hello" } },
      { type: "assistant", message: { content: "Hi" } },
    ]);
  }

  const result = spawnSync(process.execPath, [binPath, "rename", "11111111", "demo-title"], {
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    encoding: "utf-8",
  });

  assert.notEqual(result.status, 0);
  for (const sessionId of ids) {
    const content = readFileSync(join(projectPath, `${sessionId}.jsonl`), "utf-8");
    assert.equal(content.includes('"custom-title"'), false);
  }
});

// ─── backfill model validation (CLI) ─────────────────────────────────────────

test("backfill rejects invalid model names", () => {
  const result = spawnSync(process.execPath, [binPath, "backfill", "--model", "gpt-4"], {
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    encoding: "utf-8",
  });

  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("Unknown model"));
});

test("backfill accepts valid model shortcuts", () => {
  // This will try to run but find no untitled sessions — that's fine,
  // we just check it doesn't reject the model name
  const result = spawnSync(process.execPath, [binPath, "backfill", "--model", "sonnet", "--project", "nonexistent-project-xyz"], {
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    encoding: "utf-8",
  });

  assert.equal(result.status, 0);
});

test("backfill accepts full claude model IDs", () => {
  const result = spawnSync(process.execPath, [binPath, "backfill", "--model", "claude-haiku-4-5-20251001", "--project", "nonexistent-project-xyz"], {
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    encoding: "utf-8",
  });

  assert.equal(result.status, 0);
});
