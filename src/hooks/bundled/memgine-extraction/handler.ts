/**
 * Memgine Extraction Hook
 *
 * Fires on message:sent events to trigger async fact extraction.
 * Does NOT block response delivery — extraction runs in the background.
 *
 * Phase 3 of Memgine implementation.
 */

import { isMessageSentEvent, type InternalHookHandler } from "../../internal-hooks.js";

// Track turn indices per session for extraction logging
const sessionTurnCounters = new Map<string, number>();

/**
 * Derive agent ID from session key.
 * Example: "agent:dev:main" → "dev"
 */
function resolveAgentId(sessionKey: string): string {
  const parts = sessionKey.split(":");
  return parts.length >= 2 ? parts[1] : "unknown";
}

/**
 * Determine source type from session key context.
 */
function resolveSourceType(sessionKey: string): "conversation" | "cross-agent" {
  // Cross-agent sessions typically have patterns like agent:<id>:subagent or agent-to-agent
  if (sessionKey.includes("subagent") || sessionKey.includes("cross")) {
    return "cross-agent";
  }
  return "conversation";
}

/**
 * Get and increment turn counter for a session.
 */
function getNextTurnIndex(sessionKey: string): number {
  const current = sessionTurnCounters.get(sessionKey) ?? 0;
  sessionTurnCounters.set(sessionKey, current + 1);
  // Clean up old sessions to prevent memory leak (keep last 1000)
  if (sessionTurnCounters.size > 1000) {
    const entries = Array.from(sessionTurnCounters.entries());
    const toRemove = entries.slice(0, entries.length - 500);
    for (const [key] of toRemove) {
      sessionTurnCounters.delete(key);
    }
  }
  return current;
}

const memgineExtractionHook: InternalHookHandler = async (event) => {
  if (!isMessageSentEvent(event)) {
    return;
  }

  const context = event.context;

  // Only process successful sends
  if (!context.success) {
    return;
  }

  // Need a session key for tracking
  const sessionKey = event.sessionKey;
  if (!sessionKey || !sessionKey.startsWith("agent:")) {
    return;
  }

  // Resolve config
  // The event context might not have cfg directly, so we check the global config via env
  const convexSiteUrl =
    process.env.MEMGINE_CONVEX_SITE_URL || "https://necessary-gecko-572.convex.site";
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const extractionModel = process.env.MEMGINE_EXTRACTION_MODEL || "anthropic/claude-haiku-4-5";
  const minContentLength = 20;

  if (!openrouterApiKey || !openaiApiKey) {
    // Can't extract without API keys
    return;
  }

  const content = context.content;
  if (!content || content.length < minContentLength) {
    return;
  }

  // Skip heartbeat-only responses
  if (content.trim() === "HEARTBEAT_OK") {
    return;
  }

  const agentId = resolveAgentId(sessionKey);
  const sourceType = resolveSourceType(sessionKey);
  const turnIndex = getNextTurnIndex(sessionKey);

  // Build the turn content for extraction
  // The message:sent event has the assistant's response in context.content
  // We include the recipient context for better extraction
  const turnContent = `[Agent: ${agentId}] [Session: ${sessionKey}] [To: ${context.to}]\n\nAssistant response:\n${content}`;

  // Fire and forget — do NOT await. Extraction must not block.
  triggerExtraction({
    convexSiteUrl,
    turnContent,
    agentId,
    sessionKey,
    turnIndex,
    sourceType,
    model: extractionModel,
    apiKey: openrouterApiKey,
    openaiApiKey,
  }).catch((err) => {
    console.error(`[memgine-extraction] Async extraction failed: ${String(err)}`);
  });
};

async function triggerExtraction(params: {
  convexSiteUrl: string;
  turnContent: string;
  agentId: string;
  sessionKey: string;
  turnIndex: number;
  sourceType: "conversation" | "cross-agent";
  model: string;
  apiKey: string;
  openaiApiKey: string;
}): Promise<void> {
  const url = `${params.convexSiteUrl}/api/extract`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      turnContent: params.turnContent,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      turnIndex: params.turnIndex,
      sourceType: params.sourceType,
      model: params.model,
      apiKey: params.apiKey,
      openaiApiKey: params.openaiApiKey,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Extraction API error: ${resp.status} ${errText}`);
  }

  const result = await resp.json();
  if ((result as { factsExtracted?: number }).factsExtracted) {
    console.log(
      `[memgine-extraction] Extracted ${(result as { factsExtracted: number }).factsExtracted} facts from ${params.agentId} turn ${params.turnIndex}`,
    );
  }
}

export default memgineExtractionHook;
