export const config = { runtime: 'edge' };

import { json, kvCommand, kvStore, readSession } from '../lib/internal-auth.js';

const PROFILES_KEY = 'kb:profiles';
const FIELDS = ['name', 'email', 'role', 'team'];

function normalizeProfile(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const profile = {};
  for (const field of FIELDS) {
    if (typeof src[field] === 'string') profile[field] = src[field].trim().slice(0, 120);
  }
  if (profile.email) profile.email = profile.email.toLowerCase();
  return profile;
}

export default async function handler(request) {
  const identity = await readSession(request);
  if (!identity) return json({ error: 'Not signed in' }, 401);

  const target = kvStore();
  if (!target) return json({ error: 'Shared storage is not configured' }, 501);

  try {
    if (request.method === 'GET') {
      const raw = await kvCommand(target, ['HGET', PROFILES_KEY, identity.user]);
      return json({ profile: normalizeProfile(raw ? JSON.parse(raw) : {}) }, 200);
    }

    if (request.method !== 'PUT' && request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Bad request' }, 400);
    }
    const profile = normalizeProfile(body.profile);
    if (profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) {
      return json({ error: 'That email address does not look right.' }, 400);
    }
    await kvCommand(target, ['HSET', PROFILES_KEY, identity.user, JSON.stringify(profile)]);
    return json({ profile }, 200);
  } catch (error) {
    console.error(error);
    return json({ error: 'Could not update the profile. Try again.' }, 502);
  }
}
