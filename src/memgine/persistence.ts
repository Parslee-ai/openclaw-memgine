/**
 * Memgine v2 Phase B — JSONL Persistence.
 *
 * Graph snapshots via atomic rename (write to .tmp, rename to .jsonl).
 * Conversation store via write-through append-only JSONL.
 * Recovery: corrupted JSONL → load last good snapshot.
 *
 * File locations: ~/.openclaw/workspace-{agent}/memgine/
 * - graph.jsonl: full graph snapshot (nodes + edges)
 * - conversations.jsonl: append-only conversation turns
 */

import * as fs from "fs";
import * as path from "path";
import { MemoryGraph } from "./graph.js";
import {
  type MemNode,
  type MemEdge,
  MemKind,
  EdgeKind,
  type Layer,
  type ContentType,
  type FactMetadata,
  emptyMetadata,
} from "./types.js";

// ── JSONL Record Types ───────────────────────────────────────────────────────

interface JsonlNodeRecord {
  type: "node";
  index: number;
  kind: string;
  layer: number;
  key: string;
  value: string;
  factId?: string;
  scope: string;
  authority: string;
  isConstraint: boolean;
  createdAt: number;
  expiresAt?: number;
  contentType: string;
  metadata: FactMetadata;
}

interface JsonlEdgeRecord {
  type: "edge";
  kind: string;
  weight: number;
  createdAt: number;
  from: number;
  to: number;
}

interface JsonlConversationRecord {
  speaker: string;
  text: string;
  ts: number;
}

type JsonlRecord = JsonlNodeRecord | JsonlEdgeRecord;

// ── Enum Serialization ───────────────────────────────────────────────────────

function memKindToString(kind: MemKind): string {
  return MemKind[kind];
}

function stringToMemKind(s: string): MemKind {
  const val = (MemKind as Record<string, unknown>)[s];
  if (typeof val === "number") {return val as MemKind;}
  throw new Error(`Unknown MemKind: ${s}`);
}

function edgeKindToString(kind: EdgeKind): string {
  return EdgeKind[kind];
}

function stringToEdgeKind(s: string): EdgeKind {
  const val = (EdgeKind as Record<string, unknown>)[s];
  if (typeof val === "number") {return val as EdgeKind;}
  throw new Error(`Unknown EdgeKind: ${s}`);
}

// ── Node Serialization ───────────────────────────────────────────────────────

function nodeToRecord(index: number, node: MemNode): JsonlNodeRecord {
  return {
    type: "node",
    index,
    kind: memKindToString(node.kind),
    layer: node.layer,
    key: node.key,
    value: node.value,
    ...(node.factId !== undefined ? { factId: node.factId } : {}),
    scope: node.scope,
    authority: node.authority,
    isConstraint: node.isConstraint,
    createdAt: node.createdAt,
    ...(node.expiresAt !== undefined ? { expiresAt: node.expiresAt } : {}),
    contentType: node.contentType,
    metadata: node.metadata,
  };
}

function recordToNode(rec: JsonlNodeRecord): MemNode {
  return {
    kind: stringToMemKind(rec.kind),
    layer: rec.layer as Layer,
    key: rec.key,
    value: rec.value,
    ...(rec.factId !== undefined ? { factId: rec.factId } : {}),
    scope: rec.scope,
    authority: rec.authority,
    isConstraint: rec.isConstraint,
    createdAt: rec.createdAt,
    ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
    contentType: rec.contentType as ContentType,
    metadata: rec.metadata ?? emptyMetadata(),
  };
}

function edgeToRecord(edge: MemEdge): JsonlEdgeRecord {
  return {
    type: "edge",
    kind: edgeKindToString(edge.kind),
    weight: edge.weight,
    createdAt: edge.createdAt,
    from: edge.from,
    to: edge.to,
  };
}

function recordToEdge(rec: JsonlEdgeRecord): MemEdge {
  return {
    kind: stringToEdgeKind(rec.kind),
    weight: rec.weight,
    createdAt: rec.createdAt,
    from: rec.from,
    to: rec.to,
  };
}

// ── Graph Snapshot Persistence ───────────────────────────────────────────────

/**
 * Save graph to JSONL using atomic rename pattern.
 * Writes to .tmp first, then renames to target path.
 */
export function saveGraphSnapshot(graph: MemoryGraph, filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = filePath + ".tmp";
  const lines: string[] = [];

  // Serialize all alive nodes with their indices
  const nodeIndices = graph.allNodeIndices();
  for (const idx of nodeIndices) {
    const node = graph.getNode(idx);
    if (node) {
      lines.push(JSON.stringify(nodeToRecord(idx, node)));
    }
  }

  // Serialize all edges (only those with alive endpoints)
  const edges = graph.allEdges();
  for (const edge of edges) {
    const fromNode = graph.getNode(edge.from);
    const toNode = graph.getNode(edge.to);
    if (fromNode && toNode) {
      lines.push(JSON.stringify(edgeToRecord(edge)));
    }
  }

  // Atomic write: tmp → rename
  fs.writeFileSync(tmpPath, lines.join("\n") + "\n", "utf8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Load graph from JSONL snapshot.
 * Returns a new MemoryGraph populated from the file.
 * On parse error for a line, skips it (graceful degradation).
 */
export function loadGraphSnapshot(filePath: string): MemoryGraph {
  if (!fs.existsSync(filePath)) {
    return new MemoryGraph();
  }

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);

  const graph = new MemoryGraph();

  // Suppress auto-linking during restore (edges are explicitly restored)
  graph.setAutoLink(false);

  // Two-pass: nodes first (to allocate indices), then edges
  const nodeRecords: JsonlNodeRecord[] = [];
  const edgeRecords: JsonlEdgeRecord[] = [];

  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as JsonlRecord;
      if (rec.type === "node") {
        nodeRecords.push(rec);
      } else if (rec.type === "edge") {
        edgeRecords.push(rec);
      }
    } catch {
      // Skip malformed lines — graceful degradation
      continue;
    }
  }

  // Sort nodes by original index to maintain order
  nodeRecords.sort((a, b) => a.index - b.index);

  // Insert nodes — track old→new index mapping
  const indexMap = new Map<number, number>();
  for (const rec of nodeRecords) {
    const node = recordToNode(rec);
    const newIdx = graph.insert(node);
    indexMap.set(rec.index, newIdx);
  }

  // Insert edges with remapped indices
  for (const rec of edgeRecords) {
    const from = indexMap.get(rec.from);
    const to = indexMap.get(rec.to);
    if (from !== undefined && to !== undefined) {
      graph.link(from, to, recordToEdge(rec).kind, rec.weight);
    }
  }

  // Re-enable auto-linking for normal operation
  graph.setAutoLink(true);

  return graph;
}

// ── Conversation Store ───────────────────────────────────────────────────────

/**
 * Append a conversation turn to the JSONL store.
 * Write-through: called on each ingestConversation.
 */
export function appendConversation(
  filePath: string,
  speaker: string,
  text: string,
  ts: number,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const record: JsonlConversationRecord = { speaker, text, ts };
  fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
}

/**
 * Load all conversation turns from the JSONL store.
 */
export function loadConversations(
  filePath: string,
): Array<{ speaker: string; text: string; ts: number }> {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const results: Array<{ speaker: string; text: string; ts: number }> = [];

  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as JsonlConversationRecord;
      if (rec.speaker && rec.text && typeof rec.ts === "number") {
        results.push(rec);
      }
    } catch {
      continue;
    }
  }

  return results;
}

/**
 * Rewrite conversation store with compacted turns.
 * Uses atomic rename pattern.
 */
export function rewriteConversations(
  filePath: string,
  turns: Array<{ speaker: string; text: string; ts: number }>,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = filePath + ".tmp";
  const lines = turns.map((t) => JSON.stringify(t));
  fs.writeFileSync(tmpPath, lines.join("\n") + "\n", "utf8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Count lines in conversation store without loading full content.
 */
export function conversationLineCount(filePath: string): number {
  if (!fs.existsSync(filePath)) {return 0;}
  const content = fs.readFileSync(filePath, "utf8");
  return content.split("\n").filter((l) => l.trim().length > 0).length;
}
