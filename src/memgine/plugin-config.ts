/**
 * Memgine v2 Phase C — Plugin Config Validation
 *
 * Validates and normalizes memgine configuration at load time.
 * Implements Rex RA-1 (version flag) and R-3 (config validation).
 */

import { type MemgineConfig, DEFAULT_CONFIG } from "./v2config.js";

export interface MemginePluginConfig {
  /** Memgine version: 1 = Convex-backed (v1 hooks), 2 = in-memory graph (v2 plugin). Default: 1. */
  version: 1 | 2;
  /** Token budget override. Must be >= 0. */
  tokenBudget?: number;
  /** Fraction of context window for memgine context. Clamped to [0.1, 0.9]. */
  contextBudgetFraction?: number;
  /** Layer fractions. Normalized to sum to 1.0 if they don't. */
  layer1Fraction?: number;
  layer2Fraction?: number;
  layer3Fraction?: number;
  layer4Fraction?: number;
  /** Max environment nodes. Must be >= 0. */
  environmentMax?: number;
  /** Response reservation tokens. Must be >= 0. */
  responseReservation?: number;
  /** Model context window size for dynamic budget calculation. Clamped to minimum 2000. Default: 128000. */
  contextWindow?: number;
}

export interface ConfigValidationResult {
  config: MemgineConfig;
  version: 1 | 2;
  warnings: string[];
  /** Validated context window size for dynamic budget calculation. */
  contextWindow: number;
}

const DEFAULT_CONTEXT_WINDOW = 128000;

/**
 * Validate and normalize memgine plugin config.
 * Returns a validated MemgineConfig + version flag + any warnings + contextWindow.
 */
export function validateMemgineConfig(raw?: Partial<MemginePluginConfig>): ConfigValidationResult {
  const warnings: string[] = [];
  const input = raw ?? {};

  // Version flag (RA-1)
  const version = input.version === 2 ? 2 : 1;

  // Start from defaults
  const config: MemgineConfig = { ...DEFAULT_CONFIG };

  // tokenBudget: reject negatives
  if (input.tokenBudget !== undefined) {
    if (input.tokenBudget < 0) {
      warnings.push(
        `tokenBudget ${input.tokenBudget} is negative; using default ${DEFAULT_CONFIG.tokenBudget}`,
      );
    } else {
      config.tokenBudget = input.tokenBudget;
    }
  }

  // contextBudgetFraction: clamp to [0.1, 0.9]
  if (input.contextBudgetFraction !== undefined) {
    const clamped = Math.min(0.9, Math.max(0.1, input.contextBudgetFraction));
    if (clamped !== input.contextBudgetFraction) {
      warnings.push(`contextBudgetFraction ${input.contextBudgetFraction} clamped to ${clamped}`);
    }
    config.contextBudgetFraction = clamped;
  }

  // environmentMax: reject negatives
  if (input.environmentMax !== undefined) {
    if (input.environmentMax < 0) {
      warnings.push(
        `environmentMax ${input.environmentMax} is negative; using default ${DEFAULT_CONFIG.environmentMax}`,
      );
    } else {
      config.environmentMax = input.environmentMax;
    }
  }

  // responseReservation: reject negatives
  if (input.responseReservation !== undefined) {
    if (input.responseReservation < 0) {
      warnings.push(
        `responseReservation ${input.responseReservation} is negative; using default ${DEFAULT_CONFIG.responseReservation}`,
      );
    } else {
      config.responseReservation = input.responseReservation;
    }
  }

  // Layer fractions: normalize if they don't sum to 1.0
  const hasLayerOverride =
    input.layer1Fraction !== undefined ||
    input.layer2Fraction !== undefined ||
    input.layer3Fraction !== undefined ||
    input.layer4Fraction !== undefined;

  if (hasLayerOverride) {
    let l1 = input.layer1Fraction ?? DEFAULT_CONFIG.layer1Fraction;
    let l2 = input.layer2Fraction ?? DEFAULT_CONFIG.layer2Fraction;
    let l3 = input.layer3Fraction ?? DEFAULT_CONFIG.layer3Fraction;
    let l4 = input.layer4Fraction ?? DEFAULT_CONFIG.layer4Fraction;

    // Reject negatives
    if (l1 < 0 || l2 < 0 || l3 < 0 || l4 < 0) {
      warnings.push("Negative layer fraction(s) detected; using defaults");
      l1 = DEFAULT_CONFIG.layer1Fraction;
      l2 = DEFAULT_CONFIG.layer2Fraction;
      l3 = DEFAULT_CONFIG.layer3Fraction;
      l4 = DEFAULT_CONFIG.layer4Fraction;
    }

    const sum = l1 + l2 + l3 + l4;
    const epsilon = 0.001;

    if (Math.abs(sum - 1.0) > epsilon) {
      warnings.push(`Layer fractions sum to ${sum.toFixed(4)}, not 1.0; normalizing`);
      if (sum > 0) {
        l1 /= sum;
        l2 /= sum;
        l3 /= sum;
        l4 /= sum;
      } else {
        // All zero — fall back to defaults
        l1 = DEFAULT_CONFIG.layer1Fraction;
        l2 = DEFAULT_CONFIG.layer2Fraction;
        l3 = DEFAULT_CONFIG.layer3Fraction;
        l4 = DEFAULT_CONFIG.layer4Fraction;
      }
    }

    config.layer1Fraction = l1;
    config.layer2Fraction = l2;
    config.layer3Fraction = l3;
    config.layer4Fraction = l4;
  }

  // contextWindow (RA-3): reject negatives, clamp minimum to 2000
  let contextWindow = DEFAULT_CONTEXT_WINDOW;
  if (input.contextWindow !== undefined) {
    if (input.contextWindow < 0) {
      warnings.push(
        `contextWindow ${input.contextWindow} is negative; using default ${DEFAULT_CONTEXT_WINDOW}`,
      );
    } else if (input.contextWindow < 2000) {
      warnings.push(
        `contextWindow ${input.contextWindow} is below minimum 2000; clamping to 2000`,
      );
      contextWindow = 2000;
    } else {
      contextWindow = input.contextWindow;
    }
  }

  return { config, version, warnings, contextWindow };
}
