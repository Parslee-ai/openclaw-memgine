/**
 * Session memory hook handler
 *
 * On /new or /reset: extracts recent conversation, forwards to memgine
 * extraction endpoint for structured fact storage. Falls back to writing
 * markdown files when memgine is unreachable.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";
import type { HookHandler } from "../../hooks.js";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import { resolveStateDir } from "../../../config/paths.js";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { hasInterSessionUserProvenance } from "../../../sessions/input-provenance.js";
import { resolveHookConfig } from "../../config.js";
import { generateSlugViaLLM } from "../../llm-slug-generator.js";

const log = createSubsystemLogger("hooks/session-memory");

/**
 * Read recent messages from session file for slug generation
 */
async function getRecentSessionContent(
  sessionFilePath: string,
  messageCount: number = 15,
): Promise<string | null> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");

    // Parse JSONL and extract user/assistant messages first
    const allMessages: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Session files have entries with type="message" containing a nested message object
        if (entry.type === "message" && entry.message) {
          const msg = entry.message;
          const role = msg.role;
          if ((role === "user" || role === "assistant") && msg.content) {
            if (role === "user" && hasInterSessionUserProvenance(msg)) {
              continue;
            }
            // Extract text content
            const text = Array.isArray(msg.content)
              ? // oxlint-disable-next-line typescript/no-explicit-any
                msg.content.find((c: any) => c.type === "text")?.text
              : msg.content;
            if (text && !text.startsWith("/")) {
              allMessages.push(`${role}: ${text}`);
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    // Then slice to get exactly messageCount messages
    const recentMessages = allMessages.slice(-messageCount);
    return recentMessages.join("\n");
  } catch {
    return null;
  }
}

/**
 * Try the active transcript first; if /new already rotated it,
 * fallback to the latest .jsonl.reset.* sibling.
 */
async function getRecentSessionContentWithResetFallback(
  sessionFilePath: string,
  messageCount: number = 15,
): Promise<string | null> {
  const primary = await getRecentSessionContent(sessionFilePath, messageCount);
  if (primary) {
    return primary;
  }

  try {
    const dir = path.dirname(sessionFilePath);
    const base = path.basename(sessionFilePath);
    const resetPrefix = `${base}.reset.`;
    const files = await fs.readdir(dir);
    const resetCandidates = files.filter((name) => name.startsWith(resetPrefix)).toSorted();

    if (resetCandidates.length === 0) {
      return primary;
    }

    const latestResetPath = path.join(dir, resetCandidates[resetCandidates.length - 1]);
    const fallback = await getRecentSessionContent(latestResetPath, messageCount);

    if (fallback) {
      log.debug("Loaded session content from reset fallback", {
        sessionFilePath,
        latestResetPath,
      });
    }

    return fallback || primary;
  } catch {
    return primary;
  }
}

function stripResetSuffix(fileName: string): string {
  const resetIndex = fileName.indexOf(".reset.");
  return resetIndex === -1 ? fileName : fileName.slice(0, resetIndex);
}

async function findPreviousSessionFile(params: {
  sessionsDir: string;
  currentSessionFile?: string;
  sessionId?: string;
}): Promise<string | undefined> {
  try {
    const files = await fs.readdir(params.sessionsDir);
    const fileSet = new Set(files);

    const baseFromReset = params.currentSessionFile
      ? stripResetSuffix(path.basename(params.currentSessionFile))
      : undefined;
    if (baseFromReset && fileSet.has(baseFromReset)) {
      return path.join(params.sessionsDir, baseFromReset);
    }

    const trimmedSessionId = params.sessionId?.trim();
    if (trimmedSessionId) {
      const canonicalFile = `${trimmedSessionId}.jsonl`;
      if (fileSet.has(canonicalFile)) {
        return path.join(params.sessionsDir, canonicalFile);
      }

      const topicVariants = files
        .filter(
          (name) =>
            name.startsWith(`${trimmedSessionId}-topic-`) &&
            name.endsWith(".jsonl") &&
            !name.includes(".reset."),
        )
        .toSorted()
        .toReversed();
      if (topicVariants.length > 0) {
        return path.join(params.sessionsDir, topicVariants[0]);
      }
    }

    if (!params.currentSessionFile) {
      return undefined;
    }

    const nonResetJsonl = files
      .filter((name) => name.endsWith(".jsonl") && !name.includes(".reset."))
      .toSorted()
      .toReversed();
    if (nonResetJsonl.length > 0) {
      return path.join(params.sessionsDir, nonResetJsonl[0]);
    }
  } catch {
    // Ignore directory read errors.
  }
  return undefined;
}

/**
 * Forward session content to memgine extraction endpoint.
 * Returns true on success, false on failure.
 */
async function forwardToMemgine(params: {
  convexSiteUrl: string;
  sessionContent: string;
  agentId: string;
  sessionKey: string;
  openrouterApiKey: string;
  openaiApiKey: string;
}): Promise<boolean> {
  const url = `${params.convexSiteUrl}/api/extract`;
  const turnContent = `[Agent: ${params.agentId}] [Session: ${params.sessionKey}] [Source: session-boundary]\n\nSession summary:\n${params.sessionContent}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: turnContent,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      turnIndex: -1, // Sentinel: session-boundary extraction
      model: process.env.MEMGINE_EXTRACTION_MODEL || "anthropic/claude-haiku-4-5",
      apiKey: params.openrouterApiKey,
      openaiApiKey: params.openaiApiKey,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    log.warn("Memgine extraction POST failed", { status: resp.status, error: errText });
    return false;
  }

  const result = (await resp.json()) as { factsExtracted?: number };
  log.info(`Forwarded session to memgine: ${result.factsExtracted ?? 0} facts extracted`);
  return true;
}

/**
 * Save session context to memory when /new or /reset command is triggered.
 * Primary path: forward to memgine for structured fact extraction.
 * Fallback: write markdown file when memgine is unreachable.
 */
const saveSessionToMemory: HookHandler = async (event) => {
  // Only trigger on reset/new commands
  const isResetCommand = event.action === "new" || event.action === "reset";
  if (event.type !== "command" || !isResetCommand) {
    return;
  }

  try {
    log.debug("Hook triggered for reset/new command", { action: event.action });

    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
    const workspaceDir = cfg
      ? resolveAgentWorkspaceDir(cfg, agentId)
      : path.join(resolveStateDir(process.env, os.homedir), "workspace");

    // Prefer previousSessionEntry (old session before /new) over current (which may be empty)
    const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<
      string,
      unknown
    >;
    const currentSessionId = sessionEntry.sessionId as string;
    let currentSessionFile = (sessionEntry.sessionFile as string) || undefined;

    // If sessionFile is empty or looks like a new/reset file, try to find the previous session file.
    if (!currentSessionFile || currentSessionFile.includes(".reset.")) {
      const sessionsDirs = new Set<string>();
      if (currentSessionFile) {
        sessionsDirs.add(path.dirname(currentSessionFile));
      }
      sessionsDirs.add(path.join(workspaceDir, "sessions"));

      for (const sessionsDir of sessionsDirs) {
        const recoveredSessionFile = await findPreviousSessionFile({
          sessionsDir,
          currentSessionFile,
          sessionId: currentSessionId,
        });
        if (!recoveredSessionFile) {
          continue;
        }
        currentSessionFile = recoveredSessionFile;
        log.debug("Found previous session file", { file: currentSessionFile });
        break;
      }
    }

    log.debug("Session context resolved", {
      sessionId: currentSessionId,
      sessionFile: currentSessionFile,
      hasCfg: Boolean(cfg),
    });

    const sessionFile = currentSessionFile || undefined;

    // Read hook config
    const hookConfig = resolveHookConfig(cfg, "session-memory");
    const messageCount =
      typeof hookConfig?.messages === "number" && hookConfig.messages > 0
        ? hookConfig.messages
        : 15;
    const archiveToMarkdown = hookConfig?.archiveToMarkdown === true;

    let sessionContent: string | null = null;

    if (sessionFile) {
      sessionContent = await getRecentSessionContentWithResetFallback(sessionFile, messageCount);
      log.debug("Session content loaded", {
        length: sessionContent?.length ?? 0,
        messageCount,
      });
    }

    // Skip if no meaningful content to extract
    if (!sessionContent || sessionContent.trim().length < 20) {
      log.debug("Session content too short for extraction, skipping");
      return;
    }

    // Resolve memgine config: use resolveHookConfig (command events carry cfg) with env fallback
    const convexSiteUrl =
      (hookConfig?.convexSiteUrl as string | undefined) || process.env.MEMGINE_CONVEX_SITE_URL;
    const openrouterApiKey = process.env.OPENROUTER_API_KEY;
    const openaiApiKey = process.env.OPENAI_API_KEY;
    const memgineAvailable = Boolean(convexSiteUrl && openrouterApiKey && openaiApiKey);

    if (!memgineAvailable) {
      const missing = [
        !convexSiteUrl && "MEMGINE_CONVEX_SITE_URL",
        !openrouterApiKey && "OPENROUTER_API_KEY",
        !openaiApiKey && "OPENAI_API_KEY",
      ].filter(Boolean);
      log.debug("Memgine unavailable, missing keys", { missing });
    }

    let memgineSuccess = false;

    if (memgineAvailable) {
      // Attempt memgine forwarding; fall back to markdown on failure
      try {
        memgineSuccess = await forwardToMemgine({
          convexSiteUrl: convexSiteUrl!,
          sessionContent,
          agentId,
          sessionKey: event.sessionKey,
          openrouterApiKey: openrouterApiKey!,
          openaiApiKey: openaiApiKey!,
        });
      } catch (err) {
        log.warn("Memgine forwarding threw", { error: String(err) });
      }
    }

    // Write markdown if: archiveToMarkdown is on, OR memgine forwarding failed (safety net)
    const shouldWriteMarkdown = archiveToMarkdown || !memgineSuccess;

    if (shouldWriteMarkdown) {
      if (!memgineSuccess && !archiveToMarkdown) {
        log.warn("Memgine unavailable or failed — falling back to markdown archive");
      }

      const memoryDir = path.join(workspaceDir, "memory");
      await fs.mkdir(memoryDir, { recursive: true });

      const now = new Date(event.timestamp);
      const dateStr = now.toISOString().split("T")[0];

      // Generate slug: only call LLM if we're actively archiving to markdown
      let slug: string | null = null;
      const isTestEnv =
        process.env.OPENCLAW_TEST_FAST === "1" ||
        process.env.VITEST === "true" ||
        process.env.VITEST === "1" ||
        process.env.NODE_ENV === "test";
      const allowLlmSlug = !isTestEnv && hookConfig?.llmSlug !== false && archiveToMarkdown;

      if (sessionContent && cfg && allowLlmSlug) {
        slug = await generateSlugViaLLM({ sessionContent, cfg });
      }

      if (!slug) {
        const timeSlug = now.toISOString().split("T")[1].split(".")[0].replace(/:/g, "");
        slug = timeSlug.slice(0, 4);
      }

      const filename = `${dateStr}-${slug}.md`;
      const memoryFilePath = path.join(memoryDir, filename);
      const timeStr = now.toISOString().split("T")[1].split(".")[0];
      const sessionId = (sessionEntry.sessionId as string) || "unknown";
      const source = (context.commandSource as string) || "unknown";

      const entryParts = [
        `# Session: ${dateStr} ${timeStr} UTC`,
        "",
        `- **Session Key**: ${event.sessionKey}`,
        `- **Session ID**: ${sessionId}`,
        `- **Source**: ${source}`,
        "",
      ];

      if (sessionContent) {
        entryParts.push("## Conversation Summary", "", sessionContent, "");
      }

      const entry = entryParts.join("\n");

      await writeFileWithinRoot({
        rootDir: memoryDir,
        relativePath: filename,
        data: entry,
        encoding: "utf-8",
      });

      const relPath = memoryFilePath.replace(os.homedir(), "~");
      log.info(`Session context saved to ${relPath}`);
    }
  } catch (err) {
    if (err instanceof Error) {
      log.error("Failed to save session memory", {
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
      });
    } else {
      log.error("Failed to save session memory", { error: String(err) });
    }
  }
};

export default saveSessionToMemory;
