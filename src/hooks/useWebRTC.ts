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
  hasMedia: boolean;
}

interface AddPeerParams {
  peerID: string;
  createOffer: boolean;
  userNumber?: number;
  userName?: string;
  hasMedia?: boolean;
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
  participantSettings: Record<string, ParticipantSettings>;
  toggleParticipantVideo: (peerId: string) => void;
  toggleParticipantAudio: (peerId: string) => void;
};

function checkWebRTCAvailability(): WebRTCStatus {
  const errors: string[] = [];
  if (!navigator.mediaDevices) errors.push('mediaDevices недоступен');
  if (!window.RTCPeerConnection) errors.push('RTCPeerConnection недоступен');
  
  // Проверка для Apple устройств
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
  
  // ICE серверы с улучшенной поддержкой Apple
  const iceServers = useRef<RTCIceServer[]>([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    // Дополнительные STUN для Apple
    { urls: 'stun:stun.voipbuster.com:3478' },
    { urls: 'stun:stun.voipstunt.com:3478' },
    {
      urls: 'turn:numb.viagenie.ca:3478',
      username: 'webrtc@live.com',
      credential: 'muazkh'
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

  // Получить параметры медиапотока
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
      aspectRatio: { ideal: 16/9 },
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
  const initializeMedia = useCallback(async (constraints: { audio: boolean; video: boolean }, userName?: string): Promise<void> => {
    setMediaError(null);
    setIsMediaReady(false);
    
    try {
      const { isSupported, errors } = checkWebRTCAvailability();
      if (!isSupported) throw new Error(`WebRTC не поддерживается: ${errors.join(', ')}`);

      // Создаем локальный медиапоток ВСЕГДА, даже если нет устройств
      let stream: MediaStream | null = null;
      
      if (constraints.audio || constraints.video) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(getMediaConstraints(constraints));
          await enumerateDevices();
        } catch (err) {
          console.warn('Не удалось получить медиаустройства:', err);
          // Создаем пустой поток, но всё равно продолжаем
          stream = new MediaStream();
        }
      } else {
        // Для участников без устройств создаем пустой поток
        stream = new MediaStream();
      }

      setIsMediaReady(true);
      localMediaStream.current = stream;

      // Обновляем состояние медиа
      const hasAudio = constraints.audio && stream !== null && stream.getAudioTracks().length > 0;
      const hasVideo = constraints.video && stream !== null && stream.getVideoTracks().length > 0;
      
      setMediaState(prev => ({
        ...prev,
        audio: hasAudio,
        video: hasVideo
      }));

      // Добавляем локальное видео
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
        console.log('Joining room:', roomID, 'as:', userName, 'with media:', hasAudio || hasVideo);
        socket.emit(ACTIONS.JOIN, { 
          room: roomID, 
          userName: userName,
          hasMedia: hasAudio || hasVideo
        } as any);
      }
      
    } catch (err) {
      console.error('Ошибка инициализации медиа:', err);
      setMediaError(err as Error);
      // Создаем пустой поток
      localMediaStream.current = new MediaStream();
      addNewClient(LOCAL_VIDEO);
      if (roomID) {
        socket.emit(ACTIONS.JOIN, { 
          room: roomID, 
          userName: userName,
          hasMedia: false
        } as any);
      }
    }
  }, [getMediaConstraints, enumerateDevices, addNewClient, roomID]);

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
          const originalAudioTrack = originalStream.getAudioTracks()[0];

          console.log(`Restoring original tracks for peer ${peerID}`);

          // Восстанавливаем оригинальное видео
          const videoSender = senders.find(s => s.track && s.track.kind === 'video');
          if (videoSender && originalVideoTrack) {
            await videoSender.replaceTrack(originalVideoTrack);
          }

          // Восстанавливаем оригинальное аудио
          const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
          if (audioSender && originalAudioTrack) {
            await audioSender.replaceTrack(originalAudioTrack);
          }
        }

        // Создаем новый offer для обновления соединения
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        });
        
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        if (isSafari) {
          await pc.setLocalDescription(offer);
        } else {
          await pc.setLocalDescription(offer);
        }
        
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
    if (localVideo) {
      if (originalStream) {
        localVideo.srcObject = originalStream;
        localVideo.play().catch(e => console.error('Local video play error after screen share:', e));
      } else {
        localVideo.srcObject = null;
      }
    }
  }, []);

  // Демонстрация экрана - ИСПРАВЛЕННАЯ ВЕРСИЯ
  const startScreenShare = useCallback(async (): Promise<void> => {
    try {
      console.log('Starting screen share...');
      
      // Останавливаем предыдущую демонстрацию экрана
      if (screenShareStream.current) {
        screenShareStream.current.getTracks().forEach(track => track.stop());
        screenShareStream.current = null;
      }

      // Упрощенные настройки для аудио с экрана
      const screenConstraints: MediaStreamConstraints = {
        video: {
          cursor: 'always'
        } as any,
        audio: {
          // Минимальные настройки для чистого звука
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          // Убираем сложные ограничения
          sampleRate: 48000,
          channelCount: 2
        }
      };

      const stream = await navigator.mediaDevices.getDisplayMedia(screenConstraints);
      console.log('Screen share stream obtained:', stream.getTracks());

      screenShareStream.current = stream;
      setMediaState(prev => ({ ...prev, screen: true }));

      const screenVideoTrack = stream.getVideoTracks()[0];
      const screenAudioTrack = stream.getAudioTracks()[0];

      // Для аудио трека применяем упрощенные настройки
      if (screenAudioTrack) {
        try {
          // Отключаем все обработки звука
          await screenAudioTrack.applyConstraints({
            autoGainControl: false,
            noiseSuppression: false,
            echoCancellation: false
          });
        } catch (err) {
          console.warn('Не удалось применить настройки для аудио трека:', err);
        }
        
        // Упрощенная обработка состояния трека
        screenAudioTrack.addEventListener('ended', () => {
          console.log('Screen share audio ended');
        });
      }

      // Обновляем локальное видео для показа демонстрации экрана
      const localVideo = peerMediaElements.current[LOCAL_VIDEO];
      if (localVideo) {
        localVideo.srcObject = stream;
        localVideo.play().catch(e => console.error('Screen share video play error:', e));
      }

      // Обновляем все существующие peer соединения
      const updatePromises = Object.entries(peerConnections.current).map(async ([peerID, pc]) => {
        try {
          const senders = pc.getSenders();
          console.log(`Updating peer ${peerID} with screen share, ${senders.length} senders`);

          // Заменяем ВСЕ существующие треки
          for (const sender of senders) {
            if (sender.track) {
              if (sender.track.kind === 'video') {
                console.log(`Replacing video track for peer ${peerID}`);
                await sender.replaceTrack(screenVideoTrack);
              } else if (sender.track.kind === 'audio' && screenAudioTrack) {
                console.log(`Replacing audio track with screen audio for peer ${peerID}`);
                await sender.replaceTrack(screenAudioTrack);
              }
            }
          }

          // Если не было отправителя для видео, добавляем новый
          const hasVideoSender = senders.some(s => s.track?.kind === 'video');
          if (!hasVideoSender && screenVideoTrack) {
            console.log(`Adding new video track for peer ${peerID}`);
            pc.addTrack(screenVideoTrack, stream);
          }

          // Если не было отправителя для аудио, добавляем новый
          const hasAudioSender = senders.some(s => s.track?.kind === 'audio');
          if (!hasAudioSender && screenAudioTrack) {
            console.log(`Adding new audio track for peer ${peerID}`);
            pc.addTrack(screenAudioTrack, stream);
          }

          // Создаем новый offer для принудительного обновления соединения
          console.log(`Creating new offer for peer ${peerID}`);
          const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
          });
          
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
  }, [stopScreenShare]);

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

      // Если идет демонстрация экрана, обновляем только локальный поток
      if (mediaState.screen) {
        console.log('Screen share is active, updating local stream only');
        
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

        // Обновляем локальное видео только если не идет демонстрация экрана
        if (type === 'video' && !mediaState.screen) {
          const localVideo = peerMediaElements.current[LOCAL_VIDEO];
          if (localVideo && localMediaStream.current) {
            localVideo.srcObject = localMediaStream.current;
            localVideo.play().catch(e => console.error('Local video play error:', e));
          }
        }

        await enumerateDevices();
        return true;
      }

      // Если демонстрация экрана не активна, обновляем как обычно
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

      // Обновляем локальное видео
      const localVideo = peerMediaElements.current[LOCAL_VIDEO];
      if (localVideo && localMediaStream.current) {
        localVideo.srcObject = localMediaStream.current;
        localVideo.play().catch(e => console.error('Local video play error:', e));
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

  // Установка соединения с пиром - УЛУЧШЕННАЯ ВЕРСИЯ
  const setupPeerConnection = useCallback(async (
    peerID: string, 
    createOffer: boolean
  ) => {
    if (peerConnections.current[peerID]) {
      console.log(`Peer connection for ${peerID} already exists`);
      return;
    }

    console.log(`Setting up peer connection for ${peerID}, createOffer: ${createOffer}`);

    // Убедимся, что у нас есть локальный поток (даже пустой)
    if (!localMediaStream.current) {
      localMediaStream.current = new MediaStream();
    }

    const activeStream = mediaState.screen && screenShareStream.current ? 
      screenShareStream.current : localMediaStream.current;

    // Улучшенная конфигурация для Apple устройств
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const pcConfig: RTCConfiguration = {
      iceServers: iceServers.current,
      iceCandidatePoolSize: isSafari ? 5 : 10,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    };

    // Для Safari добавляем совместимые настройки
    if (isSafari) {
      // Используем более совместимую конфигурацию для Safari
      pcConfig.iceTransportPolicy = 'all';
    }

    const pc = new RTCPeerConnection(pcConfig);
    peerConnections.current[peerID] = pc;

    // Добавляем треки из активного потока, даже если они пустые
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
      console.log(`No active tracks available for peer ${peerID}, creating empty connection`);
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
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        console.log(`ICE connection ${pc.iceConnectionState} for ${peerID}, restarting ICE...`);
        pc.restartIce();
      }
    };

    // Обработка состояния соединения
    pc.onconnectionstatechange = () => {
      console.log(`Connection state for ${peerID}:`, pc.connectionState);
    };

    // Получение удаленного медиа потока
    pc.ontrack = ({ streams: [remoteStream] }) => {
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
        const offerOptions: RTCOfferOptions = {
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        };

        // Дополнительные опции для Safari
        if (isSafari) {
          offerOptions.iceRestart = true;
        }

        const offer = await pc.createOffer(offerOptions);
        
        if (isSafari) {
          // Специальная обработка для Safari
          await pc.setLocalDescription(offer);
        } else {
          await pc.setLocalDescription(offer);
        }
        
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
    // Если элемент не изменился, ничего не делаем
    if (peerMediaElements.current[id] === node) return;
    
    if (node) {
      node.autoplay = true;
      node.playsInline = true;
      node.muted = id === LOCAL_VIDEO || !participantSettings[id]?.audioEnabled;
      
      if (id !== LOCAL_VIDEO && participantSettings[id]) {
        node.style.display = participantSettings[id].videoEnabled ? 'block' : 'none';
      }
      
      peerMediaElements.current[id] = node;
      
      // Для локального видео устанавливаем поток только если он доступен и отличается
      if (id === LOCAL_VIDEO) {
        const activeStream = mediaState.screen && screenShareStream.current ? 
          screenShareStream.current : localMediaStream.current;
        if (activeStream && node.srcObject !== activeStream) {
          node.srcObject = activeStream;
          node.play().catch(e => console.error('Local video play error in provideMediaRef:', e));
        }
      }
    } else {
      // Удаляем элемент из ref если node равен null
      delete peerMediaElements.current[id];
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
    const handleAddPeer = ({ peerID, createOffer, userNumber, userName, hasMedia = true }: AddPeerParams) => {
      console.log('Adding peer:', peerID, 'createOffer:', createOffer, 'userName:', userName, 'hasMedia:', hasMedia);
      
      if (hasMedia) {
        setupPeerConnection(peerID, createOffer);
      }
      
      // ВСЕГДА добавляем клиента в список, даже без медиа
      addNewClient(peerID, () => {
        // Для участников без медиа просто добавляем в список
        if (!hasMedia) {
          console.log(`Participant ${peerID} added without media`);
        }
      });

      // Сохраняем настройки участника
      setParticipantSettings(prev => ({
        ...prev,
        [peerID]: {
          ...prev[peerID],
          hasMedia: hasMedia !== false,
          videoEnabled: true,
          audioEnabled: true
        }
      }));
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
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        if (isSafari) {
          // Специальная обработка для Safari
          await pc.setRemoteDescription(new RTCSessionDescription(sessionDescription));
        } else {
          await pc.setRemoteDescription(new RTCSessionDescription(sessionDescription));
        }
        
        console.log(`Remote description set for peer ${peerID}:`, sessionDescription.type);
        
        if (sessionDescription.type === 'offer') {
          const answerOptions: RTCAnswerOptions = {};
          // Для Safari используем стандартные настройки
          
          const answer = await pc.createAnswer(answerOptions);
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
      }
      
      // Удаляем медиа элемент
      const element = peerMediaElements.current[peerID];
      if (element) {
        element.srcObject = null;
        delete peerMediaElements.current[peerID];
      }
      
      // Удаляем из списка клиентов
      updateClients(list => list.filter(c => c !== peerID));
      
      // Удаляем из настроек
      setParticipantSettings(prev => {
        const newSettings = { ...prev };
        delete newSettings[peerID];
        return newSettings;
      });
      
      console.log(`Peer ${peerID} removed`);
    };

    const handleChatMessage = (msg: {
      id: string;
      message: string;
      sender: string;
      timestamp: string;
      userNumber?: number;
      userName?: string;
    }) => {
      addChatMessage({
        id: msg.id,
        text: msg.message,
        isLocal: msg.sender === socket.id,
        timestamp: new Date(msg.timestamp).toLocaleTimeString(),
        sender: msg.sender
      });
    };

    const handleUserNameUpdated = ({ peerID, userName }: { peerID: string; userName: string }) => {
      console.log(`User ${peerID} updated name to ${userName}`);
      // Обновление имени будет обрабатываться в Room компоненте
    };

    const handlers = {
      [ACTIONS.ADD_PEER]: handleAddPeer,
      [ACTIONS.SESSION_DESCRIPTION]: handleSessionDescription,
      [ACTIONS.ICE_CANDIDATE]: handleIceCandidate,
      [ACTIONS.REMOVE_PEER]: handleRemovePeer,
      [ACTIONS.CHAT_MESSAGE]: handleChatMessage,
      'user-name-updated': handleUserNameUpdated
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
    const timeoutId = setTimeout(() => {
      clients.forEach(clientId => {
        if (clientId !== LOCAL_VIDEO && !participantSettings[clientId]) {
          setParticipantSettings(prev => ({
            ...prev,
            [clientId]: {
              videoEnabled: true,
              audioEnabled: true,
              hasMedia: true
            }
          }));
        }
      });
    }, 100);
    
    return () => clearTimeout(timeoutId);
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