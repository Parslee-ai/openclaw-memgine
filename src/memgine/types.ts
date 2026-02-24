/**
 * Shared types for the Memgine engine.
 */

/** Fact scope values. */
export type FactScope = "global" | "task" | "hypothetical" | "draft";

/** Fact visibility values. */
export type FactVisibility = "team" | "agent-private";

/** Fact source type. */
export type FactSourceType = "conversation" | "policy" | "system" | "cross-agent";

/** Fact authority level. */
export type FactAuthority = "user" | "agent" | "policy" | "system";

/** A fact record from the Convex store. */
export interface Fact {
  _id: string;
  factId: string;
  factText: string;
  layer: number;
  scope: FactScope;
  visibility: FactVisibility;
  authorAgent: string;
  sourceType: FactSourceType;
  authority: FactAuthority;
  supersedesFactId?: string;
  dependsOn?: string[];
  isActive: boolean;
  sessionKey?: string;
  createdAt: number;
}

/** A scored fact ready for context assembly. */
export interface ScoredFact extends Fact {
  /** Relevance score (0–1). Higher = more relevant. */
  relevanceScore: number;
}

/** Session type for filtering decisions. */
export type SessionType = "main" | "subagent" | "cron" | "group" | "unknown";
