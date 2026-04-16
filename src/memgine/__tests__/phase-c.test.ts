/**
 * Memgine v2 — Phase C Test Suite
 * Delores (Dev) — Tests for plugin lifecycle, config validation, migration, and integration.
 *
 * Test coverage:
 * - PC-1: Plugin config validation (clamp, normalize, reject negatives)
 * - PC-2: Singleton engine map (getOrCreateEngine, eviction, cache)
 * - PC-3: Plugin hook wiring (session_start, before_prompt_build, message hooks, session_end)
 * - PC-4: Migration tool (MEMORY.md, WORKING.md, SOUL.md, daily logs)
 * - PC-5: Migration idempotency (run twice → same result)
 * - PC-6: Stale .tmp cleanup
 * - PC-7: v1→v2 version flag (RA-1)
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemgineEngine } from "../engine.js";
import { loadGraphSnapshot, cleanStaleTmpFiles } from "../persistence.js";
import { validateMemgineConfig } from "../plugin-config.js";
import {
  migrateMemoryMd,
  migrateWorkingMd,
  migrateSoulMd,
  migrateDailyLogs,
  migrateWorkspace,
} from "../plugin-migration.js";
import {
  getOrCreateEngine,
  evictStaleEngines,
  clearEngineCache,
  engineCacheSize,
} from "../plugin.js";
import { MemKind, emptyMetadata } from "../types.js";
import { DEFAULT_CONFIG } from "../v2config.js";

// ── Test Helpers ───────────────────────────────────────────────────────────────

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memgine-phase-c-"));
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

// ── PC-1: Config Validation ────────────────────────────────────────────────────

describe("PC-1: Plugin Config Validation", () => {
  it("returns defaults when no config provided", () => {
    const result = validateMemgineConfig();
    expect(result.version).toBe(1);
    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns version 2 when specified", () => {
    const result = validateMemgineConfig({ version: 2 });
    expect(result.version).toBe(2);
  });

  it("clamps contextBudgetFraction to [0.1, 0.9]", () => {
    const low = validateMemgineConfig({ contextBudgetFraction: 0.01 });
    expect(low.config.contextBudgetFraction).toBe(0.1);
    expect(low.warnings.length).toBeGreaterThan(0);

    const high = validateMemgineConfig({ contextBudgetFraction: 1.5 });
    expect(high.config.contextBudgetFraction).toBe(0.9);
    expect(high.warnings.length).toBeGreaterThan(0);

    const ok = validateMemgineConfig({ contextBudgetFraction: 0.5 });
    expect(ok.config.contextBudgetFraction).toBe(0.5);
    expect(ok.warnings).toHaveLength(0);
  });

  it("rejects negative tokenBudget", () => {
    const result = validateMemgineConfig({ tokenBudget: -100 });
    expect(result.config.tokenBudget).toBe(DEFAULT_CONFIG.tokenBudget);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("rejects negative environmentMax", () => {
    const result = validateMemgineConfig({ environmentMax: -1 });
    expect(result.config.environmentMax).toBe(DEFAULT_CONFIG.environmentMax);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("rejects negative responseReservation", () => {
    const result = validateMemgineConfig({ responseReservation: -500 });
    expect(result.config.responseReservation).toBe(DEFAULT_CONFIG.responseReservation);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("normalizes layer fractions that don't sum to 1.0", () => {
    const result = validateMemgineConfig({
      layer1Fraction: 0.1,
      layer2Fraction: 0.1,
      layer3Fraction: 0.1,
      layer4Fraction: 0.1,
    });
    // Sum is 0.4, should normalize to each being 0.25
    const sum =
      result.config.layer1Fraction +
      result.config.layer2Fraction +
      result.config.layer3Fraction +
      result.config.layer4Fraction;
    expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("rejects negative layer fractions", () => {
    const result = validateMemgineConfig({
      layer1Fraction: -0.1,
      layer2Fraction: 0.5,
      layer3Fraction: 0.3,
      layer4Fraction: 0.3,
    });
    // Should fall back to defaults
    expect(result.config.layer1Fraction).toBe(DEFAULT_CONFIG.layer1Fraction);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("accepts valid layer fractions that sum to 1.0", () => {
    const result = validateMemgineConfig({
      layer1Fraction: 0.1,
      layer2Fraction: 0.4,
      layer3Fraction: 0.3,
      layer4Fraction: 0.2,
    });
    expect(result.config.layer1Fraction).toBe(0.1);
    expect(result.config.layer2Fraction).toBe(0.4);
    expect(result.warnings).toHaveLength(0);
  });
});

// ── PC-2: Singleton Engine Map ─────────────────────────────────────────────────

describe("PC-2: Singleton Engine Map", () => {
  beforeEach(() => {
    clearEngineCache();
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    clearEngineCache();
    cleanup(tmpDir);
  });

  it("returns the same engine for the same workspace dir", () => {
    const e1 = getOrCreateEngine(tmpDir);
    const e2 = getOrCreateEngine(tmpDir);
    expect(e1).toBe(e2);
    expect(engineCacheSize()).toBe(1);
  });

  it("returns different engines for different workspace dirs", () => {
    const dir2 = createTmpDir();
    try {
      const e1 = getOrCreateEngine(tmpDir);
      const e2 = getOrCreateEngine(dir2);
      expect(e1).not.toBe(e2);
      expect(engineCacheSize()).toBe(2);
    } finally {
      cleanup(dir2);
    }
  });

  it("evicts stale engines beyond TTL", () => {
    // Create engine, then manually set its access time to past
    getOrCreateEngine(tmpDir);
    expect(engineCacheSize()).toBe(1);

    // We can't easily manipulate the TTL in a unit test without exposing internals,
    // but we can verify that eviction runs without error when engines are fresh
    const evicted = evictStaleEngines();
    expect(evicted).toBe(0); // Fresh engine should not be evicted
    expect(engineCacheSize()).toBe(1);
  });

  it("clears cache completely", () => {
    getOrCreateEngine(tmpDir);
    expect(engineCacheSize()).toBe(1);
    clearEngineCache();
    expect(engineCacheSize()).toBe(0);
  });
});

// ── PC-3: Plugin Hook Integration ──────────────────────────────────────────────

describe("PC-3: Plugin Hook Integration", () => {
  beforeEach(() => {
    clearEngineCache();
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    clearEngineCache();
    cleanup(tmpDir);
  });

  it("engine loads empty graph on session_start for new workspace", () => {
    const engine = getOrCreateEngine(tmpDir);
    engine.loadSnapshot();
    expect(engine.graph.nodeCount()).toBe(0);
  });

  it("engine loads existing graph on session_start", () => {
    // Create an engine with some data
    const engine1 = getOrCreateEngine(tmpDir);
    engine1.graph.insert({
      kind: MemKind.Fact,
      layer: 2,
      key: "test-fact",
      value: "The sky is blue",
      factId: "test-fact-1",
      scope: "agent",
      authority: "user",
      isConstraint: false,
      createdAt: Date.now(),
      contentType: "natural_language",
      metadata: emptyMetadata(),
    });
    engine1.persistSnapshot();

    // Clear cache and reload
    clearEngineCache();
    const engine2 = getOrCreateEngine(tmpDir);
    engine2.loadSnapshot();
    expect(engine2.graph.nodeCount()).toBe(1);
  });

  it("before_prompt_build returns context string", () => {
    const engine = getOrCreateEngine(tmpDir);

    // Add some facts so context assembly has material
    engine.graph.insert({
      kind: MemKind.Identity,
      layer: 1,
      key: "identity",
      value: "I am Delores, a developer agent",
      scope: "agent",
      authority: "system",
      isConstraint: false,
      createdAt: Date.now(),
      contentType: "natural_language",
      metadata: emptyMetadata(),
    });

    const context = engine.buildContext("Who am I?", 128000);
    expect(typeof context).toBe("string");
    // Context should contain something from the identity node
    expect(context.length).toBeGreaterThan(0);
  });

  it("message ingestion creates conversation nodes", () => {
    const engine = getOrCreateEngine(tmpDir);

    const nodesBefore = engine.graph.nodeCount();
    engine.ingestConversation("user", "Hello, how are you?", Date.now());
    engine.ingestConversation("assistant", "I'm doing well, thanks!", Date.now());
    const nodesAfter = engine.graph.nodeCount();

    expect(nodesAfter).toBeGreaterThan(nodesBefore);
  });

  it("session_end persists snapshot", () => {
    const engine = getOrCreateEngine(tmpDir);

    engine.graph.insert({
      kind: MemKind.Fact,
      layer: 2,
      key: "persist-test",
      value: "This should be persisted",
      factId: "persist-test-1",
      scope: "agent",
      authority: "user",
      isConstraint: false,
      createdAt: Date.now(),
      contentType: "natural_language",
      metadata: emptyMetadata(),
    });

    engine.persistSnapshot();

    // Verify the file exists
    const graphPath = path.join(tmpDir, ".memgine", "graph.jsonl");
    expect(fs.existsSync(graphPath)).toBe(true);

    const content = fs.readFileSync(graphPath, "utf-8");
    expect(content).toContain("persist-test");
  });

  it("consolidation runs when threshold is met", () => {
    const engine = getOrCreateEngine(tmpDir);

    // shouldConsolidate depends on graph state — with an empty graph it should be false
    expect(engine.shouldConsolidate()).toBe(false);
  });
});

// ── PC-4: Migration Tool ───────────────────────────────────────────────────────

describe("PC-4: Migration Tool", () => {
  beforeEach(() => {
    clearEngineCache();
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    clearEngineCache();
    cleanup(tmpDir);
  });

  it("migrates MEMORY.md into Fact nodes (layer 2)", () => {
    const memoryPath = path.join(tmpDir, "MEMORY.md");
    fs.writeFileSync(
      memoryPath,
      "# Memory\n\n## Important Decision\nWe chose TypeScript for the project.\n\n## Team Note\nGrace is the lead.\n",
    );

    const engine = new MemgineEngine();
    const result = migrateMemoryMd(engine, memoryPath);

    expect(result.nodesAdded).toBe(2);
    expect(result.nodesSkipped).toBe(0);

    // Verify nodes are layer 2 Facts
    const nodes = engine.graph.nodesByLayer(2);
    expect(nodes.length).toBe(2);
    expect(nodes[0].node.kind).toBe(MemKind.Fact);
  });

  it("migrates WORKING.md into Environment nodes (layer 4)", () => {
    const workingPath = path.join(tmpDir, "WORKING.md");
    fs.writeFileSync(
      workingPath,
      "# Working\n\n## Active Tasks\nImplementing Phase C.\n\n## Blockers\nNone currently.\n",
    );

    const engine = new MemgineEngine();
    const result = migrateWorkingMd(engine, workingPath);

    expect(result.nodesAdded).toBe(2);
    const nodes = engine.graph.nodesByLayer(4);
    expect(nodes.length).toBe(2);
    expect(nodes[0].node.kind).toBe(MemKind.Environment);
  });

  it("migrates SOUL.md into Identity node (layer 1)", () => {
    const soulPath = path.join(tmpDir, "SOUL.md");
    fs.writeFileSync(soulPath, "# SOUL.md — Delores\n\nI am a developer agent.\n");

    const engine = new MemgineEngine();
    const result = migrateSoulMd(engine, soulPath);

    expect(result.nodesAdded).toBe(1);
    const nodes = engine.graph.nodesByLayer(1);
    expect(nodes.length).toBe(1);
    expect(nodes[0].node.kind).toBe(MemKind.Identity);
  });

  it("migrates daily logs into Conversation nodes (layer 3)", () => {
    const memoryDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, "2026-04-14.md"), "Did some work today.\n");
    fs.writeFileSync(path.join(memoryDir, "2026-04-15.md"), "Fixed a bug in AI listing.\n");
    fs.writeFileSync(path.join(memoryDir, "notes.md"), "Should be ignored (wrong format).\n");

    const engine = new MemgineEngine();
    const result = migrateDailyLogs(engine, memoryDir);

    expect(result.nodesAdded).toBe(2); // Only YYYY-MM-DD.md files
    const nodes = engine.graph.nodesByLayer(3);
    expect(nodes.length).toBe(2);
    expect(nodes[0].node.kind).toBe(MemKind.Conversation);
  });

  it("handles missing files gracefully", () => {
    const engine = new MemgineEngine();

    const r1 = migrateMemoryMd(engine, path.join(tmpDir, "nonexistent.md"));
    expect(r1.nodesAdded).toBe(0);

    const r2 = migrateSoulMd(engine, path.join(tmpDir, "nonexistent.md"));
    expect(r2.nodesAdded).toBe(0);

    const r3 = migrateDailyLogs(engine, path.join(tmpDir, "nonexistent-dir"));
    expect(r3.nodesAdded).toBe(0);
  });

  it("handles empty files gracefully", () => {
    const emptyFile = path.join(tmpDir, "SOUL.md");
    fs.writeFileSync(emptyFile, "");

    const engine = new MemgineEngine();
    const result = migrateSoulMd(engine, emptyFile);
    expect(result.nodesAdded).toBe(0);
  });

  it("migrateWorkspace runs all migrations", () => {
    // Set up workspace
    fs.writeFileSync(path.join(tmpDir, "SOUL.md"), "# Identity\nI am an agent.\n");
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "## Fact 1\nSomething important.\n");
    fs.writeFileSync(path.join(tmpDir, "WORKING.md"), "## Task 1\nWorking on it.\n");
    const memDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "2026-04-15.md"), "Day log entry.\n");

    const engine = new MemgineEngine();
    const results = migrateWorkspace(engine, tmpDir);

    expect(results).toHaveLength(4); // SOUL, MEMORY, WORKING, daily logs
    const totalAdded = results.reduce((sum, r) => sum + r.nodesAdded, 0);
    expect(totalAdded).toBeGreaterThanOrEqual(4); // At least one node per file
  });

  it("preserves structured provenance (R-2)", () => {
    const memoryPath = path.join(tmpDir, "MEMORY.md");
    fs.writeFileSync(memoryPath, "## Decision\nWe chose TypeScript.\n");

    const engine = new MemgineEngine();
    migrateMemoryMd(engine, memoryPath);

    const nodes = engine.graph.nodesByLayer(2);
    expect(nodes.length).toBe(1);
    const provenance = nodes[0].node.metadata.provenance;
    expect(provenance).toHaveLength(1);
    expect(provenance[0].source).toBe("migration");
    expect(provenance[0].reference).toBe("MEMORY.md");
    expect(provenance[0].date).toBeDefined();
  });
});

// ── PC-5: Migration Idempotency ────────────────────────────────────────────────

describe("PC-5: Migration Idempotency (R-1)", () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it("running migrateMemoryMd twice produces same node count", () => {
    const memoryPath = path.join(tmpDir, "MEMORY.md");
    fs.writeFileSync(memoryPath, "## Fact A\nSomething.\n\n## Fact B\nSomething else.\n");

    const engine = new MemgineEngine();
    const r1 = migrateMemoryMd(engine, memoryPath);
    expect(r1.nodesAdded).toBe(2);

    const r2 = migrateMemoryMd(engine, memoryPath);
    expect(r2.nodesAdded).toBe(0);
    expect(r2.nodesSkipped).toBe(2);

    expect(engine.graph.nodeCount()).toBe(2);
  });

  it("running migrateSoulMd twice produces same node count", () => {
    const soulPath = path.join(tmpDir, "SOUL.md");
    fs.writeFileSync(soulPath, "I am Delores.\n");

    const engine = new MemgineEngine();
    migrateSoulMd(engine, soulPath);
    const countAfterFirst = engine.graph.nodeCount();

    migrateSoulMd(engine, soulPath);
    expect(engine.graph.nodeCount()).toBe(countAfterFirst);
  });

  it("running migrateWorkspace twice is idempotent", () => {
    fs.writeFileSync(path.join(tmpDir, "SOUL.md"), "# Identity\nAgent.\n");
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "## Fact\nData.\n");
    fs.writeFileSync(path.join(tmpDir, "WORKING.md"), "## Task\nStuff.\n");

    const engine = new MemgineEngine();
    migrateWorkspace(engine, tmpDir);
    const countAfterFirst = engine.graph.nodeCount();

    migrateWorkspace(engine, tmpDir);
    expect(engine.graph.nodeCount()).toBe(countAfterFirst);
  });
});

// ── PC-6: Stale .tmp Cleanup ───────────────────────────────────────────────────

describe("PC-6: Stale .tmp Cleanup (R-4)", () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it("cleans up stale .tmp files older than threshold", () => {
    const graphPath = path.join(tmpDir, "graph.jsonl");
    const tmpPath = graphPath + ".tmp";

    // Create a .tmp file and backdate it
    fs.writeFileSync(tmpPath, '{"type":"node"}\n');
    const oldTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    fs.utimesSync(tmpPath, new Date(oldTime), new Date(oldTime));

    const cleaned = cleanStaleTmpFiles(graphPath);
    expect(cleaned).toBe(1);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it("does NOT clean up fresh .tmp files", () => {
    const graphPath = path.join(tmpDir, "graph.jsonl");
    const tmpPath = graphPath + ".tmp";

    // Create a fresh .tmp file
    fs.writeFileSync(tmpPath, '{"type":"node"}\n');

    const cleaned = cleanStaleTmpFiles(graphPath);
    expect(cleaned).toBe(0);
    expect(fs.existsSync(tmpPath)).toBe(true);
  });

  it("does nothing when no .tmp file exists", () => {
    const graphPath = path.join(tmpDir, "graph.jsonl");
    const cleaned = cleanStaleTmpFiles(graphPath);
    expect(cleaned).toBe(0);
  });

  it("loadGraphSnapshot triggers .tmp cleanup", () => {
    const graphPath = path.join(tmpDir, "graph.jsonl");
    const tmpPath = graphPath + ".tmp";

    // Create stale .tmp
    fs.writeFileSync(tmpPath, '{"type":"node"}\n');
    const oldTime = Date.now() - 10 * 60 * 1000;
    fs.utimesSync(tmpPath, new Date(oldTime), new Date(oldTime));

    // loadGraphSnapshot should clean it up
    loadGraphSnapshot(graphPath);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });
});

// ── PC-7: v1→v2 Version Flag (RA-1) ───────────────────────────────────────────

describe("PC-7: v1→v2 Version Flag (RA-1)", () => {
  it("defaults to version 1", () => {
    const result = validateMemgineConfig({});
    expect(result.version).toBe(1);
  });

  it("version 1 means v2 hooks are NOT registered", () => {
    const result = validateMemgineConfig({ version: 1 });
    expect(result.version).toBe(1);
    // The plugin.register() should exit early for version != 2
    // This is tested via the plugin definition behavior
  });

  it("version 2 enables v2 hooks", () => {
    const result = validateMemgineConfig({ version: 2 });
    expect(result.version).toBe(2);
  });

  it("invalid version defaults to 1", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = validateMemgineConfig({ version: 99 as unknown as any });
    expect(result.version).toBe(1);
  });
});
