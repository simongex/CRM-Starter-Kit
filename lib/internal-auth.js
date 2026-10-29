export const SESSION_MAX_SECONDS = 12 * 60 * 60;
export const SESSION_SECONDS = SESSION_MAX_SECONDS;
export const EMAIL_DOMAIN = 'example.org';
export const PASSWORD_KEY = 'kb:internal-passwords';
const PBKDF2_ITERATIONS = 100_000;
const SESSION_EPOCH_PREFIX = 'kb:session-epoch:';
const LOGIN_FAIL_PREFIX = 'kb:login-fail:';
const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;

/* Cookies are signed only with a dedicated secret. Falling back to the
   password list would let anyone who can read INTERNAL_USERS forge a session. */
export function sessionSecret() {
  return process.env.INTERNAL_SESSION_SECRET || '';
}

export function kvStore() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

export async function kvCommand(target, args) {
  const response = await fetch(target.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  if (!response.ok) throw new Error(`store responded ${response.status}`);
  const data = await response.json();
  return data.result;
}

export function parseIdentity(input) {
  let raw = String(input || '').trim().toLowerCase();
  if (raw.includes('@')) raw = raw.slice(0, raw.indexOf('@'));
  raw = raw.replace(/[^a-z0-9._-]/g, '');
  return {
    user: raw,
    email: raw ? `${raw}@${EMAIL_DOMAIN}` : ''
  };
}

export function envUsers() {
  return (process.env.INTERNAL_USERS || '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf(':');
      return { user: pair.slice(0, at).trim().toLowerCase(), password: pair.slice(at + 1) };
    })
    .filter((entry) => entry.user && entry.password);
}

export function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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

export async function sign(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return b64url(new Uint8Array(mac));
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

export function isSecure(request) {
  if (request.headers.get('x-forwarded-proto') === 'https') return true;
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return true;
  }
}

function cookieBase(request, maxAge) {
  return `Path=/; Max-Age=${maxAge}; SameSite=Lax${isSecure(request) ? '; Secure' : ''}`;
}

export async function sessionCookies(request, identity) {
  const secret = sessionSecret();
  const now = Date.now();
  const iat = Number(identity.iat) || now;
  const absoluteEnd = iat + SESSION_MAX_SECONDS * 1000;
  if (!secret || now >= absoluteEnd) return expiredCookies(request);
  const exp = Math.min(now + SESSION_SECONDS * 1000, absoluteEnd);
  const maxAge = Math.max(1, Math.ceil((exp - now) / 1000));
  const payload = b64url(
    new TextEncoder().encode(JSON.stringify({
      u: identity.user,
      email: identity.email,
      iat,
      e: exp
    }))
  );
  const token = `${payload}.${await sign(payload, secret)}`;
  const base = cookieBase(request, maxAge);
  return [
    `kb_session=${token}; HttpOnly; ${base}`,
    `kb_user=${encodeURIComponent(identity.user)}; ${base}`,
    `kb_email=${encodeURIComponent(identity.email)}; ${base}`
  ];
}

export function expiredCookies(request) {
  const base = cookieBase(request, 0);
  return [
    `kb_session=; HttpOnly; ${base}`,
    `kb_user=; ${base}`,
    `kb_email=; ${base}`
  ];
}

export async function readSession(request) {
  const secret = sessionSecret();
  const token = readCookie(request, 'kb_session');
  if (!secret || !token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  if (!sameString(await sign(payload, secret), signature)) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    const now = Date.now();
    if (typeof claims.e !== 'number' || claims.e <= now) return null;
    if (claims.e - now > SESSION_SECONDS * 1000 + 10_000) return null;
    if (typeof claims.iat !== 'number' || claims.iat > now + 10_000) return null;
    if (now - claims.iat >= SESSION_MAX_SECONDS * 1000) return null;
    if (claims.e > claims.iat + SESSION_MAX_SECONDS * 1000 + 10_000) return null;
    const identity = parseIdentity(claims.email || claims.u || '');
    if (!identity.user) return null;
    if (!(await sessionEpochAllows(identity.user, claims.iat))) return null;
    return { ...identity, iat: claims.iat };
  } catch {
    return null;
  }
}

/* Logout and password changes move this timestamp forward. A cookie issued
   before it is rejected, including copies that were stolen earlier. */
export async function revokeSessions(user) {
  const target = kvStore();
  if (!target || !user) return;
  await kvCommand(target, ['SET', SESSION_EPOCH_PREFIX + user, String(Date.now())]);
}

async function sessionEpochAllows(user, iat) {
  const target = kvStore();
  if (!target) return true;
  try {
    const raw = await kvCommand(target, ['GET', SESSION_EPOCH_PREFIX + user]);
    if (raw == null || raw === '') return true;
    const since = Number(raw);
    return Number.isFinite(since) && iat >= since;
  } catch {
    return false;
  }
}

export function clientIp(request) {
  const real = (request.headers.get('x-real-ip') || '').trim();
  const forwarded = request.headers.get('x-forwarded-for') || '';
  const raw = real || forwarded.split(',')[0].trim();
  return raw.replace(/[^a-zA-Z0-9.:]/g, '').slice(0, 80);
}

function loginFailureKeys(user, ip) {
  const keys = [`${LOGIN_FAIL_PREFIX}user:${user}`];
  if (ip) keys.push(`${LOGIN_FAIL_PREFIX}ip:${ip}`);
  return keys;
}

export async function loginBlocked(user, ip) {
  const target = kvStore();
  if (!target) return false;
  for (const key of loginFailureKeys(user, ip)) {
    const count = Number(await kvCommand(target, ['GET', key]) || 0);
    if (count >= LOGIN_ATTEMPT_LIMIT) return true;
  }
  return false;
}

export async function recordLoginFailure(user, ip) {
  const target = kvStore();
  if (!target) return;
  for (const key of loginFailureKeys(user, ip)) {
    const count = Number(await kvCommand(target, ['INCR', key]));
    if (count === 1) {
      await kvCommand(target, ['EXPIRE', key, String(LOGIN_WINDOW_SECONDS)]);
    } else {
      const ttl = Number(await kvCommand(target, ['TTL', key]));
      if (ttl < 0) await kvCommand(target, ['EXPIRE', key, String(LOGIN_WINDOW_SECONDS)]);
    }
  }
}

export async function clearLoginFailures(user) {
  const target = kvStore();
  if (!target || !user) return;
  await kvCommand(target, ['DEL', `${LOGIN_FAIL_PREFIX}user:${user}`]);
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await derive(password, salt, PBKDF2_ITERATIONS);
  return { salt: b64url(salt), hash: b64url(digest), iter: PBKDF2_ITERATIONS };
}

export async function verifyStoredPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const iterations = Number(record.iter) || PBKDF2_ITERATIONS;
  const digest = await derive(password, fromB64url(record.salt), iterations);
  return sameString(b64url(digest), String(record.hash));
}

export async function loadPasswordMap() {
  const target = kvStore();
  if (!target) return {};
  const raw = await kvCommand(target, ['GET', PASSWORD_KEY]);
  if (!raw) return {};
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return data && typeof data === 'object' ? data : {};
}

export async function savePasswordMap(map) {
  const target = kvStore();
  if (!target) throw new Error('Shared storage is not configured');
  await kvCommand(target, ['SET', PASSWORD_KEY, JSON.stringify(map)]);
}

export async function passwordMatches(user, password) {
  const map = await loadPasswordMap();
  if (map[user]) return verifyStoredPassword(password, map[user]);

  const match = envUsers().find((entry) => entry.user === user);
  return match ? sameString(match.password, password) : false;
}

export const MANAGERS = ['alex', 'sam'];
export const ACCOUNTS = ['alex', 'sam', 'jordan', 'taylor', 'robin', 'casey', 'morgan'];

/* Programme coordinators see a named team plus every task in named categories,
   and they can take ownership of those tasks. They are not managers. */
export const COORDINATORS = {
  morgan: {
    owners: ['morgan', 'robin', 'casey'],
    categories: [
      'Logistics',
      'Exhibition & Residencies',
      'Archive & Documentation',
      'PR / Media',
      'SMM / Content',
      'SMM / Website',
      'Programme Coordination'
    ]
  }
};

/* Collaborators who share each other's tasks and actions, without extra edit rights. */
export const PEERS = {
  robin: ['casey'],
  casey: ['robin']
};

/* Managers see the whole programme and the CRM; everyone else is a collaborator. */
export function isManager(user) {
  return MANAGERS.includes(String(user || '').trim().toLowerCase());
}

export function coordinatorScope(user) {
  return COORDINATORS[String(user || '').trim().toLowerCase()] || null;
}

export function peerLogins(user) {
  return PEERS[String(user || '').trim().toLowerCase()] || [];
}

function foldCategory(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function taskInCategories(task, phases, names) {
  const folded = new Set((names || []).map(foldCategory));
  const phase = (phases || []).find((item) => item.id === task?.phaseId);
  return Boolean(foldCategory(phase?.name) && folded.has(foldCategory(phase?.name)));
}

/* Mirrors selfOwnerKey() in the internal app: something belongs to a collaborator
   when its owner field contains the first word of the login, e.g. "taylor". */
function ownerFieldMatches(user, owner) {
  const first = String(user || '').toLowerCase().split(/[^a-z]+/).find(Boolean) || '';
  if (!first) return false;
  return new RegExp(`\\b${first}\\b`, 'i').test(String(owner || ''));
}

export function ownsTask(user, task) {
  return ownerFieldMatches(user, task?.owner);
}

/* An action without its own owner belongs to the task owner. */
export function ownsAction(user, task, action) {
  return ownerFieldMatches(user, action?.owner || task?.owner);
}

function heldBy(user, task) {
  return ownsTask(user, task) || (task?.actions || []).some((action) => ownsAction(user, task, action));
}

export function overseesTask(user, task, phases) {
  const scope = coordinatorScope(user);
  if (!scope) return false;
  const login = String(user || '').trim().toLowerCase();
  const others = scope.owners.filter((owner) => owner !== login);
  if (others.some((owner) => heldBy(owner, task))) return true;
  return taskInCategories(task, phases, scope.categories);
}

export function sharesTask(user, task) {
  return peerLogins(user).some((peer) => heldBy(peer, task));
}

export function seesTask(user, task, phases) {
  if (heldBy(user, task)) return true;
  if (sharesTask(user, task)) return true;
  return overseesTask(user, task, phases);
}

export function knownAccount(user) {
  const id = String(user || '').trim().toLowerCase();
  return ACCOUNTS.includes(id) || envUsers().some((entry) => entry.user === id);
}

export function json(body, status, cookies) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });
  (cookies || []).forEach((cookie) => headers.append('Set-Cookie', cookie));
  return new Response(JSON.stringify(body), { status, headers });
}
