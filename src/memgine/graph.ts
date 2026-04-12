/**
 * Memgine v2 — The memory graph.
 *
 * Nodes are memory entries, edges are typed relationships.
 * Flat arrays + Maps for O(1) index lookups. No external graph libs.
 * Designed for <10K nodes — linear scans are fine at this scale.
 */

import { tokenize, stem, synonymExpand } from "./text.js";
import {
  type MemNode,
  type MemEdge,
  type Layer,
  type RetrievalHit,
  MemKind,
  EdgeKind,
  isValidKind,
  tokenEstimate,
} from "./types.js";

// ── Internal storage ───────────────────────────────────────────────────────────

interface NodeSlot {
  node: MemNode;
  alive: boolean;
}

export class MemoryGraph {
  // Flat array of node slots. Removed nodes have alive=false.
  private nodes: (NodeSlot | null)[] = [];
  // All edges. Cleaned on node removal.
  private edges: MemEdge[] = [];
  // Secondary indexes
  private byFactId = new Map<string, number>();
  private byKey = new Map<string, number[]>();
  private byLayerIdx: [number[], number[], number[], number[]] = [[], [], [], []];
  // Conversation chaining
  private lastConversation: number | null = null;
  // Free list for removed slots
  private freeList: number[] = [];
  // Suppress auto-linking during snapshot restore
  private suppressAutoLink = false;

  // ── Insert ─────────────────────────────────────────────────────────────────

  insert(node: MemNode): number {
    let idx: number;
    if (this.freeList.length > 0) {
      idx = this.freeList.pop()!;
      this.nodes[idx] = { node, alive: true };
    } else {
      idx = this.nodes.length;
      this.nodes.push({ node, alive: true });
    }

    // Index by factId
    if (node.factId) {
      this.byFactId.set(node.factId, idx);
    }
    // Index by key
    const keyArr = this.byKey.get(node.key);
    if (keyArr) {
      keyArr.push(idx);
    } else {
      this.byKey.set(node.key, [idx]);
    }

    // Index by layer
    const li = Math.min(Math.max(node.layer - 1, 0), 3);
    this.byLayerIdx[li].push(idx);

    // Auto-link conversation nodes temporally (suppressed during snapshot restore)
    if (!this.suppressAutoLink && (node.kind === MemKind.Conversation || node.kind === MemKind.ConversationSummary)) {
      if (this.lastConversation !== null) {
        this.link(this.lastConversation, idx, EdgeKind.TemporalNext, 1.0);
      }
      this.lastConversation = idx;
    }

    return idx;
  }

  // ── Link ───────────────────────────────────────────────────────────────────

  link(from: number, to: number, kind: EdgeKind, weight: number): void {
    this.edges.push({ kind, weight, createdAt: Date.now(), from, to });
  }

  // ── Remove ─────────────────────────────────────────────────────────────────

  remove(nodeIndex: number): void {
    const slot = this.nodes[nodeIndex];
    if (!slot || !slot.alive) {
      return;
    }

    const node = slot.node;

    // Remove from indexes
    if (node.factId) {
      this.byFactId.delete(node.factId);
    }

    const keyArr = this.byKey.get(node.key);
    if (keyArr) {
      const filtered = keyArr.filter((i) => i !== nodeIndex);
      if (filtered.length === 0) {
        this.byKey.delete(node.key);
      } else {
        this.byKey.set(node.key, filtered);
      }
    }

    const li = Math.min(Math.max(node.layer - 1, 0), 3);
    this.byLayerIdx[li] = this.byLayerIdx[li].filter((i) => i !== nodeIndex);

    // Remove all edges referencing this node
    this.edges = this.edges.filter((e) => e.from !== nodeIndex && e.to !== nodeIndex);

    // Mark slot as dead and add to free list
    slot.alive = false;
    this.freeList.push(nodeIndex);

    // Update lastConversation if needed
    if (this.lastConversation === nodeIndex) {
      this.lastConversation = null;
    }
  }

  // ── Supersede ──────────────────────────────────────────────────────────────

  /**
   * Mark old fact as FactSuperseded, add Supersedes edge,
   * cascade invalidation to DependsOn and CitesPremise dependents.
   * Returns set of invalidated node indices.
   */
  supersede(newNodeIndex: number, oldFactId: string): Set<number> {
    const invalidated = new Set<number>();
    const oldIdx = this.byFactId.get(oldFactId);
    if (oldIdx === undefined) {
      return invalidated;
    }

    const oldSlot = this.nodes[oldIdx];
    if (!oldSlot || !oldSlot.alive) {
      return invalidated;
    }

    // Mark old as superseded
    oldSlot.node.kind = MemKind.FactSuperseded;

    // Add Supersedes edge
    this.link(newNodeIndex, oldIdx, EdgeKind.Supersedes, 1.0);
    invalidated.add(oldIdx);

    // Find DependsOn dependents (nodes that have DependsOn edges pointing to oldIdx)
    for (const edge of this.edges) {
      if (edge.to === oldIdx && edge.kind === EdgeKind.DependsOn) {
        invalidated.add(edge.from);
      }
    }

    // CASCADE: invalidate nodes that cite this premise via CitesPremise
    for (const edge of this.edges) {
      if (edge.to === oldIdx && edge.kind === EdgeKind.CitesPremise) {
        const citingSlot = this.nodes[edge.from];
        if (citingSlot && citingSlot.alive) {
          // Anything citing a superseded premise is invalidated
          citingSlot.node.kind = MemKind.ConclusionInvalidated;
          invalidated.add(edge.from);
        }
      }
    }

    return invalidated;
  }

  // ── Lookups ────────────────────────────────────────────────────────────────

  getByFactId(factId: string): { nodeIndex: number; node: MemNode } | undefined {
    const idx = this.byFactId.get(factId);
    if (idx === undefined) {
      return undefined;
    }
    const slot = this.nodes[idx];
    if (!slot || !slot.alive) {
      return undefined;
    }
    return { nodeIndex: idx, node: slot.node };
  }

  getByKey(key: string): Array<{ nodeIndex: number; node: MemNode }> {
    const idxs = this.byKey.get(key) ?? [];
    const result: Array<{ nodeIndex: number; node: MemNode }> = [];
    for (const idx of idxs) {
      const slot = this.nodes[idx];
      if (slot && slot.alive) {
        result.push({ nodeIndex: idx, node: slot.node });
      }
    }
    return result;
  }

  nodesByLayer(layer: Layer): Array<{ nodeIndex: number; node: MemNode }> {
    const li = Math.min(Math.max(layer - 1, 0), 3);
    const result: Array<{ nodeIndex: number; node: MemNode }> = [];
    for (const idx of this.byLayerIdx[li]) {
      const slot = this.nodes[idx];
      if (slot && slot.alive) {
        result.push({ nodeIndex: idx, node: slot.node });
      }
    }
    return result;
  }

  validFacts(): Array<{ nodeIndex: number; node: MemNode }> {
    return this.nodesByLayer(2).filter(({ node }) => node.kind === MemKind.Fact);
  }

  constraints(): Array<{ nodeIndex: number; node: MemNode }> {
    return this.validFacts().filter(({ node }) => node.isConstraint);
  }

  // ── Seed Finding (IDF-weighted) ────────────────────────────────────────────

  findSeedsWeighted(query: string, maxSeeds: number): { seeds: number[]; weights: number[] } {
    const qTokens = tokenize(query);
    if (qTokens.size === 0) {
      return { seeds: [], weights: [] };
    }

    // Compute corpus IDF
    const corpusIdf = this.computeCorpusIdf();

    const scored: [number, number][] = []; // [score, nodeIndex]

    for (let i = 0; i < this.nodes.length; i++) {
      const slot = this.nodes[i];
      if (!slot || !slot.alive) {
        continue;
      }
      if (!isValidKind(slot.node.kind)) {
        continue;
      }

      const text = `${slot.node.key} ${slot.node.value}`.toLowerCase();
      const nTokens = tokenize(text);
      const nStems = new Set<string>();
      for (const t of nTokens) {
        nStems.add(stem(t));
      }

      let weightedHits = 0;
      let weightedTotal = 0;

      for (const qt of qTokens) {
        const termIdf = corpusIdf.get(qt) ?? 1.0;
        weightedTotal += termIdf * 3.0;

        // Exact token match (3x)
        if (nTokens.has(qt)) {
          weightedHits += termIdf * 3.0;
          continue;
        }
        // Stem match (2x)
        const qtStem = stem(qt);
        if (nStems.has(qtStem)) {
          weightedHits += termIdf * 2.0;
          continue;
        }
        // Synonym match (1.5x) — includes substring matching
        const qtSyns = synonymExpand(qt);
        if (qtSyns.size > 0) {
          let found = false;
          for (const s of qtSyns) {
            if (nTokens.has(s) || nStems.has(stem(s)) || text.includes(s)) {
              found = true;
              break;
            }
          }
          if (found) {
            weightedHits += termIdf * 1.5;
            continue;
          }
        }
        // Substring match (1x)
        if (text.includes(qt)) {
          weightedHits += termIdf;
        }
      }

      if (weightedTotal > 0) {
        const matchScore = weightedHits / weightedTotal;
        if (matchScore > 0) {
          scored.push([matchScore, i]);
        }
      }
    }

    scored.sort((a, b) => b[0] - a[0]);
    const top = scored.slice(0, maxSeeds);
    return {
      seeds: top.map(([, idx]) => idx),
      weights: top.map(([w]) => w),
    };
  }

  private computeCorpusIdf(): Map<string, number> {
    let total = 0;
    const docFreq = new Map<string, number>();

    for (const slot of this.nodes) {
      if (!slot || !slot.alive) {
        continue;
      }
      if (!isValidKind(slot.node.kind)) {
        continue;
      }
      total++;

      const text = `${slot.node.key} ${slot.node.value}`.toLowerCase();
      const tokens = tokenize(text);
      const seen = new Set<string>();
      for (const token of tokens) {
        if (!seen.has(token)) {
          seen.add(token);
          docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
        }
      }
    }

    total = Math.max(total, 1);
    const idf = new Map<string, number>();
    for (const [term, df] of docFreq) {
      idf.set(term, Math.max(0.1, Math.log(total / (1 + df))));
    }
    return idf;
  }

  // ── PPR Retrieval ──────────────────────────────────────────────────────────

  /**
   * Personalized PageRank retrieval from seed nodes.
   * damping: probability of following an edge (0.5 = equal chance of follow vs teleport)
   * seedWeights: optional per-seed weights (IDF). If null, uniform.
   */
  retrievePPR(
    seeds: number[],
    seedWeights: number[] | null,
    damping: number,
    maxResults: number,
  ): RetrievalHit[] {
    if (seeds.length === 0) {
      return [];
    }

    // Collect all alive nodes
    const allNodes: number[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.nodes[i]?.alive) {
        allNodes.push(i);
      }
    }
    const n = allNodes.length;
    if (n === 0) {
      return [];
    }

    // Build position map
    const pos = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      pos.set(allNodes[i], i);
    }

    // Build reset vector
    const reset = new Float32Array(n);
    let totalWeight = 0;
    for (let i = 0; i < seeds.length; i++) {
      const p = pos.get(seeds[i]);
      if (p !== undefined) {
        const w = seedWeights ? (seedWeights[i] ?? 1.0) : 1.0;
        reset[p] = w;
        totalWeight += w;
      }
    }
    if (totalWeight > 0) {
      for (let i = 0; i < n; i++) {
        reset[i] /= totalWeight;
      }
    }

    // Cap at 0.4 and renormalize
    const cap = 0.4;
    let needsRenorm = false;
    for (let i = 0; i < n; i++) {
      if (reset[i] > cap) {
        reset[i] = cap;
        needsRenorm = true;
      }
    }
    if (needsRenorm) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += reset[i];
      }
      if (sum > 0) {
        for (let i = 0; i < n; i++) {
          reset[i] /= sum;
        }
      }
    }

    // Initialize scores
    let scores = new Float32Array(reset);

    // Edge weight multipliers
    const edgeMult = (kind: EdgeKind): number => {
      switch (kind) {
        case EdgeKind.Supersedes:
          return 0.3;
        case EdgeKind.DependsOn:
          return 0.8;
        case EdgeKind.RelatedTo:
          return 0.6;
        case EdgeKind.Triggers:
          return 0.9;
        case EdgeKind.TemporalNext:
          return 0.5;
        case EdgeKind.CitesPremise:
          return 0.85;
        default:
          return 0.5;
      }
    };

    // Bidirectional edge kinds
    const bidirectionalKinds = new Set([EdgeKind.RelatedTo, EdgeKind.DependsOn, EdgeKind.Triggers]);

    // Precompute outgoing edge weights per node position
    const outWeights = new Float32Array(n);
    for (const edge of this.edges) {
      const fromPos = pos.get(edge.from);
      if (fromPos !== undefined) {
        outWeights[fromPos] += edge.weight * edgeMult(edge.kind);
      }
      // Also count incoming edges for bidirectional types
      if (bidirectionalKinds.has(edge.kind)) {
        const toPos = pos.get(edge.to);
        if (toPos !== undefined) {
          outWeights[toPos] += edge.weight * edgeMult(edge.kind);
        }
      }
    }

    // PPR iteration
    const maxIters = 30;
    const epsilon = 1e-6;
    let newScores = new Float32Array(n);

    for (let iter = 0; iter < maxIters; iter++) {
      newScores.fill(0);

      // Teleportation
      for (let i = 0; i < n; i++) {
        newScores[i] += (1 - damping) * reset[i];
      }

      // Propagation
      for (let i = 0; i < n; i++) {
        if (scores[i] < epsilon) {
          continue;
        }
        const nodeIdx = allNodes[i];
        const ow = outWeights[i];
        if (ow === 0) {
          continue;
        }

        // Outgoing edges
        for (const edge of this.edges) {
          if (edge.from === nodeIdx) {
            const j = pos.get(edge.to);
            if (j !== undefined) {
              const w = edge.weight * edgeMult(edge.kind);
              newScores[j] += (damping * scores[i] * w) / ow;
            }
          }
          // Bidirectional (incoming edges we traverse backwards)
          if (bidirectionalKinds.has(edge.kind) && edge.to === nodeIdx) {
            const j = pos.get(edge.from);
            if (j !== undefined) {
              const w = edge.weight * edgeMult(edge.kind);
              newScores[j] += (damping * scores[i] * w) / ow;
            }
          }
        }
      }

      // Convergence check
      let delta = 0;
      for (let i = 0; i < n; i++) {
        delta += Math.abs(scores[i] - newScores[i]);
      }
      const temp = scores;
      scores = newScores;
      newScores = temp;
      if (delta < epsilon) {
        break;
      }
    }

    // Collect results (include all alive nodes — consumers filter by kind)
    const hits: RetrievalHit[] = [];
    for (let i = 0; i < n; i++) {
      const nodeIdx = allNodes[i];
      const slot = this.nodes[nodeIdx];
      if (!slot || !slot.alive) {
        continue;
      }
      if (scores[i] < epsilon) {
        continue;
      }
      hits.push({ nodeIndex: nodeIdx, activation: scores[i], hops: 0 });
    }

    hits.sort((a, b) => b.activation - a.activation);
    return hits.slice(0, maxResults);
  }

  // ── Counts ─────────────────────────────────────────────────────────────────

  nodeCount(): number {
    let count = 0;
    for (const slot of this.nodes) {
      if (slot?.alive) {
        count++;
      }
    }
    return count;
  }

  edgeCount(): number {
    // Only count edges where both endpoints are alive
    let count = 0;
    for (const e of this.edges) {
      const from = this.nodes[e.from];
      const to = this.nodes[e.to];
      if (from?.alive && to?.alive) {
        count++;
      }
    }
    return count;
  }

  totalTokens(): number {
    let total = 0;
    for (const slot of this.nodes) {
      if (slot?.alive && isValidKind(slot.node.kind)) {
        total += tokenEstimate(slot.node.value);
      }
    }
    return total;
  }

  // ── GC & Pruning ───────────────────────────────────────────────────────────

  /**
   * Garbage-collect superseded nodes beyond retention depth.
   * Returns number of nodes removed.
   */
  gcSuperseded(maxDepth: number): number {
    const stale: number[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      const slot = this.nodes[i];
      if (!slot?.alive) {
        continue;
      }
      const k = slot.node.kind;
      if (
        k === MemKind.FactSuperseded ||
        k === MemKind.SkillDeprecated ||
        k === MemKind.ConclusionInvalidated
      ) {
        stale.push(i);
      }
    }

    const toRemove: number[] = [];
    for (const nix of stale) {
      let depth = 0;
      let current = nix;
      let reachable = false;

      // Walk backward through Supersedes edges
      while (true) {
        let parent: number | null = null;
        for (const e of this.edges) {
          if (e.to === current && e.kind === EdgeKind.Supersedes && e.from !== current) {
            parent = e.from;
            break;
          }
        }
        if (parent === null) {
          break;
        }

        depth++;
        const parentSlot = this.nodes[parent];
        if (parentSlot?.alive && isValidKind(parentSlot.node.kind)) {
          reachable = true;
          break;
        }
        if (depth > maxDepth) {
          break;
        }
        current = parent;
      }

      if (!reachable || depth > maxDepth) {
        toRemove.push(nix);
      }
    }

    for (const nix of toRemove) {
      this.remove(nix);
    }
    return toRemove.length;
  }

  /** Remove expired nodes (by expiresAt). */
  pruneExpired(now: number): void {
    const expired: number[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      const slot = this.nodes[i];
      if (!slot?.alive) {
        continue;
      }
      if (slot.node.expiresAt !== undefined && slot.node.expiresAt <= now) {
        expired.push(i);
      }
    }
    for (const nix of expired) {
      this.remove(nix);
    }
  }

  // ── Internal helpers for engine ────────────────────────────────────────────

  /** Get node by index (internal use by engine). */
  getNode(idx: number): MemNode | undefined {
    const slot = this.nodes[idx];
    return slot?.alive ? slot.node : undefined;
  }

  /** Get mutable node reference (internal use by engine). */
  getNodeMut(idx: number): MemNode | undefined {
    return this.getNode(idx);
  }

  /** Get all edges involving a node (internal use by engine). */
  edgesFrom(nodeIndex: number): MemEdge[] {
    return this.edges.filter((e) => e.from === nodeIndex);
  }

  edgesTo(nodeIndex: number): MemEdge[] {
    return this.edges.filter((e) => e.to === nodeIndex);
  }

  /** All alive node indices (internal). */
  allNodeIndices(): number[] {
    const result: number[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.nodes[i]?.alive) {
        result.push(i);
      }
    }
    return result;
  }

  /** Get all edges (for persistence serialization). */
  allEdges(): MemEdge[] {
    return this.edges;
  }

  /** Suppress/resume auto-linking (used during snapshot restore). */
  setAutoLink(enabled: boolean): void {
    this.suppressAutoLink = !enabled;
  }

  clear(): void {
    this.nodes = [];
    this.edges = [];
    this.byFactId.clear();
    this.byKey.clear();
    this.byLayerIdx = [[], [], [], []];
    this.lastConversation = null;
    this.freeList = [];
  }
}
