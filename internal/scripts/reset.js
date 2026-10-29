const form = document.getElementById('reset-form');
const errorEl = document.getElementById('error');
const submitEl = document.getElementById('submit');
const token = new URLSearchParams(location.search).get('token') || '';

history.replaceState(null, '', location.pathname);

function done(message) {
  form.innerHTML = `
    <p class="login-error">${message}</p>
    <a class="login-submit login-link" href="/internal/login">Sign in</a>
  `;
}

if (!token) {
  done('This link is missing its code. Request a new one from your profile.');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const next = document.getElementById('next').value;
  const confirm = document.getElementById('confirm').value;
  errorEl.textContent = '';
  if (next !== confirm) {
    errorEl.textContent = 'The two passwords do not match.';
    return;
  }

  submitEl.disabled = true;
  submitEl.textContent = 'Saving…';
  try {
    const response = await fetch('/api/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, next })
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      done('Your password has been changed. Sign in with the new one.');
      return;
    }
    errorEl.textContent = data.error || 'Could not change the password.';
  } catch {
    errorEl.textContent = 'Could not reach the server. Try again.';
  }
  submitEl.disabled = false;
  submitEl.textContent = 'Save new password';
});
