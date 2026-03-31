# Next Session: Phase 0 + Phase 2 — Source Verification & Business Day Utils

## Context

We're porting PicnicHealth's n8n date cascade engine to a standalone Node.js Express server. Project scaffolded at `~/Documents/Claude/picnic-cascade-engine/` with all files as stubs. Full design spec at `~/Documents/Claude/ai-consultant-experiment/clients/picnic-health/2026-03-30-cascade-engine-code-port-design.md`. Implementation plan at `~/.claude/plans/mighty-jingling-naur.md`.

## What Happened Last Session

- Read entire PicnicHealth engagement (150+ files)
- Designed architecture with Tem: Express server, pure-function engine layer, Notion client with token rotation
- Scaffolded project in Cursor (20 files, all stubs with `throw new Error('Not implemented')`)
- Discovered local JS source files are **stale (March 15)** — missing all Round 12-15 fixes

## What Needs to Happen Now

### Phase 0: Source Verification (BLOCKING — do this first)

The algorithm code in `~/Documents/Claude/ai-consultant-experiment/clients/picnic-health/deliverables/synta mcp/*.js` is from March 15. The live n8n workflows have 15 days of fixes since then. We MUST pull fresh code before porting.

**Steps:**

1. Verify Synta MCP is connected (check for `n8n_get_workflow` tool)
2. Export live Code node contents from these 4 workflows:

| Workflow | ID | Key Code Nodes |
|---|---|---|
| WF-D: Directional Cascade | `PTG7a56vRFQVlIAb` | `Resolve Cascade` (~523 lines) |
| WF-P: Parent/Subtask | `fYiNB33Ut0zm9OCP` | `Resolve Parent-Subtask` (~361 lines) |
| WF-R: Date Cascade Router | `sU6fqVy3xQIcrggC` | `Fetch & Validate Task`, `Check Import Mode`, `Fetch All Study Tasks`, `Classify & Build Dispatch`, `Restore Data`, `Enforce Constraints`, `Log Test Results` |
| WF-S: Status Roll-Up | `lEzXg1GisvBs1o69` | `Fetch & Validate`, `Compute Roll-Up` |

3. Save fresh exports to `~/Documents/Claude/picnic-cascade-engine/n8n-source/` (new directory):
   - `wf-d-resolve-cascade.js`
   - `wf-p-resolve-parent-subtask.js`
   - `wf-r-code-nodes.js` (all Router Code nodes concatenated)
   - `wf-s-status-rollup.js`

4. Quick diff summary: what changed since March 15?

**Important Synta note:** Read `~/Documents/Claude/memory/n8n-synta-mcp-guide.md` first. Synta is pointed at a specific n8n instance — verify it's pointing at PicnicHealth's Railway instance (`primary-production-022b.up.railway.app`) before pulling code. Also check `~/Documents/Claude/memory/feedback_synta_instance_check.md`.

### Phase 2: Business Day Utilities + Tests

Once fresh source is verified:

1. Open `~/Documents/Claude/picnic-cascade-engine/src/utils/business-days.js`
2. Extract these functions from the fresh WF-D code (they're in the top ~60 lines):
   - `parseDate(s)` — MUST use `new Date(s + 'T00:00:00Z')` for UTC
   - `formatDate(d)`
   - `isBusinessDay(d)` — Mon-Fri check (UTC day 1-5)
   - `nextBusinessDay(d)` — advance past weekend
   - `prevBusinessDay(d)` — retreat past weekend
   - `addBusinessDays(d, count)` — handles negative counts too
   - `countBDInclusive(start, end)` — minimum 1
   - `signedBDDelta(from, to)` — signed business day difference
3. Add `export` to each function (ESM modules)
4. Write tests in `test/utils/business-days.test.js`:
   - `isBusinessDay`: Mon=true, Sat=false, Sun=false
   - `nextBusinessDay`: Fri→Mon, Sat→Mon, Sun→Mon, Wed→Wed
   - `prevBusinessDay`: Mon→Fri, Sat→Fri, Sun→Fri
   - `addBusinessDays(Fri, 1)` = Mon, `addBusinessDays(Mon, -1)` = Fri
   - `addBusinessDays(date, 0)` on Saturday → **must NOT return Saturday** (this was a real bug)
   - `countBDInclusive` across a weekend
   - `parseDate` produces UTC midnight (not local timezone)
   - `signedBDDelta` positive, negative, zero, across weekends
5. Run `npm test` — all pass

### If Time: Phase 3 Start (Cascade Engine)

Port `runCascade` from fresh WF-D source into `src/engine/cascade.js`. Key adaptations:
- `$input.first().json` → function parameter
- `[{ json: {...} }]` return → `{ updates: [], movedTaskMap: {}, movedTaskIds: [], summary: '' }`
- Import business-day utils from `../utils/business-days.js`
- `FROZEN_STATUSES = ['Done', 'N/A']` stays the same

## Key References

- Design spec: `~/Documents/Claude/ai-consultant-experiment/clients/picnic-health/2026-03-30-cascade-engine-code-port-design.md`
- Implementation plan: `~/.claude/plans/mighty-jingling-naur.md`
- Workflow manifest: `~/Documents/Claude/ai-consultant-experiment/clients/picnic-health/workflow-manifest.json`
- Synta guide: `~/Documents/Claude/memory/n8n-synta-mcp-guide.md`
- Synta instance check: `~/Documents/Claude/memory/feedback_synta_instance_check.md`
- PicnicHealth Notion spec: https://www.notion.so/picnichealth/3342386760c28030a960f98e8181eb10
- PicnicHealth Notion plan: https://www.notion.so/picnichealth/3342386760c281c4b413edddec17c67b

## Pulse Log

Log this session to `~/Documents/Claude/ai-consultant-experiment/clients/picnic-health/pulse-log/` under today's date folder.
