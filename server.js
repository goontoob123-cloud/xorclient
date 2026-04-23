const express = require('express');
const path = require('path');
const cors = require('cors');
const https = require('https');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory player cache — persists until server restarts
// playFabId (or 'user:username') -> { username, playFabId, firstSeen, lastSeen }
const playerCache = {};

// Store active players
const activePlayers = new Map(); // username -> { roomCode, lastSeen, playerCount, maxPlayers, playFabId }

// Blacklist — username -> { reason, blacklistedAt }
const blacklist = new Map();

// Cleanup inactive players every minute
setInterval(() => {
    const now = Date.now();
    for (const [username, data] of activePlayers.entries()) {
        if (now - data.lastSeen > 60000) { // 60 seconds timeout
            activePlayers.delete(username);
        }
    }
}, 60000);

// Heartbeat endpoint - players send their status every 30 seconds
app.post('/api/heartbeat', (req, res) => {
    const { username, roomCode, playerCount, maxPlayers, timestamp, playFabId } = req.body;
    
    if (!username) {
        return res.status(400).json({ error: 'Username required' });
    }
    
    activePlayers.set(username, {
        roomCode: roomCode || 'Not in room',
        playerCount: playerCount || 0,
        maxPlayers: maxPlayers || 0,
        lastSeen: Date.now(),
        lastSeenTime: timestamp,
        playFabId: playFabId || ''
    });

    // Cache player — always save by username, use playFabId as key if available
    const cacheKey = playFabId || ('user:' + username);
    const existing = playerCache[cacheKey];
    const now = new Date().toISOString();
    if (!existing) {
        playerCache[cacheKey] = { username, playFabId: playFabId || '', firstSeen: now, lastSeen: now };
    } else {
        existing.username  = username;
        existing.playFabId = playFabId || '';
        existing.lastSeen  = now;
        if (playFabId && cacheKey.startsWith('user:')) {
            playerCache[playFabId] = existing;
            delete playerCache[cacheKey];
        }
    }
    
    console.log(`[HEARTBEAT] ${username} (${playFabId || 'no id'}) - Room: ${roomCode || 'None'} - Players: ${playerCount || 0}/${maxPlayers || 0}`);
    
    res.json({ 
        success: true, 
        onlineCount: activePlayers.size,
        timestamp: new Date().toISOString()
    });
});

// Search endpoint
app.get('/api/search', (req, res) => {
    const searchUsername = req.query.username;
    
    if (!searchUsername) {
        return res.status(400).json({ error: 'Username parameter required' });
    }
    
    const results = [];
    
    // Search for matching usernames (case-insensitive partial match)
    for (const [username, data] of activePlayers.entries()) {
        if (username.toLowerCase().includes(searchUsername.toLowerCase())) {
            results.push({
                username: username,
                roomCode: data.roomCode,
                lastSeen: data.lastSeenTime
            });
        }
    }
    
    console.log(`[SEARCH] Query: "${searchUsername}" - Found ${results.length} results`);
    
    res.json(results);
});

// Get online count endpoint (for the mod to display)
app.get('/api/onlinecount', (req, res) => {
    res.json({ onlineCount: activePlayers.size });
});

// Simple status endpoint (no HTML, just JSON) — no PlayFab IDs exposed publicly
app.get('/api/status', (req, res) => {
    const players = [];
    for (const [username, data] of activePlayers.entries()) {
        players.push({
            username:    username,
            roomCode:    data.roomCode,
            playerCount: data.playerCount,
            maxPlayers:  data.maxPlayers
        });
    }
    res.json({ onlineCount: activePlayers.size, players, timestamp: new Date().toISOString() });
});

// List all cached players (username + playFabId, no room codes)
app.get('/api/players', (req, res) => {
    const list = Object.entries(playerCache).map(([playFabId, data]) => ({
        playFabId,
        username:  data.username,
        firstSeen: data.firstSeen,
        lastSeen:  data.lastSeen
    }));
    // Sort by lastSeen descending
    list.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
    res.json({ total: list.length, players: list });
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Owner verification — ID lives server-side only, never exposed to client
const OWNER_ID  = "94C4211189AD542C";
const ADMIN_KEY = process.env.ADMIN_KEY || "xorvlynadmin2024";

// Rate limiting for blacklist check — prevent brute-force enumeration
const checkRateMap = new Map(); // ip -> { count, resetAt }
function rateLimit(req, res, next) {
    const ip  = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = checkRateMap.get(ip);
    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + 60000 }; // reset every minute
        checkRateMap.set(ip, entry);
    }
    entry.count++;
    if (entry.count > 30) { // max 30 checks per minute per IP
        return res.status(429).json({ error: 'Too many requests' });
    }
    next();
}

// Admin middleware — accepts key in body (POST) OR as ?key= query param (GET, browser-friendly)
function requireAdmin(req, res, next) {
    if (!ADMIN_KEY) return res.status(503).json({ error: 'Not configured' });
    const provided = (req.body && req.body.adminKey) || req.query.key;
    if (!provided || provided !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
    next();
}

app.get('/api/verify', (req, res) => {
    const id = req.query.id;
    if (!id) return res.status(400).json({ owner: false });
    res.json({ owner: id === OWNER_ID });
});

// Blacklist check — rate limited, returns minimal info
app.get('/api/blacklist/check', rateLimit, (req, res) => {
    const username = req.query.username;
    if (!username) return res.status(400).json({ blacklisted: false });
    const entry = blacklist.get(username.toLowerCase());
    if (entry) return res.json({ blacklisted: true, reason: entry.reason });
    res.json({ blacklisted: false });
});

// ── Admin-only routes — POST body required, key never in URL ──────────
// Blacklist:   POST /api/admin/bl  { adminKey, username, reason }
// Unblacklist: POST /api/admin/ubl { adminKey, username }
// Players:     POST /api/admin/players { adminKey }
// These route names are intentionally short and non-descriptive

app.post('/api/admin/bl', requireAdmin, (req, res) => {
    const { username, reason } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    blacklist.set(username.toLowerCase(), { reason: reason || 'No reason given', blacklistedAt: new Date().toISOString() });
    console.log(`[BL] +${username} — ${reason || 'no reason'}`);
    res.json({ success: true });
});

app.post('/api/admin/ubl', requireAdmin, (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    const existed = blacklist.delete(username.toLowerCase());
    console.log(`[BL] -${username} (existed: ${existed})`);
    res.json({ success: true, wasBlacklisted: existed });
});

app.post('/api/admin/players', requireAdmin, (req, res) => {
    const list = Object.entries(playerCache).map(([key, data]) => ({
        playFabId: data.playFabId || key,
        username:  data.username,
        firstSeen: data.firstSeen,
        lastSeen:  data.lastSeen
    }));
    list.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
    res.json({ total: list.length, players: list });
});

// Block the old public GET routes so they return 404 instead of leaking info
app.get('/api/blacklist',   (_, res) => res.status(404).end());
app.get('/api/unblacklist', (_, res) => res.status(404).end());
app.get('/api/players',     (_, res) => res.status(404).end());

app.listen(port, () => {
    console.log(`API server running on port ${port}`);
    console.log(`ADMIN_KEY configured: ${!!ADMIN_KEY}`);
    console.log(`Public endpoints: /api/heartbeat, /api/search, /api/onlinecount, /api/status, /api/verify, /api/blacklist/check`);
    console.log(`Admin endpoints (POST + adminKey in body): /api/admin/bl, /api/admin/ubl, /api/admin/players`);
});
