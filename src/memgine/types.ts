/**
 * Memgine v2 — Type definitions for graph-based memory engine.
 *
 * Port from car-memgine Rust reference to TypeScript.
 * ADR-4: purpose-built graph, no external graph libs.
 */

// ── Node Kinds ─────────────────────────────────────────────────────────────────

export enum MemKind {
  Identity,
  Fact,
  FactSuperseded,
  Conclusion,
  ConclusionInvalidated,
  Skill,
  SkillDeprecated,
  Conversation,
  ConversationSummary,
  Environment,
}

// ── Edge Kinds ─────────────────────────────────────────────────────────────────

export enum EdgeKind {
  Supersedes, // new → old ("I replace you")
  DependsOn, // dependent → dependency ("I need you")
  RelatedTo, // semantic similarity (bidirectional by convention)
  Triggers, // skill → trigger context
  TemporalNext, // conversation ordering
  CitesPremise, // Conclusion → Fact ("I am derived from this premise")
}

// ── Layer Type ─────────────────────────────────────────────────────────────────

export type Layer = 1 | 2 | 3 | 4;

// ── Content Type ───────────────────────────────────────────────────────────────

export type ContentType = "natural_language" | "code" | "structured_data";

// ── Provenance ─────────────────────────────────────────────────────────────────

export interface Provenance {
  source: string;
  reference: string;
  date?: number;
}

// ── Fact Metadata ──────────────────────────────────────────────────────────────

export interface FactMetadata {
  confidence: string;
  provenance: Provenance[];
  affectedFiles: string[];
  tags: string[];
  category: string;
  usageCount: number;
  helpfulCount: number;
  outdatedReports: number;
}

export function emptyMetadata(): FactMetadata {
  return {
    confidence: "",
    provenance: [],
    affectedFiles: [],
    tags: [],
    category: "",
    usageCount: 0,
    helpfulCount: 0,
    outdatedReports: 0,
  };
}

// ── Memory Node ────────────────────────────────────────────────────────────────

export interface MemNode {
  kind: MemKind;
  layer: Layer;
  key: string;
  value: string;
  factId?: string;
  scope: string;
  authority: string;
  isConstraint: boolean;
  createdAt: number; // epoch ms
  expiresAt?: number; // epoch ms
  contentType: ContentType;
  metadata: FactMetadata;
}

// ── Memory Edge ────────────────────────────────────────────────────────────────

export interface MemEdge {
  kind: EdgeKind;
  weight: number;
  createdAt: number; // epoch ms
  from: number; // source node index
  to: number; // target node index
}

// ── Retrieval Hit ──────────────────────────────────────────────────────────────

export interface RetrievalHit {
  nodeIndex: number;
  activation: number;
  hops: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export function isValidKind(kind: MemKind): boolean {
  return (
    kind !== MemKind.FactSuperseded &&
    kind !== MemKind.SkillDeprecated &&
    kind !== MemKind.ConclusionInvalidated
  );
}

export function tokenEstimate(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

/** Expected layer for each MemKind */
export function kindToLayer(kind: MemKind): Layer {
  switch (kind) {
    case MemKind.Identity:
      return 1;
    case MemKind.Fact:
    case MemKind.FactSuperseded:
    case MemKind.Conclusion:
    case MemKind.ConclusionInvalidated:
    case MemKind.Skill:
    case MemKind.SkillDeprecated:
      return 2;
    case MemKind.Conversation:
    case MemKind.ConversationSummary:
      return 3;
    case MemKind.Environment:
      return 4;
  }
}
