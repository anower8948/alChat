// app.js — alChat client
(() => {
  const $ = s => document.querySelector(s);
  const TOKEN_KEY = 'alchat_token';

  let me = null;
  let socket = null;
  let contacts = [];
  let activePeer = null;
  let typingTimeout = null;
  let iAmTypingTimer = null;

  // ---------- helpers ----------
  const api = async (url, opts = {}) => {
    const res = await fetch(url, {
      ...opts,
      headers: {
        ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        Authorization: 'Bearer ' + localStorage.getItem(TOKEN_KEY),
        ...(opts.headers || {})
      }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = n => n.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const fmtTime = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDay = ts => {
    const d = new Date(ts), now = new Date();
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, now)) return 'Today';
    const y = new Date(now); y.setDate(y.getDate() - 1);
    if (same(d, y)) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  };
  const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  const toast = (msg) => {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._t);
    t._t = setTimeout(() => (t.hidden = true), 2600);
  };
  const avatarEl = (el, user, withDot = false) => {
    el.textContent = initials(user.displayName || user.username);
    el.style.background = `linear-gradient(180deg, ${user.color || '#8E8E93'}, ${shade(user.color || '#8E8E93')})`;
    if (withDot) {
      let dot = el.querySelector('.dot');
      if (!dot) { dot = document.createElement('span'); dot.className = 'dot'; el.appendChild(dot); }
      dot.classList.toggle('on', !!user.online);
    }
  };
  const shade = hex => {
    const n = parseInt(hex.slice(1), 16);
    const f = c => Math.max(0, c - 38);
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  };

  // ---------- login ----------
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#loginError');
    err.hidden = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('#loginUser').value.trim(), password: $('#loginPass').value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sign in failed');
      localStorage.setItem(TOKEN_KEY, data.token);
      boot(data.user);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  $('#logoutBtn').addEventListener('click', () => {
    localStorage.removeItem(TOKEN_KEY);
    location.reload();
  });

  async function tryResume() {
    if (!localStorage.getItem(TOKEN_KEY)) return;
    try {
      const { user } = await api('/api/me');
      boot(user);
    } catch { localStorage.removeItem(TOKEN_KEY); }
  }

  // ---------- boot ----------
  function boot(user) {
    me = user;
    $('#loginScreen').hidden = true;
    $('#app').hidden = false;
    $('#meName').textContent = me.displayName;
    avatarEl($('#meAvatar'), me);
    $('#adminLink').hidden = !me.isAdmin;
    connectSocket();
    loadContacts();
  }

  function connectSocket() {
    socket = io({ auth: { token: localStorage.getItem(TOKEN_KEY) } });

    socket.on('connect_error', e => { if (e.message === 'unauthorized') { localStorage.removeItem(TOKEN_KEY); location.reload(); } });

    socket.on('message:new', msg => {
      Sounds.receive();
      if (activePeer && msg.from === activePeer.id) {
        appendMessage(msg, true);
        socket.emit('messages:read', { peerId: activePeer.id });
      }
      loadContacts();
    });

    socket.on('messages:read', ({ by }) => {
      if (activePeer && by === activePeer.id) {
        document.querySelectorAll('.meta-line.delivered').forEach(el => {
          el.textContent = 'Read ' + fmtTime(Date.now());
          el.classList.remove('delivered');
        });
      }
    });

    socket.on('typing', ({ from, typing }) => {
      if (activePeer && from === activePeer.id) {
        $('#typingRow').hidden = !typing;
        if (typing) scrollToBottom();
        clearTimeout(typingTimeout);
        if (typing) typingTimeout = setTimeout(() => ($('#typingRow').hidden = true), 5000);
      }
    });

    socket.on('reaction', ({ msgId, reactions }) => {
      const row = document.querySelector(`.msg-row[data-id="${msgId}"]`);
      if (row) renderTapbacks(row, reactions);
    });

    socket.on('presence', ({ userId, online }) => {
      const c = contacts.find(c => c.id === userId);
      if (c) c.online = online;
      renderContacts();
      if (activePeer && activePeer.id === userId) {
        activePeer.online = online;
        updatePeerStatus();
      }
    });

    socket.on('users:changed', loadContacts);

    // calls
    socket.on('call:offer', onIncomingCall);
    socket.on('call:answer', onCallAnswer);
    socket.on('call:candidate', onCallCandidate);
    socket.on('call:end', () => endCall(false, 'Call ended'));
    socket.on('call:decline', () => endCall(false, 'Declined'));
  }

  // ---------- contacts ----------
  async function loadContacts() {
    try {
      const { users } = await api('/api/users');
      contacts = users;
      renderContacts();
    } catch (e) { console.error(e); }
  }

  $('#search').addEventListener('input', renderContacts);

  function renderContacts() {
    const q = $('#search').value.trim().toLowerCase();
    const list = $('#contactList');
    list.innerHTML = '';
    const sorted = [...contacts].sort((a, b) => (b.lastMessage?.at || 0) - (a.lastMessage?.at || 0));
    for (const c of sorted) {
      if (q && !c.displayName.toLowerCase().includes(q) && !c.username.toLowerCase().includes(q)) continue;
      const el = document.createElement('div');
      el.className = 'contact' + (activePeer?.id === c.id ? ' active' : '');
      el.innerHTML = `
        <div class="avatar"></div>
        <div class="c-body">
          <div class="c-top">
            <span class="c-name">${esc(c.displayName)}</span>
            <span class="c-time">${c.lastMessage ? fmtTime(c.lastMessage.at) : ''}</span>
          </div>
          <div class="c-preview">${c.lastMessage ? esc(c.lastMessage.text) : '@' + esc(c.username)}</div>
        </div>
        ${c.unread ? `<div class="badge">${c.unread}</div>` : ''}`;
      avatarEl(el.querySelector('.avatar'), c, true);
      el.addEventListener('click', () => openChat(c));
      list.appendChild(el);
    }
    if (!list.children.length) {
      list.innerHTML = `<p style="text-align:center;color:var(--text-2);padding:30px 16px;font-size:14px">${q ? 'No matches' : 'No other users yet. Ask your admin to add people.'}</p>`;
    }
  }

  // ---------- conversation ----------
  async function openChat(peer) {
    activePeer = peer;
    $('#emptyState').hidden = true;
    $('#conversation').hidden = false;
    $('#app').classList.add('in-chat');
    $('#peerName').textContent = peer.displayName;
    avatarEl($('#peerAvatar'), peer, true);
    updatePeerStatus();
    renderContacts();
    $('#typingRow').hidden = true;

    const box = $('#messages');
    box.innerHTML = '';
    try {
      const { messages } = await api('/api/messages/' + peer.id);
      let lastDay = '', lastFrom = null, lastAt = 0;
      for (const m of messages) {
        const day = fmtDay(m.at);
        if (day !== lastDay) {
          box.insertAdjacentHTML('beforeend', `<div class="day-sep">${day} ${fmtTime(m.at)}</div>`);
          lastDay = day;
        }
        appendMessage(m, false, { grouped: m.from === lastFrom && m.at - lastAt < 120000 });
        lastFrom = m.from; lastAt = m.at;
      }
      markTailBubbles();
      scrollToBottom(false);
      socket.emit('messages:read', { peerId: peer.id });
      const c = contacts.find(c => c.id === peer.id);
      if (c) { c.unread = 0; renderContacts(); }
    } catch (e) { toast(e.message); }
    $('#msgInput').focus();
  }

  $('#backBtn').addEventListener('click', () => {
    $('#app').classList.remove('in-chat');
    $('#conversation').hidden = true;
    $('#emptyState').hidden = false;
    activePeer = null;
    renderContacts();
  });

  function updatePeerStatus() {
    const s = $('#peerStatus');
    if (activePeer.online) { s.textContent = 'online'; s.classList.add('online'); }
    else {
      s.classList.remove('online');
      s.textContent = activePeer.lastSeen ? 'last seen ' + fmtDay(activePeer.lastSeen).toLowerCase() + ' ' + fmtTime(activePeer.lastSeen) : 'offline';
    }
  }

  function appendMessage(m, scroll = true, { grouped = false } = {}) {
    const mine = m.from === me.id;
    const row = document.createElement('div');
    row.className = `msg-row ${mine ? 'me' : 'them'}${grouped ? '' : ' gap'}`;
    row.dataset.id = m.id;

    const b = document.createElement('div');
    b.className = `bubble ${mine ? 'me' : 'them'}`;

    if (m.type === 'image') {
      b.innerHTML = `<img class="chat-img" src="${esc(m.url)}" alt="${esc(m.fileName || 'photo')}" loading="lazy">`;
      b.querySelector('img').addEventListener('click', () => window.open(m.url, '_blank'));
    } else if (m.type === 'file') {
      b.innerHTML = `<a class="file-card" href="${esc(m.url)}" download="${esc(m.fileName)}" target="_blank">
        <span class="file-icon">📄</span>
        <span class="file-meta"><span class="file-name">${esc(m.fileName)}</span><span class="file-size">${fmtSize(m.size || 0)}</span></span></a>`;
    } else {
      b.textContent = m.text;
    }

    // tapback picker on right-click / long-press
    let pressTimer;
    b.addEventListener('contextmenu', e => { e.preventDefault(); showReactionPicker(e.clientX, e.clientY, m.id); });
    b.addEventListener('touchstart', e => { pressTimer = setTimeout(() => showReactionPicker(e.touches[0].clientX, e.touches[0].clientY, m.id), 480); }, { passive: true });
    b.addEventListener('touchend', () => clearTimeout(pressTimer));
    b.addEventListener('touchmove', () => clearTimeout(pressTimer));

    row.appendChild(b);
    $('#messages').appendChild(row);
    if (m.reactions && Object.keys(m.reactions).length) renderTapbacks(row, m.reactions);

    // delivery/read line on my last message
    if (mine) {
      document.querySelectorAll('.meta-line').forEach(el => el.remove());
      const meta = document.createElement('div');
      meta.className = 'meta-line' + (m.read ? '' : ' delivered');
      meta.textContent = m.read ? 'Read' : 'Delivered';
      $('#messages').appendChild(meta);
    }
    markTailBubbles();
    if (scroll) scrollToBottom();
  }

  function markTailBubbles() {
    const rows = [...document.querySelectorAll('.msg-row')];
    rows.forEach((r, i) => {
      const next = rows[i + 1];
      const isTail = !next || next.classList.contains('me') !== r.classList.contains('me') || next.classList.contains('gap');
      r.classList.toggle('tail', isTail);
    });
  }

  function renderTapbacks(row, reactions) {
    row.querySelector('.tapbacks')?.remove();
    const vals = Object.values(reactions || {});
    if (!vals.length) return;
    const t = document.createElement('div');
    t.className = 'tapbacks';
    t.textContent = [...new Set(vals)].join('') + (vals.length > 1 ? ' ' + vals.length : '');
    row.appendChild(t);
  }

  // reaction picker
  const picker = $('#reactionPicker');
  let pickerMsgId = null;
  function showReactionPicker(x, y, msgId) {
    pickerMsgId = msgId;
    picker.hidden = false;
    const w = 290;
    picker.style.left = Math.min(Math.max(8, x - w / 2), innerWidth - w - 8) + 'px';
    picker.style.top = Math.max(8, y - 64) + 'px';
  }
  picker.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    Sounds.tap();
    socket.emit('reaction', { msgId: pickerMsgId, emoji: btn.dataset.emoji });
    picker.hidden = true;
  }));
  document.addEventListener('click', e => { if (!picker.contains(e.target)) picker.hidden = true; });

  function scrollToBottom(smooth = true) {
    const box = $('#messages');
    box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  // ---------- composer ----------
  const input = $('#msgInput');
  const sendBtn = $('#sendBtn');

  input.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim();
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    if (activePeer) {
      socket.emit('typing', { to: activePeer.id, typing: true });
      clearTimeout(iAmTypingTimer);
      iAmTypingTimer = setTimeout(() => socket.emit('typing', { to: activePeer.id, typing: false }), 1800);
    }
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  sendBtn.addEventListener('click', send);

  function send() {
    const text = input.value.trim();
    if (!text || !activePeer) return;
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    socket.emit('typing', { to: activePeer.id, typing: false });
    socket.emit('message:send', { to: activePeer.id, type: 'text', text }, res => {
      if (res?.error) return toast(res.error);
      Sounds.send();
      appendMessage(res.msg, true);
      loadContacts();
    });
  }

  // file upload
  $('#attachBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !activePeer) return;
    if (file.size > 25 * 1024 * 1024) return toast('Files up to 25 MB');
    toast('Uploading ' + file.name + '…');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const up = await api('/api/upload', { method: 'POST', body: fd });
      const type = up.mime?.startsWith('image/') ? 'image' : 'file';
      socket.emit('message:send', { to: activePeer.id, type, ...up }, res => {
        if (res?.error) return toast(res.error);
        Sounds.send();
        appendMessage(res.msg, true);
        loadContacts();
      });
    } catch (ex) { toast(ex.message); }
  });

  // ---------- WebRTC calls ----------
  const RTC_CONFIG = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
  let pc = null, localStream = null, callPeer = null, callVideo = false, pendingOffer = null, callTimer = null, callStart = 0;

  $('#audioCallBtn').addEventListener('click', () => startCall(false));
  $('#videoCallBtn').addEventListener('click', () => startCall(true));
  $('#hangupBtn').addEventListener('click', () => endCall(true));
  $('#acceptBtn').addEventListener('click', acceptCall);
  $('#muteBtn').addEventListener('click', () => {
    const track = localStream?.getAudioTracks()[0];
    if (track) { track.enabled = !track.enabled; $('#muteBtn').classList.toggle('off', !track.enabled); }
  });
  $('#camBtn').addEventListener('click', () => {
    const track = localStream?.getVideoTracks()[0];
    if (track) { track.enabled = !track.enabled; $('#camBtn').classList.toggle('off', !track.enabled); }
  });

  async function getMedia(video) {
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: video ? { width: 1280, height: 720 } : false });
  }

  function newPC(peerId) {
    pc = new RTCPeerConnection(RTC_CONFIG);
    pc.onicecandidate = e => { if (e.candidate) socket.emit('call:candidate', { to: peerId, candidate: e.candidate }); };
    pc.ontrack = e => {
      $('#remoteVideo').srcObject = e.streams[0];
      setCallState('Connected', true);
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected'].includes(pc.connectionState)) endCall(false, 'Connection lost');
    };
    return pc;
  }

  function showCallUI(peer, state, { incoming = false, video = false } = {}) {
    callPeer = peer;
    callVideo = video;
    $('#callOverlay').hidden = false;
    $('#callName').textContent = peer.displayName;
    avatarEl($('#callAvatar'), peer);
    setCallState(state);
    $('#acceptBtn').hidden = !incoming;
    $('#camBtn').hidden = !video;
    $('#muteBtn').classList.remove('off');
    $('#camBtn').classList.remove('off');
  }
  function setCallState(text, connected = false) {
    $('#callState').textContent = text;
    if (connected && !callTimer) {
      Sounds.stopRing();
      callStart = Date.now();
      callTimer = setInterval(() => {
        const s = Math.floor((Date.now() - callStart) / 1000);
        $('#callState').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      }, 1000);
    }
  }

  async function startCall(video) {
    if (!activePeer) return;
    if (!navigator.mediaDevices?.getUserMedia) return toast('Calls need HTTPS and mic/camera access');
    try {
      localStream = await getMedia(video);
    } catch { return toast('Microphone/camera permission denied'); }
    showCallUI(activePeer, 'Calling…', { video });
    if (video) $('#localVideo').srcObject = localStream;
    Sounds.startRing(false);
    newPC(activePeer.id);
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('call:offer', { to: activePeer.id, sdp: offer, video });
  }

  function onIncomingCall({ from, sdp, video }) {
    if (pc || pendingOffer) { socket.emit('call:decline', { to: from }); return; } // busy
    const peer = contacts.find(c => c.id === from) || { id: from, displayName: 'Unknown', color: '#8E8E93' };
    pendingOffer = { from, sdp, video };
    showCallUI(peer, (video ? 'Incoming video call' : 'Incoming call'), { incoming: true, video });
    Sounds.startRing(true);
  }

  async function acceptCall() {
    if (!pendingOffer) return;
    const { from, sdp, video } = pendingOffer;
    try {
      localStream = await getMedia(video);
    } catch { socket.emit('call:decline', { to: from }); return endCall(false, 'Mic/camera denied'); }
    Sounds.stopRing();
    $('#acceptBtn').hidden = true;
    if (video) { $('#localVideo').srcObject = localStream; $('#camBtn').hidden = false; }
    newPC(from);
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('call:answer', { to: from, sdp: answer });
    pendingOffer = null;
    setCallState('Connecting…');
  }

  async function onCallAnswer({ sdp }) {
    if (pc) { await pc.setRemoteDescription(new RTCSessionDescription(sdp)); setCallState('Connecting…'); }
  }
  async function onCallCandidate({ candidate }) {
    try { if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { console.warn(e); }
  }

  function endCall(notifyPeer, reason = 'Call ended') {
    Sounds.stopRing();
    if (pendingOffer && notifyPeer) socket.emit('call:decline', { to: pendingOffer.from });
    else if (callPeer && notifyPeer) socket.emit('call:end', { to: callPeer.id });
    if (pc || pendingOffer) Sounds.callEnd();
    pendingOffer = null;
    clearInterval(callTimer); callTimer = null;
    pc?.close(); pc = null;
    localStream?.getTracks().forEach(t => t.stop()); localStream = null;
    $('#remoteVideo').srcObject = null;
    $('#localVideo').srcObject = null;
    setCallState(reason);
    setTimeout(() => { $('#callOverlay').hidden = true; callPeer = null; }, 900);
  }

  tryResume();
})();
