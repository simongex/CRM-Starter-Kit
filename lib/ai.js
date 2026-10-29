export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

/* Anthropic reports a missing model as "model: claude-…". The screen should name it plainly. */
export function anthropicErrorMessage(data, status) {
  const message = String(data?.error?.message || '').trim();
  const type = String(data?.error?.type || '');
  const missingModel = /^model\s*:/i.test(message)
    || (/model/i.test(message) && /not found|does not exist|invalid/i.test(message))
    || (type === 'not_found_error' && /model/i.test(message));
  if (missingModel) return `AI model unavailable: ${ANTHROPIC_MODEL}`;
  return message || `Anthropic ${status}`;
}
