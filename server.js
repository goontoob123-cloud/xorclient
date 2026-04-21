const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store active players
const activePlayers = new Map(); // username -> { roomCode, lastSeen, playerCount, maxPlayers }

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
    const { username, roomCode, playerCount, maxPlayers, timestamp } = req.body;
    
    if (!username) {
        return res.status(400).json({ error: 'Username required' });
    }
    
    activePlayers.set(username, {
        roomCode: roomCode || 'Not in room',
        playerCount: playerCount || 0,
        maxPlayers: maxPlayers || 0,
        lastSeen: Date.now(),
        lastSeenTime: timestamp
    });
    
    // Log to console (server logs)
    console.log(`[HEARTBEAT] ${username} - Room: ${roomCode || 'None'} - Players: ${playerCount || 0}/${maxPlayers || 0}`);
    
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

app.listen(port, () => {
    console.log(`API server running on port ${port}`);
    console.log(`Tracked players will appear in console logs`);
    console.log(`API endpoints:`);
    console.log(`  POST /api/heartbeat - Player heartbeat`);
    console.log(`  GET  /api/search?username= - Search players`);
    console.log(`  GET  /api/onlinecount - Get online count`);
    console.log(`  GET  /api/status - Get all players (JSON only)`);
    console.log(`  GET  /api/verify?id= - Owner verification`);
});
