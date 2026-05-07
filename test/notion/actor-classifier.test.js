import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyWebhookActor } from '../../src/notion/actor-classifier.js';

const REAL_USER_ID = 'user-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BOT_USER_ID  = 'bot-11111111-2222-3333-4444-555555555555';
const BOT_USER_ID2 = 'bot-22222222-3333-4444-5555-666666666666';
const KNOWN_BOTS   = new Set([BOT_USER_ID]);

function buttonPayload(userId, opts = {}) {
  return {
    source: { user_id: userId, ...opts.sourceExtra },
    data: opts.lastEditedBy ? { last_edited_by: opts.lastEditedBy } : {},
  };
}

function editPayload(lastEditedBy) {
  return {
    data: { last_edited_by: lastEditedBy },
  };
}

// ─── Button-first path ───────────────────────────────────────────────────────

describe('classifyWebhookActor — button-first (default)', () => {
  it('real user presses button — no source.type, not in KNOWN_BOT_IDS → mentionable:true', () => {
    const result = classifyWebhookActor(
      buttonPayload(REAL_USER_ID),
      { knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({
      userId: REAL_USER_ID,
      userType: 'person',
      mentionable: true,
      editedByBot: false,
      triggeredByUserId: REAL_USER_ID,
    });
  });

  it('real user presses button on bot-edited page — last_edited_by.type=bot is ignored', () => {
    // Regression lock: classifier MUST NOT fall through to last_edited_by.type when
    // source.user_id is present. This is the adversarial field-mixing case (security review 2026-05-07).
    const result = classifyWebhookActor(
      buttonPayload(REAL_USER_ID, { lastEditedBy: { id: BOT_USER_ID, type: 'bot' } }),
      { knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({
      userId: REAL_USER_ID,
      userType: 'person',
      mentionable: true,
      editedByBot: false,
    });
  });

  it('bot presses button with explicit source.type=bot → mentionable:false', () => {
    const result = classifyWebhookActor(
      buttonPayload(BOT_USER_ID, { sourceExtra: { type: 'bot' } }),
      { knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({
      userId: BOT_USER_ID,
      userType: 'bot',
      mentionable: false,
      editedByBot: true,
    });
  });

  it('bot presses button with no source.type but IS in KNOWN_BOT_IDS → mentionable:false', () => {
    const result = classifyWebhookActor(
      buttonPayload(BOT_USER_ID),
      { knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({
      userId: BOT_USER_ID,
      userType: 'bot',
      mentionable: false,
      editedByBot: true,
    });
  });

  it('button-first with no source.user_id — falls back to last_edited_by person', () => {
    const result = classifyWebhookActor(
      { data: { last_edited_by: { id: REAL_USER_ID, type: 'person' } } },
      { knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({
      userId: REAL_USER_ID,
      userType: 'person',
      mentionable: true,
      editedByBot: false,
    });
  });
});

// ─── Edit-first path ─────────────────────────────────────────────────────────

describe('classifyWebhookActor — edit-first (sourcePriority: edit-first)', () => {
  it('property-change by person → mentionable:true', () => {
    const result = classifyWebhookActor(
      editPayload({ id: REAL_USER_ID, type: 'person' }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({
      userId: REAL_USER_ID,
      userType: 'person',
      mentionable: true,
      editedByBot: false,
    });
  });

  it('property-change by bot (type=bot) → mentionable:false', () => {
    const result = classifyWebhookActor(
      editPayload({ id: BOT_USER_ID, type: 'bot' }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({
      userId: BOT_USER_ID,
      userType: 'bot',
      mentionable: false,
      editedByBot: true,
    });
  });

  it('property-change by legacy integration (type=integration) → mentionable:false — 2026-05-07 incident fix', () => {
    const result = classifyWebhookActor(
      editPayload({ id: BOT_USER_ID, type: 'integration' }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({
      userId: BOT_USER_ID,
      userType: 'integration',
      mentionable: false,
      editedByBot: true,
    });
  });

  it('property-change with id present but no type → userType:unknown, editedByBot:true (conservative)', () => {
    const result = classifyWebhookActor(
      editPayload({ id: BOT_USER_ID }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({
      userId: BOT_USER_ID,
      userType: 'unknown',
      mentionable: false,
      editedByBot: true,
    });
  });

  it('no last_edited_by field at all → userId:null, userType:unknown, editedByBot:true', () => {
    const result = classifyWebhookActor(
      { data: {} },
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({
      userId: null,
      userType: 'unknown',
      mentionable: false,
      editedByBot: true,
    });
  });
});

// ─── Null / empty / malformed payloads ───────────────────────────────────────

describe('classifyWebhookActor — null/empty payloads', () => {
  it('empty object {} → unknown, not mentionable', () => {
    const result = classifyWebhookActor({});
    expect(result).toMatchObject({
      userId: null,
      userType: 'unknown',
      mentionable: false,
      editedByBot: true,
      triggeredByUserId: null,
    });
  });

  it('null payload → same as empty', () => {
    const result = classifyWebhookActor(null);
    expect(result.mentionable).toBe(false);
    expect(result.editedByBot).toBe(true);
    expect(result.userId).toBeNull();
  });

  it('undefined payload → same as empty', () => {
    const result = classifyWebhookActor(undefined);
    expect(result.mentionable).toBe(false);
    expect(result.editedByBot).toBe(true);
  });

  it('{ body: ... } wrapper is unwrapped correctly', () => {
    const result = classifyWebhookActor(
      { body: { source: { user_id: REAL_USER_ID } } },
      { knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({ userId: REAL_USER_ID, mentionable: true });
  });
});

// ─── Cross-field consistency (security regression-locks) ─────────────────────

describe('classifyWebhookActor — cross-field security invariants', () => {
  it('source.user_id=botId (in KNOWN_BOTS), last_edited_by.type=person — MUST NOT mix fields', () => {
    // classifier must bind userId AND type from the SAME candidate (source),
    // NOT fall through to last_edited_by.type for the type signal.
    const result = classifyWebhookActor(
      {
        source: { user_id: BOT_USER_ID },
        data: { last_edited_by: { id: REAL_USER_ID, type: 'person' } },
      },
      { knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({
      userId: BOT_USER_ID,
      userType: 'bot',
      mentionable: false,
      editedByBot: true,
    });
  });

  it('source.user_id=realUser (not in KNOWN_BOTS), last_edited_by.type=bot — button path must not adopt bot type', () => {
    const result = classifyWebhookActor(
      {
        source: { user_id: REAL_USER_ID },
        data: { last_edited_by: { id: BOT_USER_ID, type: 'bot' } },
      },
      { knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({
      userId: REAL_USER_ID,
      userType: 'person',
      mentionable: true,
      editedByBot: false,
    });
  });
});

// ─── Telemetry (U5) ───────────────────────────────────────────────────────────

describe('classifyWebhookActor — telemetry (webhook_actor_misclassified)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits log line when legacy Pattern A disagrees — bot via KNOWN_BOT_IDS', () => {
    // Legacy: !source.user_id && last_edited_by.type==='bot' → false (source.user_id exists)
    // New:    userType==='bot' via KNOWN_BOT_IDS → editedByBot: true
    // → disagreement → should log
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      buttonPayload(BOT_USER_ID),
      { knownBotIds: KNOWN_BOTS, route: 'inception' },
    );
    expect(spy).toHaveBeenCalledOnce();
    const logged = JSON.parse(spy.mock.calls[0][0]);
    expect(logged).toMatchObject({
      event: 'webhook_actor_misclassified',
      userId: BOT_USER_ID,
      userType: 'bot',
      route: 'inception',
      sourcePriority: 'button-first',
      legacyEditedByBot: false,
      newEditedByBot: true,
    });
  });

  it('emits log line for integration type in edit-first path', () => {
    // Legacy: !source.user_id(true) && type==='bot'(false) → false
    // New:    userType==='integration' → editedByBot: true → disagreement
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      editPayload({ id: BOT_USER_ID, type: 'integration' }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS, route: 'dep-edit' },
    );
    expect(spy).toHaveBeenCalledOnce();
    const logged = JSON.parse(spy.mock.calls[0][0]);
    expect(logged.event).toBe('webhook_actor_misclassified');
    expect(logged.legacyEditedByBot).toBe(false);
    expect(logged.newEditedByBot).toBe(true);
  });

  it('does NOT emit log for a real person button press', () => {
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(buttonPayload(REAL_USER_ID), { knownBotIds: KNOWN_BOTS });
    expect(spy).not.toHaveBeenCalled();
  });

  it('emits log for bot with explicit source.type=bot — the original Pattern A failure mode', () => {
    // Legacy Pattern A: !source.user_id(false, because source.user_id exists) → legacyEditedByBot=false
    // New: source.type='bot' → userType='bot' → editedByBot=true → disagreement → should log
    // This is the original failure mode the plan was written to fix.
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      buttonPayload(BOT_USER_ID, { sourceExtra: { type: 'bot' } }),
      { knownBotIds: KNOWN_BOTS, route: 'test' },
    );
    expect(spy).toHaveBeenCalledOnce();
    const logged = JSON.parse(spy.mock.calls[0][0]);
    expect(logged.legacyEditedByBot).toBe(false);
    expect(logged.newEditedByBot).toBe(true);
  });

  it('does NOT emit log for edit-first person (both legacy and new agree: editedByBot=false)', () => {
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      editPayload({ id: REAL_USER_ID, type: 'person' }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('does NOT emit log for edit-first bot type=bot (legacy also catches this via last_edited_by.type=bot)', () => {
    // Legacy: !source.user_id(true) && last_edited_by.type==='bot'(true) → true
    // New: editedByBot=true → both agree, no log
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      editPayload({ id: BOT_USER_ID, type: 'bot' }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    expect(spy).not.toHaveBeenCalled();
  });
});
