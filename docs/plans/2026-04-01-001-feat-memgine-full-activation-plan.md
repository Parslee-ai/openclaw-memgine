---
title: "feat: Fully activate memgine engine and stop relying on markdown memory files"
type: feat
status: active
date: 2026-04-01
deepened: 2026-04-01
---

# feat: Fully activate memgine engine and stop relying on markdown memory files

## Overview

The memgine engine (Convex-backed structured fact store with vector search, 4-layer token budgeting, and async extraction) was built across Phases 1-5 and merged to main. However, this OpenClaw instance still runs on the markdown memory path -- MEMORY.md and `memory/*.md` files are the primary context source. This plan activates the memgine pipeline end-to-end: enabling hooks, seeding the fact store with existing memory from per-agent SQLite databases (~918 chunks across 7 agents), migrating the session-memory hook to feed memgine instead of writing markdown, and making memgine the primary context source for agent sessions.

## Problem Frame

Agent memory currently flows through flat markdown files:

- `MEMORY.md` at workspace root is injected into every bootstrap
- The session-memory hook writes conversation summaries to `memory/YYYY-MM-DD-slug.md` on `/new` and `/reset`
- These files are loaded verbatim into the system prompt, consuming context budget without relevance filtering

The memgine system solves this with structured facts, vector-based relevance ranking, per-layer token budgets, and visibility controls (agent-private, session-type restrictions). The infrastructure exists but isn't wired up on this instance.

## Requirements Trace

- R1. Memgine extraction hook fires on every `message:sent` and stores facts in Convex
- R2. Memgine context hook replaces MEMORY.md/WORKING.md at bootstrap with assembled, relevance-ranked facts
- R3. Session-memory hook forwards conversation summaries to memgine extraction instead of writing markdown files
- R4. Identity files (SOUL.md, AGENTS.md, USER.md, TOOLS.md) continue to load normally alongside memgine context
- R5. Graceful degradation: if Convex is unreachable, agent sessions still work (fall back to markdown)
- R6. No disruption to running gateway during migration
- R7. Existing memory content (from per-agent SQLite memory databases) is migrated into the Convex fact store so agents retain historical context

## Scope Boundaries

- Identity file migration to Layer 1 facts is **out of scope** (SOUL.md, USER.md etc. stay as markdown)
- Memory search tools (`memory_search`, `memory_get`) are **out of scope** -- they continue to work against existing markdown files; a future plan will wire them to Convex
- Convex deployment itself is already running and accessible (no infra provisioning needed)
- No changes to the Convex schema, engine, or HTTP endpoints

## Context & Research

### Relevant Code and Patterns

- **Bootstrap pipeline**: `src/agents/bootstrap-files.ts` -> `src/agents/workspace.ts` -> `src/agents/bootstrap-hooks.ts` -- loads markdown files, then gives hooks a chance to modify the list
- **Memgine context hook**: `src/hooks/bundled/memgine-context/handler.ts` -- fires on `agent:bootstrap`, filters out MEMORY.md/WORKING.md, injects virtual memgine context
- **Memgine extraction hook**: `src/hooks/bundled/memgine-extraction/handler.ts` -- fires on `message:sent`, POSTs turn content to Convex `/api/extract`
- **Session-memory hook**: `src/hooks/bundled/session-memory/handler.ts` -- fires on `command:new`/`command:reset`, writes conversation summary to `memory/YYYY-MM-DD-slug.md`
- **Hook config resolution**: `src/hooks/config.ts` -- `resolveHookConfig()` reads from `hooks.internal.entries.<hookKey>`
- **Hook eligibility**: `src/hooks/loader.ts` + `src/shared/config-eval.ts` -- checks requirements, OS, env vars, per-hook enabled flag
- **Config path**: `~/.openclaw/openclaw.json` (JSON5)

### Institutional Learnings

- **message:sent wiring coverage**: The fix commit `3323548cc` revealed that `message:sent` was not initially emitted from all delivery paths (inline bot delivery was missed). When verifying extraction, check all delivery paths.
- **Graceful degradation is mandatory**: Both memgine hooks wrap core logic in try/catch and never block. Any changes must preserve this.
- **Fork gateway for testing**: `start-fork-gateway.sh` runs on port 18790 with isolated home dir -- use this for validation.
- **Config context availability**: `MessageSentHookContext` (used by memgine-extraction) does not carry `cfg`, so `resolveHookConfig()` cannot be used in the extraction hook without cross-boundary changes. Command events (`command:new`/`command:reset`, used by session-memory) DO carry `cfg`. This shapes which hooks can use config vs env vars.
- **Embedding dimension lock**: 1536 dims (text-embedding-3-small) hardcoded in Convex schema. Not changing, but worth noting.
- **Session-memory coexistence**: During transition, both hooks can run simultaneously. Disable markdown writing only after memgine extraction is confirmed stable.

## Key Technical Decisions

- **Session-memory forwards to memgine, not replaced entirely**: The session-memory hook's message extraction and filtering logic is valuable. Rather than deleting the hook, modify it to POST the conversation summary to the memgine extraction endpoint (reusing the same HTTP call pattern as memgine-extraction). This gives memgine a "session boundary" extraction pass that captures cross-turn patterns individual turn extractions might miss. Rationale: per-turn extraction handles granular facts; session-boundary extraction captures higher-level patterns and context.

- **Extraction hook stays on env vars; session-memory uses config**: The `MessageSentHookContext` does not carry `cfg`, so `resolveHookConfig()` cannot be used in memgine-extraction without modifying the delivery pipeline (out of scope). Memgine-extraction continues reading from env vars (`MEMGINE_CONVEX_SITE_URL`, `OPENROUTER_API_KEY`, etc.). The session-memory hook fires on `command:new`/`command:reset` which DO carry `cfg`, so it can use `resolveHookConfig()` to read the Convex URL from config with env var fallback. Rationale: avoids cross-boundary changes while using config where it's naturally available.

- **Keep session-memory markdown writing behind a flag**: Add an `archiveToMarkdown` boolean (default: `false`) to session-memory config. When true, continues writing markdown files alongside memgine forwarding. Rationale: allows gradual migration and preserves archival if desired, without requiring it.

- **Fallback-write markdown on memgine POST failure**: When `archiveToMarkdown` is `false` and the memgine POST fails, session-memory should still write the markdown file as a safety net (with a warning log). Rationale: session-boundary data represents entire conversations; silently losing it is worse than a single turn extraction failure. The markdown fallback ensures no data loss during Convex outages.

## Open Questions

### Resolved During Planning

- **Should session-memory be deleted or modified?** Modified -- it has valuable message extraction logic and its event triggers (`command:new`/`command:reset`) are the right place for session-boundary fact extraction.
- **Should we migrate memory search tools?** No -- out of scope. They continue working against markdown files. A separate plan will address this.
- **Do we need to change the Convex backend?** No -- the existing schema, engine, and HTTP endpoints support everything needed.

### Deferred to Implementation

- **Extraction prompt adaptation for session summaries**: The Convex `/api/extract` endpoint prompt is designed for single-turn content ("Extract discrete facts from the following conversation turn"). Session-memory forwards multi-turn summaries (up to 15 messages). The extraction quality may differ. Either the endpoint needs input-type awareness, or session-memory should signal `sourceContext: "session-boundary"` so the backend can select an appropriate prompt. Determine during implementation whether this matters in practice.
- **Whether LLM slug generation should be preserved for archival mode**: Only relevant if `archiveToMarkdown` is used; can be decided during implementation.
- **WORKING.md active usage**: The memgine-context hook filters out both MEMORY.md and WORKING.md. Verify whether WORKING.md is actively used on this instance; if not, note it explicitly. If it is, the degradation path should account for it.

## Implementation Units

- [ ] **Unit 1: Enable memgine hooks in gateway config**

**Goal:** Wire the OpenClaw config to enable both memgine hooks so they fire at the correct lifecycle points.

**Requirements:** R1, R2, R5

**Dependencies:** None

**Files:**

- Modify: `~/.openclaw/openclaw.json` (runtime config, not in repo)
- Reference: `src/hooks/bundled/memgine-context/HOOK.md`
- Reference: `src/hooks/bundled/memgine-extraction/HOOK.md`
- Reference: `src/hooks/config.ts`

**Approach:**

- Add `hooks.internal.enabled: true` and entries for both `memgine-context` and `memgine-extraction` to the gateway config
- Set required environment variables in the shell profile or gateway env:
  - `OPENAI_API_KEY` -- used by both hooks for embeddings
  - `OPENROUTER_API_KEY` -- used by extraction hook for LLM
  - `MEMGINE_CONVEX_SITE_URL` -- used by extraction hook (points to `.convex.site` for HTTP actions)
  - `MEMGINE_CONVEX_URL` -- used by context hook's env var fallback (points to `.convex.cloud` for Convex client SDK); note: the context hook primarily reads `convexUrl` from its config entry, but falls back to this env var
- memgine-context entry needs `convexUrl`, `openaiApiKey` (as `${OPENAI_API_KEY}`), and `budgets`
- memgine-extraction entry needs `enabled: true` (rest from env vars -- `MessageSentHookContext` doesn't carry `cfg`)

**Patterns to follow:**

- `src/hooks/bundled/memgine-context/HOOK.md` -- shows the exact config shape expected
- `src/hooks/config.ts:resolveHookConfig()` -- how config is resolved at runtime

**Test scenarios:**

- Happy path: Gateway starts, `loadInternalHooks()` logs both memgine hooks as registered for their events (`agent:bootstrap`, `message:sent`)
- Error path: If Convex URL is wrong or env vars missing, hooks should log warnings and skip gracefully (not crash the gateway)

**Verification:**

- Gateway startup logs show both hooks loaded
- `openclaw channels status --probe` succeeds (gateway healthy)

---

- [ ] **Unit 2: Verify extraction pipeline end-to-end**

**Goal:** Confirm that the memgine-extraction hook fires on agent messages and facts appear in the Convex fact store.

**Requirements:** R1, R5

**Dependencies:** Unit 1

**Files:**

- Reference: `src/hooks/bundled/memgine-extraction/handler.ts`
- Reference: `memgine/convex/http.ts`
- Reference: `memgine/convex/facts.ts`

**Approach:**

- Send a test message through any connected channel
- Check gateway logs for memgine-extraction hook firing (it logs `[memgine-extraction]` prefix)
- Verify facts appear in Convex dashboard (or query via Convex CLI)
- Test with multiple delivery paths: direct channel message, inline bot reply (the path that was previously missed per commit `3323548cc`)

**Patterns to follow:**

- The extraction hook logs `[memgine-extraction] extracted N facts` on success
- Convex dashboard at the deployment URL shows fact records in the `facts` table

**Test scenarios:**

- Happy path: Send message via Telegram -> extraction hook fires -> facts visible in Convex `facts` table with correct `agentId`, `sessionKey`, embeddings generated
- Happy path: Inline bot reply -> extraction hook fires (verifies the `message:sent` wiring fix)
- Edge case: Very short message (<20 chars) -> extraction hook skips (by design)
- Error path: Convex unreachable -> extraction hook logs error, agent response still delivered

**Verification:**

- At least one fact exists in Convex with correct metadata
- Corresponding embedding exists in `fact_embeddings` table
- Gateway continues operating normally after extraction (fire-and-forget confirmed)

---

- [ ] **Unit 3: Seed fact store from existing memory databases**

**Goal:** Migrate existing agent memory (stored in per-agent SQLite databases) into the Convex fact store so agents retain their accumulated knowledge when switching to memgine.

**Requirements:** R7

**Dependencies:** Unit 1 (Convex deployment must be accessible and hooks enabled)

**Files:**

- Create: `scripts/memgine-seed.ts` (migration script)
- Reference: `memgine/convex/facts.ts` (`createBatch` mutation)
- Reference: `memgine/convex/embeddings.ts` (`store` mutation)
- Reference: `memgine/convex/schema.ts` (fact schema constraints)

**Approach:**

- Write a Node.js/Bun script that iterates over per-agent SQLite databases at `~/.openclaw/memory/*.sqlite` (grace.sqlite, dev.sqlite, biostat.sqlite, designer.sqlite, designer2.sqlite, devops.sqlite, supervisor.sqlite — ~918 chunks total)
- For each database, query the `chunks` table (`SELECT path, text, updated_at FROM chunks`) to extract memory content
- Use the **direct `facts.createBatch` Convex mutation** via the Convex SDK — NOT the HTTP `/api/extract` endpoint. Rationale: no 4000-char truncation, no LLM cost ($0 vs ~$0.19), no extraction prompt mismatch, full text preservation, and much faster (~minutes vs ~hours)
- Transform each chunk into a fact object with sensible defaults:
  - `factId`: `${agentId}-seed-${hash(path + startLine)}`
  - `factText`: full chunk text (no truncation)
  - `layer`: 2 (persistent) for MEMORY.md content; 3 (working set) for dated session logs (`memory/YYYY-MM-DD*.md`)
  - `scope`: `"global"`
  - `visibility`: `"team"`
  - `authorAgent`: derived from database filename (e.g., `grace.sqlite` -> `grace`)
  - `sourceType`: `"system"` (system-level migration, not conversation-extracted)
  - `authority`: `"system"`
  - `isActive`: `true`
- Batch in groups of ~100 facts per `createBatch` call
- After fact insertion, generate embeddings in a second pass via the OpenAI API and store via `embeddings.store` mutation. This can run async and is optional for initial activation (facts are usable without embeddings, just not vector-searchable)
- Log progress: agent name, chunks processed, facts inserted, embeddings generated

**Patterns to follow:**

- `memgine/convex/facts.ts:createBatch` — the direct mutation interface
- `memgine/convex/schema.ts` — valid enum values for `sourceType`, `scope`, `visibility`, `authority`
- Convex SDK usage: `import { ConvexClient } from "convex/browser"` or Convex CLI `npx convex run`

**Test scenarios:**

- Happy path: Script processes all 7 SQLite databases -> facts appear in Convex `facts` table with correct `authorAgent`, `layer`, `sourceType: "system"`
- Happy path: MEMORY.md-sourced chunks get layer 2; dated session logs get layer 3
- Edge case: Empty database (no chunks) -> script skips with a log message, no error
- Edge case: Duplicate run -> script should be idempotent (check for existing factIds before inserting, or use a deterministic factId scheme that Convex can deduplicate)
- Error path: Convex unreachable -> script exits with clear error message and count of what was/wasn't migrated
- Integration: After seeding, `assembleContext` returns facts from migrated data

**Verification:**

- Convex `facts` table contains facts from all 7 agent databases
- Fact count roughly matches total chunk count from SQLite (~918)
- Spot-check: a known fact from grace's MEMORY.md appears in Convex with correct agent attribution
- Context assembly produces meaningful output including seeded facts

---

- [ ] **Unit 4: Verify context assembly at bootstrap**

**Goal:** Confirm that the memgine-context hook fires during agent bootstrap and replaces MEMORY.md with assembled facts from both seeded migration data and any new extractions.

**Requirements:** R2, R4, R5

**Dependencies:** Unit 2 (extraction verified), Unit 3 (fact store seeded with existing memory)

**Files:**

- Reference: `src/hooks/bundled/memgine-context/handler.ts`
- Reference: `src/agents/bootstrap-hooks.ts`
- Reference: `memgine/convex/engine.ts`

**Approach:**

- Start a new agent session (e.g., send a message after gateway restart, or trigger `/new`)
- Check gateway logs for memgine-context hook firing on `agent:bootstrap`
- Verify the system prompt contains memgine-assembled context (not raw MEMORY.md content)
- Verify identity files (SOUL.md, AGENTS.md, USER.md, TOOLS.md) are still present in bootstrap

**Patterns to follow:**

- The context hook logs `[memgine-context] assembled context: N facts, M tokens`
- Virtual bootstrap file has path `[memgine:virtual]` and content starting with `# Memgine Context`

**Test scenarios:**

- Happy path: New session -> memgine-context fires -> system prompt includes `# Memgine Context` section with fact-based content, MEMORY.md absent from bootstrap files
- Happy path: Identity files (SOUL.md, AGENTS.md, USER.md, TOOLS.md) still present alongside memgine context (R4)
- Happy path: Subagent session -> only Layer 1-2 facts included (restricted access)
- Error path: Convex unreachable -> context hook logs warning, falls back to MEMORY.md from disk

**Verification:**

- Agent responds with awareness of recently extracted facts
- System prompt inspection shows memgine virtual file, not raw MEMORY.md

---

- [ ] **Unit 5: Migrate session-memory hook to forward to memgine**

**Goal:** Modify the session-memory hook to POST conversation summaries to the memgine extraction endpoint instead of writing markdown files, capturing session-boundary facts.

**Requirements:** R3, R5

**Dependencies:** Unit 2 (extraction pipeline verified), Unit 4 (context assembly verified)

**Files:**

- Modify: `src/hooks/bundled/session-memory/handler.ts`
- Modify: `src/hooks/bundled/session-memory/HOOK.md`
- Test: `src/hooks/bundled/session-memory/handler.test.ts`

**Approach:**

- Keep the existing message extraction and filtering logic (reads previous session JSONL, extracts last N user/assistant messages, filters inter-session and command messages)
- Replace the markdown file writing with an HTTP POST to the Convex `/api/extract` HTTP endpoint (the same endpoint used by per-turn extraction, reusing the HTTP call pattern from `memgine-extraction/handler.ts`)
- Add `archiveToMarkdown` config option (default: `false`) that preserves the old markdown writing behavior when enabled
- Remove LLM slug generation when `archiveToMarkdown` is false (no longer needed)
- Fire-and-forget the extraction call (never block the `/new`/`/reset` command)
- Read Convex URL from config via `resolveHookConfig(context.cfg, HOOK_KEY)` with env var fallback -- command events carry `cfg` in their context (verified at `src/auto-reply/reply/commands-core.ts:63`), unlike `message:sent` events
- **Fallback on failure**: If the memgine POST fails and `archiveToMarkdown` is `false`, still write the markdown file as a safety net and log a warning. Session-boundary data represents entire conversations; silently losing it is unacceptable.

**Patterns to follow:**

- `src/hooks/bundled/memgine-extraction/handler.ts:119-157` -- HTTP POST to Convex extraction endpoint
- `src/hooks/bundled/memgine-context/handler.ts:122-140` -- `resolveHookConfig()` usage with env var fallback
- Existing message extraction logic in `src/hooks/bundled/session-memory/handler.ts:27-69`

**Test scenarios:**

- Happy path: `/new` command -> session-memory extracts last 15 messages -> POSTs to memgine `/api/extract` -> returns success, no markdown file written
- Happy path: `archiveToMarkdown: true` -> writes markdown file AND forwards to memgine
- Edge case: Empty or very short session (< 2 messages) -> skips extraction (nothing meaningful to extract)
- Edge case: Previous session JSONL file not found -> logs warning, returns without error
- Error path: Memgine endpoint unreachable -> logs warning, falls back to writing markdown file as safety net, `/new` command completes normally
- Error path: Memgine endpoint unreachable AND `archiveToMarkdown: true` -> still writes markdown (archival mode unaffected)
- Integration: Facts extracted from session summary appear in Convex `facts` table with appropriate layer/scope metadata

**Verification:**

- After `/new` with healthy Convex, no new files appear in `memory/` directory (when `archiveToMarkdown` is false)
- After `/new` with Convex down, a markdown file IS written as fallback (with warning log)
- After `/new`, new facts appear in Convex derived from the session's conversation
- Next agent session's memgine context includes facts from the previous session's summary extraction

---

- [ ] **Unit 6: End-to-end validation and cleanup**

**Goal:** Validate the full lifecycle works: message -> extraction -> /new -> session extraction -> new session -> context assembly with seeded + extracted facts.

**Requirements:** R1, R2, R3, R4, R5, R6, R7

**Dependencies:** Units 1-5

**Files:**

- Reference: all hook handler files
- Reference: `memgine/convex/engine.ts`

**Approach:**

- Run a complete lifecycle test through the fork gateway:
  1. Send several messages through a channel -> verify per-turn extraction
  2. Run `/new` -> verify session-boundary extraction fires
  3. Send a new message -> verify memgine context includes facts from both extraction paths
  4. Kill Convex connectivity -> verify graceful degradation (falls back to markdown)
  5. Restore connectivity -> verify recovery
- Confirm no regressions in channel message delivery
- Confirm identity files still load alongside memgine context

**Test expectation: none** -- this is a manual validation unit using the fork gateway.

**Verification:**

- Full message lifecycle completes without errors
- Agent demonstrates awareness of facts from prior sessions
- Degradation path works (agent still responds when Convex is down)
- No markdown memory files created during normal operation (unless `archiveToMarkdown` is on)

## Success Gate

All six of these must pass on the production gateway (not fork) before this plan is considered complete. Failures in any gate mean the system is not ready and the markdown path should remain active.

**Gate 1: Historical knowledge retained.** Start a new session with an agent that has substantial history (e.g., grace). Ask it a question only its historical memory would answer — a team member's name, a project decision, infrastructure it manages. The agent answers correctly. Inspect the bootstrap: MEMORY.md is absent from the file list; the answer came from `# Memgine Context` virtual file containing seeded facts.

**Gate 2: New knowledge accumulates.** In the same session, tell the agent a new fact it hasn't seen before (e.g., "We renamed the staging server to Neptune"). Run `/new`. Start a fresh session and ask about that fact. The agent recalls it — proving the extraction pipeline captured it and context assembly served it back.

**Gate 3: Session-boundary extraction works.** After the `/new` in Gate 2, check Convex for facts with the session-boundary agent/session metadata. At least one fact from the previous session's summary appears in the `facts` table (distinct from per-turn extracted facts, if distinguishable by timing or content).

**Gate 4: Multi-agent coverage.** Repeat Gate 1 with a second agent (e.g., dev). Confirm that agent's seeded facts are distinct from grace's — each agent has its own memory, not a shared pool.

**Gate 5: Graceful degradation.** Temporarily block Convex connectivity (e.g., wrong URL). Start a session. The agent still responds. MEMORY.md from disk appears in the bootstrap as fallback. Restore connectivity and confirm memgine resumes on the next session.

**Gate 6: No markdown leak.** After Gates 1-4 complete successfully with `archiveToMarkdown: false`, check the `memory/` directory. No new markdown files were created during normal operation (only during Gate 5's intentional degradation, if the fallback-write safety net fired).

## System-Wide Impact

- **Interaction graph:** The session-memory hook changes from a filesystem writer to an HTTP caller. This removes the dependency on writable workspace `memory/` directory but adds a dependency on Convex availability (with graceful degradation and markdown fallback on failure).
- **Error propagation:** All memgine interactions are fire-and-forget or try/catch wrapped. Failures log but never block agent responses, channel delivery, or command processing. Session-memory has an additional safety net: it falls back to writing markdown when the memgine POST fails.
- **State lifecycle risks:** If per-turn extraction fails silently for extended periods, the fact store becomes stale. Extraction logging in `extraction_log` table provides an audit trail. Gateway logs should be monitored for repeated extraction failures. Session-boundary extraction failures are more consequential (represent entire conversations) and are mitigated by the markdown fallback.
- **API surface parity:** No public API changes. The memgine hooks modify internal bootstrap behavior only.
- **Memory search tool staleness:** Once `archiveToMarkdown` defaults to `false`, the `memory/` directory stops receiving new files. The `memory_search` tool (at `src/agents/tools/memory-tool.ts`) searches `MEMORY.md` + `memory/*.md`. Its results will increasingly represent only historical data. This is an expected behavioral change; a future plan will wire memory tools to the Convex fact store.
- **WORKING.md:** The memgine-context hook filters out both MEMORY.md and WORKING.md from bootstrap. Verify whether WORKING.md is actively used on this instance during Unit 3 validation.
- **Migration data volume:** ~918 chunks from 7 agent SQLite databases seeded into Convex via direct `createBatch` mutations. This is a one-time operation. Subsequent memory accumulation happens through the extraction and session-memory hooks.
- **Unchanged invariants:** All channel delivery, routing, pairing, and command processing is unaffected. Identity files (SOUL.md, AGENTS.md, etc.) continue loading normally. The memgine-extraction hook continues to use env vars for its configuration (the `MessageSentHookContext` does not carry `cfg`). Original SQLite memory databases are not modified or deleted by the migration.

## Risks & Dependencies

| Risk                                                                                                   | Mitigation                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Convex deployment is unreachable during activation                                                     | Both hooks have graceful degradation; markdown fallback remains functional                                                                                      |
| Per-turn extraction already captures all session context, making session-boundary extraction redundant | Session-boundary extraction captures cross-turn patterns (themes, decisions, outcomes) that individual turns miss; cost is one extra extraction call per `/new` |
| Existing `memory/` markdown files become stale/orphaned                                                | Files remain readable by memory search tools; no cleanup needed now. Future plan will address tool migration                                                    |
| API key exposure in HTTP request bodies to Convex                                                      | Acceptable for private deployment (HTTPS); noted as future improvement to use Convex env vars                                                                   |

## Sources & References

- Related code: `src/hooks/bundled/memgine-context/handler.ts`, `src/hooks/bundled/memgine-extraction/handler.ts`, `src/hooks/bundled/session-memory/handler.ts`
- Related code: `src/hooks/loader.ts`, `src/hooks/config.ts`, `src/agents/bootstrap-files.ts`
- Convex backend: `memgine/convex/` (schema, engine, facts, http)
- Related commits: `3323548cc` (message:sent wiring fix), `4236c466e` (Phase 5), `095cba472` (Phase 3)
