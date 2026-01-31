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

    const clients = Array.from(io.sockets.adapter.rooms.get(roomID) || []);
    const userNumber = getUserNumber(roomID, socket.id);

    // Сохраняем имя пользователя
    if (userName) {
      setUserName(roomID, socket.id, userName);
    } else {
      setUserName(roomID, socket.id, `Участник ${userNumber}`);
    }

    const currentUserName = getUserName(roomID, socket.id);

    // Отправляем сообщение в чат о подключении нового участника
    const joinMessage: ChatMessage = {
      id: `system-join-${Date.now()}-${socket.id}`,
      sender: 'system',
      message: `${currentUserName} подключился к комнате`,
      timestamp: new Date().toISOString(),
      userNumber: 0,
      userName: 'Система'
    };

    if (!roomChats.has(roomID)) {
      roomChats.set(roomID, []);
    }

    const roomMessages = roomChats.get(roomID)!;
    if (roomMessages.length >= 100) {
      roomMessages.shift();
    }
    roomMessages.push(joinMessage);

    // Рассылаем уведомление о подключении
    io.to(roomID).emit(ACTIONS.CHAT_MESSAGE, joinMessage);

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

    // Отправляем историю чата текущему пользователю
    socket.emit(ACTIONS.CHAT_HISTORY, roomChats.get(roomID) || []);
  });

  /**
   * Функция выхода из комнаты
   */
  function leaveRoom(): void {
    const rooms = Array.from(socket.rooms);
    const realRooms = rooms.filter(roomID =>
      roomID !== socket.id && validate(roomID) && version(roomID) === 4
    );

    if (realRooms.length === 0) return;

    realRooms.forEach(roomID => {
      // Отправляем сообщение в чат об отключении участника
      const userName = getUserName(roomID, socket.id);
      const leaveMessage: ChatMessage = {
        id: `system-leave-${Date.now()}-${socket.id}`,
        sender: 'system',
        message: `${userName} покинул комнату`,
        timestamp: new Date().toISOString(),
        userNumber: 0,
        userName: 'Система'
      };

      if (roomChats.has(roomID)) {
        const roomMessages = roomChats.get(roomID)!;
        if (roomMessages.length >= 100) {
          roomMessages.shift();
        }
        roomMessages.push(leaveMessage);
        
        // Рассылаем уведомление об отключении
        io.to(roomID).emit(ACTIONS.CHAT_MESSAGE, leaveMessage);
      }

      const clients = Array.from(io.sockets.adapter.rooms.get(roomID) || []);
      clients.forEach(clientID => {
        io.to(clientID).emit(ACTIONS.REMOVE_PEER, {
          peerID: socket.id,
        });
        socket.emit(ACTIONS.REMOVE_PEER, {
          peerID: clientID,
        });
      });

      // Удаляем имя пользователя при выходе
      if (roomUserNames.has(roomID)) {
        roomUserNames.get(roomID)!.delete(socket.id);
      }

      socket.leave(roomID);
      console.log(`User ${socket.id} left room ${roomID}`);
      cleanupRoom(roomID);
    });
  }

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
   * Обработчик выхода из комнаты
   */
  socket.on(ACTIONS.LEAVE, leaveRoom);

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
  socket.on('disconnecting', () => {
    const hasRealRooms = Array.from(socket.rooms).some(roomID =>
      roomID !== socket.id && validate(roomID) && version(roomID) === 4
    );
    if (hasRealRooms) {
      leaveRoom();
    }
    console.log(`User disconnecting: ${socket.id}`);
  });

  /**
   * Обработчик полного отключения
   */
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

/**
 * Запуск сервера
 */
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});