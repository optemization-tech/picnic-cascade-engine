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
 * Plan: docs/plans/2026-04-29-002-refactor-webhook-actor-classification-plan.md
 */

/**
 * Bot user ids resolved at startup via /v1/users/me for each integration token.
 * Populated by the startup boot sequence; allows bot classification when
 * source.type is absent from the webhook payload (a known Notion API gap).
 * Defaults to empty — if never populated, the allowlist path is inactive and
 * the classifier falls back to treating unknown source.user_id as 'person'.
 */
export const KNOWN_BOT_IDS = new Set();

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
  const lastEditedBy = body?.data?.last_edited_by;

  let candidate;
  let rawType;

  if (sourcePriority === 'button-first' && source?.user_id) {
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
    // last_edited_by is authoritative; no person-default — missing type is
    // conservatively 'unknown' to prevent bot ids reaching mention fields.
    candidate = lastEditedBy;
    rawType = candidate?.type ?? null;
  }

  const userId = candidate?.user_id ?? candidate?.id ?? null;

  const userType = (
    rawType === 'person' ? 'person' :
    rawType === 'bot' ? 'bot' :
    rawType === 'integration' ? 'integration' :
    'unknown'
  );

  const editedByBot = userType !== 'person';

  // U5 telemetry: emit when legacy Pattern A would have classified differently.
  // Legacy Pattern A: editedByBot = !source?.user_id && last_edited_by?.type === 'bot'
  const legacyEditedByBot = !source?.user_id && lastEditedBy?.type === 'bot';
  if (legacyEditedByBot !== editedByBot) {
    console.log(JSON.stringify({
      event: 'webhook_actor_misclassified',
      userId,
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
