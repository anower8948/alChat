// lib/db.js — tiny JSON-file database. Zero native dependencies, works anywhere.
// Data lives in data/db.json (persists on Azure App Service under /home/site/wwwroot).
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let db = { users: [], messages: [], nextUserId: 1, nextMsgId: 1 };
let saveTimer = null;

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('DB load failed, starting fresh:', e.message);
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function save() {
  // Debounced write so rapid messages don't hammer the disk
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(db));
    } catch (e) {
      console.error('DB save failed:', e.message);
    }
  }, 150);
}

load();

module.exports = {
  get users() { return db.users; },
  get messages() { return db.messages; },

  addUser(user) {
    user.id = db.nextUserId++;
    db.users.push(user);
    save();
    return user;
  },
  findUserByName(username) {
    return db.users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
  },
  findUserById(id) {
    return db.users.find(u => u.id === Number(id));
  },
  updateUser(id, patch) {
    const u = this.findUserById(id);
    if (u) { Object.assign(u, patch); save(); }
    return u;
  },
  deleteUser(id) {
    id = Number(id);
    db.users = db.users.filter(u => u.id !== id);
    db.messages = db.messages.filter(m => m.from !== id && m.to !== id);
    save();
  },

  addMessage(msg) {
    msg.id = db.nextMsgId++;
    db.messages.push(msg);
    // Keep the file from growing forever — cap at 50k messages
    if (db.messages.length > 50000) db.messages = db.messages.slice(-40000);
    save();
    return msg;
  },
  getConversation(a, b, limit = 200) {
    a = Number(a); b = Number(b);
    return db.messages
      .filter(m => (m.from === a && m.to === b) || (m.from === b && m.to === a))
      .slice(-limit);
  },
  markRead(readerId, peerId) {
    readerId = Number(readerId); peerId = Number(peerId);
    let changed = [];
    for (const m of db.messages) {
      if (m.from === peerId && m.to === readerId && !m.read) {
        m.read = true;
        changed.push(m.id);
      }
    }
    if (changed.length) save();
    return changed;
  },
  findMessage(id) {
    return db.messages.find(m => m.id === Number(id));
  },
  setReaction(msgId, userId, emoji) {
    const m = this.findMessage(msgId);
    if (!m) return null;
    m.reactions = m.reactions || {};
    if (emoji) m.reactions[userId] = emoji;
    else delete m.reactions[userId];
    save();
    return m;
  },
  lastMessagesPerPeer(userId) {
    userId = Number(userId);
    const map = {};
    for (const m of db.messages) {
      if (m.from === userId || m.to === userId) {
        const peer = m.from === userId ? m.to : m.from;
        map[peer] = m;
      }
    }
    return map;
  },
  unreadCounts(userId) {
    userId = Number(userId);
    const counts = {};
    for (const m of db.messages) {
      if (m.to === userId && !m.read) counts[m.from] = (counts[m.from] || 0) + 1;
    }
    return counts;
  },
  saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
  }
};
