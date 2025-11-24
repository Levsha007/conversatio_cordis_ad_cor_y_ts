// Импорт библиотеки Socket.IO клиента и типов
import { io, Socket, ManagerOptions, SocketOptions } from 'socket.io-client';
import { ACTIONS } from './actions';

/**
 * Интерфейс для сообщения чата
 */
interface ChatMessage {
  id: string;          // Уникальный ID сообщения
  sender: string;      // ID отправителя
  message: string;     // Текст сообщения
  timestamp: string;   // Временная метка
  userNumber?: number; // Номер пользователя
  userName?: string;   // Имя пользователя
}

/**
 * Интерфейс для прикреплённого файла в чате
 */
interface FileAttachment {
  id: string;          // Уникальный ID события
  sender: string;      // ID отправителя
  fileName: string;    // Имя файла
  timestamp: string;   // Временная метка
}

/**
 * Расширенные опции для подключения к серверу
 */
type CustomSocketOptions = Partial<ManagerOptions & SocketOptions> & {
  "force new connection"?: boolean;
};

// Конфигурация подключения к серверу
const options: CustomSocketOptions = {
  "force new connection": true,
  reconnectionAttempts: Infinity, // Бесконечные попытки переподключения
  timeout: 10000,                 // Таймаут подключения
  transports: ["websocket"],      // Приоритет WebSocket
  withCredentials: true           // Поддержка кросс-доменных запросов
};

/**
 * Типы событий, которые может получать клиент от сервера
 */
interface ServerToClientEvents {
  [ACTIONS.ADD_PEER]: (params: { peerID: string, createOffer: boolean, userNumber?: number }) => void;
  [ACTIONS.REMOVE_PEER]: (params: { peerID: string }) => void;
  [ACTIONS.ICE_CANDIDATE]: (params: { peerID: string, iceCandidate: RTCIceCandidateInit }) => void;
  [ACTIONS.SESSION_DESCRIPTION]: (params: { peerID: string, sessionDescription: RTCSessionDescriptionInit }) => void;
  [ACTIONS.CHAT_MESSAGE]: (params: { 
    id: string;
    sender: string;
    message: string;
    timestamp: string;
    userNumber?: number;
    userName?: string;
  }) => void;
  [ACTIONS.CHAT_HISTORY]: (messages: (ChatMessage | FileAttachment)[]) => void;
  [ACTIONS.FILE_ATTACHED]: (params: FileAttachment) => void;
}

/**
 * Типы событий, которые может отправлять клиент серверу
 */
interface ClientToServerEvents {
  [ACTIONS.JOIN]: (params: { room: string }) => void;
  [ACTIONS.RELAY_ICE]: (params: { peerID: string, iceCandidate: RTCIceCandidateInit }) => void;
  [ACTIONS.RELAY_SDP]: (params: { peerID: string, sessionDescription: RTCSessionDescriptionInit }) => void;
  [ACTIONS.CHAT_MESSAGE]: (params: { 
    roomID: string;
    message: string;
    id: string;
    timestamp: string;
    userName?: string;
  }) => void;
  [ACTIONS.REQUEST_CHAT_HISTORY]: (params: { roomID: string }) => void;
  [ACTIONS.FILE_ATTACHED]: (params: {
    roomID: string;
    fileName: string;
    id?: string;
    timestamp?: string;
  }) => void;
  [ACTIONS.LEAVE]: () => void;
}

/**
 * Создание экземпляра сокета с полной типизацией
 */
const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
  "https://conversatio-cordis-ad-cor-y-ts.onrender.com",  
  {
    ...options,
    transports: ["websocket", "polling"] // Используем оба транспорта
  }
);

export default socket;