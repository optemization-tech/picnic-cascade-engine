import { describe, it, expect } from 'vitest';
import { humanizeNotionError, lookupDatabaseName } from '../../src/utils/humanize-error.js';

describe('lookupDatabaseName', () => {
  it('maps Study Tasks database and data source IDs to "Study Tasks"', () => {
    expect(lookupDatabaseName('40f23867-60c2-830e-aad6-8159ca69a8d6')).toBe('Study Tasks');
    expect(lookupDatabaseName('eb823867-60c2-83a6-b067-07cd54089367')).toBe('Study Tasks');
  });

  it('maps Studies, Study Blueprint, and Activity Log', () => {
    expect(lookupDatabaseName('cad23867-60c2-836f-a27d-0131c25b6dcd')).toBe('Studies');
    expect(lookupDatabaseName('8fe23867-60c2-83e9-a95d-01ade939f5c2')).toBe('Study Blueprint');
    expect(lookupDatabaseName('f5123867-60c2-8226-9d66-810554f3ec81')).toBe('Activity Log');
  });

  it('tolerates dashless and mixed-case UUIDs', () => {
    expect(lookupDatabaseName('40F2386760C2830EAAD68159CA69A8D6')).toBe('Study Tasks');
  });

  it('returns null for unknown UUIDs and empty input', () => {
    expect(lookupDatabaseName('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(lookupDatabaseName(null)).toBeNull();
    expect(lookupDatabaseName('')).toBeNull();
  });
});

describe('humanizeNotionError', () => {
  it('rewrites the 404 not-shared pattern on a known database ID', () => {
    const error = new Error(
      'Notion API 404 Not Found: Could not find database with ID: eb823867-60c2-83a6-b067-07cd54089367. Make sure the relevant pages and databases are shared with your integration "Cascade Engine Token 4".',
    );
    expect(humanizeNotionError(error)).toBe(
      'Study Tasks database is not shared with integration "Cascade Engine Token 4".',
    );
  });

  it('rewrites page and block not-found patterns', () => {
    const pageErr = new Error(
      'Notion API 404 Not Found: Could not find page with ID: 34b23867-60c2-8087-8951-d0e05823a0c7. Make sure the relevant pages and databases are shared with your integration "Cascade Engine Token 2".',
    );
    expect(humanizeNotionError(pageErr)).toBe(
      'A page is not shared with integration "Cascade Engine Token 2".',
    );
  });

  it('falls through to the raw message when the pattern does not match', () => {
    expect(humanizeNotionError(new Error('validation_error: body.filter is invalid'))).toBe(
      'validation_error: body.filter is invalid',
    );
  });

  it('handles null, undefined, and plain strings', () => {
    expect(humanizeNotionError(null)).toBe('Unknown error');
    expect(humanizeNotionError(undefined)).toBe('Unknown error');
    expect(humanizeNotionError('plain string error')).toBe('plain string error');
  });

  it('keeps the integration name verbatim with single or double quotes', () => {
    const single = new Error(
      "Could not find database with ID: eb823867-60c2-83a6-b067-07cd54089367. Make sure the relevant pages and databases are shared with your integration 'Cascade Engine Token 4'.",
    );
    expect(humanizeNotionError(single)).toBe(
      'Study Tasks database is not shared with integration "Cascade Engine Token 4".',
    );
  });
});
