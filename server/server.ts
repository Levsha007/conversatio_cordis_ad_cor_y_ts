import path from 'path';
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { v4 as uuidv4, validate, version } from 'uuid';

import { ACTIONS, sanitizeUserName, sanitizeMessage, validateRoomID } from './socket/actions';
import { setupTopologyHandlers, TOPOLOGY_EVENTS } from './socket/topology-handler';
import { bandwidthManager } from './bandwidth-manager';

interface ChatMessage {
  id: string;
  sender: string;
  message: string;
  timestamp: string;
  userNumber?: number;
  userName?: string;
}

const app = express();
const server = createServer(app);

app.use((req, res, next) => {
  // Разрешаем CORS для всех запросов
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' blob:; " +
    "connect-src 'self' wss: ws: https:; " +
    "font-src 'self'; " +
    "frame-ancestors 'none';"
  );
  
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  
  if (req.path.includes('/socket.io/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  
  next();
});

// Добавляем простой эндпоинт для проверки работоспособности
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const io = new Server(server, {
  cors: {
    origin: [
      "https://conversatio-cordis-ad-cor-y-ts.vercel.app",
      "https://conversatio-cordis-ad-cor-y-ts.onrender.com",
      "http://localhost:3000",
      "http://localhost:3001"
    ],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
  allowEIO3: true
});

const PORT = process.env.PORT || 3001;

const roomChats = new Map<string, ChatMessage[]>();
const roomUserCounters = new Map<string, number>();
const roomUserNames = new Map<string, Map<string, string>>();
const allParticipants = new Map<string, Set<string>>();
const messageCooldown = new Map<string, number>();

function cleanupRoom(roomID: string): void {
  const room = io.sockets.adapter.rooms.get(roomID);
  if (!room || room.size === 0) {
    roomChats.delete(roomID);
    roomUserCounters.delete(roomID);
    roomUserNames.delete(roomID);
    allParticipants.delete(roomID);
    bandwidthManager.cleanupRoom(roomID);
    console.log(`[Cleanup] Room ${roomID.slice(-8)} cleared`);
  }
}

function getUserNumber(roomID: string, socketId: string): number {
  if (!roomUserCounters.has(roomID)) {
    roomUserCounters.set(roomID, 1);
  }
  
  const room = io.sockets.adapter.rooms.get(roomID);
  if (!room) return 1;
  
  const clients = Array.from(room);
  const userIndex = clients.indexOf(socketId);
  return userIndex + 1;
}

function getUserName(roomID: string, socketId: string): string {
  if (!roomUserNames.has(roomID)) {
    roomUserNames.set(roomID, new Map());
  }
  
  const userNames = roomUserNames.get(roomID)!;
  const userNumber = getUserNumber(roomID, socketId);
  
  return userNames.get(socketId) || `Участник ${userNumber}`;
}

function setUserName(roomID: string, socketId: string, userName: string): void {
  if (!roomUserNames.has(roomID)) {
    roomUserNames.set(roomID, new Map());
  }
  
  const cleanName = sanitizeUserName(userName);
  roomUserNames.get(roomID)!.set(socketId, cleanName);
}

function getAllParticipants(roomID: string): Array<{ id: string; name: string; isOnline: boolean }> {
  const participants = Array.from(allParticipants.get(roomID) || []);
  const activeSockets = io.sockets.adapter.rooms.get(roomID) || new Set();
  
  return participants.map(pid => ({
    id: pid,
    name: getUserName(roomID, pid),
    isOnline: activeSockets.has(pid)
  }));
}

function leaveRoom(roomID: string, socketId: string, isDisconnecting = false): void {
  if (allParticipants.has(roomID)) {
    allParticipants.get(roomID)!.delete(socketId);
  }

  const userName = getUserName(roomID, socketId);
  const participantsList = getAllParticipants(roomID);

  io.to(roomID).emit('user-left', {
    peerID: socketId,
    userName: userName,
    timestamp: new Date().toISOString(),
    participants: participantsList
  });

  const clients = Array.from(io.sockets.adapter.rooms.get(roomID) || []);
  clients.forEach(clientID => {
    if (clientID !== socketId) {
      io.to(clientID).emit(ACTIONS.REMOVE_PEER, {
        peerID: socketId,
      });
    }
  });

  io.to(roomID).emit(ACTIONS.LOWER_HAND, {
    peerID: socketId,
    userName: userName
  });

  if (roomUserNames.has(roomID)) {
    roomUserNames.get(roomID)!.delete(socketId);
  }

  if (!isDisconnecting) {
    io.sockets.sockets.get(socketId)?.leave(roomID);
  }

  bandwidthManager.removePeer(roomID, socketId);

  console.log(`[Leave] ${socketId.slice(-8)} (${userName}) left room ${roomID.slice(-8)}`);
  
  setTimeout(() => cleanupRoom(roomID), 1000);
}

io.on('connection', (socket: Socket) => {
  console.log(`[Connect] New connection: ${socket.id.slice(-8)} from ${socket.handshake.address}`);
  
  setupTopologyHandlers(io, socket);

  socket.on(ACTIONS.JOIN, (config: { room: string; userName?: string }) => {
    const { room: roomID, userName } = config;
    
    console.log(`[Join request] Socket ${socket.id.slice(-8)} to room ${roomID?.slice(-8)}`);
    
    if (!validate(roomID)) {
      console.warn(`[Invalid] Room ID: ${roomID}`);
      socket.emit('error', { message: 'Неверный формат комнаты' });
      return;
    }

    if (!allParticipants.has(roomID)) {
      allParticipants.set(roomID, new Set());
    }
    allParticipants.get(roomID)!.add(socket.id);

    bandwidthManager.initRoom(roomID);

    const clients = Array.from(io.sockets.adapter.rooms.get(roomID) || []);
    const userNumber = getUserNumber(roomID, socket.id);

    const cleanUserName = userName ? sanitizeUserName(userName) : `Участник ${userNumber}`;
    setUserName(roomID, socket.id, cleanUserName);

    const currentUserName = getUserName(roomID, socket.id);
    const participantsList = getAllParticipants(roomID);

    io.to(roomID).emit('user-joined', {
      peerID: socket.id,
      userName: currentUserName,
      timestamp: new Date().toISOString(),
      participants: participantsList
    });

    clients.forEach(clientID => {
      const clientUserNumber = getUserNumber(roomID, clientID);
      const clientUserName = getUserName(roomID, clientID);
      
      io.to(clientID).emit(ACTIONS.ADD_PEER, {
        peerID: socket.id,
        createOffer: false,
        userNumber: userNumber,
        userName: currentUserName
      });
      
      socket.emit(ACTIONS.ADD_PEER, {
        peerID: clientID,
        createOffer: true,
        userNumber: clientUserNumber,
        userName: clientUserName
      });
    });

    socket.join(roomID);
    console.log(`[Join] ${socket.id.slice(-8)} (${currentUserName}) → room ${roomID.slice(-8)} as #${userNumber}`);

    if (!roomChats.has(roomID)) {
      roomChats.set(roomID, []);
    }

    socket.emit(ACTIONS.CHAT_HISTORY, roomChats.get(roomID) || []);
    
    const topology = bandwidthManager.getTopology(roomID);
    if (topology) {
      socket.emit(TOPOLOGY_EVENTS.TOPOLOGY_UPDATE, {
        edges: topology.edges,
        relayAssignments: Array.from(topology.relayAssignments.entries()),
        timestamp: topology.timestamp
      });
    }
  });

  socket.on(ACTIONS.CHAT_MESSAGE, (data: {
    roomID: string;
    message: string;
    id?: string;
    timestamp?: string;
    userName?: string;
  }) => {
    const { roomID, message, id, timestamp, userName } = data;

    if (!validate(roomID)) return;
    
    const now = Date.now();
    const lastMessage = messageCooldown.get(socket.id) || 0;
    
    if (now - lastMessage < 500) return;
    messageCooldown.set(socket.id, now);

    const userNumber = getUserNumber(roomID, socket.id);
    const currentUserName = getUserName(roomID, socket.id);

    if (userName && userName !== currentUserName) {
      const cleanName = sanitizeUserName(userName);
      setUserName(roomID, socket.id, cleanName);
      
      io.to(roomID).emit('user-name-updated', {
        peerID: socket.id,
        userName: getUserName(roomID, socket.id)
      });
    }

    const cleanMessage = sanitizeMessage(message);

    const chatMessage: ChatMessage = {
      id: id || `${socket.id}-${Date.now()}`,
      sender: socket.id,
      message: cleanMessage,
      timestamp: timestamp || new Date().toISOString(),
      userNumber: userNumber,
      userName: getUserName(roomID, socket.id)
    };

    if (!roomChats.has(roomID)) {
      roomChats.set(roomID, []);
    }

    const roomMessages = roomChats.get(roomID)!;

    if (roomMessages.length >= 100) {
      roomMessages.shift();
    }

    roomMessages.push(chatMessage);
    
    io.to(roomID).emit(ACTIONS.CHAT_MESSAGE, {
      ...chatMessage,
      userNumber: userNumber,
      userName: getUserName(roomID, socket.id)
    });
  });

  socket.on('update-user-name', (data: { roomID: string; userName: string }) => {
    const { roomID, userName } = data;
    
    if (!validate(roomID)) return;
    
    const cleanUserName = sanitizeUserName(userName);
    setUserName(roomID, socket.id, cleanUserName);
    const currentUserName = getUserName(roomID, socket.id);
    
    io.to(roomID).emit('user-name-updated', {
      peerID: socket.id,
      userName: currentUserName
    });
    
    console.log(`[Name] ${socket.id.slice(-8)} → ${currentUserName}`);
  });

  socket.on(ACTIONS.RAISE_HAND, ({ roomID }: { roomID: string }) => {
    if (!validate(roomID)) return;
    
    const userName = getUserName(roomID, socket.id);
    
    io.to(roomID).emit(ACTIONS.RAISE_HAND, {
      peerID: socket.id,
      userName: userName
    });
    
    console.log(`[Hand] ${socket.id.slice(-8)} raised hand in room ${roomID.slice(-8)}`);
  });

  socket.on(ACTIONS.LOWER_HAND, ({ roomID }: { roomID: string }) => {
    if (!validate(roomID)) return;
    
    const userName = getUserName(roomID, socket.id);
    
    io.to(roomID).emit(ACTIONS.LOWER_HAND, {
      peerID: socket.id,
      userName: userName
    });
    
    console.log(`[Hand] ${socket.id.slice(-8)} lowered hand in room ${roomID.slice(-8)}`);
  });

  socket.on(ACTIONS.REQUEST_CHAT_HISTORY, ({ roomID }: { roomID: string }) => {
    if (roomChats.has(roomID)) {
      socket.emit(ACTIONS.CHAT_HISTORY, roomChats.get(roomID) || []);
    } else {
      socket.emit(ACTIONS.CHAT_HISTORY, []);
    }
  });

  socket.on('get-participants', ({ roomID }: { roomID: string }) => {
    if (!validate(roomID)) return;
    
    const participants = getAllParticipants(roomID);
    socket.emit('participants-list', participants);
  });

  socket.on(ACTIONS.LEAVE, () => {
    const rooms = Array.from(socket.rooms);
    const realRooms = rooms.filter(roomID =>
      roomID !== socket.id && validate(roomID) && version(roomID) === 4
    );

    realRooms.forEach(roomID => {
      leaveRoom(roomID, socket.id, false);
    });
  });

  socket.on(ACTIONS.RELAY_SDP, ({
    peerID,
    sessionDescription,
    isRelayForward,
    sourcePeerId
  }: {
    peerID: string;
    sessionDescription: RTCSessionDescriptionInit;
    isRelayForward?: boolean;
    sourcePeerId?: string;
  }) => {
    io.to(peerID).emit(ACTIONS.SESSION_DESCRIPTION, {
      peerID: socket.id,
      sessionDescription,
      isRelayForward: isRelayForward || false,
      sourcePeerId: sourcePeerId || null
    });
  });

  socket.on(ACTIONS.RELAY_ICE, ({
    peerID,
    iceCandidate,
    isRelayForward,
    sourcePeerId
  }: {
    peerID: string;
    iceCandidate: RTCIceCandidateInit;
    isRelayForward?: boolean;
    sourcePeerId?: string;
  }) => {
    io.to(peerID).emit(ACTIONS.ICE_CANDIDATE, {
      peerID: socket.id,
      iceCandidate,
      isRelayForward: isRelayForward || false,
      sourcePeerId: sourcePeerId || null
    });
  });

  socket.on('disconnecting', (reason) => {
    console.log(`[Disconnecting] ${socket.id.slice(-8)}, reason: ${reason}`);
    
    const rooms = Array.from(socket.rooms);
    const realRooms = rooms.filter(roomID =>
      roomID !== socket.id && validate(roomID)
    );

    realRooms.forEach(roomID => {
      leaveRoom(roomID, socket.id, true);
    });
  });

  socket.on('disconnect', (reason) => {
    console.log(`[Disconnect] ${socket.id.slice(-8)}, reason: ${reason}`);
    messageCooldown.delete(socket.id);
    
    const rooms = Array.from(socket.rooms);
    const realRooms = rooms.filter(roomID =>
      roomID !== socket.id && validate(roomID)
    );

    realRooms.forEach(roomID => {
      cleanupRoom(roomID);
    });
  });
});

server.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`[Server] Started on port ${PORT}`);
  console.log(`[WebSocket] Ready for connections`);
  console.log(`[Bandwidth] Topology recalculation interval: 10 seconds`);
  console.log(`========================================\n`);
});