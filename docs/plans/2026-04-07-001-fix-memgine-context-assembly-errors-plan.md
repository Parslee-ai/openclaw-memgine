---
title: "fix: Resolve memgine context assembly errors"
type: fix
status: completed
date: 2026-04-07
---

# fix: Resolve memgine context assembly errors

## Overview

The memgine context hook fires on every `agent:bootstrap` event and is failing 100% of the time with `TypeError: Cannot read properties of undefined (reading 'context')`. The extraction hook is also failing with 404 errors. These errors are non-blocking (the gateway degrades gracefully), but they mean no agent gets memgine context injected and no facts are extracted from conversations.

## Problem Frame

After investigating the live error, the root cause is a **Convex array length limit overflow**. The `facts.listActive` query in `memgine/convex/engine.ts:68` returns all active facts (currently 8404), which exceeds Convex's built-in array length limit of 8192. The Convex action returns `{ status: "error", errorMessage: "..." }` with HTTP 200, so the client-side code in `memgine-context/handler.ts:112` reads `result.value` as `undefined` (error responses have no `value` field), and the subsequent access to `.context` throws the TypeError.

The extraction 404 errors are a separate issue — the Convex deployment at `grand-coyote-108.convex.site` may not have all HTTP routes deployed, or the extraction endpoint rejects empty/malformed payloads.

## Requirements Trace

- R1. Context assembly must not crash when the facts table exceeds Convex limits
- R2. The client-side hook must handle Convex error responses (HTTP 200 with `status: "error"`) gracefully
- R3. The Convex `listActive` query should not attempt to return unbounded result sets
- R4. Extraction errors should be clearly logged with actionable information

## Scope Boundaries

- Not migrating away from Convex or redesigning the memgine architecture
- Not changing the 4-layer fact assembly model
- Not addressing the obs plugin SQLite FK errors (separate issue)
- Not addressing the stale HOOK.md documentation (low priority)

## Context & Research

### Relevant Code and Patterns

- `src/hooks/bundled/memgine-context/handler.ts` — client-side context assembly hook
- `src/hooks/bundled/memgine-extraction/handler.ts` — client-side extraction hook
- `memgine/convex/engine.ts` — server-side `assembleContext` action
- `memgine/convex/facts.ts` — `listActive` query (the source of the overflow)
- `memgine/convex/schema.ts` — fact table schema and indexes

### Root Cause Evidence

```
$ curl -s 'https://grand-coyote-108.convex.cloud/api/action' \
  -X POST -H 'Content-Type: application/json' \
  -d '{"path":"engine:assembleContext","args":{"queryEmbedding":[],"agentId":"test","sessionType":"main"},"format":"json"}'

{"status":"error","errorMessage":"...Array length is too long (8404 > maximum length 8192)..."}
```

The response is HTTP 200 but `status: "error"` — no `value` field exists.

## Key Technical Decisions

- **Paginate `listActive` server-side rather than raising the limit**: Convex's 8192 limit is a platform constraint we can't change. The `assembleContext` action should query per-layer instead of fetching all facts at once. Each layer will have far fewer than 8192 facts. This is also more efficient since the engine already groups by layer.
- **Add client-side error response handling**: Even after fixing the server side, the client should handle `{ status: "error" }` responses gracefully rather than assuming `value` always exists. Defense in depth.
- **Log the Convex error message when present**: The error response includes `errorMessage` which is useful for debugging. Currently it's lost.

## Open Questions

### Resolved During Planning

- **Is the `.cloud/api/action` URL correct?** Yes — tested live, it returns HTTP 200. Convex serves the action dispatcher on `.cloud` domains. The 404 errors from April 1 were likely a transient deployment issue or a different slug.
- **Why 8404 active facts?** The extraction pipeline has been running since Phase 3 activation, extracting facts from every `message:sent` event. Without deduplication or TTL, the facts table grew past the Convex limit.

### Deferred to Implementation

- **Should old facts be garbage-collected?** Likely yes, but that's a separate feature. For now, the per-layer query approach avoids the limit.
- **Exact Convex query API for per-layer pagination**: Implementation will determine the optimal query pattern.

## Implementation Units

- [ ] **Unit 1: Fix Convex `assembleContext` to query per-layer**

  **Goal:** Eliminate the array length overflow by querying facts per-layer instead of fetching all active facts at once.

  **Requirements:** R1, R3

  **Dependencies:** None

  **Files:**
  - Modify: `memgine/convex/engine.ts`
  - Modify: `memgine/convex/facts.ts` (add per-layer query if needed)

  **Approach:**
  - Replace the single `listActive({})` call at line 68 with four per-layer calls: `listActive({ layer: 1 })`, `listActive({ layer: 2 })`, etc.
  - The `by_layer` index already exists in the schema and `listActive` already supports the `layer` parameter — this is a one-line-per-layer change in `engine.ts`.
  - Each layer will have well under 8192 facts, avoiding the Convex limit.
  - Preserve the existing filtering, scoring, and budget logic — just change how facts are fetched.

  **Patterns to follow:**
  - The existing `listActive` query already supports `layer` filtering via `by_layer` index (`facts.ts:15-20`)

  **Test scenarios:**
  - Happy path: `assembleContext` returns context when total active facts exceed 8192 but each layer is under 8192
  - Happy path: `assembleContext` returns correct per-layer grouping matching current behavior when facts are under the limit
  - Edge case: A single layer with 0 facts produces no section for that layer (existing behavior preserved)

  **Verification:**
  - `curl` the `/api/action` endpoint with the same test payload that currently returns the overflow error — should now return valid context

- [ ] **Unit 2: Add client-side error response handling in context hook**

  **Goal:** Handle Convex `{ status: "error" }` responses gracefully instead of crashing on `undefined.context`.

  **Requirements:** R2

  **Dependencies:** None (can be done in parallel with Unit 1)

  **Files:**
  - Modify: `src/hooks/bundled/memgine-context/handler.ts`
  - Test: `src/hooks/bundled/memgine-context/handler.test.ts`

  **Approach:**
  - In `callMemgineAssemble` (line 112-113), check for `status: "error"` in the JSON response before accessing `.value`
  - If `status === "error"`, throw an error that includes the `errorMessage` field so it surfaces in the catch block's logging
  - This is defense-in-depth — Unit 1 fixes the root cause, this prevents the same class of bug from producing a confusing TypeError

  **Patterns to follow:**
  - The extraction hook already has clear error logging with status code and error text (`handler.ts:147`)

  **Test scenarios:**
  - Error path: Convex returns `{ status: "error", errorMessage: "..." }` with HTTP 200 — hook logs the error message and returns without crashing
  - Error path: Convex returns `{ value: null }` — hook handles gracefully
  - Happy path: Convex returns `{ value: { context: "...", stats: {...} } }` — works as before
  - Edge case: Convex returns `{ value: { context: "", stats: {...} } }` — skips injection (existing behavior at line 159)

  **Verification:**
  - Gateway error log shows descriptive error messages instead of `TypeError: Cannot read properties of undefined`

- [ ] **Unit 3: Improve extraction hook error logging**

  **Goal:** Make extraction 404 errors actionable by logging the URL being called.

  **Requirements:** R4

  **Dependencies:** None

  **Files:**
  - Modify: `src/hooks/bundled/memgine-extraction/handler.ts`

  **Approach:**
  - In `triggerExtraction` (line 146-148), include the URL in the error message so operators can tell which Convex deployment is being targeted
  - This is a one-line change to the error template

  **Patterns to follow:**
  - Context hook's error at line 109 already includes status and response text

  **Test scenarios:**
  - Error path: extraction endpoint returns 404 — log message includes the full URL that was called

  **Verification:**
  - Gateway error log shows `Extraction API error: 404  (url: https://grand-coyote-108.convex.site/api/extract)` instead of bare `Extraction API error: 404`

## System-Wide Impact

- **Interaction graph:** The memgine-context hook fires on every `agent:bootstrap` event. Fixing it means all agent sessions will start receiving memgine context again, which increases bootstrap payload size and may affect token usage.
- **Error propagation:** Both hooks already have try/catch with graceful degradation — errors log but don't block the gateway. This plan preserves that pattern.
- **State lifecycle risks:** None — we're not changing the fact store schema or write path.
- **Unchanged invariants:** The 4-layer assembly model, token budgets, visibility filtering, and vector search scoring all remain identical.

## Risks & Dependencies

| Risk                                            | Mitigation                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Per-layer queries increase Convex read units    | Each `listActive({ layer: N })` uses the `by_layer` index, so reads are indexed and efficient. Total data read is the same. |
| Convex deployment needs redeployment for Unit 1 | `npx convex deploy` from `memgine/` directory. Verify with the same curl test.                                              |
| Facts table continues growing unboundedly       | Out of scope for this fix, but worth tracking. A future GC/TTL mechanism should be planned.                                 |

## Sources & References

- Live error: `~/.openclaw/logs/gateway.err.log` — `TypeError: Cannot read properties of undefined (reading 'context')`
- Convex array limit: platform constraint at 8192 elements per query result
- Related commit: `5f38128d0` — activated end-to-end memgine pipeline
