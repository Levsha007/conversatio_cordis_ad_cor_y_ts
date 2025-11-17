// Импорт необходимых хуков и зависимостей
import { useEffect, useRef, useCallback, useState } from 'react';
import useStateWithCallback from './useStateWithCallback';
import socket from '../socket';
import { ACTIONS } from '../socket/actions';

// Константа для идентификации локального видео
export const LOCAL_VIDEO = 'LOCAL_VIDEO';

// Интерфейсы для типизации данных
interface WebRTCStatus {
  isSupported: boolean;
  errors: string[];
}

interface MediaState {
  audio: boolean;
  video: boolean;
  screen: boolean;
}

interface AvailableDevices {
  audio: MediaDeviceInfo[];
  video: MediaDeviceInfo[];
}

interface ChatMessage {
  id: string;
  text: string;
  isLocal: boolean;
  timestamp: string;
  sender: string;
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
  participantSettings: Record<string, ParticipantSettings>;
  toggleParticipantVideo: (peerId: string) => void;
  toggleParticipantAudio: (peerId: string) => void;
};

function checkWebRTCAvailability(): WebRTCStatus {
  const errors: string[] = [];
  if (!navigator.mediaDevices) errors.push('mediaDevices недоступен');
  if (!window.RTCPeerConnection) errors.push('RTCPeerConnection недоступен');
  return {
    isSupported: errors.length === 0,
    errors
  };
}

export default function useWebRTC(roomID?: string): UseWebRTCReturn {
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
  
  // ICE серверы с поддержкой Apple
  const iceServers = useRef<RTCIceServer[]>([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    // Для Apple устройств
    { urls: 'stun:stun.iphone.com:3478' },
    { urls: 'stun:stun.mac.com:3478' }
  ]);

  const isInitialized = useRef(false);

  // Функция добавления нового клиента
  const addNewClient = useCallback((newClient: string, cb?: () => void) => {
    updateClients(list => {
      if (!list.includes(newClient)) return [...list, newClient];
      return list;
    }, cb);
  }, [updateClients]);

  // Получить параметры медиапотока
  const getMediaConstraints = useCallback((constraints: { audio: boolean; video: boolean }): MediaStreamConstraints => ({
    audio: constraints.audio ? {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      deviceId: selectedAudioDevice ? { exact: selectedAudioDevice } : undefined
    } : false,
    video: constraints.video ? {
      width: { ideal: 1280, max: 1920 },
      height: { ideal: 720, max: 1080 },
      frameRate: { ideal: 30, max: 60 },
      aspectRatio: { ideal: 1.7777777778 }, // 16:9
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

      // Автоматически выбираем устройства по умолчанию
      if (!selectedAudioDevice && audioDevices.length > 0) {
        const defaultAudio = audioDevices.find(d => d.deviceId === 'default') || audioDevices[0];
        setSelectedAudioDevice(defaultAudio.deviceId);
      }
      if (!selectedVideoDevice && videoDevices.length > 0) {
        const defaultVideo = videoDevices.find(d => d.deviceId === 'default') || videoDevices[0];
        setSelectedVideoDevice(defaultVideo.deviceId);
      }
    } catch (err) {
      console.error('Ошибка получения устройств:', err);
    }
  }, [selectedAudioDevice, selectedVideoDevice]);

  // Инициализация медиапотока
  const initializeMedia = useCallback(async (constraints: { audio: boolean; video: boolean }): Promise<void> => {
    setMediaError(null);
    setIsMediaReady(false);
    
    try {
      const { isSupported, errors } = checkWebRTCAvailability();
      if (!isSupported) throw new Error(`WebRTC не поддерживается: ${errors.join(', ')}`);

      // Останавливаем предыдущие потоки (кроме демонстрации экрана)
      if (localMediaStream.current && !mediaState.screen) {
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
          // Создаем пустой поток для участников без устройств
          stream = new MediaStream();
        }
      } else {
        // Создаем пустой поток для участников без устройств
        stream = new MediaStream();
      }

      setIsMediaReady(true);
      localMediaStream.current = stream;

      // Обновляем состояние медиа
      setMediaState(prev => ({
        ...prev,
        audio: constraints.audio && stream !== null,
        video: constraints.video && stream !== null
      }));

      // Добавляем локальное видео
      addNewClient(LOCAL_VIDEO, () => {
        const localVideo = peerMediaElements.current[LOCAL_VIDEO];
        if (localVideo) {
          // Показываем демонстрацию экрана если она активна, иначе обычный поток
          const activeStream = mediaState.screen ? screenShareStream.current : stream;
          localVideo.srcObject = activeStream;
          localVideo.volume = 0;
          if (activeStream) {
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
      // Создаем пустой поток для участников с ошибкой
      localMediaStream.current = new MediaStream();
      addNewClient(LOCAL_VIDEO);
      if (roomID) socket.emit(ACTIONS.JOIN, { room: roomID });
    }
  }, [getMediaConstraints, enumerateDevices, addNewClient, roomID, mediaState.screen]);

  // Демонстрация экрана - УПРОЩЕННАЯ И ИСПРАВЛЕННАЯ ВЕРСИЯ
  const startScreenShare = useCallback(async (): Promise<void> => {
    try {
      console.log('Starting screen share...');
      
      // Останавливаем предыдущую демонстрацию экрана
      if (screenShareStream.current) {
        screenShareStream.current.getTracks().forEach(track => track.stop());
        screenShareStream.current = null;
      }

      // Получаем поток демонстрации экрана ТОЛЬКО с видео
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'window'
        } as any,
        audio: false // Отключаем аудио с экрана чтобы не конфликтовало с микрофоном
      });

      console.log('Screen share stream obtained:', stream.getTracks());

      screenShareStream.current = stream;
      setMediaState(prev => ({ ...prev, screen: true }));

      const screenVideoTrack = stream.getVideoTracks()[0];

      // Обновляем локальное видео для показа демонстрации экрана
      const localVideo = peerMediaElements.current[LOCAL_VIDEO];
      if (localVideo) {
        // Создаем комбинированный поток: видео с экрана + аудио с микрофона
        const combinedStream = new MediaStream();
        combinedStream.addTrack(screenVideoTrack);
        
        // Добавляем аудио трек из локального потока если он есть
        if (localMediaStream.current) {
          const audioTracks = localMediaStream.current.getAudioTracks();
          audioTracks.forEach(track => combinedStream.addTrack(track));
        }
        
        localVideo.srcObject = combinedStream;
        localVideo.play().catch(e => console.error('Screen share video play error:', e));
      }

      // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Обновляем ВСЕ существующие peer соединения
      const updatePromises = Object.entries(peerConnections.current).map(async ([peerID, pc]) => {
        try {
          console.log(`Updating peer ${peerID} for screen share`);
          
          const senders = pc.getSenders();
          let videoSender = senders.find(s => s.track && s.track.kind === 'video');
          
          if (videoSender) {
            // Заменяем существующий видео трек на демонстрацию экрана
            await videoSender.replaceTrack(screenVideoTrack);
            console.log(`Replaced video track for peer ${peerID}`);
          } else {
            // Добавляем новый видео трек
            pc.addTrack(screenVideoTrack, stream);
            console.log(`Added new video track for peer ${peerID}`);
          }

          // Аудио оставляем как есть (микрофон продолжает работать)
          // Не трогаем аудио сендеры!

          // Перезапускаем переговоры
          console.log(`Restarting negotiation for peer ${peerID}`);
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
      });

      await Promise.all(updatePromises);

      // Обработчик окончания демонстрации экрана
      screenVideoTrack.addEventListener('ended', () => {
        console.log('Screen share ended by user');
        stopScreenShare();
      });

    } catch (err) {
      console.error('Ошибка демонстрации экрана:', err);
      setMediaError(err as Error);
      throw err;
    }
  }, []);

  // Остановка демонстрации экрана
  const stopScreenShare = useCallback((): void => {
    if (screenShareStream.current) {
      screenShareStream.current.getTracks().forEach(track => track.stop());
      screenShareStream.current = null;
    }

    setMediaState(prev => ({ ...prev, screen: false }));

    // Восстанавливаем оригинальные треки для всех peer соединений
    const originalStream = localMediaStream.current;
    
    Object.entries(peerConnections.current).forEach(async ([peerID, pc]) => {
      try {
        const senders = pc.getSenders();
        
        if (originalStream) {
          const originalVideoTrack = originalStream.getVideoTracks()[0];
          const videoSender = senders.find(s => s.track && s.track.kind === 'video');
          
          if (videoSender && originalVideoTrack) {
            await videoSender.replaceTrack(originalVideoTrack);
            console.log(`Restored original video track for peer ${peerID}`);
          }
        }

        // Перезапускаем переговоры
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        socket.emit(ACTIONS.RELAY_SDP, {
          peerID,
          sessionDescription: offer,
        });

        console.log(`Screen share stopped, restoration offer sent to peer ${peerID}`);

      } catch (err) {
        console.error(`Error restoring tracks for peer ${peerID}:`, err);
      }
    });

    // Восстанавливаем локальное видео
    const localVideo = peerMediaElements.current[LOCAL_VIDEO];
    if (localVideo && originalStream) {
      localVideo.srcObject = originalStream;
      localVideo.play().catch(e => console.error('Local video play error after screen share:', e));
    }
  }, []);

  // Переключение медиаустройства
  const switchMediaDevice = useCallback(async (
    type: 'audio' | 'video',
    deviceId?: string
  ): Promise<boolean> => {
    try {
      console.log(`Switching ${type} device to:`, deviceId);

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

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        console.error(`Failed to get user media for ${type}:`, err);
        // Создаем пустой поток если устройство недоступно
        stream = new MediaStream();
      }

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

      // Обновляем локальное видео (если не идет демонстрация экрана)
      if (!mediaState.screen) {
        const localVideo = peerMediaElements.current[LOCAL_VIDEO];
        if (localVideo && localMediaStream.current) {
          localVideo.srcObject = localMediaStream.current;
          localVideo.play().catch(e => console.error('Local video play error:', e));
        }
      }

      await enumerateDevices();
      return true;
    } catch (err) {
      console.error(`Ошибка переключения устройства ${type}:`, err);
      return false;
    }
  }, [enumerateDevices, mediaState]);

  // Переподключение
  const reconnect = useCallback(async (): Promise<void> => {
    try {
      Object.values(peerConnections.current).forEach(pc => pc.close());
      peerConnections.current = {};
      
      // Останавливаем потоки
      if (localMediaStream.current) {
        localMediaStream.current.getTracks().forEach(track => track.stop());
        localMediaStream.current = null;
      }
      if (screenShareStream.current) {
        screenShareStream.current.getTracks().forEach(track => track.stop());
        screenShareStream.current = null;
      }
      
      updateClients([], () => {});
      
      // Переинициализируем медиа
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
      
      // Обновляем состояние треков в активном потоке
      const activeStream = mediaState.screen ? screenShareStream.current : localMediaStream.current;
      if (activeStream) {
        activeStream.getTracks()
          .filter(track => track.kind === type)
          .forEach(track => {
            track.enabled = newState[type];
          });
      }

      return newState;
    });
  }, [mediaState.screen]);

  // Установка соединения с пиром - ОСНОВНАЯ ФУНКЦИЯ
  const setupPeerConnection = useCallback(async (
    peerID: string, 
    createOffer: boolean
  ) => {
    if (peerConnections.current[peerID]) {
      console.log(`Peer connection for ${peerID} already exists`);
      return;
    }

    console.log(`Setting up peer connection for ${peerID}, createOffer: ${createOffer}`);

    // Конфигурация для лучшей совместимости с Apple
    // Убрать свойство sdpSemantics из конфигурации RTCPeerConnection
    const pc = new RTCPeerConnection({ 
      iceServers: iceServers.current,
      iceCandidatePoolSize: 10,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
      // Убрать sdpSemantics: 'unified-plan' - это свойство устарело или не поддерживается в TypeScript
    });

    peerConnections.current[peerID] = pc;

    // Добавляем треки из активного потока
    const activeStream = mediaState.screen ? screenShareStream.current : localMediaStream.current;
    if (activeStream && activeStream.getTracks().length > 0) {
      console.log(`Adding ${activeStream.getTracks().length} tracks from active stream to peer ${peerID}`);
      activeStream.getTracks().forEach(track => {
        if (track.readyState === 'live') {
          try {
            pc.addTrack(track, activeStream);
            console.log(`Added ${track.kind} track to peer ${peerID}`);
          } catch (err) {
            console.error(`Error adding ${track.kind} track to peer ${peerID}:`, err);
          }
        }
      });
    } else {
      console.log(`No active tracks available for peer ${peerID}`);
      // Добавляем пустые треки чтобы соединение установилось
      addNewClient(peerID);
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

    // Обработка ICE соединения
    pc.oniceconnectionstatechange = () => {
      console.log(`ICE connection state for ${peerID}:`, pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        console.log('ICE connection failed, restarting ICE...');
        pc.restartIce();
      }
    };

    // Обработка сигнального состояния
    pc.onsignalingstatechange = () => {
      console.log(`Signaling state for ${peerID}:`, pc.signalingState);
    };

    // Получение удаленного медиа потока
    pc.ontrack = ({ streams: [remoteStream], track }) => {
      if (!remoteStream) {
        console.log('No remote stream received for peer:', peerID);
        // Добавляем клиента даже без потока для отображения участника
        addNewClient(peerID, () => {
          const element = peerMediaElements.current[peerID];
          if (element) {
            element.srcObject = null;
          }
        });
        return;
      }
      
      console.log('Received remote stream from:', peerID, 'with track:', track.kind);
      addNewClient(peerID, () => {
        const element = peerMediaElements.current[peerID];
        if (element) {
          // Для Apple устройств - особенная обработка
          if (navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome')) {
            element.srcObject = remoteStream;
          } else {
            element.srcObject = remoteStream;
          }
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
        console.log(`Offer created and sent to peer ${peerID}`);
      } catch (err) {
        console.error('Ошибка создания оффера:', err);
      }
    }
  }, [addNewClient, mediaState.screen]);

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
      
      // Для Apple устройств
      node.setAttribute('playsinline', 'true');
      node.setAttribute('webkit-playsinline', 'true');
      
      if (id !== LOCAL_VIDEO && participantSettings[id]) {
        node.style.display = participantSettings[id].videoEnabled ? 'block' : 'none';
      }
      
      peerMediaElements.current[id] = node;
      
      // Если это локальное видео, сразу устанавливаем правильный поток
      if (id === LOCAL_VIDEO) {
        const activeStream = mediaState.screen ? screenShareStream.current : localMediaStream.current;
        if (activeStream) {
          node.srcObject = activeStream;
          node.play().catch(e => console.error('Local video play error in provideMediaRef:', e));
        }
      }
    }
  }, [participantSettings, mediaState.screen]);

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
      if (!pc) {
        console.log(`No peer connection found for ${peerID}`);
        return;
      }
      
      try {
        await pc.setRemoteDescription(
          new RTCSessionDescription(sessionDescription)
        );
        console.log(`Remote description set for peer ${peerID}:`, sessionDescription.type);
        
        if (sessionDescription.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit(ACTIONS.RELAY_SDP, {
            peerID,
            sessionDescription: answer,
          });
          console.log(`Answer sent to peer ${peerID}`);
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
        console.log(`Peer ${peerID} removed`);
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
      console.log('WebRTC hook unmounted and cleaned up');
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