/**
 * Memgine — Deterministic Memory Engine for OpenClaw.
 *
 * Entry point for hook registration. Call registerMemgineHooks()
 * during gateway startup to activate the engine.
 */

import { registerInternalHook } from "../hooks/internal-hooks.js";
import { memgineBootstrapHook } from "./bootstrap-hook.js";

export { ContextAssembler, inferSessionType } from "./context-assembler.js";
export { MemgineClient } from "./client.js";
export { isMemgineEnabled, resolveMemgineConfig } from "./config.js";
export type { MemgineConfig, MemgineLayerBudgets } from "./config.js";
export type { Fact, ScoredFact, SessionType } from "./types.js";

/**
 * Register all Memgine hooks with the OpenClaw internal hook system.
 *
 * Should be called once during gateway startup.
 * The hook itself checks if Memgine is enabled in config before acting.
 */
export function registerMemgineHooks(): void {
  registerInternalHook("agent:bootstrap", memgineBootstrapHook);
}
