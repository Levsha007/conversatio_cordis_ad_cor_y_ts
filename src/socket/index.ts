import { io, Socket, ManagerOptions, SocketOptions } from 'socket.io-client';
import { ACTIONS } from './actions';

// Интерфейс для сообщений чата
interface ChatMessage {
  id: string;          // Уникальный идентификатор сообщения
  sender: string;      // ID отправителя
  message: string;     // Текст сообщения
  timestamp: string;   // Временная метка
}

// Кастомные опции для Socket.IO клиента
type CustomSocketOptions = Partial<ManagerOptions & SocketOptions> & {
  "force new connection"?: boolean;  // Принудительное новое соединение
};

// Настройки подключения Socket.IO
const options: CustomSocketOptions = {
  "force new connection": true,  // Всегда создавать новое соединение
  reconnectionAttempts: Infinity, // Бесконечные попытки переподключения
  timeout: 10000,                // Таймаут соединения 10 секунд
  transports: ["websocket"],     // Предпочитаемый транспорт
  withCredentials: true          // Передавать куки и заголовки аутентификации
};

// Типы событий от сервера к клиенту
interface ServerToClientEvents {
  // Список доступных комнат
  [ACTIONS.SHARE_ROOMS]: (params: { rooms: string[] }) => void;
  // Добавление нового участника
  [ACTIONS.ADD_PEER]: (params: { peerID: string, createOffer: boolean }) => void;
  // Удаление участника
  [ACTIONS.REMOVE_PEER]: (params: { peerID: string }) => void;
  // ICE кандидат для установки P2P соединения
  [ACTIONS.ICE_CANDIDATE]: (params: { peerID: string, iceCandidate: RTCIceCandidateInit }) => void;
  // SDP описание сессии
  [ACTIONS.SESSION_DESCRIPTION]: (params: { peerID: string, sessionDescription: RTCSessionDescriptionInit }) => void;
  // Новое сообщение чата
  [ACTIONS.CHAT_MESSAGE]: (params: { 
    id: string;
    sender: string;
    message: string;
    timestamp: string;
  }) => void;
  // История сообщений чата
  [ACTIONS.CHAT_HISTORY]: (messages: ChatMessage[]) => void;
}

// Типы событий от клиента к серверу
interface ClientToServerEvents {
  // Подключение к комнате
  [ACTIONS.JOIN]: (params: { room: string }) => void;
  // Запрос списка комнат
  [ACTIONS.GET_ROOMS]: () => void;
  // Передача ICE кандидата
  [ACTIONS.RELAY_ICE]: (params: { peerID: string, iceCandidate: RTCIceCandidateInit }) => void;
  // Передача SDP описания
  [ACTIONS.RELAY_SDP]: (params: { peerID: string, sessionDescription: RTCSessionDescriptionInit }) => void;
  // Отправка сообщения в чат
  [ACTIONS.CHAT_MESSAGE]: (params: { 
    roomID: string;
    message: string;
    id: string;
    timestamp: string;
  }) => void;
  // Запрос истории чата
  [ACTIONS.REQUEST_CHAT_HISTORY]: (params: { roomID: string }) => void;
  // Выход из комнаты
  [ACTIONS.LEAVE]: () => void;
}

// Создание и настройка экземпляра Socket.IO клиента
const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
  "https://conversatio-cordis-ad-cor-y-ts.onrender.com", 
  {
    ...options,
    transports: ["websocket", "polling"]  // Используемые транспорты
  }
);

export default socket;