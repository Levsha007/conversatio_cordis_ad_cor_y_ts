import path from 'path';
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { v4 as uuidv4, validate, version } from 'uuid';
import { ACTIONS } from './socket/actions';

// Интерфейс для сообщений чата 
interface ChatMessage {
  id: string;          // Уникальный идентификатор сообщения
  sender: string;      // ID отправителя
  message: string;     // Текст сообщения
  timestamp: string;   // Временная метка сообщения
}

// Инициализация Express приложения и HTTP сервера
const app = express();
const server = createServer(app);

// Настройка Socket.IO сервера
const io = new Server(server, {
  cors: {
    origin: [
      "https://conversatio-cordis-ad-cor-y-ts.vercel.app",
      "http://localhost:3000"
    ],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket", "polling"],  // Используемые транспорты
  pingTimeout: 60000,    // Таймаут соединения
  pingInterval: 25000    // Интервал пингов
});

const PORT = process.env.PORT || 3001;
// Хранилище истории чатов для комнат (roomID -> ChatMessage[])
const roomChats = new Map<string, ChatMessage[]>();

// Получение списка активных комнат
function getClientRooms(): string[] {
  const { rooms } = io.sockets.adapter;
  // Фильтруем только валидные UUID v4 комнаты
  return Array.from(rooms.keys()).filter(roomID => 
    validate(roomID) && version(roomID) === 4
  );
}

// Рассылка информации о комнатах всем клиентам
function shareRoomsInfo(): void {
  const rooms = getClientRooms();
  io.emit(ACTIONS.SHARE_ROOMS, { rooms });
}

// Очистка истории чата при опустошении комнаты
function cleanupRoom(roomID: string): void {
  const room = io.sockets.adapter.rooms.get(roomID);
  if (!room || room.size === 0) {
    roomChats.delete(roomID);
    console.log(`Chat history cleared for room ${roomID}`);
  }
}

// Обработка нового подключения
io.on('connection', (socket: Socket) => {
  console.log('New connection:', socket.id);
  
  shareRoomsInfo();
  
  // Периодическая рассылка информации о комнатах
  const roomsInterval = setInterval(shareRoomsInfo, 3000);

  // Обработка запроса списка комнат
  socket.on(ACTIONS.GET_ROOMS, () => {
    socket.emit(ACTIONS.SHARE_ROOMS, { rooms: getClientRooms() });
  });

  // Обработка подключения к комнате
  socket.on(ACTIONS.JOIN, (config: { room: string }) => {
    const { room: roomID } = config;
    
    // Валидация ID комнаты
    if (!validate(roomID) || version(roomID) !== 4) {
      return console.warn(`Invalid room ID: ${roomID}`);
    }

    // Проверка, что клиент еще не в комнате
    const joinedRooms = Array.from(socket.rooms);
    if (joinedRooms.includes(roomID)) {
      return console.warn(`Already joined to ${roomID}`);
    }

    // Получаем список участников комнаты
    const clients = Array.from(io.sockets.adapter.rooms.get(roomID) || []);

    // Уведомляем участников о новом подключении
    clients.forEach(clientID => {
      // Существующие клиенты получают уведомление о новом участнике
      io.to(clientID).emit(ACTIONS.ADD_PEER, {
        peerID: socket.id,
        createOffer: false
      });

      // Новый клиент получает уведомление о существующих участниках
      socket.emit(ACTIONS.ADD_PEER, {
        peerID: clientID,
        createOffer: true,
      });
    });

    socket.join(roomID);
    console.log(`User ${socket.id} joined room ${roomID}`);

    // Инициализация истории чата для новой комнаты
    if (!roomChats.has(roomID)) {
      roomChats.set(roomID, []);
    }

    // Отправка истории чата новому участнику
    socket.emit(ACTIONS.CHAT_HISTORY, roomChats.get(roomID) || []);
    shareRoomsInfo();
  });

  // Функция выхода из комнаты
  function leaveRoom(): void {
    const rooms = Array.from(socket.rooms);
    
    // Фильтруем только реальные комнаты (исключая комнату с ID сокета)
    const realRooms = rooms.filter(roomID => 
      roomID !== socket.id && validate(roomID) && version(roomID) === 4
    );

    if (realRooms.length === 0) return;

    realRooms.forEach(roomID => {
      const clients = Array.from(io.sockets.adapter.rooms.get(roomID) || []);
      
      // Уведомляем участников о выходе
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

  // Обработка сообщений чата
  socket.on(ACTIONS.CHAT_MESSAGE, (data: { 
    roomID: string; 
    message: string; 
    id?: string; 
    timestamp?: string 
  }) => {
    const { roomID, message, id, timestamp } = data;
    
    // Валидация ID комнаты
    if (!validate(roomID) || version(roomID) !== 4) return;
    
    // Создание объекта сообщения
    const chatMessage: ChatMessage = {
      id: id || `${socket.id}-${Date.now()}`,  // Генерация ID если не предоставлен
      sender: socket.id,
      message,
      timestamp: timestamp || new Date().toISOString()  // Текущее время если не предоставлено
    };

    // Инициализация истории чата для новой комнаты
    if (!roomChats.has(roomID)) {
      roomChats.set(roomID, []);
    }

    const roomMessages = roomChats.get(roomID)!;
    
    // Ограничение истории 100 сообщениями
    if (roomMessages.length >= 100) {
      roomMessages.shift();
    }
    
    // Добавление сообщения и рассылка участникам
    roomMessages.push(chatMessage);
    io.to(roomID).emit(ACTIONS.CHAT_MESSAGE, chatMessage);
  });

  // Обработка запроса истории чата
  socket.on(ACTIONS.REQUEST_CHAT_HISTORY, ({ roomID }: { roomID: string }) => {
    if (roomChats.has(roomID)) {
      socket.emit(ACTIONS.CHAT_HISTORY, roomChats.get(roomID) || []);
    } else {
      socket.emit(ACTIONS.CHAT_HISTORY, []);
    }
  });

  // Обработка явного выхода из комнаты
  socket.on(ACTIONS.LEAVE, leaveRoom);
  
  // Обработка отключения клиента
  socket.on('disconnecting', () => {
    const hasRealRooms = Array.from(socket.rooms).some(roomID => 
      roomID !== socket.id && validate(roomID) && version(roomID) === 4
    );
    
    if (hasRealRooms) {
      leaveRoom();
    }
    console.log(`User disconnecting: ${socket.id}`);
  });
  
  // Обработка полного отключения клиента
  socket.on('disconnect', () => {
    clearInterval(roomsInterval);
    console.log(`User disconnected: ${socket.id}`);
  });

  // Релеирование SDP (Session Description Protocol) данных между клиентами
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

  // Релеирование ICE кандидатов между клиентами
  socket.on(ACTIONS.RELAY_ICE, ({ 
    peerID, 
    iceCandidate 
  }: { 
    peerID: string; 
    iceCandidate: RTCIceCandidateInit 
  }) => {
    io.to(peerID).emit(ACTIONS.ICE_CANDIDATE, {
      peerID: socket.id,
      iceCandidate,
    });
  });

  // Обработка ошибок сокета
  socket.on('error', (err: Error) => {
    console.error('Socket error:', err);
  });
});

// Запуск сервера
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});