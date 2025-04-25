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
} as const;

// Добавляем default export для совместимости
export default ACTIONS;

// Типы (остаются как были)
export type ActionKeys = keyof typeof ACTIONS;

// Тип всех возможных значений действий
export type ActionValues = typeof ACTIONS[ActionKeys];

// Типы для конкретных событий (пример)
export type JoinAction = {
    type: typeof ACTIONS.JOIN;
    room: string;
    userId?: string;
};

export type IceCandidateAction = {
    type: typeof ACTIONS.ICE_CANDIDATE;
    peerID: string;
    iceCandidate: RTCIceCandidate;
};

// Общий тип для всех событий
export type SocketAction = 
    | JoinAction
    | IceCandidateAction
    | { type: typeof ACTIONS.LEAVE }
    // Добавьте остальные действия по аналогии
    ;

// Вспомогательный тип для обработчиков
export type ActionHandler<T extends SocketAction> = (action: T) => void;