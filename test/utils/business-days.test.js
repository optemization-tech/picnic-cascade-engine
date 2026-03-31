import { describe, it, expect } from 'vitest';
import {
  parseDate,
  formatDate,
  isBusinessDay,
  nextBusinessDay,
  prevBusinessDay,
  addBusinessDays,
  countBDInclusive,
  signedBDDelta,
} from '../../src/utils/business-days.js';

// Helper: create UTC date for a known day
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));

// 2026-03-30 = Monday, 2026-03-31 = Tuesday, ... 2026-04-03 = Friday
// 2026-04-04 = Saturday, 2026-04-05 = Sunday, 2026-04-06 = Monday
const MON = utc(2026, 3, 30);
const TUE = utc(2026, 3, 31);
const WED = utc(2026, 4, 1);
const THU = utc(2026, 4, 2);
const FRI = utc(2026, 4, 3);
const SAT = utc(2026, 4, 4);
const SUN = utc(2026, 4, 5);
const NEXT_MON = utc(2026, 4, 6);
const NEXT_TUE = utc(2026, 4, 7);
const NEXT_FRI = utc(2026, 4, 10);

describe('parseDate', () => {
  it('parses YYYY-MM-DD to UTC midnight', () => {
    const d = parseDate('2026-03-30');
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(2); // 0-indexed
    expect(d.getUTCDate()).toBe(30);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
  });

  it('returns null for falsy input', () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate('')).toBeNull();
  });

  it('does not produce local timezone offset', () => {
    // The whole point: '2026-01-15' should be Jan 15 UTC, not Jan 14 or Jan 16
    const d = parseDate('2026-01-15');
    expect(d.getUTCDate()).toBe(15);
  });
});

describe('formatDate', () => {
  it('formats UTC Date to YYYY-MM-DD', () => {
    expect(formatDate(utc(2026, 3, 30))).toBe('2026-03-30');
    expect(formatDate(utc(2026, 1, 5))).toBe('2026-01-05');
  });
});

describe('isBusinessDay', () => {
  it('Monday is a business day', () => {
    expect(isBusinessDay(MON)).toBe(true);
  });

  it('Friday is a business day', () => {
    expect(isBusinessDay(FRI)).toBe(true);
  });

  it('Saturday is not a business day', () => {
    expect(isBusinessDay(SAT)).toBe(false);
  });

  it('Sunday is not a business day', () => {
    expect(isBusinessDay(SUN)).toBe(false);
  });

  it('all weekdays are business days', () => {
    expect(isBusinessDay(TUE)).toBe(true);
    expect(isBusinessDay(WED)).toBe(true);
    expect(isBusinessDay(THU)).toBe(true);
  });
});

describe('nextBusinessDay', () => {
  it('Friday → Monday', () => {
    expect(formatDate(nextBusinessDay(FRI))).toBe(formatDate(NEXT_MON));
  });

  it('Saturday → Monday', () => {
    expect(formatDate(nextBusinessDay(SAT))).toBe(formatDate(NEXT_MON));
  });

  it('Sunday → Monday', () => {
    expect(formatDate(nextBusinessDay(SUN))).toBe(formatDate(NEXT_MON));
  });

  it('Wednesday → Thursday (weekday advances 1 day)', () => {
    expect(formatDate(nextBusinessDay(WED))).toBe(formatDate(THU));
  });
});

describe('prevBusinessDay', () => {
  it('Monday → previous Friday', () => {
    // NEXT_MON (April 6) → Friday (April 3)
    expect(formatDate(prevBusinessDay(NEXT_MON))).toBe(formatDate(FRI));
  });

  it('Saturday → Friday', () => {
    expect(formatDate(prevBusinessDay(SAT))).toBe(formatDate(FRI));
  });

  it('Sunday → Friday', () => {
    expect(formatDate(prevBusinessDay(SUN))).toBe(formatDate(FRI));
  });

  it('Wednesday → Tuesday', () => {
    expect(formatDate(prevBusinessDay(WED))).toBe(formatDate(TUE));
  });
});

describe('addBusinessDays', () => {
  it('Friday + 1 BD = Monday', () => {
    expect(formatDate(addBusinessDays(FRI, 1))).toBe(formatDate(NEXT_MON));
  });

  it('Monday - 1 BD = previous Friday', () => {
    // NEXT_MON (April 6) - 1 BD = Friday (April 3)
    expect(formatDate(addBusinessDays(NEXT_MON, -1))).toBe(formatDate(FRI));
  });

  it('Monday + 5 BD = next Monday', () => {
    // Mon Mar 30 + 5 BD = Mon Apr 6
    expect(formatDate(addBusinessDays(MON, 5))).toBe(formatDate(NEXT_MON));
  });

  it('count 0 on weekday returns same date', () => {
    expect(formatDate(addBusinessDays(WED, 0))).toBe(formatDate(WED));
  });

  it('count 0 on Saturday snaps to Monday (zero-offset weekend bug fix)', () => {
    const result = addBusinessDays(SAT, 0);
    expect(isBusinessDay(result)).toBe(true);
    expect(formatDate(result)).toBe(formatDate(NEXT_MON));
  });

  it('count 0 on Sunday snaps to Monday', () => {
    const result = addBusinessDays(SUN, 0);
    expect(isBusinessDay(result)).toBe(true);
    expect(formatDate(result)).toBe(formatDate(NEXT_MON));
  });

  it('Monday + 2 BD = Wednesday', () => {
    expect(formatDate(addBusinessDays(MON, 2))).toBe(formatDate(WED));
  });

  it('Friday - 4 BD = Monday', () => {
    expect(formatDate(addBusinessDays(FRI, -4))).toBe(formatDate(MON));
  });
});

describe('countBDInclusive', () => {
  it('Mon to Fri = 5 business days', () => {
    expect(countBDInclusive(MON, FRI)).toBe(5);
  });

  it('Mon to next Mon (across weekend) = 6 business days', () => {
    expect(countBDInclusive(MON, NEXT_MON)).toBe(6);
  });

  it('same day = 1', () => {
    expect(countBDInclusive(WED, WED)).toBe(1);
  });

  it('end before start returns 1 (minimum)', () => {
    expect(countBDInclusive(FRI, MON)).toBe(1);
  });

  it('null start returns 1', () => {
    expect(countBDInclusive(null, FRI)).toBe(1);
  });

  it('null end returns 1', () => {
    expect(countBDInclusive(MON, null)).toBe(1);
  });

  it('Mon to next Tue = 7 business days', () => {
    expect(countBDInclusive(MON, NEXT_TUE)).toBe(7);
  });

  it('Mon to next Fri = 10 business days (2 full weeks)', () => {
    expect(countBDInclusive(MON, NEXT_FRI)).toBe(10);
  });
});

describe('signedBDDelta', () => {
  it('same day = 0', () => {
    expect(signedBDDelta(WED, WED)).toBe(0);
  });

  it('accepts YYYY-MM-DD string inputs', () => {
    expect(signedBDDelta('2026-03-30', '2026-04-03')).toBe(4);
    expect(signedBDDelta('2026-04-06', '2026-04-03')).toBe(-1);
  });

  it('null inputs = 0', () => {
    expect(signedBDDelta(null, WED)).toBe(0);
    expect(signedBDDelta(WED, null)).toBe(0);
    expect(signedBDDelta(null, null)).toBe(0);
  });

  it('positive: Mon to Fri = +5', () => {
    expect(signedBDDelta(MON, NEXT_MON)).toBe(5);
  });

  it('positive: Mon to Wed = +2', () => {
    expect(signedBDDelta(MON, WED)).toBe(2);
  });

  it('negative: Fri to Mon = -5', () => {
    expect(signedBDDelta(NEXT_MON, MON)).toBe(-5);
  });

  it('negative: Wed to Mon = -2', () => {
    expect(signedBDDelta(WED, MON)).toBe(-2);
  });

  it('across weekend: Fri to next Mon = +1', () => {
    expect(signedBDDelta(FRI, NEXT_MON)).toBe(1);
  });

  it('across weekend backward: next Mon to Fri = -1', () => {
    expect(signedBDDelta(NEXT_MON, FRI)).toBe(-1);
  });

  it('adjacent weekdays: Mon to Tue = +1', () => {
    expect(signedBDDelta(MON, TUE)).toBe(1);
  });

  it('two full weeks: Mon to next Fri = +9', () => {
    // Mon(1), Tue(2), Wed(3), Thu(4), Fri(5), Mon(6), Tue(7), Wed(8), Thu(9), [Fri=target, not counted because delta counts steps TO target]
    // Actually let me recalculate:
    // From Mon Mar 30 to Fri Apr 10
    // Steps: Tue(1), Wed(2), Thu(3), Fri(4), Mon(5), Tue(6), Wed(7), Thu(8), Fri(9)
    expect(signedBDDelta(MON, NEXT_FRI)).toBe(9);
  });
});
