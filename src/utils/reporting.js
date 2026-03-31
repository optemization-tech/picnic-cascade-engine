const LEVEL_COLOR = {
  info: 'blue_background',
  success: 'green_background',
  warning: 'yellow_background',
  error: 'red_background',
};

const LEVEL_PREFIX = {
  info: '🆕',
  success: '❇️',
  warning: '⚠️',
  error: '❌',
};

export function buildReportingText(level, message) {
  const normalizedLevel = LEVEL_COLOR[level] ? level : 'info';
  const color = LEVEL_COLOR[normalizedLevel];
  const prefix = LEVEL_PREFIX[normalizedLevel];
  const content = `${prefix} ${String(message || '').slice(0, 2000)}`;
  return [{
    type: 'text',
    text: { content },
    annotations: { color },
  }];
}
