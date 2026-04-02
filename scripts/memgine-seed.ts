#!/usr/bin/env node --experimental-sqlite --import tsx
/**
 * Memgine Seed Script
 *
 * Migrates existing agent memory from per-agent SQLite databases (~918 chunks
 * across 7 agents) into the Convex fact store via the /api/extract endpoint.
 *
 * NOT IDEMPOTENT: The extract endpoint creates new facts each run. Re-running
 * will create duplicate facts. Only run once per agent, or clear the fact store
 * before re-running.
 *
 * Usage:
 *   node --experimental-sqlite --import tsx scripts/memgine-seed.ts [--dry-run] [--agent <name>] [--concurrency <n>]
 *
 * Environment variables (read from ~/.openclaw/openclaw.json if not set):
 *   MEMGINE_CONVEX_SITE_URL — Convex site URL (e.g. https://proficient-eel-773.convex.site)
 *   OPENROUTER_API_KEY      — For LLM extraction
 *   OPENAI_API_KEY          — For embeddings
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error -- node:sqlite is experimental in Node 22+
import { DatabaseSync } from "node:sqlite";

const MEMORY_DIR = path.join(os.homedir(), ".openclaw", "memory");
const CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");

interface ChunkRow {
  id: string;
  path: string;
  text: string;
  start_line: number;
  updated_at: number;
}

function readChunks(dbPath: string): ChunkRow[] {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const stmt = db.prepare(
      "SELECT id, path, text, start_line, updated_at FROM chunks ORDER BY path, start_line",
    );
    return stmt.all() as ChunkRow[];
  } finally {
    db.close();
  }
}

function makeFactId(agentId: string, chunkPath: string, startLine: number): string {
  const hash = createHash("sha256")
    .update(`${agentId}:${chunkPath}:${startLine}`)
    .digest("hex")
    .slice(0, 12);
  return `${agentId}-seed-${hash}`;
}

function resolveLayer(chunkPath: string): "persistent" | "working-set" {
  if (chunkPath.match(/memory\/\d{4}-\d{2}-\d{2}/)) {
    return "working-set";
  }
  return "persistent";
}

/** Load env vars from openclaw.json if not already set in process.env */
function loadConfigEnv(): void {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    const envBlock = config?.env;
    if (envBlock && typeof envBlock === "object") {
      for (const [key, value] of Object.entries(envBlock)) {
        if (!process.env[key] && typeof value === "string") {
          process.env[key] = value;
        }
      }
    }
  } catch {
    // config not found or not parseable -- rely on process.env
  }
}

async function extractViaApi(params: {
  siteUrl: string;
  content: string;
  agentId: string;
  sessionKey: string;
  turnIndex: number;
  apiKey: string;
  openaiApiKey: string;
  model: string;
}): Promise<number> {
  const resp = await fetch(`${params.siteUrl}/api/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: params.content,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      turnIndex: params.turnIndex,
      model: params.model,
      apiKey: params.apiKey,
      openaiApiKey: params.openaiApiKey,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Extract API ${resp.status}: ${err.slice(0, 200)}`);
  }

  const result = (await resp.json()) as { factsExtracted?: number };
  return result.factsExtracted ?? 0;
}

/** Process chunks with concurrency limit */
async function processWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
}

async function main() {
  loadConfigEnv();

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const agentFilter = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : undefined;
  const concurrency = args.includes("--concurrency")
    ? Number.parseInt(args[args.indexOf("--concurrency") + 1], 10) || 3
    : 3;

  const siteUrl = process.env.MEMGINE_CONVEX_SITE_URL;
  const apiKey = process.env.OPENROUTER_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const model = process.env.MEMGINE_EXTRACTION_MODEL || "anthropic/claude-haiku-4-5";

  if (!siteUrl && !dryRun) {
    console.error("Missing MEMGINE_CONVEX_SITE_URL");
    process.exit(1);
  }
  if ((!apiKey || !openaiApiKey) && !dryRun) {
    console.error("Missing OPENROUTER_API_KEY or OPENAI_API_KEY");
    process.exit(1);
  }

  // Discover databases
  const dbFiles = fs
    .readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith(".sqlite"))
    .map((f) => ({ agentId: f.replace(".sqlite", ""), path: path.join(MEMORY_DIR, f) }))
    .filter((d) => !agentFilter || d.agentId === agentFilter);

  if (dbFiles.length === 0) {
    console.error("No SQLite databases found" + (agentFilter ? ` for agent "${agentFilter}"` : ""));
    process.exit(1);
  }

  console.log(`\n=== Memgine Seed ===`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Model: ${model}`);
  console.log(`Databases: ${dbFiles.map((d) => d.agentId).join(", ")}\n`);

  let totalChunks = 0;
  let totalFacts = 0;
  let totalErrors = 0;

  for (const { agentId, path: dbPath } of dbFiles) {
    console.log(`--- Processing: ${agentId} ---`);
    const chunks = readChunks(dbPath);
    if (chunks.length === 0) {
      console.log(`  (empty - skipping)`);
      continue;
    }

    const persistent = chunks.filter((c) => resolveLayer(c.path) === "persistent").length;
    const workingSet = chunks.length - persistent;
    console.log(
      `  Chunks: ${chunks.length} (persistent: ${persistent}, working-set: ${workingSet})`,
    );

    if (dryRun) {
      console.log(`  [DRY RUN] Would extract ${chunks.length} chunks`);
      totalChunks += chunks.length;
      continue;
    }

    let agentFacts = 0;
    let agentErrors = 0;

    await processWithConcurrency(chunks, concurrency, async (chunk, idx) => {
      const factId = makeFactId(agentId, chunk.path, chunk.start_line);
      const layer = resolveLayer(chunk.path);
      // Prefix content with metadata so the LLM extracts with proper context
      const content = `[Seed migration] [Agent: ${agentId}] [Source: ${chunk.path}] [Layer: ${layer}] [FactID: ${factId}]\n\n${chunk.text}`;

      try {
        const extracted = await extractViaApi({
          siteUrl: siteUrl!,
          content,
          agentId,
          sessionKey: `seed:${agentId}`,
          turnIndex: idx,
          apiKey: apiKey!,
          openaiApiKey: openaiApiKey!,
          model,
        });
        agentFacts += extracted;
        if ((idx + 1) % 10 === 0 || idx === chunks.length - 1) {
          console.log(
            `  Progress: ${idx + 1}/${chunks.length} chunks, ${agentFacts} facts extracted`,
          );
        }
      } catch (err) {
        agentErrors++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Error on chunk ${idx} (${chunk.path}): ${msg.slice(0, 150)}`);
      }
    });

    totalChunks += chunks.length;
    totalFacts += agentFacts;
    totalErrors += agentErrors;
    console.log(`  Done: ${agentId} (${agentFacts} facts, ${agentErrors} errors)`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Chunks processed: ${totalChunks}`);
  console.log(`Facts extracted: ${totalFacts}`);
  if (totalErrors > 0) {
    console.log(`Errors: ${totalErrors}`);
  }
  console.log(`Mode: ${dryRun ? "DRY RUN (nothing written)" : "LIVE"}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
