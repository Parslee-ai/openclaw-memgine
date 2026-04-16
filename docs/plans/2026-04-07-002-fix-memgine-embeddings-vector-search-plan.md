---
title: "fix: Resolve memgine embeddings vectorSearch type error"
type: fix
status: completed
date: 2026-04-07
---

# fix: Resolve memgine embeddings vectorSearch type error

## Overview

The `searchByVector` action in `memgine/convex/embeddings.ts` accesses `r.factId` on vector search results, but Convex's `vectorSearch` returns only `{ _id, _score }` — it does not include document fields. This causes a TypeScript error and means the relevance scoring in `engine.ts` gets `undefined` factIds, breaking the score map lookup.

## Problem Frame

```
convex/embeddings.ts(40,17): error TS2339: Property 'factId' does not exist on type
  '{ _id: Id<"fact_embeddings">; _score: number; }'.
```

Convex `vectorSearch` returns document IDs and scores, not full documents. To get `factId`, you must fetch the document by `_id`. This is the documented Convex pattern for vector search: search → get IDs → fetch documents.

## Requirements Trace

- R1. `searchByVector` must return `factId` and `score` pairs that `engine.ts` can use for relevance scoring
- R2. The TypeScript types must be correct (no `TS2339`)

## Scope Boundaries

- Not changing the vector search dimensions, index, or embedding model
- Not changing how `engine.ts` consumes the results

## Key Technical Decisions

- **Fetch documents by `_id` after vector search**: This is the standard Convex pattern. Each vector search result has `_id` which can be used with `ctx.runQuery` or `ctx.db.get` to fetch the full `fact_embeddings` document containing `factId`.
- **Use `ctx.runQuery` from action context**: Since `searchByVector` is an `action` (not a `query`), direct `ctx.db` access isn't available. Use `ctx.runQuery` with an internal query, or restructure to fetch via the existing `by_factId` index. Actually — the simpler approach is to just use `ctx.runQuery` with an inline helper or fetch each doc. But the cleanest Convex pattern for actions is to call a query that fetches by IDs.

## Implementation Units

- [ ] **Unit 1: Fix `searchByVector` to resolve factIds from vector search results**

  **Goal:** After vector search returns `_id` + `_score` pairs, fetch the corresponding `fact_embeddings` documents to extract `factId`.

  **Requirements:** R1, R2

  **Dependencies:** None

  **Files:**
  - Modify: `memgine/convex/embeddings.ts`

  **Approach:**
  - Add an internal query `getByIds` that takes an array of document IDs and returns the corresponding `fact_embeddings` documents
  - In `searchByVector`, after getting vector results, call the internal query to fetch documents, then zip factIds with scores
  - Alternatively, since Convex actions can call queries via `ctx.runQuery`, add a simple `getById` query and batch the lookups

  **Patterns to follow:**
  - Convex docs pattern: vector search → fetch docs → combine with scores
  - `facts.ts:getByFactId` for query-by-id pattern

  **Test scenarios:**
  - Happy path: vector search returns results with valid factIds and scores
  - Edge case: vector search returns 0 results — returns empty array
  - Edge case: a `fact_embeddings` document was deleted between search and fetch — skip that result gracefully

  **Verification:**
  - `npx tsc --noEmit` in `memgine/` passes without the `TS2339` error
  - `assembleContext` curl test returns relevance-scored results

## Risks & Dependencies

| Risk                                     | Mitigation                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Extra query round-trip per vector search | The `getByIds` query is indexed by `_id` (primary key) so it's fast. Typical result set is 64-256 docs. |
| Needs Convex redeployment                | Bundle with the engine.ts per-layer query fix from the previous plan. Single deploy.                    |
