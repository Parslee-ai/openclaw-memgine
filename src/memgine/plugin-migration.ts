/**
 * Memgine v2 Phase C — Flat File → Graph Migration Tool
 *
 * Migrates existing flat markdown files (MEMORY.md, WORKING.md, SOUL.md, daily logs)
 * into the v2 graph engine as typed nodes.
 *
 * Implements Rex R-1 (idempotency via factId dedup) and R-2 (structured provenance).
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { MemgineEngine } from "./engine.js";
import {
  MemKind,
  emptyMetadata,
  type Layer,
  type Provenance,
  type ContentType,
  type MemNode,
} from "./types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Generate a deterministic factId for migration dedup (R-1).
 * Format: migration:<filename>:<hash>
 */
function migrationFactId(filename: string, section: string): string {
  const hash = crypto.createHash("sha256").update(section).digest("hex").slice(0, 12);
  return `migration:${filename}:${hash}`;
}

/**
 * Build structured provenance for migrated nodes (R-2).
 */
function migrationProvenance(filename: string, date?: number): Provenance {
  return {
    source: "migration",
    reference: filename,
    date: date ?? Date.now(),
  };
}

/**
 * Split a markdown file into sections by ## headings.
 * Returns array of { heading, content } objects.
 * If no headings exist, the entire content is one section with heading "".
 */
function splitMarkdownSections(text: string): Array<{ heading: string; content: string }> {
  const lines = text.split("\n");
  const sections: Array<{ heading: string; content: string }> = [];
  let currentHeading = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      // Flush previous section
      if (currentLines.length > 0 || currentHeading) {
        const content = currentLines.join("\n").trim();
        if (content) {
          sections.push({ heading: currentHeading, content });
        }
      }
      currentHeading = headingMatch[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Flush last section
  const content = currentLines.join("\n").trim();
  if (content || currentHeading) {
    sections.push({ heading: currentHeading, content: content || currentHeading });
  }

  return sections;
}

/**
 * Create a MemNode with proper structure.
 */
function createNode(
  kind: MemKind,
  layer: Layer,
  key: string,
  value: string,
  factId: string,
  provenance: Provenance,
): MemNode {
  const meta = emptyMetadata();
  meta.provenance = [provenance];

  return {
    kind,
    layer,
    key,
    value,
    factId,
    scope: "agent",
    authority: "migration",
    isConstraint: false,
    createdAt: provenance.date ?? Date.now(),
    contentType: "natural_language" as ContentType,
    metadata: meta,
  };
}

// ── Migration Functions ────────────────────────────────────────────────────────

export interface MigrationResult {
  nodesAdded: number;
  nodesSkipped: number;
  sourceFile: string;
}

/**
 * Migrate MEMORY.md → Fact nodes (layer 2).
 * Each ## section becomes a separate Fact node.
 * Idempotent: skips nodes whose factId already exists in the graph.
 */
export function migrateMemoryMd(engine: MemgineEngine, filePath: string): MigrationResult {
  const result: MigrationResult = { nodesAdded: 0, nodesSkipped: 0, sourceFile: filePath };

  if (!fs.existsSync(filePath)) {
    return result;
  }

  const text = fs.readFileSync(filePath, "utf-8");
  const sections = splitMarkdownSections(text);
  const filename = path.basename(filePath);
  const provenance = migrationProvenance(filename);

  for (const section of sections) {
    const factId = migrationFactId(filename, section.heading || section.content);
    const key = section.heading || `memory-section-${result.nodesAdded}`;
    const value = section.heading ? `${section.heading}: ${section.content}` : section.content;

    // Check idempotency — skip if factId already exists
    if (hasFactId(engine, factId)) {
      result.nodesSkipped++;
      continue;
    }

    const node = createNode(MemKind.Fact, 2 as Layer, key, value, factId, provenance);
    engine.graph.insert(node);
    result.nodesAdded++;
  }

  return result;
}

/**
 * Migrate WORKING.md → Environment nodes (layer 4).
 * Each ## section becomes a separate Environment node.
 */
export function migrateWorkingMd(engine: MemgineEngine, filePath: string): MigrationResult {
  const result: MigrationResult = { nodesAdded: 0, nodesSkipped: 0, sourceFile: filePath };

  if (!fs.existsSync(filePath)) {
    return result;
  }

  const text = fs.readFileSync(filePath, "utf-8");
  const sections = splitMarkdownSections(text);
  const filename = path.basename(filePath);
  const provenance = migrationProvenance(filename);

  for (const section of sections) {
    const factId = migrationFactId(filename, section.heading || section.content);
    const key = section.heading || `working-section-${result.nodesAdded}`;
    const value = section.heading ? `${section.heading}: ${section.content}` : section.content;

    if (hasFactId(engine, factId)) {
      result.nodesSkipped++;
      continue;
    }

    const node = createNode(MemKind.Environment, 4 as Layer, key, value, factId, provenance);
    engine.graph.insert(node);
    result.nodesAdded++;
  }

  return result;
}

/**
 * Migrate SOUL.md → Identity node (layer 1).
 * The entire file content becomes a single Identity node.
 */
export function migrateSoulMd(engine: MemgineEngine, filePath: string): MigrationResult {
  const result: MigrationResult = { nodesAdded: 0, nodesSkipped: 0, sourceFile: filePath };

  if (!fs.existsSync(filePath)) {
    return result;
  }

  const text = fs.readFileSync(filePath, "utf-8").trim();
  if (!text) {
    return result;
  }

  const filename = path.basename(filePath);
  const factId = migrationFactId(filename, "identity");
  const provenance = migrationProvenance(filename);

  if (hasFactId(engine, factId)) {
    result.nodesSkipped++;
    return result;
  }

  const node = createNode(MemKind.Identity, 1 as Layer, "identity", text, factId, provenance);
  engine.graph.insert(node);
  result.nodesAdded++;
  return result;
}

/**
 * Migrate daily log files (memory/YYYY-MM-DD.md) → Conversation nodes (layer 3).
 * Each file becomes a single Conversation node. The date is parsed from filename.
 */
export function migrateDailyLogs(engine: MemgineEngine, dirPath: string): MigrationResult {
  const result: MigrationResult = { nodesAdded: 0, nodesSkipped: 0, sourceFile: dirPath };

  if (!fs.existsSync(dirPath)) {
    return result;
  }

  const files = fs
    .readdirSync(dirPath)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .toSorted();

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const text = fs.readFileSync(filePath, "utf-8").trim();

    if (!text) {
      continue;
    }

    const factId = migrationFactId(file, "daily-log");

    // Parse date from filename
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    const logDate = dateMatch ? new Date(dateMatch[1]).getTime() : Date.now();
    const provenance = migrationProvenance(file, logDate);

    if (hasFactId(engine, factId)) {
      result.nodesSkipped++;
      continue;
    }

    const node = createNode(
      MemKind.Conversation,
      3 as Layer,
      `daily:${file}`,
      text,
      factId,
      provenance,
    );
    engine.graph.insert(node);
    result.nodesAdded++;
  }

  return result;
}

// ── Utilities ──────────────────────────────────────────────────────────────────

/**
 * Check if a factId already exists in the engine's graph.
 */
function hasFactId(engine: MemgineEngine, factId: string): boolean {
  return engine.graph.getByFactId(factId) !== undefined;
}

/**
 * Run all migrations for a workspace directory.
 * Preserves source files (never deletes originals).
 */
export function migrateWorkspace(engine: MemgineEngine, workspaceDir: string): MigrationResult[] {
  const results: MigrationResult[] = [];

  const soulPath = path.join(workspaceDir, "SOUL.md");
  results.push(migrateSoulMd(engine, soulPath));

  const memoryPath = path.join(workspaceDir, "MEMORY.md");
  results.push(migrateMemoryMd(engine, memoryPath));

  const workingPath = path.join(workspaceDir, "WORKING.md");
  results.push(migrateWorkingMd(engine, workingPath));

  const dailyDir = path.join(workspaceDir, "memory");
  results.push(migrateDailyLogs(engine, dailyDir));

  return results;
}
