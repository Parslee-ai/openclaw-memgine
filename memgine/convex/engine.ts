import { v } from "convex/values";
import { api } from "./_generated/api";
import { action } from "./_generated/server";

/**
 * Memgine Context Assembly Engine
 *
 * Assembles fact-based context for an agent session by:
 * 1. Vector search for relevant facts
 * 2. Filtering by visibility and session type
 * 3. Applying per-layer token budgets
 * 4. Sorting most relevant facts LAST (recency bias exploitation)
 */

const DEFAULT_BUDGETS = {
  identity: 2000,
  persistent: 8000,
  workingSet: 4000,
  signals: 2000,
};

const LAYER_NAMES: Record<number, string> = {
  1: "Identity & Role",
  2: "Persistent Facts",
  3: "Working Set",
  4: "Environmental Signals",
};

/** Rough token estimate: ~4 chars per token */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface FactRecord {
  factId: string;
  factText: string;
  layer: number;
  scope: string;
  visibility: string;
  authorAgent: string;
  sourceType: string;
  authority: string;
  isActive: boolean;
  createdAt: number;
}

export const assembleContext = action({
  args: {
    queryEmbedding: v.array(v.float64()),
    agentId: v.string(),
    sessionType: v.string(), // "main" | "subagent" | "cron"
    budgets: v.optional(
      v.object({
        identity: v.optional(v.number()),
        persistent: v.optional(v.number()),
        workingSet: v.optional(v.number()),
        signals: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const budgets = {
      ...DEFAULT_BUDGETS,
      ...args.budgets,
    };

    // Step 1: Get active facts per-layer to stay under Convex's 8192 array limit.
    // Subagents/cron only get Layer 1 + Layer 2.
    const layersToFetch =
      args.sessionType === "subagent" || args.sessionType === "cron" ? [1, 2] : [1, 2, 3, 4];

    const layerResults = await Promise.all(
      layersToFetch.map(
        (layer) => ctx.runQuery(api.facts.listActive, { layer }) as Promise<FactRecord[]>,
      ),
    );

    const allFacts: FactRecord[] = layerResults.flat();

    if (allFacts.length === 0) {
      return { context: "", stats: { totalFacts: 0, includedFacts: 0, droppedFacts: 0 } };
    }

    // Step 2: Engine-level filtering
    const filtered = allFacts.filter((f) => {
      // Visibility: agent-private facts only visible to author
      if (f.visibility === "agent-private" && f.authorAgent !== args.agentId) {
        return false;
      }
      // Scope: hypothetical/draft excluded unless explicitly queried
      if (f.scope === "hypothetical" || f.scope === "draft") {
        return false;
      }
      return true;
    });

    // Step 3: Vector search for relevance scoring
    const vectorResults = await ctx.runAction(api.embeddings.searchByVector, {
      queryEmbedding: args.queryEmbedding,
      limit: 256,
    });

    // Build relevance score map
    const scoreMap = new Map<string, number>();
    for (const r of vectorResults) {
      scoreMap.set(r.factId, r.score);
    }

    // Attach scores (default 0 for facts not in vector results)
    const scored = filtered.map((f) => ({
      ...f,
      relevanceScore: scoreMap.get(f.factId) ?? 0,
    }));

    // Step 4: Group by layer and apply budgets
    const layerGroups: Record<number, typeof scored> = { 1: [], 2: [], 3: [], 4: [] };
    for (const f of scored) {
      if (layerGroups[f.layer]) {
        layerGroups[f.layer].push(f);
      }
    }

    const layerBudgetMap: Record<number, number> = {
      1: budgets.identity,
      2: budgets.persistent,
      3: budgets.workingSet,
      4: budgets.signals,
    };

    let includedFacts = 0;
    let droppedFacts = 0;
    const contextParts: string[] = [];

    for (const layer of [1, 2, 3, 4]) {
      const facts = layerGroups[layer];
      if (facts.length === 0) {
        continue;
      }

      // Sort by relevance ascending (least relevant first, most relevant last)
      facts.sort((a, b) => a.relevanceScore - b.relevanceScore);

      const budget = layerBudgetMap[layer];
      let usedTokens = 0;
      const included: string[] = [];

      // Include facts from most relevant (end) to least relevant (start)
      // but we'll reverse to apply budget from least relevant first
      for (const f of facts) {
        const factLine =
          f.authorAgent !== args.agentId ? `${f.authorAgent} reported: ${f.factText}` : f.factText;
        const tokens = estimateTokens(factLine);

        if (layer === 1 || usedTokens + tokens <= budget) {
          // Layer 1 never compacts
          included.push(factLine);
          usedTokens += tokens;
          includedFacts++;
        } else {
          droppedFacts++;
        }
      }

      if (included.length > 0) {
        contextParts.push(`## ${LAYER_NAMES[layer]}\n\n${included.join("\n")}`);
      }
    }

    const context = contextParts.join("\n\n---\n\n");

    return {
      context,
      stats: {
        totalFacts: allFacts.length,
        filteredFacts: filtered.length,
        includedFacts,
        droppedFacts,
        layers: Object.fromEntries([1, 2, 3, 4].map((l) => [l, layerGroups[l].length])),
      },
    };
  },
});
