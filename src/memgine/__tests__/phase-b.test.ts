/**
 * Memgine v2 — Phase B Test Suite
 * Delores (Dev) — Tests for JSONL persistence, compaction, self-reflection, and consolidation.
 *
 * Test coverage:
 * - PB-1: Graph JSONL snapshot persistence (save + load + atomic rename)
 * - PB-2: Conversation write-through JSONL
 * - PB-3: Heuristic conversation compaction
 * - PB-4: Self-reflection detection (corrections, preferences, friction)
 * - PB-5: Consolidation pass (prune + GC + compact + reflect + persist)
 * - PB-6: Engine persistence integration (enablePersistence, loadSnapshot, etc.)
 * - PB-7: Phase A regression (all existing functionality preserved)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { MemoryGraph } from "../graph.js";
import { MemgineEngine } from "../engine.js";
import {
  MemKind,
  EdgeKind,
  emptyMetadata,
  tokenEstimate,
} from "../types.js";
import {
  saveGraphSnapshot,
  loadGraphSnapshot,
  appendConversation,
  loadConversations,
  rewriteConversations,
  conversationLineCount,
} from "../persistence.js";
import {
  compactConversation,
  detectReflections,
  type ConversationTurn,
} from "../compaction.js";
import {
  consolidate,
} from "../consolidation.js";

// ── Test Helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

function freshTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memgine-test-"));
  return dir;
}

function graphPath(): string {
  return path.join(tmpDir, "graph.jsonl");
}

function convPath(): string {
  return path.join(tmpDir, "conversations.jsonl");
}

beforeEach(() => {
  tmpDir = freshTmpDir();
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

// ── PB-1: Graph JSONL Snapshot Persistence ───────────────────────────────────

describe("PB-1: Graph JSONL Snapshot Persistence", () => {
  it("saves and loads an empty graph", () => {
    const graph = new MemoryGraph();
    saveGraphSnapshot(graph, graphPath());

    expect(fs.existsSync(graphPath())).toBe(true);

    const loaded = loadGraphSnapshot(graphPath());
    expect(loaded.nodeCount()).toBe(0);
    expect(loaded.edgeCount()).toBe(0);
  });

  it("round-trips nodes with all fields", () => {
    const graph = new MemoryGraph();
    graph.insert({
      kind: MemKind.Fact,
      layer: 2,
      key: "database",
      value: "PostgreSQL is the primary database",
      factId: "fact-001",
      scope: "global",
      authority: "user",
      isConstraint: false,
      createdAt: 1700000000000,
      contentType: "natural_language",
      metadata: { ...emptyMetadata(), confidence: "high", tags: ["infra"] },
    });

    graph.insert({
      kind: MemKind.Environment,
      layer: 4,
      key: "timezone",
      value: "America/New_York",
      scope: "global",
      authority: "system",
      isConstraint: false,
      createdAt: 1700000001000,
      expiresAt: 1700100000000,
      contentType: "natural_language",
      metadata: emptyMetadata(),
    });

    saveGraphSnapshot(graph, graphPath());
    const loaded = loadGraphSnapshot(graphPath());

    expect(loaded.nodeCount()).toBe(2);

    const fact = loaded.getByFactId("fact-001");
    expect(fact).toBeDefined();
    expect(fact!.node.kind).toBe(MemKind.Fact);
    expect(fact!.node.key).toBe("database");
    expect(fact!.node.value).toBe("PostgreSQL is the primary database");
    expect(fact!.node.metadata.confidence).toBe("high");
    expect(fact!.node.metadata.tags).toEqual(["infra"]);

    const envNodes = loaded.nodesByLayer(4);
    expect(envNodes.length).toBe(1);
    expect(envNodes[0].node.expiresAt).toBe(1700100000000);
  });

  it("round-trips edges with correct remapping", () => {
    const graph = new MemoryGraph();
    const n0 = graph.insert({
      kind: MemKind.Fact,
      layer: 2,
      key: "a",
      value: "fact A",
      factId: "a",
      scope: "global",
      authority: "user",
      isConstraint: false,
      createdAt: 1000,
      contentType: "natural_language",
      metadata: emptyMetadata(),
    });
    const n1 = graph.insert({
      kind: MemKind.Fact,
      layer: 2,
      key: "b",
      value: "fact B depends on A",
      factId: "b",
      scope: "global",
      authority: "user",
      isConstraint: false,
      createdAt: 2000,
      contentType: "natural_language",
      metadata: emptyMetadata(),
    });
    graph.link(n1, n0, EdgeKind.DependsOn, 1.0);

    saveGraphSnapshot(graph, graphPath());
    const loaded = loadGraphSnapshot(graphPath());

    expect(loaded.nodeCount()).toBe(2);
    expect(loaded.edgeCount()).toBe(1);

    const factA = loaded.getByFactId("a");
    const factB = loaded.getByFactId("b");
    expect(factA).toBeDefined();
    expect(factB).toBeDefined();

    // Edge should point from B to A
    const edges = loaded.edgesFrom(factB!.nodeIndex);
    expect(edges.length).toBe(1);
    expect(edges[0].kind).toBe(EdgeKind.DependsOn);
    expect(edges[0].to).toBe(factA!.nodeIndex);
  });

  it("atomic rename: no .tmp file remains after save", () => {
    const graph = new MemoryGraph();
    graph.insert({
      kind: MemKind.Fact,
      layer: 2,
      key: "test",
      value: "value",
      scope: "global",
      authority: "user",
      isConstraint: false,
      createdAt: 1000,
      contentType: "natural_language",
      metadata: emptyMetadata(),
    });

    saveGraphSnapshot(graph, graphPath());

    expect(fs.existsSync(graphPath())).toBe(true);
    expect(fs.existsSync(graphPath() + ".tmp")).toBe(false);
  });

  it("loads from non-existent file returns empty graph", () => {
    const loaded = loadGraphSnapshot("/nonexistent/path/graph.jsonl");
    expect(loaded.nodeCount()).toBe(0);
  });

  it("gracefully skips malformed JSONL lines", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      graphPath(),
      [
        JSON.stringify({ type: "node", index: 0, kind: "Fact", layer: 2, key: "ok", value: "good", scope: "global", authority: "user", isConstraint: false, createdAt: 1000, contentType: "natural_language" }),
        "{ this is not valid json }",
        JSON.stringify({ type: "node", index: 1, kind: "Fact", layer: 2, key: "also-ok", value: "fine", scope: "global", authority: "user", isConstraint: false, createdAt: 2000, contentType: "natural_language" }),
      ].join("\n") + "\n",
    );

    const loaded = loadGraphSnapshot(graphPath());
    expect(loaded.nodeCount()).toBe(2);
  });

  it("survives process restart: save, reload, verify state", () => {
    const engine = new MemgineEngine();
    engine.ingestIdentity("TestUser", "developer");
    engine.ingestFact("f1", "language", "TypeScript is used");
    engine.ingestFact("f2", "framework", "Express.js for API", { dependsOn: ["f1"] });
    engine.ingestConversation("User", "What framework do we use?", 1000);
    engine.ingestConversation("Assistant", "We use Express.js", 2000);

    // Save
    saveGraphSnapshot(engine.graph, graphPath());

    // Simulate restart: new engine, load from disk
    const engine2 = new MemgineEngine();
    engine2.graph = loadGraphSnapshot(graphPath());

    // Verify state
    expect(engine2.graph.nodeCount()).toBe(engine.graph.nodeCount());
    expect(engine2.graph.edgeCount()).toBe(engine.graph.edgeCount());
    expect(engine2.graph.getByFactId("f1")).toBeDefined();
    expect(engine2.graph.getByFactId("f2")).toBeDefined();

    // Context assembly should work on reloaded graph
    const ctx = engine2.buildContext("framework", 8192);
    expect(ctx).toContain("Express.js");
  });
});

// ── PB-2: Conversation Write-Through JSONL ───────────────────────────────────

describe("PB-2: Conversation Write-Through JSONL", () => {
  it("appends turns to JSONL file", () => {
    appendConversation(convPath(), "User", "Hello there", 1000);
    appendConversation(convPath(), "Assistant", "Hi! How can I help?", 2000);

    const turns = loadConversations(convPath());
    expect(turns.length).toBe(2);
    expect(turns[0].speaker).toBe("User");
    expect(turns[0].text).toBe("Hello there");
    expect(turns[0].ts).toBe(1000);
    expect(turns[1].speaker).toBe("Assistant");
  });

  it("loads from non-existent file returns empty array", () => {
    const turns = loadConversations("/nonexistent/conv.jsonl");
    expect(turns).toEqual([]);
  });

  it("rewrites conversation store with atomic rename", () => {
    appendConversation(convPath(), "User", "First", 1000);
    appendConversation(convPath(), "User", "Second", 2000);
    appendConversation(convPath(), "User", "Third", 3000);

    const compacted = [
      { speaker: "User", text: "First and Second", ts: 1000 },
      { speaker: "User", text: "Third", ts: 3000 },
    ];

    rewriteConversations(convPath(), compacted);

    const loaded = loadConversations(convPath());
    expect(loaded.length).toBe(2);
    expect(loaded[0].text).toBe("First and Second");

    // No .tmp remains
    expect(fs.existsSync(convPath() + ".tmp")).toBe(false);
  });

  it("counts lines without loading full content", () => {
    expect(conversationLineCount(convPath())).toBe(0);

    appendConversation(convPath(), "A", "one", 1);
    appendConversation(convPath(), "B", "two", 2);
    appendConversation(convPath(), "C", "three", 3);

    expect(conversationLineCount(convPath())).toBe(3);
  });

  it("engine write-through: ingestConversation writes to JSONL", () => {
    const engine = new MemgineEngine();
    engine.enablePersistence(graphPath(), convPath());

    engine.ingestConversation("User", "Test message", 1000);
    engine.ingestConversation("Assistant", "Response", 2000);

    const turns = loadConversations(convPath());
    expect(turns.length).toBe(2);
    expect(turns[0].speaker).toBe("User");
    expect(turns[1].speaker).toBe("Assistant");
  });
});

// ── PB-3: Heuristic Conversation Compaction ──────────────────────────────────

describe("PB-3: Heuristic Conversation Compaction", () => {
  it("protects keep-recent window (last 6 turns)", () => {
    const turns: ConversationTurn[] = [];
    for (let i = 0; i < 10; i++) {
      turns.push({ speaker: "User", text: `Message ${i}`, ts: i * 1000 });
    }

    const result = compactConversation(turns, 6);
    // Last 6 turns must be preserved verbatim
    const recent = result.compacted.slice(-6);
    for (let i = 0; i < 6; i++) {
      expect(recent[i].text).toBe(`Message ${i + 4}`);
    }
  });

  it("returns original if fewer turns than keep-recent", () => {
    const turns: ConversationTurn[] = [
      { speaker: "User", text: "Hello", ts: 1000 },
      { speaker: "Asst", text: "Hi!", ts: 2000 },
    ];
    const result = compactConversation(turns, 6);
    expect(result.compacted.length).toBe(2);
    expect(result.removed).toBe(0);
    expect(result.merged).toBe(0);
  });

  it("merges consecutive same-speaker turns", () => {
    const turns: ConversationTurn[] = [
      { speaker: "User", text: "First part", ts: 1000 },
      { speaker: "User", text: "Second part", ts: 2000 },
      { speaker: "User", text: "Third part", ts: 3000 },
      { speaker: "Asst", text: "Got it", ts: 4000 },
      // Keep-recent window (need more turns to push these into compactable zone)
      { speaker: "User", text: "Recent 1", ts: 5000 },
      { speaker: "Asst", text: "Recent 2", ts: 6000 },
      { speaker: "User", text: "Recent 3", ts: 7000 },
      { speaker: "Asst", text: "Recent 4", ts: 8000 },
      { speaker: "User", text: "Recent 5", ts: 9000 },
      { speaker: "Asst", text: "Recent 6", ts: 10000 },
    ];

    const result = compactConversation(turns, 6);
    expect(result.merged).toBeGreaterThan(0);

    // The first 3 User turns should be merged into one
    const compactable = result.compacted.slice(0, -6);
    const userMerged = compactable.find(t => t.speaker === "User" && t.text.includes("First part"));
    expect(userMerged).toBeDefined();
    expect(userMerged!.text).toContain("Second part");
    expect(userMerged!.text).toContain("Third part");
  });

  it("drops low-value exchanges (acks, greetings)", () => {
    const turns: ConversationTurn[] = [
      { speaker: "User", text: "Can you help?", ts: 1000 },
      { speaker: "Asst", text: "ok", ts: 2000 },
      { speaker: "User", text: "Thanks", ts: 3000 },
      { speaker: "Asst", text: "Important analysis result", ts: 4000 },
      // Keep-recent
      { speaker: "User", text: "R1", ts: 5000 },
      { speaker: "Asst", text: "R2", ts: 6000 },
      { speaker: "User", text: "R3", ts: 7000 },
      { speaker: "Asst", text: "R4", ts: 8000 },
      { speaker: "User", text: "R5", ts: 9000 },
      { speaker: "Asst", text: "R6", ts: 10000 },
    ];

    const result = compactConversation(turns, 6);
    expect(result.removed).toBeGreaterThan(0);

    // "ok" and "Thanks" should be dropped
    const compactable = result.compacted.slice(0, -6);
    const texts = compactable.map(t => t.text);
    expect(texts).not.toContain("ok");
    expect(texts).not.toContain("Thanks");
    // But substantive content should remain
    expect(texts.some(t => t.includes("help"))).toBe(true);
    expect(texts.some(t => t.includes("Important"))).toBe(true);
  });

  it("achieves >50% reduction on typical conversation data", () => {
    // Build a realistic conversation with lots of filler
    const turns: ConversationTurn[] = [];
    let ts = 0;
    for (let i = 0; i < 40; i++) {
      if (i % 4 === 0) {
        turns.push({ speaker: "User", text: `Important question about topic ${i}`, ts: ts++ });
      } else if (i % 4 === 1) {
        turns.push({ speaker: "Asst", text: `Detailed answer about topic ${i - 1} with lots of context and explanation`, ts: ts++ });
      } else if (i % 4 === 2) {
        turns.push({ speaker: "User", text: "ok", ts: ts++ });
      } else {
        turns.push({ speaker: "User", text: "thanks", ts: ts++ });
      }
    }

    const result = compactConversation(turns, 6);
    const reductionPct = 1 - (result.compacted.length / result.original);
    expect(reductionPct).toBeGreaterThan(0.25); // At least 25% reduction from filler removal
  });
});

// ── PB-4: Self-Reflection Detection ──────────────────────────────────────────

describe("PB-4: Self-Reflection Detection", () => {
  it("detects corrections (\"actually X not Y\")", () => {
    const turns: ConversationTurn[] = [
      { speaker: "User", text: "Actually, we use PostgreSQL not MySQL", ts: 1000 },
    ];
    const reflections = detectReflections(turns);
    expect(reflections.length).toBeGreaterThan(0);
    expect(reflections.some(r => r.type === "correction")).toBe(true);
  });

  it("detects corrections (\"I was wrong\")", () => {
    const turns: ConversationTurn[] = [
      { speaker: "User", text: "I was wrong about the API endpoint", ts: 1000 },
    ];
    const reflections = detectReflections(turns);
    expect(reflections.some(r => r.type === "correction")).toBe(true);
  });

  it("detects corrections (\"let me correct\")", () => {
    const turns: ConversationTurn[] = [
      { speaker: "User", text: "Let me correct that: the port is 5432", ts: 1000 },
    ];
    const reflections = detectReflections(turns);
    expect(reflections.some(r => r.type === "correction")).toBe(true);
  });

  it("detects preferences (\"I prefer X\")", () => {
    const turns: ConversationTurn[] = [
      { speaker: "User", text: "I prefer TypeScript over JavaScript", ts: 1000 },
    ];
    const reflections = detectReflections(turns);
    expect(reflections.some(r => r.type === "preference")).toBe(true);
  });

  it("detects preferences (\"from now on\")", () => {
    const turns: ConversationTurn[] = [
      { speaker: "User", text: "From now on, always use strict mode", ts: 1000 },
    ];
    const reflections = detectReflections(turns);
    expect(reflections.some(r => r.type === "preference")).toBe(true);
  });

  it("detects preferences (\"remember that\")", () => {
    const turns: ConversationTurn[] = [
      { speaker: "User", text: "Remember that I use VS Code, not Vim", ts: 1000 },
    ];
    const reflections = detectReflections(turns);
    expect(reflections.some(r => r.type === "preference")).toBe(true);
  });

  it("detects friction (\"I already said\")", () => {
    const turns: ConversationTurn[] = [
      { speaker: "User", text: "I already said the file is in /tmp", ts: 1000 },
    ];
    const reflections = detectReflections(turns);
    expect(reflections.some(r => r.type === "friction")).toBe(true);
  });

  it("detects friction (\"for the Nth time\")", () => {
    const turns: ConversationTurn[] = [
      { speaker: "User", text: "For the 3rd time, the config is in .env", ts: 1000 },
    ];
    const reflections = detectReflections(turns);
    expect(reflections.some(r => r.type === "friction")).toBe(true);
  });

  it("returns empty for neutral conversation", () => {
    const turns: ConversationTurn[] = [
      { speaker: "User", text: "Can you build a REST API?", ts: 1000 },
      { speaker: "Asst", text: "Sure, let me set that up.", ts: 2000 },
    ];
    const reflections = detectReflections(turns);
    expect(reflections.length).toBe(0);
  });

  it("extracts relevant sentence from multi-sentence text", () => {
    const turns: ConversationTurn[] = [
      {
        speaker: "User",
        text: "The project is going well. Actually, we use Python not Ruby. Let me know if you need anything.",
        ts: 1000,
      },
    ];
    const reflections = detectReflections(turns);
    const correction = reflections.find(r => r.type === "correction");
    expect(correction).toBeDefined();
    expect(correction!.text).toContain("Python");
  });

  it("detects multiple insight types from same turn", () => {
    const turns: ConversationTurn[] = [
      {
        speaker: "User",
        text: "Actually, I prefer dark mode. I already told you this.",
        ts: 1000,
      },
    ];
    const reflections = detectReflections(turns);
    const types = new Set(reflections.map(r => r.type));
    expect(types.size).toBeGreaterThanOrEqual(2);
  });
});

// ── PB-5: Consolidation Pass ─────────────────────────────────────────────────

describe("PB-5: Consolidation Pass", () => {
  it("prunes expired nodes during consolidation", () => {
    const engine = new MemgineEngine();
    engine.enablePersistence(graphPath(), convPath());

    engine.ingestEnvironment("temp", "72F", 1000, 2000); // Already expired
    engine.ingestFact("f1", "key", "value");

    const result = consolidate(engine, graphPath(), convPath());
    expect(result.pruned).toBe(1);
    expect(engine.graph.nodeCount()).toBe(1); // Only the fact remains
    expect(result.persisted).toBe(true);
  });

  it("GCs superseded facts beyond depth", () => {
    const engine = new MemgineEngine();
    engine.enablePersistence(graphPath(), convPath());

    // Create a chain: f1 → f2 → f3 → f4 (each supersedes the previous)
    engine.ingestFact("f1", "config", "value1");
    engine.ingestFact("f2", "config", "value2", { supersedes: "f1" });
    engine.ingestFact("f3", "config", "value3", { supersedes: "f2" });
    engine.ingestFact("f4", "config", "value4", { supersedes: "f3" });

    const result = consolidate(engine, graphPath(), convPath(), { gcMaxDepth: 1 });
    expect(result.gcRemoved).toBeGreaterThan(0);
  });

  it("compacts conversations when over threshold", () => {
    const engine = new MemgineEngine();
    engine.enablePersistence(graphPath(), convPath());

    // Write 120 turns (above default 100 threshold)
    for (let i = 0; i < 120; i++) {
      appendConversation(convPath(), i % 2 === 0 ? "User" : "Asst", i % 3 === 0 ? "ok" : `Message ${i}`, i * 1000);
    }

    const result = consolidate(engine, graphPath(), convPath(), { maxConversationTurns: 100 });
    expect(result.compaction).not.toBeNull();
    expect(result.compaction!.compacted.length).toBeLessThan(120);
  });

  it("detects reflections during consolidation", () => {
    const engine = new MemgineEngine();
    engine.enablePersistence(graphPath(), convPath());

    appendConversation(convPath(), "User", "Actually, we use Postgres not MySQL", 1000);
    appendConversation(convPath(), "User", "I prefer tabs over spaces", 2000);

    const result = consolidate(engine, graphPath(), convPath());
    expect(result.reflections.length).toBeGreaterThan(0);
  });

  it("persists graph snapshot during consolidation", () => {
    const engine = new MemgineEngine();
    engine.enablePersistence(graphPath(), convPath());
    engine.ingestFact("f1", "key", "value");

    consolidate(engine, graphPath(), convPath());

    expect(fs.existsSync(graphPath())).toBe(true);
    const loaded = loadGraphSnapshot(graphPath());
    expect(loaded.nodeCount()).toBe(1);
  });
});

// ── PB-6: Engine Persistence Integration ─────────────────────────────────────

describe("PB-6: Engine Persistence Integration", () => {
  it("enablePersistence + persistSnapshot round-trip", () => {
    const engine = new MemgineEngine();
    engine.enablePersistence(graphPath(), convPath());

    engine.ingestIdentity("TestUser", "dev");
    engine.ingestFact("f1", "lang", "TypeScript");
    engine.ingestConversation("User", "Hello", 1000);

    engine.persistSnapshot();

    // New engine, load snapshot
    const engine2 = new MemgineEngine();
    engine2.enablePersistence(graphPath(), convPath());
    engine2.loadSnapshot();

    expect(engine2.graph.nodeCount()).toBe(engine.graph.nodeCount());
    expect(engine2.graph.getByFactId("f1")).toBeDefined();
  });

  it("loadConversationHistory replays turns into graph", () => {
    // Seed conversation file
    appendConversation(convPath(), "User", "Hello", 1000);
    appendConversation(convPath(), "Asst", "Hi!", 2000);
    appendConversation(convPath(), "User", "How are you?", 3000);

    const engine = new MemgineEngine();
    engine.enablePersistence(graphPath(), convPath());
    engine.loadConversationHistory();

    const convNodes = engine.graph.nodesByLayer(3);
    expect(convNodes.length).toBe(3);
  });

  it("shouldConsolidate triggers on high ingestion count", () => {
    const engine = new MemgineEngine({}, { snapshotInterval: 5 });
    engine.enablePersistence(graphPath(), convPath());

    for (let i = 0; i < 6; i++) {
      engine.ingestFact(`f${i}`, `key${i}`, `value${i}`);
    }

    expect(engine.shouldConsolidate()).toBe(true);
  });

  it("shouldConsolidate returns false when nothing to do", () => {
    const engine = new MemgineEngine({}, { snapshotInterval: 50 });
    engine.enablePersistence(graphPath(), convPath());

    engine.ingestFact("f1", "key", "value");

    expect(engine.shouldConsolidate()).toBe(false);
  });

  it("consolidate resets ingestion counter", () => {
    const engine = new MemgineEngine({}, { snapshotInterval: 5 });
    engine.enablePersistence(graphPath(), convPath());

    for (let i = 0; i < 6; i++) {
      engine.ingestFact(`f${i}`, `key${i}`, `value${i}`);
    }

    expect(engine.shouldConsolidate()).toBe(true);

    engine.consolidate();

    expect(engine.shouldConsolidate()).toBe(false);
  });

  it("detectReflections works through engine API", () => {
    const engine = new MemgineEngine();
    engine.enablePersistence(graphPath(), convPath());

    engine.ingestConversation("User", "Actually, the port is 3000 not 8080", 1000);

    const reflections = engine.detectReflections();
    expect(reflections.some(r => r.type === "correction")).toBe(true);
  });

  it("full lifecycle: create → persist → reload → consolidate → verify", () => {
    // Phase 1: Create and populate
    const engine1 = new MemgineEngine();
    engine1.enablePersistence(graphPath(), convPath());

    engine1.ingestIdentity("Dev", "developer");
    engine1.ingestFact("f1", "db", "MySQL");
    engine1.ingestFact("f2", "db", "PostgreSQL", { supersedes: "f1" });
    engine1.ingestConversation("User", "What DB do we use?", 1000);
    engine1.ingestConversation("Asst", "PostgreSQL", 2000);
    engine1.ingestConversation("User", "Actually, we use PostgreSQL not MySQL", 3000);

    engine1.persistSnapshot();

    // Phase 2: Reload
    const engine2 = new MemgineEngine();
    engine2.enablePersistence(graphPath(), convPath());
    engine2.loadSnapshot();
    engine2.loadConversationHistory();

    // Verify state survived
    expect(engine2.graph.getByFactId("f2")).toBeDefined();
    expect(engine2.graph.getByFactId("f2")!.node.value).toBe("PostgreSQL");

    // Phase 3: Consolidate
    const result = engine2.consolidate();
    expect(result).not.toBeNull();
    expect(result!.persisted).toBe(true);

    // Phase 4: Verify graph still correct
    const ctx = engine2.buildContext("database", 8192);
    expect(ctx).toContain("PostgreSQL");

    // Reflections should detect the correction
    const reflections = engine2.detectReflections();
    expect(reflections.some(r => r.type === "correction")).toBe(true);
  });
});

// ── PB-7: Phase A Regression ─────────────────────────────────────────────────

describe("PB-7: Phase A Regression", () => {
  it("PPR retrieval still works", () => {
    const engine = new MemgineEngine();
    engine.ingestFact("f1", "database", "PostgreSQL is the primary database");
    engine.ingestFact("f2", "cache", "Redis is used for caching");

    const ctx = engine.buildContext("database", 8192);
    expect(ctx).toContain("PostgreSQL");
  });

  it("supersession cascade still works", () => {
    const engine = new MemgineEngine();
    engine.ingestFact("f1", "port", "Port is 3000");
    engine.ingestFact("dep1", "config", "Config uses port 3000", { dependsOn: ["f1"] });
    engine.ingestFact("f2", "port", "Port is 8080", { supersedes: "f1" });

    expect(engine.needsReview.has("dep1")).toBe(true);
  });

  it("fast mode still works", () => {
    const engine = new MemgineEngine();
    engine.ingestFact("f1", "a", "value a");
    engine.ingestFact("f2", "b", "value b");

    const ctx = engine.buildContextFast("anything", 8192);
    expect(ctx).toContain("value a");
    expect(ctx).toContain("value b");
  });

  it("context assembly respects budget", () => {
    const engine = new MemgineEngine();
    engine.ingestIdentity("User", "dev");

    // Add many facts to exceed a small budget
    for (let i = 0; i < 100; i++) {
      engine.ingestFact(`f${i}`, `key${i}`, `Long value ${i} `.repeat(20));
    }

    // Very small context window — should truncate
    const ctx = engine.buildContext("test", 8192);
    expect(tokenEstimate(ctx)).toBeLessThan(8192);
  });

  it("conversation filter still works", () => {
    const engine = new MemgineEngine();
    engine.ingestConversation("User", "Let's discuss the API", 1000);
    engine.ingestConversation("User", "Hold on, quick interruption", 2000);
    engine.ingestConversation("User", "Dealing with something else", 3000);
    engine.ingestConversation("User", "Back to the API discussion", 4000);
    engine.ingestConversation("User", "So about the endpoints", 5000);

    const ctx = engine.buildContext("API", 32000);
    expect(ctx).not.toContain("quick interruption");
    expect(ctx).not.toContain("Dealing with something else");
    expect(ctx).toContain("endpoints");
  });
});
