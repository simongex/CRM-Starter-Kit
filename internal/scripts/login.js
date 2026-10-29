const form = document.getElementById('login-form');
const errorEl = document.getElementById('error');
const submitEl = document.getElementById('submit');
const passkeyEl = document.getElementById('passkey');

function workspacePath() {
  const raw = new URLSearchParams(location.search).get('to') || '';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/internal';
  let path = raw;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return '/internal';
  }
  path = path.replace(/\/+$/, '') || '/';
  if (
    path.includes('\\')
    || path.includes('//')
    || path.includes('?')
    || path.includes('#')
    || path.includes('%')
    || path.includes('..')
  ) return '/internal';
  if (
    path === '/internal'
    || path === '/internal/timeline'
    || path === '/internal/contacts'
    || path === '/internal/contacts/review'
  ) return path;
  if (/^\/internal\/contacts\/[^/]+$/.test(path)) return path;
  return '/internal';
}

function openWorkspace() {
  const path = workspacePath();
  try {
    const prefs = JSON.parse(localStorage.getItem('yourorg-internal-prefs-v1') || '{}');
    const next = prefs && typeof prefs === 'object' ? prefs : {};
    next.view = path === '/internal/timeline'
      ? 'gantt'
      : path.startsWith('/internal/contacts') ? 'contacts' : 'dashboard';
    localStorage.setItem('yourorg-internal-prefs-v1', JSON.stringify(next));
  } catch {
    /* the workspace still opens on the requested page */
  }
  window.location.replace(path);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.textContent = '';
  submitEl.disabled = true;
  submitEl.textContent = 'Signing in…';

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: document.getElementById('email').value,
        password: document.getElementById('password').value
      })
    });

    if (response.ok) {
      try {
        const stateResponse = await fetch('/api/state', { cache: 'no-store' });
        if (stateResponse.ok) {
          const doc = await stateResponse.json();
          if (doc.state && Array.isArray(doc.state.tasks)) {
            localStorage.setItem('yourorg-internal-v2', JSON.stringify(doc.state));
            localStorage.setItem('yourorg-internal-version', String(doc.updatedAt || 0));
          }
        }
      } catch {
        /* the workspace loads it again if this copy did not arrive */
      }
      openWorkspace();
      return;
    }

    const data = await response.json().catch(() => ({}));
    errorEl.textContent = data.error || 'That email and password did not match.';
  } catch {
    errorEl.textContent = 'Could not reach the server. Try again.';
  }

  submitEl.disabled = false;
  submitEl.textContent = 'Sign in';
  document.getElementById('password').select();
});

if (passkeyEl && window.KBPasskey?.supported()) {
  passkeyEl.hidden = false;
  passkeyEl.addEventListener('click', async () => {
    errorEl.textContent = '';
    passkeyEl.disabled = true;
    submitEl.disabled = true;
    passkeyEl.textContent = 'Waiting for Touch ID or Face ID…';
    try {
      const response = await window.KBPasskey.login();
      if (response?.ok) {
        openWorkspace();
        return;
      }
      errorEl.textContent = 'Could not sign in with Touch ID or Face ID.';
    } catch (error) {
      errorEl.textContent = window.KBPasskey.friendly(error);
    }
    passkeyEl.disabled = false;
    submitEl.disabled = false;
    passkeyEl.textContent = 'Sign in with Touch ID or Face ID';
  });
}
