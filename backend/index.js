// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

// ──────────────────────────────────────────────
// 1. Socket.IO + Express server (port 3001)
// ──────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: "http://localhost:5173",
  credentials: true
}));

const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'Socket.IO server running', port: 3001 });
});

// Room management
const rooms = new Map();
const DEFAULT_ROOM = 'default-room';

io.on('connection', (socket) => {
  console.log('✅ Socket.IO client connected:', socket.id);

  socket.on('join-default-room', (userId) => {
    console.log(`🎯 User ${userId} joining room ${DEFAULT_ROOM}`);

    socket.userId = userId;
    socket.join(DEFAULT_ROOM);

    if (!rooms.has(DEFAULT_ROOM)) {
      rooms.set(DEFAULT_ROOM, new Set());
    }
    rooms.get(DEFAULT_ROOM).add(userId);

    // Tell everyone else a new user arrived
    socket.to(DEFAULT_ROOM).emit('user-connected', userId);

    // Send current user list to the new user (excluding themselves)
    const currentUsers = Array.from(rooms.get(DEFAULT_ROOM)).filter(id => id !== userId);
    socket.emit('current-users', currentUsers);

    console.log(`🏠 Room now has ${rooms.get(DEFAULT_ROOM).size} users`);
  });

  socket.on('disconnect', () => {
    const userId = socket.userId;
    if (!userId) return;

    console.log(`❌ User disconnected: ${userId}`);

    if (rooms.has(DEFAULT_ROOM)) {
      rooms.get(DEFAULT_ROOM).delete(userId);
      if (rooms.get(DEFAULT_ROOM).size === 0) {
        rooms.delete(DEFAULT_ROOM);
      } else {
        socket.to(DEFAULT_ROOM).emit('user-disconnected', userId);
      }
    }
  });
});

server.listen(3001, () => {
  console.log(`🚀 Socket.IO server running on http://localhost:3001`);
});

// ──────────────────────────────────────────────
// 2. Dedicated PeerJS server (port 3002)
// ──────────────────────────────────────────────
const { PeerServer } = require('peer');

const peerServer = PeerServer({
  port: 3002,
  path: '/peerjs',
  allow_discovery: true,     // optional, helps debugging
  // You can add SSL here later if needed
});

peerServer.on('connection', (client) => {
  console.log('🔗 PeerJS client connected:', client.getId());
});

peerServer.on('disconnect', (client) => {
  console.log('🔗 PeerJS client disconnected:', client.getId());
});

console.log(`🚀 PeerJS server running on http://localhost:3002/peerjs`);