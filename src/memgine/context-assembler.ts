/**
 * Memgine Context Assembler — the core engine.
 *
 * Assembles deterministic, query-relevant context from the fact store.
 * Replaces flat-file memory (MEMORY.md, WORKING.md) with structured facts.
 *
 * Pipeline:
 * 1. Fetch all active facts from Convex
 * 2. Filter by visibility, scope, and session type
 * 3. Score by relevance (vector search or recency fallback)
 * 4. Group by layer, apply per-layer token budgets
 * 5. Sort within layer: most relevant LAST (recency bias exploitation)
 * 6. Render into text with attribution
 */

import { applyLayerBudgets, getLayerName } from "./budget.js";
import { MemgineClient } from "./client.js";
import { resolveLayerBudgets, type MemgineConfig } from "./config.js";
import type { Fact, ScoredFact, SessionType } from "./types.js";

/** Options for context assembly. */
export interface AssembleContextOptions {
  /** The user's current query/message. */
  query: string;
  /** The requesting agent's identifier (e.g., "grace", "delores"). */
  agentId: string;
  /** The session key (e.g., "agent:dev:main"). */
  sessionKey: string;
  /** Session type for filtering decisions. */
  sessionType: SessionType;
}

/**
 * Determine session type from a session key string.
 */
export function inferSessionType(sessionKey?: string): SessionType {
  if (!sessionKey) return "unknown";
  if (sessionKey.includes(":subagent:")) return "subagent";
  if (sessionKey.includes(":cron:")) return "cron";
  if (sessionKey.includes(":main")) return "main";
  // Group chats, Discord channels, etc.
  if (sessionKey.includes(":group:") || sessionKey.includes(":channel:")) return "group";
  return "unknown";
}

export class ContextAssembler {
  private readonly client: MemgineClient;
  private readonly config: MemgineConfig;

  constructor(config: MemgineConfig) {
    this.client = new MemgineClient(config.convexUrl);
    this.config = config;
  }

  /**
   * Assemble context from the fact store for injection into the system prompt.
   *
   * @returns Rendered text suitable for inclusion in bootstrap context.
   */
  async assembleContext(options: AssembleContextOptions): Promise<string> {
    const { agentId, sessionType } = options;

    // 1. Fetch all active facts
    let facts: Fact[];
    try {
      facts = await this.client.fetchActiveFacts();
    } catch (err) {
      console.warn(`[memgine] Failed to fetch facts: ${String(err)}`);
      return ""; // Graceful degradation — no context rather than crash
    }

    if (facts.length === 0) {
      return "";
    }

    // 2. Filter by visibility, scope, and session type
    const filtered = this.filterFacts(facts, agentId, sessionType);

    if (filtered.length === 0) {
      return "";
    }

    // 3. Score by relevance
    const scored = await this.scoreFacts(filtered, options);

    // 4. Group by layer
    const byLayer = new Map<number, ScoredFact[]>();
    for (const fact of scored) {
      const layer = fact.layer;
      if (!byLayer.has(layer)) byLayer.set(layer, []);
      byLayer.get(layer)!.push(fact);
    }

    // Sort within each layer: ascending by relevance (most relevant last = recency bias)
    for (const [, layerFacts] of byLayer) {
      layerFacts.sort((a, b) => a.relevanceScore - b.relevanceScore);
    }

    // 5. Apply per-layer token budgets
    const budgets = resolveLayerBudgets(this.config);
    const budgeted = applyLayerBudgets(byLayer, budgets);

    // 6. Render
    return this.renderContext(budgeted);
  }

  /**
   * Filter facts based on visibility, scope, and session type.
   */
  private filterFacts(
    facts: Fact[],
    agentId: string,
    sessionType: SessionType,
  ): Fact[] {
    return facts.filter((fact) => {
      // Visibility: agent-private facts only visible to author
      if (fact.visibility === "agent-private" && fact.authorAgent !== agentId) {
        return false;
      }

      // Scope: hypothetical and draft excluded by default
      if (fact.scope === "hypothetical" || fact.scope === "draft") {
        return false;
      }

      // Session type: subagents and cron only get Layer 1
      if ((sessionType === "subagent" || sessionType === "cron") && fact.layer !== 1) {
        return false;
      }

      return true;
    });
  }

  /**
   * Score facts by relevance. Uses vector search if embeddings are available,
   * falls back to recency-based ordering.
   */
  private async scoreFacts(
    facts: Fact[],
    _options: AssembleContextOptions,
  ): Promise<ScoredFact[]> {
    // Phase 2: Recency-based fallback scoring.
    // Vector search scoring will be added in Phase 3 when embeddings are generated.
    //
    // Score formula: newer facts get higher relevance scores.
    // Normalized to 0–1 range based on age relative to oldest fact.

    if (facts.length === 0) return [];

    const now = Date.now();
    const oldest = Math.min(...facts.map((f) => f.createdAt));
    const range = now - oldest || 1; // Avoid division by zero

    return facts.map((fact) => ({
      ...fact,
      relevanceScore: (fact.createdAt - oldest) / range,
    }));
  }

  /**
   * Render scored, budgeted facts into text for context injection.
   */
  private renderContext(factsByLayer: Map<number, ScoredFact[]>): string {
    const sections: string[] = [];

    // Render layers in order (1, 2, 3, 4)
    const sortedLayers = [...factsByLayer.keys()].sort((a, b) => a - b);

    for (const layer of sortedLayers) {
      const facts = factsByLayer.get(layer);
      if (!facts || facts.length === 0) continue;

      const layerName = getLayerName(layer);
      const lines: string[] = [`## ${layerName}`];

      for (const fact of facts) {
        // Include attribution for cross-agent facts
        if (fact.sourceType === "cross-agent" && fact.authorAgent) {
          lines.push(`- [${fact.authorAgent}] ${fact.factText}`);
        } else {
          lines.push(`- ${fact.factText}`);
        }
      }

      sections.push(lines.join("\n"));
    }

    if (sections.length === 0) return "";

    return `# Memgine Context\n\n${sections.join("\n\n")}\n`;
  }
}
