const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store connected clients
const clients = new Set();

// Create WebSocket server
const wss = new WebSocket.Server({ port: process.env.WS_PORT || 8080 });

wss.on('connection', (ws) => {
    console.log('New client connected');
    clients.add(ws);
    
    ws.on('message', (message) => {
        console.log('Received:', message.toString());
        // Broadcast to all other clients if needed
        clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message.toString());
            }
        });
    });
    
    ws.on('close', () => {
        console.log('Client disconnected');
        clients.delete(ws);
    });
    
    ws.send(JSON.stringify({ title: 'Connected', message: 'WebSocket connection established!', id: 'connection' }));
});

// API endpoint to send notifications
app.post('/api/send-notification', (req, res) => {
    const { title, message } = req.body;
    
    if (!title || !message) {
        return res.status(400).json({ error: 'Title and message are required' });
    }
    
    const notification = {
        title: title.toUpperCase(),
        message: message,
        id: Date.now().toString()
    };
    
    // Send to all connected clients
    let sentCount = 0;
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(notification));
            sentCount++;
        }
    });
    
    res.json({ 
        success: true, 
        message: `Notification sent to ${sentCount} client(s)`,
        notification: notification
    });
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`HTTP server running on port ${port}`);
    console.log(`WebSocket server running on port ${process.env.WS_PORT || 8080}`);
});
