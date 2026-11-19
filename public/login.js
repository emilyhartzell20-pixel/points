'use strict';
document.getElementById('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const err = document.getElementById('err');
  err.textContent = '';
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: f.get('email'), password: f.get('password') }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sign-in failed');
    location.href = data.user.role === 'staff' ? '/staff' : '/client';
  } catch (ex) { err.textContent = ex.message; }
});
