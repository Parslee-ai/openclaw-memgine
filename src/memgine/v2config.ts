/**
 * Memgine v2 — Configuration.
 *
 * Budget calculations, layer fractions, and thresholds.
 */

export interface MemgineConfig {
  /** Fixed token budget (used when no model context window provided). Default 8000. */
  tokenBudget: number;
  /** Layer fraction for Identity (layer 1). Default 0.05. */
  layer1Fraction: number;
  /** Layer fraction for Facts (layer 2). Default 0.50. */
  layer2Fraction: number;
  /** Layer fraction for Conversation (layer 3). Default 0.30. */
  layer3Fraction: number;
  /** Layer fraction for Environment (layer 4). Default 0.15. */
  layer4Fraction: number;
  /** Max environment nodes in context. Default 5. */
  environmentMax: number;
  /** Tokens reserved for model response. Default 4096. */
  responseReservation: number;
  /** Fraction of remaining window for context assembly. Default 0.40. */
  contextBudgetFraction: number;
}

export const DEFAULT_CONFIG: MemgineConfig = {
  tokenBudget: 8000,
  layer1Fraction: 0.05,
  layer2Fraction: 0.5,
  layer3Fraction: 0.3,
  layer4Fraction: 0.15,
  environmentMax: 5,
  responseReservation: 4096,
  contextBudgetFraction: 0.4,
};

/**
 * Compute effective budget given an optional model context window size.
 * Formula: (contextWindow - responseReservation) * contextBudgetFraction
 * Clamped to minimum 2000 tokens.
 */
export function effectiveBudget(cfg: MemgineConfig, contextWindow?: number): number {
  if (contextWindow !== undefined && contextWindow > 0) {
    const remaining = Math.max(0, contextWindow - cfg.responseReservation);
    const dynamic = Math.floor(remaining * cfg.contextBudgetFraction);
    // Minimum 2000 tokens to remain useful even when context window is small
    return Math.max(dynamic, 2000);
  }
  return cfg.tokenBudget;
}

/** Layer token budget. */
export function layerTokens(cfg: MemgineConfig, budget: number, layer: 1 | 2 | 3 | 4): number {
  switch (layer) {
    case 1:
      return Math.floor(budget * cfg.layer1Fraction);
    case 2:
      return Math.floor(budget * cfg.layer2Fraction);
    case 3:
      return Math.floor(budget * cfg.layer3Fraction);
    case 4:
      return Math.floor(budget * cfg.layer4Fraction);
  }
}
