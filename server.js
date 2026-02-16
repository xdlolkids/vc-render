const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid'); // We'll need to install this

// Create Express app
const app = express();
const server = http.createServer(app);

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store room information
const rooms = new Map(); // roomCode -> { host: ws, peer: ws, users: Set }

// Generate random room code
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    console.log(`[${new Date().toISOString()}] New client connected`);
    
    // Assign unique ID to this connection
    ws.id = uuidv4();
    ws.roomCode = null;
    ws.role = null;

    // Handle incoming messages
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log(`[${new Date().toISOString()}] Received:`, message.type, 'from', ws.id);
            
            switch (message.type) {
                case 'create-room':
                    handleCreateRoom(ws);
                    break;
                    
                case 'join-room':
                    handleJoinRoom(ws, message.roomCode);
                    break;
                    
                case 'offer':
                case 'answer':
                case 'ice-candidate':
                    // Forward WebRTC signaling data to the other peer in the room
                    forwardToPeer(ws, message);
                    break;
                    
                case 'leave-room':
                    handleLeaveRoom(ws);
                    break;
                    
                default:
                    console.log('Unknown message type:', message.type);
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    // Handle disconnection
    ws.on('close', () => {
        console.log(`[${new Date().toISOString()}] Client disconnected:`, ws.id);
        handleLeaveRoom(ws);
    });
});

// Handle room creation
function handleCreateRoom(ws) {
    // Generate unique room code
    let roomCode;
    do {
        roomCode = generateRoomCode();
    } while (rooms.has(roomCode));
    
    // Create new room with this client as host
    rooms.set(roomCode, {
        host: ws,
        peer: null,
        users: new Set([ws.id])
    });
    
    ws.roomCode = roomCode;
    ws.role = 'host';
    
    // Send room code back to client
    ws.send(JSON.stringify({
        type: 'room-created',
        roomCode: roomCode,
        role: 'host'
    }));
    
    console.log(`[${new Date().toISOString()}] Room created: ${roomCode} by host ${ws.id}`);
}

// Handle joining a room
function handleJoinRoom(ws, roomCode) {
    const room = rooms.get(roomCode);
    
    if (!room) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Room not found'
        }));
        return;
    }
    
    if (room.peer) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Room is full'
        }));
        return;
    }
    
    // Add peer to room
    room.peer = ws;
    room.users.add(ws.id);
    ws.roomCode = roomCode;
    ws.role = 'peer';
    
    // Notify peer that they joined successfully
    ws.send(JSON.stringify({
        type: 'room-joined',
        roomCode: roomCode,
        role: 'peer'
    }));
    
    // Notify host that peer joined
    if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.send(JSON.stringify({
            type: 'peer-joined',
            role: 'host'
        }));
    }
    
    console.log(`[${new Date().toISOString()}] Peer ${ws.id} joined room ${roomCode}`);
}

// Forward messages to the other peer in the room
function forwardToPeer(ws, message) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    // Determine target (the other peer in the room)
    const target = ws === room.host ? room.peer : room.host;
    
    if (target && target.readyState === WebSocket.OPEN) {
        // Add sender role to message for context
        message.senderRole = ws.role;
        target.send(JSON.stringify(message));
        console.log(`[${new Date().toISOString()}] Forwarded ${message.type} from ${ws.role} to ${ws.role === 'host' ? 'peer' : 'host'}`);
    }
}

// Handle user leaving room
function handleLeaveRoom(ws) {
    if (!ws.roomCode) return;
    
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    // Remove user from room
    room.users.delete(ws.id);
    
    // Notify the other peer if they're still connected
    const otherPeer = ws === room.host ? room.peer : room.host;
    if (otherPeer && otherPeer.readyState === WebSocket.OPEN) {
        otherPeer.send(JSON.stringify({
            type: 'peer-left',
            role: otherPeer.role
        }));
    }
    
    // Clean up room if empty
    if (room.users.size === 0) {
        rooms.delete(ws.roomCode);
        console.log(`[${new Date().toISOString()}] Room ${ws.roomCode} deleted (empty)`);
    } else if (ws === room.host) {
        // Host left, but peer is still there - delete room
        if (room.peer && room.peer.readyState === WebSocket.OPEN) {
            room.peer.send(JSON.stringify({
                type: 'host-left',
                message: 'Host has left the room'
            }));
        }
        rooms.delete(ws.roomCode);
        console.log(`[${new Date().toISOString()}] Room ${ws.roomCode} deleted (host left)`);
    } else if (ws === room.peer) {
        // Peer left, update room
        room.peer = null;
        console.log(`[${new Date().toISOString()}] Peer left room ${ws.roomCode}`);
    }
    
    ws.roomCode = null;
    ws.role = null;
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] Server running on port ${PORT}`);
    console.log(`[${new Date().toISOString()}] WebSocket server ready`);
});