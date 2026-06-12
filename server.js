// server.js — alChat backend
// Express REST API + Socket.IO realtime + WebRTC signaling for calls.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Server } = require('socket.io');
const db = require('./lib/db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('[alChat] JWT_SECRET not set — using a random secret (sessions reset on restart). Set JWT_SECRET in Azure App Settings for production.');
}

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- Seed default admin ----------
if (!db.users.length) {
  db.addUser({
    username: 'admin',
    passwordHash: bcrypt.hashSync('admin123', 10),
    displayName: 'Administrator',
    isAdmin: true,
    color: '#5856D6',
    createdAt: Date.now()
  });
  console.log('[alChat] Seeded default admin → username: admin / password: admin123 (change it!)');
}

// ---------- Middleware ----------
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

function sign(user) {
  return jwt.sign({ id: user.id, username: user.username, isAdmin: !!user.isAdmin }, JWT_SECRET, { expiresIn: '7d' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    if (!db.findUserById(req.user.id)) return res.status(401).json({ error: 'Account no longer exists' });
    next();
  } catch {
    res.status(401).json({ error: 'Session expired — sign in again' });
  }
}
function adminOnly(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
}
const publicUser = u => ({
  id: u.id, username: u.username, displayName: u.displayName || u.username,
  color: u.color, isAdmin: !!u.isAdmin, createdAt: u.createdAt, lastSeen: u.lastSeen || null
});

// ---------- Auth ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.findUserByName(username || '');
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: publicUser(db.findUserById(req.user.id)) });
});

app.post('/api/me/password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = db.findUserById(req.user.id);
  if (!bcrypt.compareSync(currentPassword || '', user.passwordHash)) {
    return res.status(400).json({ error: 'Current password is wrong' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  db.updateUser(user.id, { passwordHash: bcrypt.hashSync(newPassword, 10) });
  res.json({ ok: true });
});

// ---------- Contacts & messages ----------
app.get('/api/users', auth, (req, res) => {
  const lasts = db.lastMessagesPerPeer(req.user.id);
  const unread = db.unreadCounts(req.user.id);
  const list = db.users
    .filter(u => u.id !== req.user.id)
    .map(u => ({
      ...publicUser(u),
      online: presence.has(u.id),
      lastMessage: lasts[u.id] ? summary(lasts[u.id]) : null,
      unread: unread[u.id] || 0
    }));
  res.json({ users: list });
});

function summary(m) {
  return {
    id: m.id, from: m.from, to: m.to, at: m.at, read: !!m.read,
    text: m.type === 'text' ? m.text : (m.type === 'image' ? '📷 Photo' : '📎 ' + (m.fileName || 'File'))
  };
}

app.get('/api/messages/:peerId', auth, (req, res) => {
  const peer = db.findUserById(req.params.peerId);
  if (!peer) return res.status(404).json({ error: 'User not found' });
  res.json({ messages: db.getConversation(req.user.id, peer.id) });
});

// ---------- File uploads ----------
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
    cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '-' + safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } }); // 25 MB

app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  res.json({
    url: '/uploads/' + req.file.filename,
    fileName: req.file.originalname,
    size: req.file.size,
    mime: req.file.mimetype
  });
});

// ---------- Admin API ----------
app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  res.json({
    users: db.users.map(u => ({ ...publicUser(u), online: presence.has(u.id) })),
    stats: {
      totalUsers: db.users.length,
      totalMessages: db.messages.length,
      onlineNow: presence.size
    }
  });
});

app.post('/api/admin/users', auth, adminOnly, (req, res) => {
  const { username, password, displayName, isAdmin } = req.body || {};
  if (!username || !/^[a-zA-Z0-9._-]{3,24}$/.test(username)) {
    return res.status(400).json({ error: 'Username: 3–24 letters, numbers, dot, dash or underscore' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (db.findUserByName(username)) return res.status(409).json({ error: 'Username already taken' });
  const colors = ['#FF9500', '#FF2D55', '#5856D6', '#34C759', '#007AFF', '#AF52DE', '#FF3B30', '#00C7BE'];
  const user = db.addUser({
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    displayName: (displayName || username).slice(0, 40),
    isAdmin: !!isAdmin,
    color: colors[Math.floor(Math.random() * colors.length)],
    createdAt: Date.now()
  });
  io.emit('users:changed');
  res.json({ user: publicUser(user) });
});

app.post('/api/admin/users/:id/password', auth, adminOnly, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const user = db.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.updateUser(user.id, { passwordHash: bcrypt.hashSync(password, 10) });
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  const user = db.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
  db.deleteUser(user.id);
  const sock = presence.get(user.id);
  if (sock) io.to(sock).disconnectSockets(true);
  io.emit('users:changed');
  res.json({ ok: true });
});

// ---------- Socket.IO realtime ----------
const presence = new Map(); // userId -> socket room name

io.use((socket, next) => {
  try {
    const payload = jwt.verify(socket.handshake.auth?.token || '', JWT_SECRET);
    const user = db.findUserById(payload.id);
    if (!user) return next(new Error('unauthorized'));
    socket.user = payload;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  const uid = socket.user.id;
  const room = 'u:' + uid;
  socket.join(room);
  presence.set(uid, room);
  io.emit('presence', { userId: uid, online: true });

  socket.on('message:send', (data, ack) => {
    const peer = db.findUserById(data?.to);
    if (!peer) return ack && ack({ error: 'User not found' });
    const type = ['text', 'image', 'file'].includes(data.type) ? data.type : 'text';
    const msg = db.addMessage({
      from: uid, to: peer.id, type,
      text: type === 'text' ? String(data.text || '').slice(0, 4000) : undefined,
      url: type !== 'text' ? data.url : undefined,
      fileName: data.fileName, size: data.size, mime: data.mime,
      at: Date.now(), read: false, reactions: {}
    });
    io.to('u:' + peer.id).emit('message:new', msg);
    ack && ack({ msg });
  });

  socket.on('messages:read', ({ peerId }) => {
    const changed = db.markRead(uid, peerId);
    if (changed.length) io.to('u:' + Number(peerId)).emit('messages:read', { by: uid, ids: changed });
  });

  socket.on('typing', ({ to, typing }) => {
    io.to('u:' + Number(to)).emit('typing', { from: uid, typing: !!typing });
  });

  socket.on('reaction', ({ msgId, emoji }, ack) => {
    const m = db.setReaction(msgId, uid, emoji || null);
    if (!m) return ack && ack({ error: 'Message not found' });
    const payload = { msgId: m.id, reactions: m.reactions };
    io.to('u:' + m.from).emit('reaction', payload);
    io.to('u:' + m.to).emit('reaction', payload);
    ack && ack({ ok: true });
  });

  // ----- WebRTC call signaling (audio/video) -----
  socket.on('call:offer', ({ to, sdp, video }) => {
    io.to('u:' + Number(to)).emit('call:offer', { from: uid, sdp, video: !!video });
  });
  socket.on('call:answer', ({ to, sdp }) => {
    io.to('u:' + Number(to)).emit('call:answer', { from: uid, sdp });
  });
  socket.on('call:candidate', ({ to, candidate }) => {
    io.to('u:' + Number(to)).emit('call:candidate', { from: uid, candidate });
  });
  socket.on('call:end', ({ to }) => {
    io.to('u:' + Number(to)).emit('call:end', { from: uid });
  });
  socket.on('call:decline', ({ to }) => {
    io.to('u:' + Number(to)).emit('call:decline', { from: uid });
  });

  socket.on('disconnect', () => {
    if (presence.get(uid) === room && !io.sockets.adapter.rooms.get(room)) {
      presence.delete(uid);
      db.updateUser(uid, { lastSeen: Date.now() });
      io.emit('presence', { userId: uid, online: false });
    }
  });
});

// ---------- Pages ----------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

process.on('SIGTERM', () => { db.saveNow(); process.exit(0); });

server.listen(PORT, () => console.log(`[alChat] running on http://localhost:${PORT}`));
