// src/socket/actions.ts

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
  if (!name) return 'Участник';
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

export type JoinAction = {
  type: typeof ACTIONS.JOIN;
  room: string;
  userId?: string;
  userName?: string;
  hasMedia?: boolean;
};

export type IceCandidateAction = {
  type: typeof ACTIONS.ICE_CANDIDATE;
  peerID: string;
  iceCandidate: RTCIceCandidate;
};

export type FileAttachedAction = {
  type: typeof ACTIONS.FILE_ATTACHED;
  roomID: string;
  fileName: string;
  sender: string;
  timestamp: string;
};

export type SocketAction = JoinAction | IceCandidateAction | FileAttachedAction | { type: typeof ACTIONS.LEAVE };
export type ActionHandler<T extends SocketAction> = (action: T) => void;

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

// Информация об участнике
interface ParticipantInfo {
  id: string;
  name: string;
  isOnline: boolean;
}

// События от сервера к клиенту
export interface ServerToClientEvents {
  [ACTIONS.ADD_PEER]: (params: { 
    peerID: string; 
    createOffer: boolean; 
    userNumber?: number;
    userName?: string;
    hasMedia?: boolean;
  }) => void;
  [ACTIONS.REMOVE_PEER]: (params: { peerID: string }) => void;
  [ACTIONS.ICE_CANDIDATE]: (params: { 
    peerID: string; 
    iceCandidate: RTCIceCandidateInit;
    isRelayForward?: boolean;
    sourcePeerId?: string;
  }) => void;
  [ACTIONS.SESSION_DESCRIPTION]: (params: { 
    peerID: string; 
    sessionDescription: RTCSessionDescriptionInit;
    isRelayForward?: boolean;
    sourcePeerId?: string;
  }) => void;
  [ACTIONS.CHAT_MESSAGE]: (params: ChatMessage) => void;
  [ACTIONS.CHAT_HISTORY]: (messages: ChatMessage[]) => void;
  [ACTIONS.FILE_ATTACHED]: (params: FileAttachment) => void;
  [ACTIONS.RAISE_HAND]: (params: { peerID: string; userName: string }) => void;
  [ACTIONS.LOWER_HAND]: (params: { peerID: string; userName: string }) => void;
  
  // Дополнительные события для Room компонента
  'user-joined': (params: { 
    peerID: string; 
    userName: string;
    timestamp: string;
    participants?: ParticipantInfo[];
  }) => void;
  'user-left': (params: { 
    peerID: string; 
    userName: string;
    timestamp: string;
    participants?: ParticipantInfo[];
  }) => void;
  'user-name-updated': (params: { peerID: string; userName: string }) => void;
  'participants-list': (participants: ParticipantInfo[]) => void;
  'error': (params: { message: string }) => void;
  'topology-update': (params: { 
    edges: Array<{ from: string; to: string; type: string }>; 
    relayAssignments: [string, string][];
    timestamp: number;
  }) => void;
}

// События от клиента к серверу
export interface ClientToServerEvents {
  [ACTIONS.JOIN]: (params: { 
    room: string;
    userName?: string;
    hasMedia?: boolean;
  }) => void;
  [ACTIONS.RELAY_ICE]: (params: { 
    peerID: string; 
    iceCandidate: RTCIceCandidateInit;
    isRelayForward?: boolean;
    sourcePeerId?: string;
  }) => void;
  [ACTIONS.RELAY_SDP]: (params: { 
    peerID: string; 
    sessionDescription: RTCSessionDescriptionInit;
    isRelayForward?: boolean;
    sourcePeerId?: string;
  }) => void;
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
  
  // Дополнительные события
  'update-user-name': (params: { roomID: string; userName: string }) => void;
  'get-participants': (params: { roomID: string }) => void;
  'bandwidth-report': (params: { 
    peerId: string; 
    inboundBps: number; 
    outboundBps: number; 
    rtt: number;
  }) => void;
  'request-topology': () => void;
  'become-relay': () => void;
  'stop-relay': () => void;
}

export type { ChatMessage, FileAttachment, ParticipantInfo };