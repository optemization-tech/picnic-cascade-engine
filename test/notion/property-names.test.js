import { describe, it, expect } from 'vitest';
import {
  STUDY_TASKS_PROPS,
  STUDIES_PROPS,
  BLUEPRINT_PROPS,
  ACTIVITY_LOG_PROPS,
  findById,
} from '../../src/notion/property-names.js';

const PROP_GROUPS = {
  STUDY_TASKS_PROPS,
  STUDIES_PROPS,
  BLUEPRINT_PROPS,
  ACTIVITY_LOG_PROPS,
};

describe('property-names constants', () => {
  for (const [groupName, group] of Object.entries(PROP_GROUPS)) {
    describe(groupName, () => {
      it('every constant has a non-empty .name and .id', () => {
        for (const [key, def] of Object.entries(group)) {
          expect(def, `${groupName}.${key} is undefined`).toBeDefined();
          expect(typeof def.name, `${groupName}.${key}.name is not a string`).toBe('string');
          expect(def.name.length, `${groupName}.${key}.name is empty`).toBeGreaterThan(0);
          expect(typeof def.id, `${groupName}.${key}.id is not a string`).toBe('string');
          expect(def.id.length, `${groupName}.${key}.id is empty`).toBeGreaterThan(0);
        }
      });

      it('no two constants share a name', () => {
        const seen = new Map();
        for (const [key, def] of Object.entries(group)) {
          if (seen.has(def.name)) {
            throw new Error(
              `${groupName}: name '${def.name}' duplicated by ${seen.get(def.name)} and ${key}`,
            );
          }
          seen.set(def.name, key);
        }
        expect(seen.size).toBe(Object.keys(group).length);
      });

      it('no two constants share an id', () => {
        const seen = new Map();
        for (const [key, def] of Object.entries(group)) {
          if (seen.has(def.id)) {
            throw new Error(
              `${groupName}: id '${def.id}' duplicated by ${seen.get(def.id)} and ${key}`,
            );
          }
          seen.set(def.id, key);
        }
        expect(seen.size).toBe(Object.keys(group).length);
      });
    });
  }
});

describe('findById', () => {
  const propDef = { id: 'Q%5E%7C%3C' };

  it('returns the matching property when found', () => {
    const page = {
      properties: {
        'Some Other Prop': { id: 'XYZ', type: 'rich_text', rich_text: [] },
        '[Do Not Edit] Reference Start Date': {
          id: 'Q%5E%7C%3C',
          type: 'date',
          date: { start: '2026-04-28' },
        },
      },
    };
    const found = findById(page, propDef);
    expect(found).toBeDefined();
    expect(found.id).toBe('Q%5E%7C%3C');
    expect(found.date.start).toBe('2026-04-28');
  });

  it('returns undefined when no property matches the id', () => {
    const page = {
      properties: {
        'Other Prop': { id: 'AAAA', type: 'rich_text', rich_text: [] },
      },
    };
    expect(findById(page, propDef)).toBeUndefined();
  });

  it('returns undefined for null page', () => {
    expect(findById(null, propDef)).toBeUndefined();
  });

  it('returns undefined for undefined page', () => {
    expect(findById(undefined, propDef)).toBeUndefined();
  });

  it('returns undefined for page with no properties field', () => {
    expect(findById({}, propDef)).toBeUndefined();
  });

  it('returns undefined for page with empty properties object', () => {
    expect(findById({ properties: {} }, propDef)).toBeUndefined();
  });

  it('works with a constant from STUDY_TASKS_PROPS', () => {
    const page = {
      properties: {
        '[Do Not Edit] Reference Start Date': {
          id: STUDY_TASKS_PROPS.REF_START.id,
          type: 'date',
          date: { start: '2026-04-28' },
        },
      },
    };
    const found = findById(page, STUDY_TASKS_PROPS.REF_START);
    expect(found?.date?.start).toBe('2026-04-28');
  });

  it('rename-immune: matches by id even when response key (name) differs', () => {
    // Simulates a Notion rename where the response's name-key has changed
    // but the id on the value is the same. findById should still resolve.
    const page = {
      properties: {
        'Some Future Renamed Name': {
          id: STUDY_TASKS_PROPS.REF_START.id,
          type: 'date',
          date: { start: '2026-04-28' },
        },
      },
    };
    const found = findById(page, STUDY_TASKS_PROPS.REF_START);
    expect(found?.date?.start).toBe('2026-04-28');
  });
});
