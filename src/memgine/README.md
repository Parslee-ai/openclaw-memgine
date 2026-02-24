# Memgine — Core Engine

Deterministic memory engine for OpenClaw. Replaces flat-file memory (MEMORY.md, WORKING.md) with a structured fact store, query-relevant context assembly, and engine-level filtering.

## Architecture

```
User message arrives
  → Gateway resolves agent, session, workspace
  → agent:bootstrap hook fires
    → ContextAssembler.assembleContext()
      → MemgineClient fetches active facts from Convex
      → Filter by visibility, scope, session type
      → Score by relevance (recency fallback in Phase 2, vector search in Phase 3)
      → Group by layer, apply per-layer token budgets
      → Sort: most relevant LAST (recency bias exploitation)
      → Render into text with attribution
    → Inject as synthetic MEMGINE_CONTEXT.md bootstrap file
  → Rest of OpenClaw pipeline continues normally
```

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Entry point — `registerMemgineHooks()` |
| `config.ts` | Configuration types and helpers |
| `types.ts` | Shared types (Fact, ScoredFact, SessionType) |
| `client.ts` | HTTP client for Convex Memgine deployment |
| `context-assembler.ts` | Core engine — fetches, filters, scores, budgets, renders |
| `budget.ts` | Token budget manager with simple drop compaction |
| `bootstrap-hook.ts` | agent:bootstrap hook integration |

## Configuration

Add to your OpenClaw config (YAML):

```yaml
memgine:
  enabled: true
  convexUrl: "https://your-deployment.convex.cloud"
  layerBudgets:
    identity: 2000
    persistent: 8000
    workingSet: 4000
    signals: 2000
```

## Four Layers

| Layer | Name | Compaction |
|-------|------|------------|
| 1 | Identity & Role | Never compacts |
| 2 | Persistent Facts | Conservative — drops lowest-relevance |
| 3 | Working Set | Aggressive |
| 4 | Environmental Signals | Most aggressive |

## Phase 2 Scope

- ✅ Immutable fact store with supersession chains (via Convex schema from Phase 1)
- ✅ Per-layer token budgets with simple drop compaction
- ✅ Engine-level filtering (visibility, scope, session type)
- ✅ `agent:bootstrap` hook integration
- ⏳ Query-relevance scoring via vector search (uses recency fallback; Phase 3 adds embeddings)
