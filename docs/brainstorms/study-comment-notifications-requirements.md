---
date: 2026-04-14
topic: study-comment-notifications
---

# Study Comment Notifications

## Problem Frame

When an automation completes (cascade, inception, deletion, etc.), the result is written to the Automation Reporting property on the study page. This property is a single rich-text field that gets overwritten on each run — it's not visible unless a PM navigates to the study page and scrolls to the property. PMs who trigger date changes have no push notification that the cascade succeeded or failed.

Notion page comments are a natural fit: they appear in the comments sidebar, trigger email/Slack/in-app notifications for mentioned users, and create a persistent timestamped thread. Adding a comment after each automation gives the triggering PM immediate, passive visibility into outcomes.

## Requirements

**Comment Posting**
- R1. After every terminal event across 5 user-initiated routes (date-cascade, inception, add-task-set, deletion, undo-cascade), post a Notion comment on the study page. Comments follow the debounced terminal event, not raw webhook receipt — the existing per-task debounce and per-study queue ensure one comment per logical operation.
- R2. Comments are posted for `success` and `failed` terminal statuses. `no_action` outcomes are silent, with one exception: undo-cascade's `no_action` ("no recent cascade to undo") posts a comment because it responds to an explicit PM button click that deserves feedback.
- R3. The comment is posted to the study page identified by `studyId`, not the source task page. If `studyId` is null for a terminal event, the comment is silently skipped.

**User Mention**
- R4. When `triggeredByUserId` is a real person (not a bot, not absent), the comment @-mentions that user via a Notion `mention` rich text object.
- R5. When `triggeredByUserId` is absent or is a bot, the comment is still posted but without a user mention. The comment describes what ran without attributing who triggered it.

**Comment Content**
- R6. Comments use a simple emoji + plain-English summary format. No workflow name, no task name prefix, no status label — the emoji conveys status and the summary is self-contained.
  - Success: `✅ {plain summary}` (e.g., "✅ Study setup complete — 200 tasks created")
  - Failure: `❌ {plain summary}` (e.g., "❌ Date cascade failed: rate limited")
  - No-action: `ℹ️ {plain summary}` (e.g., "ℹ️ No recent cascade to undo")
- R7. Summaries are written for PMs, not engineers. No internal jargon ("parents wired", "deps wired", "residue tasks"). Each route provides a human-friendly summary:
  - **Inception success**: "Study setup complete — {N} tasks created"
  - **Date Cascade success**: "{TaskName} updated — {N} dependent task(s) rescheduled"
  - **Add Task Set success**: "{ButtonType} tasks added — {N} tasks created"
  - **Deletion success**: "Study tasks deleted — {N} task(s) archived"
  - **Undo success**: "Undo complete: restored {N} tasks to pre-cascade dates"
  - **Failures**: brief error reason (e.g., "Date cascade failed: rate limited")
- R8. Detailed diagnostics remain in the Activity Log. Comment summaries and activity log summaries are independent — activity logs keep full internal detail.

**Comment Identity**
- R9. All comments are posted through a single dedicated Notion integration (e.g., "Study Notifications") separate from the cascade/provision/deletion integrations. This gives comments a distinct, consistent identity so they don't appear to come from the same bot that modifies tasks.
- R10. The comment token is configured via `NOTION_COMMENT_TOKEN_1` env var on Railway. All 5 routes share this single `commentClient`.

**Reliability**
- R11. Comment posting must not block or delay the route's response. If the comment fails to post (Notion API error, rate limit), the failure is logged but does not affect the route outcome or the Activity Log entry.
- R12. The existing Automation Reporting property write and Activity Log entry are unchanged — this is additive, not a replacement.

## Success Criteria

- A PM edits a task date and sees a Notion notification like "@PM: ✅ Task One updated — 4 dependent task(s) rescheduled" — clear, scannable, no jargon.
- A failed automation surfaces the error in a comment without requiring the PM to dig into the Activity Log.
- Comments come from a distinct "Study Notifications" integration, not the same one that moves dates or creates tasks.
- No route is slowed or broken by the comment feature, even under Notion rate limits.

## Scope Boundaries

- **Not replacing Automation Reporting or Activity Log** — this is an additional notification channel.
- **No new comment threading** — each automation posts a standalone comment, not a reply to a previous comment.
- **No comment for no_action** — except undo-cascade's "no undo available" which is a user-initiated action.
- **Excluded routes: status-rollup and copy-blocks** — status-rollup fires on every subtask status change (could be dozens per cascade, burying the actual cascade notification). copy-blocks is a background async operation invoked by inception/add-task-set, which already post their own comments. Can expand to these routes later if PMs want them.
- **No configurable opt-out per study** — all studies get comments. Can revisit if noise becomes a problem.
- **No team tagging on failures** — comments stay simple, one @-mention for the triggering user only. Team-level alerting belongs in Activity Log or Slack, not study page comments.

## Key Decisions

- **5 user-initiated routes** (not all 7): Excluded status-rollup (high-frequency, low-signal) and copy-blocks (internal, parent route already comments). Avoids notification noise that would train PMs to ignore comments entirely.
- **Undo no_action exception**: Undo-cascade's `no_action` gets a comment because the PM explicitly pressed a button and deserves feedback, unlike automated no-ops (import mode, frozen status, zero-delta).
- **Emoji + summary format**: Production testing showed the original format (`{Workflow} — {TaskName}: {Label}. {Summary}`) was too verbose and technical. Simplified to `{emoji} {summary}` — the emoji replaces the status label and the summary is self-contained plain English.
- **Separate comment summaries from activity log summaries**: Activity logs keep full internal detail (parents wired, deps wired, cascade mode). Comments get PM-friendly language. These are maintained independently.
- **Dedicated comment integration**: A single `NOTION_COMMENT_TOKEN_1` env var feeds a `commentClient` shared across all 5 routes, distinct from cascade/provision/deletion pools. Prevents comments from appearing as the same bot identity that modifies tasks.
- **Fire-and-forget**: Comment posting is not in the critical path. A failed comment is an acceptable degradation.

## Dependencies / Assumptions

- The Notion Comments API (`POST /v1/comments`) supports user mentions via `mention` rich text objects with `type: "user"`.
- The engine's existing `NotionClient.request()` method can post comments without new Notion plumbing.
- Study pages must have comments enabled (Notion default).
- The dedicated comment integration must have "Insert comments" capability enabled and be shared with the study pages.
- A single comment token is sufficient — comment posting is low-frequency (one per automation) and not rate-sensitive.

## Next Steps

-> `/ce:plan` or `/ce:work` for implementation
