/**
 * Memgine v2 Phase C — OpenClaw Plugin Definition
 *
 * Registers the v2 in-memory graph engine as an OpenClaw plugin with typed hooks:
 * - session_start → load graph snapshot + conversations
 * - before_prompt_build → assemble context via PPR retrieval
 * - message_received → ingest user message
 * - message_sent → ingest assistant message (fire-and-forget)
 * - session_end → persist snapshot + conditional consolidation
 *
 * Architecture decisions (from Rex's review):
 * - RA-1: v1→v2 transition via `memgine.version` config flag
 * - RA-2: No dedicated heartbeat hook — consolidation in session_end
 * - RA-3: Singleton engine map (module-level Map<string, MemgineEngine>)
 */

import * as os from "os";
import * as path from "path";
import type {
  OpenClawPluginDefinition,
  OpenClawPluginApi,
  PluginHookSessionStartEvent,
  PluginHookSessionContext,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookAgentContext,
  PluginHookMessageReceivedEvent,
  PluginHookMessageContext,
  PluginHookMessageSentEvent,
  PluginHookSessionEndEvent,
} from "../plugins/types.js";
import { MemgineEngine } from "./engine.js";
import { validateMemgineConfig, type MemginePluginConfig } from "./plugin-config.js";

// ── Singleton Engine Map ───────────────────────────────────────────────────────

/** Module-level engine map keyed by workspaceDir. */
const engines = new Map<string, MemgineEngine>();

/** Tracks last access time for TTL eviction. */
const engineLastAccess = new Map<string, number>();

/** Engine eviction TTL: 1 hour. */
const ENGINE_TTL_MS = 60 * 60 * 1000;

/**
 * Get or create a MemgineEngine for a workspace directory.
 * Engines are cached in a module-level map (RA-3).
 */
export function getOrCreateEngine(
  workspaceDir: string,
  pluginConfig?: Partial<MemginePluginConfig>,
): MemgineEngine {
  let engine = engines.get(workspaceDir);
  if (engine) {
    engineLastAccess.set(workspaceDir, Date.now());
    return engine;
  }

  const { config } = validateMemgineConfig(pluginConfig);

  engine = new MemgineEngine(config);

  const memgineDir = path.join(workspaceDir, ".memgine");
  const graphPath = path.join(memgineDir, "graph.jsonl");
  const conversationPath = path.join(memgineDir, "conversations.jsonl");
  engine.enablePersistence(graphPath, conversationPath);

  engines.set(workspaceDir, engine);
  engineLastAccess.set(workspaceDir, Date.now());

  return engine;
}

/**
 * Evict engines unused for more than ENGINE_TTL_MS.
 * Called on session_end to keep memory bounded.
 */
export function evictStaleEngines(): number {
  const now = Date.now();
  let evicted = 0;

  for (const [dir, lastAccess] of engineLastAccess) {
    if (now - lastAccess > ENGINE_TTL_MS) {
      const engine = engines.get(dir);
      if (engine) {
        try {
          engine.persistSnapshot();
        } catch {
          // Best-effort — don't let eviction failure crash
        }
      }
      engines.delete(dir);
      engineLastAccess.delete(dir);
      evicted++;
    }
  }

  return evicted;
}

/** For testing: clear all cached engines. */
export function clearEngineCache(): void {
  engines.clear();
  engineLastAccess.clear();
}

/** For testing: get the number of cached engines. */
export function engineCacheSize(): number {
  return engines.size;
}

// ── Routing Maps (RA-2) ────────────────────────────────────────────────────────

/** Session routing TTL: 2 hours. */
const SESSION_ROUTING_TTL_MS = 2 * 60 * 60 * 1000;

/** sessionId → workspaceDir. Populated on session_start and before_prompt_build. */
const sessionToWorkspace = new Map<string, string>();

/** Tracks last access time for session routing entries. */
const sessionLastAccess = new Map<string, number>();

/** channelId → workspaceDir. Populated on before_prompt_build. */
const channelToWorkspace = new Map<string, string>();

function evictExpiredSessionEntries(): void {
  const now = Date.now();
  for (const [sessionId, lastAccess] of sessionLastAccess) {
    if (now - lastAccess > SESSION_ROUTING_TTL_MS) {
      sessionToWorkspace.delete(sessionId);
      sessionLastAccess.delete(sessionId);
    }
  }
}

export function getSessionWorkspace(sessionId: string): string | undefined {
  evictExpiredSessionEntries();
  const ws = sessionToWorkspace.get(sessionId);
  if (ws !== undefined) {
    sessionLastAccess.set(sessionId, Date.now());
  }
  return ws;
}

export function getChannelWorkspace(channelId: string): string | undefined {
  return channelToWorkspace.get(channelId);
}

export function sessionMapSize(): number {
  return sessionToWorkspace.size;
}

export function channelMapSize(): number {
  return channelToWorkspace.size;
}

export function clearRoutingMaps(): void {
  sessionToWorkspace.clear();
  sessionLastAccess.clear();
  channelToWorkspace.clear();
}

// ── Workspace Resolution (RA-1) ────────────────────────────────────────────────

/**
 * Resolve workspace directory from hook context.
 * Uses workspaceDir when available; falls back to agentId-based convention.
 */
export function resolveWorkspaceDir(ctx: {
  workspaceDir?: string;
  agentId?: string;
}): string | undefined {
  if (ctx.workspaceDir) {return ctx.workspaceDir;}
  if (ctx.agentId) {
    // Guard against path traversal in agentId
    if (ctx.agentId.includes("..") || ctx.agentId.includes("/") || ctx.agentId.includes("\\")) {
      return undefined;
    }
    return path.join(os.homedir(), ".openclaw", `workspace-${ctx.agentId}`);
  }
  return undefined;
}

// ── Plugin Definition ──────────────────────────────────────────────────────────

const memginePlugin: OpenClawPluginDefinition = {
  id: "memgine-v2",
  name: "Memgine v2",
  description: "Graph-based agent memory with PPR retrieval and layered context assembly",
  version: "2.0.0",
  kind: "memory",

  register(api: OpenClawPluginApi): void {
    const pluginConfig = api.pluginConfig as Partial<MemginePluginConfig> | undefined;
    const { version, warnings, contextWindow } = validateMemgineConfig(pluginConfig);

    for (const w of warnings) {
      api.logger.warn(`[memgine-v2] config: ${w}`);
    }

    // RA-1: Only register v2 hooks when version = 2
    if (version !== 2) {
      api.logger.info("[memgine-v2] version is not 2; v2 hooks NOT registered (v1 hooks active)");
      return;
    }

    api.logger.info("[memgine-v2] Registering v2 hooks (v1 hooks should be disabled)");

    // ── session_start ──────────────────────────────────────────────────────

    api.on("session_start", (event: PluginHookSessionStartEvent, ctx: PluginHookSessionContext) => {
      const workspaceDir = resolveWorkspaceDir(ctx);
      if (!workspaceDir) {
        return;
      }

      // RA-2: Register session → workspace mapping
      sessionToWorkspace.set(ctx.sessionId, workspaceDir);
      sessionLastAccess.set(ctx.sessionId, Date.now());

      const engine = getOrCreateEngine(workspaceDir, pluginConfig);

      try {
        engine.loadSnapshot();
        engine.loadConversationHistory();
        api.logger.info(
          `[memgine-v2] session_start: loaded graph (${engine.graph.nodeCount()} nodes) for ${workspaceDir}`,
        );
      } catch (err) {
        api.logger.error(`[memgine-v2] session_start: failed to load snapshot: ${String(err)}`);
      }
    });

    // ── before_prompt_build ────────────────────────────────────────────────

    api.on(
      "before_prompt_build",
      (
        event: PluginHookBeforePromptBuildEvent,
        ctx: PluginHookAgentContext,
      ): PluginHookBeforePromptBuildResult | void => {
        const workspaceDir = resolveWorkspaceDir(ctx);
        if (!workspaceDir) {
          return;
        }

        // RA-2: Keep routing maps current (before_prompt_build has channelId + sessionId)
        if (ctx.sessionId) {
          sessionToWorkspace.set(ctx.sessionId, workspaceDir);
          sessionLastAccess.set(ctx.sessionId, Date.now());
        }
        if (ctx.channelId) {
          channelToWorkspace.set(ctx.channelId, workspaceDir);
        }

        const engine = engines.get(workspaceDir);
        if (!engine) {
          return;
        }

        try {
          // RA-3: Use validated contextWindow from config instead of hardcoded value
          const context = engine.buildContext(event.prompt, contextWindow);

          if (context && context.trim().length > 0) {
            return { prependContext: context };
          }
        } catch (err) {
          api.logger.error(
            `[memgine-v2] before_prompt_build: context assembly failed: ${String(err)}`,
          );
        }
      },
    );

    // ── message_received (user message) ────────────────────────────────────

    api.on(
      "message_received",
      (event: PluginHookMessageReceivedEvent, ctx: PluginHookMessageContext) => {
        // RA-2: Route via channelId → workspaceDir; no getMostRecentEngine fallback
        const workspaceDir = channelToWorkspace.get(ctx.channelId);
        if (!workspaceDir) {
          api.logger.warn(
            `[memgine-v2] message_received: no workspace for channelId ${ctx.channelId}; skipping`,
          );
          return;
        }

        const engine = engines.get(workspaceDir);
        if (!engine) {
          return;
        }

        try {
          engine.ingestConversation("user", event.content, event.timestamp ?? Date.now());
        } catch (err) {
          api.logger.error(`[memgine-v2] message_received: ingestion failed: ${String(err)}`);
        }
      },
    );

    // ── message_sent (assistant message) ────────────────────────────────────

    api.on("message_sent", (event: PluginHookMessageSentEvent, ctx: PluginHookMessageContext) => {
      if (!event.success) {
        return;
      }

      // RA-2: Route via channelId → workspaceDir; no getMostRecentEngine fallback
      const workspaceDir = channelToWorkspace.get(ctx.channelId);
      if (!workspaceDir) {
        api.logger.warn(
          `[memgine-v2] message_sent: no workspace for channelId ${ctx.channelId}; skipping`,
        );
        return;
      }

      const engine = engines.get(workspaceDir);
      if (!engine) {
        return;
      }

      try {
        engine.ingestConversation("assistant", event.content, Date.now());
      } catch (err) {
        api.logger.error(`[memgine-v2] message_sent: ingestion failed: ${String(err)}`);
      }
    });

    // ── session_end ────────────────────────────────────────────────────────

    api.on(
      "session_end",
      async (event: PluginHookSessionEndEvent, ctx: PluginHookSessionContext) => {
        const workspaceDir = resolveWorkspaceDir(ctx);
        if (!workspaceDir) {
          return;
        }

        // RA-2: Clean up session routing entry
        sessionToWorkspace.delete(ctx.sessionId);
        sessionLastAccess.delete(ctx.sessionId);

        const engine = engines.get(workspaceDir);
        if (!engine) {
          return;
        }

        try {
          engine.persistSnapshot();
          api.logger.info(
            `[memgine-v2] session_end: persisted graph (${engine.graph.nodeCount()} nodes)`,
          );

          if (engine.shouldConsolidate()) {
            api.logger.info(
              "[memgine-v2] session_end: consolidation threshold met, running consolidation",
            );
            const result = engine.consolidate();
            if (result) {
              api.logger.info(
                `[memgine-v2] session_end: consolidation complete — pruned=${result.pruned}, gc=${result.gcRemoved}, compaction=${result.compaction ? "yes" : "no"}`,
              );
              engine.persistSnapshot();
            }
          }
        } catch (err) {
          api.logger.error(
            `[memgine-v2] session_end: persist/consolidation failed: ${String(err)}`,
          );
        }

        evictStaleEngines();
      },
    );
  },
};

export default memginePlugin;
