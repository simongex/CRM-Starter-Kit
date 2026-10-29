import { kvCommand, kvStore } from './internal-auth.js';

export const RESET_SECONDS = 30 * 60;
const RESET_PREFIX = 'kb:pwreset:';
const THROTTLE_PREFIX = 'kb:pwreset-throttle:';
const THROTTLE_SECONDS = 60;

function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function tokenKey(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  return RESET_PREFIX + b64url(new Uint8Array(digest));
}

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

/* Returns false when a link was already sent to this user in the last minute. */
export async function claimResetSlot(user) {
  const target = kvStore();
  const result = await kvCommand(target, ['SET', THROTTLE_PREFIX + user, '1', 'EX', String(THROTTLE_SECONDS), 'NX']);
  return result === 'OK';
}

/* Only a hash of the token is stored, so a database leak does not expose live links. */
export async function createResetToken(user) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await kvCommand(kvStore(), ['SET', await tokenKey(token), user, 'EX', String(RESET_SECONDS)]);
  return token;
}

export async function consumeResetToken(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return '';
  const user = await kvCommand(kvStore(), ['GETDEL', await tokenKey(token)]);
  return typeof user === 'string' ? user : '';
}

export function siteOrigin(request) {
  const configured = String(process.env.SITE_URL || '').replace(/\/+$/, '');
  return configured || new URL(request.url).origin;
}

export async function sendResetEmail(to, link) {
  const from = process.env.RESET_EMAIL_FROM || 'YourOrg <no-reply@example.org>';
  const minutes = RESET_SECONDS / 60;
  const text = [
    'Someone asked to set a new password for your YourOrg internal workspace account.',
    '',
    `Open this link within ${minutes} minutes to choose a new password:`,
    link,
    '',
    'The link works once. If you did not ask for this, you can ignore this email; your password stays the same.'
  ].join('\n');
  const html = `
    <div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">
      <p>Someone asked to set a new password for your YourOrg internal workspace account.</p>
      <p>Open this link within ${minutes} minutes to choose a new password:</p>
      <p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#000;color:#fff;text-decoration:none;font-weight:700">Set a new password</a></p>
      <p style="color:#666;font-size:13px">The link works once. If you did not ask for this, you can ignore this email; your password stays the same.</p>
    </div>`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to: [to], subject: 'Set a new YourOrg password', text, html })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`email provider responded ${response.status} ${detail.slice(0, 200)}`);
  }
}
