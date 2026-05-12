import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  classifyWebhookActor,
  _resetUnrecognizedActorSeen,
} from '../../src/notion/actor-classifier.js';

const REAL_USER_ID = 'user-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const REAL_USER_ID2 = 'user-bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const BOT_USER_ID  = 'bot-11111111-2222-3333-4444-555555555555';
const BOT_USER_ID2 = 'bot-22222222-3333-4444-5555-666666666666';
const KNOWN_BOTS   = new Set([BOT_USER_ID]);

// First-seen-only telemetry uses module-level state; reset between tests so
// each one sees a fresh seen-set rather than inheriting earlier observations.
beforeEach(() => _resetUnrecognizedActorSeen());

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

  it('property-change with id present but no type — id IN allowlist → userType:bot, editedByBot:true (positively identified)', () => {
    // R3: when type is missing, fall back to KNOWN_BOT_IDS lookup. Engine echoes
    // whose token bot ids registered at boot still drop via positive ID match.
    const result = classifyWebhookActor(
      editPayload({ id: BOT_USER_ID }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({
      userId: BOT_USER_ID,
      userType: 'bot',
      mentionable: false,
      editedByBot: true,
    });
  });

  it('property-change with id present but no type — id NOT in allowlist → userType:person (R3 regression fix for Tem 2026-05-12)', () => {
    // R3: this is the production case Notion's webhook payload shape produces
    // when an automation includes `last_edited_by` without `type` (Notion omits
    // type for all actors). Pre-R3 this dropped as conservative-unknown; post-R3
    // it falls through to person by default and the cascade proceeds.
    const result = classifyWebhookActor(
      editPayload({ id: REAL_USER_ID }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({
      userId: REAL_USER_ID,
      userType: 'person',
      mentionable: true,
      editedByBot: false,
    });
  });

  it('no last_edited_by field at all + populated allowlist → userId:null, userType:person, mentionable:false', () => {
    // R3: candidate is undefined → userId is null → defaults to person, but
    // mentionable is false because there's no user id to write into a people field.
    // U4 telemetry surfaces this as `webhook_actor_missing_last_edited_by`.
    const result = classifyWebhookActor(
      { data: {} },
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({
      userId: null,
      userType: 'person',
      mentionable: false,
      editedByBot: false,
    });
  });

  it('empty-string id + missing type → userId:null, mentionable:false (empty-string guard)', () => {
    // Mirrors button-first's `source.user_id.length > 0` guard. Without this guard,
    // mentionable would compute as `'person' && '' !== null` = true, letting an
    // empty string get written into a Notion people field.
    const result = classifyWebhookActor(
      editPayload({ id: '' }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    expect(result).toMatchObject({
      userId: null,
      mentionable: false,
    });
  });
});

// ─── Cold-boot guard (R7) ─────────────────────────────────────────────────────

describe('classifyWebhookActor — cold-boot guard (R7)', () => {
  it('cold-boot (empty allowlist) + missing type → userType:unknown, editedByBot:true (drops via gate)', () => {
    // During the 1-10s window between app.listen and registerBotIds completing,
    // we have no signal to distinguish bots from people via id-match. Drop
    // conservatively so engine echoes during the registration race don't loop.
    const result = classifyWebhookActor(
      editPayload({ id: BOT_USER_ID }),
      { sourcePriority: 'edit-first', knownBotIds: new Set() },
    );
    expect(result).toMatchObject({
      userType: 'unknown',
      editedByBot: true,
    });
  });

  it('cold-boot (empty allowlist) + explicit type=person → bypasses guard, classifies as person', () => {
    // Explicit type signal is trusted even during the cold-boot window so
    // legitimate person edits still work. Only the type-missing path is
    // conservatively dropped.
    const result = classifyWebhookActor(
      editPayload({ id: REAL_USER_ID, type: 'person' }),
      { sourcePriority: 'edit-first', knownBotIds: new Set() },
    );
    expect(result).toMatchObject({
      userType: 'person',
      mentionable: true,
      editedByBot: false,
    });
  });

  it('cold-boot (empty allowlist) + explicit type=bot → bypasses guard, classifies as bot', () => {
    const result = classifyWebhookActor(
      editPayload({ id: BOT_USER_ID, type: 'bot' }),
      { sourcePriority: 'edit-first', knownBotIds: new Set() },
    );
    expect(result).toMatchObject({
      userType: 'bot',
      editedByBot: true,
    });
  });

  it('cold-boot guard fires when no last_edited_by AND empty allowlist', () => {
    const result = classifyWebhookActor(
      { data: {} },
      { sourcePriority: 'edit-first', knownBotIds: new Set() },
    );
    expect(result).toMatchObject({
      userType: 'unknown',
      mentionable: false,
      editedByBot: true,
    });
  });

  it('cold-boot guard emits webhook_dropped_cold_boot event with route + truncated ids', () => {
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      { data: { id: 'task-1234abcd', last_edited_by: { id: REAL_USER_ID } } },
      { sourcePriority: 'edit-first', knownBotIds: new Set(), route: 'date-cascade' },
    );
    const events = spy.mock.calls
      .map((call) => { try { return JSON.parse(call[0]); } catch { return null; } })
      .filter((e) => e && e.event === 'webhook_dropped_cold_boot');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'webhook_dropped_cold_boot',
      route: 'date-cascade',
      sourcePriority: 'edit-first',
      taskIdPrefix: 'task-123',
      userIdPrefix: REAL_USER_ID.slice(0, 8),
    });
    spy.mockRestore();
  });

  it('cold-boot guard does NOT fire once allowlist is populated', () => {
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      editPayload({ id: REAL_USER_ID }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    const events = spy.mock.calls
      .map((call) => { try { return JSON.parse(call[0]); } catch { return null; } })
      .filter((e) => e && e.event === 'webhook_dropped_cold_boot');
    expect(events).toHaveLength(0);
    spy.mockRestore();
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
      userId: BOT_USER_ID.slice(0, 8),
      userType: 'bot',
      route: 'inception',
      sourcePriority: 'button-first',
      legacyEditedByBot: false,
      newEditedByBot: true,
    });
  });

  it('does NOT emit for edit-first integration type (noise suppressed — only button-first is telemetry-worthy)', () => {
    // Legacy: !source.user_id(true) && type==='bot'(false) → false
    // New:    userType==='integration' → editedByBot: true → would disagree
    // But R7 fix: telemetry is gated on sourcePriority === 'button-first' to prevent
    // high-volume noise from every property-change webhook from an integration.
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      editPayload({ id: BOT_USER_ID, type: 'integration' }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS, route: 'dep-edit' },
    );
    expect(spy).not.toHaveBeenCalled();
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

  it('does NOT emit webhook_actor_misclassified for edit-first person (both legacy and new agree: editedByBot=false)', () => {
    // Filter the assertion to webhook_actor_misclassified specifically — U4's
    // first-seen-only webhook_actor_unrecognized event fires alongside this
    // case (REAL_USER_ID is not in KNOWN_BOTS) and is asserted separately below.
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      editPayload({ id: REAL_USER_ID, type: 'person' }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    const misclassifiedEvents = spy.mock.calls
      .map((call) => { try { return JSON.parse(call[0]); } catch { return null; } })
      .filter((e) => e && e.event === 'webhook_actor_misclassified');
    expect(misclassifiedEvents).toHaveLength(0);
  });

  it('does NOT emit log for edit-first bot type=bot (legacy also catches this via last_edited_by.type=bot)', () => {
    // Legacy: !source.user_id(true) && last_edited_by.type==='bot'(true) → true
    // New: editedByBot=true → both agree, no log
    // Also: BOT_USER_ID IS in KNOWN_BOTS, so webhook_actor_unrecognized does not fire.
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      editPayload({ id: BOT_USER_ID, type: 'bot' }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── U2: path-tolerant last_edited_by lookup ─────────────────────────────────

describe('classifyWebhookActor — U2 path-tolerant last_edited_by lookup', () => {
  it('reads last_edited_by from body.data.last_edited_by (existing path)', () => {
    const result = classifyWebhookActor(
      { body: { data: { last_edited_by: { id: REAL_USER_ID, type: 'person' } } } },
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    expect(result.userId).toBe(REAL_USER_ID);
    expect(result.userType).toBe('person');
  });

  it('reads last_edited_by from body.last_edited_by when no data wrapper (R5 — new path)', () => {
    const result = classifyWebhookActor(
      { body: { last_edited_by: { id: REAL_USER_ID, type: 'person' } } },
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    expect(result.userId).toBe(REAL_USER_ID);
    expect(result.userType).toBe('person');
  });

  it('button-first source.user_id still resolves at body level (U2 regression guard for source)', () => {
    // Critical: U2 only made last_edited_by path-tolerant. source must remain at body level
    // (sibling to data), not nested inside data. Verified against Notion's real button payloads
    // — moving the source lookup would silently break every button automation.
    const result = classifyWebhookActor(
      {
        body: {
          source: { user_id: REAL_USER_ID },
          data: { last_edited_by: { id: BOT_USER_ID, type: 'bot' } },
        },
      },
      { knownBotIds: KNOWN_BOTS },
    );
    expect(result.userId).toBe(REAL_USER_ID);
    expect(result.userType).toBe('person');
  });
});

// ─── U4: webhook_actor_missing_last_edited_by telemetry ──────────────────────

describe('classifyWebhookActor — webhook_actor_missing_last_edited_by (U4)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits when last_edited_by AND source.user_id are both absent (edit-first)', () => {
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      { data: {} },
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS, route: 'date-cascade' },
    );
    const events = spy.mock.calls
      .map((call) => { try { return JSON.parse(call[0]); } catch { return null; } })
      .filter((e) => e && e.event === 'webhook_actor_missing_last_edited_by');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'webhook_actor_missing_last_edited_by',
      sourcePriority: 'edit-first',
      route: 'date-cascade',
    });
  });

  it('does NOT emit when last_edited_by has an id (only type is missing)', () => {
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      editPayload({ id: REAL_USER_ID }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    const events = spy.mock.calls
      .map((call) => { try { return JSON.parse(call[0]); } catch { return null; } })
      .filter((e) => e && e.event === 'webhook_actor_missing_last_edited_by');
    expect(events).toHaveLength(0);
  });

  it('does NOT emit on button-first path (this event is edit-first only)', () => {
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      buttonPayload(REAL_USER_ID),
      { knownBotIds: KNOWN_BOTS },
    );
    const events = spy.mock.calls
      .map((call) => { try { return JSON.parse(call[0]); } catch { return null; } })
      .filter((e) => e && e.event === 'webhook_actor_missing_last_edited_by');
    expect(events).toHaveLength(0);
  });
});

// ─── U4: webhook_actor_unrecognized telemetry (first-seen-only) ──────────────

describe('classifyWebhookActor — webhook_actor_unrecognized first-seen-only (U4, R8)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits on first observation of an actor not in KNOWN_BOT_IDS', () => {
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      editPayload({ id: REAL_USER_ID }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS, route: 'date-cascade' },
    );
    const events = spy.mock.calls
      .map((call) => { try { return JSON.parse(call[0]); } catch { return null; } })
      .filter((e) => e && e.event === 'webhook_actor_unrecognized');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'webhook_actor_unrecognized',
      sourcePriority: 'edit-first',
      route: 'date-cascade',
      userIdPrefix: REAL_USER_ID.slice(0, 8),
    });
  });

  it('does NOT emit on second observation of the same actor (first-seen suppression)', () => {
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      editPayload({ id: REAL_USER_ID }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    classifyWebhookActor(
      editPayload({ id: REAL_USER_ID }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    const events = spy.mock.calls
      .map((call) => { try { return JSON.parse(call[0]); } catch { return null; } })
      .filter((e) => e && e.event === 'webhook_actor_unrecognized');
    expect(events).toHaveLength(1);
  });

  it('emits separately for each unique unrecognized actor (set is keyed per id)', () => {
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      editPayload({ id: REAL_USER_ID }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    classifyWebhookActor(
      editPayload({ id: REAL_USER_ID2 }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    const events = spy.mock.calls
      .map((call) => { try { return JSON.parse(call[0]); } catch { return null; } })
      .filter((e) => e && e.event === 'webhook_actor_unrecognized');
    expect(events).toHaveLength(2);
  });

  it('does NOT emit for a recognized engine bot (id IS in KNOWN_BOT_IDS)', () => {
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      editPayload({ id: BOT_USER_ID }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    const events = spy.mock.calls
      .map((call) => { try { return JSON.parse(call[0]); } catch { return null; } })
      .filter((e) => e && e.event === 'webhook_actor_unrecognized');
    expect(events).toHaveLength(0);
  });

  it('does NOT emit during cold-boot (empty allowlist — cold-boot guard handles drops via webhook_dropped_cold_boot instead)', () => {
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      editPayload({ id: REAL_USER_ID }),
      { sourcePriority: 'edit-first', knownBotIds: new Set() },
    );
    const events = spy.mock.calls
      .map((call) => { try { return JSON.parse(call[0]); } catch { return null; } })
      .filter((e) => e && e.event === 'webhook_actor_unrecognized');
    expect(events).toHaveLength(0);
  });

  it('emits for unrecognized actor even when type is explicitly person (catches new actors regardless of type signal)', () => {
    // Notion AI / Zapier writes may include type='person' AND not be in KNOWN_BOT_IDS;
    // surfacing them via first-seen-only telemetry lets ops notice new actors.
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      editPayload({ id: REAL_USER_ID, type: 'person' }),
      { sourcePriority: 'edit-first', knownBotIds: KNOWN_BOTS },
    );
    const events = spy.mock.calls
      .map((call) => { try { return JSON.parse(call[0]); } catch { return null; } })
      .filter((e) => e && e.event === 'webhook_actor_unrecognized');
    expect(events).toHaveLength(1);
  });

  it('does NOT emit on button-first path (this event is edit-first only)', () => {
    const spy = vi.spyOn(console, 'log');
    classifyWebhookActor(
      buttonPayload(REAL_USER_ID),
      { knownBotIds: KNOWN_BOTS },
    );
    const events = spy.mock.calls
      .map((call) => { try { return JSON.parse(call[0]); } catch { return null; } })
      .filter((e) => e && e.event === 'webhook_actor_unrecognized');
    expect(events).toHaveLength(0);
  });
});
