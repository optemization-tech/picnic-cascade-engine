import { describe, it, expect } from 'vitest';
import { buildReportingText } from '../../src/utils/reporting.js';

// @behavior BEH-AUTOMATION-REPORTING
describe('buildReportingText', () => {
  it('formats info, success, warning, and error levels with prefixes', () => {
    const info = buildReportingText('info', 'Info message');
    const success = buildReportingText('success', 'Success message');
    const warning = buildReportingText('warning', 'Warning message');
    const error = buildReportingText('error', 'Error message');

    expect(info[0].text.content.startsWith('🆕')).toBe(true);
    expect(success[0].text.content.startsWith('❇️')).toBe(true);
    expect(warning[0].text.content.startsWith('⚠️')).toBe(true);
    expect(error[0].text.content.startsWith('❌')).toBe(true);
  });

  it('falls back to info level for unknown levels', () => {
    const payload = buildReportingText('mystery-level', 'Message');
    expect(payload[0].annotations.color).toBe('blue_background');
    expect(payload[0].text.content.startsWith('🆕')).toBe(true);
  });
});
