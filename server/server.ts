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
  transports: ["websocket", "polling"],  // Поддерживаемые транспортные протоколы
  pingTimeout: 60000,    // Таймаут соединения (мс)
  pingInterval: 25000    // Интервал пинга (мс)
});

const PORT = process.env.PORT || 3001;  // Порт сервера

// Хранилище чатов по комнатам
const roomChats = new Map<string, ChatMessage[]>();
// Хранилище информации о пользователях
const userInfo = new Map<string, { name: string }>();

/**
 * Функция очистки истории чата пустой комнаты
 * @param roomID - ID комнаты
 */
function cleanupRoom(roomID: string): void {
  const room = io.sockets.adapter.rooms.get(roomID);
  if (!room || room.size === 0) {
    roomChats.delete(roomID);
    console.log(`Chat history cleared for room ${roomID}`);
  }
}

/**
 * Генерация читаемого имени пользователя
 */
function generateUserName(socketId: string): string {
  const names = ['Алексей', 'Мария', 'Иван', 'Ольга', 'Дмитрий', 'Елена', 'Сергей', 'Анна'];
  const randomName = names[Math.floor(Math.random() * names.length)];
  return `${randomName}-${socketId.substring(0, 4)}`;
}

/**
 * Обработчик подключения нового клиента
 * @param socket - клиентский сокет
 */
io.on('connection', (socket: Socket) => {
  console.log('New connection:', socket.id);
  
  // Генерируем имя для пользователя
  const userName = generateUserName(socket.id);
  userInfo.set(socket.id, { name: userName });

  /**
   * Обработчик входа в комнату
   * @param config - параметры входа
   */
  socket.on(ACTIONS.JOIN, (config: { room: string }) => {
    const { room: roomID } = config;
    if (!validate(roomID)) {
      return console.warn(`Invalid room ID: ${roomID}`);
    }

    const clients = Array.from(io.sockets.adapter.rooms.get(roomID) || []);

    // Отправляем всем участникам информацию о новом пользователе
    clients.forEach(clientID => {
      io.to(clientID).emit(ACTIONS.ADD_PEER, {
        peerID: socket.id,
        createOffer: false,
        userName: userInfo.get(socket.id)?.name || `User-${socket.id.substring(0, 4)}`
      });
      
      // Отправляем новому пользователю информацию о существующих участниках
      socket.emit(ACTIONS.ADD_PEER, {
        peerID: clientID,
        createOffer: true,
        userName: userInfo.get(clientID)?.name || `User-${clientID.substring(0, 4)}`
      });
    });

    // Присоединяемся к комнате
    socket.join(roomID);
    console.log(`User ${socket.id} (${userName}) joined room ${roomID}`);

    // Если история чата ещё не существует, создаем её
    if (!roomChats.has(roomID)) {
      roomChats.set(roomID, []);
    }

    // Отправляем историю чата текущему пользователю
    socket.emit(ACTIONS.CHAT_HISTORY, roomChats.get(roomID) || []);
    
    // Уведомляем всех о новом участнике
    socket.to(roomID).emit(ACTIONS.USER_JOINED, {
      userId: socket.id,
      userName: userName
    });
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
      const clients = Array.from(io.sockets.adapter.rooms.get(roomID) || []);
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
      
      // Уведомляем об уходе участника
      socket.to(roomID).emit(ACTIONS.USER_LEFT, {
        userId: socket.id
      });
      
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
  }) => {
    const { roomID, message, id, timestamp } = data;

    if (!validate(roomID)) return;

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
      roomMessages.shift(); // Ограничиваем историю до 100 сообщений
    }

    roomMessages.push(chatMessage);
    io.to(roomID).emit(ACTIONS.CHAT_MESSAGE, {
      ...chatMessage,
      userName: userInfo.get(socket.id)?.name || `User-${socket.id.substring(0, 4)}`
    }); // Рассылаем всем участникам
  });

  /**
   * Обработчик запроса истории чата
   */
  socket.on(ACTIONS.REQUEST_CHAT_HISTORY, ({ roomID }: { roomID: string }) => {
    if (roomChats.has(roomID)) {
      const messages = roomChats.get(roomID) || [];
      // Добавляем имена пользователей к истории сообщений
      const messagesWithNames = messages.map(msg => ({
        ...msg,
        userName: userInfo.get(msg.sender)?.name || `User-${msg.sender.substring(0, 4)}`
      }));
      socket.emit(ACTIONS.CHAT_HISTORY, messagesWithNames);
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
    userInfo.delete(socket.id);
    console.log(`User disconnected: ${socket.id}`);
  });
});

/**
 * Запуск сервера
 */
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});