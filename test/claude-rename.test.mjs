import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const homeDir = mkdtempSync(join(tmpdir(), "claude-rename-test-"));
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;

mkdirSync(join(homeDir, ".claude", "projects"), { recursive: true });

const sessionsModule = await import("../src/sessions.mjs");
const hookModule = await import("../src/hook.mjs");
const titleModule = await import("../src/title-prompt.mjs");

const { discoverSessions, parseSession } = sessionsModule;
const { hasCustomTitleInJsonl } = hookModule;
const { normalizeGeneratedTitle } = titleModule;

function writeJsonl(path, entries) {
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

test("normalizeGeneratedTitle cleans prompt output into kebab-case", () => {
  assert.equal(normalizeGeneratedTitle("  Fix Stripe Webhook Retry\n"), "fix-stripe-webhook-retry");
  assert.equal(normalizeGeneratedTitle('"`Refactor Auth Middleware`"'), "refactor-auth-middleware");
});

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

  const binPath = fileURLToPath(new URL("../bin/claude-rename.mjs", import.meta.url));
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
