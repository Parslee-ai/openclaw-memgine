/**
 * Memgine Context Bootstrap Hook
 *
 * Assembles fact-based context from the Memgine engine and injects it
 * as a virtual bootstrap file during agent:bootstrap.
 */

import { resolveHookConfig } from "../../config.js";
import { isAgentBootstrapEvent, type InternalHookHandler } from "../../internal-hooks.js";
import type { WorkspaceBootstrapFile } from "../../../agents/workspace.js";

const HOOK_KEY = "memgine-context";

interface MemgineConfig {
  enabled?: boolean;
  convexUrl?: string;
  embeddingModel?: string;
  openaiApiKey?: string;
  budgets?: {
    identity?: number;
    persistent?: number;
    workingSet?: number;
    signals?: number;
  };
}

/**
 * Derive session type from sessionKey pattern.
 * Examples: "agent:dev:main" → "main", "agent:dev:subagent:xxx" → "subagent", "agent:dev:cron:xxx" → "cron"
 */
function resolveSessionType(sessionKey?: string): string {
  if (!sessionKey) {return "main";}
  const parts = sessionKey.split(":");
  // Pattern: agent:<id>:<type>[:<suffix>]
  if (parts.length >= 3) {
    const type = parts[2];
    if (type === "subagent" || type === "cron") {return type;}
    if (type === "main") {return "main";}
  }
  return "main";
}

/**
 * Derive agent ID from sessionKey.
 * Example: "agent:dev:main" → "dev"
 */
function resolveAgentId(sessionKey?: string, agentId?: string): string {
  if (agentId) {return agentId;}
  if (!sessionKey) {return "unknown";}
  const parts = sessionKey.split(":");
  return parts.length >= 2 ? parts[1] : "unknown";
}

/**
 * Generate embedding for a query string using OpenAI API.
 */
async function generateEmbedding(
  text: string,
  model: string,
  apiKey: string
): Promise<number[]> {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: text.slice(0, 8000), // Truncate to avoid token limits
    }),
  });

  if (!resp.ok) {
    throw new Error(`OpenAI embedding API error: ${resp.status} ${await resp.text()}`);
  }

  const data = (await resp.json()) as unknown as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

/**
 * Call Memgine assembleContext action via Convex HTTP action endpoint.
 */
async function callMemgineAssemble(
  convexUrl: string,
  params: {
    queryEmbedding: number[];
    agentId: string;
    sessionType: string;
    budgets?: MemgineConfig["budgets"];
  }
): Promise<{ context: string; stats: Record<string, unknown> }> {
  // Convex HTTP actions endpoint
  const url = convexUrl.replace(/\/$/, "");
  const actionUrl = `${url}/api/action`;

  const resp = await fetch(actionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "engine:assembleContext",
      args: params,
      format: "json",
    }),
  });

  if (!resp.ok) {
    throw new Error(`Memgine assembleContext error: ${resp.status} ${await resp.text()}`);
  }

  const result = (await resp.json()) as unknown as { value: { context: string; stats: Record<string, unknown> } };
  return result.value;
}

const memgineContextHook: InternalHookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const context = event.context;
  const hookConfig = resolveHookConfig(context.cfg, HOOK_KEY) as MemgineConfig | undefined;

  if (!hookConfig || hookConfig.enabled === false) {
    return;
  }

  const convexUrl = hookConfig.convexUrl || process.env.MEMGINE_CONVEX_URL;
  const openaiApiKey = hookConfig.openaiApiKey || process.env.OPENAI_API_KEY;
  const embeddingModel = hookConfig.embeddingModel || "text-embedding-3-small";

  if (!convexUrl) {
    console.warn("[memgine-context] No convexUrl configured, skipping");
    return;
  }

  if (!openaiApiKey) {
    console.warn("[memgine-context] No OpenAI API key configured, skipping");
    return;
  }

  const agentId = resolveAgentId(context.sessionKey, context.agentId);
  const sessionType = resolveSessionType(context.sessionKey);

  try {
    // Use a generic query for embedding — in the future this could be derived
    // from the user's message or recent conversation context
    const queryText = `Agent ${agentId} session context`;

    const queryEmbedding = await generateEmbedding(queryText, embeddingModel, openaiApiKey);

    const result = await callMemgineAssemble(convexUrl, {
      queryEmbedding,
      agentId,
      sessionType,
      budgets: hookConfig.budgets,
    });

    if (!result.context || result.context.trim().length === 0) {
      // No facts in store yet — skip injection
      return;
    }

    // Remove files that Memgine replaces (MEMORY.md, WORKING.md)
    // Keep identity files (SOUL.md, AGENTS.md, USER.md, TOOLS.md) — those are still
    // useful for onboarding and will eventually be migrated to Layer 1 facts
    const replacedFiles = new Set(["MEMORY.md", "WORKING.md"]);
    const filteredFiles = context.bootstrapFiles.filter(
      (f) => !replacedFiles.has(f.name)
    );

    // Inject Memgine context as a virtual bootstrap file
    const memgineFile = {
      name: "MEMORY.md" as any, // Takes MEMORY.md's slot in context
      path: "[memgine:virtual]",
      content: `# Memgine Context\n\n${result.context}`,
      missing: false,
    } satisfies WorkspaceBootstrapFile;

    context.bootstrapFiles = [...filteredFiles, memgineFile];

    console.log(
      `[memgine-context] Injected ${(result.stats as Record<string, unknown>)?.includedFacts ?? "?"} facts ` +
        `(${(result.stats as Record<string, unknown>)?.droppedFacts ?? 0} dropped) for agent=${agentId} session=${sessionType}`
    );
  } catch (err) {
    console.error(`[memgine-context] Failed to assemble context: ${String(err)}`);
    // Don't block bootstrap on Memgine failure — gracefully degrade
  }
};

export default memgineContextHook;
