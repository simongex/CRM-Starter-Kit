export const config = { runtime: 'edge' };

import {
  json,
  kvStore,
  readSession,
  sameString,
  sessionSecret,
  sign
} from '../lib/internal-auth.js';
import { integrationStatus } from '../lib/contacts.js';
import {
  accountForUser,
  exchangeGmailCode,
  gmailAuthUrl,
  gmailProfile,
  loadGmailTokens,
  requestOrigin,
  saveGmailTokens
} from '../lib/contact-integrations.js';

function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' }
  });
}

async function makeState(user) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    u: user,
    e: Date.now() + 10 * 60 * 1000
  })));
  return `${payload}.${await sign(payload, sessionSecret())}`;
}

async function readState(value) {
  const token = String(value || '');
  if (!token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  if (!sameString(await sign(payload, sessionSecret()), signature)) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    if (typeof claims.e !== 'number' || claims.e <= Date.now()) return null;
    return String(claims.u || '');
  } catch {
    return null;
  }
}

export default async function handler(request) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const url = new URL(request.url);
  const code = url.searchParams.get('code') || '';
  const oauthState = url.searchParams.get('state') || '';
  const oauthError = url.searchParams.get('error') || '';
  const home = `${requestOrigin(request)}/internal/contacts`;

  if (oauthError) {
    return redirect(`${home}?gmail=error`);
  }

  if (code) {
    const user = await readState(oauthState);
    if (!user) return redirect(`${home}?gmail=error`);
    const target = kvStore();
    if (!target) return redirect(`${home}?gmail=error`);
    try {
      const tokens = await exchangeGmailCode(code, request);
      const profile = await gmailProfile(tokens.access_token);
      const map = await loadGmailTokens(target);
      map[user] = {
        refresh_token: tokens.refresh_token || map[user]?.refresh_token || '',
        access_token: tokens.access_token,
        expiry: Date.now() + (Number(tokens.expires_in) || 3500) * 1000,
        email: profile.email || ''
      };
      if (!map[user].refresh_token) {
        return redirect(`${home}?gmail=error`);
      }
      await saveGmailTokens(target, map);
      return redirect(`${home}?gmail=connected`);
    } catch {
      return redirect(`${home}?gmail=error`);
    }
  }

  const identity = await readSession(request);
  if (!identity) return json({ error: 'Not signed in' }, 401);

  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    return json({ error: 'Gmail is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET.' }, 501);
  }

  const target = kvStore();
  if (!target) return json({ error: 'Shared storage is not configured' }, 501);

  if (url.searchParams.get('status')) {
    const tokens = await loadGmailTokens(target);
    return json({ integrations: integrationStatus(accountForUser(tokens, identity.user)) });
  }

  if (url.searchParams.get('disconnect')) {
    const tokens = await loadGmailTokens(target);
    delete tokens[identity.user];
    await saveGmailTokens(target, tokens);
    return json({ ok: true, integrations: integrationStatus(null) });
  }

  const state = await makeState(identity.user);
  return redirect(gmailAuthUrl(state, request));
}
