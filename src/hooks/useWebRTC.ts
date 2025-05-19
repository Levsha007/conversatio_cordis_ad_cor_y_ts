// Импорт необходимых хуков и зависимостей
import { useEffect, useRef, useCallback, useState } from 'react';
import useStateWithCallback from './useStateWithCallback';
import socket from '../socket';
import { ACTIONS } from '../socket/actions';

// Константа для идентификации локального видео
export const LOCAL_VIDEO = 'LOCAL_VIDEO';

// Интерфейсы для типизации данных
interface WebRTCStatus {
  isSupported: boolean; // Поддерживается ли WebRTC
  errors: string[]; // Список ошибок, если не поддерживается
}

interface MediaState {
  audio: boolean; // Состояние аудио (вкл/выкл)
  video: boolean; // Состояние видео (вкл/выкл)
}

interface AvailableDevices {
  audio: MediaDeviceInfo[]; // Доступные аудио устройства
  video: MediaDeviceInfo[]; // Доступные видео устройства
}

interface ChatMessage {
  id: string; // Уникальный ID сообщения
  text: string; // Текст сообщения
  isLocal: boolean; // Отправлено ли текущим пользователем
  timestamp: string; // Время отправки
  sender: string; // ID отправителя
}

interface FileAttachmentMessage {
  id: string;
  fileName: string;
  isLocal: boolean;
  timestamp: string;
  sender: string;
}

type ChatItem = ChatMessage | FileAttachmentMessage;

interface UseWebRTCReturn {
  clients: string[]; // Список ID подключенных клиентов
  provideMediaRef: (id: string, node: HTMLVideoElement | null) => void;
  mediaError: Error | null; // Ошибка медиа
  isMediaReady: boolean; // Готовность медиа
  webRTCStatus: WebRTCStatus; // Статус WebRTC
  mediaState: MediaState; // Текущее состояние медиа
  toggleMedia: (type: 'audio' | 'video') => void; // Переключение медиа
  switchMediaDevice: (type: 'audio' | 'video', deviceId?: string) => Promise<boolean>;
  availableDevices: AvailableDevices; // Доступные устройства
  addChatMessage: (message: ChatMessage) => void; // Добавление текстового сообщения
  addFileAttachment: (file: FileAttachmentMessage) => void; // Добавление сообщения о файле
  getChatMessages: () => ChatItem[]; // Получение всех сообщений
  peerMediaElements: React.MutableRefObject<Record<string, HTMLVideoElement | null>>;
  reconnect: () => Promise<void>; // Переподключение
}

// Функция проверки поддержки WebRTC в браузере
function checkWebRTCAvailability(): WebRTCStatus {
  const errors: string[] = [];
  if (!navigator.mediaDevices) errors.push('mediaDevices недоступен');
  if (!window.RTCPeerConnection) errors.push('RTCPeerConnection недоступен');
  return {
    isSupported: errors.length === 0,
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
  const [availableDevices, setAvailableDevices] = useState<AvailableDevices>({
    audio: [],
    video: []
  });

  // Рефы для хранения данных между рендерами
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
  const localMediaStream = useRef<MediaStream | null>(null);
  const peerMediaElements = useRef<Record<string, HTMLVideoElement | null>>({
    [LOCAL_VIDEO]: null
  });

  const iceServers = useRef<RTCIceServer[]>([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]);

  const chatMessages = useRef<ChatItem[]>([]); // Поддерживаем и сообщения, и файлы

  // Функция добавления нового клиента
  const addNewClient = useCallback((newClient: string, cb?: () => void) => {
    updateClients(list => {
      if (!list.includes(newClient)) return [...list, newClient];
      return list;
    }, cb);
  }, [updateClients]);

  // Функция получения настроек медиапотока
  const getMediaConstraints = useCallback((): MediaStreamConstraints => ({
    audio: true,
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 }
    }
  }), []);

  // Функция перечисления доступных устройств
  const enumerateDevices = useCallback(async (): Promise<void> => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAvailableDevices({
        audio: devices.filter(d => d.kind === 'audioinput'),
        video: devices.filter(d => d.kind === 'videoinput')
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

      if (localMediaStream.current) {
        localMediaStream.current.getTracks().forEach(track => track.stop());
        localMediaStream.current = null;
      }

      const stream = await navigator.mediaDevices.getUserMedia(getMediaConstraints());
      await enumerateDevices();
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
      Object.values(peerConnections.current).forEach(pc => pc.close());
      peerConnections.current = {};
      if (localMediaStream.current) {
        localMediaStream.current.getTracks().forEach(track => track.stop());
        localMediaStream.current = null;
      }
      updateClients([], () => {});
      const stream = await startMediaStream();
      if (!stream) return;
      localMediaStream.current = stream;
      addNewClient(LOCAL_VIDEO, () => {
        const localVideo = peerMediaElements.current[LOCAL_VIDEO];
        if (localVideo) {
          localVideo.srcObject = stream;
          localVideo.volume = 0;
        }
      });
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

  // Функция переключения медиаустройства
  const switchMediaDevice = useCallback(
    async (type: 'audio' | 'video', deviceId?: string): Promise<boolean> => {
      try {
        const oldTracks = localMediaStream.current?.getTracks().filter(track => track.kind === type) || [];
        oldTracks.forEach(track => {
          track.stop();
          localMediaStream.current?.removeTrack(track);
        });

        const constraints: MediaStreamConstraints = {
          [type]: deviceId ? { deviceId: { exact: deviceId } } : true
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const newTracks = stream.getTracks();

        if (!localMediaStream.current) {
          localMediaStream.current = new MediaStream();
        }

        newTracks.forEach(track => {
          localMediaStream.current?.addTrack(track);
          track.enabled = mediaState[type];
        });

        Object.values(peerConnections.current).forEach(pc => {
          const senders = pc.getSenders();
          senders.forEach(sender => {
            if (sender.track?.kind === type) {
              const newTrack = newTracks.find(t => t.kind === type);
              if (newTrack) sender.replaceTrack(newTrack);
            }
          });
        });

        const localVideo = peerMediaElements.current[LOCAL_VIDEO];
        if (localVideo) {
          localVideo.srcObject = new MediaStream(localMediaStream.current?.getTracks() || []);
        }

        await enumerateDevices();
        return true;
      } catch (err) {
        console.error(`Ошибка переключения устройства ${type}:`, err);
        return false;
      }
    },
    [enumerateDevices, mediaState]
  );

  // Функция установки соединения с пиром
  const setupPeerConnection = useCallback(
    async (peerID: string, createOffer: boolean) => {
      if (peerConnections.current[peerID]) return;
      const pc = new RTCPeerConnection({ iceServers: iceServers.current });
      peerConnections.current[peerID] = pc;

      if (localMediaStream.current) {
        localMediaStream.current.getTracks().forEach(track => {
          pc.addTrack(track, localMediaStream.current!);
        });
      }

      pc.onicecandidate = event => {
        if (event.candidate) {
          socket.emit(ACTIONS.RELAY_ICE, {
            peerID,
            iceCandidate: event.candidate
          });
        }
      };

      pc.ontrack = ({ streams: [remoteStream] }) => {
        if (!remoteStream) return;
        addNewClient(peerID, () => {
          const element = peerMediaElements.current[peerID];
          if (element) element.srcObject = remoteStream;
        });
      };

      if (createOffer) {
        try {
          const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
          });
          await pc.setLocalDescription(offer);
          socket.emit(ACTIONS.RELAY_SDP, {
            peerID,
            sessionDescription: offer
          });
        } catch (err) {
          console.error('Ошибка создания оффера:', err);
        }
      }
    },
    [addNewClient]
  );

  // Функции для работы с чатом
  const addChatMessage = useCallback((message: ChatMessage) => {
    chatMessages.current = [...chatMessages.current, message];
  }, []);

  const addFileAttachment = useCallback((file: FileAttachmentMessage) => {
    chatMessages.current = [...chatMessages.current, file];
  }, []);

  const getChatMessages = useCallback(() => {
    return chatMessages.current;
  }, []);

  // Функция привязки видео элементов
  const provideMediaRef = useCallback(
    (id: string, node: HTMLVideoElement | null) => {
      if (node) {
        node.autoplay = true;
        node.playsInline = true;
        node.muted = id === LOCAL_VIDEO;
        peerMediaElements.current[id] = node;
      }
    },
    []
  );

  // Эффект инициализации
  useEffect(() => {
    let isMounted = true;
    let stream: MediaStream | null = null;

    const init = async () => {
      try {
        stream = await startMediaStream();
        if (!isMounted || !stream) return;
        localMediaStream.current = stream;

        addNewClient(LOCAL_VIDEO, () => {
          const localVideo = peerMediaElements.current[LOCAL_VIDEO];
          if (localVideo) {
            localVideo.srcObject = stream;
            localVideo.volume = 0;
          }
        });

        if (roomID) socket.emit(ACTIONS.JOIN, { room: roomID });
      } catch (err) {
        console.error('Ошибка инициализации:', err);
        setMediaError(err as Error);
      }
    };

    init();

    return () => {
      isMounted = false;
      Object.values(peerConnections.current).forEach(pc => pc.close());
      if (stream) stream.getTracks().forEach(track => track.stop());
      if (localMediaStream.current) {
        localMediaStream.current.getTracks().forEach(track => track.stop());
      }
      socket.emit(ACTIONS.LEAVE);
    };
  }, [roomID, startMediaStream, addNewClient]);

  // Эффект для обработки socket-событий
  useEffect(() => {
    const handleAddPeer = ({ peerID, createOffer }: { peerID: string; createOffer: boolean }) => {
      setupPeerConnection(peerID, createOffer);
    };

    const handleSessionDescription = async ({
      peerID,
      sessionDescription
    }: {
      peerID: string;
      sessionDescription: RTCSessionDescriptionInit;
    }) => {
      const pc = peerConnections.current[peerID];
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sessionDescription));
        if (sessionDescription.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit(ACTIONS.RELAY_SDP, {
            peerID,
            sessionDescription: answer
          });
        }
      } catch (err) {
        console.error('Ошибка setRemoteDescription:', err);
      }
    };

    const handleIceCandidate = ({ peerID, iceCandidate }: { peerID: string; iceCandidate: RTCIceCandidateInit }) => {
      const pc = peerConnections.current[peerID];
      if (pc) pc.addIceCandidate(new RTCIceCandidate(iceCandidate));
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

    const handleChatMessage = (msg: {
      id: string;
      message: string;
      sender: string;
      timestamp: string;
    }) => {
      addChatMessage({
        ...msg,
        isLocal: msg.sender === socket.id,
        text: msg.message,
        timestamp: new Date(msg.timestamp).toLocaleTimeString()
      });
    };

    const handleFileAttached = (data: {
      id: string;
      fileName: string;
      sender: string;
      timestamp: string;
    }) => {
      addFileAttachment({
        ...data,
        isLocal: data.sender === socket.id,
        timestamp: new Date(data.timestamp).toLocaleTimeString()
      });
    };

    const handlers = {
      [ACTIONS.ADD_PEER]: handleAddPeer,
      [ACTIONS.SESSION_DESCRIPTION]: handleSessionDescription,
      [ACTIONS.ICE_CANDIDATE]: handleIceCandidate,
      [ACTIONS.REMOVE_PEER]: handleRemovePeer,
      [ACTIONS.CHAT_MESSAGE]: handleChatMessage,
      [ACTIONS.FILE_ATTACHED]: handleFileAttached
    };

    Object.entries(handlers).forEach(([action, handler]) => {
      socket.on(action as any, handler);
    });

    if (roomID) {
      socket.emit(ACTIONS.REQUEST_CHAT_HISTORY, { roomID });
    }

    return () => {
      Object.entries(handlers).forEach(([action, handler]) => {
        socket.off(action as any, handler);
      });
    };
  }, [
    setupPeerConnection,
    updateClients,
    addChatMessage,
    addFileAttachment
  ]);

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
    addFileAttachment,
    getChatMessages,
    peerMediaElements,
    reconnect
  };
}