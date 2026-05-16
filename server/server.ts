import path from 'path';
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { v4 as uuidv4, validate, version } from 'uuid';

import { ACTIONS, sanitizeUserName, sanitizeMessage, validateRoomID } from './socket/actions';
import { setupTopologyHandlers, setupTopologyBroadcast, TOPOLOGY_EVENTS } from './socket/topology-handler';
import { bandwidthManager } from './bandwidth-manager';

interface ChatMessage {
  id: string;
  sender: string;
  message: string;
  timestamp: string;
  userNumber?: number;
  userName?: string;
}

interface JoinMetrics {
  socketId: string;
  roomId: string;
  joinRequestTime: number;
  connectionEstablishedTime: number | null;
  userName: string;
}

const app = express();
const server = createServer(app);

app.use((req, res, next) => {
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

setupTopologyBroadcast(io);

const roomChats = new Map<string, ChatMessage[]>();
const roomUserCounters = new Map<string, number>();
const roomUserNames = new Map<string, Map<string, string>>();
const allParticipants = new Map<string, Set<string>>();
const messageCooldown = new Map<string, number>();
const joinMetrics = new Map<string, JoinMetrics>();
const activeTabs = new Map<string, Map<string, string>>();

function cleanupRoom(roomID: string): void {
  const room = io.sockets.adapter.rooms.get(roomID);
  if (!room || room.size === 0) {
    roomChats.delete(roomID);
    roomUserCounters.delete(roomID);
    roomUserNames.delete(roomID);
    allParticipants.delete(roomID);
    activeTabs.delete(roomID);
    bandwidthManager.cleanupRoom(roomID);
    console.log(`[CLEANUP] Room ${roomID.slice(-8)} cleared`);
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
  
  return userNames.get(socketId) || `Participant ${userNumber}`;
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

function recordJoinStart(roomID: string, socketId: string, userName: string): void {
  const metricKey = `${roomID}:${socketId}`;
  joinMetrics.set(metricKey, {
    socketId,
    roomId: roomID,
    joinRequestTime: Date.now(),
    connectionEstablishedTime: null,
    userName
  });
}

function recordConnectionComplete(roomID: string, socketId: string): void {
  const metricKey = `${roomID}:${socketId}`;
  const metric = joinMetrics.get(metricKey);
  if (metric && !metric.connectionEstablishedTime) {
    metric.connectionEstablishedTime = Date.now();
    const joinTime = metric.connectionEstablishedTime - metric.joinRequestTime;
    console.log(`[METRIC] Room ${roomID.slice(-8)} user ${metric.userName} join completed in ${joinTime}ms`);
  }
}

function isDuplicateTab(roomID: string, socketId: string, tabId: string): boolean {
  const roomTabs = activeTabs.get(roomID);
  if (!roomTabs) return false;
  
  for (const [existingSocketId, existingTabId] of roomTabs) {
    if (existingTabId === tabId && existingSocketId !== socketId) {
      return true;
    }
  }
  return false;
}

function registerTab(roomID: string, socketId: string, tabId: string): void {
  if (!activeTabs.has(roomID)) {
    activeTabs.set(roomID, new Map());
  }
  activeTabs.get(roomID)!.set(socketId, tabId);
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
  
  const metricKey = `${roomID}:${socketId}`;
  if (joinMetrics.has(metricKey)) {
    const metric = joinMetrics.get(metricKey)!;
    if (metric.connectionEstablishedTime) {
      const totalTime = metric.connectionEstablishedTime - metric.joinRequestTime;
      console.log(`[METRIC] Room ${roomID.slice(-8)} user ${userName} total connection time: ${totalTime}ms`);
    }
    joinMetrics.delete(metricKey);
  }
  
  const roomTabs = activeTabs.get(roomID);
  if (roomTabs) {
    roomTabs.delete(socketId);
    if (roomTabs.size === 0) {
      activeTabs.delete(roomID);
    }
  }

  console.log(`[LEAVE] ${socketId.slice(-8)} (${userName}) left room ${roomID.slice(-8)}`);
  
  setTimeout(() => cleanupRoom(roomID), 1000);
}

io.on('connection', (socket: Socket) => {
  console.log(`[CONNECT] New connection: ${socket.id.slice(-8)}`);
  
  setupTopologyHandlers(io, socket);

  socket.on(ACTIONS.JOIN, async (config: { room: string; userName?: string; tabId?: string }) => {
    const { room: roomID, userName, tabId } = config;
    
    console.log(`[JOIN] Request from ${socket.id.slice(-8)} to room ${roomID?.slice(-8)}`);
    
    if (!validate(roomID)) {
      console.warn(`[ERROR] Invalid room ID: ${roomID}`);
      socket.emit('error', { message: 'Invalid room format' });
      return;
    }
    
    if (tabId && isDuplicateTab(roomID, socket.id, tabId)) {
      console.warn(`[REJECT] Duplicate tab detected for room ${roomID.slice(-8)}, tabId: ${tabId}`);
      socket.emit('error', { message: 'You already have this room open in another tab' });
      return;
    }
    
    if (tabId) {
      registerTab(roomID, socket.id, tabId);
    }

    if (!allParticipants.has(roomID)) {
      allParticipants.set(roomID, new Set());
    }
    allParticipants.get(roomID)!.add(socket.id);

    bandwidthManager.initRoom(roomID);
    bandwidthManager.registerPeer(roomID, socket.id);

    await socket.join(roomID);

    const clients = Array.from(io.sockets.adapter.rooms.get(roomID) || [])
      .filter(clientID => clientID !== socket.id);

    const userNumber = getUserNumber(roomID, socket.id);

    const cleanUserName = userName ? sanitizeUserName(userName) : `Participant ${userNumber}`;
    setUserName(roomID, socket.id, cleanUserName);

    const currentUserName = getUserName(roomID, socket.id);
    const participantsList = getAllParticipants(roomID);
    
    recordJoinStart(roomID, socket.id, currentUserName);

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
        createOffer: false,
        userNumber: clientUserNumber,
        userName: clientUserName
      });
      
      recordConnectionComplete(roomID, clientID);
    });

    bandwidthManager.recalculateTopology(roomID);

    console.log(`[JOIN] ${socket.id.slice(-8)} (${currentUserName}) joined room ${roomID.slice(-8)} as #${userNumber}`);

    if (!roomChats.has(roomID)) {
      roomChats.set(roomID, []);
    }

    socket.emit(ACTIONS.CHAT_HISTORY, roomChats.get(roomID) || []);
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
    
    console.log(`[NAME] ${socket.id.slice(-8)} -> ${currentUserName}`);
  });

  socket.on(ACTIONS.RAISE_HAND, ({ roomID }: { roomID: string }) => {
    if (!validate(roomID)) return;
    
    const userName = getUserName(roomID, socket.id);
    
    io.to(roomID).emit(ACTIONS.RAISE_HAND, {
      peerID: socket.id,
      userName: userName
    });
    
    console.log(`[HAND] ${socket.id.slice(-8)} raised hand in room ${roomID.slice(-8)}`);
  });

  socket.on(ACTIONS.LOWER_HAND, ({ roomID }: { roomID: string }) => {
    if (!validate(roomID)) return;
    
    const userName = getUserName(roomID, socket.id);
    
    io.to(roomID).emit(ACTIONS.LOWER_HAND, {
      peerID: socket.id,
      userName: userName
    });
    
    console.log(`[HAND] ${socket.id.slice(-8)} lowered hand in room ${roomID.slice(-8)}`);
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
    console.log(`[DISCONNECT] ${socket.id.slice(-8)} disconnecting, reason: ${reason}`);
    
    const rooms = Array.from(socket.rooms);
    const realRooms = rooms.filter(roomID =>
      roomID !== socket.id && validate(roomID)
    );

    realRooms.forEach(roomID => {
      leaveRoom(roomID, socket.id, true);
    });
  });

  socket.on('disconnect', (reason) => {
    console.log(`[DISCONNECT] ${socket.id.slice(-8)} disconnected, reason: ${reason}`);
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
  console.log(`[SERVER] Started on port ${PORT}`);
  console.log(`[CONFIG] Topology recalculation interval: 10 seconds`);
  console.log(`[CONFIG] Tab duplication protection: ENABLED`);
  console.log(`[CONFIG] Join metrics logging: ENABLED`);
  console.log(`========================================\n`);
});