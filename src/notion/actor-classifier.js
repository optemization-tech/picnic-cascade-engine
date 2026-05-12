/**
 * classifyWebhookActor — unified actor classification for Notion webhook payloads.
 *
 * Returns { userId, userType, mentionable, triggeredByUserId, editedByBot }.
 * The `mentionable` field answers "can I write this userId into a Notion
 * people/mention field?" — the question every downstream consumer actually needs.
 * The legacy `triggeredByUserId` / `editedByBot` fields remain for backward
 * compatibility with existing guards.
 *
 * Security invariant: userId and rawType are ALWAYS bound to the SAME candidate
 * block. Reading them from different blocks allows a crafted payload to write a
 * bot id into a people/mention field while appearing to be a person edit.
 *
 * Plan: docs/plans/2026-05-12-001-fix-classify-webhook-actor-edit-first-knownbots-fallback-plan.md
 * (supersedes docs/plans/2026-04-29-002-refactor-webhook-actor-classification-plan.md)
 */

/**
 * Bot user ids resolved at startup via /v1/users/me for each integration token.
 * Populated by the startup boot sequence; allows positive bot classification via
 * id-match when source.type / last_edited_by.type is absent from the webhook
 * payload (Notion's automation builder doesn't expose `type` as a body field).
 *
 * Defaults to empty. The cold-boot guard in the edit-first branch treats
 * `size === 0` as "registration race in progress, drop conservatively" so engine
 * echoes during the 1-10s window after each Railway redeploy don't loop. Once
 * populated, the allowlist never empties for the process lifetime (no clear/delete).
 */
const KNOWN_BOT_IDS = new Set();

/**
 * First-seen-only seen-set for `webhook_actor_unrecognized` telemetry. Each
 * unique user id is added on first observation per process boot; subsequent
 * observations of the same id are suppressed. Resets on process restart by
 * design — re-emission per actor per restart is the desired cadence so ops
 * can spot new actors after each deploy.
 */
const seenUnrecognizedActors = new Set();

/** Register a known bot integration id at startup (e.g. from /v1/users/me). */
export function registerBotId(id) { KNOWN_BOT_IDS.add(id); }

/** Test-only: reset the first-seen seen-set between cases. */
export function _resetUnrecognizedActorSeen() { seenUnrecognizedActors.clear(); }

/**
 * @param {object|null|undefined} payload  Raw webhook body or { body: ... } wrapper.
 * @param {object}  [options]
 * @param {'button-first'|'edit-first'} [options.sourcePriority='button-first']
 *   'button-first': source.user_id dominates (button-trigger routes).
 *   'edit-first': last_edited_by dominates (property-change routes via guards.js).
 * @param {Set<string>} [options.knownBotIds]  Defaults to the module-level KNOWN_BOT_IDS.
 * @param {string} [options.route]  Calling route label, used only in telemetry.
 * @returns {{ userId: string|null, userType: 'person'|'bot'|'integration'|'unknown', mentionable: boolean, triggeredByUserId: string|null, editedByBot: boolean }}
 */
export function classifyWebhookActor(payload, {
  sourcePriority = 'button-first',
  knownBotIds = KNOWN_BOT_IDS,
  route,
} = {}) {
  const body = (payload?.body ?? payload) ?? {};
  const source = body?.source;
  // Path-tolerant lookup for the property-change path (U2): match
  // parseWebhookPayload's body→data fallback chain (src/gates/guards.js:21-22)
  // so misconfigured automation bodies (no `data` wrapper) still extract the
  // actor. `source` stays at body level — Notion's button payloads put it
  // there by design (sibling to `data`, not nested inside it).
  const data = body?.data ?? body;
  const lastEditedBy = data?.last_edited_by;
  const pageId = data?.id;

  let candidate;
  let rawType;
  let coldBootDrop = false;

  if (sourcePriority === 'button-first' && typeof source?.user_id === 'string' && source.user_id.length > 0) {
    // Button-trigger path: source.user_id is the authoritative actor.
    // Type fallback chain (in priority order):
    //   1. source.type, when Notion populates it explicitly
    //   2. KNOWN_BOT_IDS allowlist, for integrations that omit source.type
    //   3. Default to 'person' — button click without a bot signal is human intent
    //      (locks in parseUndoPayload's historical semantic)
    candidate = source;
    rawType = source.type ?? (knownBotIds.has(source.user_id) ? 'bot' : 'person');
  } else {
    // Property-change path OR button-first with no source.user_id.
    // last_edited_by is authoritative.
    candidate = lastEditedBy;

    // Empty-string id guard — mirrors button-first's `source.user_id.length > 0`
    // check (line 65). Without this, an empty `id: ''` would set `mentionable=true`
    // because '' is not strictly null.
    const rawId = candidate?.user_id ?? candidate?.id;
    const hasValidId = typeof rawId === 'string' && rawId.length > 0;

    if (candidate?.type) {
      // Explicit type signal trusted — preserves PR #104's integration-type
      // protection and bypasses the cold-boot guard for legitimate type=person
      // edits that happen during the registration race.
      rawType = candidate.type;
    } else if (knownBotIds.size === 0) {
      // Cold-boot guard (R7): between app.listen and registerBotIds completing,
      // KNOWN_BOT_IDS is empty and we have no id-match signal. Drop conservatively
      // (mirrors pre-fix unknown→bot behavior) so engine echoes during the race
      // don't pass the front-door gate. Self-healing — once registration adds
      // bot ids, this branch stops firing.
      rawType = 'unknown';
      coldBootDrop = true;
    } else if (hasValidId && knownBotIds.has(rawId)) {
      // Positive bot identification via the allowlist populated at boot.
      rawType = 'bot';
    } else {
      // Steady state with no type and no id-match — default to person. This is
      // the post-fix permissive behavior that restores cascades when Notion's
      // automation builder doesn't include `type` in the webhook body (the
      // production case Tem hit on 2026-05-12). Empty-id actors land here too
      // but compute mentionable=false because userId is normalized to null below.
      rawType = 'person';
    }
  }

  // userId derivation, with empty-string normalization. The button-first branch
  // already guards against empty source.user_id; we apply the same normalization
  // here so a payload with `{id: ''}` produces userId=null rather than ''.
  const rawUserId = candidate?.user_id ?? candidate?.id ?? null;
  const userId = (typeof rawUserId === 'string' && rawUserId.length > 0) ? rawUserId : null;

  const userType = (
    rawType === 'person' ? 'person' :
    rawType === 'bot' ? 'bot' :
    rawType === 'integration' ? 'integration' :
    'unknown'
  );

  const editedByBot = userType !== 'person';

  // ─── Telemetry ───────────────────────────────────────────────────────────

  // webhook_dropped_cold_boot: fires when the cold-boot guard returned 'unknown'.
  // Bounded by the registration window (seconds per deploy), so log volume is
  // small. Lets ops correlate post-deploy "my edit didn't propagate" complaints
  // with the actual registration race.
  if (coldBootDrop) {
    console.log(JSON.stringify({
      event: 'webhook_dropped_cold_boot',
      route: route ?? 'unknown',
      sourcePriority,
      taskIdPrefix: typeof pageId === 'string' ? pageId.slice(0, 8) : null,
      userIdPrefix: userId ? userId.slice(0, 8) : null,
    }));
  }

  // webhook_actor_missing_last_edited_by: edit-first paths where the actor is
  // structurally absent (no last_edited_by AND no source.user_id). True
  // misconfiguration — emit per-call so it surfaces loudly. Suppressed on
  // button-first paths where source.user_id-or-bust is the authoritative signal.
  if (sourcePriority !== 'button-first' && !candidate) {
    console.log(JSON.stringify({
      event: 'webhook_actor_missing_last_edited_by',
      sourcePriority,
      route: route ?? 'unknown',
    }));
  }

  // webhook_actor_unrecognized: first-seen-only — fires once per unique user id
  // per engine boot for edit-first paths where the actor is not in KNOWN_BOT_IDS.
  // Suppresses noise from steady-state user edits (every PM edit would otherwise
  // emit, given Notion omits `type` for everyone) while still surfacing new
  // third-party actors (Notion AI, Zapier, future integrations). Skipped during
  // cold-boot — the cold-boot guard already drops via webhook_dropped_cold_boot.
  if (
    sourcePriority !== 'button-first' &&
    userId !== null &&
    knownBotIds.size > 0 &&
    !knownBotIds.has(userId) &&
    !seenUnrecognizedActors.has(userId)
  ) {
    seenUnrecognizedActors.add(userId);
    console.log(JSON.stringify({
      event: 'webhook_actor_unrecognized',
      sourcePriority,
      route: route ?? 'unknown',
      userIdPrefix: userId.slice(0, 8),
    }));
  }

  // Legacy U5 telemetry (PR #104): kept as-is for button-first path mismatches
  // between the legacy Pattern A heuristic and the new classification. Distinct
  // purpose from U4's two new events; consolidation is out of scope for this plan.
  const legacyEditedByBot = !source?.user_id && lastEditedBy?.type === 'bot';
  if (sourcePriority === 'button-first' && legacyEditedByBot !== editedByBot) {
    console.log(JSON.stringify({
      event: 'webhook_actor_misclassified',
      userId: userId?.slice(0, 8),
      userType,
      route: route ?? 'unknown',
      sourcePriority,
      legacyEditedByBot,
      newEditedByBot: editedByBot,
    }));
  }

  return {
    userId,
    userType,
    mentionable: userType === 'person' && userId !== null,
    // Backward-compatible legacy fields:
    triggeredByUserId: userId,
    editedByBot,
  };
}
