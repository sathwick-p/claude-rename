/**
 * Session discovery and parsing utilities.
 * Finds all Claude Code session JSONL files and extracts metadata.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

export function cwdToProjectDir(cwd) {
  return cwd.replace(/\//g, "-");
}

export function projectDirToCwd(dir) {
  return dir.replace(/^-/, "/").replace(/-/g, "/");
}

/**
 * Discover all session JSONL files across all projects.
 * Returns array of { sessionId, projectDir, projectPath, jsonlPath, mtime }
 */
export function discoverSessions(filterProject = null) {
  const sessions = [];

  if (!existsSync(PROJECTS_DIR)) return sessions;

  const projectDirs = readdirSync(PROJECTS_DIR).filter((d) => {
    const full = join(PROJECTS_DIR, d);
    try {
      return statSync(full).isDirectory();
    } catch {
      return false;
    }
  });

  for (const projectDir of projectDirs) {
    if (filterProject) {
      const projectPath = projectDirToCwd(projectDir);
      if (
        !projectPath.includes(filterProject) &&
        !projectDir.includes(filterProject)
      ) {
        continue;
      }
    }

    const projectPath = join(PROJECTS_DIR, projectDir);
    let files;
    try {
      files = readdirSync(projectPath).filter((f) => UUID_REGEX.test(f));
    } catch {
      continue;
    }

    for (const file of files) {
      const jsonlPath = join(projectPath, file);
      const sessionId = basename(file, ".jsonl");
      try {
        const stats = statSync(jsonlPath);
        sessions.push({
          sessionId,
          projectDir,
          projectPath: projectDirToCwd(projectDir),
          jsonlPath,
          mtime: stats.mtime,
          size: stats.size,
        });
      } catch {}
    }
  }

  // Sort by modification time, newest first
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

/**
 * Parse a session JSONL file to extract metadata and conversation.
 */
export function parseSession(jsonlPath) {
  const result = {
    customTitle: null,
    userMessages: [],
    assistantMessages: [],
    startedAt: null,
    gitBranch: null,
    version: null,
    messageCount: 0,
  };

  try {
    const content = readFileSync(jsonlPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        if (entry.type === "custom-title") {
          result.customTitle = entry.customTitle;
        }

        if (entry.type === "user" && entry.message?.content) {
          const text = extractText(entry.message.content);
          if (text && !isSystemMessage(text)) {
            result.userMessages.push(text);
            result.messageCount++;
          }
          if (!result.startedAt && entry.timestamp) {
            result.startedAt = entry.timestamp;
          }
          if (!result.gitBranch && entry.gitBranch) {
            result.gitBranch = entry.gitBranch;
          }
          if (!result.version && entry.version) {
            result.version = entry.version;
          }
        }

        if (entry.type === "assistant" && entry.message?.content) {
          const text = extractText(entry.message.content);
          if (text) {
            result.assistantMessages.push(text);
            result.messageCount++;
          }
        }
      } catch {}
    }
  } catch {}

  return result;
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
