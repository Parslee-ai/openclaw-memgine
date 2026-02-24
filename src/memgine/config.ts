/**
 * Memgine configuration types and helpers.
 */

import type { OpenClawConfig } from "../config/config.js";

/** Per-layer token budget configuration. */
export interface MemgineLayerBudgets {
  /** Layer 1 — Identity & Role (never compacts). */
  identity: number;
  /** Layer 2 — Persistent Facts (conservative compaction). */
  persistent: number;
  /** Layer 3 — Working Set (aggressive compaction). */
  workingSet: number;
  /** Layer 4 — Environmental Signals (most aggressive). */
  signals: number;
}

/** Per-agent extraction overrides. */
export interface MemgineAgentConfig {
  extractionPrompt?: string;
}

/** Top-level Memgine configuration. */
export interface MemgineConfig {
  enabled: boolean;
  /** Convex deployment URL for the Memgine fact store. */
  convexUrl: string;
  /** Model used for async fact extraction (Phase 3). */
  extractionModel?: string;
  /** Default extraction prompt or path to prompt file. */
  extractionPrompt?: string;
  /** Per-layer token budgets. */
  layerBudgets?: Partial<MemgineLayerBudgets>;
  /** Compaction strategy. */
  compaction?: {
    strategy?: "simple_drop" | "summary_dag";
    summaryThreshold?: number;
  };
  /** Per-agent overrides. */
  agents?: Record<string, MemgineAgentConfig>;
}

/** Default layer budgets (in approximate tokens). */
export const DEFAULT_LAYER_BUDGETS: MemgineLayerBudgets = {
  identity: 2000,
  persistent: 8000,
  workingSet: 4000,
  signals: 2000,
};

/** Resolve the Memgine config from the OpenClaw config. */
export function resolveMemgineConfig(cfg?: OpenClawConfig): MemgineConfig | undefined {
  if (!cfg) return undefined;
  const raw = (cfg as Record<string, unknown>).memgine;
  if (!raw || typeof raw !== "object") return undefined;
  return raw as MemgineConfig;
}

/** Check if Memgine is enabled. */
export function isMemgineEnabled(cfg?: OpenClawConfig): boolean {
  const mc = resolveMemgineConfig(cfg);
  return mc?.enabled === true && !!mc?.convexUrl;
}

/** Resolve layer budgets with defaults. */
export function resolveLayerBudgets(cfg?: MemgineConfig): MemgineLayerBudgets {
  return {
    ...DEFAULT_LAYER_BUDGETS,
    ...cfg?.layerBudgets,
  };
}
