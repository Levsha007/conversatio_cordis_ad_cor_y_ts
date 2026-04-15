import { useEffect, useRef, useCallback, useState } from 'react';
import useStateWithCallback from './useStateWithCallback';
import socket from '../socket';
import { ACTIONS } from '../socket/actions';

export const LOCAL_VIDEO = 'LOCAL_VIDEO';

// Типы для SFU
interface SFUPeer {
  id: string;
  userName: string;
  hasMedia: boolean;
}

interface ConsumerInfo {
  peerId: string;
  kind: 'audio' | 'video';
  consumerId: string;
  producerId: string;
}

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
  initializeMedia: (constraints: { audio: boolean; video: boolean }, userName?: string) => Promise<void>;
  forceSyncTracks: () => Promise<void>;
  refreshDevices: () => Promise<void>;
  isDeviceAvailable: (type: 'audio' | 'video') => boolean;
  participantSettings: Record<string, ParticipantSettings>;
  toggleParticipantVideo: (peerId: string) => void;
  toggleParticipantAudio: (peerId: string) => void;
};

function checkWebRTCAvailability(): WebRTCStatus {
  const errors: string[] = [];
  if (!navigator.mediaDevices) errors.push('mediaDevices недоступен');
  if (!window.RTCPeerConnection) errors.push('RTCPeerConnection недоступен');
  
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  if (isSafari && !window.RTCRtpSender) {
    errors.push('Safari требует дополнительных разрешений для WebRTC');
  }
  
  return {
    isSupported: errors.length === 0,
    errors
  };
}

export default function useWebRTC(roomID?: string): UseWebRTCReturn {
  const [clients, updateClients] = useStateWithCallback<string[]>([LOCAL_VIDEO]);
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

  // Рефы для SFU
  const localStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);
  const peerMediaElements = useRef<Record<string, HTMLVideoElement | null>>({});
  const chatMessages = useRef<ChatMessage[]>([]);
  
  // SFU специфичные рефы
  const sfuTransport = useRef<any>(null);
  const producers = useRef<Record<string, any>>({});
  const consumers = useRef<Record<string, any>>({});
  const remoteStreams = useRef<Record<string, MediaStream>>({});
  
  const isInitialized = useRef(false);
  const localPeerId = useRef<string | null>(null);

  // Добавление клиента
  const addNewClient = useCallback((newClient: string, cb?: () => void) => {
    updateClients(list => {
      if (!list.includes(newClient)) return [...list, newClient];
      return list;
    }, cb);
  }, [updateClients]);

  // Получение медиаконстрейнов
  const getMediaConstraints = useCallback((constraints: { audio: boolean; video: boolean }): MediaStreamConstraints => ({
    audio: constraints.audio ? {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      deviceId: selectedAudioDevice ? { exact: selectedAudioDevice } : undefined
    } : false,
    video: constraints.video ? {
      width: { ideal: 1280, min: 640 },
      height: { ideal: 720, min: 480 },
      frameRate: { ideal: 30, min: 20 },
      deviceId: selectedVideoDevice ? { exact: selectedVideoDevice } : undefined
    } : false
  }), [selectedAudioDevice, selectedVideoDevice]);

  // Перечисление устройств
  const enumerateDevices = useCallback(async (): Promise<void> => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioDevices = devices.filter(d => d.kind === 'audioinput');
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      
      setAvailableDevices({
        audio: audioDevices,
        video: videoDevices
      });

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

  // Создание producer для SFU
  const createProducer = useCallback(async (kind: 'audio' | 'video') => {
    if (!sfuTransport.current || !localStream.current) {
      console.log(`Cannot create ${kind} producer: transport or stream not ready`);
      return;
    }

    const track = kind === 'audio' 
      ? localStream.current.getAudioTracks()[0]
      : localStream.current.getVideoTracks()[0];
    
    if (!track || !track.enabled) {
      console.log(`${kind} track not available or disabled`);
      return;
    }

    try {
      // Создаём producer через транспорт
      const producer = await (sfuTransport.current as any).produce({
        track,
        encodings: kind === 'video' ? [
          { maxBitrate: 100000, scaleResolutionDownBy: 4 },
          { maxBitrate: 300000, scaleResolutionDownBy: 2 },
          { maxBitrate: 800000 }
        ] : undefined,
        codecOptions: {
          videoGoogleStartBitrate: 1000
        }
      });

      producers.current[kind] = producer;
      console.log(`${kind} producer created with id: ${producer.id}`);

      producer.on('transportclose', () => {
        console.log(`${kind} producer transport closed`);
      });

      producer.on('trackended', () => {
        console.log(`${kind} producer track ended`);
      });

    } catch (err) {
      console.error(`Failed to create ${kind} producer:`, err);
    }
  }, []);

  // Создание consumer для удалённого потока
  const createConsumer = useCallback(async (
    peerId: string,
    peerName: string,
    kind: 'audio' | 'video',
    consumerParameters: any
  ) => {
    if (!sfuTransport.current) {
      console.log('Cannot create consumer: transport not ready');
      return;
    }

    try {
      const consumer = await (sfuTransport.current as any).consume({
        ...consumerParameters
      });

      const key = `${peerId}:${kind}`;
      consumers.current[key] = consumer;

      // Получаем или создаём MediaStream для peer
      if (!remoteStreams.current[peerId]) {
        remoteStreams.current[peerId] = new MediaStream();
      }

      const stream = remoteStreams.current[peerId];
      stream.addTrack(consumer.track);

      // Добавляем клиента в список
      addNewClient(peerId, () => {
        const element = peerMediaElements.current[peerId];
        if (element && element.srcObject !== stream) {
          element.srcObject = stream;
          element.play().catch(e => console.error('Remote video play error:', e));
        }
      });

      // Возобновляем consumer (он создаётся paused)
      await consumer.resume();
      socket.emit('resume-consumer', { peerId, kind });

      console.log(`${kind} consumer created for peer ${peerId} (${peerName})`);

    } catch (err) {
      console.error(`Failed to create ${kind} consumer:`, err);
    }
  }, [addNewClient]);

  // Инициализация SFU транспорта
  const initSFUTransport = useCallback(async (transportParams: any) => {
    try {
      // Динамически импортируем mediasoup-client
      const { Device } = await import('mediasoup-client');
      
      const device = new Device();
      
      // Загружаем RTP capabilities с сервера
      await device.load({
        routerRtpCapabilities: transportParams.routerRtpCapabilities
      });

      // Создаём транспорт
      const transport = device.createSendTransport({
        id: transportParams.id,
        iceParameters: transportParams.iceParameters,
        iceCandidates: transportParams.iceCandidates,
        dtlsParameters: transportParams.dtlsParameters
      });

      sfuTransport.current = transport;

      // Обработка отправки медиа
      transport.on('produce', async ({ kind, rtpParameters }: any, callback: any, errback: any) => {
        try {
          socket.emit('create-producer', { kind, rtpParameters });
          
          // Временный обработчик ответа от сервера
          const handler = (data: any) => {
            if (data.kind === kind) {
              callback({ id: data.producerId });
              socket.off('producer-created', handler);
            }
          };
          
          socket.on('producer-created', handler);
          
          setTimeout(() => {
            socket.off('producer-created', handler);
            errback(new Error('Producer creation timeout'));
          }, 10000);
          
        } catch (err) {
          errback(err as Error);
        }
      });

      transport.on('connectionstatechange', (state: any) => {
        console.log('Transport connection state:', state);
      });

      // Если есть локальный стрим, создаём producers
      if (localStream.current) {
        if (mediaState.audio && localStream.current.getAudioTracks()[0]?.enabled) {
          await createProducer('audio');
        }
        if (mediaState.video && localStream.current.getVideoTracks()[0]?.enabled) {
          await createProducer('video');
        }
      }

      console.log('SFU Transport initialized');

    } catch (err) {
      console.error('Failed to initialize SFU transport:', err);
    }
  }, [createProducer, mediaState.audio, mediaState.video]);

  // Инициализация медиапотока
  const initializeMedia = useCallback(async (
    constraints: { audio: boolean; video: boolean }, 
    userName?: string
  ): Promise<void> => {
    setMediaError(null);
    setIsMediaReady(false);
    
    try {
      const { isSupported, errors } = checkWebRTCAvailability();
      if (!isSupported) throw new Error(`WebRTC не поддерживается: ${errors.join(', ')}`);

      if (localStream.current) {
        localStream.current.getTracks().forEach(track => track.stop());
        localStream.current = null;
      }

      let stream: MediaStream | null = null;
      const mediaConstraints = getMediaConstraints(constraints);

      try {
        stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
        console.log('Media stream obtained:', {
          audioTracks: stream.getAudioTracks().length,
          videoTracks: stream.getVideoTracks().length
        });
        
        if (constraints.audio && stream.getAudioTracks().length > 0) {
          stream.getAudioTracks().forEach(track => { track.enabled = true; });
        }
        
        if (constraints.video && stream.getVideoTracks().length > 0) {
          stream.getVideoTracks().forEach(track => { track.enabled = true; });
        }
        
        await enumerateDevices();
      } catch (err) {
        console.error('Не удалось получить медиаустройства:', err);
        stream = new MediaStream();
      }

      setIsMediaReady(true);
      localStream.current = stream;

      setMediaState(prev => ({
        ...prev,
        audio: constraints.audio,
        video: constraints.video
      }));

      // Отображаем локальное видео
      addNewClient(LOCAL_VIDEO, () => {
        const localVideo = peerMediaElements.current[LOCAL_VIDEO];
        if (localVideo && stream) {
          localVideo.srcObject = stream;
          localVideo.volume = 0;
          localVideo.play().catch(e => console.error('Local video play error:', e));
        }
      });

      // Присоединяемся к комнате
      if (roomID) {
        console.log('Joining room:', roomID, 'as:', userName, 'with constraints:', constraints);
        socket.emit(ACTIONS.JOIN, { 
          room: roomID, 
          userName: userName,
          hasMedia: constraints.audio || constraints.video
        });
      }
      
    } catch (err) {
      console.error('Ошибка инициализации медиа:', err);
      setMediaError(err as Error);
      localStream.current = new MediaStream();
      addNewClient(LOCAL_VIDEO);
      if (roomID) socket.emit(ACTIONS.JOIN, { room: roomID, userName });
    }
  }, [getMediaConstraints, enumerateDevices, addNewClient, roomID]);

  // Демонстрация экрана
  const startScreenShare = useCallback(async (): Promise<void> => {
    try {
      if (screenStream.current) {
        screenStream.current.getTracks().forEach(track => track.stop());
        screenStream.current = null;
      }

      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 }
        },
        audio: false
      });

      screenStream.current = displayStream;
      setMediaState(prev => ({ ...prev, screen: true }));

      // Обновляем локальное видео
      const localVideo = peerMediaElements.current[LOCAL_VIDEO];
      if (localVideo) {
        localVideo.srcObject = displayStream;
        localVideo.play().catch(e => console.error('Screen share video error:', e));
      }

      // Заменяем video producer на экран
      if (producers.current.video) {
        await producers.current.video.close();
        delete producers.current.video;
      }

      // Создаём новый producer для экрана
      if (sfuTransport.current && displayStream.getVideoTracks()[0]) {
        const screenTrack = displayStream.getVideoTracks()[0];
        const producer = await (sfuTransport.current as any).produce({
          track: screenTrack
        });
        producers.current.video = producer;
      }

      displayStream.getVideoTracks()[0].addEventListener('ended', () => {
        stopScreenShare();
      });

    } catch (err) {
      console.error('Ошибка демонстрации экрана:', err);
      setMediaError(err as Error);
      throw err;
    }
  }, []);

  const stopScreenShare = useCallback((): void => {
    if (screenStream.current) {
      screenStream.current.getTracks().forEach(track => track.stop());
      screenStream.current = null;
    }

    setMediaState(prev => ({ ...prev, screen: false }));

    // Восстанавливаем видео с камеры
    if (localStream.current && mediaState.video) {
      const videoTrack = localStream.current.getVideoTracks()[0];
      if (videoTrack && sfuTransport.current) {
        // Пересоздаём видео producer
        if (producers.current.video) {
          producers.current.video.close();
          delete producers.current.video;
        }
        createProducer('video');
      }
    }

    // Восстанавливаем локальное видео
    const localVideo = peerMediaElements.current[LOCAL_VIDEO];
    if (localVideo && localStream.current) {
      localVideo.srcObject = localStream.current;
      localVideo.play().catch(e => console.error('Local video restore error:', e));
    }
  }, [mediaState.video, createProducer]);

  const toggleMedia = useCallback((type: 'audio' | 'video') => {
    setMediaState(prev => {
      const newState = { ...prev, [type]: !prev[type] };
      
      const activeStream = mediaState.screen ? screenStream.current : localStream.current;
      if (activeStream) {
        activeStream.getTracks()
          .filter(track => track.kind === type)
          .forEach(track => {
            track.enabled = newState[type];
          });
      }

      // Для SFU: если включаем трек, создаём producer
      if (newState[type] && sfuTransport.current && !producers.current[type]) {
        createProducer(type);
      }
      
      return newState;
    });
  }, [mediaState.screen, createProducer]);

  const switchMediaDevice = useCallback(async (
    type: 'audio' | 'video',
    deviceId?: string
  ): Promise<boolean> => {
    try {
      if (type === 'audio' && deviceId) {
        setSelectedAudioDevice(deviceId);
      } else if (type === 'video' && deviceId) {
        setSelectedVideoDevice(deviceId);
      }
  
      // Пересоздаём медиапоток с новым устройством
      const constraints = {
        audio: mediaState.audio,
        video: mediaState.video && !mediaState.screen
      };
  
      // ИСПРАВЛЕНО: убираем true, используем undefined вместо true
      const audioConstraints: boolean | MediaTrackConstraints = constraints.audio 
        ? (deviceId && type === 'audio' ? { deviceId: { exact: deviceId } } : true)
        : false;
      
      const videoConstraints: boolean | MediaTrackConstraints = constraints.video 
        ? (deviceId && type === 'video' ? { deviceId: { exact: deviceId } } : true)
        : false;
  
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: videoConstraints
      });
  
      // Заменяем треки в локальном стриме
      if (localStream.current) {
        const oldTracks = localStream.current.getTracks().filter(t => t.kind === type);
        oldTracks.forEach(track => {
          track.stop();
          localStream.current?.removeTrack(track);
        });
        
        const newTracks = newStream.getTracks();
        newTracks.forEach(track => {
          localStream.current?.addTrack(track);
          track.enabled = mediaState[type];
        });
      } else {
        localStream.current = newStream;
      }
  
      // Обновляем локальное видео
      const localVideo = peerMediaElements.current[LOCAL_VIDEO];
      if (localVideo && localStream.current) {
        localVideo.srcObject = localStream.current;
      }
  
      // Пересоздаём producer
      if (sfuTransport.current && producers.current[type]) {
        await producers.current[type].close();
        delete producers.current[type];
        await createProducer(type);
      }
  
      await enumerateDevices();
      return true;
    } catch (err) {
      console.error(`Ошибка переключения устройства ${type}:`, err);
      return false;
    }
  }, [mediaState, mediaState.screen, createProducer, enumerateDevices]);

  const reconnect = useCallback(async (): Promise<void> => {
    try {
      if (localStream.current) {
        localStream.current.getTracks().forEach(track => track.stop());
        localStream.current = null;
      }
      if (screenStream.current) {
        screenStream.current.getTracks().forEach(track => track.stop());
        screenStream.current = null;
      }
      
      updateClients([LOCAL_VIDEO], () => {});
      
      await initializeMedia({
        audio: mediaState.audio,
        video: mediaState.video
      });
    } catch (err) {
      console.error('Ошибка переподключения:', err);
      setMediaError(err as Error);
    }
  }, [updateClients, initializeMedia, mediaState]);

  const forceSyncTracks = useCallback(async (): Promise<void> => {
    console.log('Force syncing tracks...');
    // В SFU синхронизация происходит автоматически
  }, []);

  const refreshDevices = useCallback(async (): Promise<void> => {
    await enumerateDevices();
  }, [enumerateDevices]);

  const isDeviceAvailable = useCallback((type: 'audio' | 'video'): boolean => {
    return mediaState[type];
  }, [mediaState]);

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

  const addChatMessage = useCallback((message: ChatMessage) => {
    chatMessages.current = [...chatMessages.current, message];
  }, []);

  const getChatMessages = useCallback((): ChatMessage[] => {
    return chatMessages.current;
  }, []);

  const provideMediaRef = useCallback((id: string, node: HTMLVideoElement | null) => {
    if (peerMediaElements.current[id] === node) return;
    
    if (node) {
      node.autoplay = true;
      node.playsInline = true;
      node.muted = id === LOCAL_VIDEO || !participantSettings[id]?.audioEnabled;
      
      if (id !== LOCAL_VIDEO && participantSettings[id]) {
        node.style.display = participantSettings[id].videoEnabled ? 'block' : 'none';
      }
      
      peerMediaElements.current[id] = node;
      
      if (id === LOCAL_VIDEO) {
        const activeStream = mediaState.screen && screenStream.current ? 
          screenStream.current : localStream.current;
        if (activeStream && node.srcObject !== activeStream) {
          node.srcObject = activeStream;
          node.play().catch(e => console.error('Local video play error:', e));
        }
      } else if (remoteStreams.current[id] && node.srcObject !== remoteStreams.current[id]) {
        node.srcObject = remoteStreams.current[id];
        node.play().catch(e => console.error('Remote video play error:', e));
      }
    } else {
      delete peerMediaElements.current[id];
    }
  }, [participantSettings, mediaState.screen]);

  // Подписка на Socket.IO события (SFU)
  useEffect(() => {
    // Обработчик существующих участников
    const handleExistingPeers = (peers: Array<{ peerId: string; userName: string; hasMedia: boolean }>) => {
      console.log('Existing peers:', peers);
      for (const peer of peers) {
        addNewClient(peer.peerId);
      }
    };

    // Обработчик добавления peer
    const handleAddPeer = ({ peerID, userName }: { peerID: string; userName?: string }) => {
      console.log('Adding peer:', peerID, userName);
      addNewClient(peerID);
    };

    // Обработчик удаления peer
    const handleRemovePeer = ({ peerID }: { peerID: string }) => {
      console.log('Removing peer:', peerID);
      updateClients(list => list.filter(c => c !== peerID));
      
      // Очищаем remote streams
      delete remoteStreams.current[peerID];
      delete peerMediaElements.current[peerID];
      
      // Закрываем consumers для этого peer
      Object.keys(consumers.current).forEach(key => {
        if (key.startsWith(peerID)) {
          consumers.current[key].close();
          delete consumers.current[key];
        }
      });
    };

    // Обработчик нового producer (создаём consumer)
    const handleNewProducer = async ({ 
      peerId, 
      peerName, 
      kind, 
      consumerParameters 
    }: { 
      peerId: string; 
      peerName: string; 
      kind: 'audio' | 'video'; 
      consumerParameters: any;
    }) => {
      console.log(`New ${kind} producer from ${peerName} (${peerId})`);
      await createConsumer(peerId, peerName, kind, consumerParameters);
    };

    // Обработчик создания транспорта
    const handleTransportCreated = (params: any) => {
      console.log('Transport created, initializing SFU...');
      // Нужно получить routerRtpCapabilities от сервера
      // В реальном приложении сервер должен отправить их
      initSFUTransport({
        ...params,
        routerRtpCapabilities: {
          // Эти значения должны прийти с сервера при JOIN
          codecs: [
            { mimeType: 'audio/opus', kind: 'audio', clockRate: 48000, channels: 2 },
            { mimeType: 'video/VP8', kind: 'video', clockRate: 90000 }
          ]
        }
      });
    };

    // Обработчик сообщений чата
    const handleChatMessage = (msg: {
      id: string;
      message: string;
      sender: string;
      timestamp: string;
      userName?: string;
    }) => {
      addChatMessage({
        id: msg.id,
        text: msg.message,
        isLocal: msg.sender === localPeerId.current,
        timestamp: new Date(msg.timestamp).toLocaleTimeString(),
        sender: msg.sender
      });
    };

    const handleChatHistory = (messages: any[]) => {
      const formattedMessages = messages.map(msg => ({
        id: msg.id,
        text: msg.message,
        isLocal: msg.sender === localPeerId.current,
        timestamp: new Date(msg.timestamp).toLocaleTimeString(),
        sender: msg.sender
      }));
      chatMessages.current = formattedMessages;
    };

    const handleUserNameUpdated = ({ peerID, userName }: { peerID: string; userName: string }) => {
      console.log(`User ${peerID} updated name to ${userName}`);
    };

    const handleRaiseHand = ({ peerID, userName }: { peerID: string; userName: string }) => {
      console.log(`${userName} raised hand`);
    };

    const handleLowerHand = ({ peerID, userName }: { peerID: string; userName: string }) => {
      console.log(`${userName} lowered hand`);
    };

    const handleError = ({ message }: { message: string }) => {
      console.error('Server error:', message);
      setMediaError(new Error(message));
    };

    // Регистрируем обработчики
    socket.on('transport-created', handleTransportCreated);
    socket.on('existing-peers', handleExistingPeers);
    socket.on(ACTIONS.ADD_PEER, handleAddPeer);
    socket.on(ACTIONS.REMOVE_PEER, handleRemovePeer);
    socket.on('new-producer', handleNewProducer);
    socket.on(ACTIONS.CHAT_MESSAGE, handleChatMessage);
    socket.on(ACTIONS.CHAT_HISTORY, handleChatHistory);
    socket.on('user-name-updated', handleUserNameUpdated);
    socket.on(ACTIONS.RAISE_HAND, handleRaiseHand);
    socket.on(ACTIONS.LOWER_HAND, handleLowerHand);
    socket.on('error', handleError);

    // Запрашиваем историю чата
    if (roomID) {
      socket.emit(ACTIONS.REQUEST_CHAT_HISTORY, { roomID });
    }

    // Сохраняем ID текущего peer (должен прийти от сервера)
    socket.on('connect', () => {
      console.log('Socket connected');
    });

    return () => {
      socket.off('transport-created', handleTransportCreated);
      socket.off('existing-peers', handleExistingPeers);
      socket.off(ACTIONS.ADD_PEER, handleAddPeer);
      socket.off(ACTIONS.REMOVE_PEER, handleRemovePeer);
      socket.off('new-producer', handleNewProducer);
      socket.off(ACTIONS.CHAT_MESSAGE, handleChatMessage);
      socket.off(ACTIONS.CHAT_HISTORY, handleChatHistory);
      socket.off('user-name-updated', handleUserNameUpdated);
      socket.off(ACTIONS.RAISE_HAND, handleRaiseHand);
      socket.off(ACTIONS.LOWER_HAND, handleLowerHand);
      socket.off('error', handleError);
    };
  }, [roomID, addChatMessage, addNewClient, updateClients, createConsumer, initSFUTransport]);

  // Очистка при размонтировании
  useEffect(() => {
    return () => {
      // Закрываем producers
      Object.values(producers.current).forEach(producer => producer.close());
      producers.current = {};
      
      // Закрываем consumers
      Object.values(consumers.current).forEach(consumer => consumer.close());
      consumers.current = {};
      
      // Закрываем транспорт
      if (sfuTransport.current) {
        sfuTransport.current.close();
        sfuTransport.current = null;
      }
      
      // Останавливаем локальные стримы
      if (localStream.current) {
        localStream.current.getTracks().forEach(track => track.stop());
        localStream.current = null;
      }
      
      if (screenStream.current) {
        screenStream.current.getTracks().forEach(track => track.stop());
        screenStream.current = null;
      }
      
      socket.emit(ACTIONS.LEAVE);
      console.log('WebRTC hook unmounted');
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
    forceSyncTracks,
    refreshDevices,
    isDeviceAvailable,
    participantSettings,
    toggleParticipantVideo,
    toggleParticipantAudio
  };
}