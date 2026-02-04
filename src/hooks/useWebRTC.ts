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

      // Останавливаем предыдущие потоки
      if (localMediaStream.current) {
        localMediaStream.current.getTracks().forEach(track => track.stop());
        localMediaStream.current = null;
      }

      let stream: MediaStream | null = null;
      
      // Всегда пытаемся получить доступ к устройствам
      const mediaConstraints: MediaStreamConstraints = {
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
      };

      try {
        stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
        console.log('Media stream obtained:', {
          audioTracks: stream.getAudioTracks().length,
          videoTracks: stream.getVideoTracks().length,
          constraints: constraints
        });
        
        // Отключаем треки, если пользователь не хочет их использовать
        if (!constraints.audio) {
          stream.getAudioTracks().forEach(track => {
            track.enabled = false;
            console.log('Audio track disabled on initialization');
          });
        }
        
        if (!constraints.video) {
          stream.getVideoTracks().forEach(track => {
            track.enabled = false;
            console.log('Video track disabled on initialization');
          });
        }
        
        await enumerateDevices();
      } catch (err) {
        console.error('Не удалось получить медиаустройства:', err);
        
        // Даже при ошибке создаем пустой поток
        stream = new MediaStream();
        
        if (err instanceof Error) {
          if (err.name === 'NotAllowedError') {
            console.warn('Пользователь отказал в доступе к устройствам');
          } else if (err.name === 'NotFoundError') {
            console.warn('Устройства не найдены');
          }
        }
      }

      setIsMediaReady(true);
      localMediaStream.current = stream;

      // Обновляем состояние медиа на основе constraints
      setMediaState(prev => ({
        ...prev,
        audio: constraints.audio,
        video: constraints.video
      }));

      // Добавляем локальное видео
      addNewClient(LOCAL_VIDEO, () => {
        const localVideo = peerMediaElements.current[LOCAL_VIDEO];
        if (localVideo && stream) {
          localVideo.srcObject = stream;
          localVideo.volume = 0;
          if (stream) {
            localVideo.play().catch(e => console.error('Local video play error:', e));
          }
        }
      });

      // Присоединяемся к комнате с именем пользователя
      if (roomID) {
        console.log('Joining room:', roomID, 'as:', userName, 'with constraints:', constraints);
        socket.emit(ACTIONS.JOIN, { 
          room: roomID, 
          userName: userName 
        } as any);
      }
      
    } catch (err) {
      console.error('Ошибка инициализации медиа:', err);
      setMediaError(err as Error);
      localMediaStream.current = new MediaStream();
      addNewClient(LOCAL_VIDEO);
      if (roomID) socket.emit(ACTIONS.JOIN, { room: roomID, userName: userName } as any);
    }
  }, [getMediaConstraints, enumerateDevices, addNewClient, roomID, mediaState.screen]);

  // Остановка демонстрации экрана
  const stopScreenShare = useCallback((): void => {
    if (screenShareStream.current) {
      screenShareStream.current.getTracks().forEach(track => {
        track.stop();
        console.log('Stopped screen share track:', track.kind, track.id);
      });
      screenShareStream.current = null;
    }

    setMediaState(prev => ({ ...prev, screen: false }));

    // Восстанавливаем оригинальные треки
    const originalStream = localMediaStream.current;
    
    Object.entries(peerConnections.current).forEach(async ([peerID, pc]) => {
      try {
        const senders = pc.getSenders();
        
        if (originalStream) {
          const originalAudioTrack = originalStream.getAudioTracks()[0];
          const originalVideoTrack = originalStream.getVideoTracks()[0];

          console.log(`Restoring original tracks for peer ${peerID}`);

          // 1. Восстанавливаем аудио (если было)
          const audioSender = senders.find(s => s.track?.kind === 'audio');
          if (audioSender && originalAudioTrack) {
            await audioSender.replaceTrack(originalAudioTrack);
            console.log(`Restored audio for peer ${peerID}`);
          }

          // 2. Восстанавливаем видео (если было)
          const videoSender = senders.find(s => s.track?.kind === 'video');
          if (videoSender && originalVideoTrack) {
            await videoSender.replaceTrack(originalVideoTrack);
            console.log(`Restored video for peer ${peerID}`);
          } else if (videoSender && !originalVideoTrack) {
            // Если видео не было, удаляем видео-отправитель
            videoSender.track?.stop();
            console.log(`Removed video sender for peer ${peerID}`);
          }
        }

        // Создаем новый offer для обновления соединения
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        });
        
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
    } else if (localVideo) {
      localVideo.srcObject = null;
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

      // Запрашиваем ТОЛЬКО видео с экрана, НИКАКОГО АУДИО
      const screenConstraints: MediaStreamConstraints = {
        video: {
          cursor: 'always',
          frameRate: { ideal: 30, max: 60 }
        } as MediaTrackConstraints,
        audio: false
      };

      const displayStream = await navigator.mediaDevices.getDisplayMedia(screenConstraints);
      console.log('Screen share stream (video only):', displayStream.getTracks());

      const screenVideoTrack = displayStream.getVideoTracks()[0];
      if (!screenVideoTrack) {
        throw new Error('Не удалось получить видео с экрана');
      }

      // Создаем новый поток только с видео с экрана
      const screenStream = new MediaStream();
      screenStream.addTrack(screenVideoTrack);
      screenShareStream.current = screenStream;

      setMediaState(prev => ({ ...prev, screen: true }));

      // Обновляем локальное видео
      const localVideo = peerMediaElements.current[LOCAL_VIDEO];
      if (localVideo) {
        localVideo.srcObject = screenStream;
        localVideo.play().catch(e => console.error('Screen share video play error:', e));
      }

      // Получаем текущие треки из локального потока
      const localAudioTrack = localMediaStream.current?.getAudioTracks()[0];
      const localVideoTrack = localMediaStream.current?.getVideoTracks()[0];

      console.log('Current tracks:', {
        localAudio: localAudioTrack?.enabled,
        localVideo: localVideoTrack?.enabled,
        screenVideo: screenVideoTrack
      });

      // Обновляем все существующие peer соединения
      const updatePromises = Object.entries(peerConnections.current).map(async ([peerID, pc]) => {
        try {
          const senders = pc.getSenders();
          console.log(`Updating peer ${peerID} for screen share, ${senders.length} senders`);

          // 1. РАБОТАЕМ С АУДИО (МИКРОФОНОМ) - НЕ ТРОГАЕМ ЕГО!
          const audioSender = senders.find(s => s.track?.kind === 'audio');
          if (localAudioTrack && audioSender) {
            // Если есть микрофон и аудио-отправитель, убеждаемся что он использует правильный трек
            if (audioSender.track?.id !== localAudioTrack.id) {
              await audioSender.replaceTrack(localAudioTrack);
              console.log(`Updated audio track for peer ${peerID}`);
            }
          } else if (localAudioTrack && !audioSender) {
            // Если есть микрофон, но нет аудио-отправителя - добавляем
            pc.addTrack(localAudioTrack, localMediaStream.current!);
            console.log(`Added audio track for peer ${peerID}`);
          }

          // 2. РАБОТАЕМ С ВИДЕО - ЗАМЕНЯЕМ НА ЭКРАН
          const videoSender = senders.find(s => s.track?.kind === 'video');
          if (screenVideoTrack) {
            if (videoSender) {
              // Заменяем существующий видео-трек на экран
              await videoSender.replaceTrack(screenVideoTrack);
              console.log(`Replaced video track with screen for peer ${peerID}`);
            } else {
              // Если нет видео-отправителя, добавляем экран
              pc.addTrack(screenVideoTrack, screenStream);
              console.log(`Added screen video track for peer ${peerID}`);
            }
          }

          // 3. КРИТИЧЕСКИ ВАЖНО: Создаем новый offer
          console.log(`Creating new offer for peer ${peerID}`);
          const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
            iceRestart: false
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

      screenVideoTrack.addEventListener('mute', () => {
        console.log('Screen share video muted');
      });
      
      screenVideoTrack.addEventListener('unmute', () => {
        console.log('Screen share video unmuted');
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

  // Установка соединения с пиром
  const setupPeerConnection = useCallback(async (
    peerID: string, 
    createOffer: boolean
  ) => {
    if (peerConnections.current[peerID]) {
      console.log(`Peer connection for ${peerID} already exists`);
      return;
    }

    console.log(`Setting up peer connection for ${peerID}, createOffer: ${createOffer}`);

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
      pcConfig.iceTransportPolicy = 'all';
    }

    const pc = new RTCPeerConnection(pcConfig);
    peerConnections.current[peerID] = pc;

    // Добавляем треки из правильных потоков
    const audioTrack = localMediaStream.current?.getAudioTracks()[0];
    const videoTrack = mediaState.screen && screenShareStream.current ? 
      screenShareStream.current.getVideoTracks()[0] : 
      localMediaStream.current?.getVideoTracks()[0];

    console.log('Adding tracks to new peer:', {
      audio: audioTrack?.enabled,
      video: videoTrack?.enabled,
      screenActive: mediaState.screen
    });

    // Добавляем аудио-трек (микрофон)
    if (audioTrack && audioTrack.enabled) {
      pc.addTrack(audioTrack, localMediaStream.current!);
      console.log(`Added audio track to peer ${peerID}`);
    }

    // Добавляем видео-трек (камера или экран)
    if (videoTrack && videoTrack.enabled) {
      const stream = mediaState.screen && screenShareStream.current ? 
        screenShareStream.current : localMediaStream.current;
      if (stream) {
        pc.addTrack(videoTrack, stream);
        console.log(`Added video track to peer ${peerID}`);
      }
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
        const activeStream = mediaState.screen && screenShareStream.current ? 
          screenShareStream.current : localMediaStream.current;
        if (activeStream && node.srcObject !== activeStream) {
          node.srcObject = activeStream;
          node.play().catch(e => console.error('Local video play error in provideMediaRef:', e));
        }
      }
    } else {
      delete peerMediaElements.current[id];
    }
  }, [participantSettings, mediaState.screen]);

  // Функция для принудительной синхронизации треков
  const forceSyncTracks = useCallback(async (): Promise<void> => {
    console.log('Force syncing all tracks...');
    
    const activeStream = mediaState.screen && screenShareStream.current ? 
      screenShareStream.current : localMediaStream.current;
    
    if (!activeStream) {
      console.log('No active stream to sync');
      return;
    }

    const audioTrack = localMediaStream.current?.getAudioTracks()[0];
    const videoTrack = activeStream.getVideoTracks()[0];

    console.log('Tracks to sync:', {
      audio: audioTrack?.enabled,
      video: videoTrack?.enabled,
      screenActive: mediaState.screen
    });

    for (const [peerID, pc] of Object.entries(peerConnections.current)) {
      try {
        const senders = pc.getSenders();
        
        // Синхронизируем аудио
        const audioSender = senders.find(s => s.track?.kind === 'audio');
        if (audioTrack && audioSender) {
          if (audioSender.track?.id !== audioTrack.id) {
            await audioSender.replaceTrack(audioTrack);
            console.log(`Synced audio for peer ${peerID}`);
          }
        } else if (audioTrack && !audioSender) {
          pc.addTrack(audioTrack, localMediaStream.current!);
          console.log(`Added audio track for peer ${peerID}`);
        }

        // Синхронизируем видео
        const videoSender = senders.find(s => s.track?.kind === 'video');
        if (videoTrack && videoSender) {
          if (videoSender.track?.id !== videoTrack.id) {
            await videoSender.replaceTrack(videoTrack);
            console.log(`Synced video for peer ${peerID}`);
          }
        } else if (videoTrack && !videoSender) {
          pc.addTrack(videoTrack, activeStream);
          console.log(`Added video track for peer ${peerID}`);
        }

        // Принудительно обновляем соединение
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        });
        
        await pc.setLocalDescription(offer);
        
        socket.emit(ACTIONS.RELAY_SDP, {
          peerID,
          sessionDescription: offer,
        });

        console.log(`Force sync completed for peer ${peerID}`);

      } catch (err) {
        console.error(`Error force syncing tracks for peer ${peerID}:`, err);
      }
    }
  }, [mediaState.screen, localMediaStream, screenShareStream]);

  // Функция обновления устройств
  const refreshDevices = useCallback(async (): Promise<void> => {
    try {
      await enumerateDevices();
    } catch (err) {
      console.error('Ошибка обновления устройств:', err);
    }
  }, [enumerateDevices]);

  // Функция проверки доступности устройства
  const isDeviceAvailable = useCallback((type: 'audio' | 'video'): boolean => {
    return mediaState[type];
  }, [mediaState]);

  // Инициализация WebRTC при изменении roomID
  useEffect(() => {
    if (roomID && !isInitialized.current) {
      isInitialized.current = true;
    }
  }, [roomID]);

  // Подписка на события Socket.IO
  useEffect(() => {
    const handleAddPeer = ({ peerID, createOffer, userNumber, userName }: { 
      peerID: string; 
      createOffer: boolean;
      userNumber?: number;
      userName?: string;
    }) => {
      console.log('Adding peer:', peerID, 'createOffer:', createOffer, 'userName:', userName);
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
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        if (isSafari) {
          await pc.setRemoteDescription(new RTCSessionDescription(sessionDescription));
        } else {
          await pc.setRemoteDescription(new RTCSessionDescription(sessionDescription));
        }
        
        console.log(`Remote description set for peer ${peerID}:`, sessionDescription.type);
        
        if (sessionDescription.type === 'offer') {
          const answerOptions: RTCAnswerOptions = {};
          
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
    const timeoutId = setTimeout(() => {
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
    forceSyncTracks,
    refreshDevices,
    isDeviceAvailable,
    participantSettings,
    toggleParticipantVideo,
    toggleParticipantAudio
  };
}