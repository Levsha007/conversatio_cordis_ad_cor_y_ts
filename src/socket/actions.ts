/**
 * Константы действий (именованные события) для WebSocket соединения
 * Каждое действие соответствует определённому событию в системе видеоконференций
 */
export const ACTIONS = {
  // Подключение к комнате
  JOIN: 'join',
  // Выход из комнаты
  LEAVE: 'leave',
  // Обмен списком доступных комнат
  SHARE_ROOMS: 'share-rooms',
  // Запрос списка комнат
  GET_ROOMS: 'get-rooms',
  // Добавление нового участника
  ADD_PEER: 'add-peer',
  // Удаление участника
  REMOVE_PEER: 'remove-peer',
  // Передача SDP (Session Description Protocol) данных
  RELAY_SDP: 'relay-sdp',
  // Передача ICE (Interactive Connectivity Establishment) кандидатов
  RELAY_ICE: 'relay-ice',
  // ICE кандидат для установки P2P соединения
  ICE_CANDIDATE: 'ice-candidate',
  // Описание сессии WebRTC
  SESSION_DESCRIPTION: 'session-description',
  // Сообщение в чате
  CHAT_MESSAGE: 'chat-message',
  // История чата
  CHAT_HISTORY: 'chat-history',
  // Запрос истории чата
  REQUEST_CHAT_HISTORY: 'request-chat-history',
  // Прикрепление файла в чате
  FILE_ATTACHED: 'file-attached',
  // Поднятие руки
  RAISE_HAND: 'raise-hand',
  // Опускание руки
  LOWER_HAND: 'lower-hand'
} as const;

// Экспорт по умолчанию для обратной совместимости
export default ACTIONS;

/**
 * Утилиты для очистки и валидации данных
 */
export const sanitizeInput = (input: string): string => {
  return input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
    .trim()
    .substring(0, 1000);
};

export const sanitizeUserName = (name: string): string => {
  const sanitized = sanitizeInput(name);
  return sanitized || 'Участник';
};

export const sanitizeMessage = (message: string): string => {
  return sanitizeInput(message);
};

export const validateRoomID = (roomID: string): boolean => {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roomID);
};

/**
 * Типы для работы с действиями
 */

// Тип ключей действий (например 'JOIN' | 'LEAVE' | ...)
export type ActionKeys = keyof typeof ACTIONS;

// Тип значений действий (например 'join' | 'leave' | ...)
export type ActionValues = typeof ACTIONS[ActionKeys];

/**
 * Типы для конкретных событий
 */

// Действие подключения к комнате
export type JoinAction = {
  type: typeof ACTIONS.JOIN;
  room: string;
  userId?: string;
  userName?: string;
  hasMedia?: boolean;
};

// Действие передачи ICE кандидата
export type IceCandidateAction = {
  type: typeof ACTIONS.ICE_CANDIDATE;
  peerID: string;
  iceCandidate: RTCIceCandidate;
};

// Событие прикрепления файла
export type FileAttachedAction = {
  type: typeof ACTIONS.FILE_ATTACHED;
  roomID: string;
  fileName: string;
  sender: string;
  timestamp: string;
};

/**
 * Объединённый тип всех возможных действий
 */
export type SocketAction =
  | JoinAction
  | IceCandidateAction
  | FileAttachedAction
  | { type: typeof ACTIONS.LEAVE };

/**
 * Тип для обработчиков действий
 * @template T - конкретный тип действия
 */
export type ActionHandler<T extends SocketAction> = (action: T) => void;

// --------------------------
// Типы для Socket.IO (Server-to-client / Client-to-server)
// --------------------------

// Сообщение чата
interface ChatMessage {
  id: string;
  sender: string;
  message: string;
  timestamp: string;
  userNumber?: number;
  userName?: string;
}

// Сообщение о прикреплённом файле
interface FileAttachment {
  id: string;
  sender: string;
  fileName: string;
  timestamp: string;
}

// События от сервера к клиенту
interface ServerToClientEvents {
  [ACTIONS.ADD_PEER]: (params: {
    peerID: string;
    createOffer: boolean;
    userNumber?: number;
    userName?: string;
    hasMedia?: boolean;
  }) => void;
  [ACTIONS.REMOVE_PEER]: (params: { peerID: string }) => void;
  [ACTIONS.ICE_CANDIDATE]: (params: { peerID: string; iceCandidate: RTCIceCandidateInit }) => void;
  [ACTIONS.SESSION_DESCRIPTION]: (params: { peerID: string; sessionDescription: RTCSessionDescriptionInit }) => void;
  [ACTIONS.CHAT_MESSAGE]: (params: ChatMessage) => void;
  [ACTIONS.CHAT_HISTORY]: (messages: ChatMessage[]) => void;
  [ACTIONS.FILE_ATTACHED]: (params: FileAttachment) => void;
  [ACTIONS.RAISE_HAND]: (params: { peerID: string; userName: string }) => void;
  [ACTIONS.LOWER_HAND]: (params: { peerID: string; userName: string }) => void;
  'user-name-updated': (params: { peerID: string; userName: string }) => void;
}

// События от клиента к серверу
interface ClientToServerEvents {
  [ACTIONS.JOIN]: (params: {
    room: string;
    userName?: string;
    hasMedia?: boolean;
  }) => void;
  [ACTIONS.RELAY_ICE]: (params: { peerID: string; iceCandidate: RTCIceCandidateInit }) => void;
  [ACTIONS.RELAY_SDP]: (params: { peerID: string; sessionDescription: RTCSessionDescriptionInit }) => void;
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
  [ACTIONS.RAISE_HAND]: (params: { roomID: string }) => void;
  [ACTIONS.LOWER_HAND]: (params: { roomID: string }) => void;
  'update-user-name': (params: { roomID: string; userName: string }) => void;
}

// Экспортируем интерфейсы для использования в других частях приложения
export type {
  ChatMessage,
  FileAttachment,
  ServerToClientEvents,
  ClientToServerEvents
};