'use strict';
// The one-time token lives in the URL fragment (#t=...), which browsers never send to servers.
(async () => {
  const box = document.getElementById('setup');
  const token = new URLSearchParams(location.hash.slice(1)).get('t');
  history.replaceState(null, '', location.pathname); // keep the token out of history / screenshots
  const post = async (path, body) => {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  };
  try {
    if (!token) throw new Error('This link is incomplete. Ask your LeadG2 consultant for a new one.');
    const who = await post('/api/invite/check', { token });
    const pw = h('input', { type: 'password', name: 'pw', autocomplete: 'new-password', minlength: '10', required: true });
    const pw2 = h('input', { type: 'password', name: 'pw2', autocomplete: 'new-password', required: true });
    const err = h('p', { class: 'error', role: 'alert' });
    const form = h('form', {},
      h('p', {}, `Welcome, ${who.name}. Choose a password for `, h('strong', {}, who.email), '.'),
      h('label', {}, 'New password (at least 10 characters)', pw),
      h('label', {}, 'Confirm password', pw2),
      h('button', { type: 'submit', class: 'primary' }, 'Save password'), err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      if (pw.value !== pw2.value) { err.textContent = 'The passwords do not match.'; return; }
      try {
        await post('/api/invite/accept', { token, password: pw.value });
        box.replaceChildren(h('p', {}, 'Your password is set.'), h('p', {}, h('a', { href: '/login' }, 'Sign in to your dashboard →')));
      } catch (ex) { err.textContent = ex.message; }
    });
    box.replaceChildren(form);
  } catch (ex) {
    box.replaceChildren(h('p', { class: 'error' }, ex.message));
  }
})();
