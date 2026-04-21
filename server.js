const express = require('express');
const path = require('path');
const cors = require('cors');
const fs   = require('fs');
const https = require('https');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── GitHub persistence config ─────────────────────────────────────────────────
// Set these as environment variables on Render, never hardcode tokens
const GH_TOKEN  = process.env.GH_TOKEN;
const GH_OWNER  = process.env.GH_OWNER || 'goontoob123-cloud';
const GH_REPO   = process.env.GH_REPO  || 'xorclient';
const GH_PATH   = 'players.json';

let playerCache = {};
let ghFileSha   = null; // needed for GitHub API updates

// Load players.json from GitHub on startup
async function loadPlayersFromGitHub() {
    if (!GH_TOKEN || !GH_OWNER || !GH_REPO) {
        console.log('[CACHE] GitHub env vars not set, using in-memory only');
        return;
    }
    try {
        const data = await ghGet(`/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}`);
        const parsed = JSON.parse(data);
        ghFileSha   = parsed.sha;
        playerCache = JSON.parse(Buffer.from(parsed.content, 'base64').toString('utf8'));
        console.log(`[CACHE] Loaded ${Object.keys(playerCache).length} players from GitHub`);
    } catch (e) {
        console.log('[CACHE] Could not load players.json from GitHub:', e.message);
    }
}

// Save players.json to GitHub
let saveQueued = false;
function scheduleSave() {
    if (saveQueued) return;
    saveQueued = true;
    setTimeout(async () => {
        saveQueued = false;
        await savePlayersToGitHub();
    }, 5000); // debounce — save at most once every 5s
}

async function savePlayersToGitHub() {
    if (!GH_TOKEN || !GH_OWNER || !GH_REPO) return;
    try {
        const content = Buffer.from(JSON.stringify(playerCache, null, 2)).toString('base64');
        const body = JSON.stringify({
            message: 'chore: update players cache',
            content,
            sha: ghFileSha || undefined
        });
        const result = await ghPut(`/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}`, body);
        const parsed = JSON.parse(result);
        if (parsed.content && parsed.content.sha) ghFileSha = parsed.content.sha;
        console.log(`[CACHE] Saved ${Object.keys(playerCache).length} players to GitHub`);
    } catch (e) {
        console.error('[CACHE] Failed to save to GitHub:', e.message);
    }
}

function ghGet(apiPath) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: apiPath,
            method: 'GET',
            headers: { 'Authorization': `token ${GH_TOKEN}`, 'User-Agent': 'xorv-server', 'Accept': 'application/vnd.github.v3+json' }
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => res.statusCode >= 400 ? reject(new Error(`HTTP ${res.statusCode}: ${data}`)) : resolve(data));
        });
        req.on('error', reject);
        req.end();
    });
}

function ghPut(apiPath, body) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: apiPath,
            method: 'PUT',
            headers: { 'Authorization': `token ${GH_TOKEN}`, 'User-Agent': 'xorv-server', 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => res.statusCode >= 400 ? reject(new Error(`HTTP ${res.statusCode}: ${data}`)) : resolve(data));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// Load on startup
loadPlayersFromGitHub();

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
        scheduleSave();
    } else {
        const changed = existing.username !== username || existing.playFabId !== (playFabId || '');
        existing.username  = username;
        existing.playFabId = playFabId || '';
        existing.lastSeen  = now;
        if (playFabId && cacheKey.startsWith('user:')) {
            playerCache[playFabId] = existing;
            delete playerCache[cacheKey];
        }
        scheduleSave();
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
const OWNER_ID = "94C4211189AD542C";
app.get('/api/verify', (req, res) => {
    const id = req.query.id;
    if (!id) return res.status(400).json({ owner: false });
    res.json({ owner: id === OWNER_ID });
});

// Blacklist check — mod calls this on startup
app.get('/api/blacklist/check', (req, res) => {
    const username = req.query.username;
    if (!username) return res.status(400).json({ blacklisted: false });
    const entry = blacklist.get(username.toLowerCase());
    if (entry) return res.json({ blacklisted: true, reason: entry.reason });
    res.json({ blacklisted: false });
});

// Blacklist a player — GET /api/blacklist?username=NAME&reason=REASON
app.get('/api/blacklist', (req, res) => {
    const { username, reason } = req.query;
    if (!username) return res.status(400).json({ error: 'Username required' });
    blacklist.set(username.toLowerCase(), { reason: reason || 'No reason given', blacklistedAt: new Date().toISOString() });
    console.log(`[BLACKLIST] Added: ${username} — Reason: ${reason || 'No reason given'}`);
    res.json({ success: true, username, reason: reason || 'No reason given' });
});

// Unblacklist a player — GET /api/unblacklist?username=NAME
app.get('/api/unblacklist', (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'Username required' });
    const existed = blacklist.delete(username.toLowerCase());
    console.log(`[BLACKLIST] Removed: ${username} (was blacklisted: ${existed})`);
    res.json({ success: true, username, wasBlacklisted: existed });
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
