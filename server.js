const express = require('express');
const path    = require('path');
const cors    = require('cors');
const https   = require('https');
const crypto  = require('crypto');

const app  = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── Config ────────────────────────────────────────────────────────────
const OWNER_ID    = "94C4211189AD542C";
const ADMIN_KEY   = process.env.ADMIN_KEY   || "xorvlynadmin2024";
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK || "";

// Notification queue: username -> [{ title, message }]
const notifyQueue = new Map();
const playerCache   = {};
const blacklist     = new Map();
const activePlayers = new Map();
// key -> { owner, hwid, tier, createdAt, expiresAt, lastUsed, useCount, banned, banReason, lastUsername }
const keyStore      = new Map();
// sessionToken -> { key, hwid, username, createdAt, expiresAt, tier }
const sessions      = new Map();
const authRateMap   = new Map();
const checkRateMap  = new Map();

// ── Discord webhook ───────────────────────────────────────────────────
function sendWebhook(title, description, color) {
    if (!WEBHOOK_URL) return;
    const body = JSON.stringify({
        embeds: [{ title, description, color: color || 0x2b2d31, timestamp: new Date().toISOString(), footer: { text: 'Xor Client' } }]
    });
    try {
        const u = new URL(WEBHOOK_URL);
        const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
        r.on('error', () => {});
        r.write(body); r.end();
    } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────
function genKey() {
    const s = () => crypto.randomBytes(2).toString('hex').toUpperCase();
    return `XORV-${s()}-${s()}-${s()}-${s()}`;
}
function genToken()      { return crypto.randomBytes(32).toString('hex'); }
function hashHwid(hwid)  { return crypto.createHash('sha256').update(hwid + 'xorvsalt2024').digest('hex'); }
function isExpired(e)    { return e.expiresAt && Date.now() > new Date(e.expiresAt).getTime(); }

function requireAdmin(req, res, next) {
    const k = (req.body && req.body.adminKey) || req.query.key;
    if (!k || k !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
    next();
}
function authRate(req, res, next) {
    const ip = req.ip || 'x'; const now = Date.now();
    let e = authRateMap.get(ip);
    if (!e || now > e.r) { e = { c: 0, r: now + 60000 }; authRateMap.set(ip, e); }
    if (++e.c > 10) return res.status(429).json({ error: 'Too many attempts. Wait 1 minute.' });
    next();
}
function checkRate(req, res, next) {
    const ip = req.ip || 'x'; const now = Date.now();
    let e = checkRateMap.get(ip);
    if (!e || now > e.r) { e = { c: 0, r: now + 60000 }; checkRateMap.set(ip, e); }
    if (++e.c > 60) return res.status(429).json({ error: 'Rate limited' });
    next();
}

// Cleanup
setInterval(() => { const n = Date.now(); for (const [t, s] of sessions) if (n > new Date(s.expiresAt).getTime()) sessions.delete(t); }, 600000);
setInterval(() => { const n = Date.now(); for (const [u, d] of activePlayers) if (n - d.lastSeen > 60000) activePlayers.delete(u); }, 60000);

// =====================================================================
//  KEY AUTH
// =====================================================================

// POST /api/auth/validate  { key, hwid, username }
// Returns session token on success
app.post('/api/auth/validate', authRate, (req, res) => {
    const { key, hwid, username } = req.body;
    if (!key || !hwid) return res.status(400).json({ success: false, error: 'Key and HWID required' });

    const entry = keyStore.get(key);
    if (!entry) {
        sendWebhook('❌ Invalid Key', `Key: \`${key}\`\nUser: \`${username||'?'}\``, 0xed4245);
        return res.status(401).json({ success: false, error: 'Invalid key' });
    }
    if (entry.banned) {
        sendWebhook('🚫 Banned Key Used', `Key: \`${key}\`\nUser: \`${username||'?'}\`\nReason: ${entry.banReason}`, 0xed4245);
        return res.status(403).json({ success: false, error: 'Key banned: ' + (entry.banReason || 'contact support') });
    }
    if (isExpired(entry)) return res.status(403).json({ success: false, error: 'Key expired' });

    const hashed = hashHwid(hwid);
    if (!entry.hwid) {
        entry.hwid = hashed;
        sendWebhook('🔑 Key Activated', `Key: \`${key}\`\nUser: \`${username||'?'}\`\nTier: \`${entry.tier}\``, 0x57f287);
    } else if (entry.hwid !== hashed) {
        sendWebhook('⚠️ HWID Mismatch', `Key: \`${key}\`\nUser: \`${username||'?'}\``, 0xfee75c);
        return res.status(403).json({ success: false, error: 'Key is bound to a different machine. Contact support to reset.' });
    }

    entry.lastUsed = new Date().toISOString();
    entry.useCount = (entry.useCount || 0) + 1;
    if (username) entry.lastUsername = username;

    const token   = genToken();
    const expires = new Date(Date.now() + 86400000).toISOString(); // 24h
    sessions.set(token, { key, hwid: hashed, username: username||'', createdAt: new Date().toISOString(), expiresAt: expires, tier: entry.tier });

    res.json({ success: true, token, tier: entry.tier, expiresAt: expires });
});

// POST /api/auth/check  { token, hwid }
// Verify session is still valid (called on heartbeat)
app.post('/api/auth/check', checkRate, (req, res) => {
    const { token, hwid } = req.body;
    if (!token || !hwid) return res.status(400).json({ valid: false });
    const s = sessions.get(token);
    if (!s) return res.json({ valid: false, error: 'Session not found' });
    if (Date.now() > new Date(s.expiresAt).getTime()) { sessions.delete(token); return res.json({ valid: false, error: 'Session expired' }); }
    if (s.hwid !== hashHwid(hwid)) return res.json({ valid: false, error: 'HWID mismatch' });
    const entry = keyStore.get(s.key);
    if (!entry || entry.banned) return res.json({ valid: false, error: 'Key revoked' });
    res.json({ valid: true, tier: s.tier });
});

// GET /api/auth/status?token=TOKEN
app.get('/api/auth/status', checkRate, (req, res) => {
    const s = sessions.get(req.query.token);
    if (!s || Date.now() > new Date(s.expiresAt).getTime()) return res.json({ valid: false });
    res.json({ valid: true, tier: s.tier, expiresAt: s.expiresAt });
});

// =====================================================================
//  ADMIN — KEY MANAGEMENT
// =====================================================================

// GET /api/admin/genkey?key=ADMIN&tier=user&days=30&owner=NAME
app.get('/api/admin/genkey', requireAdmin, (req, res) => {
    const { tier, days, owner } = req.query;
    const newKey    = genKey();
    const expiresAt = days ? new Date(Date.now() + parseInt(days) * 86400000).toISOString() : null;
    keyStore.set(newKey, { owner: owner||'unknown', hwid: null, tier: tier||'user', createdAt: new Date().toISOString(), expiresAt, lastUsed: null, useCount: 0, banned: false, banReason: null, lastUsername: null });
    sendWebhook('🔑 Key Generated', `Key: \`${newKey}\`\nOwner: \`${owner||'unknown'}\`\nTier: \`${tier||'user'}\`\nExpires: \`${expiresAt||'never'}\``, 0x57f287);
    res.json({ success: true, key: newKey, tier: tier||'user', expiresAt });
});

// GET /api/admin/revokekey?key=ADMIN&target=KEY&reason=REASON
app.get('/api/admin/revokekey', requireAdmin, (req, res) => {
    const { target, reason } = req.query;
    if (!target) return res.status(400).json({ error: 'Target required' });
    const entry = keyStore.get(target);
    if (!entry) return res.status(404).json({ error: 'Key not found' });
    entry.banned = true; entry.banReason = reason || 'Revoked by admin';
    for (const [t, s] of sessions) if (s.key === target) sessions.delete(t);
    sendWebhook('🔨 Key Revoked', `Key: \`${target}\`\nOwner: \`${entry.owner}\`\nReason: ${reason||'none'}`, 0xed4245);
    res.json({ success: true });
});

// GET /api/admin/resetkey?key=ADMIN&target=KEY  — reset HWID binding
app.get('/api/admin/resetkey', requireAdmin, (req, res) => {
    const { target } = req.query;
    if (!target) return res.status(400).json({ error: 'Target required' });
    const entry = keyStore.get(target);
    if (!entry) return res.status(404).json({ error: 'Key not found' });
    entry.hwid = null;
    sendWebhook('🔄 HWID Reset', `Key: \`${target}\`\nOwner: \`${entry.owner}\``, 0x5865f2);
    res.json({ success: true });
});

// GET /api/admin/unbankey?key=ADMIN&target=KEY
app.get('/api/admin/unbankey', requireAdmin, (req, res) => {
    const { target } = req.query;
    if (!target) return res.status(400).json({ error: 'Target required' });
    const entry = keyStore.get(target);
    if (!entry) return res.status(404).json({ error: 'Key not found' });
    entry.banned = false; entry.banReason = null;
    sendWebhook('✅ Key Unbanned', `Key: \`${target}\`\nOwner: \`${entry.owner}\``, 0x57f287);
    res.json({ success: true });
});

// GET /api/admin/keys?key=ADMIN  — list all keys
app.get('/api/admin/keys', requireAdmin, (req, res) => {
    const list = [];
    for (const [k, v] of keyStore)
        list.push({ key: k, owner: v.owner, tier: v.tier, hwid: v.hwid ? v.hwid.substring(0,8)+'...' : null, createdAt: v.createdAt, expiresAt: v.expiresAt, lastUsed: v.lastUsed, useCount: v.useCount, banned: v.banned, lastUsername: v.lastUsername });
    res.json({ total: list.length, keys: list });
});

// =====================================================================
//  EXISTING ENDPOINTS
// =====================================================================

app.post('/api/heartbeat', (req, res) => {
    const { username, roomCode, playerCount, maxPlayers, timestamp, playFabId } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    activePlayers.set(username, { roomCode: roomCode||'Not in room', playerCount: playerCount||0, maxPlayers: maxPlayers||0, lastSeen: Date.now(), lastSeenTime: timestamp, playFabId: playFabId||'' });
    const ck = playFabId || ('user:' + username);
    const ex = playerCache[ck]; const now = new Date().toISOString();
    if (!ex) { playerCache[ck] = { username, playFabId: playFabId||'', firstSeen: now, lastSeen: now }; }
    else { ex.username = username; ex.playFabId = playFabId||''; ex.lastSeen = now; if (playFabId && ck.startsWith('user:')) { playerCache[playFabId] = ex; delete playerCache[ck]; } }
    // Drain any queued notifications for this user
    const pending = notifyQueue.get(username) || [];
    notifyQueue.delete(username);

    res.json({ success: true, onlineCount: activePlayers.size, timestamp: new Date().toISOString(), notifications: pending });
});

// GET /api/admin/notify?key=ADMIN&username=NAME&title=TITLE&message=MSG
// Push a real-time notification to a specific player (delivered on next heartbeat)
// Use username=* to broadcast to everyone currently online
app.get('/api/admin/notify', requireAdmin, (req, res) => {
    const { username, title, message } = req.query;
    if (!username || !title) return res.status(400).json({ error: 'username and title required' });
    const notif = { title, message: message || '' };
    if (username === '*') {
        // Broadcast to all active players
        let count = 0;
        for (const [u] of activePlayers) {
            const q = notifyQueue.get(u) || [];
            q.push(notif);
            notifyQueue.set(u, q);
            count++;
        }
        sendWebhook('📢 Broadcast Notification', `Title: **${title}**\nMessage: ${message||''}\nRecipients: ${count}`, 0x5865f2);
        return res.json({ success: true, recipients: count });
    }
    const q = notifyQueue.get(username) || [];
    q.push(notif);
    notifyQueue.set(username, q);
    sendWebhook('🔔 Notification Sent', `To: \`${username}\`\nTitle: **${title}**\nMessage: ${message||''}`, 0x5865f2);
    res.json({ success: true, username, queued: q.length });
});

app.get('/api/search', (req, res) => {
    const q = req.query.username;
    if (!q) return res.status(400).json({ error: 'Username required' });
    const results = [];
    for (const [u, d] of activePlayers) if (u.toLowerCase().includes(q.toLowerCase())) results.push({ username: u, roomCode: d.roomCode, lastSeen: d.lastSeenTime });
    res.json(results);
});

app.get('/api/onlinecount', (req, res) => res.json({ onlineCount: activePlayers.size }));

app.get('/api/status', (req, res) => {
    const players = [];
    for (const [u, d] of activePlayers) players.push({ username: u, roomCode: d.roomCode, playerCount: d.playerCount, maxPlayers: d.maxPlayers });
    res.json({ onlineCount: activePlayers.size, players, timestamp: new Date().toISOString() });
});

app.get('/api/verify', (req, res) => {
    const id = req.query.id;
    if (!id) return res.status(400).json({ owner: false });
    res.json({ owner: id === OWNER_ID });
});

app.get('/api/blacklist/check', checkRate, (req, res) => {
    const u = req.query.username;
    if (!u) return res.status(400).json({ blacklisted: false });
    const e = blacklist.get(u.toLowerCase());
    res.json(e ? { blacklisted: true, reason: e.reason } : { blacklisted: false });
});

app.get('/api/admin/bl',  requireAdmin, (req, res) => { const { username, reason } = req.query; if (!username) return res.status(400).json({ error: 'Username required' }); blacklist.set(username.toLowerCase(), { reason: reason||'No reason', blacklistedAt: new Date().toISOString() }); sendWebhook('🚫 Blacklisted', `User: \`${username}\`\nReason: ${reason||'none'}`, 0xed4245); res.json({ success: true }); });
app.get('/api/admin/ubl', requireAdmin, (req, res) => { const { username } = req.query; if (!username) return res.status(400).json({ error: 'Username required' }); blacklist.delete(username.toLowerCase()); sendWebhook('✅ Unblacklisted', `User: \`${username}\``, 0x57f287); res.json({ success: true }); });

app.get('/api/admin/players', requireAdmin, (req, res) => {
    const list = Object.entries(playerCache).map(([k, d]) => ({ playFabId: d.playFabId||k, username: d.username, firstSeen: d.firstSeen, lastSeen: d.lastSeen }));
    list.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
    res.json({ total: list.length, players: list });
});

app.get('/api/blacklist',   (_, res) => res.status(404).end());
app.get('/api/unblacklist', (_, res) => res.status(404).end());
app.get('/api/players',     (_, res) => res.status(404).end());

// GET /api
app.get('/api', (req, res) => {
    res.type('text/plain').send(`Xor Client API
Admin routes require ?key=ADMIN_KEY

--- AUTH ---
POST /api/auth/validate       body: { key, hwid, username }
POST /api/auth/check          body: { token, hwid }
GET  /api/auth/status         ?token=TOKEN

--- PUBLIC ---
POST /api/heartbeat           body: { username, roomCode, playerCount, maxPlayers, timestamp, playFabId }
GET  /api/search              ?username=QUERY
GET  /api/onlinecount
GET  /api/status
GET  /api/verify              ?id=PLAYFAB_ID
GET  /api/blacklist/check     ?username=NAME

--- ADMIN: KEYS ---
GET  /api/admin/genkey        ?key= &tier=user &days=30 &owner=NAME
GET  /api/admin/revokekey     ?key= &target=KEY &reason=REASON
GET  /api/admin/resetkey      ?key= &target=KEY
GET  /api/admin/unbankey      ?key= &target=KEY
GET  /api/admin/keys          ?key=

--- ADMIN: PLAYERS & MODERATION ---
GET  /api/admin/players       ?key=
GET  /api/admin/bl            ?key= &username=NAME &reason=REASON
GET  /api/admin/ubl           ?key= &username=NAME
GET  /api/admin/notify        ?key= &username=NAME|* &title=TITLE &message=MSG
`);
});

app.get('/', (req, res) => {
    try { res.sendFile(path.join(__dirname, 'public', 'index.html')); } catch { res.json({ status: 'Xor Client API' }); }
});

app.listen(port, () => {
    console.log(`Xor Client API on port ${port}`);
    console.log(`Webhook: ${WEBHOOK_URL ? 'set' : 'not set'}`);
    console.log(`Auth endpoints: POST /api/auth/validate | POST /api/auth/check | GET /api/auth/status`);
    console.log(`Key mgmt: GET /api/admin/genkey | revokekey | resetkey | unbankey | keys`);
});
