// src/socket/actions.ts

export const ACTIONS = {
  JOIN: 'join',
  LEAVE: 'leave',
  SHARE_ROOMS: 'share-rooms',
  GET_ROOMS: 'get-rooms',
  ADD_PEER: 'add-peer',
  REMOVE_PEER: 'remove-peer',
  RELAY_SDP: 'relay-sdp',
  RELAY_ICE: 'relay-ice',
  ICE_CANDIDATE: 'ice-candidate',
  SESSION_DESCRIPTION: 'session-description',
  CHAT_MESSAGE: 'chat-message',
  CHAT_HISTORY: 'chat-history',
  REQUEST_CHAT_HISTORY: 'request-chat-history',
  FILE_ATTACHED: 'file-attached',
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
  if (!name) return 'Participant';
  const sanitized = sanitizeInput(name);
  return sanitized || 'Participant';
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

interface ChatMessage {
  id: string;
  sender: string;
  message: string;
  timestamp: string;
  userNumber?: number;
  userName?: string;
}

interface FileAttachment {
  id: string;
  sender: string;
  fileName: string;
  timestamp: string;
}

interface ParticipantInfo {
  id: string;
  name: string;
  isOnline: boolean;
}

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

export interface ClientToServerEvents {
  [ACTIONS.JOIN]: (params: { 
    room: string;
    userName?: string;
    hasMedia?: boolean;
    tabId?: string;
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