import path from 'path';
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { v4 as uuidv4, validate, version } from 'uuid';

// Импорт констант действий из actions.ts
import { ACTIONS, sanitizeUserName, sanitizeMessage, validateRoomID } from './socket/actions';

/**
 * Интерфейс для сообщений чата
 */
interface ChatMessage {
  id: string;
  sender: string;
  message: string;
  timestamp: string;
  userNumber?: number;
  userName?: string;
}

// Создаем Express приложение и HTTP сервер
const app = express();
const server = createServer(app);

// Добавляем security headers middleware
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' blob:; " +
    "connect-src 'self' wss: ws:; " +
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

// Настраиваем Socket.IO сервер
const io = new Server(server, {
  cors: {
    origin: [
      "https://conversatio-cordis-ad-cor-y-ts.vercel.app",
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

// Хранилище чатов по комнатам
const roomChats = new Map<string, ChatMessage[]>();
// Хранилище информации о пользователях
const roomUserCounters = new Map<string, number>();
// Хранилище имен пользователей
const roomUserNames = new Map<string, Map<string, string>>();
// Хранилище для всех участников
const allParticipants = new Map<string, Set<string>>();
// Хранилище для rate limiting сообщений
const messageCooldown = new Map<string, number>();
// Хранилище комнат пользователя
const userRooms = new Map<string, Set<string>>();

/**
 * Функция очистки истории чата пустой комнаты
 * @param roomID - ID комнаты
 */
function cleanupRoom(roomID: string): void {
  const room = io.sockets.adapter.rooms.get(roomID);
  if (!room || room.size === 0) {
    roomChats.delete(roomID);
    roomUserCounters.delete(roomID);
    roomUserNames.delete(roomID);
    allParticipants.delete(roomID);
    console.log(`Chat history cleared for room ${roomID}`);
  }
}

/**
 * Получение номера пользователя в комнате
 */
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

/**
 * Получение имени пользователя
 */
function getUserName(roomID: string, socketId: string): string {
  if (!roomUserNames.has(roomID)) {
    roomUserNames.set(roomID, new Map());
  }
  
  const userNames = roomUserNames.get(roomID)!;
  const userNumber = getUserNumber(roomID, socketId);
  
  return userNames.get(socketId) || `Участник ${userNumber}`;
}

/**
 * Установка имени пользователя
 */
function setUserName(roomID: string, socketId: string, userName: string): void {
  if (!roomUserNames.has(roomID)) {
    roomUserNames.set(roomID, new Map());
  }
  
  roomUserNames.get(roomID)!.set(socketId, userName);
}

/**
 * Получение списка всех участников комнаты
 */
function getAllParticipants(roomID: string): Array<{ id: string; name: string; isOnline: boolean }> {
  const participants = Array.from(allParticipants.get(roomID) || []);
  const activeSockets = io.sockets.adapter.rooms.get(roomID) || new Set();
  
  return participants.map(pid => ({
    id: pid,
    name: getUserName(roomID, pid),
    isOnline: activeSockets.has(pid)
  }));
}

/**
 * Функция выхода из комнаты
 */
function leaveRoom(roomID: string, socketId: string, isDisconnecting = false): void {
  // Удаляем из общего списка
  if (allParticipants.has(roomID)) {
    allParticipants.get(roomID)!.delete(socketId);
  }

  const userName = getUserName(roomID, socketId);
  
  // Получаем обновленный список участников
  const participantsList = getAllParticipants(roomID);

  // Отправляем уведомление об отключении ВСЕМ участникам
  io.to(roomID).emit('user-left', {
    peerID: socketId,
    userName: userName,
    timestamp: new Date().toISOString(),
    participants: participantsList
  });

  // Отправляем REMOVE_PEER всем ОСТАВШИМСЯ участникам
  const clients = Array.from(io.sockets.adapter.rooms.get(roomID) || []);
  clients.forEach(clientID => {
    if (clientID !== socketId) {
      io.to(clientID).emit(ACTIONS.REMOVE_PEER, {
        peerID: socketId,
      });
    }
  });

  // Автоматически опускаем руку при выходе
  io.to(roomID).emit(ACTIONS.LOWER_HAND, {
    peerID: socketId,
    userName: userName
  });

  // Удаляем имя пользователя при выходе
  if (roomUserNames.has(roomID)) {
    roomUserNames.get(roomID)!.delete(socketId);
  }

  if (!isDisconnecting) {
    io.sockets.sockets.get(socketId)?.leave(roomID);
  }

  console.log(`User ${socketId} (${userName}) left room ${roomID}, disconnecting: ${isDisconnecting}`);
  
  // Очищаем комнату если она пуста
  setTimeout(() => cleanupRoom(roomID), 1000);
}

/**
 * Обработчик подключения нового клиента
 * @param socket - клиентский сокет
 */
io.on('connection', (socket: Socket) => {
  console.log('New connection:', socket.id);
  
  userActivity.set(socket.id, Date.now());

  /**
   * Обработчик входа в комнату
   * @param config - параметры входа
   */
  socket.on(ACTIONS.JOIN, (config: { room: string; userName?: string }) => {
    const { room: roomID, userName } = config;
    
    if (!validate(roomID)) {
      console.warn(`Invalid room ID: ${roomID}`);
      socket.emit('error', { message: 'Неверный формат комнаты' });
      return;
    }
    
    // Очистка имени пользователя
    const cleanUserName = sanitizeUserName(userName || '');
    
    // Проверка на флуд комнатами
    const maxRoomsPerUser = 5;
    const userRoomsSet = userRooms.get(socket.id) || new Set();
    
    if (userRoomsSet.size >= maxRoomsPerUser) {
      socket.emit('error', {
        message: 'Вы подключены к слишком большому количеству комнат. Пожалуйста, покиньте некоторые.'
      });
      return;
    }
    
    userRoomsSet.add(roomID);
    userRooms.set(socket.id, userRoomsSet);

    // Добавляем участника в общий список
    if (!allParticipants.has(roomID)) {
      allParticipants.set(roomID, new Set());
    }
    allParticipants.get(roomID)!.add(socket.id);

    const clients = Array.from(io.sockets.adapter.rooms.get(roomID) || []);
    const userNumber = getUserNumber(roomID, socket.id);

    // Сохраняем имя пользователя
    if (cleanUserName) {
      setUserName(roomID, socket.id, cleanUserName);
    } else {
      setUserName(roomID, socket.id, `Участник ${userNumber}`);
    }

    const currentUserName = getUserName(roomID, socket.id);

    // Получаем список всех участников
    const participantsList = getAllParticipants(roomID);

    // Отправляем уведомление о подключении
    io.to(roomID).emit('user-joined', {
      peerID: socket.id,
      userName: currentUserName,
      timestamp: new Date().toISOString(),
      participants: participantsList
    });

    // Отправляем всем участникам информацию о новом пользователе
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
    console.log(`User ${socket.id} (${currentUserName}) joined room ${roomID} as Participant ${userNumber}`);

    if (!roomChats.has(roomID)) {
      roomChats.set(roomID, []);
    }

    socket.emit(ACTIONS.CHAT_HISTORY, roomChats.get(roomID) || []);
  });

  /**
   * Обработчик текстовых сообщений чата
   */
  socket.on(ACTIONS.CHAT_MESSAGE, (data: {
    roomID: string;
    message: string;
    id?: string;
    timestamp?: string;
    userName?: string;
  }) => {
    const { roomID, message, id, timestamp, userName } = data;

    if (!validate(roomID)) return;
    
    // Rate limiting
    const now = Date.now();
    const lastMessage = messageCooldown.get(socket.id) || 0;
    
    if (now - lastMessage < 1000) {
      socket.emit('error', { message: 'Слишком много сообщений. Подождите 1 секунду.' });
      return;
    }
    
    messageCooldown.set(socket.id, now);
    
    // Очистка данных
    const cleanMessage = sanitizeMessage(message);
    const cleanUserName = userName ? sanitizeUserName(userName) : undefined;

    const userNumber = getUserNumber(roomID, socket.id);
    const currentUserName = getUserName(roomID, socket.id);

    if (cleanUserName && cleanUserName !== currentUserName) {
      setUserName(roomID, socket.id, cleanUserName);
      
      io.to(roomID).emit('user-name-updated', {
        peerID: socket.id,
        userName: getUserName(roomID, socket.id)
      });
    }

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

  /**
   * Обработчик обновления имени пользователя
   */
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
    
    console.log(`User ${socket.id} updated name to ${currentUserName}`);
  });

  /**
   * Обработчик запроса истории чата
   */
  socket.on(ACTIONS.REQUEST_CHAT_HISTORY, ({ roomID }: { roomID: string }) => {
    if (roomChats.has(roomID)) {
      socket.emit(ACTIONS.CHAT_HISTORY, roomChats.get(roomID) || []);
    } else {
      socket.emit(ACTIONS.CHAT_HISTORY, []);
    }
  });

  /**
   * Обработчик запроса списка участников
   */
  socket.on('get-participants', ({ roomID }: { roomID: string }) => {
    if (!validate(roomID)) return;
    
    const participants = getAllParticipants(roomID);
    socket.emit('participants-list', participants);
  });

  /**
   * Обработчик выхода из комнаты
   */
  socket.on(ACTIONS.LEAVE, () => {
    const rooms = Array.from(socket.rooms);
    const realRooms = rooms.filter(roomID =>
      roomID !== socket.id && validate(roomID) && version(roomID) === 4
    );

    realRooms.forEach(roomID => {
      userRooms.get(socket.id)?.delete(roomID);
      leaveRoom(roomID, socket.id, false);
    });
    
    if (userRooms.get(socket.id)?.size === 0) {
      userRooms.delete(socket.id);
    }
  });

  /**
   * Обработчик поднятия руки
   */
  socket.on(ACTIONS.RAISE_HAND, ({ roomID }: { roomID: string }) => {
    if (!validate(roomID)) return;
    
    const userName = getUserName(roomID, socket.id);
    
    io.to(roomID).emit(ACTIONS.RAISE_HAND, {
      peerID: socket.id,
      userName: userName
    });
    
    console.log(`User ${socket.id} (${userName}) raised hand in room ${roomID}`);
  });

  /**
   * Обработчик опускания руки
   */
  socket.on(ACTIONS.LOWER_HAND, ({ roomID }: { roomID: string }) => {
    if (!validate(roomID)) return;
    
    const userName = getUserName(roomID, socket.id);
    
    io.to(roomID).emit(ACTIONS.LOWER_HAND, {
      peerID: socket.id,
      userName: userName
    });
    
    console.log(`User ${socket.id} (${userName}) lowered hand in room ${roomID}`);
  });

  /**
   * Обработчик передачи SDP (Session Description Protocol)
   */
  socket.on(ACTIONS.RELAY_SDP, ({
    peerID,
    sessionDescription
  }: {
    peerID: string;
    sessionDescription: RTCSessionDescriptionInit;
  }) => {
    io.to(peerID).emit(ACTIONS.SESSION_DESCRIPTION, {
      peerID: socket.id,
      sessionDescription,
    });
  });

  /**
   * Обработчик передачи ICE кандидатов
   */
  socket.on(ACTIONS.RELAY_ICE, ({
    peerID,
    iceCandidate
  }: {
    peerID: string;
    iceCandidate: RTCIceCandidateInit;
  }) => {
    io.to(peerID).emit(ACTIONS.ICE_CANDIDATE, {
      peerID: socket.id,
      iceCandidate,
    });
  });

  /**
   * Обработчик активности пользователя
   */
  socket.on('activity', () => {
    userActivity.set(socket.id, Date.now());
  });

  /**
   * Обработчик отключения (перед фактическим отключением)
   */
  socket.on('disconnecting', (reason) => {
    console.log(`User disconnecting: ${socket.id}, reason: ${reason}`);
    
    const rooms = Array.from(socket.rooms);
    const realRooms = rooms.filter(roomID =>
      roomID !== socket.id && validate(roomID) && version(roomID) === 4
    );

    realRooms.forEach(roomID => {
      const userName = getUserName(roomID, socket.id);
      io.to(roomID).emit(ACTIONS.LOWER_HAND, {
        peerID: socket.id,
        userName: userName
      });
      
      userRooms.get(socket.id)?.delete(roomID);
      leaveRoom(roomID, socket.id, true);
    });
    
    if (userRooms.get(socket.id)?.size === 0) {
      userRooms.delete(socket.id);
    }
  });

  /**
   * Обработчик полного отключения
   */
  socket.on('disconnect', (reason) => {
    console.log(`User disconnected: ${socket.id}, reason: ${reason}`);
    
    userActivity.delete(socket.id);
    messageCooldown.delete(socket.id);
    
    const rooms = Array.from(socket.rooms);
    const realRooms = rooms.filter(roomID =>
      roomID !== socket.id && validate(roomID) && version(roomID) === 4
    );

    realRooms.forEach(roomID => {
      cleanupRoom(roomID);
    });
  });
});

// Хранилище для отслеживания активности пользователей
const userActivity = new Map<string, number>();

// Периодическая проверка на неактивных пользователей
setInterval(() => {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 минут
  
  userActivity.forEach((lastActive, userId) => {
    if (now - lastActive > timeout) {
      const socket = io.sockets.sockets.get(userId);
      if (socket) {
        console.log(`Auto-disconnecting inactive user: ${userId}`);
        socket.disconnect();
      }
      userActivity.delete(userId);
    }
  });
}, 60000); // Проверка каждую минуту

/**
 * Запуск сервера
 */
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});