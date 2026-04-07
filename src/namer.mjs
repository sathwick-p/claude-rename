/**
 * Title generation via claude -p (pipe mode).
 * Uses the user's existing Claude Code subscription. No separate API key needed.
 */

import { buildTitlePrompt, generateTitleViaCLI } from "./title-prompt.mjs";

/**
 * Generate a title using Claude Code pipe mode.
 * @param {string[]} userMessages
 * @param {string[]} assistantMessages
 * @param {string} model - Claude model to use (default: "haiku")
 */
export async function generateTitle(userMessages, assistantMessages, model = "haiku") {
  try {
    const prompt = buildTitlePrompt(userMessages, assistantMessages, {
      replyInstruction: "Reply with ONLY the title, nothing else",
      includeQuotesNote: true,
    });
    const title = await generateTitleViaCLI(prompt, model);
    if (title) return { title, method: "claude" };
  } catch {}

  return null;
}
