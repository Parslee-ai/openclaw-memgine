/**
 * Token budget manager for Memgine context assembly.
 *
 * Uses simple character-based approximation (chars / 4 ≈ tokens).
 * Applies per-layer budgets with simple drop compaction.
 */

import type { MemgineLayerBudgets } from "./config.js";
import type { ScoredFact } from "./types.js";

/** Approximate token count from text. ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Approximate character count from token budget. */
export function tokensToChars(tokens: number): number {
  return tokens * 4;
}

/**
 * Layer names for readability.
 */
const LAYER_NAMES: Record<number, string> = {
  1: "Identity & Role",
  2: "Persistent Facts",
  3: "Working Set",
  4: "Environmental Signals",
};

export function getLayerName(layer: number): string {
  return LAYER_NAMES[layer] ?? `Layer ${layer}`;
}

/**
 * Get the token budget for a specific layer.
 */
export function getLayerBudget(layer: number, budgets: MemgineLayerBudgets): number {
  switch (layer) {
    case 1:
      return budgets.identity;
    case 2:
      return budgets.persistent;
    case 3:
      return budgets.workingSet;
    case 4:
      return budgets.signals;
    default:
      return 1000;
  }
}

/**
 * Apply per-layer token budgets using simple drop compaction.
 *
 * Facts within each layer are assumed to be sorted by relevance (ascending).
 * When over budget, the lowest-relevance facts (at the beginning) are dropped.
 *
 * @returns Facts that fit within the budget, grouped by layer.
 */
export function applyLayerBudgets(
  factsByLayer: Map<number, ScoredFact[]>,
  budgets: MemgineLayerBudgets,
): Map<number, ScoredFact[]> {
  const result = new Map<number, ScoredFact[]>();

  for (const [layer, facts] of factsByLayer) {
    const budget = getLayerBudget(layer, budgets);
    const charBudget = tokensToChars(budget);

    // Layer 1 never compacts
    if (layer === 1) {
      result.set(layer, facts);
      continue;
    }

    // Facts are sorted ascending by relevance.
    // Drop from the beginning (lowest relevance) until within budget.
    let totalChars = facts.reduce((sum, f) => sum + f.factText.length, 0);
    let startIdx = 0;

    while (totalChars > charBudget && startIdx < facts.length) {
      totalChars -= facts[startIdx]!.factText.length;
      startIdx++;
    }

    result.set(layer, facts.slice(startIdx));
  }

  return result;
}
