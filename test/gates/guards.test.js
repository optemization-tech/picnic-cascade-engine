import { describe, it, expect, beforeAll } from 'vitest';
import { parseWebhookPayload, isImportMode, isFrozen } from '../../src/gates/guards.js';
import { STUDY_TASKS_PROPS as ST } from '../../src/notion/property-names.js';
import { registerBotId } from '../../src/notion/actor-classifier.js';

// parseWebhookPayload calls classifyWebhookActor with the module-level
// KNOWN_BOT_IDS (no injection). Register a single bot id once so the steady-state
// branch (allowlist populated) is exercised rather than the cold-boot guard.
// Tests that need the cold-boot path call classifyWebhookActor directly with an
// empty injected knownBotIds option (covered in test/notion/actor-classifier.test.js).
beforeAll(() => {
  registerBotId('bot-fixture-for-guards-tests');
});

function buildPayload(overrides = {}) {
  return {
    body: {
      data: {
        id: 'task-1',
        last_edited_by: { id: 'user-1', type: 'person' },
        properties: {
          [ST.TASK_NAME.name]:           { id: ST.TASK_NAME.id,           type: 'title',    title: [{ text: { content: 'Task One' } }] },
          [ST.DATES.name]:               { id: ST.DATES.id,               type: 'date',     date: { start: '2026-04-01', end: '2026-04-02' } },
          [ST.REF_START.name]:           { id: ST.REF_START.id,           type: 'date',     date: { start: '2026-04-01' } },
          [ST.REF_END.name]:             { id: ST.REF_END.id,             type: 'date',     date: { start: '2026-04-02' } },
          [ST.STATUS.name]:              { id: ST.STATUS.id,              type: 'status',   status: { name: 'Not Started' } },
          [ST.IMPORT_MODE_ROLLUP.name]:  { id: ST.IMPORT_MODE_ROLLUP.id,  type: 'rollup',   rollup: { type: 'boolean', boolean: false } },
          [ST.STUDY.name]:               { id: ST.STUDY.id,               type: 'relation', relation: [{ id: 'study-1' }] },
          [ST.PARENT_TASK.name]:         { id: ST.PARENT_TASK.id,         type: 'relation', relation: [] },
          [ST.SUBTASKS.name]:            { id: ST.SUBTASKS.id,            type: 'relation', relation: [] },
          ...(overrides.properties || {}),
        },
      },
    },
  };
}

describe('guards parseWebhookPayload', () => {
  // @behavior BEH-GUARD-FREEZE
  it('parses core fields and deltas', () => {
    const parsed = parseWebhookPayload(buildPayload());
    expect(parsed.skip).toBe(false);
    expect(parsed.taskId).toBe('task-1');
    expect(parsed.taskName).toBe('Task One');
    expect(parsed.studyId).toBe('study-1');
    expect(parsed.startDelta).toBe(0);
    expect(parsed.endDelta).toBe(0);
  });

  it('includes mentionable and userType from classifier (U4)', () => {
    const parsed = parseWebhookPayload(buildPayload());
    expect(parsed.mentionable).toBe(true);
    expect(parsed.userType).toBe('person');
    expect(parsed.editedByBot).toBe(false);
  });

  it('handles missing page id as skip', () => {
    const parsed = parseWebhookPayload({ body: { data: { properties: {} } } });
    expect(parsed.skip).toBe(true);
  });

  // @behavior BEH-GUARD-IMPORT-MODE
  it('extracts import mode from rollup array', () => {
    const parsed = parseWebhookPayload(buildPayload({
      properties: {
        [ST.IMPORT_MODE_ROLLUP.name]: {
          id: ST.IMPORT_MODE_ROLLUP.id,
          type: 'rollup',
          rollup: { type: 'array', array: [{ checkbox: true }] },
        },
      },
    }));
    expect(parsed.importMode).toBe(true);
  });

  // @behavior BEH-GUARD-IMPORT-MODE
  it('extracts import mode from direct checkbox', () => {
    const parsed = parseWebhookPayload(buildPayload({
      properties: {
        [ST.IMPORT_MODE_ROLLUP.name]: {
          id: ST.IMPORT_MODE_ROLLUP.id,
          type: 'checkbox',
          checkbox: true,
        },
      },
    }));
    expect(parsed.importMode).toBe(true);
  });

  // @behavior BEH-GUARD-FREEZE
  it('captures frozen status from payload', () => {
    const parsed = parseWebhookPayload(buildPayload({
      properties: {
        [ST.STATUS.name]: { id: ST.STATUS.id, type: 'status', status: { name: 'Done' } },
      },
    }));
    expect(parsed.status).toBe('Done');
    expect(isFrozen(parsed)).toBe(true);
  });

  // @behavior BEH-DEBOUNCE-ECHO
  it('sets editedByBot true when last_edited_by type is bot', () => {
    const payload = buildPayload();
    payload.body.data.last_edited_by = { id: 'bot-1', type: 'bot' };
    expect(parseWebhookPayload(payload).editedByBot).toBe(true);
  });

  // @behavior BEH-DEBOUNCE-ECHO
  it('sets editedByBot false when last_edited_by type is person', () => {
    const payload = buildPayload();
    payload.body.data.last_edited_by = { id: 'user-1', type: 'person' };
    expect(parseWebhookPayload(payload).editedByBot).toBe(false);
  });

  // @behavior BEH-DEBOUNCE-ECHO
  it('sets editedByBot FALSE when last_edited_by is missing AND allowlist populated', () => {
    // Post-2026-05-12 (this plan's R3): with KNOWN_BOT_IDS populated at boot,
    // a missing last_edited_by defaults to person and mentionable=false (userId=null).
    // The cold-boot path that returns editedByBot=true is tested directly on
    // classifyWebhookActor in test/notion/actor-classifier.test.js.
    const payload = buildPayload();
    delete payload.body.data.last_edited_by;
    const parsed = parseWebhookPayload(payload);
    expect(parsed.editedByBot).toBe(false);
    expect(parsed.mentionable).toBe(false);
    expect(parsed.userId).toBe(null);
  });

  // @behavior BEH-DEBOUNCE-ECHO
  it('sets editedByBot FALSE when last_edited_by.id present but type missing AND id not in KNOWN_BOT_IDS', () => {
    // Post-2026-05-12 (this plan's R3): Notion's automation builder doesn't
    // expose `type` as a body field, so production webhooks arrive with `id`
    // only. With the bot fixture registered above, an unknown id (not in the
    // allowlist) falls through to person and the cascade proceeds.
    const payload = buildPayload();
    payload.body.data.last_edited_by = { id: 'ambiguous-id' };
    const parsed = parseWebhookPayload(payload);
    expect(parsed.editedByBot).toBe(false);
    expect(parsed.mentionable).toBe(true);
  });

  // @behavior BEH-DEBOUNCE-ECHO
  it('sets editedByBot TRUE when last_edited_by.id is in KNOWN_BOT_IDS (positive bot identification)', () => {
    // Engine echoes whose bot ids are registered at boot still drop via id-match.
    const payload = buildPayload();
    payload.body.data.last_edited_by = { id: 'bot-fixture-for-guards-tests' };
    expect(parseWebhookPayload(payload).editedByBot).toBe(true);
  });

  // @behavior BEH-DEBOUNCE-ECHO
  it('sets editedByBot true when last_edited_by.type is integration — 2026-05-07 incident fix', () => {
    const payload = buildPayload();
    payload.body.data.last_edited_by = { id: 'bot-integration-id', type: 'integration' };
    expect(parseWebhookPayload(payload).editedByBot).toBe(true);
  });

  it('passes through _replayTrustRef=true from body', () => {
    const payload = buildPayload();
    payload.body._replayTrustRef = true;
    expect(parseWebhookPayload(payload)._replayTrustRef).toBe(true);
  });

  it('defaults _replayTrustRef to false when absent', () => {
    const payload = buildPayload();
    expect(parseWebhookPayload(payload)._replayTrustRef).toBe(false);
  });

  it('coerces non-boolean truthy _replayTrustRef to true', () => {
    const payload = buildPayload();
    payload.body._replayTrustRef = 'yes';
    expect(parseWebhookPayload(payload)._replayTrustRef).toBe(true);
  });
});

describe('guards predicates', () => {
  it('import/frozen checks', () => {
    expect(isImportMode({ importMode: true })).toBe(true);
    expect(isFrozen({ status: 'Done' })).toBe(true);
    expect(isFrozen({ status: 'N/A' })).toBe(true);
    expect(isFrozen({ status: 'In Progress' })).toBe(false);
  });
});
