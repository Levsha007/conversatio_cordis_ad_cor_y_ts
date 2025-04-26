/**
 * Константы действий (именованные события) для WebSocket соединения
 * Каждое действие соответствует определенному событию в системе видеоконференций
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
    REQUEST_CHAT_HISTORY: 'request-chat-history'
} as const;

// Экспорт по умолчанию для обратной совместимости
export default ACTIONS;

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
    room: string;       // ID комнаты
    userId?: string;    // Опциональный ID пользователя
};

// Действие передачи ICE кандидата
export type IceCandidateAction = {
    type: typeof ACTIONS.ICE_CANDIDATE;
    peerID: string;         // ID участника
    iceCandidate: RTCIceCandidate;  // Данные ICE кандидата
};

/**
 * Объединенный тип всех возможных действий
 * Можно расширять добавлением новых типов действий
 */
export type SocketAction = 
    | JoinAction
    | IceCandidateAction
    | { type: typeof ACTIONS.LEAVE }  // Действие выхода из комнаты
    // Другие действия добавляются по аналогии
    ;

/**
 * Тип для обработчиков действий
 * @template T - конкретный тип действия
 */
export type ActionHandler<T extends SocketAction> = (action: T) => void;