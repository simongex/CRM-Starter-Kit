export const config = { runtime: 'edge' };

import {
  isManager,
  json,
  kvStore,
  kvCommand,
  coordinatorScope,
  overseesTask,
  ownsAction,
  ownsTask,
  readSession,
  seesTask
} from '../lib/internal-auth.js';

const KEY = 'kb:internal-state';
const MAX_BODY = 2_000_000;

/* Collaborators only receive tasks they own, hold an action in, or oversee. */
function visibleDoc(doc, user) {
  if (!doc?.state || isManager(user)) return doc;
  const phases = doc.state.phases || [];
  return {
    ...doc,
    state: { ...doc.state, tasks: (doc.state.tasks || []).filter((task) => seesTask(user, task, phases)) }
  };
}

/* Collaborators send back only the tasks they were given. On a task they own they may
   change everything except its owner. On a task they only see through an action, only
   their own actions change, matched by position since they cannot add or remove any.
   Categories and everyone else's tasks stay as stored. Returns null to refuse. */
function mergeCollaboratorEdits(current, incoming, user) {
  const phases = current.phases || [];
  const visible = new Set(current.tasks.filter((task) => seesTask(user, task, phases)).map((task) => task.id));
  const sent = new Map(incoming.tasks.map((task) => [task.id, task]));
  if ([...visible].some((id) => !sent.has(id))) return null;
  const known = new Set(current.tasks.map((task) => task.id));
  for (const task of incoming.tasks) {
    if (visible.has(task.id)) continue;
    if (known.has(task.id) || !coordinatorScope(user) || !overseesTask(user, task, phases)) return null;
  }

  const tasks = [];
  for (const task of current.tasks) {
    const edit = sent.get(task.id);
    if (!visible.has(task.id)) {
      tasks.push(task);
    } else if (overseesTask(user, task, phases)) {
      tasks.push({ ...edit, id: task.id });
    } else if (ownsTask(user, task)) {
      tasks.push({ ...edit, id: task.id, owner: task.owner });
    } else {
      const before = task.actions || [];
      const after = Array.isArray(edit.actions) ? edit.actions : [];
      if (after.length !== before.length) return null;
      tasks.push({
        ...task,
        actions: before.map((action, i) => (
          ownsAction(user, task, action) ? { ...after[i], owner: action.owner } : action
        ))
      });
    }
  }
  const created = incoming.tasks.filter((task) => !known.has(task.id) && overseesTask(user, task, phases));
  return { ...current, tasks: [...created, ...tasks] };
}

function docResponse(text) {
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default async function handler(request) {
  const identity = await readSession(request);
  if (!identity) return json({ error: 'Not signed in' }, 401);

  const target = kvStore();
  if (!target) return json({ error: 'Shared storage is not configured' }, 501);
  const manager = isManager(identity.user);

  try {
    if (request.method === 'GET') {
      const raw = await kvCommand(target, ['GET', KEY]);
      if (!raw) return json({ updatedAt: 0, updatedBy: '', state: null }, 200);
      if (manager && typeof raw === 'string') return docResponse(raw);
      const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return docResponse(JSON.stringify(visibleDoc(doc, identity.user)));
    }

    if (request.method !== 'PUT' && request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'Timeline is too large to save' }, 413);

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'Bad request' }, 400);
    }
    if (!body.state || !Array.isArray(body.state.tasks) || !Array.isArray(body.state.phases)) {
      return json({ error: 'Bad request' }, 400);
    }

    const raw = await kvCommand(target, ['GET', KEY]);
    const current = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { updatedAt: 0 };
    if (String(current.updatedAt || 0) !== String(body.base || 0)) {
      return json(visibleDoc(current, identity.user), 409);
    }

    let state = body.state;
    if (!manager) {
      if (!current.state) return json({ error: 'Only Alex and Sam can set up the timeline.' }, 403);
      state = mergeCollaboratorEdits(current.state, body.state, identity.user);
      if (!state) {
        return json({ error: 'You can only edit your own tasks. Only Alex and Sam can add or delete tasks.' }, 403);
      }
    }

    const doc = { updatedAt: Date.now(), updatedBy: identity.user, state };
    await kvCommand(target, ['SET', KEY, JSON.stringify(doc)]);
    return json({ updatedAt: doc.updatedAt, updatedBy: doc.updatedBy }, 200);
  } catch (error) {
    console.error(error);
    return json({ error: 'Could not update the timeline. Try again.' }, 502);
  }
}
