/**
 * Memgine bootstrap hook — integrates with the agent:bootstrap internal hook.
 *
 * When Memgine is enabled, this hook:
 * 1. Assembles context from the fact store
 * 2. Adds a synthetic MEMGINE_CONTEXT.md file to bootstrapFiles[]
 * 3. Preserves existing files (SOUL.md, AGENTS.md, etc.) — Phase 2 is additive
 */

import type { AgentBootstrapHookContext } from "../hooks/internal-hooks.js";
import { isAgentBootstrapEvent, type InternalHookEvent } from "../hooks/internal-hooks.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import { ContextAssembler, inferSessionType } from "./context-assembler.js";
import { isMemgineEnabled, resolveMemgineConfig } from "./config.js";

/**
 * The Memgine bootstrap hook handler.
 *
 * Registered on the "agent:bootstrap" event key.
 * Assembles fact-store context and injects it as a synthetic bootstrap file.
 */
export async function memgineBootstrapHook(event: InternalHookEvent): Promise<void> {
  if (!isAgentBootstrapEvent(event)) return;

  const context = event.context as AgentBootstrapHookContext;
  const cfg = context.cfg;

  if (!isMemgineEnabled(cfg)) return;

  const memgineCfg = resolveMemgineConfig(cfg);
  if (!memgineCfg) return;

  const sessionKey = context.sessionKey ?? context.sessionId ?? "unknown";
  const agentId =
    context.agentId ?? resolveAgentIdFromSessionKey(sessionKey) ?? "unknown";
  const sessionType = inferSessionType(sessionKey);

  try {
    const assembler = new ContextAssembler(memgineCfg);
    const assembledContext = await assembler.assembleContext({
      query: "", // No user query available at bootstrap time; recency-based scoring
      agentId,
      sessionKey,
      sessionType,
    });

    if (!assembledContext) return;

    // Add synthetic bootstrap file with assembled Memgine context
    const memgineFile: WorkspaceBootstrapFile = {
      name: "MEMORY.md" as WorkspaceBootstrapFile["name"], // Reuse MEMORY.md slot
      path: `${context.workspaceDir}/MEMGINE_CONTEXT.md`,
      content: assembledContext,
      missing: false,
    };

    // Remove the original MEMORY.md if present (Memgine replaces it)
    context.bootstrapFiles = context.bootstrapFiles.filter(
      (f) => f.name !== "MEMORY.md" && f.name !== "memory.md",
    );

    // Add the Memgine context file
    context.bootstrapFiles.push(memgineFile);
  } catch (err) {
    // Graceful degradation — if Memgine fails, don't break the agent
    console.warn(`[memgine] Bootstrap hook failed: ${String(err)}`);
  }
}
