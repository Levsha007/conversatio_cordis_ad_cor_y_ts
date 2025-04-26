import { useEffect, useRef, useCallback, useState } from 'react';
import useStateWithCallback from './useStateWithCallback';
import socket from '../socket';
import { ACTIONS } from '../socket/actions';

// Константа для идентификации локального видео потока
export const LOCAL_VIDEO = 'LOCAL_VIDEO';

// Интерфейсы для типизации возвращаемых значений и состояний
interface WebRTCStatus {
    isSupported: boolean;  // Флаг поддержки WebRTC
    errors: string[];      // Список ошибок (если не поддерживается)
}

interface MediaState {
    audio: boolean;  // Состояние аудио (вкл/выкл)
    video: boolean;  // Состояние видео (вкл/выкл)
}

interface AvailableDevices {
    audio: MediaDeviceInfo[];  // Доступные аудио устройства
    video: MediaDeviceInfo[];  // Доступные видео устройства
}

interface ChatMessage {
    id: string;         // Уникальный ID сообщения
    text: string;       // Текст сообщения
    isLocal: boolean;   // Флаг локального сообщения
    timestamp: string;  // Временная метка
    sender: string;     // ID отправителя
}

// Интерфейс возвращаемых хуком значений
interface UseWebRTCReturn {
    clients: string[];  // Список ID подключенных клиентов
    provideMediaRef: (id: string, node: HTMLVideoElement | null) => void;
    mediaError: Error | null;      // Ошибка медиа потока
    isMediaReady: boolean;         // Флаг готовности медиа
    webRTCStatus: WebRTCStatus;    // Статус WebRTC
    mediaState: MediaState;        // Текущее состояние медиа
    toggleMedia: (type: 'audio' | 'video') => void;  // Переключение медиа
    switchMediaDevice: (type: 'audio' | 'video', deviceId?: string) => Promise<boolean>;
    availableDevices: AvailableDevices;  // Доступные устройства
    addChatMessage: (message: ChatMessage) => void;  // Добавление сообщения
    getChatMessages: () => ChatMessage[];  // Получение сообщений
    peerMediaElements: React.MutableRefObject<Record<string, HTMLVideoElement | null>>;
    reconnect: () => Promise<void>;  // Переподключение
}

// Проверка доступности WebRTC в браузере
function checkWebRTCAvailability(): WebRTCStatus {
    const errors: string[] = [];
    
    if (!navigator) {
        errors.push('WebRTC не поддерживается: navigator недоступен');
        return { isSupported: false, errors };
    }

    if (!navigator.mediaDevices) {
        errors.push('WebRTC не поддерживается: mediaDevices недоступен');
    }

    if (!window.RTCPeerConnection) {
        errors.push('WebRTC не поддерживается: RTCPeerConnection недоступен');
    }

    return {
        isSupported: errors.length === 0,
        errors
    };
}

// Основной хук для работы с WebRTC
export default function useWebRTC(roomID?: string): UseWebRTCReturn {
    // Состояния хука
    const [clients, updateClients] = useStateWithCallback<string[]>([]);
    const [mediaError, setMediaError] = useState<Error | null>(null);
    const [isMediaReady, setIsMediaReady] = useState(false);
    const [webRTCStatus, setWebRTCStatus] = useState<WebRTCStatus>({
        isSupported: true,
        errors: []
    });
    const [mediaState, setMediaState] = useState<MediaState>({
        audio: true,
        video: true
    });
    const [availableDevices, setAvailableDevices] = useState<AvailableDevices>({
        audio: [],
        video: []
    });
    
    // Рефы для хранения мутируемых значений между рендерами
    const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
    const localMediaStream = useRef<MediaStream | null>(null);
    const peerMediaElements = useRef<Record<string, HTMLVideoElement | null>>({
        [LOCAL_VIDEO]: null,
    });
    const chatMessages = useRef<ChatMessage[]>([]);

    // STUN сервера для установки P2P соединений
    const iceServers = useRef<RTCIceServer[]>([
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]);

    // Добавление нового клиента в список
    const addNewClient = useCallback((newClient: string, cb?: () => void) => {
        updateClients(list => {
            if (!list.includes(newClient)) {
                return [...list, newClient];
            }
            return list;
        }, cb);
    }, [updateClients]);

    // Получение ограничений для медиа потока
    const getMediaConstraints = useCallback((): MediaStreamConstraints => {
        return {
            audio: true,
            video: {
                width: { ideal: 1280 },  // Идеальная ширина
                height: { ideal: 720 },   // Идеальная высота
                frameRate: { ideal: 30 }  // Идеальная частота кадров
            }
        };
    }, []);

    // Получение списка доступных устройств
    const enumerateDevices = useCallback(async (): Promise<void> => {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            setAvailableDevices({
                audio: devices.filter(d => d.kind === 'audioinput'),
                video: devices.filter(d => d.kind === 'videoinput')
            });
        } catch (err) {
            console.error('Error enumerating devices:', err);
        }
    }, []);

    // Запуск медиа потока (аудио/видео)
    const startMediaStream = useCallback(async (): Promise<MediaStream | null> => {
        setMediaError(null);
        setIsMediaReady(false);

        try {
            const { isSupported, errors } = checkWebRTCAvailability();
            if (!isSupported) {
                throw new Error(`WebRTC не поддерживается: ${errors.join(', ')}`);
            }

            // Остановка предыдущего потока, если есть
            if (localMediaStream.current) {
                localMediaStream.current.getTracks().forEach(track => track.stop());
                localMediaStream.current = null;
            }

            // Запрос доступа к медиа устройствам
            const stream = await navigator.mediaDevices.getUserMedia(
                getMediaConstraints()
            );
            
            await enumerateDevices();
            setIsMediaReady(true);
            return stream;
        } catch (err) {
            console.error('Media stream error:', err);
            setMediaError(err as Error);
            return null;
        }
    }, [getMediaConstraints, enumerateDevices]);

    // Переподключение с полной переинициализацией
    const reconnect = useCallback(async () => {
        try {
            // Закрытие всех существующих соединений
            Object.values(peerConnections.current).forEach(pc => pc.close());
            peerConnections.current = {};
            
            // Остановка текущего медиа потока
            if (localMediaStream.current) {
                localMediaStream.current.getTracks().forEach(track => track.stop());
                localMediaStream.current = null;
            }

            // Сброс списка клиентов
            updateClients([], () => {});

            // Запуск нового медиа потока
            const stream = await startMediaStream();
            if (!stream) return;

            localMediaStream.current = stream;
            // Добавление локального видео
            addNewClient(LOCAL_VIDEO, () => {
                const localVideo = peerMediaElements.current[LOCAL_VIDEO];
                if (localVideo) {
                    localVideo.srcObject = stream;
                    localVideo.volume = 0;
                }
            });

            // Повторное подключение к комнате
            if (roomID) {
                socket.emit(ACTIONS.JOIN, { room: roomID });
            }
        } catch (err) {
            console.error('Reconnection error:', err);
            setMediaError(err as Error);
        }
    }, [roomID, startMediaStream, addNewClient, updateClients]);

    // Переключение состояния медиа (аудио/видео)
    const toggleMedia = useCallback((type: 'audio' | 'video') => {
        setMediaState(prev => {
            const newState = {...prev, [type]: !prev[type]};
            
            // Включение/выключение соответствующих треков
            if (localMediaStream.current) {
                localMediaStream.current.getTracks()
                    .filter(track => track.kind === type)
                    .forEach(track => {
                        track.enabled = newState[type];
                    });
            }
            
            return newState;
        });
    }, []);

    // Переключение медиа устройства
    const switchMediaDevice = useCallback(async (
        type: 'audio' | 'video', 
        deviceId?: string
    ): Promise<boolean> => {
        try {
            // Получение нового медиа потока с выбранным устройством
            const stream = await navigator.mediaDevices.getUserMedia({
                [type]: deviceId ? { deviceId: { exact: deviceId } } : true
            });
            
            const tracks = stream.getTracks().filter(track => track.kind === type);
            const oldTracks = localMediaStream.current?.getTracks()
                .filter(track => track.kind === type);
            
            // Остановка старых треков
            if (oldTracks) {
                oldTracks.forEach(track => track.stop());
            }
            
            // Добавление новых треков
            if (localMediaStream.current) {
                tracks.forEach(track => localMediaStream.current!.addTrack(track));
            } else {
                localMediaStream.current = new MediaStream(tracks);
            }
            
            // Обновление треков во всех peer соединениях
            Object.values(peerConnections.current).forEach(pc => {
                const senders = pc.getSenders();
                const sender = senders.find(s => s.track?.kind === type);
                if (sender && tracks[0]) {
                    sender.replaceTrack(tracks[0]);
                }
            });
            
            // Обновление локального видео элемента
            if (type === 'video') {
                const localVideo = peerMediaElements.current[LOCAL_VIDEO];
                if (localVideo) {
                    localVideo.srcObject = new MediaStream([
                        ...localMediaStream.current.getTracks()
                    ]);
                }
            }
            
            return true;
        } catch (err) {
            console.error(`Failed to switch ${type} device:`, err);
            return false;
        }
    }, []);

    // Установка peer-to-peer соединения
    const setupPeerConnection = useCallback(async (
        peerID: string, 
        createOffer: boolean  // Нужно ли создавать оффер
    ) => {
        if (peerID in peerConnections.current) {
            return;
        }

        // Создание нового RTCPeerConnection
        const pc = new RTCPeerConnection({
            iceServers: iceServers.current
        });

        peerConnections.current[peerID] = pc;

        // Обработка ICE кандидатов
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                // Отправка кандидата через сокет
                socket.emit(ACTIONS.RELAY_ICE, {
                    peerID,
                    iceCandidate: event.candidate,
                });
            }
        };

        // Логирование состояния ICE соединения
        pc.oniceconnectionstatechange = () => {
            console.log(`ICE state for ${peerID}:`, pc.iceConnectionState);
        };

        // Получение удаленного медиа потока
        pc.ontrack = ({ streams: [remoteStream] }) => {
            if (!remoteStream) return;
            
            // Добавление клиента и обновление видео элемента
            addNewClient(peerID, () => {
                const element = peerMediaElements.current[peerID];
                if (element) {
                    element.srcObject = remoteStream;
                }
            });
        };

        // Добавление локальных треков в соединение
        if (localMediaStream.current) {
            localMediaStream.current.getTracks().forEach(track => {
                pc.addTrack(track, localMediaStream.current!);
            });
        }

        // Создание оффера, если требуется
        if (createOffer) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit(ACTIONS.RELAY_SDP, {
                peerID,
                sessionDescription: offer,
            });
        }
    }, [addNewClient]);

    // Добавление сообщения в чат
    const addChatMessage = useCallback((message: ChatMessage) => {
        chatMessages.current = [...chatMessages.current, message];
    }, []);

    // Получение всех сообщений чата
    const getChatMessages = useCallback((): ChatMessage[] => {
        return chatMessages.current;
    }, []);

    // Эффект инициализации при монтировании
    useEffect(() => {
        const { isSupported, errors } = checkWebRTCAvailability();
        setWebRTCStatus({ isSupported, errors });

        if (!isSupported) {
            setMediaError(new Error(`WebRTC не поддерживается: ${errors.join(', ')}`));
            return;
        }

        let isMounted = true;
        let stream: MediaStream | null = null;

        async function init() {
            try {
                stream = await startMediaStream();
                if (!isMounted || !stream) return;

                localMediaStream.current = stream;
                // Добавление локального видео
                addNewClient(LOCAL_VIDEO, () => {
                    const localVideo = peerMediaElements.current[LOCAL_VIDEO];
                    if (localVideo) {
                        localVideo.srcObject = stream;
                        localVideo.volume = 0;
                    }
                });

                // Подключение к комнате
                if (roomID) {
                    socket.emit(ACTIONS.JOIN, { room: roomID });
                }
            } catch (err) {
                console.error('Initialization error:', err);
                setMediaError(err as Error);
            }
        }

        init();

        // Очистка при размонтировании
        return () => {
            isMounted = false;
            // Закрытие всех соединений
            Object.values(peerConnections.current).forEach(pc => pc.close());
            peerConnections.current = {};

            // Остановка медиа потоков
            if (stream) stream.getTracks().forEach(track => track.stop());
            if (localMediaStream.current) {
                localMediaStream.current.getTracks().forEach(track => track.stop());
                localMediaStream.current = null;
            }
            
            // Отправка события выхода
            socket.emit(ACTIONS.LEAVE);
        };
    }, [roomID, startMediaStream, addNewClient]);

    // Эффект для обработки socket событий
    useEffect(() => {
        // Обработчики socket событий
        const handleAddPeer = ({ peerID, createOffer }: { 
            peerID: string; 
            createOffer: boolean 
        }) => {
            setupPeerConnection(peerID, createOffer);
        };
        
        const handleSessionDescription = async ({ 
            peerID, 
            sessionDescription 
        }: { 
            peerID: string; 
            sessionDescription: RTCSessionDescriptionInit 
        }) => {
            const pc = peerConnections.current[peerID];
            if (!pc) return;

            try {
                await pc.setRemoteDescription(
                    new RTCSessionDescription(sessionDescription)
                );
                if (sessionDescription.type === 'offer') {
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    socket.emit(ACTIONS.RELAY_SDP, {
                        peerID,
                        sessionDescription: answer,
                    });
                }
            } catch (err) {
                console.error('setRemoteDescription error:', err);
            }
        };
        
        const handleIceCandidate = ({ 
            peerID, 
            iceCandidate 
        }: { 
            peerID: string; 
            iceCandidate: RTCIceCandidateInit 
        }) => {
            const pc = peerConnections.current[peerID];
            if (pc) {
                pc.addIceCandidate(new RTCIceCandidate(iceCandidate))
                    .catch(err => console.error('addIceCandidate error:', err));
            }
        };
        
        const handleRemovePeer = ({ peerID }: { peerID: string }) => {
            const pc = peerConnections.current[peerID];
            if (pc) {
                pc.close();
                delete peerConnections.current[peerID];
                delete peerMediaElements.current[peerID];
                updateClients(list => list.filter(c => c !== peerID));
            }
        };

        const handleChatHistory = (messages: ChatMessage[]) => {
            chatMessages.current = messages;
        };

        const handleChatMessage = (msg: {
            id: string;
            message: string;
            sender: string;
            timestamp: string;
        }) => {
            addChatMessage({
                id: msg.id,
                text: msg.message,
                isLocal: msg.sender === socket.id,
                timestamp: new Date(msg.timestamp).toLocaleTimeString(),
                sender: msg.sender
            });
        };

        // Регистрация обработчиков
        const handlers: Record<string, (...args: any[]) => void> = {
            [ACTIONS.ADD_PEER]: handleAddPeer,
            [ACTIONS.SESSION_DESCRIPTION]: handleSessionDescription,
            [ACTIONS.ICE_CANDIDATE]: handleIceCandidate,
            [ACTIONS.REMOVE_PEER]: handleRemovePeer,
            [ACTIONS.CHAT_HISTORY]: handleChatHistory,
            [ACTIONS.CHAT_MESSAGE]: handleChatMessage
        };

        (Object.entries(handlers) as [keyof typeof ACTIONS, (...args: any[]) => void][]).forEach(
            ([action, handler]) => {
                socket.on(action as any, handler);
            }
        );

        // Отписка от событий при размонтировании
        return () => {
            (Object.entries(handlers) as [keyof typeof ACTIONS, (...args: any[]) => void][]).forEach(
                ([action, handler]) => {
                    socket.off(action as any, handler);
                }
            );
        };
    }, [setupPeerConnection, updateClients, addChatMessage]);

    // Функция для привязки видео элементов
    const provideMediaRef = useCallback((
        id: string, 
        node: HTMLVideoElement | null
    ) => {
        if (node) {
            node.autoplay = true;
            node.playsInline = true;
            node.muted = id === LOCAL_VIDEO;  // Отключаем звук для локального видео
            peerMediaElements.current[id] = node;
        }
    }, []);

    // Возвращаемые хуком значения
    return {
        clients,
        provideMediaRef,
        mediaError,
        isMediaReady,
        webRTCStatus,
        mediaState,
        toggleMedia,
        switchMediaDevice,
        availableDevices,
        addChatMessage,
        getChatMessages,
        peerMediaElements,
        reconnect
    };
}