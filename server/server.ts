import path from 'path';
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { v4 as uuidv4, validate, version } from 'uuid';

// Импорт констант действий из actions.ts
import { ACTIONS } from './socket/actions';

/**
 * Интерфейс для сообщений чата
 */
interface ChatMessage {
  id: string;          // Уникальный ID сообщения
  sender: string;      // ID отправителя
  message: string;     // Текст сообщения
  timestamp: string;   // Временная метка
  userNumber?: number; // Номер пользователя
  userName?: string;   // Имя пользователя
}

// Создаем Express приложение и HTTP сервер
const app = express();
const server = createServer(app);

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

  // Удаляем имя пользователя при выходе
  if (roomUserNames.has(roomID)) {
    roomUserNames.get(roomID)!.delete(socketId);
  }

  if (!isDisconnecting) {
    // Только если это не автоматическое отключение, выходим из комнаты
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

  /**
   * Обработчик входа в комнату
   * @param config - параметры входа
   */
  socket.on(ACTIONS.JOIN, (config: { room: string; userName?: string }) => {
    const { room: roomID, userName } = config;
    if (!validate(roomID)) {
      return console.warn(`Invalid room ID: ${roomID}`);
    }

    // Добавляем участника в общий список
    if (!allParticipants.has(roomID)) {
      allParticipants.set(roomID, new Set());
    }
    allParticipants.get(roomID)!.add(socket.id);

    const clients = Array.from(io.sockets.adapter.rooms.get(roomID) || []);
    const userNumber = getUserNumber(roomID, socket.id);

    // Сохраняем имя пользователя
    if (userName) {
      setUserName(roomID, socket.id, userName);
    } else {
      setUserName(roomID, socket.id, `Участник ${userNumber}`);
    }

    const currentUserName = getUserName(roomID, socket.id);

    // Получаем список всех участников
    const participantsList = getAllParticipants(roomID);

    // Отправляем уведомление о подключении (НЕ в чат)
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
      
      // Отправляем новому пользователю информацию о существующих участниках
      socket.emit(ACTIONS.ADD_PEER, {
        peerID: clientID,
        createOffer: true,
        userNumber: clientUserNumber,
        userName: clientUserName
      });
    });

    // Присоединяемся к комнате
    socket.join(roomID);
    console.log(`User ${socket.id} (${currentUserName}) joined room ${roomID} as Participant ${userNumber}`);

    // Если история чата ещё не существует, создаем её
    if (!roomChats.has(roomID)) {
      roomChats.set(roomID, []);
    }

    // Отправляем историю чата текущему пользователю
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

    const userNumber = getUserNumber(roomID, socket.id);
    const currentUserName = getUserName(roomID, socket.id);

    // Если передано новое имя, обновляем его
    if (userName && userName !== currentUserName) {
      setUserName(roomID, socket.id, userName);
      
      // Отправляем всем обновление имени
      io.to(roomID).emit('user-name-updated', {
        peerID: socket.id,
        userName: getUserName(roomID, socket.id)
      });
    }

    const chatMessage: ChatMessage = {
      id: id || `${socket.id}-${Date.now()}`,
      sender: socket.id,
      message,
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
    
    // Рассылаем всем участникам с номером пользователя и именем
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
    
    setUserName(roomID, socket.id, userName);
    const currentUserName = getUserName(roomID, socket.id);
    
    // Отправляем всем обновление имени
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
      leaveRoom(roomID, socket.id, false);
    });
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
   * Обработчик отключения (перед фактическим отключением)
   */
  socket.on('disconnecting', (reason) => {
    console.log(`User disconnecting: ${socket.id}, reason: ${reason}`);
    
    const rooms = Array.from(socket.rooms);
    const realRooms = rooms.filter(roomID =>
      roomID !== socket.id && validate(roomID) && version(roomID) === 4
    );

    // Для каждой комнаты вызываем leaveRoom с флагом disconnecting
    realRooms.forEach(roomID => {
      leaveRoom(roomID, socket.id, true);
    });
  });

  /**
   * Обработчик полного отключения
   */
  socket.on('disconnect', (reason) => {
    console.log(`User disconnected: ${socket.id}, reason: ${reason}`);
    
    // Дополнительная очистка если нужно
    const rooms = Array.from(socket.rooms);
    const realRooms = rooms.filter(roomID =>
      roomID !== socket.id && validate(roomID) && version(roomID) === 4
    );

    // Убеждаемся что пользователь удален из всех комнат
    realRooms.forEach(roomID => {
      cleanupRoom(roomID);
    });
  });
});

/**
 * Запуск сервера
 */
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});