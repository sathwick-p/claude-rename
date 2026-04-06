/**
 * Title generation via claude -p (pipe mode).
 * Uses the user's existing Claude Code subscription. No separate API key needed.
 */

import { execFile } from "child_process";
import { buildTitlePrompt, normalizeGeneratedTitle } from "./title-prompt.mjs";

/**
 * Generate a title using Claude Code pipe mode.
 * @param {string[]} userMessages
 * @param {string[]} assistantMessages
 * @param {string} model - Claude model to use (default: "haiku")
 */
export async function generateTitle(userMessages, assistantMessages, model = "haiku") {
  try {
    const title = await generateTitleViaClaude(userMessages, assistantMessages, model);
    if (title) return { title, method: "claude" };
  } catch {}

  return null;
}

function generateTitleViaClaude(userMessages, assistantMessages, model) {
  const prompt = buildTitlePrompt(userMessages, assistantMessages, {
    replyInstruction: "Reply with ONLY the title, nothing else",
    includeQuotesNote: true,
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
