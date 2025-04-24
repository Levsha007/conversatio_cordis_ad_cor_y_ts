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
    REQUEST_CHAT_HISTORY: 'request-chat-history'
} as const; // Фиксируем типы

// Тип для всех возможных действий
export type ActionType = keyof typeof ACTIONS;