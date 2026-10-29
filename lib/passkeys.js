import {
  knownAccount,
  kvCommand,
  kvStore,
  loadPasswordMap,
  parseIdentity
} from './internal-auth.js';

const CHALLENGE_PREFIX = 'kb:passkey-challenge:';
const CRED_PREFIX = 'kb:passkey:';
const USER_PREFIX = 'kb:passkey-user:';
const CHALLENGE_TTL = 300;
const MAX_PER_USER = 8;

export class PasskeyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function bytesToB64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToB64url(bytes);
}

function validId(value) {
  return /^[A-Za-z0-9_-]{16,200}$/.test(String(value || ''));
}

function sameText(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function store() {
  const target = kvStore();
  if (!target) throw new PasskeyError('Passkeys are not available until the shared database is connected.', 503);
  return target;
}

export function relyingParty(request) {
  const url = new URL(request.url);
  const forwardedHost = (request.headers.get('x-forwarded-host') || '').split(',')[0].trim();
  const host = forwardedHost || request.headers.get('host') || url.host;
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  const proto = (request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')).split(',')[0].trim();
  return { rpId: hostname, origin: `${proto}://${host}`, name: 'YourOrg' };
}

function decodeCbor(bytes, offset = 0) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const read = (pos) => {
    if (pos >= view.length) throw new PasskeyError('Could not read this device key.', 400);
    const initial = view[pos];
    const major = initial >> 5;
    const info = initial & 31;
    pos += 1;
    let length = info;
    if (info >= 24) {
      const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
      if (!width) throw new PasskeyError('Could not read this device key.', 400);
      length = 0;
      for (let i = 0; i < width; i += 1) length = length * 256 + view[pos + i];
      pos += width;
    }
    if (major === 0) return { value: length, pos };
    if (major === 1) return { value: -1 - length, pos };
    if (major === 2 || major === 3) {
      const slice = view.slice(pos, pos + length);
      const value = major === 2 ? slice : new TextDecoder().decode(slice);
      return { value, pos: pos + length };
    }
    if (major === 4) {
      const items = [];
      for (let i = 0; i < length; i += 1) {
        const item = read(pos);
        items.push(item.value);
        pos = item.pos;
      }
      return { value: items, pos };
    }
    if (major === 5) {
      const map = new Map();
      for (let i = 0; i < length; i += 1) {
        const key = read(pos);
        const item = read(key.pos);
        map.set(key.value, item.value);
        pos = item.pos;
      }
      return { value: map, pos };
    }
    throw new PasskeyError('Could not read this device key.', 400);
  };
  return read(offset);
}

function parseAuthData(authData) {
  if (!(authData instanceof Uint8Array) || authData.length < 37) {
    throw new PasskeyError('Could not read this device key.', 400);
  }
  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const signCount = authData[33] * 16777216 + (authData[34] << 16) + (authData[35] << 8) + authData[36];
  const parsed = {
    rpIdHash,
    signCount,
    up: Boolean(flags & 1),
    uv: Boolean(flags & 4)
  };
  if (flags & 0x40) {
    if (authData.length < 55) throw new PasskeyError('Could not read this device key.', 400);
    const idLen = (authData[53] << 8) + authData[54];
    const idStart = 55;
    if (authData.length < idStart + idLen) throw new PasskeyError('Could not read this device key.', 400);
    parsed.credentialId = authData.slice(idStart, idStart + idLen);
    parsed.cose = decodeCbor(authData, idStart + idLen).value;
  }
  return parsed;
}

function coseToJwk(cose) {
  if (!(cose instanceof Map)) throw new PasskeyError('This device key is not supported.', 400);
  if (cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) {
    throw new PasskeyError('This device key is not supported.', 400);
  }
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
    throw new PasskeyError('This device key is not supported.', 400);
  }
  return { kty: 'EC', crv: 'P-256', x: bytesToB64url(x), y: bytesToB64url(y) };
}

function derToP1363(signature) {
  const bytes = signature instanceof Uint8Array ? signature : new Uint8Array(signature);
  if (bytes.length === 64 && bytes[0] !== 0x30) return bytes;
  if (bytes[0] !== 0x30) throw new PasskeyError('Could not check this device.', 401);
  let pos = 2;
  if (bytes[1] & 0x80) pos = 2 + (bytes[1] & 0x7f);
  const readInt = () => {
    if (bytes[pos] !== 0x02) throw new PasskeyError('Could not check this device.', 401);
    const len = bytes[pos + 1];
    const start = pos + 2;
    pos = start + len;
    return bytes.slice(start, pos);
  };
  const fixed = (part) => {
    let index = 0;
    while (index < part.length - 1 && part[index] === 0) index += 1;
    const slice = part.slice(index);
    if (slice.length > 32) throw new PasskeyError('Could not check this device.', 401);
    const out = new Uint8Array(32);
    out.set(slice, 32 - slice.length);
    return out;
  };
  const raw = new Uint8Array(64);
  raw.set(fixed(readInt()), 0);
  raw.set(fixed(readInt()), 32);
  return raw;
}

async function verifyEs256(jwk, data, signature) {
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    derToP1363(signature),
    data
  );
}

async function accountExists(user) {
  if (knownAccount(user)) return true;
  const map = await loadPasswordMap();
  return Boolean(map && map[user]);
}

async function listCredentialIds(user) {
  const raw = await kvCommand(store(), ['GET', USER_PREFIX + user]);
  if (!raw) return [];
  try {
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? ids.filter(validId) : [];
  } catch {
    return [];
  }
}

async function putChallenge(record) {
  const id = randomId();
  await kvCommand(store(), ['SET', CHALLENGE_PREFIX + id, JSON.stringify(record), 'EX', String(CHALLENGE_TTL)]);
  return id;
}

async function takeChallenge(id) {
  if (!validId(id)) return null;
  const raw = await kvCommand(store(), ['GETDEL', CHALLENGE_PREFIX + id]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readClient(credential, expectedType, challenge, request) {
  const response = credential?.response || {};
  let client;
  try {
    client = JSON.parse(new TextDecoder().decode(b64urlToBytes(response.clientDataJSON)));
  } catch {
    throw new PasskeyError('Could not check this device.', 400);
  }
  if (client.type !== expectedType || !sameText(client.challenge, challenge) || client.crossOrigin === true) {
    throw new PasskeyError('Could not check this device.', 401);
  }
  const rp = relyingParty(request);
  if (client.origin !== rp.origin) throw new PasskeyError('Could not check this device.', 401);
  return { clientData: b64urlToBytes(response.clientDataJSON), rp };
}

async function authenticatorData(credential, expectedType) {
  const response = credential.response || {};
  if (expectedType === 'webauthn.create') {
    const decoded = decodeCbor(b64urlToBytes(response.attestationObject));
    const attestation = decoded.value;
    if (!(attestation instanceof Map)) throw new PasskeyError('Could not read this device key.', 400);
    const fmt = attestation.get('fmt');
    if (fmt !== 'none' && fmt !== 'packed') throw new PasskeyError('This device key is not supported.', 400);
    const authData = attestation.get('authData');
    if (!(authData instanceof Uint8Array)) throw new PasskeyError('Could not read this device key.', 400);
    return authData;
  }
  return b64urlToBytes(response.authenticatorData);
}

export async function passkeyCount(user) {
  return (await listCredentialIds(parseIdentity(user).user)).length;
}

export async function registerOptions(request, user) {
  const identity = parseIdentity(user);
  if (!identity.user) throw new PasskeyError('Not signed in', 401);
  const rp = relyingParty(request);
  const existing = await listCredentialIds(identity.user);
  const challenge = randomId();
  const challengeId = await putChallenge({ kind: 'register', challenge, user: identity.user });
  return {
    challengeId,
    publicKey: {
      challenge,
      rp: { name: rp.name, id: rp.rpId },
      user: {
        id: bytesToB64url(new TextEncoder().encode(identity.user)),
        name: identity.email,
        displayName: identity.email
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 60000,
      attestation: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required'
      },
      excludeCredentials: existing.map((id) => ({ type: 'public-key', id }))
    }
  };
}

export async function verifyRegistration(request, user, body) {
  const identity = parseIdentity(user);
  const stored = await takeChallenge(body?.challengeId);
  if (!stored || stored.kind !== 'register' || stored.user !== identity.user) {
    throw new PasskeyError('That setup expired. Try again.', 400);
  }
  const credential = body?.credential || {};
  const rawId = b64urlToBytes(credential.rawId || credential.id);
  const credentialId = bytesToB64url(rawId);
  if (!validId(credentialId)) throw new PasskeyError('Could not save this device.', 400);
  const { rp } = await readClient(credential, 'webauthn.create', stored.challenge, request);
  const authData = await authenticatorData(credential, 'webauthn.create');
  const parsed = parseAuthData(authData);
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rp.rpId)));
  if (!equalBytes(parsed.rpIdHash, rpHash) || !parsed.up || !parsed.uv || !parsed.credentialId) {
    throw new PasskeyError('Touch ID or Face ID did not confirm this device.', 401);
  }
  if (!equalBytes(parsed.credentialId, rawId)) throw new PasskeyError('Could not save this device.', 400);
  const jwk = coseToJwk(parsed.cose);
  const ids = await listCredentialIds(identity.user);
  if (ids.includes(credentialId)) return;
  if (ids.length >= MAX_PER_USER) {
    throw new PasskeyError('This account already has a passkey on eight devices.', 400);
  }
  const record = {
    user: identity.user,
    x: jwk.x,
    y: jwk.y,
    counter: parsed.signCount,
    createdAt: new Date().toISOString()
  };
  const target = store();
  await kvCommand(target, ['SET', CRED_PREFIX + credentialId, JSON.stringify(record)]);
  ids.push(credentialId);
  await kvCommand(target, ['SET', USER_PREFIX + identity.user, JSON.stringify(ids)]);
}

export async function loginOptions(request) {
  const rp = relyingParty(request);
  const challenge = randomId();
  const challengeId = await putChallenge({ kind: 'login', challenge });
  return {
    challengeId,
    publicKey: {
      challenge,
      rpId: rp.rpId,
      timeout: 60000,
      userVerification: 'required'
    }
  };
}

export async function verifyLogin(request, body) {
  const stored = await takeChallenge(body?.challengeId);
  if (!stored || stored.kind !== 'login') throw new PasskeyError('That sign-in expired. Try again.', 400);
  const credential = body?.credential || {};
  const credentialId = bytesToB64url(b64urlToBytes(credential.rawId || credential.id));
  if (!validId(credentialId)) throw new PasskeyError('This device is not set up for YourOrg.', 401);
  const raw = await kvCommand(store(), ['GET', CRED_PREFIX + credentialId]);
  if (!raw) throw new PasskeyError('This device is not set up for YourOrg.', 401);
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new PasskeyError('This device is not set up for YourOrg.', 401);
  }
  const identity = parseIdentity(record.user);
  if (!identity.user || !(await accountExists(identity.user))) {
    throw new PasskeyError('This device is not set up for YourOrg.', 401);
  }
  const handle = credential.response?.userHandle;
  if (handle && new TextDecoder().decode(b64urlToBytes(handle)) !== identity.user) {
    throw new PasskeyError('This device is not set up for YourOrg.', 401);
  }
  const { rp, clientData } = await readClient(credential, 'webauthn.get', stored.challenge, request);
  const authData = await authenticatorData(credential, 'webauthn.get');
  const parsed = parseAuthData(authData);
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rp.rpId)));
  if (!equalBytes(parsed.rpIdHash, rpHash) || !parsed.up || !parsed.uv) {
    throw new PasskeyError('Touch ID or Face ID did not confirm this sign-in.', 401);
  }
  const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData));
  const signed = new Uint8Array(authData.length + clientHash.length);
  signed.set(authData, 0);
  signed.set(clientHash, authData.length);
  const ok = await verifyEs256({ x: record.x, y: record.y }, signed, b64urlToBytes(credential.response?.signature));
  if (!ok) throw new PasskeyError('Touch ID or Face ID did not confirm this sign-in.', 401);
  if (record.counter > 0 && parsed.signCount > 0 && parsed.signCount <= record.counter) {
    throw new PasskeyError('Touch ID or Face ID did not confirm this sign-in.', 401);
  }
  record.counter = parsed.signCount;
  await kvCommand(store(), ['SET', CRED_PREFIX + credentialId, JSON.stringify(record)]);
  return identity;
}
