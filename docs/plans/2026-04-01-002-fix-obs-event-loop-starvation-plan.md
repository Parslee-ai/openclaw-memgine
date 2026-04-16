---
title: "fix: Prevent openclaw-obs event loop starvation from unbatched synchronous SQLite writes"
type: fix
status: active
date: 2026-04-01
deepened: null
---

**Target repo:** openclaw-obs (`/Users/studio/projects/openclaw-obs`)

# fix: Prevent openclaw-obs event loop starvation from unbatched synchronous SQLite writes

## Overview

The openclaw-obs plugin's `EventBuffer` flush path runs N individual synchronous SQLite writes without a wrapping transaction. In WAL mode, each individual `INSERT`/`UPDATE` is an implicit single-statement transaction with its own fsync. For a batch of 50-200 events, this blocks the Node.js event loop for 100ms-2s, starving HTTP responses, WebSocket frames, and gateway I/O. The fix wraps flush batches in explicit transactions and adds defensive measures against secondary starvation vectors.

## Problem Frame

The gateway process intermittently becomes unresponsive. During these periods:

- No HTTP responses are served
- WebSocket frames are not delivered
- Log writes stall

The starvation correlates with bursts of openclaw-obs activity. The user's initial theory attributed this to `SQLITE_CONSTRAINT_FOREIGNKEY` errors causing tight retry loops. Code investigation reveals a different mechanism.

### Root Cause Analysis (Revised from Initial Theory)

The initial theory (FK constraint errors + retry loop) has three issues:

1. **FK constraints are NOT enforced.** `getDb()` in `src/plugin/db.ts:220-255` sets `journal_mode = WAL` and `busy_timeout = 5000` but never sets `PRAGMA foreign_keys = ON`. SQLite defaults to `foreign_keys = OFF`, so the `REFERENCES traces(id)` clauses in the schema are decorative — insertions with non-existent `trace_id` values succeed silently.

2. **No retry/re-queue logic exists.** `EventBuffer.flush()` (`src/plugin/buffer.ts:44-52`) catches errors and drops the batch. `flushBatch()` (`src/plugin/index.ts:93-123`) wraps each event in individual try-catch, logging errors and continuing. Failed events are permanently lost — never re-queued or retried.

3. **The actual starvation mechanism is missing transaction batching.** `flushBatch()` iterates events and calls individual `insertSpan()`, `insertMessage()`, `upsertTrace()` etc. Each is a separate SQLite write. In WAL mode without an explicit transaction, each write is an implicit single-statement transaction requiring its own journal write + fsync. For a batch of 100 events, this means ~100 fsyncs. At 1-10ms per fsync on macOS, the entire flush takes 100ms-1s of continuous event loop blocking.

### Secondary Starvation Vectors

1. **Threshold-triggered synchronous flush.** `push()` (`src/plugin/buffer.ts:37-42`) calls `this.flush()` synchronously when queue length reaches 50. This means hook handlers (which call `push()`) block while the full flush executes. A single LLM call generates 4-8 events across hooks (llm_input messages, llm_output messages + span, tool_call messages + spans), so 6-12 LLM calls trigger a synchronous flush inside a hook handler.

2. **Startup prune on main thread.** Service start (`src/plugin/index.ts:676-685`) runs `pruneOldTraces()` + `pruneBySize()` synchronously. These scan the full traces table and can process hundreds of rows with multiple UPDATE/DELETE statements, each in its own implicit transaction.

3. **Unbounded console.error per event.** Each failed event in `flushBatch()` produces a `console.error()` call. If a class of events consistently fails (e.g., updates referencing pruned spans), every event in every batch generates a separate log write.

## Requirements Trace

- R0. Flush performance must be measurable — each flush logs batch size, duration (ms), and error count so we can validate before/after
- R1. Flush batches must use a single SQLite transaction to reduce fsync cost from O(n) to O(1)
- R2. `insertSpan` must not throw on constraint violations (align with `insertMessage`'s `INSERT OR IGNORE` pattern)
- R3. Threshold-triggered flushes must not block the calling hook handler synchronously
- R4. Error logging during flushes must be rate-limited to prevent console I/O starvation
- R5. No data loss for events that would have succeeded under the current code

## Success Gate

The fix is validated when flush timing logs show:

- **Baseline (before fix):** flush of 50+ events takes >50ms (expected: 50-500ms due to per-event fsync)
- **After fix:** flush of 50+ events takes <10ms consistently (single-transaction fsync)
- **Method:** Deploy Unit 0 (timing instrumentation) first, capture baseline under normal agent activity, then deploy Units 1-4 and compare

## Scope Boundaries

- NOT changing the overall architecture (synchronous better-sqlite3, single-process, in-memory buffer)
- NOT adding async SQLite (e.g., worker threads or switching to better-sqlite3-pool)
- NOT adding FK constraint enforcement (it was never on; enabling it now would be a behavior change)
- NOT adding test infrastructure from scratch (the plugin has zero tests; adding a full test suite is a separate effort)
- NOT changing the flush interval (100ms) or threshold (50)

## Context & Research

### Relevant Code and Patterns

- `src/plugin/buffer.ts` — `EventBuffer` class: 100ms `setInterval` flush + 50-event threshold flush. Queue is FIFO via `splice(0)`. Errors caught and logged.
- `src/plugin/index.ts:93-123` — `flushBatch()`: iterates events, per-event try-catch, individual DB write calls. No transaction wrapper.
- `src/plugin/index.ts:165-213` — `getOrCreateTrace()`: pushes `"trace"` event to buffer (not direct DB write), then returns traceId. Subsequent span events reference this traceId. Both trace and span go through the buffer in FIFO order, so ordering is preserved within a single flush.
- `src/plugin/db.ts:220-255` — `getDb()`: opens better-sqlite3 with WAL + busy_timeout, runs schema + migrations. No `foreign_keys` pragma.
- `src/plugin/db.ts:266-285` — `upsertTrace()`: `INSERT ... ON CONFLICT(id) DO UPDATE` — safe against duplicates.
- `src/plugin/db.ts:298-310` — `insertMessage()`: `INSERT OR IGNORE` — safe against constraint violations.
- `src/plugin/db.ts:319-340` — `insertSpan()`: plain `INSERT` — throws on any constraint violation (duplicate ID, or FK violation if constraints were ever enabled).
- `src/plugin/db.ts:891-934` — `pruneStage3Delete()` + `pruneOldTraces()`: synchronous multi-stage prune with compress → strip → delete. Runs at startup and hourly.

### Institutional Learnings

- better-sqlite3 is synchronous by design. Transaction batching is the standard mitigation for bulk writes — wrap N statements in `db.transaction()` to get a single fsync.
- The plugin has no test suite. Changes should be defensively small and verifiable via manual testing (gateway restart + burst of agent activity).

## Key Technical Decisions

- **Transaction wrapping in flushBatch, not in individual DB functions**: Wrapping at the `flushBatch()` level batches the entire flush into one transaction. Wrapping inside `insertSpan()`/`insertMessage()` individually would not help — each call would still be its own transaction. The batch-level wrapper is the correct granularity.

- **INSERT OR IGNORE on insertSpan rather than pre-checking trace existence**: Pre-checking (`SELECT EXISTS(... WHERE id = @trace_id)`) adds a read per span insert. `INSERT OR IGNORE` is a single statement that handles all constraint types (PK, FK, UNIQUE) with no extra round-trip. This matches the existing `insertMessage` pattern.

- **setImmediate for deferred flush, not queueMicrotask**: `queueMicrotask` runs before I/O callbacks, so it wouldn't yield to pending HTTP/WebSocket work. `setImmediate` (or `setTimeout(fn, 0)`) runs after I/O callbacks, giving the event loop a chance to process pending I/O before the flush executes.

- **Error summary logging, not per-event logging**: Replace per-event `console.error` with a count-and-summarize approach. Log the error type and count at the end of each flush, not one line per failed event.

## Open Questions

### Resolved During Planning

- **Are FK constraints actually enforced?** No. `getDb()` never sets `PRAGMA foreign_keys = ON`. SQLite defaults to OFF. The `REFERENCES` clauses in the schema are not enforced at runtime.

- **Are failed events retried?** No. `flush()` splices events out of the queue before calling `flushFn`. On error, events are dropped. `flushBatch()` catches per-event errors and continues.

- **What triggers the observed error bursts?** Without FK enforcement, the most likely remaining error source is `insertSpan`'s plain `INSERT` hitting a `SQLITE_CONSTRAINT_PRIMARYKEY` on duplicate span IDs (unlikely with UUID), or `SQLITE_BUSY` from WAL contention during prune operations. The user may also be running a version that enables FK constraints via the gateway or plugin-sdk (needs production verification).

### Deferred to Implementation

- **What is the actual error type in production logs?** The user reports "SQLITE_CONSTRAINT_FOREIGNKEY" but the code doesn't enable FK enforcement. Implementation should add a diagnostic log of the exact SQLite error code on first error per flush to confirm the error type.

- **How large are typical flush batches?** Depends on agent activity patterns. The 50-event threshold and 100ms interval bound this, but burst activity could produce larger effective batches if the interval timer fires while many events are queued.

## Implementation Units

- [ ] **Unit 0: Add flush timing instrumentation**

**Goal:** Establish a measurable baseline for flush performance so we can validate the fix with before/after data.

**Requirements:** R0

**Dependencies:** None — deploy this FIRST, before any other units

**Files:**

- Modify: `src/plugin/index.ts`

**Approach:**

- Add timing around the `flushBatch()` call inside `EventBuffer.flush()` — but since `flush()` is in `buffer.ts` and calls `this.flushFn(batch)`, the cleanest place is inside `flushBatch()` itself in `index.ts`
- At the top of `flushBatch()`, capture `const start = performance.now()` (or `Date.now()` for simplicity)
- At the bottom, compute `const ms = performance.now() - start`
- Log: `console.log(\`[openclaw-obs] flush: ${events.length} events, ${ms.toFixed(1)}ms, ${errorCount} errors\`)`
- Only log when `events.length > 0` (skip empty flushes)
- For batches > 20 events OR duration > 50ms, log at `warn` level to make starvation-risk flushes visible

**Patterns to follow:**

- Keep the log format parseable — fixed prefix, key=value style — so it can be grepped from gateway logs

**Test scenarios:**

- Happy path: Flush 10 events → log line shows "10 events, Xms, 0 errors"
- Happy path: Flush 0 events → no log line emitted
- Edge case: Flush 50+ events → log at warn level with batch size and duration
- Edge case: Flush with errors → error count reflected in log line

**Verification:**

- Run gateway with active agents, grep logs for `[openclaw-obs] flush:`, confirm batch sizes and durations are logged
- Baseline capture: record typical flush durations for 50-event batches before applying Units 1-4

---

- [ ] **Unit 1: Wrap flushBatch in explicit SQLite transaction**

**Goal:** Reduce flush time from O(n _ fsync) to O(1 _ fsync) by batching all writes in a single transaction.

**Requirements:** R1, R5

**Dependencies:** None

**Files:**

- Modify: `src/plugin/index.ts`
- Modify: `src/plugin/db.ts` (`getDb` is already exported; no changes needed here unless refactoring)

**Approach:**

- Add `getDb` to the existing import statement in `index.ts` (lines 3-12) — it is exported from `db.ts` but not yet imported
- Wrap the for-loop body of `flushBatch()` in `getDb().transaction(() => { ... })()`
- Keep the per-event try-catch INSIDE the transaction so individual failures don't roll back the entire batch
- better-sqlite3's `transaction()` returns a function; the inner try-catches prevent individual errors from propagating and rolling back the transaction

**Patterns to follow:**

- `pruneStage3Delete()` at `src/plugin/db.ts:909` already uses `d.transaction(() => { ... })` for batched deletes — follow this pattern

**Test scenarios:**

- Happy path: Flush a batch of 10 events (mix of trace, span, message) → all committed in a single transaction, all retrievable from DB
- Happy path: Flush empty batch → no transaction started, no-op
- Error path: One event in the batch has invalid data → that event's error is caught and logged, remaining events still committed
- Edge case: Flush during concurrent prune (busy_timeout) → transaction completes or retries via busy_timeout pragma

**Verification:**

- Gateway restart with active agents produces no event loop starvation
- `sqlite3 traces.db "PRAGMA journal_mode"` confirms WAL mode
- Manual test: trigger burst of 100+ events (rapid tool calls) and confirm HTTP endpoints remain responsive during flush

---

- [ ] **Unit 2: Make insertSpan defensive with INSERT OR IGNORE**

**Goal:** Prevent `insertSpan` from throwing on any constraint violation, aligning with `insertMessage`'s existing pattern.

**Requirements:** R2

**Dependencies:** None (can be done in parallel with Unit 1)

**Files:**

- Modify: `src/plugin/db.ts`

**Approach:**

- Change `INSERT INTO spans` to `INSERT OR IGNORE INTO spans` at line 322
- This handles: duplicate PK (span ID collision), FK violations (if constraints are ever enabled), any other constraint

**Patterns to follow:**

- `insertMessage()` at `src/plugin/db.ts:301` already uses `INSERT OR IGNORE`

**Test scenarios:**

- Happy path: Insert a span with valid trace_id → succeeds as before
- Edge case: Insert a span with duplicate ID → silently ignored, no error thrown
- Edge case: Insert a span with non-existent trace_id (if FK constraints were enabled) → silently ignored

**Verification:**

- No `[openclaw-obs] Write error:` log lines for span inserts during normal operation
- Existing spans are not overwritten by duplicates (INSERT OR IGNORE skips, doesn't update)

---

- [ ] **Unit 3: Defer threshold-triggered flush to yield to I/O**

**Goal:** Prevent `push()` from blocking hook handlers with synchronous DB writes when the threshold is reached.

**Requirements:** R3

**Dependencies:** None (can be done in parallel with Units 1-2)

**Files:**

- Modify: `src/plugin/buffer.ts`

**Approach:**

- Add a `private pendingFlush = false` flag to `EventBuffer`
- When threshold is reached in `push()`, instead of calling `this.flush()` directly, check `!this.pendingFlush` and then set it to `true` and call `setImmediate(() => { this.pendingFlush = false; this.flush(); })`
- The interval timer flush remains synchronous (it fires on the event loop anyway, so deferring it gains nothing)
- `stop()` should still call `flush()` synchronously to ensure all events are written before shutdown

**Patterns to follow:**

- The existing `timer.unref()` pattern shows awareness of process lifecycle. Note: `setImmediate` returns an `Immediate` object which does NOT block process exit in Node.js (unlike `Timeout`/`Interval` objects), so no `.unref()` call is needed for the deferred flush

**Test scenarios:**

- Happy path: Push 50 events rapidly → flush is deferred, events are written on next I/O cycle, not inside the push call
- Happy path: Push 49 events → no deferred flush triggered, events wait for interval timer
- Edge case: Push 100 events rapidly (2x threshold) → only one deferred flush is scheduled (pendingFlush flag prevents double-scheduling), all 100 events flushed together
- Edge case: `stop()` called while deferred flush is pending → `stop()` flushes synchronously, all events written
- Integration: Hook handler pushes events that hit threshold → hook handler returns without blocking, flush happens after I/O cycle

**Verification:**

- Hook handler execution time does not include DB write time
- Events are still written within ~1-2ms of threshold being reached (setImmediate latency)

---

- [ ] **Unit 4: Rate-limit error logging in flushBatch**

**Goal:** Prevent console.error flooding when a class of events consistently fails.

**Requirements:** R4

**Dependencies:** Unit 0 (timing instrumentation provides the errorCount variable), Unit 1 (transaction wrapping changes the error handling flow)

**Files:**

- Modify: `src/plugin/index.ts`

**Approach:**

- Replace per-event `console.error("[openclaw-obs] Write error:", err)` with error counting
- Track `errorCount` and `firstError` during the flush loop (these feed into Unit 0's timing log line)
- The per-flush summary is already handled by Unit 0's log: `flush: N events, Xms, Y errors`
- When `errorCount > 0`, log ONE additional line with the first error's message and stack trace for debugging
- This reduces worst-case log output from N lines per flush to 2 lines (timing summary + first error detail)

**Patterns to follow:**

- The startup prune error handler at `src/plugin/index.ts:683-685` uses a single catch-and-log pattern

**Test scenarios:**

- Happy path: Flush with no errors → no error log output
- Error path: 1 error in batch → full error logged (with stack) + summary "1 write error(s)"
- Error path: 50 errors in batch → full first error logged + summary "50 write error(s)", NOT 50 individual error lines
- Edge case: Mix of different error types in same batch → first error gets full output, summary includes total count

**Verification:**

- During error bursts, log output is bounded to 2 lines per flush regardless of batch size
- First error per flush includes enough detail for debugging (error message + stack)

## System-Wide Impact

- **Interaction graph:** The `EventBuffer` is the central write path for ALL observability data. All hooks (`session_start`, `llm_input`, `llm_output`, `before_tool_call`, `after_tool_call`, `subagent_spawned`, `subagent_ended`) and the diagnostic event listener funnel through `buffer.push()` → `flush()` → `flushBatch()`. The transaction wrapping affects every write.

- **Error propagation:** Currently, errors in individual inserts are caught per-event and logged. After the fix, this behavior is preserved — the transaction wrapper does not change error propagation because inner try-catches prevent errors from bubbling to the transaction boundary. The transaction commits whatever succeeded.

- **State lifecycle risks:** The deferred flush (Unit 3) introduces a brief window where events are in the queue but not yet written. If the process crashes between `push()` and the deferred `flush()`, those events are lost. This is acceptable — the current interval-based flush already has this characteristic (events wait up to 100ms), and the plugin is designed for best-effort observability, not durable event sourcing.

- **API surface parity:** No external API changes. The dashboard read queries are unaffected.

- **Unchanged invariants:** The flush interval (100ms), threshold (50), FIFO event ordering, and best-effort write semantics are all preserved. The DB schema is not modified.

## Risks & Dependencies

| Risk                                                                                                          | Mitigation                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transaction wrapping changes error semantics — a thrown error inside `db.transaction()` rolls back everything | Per-event try-catch is INSIDE the transaction, so individual failures don't propagate. Only an unexpected error outside the try-catch (e.g., `getDb()` failure) would roll back. |
| `setImmediate` not available in all environments                                                              | Node.js 22+ (the project baseline) supports `setImmediate`. Bun also supports it.                                                                                                |
| Deferred flush loses events on process crash                                                                  | Acceptable — existing interval flush already has this characteristic. Plugin is best-effort.                                                                                     |
| `INSERT OR IGNORE` silently drops data on constraint violations                                               | This is intentional and matches `insertMessage`'s existing pattern. Duplicate/orphaned spans are not useful data.                                                                |

## Sources & References

- Related code: `src/plugin/buffer.ts` (EventBuffer), `src/plugin/index.ts` (flushBatch, hooks), `src/plugin/db.ts` (SQLite schema, write operations)
- better-sqlite3 transaction docs: transactions batch multiple statements into a single fsync
- SQLite WAL mode: each implicit transaction (single statement without BEGIN/COMMIT) requires its own journal write
