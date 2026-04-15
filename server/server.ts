import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4, validate as uuidValidate } from 'uuid';

import MediasoupWorker from './sfu/mediasoup-worker';
import RoomManager from './sfu/room-manager';
import { SFUPeer } from './sfu/peer';
import { ACTIONS, sanitizeUserName, sanitizeMessage } from './socket/actions';

// Интерфейсы
interface ChatMessage {
  id: string;
  sender: string;
  message: string;
  timestamp: string;
  userName?: string;
}

// Создаём Express приложение
const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);

// Настраиваем Socket.IO
const io = new Server(server, {
  cors: {
    origin: [
      "https://conversatio-cordis-ad-cor-y-ts.vercel.app",
      "http://localhost:3000",
      "http://localhost:3001"
    ],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3001;

// Хранилища
const roomChats = new Map<string, ChatMessage[]>();
const socketToPeer = new Map<string, { roomId: string; peerId: string }>();
const peerToSocket = new Map<string, Socket>();

// Инициализация Mediasoup
async function initMediasoup() {
  try {
    const worker = MediasoupWorker.getInstance();
    await worker.init();
    console.log('Mediasoup initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Mediasoup:', error);
    process.exit(1);
  }
}

// Получение имени пользователя
function getUserName(roomId: string, peerId: string): string {
  const room = RoomManager.getInstance().getRoom(roomId);
  const peer = room?.peers.get(peerId);
  return peer?.userName || 'Участник';
}

// Сохранение сообщения чата
function saveChatMessage(roomId: string, message: ChatMessage): void {
  if (!roomChats.has(roomId)) {
    roomChats.set(roomId, []);
  }
  
  const messages = roomChats.get(roomId)!;
  messages.push(message);
  
  // Ограничиваем историю 100 сообщениями
  if (messages.length > 100) {
    messages.shift();
  }
}

// Обработка WebRTC транспорта
async function handleCreateTransport(socket: Socket, peer: SFUPeer, roomId: string) {
  const roomManager = RoomManager.getInstance();
  const room = roomManager.getRoom(roomId);
  
  if (!room || !room.router) {
    socket.emit('error', { message: 'Room not found' });
    return;
  }

  try {
    // Создаём WebRTC транспорт для peer
    const transport = await room.router.createWebRtcTransport({
      listenIps: [
        {
          ip: '0.0.0.0',
          announcedIp: process.env.ANNOUNCED_IP || 'localhost'
        }
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1000000
    });

    await peer.setTransport(transport);

    // Отправляем параметры транспорта клиенту
    socket.emit('transport-created', {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    });

    // Обработка DTLS состояния
    transport.on('dtlsstatechange', (dtlsState) => {
      console.log(`DTLS state for peer ${peer.id}: ${dtlsState}`);
    });

    // Обработка закрытия через routerclose (ИСПРАВЛЕНО)
    transport.on('routerclose', () => {
      console.log(`Router closed for peer ${peer.id}`);
      peer.transport = null;
    });

    // Дополнительная проверка через интервал
    const checkInterval = setInterval(() => {
      if (transport.closed) {
        console.log(`Transport closed for peer ${peer.id}`);
        peer.transport = null;
        clearInterval(checkInterval);
      }
    }, 5000);

    console.log(`Transport created for peer ${peer.id} in room ${roomId}`);
  } catch (error) {
    console.error('Error creating transport:', error);
    socket.emit('error', { message: 'Failed to create transport' });
  }
}

// Обработка создания producer (отправка медиа)
async function handleCreateProducer(
  socket: Socket,
  peer: SFUPeer,
  roomId: string,
  kind: 'audio' | 'video',
  rtpParameters: any
) {
  const roomManager = RoomManager.getInstance();
  const room = roomManager.getRoom(roomId);
  
  if (!room || !peer.transport) {
    socket.emit('error', { message: 'Transport not ready' });
    return;
  }

  try {
    const producer = await peer.transport.produce({
      kind,
      rtpParameters
    });

    peer.addProducer(kind, producer);

    // Оповещаем всех остальных участников о новом producer
    for (const otherPeer of room.peers.values()) {
      if (otherPeer.id !== peer.id && otherPeer.transport) {
        // Создаём consumer для каждого существующего peer
        const consumer = await otherPeer.transport.consume({
          producerId: producer.id,
          rtpCapabilities: room.router.rtpCapabilities,
          paused: true
        });

        otherPeer.addConsumer(peer.id, kind, consumer);

        // Отправляем событие о новом потоке
        const otherSocket = peerToSocket.get(otherPeer.id);
        if (otherSocket) {
          otherSocket.emit('new-producer', {
            peerId: peer.id,
            peerName: peer.userName,
            kind,
            consumerParameters: {
              producerId: consumer.producerId,
              id: consumer.id,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
              type: consumer.type
            }
          });
        }
      }
    }

    socket.emit('producer-created', {
      kind,
      producerId: producer.id
    });

    console.log(`Producer created for peer ${peer.id}: ${kind}`);
  } catch (error) {
    console.error('Error creating producer:', error);
    socket.emit('error', { message: `Failed to create ${kind} producer` });
  }
}

// Обработка возобновления consumer
async function handleResumeConsumer(
  socket: Socket,
  peer: SFUPeer,
  peerId: string,
  kind: 'audio' | 'video'
) {
  const consumer = peer.getConsumer(peerId, kind);
  if (consumer && consumer.paused) {
    await consumer.resume();
    console.log(`Consumer resumed for peer ${peer.id} from ${peerId}: ${kind}`);
  }
}

// Обработка отключения peer
async function handlePeerDisconnect(peerId: string) {
  const mapping = socketToPeer.get(peerId);
  if (!mapping) return;

  const { roomId } = mapping;
  const roomManager = RoomManager.getInstance();
  const room = roomManager.getRoom(roomId);
  
  if (room) {
    const peer = room.peers.get(peerId);
    if (peer) {
      // Уведомляем всех остальных участников
      for (const otherPeer of room.peers.values()) {
        if (otherPeer.id !== peerId) {
          const otherSocket = peerToSocket.get(otherPeer.id);
          if (otherSocket) {
            otherSocket.emit(ACTIONS.REMOVE_PEER, { peerID: peerId });
          }
        }
      }

      // Закрываем peer
      await peer.close();
      roomManager.removePeer(roomId, peerId);
      
      console.log(`Peer ${peerId} (${peer.userName}) disconnected from room ${roomId}`);
    }
  }

  socketToPeer.delete(peerId);
  peerToSocket.delete(peerId);
}

// ==================== Socket.IO обработчики ====================

io.on('connection', (socket: Socket) => {
  console.log('Client connected:', socket.id);

  // JOIN комнаты
  socket.on(ACTIONS.JOIN, async (data: { room: string; userName?: string; hasMedia?: boolean }) => {
    const { room: roomId, userName, hasMedia = true } = data;
    
    if (!uuidValidate(roomId)) {
      socket.emit('error', { message: 'Invalid room ID format' });
      return;
    }

    const cleanUserName = sanitizeUserName(userName || '');
    const peerId = uuidv4();
    
    // Сохраняем соответствие
    socketToPeer.set(socket.id, { roomId, peerId });
    peerToSocket.set(peerId, socket);

    // Создаём или получаем комнату
    const roomManager = RoomManager.getInstance();
    const room = await roomManager.getOrCreateRoom(roomId);
    
    // Создаём peer
    const peer = new SFUPeer({
      id: peerId,
      socketId: socket.id,
      userName: cleanUserName || `Участник ${room.peers.size + 1}`,
      hasMedia,
      joinedAt: new Date()
    });
    peer.setSocket(socket);
    
    await roomManager.addPeer(roomId, peerId, peer);
    
    // Создаём транспорт для peer
    await handleCreateTransport(socket, peer, roomId);
    
    // Отправляем список существующих участников новому peer
    const existingPeers = roomManager.getAllPeers(roomId).filter(p => p.id !== peerId);
    socket.emit('existing-peers', existingPeers.map(p => ({
      peerId: p.id,
      userName: p.userName,
      hasMedia: p.hasMedia
    })));
    
    // Уведомляем всех остальных о новом участнике
    for (const otherPeer of existingPeers) {
      const otherSocket = peerToSocket.get(otherPeer.id);
      if (otherSocket) {
        otherSocket.emit(ACTIONS.ADD_PEER, {
          peerID: peerId,
          createOffer: false,
          userName: peer.userName,
          hasMedia: peer.hasMedia
        });
        
        socket.emit(ACTIONS.ADD_PEER, {
          peerID: otherPeer.id,
          createOffer: false,
          userName: otherPeer.userName,
          hasMedia: otherPeer.hasMedia
        });
      }
    }
    
    // Отправляем историю чата
    if (roomChats.has(roomId)) {
      socket.emit(ACTIONS.CHAT_HISTORY, roomChats.get(roomId));
    }
    
    console.log(`User ${peer.userName} (${peerId}) joined room ${roomId}`);
  });

  // Создание producer (аудио/видео)
  socket.on('create-producer', async (data: { kind: 'audio' | 'video'; rtpParameters: any }) => {
    const mapping = socketToPeer.get(socket.id);
    if (!mapping) return;
    
    const { roomId, peerId } = mapping;
    const roomManager = RoomManager.getInstance();
    const peer = roomManager.getPeer(roomId, peerId);
    
    if (peer) {
      await handleCreateProducer(socket, peer, roomId, data.kind, data.rtpParameters);
    }
  });

  // Возобновление consumer
  socket.on('resume-consumer', async (data: { peerId: string; kind: 'audio' | 'video' }) => {
    const mapping = socketToPeer.get(socket.id);
    if (!mapping) return;
    
    const { roomId, peerId } = mapping;
    const roomManager = RoomManager.getInstance();
    const peer = roomManager.getPeer(roomId, peerId);
    
    if (peer) {
      await handleResumeConsumer(socket, peer, data.peerId, data.kind);
    }
  });

  // Обновление уровня громкости (для активного спикера)
  socket.on('audio-level', (data: { level: number }) => {
    const mapping = socketToPeer.get(socket.id);
    if (!mapping) return;
    
    const { roomId, peerId } = mapping;
    const roomManager = RoomManager.getInstance();
    roomManager.updateAudioLevel(roomId, peerId, data.level);
    
    const activeSpeaker = roomManager.getActiveSpeaker(roomId);
    if (activeSpeaker) {
      const room = roomManager.getRoom(roomId);
      if (room) {
        for (const peer of room.peers.values()) {
          const peerSocket = peerToSocket.get(peer.id);
          if (peerSocket) {
            peerSocket.emit('active-speaker', { peerId: activeSpeaker });
          }
        }
      }
    }
  });

  // Чат сообщение
  socket.on(ACTIONS.CHAT_MESSAGE, async (data: {
    roomID: string;
    message: string;
    id: string;
    timestamp: string;
    userName?: string;
  }) => {
    const { roomID, message, id, timestamp, userName } = data;
    
    const mapping = socketToPeer.get(socket.id);
    if (!mapping || mapping.roomId !== roomID) return;
    
    const { peerId } = mapping;
    const cleanMessage = sanitizeMessage(message);
    
    const chatMessage: ChatMessage = {
      id: id || `${peerId}-${Date.now()}`,
      sender: peerId,
      message: cleanMessage,
      timestamp: timestamp || new Date().toISOString(),
      userName: userName || getUserName(roomID, peerId)
    };
    
    saveChatMessage(roomID, chatMessage);
    
    // Рассылаем всем в комнате
    const roomManager = RoomManager.getInstance();
    const room = roomManager.getRoom(roomID);
    if (room) {
      for (const peer of room.peers.values()) {
        const peerSocket = peerToSocket.get(peer.id);
        if (peerSocket) {
          peerSocket.emit(ACTIONS.CHAT_MESSAGE, chatMessage);
        }
      }
    }
  });

  // Запрос истории чата
  socket.on(ACTIONS.REQUEST_CHAT_HISTORY, (data: { roomID: string }) => {
    const { roomID } = data;
    if (roomChats.has(roomID)) {
      socket.emit(ACTIONS.CHAT_HISTORY, roomChats.get(roomID));
    }
  });

  // Обновление имени пользователя
  socket.on('update-user-name', async (data: { roomID: string; userName: string }) => {
    const { roomID, userName } = data;
    const mapping = socketToPeer.get(socket.id);
    if (!mapping || mapping.roomId !== roomID) return;
    
    const { peerId } = mapping;
    const roomManager = RoomManager.getInstance();
    const peer = roomManager.getPeer(roomID, peerId);
    
    if (peer) {
      const cleanName = sanitizeUserName(userName);
      peer.userName = cleanName;
      
      // Рассылаем обновление всем
      const room = roomManager.getRoom(roomID);
      if (room) {
        for (const otherPeer of room.peers.values()) {
          const otherSocket = peerToSocket.get(otherPeer.id);
          if (otherSocket) {
            otherSocket.emit('user-name-updated', {
              peerID: peerId,
              userName: cleanName
            });
          }
        }
      }
    }
  });

  // Поднятие руки
  socket.on(ACTIONS.RAISE_HAND, async (data: { roomID: string }) => {
    const { roomID } = data;
    const mapping = socketToPeer.get(socket.id);
    if (!mapping || mapping.roomId !== roomID) return;
    
    const { peerId } = mapping;
    const userName = getUserName(roomID, peerId);
    
    const roomManager = RoomManager.getInstance();
    const room = roomManager.getRoom(roomID);
    if (room) {
      for (const peer of room.peers.values()) {
        const peerSocket = peerToSocket.get(peer.id);
        if (peerSocket) {
          peerSocket.emit(ACTIONS.RAISE_HAND, { peerID: peerId, userName });
        }
      }
    }
  });

  // Опускание руки
  socket.on(ACTIONS.LOWER_HAND, async (data: { roomID: string }) => {
    const { roomID } = data;
    const mapping = socketToPeer.get(socket.id);
    if (!mapping || mapping.roomId !== roomID) return;
    
    const { peerId } = mapping;
    const userName = getUserName(roomID, peerId);
    
    const roomManager = RoomManager.getInstance();
    const room = roomManager.getRoom(roomID);
    if (room) {
      for (const peer of room.peers.values()) {
        const peerSocket = peerToSocket.get(peer.id);
        if (peerSocket) {
          peerSocket.emit(ACTIONS.LOWER_HAND, { peerID: peerId, userName });
        }
      }
    }
  });

  // Выход из комнаты
  socket.on(ACTIONS.LEAVE, async () => {
    const mapping = socketToPeer.get(socket.id);
    if (mapping) {
      await handlePeerDisconnect(mapping.peerId);
    }
    socket.leave(socket.id);
  });

  // Отключение
  socket.on('disconnect', async () => {
    console.log('Client disconnected:', socket.id);
    const mapping = socketToPeer.get(socket.id);
    if (mapping) {
      await handlePeerDisconnect(mapping.peerId);
    }
  });
});

// Запуск сервера
async function startServer() {
  await initMediasoup();
  
  server.listen(PORT, () => {
    console.log(`SFU Server running on port ${PORT}`);
    console.log(`Mediasoup worker ports: 40000-40100 (UDP/TCP)`);
  });
}

startServer().catch(console.error);