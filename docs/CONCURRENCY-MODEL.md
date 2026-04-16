# Concurrency Model — PicnicHealth Cascade Engine

> **Audience:** Engineers (Seb) maintaining or migrating the engine, and semi-technical PMs (Meg) understanding how concurrent edits are handled.
>
> **Last updated:** 2026-04-15

## Overview

The cascade engine processes Notion webhook automations on a single Node.js server (Railway). All concurrency control is **in-memory** — there is no external queue (Redis, SQS, etc.). This works because Railway runs a single replica by default.

⚠️ **Multi-replica warning:** If the engine is deployed with multiple replicas (e.g., on PicnicHealth's own infrastructure), every mechanism described below breaks — per-study queues, undo entries, debounce timers, and flight tracking are all per-process. Migration to multi-replica requires Redis-backed queues and distributed locks. See [Section 4](#4-multi-replica-migration-warning) for details.

---

## 1. Mechanisms

### 1.1 CascadeQueue — Per-Task Debounce + Per-Study FIFO

**File:** `src/services/cascade-queue.js`
**Used by:** `date-cascade`, `undo-cascade`

Two-level locking:

**Level 1 — Per-task debounce (5 seconds):**
When a webhook arrives for a task, a 5-second timer starts (configurable via `CASCADE_DEBOUNCE_MS`). If another webhook arrives for the *same task* within the window:
- If `editedByBot` is true (echo from the engine itself): webhook is silently dropped
- If `editedByBot` is false (real user edit): the timer resets and the payload is replaced with the newer one

After the debounce fires, the payload is enqueued to the study's FIFO queue.

**Level 2 — Per-study FIFO queue:**
Each study has its own queue (`Map<studyId, { running, queue[] }>`). Cascades for the same study are serialized — the second cascade waits until the first finishes, then re-queries the full task graph (so it sees the first cascade's results). Different studies are fully concurrent.

### 1.2 FlightTracker — Fire-and-Forget with Graceful Shutdown

**File:** `src/services/flight-tracker.js`
**Used by:** `inception`, `add-task-set`, `deletion`, `status-rollup`, `copy-blocks`

Tracks in-flight async operations via a Set of Promises. Unlike CascadeQueue, FlightTracker does NOT serialize — operations run concurrently. Its purpose is to enable graceful shutdown: when the server receives SIGTERM, it waits for all tracked operations to complete (with an 8-second timeout) before exiting.

### 1.3 Import Mode — Study-Level Circuit Breaker

**Property:** `Import Mode` checkbox on the Studies database page
**Set by:** `inception`, `add-task-set`, `undo-cascade` (Notion button automations set it ON before the webhook fires; the route disables it after processing)
**Checked by:** `date-cascade` (skips with `import_mode_skip` reason), `status-rollup` (early return)

Import Mode prevents cascade webhooks from firing real cascades while a multi-step automation (like inception or add-task-set) is modifying tasks. Without it, each new task's date would trigger a cascade webhook, causing a flood of unnecessary work.

**Lifecycle:**
1. Notion button automation sets `Import Mode = true` on the study page
2. Webhook fires to the engine
3. Route enables Import Mode again (idempotent confirm)
4. Route performs bulk work (create tasks, wire relations, etc.)
5. Route disables Import Mode in a `finally` block (ensures cleanup even on errors)
6. Startup sweep (`src/index.js`) clears any stuck Import Mode entries from prior crashes

### 1.4 LMBS (Last Modified By System) — Echo Prevention

**Property:** `Last Modified By System` checkbox on each task page
**Pattern:** Set `LMBS = true` before writing dates → write dates → clear `LMBS = false`

When the engine patches a task's dates, Notion fires a "When Dates changes" webhook. Without LMBS, this would trigger an infinite cascade loop. The engine detects echoes by checking if the webhook's `editedByBot` flag is true (the last editor was a bot/integration, not a person).

LMBS is set per-task during the cascade's patch phase and cleared afterward. The 3-second sleep between LMBS set and patch has been eliminated — the debounce + editedByBot detection handles echo prevention.

### 1.5 withStudyLock — Add-Task-Set Serialization

**File:** `src/routes/add-task-set.js` (function `withStudyLock`)
**Used by:** `add-task-set` only

A lightweight per-study Promise chain that serializes concurrent add-task-set operations. When two "Add TLF" button clicks fire for the same study within seconds, the second waits for the first to complete before running.

This is separate from CascadeQueue because add-task-set doesn't need debounce — it's a fire-once button click, not a stream of date-change webhooks.

### 1.6 Graceful Shutdown

**File:** `src/index.js`

On SIGTERM or SIGINT:
1. Stop accepting new HTTP requests
2. Clear all debounce timers in CascadeQueue
3. Wait for CascadeQueue to drain (finish in-flight cascades)
4. Wait for FlightTracker to drain (finish in-flight button operations, 8s timeout)
5. Exit

On startup:
- Import Mode sweep: queries all studies, disables Import Mode on any that have it stuck ON (from prior crashes where the `finally` block didn't execute — e.g., OOM, SIGKILL).

---

## 2. Route Dispatch Matrix

| Route | Dispatch | Import Mode | LMBS Check | Serialization |
|---|---|---|---|---|
| `/webhook/date-cascade` | CascadeQueue | Disables (finally) | ✓ editedByBot | Per-study FIFO |
| `/webhook/undo-cascade` | CascadeQueue | Disables (3 paths) | ✓ editedByBot | Per-study FIFO |
| `/webhook/status-rollup` | FlightTracker | Checks (early return if ON) | ✓ editedByBot | None |
| `/webhook/inception` | FlightTracker | Enables → Disables | ✓ editedByBot | Import Mode blocks cascades |
| `/webhook/add-task-set` | FlightTracker + withStudyLock | Enables → Disables | ✓ editedByBot | Per-study Promise chain |
| `/webhook/deletion` | FlightTracker | — | ✓ editedByBot | None |
| `/webhook/copy-blocks` | FlightTracker | — | — | None |

**Two dispatch families:**
- **CascadeQueue** routes (date-cascade, undo-cascade): debounce → per-study FIFO → process. These handle the high-frequency date-change webhook stream.
- **FlightTracker** routes (everything else): fire-and-forget, tracked for graceful shutdown. These handle button clicks (inception, add-task-set, deletion) and status changes.

Import Mode bridges the two: button routes enable it, which causes CascadeQueue routes to skip.

---

## 3. Scenario Matrix

### Same-Study Scenarios

| Scenario | What Happens |
|---|---|
| **PM edits task A, then edits task B in the same study before A's cascade finishes** | B's webhook enters debounce (5s). After A's cascade completes and drains from the per-study queue, B's debounced payload fires and queues. B's cascade re-queries the full task graph (sees A's results). |
| **PM edits task A, Cmd+Z within 5 seconds** | Debounce replaces A's original payload with the reverted payload. When the 5s timer fires, the engine compares new dates to reference dates → zero delta → cascade skips entirely. |
| **PM edits task A, Cmd+Z after 5 seconds (cascade already started)** | A's cascade has already fired. The Cmd+Z triggers a NEW webhook which enters debounce. When it fires, it queues behind the in-flight cascade. The second "cascade" either (a) detects zero delta and skips, or (b) the PM clicks "Undo Last Automation" button. |
| **PM A and PM B edit different tasks in the SAME study simultaneously** | Both webhooks enter debounce (different task IDs, independent timers). Both fire after 5s. Per-study FIFO serializes them: PM A's cascade runs first, PM B's cascade runs second (re-querying the graph after A's changes). |
| **PM clicks add-task-set during an active date cascade** | Import Mode is already OFF (cascade doesn't set it). The button automation sets Import Mode ON before firing the webhook. Any concurrent cascades in the queue will see Import Mode ON and skip. After add-task-set completes and disables Import Mode, queued cascades resume normally. |
| **PM clicks add-task-set twice rapidly on the same study** | `withStudyLock` serializes: second click waits for the first to finish. Both use Import Mode. No duplicate tasks because the second operation re-queries after the first completes. |
| **PM clicks Undo Last Automation during an active cascade** | Undo webhook enters CascadeQueue (same queue as date-cascade). It waits for the in-flight cascade to finish, then runs. The undo restores pre-cascade dates. |
| **PM clicks Undo Last Automation when no cascade has occurred** | Undo store is empty for this study. Route returns "No recent automation to undo" via Automation Reporting property. No date changes. |

### Cross-Study Scenarios

| Scenario | What Happens |
|---|---|
| **PM A edits Study 1, PM B edits Study 2 simultaneously** | Fully concurrent. Different study IDs → different queues. No interaction. |
| **3 PMs click add-task-set on 3 different studies simultaneously** | Fully concurrent. Each study has its own `withStudyLock`. Import Mode is per-study. No cross-study blocking. |
| **PM edits Study 1, triggering a cascade that takes 30 seconds. Another PM tries inception on Study 2.** | No interaction. Inception on Study 2 runs immediately and concurrently with Study 1's cascade. |

### Deployment Scenarios

| Scenario | What Happens |
|---|---|
| **Railway deploys a new version while a cascade is in-flight** | SIGTERM received → graceful shutdown initiates → CascadeQueue drains (finishes the in-flight cascade) → FlightTracker drains (8s timeout) → process exits → new container starts → import-mode sweep clears any stuck Import Mode. |
| **Server crashes (OOM / SIGKILL) mid-cascade** | No graceful shutdown. Import Mode may be stuck ON for the affected study. LMBS may be stuck ON for affected tasks. Undo store entries lost. On next startup: import-mode sweep clears stuck Import Mode. LMBS stuck tasks will have their next user edit treated as a real edit (LMBS cleared by the cascade's cleanup pass). |
| **Notion webhook arrives while Import Mode is ON (from an in-flight automation)** | `date-cascade`: skips with `import_mode_skip` reason (zero API cost — checked from webhook payload rollup). `status-rollup`: early return. Button routes: Import Mode already ON, enable is idempotent. |

---

## 4. Multi-Replica Migration Warning

**Current assumption:** Single Railway instance. All in-memory state is process-local.

**What breaks under multiple replicas:**

| Mechanism | Why it breaks |
|---|---|
| CascadeQueue per-study FIFO | Two replicas could process cascades for the same study concurrently — no serialization across processes |
| UndoStore per-study entries | Undo saved on replica A is invisible to replica B — PM's undo request hits the wrong replica |
| withStudyLock Promise chain | Same-study add-task-set clicks routed to different replicas run concurrently |
| FlightTracker graceful shutdown | Each replica only drains its own in-flight work |
| Debounce timers | Two webhooks for the same task routed to different replicas both fire — no deduplication |

**Migration path (when Seb moves to PicnicHealth infrastructure):**
- Replace in-memory Maps with Redis (or similar): per-study locks, debounce state, undo manifests
- Use a distributed queue (Bull, BullMQ, or cloud-native) for per-study FIFO serialization
- Sticky sessions (route all webhooks for a study to the same replica) is a simpler but less resilient alternative
- Import Mode is already external (Notion property), so it works across replicas as-is
- LMBS echo detection via `editedByBot` is stateless — works across replicas as-is

---

## Sources

- `src/services/cascade-queue.js` — CascadeQueue implementation
- `src/services/flight-tracker.js` — FlightTracker implementation
- `src/services/undo-store.js` — UndoStore (in-memory undo manifests)
- `src/routes/add-task-set.js` — withStudyLock implementation
- `src/index.js` — Graceful shutdown + import-mode startup sweep
- `src/config.js` — `CASCADE_DEBOUNCE_MS` env var (default 5000ms)
- Railway deployment: single-replica confirmed (no scaling config, no replica env vars as of 2026-04-15)
