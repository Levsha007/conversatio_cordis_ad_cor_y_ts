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

interface QualitySettings {
  videoBitrate: number;
  audioBitrate: number;
  videoResolution: string;
  frameRate: number;
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
  qualitySettings: QualitySettings;
  updateQualitySettings: (settings: Partial<QualitySettings>) => void;
  applyQualitySettings: () => Promise<void>;
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

  // Новые состояния для управления участниками и качеством
  const [participantSettings, setParticipantSettings] = useState<Record<string, ParticipantSettings>>({});
  const [qualitySettings, setQualitySettings] = useState<QualitySettings>({
    videoBitrate: 1500000, // 1.5 Mbps
    audioBitrate: 64000,   // 64 kbps
    videoResolution: '720p',
    frameRate: 30
  });

  // Рефы для хранения данных между рендерами
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
  const localMediaStream = useRef<MediaStream | null>(null);
  const screenShareStream = useRef<MediaStream | null>(null);
  const peerMediaElements = useRef<Record<string, HTMLVideoElement | null>>({
    [LOCAL_VIDEO]: null
  });
  const chatMessages = useRef<ChatMessage[]>([]); // Храним все сообщения чата
  const iceServers = useRef<RTCIceServer[]>([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]);
  const isInitialized = useRef(false);

  // Функция добавления нового клиента
  const addNewClient = useCallback((newClient: string, cb?: () => void) => {
    updateClients(list => {
      if (!list.includes(newClient)) return [...list, newClient];
      return list;
    }, cb);
  }, [updateClients]);

  // Получить параметры медиапотока - ИСПРАВЛЕННАЯ ВЕРСИЯ (без нестандартных свойств)
  const getMediaConstraints = useCallback((constraints: { audio: boolean; video: boolean }): MediaStreamConstraints => ({
    audio: constraints.audio ? {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 2, // Стерео звук вместо моно
      sampleRate: 48000, // Высокая частота дискретизации
      sampleSize: 16, // Высокое качество
    } : false,
    video: constraints.video ? {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 }
    } : false
  }), []);

  // Перечисление доступных устройств
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

  // Инициализация медиапотока - ИСПРАВЛЕННАЯ ВЕРСИЯ
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
        stream = await navigator.mediaDevices.getUserMedia(getMediaConstraints(constraints));
        await enumerateDevices();
      }

      setIsMediaReady(true);
      localMediaStream.current = stream;
      
      // Обновляем состояние медиа
      setMediaState(prev => ({
        ...prev,
        audio: constraints.audio,
        video: constraints.video
      }));

      // Всегда добавляем локальное видео, даже если нет устройств
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
      if (roomID) socket.emit(ACTIONS.JOIN, { room: roomID });
      
    } catch (err) {
      console.error('Ошибка инициализации медиа:', err);
      setMediaError(err as Error);
      // Даже при ошибке добавляем локальное видео
      addNewClient(LOCAL_VIDEO);
      if (roomID) socket.emit(ACTIONS.JOIN, { room: roomID });
    }
  }, [getMediaConstraints, enumerateDevices, addNewClient, roomID]);

  // Демонстрация экрана - ИСПРАВЛЕННАЯ ВЕРСИЯ (без нестандартных свойств)
  const startScreenShare = useCallback(async (): Promise<void> => {
    try {
      console.log('Starting screen share...');
      
      // Останавливаем предыдущую демонстрацию экрана
      if (screenShareStream.current) {
        screenShareStream.current.getTracks().forEach(track => track.stop());
        screenShareStream.current = null;
      }

      // Получаем поток экрана с улучшенными настройками звука
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'window'
        } as any,
        audio: {
          // Улучшенные настройки звука для демонстрации экрана
          echoCancellation: false, // Для системного звука эхоподавление может мешать
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
          sampleRate: 48000,
          sampleSize: 16,
        }
      });

      console.log('Screen share stream obtained:', stream.getTracks());

      screenShareStream.current = stream;

      // Обновляем состояние
      setMediaState(prev => ({ ...prev, screen: true }));

      // Получаем треки из потока экрана
      const videoTracks = stream.getVideoTracks();
      const audioTracks = stream.getAudioTracks();

      console.log('Video tracks:', videoTracks.length, 'Audio tracks:', audioTracks.length);

      // Настраиваем битрейт для видео для лучшего качества
      if (videoTracks.length > 0) {
        const videoTrack = videoTracks[0];
        // Пытаемся установить высокий битрейт для лучшего качества
        try {
          const capabilities = videoTrack.getCapabilities();
          const settings = videoTrack.getSettings();
          
          // Если поддерживается, устанавливаем ограничения для лучшего качества
          if (capabilities && 'width' in capabilities) {
            await videoTrack.applyConstraints({
              width: { ideal: 1920 },
              height: { ideal: 1080 },
              frameRate: { ideal: 30 }
            });
          }
        } catch (err) {
          console.warn('Could not apply video constraints for screen share:', err);
        }
      }

      // Обновляем локальный видеоэлемент для демонстрации экрана
      const localVideo = peerMediaElements.current[LOCAL_VIDEO];
      if (localVideo) {
        localVideo.srcObject = stream;
        localVideo.play().catch(e => console.error('Screen share video play error:', e));
      }

      // Для каждого peer соединения заменяем треки
      const updatePromises = Object.entries(peerConnections.current).map(async ([peerID, pc]) => {
        try {
          console.log(`Updating tracks for peer: ${peerID}`);
          const senders = pc.getSenders();
          
          // Находим существующие сендеры
          const videoSender = senders.find(s => s.track && s.track.kind === 'video');
          const audioSender = senders.find(s => s.track && s.track.kind === 'audio');

          // Заменяем или добавляем видео трек
          if (videoTracks.length > 0) {
            if (videoSender) {
              console.log('Replacing video track');
              await videoSender.replaceTrack(videoTracks[0]);
              
              // Пытаемся настроить параметры кодирования для лучшего качества
              try {
                const params = videoSender.getParameters();
                if (!params.encodings) {
                  params.encodings = [{}];
                }
                // Устанавливаем высокий битрейт для лучшего качества
                params.encodings[0].maxBitrate = 2500000; // 2.5 Mbps
                params.encodings[0].priority = 'high';
                params.encodings[0].networkPriority = 'high';
                await videoSender.setParameters(params);
              } catch (err) {
                console.warn('Could not set video encoding parameters:', err);
              }
            } else {
              console.log('Adding new video track');
              pc.addTrack(videoTracks[0], stream);
            }
          }

          // Заменяем или добавляем аудио трек
          if (audioTracks.length > 0) {
            if (audioSender) {
              console.log('Replacing audio track');
              await audioSender.replaceTrack(audioTracks[0]);
              
              // Пытаемся настроить параметры кодирования для лучшего качества звука
              try {
                const params = audioSender.getParameters();
                if (!params.encodings) {
                  params.encodings = [{}];
                }
                // Устанавливаем высокий битрейт для звука
                params.encodings[0].maxBitrate = 128000; // 128 kbps
                params.encodings[0].priority = 'high';
                await audioSender.setParameters(params);
              } catch (err) {
                console.warn('Could not set audio encoding parameters:', err);
              }
            } else {
              console.log('Adding new audio track');
              pc.addTrack(audioTracks[0], stream);
            }
          }

          // Создаем новый offer для синхронизации изменений
          console.log('Creating new offer for screen share');
          const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
          });
          await pc.setLocalDescription(offer);
          
          socket.emit(ACTIONS.RELAY_SDP, {
            peerID,
            sessionDescription: offer,
          });

          console.log(`Screen share update completed for peer: ${peerID}`);
        } catch (err) {
          console.error(`Error updating screen share for peer ${peerID}:`, err);
        }
      });

      await Promise.all(updatePromises);

      // Обработчик окончания демонстрации экрана (пользователь нажал "Stop Share")
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        console.log('Screen share ended by user');
        stopScreenShare();
      });

      console.log('Screen share started successfully');
    } catch (err) {
      console.error('Ошибка демонстрации экрана:', err);
      setMediaError(err as Error);
      throw err;
    }
  }, []);

  // Остановка демонстрации экрана - ИСПРАВЛЕННАЯ ВЕРСИЯ
  const stopScreenShare = useCallback((): void => {
    console.log('Stopping screen share...');
    
    if (screenShareStream.current) {
      screenShareStream.current.getTracks().forEach(track => {
        track.stop();
        console.log('Stopped screen share track:', track.kind);
      });
      screenShareStream.current = null;
    }

    setMediaState(prev => ({ ...prev, screen: false }));

    // Восстанавливаем оригинальные треки из камеры/микрофона
    const originalStream = localMediaStream.current;
    
    // Для каждого peer соединения восстанавливаем оригинальные треки
    Object.entries(peerConnections.current).forEach(async ([peerID, pc]) => {
      try {
        console.log(`Restoring original tracks for peer: ${peerID}`);
        const senders = pc.getSenders();
        
        if (originalStream) {
          const originalVideoTracks = originalStream.getVideoTracks();
          const originalAudioTracks = originalStream.getAudioTracks();

          // Восстанавливаем видео трек
          const videoSender = senders.find(s => s.track && s.track.kind === 'video');
          if (videoSender && originalVideoTracks.length > 0) {
            console.log('Restoring original video track');
            await videoSender.replaceTrack(originalVideoTracks[0]);
          } else if (videoSender) {
            // Если нет оригинального видео, останавливаем видео
            await videoSender.replaceTrack(null);
          }

          // Восстанавливаем аудио трек
          const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
          if (audioSender && originalAudioTracks.length > 0) {
            console.log('Restoring original audio track');
            await audioSender.replaceTrack(originalAudioTracks[0]);
          } else if (audioSender) {
            // Если нет оригинального аудио, останавливаем аудио
            await audioSender.replaceTrack(null);
          }

          // Создаем новый offer для синхронизации изменений
          console.log('Creating new offer after stopping screen share');
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          
          socket.emit(ACTIONS.RELAY_SDP, {
            peerID,
            sessionDescription: offer,
          });
        } else {
          // Если нет оригинального потока, останавливаем все треки
          console.log('No original stream, stopping all tracks');
          senders.forEach(sender => {
            if (sender.track) {
              sender.replaceTrack(null);
            }
          });

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          
          socket.emit(ACTIONS.RELAY_SDP, {
            peerID,
            sessionDescription: offer,
          });
        }

        console.log(`Original tracks restored for peer: ${peerID}`);
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

    console.log('Screen share stopped successfully');
  }, []);

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
      
      // Повторная инициализация с текущими настройками
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

  // Переключение медиаустройства
  const switchMediaDevice = useCallback(async (
    type: 'audio' | 'video',
    deviceId?: string
  ): Promise<boolean> => {
    try {
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

      Object.values(peerConnections.current).forEach(pc => {
        const senders = pc.getSenders();
        senders.forEach(sender => {
          if (sender.track?.kind === type) {
            const newTrack = newTracks.find(t => t.kind === type);
            if (newTrack) sender.replaceTrack(newTrack).catch(e => {
              console.error('Ошибка при замене трека:', e);
            });
          }
        });
      });

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

  // Функции управления участниками
  const toggleParticipantVideo = useCallback((peerId: string) => {
    setParticipantSettings(prev => ({
      ...prev,
      [peerId]: {
        ...prev[peerId],
        videoEnabled: !(prev[peerId]?.videoEnabled ?? true)
      }
    }));

    // Обновляем видео элемент
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

    // Обновляем видео элемент
    const videoElement = peerMediaElements.current[peerId];
    if (videoElement) {
      videoElement.muted = !participantSettings[peerId]?.audioEnabled;
    }
  }, [participantSettings]);

  // Функции управления качеством
  const updateQualitySettings = useCallback((settings: Partial<QualitySettings>) => {
    setQualitySettings(prev => ({ ...prev, ...settings }));
  }, []);

  const applyQualitySettings = useCallback(async (): Promise<void> => {
    try {
      console.log('Applying quality settings:', qualitySettings);

      // Применяем настройки ко всем активным peer соединениям
      Object.entries(peerConnections.current).forEach(async ([peerId, pc]) => {
        const senders = pc.getSenders();
        
        for (const sender of senders) {
          if (sender.track) {
            try {
              const params = sender.getParameters();
              
              if (!params.encodings) {
                params.encodings = [{}];
              }

              if (sender.track.kind === 'video') {
                // Настройки видео
                params.encodings[0].maxBitrate = qualitySettings.videoBitrate;
                params.encodings[0].scaleResolutionDownBy = 
                  qualitySettings.videoResolution === '1080p' ? 1 :
                  qualitySettings.videoResolution === '720p' ? 1.5 :
                  qualitySettings.videoResolution === '480p' ? 2 : 3;
                
                // Пытаемся применить ограничения к треку
                if (sender.track.kind === 'video') {
                  await sender.track.applyConstraints({
                    width: { ideal: 
                      qualitySettings.videoResolution === '1080p' ? 1920 :
                      qualitySettings.videoResolution === '720p' ? 1280 :
                      qualitySettings.videoResolution === '480p' ? 854 : 640
                    },
                    height: { ideal: 
                      qualitySettings.videoResolution === '1080p' ? 1080 :
                      qualitySettings.videoResolution === '720p' ? 720 :
                      qualitySettings.videoResolution === '480p' ? 480 : 360
                    },
                    frameRate: { ideal: qualitySettings.frameRate }
                  });
                }
              } else if (sender.track.kind === 'audio') {
                // Настройки аудио
                params.encodings[0].maxBitrate = qualitySettings.audioBitrate;
              }

              await sender.setParameters(params);
              console.log(`Quality settings applied for ${sender.track.kind} track`);
            } catch (err) {
              console.warn(`Could not apply quality settings for ${sender.track.kind}:`, err);
            }
          }
        }

        // Пересоздаем offer с новыми настройками
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit(ACTIONS.RELAY_SDP, {
            peerID: peerId,
            sessionDescription: offer,
          });
        } catch (err) {
          console.warn('Could not recreate offer with new quality settings:', err);
        }
      });

      console.log('Quality settings applied successfully');
    } catch (err) {
      console.error('Error applying quality settings:', err);
    }
  }, [qualitySettings]);

  // Установка соединения с пиром
  const setupPeerConnection = useCallback(async (
    peerID: string, 
    createOffer: boolean
  ) => {
    if (peerConnections.current[peerID]) return;

    const pc = new RTCPeerConnection({ iceServers: iceServers.current });
    peerConnections.current[peerID] = pc;

    // Добавляем треки из активного потока в новое соединение
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

    // Получение удаленного медиа потока
    pc.ontrack = ({ streams: [remoteStream] }) => {
      if (!remoteStream) return;
      addNewClient(peerID, () => {
        const element = peerMediaElements.current[peerID];
        if (element) {
          element.srcObject = remoteStream;
          element.play().catch(e => console.error('Remote video play error:', e));
        }
      });
    };

    // Создание оффера, если требуется
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
      
      // Применяем настройки отображения видео
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
      // Не инициализируем медиа автоматически - ждем выбора пользователя
    }
  }, [roomID]);

  // Инициализация настроек участников при добавлении
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

  // Применяем настройки качества при изменении
  useEffect(() => {
    if (Object.keys(peerConnections.current).length > 0) {
      applyQualitySettings();
    }
  }, [qualitySettings, applyQualitySettings]);

  // Подписка на события Socket.IO
  useEffect(() => {
    const handleAddPeer = ({ 
      peerID, 
      createOffer 
    }: { 
      peerID: string; 
      createOffer: boolean;
      userNumber?: number;
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
      if (pc) pc.addIceCandidate(new RTCIceCandidate(iceCandidate)).catch(err => console.error('Ошибка addIceCandidate:', err));
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
      userNumber?: number;
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
    // Новые функции
    participantSettings,
    toggleParticipantVideo,
    toggleParticipantAudio,
    qualitySettings,
    updateQualitySettings,
    applyQualitySettings
  };
}