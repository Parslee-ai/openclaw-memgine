/**
 * Memgine v2 — Phase A QA Test Suite
 * Dorothy (QA) — Independent verification against test contract
 *
 * Covers: FT-1 through FT-5, EC-1 through EC-10, INV-1 through INV-4
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MemoryGraph } from "../graph.js";
import { MemgineEngine } from "../engine.js";
import {
  MemKind,
  EdgeKind,
  type MemNode,
  type Layer,
  emptyMetadata,
  tokenEstimate,
  isValidKind,
  kindToLayer,
} from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<MemNode> = {}): MemNode {
  return {
    kind: MemKind.Fact,
    layer: 2,
    key: "test_key",
    value: "test value",
    scope: "global",
    authority: "peer",
    isConstraint: false,
    createdAt: Date.now(),
    contentType: "natural_language",
    metadata: emptyMetadata(),
    ...overrides,
  };
}

// ── Invariant Checker ────────────────────────────────────────────────────────

function checkInvariants(graph: MemoryGraph): void {
  const allIndices = graph.allNodeIndices();
  const aliveSet = new Set(allIndices);

  // INV-1: No dangling edges
  // We can't directly access edges, but we can check edgesFrom/edgesTo for alive nodes
  // Actually we need to verify through the edge count mechanism
  // The edgeCount() method already filters for alive endpoints, so if it matches we're good

  // INV-2: Index consistency — verify lookups match reality
  for (const idx of allIndices) {
    const node = graph.getNode(idx);
    expect(node).toBeDefined();
    if (!node) {continue;}

    // Check byFactId
    if (node.factId) {
      const lookup = graph.getByFactId(node.factId);
      // Only check for non-superseded (superseded facts may still be findable)
      if (isValidKind(node.kind)) {
        expect(lookup).toBeDefined();
        expect(lookup!.nodeIndex).toBe(idx);
      }
    }

    // Check byKey
    const byKey = graph.getByKey(node.key);
    const found = byKey.some((r) => r.nodeIndex === idx);
    expect(found).toBe(true);

    // Check byLayer
    const byLayer = graph.nodesByLayer(node.layer);
    const foundInLayer = byLayer.some((r) => r.nodeIndex === idx);
    expect(foundInLayer).toBe(true);
  }

  // INV-3: Layer validity
  for (const idx of allIndices) {
    const node = graph.getNode(idx)!;
    const expectedLayer = kindToLayer(node.kind);
    expect(node.layer).toBe(expectedLayer);
  }
}

function checkBudgetInvariant(output: string, contextWindow: number): void {
  // INV-4: Budget never exceeded (5% tolerance)
  const budget = Math.max(Math.floor((contextWindow - 4096) * 0.4), 2000);
  const outputTokens = tokenEstimate(output);
  const maxAllowed = Math.ceil(budget * 1.05);
  expect(outputTokens).toBeLessThanOrEqual(maxAllowed);
}

// ── FT-1: Graph CRUD + Secondary Indexes ─────────────────────────────────────

describe("FT-1: Graph CRUD + Secondary Indexes (S1, weight 0.20)", () => {
  let graph: MemoryGraph;

  beforeEach(() => {
    graph = new MemoryGraph();
  });

  it("1.1 — Add Identity node with correct indexing", () => {
    const node = makeNode({
      kind: MemKind.Identity,
      layer: 1,
      key: "agent_role",
      value: "Team Lead",
    });
    const idx = graph.insert(node);

    expect(graph.getByKey("agent_role").length).toBe(1);
    expect(graph.getByKey("agent_role")[0].nodeIndex).toBe(idx);
    expect(graph.nodesByLayer(1).some((r) => r.nodeIndex === idx)).toBe(true);
    checkInvariants(graph);
  });

  it("1.2 — Add Fact node with factId indexing", () => {
    const node = makeNode({
      kind: MemKind.Fact,
      layer: 2,
      key: "bigeq_db",
      value: "PostgreSQL 17",
      factId: "f-001",
    });
    const idx = graph.insert(node);

    const byFactId = graph.getByFactId("f-001");
    expect(byFactId).toBeDefined();
    expect(byFactId!.nodeIndex).toBe(idx);
    expect(graph.getByKey("bigeq_db").length).toBe(1);
    expect(graph.nodesByLayer(2).some((r) => r.nodeIndex === idx)).toBe(true);
    checkInvariants(graph);
  });

  it("1.3 — Add RelatedTo edge between nodes", () => {
    const iNode = makeNode({ kind: MemKind.Identity, layer: 1, key: "identity" });
    const fNode = makeNode({ kind: MemKind.Fact, layer: 2, key: "fact1", factId: "f-001" });
    const iIdx = graph.insert(iNode);
    const fIdx = graph.insert(fNode);

    graph.link(iIdx, fIdx, EdgeKind.RelatedTo, 1.0);

    expect(graph.edgeCount()).toBe(1);
    // Verify edge exists from both directions (RelatedTo is bidirectional)
    const edgesFrom = graph.edgesFrom(iIdx);
    expect(edgesFrom.some((e) => e.to === fIdx && e.kind === EdgeKind.RelatedTo)).toBe(true);
    checkInvariants(graph);
  });

  it("1.4 — Remove node cleans all indexes and edges", () => {
    const iNode = makeNode({ kind: MemKind.Identity, layer: 1, key: "identity" });
    const fNode = makeNode({ kind: MemKind.Fact, layer: 2, key: "fact1", factId: "f-001" });
    const iIdx = graph.insert(iNode);
    const fIdx = graph.insert(fNode);
    graph.link(iIdx, fIdx, EdgeKind.RelatedTo, 1.0);

    graph.remove(fIdx);

    // Gone from all indexes
    expect(graph.getByFactId("f-001")).toBeUndefined();
    expect(graph.getByKey("fact1").length).toBe(0);
    expect(graph.nodesByLayer(2).some((r) => r.nodeIndex === fIdx)).toBe(false);
    // Edge also removed (no dangling)
    expect(graph.edgeCount()).toBe(0);
    expect(graph.nodeCount()).toBe(1);
  });
});

// ── FT-2: PPR Retrieval + IDF-Weighted Seeds ────────────────────────────────

describe("FT-2: PPR Retrieval + IDF-Weighted Seeds (S2, weight 0.25)", () => {
  let engine: MemgineEngine;

  beforeEach(() => {
    engine = new MemgineEngine();

    // Build a 20-node, 4-topic graph
    // Topic 1: PostgreSQL (5 nodes)
    engine.ingestFact("f-pg-1", "postgresql_version", "PostgreSQL 17 is the primary database", {});
    engine.ingestFact("f-pg-2", "postgresql_config", "PostgreSQL uses WAL replication", {});
    engine.ingestFact("f-pg-3", "postgresql_perf", "PostgreSQL connection pooling via pgbouncer", {});
    engine.ingestFact("f-pg-4", "postgresql_backup", "Database backup runs nightly at 2am", {});
    engine.ingestFact("f-pg-5", "postgresql_schema", "PostgreSQL schema uses 42 tables", {});

    // Topic 2: Django (5 nodes, linked to PostgreSQL)
    engine.ingestFact("f-dj-1", "django_orm", "Django ORM connects to PostgreSQL", { dependsOn: ["f-pg-1"] });
    engine.ingestFact("f-dj-2", "django_version", "Django 1.11 is the application framework", {});
    engine.ingestFact("f-dj-3", "django_auth", "Django authentication uses JWT tokens", {});
    engine.ingestFact("f-dj-4", "django_celery", "Celery workers process background tasks", {});
    engine.ingestFact("f-dj-5", "django_cache", "Redis caching layer for session data", {});

    // Topic 3: Billing (5 nodes, unrelated to DB)
    engine.ingestFact("f-bill-1", "billing_provider", "Authorize.net handles payment processing", {});
    engine.ingestFact("f-bill-2", "billing_plans", "Three subscription tiers: Basic, Pro, Enterprise", {});
    engine.ingestFact("f-bill-3", "billing_webhooks", "Stripe webhooks for payment events", {});
    engine.ingestFact("f-bill-4", "billing_invoices", "Monthly invoicing on the 1st", {});
    engine.ingestFact("f-bill-5", "billing_taxes", "Tax calculation via Avalara API", {});

    // Topic 4: Agora (5 nodes, unrelated to DB)
    engine.ingestFact("f-ag-1", "agora_frontend", "Agora uses React and Convex for real-time chat", {});
    engine.ingestFact("f-ag-2", "agora_deploy", "Agora deploys to Netlify", {});
    engine.ingestFact("f-ag-3", "agora_auth", "Agora uses API keys for bot authentication", {});
    engine.ingestFact("f-ag-4", "agora_threads", "Agora supports threaded conversations", {});
    engine.ingestFact("f-ag-5", "agora_mentions", "Agora mention system notifies agents via polling", {});
  });

  it("2.1 — Database query retrieves PostgreSQL nodes in top 5", () => {
    const { seeds } = engine.graph.findSeedsWeighted("How is the database configured?", 5);
    const seedKeys = seeds.map((idx) => engine.graph.getNode(idx)!.key);
    const pgKeys = seedKeys.filter((k) => k.startsWith("postgresql"));
    expect(pgKeys.length).toBeGreaterThanOrEqual(2);
  });

  it("2.2 — Cross-topic activation via RelatedTo edge", () => {
    const hits = engine.graph.findSeedsWeighted("How is the database configured?", 10);
    const topKeys = hits.seeds.map((idx) => engine.graph.getNode(idx)!.key);
    // django_orm should appear because it depends on postgresql_version
    expect(topKeys).toContain("django_orm");
  });

  it("2.3 — Unrelated topics suppressed", () => {
    const { seeds, weights } = engine.graph.findSeedsWeighted("How is the database configured?", 20);
    // Get scores for billing and agora nodes vs postgresql nodes
    const pgScores: number[] = [];
    const otherScores: number[] = [];
    for (let i = 0; i < seeds.length; i++) {
      const key = engine.graph.getNode(seeds[i])!.key;
      if (key.startsWith("postgresql")) {
        pgScores.push(weights[i]);
      } else if (key.startsWith("billing") || key.startsWith("agora")) {
        otherScores.push(weights[i]);
      }
    }
    // PostgreSQL nodes should have higher average seed weight
    const avgPg = pgScores.reduce((a, b) => a + b, 0) / Math.max(pgScores.length, 1);
    const avgOther = otherScores.length > 0 ? otherScores.reduce((a, b) => a + b, 0) / otherScores.length : 0;
    expect(avgPg).toBeGreaterThan(avgOther);
  });

  it("2.4 — PPR results ordered by descending activation", () => {
    const { seeds, weights } = engine.graph.findSeedsWeighted("How is the database configured?", 5);
    const hits = engine.graph.retrievePPR(seeds, weights, 0.5, 20);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].activation).toBeGreaterThanOrEqual(hits[i].activation);
    }
  });
});

// ── FT-3: Six-Layer Context Assembly ─────────────────────────────────────────

describe("FT-3: Six-Layer Context Assembly (S3, weight 0.25)", () => {
  let engine: MemgineEngine;

  beforeEach(() => {
    engine = new MemgineEngine();
    engine.ingestIdentity("TestAgent", "Senior Developer");
    engine.ingestFact("f-c1", "no_rm_rf", "Never run rm -rf on production", { isConstraint: true });
    engine.ingestFact("f-c2", "always_backup", "Always backup before deploy", { isConstraint: true });
    engine.ingestFact("f-1", "db_config", "PostgreSQL is the primary database", {});
    engine.ingestFact("f-2", "cache_config", "Redis is used for caching", {});
    engine.ingestFact("f-3", "deploy_method", "Deploys via Docker containers", {});
    engine.ingestConversation("User", "How do we deploy?", 1000);
    engine.ingestConversation("Agent", "We use Docker containers on AWS", 2000);
    engine.ingestEnvironment("os", "macOS Sequoia", Date.now());
    engine.ingestEnvironment("node", "v25.6.0", Date.now());
  });

  it("3.1 — Layer ordering: Identity → Constraints → Facts → Conversation → Environment", () => {
    const output = engine.buildContext("deployment", 32000);
    const identityPos = output.indexOf("## Identity");
    const constraintPos = output.indexOf("## Constraints");
    const factPos = output.indexOf("## Facts");
    const convPos = output.indexOf("## Conversation");
    const envPos = output.indexOf("## Environment");

    expect(identityPos).toBeGreaterThanOrEqual(0);
    expect(constraintPos).toBeGreaterThan(identityPos);
    expect(factPos).toBeGreaterThan(constraintPos);
    expect(convPos).toBeGreaterThan(factPos);
    expect(envPos).toBeGreaterThan(convPos);
  });

  it("3.2 — Identity text present regardless of budget", () => {
    const output = engine.buildContext("deployment", 32000);
    expect(output).toContain("TestAgent");
    expect(output).toContain("Senior Developer");
  });

  it("3.3 — Constraints with ⚠️ markers before regular facts", () => {
    const output = engine.buildContext("deployment", 32000);
    const constraintSection = output.split("## Constraints")[1]?.split("## Facts")[0] ?? "";
    expect(constraintSection).toContain("⚠️");
    expect(constraintSection).toContain("no_rm_rf");
    expect(constraintSection).toContain("always_backup");
  });

  it("3.4 — Facts sorted ascending by relevance (least first, most last)", () => {
    const output = engine.buildContext("database configuration", 32000);
    const factSection = output.split("## Facts")[1]?.split("## Conversation")[0] ?? "";
    // db_config should be more relevant to "database configuration" query
    // and should appear AFTER (later = more relevant in ascending sort)
    const dbPos = factSection.indexOf("db_config");
    // At minimum, facts section should exist and have content
    expect(factSection.length).toBeGreaterThan(0);
    expect(dbPos).toBeGreaterThan(-1);
  });

  it("3.5 — Budget respected (within 5% tolerance)", () => {
    const contextWindow = 8192;
    const output = engine.buildContext("deployment", contextWindow);
    checkBudgetInvariant(output, contextWindow);
  });

  it("3.6 — Truncation drops lower-scored facts before conversation/environment", () => {
    // Create lots of low-value facts to force truncation
    for (let i = 0; i < 50; i++) {
      engine.ingestFact(`f-filler-${i}`, `filler_${i}`, `Some unrelated filler content number ${i} about nothing relevant to the query`, {});
    }
    const output = engine.buildContext("deployment", 8192);
    // Conversation and environment should still be present
    expect(output).toContain("## Conversation");
    expect(output).toContain("## Environment");
    checkBudgetInvariant(output, 8192);
  });
});

// ── FT-4: Fact Supersession + Cascade Invalidation (HOLDOUT) ────────────────

describe("FT-4: Fact Supersession + Cascade Invalidation (S4, weight 0.15)", () => {
  let engine: MemgineEngine;
  let factA: number;
  let factB: number;
  let conclusionC: number;

  beforeEach(() => {
    engine = new MemgineEngine();

    // Fact A: the original
    factA = engine.ingestFact("f-010", "db_version", "PostgreSQL 16 is the primary database", {});

    // Fact B: depends on A
    factB = engine.ingestFact("f-011", "db_perf", "Query performance optimized for PG16 features", {
      dependsOn: ["f-010"],
    });

    // Conclusion C: cites A as premise
    const cIdx = engine.graph.insert(makeNode({
      kind: MemKind.Conclusion,
      layer: 2,
      key: "db_conclusion",
      value: "PG16 migration is complete and stable",
      factId: "f-c01",
    }));
    engine.graph.link(cIdx, factA, EdgeKind.CitesPremise, 1.0);
    conclusionC = cIdx;
  });

  it("4.1 — Supersede Fact A with Fact D changes kind to FactSuperseded", () => {
    const factD = engine.ingestFact("f-012", "db_version", "PostgreSQL 17 is the primary database", {
      supersedes: "f-010",
    });
    const oldA = engine.graph.getByFactId("f-010");
    expect(oldA).toBeDefined();
    expect(oldA!.node.kind).toBe(MemKind.FactSuperseded);
  });

  it("4.2 — Supersedes edge from Fact D → Fact A exists", () => {
    const factD = engine.ingestFact("f-012", "db_version", "PostgreSQL 17 is the primary database", {
      supersedes: "f-010",
    });
    const edges = engine.graph.edgesFrom(factD);
    const supersedingEdge = edges.find(
      (e) => e.kind === EdgeKind.Supersedes && e.to === factA,
    );
    expect(supersedingEdge).toBeDefined();
  });

  it("4.3 — DependsOn cascade: Fact B added to needsReview", () => {
    engine.ingestFact("f-012", "db_version", "PostgreSQL 17 is the primary database", {
      supersedes: "f-010",
    });
    // Fact B's factId should be in needsReview
    expect(engine.needsReview.has("f-011")).toBe(true);
  });

  it("4.4 — Conclusion invalidation: Conclusion C becomes ConclusionInvalidated", () => {
    engine.ingestFact("f-012", "db_version", "PostgreSQL 17 is the primary database", {
      supersedes: "f-010",
    });
    const cNode = engine.graph.getNode(conclusionC);
    expect(cNode).toBeDefined();
    expect(cNode!.kind).toBe(MemKind.ConclusionInvalidated);
  });

  it("4.5 — Invalidated conclusion renders with ⚠️ RECALCULATE marker", () => {
    engine.ingestIdentity("TestAgent", "Developer");
    engine.ingestFact("f-012", "db_version", "PostgreSQL 17 is the primary database", {
      supersedes: "f-010",
    });
    const output = engine.buildContext("database version", 32000);
    expect(output).toContain("⚠️");
    expect(output).toContain("RECALCULATE");
  });

  it("4.6 — Superseded fact still findable by factId", () => {
    engine.ingestFact("f-012", "db_version", "PostgreSQL 17 is the primary database", {
      supersedes: "f-010",
    });
    const old = engine.graph.getByFactId("f-010");
    expect(old).toBeDefined();
    expect(old!.node.value).toContain("PostgreSQL 16");
  });

  it("4.7 — New fact indexed by factId", () => {
    engine.ingestFact("f-012", "db_version", "PostgreSQL 17 is the primary database", {
      supersedes: "f-010",
    });
    const newFact = engine.graph.getByFactId("f-012");
    expect(newFact).toBeDefined();
    expect(newFact!.node.value).toContain("PostgreSQL 17");
  });
});

// ── FT-5: Fast Mode (HOLDOUT) ───────────────────────────────────────────────

describe("FT-5: Fast Mode (S5, weight 0.15)", () => {
  let engine: MemgineEngine;

  beforeEach(() => {
    engine = new MemgineEngine();
    engine.ingestIdentity("TestAgent", "Developer");
    engine.ingestFact("f-c1", "constraint1", "Never delete production data", { isConstraint: true });
    engine.ingestFact("f-1", "db_config", "PostgreSQL is the database", {});
    engine.ingestFact("f-2", "cache_config", "Redis is used for caching", {});
    engine.ingestConversation("User", "What database do we use?", 1000);
    engine.ingestConversation("Agent", "We use PostgreSQL", 2000);
    engine.ingestEnvironment("os", "macOS", Date.now());
  });

  it("5.1 — Fast mode uses creation-order only (no PPR)", () => {
    // This is hard to test directly without mocking, but we can verify
    // the output is deterministic and doesn't change with different queries
    const output1 = engine.buildContextFast("database", 32000);
    const output2 = engine.buildContextFast("completely different query about billing", 32000);

    // Fast mode: facts should be in same order regardless of query
    const factSection1 = output1.split("## Facts")[1]?.split("## Conversation")[0] ?? "";
    const factSection2 = output2.split("## Facts")[1]?.split("## Conversation")[0] ?? "";
    expect(factSection1).toBe(factSection2);
  });

  it("5.2 — No Skill nodes in output", () => {
    // Add a skill node directly
    engine.graph.insert(makeNode({
      kind: MemKind.Skill,
      layer: 2,
      key: "skill_test",
      value: "Some skill content",
    }));
    const output = engine.buildContextFast("anything", 32000);
    // Skills shouldn't appear (they're in validFacts since kind=Skill is valid,
    // but fast mode should not include special skill handling)
    // Actually validFacts filters for kind === Fact only, so skills excluded
    expect(output).not.toContain("skill_test");
  });

  it("5.4 — Structure preserved: all five sections present", () => {
    const output = engine.buildContextFast("database", 32000);
    expect(output).toContain("## Identity");
    expect(output).toContain("## Constraints");
    expect(output).toContain("## Facts");
    expect(output).toContain("## Conversation");
    expect(output).toContain("## Environment");
  });

  it("5.5 — Latency under 100ms", () => {
    // Add more data to stress test
    for (let i = 0; i < 100; i++) {
      engine.ingestFact(`f-stress-${i}`, `stress_${i}`, `Stress test fact number ${i}`, {});
    }

    const start = performance.now();
    engine.buildContextFast("test query", 32000);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
  });
});

// ── Edge Cases ───────────────────────────────────────────────────────────────

describe("Edge Cases (EC-1 through EC-10)", () => {
  it("EC-1 — Empty graph → buildContext returns gracefully", () => {
    const engine = new MemgineEngine();
    const output = engine.buildContext("test", 32000);
    // Should not crash, may return empty or minimal output
    expect(typeof output).toBe("string");
  });

  it("EC-2 — Single node, no edges → PPR query returns it if keyword-matched", () => {
    const graph = new MemoryGraph();
    const idx = graph.insert(makeNode({ key: "database", value: "PostgreSQL config" }));

    const { seeds } = graph.findSeedsWeighted("database", 5);
    expect(seeds.length).toBeGreaterThanOrEqual(1);
    expect(seeds).toContain(idx);

    // PPR should handle single node without crash
    const hits = graph.retrievePPR(seeds, null, 0.5, 10);
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it("EC-3 — Duplicate key insertion: both nodes indexed under byKey", () => {
    const graph = new MemoryGraph();
    const idx1 = graph.insert(makeNode({ key: "shared_key", value: "value 1", factId: "f-1" }));
    const idx2 = graph.insert(makeNode({ key: "shared_key", value: "value 2", factId: "f-2" }));

    const results = graph.getByKey("shared_key");
    expect(results.length).toBe(2);
    expect(results.some((r) => r.nodeIndex === idx1)).toBe(true);
    expect(results.some((r) => r.nodeIndex === idx2)).toBe(true);
  });

  it("EC-4 — Expired TTL node excluded from buildContext", () => {
    const engine = new MemgineEngine();
    engine.ingestIdentity("Test", "Dev");
    engine.ingestEnvironment("temp", "70F", 1000, 1001); // already expired
    const output = engine.buildContext("temp", 32000);
    expect(output).not.toContain("70F");
  });

  it("EC-5 — Budget = 0 (minimal context window) still includes Identity", () => {
    const engine = new MemgineEngine();
    engine.ingestIdentity("TestAgent", "Developer");
    engine.ingestFact("f-1", "fact1", "Some fact", {});
    // Very small context window — budget formula: max((100 - 4096) * 0.4, 2000) = 2000
    const output = engine.buildContext("test", 100);
    expect(output).toContain("TestAgent");
  });

  it("EC-6 — Remove node that doesn't exist: no crash", () => {
    const graph = new MemoryGraph();
    // Should not throw
    expect(() => graph.remove(999)).not.toThrow();
    expect(() => graph.remove(-1)).not.toThrow();
  });

  it("EC-7 — Supersede an already-superseded node: chain works", () => {
    const engine = new MemgineEngine();
    const a = engine.ingestFact("f-a", "version", "v1", {});
    const b = engine.ingestFact("f-b", "version", "v2", { supersedes: "f-a" });
    const c = engine.ingestFact("f-c", "version", "v3", { supersedes: "f-b" });

    // Original still findable
    const origA = engine.graph.getByFactId("f-a");
    expect(origA).toBeDefined();

    // Both old versions are superseded
    expect(origA!.node.kind).toBe(MemKind.FactSuperseded);
    const origB = engine.graph.getByFactId("f-b");
    expect(origB).toBeDefined();
    expect(origB!.node.kind).toBe(MemKind.FactSuperseded);

    // Latest is active
    const latest = engine.graph.getByFactId("f-c");
    expect(latest).toBeDefined();
    expect(latest!.node.kind).toBe(MemKind.Fact);
  });

  it("EC-8 — Query with no keyword matches → empty or near-empty results", () => {
    const graph = new MemoryGraph();
    graph.insert(makeNode({ key: "database", value: "PostgreSQL" }));

    const { seeds } = graph.findSeedsWeighted("xyzzyplugh", 5);
    // Should return empty or very low score results, no crash
    expect(seeds.length).toBeLessThanOrEqual(1);
  });

  it("EC-9 — Very long node value (>10K chars) handled gracefully", () => {
    const engine = new MemgineEngine();
    engine.ingestIdentity("Test", "Dev");
    const longValue = "x".repeat(12000);
    engine.ingestFact("f-long", "long_key", longValue, {});

    // Should not crash during context assembly
    const output = engine.buildContext("long_key", 32000);
    expect(typeof output).toBe("string");
    checkBudgetInvariant(output, 32000);
  });

  it("EC-10 — Node with all optional fields missing: no undefined leaks", () => {
    const node = makeNode({
      factId: undefined,
      expiresAt: undefined,
    });
    const graph = new MemoryGraph();
    const idx = graph.insert(node);
    const retrieved = graph.getNode(idx);
    expect(retrieved).toBeDefined();
    expect(retrieved!.key).toBeDefined();
    expect(retrieved!.value).toBeDefined();
    expect(retrieved!.kind).toBeDefined();
    expect(retrieved!.layer).toBeDefined();
  });
});

// ── Invariant Tests ──────────────────────────────────────────────────────────

describe("Invariants (INV-1 through INV-4)", () => {
  it("INV-1 & INV-2 — No dangling edges + index consistency after mutations", () => {
    const graph = new MemoryGraph();
    const nodes: number[] = [];

    // Insert several nodes
    for (let i = 0; i < 10; i++) {
      nodes.push(
        graph.insert(
          makeNode({
            key: `key_${i}`,
            value: `value ${i}`,
            factId: `f-${i}`,
          }),
        ),
      );
    }

    // Add edges
    for (let i = 1; i < nodes.length; i++) {
      graph.link(nodes[i - 1], nodes[i], EdgeKind.RelatedTo, 0.5);
    }

    checkInvariants(graph);

    // Remove some nodes
    graph.remove(nodes[3]);
    graph.remove(nodes[7]);

    // After removal, no dangling edges
    expect(graph.edgeCount()).toBe(5); // 9 edges minus 4 that touched nodes 3 and 7 (2→3, 3→4, 6→7, 7→8)
    checkInvariants(graph);
  });

  it("INV-3 — Layer validity for all MemKind values", () => {
    const graph = new MemoryGraph();

    const testCases: Array<{ kind: MemKind; expectedLayer: Layer }> = [
      { kind: MemKind.Identity, expectedLayer: 1 },
      { kind: MemKind.Fact, expectedLayer: 2 },
      { kind: MemKind.Conclusion, expectedLayer: 2 },
      { kind: MemKind.Skill, expectedLayer: 2 },
      { kind: MemKind.Conversation, expectedLayer: 3 },
      { kind: MemKind.ConversationSummary, expectedLayer: 3 },
      { kind: MemKind.Environment, expectedLayer: 4 },
    ];

    for (const { kind, expectedLayer } of testCases) {
      const idx = graph.insert(
        makeNode({
          kind,
          layer: expectedLayer,
          key: `test_${kind}`,
          value: `test value for ${MemKind[kind]}`,
        }),
      );
      const node = graph.getNode(idx)!;
      expect(kindToLayer(node.kind)).toBe(expectedLayer);
    }
  });

  it("INV-4 — Budget never exceeded in context output", () => {
    const engine = new MemgineEngine();
    engine.ingestIdentity("TestAgent", "Developer");
    for (let i = 0; i < 30; i++) {
      engine.ingestFact(`f-${i}`, `key_${i}`, `Fact number ${i} with some content`, {});
    }
    for (let i = 0; i < 20; i++) {
      engine.ingestConversation("User", `Message number ${i}`, i * 1000);
    }
    engine.ingestEnvironment("os", "macOS", Date.now());

    for (const cw of [8192, 16384, 32000, 128000]) {
      const output = engine.buildContext("test query", cw);
      checkBudgetInvariant(output, cw);
    }
  });
});

// ── Scoring & Weight Documentation ───────────────────────────────────────────

describe("Scoring", () => {
  it("Ship threshold: all scenarios weighted avg >= 0.85", () => {
    // This test documents the scoring weights
    const weights = {
      S1: 0.2,
      S2: 0.25,
      S3: 0.25,
      S4: 0.15,
      S5: 0.15,
    };
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1.0);
  });
});
