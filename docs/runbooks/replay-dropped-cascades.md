# Replay Dropped Cascades — Operator Runbook

**Purpose:** Re-fire cascades that were silently dropped between 2026-05-08 and 2026-05-12 because Notion's webhook payload doesn't include `last_edited_by.type` and the engine's classifier (pre-fix) treated missing type as `unknown` → `bot` → drop.

**Pre-condition:** PR for `2026-05-12-001-fix-classify-webhook-actor-edit-first-knownbots-fallback-plan` (U1-U4) **must already be deployed and verified in production.** Running this script before the fix lands will produce a fresh set of dropped cascades — the replay webhooks will be dropped the same way.

**Estimated wall-clock time:** ~5s per affected component (1 study with 2 chains = 10s). Run during US/Pacific off-hours to avoid colliding with active PM edits.

---

## 1. Pre-flight checklist

Confirm each item before invoking the script:

- [ ] U1-U4 are deployed (check `git log` on engine main + Railway deployment list)
- [ ] U5 verification passed: `bot_ids_registered` event visible in Railway logs from the latest boot with `registered > 0 AND failed: 0`
- [ ] Live test: Tem (or another operator) has moved a task date on a sacrificial study and confirmed the cascade fired (Railway shows `debounce_new` → `debounce_fired` → cascade Activity Log success, NOT `cascade_bot_echo_dropped`)
- [ ] PicnicHealth eng Slack channel notified — see template in §4
- [ ] Current time is outside US/Pacific business hours (8am–6pm PT)

---

## 2. Required environment variables

```bash
# Engine auth — same secret used by Notion automations
export WEBHOOK_SECRET="<from Railway env or 1Password>"

# Real Notion person user ID — used in synthesized last_edited_by so
# downstream mention writes don't 400 on a fake UUID. Use the operator's
# own Notion user ID. Treat as sensitive — same hygiene as WEBHOOK_SECRET.
export BACKFILL_ACTOR_USER_ID="<your Notion user UUID>"

# At least one Notion integration token (the engine's cascade pool token works).
export NOTION_TOKEN_1="<token>"

# Optional — override the engine URL (defaults to production)
# export ENGINE_URL="https://picnic-cascade-engine-production.up.railway.app"
```

Sanity-check that none of these values end up in shell history (`unset HISTFILE` or use a fresh shell).

---

## 3. Phase 1 — Diagnose (read-only)

Run this first to size the work:

```bash
cd projects/engine  # or wherever the engine repo is checked out
node scripts/replay-dropped-cascades.js
```

Expected output shape:

```
Diagnose: N studies affected (replay id <uuid>)
  <Study Name> (<study-page-id>)
    M divergent tasks across K components
      - seed: <task name> (P divergent)
      - seed: <task name> (Q divergent)
  ...

To apply: re-run with --apply --confirm-notified
```

Interpretation:

- `divergent tasks` = tasks where `[Do Not Edit] Reference Start/End Date` no longer matches `Dates`. A successful cascade aligns these; divergence is the signature of a dropped cascade.
- `components` = independent dependency chains (Blocked-by/Blocking graph). The replay fires one webhook per component, since the cascade engine walks the graph from one seed.
- `skipped: all_frozen_component` = every divergent task in that chain is Done/N/A. The cascade engine would no-op on a frozen seed, so the script reports it and moves on. Operator decides whether to un-freeze a task and retry.

**If output is `No divergent studies found`**, nothing to do. The fix already restored cascades for any future edits; historical drops will accumulate on their own as PMs re-edit affected tasks.

**Single-study scope:** add `--study <pageId>` to diagnose just one study. Useful for sacrificial-study verification.

---

## 4. Phase 2 — Apply

### 4a. Slack notification

Before running `--apply`, post this template to the PicnicHealth eng Slack channel (placeholder: `#picnic-eng-cascade-ops` — confirm channel name in your team's docs):

```
Starting cascade replay backfill — N studies, ~M components, ETA <X> minutes.
Operator: <name>. Abort: ping me here. Engine commit: <SHA>.
```

Replace `N`, `M`, `<X>` from the Phase 1 diagnose output. ETA is roughly `M × 5s` (one component every 5s due to the inter-component throttle).

### 4b. Run with `--apply --confirm-notified`

```bash
node scripts/replay-dropped-cascades.js --apply --confirm-notified
```

The script aborts with `exit 3` if `--confirm-notified` is missing — this is the operator's explicit confirmation that Slack was notified.

### 4c. Watch the output

```
Apply complete (replay id <uuid>, state: success)
  applied: K
```

or, on partial failure:

```
Apply complete (replay id <uuid>, state: partial)
  applied: J
  engine_error: L
  transient: M

Failures:
  - <study name> / <seed task name>: engine_error — <truncated body>
  ...
```

### 4d. Verify in Railway

While the script runs (and for ~30s after), watch Railway HTTP logs:

```bash
railway logs --service picnic-cascade-engine --http --filter "@path:/webhook/date-cascade"
```

Each replay webhook should show as `POST /webhook/date-cascade 200 <ms>`. **Not** `cascade_bot_echo_dropped` — if you see that, the U1-U4 fix isn't actually live and you should abort (`Ctrl-C` the script).

Each cascade should also produce an Activity Log entry on the affected study (Workflow: `Date Cascade`, Source Task ID: the seed task) with terminal status `success`, `no_action`, `no_shifts`, or `failed`.

---

## 5. Re-run on residue

If Phase 2 reports `partial` or `transient`, re-run Phase 1 to see what's left:

```bash
node scripts/replay-dropped-cascades.js
```

The script is idempotent — successful cascades wrote `Reference = Dates`, so already-replayed studies don't show up in the next diagnose. Only the failed and transient components remain.

Common residue causes:

| Residue | Likely cause | Action |
|---|---|---|
| `engine_error` with `frozen_status` | Seed task was frozen between diagnose and apply (race) | Operator: un-freeze the task, re-run |
| `transient` (5xx) | Notion or engine was momentarily unavailable | Wait 5 minutes, re-run |
| `auth_error` | WEBHOOK_SECRET wrong or rotated | Confirm secret, re-export, re-run |
| `skipped: all_frozen_component` | Chain has no non-frozen divergent task | Decide manually — un-freeze a task in the chain if the dates need to propagate, or accept the divergence |

---

## 6. Post-completion checklist

- [ ] Final `Apply complete` line shows `state: success` (or operator-accepted residue)
- [ ] Spot-check 2-3 replayed studies: open the Notion page, verify downstream tasks shifted
- [ ] Write a pulse-log entry in the picnic-health repo: `pulse-log/MM.DD/NN-replay-dropped-cascades.md` capturing: studies replayed, components per study, tasks affected, any residue requiring manual follow-up
- [ ] Notify Slack channel with completion summary

---

## 7. Troubleshooting

### "Script exits 3 with `missing_webhook_secret`"

You forgot to `export WEBHOOK_SECRET=...` in this shell. Run `env | grep WEBHOOK_SECRET` to confirm. Source from Railway env or 1Password.

### "Script exits 3 with `missing_backfill_actor`"

Set `BACKFILL_ACTOR_USER_ID` to your real Notion person user UUID. **Do not use a fake string** — Notion mention writes will 400 on synthetic UUIDs.

### "Diagnose shows divergence but apply doesn't fire any webhooks"

Phase 1 reports the candidate set; Phase 2 re-fetches the seed task before synthesizing the payload. If the task changed between phases (PM edited it manually, or it became frozen), the re-fetch might exclude it. Re-run Phase 1 to see the current state.

### "Notion automation auto-disabled"

Separate concern. If a study's `When Dates changes` Notion automation is disabled (Notion does this after sustained webhook errors), this script won't re-enable it. Tem confirms each affected study's automations are active before backfill runs.

### "I see `webhook_actor_unrecognized` events in Railway logs for the replay actor"

Expected — the script's synthesized `BACKFILL_ACTOR_USER_ID` is a real Notion user but isn't in `KNOWN_BOT_IDS` (it's a person, not an engine bot). First-seen-only telemetry emits once per unique actor per engine boot. After the first replay it stops.

---

## 8. References

- Plan: [`docs/plans/2026-05-12-001-fix-classify-webhook-actor-edit-first-knownbots-fallback-plan.md`](../plans/2026-05-12-001-fix-classify-webhook-actor-edit-first-knownbots-fallback-plan.md) (U6)
- Script source: [`scripts/replay-dropped-cascades.js`](../../scripts/replay-dropped-cascades.js)
- Tests: [`test/scripts/replay-dropped-cascades.test.js`](../../test/scripts/replay-dropped-cascades.test.js)
- Related runbook (different M2 scenario, similar diagnose-then-apply pattern): [`docs/runbooks/missing-task-content.md`](missing-task-content.md)
