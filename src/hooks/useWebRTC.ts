// Импорт необходимых хуков и зависимостей
import { useEffect, useRef, useCallback, useState } from 'react';
import useStateWithCallback from './useStateWithCallback';
import socket from '../socket';
import { ACTIONS } from '../socket/actions';

// Константа для идентификации локального видео
export const LOCAL_VIDEO = 'LOCAL_VIDEO';

// Интерфейсы для типизации данных
interface WebRTCStatus {
  isSupported: boolean;  // Поддерживается ли WebRTC
  errors: string[];      // Список ошибок, если не поддерживается
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
  isLocal: boolean;   // Отправлено ли текущим пользователем
  timestamp: string;  // Время отправки
  sender: string;     // ID отправителя
}

interface UseWebRTCReturn {
  clients: string[];  // Список ID подключенных клиентов
  provideMediaRef: (id: string, node: HTMLVideoElement | null) => void;
  mediaError: Error | null;  // Ошибка медиа
  isMediaReady: boolean;     // Готовность медиа
  webRTCStatus: WebRTCStatus; // Статус WebRTC
  mediaState: MediaState;     // Текущее состояние медиа
  toggleMedia: (type: 'audio' | 'video') => void;  // Переключение медиа
  switchMediaDevice: (type: 'audio' | 'video', deviceId?: string) => Promise<boolean>;
  availableDevices: AvailableDevices;  // Доступные устройства
  addChatMessage: (message: ChatMessage) => void;  // Добавление сообщения
  getChatMessages: () => ChatMessage[];  // Получение сообщений
  peerMediaElements: React.MutableRefObject<Record<string, HTMLVideoElement | null>>;
  reconnect: () => Promise<void>;  // Переподключение
}

// Функция проверки поддержки WebRTC в браузере
function checkWebRTCAvailability(): WebRTCStatus {
  const errors: string[] = [];
  
  // Проверяем наличие необходимых API
  if (!navigator.mediaDevices) errors.push('mediaDevices недоступен');
  if (!window.RTCPeerConnection) errors.push('RTCPeerConnection недоступен');

  return {
    isSupported: errors.length === 0,  // Поддерживается, если нет ошибок
    errors
  };
}

// Основной хук useWebRTC
export default function useWebRTC(roomID?: string): UseWebRTCReturn {
  // Состояния компонента
  const [clients, updateClients] = useStateWithCallback<string[]>([]);
  const [mediaError, setMediaError] = useState<Error | null>(null);
  const [isMediaReady, setIsMediaReady] = useState(false);
  const [webRTCStatus, setWebRTCStatus] = useState<WebRTCStatus>(checkWebRTCAvailability());
  const [mediaState, setMediaState] = useState<MediaState>({ audio: true, video: true });
  const [availableDevices, setAvailableDevices] = useState<AvailableDevices>({ audio: [], video: [] });

  // Рефы для хранения данных между рендерами
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
  const localMediaStream = useRef<MediaStream | null>(null);
  const peerMediaElements = useRef<Record<string, HTMLVideoElement | null>>({ [LOCAL_VIDEO]: null });
  const chatMessages = useRef<ChatMessage[]>([]);
  const iceServers = useRef<RTCIceServer[]>([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]);

  // Функция добавления нового клиента
  const addNewClient = useCallback((newClient: string, cb?: () => void) => {
    updateClients(list => {
      if (!list.includes(newClient)) return [...list, newClient];  // Добавляем, если еще нет
      return list;
    }, cb);
  }, [updateClients]);

  // Функция получения настроек медиапотока
  const getMediaConstraints = useCallback((): MediaStreamConstraints => ({
    audio: true,
    video: {
      width: { ideal: 1280 },  // Идеальная ширина
      height: { ideal: 720 },  // Идеальная высота
      frameRate: { ideal: 30 } // Идеальная частота кадров
    }
  }), []);

  // Функция перечисления доступных устройств
  const enumerateDevices = useCallback(async (): Promise<void> => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAvailableDevices({
        audio: devices.filter(d => d.kind === 'audioinput'),  // Фильтруем аудио устройства
        video: devices.filter(d => d.kind === 'videoinput')   // Фильтруем видео устройства
      });
    } catch (err) {
      console.error('Ошибка получения устройств:', err);
    }
  }, []);

  // Функция запуска медиапотока
  const startMediaStream = useCallback(async (): Promise<MediaStream | null> => {
    setMediaError(null);
    setIsMediaReady(false);

    try {
      const { isSupported, errors } = checkWebRTCAvailability();
      if (!isSupported) throw new Error(`WebRTC не поддерживается: ${errors.join(', ')}`);

      // Останавливаем предыдущий поток, если есть
      if (localMediaStream.current) {
        localMediaStream.current.getTracks().forEach(track => track.stop());
        localMediaStream.current = null;
      }

      // Получаем новый медиапоток с настройками
      const stream = await navigator.mediaDevices.getUserMedia(getMediaConstraints());
      console.log('Получены треки:', stream.getTracks());  // Логирование треков
      
      await enumerateDevices();  // Обновляем список устройств
      setIsMediaReady(true);
      return stream;
    } catch (err) {
      console.error('Ошибка медиапотока:', err);
      setMediaError(err as Error);
      return null;
    }
  }, [getMediaConstraints, enumerateDevices]);

  // Функция переподключения
  const reconnect = useCallback(async () => {
    try {
      // Закрываем все соединения
      Object.values(peerConnections.current).forEach(pc => pc.close());
      peerConnections.current = {};
      
      // Останавливаем текущий поток
      if (localMediaStream.current) {
        localMediaStream.current.getTracks().forEach(track => track.stop());
        localMediaStream.current = null;
      }

      // Сбрасываем список клиентов
      updateClients([], () => {});

      // Запускаем новый поток
      const stream = await startMediaStream();
      if (!stream) return;

      localMediaStream.current = stream;
      // Добавляем локальное видео
      addNewClient(LOCAL_VIDEO, () => {
        const localVideo = peerMediaElements.current[LOCAL_VIDEO];
        if (localVideo) {
          localVideo.srcObject = stream;
          localVideo.volume = 0;  // Отключаем звук у локального видео
        }
      });

      // Присоединяемся к комнате, если указан roomID
      if (roomID) socket.emit(ACTIONS.JOIN, { room: roomID });
    } catch (err) {
      console.error('Ошибка переподключения:', err);
      setMediaError(err as Error);
    }
  }, [roomID, startMediaStream, addNewClient, updateClients]);

  // Функция переключения состояния медиа (вкл/выкл)
  const toggleMedia = useCallback((type: 'audio' | 'video') => {
    setMediaState(prev => {
      const newState = { ...prev, [type]: !prev[type] };
      // Применяем изменения к трекам
      if (localMediaStream.current) {
        localMediaStream.current.getTracks()
          .filter(track => track.kind === type)
          .forEach(track => {
            track.enabled = newState[type];  // Включаем/выключаем трек
          });
      }
      return newState;
    });
  }, []);

  // Функция переключения медиаустройства
  const switchMediaDevice = useCallback(async (
    type: 'audio' | 'video',
    deviceId?: string
  ): Promise<boolean> => {
    try {
      // Удаляем старые треки
      const oldTracks = localMediaStream.current?.getTracks()
        .filter(track => track.kind === type) || [];
      
      oldTracks.forEach(track => {
        track.stop();
        localMediaStream.current?.removeTrack(track);
      });

      // Настраиваем ограничения для нового устройства
      const constraints: MediaStreamConstraints = {
        [type]: deviceId ? { deviceId: { exact: deviceId } } : true
      };

      // Получаем новый поток с выбранным устройством
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const newTracks = stream.getTracks();
    
      if (!localMediaStream.current) {
        localMediaStream.current = new MediaStream();
      }
      
      // Добавляем новые треки
      newTracks.forEach(track => {
        localMediaStream.current?.addTrack(track);
        track.enabled = mediaState[type];  // Сохраняем предыдущее состояние
      });

      // Обновляем треки во всех соединениях
      Object.values(peerConnections.current).forEach(pc => {
        const senders = pc.getSenders();
        senders.forEach(sender => {
          if (sender.track?.kind === type) {
            const newTrack = newTracks.find(t => t.kind === type);
            if (newTrack) sender.replaceTrack(newTrack);
          }
        });
      });

      // Обновляем локальное видео
      const localVideo = peerMediaElements.current[LOCAL_VIDEO];
      if (localVideo) {
        localVideo.srcObject = new MediaStream(
          localMediaStream.current?.getTracks() || []
        );
      }

      await enumerateDevices();  // Обновляем список устройств
      return true;
    } catch (err) {
      console.error(`Ошибка переключения устройства ${type}:`, err);
      return false;
    }
  }, [enumerateDevices, mediaState]);

  // Функция установки соединения с пиром
  const setupPeerConnection = useCallback(async (
    peerID: string, 
    createOffer: boolean
  ) => {
    if (peerID in peerConnections.current) return;

    // Создаем новое соединение
    const pc = new RTCPeerConnection({ iceServers: iceServers.current });
    peerConnections.current[peerID] = pc;

    // Добавляем локальные треки ДО создания оффера
    if (localMediaStream.current) {
      localMediaStream.current.getTracks().forEach(track => {
        pc.addTrack(track, localMediaStream.current!);
      });
    }

    // Обработчик ICE кандидатов
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit(ACTIONS.RELAY_ICE, {
          peerID,
          iceCandidate: event.candidate,
        });
      }
    };

    // Обработчик получения удаленного потока
    pc.ontrack = ({ streams: [remoteStream] }) => {
      if (!remoteStream) return;
      addNewClient(peerID, () => {
        const element = peerMediaElements.current[peerID];
        if (element) element.srcObject = remoteStream;
      });
    };

    // Создаем оффер, если требуется
    if (createOffer) {
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        });
        await pc.setLocalDescription(offer);
        socket.emit(ACTIONS.RELAY_SDP, {
          peerID,
          sessionDescription: offer,
        });
      } catch (err) {
        console.error('Ошибка создания оффера:', err);
      }
    }
  }, [addNewClient]);

  // Функции для работы с чатом
  const addChatMessage = useCallback((message: ChatMessage) => {
    chatMessages.current = [...chatMessages.current, message];
  }, []);

  const getChatMessages = useCallback(() => {
    return chatMessages.current;
  }, []);

  // Функция привязки видео элементов
  const provideMediaRef = useCallback((
    id: string, 
    node: HTMLVideoElement | null
  ) => {
    if (node) {
      node.autoplay = true;      // Автовоспроизведение
      node.playsInline = true;   // Встроенное воспроизведение
      node.muted = id === LOCAL_VIDEO;  // Без звука для локального видео
      peerMediaElements.current[id] = node;
    }
  }, []);

  // Эффект инициализации
  useEffect(() => {
    let isMounted = true;
    let stream: MediaStream | null = null;

    const init = async () => {
      try {
        stream = await startMediaStream();
        if (!isMounted || !stream) return;

        localMediaStream.current = stream;
        // Настраиваем локальное видео
        addNewClient(LOCAL_VIDEO, () => {
          const localVideo = peerMediaElements.current[LOCAL_VIDEO];
          if (localVideo) {
            localVideo.srcObject = stream;
            localVideo.volume = 0;  // Отключаем звук у локального видео
          }
        });

        // Присоединяемся к комнате, если указан roomID
        if (roomID) socket.emit(ACTIONS.JOIN, { room: roomID });
      } catch (err) {
        console.error('Ошибка инициализации:', err);
        setMediaError(err as Error);
      }
    };

    init();

    // Функция очистки при размонтировании
    return () => {
      isMounted = false;
      // Закрываем все соединения
      Object.values(peerConnections.current).forEach(pc => pc.close());
      // Останавливаем все треки
      if (stream) stream.getTracks().forEach(track => track.stop());
      if (localMediaStream.current) {
        localMediaStream.current.getTracks().forEach(track => track.stop());
      }
      // Покидаем комнату
      socket.emit(ACTIONS.LEAVE);
    };
  }, [roomID, startMediaStream, addNewClient]);

  // Эффект для обработки socket-событий
  useEffect(() => {
    // Обработчик добавления нового пира
    const handleAddPeer = ({ peerID, createOffer }: { 
      peerID: string; 
      createOffer: boolean 
    }) => {
      setupPeerConnection(peerID, createOffer);
    };
    
    // Обработчик SDP (Session Description Protocol)
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
        await pc.setRemoteDescription(new RTCSessionDescription(sessionDescription));
        if (sessionDescription.type === 'offer') {
          // Создаем ответ, если получен оффер
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit(ACTIONS.RELAY_SDP, {
            peerID,
            sessionDescription: answer,
          });
        }
      } catch (err) {
        console.error('Ошибка setRemoteDescription:', err);
      }
    };
    
    // Обработчик ICE кандидатов
    const handleIceCandidate = ({ 
      peerID, 
      iceCandidate 
    }: { 
      peerID: string; 
      iceCandidate: RTCIceCandidateInit 
    }) => {
      const pc = peerConnections.current[peerID];
      if (pc) pc.addIceCandidate(new RTCIceCandidate(iceCandidate));
    };
    
    // Обработчик удаления пира
    const handleRemovePeer = ({ peerID }: { peerID: string }) => {
      const pc = peerConnections.current[peerID];
      if (pc) {
        pc.close();
        delete peerConnections.current[peerID];
        delete peerMediaElements.current[peerID];
        updateClients(list => list.filter(c => c !== peerID));
      }
    };

    // Обработчик сообщений чата
    const handleChatMessage = (msg: {
      id: string;
      message: string;
      sender: string;
      timestamp: string;
    }) => {
      addChatMessage({
        ...msg,
        isLocal: msg.sender === socket.id,  // Помечаем локальные сообщения
        timestamp: new Date(msg.timestamp).toLocaleTimeString(),
        text: ''
      });
    };

    // Регистрируем обработчики событий
    const handlers = {
      [ACTIONS.ADD_PEER]: handleAddPeer,
      [ACTIONS.SESSION_DESCRIPTION]: handleSessionDescription,
      [ACTIONS.ICE_CANDIDATE]: handleIceCandidate,
      [ACTIONS.REMOVE_PEER]: handleRemovePeer,
      [ACTIONS.CHAT_MESSAGE]: handleChatMessage
    };

    Object.entries(handlers).forEach(([action, handler]) => {
      socket.on(action as any, handler);
    });

    // Отписываемся от событий при размонтировании
    return () => {
      Object.entries(handlers).forEach(([action, handler]) => {
        socket.off(action as any, handler);
      });
    };
  }, [setupPeerConnection, updateClients, addChatMessage]);

  // Возвращаем объект с функциями и состояниями
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