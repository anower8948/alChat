// admin.js — alChat admin dashboard
(() => {
  const $ = s => document.querySelector(s);
  const TOKEN_KEY = 'alchat_token';
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) location.href = '/';

  const api = async (url, opts = {}) => {
    const res = await fetch(url, {
      ...opts,
      headers: {
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: 'Bearer ' + token
      }
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { localStorage.removeItem(TOKEN_KEY); location.href = '/'; }
    if (res.status === 403) { alert('This page is for admins only.'); location.href = '/'; }
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = msg => {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._t);
    t._t = setTimeout(() => (t.hidden = true), 2600);
  };
  const initials = n => n.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

  async function load() {
    try {
      const { users, stats } = await api('/api/admin/users');
      $('#stUsers').textContent = stats.totalUsers;
      $('#stOnline').textContent = stats.onlineNow;
      $('#stMsgs').textContent = stats.totalMessages;

      const list = $('#userList');
      list.innerHTML = '';
      for (const u of users) {
        const row = document.createElement('div');
        row.className = 'user-row';
        row.innerHTML = `
          <div class="avatar small" style="background:${esc(u.color || '#8E8E93')}">${esc(initials(u.displayName || u.username))}</div>
          <div class="u-meta">
            <div class="u-name">${esc(u.displayName)}
              ${u.isAdmin ? '<span class="tag">ADMIN</span>' : ''}
              ${u.online ? '<span class="tag online">ONLINE</span>' : ''}
            </div>
            <div class="u-sub">@${esc(u.username)} · joined ${new Date(u.createdAt).toLocaleDateString()}</div>
          </div>
          <div class="u-actions">
            <button class="mini-btn" data-act="pass">Reset password</button>
            <button class="mini-btn danger" data-act="del">Delete</button>
          </div>`;
        row.querySelector('[data-act="pass"]').addEventListener('click', async () => {
          const password = prompt(`New password for @${u.username} (min 6 characters):`);
          if (!password) return;
          try {
            await api(`/api/admin/users/${u.id}/password`, { method: 'POST', body: JSON.stringify({ password }) });
            toast(`Password updated for @${u.username}`);
          } catch (e) { toast(e.message); }
        });
        row.querySelector('[data-act="del"]').addEventListener('click', async () => {
          if (!confirm(`Delete @${u.username}? Their messages will be removed too.`)) return;
          try {
            await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
            toast(`Deleted @${u.username}`);
            load();
          } catch (e) { toast(e.message); }
        });
        list.appendChild(row);
      }
    } catch (e) { toast(e.message); }
  }

  $('#addForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: $('#newUser').value.trim(),
          displayName: $('#newName').value.trim(),
          password: $('#newPass').value,
          isAdmin: $('#newAdmin').checked
        })
      });
      toast('User added — they can sign in now');
      e.target.reset();
      load();
    } catch (ex) { toast(ex.message); }
  });

  load();
  setInterval(load, 10000); // refresh stats every 10s
})();
