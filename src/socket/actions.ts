/**
 * Константы действий (именованные события) для WebSocket соединения
 */
export const ACTIONS = {
  JOIN: 'join',
  LEAVE: 'leave',
  ADD_PEER: 'add-peer',
  REMOVE_PEER: 'remove-peer',
  CHAT_MESSAGE: 'chat-message',
  CHAT_HISTORY: 'chat-history',
  REQUEST_CHAT_HISTORY: 'request-chat-history',
  RAISE_HAND: 'raise-hand',
  LOWER_HAND: 'lower-hand'
} as const;

export default ACTIONS;

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

// Интерфейс для информации об участнике
export interface ParticipantInfo {
  id: string;
  name: string;
  isOnline: boolean;
}

// Интерфейс для параметров участника
export interface PeerParams {
  peerID: string;
  createOffer: boolean;
  userName?: string;
  hasMedia?: boolean;
  userNumber?: number;
}

// Интерфейс для сообщения чата
export interface ChatMessageParams {
  id: string;
  sender: string;
  message: string;
  timestamp: string;
  userName?: string;
  userNumber?: number;
}

// Интерфейс для параметров подключения
export interface JoinParams {
  room: string;
  userName?: string;
  hasMedia?: boolean;
}

// Интерфейс для параметров ретрансляции SDP
export interface RelaySDPParams {
  peerID: string;
  sessionDescription: RTCSessionDescriptionInit;
}

// Интерфейс для параметров ретрансляции ICE
export interface RelayICEParams {
  peerID: string;
  iceCandidate: RTCIceCandidateInit;
}

// Интерфейс для параметров создания producer
export interface CreateProducerParams {
  kind: 'audio' | 'video';
  rtpParameters: any;
}

// Интерфейс для параметров возобновления consumer
export interface ResumeConsumerParams {
  peerId: string;
  kind: 'audio' | 'video';
}

// Интерфейс для параметров уровня аудио
export interface AudioLevelParams {
  level: number;
}

// Интерфейс для параметров обновления имени
export interface UpdateUserNameParams {
  roomID: string;
  userName: string;
}

// Интерфейс для параметров комнаты
export interface RoomParams {
  roomID: string;
}

// Интерфейс для параметров сообщения чата от клиента
export interface ChatMessageClientParams {
  roomID: string;
  message: string;
  id: string;
  timestamp: string;
  userName?: string;
}

// ==================== События от сервера к клиенту ====================

export interface ServerToClientEvents {
  // Базовые WebRTC события
  [ACTIONS.ADD_PEER]: (params: PeerParams) => void;
  [ACTIONS.REMOVE_PEER]: (params: { peerID: string }) => void;
  [ACTIONS.CHAT_MESSAGE]: (params: ChatMessageParams) => void;
  [ACTIONS.CHAT_HISTORY]: (messages: ChatMessageParams[]) => void;
  [ACTIONS.RAISE_HAND]: (params: { peerID: string; userName: string }) => void;
  [ACTIONS.LOWER_HAND]: (params: { peerID: string; userName: string }) => void;
  
  // SFU транспортные события
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
  
  // События для уведомлений о подключении/отключении (КАСТОМНЫЕ)
  'participant-joined': (params: {
    peerID: string;
    userName: string;
    timestamp: string;
    participants?: ParticipantInfo[];
  }) => void;
  
  'participant-left': (params: {
    peerID: string;
    userName: string;
    timestamp: string;
    participants?: ParticipantInfo[];
  }) => void;
  
  // Событие обновления имени
  'user-name-updated': (params: { peerID: string; userName: string }) => void;
  
  // Событие списка участников
  'participants-list': (participants: ParticipantInfo[]) => void;
  
  // Событие ошибки
  'error': (params: { message: string }) => void;
}

// ==================== События от клиента к серверу ====================

export interface ClientToServerEvents {
  // Базовые WebRTC события
  [ACTIONS.JOIN]: (params: JoinParams) => void;
  [ACTIONS.CHAT_MESSAGE]: (params: ChatMessageClientParams) => void;
  [ACTIONS.REQUEST_CHAT_HISTORY]: (params: RoomParams) => void;
  [ACTIONS.LEAVE]: () => void;
  [ACTIONS.RAISE_HAND]: (params: RoomParams) => void;
  [ACTIONS.LOWER_HAND]: (params: RoomParams) => void;
  
  // SFU producer/consumer события
  'create-producer': (params: CreateProducerParams) => void;
  'resume-consumer': (params: ResumeConsumerParams) => void;
  
  // Аудио уровень для активного спикера
  'audio-level': (params: AudioLevelParams) => void;
  
  // Обновление имени пользователя
  'update-user-name': (params: UpdateUserNameParams) => void;
  
  // Запрос списка участников
  'get-participants': (params: RoomParams) => void;
}