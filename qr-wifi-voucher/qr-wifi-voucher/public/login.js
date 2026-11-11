(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  fetch('/api/branding')
    .then((r) => r.json())
    .then((b) => {
      if (b && b.cafeName) {
        $('cafe-name').textContent = b.cafeName;
        document.title = `Staff log in - ${b.cafeName}`;
      }
    })
    .catch(() => {});

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('login-btn');
    const error = $('login-error');
    error.hidden = true;
    button.disabled = true;
    button.textContent = 'Logging in…';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-QRWifi': '1' },
        body: JSON.stringify({ username: $('username').value, password: $('password').value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not log in.');
      location.href = '/';
    } catch (err) {
      error.textContent = err.message === 'Failed to fetch' ? "Can't reach the server. Check the network and try again." : err.message;
      error.hidden = false;
      $('password').select();
      button.disabled = false;
      button.textContent = 'Log in';
    }
  });
})();
