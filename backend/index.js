// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { PeerServer } = require('peer');

// ──────────────────────────────────────────────
// 1. Socket.IO + Express server (port 3001)
// ──────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: "*",
  credentials: true
}));

app.use(express.json());

const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'Socket.IO server running', 
    port: 3001,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Room management
const rooms = new Map();
const DEFAULT_ROOM = 'conference-room';

// Track user sessions
const userSessions = new Map();

io.on('connection', (socket) => {
  console.log('✅ Socket.IO client connected:', socket.id);

  // Heartbeat for connection health
  socket.on('ping', () => {
    socket.emit('pong', { timestamp: Date.now() });
  });

  socket.on('join-default-room', (userId) => {
    console.log(`🎯 User ${userId} joining room ${DEFAULT_ROOM}`);

    socket.userId = userId;
    socket.join(DEFAULT_ROOM);

    // Store user session
    userSessions.set(userId, {
      socketId: socket.id,
      joinedAt: new Date(),
      room: DEFAULT_ROOM
    });

    if (!rooms.has(DEFAULT_ROOM)) {
      rooms.set(DEFAULT_ROOM, new Set());
    }
    rooms.get(DEFAULT_ROOM).add(userId);

    // Notify others about new user
    socket.to(DEFAULT_ROOM).emit('user-connected', userId);

    // Send current user list to the new user
    const currentUsers = Array.from(rooms.get(DEFAULT_ROOM)).filter(id => id !== userId);
    socket.emit('current-users', currentUsers);

    console.log(`🏠 Room ${DEFAULT_ROOM} now has ${rooms.get(DEFAULT_ROOM).size} users:`, Array.from(rooms.get(DEFAULT_ROOM)));
  });

  socket.on('disconnect', (reason) => {
    const userId = socket.userId;
    if (!userId) return;

    console.log(`❌ User disconnected: ${userId} (reason: ${reason})`);

    // Cleanup user session
    userSessions.delete(userId);

    if (rooms.has(DEFAULT_ROOM)) {
      rooms.get(DEFAULT_ROOM).delete(userId);
      
      if (rooms.get(DEFAULT_ROOM).size === 0) {
        rooms.delete(DEFAULT_ROOM);
        console.log(`🗑️ Room ${DEFAULT_ROOM} is now empty and has been removed`);
      } else {
        // Notify others about user departure
        socket.to(DEFAULT_ROOM).emit('user-disconnected', userId);
        console.log(`🏠 Room ${DEFAULT_ROOM} now has ${rooms.get(DEFAULT_ROOM).size} users`);
      }
    }
  });

  socket.on('error', (error) => {
    console.error('❌ Socket error:', error);
  });
});

// Admin endpoint to check room status
app.get('/admin/rooms', (req, res) => {
  const roomData = {};
  rooms.forEach((users, roomName) => {
    roomData[roomName] = {
      userCount: users.size,
      users: Array.from(users)
    };
  });

  res.json({
    totalRooms: rooms.size,
    totalUsers: userSessions.size,
    rooms: roomData,
    activeSessions: Array.from(userSessions.entries()).map(([userId, session]) => ({
      userId,
      socketId: session.socketId,
      joinedAt: session.joinedAt,
      room: session.room
    }))
  });
});

server.listen(3001, () => {
  console.log(`🚀 Socket.IO server running on http://localhost:3001`);
  console.log(`📊 Admin endpoint available at http://localhost:3001/admin/rooms`);
});

// ──────────────────────────────────────────────
// 2. Dedicated PeerJS server (port 3002)
// ──────────────────────────────────────────────
const peerServer = PeerServer({
  port: 3002,
  path: '/peerjs',
  allow_discovery: true,
  proxied: true,
  key: 'peerjs', // You can change this for security
  ssl: false // Set to true if using HTTPS
});

peerServer.on('connection', (client) => {
  console.log('🔗 PeerJS client connected:', client.getId());
});

peerServer.on('disconnect', (client) => {
  console.log('🔗 PeerJS client disconnected:', client.getId());
});

peerServer.on('error', (error) => {
  console.error('❌ PeerJS server error:', error);
});

// PeerJS health check
const peerApp = express();
peerApp.get('/health', (req, res) => {
  res.json({ 
    status: 'PeerJS server running', 
    port: 3002,
    timestamp: new Date().toISOString()
  });
});

peerServer.on('listening', () => {
  console.log(`🚀 PeerJS server running on http://localhost:3002/peerjs`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Socket.IO server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Socket.IO server closed');
    process.exit(0);
  });
});