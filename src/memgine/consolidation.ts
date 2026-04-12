/**
 * Memgine v2 Phase B — Consolidation Pass.
 *
 * Orchestrates graph maintenance:
 * 1. Prune expired nodes
 * 2. GC superseded facts beyond retention depth
 * 3. Compact conversations
 * 4. Run self-reflection detection
 * 5. Persist updated graph snapshot
 *
 * Designed to run during heartbeats (onHeartbeat hook).
 */

import { MemgineEngine } from "./engine.js";
import {
  type CompactionResult,
  type ReflectionInsight,
  compactConversation,
  detectReflections,
} from "./compaction.js";
import {
  saveGraphSnapshot,
  loadConversations,
  rewriteConversations,
  conversationLineCount,
} from "./persistence.js";

// ── Configuration ────────────────────────────────────────────────────────────

export interface ConsolidationConfig {
  /** Max supersession chain depth before GC. Default 3. */
  gcMaxDepth: number;
  /** Keep-recent conversation turns (never compacted). Default 6. */
  keepRecentTurns: number;
  /** Conversation line count threshold to trigger compaction rewrite. Factor of max. Default 1.5. */
  compactionRewriteFactor: number;
  /** Max conversation turns before compaction triggers. Default 100. */
  maxConversationTurns: number;
  /** Long turn character threshold for summarization. Default 500. */
  longTurnThreshold: number;
  /** Number of ingestions between auto-snapshots. Default 50. */
  snapshotInterval: number;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  gcMaxDepth: 3,
  keepRecentTurns: 6,
  compactionRewriteFactor: 1.5,
  maxConversationTurns: 100,
  longTurnThreshold: 500,
  snapshotInterval: 50,
};

// ── Consolidation Result ─────────────────────────────────────────────────────

export interface ConsolidationResult {
  /** Nodes pruned (expired). */
  pruned: number;
  /** Nodes removed by GC (superseded beyond depth). */
  gcRemoved: number;
  /** Conversation compaction result (null if not triggered). */
  compaction: CompactionResult | null;
  /** Self-reflection insights detected. */
  reflections: ReflectionInsight[];
  /** Whether graph snapshot was persisted. */
  persisted: boolean;
}

// ── Consolidation Pass ───────────────────────────────────────────────────────

/**
 * Run a full consolidation pass on the engine.
 *
 * @param engine - The MemgineEngine instance
 * @param graphPath - Path to graph.jsonl
 * @param conversationPath - Path to conversations.jsonl
 * @param config - Consolidation configuration
 */
export function consolidate(
  engine: MemgineEngine,
  graphPath: string,
  conversationPath: string,
  config: Partial<ConsolidationConfig> = {},
): ConsolidationResult {
  const cfg = { ...DEFAULT_CONSOLIDATION_CONFIG, ...config };

  // 1. Prune expired nodes
  const now = Date.now();
  const prunedBefore = engine.graph.nodeCount();
  engine.graph.pruneExpired(now);
  const pruned = prunedBefore - engine.graph.nodeCount();

  // 2. GC superseded facts beyond retention depth
  const gcRemoved = engine.graph.gcSuperseded(cfg.gcMaxDepth);

  // 3. Conversation compaction
  let compaction: CompactionResult | null = null;
  const lineCount = conversationLineCount(conversationPath);

  if (lineCount > cfg.maxConversationTurns) {
    const turns = loadConversations(conversationPath);
    compaction = compactConversation(turns, cfg.keepRecentTurns, cfg.longTurnThreshold);

    // Rewrite if compaction removed enough
    if (compaction.compacted.length < turns.length) {
      rewriteConversations(conversationPath, compaction.compacted);
    }
  }

  // 4. Self-reflection detection
  const recentTurns = loadConversations(conversationPath);
  const reflections = detectReflections(recentTurns);

  // 5. Persist graph snapshot
  saveGraphSnapshot(engine.graph, graphPath);

  return {
    pruned,
    gcRemoved,
    compaction,
    reflections,
    persisted: true,
  };
}

/**
 * Lightweight check: should we trigger consolidation?
 * Returns true if conversation store is bloated or enough ingestions happened.
 */
export function shouldConsolidate(
  conversationPath: string,
  ingestionsSinceLastSnapshot: number,
  config: Partial<ConsolidationConfig> = {},
): boolean {
  const cfg = { ...DEFAULT_CONSOLIDATION_CONFIG, ...config };

  // Trigger if enough ingestions since last snapshot
  if (ingestionsSinceLastSnapshot >= cfg.snapshotInterval) {
    return true;
  }

  // Trigger if conversation store is bloated
  const lineCount = conversationLineCount(conversationPath);
  if (lineCount > cfg.maxConversationTurns * cfg.compactionRewriteFactor) {
    return true;
  }

  return false;
}
