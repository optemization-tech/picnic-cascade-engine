# n8n Source Files

Exported from live n8n workflows on 2026-03-30 via Synta MCP.

## Files

| File | Workflow | ID | Last Updated | Notes |
|---|---|---|---|---|
| `wf-d-resolve-cascade.js` | Date Change - Cascade Engine | `PTG7a56vRFQVlIAb` | 2026-03-31 | v5: adjacency + gap absorption |
| `wf-p-resolve-parent-subtask.js` | Date Change - Parent/Subtask Engine | `fYiNB33Ut0zm9OCP` | 2026-03-23 | v1 unchanged from Mar 15 |
| `wf-r-code-nodes.js` | Date Cascade Router | `sU6fqVy3xQIcrggC` | 2026-03-30+ | 11 Code nodes extracted |
| `wf-s-status-rollup.js` | Status Change - Roll-Up | `lEzXg1GisvBs1o69` | 2026-03-24 | Added payload-first LMBS |

## Changes Since March 15 (local snapshots)

### WF-D (Cascade Engine) - MAJOR
- v2 (Mar 23): Fix pullRightUpstream over-shift
- v3 (Mar 23): Replace gap-preserving downstream with uniform delta shift
- v4 (Mar 30): BL-R15 gap-absorption check in pullRightUpstream
- v5 (Mar 30): Adjacency check uses ORIGINAL positions (tight chains maintain adjacency)
- conflictOnlyDownstream: now propagates effectiveEnds for non-moved tasks
- noUpdates return includes movedTaskIds: []
- Output items include movedTaskIds array

### WF-P (Parent/Subtask) - UNCHANGED
- Identical to March 15 export

### WF-R (Router) - SIGNIFICANT
- Fetch & Validate: v4 drag normalization, payload-first pattern
- Classify & Build Dispatch: Error 1 fix, stale reference correction
- Enforce Constraints: v3 BL-H1d/e fix, case-a roll-up handling
- New nodes: Report Start, Report Complete, Report Error, Cleanup LMBS, Log Test Results

### WF-S (Status Roll-Up) - MODERATE
- Payload-first LMBS check (zero API calls if system-modified)
- Activity Log node added
