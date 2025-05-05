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
  transports: ["websocket", "polling"],  // Используемые транспортные протоколы
  pingTimeout: 60000,    // Таймаут соединения (мс)
  pingInterval: 25000    // Интервал пинга (мс)
});

const PORT = process.env.PORT || 3001;  // Порт сервера
const roomChats = new Map<string, ChatMessage[]>();  // Хранилище чатов по комнатам

// Функция очистки истории чата пустой комнаты
function cleanupRoom(roomID: string): void {
  const room = io.sockets.adapter.rooms.get(roomID);
  // Если комнаты нет или она пуста - удаляем историю чата
  if (!room || room.size === 0) {
    roomChats.delete(roomID);
    console.log(`Chat history cleared for room ${roomID}`);
  }
}

// Обработчик подключения нового клиента
io.on('connection', (socket: Socket) => {
  console.log('New connection:', socket.id);
  
  // Обработчик входа в комнату
  socket.on(ACTIONS.JOIN, (config: { room: string }) => {
    const { room: roomID } = config;
    
    // Проверяем валидность UUID комнаты
    if (!validate(roomID)) {
      return console.warn(`Invalid room ID: ${roomID}`);
    }

    // Получаем список клиентов в комнате
    const clients = Array.from(io.sockets.adapter.rooms.get(roomID) || []);

    // Уведомляем всех участников о новом подключении
    clients.forEach(clientID => {
      // Существующим клиентам отправляем информацию о новом участнике
      io.to(clientID).emit(ACTIONS.ADD_PEER, {
        peerID: socket.id,
        createOffer: false  // Существующие клиенты не создают оффер
      });

      // Новому клиенту отправляем информацию о существующих участниках
      socket.emit(ACTIONS.ADD_PEER, {
        peerID: clientID,
        createOffer: true,  // Новый клиент создает оффер
      });
    });

    // Присоединяем сокет к комнате
    socket.join(roomID);
    console.log(`User ${socket.id} joined room ${roomID}`);

    // Инициализируем историю чата для комнаты, если ее нет
    if (!roomChats.has(roomID)) {
      roomChats.set(roomID, []);
    }

    // Отправляем новому участнику историю чата
    socket.emit(ACTIONS.CHAT_HISTORY, roomChats.get(roomID) || []);
  });

  // Функция выхода из комнаты
  function leaveRoom(): void {
    // Получаем все комнаты, в которых находится сокет
    const rooms = Array.from(socket.rooms);
    // Фильтруем только реальные комнаты (исключая комнату с ID сокета)
    const realRooms = rooms.filter(roomID => 
      roomID !== socket.id && validate(roomID) && version(roomID) === 4
    );

    if (realRooms.length === 0) return;

    // Обрабатываем каждую комнату
    realRooms.forEach(roomID => {
      const clients = Array.from(io.sockets.adapter.rooms.get(roomID) || []);
      
      // Уведомляем других участников о выходе
      clients.forEach(clientID => {
        io.to(clientID).emit(ACTIONS.REMOVE_PEER, {
          peerID: socket.id,
        });

        socket.emit(ACTIONS.REMOVE_PEER, {
          peerID: clientID,
        });
      });

      // Покидаем комнату
      socket.leave(roomID);
      console.log(`User ${socket.id} left room ${roomID}`);
      // Очищаем комнату, если она пуста
      cleanupRoom(roomID);
    });
  }

  // Обработчик сообщений чата
  socket.on(ACTIONS.CHAT_MESSAGE, (data: { 
    roomID: string; 
    message: string; 
    id?: string; 
    timestamp?: string 
  }) => {
    const { roomID, message, id, timestamp } = data;
    
    // Проверяем валидность ID комнаты
    if (!validate(roomID)) return;
    
    // Создаем объект сообщения
    const chatMessage: ChatMessage = {
      id: id || `${socket.id}-${Date.now()}`,  // Генерируем ID, если не предоставлен
      sender: socket.id,
      message,
      timestamp: timestamp || new Date().toISOString()  // Используем текущее время, если не предоставлено
    };

    // Инициализируем историю чата, если ее нет
    if (!roomChats.has(roomID)) {
      roomChats.set(roomID, []);
    }

    const roomMessages = roomChats.get(roomID)!;
    
    // Ограничиваем историю 100 сообщениями (удаляем самое старое при превышении)
    if (roomMessages.length >= 100) {
      roomMessages.shift();
    }
    
    // Добавляем сообщение в историю и рассылаем всем участникам комнаты
    roomMessages.push(chatMessage);
    io.to(roomID).emit(ACTIONS.CHAT_MESSAGE, chatMessage);
  });

  // Обработчик запроса истории чата
  socket.on(ACTIONS.REQUEST_CHAT_HISTORY, ({ roomID }: { roomID: string }) => {
    if (roomChats.has(roomID)) {
      socket.emit(ACTIONS.CHAT_HISTORY, roomChats.get(roomID) || []);
    } else {
      socket.emit(ACTIONS.CHAT_HISTORY, []);
    }
  });

  // Обработчик выхода из комнаты
  socket.on(ACTIONS.LEAVE, leaveRoom);
  
  // Обработчик отключения (перед фактическим отключением)
  socket.on('disconnecting', () => {
    // Проверяем, есть ли реальные комнаты
    const hasRealRooms = Array.from(socket.rooms).some(roomID => 
      roomID !== socket.id && validate(roomID) && version(roomID) === 4
    );
    
    // Если есть - вызываем функцию выхода
    if (hasRealRooms) {
      leaveRoom();
    }
    console.log(`User disconnecting: ${socket.id}`);
  });
  
  // Обработчик полного отключения
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });

  // Обработчик передачи SDP (Session Description Protocol)
  socket.on(ACTIONS.RELAY_SDP, ({ 
    peerID, 
    sessionDescription 
  }: { 
    peerID: string; 
    sessionDescription: RTCSessionDescriptionInit 
  }) => {
    // Пересылаем SDP указанному пиру
    io.to(peerID).emit(ACTIONS.SESSION_DESCRIPTION, {
      peerID: socket.id,
      sessionDescription,
    });
  });

  // Обработчик передачи ICE кандидатов
  socket.on(ACTIONS.RELAY_ICE, ({ 
    peerID, 
    iceCandidate 
  }: { 
    peerID: string; 
    iceCandidate: RTCIceCandidateInit 
  }) => {
    // Пересылаем ICE кандидат указанному пиру
    io.to(peerID).emit(ACTIONS.ICE_CANDIDATE, {
      peerID: socket.id,
      iceCandidate,
    });
  });

  // Обработчик ошибок сокета
  socket.on('error', (err: Error) => {
    console.error('Socket error:', err);
  });
});

// Запуск сервера
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});