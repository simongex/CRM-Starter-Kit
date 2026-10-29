/* One Mailchimp audience. Only contacts whose newsletter status is Agreed
   are written. Groups become tags on those members. Stays idle until
   MAILCHIMP_API_KEY, MAILCHIMP_SERVER_PREFIX and MAILCHIMP_AUDIENCE_ID
   are all set. This module never sends status: 'subscribed', so an
   existing member is not re-subscribed. */

import {
  mailingAddress,
  markResubscribed,
  markUnsubscribed,
  splitPersonName
} from './contacts.js';

const REMOTE_STATUSES = new Set(['subscribed', 'unsubscribed', 'cleaned', 'pending', 'transactional']);

export function mailchimpConfigured() {
  return Boolean(
    process.env.MAILCHIMP_API_KEY
    && process.env.MAILCHIMP_SERVER_PREFIX
    && process.env.MAILCHIMP_AUDIENCE_ID
  );
}

function config() {
  return {
    key: process.env.MAILCHIMP_API_KEY || '',
    server: process.env.MAILCHIMP_SERVER_PREFIX || '',
    audience: process.env.MAILCHIMP_AUDIENCE_ID || ''
  };
}

const MD5_SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

/* Edge crypto.subtle has no MD5. Mailchimp's subscriber hash is the MD5 of
   the lowercased email, so this is the small pure-JS version. */
export function md5Hex(value) {
  const data = new TextEncoder().encode(String(value ?? ''));
  const zeros = (56 - ((data.length + 1) % 64) + 64) % 64;
  const padded = new Uint8Array(data.length + 1 + zeros + 8);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = data.length * 8;
  view.setUint32(padded.length - 8, bits >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32), true);

  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(16);
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + k[i] + words[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((f << MD5_SHIFT[i]) | (f >>> (32 - MD5_SHIFT[i])))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map((word) => (
    [word & 255, (word >>> 8) & 255, (word >>> 16) & 255, (word >>> 24) & 255]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  )).join('');
}

function isoToday(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/* Null unless the contact is Agreed and has an email. status is omitted
   so Mailchimp keeps an existing member's status. */
export function memberPayload(contact) {
  if (contact?.newsletter?.status !== 'agreed') return null;
  const email = mailingAddress(contact);
  if (!email) return null;
  const { firstName, lastName } = splitPersonName(contact?.name);
  return {
    email_address: email,
    status_if_new: 'subscribed',
    merge_fields: { FNAME: firstName, LNAME: lastName }
  };
}

export function tagPlan(contact, groups) {
  const ids = new Set(contact?.groups || []);
  return (groups || []).map((group) => ({
    name: group.name,
    status: ids.has(group.id) ? 'active' : 'inactive'
  }));
}

/* upsert writes an Agreed contact. archive removes someone who left
   Agreed after they had been synced. Everyone else is left alone. */
export function syncPlan(contact) {
  const status = contact?.newsletter?.status;
  if (status === 'agreed') return mailingAddress(contact) ? 'upsert' : 'skip';
  const synced = contact?.newsletter?.syncedEmail || contact?.newsletter?.mailchimpStatus;
  if ((status === 'not-asked' || status === 'declined') && synced) return 'archive';
  return 'skip';
}

async function mc(method, path, body) {
  const { key, server } = config();
  const response = await fetch(`https://${server}.api.mailchimp.com/3.0${path}`, {
    method,
    headers: {
      Authorization: `Basic ${btoa(`key:${key}`)}`,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.detail || data.title || `Mailchimp responded ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function upsertMember(email, { firstName, lastName } = {}) {
  const address = String(email || '').trim().toLowerCase();
  const { audience } = config();
  return mc('PUT', `/lists/${audience}/members/${md5Hex(address)}`, {
    email_address: address,
    status_if_new: 'subscribed',
    merge_fields: { FNAME: firstName || '', LNAME: lastName || '' }
  });
}

export async function setTags(email, tags) {
  const address = String(email || '').trim().toLowerCase();
  const { audience } = config();
  if (!tags?.length) return {};
  return mc('POST', `/lists/${audience}/members/${md5Hex(address)}/tags`, { tags });
}

export async function getMember(email) {
  const address = String(email || '').trim().toLowerCase();
  if (!address) return '';
  const { audience } = config();
  try {
    const data = await mc('GET', `/lists/${audience}/members/${md5Hex(address)}?fields=status,email_address`);
    return REMOTE_STATUSES.has(data.status) ? data.status : '';
  } catch (error) {
    if (error.status === 404) return '';
    throw error;
  }
}

export async function archiveMember(email) {
  const address = String(email || '').trim().toLowerCase();
  const { audience } = config();
  try {
    await mc('DELETE', `/lists/${audience}/members/${md5Hex(address)}`);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function findStaticSegment(name) {
  const { audience } = config();
  let offset = 0;
  for (;;) {
    const data = await mc('GET', `/lists/${audience}/segments?count=1000&offset=${offset}&type=static`);
    const segments = Array.isArray(data.segments) ? data.segments : [];
    const found = segments.find((item) => item.name === name);
    if (found) return found;
    offset += segments.length;
    if (!segments.length || segments.length < 1000) return null;
  }
}

export async function renameGroupTag(oldName, newName) {
  const from = String(oldName || '').trim();
  const to = String(newName || '').trim();
  if (!from || !to || from === to) return { renamed: false };
  const segment = await findStaticSegment(from);
  if (!segment) return { renamed: false };
  const { audience } = config();
  await mc('PATCH', `/lists/${audience}/segments/${segment.id}`, { name: to });
  return { renamed: true, id: segment.id };
}

export async function deleteGroupSegment(name) {
  const label = String(name || '').trim();
  if (!label) return { deleted: false };
  const segment = await findStaticSegment(label);
  if (!segment) return { deleted: false };
  const { audience } = config();
  await mc('DELETE', `/lists/${audience}/segments/${segment.id}`);
  return { deleted: true, id: segment.id };
}

function stampSync(contact, email, remote) {
  contact.newsletter.mailchimpStatus = remote || contact.newsletter.mailchimpStatus || '';
  contact.newsletter.syncedAt = new Date().toISOString();
  contact.newsletter.syncedEmail = email;
}

function refuseRemote(contact, email, remote, date) {
  contact.newsletter = markUnsubscribed(contact.newsletter, date || isoToday());
  stampSync(contact, email, remote);
}

/* Agreed contacts are written. A remote unsubscribe or cleaned address
   is recorded locally and left untouched in Mailchimp. Leaving Agreed
   archives the member so they can be added again later. */
export async function syncContact(state, contact, date) {
  const plan = syncPlan(contact);
  if (plan === 'skip') return { id: contact.id, skipped: 'skip' };
  const email = mailingAddress(contact);
  const previous = String(contact.newsletter?.syncedEmail || '').trim().toLowerCase();
  if (plan === 'archive') {
    await archiveMember(previous || email);
    stampSync(contact, previous || email, 'archived');
    return { id: contact.id, archived: true, newsletter: contact.newsletter };
  }
  let remote = await getMember(email);
  if (!remote && previous && previous !== email) remote = await getMember(previous);
  if (remote === 'unsubscribed' || remote === 'cleaned') {
    refuseRemote(contact, email || previous, remote, date);
    return { id: contact.id, skipped: remote, newsletter: contact.newsletter };
  }
  if (previous && previous !== email && remote) {
    const { audience } = config();
    try {
      await mc('PATCH', `/lists/${audience}/members/${md5Hex(previous)}`, { email_address: email });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const { firstName, lastName } = splitPersonName(contact.name);
  await upsertMember(email, { firstName, lastName });
  await setTags(email, tagPlan(contact, state.groups || []));
  stampSync(contact, email, remote || 'subscribed');
  return { id: contact.id, newsletter: contact.newsletter };
}

/* Agreed + remote unsubscribed/cleaned becomes unsubscribed.
   Unsubscribed + remote subscribed (they used the Mailchimp form) becomes agreed. */
export function applyMailchimpEvent(state, { type, email, date } = {}) {
  const address = String(email || '').trim().toLowerCase();
  if (!address) return false;
  const day = date || isoToday();
  let changed = false;
  for (const contact of state.contacts || []) {
    const own = mailingAddress(contact);
    const synced = String(contact.newsletter?.syncedEmail || '').trim().toLowerCase();
    if (own !== address && synced !== address) continue;
    const status = contact.newsletter?.status;
    if ((type === 'unsubscribe' || type === 'cleaned') && status === 'agreed') {
      contact.newsletter = markUnsubscribed(contact.newsletter, day);
      contact.newsletter.mailchimpStatus = type === 'cleaned' ? 'cleaned' : 'unsubscribed';
      contact.newsletter.syncedEmail = address;
      changed = true;
    } else if (type === 'subscribe' && status === 'unsubscribed') {
      contact.newsletter = markResubscribed(contact.newsletter, day);
      contact.newsletter.mailchimpStatus = 'subscribed';
      contact.newsletter.syncedEmail = address;
      changed = true;
    }
  }
  return changed;
}

export async function pullAudienceStatuses(state, date) {
  const { audience } = config();
  const byEmail = new Map();
  let offset = 0;
  const count = 1000;
  for (;;) {
    const data = await mc(
      'GET',
      `/lists/${audience}/members?count=${count}&offset=${offset}&fields=members.email_address,members.status,total_items`
    );
    const members = Array.isArray(data.members) ? data.members : [];
    for (const member of members) {
      const email = String(member.email_address || '').trim().toLowerCase();
      if (email && REMOTE_STATUSES.has(member.status)) byEmail.set(email, member.status);
    }
    offset += members.length;
    if (!members.length || members.length < count || offset >= (Number(data.total_items) || offset)) break;
  }
  let updated = 0;
  const day = date || isoToday();
  for (const [email, remote] of byEmail) {
    const type = remote === 'cleaned'
      ? 'cleaned'
      : (remote === 'unsubscribed' ? 'unsubscribe' : (remote === 'subscribed' ? 'subscribe' : ''));
    if (!type) continue;
    if (applyMailchimpEvent(state, { type, email, date: day })) updated += 1;
  }
  return { updated, seen: byEmail.size };
}
