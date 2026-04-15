/**
 * Константы действий (именованные события) для WebSocket соединения
 * Каждое действие соответствует определённому событию в системе видеоконференций
 */
export const ACTIONS = {
  // Подключение к комнате
  JOIN: 'join',
  // Выход из комнаты
  LEAVE: 'leave',
  // Добавление нового участника
  ADD_PEER: 'add-peer',
  // Удаление участника
  REMOVE_PEER: 'remove-peer',
  // Сообщение в чате
  CHAT_MESSAGE: 'chat-message',
  // История чата
  CHAT_HISTORY: 'chat-history',
  // Запрос истории чата
  REQUEST_CHAT_HISTORY: 'request-chat-history',
  // Поднятие руки
  RAISE_HAND: 'raise-hand',
  // Опускание руки
  LOWER_HAND: 'lower-hand'
} as const;

export default ACTIONS;

/**
 * Утилиты для очистки и валидации данных
 */
export const sanitizeInput = (input: string): string => {
  if (!input) return '';
  
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .trim()
    .substring(0, 1000);
};

export const sanitizeUserName = (name: string): string => {
  if (!name) return '';
  const sanitized = sanitizeInput(name);
  return sanitized || 'Участник';
};

export const sanitizeMessage = (message: string): string => {
  if (!message) return '';
  return sanitizeInput(message);
};

export const validateRoomID = (roomID: string): boolean => {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roomID);
};

export type ActionKeys = keyof typeof ACTIONS;
export type ActionValues = typeof ACTIONS[ActionKeys];

// События от сервера к клиенту
export interface ServerToClientEvents {
  [ACTIONS.ADD_PEER]: (params: { 
    peerID: string; 
    createOffer: boolean; 
    userName?: string;
    hasMedia?: boolean;
  }) => void;
  [ACTIONS.REMOVE_PEER]: (params: { peerID: string }) => void;
  [ACTIONS.CHAT_MESSAGE]: (params: {
    id: string;
    sender: string;
    message: string;
    timestamp: string;
    userName?: string;
  }) => void;
  [ACTIONS.CHAT_HISTORY]: (messages: any[]) => void;
  [ACTIONS.RAISE_HAND]: (params: { peerID: string; userName: string }) => void;
  [ACTIONS.LOWER_HAND]: (params: { peerID: string; userName: string }) => void;
  
  'transport-created': (params: {
    id: string;
    iceParameters: any;
    iceCandidates: any[];
    dtlsParameters: any;
  }) => void;
  'existing-peers': (peers: Array<{ peerId: string; userName: string; hasMedia: boolean }>) => void;
  'new-producer': (params: {
    peerId: string;
    peerName: string;
    kind: 'audio' | 'video';
    consumerParameters: any;
  }) => void;
  'producer-created': (params: { kind: 'audio' | 'video'; producerId: string }) => void;
  'active-speaker': (params: { peerId: string }) => void;
  'user-name-updated': (params: { peerID: string; userName: string }) => void;
  'error': (params: { message: string }) => void;
}

// События от клиента к серверу
export interface ClientToServerEvents {
  [ACTIONS.JOIN]: (params: { room: string; userName?: string; hasMedia?: boolean }) => void;
  [ACTIONS.CHAT_MESSAGE]: (params: {
    roomID: string;
    message: string;
    id: string;
    timestamp: string;
    userName?: string;
  }) => void;
  [ACTIONS.REQUEST_CHAT_HISTORY]: (params: { roomID: string }) => void;
  [ACTIONS.LEAVE]: () => void;
  [ACTIONS.RAISE_HAND]: (params: { roomID: string }) => void;
  [ACTIONS.LOWER_HAND]: (params: { roomID: string }) => void;
  
  'create-producer': (params: { kind: 'audio' | 'video'; rtpParameters: any }) => void;
  'resume-consumer': (params: { peerId: string; kind: 'audio' | 'video' }) => void;
  'audio-level': (params: { level: number }) => void;
  'update-user-name': (params: { roomID: string; userName: string }) => void;
}