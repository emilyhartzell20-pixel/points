'use strict';
document.getElementById('logout').addEventListener('click', logout);
(async () => {
  const app = document.getElementById('app');
  try {
    const v = await api('/api/client/dashboard');
    app.replaceChildren(renderClientView(v));
  } catch (e) {
    app.replaceChildren(h('p', { class: 'error' }, e.message));
  }
})();
