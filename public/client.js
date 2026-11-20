'use strict';
document.getElementById('logout').addEventListener('click', logout);
(async function load() {
  const app = document.getElementById('app');
  try {
    const v = await api('/api/client/dashboard');
    app.replaceChildren(renderClientView(v, { onAnswered: load }));
  } catch (e) {
    app.replaceChildren(h('p', { class: 'error' }, e.message));
  }
})();
