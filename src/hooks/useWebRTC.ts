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
  errors: string[];     // Список ошибок, если не поддерживается
}

interface MediaState {
  audio: boolean; // Состояние аудио (вкл/выкл)
  video: boolean; // Состояние видео (вкл/выкл)
  screen: boolean; // Состояние демонстрации экрана
}

interface AvailableDevices {
  audio: MediaDeviceInfo[]; // Доступные аудио устройства
  video: MediaDeviceInfo[]; // Доступные видео устройства
}

interface ChatMessage {
  id: string;         // Уникальный ID сообщения
  text: string;       // Текст сообщения
  isLocal: boolean;   // Отправлено ли текущим пользователем
  timestamp: string;  // Временная метка
  sender: string;     // ID отправителя
}

interface ParticipantSettings {
  videoEnabled: boolean;
  audioEnabled: boolean;
}

type UseWebRTCReturn = {
  clients: string[];
  provideMediaRef: (id: string, node: HTMLVideoElement | null) => void;
  mediaError: Error | null;
  isMediaReady: boolean;
  webRTCStatus: WebRTCStatus;
  mediaState: MediaState;
  toggleMedia: (type: 'audio' | 'video') => void;
  switchMediaDevice: (type: 'audio' | 'video', deviceId?: string) => Promise<boolean>;
  availableDevices: AvailableDevices;
  addChatMessage: (message: ChatMessage) => void;
  getChatMessages: () => ChatMessage[];
  peerMediaElements: React.MutableRefObject<Record<string, HTMLVideoElement | null>>;
  reconnect: () => Promise<void>;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => void;
  initializeMedia: (constraints: { audio: boolean; video: boolean }) => Promise<void>;
  // Новые функции
  participantSettings: Record<string, ParticipantSettings>;
  toggleParticipantVideo: (peerId: string) => void;
  toggleParticipantAudio: (peerId: string) => void;
};

// Проверка доступности WebRTC
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
  const [mediaState, setMediaState] = useState<MediaState>({ 
    audio: false, 
    video: false, 
    screen: false 
  });
  const [availableDevices, setAvailableDevices] = useState<AvailableDevices>({
    audio: [],
    video: []
  });
  const [participantSettings, setParticipantSettings] = useState<Record<string, ParticipantSettings>>({});
  const [selectedAudioDevice, setSelectedAudioDevice] = useState<string>('');
  const [selectedVideoDevice, setSelectedVideoDevice] = useState<string>('');

  // Рефы для хранения данных между рендерами
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
  const localMediaStream = useRef<MediaStream | null>(null);
  const screenShareStream = useRef<MediaStream | null>(null);
  const peerMediaElements = useRef<Record<string, HTMLVideoElement | null>>({});
  const chatMessages = useRef<ChatMessage[]>([]);
  
  // Улучшенные ICE серверы для лучшей совместимости с разными сетями
  const iceServers = useRef<RTCIceServer[]>([
    // Публичные STUN серверы
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    // Дополнительные STUN серверы
    { urls: 'stun:stun.voipbuster.com:3478' },
    { urls: 'stun:stun.voipstunt.com:3478' },
    { urls: 'stun:stun.ekiga.net:3478' },
    // Публичные TURN серверы (для обхода NAT)
    {
      urls: 'turn:numb.viagenie.ca:3478',
      username: 'webrtc@live.com',
      credential: 'muazkh'
    },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]);

  const isInitialized = useRef(false);

  // Функция добавления нового клиента
  const addNewClient = useCallback((newClient: string, cb?: () => void) => {
    updateClients(list => {
      if (!list.includes(newClient)) return [...list, newClient];
      return list;
    }, cb);
  }, [updateClients]);

  // Получить параметры медиапотока с учетом выбранных устройств
  const getMediaConstraints = useCallback((constraints: { audio: boolean; video: boolean }): MediaStreamConstraints => ({
    audio: constraints.audio ? {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 2,
      sampleRate: 48000,
      sampleSize: 16,
      deviceId: selectedAudioDevice ? { exact: selectedAudioDevice } : undefined
    } : false,
    video: constraints.video ? {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
      deviceId: selectedVideoDevice ? { exact: selectedVideoDevice } : undefined
    } : false
  }), [selectedAudioDevice, selectedVideoDevice]);

  // Перечисление доступных устройств
  const enumerateDevices = useCallback(async (): Promise<void> => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioDevices = devices.filter(d => d.kind === 'audioinput');
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      
      setAvailableDevices({
        audio: audioDevices,
        video: videoDevices
      });

      // Автоматически выбираем первое доступное устройство, если не выбрано
      if (!selectedAudioDevice && audioDevices.length > 0) {
        setSelectedAudioDevice(audioDevices[0].deviceId);
      }
      if (!selectedVideoDevice && videoDevices.length > 0) {
        setSelectedVideoDevice(videoDevices[0].deviceId);
      }
    } catch (err) {
      console.error('Ошибка получения устройств:', err);
    }
  }, [selectedAudioDevice, selectedVideoDevice]);

  // Инициализация медиапотока - УЛУЧШЕННАЯ ВЕРСИЯ
  const initializeMedia = useCallback(async (constraints: { audio: boolean; video: boolean }): Promise<void> => {
    setMediaError(null);
    setIsMediaReady(false);
    
    try {
      const { isSupported, errors } = checkWebRTCAvailability();
      if (!isSupported) throw new Error(`WebRTC не поддерживается: ${errors.join(', ')}`);

      // Останавливаем предыдущие потоки
      if (localMediaStream.current) {
        localMediaStream.current.getTracks().forEach(track => track.stop());
        localMediaStream.current = null;
      }

      let stream: MediaStream | null = null;
      
      if (constraints.audio || constraints.video) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(getMediaConstraints(constraints));
          await enumerateDevices();
        } catch (err) {
          console.warn('Не удалось получить медиаустройства:', err);
          // Продолжаем без устройств
        }
      }

      setIsMediaReady(true);
      localMediaStream.current = stream;
      
      // Обновляем состояние медиа
      setMediaState(prev => ({
        ...prev,
        audio: constraints.audio && stream !== null,
        video: constraints.video && stream !== null
      }));

      // ВСЕГДА добавляем локальное видео, даже если нет устройств
      addNewClient(LOCAL_VIDEO, () => {
        const localVideo = peerMediaElements.current[LOCAL_VIDEO];
        if (localVideo) {
          localVideo.srcObject = stream;
          localVideo.volume = 0;
          if (stream) {
            localVideo.play().catch(e => console.error('Local video play error:', e));
          }
        }
      });

      // Присоединяемся к комнате
      if (roomID) {
        console.log('Joining room:', roomID);
        socket.emit(ACTIONS.JOIN, { room: roomID });
      }
      
    } catch (err) {
      console.error('Ошибка инициализации медиа:', err);
      setMediaError(err as Error);
      // Даже при ошибке добавляем локальное видео и присоединяемся к комнате
      addNewClient(LOCAL_VIDEO);
      if (roomID) socket.emit(ACTIONS.JOIN, { room: roomID });
    }
  }, [getMediaConstraints, enumerateDevices, addNewClient, roomID]);

  // Демонстрация экрана - ИСПРАВЛЕННАЯ ВЕРСИЯ
  const startScreenShare = useCallback(async (): Promise<void> => {
    try {
      console.log('Starting screen share...');
      
      if (screenShareStream.current) {
        screenShareStream.current.getTracks().forEach(track => track.stop());
        screenShareStream.current = null;
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'window'
        } as any,
        audio: true
      });

      console.log('Screen share stream obtained:', stream.getTracks());

      screenShareStream.current = stream;
      setMediaState(prev => ({ ...prev, screen: true }));

      const videoTracks = stream.getVideoTracks();
      const audioTracks = stream.getAudioTracks();

      // Обновляем локальное видео
      const localVideo = peerMediaElements.current[LOCAL_VIDEO];
      if (localVideo) {
        localVideo.srcObject = stream;
        localVideo.play().catch(e => console.error('Screen share video play error:', e));
      }

      // Обновляем все peer соединения - ИСПРАВЛЕННЫЙ КОД
      await Promise.all(
        Object.entries(peerConnections.current).map(async ([peerID, pc]) => {
          try {
            const senders = pc.getSenders();
            
            // Находим отправители для видео и аудио
            const videoSender = senders.find(s => s.track && s.track.kind === 'video');
            const audioSender = senders.find(s => s.track && s.track.kind === 'audio');

            // Заменяем видео трек
            if (videoTracks.length > 0) {
              if (videoSender) {
                await videoSender.replaceTrack(videoTracks[0]);
              } else {
                pc.addTrack(videoTracks[0], stream);
              }
            }

            // Заменяем аудио трек
            if (audioTracks.length > 0) {
              if (audioSender) {
                await audioSender.replaceTrack(audioTracks[0]);
              } else {
                pc.addTrack(audioTracks[0], stream);
              }
            }

            // Перезапускаем переговоры для всех пиров
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            
            socket.emit(ACTIONS.RELAY_SDP, {
              peerID,
              sessionDescription: offer,
            });

            console.log(`Screen share offer sent to peer ${peerID}`);

          } catch (err) {
            console.error(`Error updating screen share for peer ${peerID}:`, err);
          }
        })
      );

      // Обработчик окончания демонстрации экрана
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        console.log('Screen share ended by user');
        stopScreenShare();
      });

    } catch (err) {
      console.error('Ошибка демонстрации экрана:', err);
      setMediaError(err as Error);
      throw err;
    }
  }, []);

  // Остановка демонстрации экрана - ИСПРАВЛЕННАЯ ВЕРСИЯ
  const stopScreenShare = useCallback((): void => {
    if (screenShareStream.current) {
      screenShareStream.current.getTracks().forEach(track => track.stop());
      screenShareStream.current = null;
    }

    setMediaState(prev => ({ ...prev, screen: false }));

    // Восстанавливаем оригинальные треки
    const originalStream = localMediaStream.current;
    
    // Обновляем все peer соединения
    Object.entries(peerConnections.current).forEach(async ([peerID, pc]) => {
      try {
        const senders = pc.getSenders();
        
        if (originalStream) {
          const originalVideoTracks = originalStream.getVideoTracks();
          const originalAudioTracks = originalStream.getAudioTracks();

          // Восстанавливаем оригинальные треки
          const videoSender = senders.find(s => s.track && s.track.kind === 'video');
          if (videoSender && originalVideoTracks.length > 0) {
            await videoSender.replaceTrack(originalVideoTracks[0]);
          }

          const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
          if (audioSender && originalAudioTracks.length > 0) {
            await audioSender.replaceTrack(originalAudioTracks[0]);
          }
        }

        // Перезапускаем переговоры
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        socket.emit(ACTIONS.RELAY_SDP, {
          peerID,
          sessionDescription: offer,
        });

        console.log(`Screen share stopped, offer sent to peer ${peerID}`);

      } catch (err) {
        console.error(`Error restoring tracks for peer ${peerID}:`, err);
      }
    });

    // Восстанавливаем локальное видео
    const localVideo = peerMediaElements.current[LOCAL_VIDEO];
    if (localVideo) {
      if (originalStream) {
        localVideo.srcObject = originalStream;
        localVideo.play().catch(e => console.error('Local video play error after screen share:', e));
      } else {
        localVideo.srcObject = null;
      }
    }
  }, []);

  // Переключение медиаустройства - УЛУЧШЕННАЯ ВЕРСИЯ
  const switchMediaDevice = useCallback(async (
    type: 'audio' | 'video',
    deviceId?: string
  ): Promise<boolean> => {
    try {
      // Сохраняем выбранное устройство
      if (type === 'audio' && deviceId) {
        setSelectedAudioDevice(deviceId);
      } else if (type === 'video' && deviceId) {
        setSelectedVideoDevice(deviceId);
      }

      const oldTracks = localMediaStream.current?.getTracks()
        .filter(track => track.kind === type) || [];
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

      // Обновляем все peer соединения с новыми треками
      await Promise.all(
        Object.values(peerConnections.current).map(async (pc) => {
          const senders = pc.getSenders();
          await Promise.all(
            senders.map(async (sender) => {
              if (sender.track?.kind === type) {
                const newTrack = newTracks.find(t => t.kind === type);
                if (newTrack) {
                  try {
                    await sender.replaceTrack(newTrack);
                  } catch (e) {
                    console.error('Ошибка при замене трека:', e);
                  }
                }
              }
            })
          );
        })
      );

      const localVideo = peerMediaElements.current[LOCAL_VIDEO];
      if (localVideo && localMediaStream.current) {
        localVideo.srcObject = new MediaStream(
          localMediaStream.current.getTracks()
        );
        localVideo.play().catch(e => console.error('Local video play error:', e));
      }

      await enumerateDevices();
      return true;
    } catch (err) {
      console.error(`Ошибка переключения устройства ${type}:`, err);
      return false;
    }
  }, [enumerateDevices, mediaState]);

  // Остальные функции остаются без изменений...
  // [Остальной код остается таким же как в оригинале, чтобы не превышать лимит ответа]

  // Переподключение
  const reconnect = useCallback(async (): Promise<void> => {
    try {
      Object.values(peerConnections.current).forEach(pc => pc.close());
      peerConnections.current = {};
      if (localMediaStream.current) {
        localMediaStream.current.getTracks().forEach(track => track.stop());
        localMediaStream.current = null;
      }
      if (screenShareStream.current) {
        screenShareStream.current.getTracks().forEach(track => track.stop());
        screenShareStream.current = null;
      }
      updateClients([], () => {});
      
      await initializeMedia({
        audio: mediaState.audio,
        video: mediaState.video
      });
    } catch (err) {
      console.error('Ошибка переподключения:', err);
      setMediaError(err as Error);
    }
  }, [updateClients, initializeMedia, mediaState]);

  // Переключение состояния медиа (вкл/выкл)
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

  // Установка соединения с пиром
  const setupPeerConnection = useCallback(async (
    peerID: string, 
    createOffer: boolean
  ) => {
    if (peerConnections.current[peerID]) return;

    const pc = new RTCPeerConnection({ 
      iceServers: iceServers.current,
      iceCandidatePoolSize: 10,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });

    peerConnections.current[peerID] = pc;

    // Добавляем треки из активного потока
    const activeStream = screenShareStream.current || localMediaStream.current;
    if (activeStream) {
      activeStream.getTracks().forEach(track => {
        pc.addTrack(track, activeStream);
      });
    }

    // Обработка ICE кандидатов
    pc.onicecandidate = event => {
      if (event.candidate) {
        socket.emit(ACTIONS.RELAY_ICE, {
          peerID,
          iceCandidate: event.candidate
        });
      }
    };

    // Улучшенная обработка ICE соединения
    pc.oniceconnectionstatechange = () => {
      console.log(`ICE connection state for ${peerID}:`, pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        console.log('ICE connection failed, restarting ICE...');
        pc.restartIce();
      }
    };

    // Получение удаленного медиа потока
    pc.ontrack = ({ streams: [remoteStream] }) => {
      if (!remoteStream) return;
      console.log('Received remote stream from:', peerID, remoteStream.getTracks());
      addNewClient(peerID, () => {
        const element = peerMediaElements.current[peerID];
        if (element) {
          element.srcObject = remoteStream;
          element.play().catch(e => console.error('Remote video play error:', e));
        }
      });
    };

    // Создание оффера
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
  }, [addNewClient]);

  // Функции управления участниками
  const toggleParticipantVideo = useCallback((peerId: string) => {
    setParticipantSettings(prev => ({
      ...prev,
      [peerId]: {
        ...prev[peerId],
        videoEnabled: !(prev[peerId]?.videoEnabled ?? true)
      }
    }));

    const videoElement = peerMediaElements.current[peerId];
    if (videoElement) {
      videoElement.style.display = participantSettings[peerId]?.videoEnabled ? 'none' : 'block';
    }
  }, [participantSettings]);

  const toggleParticipantAudio = useCallback((peerId: string) => {
    setParticipantSettings(prev => ({
      ...prev,
      [peerId]: {
        ...prev[peerId],
        audioEnabled: !(prev[peerId]?.audioEnabled ?? true)
      }
    }));

    const videoElement = peerMediaElements.current[peerId];
    if (videoElement) {
      videoElement.muted = !participantSettings[peerId]?.audioEnabled;
    }
  }, [participantSettings]);

  // Добавление сообщения в чат
  const addChatMessage = useCallback((message: ChatMessage) => {
    chatMessages.current = [...chatMessages.current, message];
  }, []);

  // Получение всех сообщений
  const getChatMessages = useCallback((): ChatMessage[] => {
    return chatMessages.current;
  }, []);

  // Привязка ref к видео элементам
  const provideMediaRef = useCallback((id: string, node: HTMLVideoElement | null) => {
    if (node) {
      node.autoplay = true;
      node.playsInline = true;
      node.muted = id === LOCAL_VIDEO || !participantSettings[id]?.audioEnabled;
      
      if (id !== LOCAL_VIDEO && participantSettings[id]) {
        node.style.display = participantSettings[id].videoEnabled ? 'block' : 'none';
      }
      
      peerMediaElements.current[id] = node;
    }
  }, [participantSettings]);

  // Инициализация WebRTC при изменении roomID
  useEffect(() => {
    if (roomID && !isInitialized.current) {
      isInitialized.current = true;
    }
  }, [roomID]);

  // Подписка на события Socket.IO
  useEffect(() => {
    const handleAddPeer = ({ peerID, createOffer }: { 
      peerID: string; 
      createOffer: boolean;
    }) => {
      console.log('Adding peer:', peerID, 'createOffer:', createOffer);
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
        console.error('Ошибка setRemoteDescription:', err);
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
          .catch(err => console.error('Ошибка addIceCandidate:', err));
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

    if (roomID) {
      socket.emit(ACTIONS.REQUEST_CHAT_HISTORY, { roomID });
    }

    return () => {
      Object.entries(handlers).forEach(([action, handler]) => {
        socket.off(action as any, handler);
      });
    };
  }, [setupPeerConnection, updateClients, addChatMessage, roomID]);

  // Инициализация настроек участников
  useEffect(() => {
    clients.forEach(clientId => {
      if (clientId !== LOCAL_VIDEO && !participantSettings[clientId]) {
        setParticipantSettings(prev => ({
          ...prev,
          [clientId]: {
            videoEnabled: true,
            audioEnabled: true
          }
        }));
      }
    });
  }, [clients, participantSettings]);

  // Очистка при размонтировании
  useEffect(() => {
    return () => {
      Object.values(peerConnections.current).forEach(pc => pc.close());
      peerConnections.current = {};
      if (localMediaStream.current) {
        localMediaStream.current.getTracks().forEach(track => track.stop());
        localMediaStream.current = null;
      }
      if (screenShareStream.current) {
        screenShareStream.current.getTracks().forEach(track => track.stop());
        screenShareStream.current = null;
      }
      socket.emit(ACTIONS.LEAVE);
    };
  }, []);

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
    reconnect,
    startScreenShare,
    stopScreenShare,
    initializeMedia,
    participantSettings,
    toggleParticipantVideo,
    toggleParticipantAudio
  };
}