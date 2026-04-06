/**
 * Shared title-generation prompt and normalization helpers.
 * Keep the hook fallback and the CLI backfill logic aligned.
 */

const TITLE_PROMPT_RULES = `Rules:
- 3-6 words, kebab-case, lowercase, max 50 characters
- Be SPECIFIC: mention the actual technology, feature, file, or bug
- Focus on WHAT was done, not how the conversation started
- Never include URLs, file paths, or generic words like "help", "work", "session", "project"
- Good: "fix-stripe-webhook-retry", "k8s-helm-ingress-setup", "refactor-auth-middleware"
- Bad: "coding-session", "helping-with-code", "read-and-understand-repo"`;

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
