/**
 * Memgine v2 — Engine: graph-based memory orchestrator.
 *
 * Provides ingest methods and context assembly per the paper's
 * proven six-layer algorithm (Section 4).
 */

import { MemoryGraph } from "./graph.js";
import { stem, synonymExpand } from "./text.js";
import {
  type MemNode,
  MemKind,
  EdgeKind,
  isValidKind,
  tokenEstimate,
  emptyMetadata,
} from "./types.js";
import { type MemgineConfig, DEFAULT_CONFIG, effectiveBudget, layerTokens } from "./v2config.js";
import {
  saveGraphSnapshot,
  loadGraphSnapshot,
  appendConversation,
  loadConversations,
} from "./persistence.js";
import {
  consolidate,
  shouldConsolidate,
  type ConsolidationConfig,
  type ConsolidationResult,
  DEFAULT_CONSOLIDATION_CONFIG,
} from "./consolidation.js";
import { detectReflections, type ReflectionInsight } from "./compaction.js";

export class MemgineEngine {
  public graph: MemoryGraph;
  public needsReview = new Set<string>();

  private cfg: MemgineConfig;
  private consolidationCfg: ConsolidationConfig;
  private factIdCounts = new Map<string, number>();

  /** Persistence paths (null = persistence disabled). */
  private graphPath: string | null = null;
  private conversationPath: string | null = null;

  /** Ingestion counter for auto-snapshot triggering. */
  private ingestionsSinceSnapshot = 0;

  constructor(config?: Partial<MemgineConfig>, consolidationConfig?: Partial<ConsolidationConfig>) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this.consolidationCfg = { ...DEFAULT_CONSOLIDATION_CONFIG, ...consolidationConfig };
    this.graph = new MemoryGraph();
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  /**
   * Enable persistence. Call after constructor to set file paths.
   */
  enablePersistence(graphPath: string, conversationPath: string): void {
    this.graphPath = graphPath;
    this.conversationPath = conversationPath;
  }

  /**
   * Load graph state from JSONL snapshot.
   * Must call enablePersistence() first.
   */
  loadSnapshot(): void {
    if (!this.graphPath) {return;}
    this.graph = loadGraphSnapshot(this.graphPath);
  }

  /**
   * Load conversations from JSONL and replay into graph.
   * Must call enablePersistence() first.
   */
  loadConversationHistory(): void {
    if (!this.conversationPath) {return;}
    const turns = loadConversations(this.conversationPath);
    for (const turn of turns) {
      // Insert into graph without re-persisting to conversation store
      this.graph.insert({
        kind: MemKind.Conversation,
        layer: 3,
        key: turn.speaker,
        value: `${turn.speaker}: ${turn.text}`,
        scope: "global",
        authority: "peer",
        isConstraint: false,
        createdAt: turn.ts,
        contentType: "natural_language",
        metadata: emptyMetadata(),
      });
    }
  }

  /**
   * Persist current graph state to JSONL snapshot.
   */
  persistSnapshot(): void {
    if (!this.graphPath) {return;}
    saveGraphSnapshot(this.graph, this.graphPath);
    this.ingestionsSinceSnapshot = 0;
  }

  /**
   * Run consolidation pass (prune, GC, compact, reflect, persist).
   */
  consolidate(): ConsolidationResult | null {
    if (!this.graphPath || !this.conversationPath) {return null;}
    const result = consolidate(
      this,
      this.graphPath,
      this.conversationPath,
      this.consolidationCfg,
    );
    this.ingestionsSinceSnapshot = 0;
    return result;
  }

  /**
   * Check if consolidation should be triggered.
   */
  shouldConsolidate(): boolean {
    if (!this.conversationPath) {return false;}
    return shouldConsolidate(
      this.conversationPath,
      this.ingestionsSinceSnapshot,
      this.consolidationCfg,
    );
  }

  /**
   * Detect self-reflection insights from current conversation history.
   */
  detectReflections(): ReflectionInsight[] {
    if (!this.conversationPath) {return [];}
    const turns = loadConversations(this.conversationPath);
    return detectReflections(turns);
  }

  // ── Ingest Methods ─────────────────────────────────────────────────────────

  ingestIdentity(name: string, authority: string): number {
    return this.graph.insert({
      kind: MemKind.Identity,
      layer: 1,
      key: "identity",
      value: `User: ${name}\nRole: ${authority}`,
      scope: "global",
      authority,
      isConstraint: false,
      createdAt: 0, // earliest possible — always first
      contentType: "natural_language",
      metadata: emptyMetadata(),
    });
  }

  ingestFact(
    factId: string,
    key: string,
    value: string,
    opts?: {
      authority?: string;
      scope?: string;
      supersedes?: string;
      dependsOn?: string[];
      isConstraint?: boolean;
    },
  ): number {
    const authority = opts?.authority ?? "peer";
    const scope = opts?.scope ?? "global";
    const isConstraint = opts?.isConstraint ?? false;

    // Deduplicate fact_id
    const count = (this.factIdCounts.get(factId) ?? 0) + 1;
    this.factIdCounts.set(factId, count);
    const effectiveId = count > 1 ? `${factId}-${count}` : factId;

    this.ingestionsSinceSnapshot++;

    const nix = this.graph.insert({
      kind: MemKind.Fact,
      layer: 2,
      key,
      value,
      factId: effectiveId,
      scope,
      authority,
      isConstraint,
      createdAt: Date.now(),
      contentType: "natural_language",
      metadata: emptyMetadata(),
    });

    // Dependency edges
    if (opts?.dependsOn) {
      for (const depId of opts.dependsOn) {
        const dep = this.graph.getByFactId(depId);
        if (dep) {
          this.graph.link(nix, dep.nodeIndex, EdgeKind.DependsOn, 1.0);
        }
      }
    }

    // RelatedTo edges for facts with the same key
    const sameKey = this.graph
      .validFacts()
      .filter((f) => f.nodeIndex !== nix && f.node.key === key);
    for (const other of sameKey) {
      this.graph.link(nix, other.nodeIndex, EdgeKind.RelatedTo, 0.5);
    }

    // Supersession
    if (opts?.supersedes) {
      const sup = opts.supersedes;
      // Try direct factId, then search by key
      let targetId: string | null = null;
      if (this.graph.getByFactId(sup)) {
        targetId = sup;
      } else {
        const byKey = this.graph.validFacts().find((f) => f.node.key === sup);
        if (byKey?.node.factId) {
          targetId = byKey.node.factId;
        }
      }

      if (targetId) {
        const invalidated = this.graph.supersede(nix, targetId);
        for (const invIdx of invalidated) {
          const invNode = this.graph.getNode(invIdx);
          if (invNode?.factId && invNode.factId !== effectiveId) {
            this.needsReview.add(invNode.factId);
          }
        }
      }
    }

    return nix;
  }

  ingestConversation(speaker: string, text: string, ts: number): number {
    // Write-through to conversation store
    if (this.conversationPath) {
      appendConversation(this.conversationPath, speaker, text, ts);
    }

    this.ingestionsSinceSnapshot++;

    return this.graph.insert({
      kind: MemKind.Conversation,
      layer: 3,
      key: speaker,
      value: `${speaker}: ${text}`,
      scope: "global",
      authority: "peer",
      isConstraint: false,
      createdAt: ts,
      contentType: "natural_language",
      metadata: emptyMetadata(),
    });
  }

  ingestEnvironment(key: string, value: string, ts: number, expiresAt?: number): number {
    return this.graph.insert({
      kind: MemKind.Environment,
      layer: 4,
      key,
      value,
      scope: "global",
      authority: "system",
      isConstraint: false,
      createdAt: ts,
      expiresAt,
      contentType: "natural_language",
      metadata: emptyMetadata(),
    });
  }

  // ── Context Assembly ───────────────────────────────────────────────────────

  /**
   * Build context using the paper's six-layer algorithm.
   * contextWindow: model's context window size (e.g. 8192, 128000)
   */
  buildContext(query: string, contextWindow: number): string {
    return this.buildContextInternal(query, contextWindow, false);
  }

  /**
   * Fast mode — skips PPR, skills, known unknowns.
   */
  buildContextFast(query: string, contextWindow: number): string {
    return this.buildContextInternal(query, contextWindow, true);
  }

  private buildContextInternal(query: string, contextWindow: number, fast: boolean): string {
    const sections: string[] = [];
    const budget = effectiveBudget(this.cfg, contextWindow);

    // === 1. Identity (always, verbatim) ===
    for (const { node } of this.graph.nodesByLayer(1)) {
      if (node.kind === MemKind.Identity) {
        sections.push(`## Identity\n${node.value}`);
      }
    }

    // === 2. Active Constraints ===
    const constraints = this.graph.constraints();
    if (constraints.length > 0) {
      const lines = constraints.map(
        ({ node }) => `⚠️ [${node.factId ?? "?"}] ${node.key}: ${node.value}`,
      );
      sections.push(`## Constraints\n${lines.join("\n")}`);
    }

    // === 3. Current Facts ===
    const allValid = this.graph.validFacts().filter(({ node }) => !node.isConstraint);

    // Score facts
    const scored = fast
      ? allValid
          .map((f) => ({ ...f, score: 0 }))
          .toSorted((a, b) => a.node.createdAt - b.node.createdAt)
      : this.scoreFacts(query, allValid);

    // Budget-aware truncation: drop lowest-scored first
    const factBudget = layerTokens(this.cfg, budget, 2);
    let keepStart = 0;
    let tokensAcc = 0;
    for (let i = scored.length - 1; i >= 0; i--) {
      tokensAcc += tokenEstimate(scored[i].node.value);
      if (tokensAcc > factBudget) {
        keepStart = i + 1;
        break;
      }
    }
    // Always keep at least the most relevant fact
    const maxStart = Math.max(0, scored.length - 1);
    const keptFacts = scored.slice(Math.min(keepStart, maxStart));

    // Build inline repair map
    const inlineRepairs = fast ? new Map<number, number[]>() : this.buildInlineRepairMap();
    const emittedRepairs = new Set<number>();

    const factLines: string[] = [];
    for (const { nodeIndex, node } of keptFacts) {
      const typeMarker = this.memoryTypeMarker(node);
      const depNote = this.depAnnotation(nodeIndex);
      const correction = this.correctionAnnotation(nodeIndex);
      const fid = node.factId ?? "?";
      factLines.push(`- [${fid}] ${typeMarker}${node.key}: ${node.value}${depNote}${correction}`);

      // Inline repair
      const staleDeps = inlineRepairs.get(nodeIndex);
      if (staleDeps) {
        for (const staleIdx of staleDeps) {
          if (!emittedRepairs.has(staleIdx)) {
            emittedRepairs.add(staleIdx);
            const sn = this.graph.getNode(staleIdx);
            if (sn) {
              const sfid = sn.factId ?? "?";
              factLines.push(
                `  ⚠️ RECALCULATE [${sfid}]: ${sn.value} (depends on: ${fid})\n    was based on old value — recalculate with current value above`,
              );
            }
          }
        }
      }
    }

    // Orphan invalidations
    const orphans = fast ? [] : this.orphanInvalidations(emittedRepairs);

    if (factLines.length > 0) {
      sections.push(`## Facts\n${factLines.join("\n")}`);
    }
    if (orphans.length > 0) {
      sections.push(`## Outdated\n${orphans.join("\n")}`);
    }

    // === 4. Recent Conversation ===
    const allConv = this.graph
      .nodesByLayer(3)
      .filter(
        ({ node }) =>
          node.kind === MemKind.Conversation || node.kind === MemKind.ConversationSummary,
      )
      .toSorted((a, b) => b.node.createdAt - a.node.createdAt);

    const convBudget = layerTokens(this.cfg, budget, 3);
    let convTokens = 0;
    const verbatimLines: string[] = [];

    // Raw conversation (most recent first, reversed later)
    const rawConv = allConv.filter(({ node }) => node.kind === MemKind.Conversation).toReversed(); // chronological
    const filtered = this.filterConversation(rawConv.map(({ node }) => node));

    for (let i = filtered.length - 1; i >= 0; i--) {
      const est = tokenEstimate(filtered[i].value);
      if (convTokens + est > convBudget) {
        break;
      }
      convTokens += est;
      verbatimLines.unshift(filtered[i].value);
    }

    // Summaries (older, compacted)
    const summaryNodes = allConv
      .filter(({ node }) => node.kind === MemKind.ConversationSummary)
      .toSorted((a, b) => a.node.createdAt - b.node.createdAt);

    const summaryLines: string[] = [];
    for (const { node } of summaryNodes) {
      const est = tokenEstimate(node.value);
      if (convTokens + est > convBudget) {
        break;
      }
      convTokens += est;
      summaryLines.push(node.value);
    }

    const contextParts: string[] = [];
    if (summaryLines.length > 0) {
      contextParts.push(`### Earlier (summarized)\n${summaryLines.join("\n")}`);
    }
    if (verbatimLines.length > 0) {
      contextParts.push(`### Recent\n${verbatimLines.join("\n")}`);
    }
    if (contextParts.length > 0) {
      sections.push(`## Conversation\n${contextParts.join("\n\n")}`);
    }

    // === 5. Environment ===
    const now = Date.now();
    const env = this.graph
      .nodesByLayer(4)
      .filter(({ node }) => node.kind === MemKind.Environment)
      .filter(({ node }) => node.expiresAt === undefined || node.expiresAt > now)
      .toSorted((a, b) => b.node.createdAt - a.node.createdAt)
      .slice(0, this.cfg.environmentMax);

    if (env.length > 0) {
      const lines = env.map(({ node }) => `- ${node.key}: ${node.value}`);
      sections.push(`## Environment\n${lines.join("\n")}`);
    }

    return sections.join("\n\n");
  }

  // ── Scoring ────────────────────────────────────────────────────────────────

  private scoreFacts(
    query: string,
    facts: Array<{ nodeIndex: number; node: MemNode }>,
  ): Array<{ nodeIndex: number; node: MemNode; score: number }> {
    const { seeds, weights } = this.graph.findSeedsWeighted(query, 5);
    const activationMap = new Map<number, number>();
    if (seeds.length > 0) {
      const hits = this.graph.retrievePPR(seeds, weights, 0.5, 50);
      for (const h of hits) {
        activationMap.set(h.nodeIndex, h.activation);
      }
    }

    const scored = facts.map(({ nodeIndex, node }) => {
      const act = activationMap.get(nodeIndex) ?? 0;
      const kw = this.keywordOverlap(query, node.key, node.value);
      const score = Math.max(act, kw);
      return { nodeIndex, node, score };
    });

    // ASCENDING — least relevant first, most relevant LAST (recency attention)
    scored.sort((a, b) => a.score - b.score);
    return scored;
  }

  private keywordOverlap(query: string, key: string, value: string): number {
    const q = query.toLowerCase();
    const tokens = new Set(q.split(/[\s\p{P}]+/u).filter((s) => s.length > 0));
    if (tokens.size === 0) {
      return 0;
    }

    const text = `${key} ${value}`.toLowerCase();
    const textTokens = new Set(text.split(/[\s\p{P}]+/u).filter((s) => s.length > 0));
    const textStems = new Set<string>();
    for (const t of textTokens) {
      textStems.add(stem(t));
    }

    let hits = 0;
    for (const t of tokens) {
      if (text.includes(t)) {
        hits++;
        continue;
      }
      const tStem = stem(t);
      if (textStems.has(tStem)) {
        hits++;
        continue;
      }
      const syns = synonymExpand(t);
      let found = false;
      for (const s of syns) {
        if (textTokens.has(s) || textStems.has(stem(s))) {
          found = true;
          break;
        }
      }
      if (found) {
        hits++;
      }
    }
    return hits / tokens.size;
  }

  // ── Annotation helpers ─────────────────────────────────────────────────────

  private memoryTypeMarker(node: MemNode): string {
    switch (node.authority) {
      case "system":
      case "policy":
      case "executive":
        return "[org] ";
      case "user":
      case "peer":
        return "[usr] ";
      default:
        return "[ext] ";
    }
  }

  private depAnnotation(nodeIndex: number): string {
    const deps: string[] = [];
    for (const edge of this.graph.edgesFrom(nodeIndex)) {
      if (edge.kind === EdgeKind.DependsOn) {
        const target = this.graph.getNode(edge.to);
        if (target?.factId) {
          deps.push(target.factId);
        }
      }
    }
    return deps.length > 0 ? ` (depends on: ${deps.join(", ")})` : "";
  }

  private correctionAnnotation(nodeIndex: number): string {
    for (const edge of this.graph.edgesFrom(nodeIndex)) {
      if (edge.kind === EdgeKind.Supersedes) {
        const old = this.graph.getNode(edge.to);
        if (old) {
          return ` (changed from: ${old.value})`;
        }
      }
    }
    return "";
  }

  private buildInlineRepairMap(): Map<number, number[]> {
    const map = new Map<number, number[]>();
    for (const fid of this.needsReview) {
      const stale = this.graph.getByFactId(fid);
      if (!stale) {
        continue;
      }
      const staleIdx = stale.nodeIndex;

      for (const edge of this.graph.edgesFrom(staleIdx)) {
        if (edge.kind !== EdgeKind.DependsOn) {
          continue;
        }
        const depNode = this.graph.getNode(edge.to);
        if (!depNode || depNode.kind !== MemKind.FactSuperseded) {
          continue;
        }

        // Find the corrector (who supersedes the dep)
        const supersedingEdges = this.graph.edgesTo(edge.to);
        for (const se of supersedingEdges) {
          if (se.kind === EdgeKind.Supersedes) {
            const corrector = this.graph.getNode(se.from);
            if (corrector && isValidKind(corrector.kind)) {
              const arr = map.get(se.from) ?? [];
              arr.push(staleIdx);
              map.set(se.from, arr);
            }
          }
        }
      }
    }
    return map;
  }

  private orphanInvalidations(emitted: Set<number>): string[] {
    const result: string[] = [];
    for (const fid of this.needsReview) {
      const entry = this.graph.getByFactId(fid);
      if (!entry) {
        continue;
      }
      if (emitted.has(entry.nodeIndex)) {
        continue;
      }
      result.push(`⚠️ OUTDATED [${fid}]: ${entry.node.value} — may no longer be accurate`);
    }
    return result;
  }

  // ── Conversation filter (interruption/scope removal) ───────────────────────

  private filterConversation(nodes: MemNode[]): MemNode[] {
    // Pass 1: Remove interruption blocks
    let result: MemNode[] = [];
    let skip = false;
    for (const node of nodes) {
      const lower = node.value.toLowerCase();
      if (
        !skip &&
        (lower.includes("hold on") ||
          lower.includes("pause this") ||
          lower.includes("one moment") ||
          lower.includes("quick interruption") ||
          lower.includes("sorry, need to") ||
          lower.includes("let me handle") ||
          lower.includes("stepping away"))
      ) {
        skip = true;
        continue;
      }
      if (
        skip &&
        (lower.includes("back to") ||
          lower.includes("resume") ||
          lower.includes("where were we") ||
          lower.includes("anyway,") ||
          lower.includes("returning to") ||
          lower.includes("back on track") ||
          lower.includes("incident resolved"))
      ) {
        skip = false;
        result.push(node);
        continue;
      }
      if (!skip) {
        result.push(node);
      }
    }

    // Pass 2: Remove scoped sections
    const filtered: MemNode[] = [];
    let scopeSkip = false;
    for (const node of result) {
      const lower = node.value.toLowerCase();
      if (!scopeSkip && (lower.includes("[scope:") || lower.includes("just exploratory"))) {
        scopeSkip = true;
        continue;
      }
      if (
        scopeSkip &&
        (lower.includes("that's enough") ||
          lower.includes("real commitments") ||
          lower.includes("back to real") ||
          lower.includes("let's talk about real"))
      ) {
        scopeSkip = false;
        continue;
      }
      if (!scopeSkip) {
        filtered.push(node);
      }
    }

    // Pass 3: Strip [SCOPE:] entries
    return filtered.filter((n) => !n.value.toUpperCase().includes("[SCOPE:"));
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  validFactCount(): number {
    return this.graph.validFacts().length;
  }

  reset(): void {
    this.graph.clear();
    this.needsReview.clear();
    this.factIdCounts.clear();
  }
}
