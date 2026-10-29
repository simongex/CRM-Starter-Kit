/* Slack Web API via fetch. Token: SLACK_BOT_TOKEN (xoxb-...) with
   chat:write and users:read.email. Direct messages only — sendDm rejects
   anything that is not a Slack user id. */

export const SLACK_IDS_KEY = 'kb:slack-ids';
export const SLACK_ID_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SLACK_API = 'https://slack.com/api';

function slackError(message, code) {
  const error = new Error(message);
  error.code = code || '';
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFlat(body) {
  return Object.values(body || {}).every((value) => (
    value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  ));
}

async function slackFetch(method, init, allowRetry) {
  const response = await fetch(`${SLACK_API}/${method}`, init);
  if (response.status === 429 && allowRetry) {
    const header = Number(response.headers.get('retry-after'));
    const seconds = Number.isFinite(header) && header > 0 ? header : 1;
    await response.arrayBuffer().catch(() => {});
    await delay(Math.min(seconds, 15) * 1000);
    return slackFetch(method, init, false);
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (response.status === 429 || data.error === 'ratelimited') {
    throw slackError('Slack rate limit', 'ratelimited');
  }
  if (!response.ok || data.ok === false) {
    throw slackError(data.error || `Slack responded ${response.status}`, data.error || String(response.status));
  }
  if (data.ok !== true) throw slackError('Slack response was not ok', 'not_ok');
  return data;
}

export async function slackApi(method, body) {
  const token = process.env.SLACK_BOT_TOKEN || '';
  if (!token) throw slackError('SLACK_BOT_TOKEN is not set', 'no_token');

  const payload = body || {};
  const init = isFlat(payload)
    ? {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'
        },
        body: new URLSearchParams(Object.entries(payload).map(([key, value]) => [key, value == null ? '' : String(value)]))
      }
    : {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(payload)
      };

  return slackFetch(method, init, true);
}

export async function lookupSlackId(email) {
  try {
    const data = await slackApi('users.lookupByEmail', { email });
    const id = data?.user?.id || '';
    if (!id || data.user.deleted) throw slackError(`No Slack account for ${email}`, 'users_not_found');
    return id;
  } catch (error) {
    if (error.code === 'users_not_found' || error.message === 'users_not_found') {
      throw slackError(`No Slack account for ${email}`, 'users_not_found');
    }
    throw error;
  }
}

/* channel must be the Slack user id (U… / W…). Passing that id opens the
   bot's DM with that person. Channel ids are refused. */
export async function sendDm(slackId, blocks, text) {
  if (!/^[UW][A-Z0-9]{2,}$/.test(String(slackId || ''))) {
    throw slackError('Refusing to post outside a direct message', 'not_dm');
  }
  return slackApi('chat.postMessage', {
    channel: slackId,
    text: text || 'Weekly deadlines',
    blocks: Array.isArray(blocks) ? blocks : [],
    link_names: false,
    unfurl_links: false,
    unfurl_media: false
  });
}
