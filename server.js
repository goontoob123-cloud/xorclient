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

// Simple status endpoint (no HTML, just JSON)
app.get('/api/status', (req, res) => {
    const players = [];
    for (const [username, data] of activePlayers.entries()) {
        players.push({
            username: username,
            playFabId: data.playFabId || '',
            roomCode: data.roomCode,
            playerCount: data.playerCount,
            maxPlayers: data.maxPlayers
        });
    }
    
    res.json({
        onlineCount: activePlayers.size,
        players: players,
        timestamp: new Date().toISOString()
    });
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
// Admin key — set ADMIN_KEY env var on Render, required for blacklist management
const ADMIN_KEY = process.env.ADMIN_KEY || null;

function requireAdmin(req, res, next) {
    if (!ADMIN_KEY) {
        // No key configured — lock down completely
        return res.status(503).json({ error: 'Admin not configured' });
    }
    const provided = req.headers['x-admin-key'] || req.query.key;
    if (provided !== ADMIN_KEY) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    next();
}

app.get('/api/verify', (req, res) => {
    const id = req.query.id;
    if (!id) return res.status(400).json({ owner: false });
    res.json({ owner: id === OWNER_ID });
});

// Blacklist check — public, mod calls this on startup
app.get('/api/blacklist/check', (req, res) => {
    const username = req.query.username;
    if (!username) return res.status(400).json({ blacklisted: false });
    const entry = blacklist.get(username.toLowerCase());
    if (entry) return res.json({ blacklisted: true, reason: entry.reason });
    res.json({ blacklisted: false });
});

// Blacklist a player — requires admin key in x-admin-key header or ?key=
// Usage: GET /api/blacklist?username=NAME&reason=REASON  (+ header x-admin-key: YOUR_KEY)
app.get('/api/blacklist', requireAdmin, (req, res) => {
    const { username, reason } = req.query;
    if (!username) return res.status(400).json({ error: 'Username required' });
    blacklist.set(username.toLowerCase(), { reason: reason || 'No reason given', blacklistedAt: new Date().toISOString() });
    console.log(`[BLACKLIST] Added: ${username} — Reason: ${reason || 'No reason given'}`);
    res.json({ success: true, username, reason: reason || 'No reason given' });
});

// Unblacklist — requires admin key
app.get('/api/unblacklist', requireAdmin, (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'Username required' });
    const existed = blacklist.delete(username.toLowerCase());
    console.log(`[BLACKLIST] Removed: ${username} (was blacklisted: ${existed})`);
    res.json({ success: true, username, wasBlacklisted: existed });
});

// Players list — requires admin key (don't expose IDs publicly)
app.get('/api/players', requireAdmin, (req, res) => {
    const list = Object.entries(playerCache).map(([key, data]) => ({
        playFabId: data.playFabId || key,
        username:  data.username,
        firstSeen: data.firstSeen,
        lastSeen:  data.lastSeen
    }));
    list.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
    res.json({ total: list.length, players: list });
});

app.listen(port, () => {
    console.log(`API server running on port ${port}`);
    console.log(`Tracked players will appear in console logs`);
    console.log(`API endpoints:`);
    console.log(`  POST /api/heartbeat - Player heartbeat`);
    console.log(`  GET  /api/search?username= - Search players`);
    console.log(`  GET  /api/onlinecount - Get online count`);
    console.log(`  GET  /api/status - Get all players (JSON only)`);
    console.log(`  GET  /api/verify?id= - Owner verification`);
    console.log(`  GET  /api/blacklist/check?username= - Check if blacklisted`);
    console.log(`  GET  /api/blacklist?username=&reason= - Blacklist player`);
    console.log(`  GET  /api/unblacklist?username= - Unblacklist player`);
    console.log(`  GET  /api/players - List all cached players + IDs`);
});
