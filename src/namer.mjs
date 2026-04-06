/**
 * Title generation via claude -p (pipe mode).
 * Uses the user's existing Claude Code subscription. No separate API key needed.
 */

import { execFile } from "child_process";

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
  const userContext = userMessages.slice(0, 3).join("\n\n").slice(0, 1500);
  const assistantContext = assistantMessages
    .slice(0, 1)
    .join("\n")
    .slice(0, 500);

  const prompt = `You generate short session titles for Claude Code conversations.

Rules:
- 3-6 words, kebab-case, lowercase, max 50 characters
- Be SPECIFIC: mention the actual technology, feature, file, or bug
- Focus on WHAT was done, not how the conversation started
- Never include URLs, file paths, or generic words like "help", "work", "session", "project"
- Good: "fix-stripe-webhook-retry", "k8s-helm-ingress-setup", "refactor-auth-middleware"
- Bad: "coding-session", "helping-with-code", "read-and-understand-repo"
- Reply with ONLY the title, nothing else — no explanation, no quotes

User messages:
${userContext}

Assistant response:
${assistantContext}

Title:`;

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

        let title = stdout.trim();
        const lines = title.split("\n").filter((l) => l.trim());
        if (lines.length > 0) title = lines[lines.length - 1].trim();

        title = title
          .replace(/[`'"*]/g, "")
          .replace(/^[^a-z]*/, "")
          .replace(/[.\s]+$/, "")
          .replace(/\s+/g, "-")
          .toLowerCase();

        if (title && title.length >= 5 && title.length <= 50 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(title)) {
          resolve(title);
        } else {
          resolve(null);
        }
      },
    );
  });
}
