import path from 'path';
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { v4 as uuidv4, validate, version } from 'uuid';
import { ACTIONS } from './src/socket/actions';

interface ChatMessage {
  id: string;
  sender: string;
  message: string;
  timestamp: string;
}

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      "https://conversatio-cordis-ad-cor.vercel.app",
      "http://localhost:3000"
    ],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3001;
const roomChats = new Map<string, ChatMessage[]>();

function getClientRooms(): string[] {
  const { rooms } = io.sockets.adapter;
  return Array.from(rooms.keys()).filter(roomID => 
    validate(roomID) && version(roomID) === 4
  );
}

function shareRoomsInfo(): void {
  const rooms = getClientRooms();
  io.emit(ACTIONS.SHARE_ROOMS, { rooms });
}

function cleanupRoom(roomID: string): void {
  const room = io.sockets.adapter.rooms.get(roomID);
  if (!room || room.size === 0) {
    roomChats.delete(roomID);
    console.log(`Chat history cleared for room ${roomID}`);
  }
}

io.on('connection', (socket: Socket) => {
  console.log('New connection:', socket.id);
  
  shareRoomsInfo();
  
  const roomsInterval = setInterval(shareRoomsInfo, 3000);

  socket.on(ACTIONS.GET_ROOMS, () => {
    socket.emit(ACTIONS.SHARE_ROOMS, { rooms: getClientRooms() });
  });

  socket.on(ACTIONS.JOIN, (config: { room: string }) => {
    const { room: roomID } = config;
    
    if (!validate(roomID) || version(roomID) !== 4) {
      return console.warn(`Invalid room ID: ${roomID}`);
    }

    const joinedRooms = Array.from(socket.rooms);

    if (joinedRooms.includes(roomID)) {
      return console.warn(`Already joined to ${roomID}`);
    }

    const clients = Array.from(io.sockets.adapter.rooms.get(roomID) || []);

    clients.forEach(clientID => {
      io.to(clientID).emit(ACTIONS.ADD_PEER, {
        peerID: socket.id,
        createOffer: false
      });

      socket.emit(ACTIONS.ADD_PEER, {
        peerID: clientID,
        createOffer: true,
      });
    });

    socket.join(roomID);
    console.log(`User ${socket.id} joined room ${roomID}`);

    if (!roomChats.has(roomID)) {
      roomChats.set(roomID, []);
    }

    socket.emit(ACTIONS.CHAT_HISTORY, roomChats.get(roomID));
    shareRoomsInfo();
  });

  function leaveRoom(): void {
    const rooms = Array.from(socket.rooms);
    
    const realRooms = rooms.filter(roomID => 
      roomID !== socket.id && validate(roomID) && version(roomID) === 4
    );

    if (realRooms.length === 0) return;

    realRooms.forEach(roomID => {
      const clients = Array.from(io.sockets.adapter.rooms.get(roomID) || [];
      
      clients.forEach(clientID => {
        io.to(clientID).emit(ACTIONS.REMOVE_PEER, {
          peerID: socket.id,
        });

        socket.emit(ACTIONS.REMOVE_PEER, {
          peerID: clientID,
        });
      });

      socket.leave(roomID);
      console.log(`User ${socket.id} left room ${roomID}`);
      cleanupRoom(roomID);
    });
  }

  socket.on(ACTIONS.CHAT_MESSAGE, (data: { 
    roomID: string; 
    message: string; 
    id?: string; 
    timestamp?: string 
  }) => {
    const { roomID, message, id, timestamp } = data;
    
    if (!validate(roomID) || version(roomID) !== 4) return;
    
    const chatMessage: ChatMessage = {
      id: id || `${socket.id}-${Date.now()}`,
      sender: socket.id,
      message,
      timestamp: timestamp || new Date().toISOString()
    };

    if (!roomChats.has(roomID)) {
      roomChats.set(roomID, []);
    }

    const roomMessages = roomChats.get(roomID)!;
    
    if (roomMessages.length >= 100) {
      roomMessages.shift();
    }
    
    roomMessages.push(chatMessage);
    io.to(roomID).emit(ACTIONS.CHAT_MESSAGE, chatMessage);
  });

  socket.on(ACTIONS.REQUEST_CHAT_HISTORY, ({ roomID }: { roomID: string }) => {
    if (roomChats.has(roomID)) {
      socket.emit(ACTIONS.CHAT_HISTORY, roomChats.get(roomID));
    } else {
      socket.emit(ACTIONS.CHAT_HISTORY, []);
    }
  });

  socket.on(ACTIONS.LEAVE, leaveRoom);
  
  socket.on('disconnecting', () => {
    const hasRealRooms = Array.from(socket.rooms).some(roomID => 
      roomID !== socket.id && validate(roomID) && version(roomID) === 4
    );
    
    if (hasRealRooms) {
      leaveRoom();
    }
    console.log(`User disconnecting: ${socket.id}`);
  });
  
  socket.on('disconnect', () => {
    clearInterval(roomsInterval);
    console.log(`User disconnected: ${socket.id}`);
  });

  socket.on(ACTIONS.RELAY_SDP, ({ 
    peerID, 
    sessionDescription 
  }: { 
    peerID: string; 
    sessionDescription: RTCSessionDescriptionInit 
  }) => {
    io.to(peerID).emit(ACTIONS.SESSION_DESCRIPTION, {
      peerID: socket.id,
      sessionDescription,
    });
  });

  socket.on(ACTIONS.RELAY_ICE, ({ 
    peerID, 
    iceCandidate 
  }: { 
    peerID: string; 
    iceCandidate: RTCIceCandidate 
  }) => {
    io.to(peerID).emit(ACTIONS.ICE_CANDIDATE, {
      peerID: socket.id,
      iceCandidate,
    });
  });

  socket.on('error', (err: Error) => {
    console.error('Socket error:', err);
  });
});

server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});