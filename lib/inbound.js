import { capSentences, replaceEmDashes } from './note-style.js';

/* A morning review keeps a person who wrote to us, and drops mail that is
   automated, a shared mailbox, or an advertisement. */

const ROLE_LOCAL = new Set([
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply', 'do_not_reply',
  'notifications', 'notification', 'notify', 'mailer-daemon', 'postmaster',
  'bounce', 'bounces', 'newsletter', 'newsletters', 'news', 'marketing',
  'promo', 'promotions', 'ads', 'advertising', 'info', 'hello', 'contact',
  'office', 'team', 'support', 'help', 'helpdesk', 'sales', 'billing',
  'accounts', 'accounting', 'admin', 'administrator', 'reception',
  'enquiries', 'enquiry', 'inquiries', 'inquiry', 'press', 'media',
  'events', 'updates', 'update', 'alert', 'alerts', 'digest',
  'unsubscribe', 'mail', 'automated', 'automation', 'system', 'bot',
  'daemon', 'feedback', 'survey', 'surveys', 'careers', 'jobs', 'hr',
  'recruitment', 'webmaster', 'abuse', 'security', 'privacy', 'legal',
  'orders', 'order', 'shop', 'store', 'subscribe', 'community',
  'social', 'booking', 'reservations', 'reservation', 'service',
  'customerservice', 'customer-service', 'studio', 'gallery', 'general'
]);

const BULK_LABELS = new Set([
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_FORUMS',
  'CATEGORY_UPDATES',
  'SPAM'
]);

const BULK_DOMAINS = [
  'mailchimp.com',
  'mandrillapp.com',
  'sendgrid.net',
  'sendgrid.com',
  'createsend.com',
  'hubspotemail.net',
  'hubspot.com',
  'constantcontact.com',
  'mailerlite.com',
  'klaviyo.com',
  'mcsv.net',
  'list-manage.com'
];

function headerValue(headers, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) return String(value || '');
  }
  return '';
}

function bulkDomain(domain) {
  return BULK_DOMAINS.some((item) => domain === item || domain.endsWith(`.${item}`));
}

export function classifyInbound({ email, name, subject, headers, labelIds } = {}) {
  const address = String(email || '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  const local = at > 0 ? address.slice(0, at) : '';
  const domain = at > 0 ? address.slice(at + 1) : '';
  if (!local || !domain || !domain.includes('.')) return { keep: false, reason: 'address' };
  if (domain === 'example.org') return { keep: false, reason: 'internal' };
  if (bulkDomain(domain)) return { keep: false, reason: 'advertisement' };

  const bare = local.split('+')[0];
  if (
    ROLE_LOCAL.has(bare)
    || /no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|notification/.test(bare)
    || /^\d+$/.test(bare)
  ) {
    return { keep: false, reason: 'role' };
  }

  for (const label of labelIds || []) {
    if (BULK_LABELS.has(label)) return { keep: false, reason: 'advertisement' };
  }
  if (headerValue(headers, 'list-unsubscribe') || headerValue(headers, 'list-id')) {
    return { keep: false, reason: 'advertisement' };
  }
  const precedence = headerValue(headers, 'precedence').toLowerCase();
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') {
    return { keep: false, reason: 'advertisement' };
  }
  const auto = headerValue(headers, 'auto-submitted').toLowerCase();
  if (auto && auto !== 'no') return { keep: false, reason: 'automated' };
  if (/\bvia\s+(mailchimp|sendgrid|constant contact|klaviyo|mailerlite|hubspot)\b/i.test(name || '')) {
    return { keep: false, reason: 'advertisement' };
  }
  if (/\bunsubscribe\b|view in browser|\b\d+\s*%\s*off\b/i.test(subject || '')) {
    return { keep: false, reason: 'advertisement' };
  }
  return { keep: true, reason: '' };
}

export function nameFromAddress(email, name) {
  const given = String(name || '').replace(/^"|"$/g, '').trim();
  if (given && !given.includes('@')) return given.slice(0, 160);
  const local = String(email || '').split('@')[0].split('+')[0];
  const parts = local.split(/[._-]+/).filter((part) => part && !/^\d+$/.test(part));
  if (!parts.length) return '';
  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
    .slice(0, 160);
}

/* Used when the model is not available. Two sentences at most, from the
   subject and the Gmail snippet, with no added detail. */
export function fallbackProposalSummary({ name, subject, snippet } = {}) {
  const who = String(name || '').trim() || 'They';
  const topic = String(subject || '').replace(/^(re|fw|fwd)\s*:\s*/i, '').trim();
  const first = topic
    ? `${who} wrote about ${topic.replace(/[.]+$/, '')}.`
    : `${who} wrote to YourOrg.`;
  const detail = String(snippet || '').replace(/\s+/g, ' ').trim();
  if (!detail || detail.toLowerCase() === topic.toLowerCase()) {
    return capSentences(replaceEmDashes(first), 2);
  }
  const second = /[.!?]$/.test(detail) ? detail : `${detail}.`;
  return capSentences(replaceEmDashes(`${first} ${second}`), 2);
}
