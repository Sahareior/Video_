const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { PeerServer } = require('peer');
const { v4: uuidv4 } = require('uuid');

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

// Room management
const rooms = new Map();
const userSessions = new Map();

// Sample groups data
const sampleGroups = [
  {
    id: 'dev-team',
    name: 'Development Team',
    description: 'Weekly development sync meetings',
    maxMembers: 20,
    createdAt: new Date(),
    isPublic: true
  },
  {
    id: 'design-review',
    name: 'Design Review',
    description: 'Design feedback and collaboration',
    maxMembers: 15,
    createdAt: new Date(),
    isPublic: true
  },
  {
    id: 'project-alpha',
    name: 'Project Alpha',
    description: 'Main project discussion group',
    maxMembers: 25,
    createdAt: new Date(),
    isPublic: true
  },
  {
    id: 'marketing-team',
    name: 'Marketing Team',
    description: 'Marketing campaign discussions',
    maxMembers: 12,
    createdAt: new Date(),
    isPublic: true
  }
];

// Initialize sample groups
sampleGroups.forEach(group => {
  if (!rooms.has(group.id)) {
    rooms.set(group.id, {
      id: group.id,
      name: group.name,
      description: group.description,
      maxMembers: group.maxMembers,
      createdAt: group.createdAt,
      isPublic: group.isPublic,
      users: new Set(),
      userCount: 0
    });
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

// Get available groups
app.get('/api/groups', (req, res) => {
  const groups = Array.from(rooms.values()).map(room => ({
    id: room.id,
    name: room.name,
    description: room.description,
    maxMembers: room.maxMembers,
    userCount: room.users.size,
    isPublic: room.isPublic,
    createdAt: room.createdAt
  }));
  res.json(groups);
});

// Create new group
app.post('/api/groups', (req, res) => {
  const { name, description, maxMembers = 20, isPublic = true } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Group name is required' });
  }

  const groupId = name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();
  
  const newGroup = {
    id: groupId,
    name,
    description: description || `${name} video call group`,
    maxMembers,
    isPublic,
    createdAt: new Date(),
    users: new Set(),
    userCount: 0
  };

  rooms.set(groupId, newGroup);
  
  res.status(201).json({
    id: newGroup.id,
    name: newGroup.name,
    description: newGroup.description,
    maxMembers: newGroup.maxMembers,
    userCount: 0,
    isPublic: newGroup.isPublic,
    createdAt: newGroup.createdAt
  });
});

io.on('connection', (socket) => {
  console.log('✅ Socket.IO client connected:', socket.id);

  // Heartbeat for connection health
  socket.on('ping', () => {
    socket.emit('pong', { timestamp: Date.now() });
  });

  // Join a specific room
  socket.on('join-room', (data) => {
    const { userId, roomId } = data;
    
    if (!rooms.has(roomId)) {
      socket.emit('join-error', { message: 'Room does not exist' });
      return;
    }

    const room = rooms.get(roomId);
    
    // Check if room is full
    if (room.users.size >= room.maxMembers) {
      socket.emit('join-error', { message: 'Room is full' });
      return;
    }

    // Leave previous room if any
    if (socket.roomId) {
      socket.leave(socket.roomId);
      const previousRoom = rooms.get(socket.roomId);
      if (previousRoom) {
        previousRoom.users.delete(socket.userId);
        previousRoom.userCount = previousRoom.users.size;
        socket.to(socket.roomId).emit('user-left', {
          userId: socket.userId,
          roomId: socket.roomId,
          userCount: previousRoom.userCount
        });
      }
    }

    // Join new room
    socket.userId = userId;
    socket.roomId = roomId;
    socket.join(roomId);

    // Store user session
    userSessions.set(userId, {
      socketId: socket.id,
      joinedAt: new Date(),
      room: roomId
    });

    // Add user to room
    room.users.add(userId);
    room.userCount = room.users.size;

    // Notify others about new user
    socket.to(roomId).emit('user-joined', {
      userId,
      roomId,
      userCount: room.userCount
    });

    // Send current user list to the new user
    const currentUsers = Array.from(room.users).filter(id => id !== userId);
    socket.emit('room-joined', {
      roomId,
      roomName: room.name,
      currentUsers,
      userCount: room.userCount
    });

    console.log(`🏠 User ${userId} joined room ${roomId} (${room.userCount} users)`);
  });

  // Leave room
  socket.on('leave-room', () => {
    if (socket.roomId && socket.userId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.users.delete(socket.userId);
        room.userCount = room.users.size;
        
        socket.to(socket.roomId).emit('user-left', {
          userId: socket.userId,
          roomId: socket.roomId,
          userCount: room.userCount
        });

        console.log(`🚪 User ${socket.userId} left room ${socket.roomId} (${room.userCount} users left)`);

        // Remove empty public rooms after some time? Or keep them?
        if (room.userCount === 0 && !room.isPublic) {
          // Optionally remove private rooms when empty
          // rooms.delete(socket.roomId);
        }
      }
      
      socket.leave(socket.roomId);
      userSessions.delete(socket.userId);
      socket.roomId = null;
    }
  });

  socket.on('disconnect', (reason) => {
    const userId = socket.userId;
    const roomId = socket.roomId;

    if (userId && roomId) {
      const room = rooms.get(roomId);
      if (room) {
        room.users.delete(userId);
        room.userCount = room.users.size;
        
        socket.to(roomId).emit('user-left', {
          userId,
          roomId,
          userCount: room.userCount
        });

        console.log(`❌ User ${userId} disconnected from room ${roomId} (reason: ${reason})`);
      }
    }

    userSessions.delete(userId);
  });

  socket.on('error', (error) => {
    console.error('❌ Socket error:', error);
  });
});

// Admin endpoint to check room status
app.get('/admin/rooms', (req, res) => {
  const roomData = {};
  rooms.forEach((room, roomName) => {
    roomData[roomName] = {
      name: room.name,
      userCount: room.users.size,
      maxMembers: room.maxMembers,
      users: Array.from(room.users),
      isPublic: room.isPublic,
      createdAt: room.createdAt
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
  console.log(`🌐 Groups API available at http://localhost:3001/api/groups`);
});

// ──────────────────────────────────────────────
// 2. Dedicated PeerJS server (port 3002)
// ──────────────────────────────────────────────
const peerServer = PeerServer({
  port: 3002,
  path: '/peerjs',
  allow_discovery: true,
  proxied: true,
  key: 'peerjs',
  ssl: false
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