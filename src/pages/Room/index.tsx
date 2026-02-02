import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import useWebRTC, { LOCAL_VIDEO } from '../../hooks/useWebRTC';
import socket from '../../socket';
import { ACTIONS } from '../../socket/actions';
import styles from './Room.module.css';

/**
 * Интерфейс для описания параметров расположения видео элементов
 */
interface LayoutItem {
  width: string;
  height: string;
}

/**
 * Интерфейс для сообщений чата
 */
interface ChatMessage {
  id: string;
  text: string;
  isLocal: boolean;
  timestamp: string;
  sender: string;
  userName?: string;
}

/**
 * Интерфейс для настроек устройств
 */
interface DeviceSettings {
  audio: boolean;
  video: boolean;
}

/**
 * Интерфейс для участника
 */
interface Participant {
  id: string;
  name: string;
  isOnline: boolean;
  hasMedia?: boolean;
  isScreenSharing?: boolean;
}

/**
 * Кастомный хук для определения мобильного устройства
 */
const useIsMobile = (): boolean => {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const checkIsMobile = () => setIsMobile(window.innerWidth <= 767);
    checkIsMobile();
    window.addEventListener('resize', checkIsMobile);
    return () => window.removeEventListener('resize', checkIsMobile);
  }, []);
  return isMobile;
};

/**
 * Кастомный хук для синхронизации вкладок
 */
const useTabSync = (roomId: string) => {
  const navigate = useNavigate();
  useEffect(() => {
    if (!roomId) return;

    const tabId = sessionStorage.getItem(`vc_tab_${roomId}`) || Date.now().toString();
    sessionStorage.setItem(`vc_tab_${roomId}`, tabId);

    const channel = new BroadcastChannel(`vc_${roomId}`);
    const handleMessage = (e: MessageEvent) => {
      if (e.data.type === 'TAB_ACTIVE' && e.data.tabId !== tabId) {
        socket.emit(ACTIONS.LEAVE);
        navigate('/', { replace: true });
      }
    };
    channel.addEventListener('message', handleMessage);

    channel.postMessage({ type: 'TAB_ACTIVE', tabId });

    return () => {
      channel.removeEventListener('message', handleMessage);
      channel.close();
      sessionStorage.removeItem(`vc_tab_${roomId}`);
    };
  }, [roomId, navigate]);
};

/**
 * Компонент выбора устройств перед входом в комнату
 */
const DeviceSelection: React.FC<{
  onJoin: (settings: DeviceSettings, userName: string) => void;
}> = ({ onJoin }) => {
  const [name, setName] = useState('');
  // Устройства всегда включены по умолчанию
  const [initialSettings, setInitialSettings] = useState<DeviceSettings>({
    audio: true,
    video: true
  });

  const handleJoin = () => {
    // Всегда передаем true для устройств, но начальные настройки (включены/выключены)
    onJoin(initialSettings, name.trim() || `Участник ${Math.floor(Math.random() * 1000) + 1}`);
  };

  const toggleSetting = (type: keyof DeviceSettings) => {
    setInitialSettings(prev => ({
      ...prev,
      [type]: !prev[type]
    }));
  };

  return (
    <div className={styles.deviceSelectionOverlay}>
      <div className={styles.deviceSelectionModal}>
        <h2>Настройка перед входом</h2>
        
        {/* Поле для ввода имени */}
        <div className={styles.nameInputSection}>
          <label className={styles.nameLabel}>Ваше имя (необязательно):</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Введите ваше имя"
            className={styles.nameInput}
            maxLength={50}
          />
          <div className={styles.nameHint}>
            Если не указать имя, будет сгенерировано автоматически
          </div>
        </div>

        <p>Настройте начальное состояние устройств:</p>
        
        <div className={styles.deviceOptions}>
          <div className={styles.deviceOptionRow}>
            <div className={styles.deviceStatus}>
              <span className={styles.deviceIcon}>🎤</span>
              <span className={styles.deviceName}>Микрофон</span>
              <span className={`${styles.deviceState} ${initialSettings.audio ? styles.deviceOn : styles.deviceOff}`}>
                {initialSettings.audio ? 'Вкл' : 'Выкл'}
              </span>
            </div>
            <button
              className={`${styles.toggleButton} ${initialSettings.audio ? styles.toggleOn : styles.toggleOff}`}
              onClick={() => toggleSetting('audio')}
              type="button"
            >
              <div className={styles.toggleSlider} />
            </button>
          </div>

          <div className={styles.deviceOptionRow}>
            <div className={styles.deviceStatus}>
              <span className={styles.deviceIcon}>📹</span>
              <span className={styles.deviceName}>Камера</span>
              <span className={`${styles.deviceState} ${initialSettings.video ? styles.deviceOn : styles.deviceOff}`}>
                {initialSettings.video ? 'Вкл' : 'Выкл'}
              </span>
            </div>
            <button
              className={`${styles.toggleButton} ${initialSettings.video ? styles.toggleOn : styles.toggleOff}`}
              onClick={() => toggleSetting('video')}
              type="button"
            >
              <div className={styles.toggleSlider} />
            </button>
          </div>
        </div>

        <div className={styles.deviceInfo}>
          <p>💡 Для изменения настроек перезагрузите страницу</p>
        </div>

        <div className={styles.deviceSelectionButtons}>
          <button
            onClick={handleJoin}
            className={styles.joinButton}
          >
            Войти в комнату
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Функция расчета расположения видео элементов (обычный режим)
 */
function calculateLayout(
  clientsCount: number = 1, 
  isMobile: boolean, 
  fullscreenParticipant: string | null = null
): LayoutItem[] {
  if (fullscreenParticipant) {
    return Array(clientsCount).fill({
      width: '100%',
      height: '100%'
    });
  }

  if (isMobile) {
    // Для мобильных устройств
    if (clientsCount === 1) {
      return [{ width: '100%', height: '100%' }];
    } else if (clientsCount === 2) {
      return [
        { width: '100%', height: '50%' },
        { width: '100%', height: '50%' }
      ];
    } else if (clientsCount === 3) {
      return [
        { width: '100%', height: '50%' },
        { width: '50%', height: '50%' },
        { width: '50%', height: '50%' }
      ];
    } else {
      return Array(clientsCount).fill({
        width: clientsCount <= 2 ? '100%' : '50%',
        height: `${100 / Math.ceil(clientsCount / 2)}%`
      });
    }
  }

  // Для десктопа - оригинальная логика
  const pairs = Array.from({ length: clientsCount }).reduce<Array<Array<undefined>>>(
    (acc, _, index, arr) => {
      if (index % 2 === 0) acc.push(arr.slice(index, index + 2) as undefined[]);
      return acc;
    },
    []
  );

  return pairs.map((row, index, arr) => {
    const height = `${100 / pairs.length}%`;
    if (index === arr.length - 1 && row.length === 1) {
      return [{ width: '100%', height }];
    }
    return row.map(() => ({ width: '50%', height }));
  }).flat();
}

/**
 * Функция расчета расположения с поддержкой демонстрации экрана
 */
function calculateLayoutWithScreenShare(
  clients: string[],
  isMobile: boolean,
  screenShareParticipant: string | null,
  fullscreenParticipant: string | null = null
): { clientID: string; layout: LayoutItem; isScreenShare: boolean }[] {
  // Полноэкранный режим имеет приоритет
  if (fullscreenParticipant) {
    return clients.map(client => ({
      clientID: client,
      layout: { width: '100%', height: '100%' },
      isScreenShare: client === screenShareParticipant
    }));
  }

  // Если есть демонстрация экрана
  const screenShareClient = screenShareParticipant && clients.includes(screenShareParticipant) 
    ? screenShareParticipant 
    : null;
  
  if (screenShareClient) {
    const otherClients = clients.filter(client => client !== screenShareClient);
    
    if (isMobile) {
      // На мобильных: демонстрация экрана на весь экран, другие снизу
      return clients.map(client => {
        if (client === screenShareClient) {
          return {
            clientID: client,
            layout: { width: '100%', height: '70%' },
            isScreenShare: true
          };
        } else {
          // Распределяем оставшихся участников в ряд снизу
          const index = otherClients.indexOf(client);
          const totalOthers = otherClients.length;
          return {
            clientID: client,
            layout: { 
              width: `${100 / Math.min(totalOthers, 3)}%`, 
              height: '30%' 
            },
            isScreenShare: false
          };
        }
      });
    } else {
      // На десктопе: демонстрация экрана слева большая, остальные справа в столбик
      return clients.map(client => {
        if (client === screenShareClient) {
          return {
            clientID: client,
            layout: { width: '70%', height: '100%' },
            isScreenShare: true
          };
        } else {
          const index = otherClients.indexOf(client);
          const totalOthers = otherClients.length;
          return {
            clientID: client,
            layout: { 
              width: '30%', 
              height: `${100 / Math.min(totalOthers, 4)}%` 
            },
            isScreenShare: false
          };
        }
      });
    }
  }
  
  // Обычный режим (без демонстрации экрана)
  const layout = calculateLayout(clients.length, isMobile, fullscreenParticipant);
  return clients.map((client, index) => ({
    clientID: client,
    layout: layout[index],
    isScreenShare: false
  }));
}

/**
 * Основной компонент комнаты видеоконференции
 */
const Room: React.FC = () => {
  const navigate = useNavigate();
  const { id: roomID } = useParams<{ id: string }>();
  useTabSync(roomID || '');
  const isMobile = useIsMobile();

  // Использование кастомного хука WebRTC
  const {
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
    refreshDevices,
    participantSettings,
    toggleParticipantVideo,
    toggleParticipantAudio
  } = useWebRTC(roomID || '');

  // Состояния компонента
  const [showDeviceSelection, setShowDeviceSelection] = useState(true);
  const [devicesInitialized, setDevicesInitialized] = useState(false);
  const [fullscreenParticipant, setFullscreenParticipant] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const errorShown = useRef(false);
  const [messageInput, setMessageInput] = useState('');
  const [showChat, setShowChat] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isCopied, setIsCopied] = useState(false);
  const copyTimeout = useRef<number | null>(null);
  const [userNumbers, setUserNumbers] = useState<Record<string, number>>({});
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [userName, setUserName] = useState('');
  const [showNameInput, setShowNameInput] = useState(false);
  const [notifications, setNotifications] = useState<Array<{
    id: string;
    message: string;
    type: 'join' | 'leave' | 'system';
    timestamp: string;
  }>>([]);
  const [showParticipants, setShowParticipants] = useState(false);
  const [allParticipants, setAllParticipants] = useState<Participant[]>([]);

  // Определяем, кто ведет демонстрацию экрана
  const screenShareParticipant = useMemo(() => {
    // Проверяем локальную демонстрацию экрана
    if (mediaState.screen) {
      return LOCAL_VIDEO;
    }
    
    // Проверяем удаленную демонстрацию экрана
    for (const clientID of clients) {
      if (clientID !== LOCAL_VIDEO) {
        const stream = peerMediaElements.current[clientID]?.srcObject as MediaStream;
        if (stream && stream.getVideoTracks().some(track => 
          track.label.toLowerCase().includes('screen') || 
          track.label.toLowerCase().includes('desktop') ||
          track.label.toLowerCase().includes('window')
        )) {
          return clientID;
        }
      }
    }
    
    return null;
  }, [clients, mediaState.screen, peerMediaElements]);

  // Используем новый расчет лейаута с поддержкой демонстрации экрана
  const videoLayouts = useMemo(() => 
    calculateLayoutWithScreenShare(
      clients, 
      isMobile, 
      screenShareParticipant,
      fullscreenParticipant
    ),
    [clients, isMobile, screenShareParticipant, fullscreenParticipant]
  );

  // Обновляем список участников с учетом всех данных
  const participantsList = useMemo(() => {
    return allParticipants.map(participant => {
      // Упрощаем логику: не показываем информацию о медиа
      const isScreenSharing = participant.id === screenShareParticipant;
      
      return {
        ...participant,
        isLocal: participant.id === socket.id,
        isScreenSharing
      };
    });
  }, [allParticipants, screenShareParticipant]);

  // Стабильные ссылки на обработчики
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setMessageInput(e.target.value);
  }, []);

  /**
   * Получение отображаемого имени пользователя
   */
  const getUserDisplayName = useCallback((userId: string): string => {
    if (userId === LOCAL_VIDEO) return userName || 'Вы';
    return userNames[userId] || (userNumbers[userId] ? `Участник ${userNumbers[userId]}` : `Участник`);
  }, [userName, userNumbers, userNames]);

  /**
   * Получение метки отправителя сообщения
   */
  const getSenderLabel = useCallback((senderId: string): string => {
    if (senderId === socket.id) return userName || 'Вы';
    return userNames[senderId] || (userNumbers[senderId] ? `Участник ${userNumbers[senderId]}` : `Участник`);
  }, [userName, userNumbers, userNames]);

  const handleSendMessage = useCallback(() => {
    const trimmedMessage = messageInput.trim();
    if (trimmedMessage && roomID) {
      const messageId = `${socket.id}-${Date.now()}`;
      const newMessage: ChatMessage = {
        id: messageId,
        text: trimmedMessage,
        isLocal: true,
        timestamp: new Date().toLocaleTimeString(),
        sender: socket.id || 'unknown',
        userName: userName
      };
      
      if (addChatMessage) {
        addChatMessage(newMessage);
      }
      setMessages(prev => [...prev, newMessage]);
      setMessageInput('');
      
      // Отправляем сообщение с именем пользователя
      socket.emit(ACTIONS.CHAT_MESSAGE, {
        roomID,
        message: trimmedMessage,
        id: messageId,
        timestamp: new Date().toISOString(),
        userName: userName
      });
    }
  }, [messageInput, roomID, addChatMessage, userName]);

  const handleKeyPress = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSendMessage();
    }
  }, [handleSendMessage]);

  // Инициализация сообщений при монтировании
  useEffect(() => {
    if (getChatMessages) {
      setMessages(getChatMessages());
    }
  }, [getChatMessages]);

  /**
   * Обработчик выбора устройств
   */
  const handleDeviceSelection = async (settings: DeviceSettings, name: string) => {
    setShowDeviceSelection(false);
    setUserName(name);
    setUserNames(prev => ({ ...prev, [socket.id as string]: name }));
    await initializeMedia(settings, name);
    setDevicesInitialized(true);
  };

  /**
   * Переключение полноэкранного режима для участника
   */
  const toggleFullscreen = useCallback((clientID: string) => {
    if (fullscreenParticipant === clientID) {
      setFullscreenParticipant(null);
      // Выход из полноэкранного режима
      if (document.fullscreenElement) {
        document.exitFullscreen();
      }
    } else {
      setFullscreenParticipant(clientID);
      
      // Вход в полноэкранный режим
      const videoWrapper = document.querySelector(`[data-client-id="${clientID}"]`) as HTMLElement;
      if (videoWrapper && videoWrapper.requestFullscreen) {
        videoWrapper.requestFullscreen().catch(err => {
          console.error('Ошибка при входе в полноэкранный режим:', err);
        });
      }
    }
  }, [fullscreenParticipant]);

  /**
   * Обработчик выхода из полноэкранного режима
   */
  const handleExitFullscreen = useCallback(() => {
    setFullscreenParticipant(null);
    if (document.fullscreenElement) {
      document.exitFullscreen();
    }
  }, []);

  /**
   * Копирование ссылки на комнату в буфер обмена
   */
  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setIsCopied(true);
      if (copyTimeout.current) window.clearTimeout(copyTimeout.current);
      copyTimeout.current = window.setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Ошибка при копировании ссылки:', err);
    }
  }, []);

  /**
   * Выход из комнаты с подтверждением
   */
  const handleLeaveRoom = useCallback(() => {
    if (window.confirm('Вы уверены, что хотите выйти из комнаты?')) {
      navigate('/');
    }
  }, [navigate]);

  /**
   * Повторная попытка подключения
   */
  const handleRetry = useCallback(async () => {
    setRetryCount(prev => prev + 1);
    errorShown.current = false;
    await reconnect();
  }, [reconnect]);

  /**
   * Запуск демонстрации экрана
   */
  const handleStartScreenShare = useCallback(async () => {
    try {
      await startScreenShare();
    } catch (err) {
      console.error('Ошибка демонстрации экрана:', err);
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError') {
          alert('Разрешение на демонстрацию экрана было отклонено');
        } else {
          alert('Не удалось начать демонстрацию экрана: ' + err.message);
        }
      } else {
        alert('Не удалось начать демонстрацию экрана');
      }
    }
  }, [startScreenShare]);

  /**
   * Остановка демонстрации экрана
   */
  const handleStopScreenShare = useCallback(() => {
    stopScreenShare();
  }, [stopScreenShare]);

  /**
   * Обработчик выбора файла
   */
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && roomID) {
      const fileId = `${socket.id}-${Date.now()}`;
      const fileNameWithIcon = `📄 ${file.name}`;
      const newMessage: ChatMessage = {
        id: fileId,
        text: fileNameWithIcon,
        isLocal: true,
        timestamp: new Date().toLocaleTimeString(),
        sender: socket.id || 'unknown',
        userName: userName
      };
      
      if (addChatMessage) {
        addChatMessage(newMessage);
      }
      setMessages(prev => [...prev, newMessage]);

      socket.emit(ACTIONS.CHAT_MESSAGE, {
        roomID,
        message: fileNameWithIcon,
        id: fileId,
        timestamp: new Date().toISOString(),
        userName: userName
      });
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [roomID, addChatMessage, userName]);

  /**
   * Функция обновления имени
   */
  const handleSaveName = useCallback(() => {
    if (userName.trim()) {
      const newName = userName.trim();
      setUserName(newName);
      
      // Отправляем обновление имени на сервер
      socket.emit('update-user-name', {
        roomID: roomID || '',
        userName: newName
      });
      
      // Обновляем локально
      setUserNames(prev => ({ ...prev, [socket.id as string]: newName }));
      setShowNameInput(false);
      
      // Показываем уведомление
      setNotifications(prev => [...prev, {
        id: `name-updated-${Date.now()}`,
        message: `Имя изменено на "${newName}"`,
        type: 'system',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }]);
    }
  }, [userName, roomID]);

  // Автопрокрутка чата к последнему сообщению
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  // Обработчик события выхода из полноэкранного режима
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        setFullscreenParticipant(null);
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Подписка на события Socket.IO для обновления номеров пользователей
  useEffect(() => {
    const handleAddPeer = ({ peerID, createOffer, userNumber, userName: peerUserName }: { 
      peerID: string; 
      createOffer: boolean;
      userNumber?: number;
      userName?: string;
    }) => {
      console.log('Adding peer:', peerID, 'createOffer:', createOffer, 'userName:', peerUserName);
      
      if (userNumber) {
        setUserNumbers(prev => ({ ...prev, [peerID]: userNumber }));
      }
      if (peerUserName) {
        setUserNames(prev => ({ ...prev, [peerID]: peerUserName }));
      }
    };

    const handleRemovePeer = ({ peerID }: { peerID: string }) => {
      setUserNumbers(prev => {
        const newNumbers = { ...prev };
        delete newNumbers[peerID];
        return newNumbers;
      });
      setUserNames(prev => {
        const newNames = { ...prev };
        delete newNames[peerID];
        return newNames;
      });
    };

    const handleChatMessage = (msg: {
      id: string;
      message: string;
      sender: string;
      timestamp: string;
      userNumber?: number;
      userName?: string;
    }) => {
      if (msg.userNumber && msg.sender !== socket.id) {
        setUserNumbers(prev => ({ ...prev, [msg.sender]: msg.userNumber! }));
      }
      if (msg.userName && msg.sender !== socket.id) {
        setUserNames(prev => ({ ...prev, [msg.sender]: msg.userName! }));
      }
      
      // Добавляем сообщение в чат
      const newMessage: ChatMessage = {
        id: msg.id,
        text: msg.message,
        isLocal: msg.sender === socket.id,
        timestamp: new Date(msg.timestamp).toLocaleTimeString(),
        sender: msg.sender,
        userName: msg.userName || getSenderLabel(msg.sender)
      };
      
      setMessages(prev => {
        if (prev.some(m => m.id === msg.id)) return prev;
        return [...prev, newMessage];
      });
    };

    socket.on(ACTIONS.ADD_PEER, handleAddPeer);
    socket.on(ACTIONS.REMOVE_PEER, handleRemovePeer);
    socket.on(ACTIONS.CHAT_MESSAGE, handleChatMessage);

    return () => {
      socket.off(ACTIONS.ADD_PEER, handleAddPeer);
      socket.off(ACTIONS.REMOVE_PEER, handleRemovePeer);
      socket.off(ACTIONS.CHAT_MESSAGE, handleChatMessage);
    };
  }, [getSenderLabel]);

  // Подписка на события чата и запрос истории
  useEffect(() => {
    const chatMessageHandler = (msg: {
      id: string;
      message: string;
      sender: string;
      timestamp: string;
      userNumber?: number;
      userName?: string;
    }) => {
      setMessages(prev => {
        if (prev.some(m => m.id === msg.id)) return prev;
        
        if (msg.userNumber && msg.sender !== socket.id) {
          setUserNumbers(prev => ({ ...prev, [msg.sender]: msg.userNumber! }));
        }
        if (msg.userName && msg.sender !== socket.id) {
          setUserNames(prev => ({ ...prev, [msg.sender]: msg.userName! }));
        }
        
        const newMessage = {
          id: msg.id,
          text: msg.message,
          isLocal: msg.sender === socket.id,
          timestamp: new Date(msg.timestamp).toLocaleTimeString(),
          sender: msg.sender,
          userName: msg.userName
        };
        
        if (addChatMessage) {
          addChatMessage(newMessage);
        }
        
        return [...prev, newMessage];
      });
    };

    const chatHistoryHandler = (historyMessages: any[]) => {
      const formattedMessages = historyMessages.map(msg => ({
        id: msg.id,
        text: msg.message,
        isLocal: msg.sender === socket.id,
        timestamp: new Date(msg.timestamp).toLocaleTimeString(),
        sender: msg.sender,
        userName: msg.userName
      }));
      
      setMessages(formattedMessages);
      
      historyMessages.forEach(msg => {
        if (msg.userNumber && msg.sender !== socket.id) {
          setUserNumbers(prev => ({ ...prev, [msg.sender]: msg.userNumber }));
        }
        if (msg.userName && msg.sender !== socket.id) {
          setUserNames(prev => ({ ...prev, [msg.sender]: msg.userName }));
        }
      });
    };

    socket.on(ACTIONS.CHAT_MESSAGE, chatMessageHandler);
    socket.on(ACTIONS.CHAT_HISTORY, chatHistoryHandler);
    
    if (roomID) {
      socket.emit(ACTIONS.REQUEST_CHAT_HISTORY, { roomID });
    }

    return () => {
      socket.off(ACTIONS.CHAT_MESSAGE, chatMessageHandler);
      socket.off(ACTIONS.CHAT_HISTORY, chatHistoryHandler);
    };
  }, [roomID, addChatMessage]);

  // Подписка на события уведомлений и списка участников
  useEffect(() => {
    const handleUserJoined = ({ 
      peerID, 
      userName: joinedUserName, 
      timestamp,
      participants 
    }: { 
      peerID: string; 
      userName: string;
      timestamp: string;
      participants?: Participant[];
    }) => {
      if (peerID !== socket.id) {
        setNotifications(prev => [...prev, {
          id: `join-${peerID}-${Date.now()}`,
          message: `${joinedUserName} подключился`,
          type: 'join',
          timestamp: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }]);
      }
      
      // Обновляем список участников если пришел
      if (participants) {
        setAllParticipants(participants);
      }
    };

    const handleUserLeft = ({ 
      peerID, 
      userName: leftUserName, 
      timestamp,
      participants 
    }: { 
      peerID: string; 
      userName: string;
      timestamp: string;
      participants?: Participant[];
    }) => {
      setNotifications(prev => [...prev, {
        id: `leave-${peerID}-${Date.now()}`,
        message: `${leftUserName} отключился`,
        type: 'leave',
        timestamp: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }]);
      
      // Обновляем список участников
      if (participants) {
        setAllParticipants(participants);
      }
    };

    // Добавляем обработчик для списка участников
    const handleParticipantsList = (participants: Participant[]) => {
      setAllParticipants(participants);
    };

    // Обработчик обновления имени пользователя
    const handleUserNameUpdated = ({ peerID, userName: updatedName }: { peerID: string; userName: string }) => {
      console.log(`User ${peerID} updated name to ${updatedName}`);
      
      // Обновляем имя в состоянии
      setUserNames(prev => ({ ...prev, [peerID]: updatedName }));
      
      // Обновляем в списке участников
      setAllParticipants(prev => 
        prev.map(p => p.id === peerID ? { ...p, name: updatedName } : p)
      );
      
      // Показываем уведомление (только если это не текущий пользователь)
      if (peerID !== socket.id) {
        setNotifications(prev => [...prev, {
          id: `name-update-${peerID}-${Date.now()}`,
          message: `${updatedName} изменил(а) имя`,
          type: 'system',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }]);
      }
    };

    socket.on('user-joined', handleUserJoined);
    socket.on('user-left', handleUserLeft);
    socket.on('participants-list', handleParticipantsList);
    socket.on('user-name-updated', handleUserNameUpdated);
    
    return () => {
      socket.off('user-joined', handleUserJoined);
      socket.off('user-left', handleUserLeft);
      socket.off('participants-list', handleParticipantsList);
      socket.off('user-name-updated', handleUserNameUpdated);
    };
  }, []);

  // Запрашиваем список участников при загрузке и обновляем устройства
  useEffect(() => {
    if (roomID && devicesInitialized) {
      socket.emit('get-participants', { roomID });
      
      // Принудительно обновляем список устройств при входе
      setTimeout(() => {
        if (refreshDevices) {
          refreshDevices();
        }
      }, 1000);
    }
  }, [roomID, devicesInitialized, refreshDevices]);

  // Обработка и отображение ошибок WebRTC и медиаустройств
  useEffect(() => {
    if ((mediaError || !webRTCStatus.isSupported) && !errorShown.current) {
      errorShown.current = true;
      let errorMessage = '';
      if (!webRTCStatus.isSupported) {
        errorMessage = `WebRTC не поддерживается: ${webRTCStatus.errors.join(', ')}`;
      } else if (mediaError?.name === 'NotAllowedError') {
        errorMessage = 'Доступ к камере/микрофону запрещен';
      } else if (mediaError?.name === 'NotFoundError') {
        errorMessage = 'Не удалось найти медиаустройства';
      } else {
        errorMessage = `Ошибка: ${mediaError?.message || 'Неизвестная ошибка'}`;
      }
      console.error('Ошибка медиа:', errorMessage);
      alert(errorMessage);
    }
  }, [mediaError, webRTCStatus, retryCount]);

  // Рендер основного интерфейса
  return (
    <div className={styles.roomContainer}>
      {/* Окно выбора устройств */}
      {showDeviceSelection && (
        <DeviceSelection onJoin={handleDeviceSelection} />
      )}

      {/* Оверлей с ошибками */}
      {(!isMediaReady && devicesInitialized && (mediaState.audio || mediaState.video)) || 
       (clients.length === 0 && devicesInitialized) || 
       !webRTCStatus.isSupported ? (
        <div className={styles.errorOverlay}>
          {!webRTCStatus.isSupported ? (
            <>
              <h2 className={styles.errorTitle}>WebRTC не поддерживается в вашем браузере</h2>
              <p className={styles.errorDescription}>{webRTCStatus.errors.join(', ')}</p>
            </>
          ) : mediaError ? (
            <>
              <h2 className={styles.errorTitle}>Ошибка подключения</h2>
              <p className={styles.errorDescription}>
                {mediaError.name === 'NotAllowedError'
                  ? 'Доступ к камере/микрофону запрещен'
                  : mediaError.name === 'NotFoundError'
                  ? 'Не удалось найти медиаустройства'
                  : mediaError.message}
              </p>
              <button onClick={handleRetry} className={styles.retryButton}>
                Попробовать снова
              </button>
            </>
          ) : (
            <>
              <h2 className={styles.errorTitle}>Подключение к комнате...</h2>
              <div>Загрузка...</div>
            </>
          )}
        </div>
      ) : null}

      {/* Видео потоки участников */}
      {videoLayouts.map(({ clientID, layout, isScreenShare }) => {
        const isLocal = clientID === LOCAL_VIDEO;
        const hasMediaStream = isLocal ? 
          (mediaState.audio || mediaState.video || mediaState.screen) : 
          (peerMediaElements.current[clientID]?.srcObject as MediaStream)?.getTracks().length > 0;
        
        return (
          <div 
            key={clientID}
            data-client-id={clientID}
            className={`${styles.videoWrapper} ${
              fullscreenParticipant === clientID ? styles.videoWrapperFullscreen : ''
            } ${
              fullscreenParticipant && fullscreenParticipant !== clientID ? styles.videoWrapperHidden : ''
            } ${isScreenShare ? styles.screenShareWrapper : ''} ${
              !hasMediaStream ? styles.noMediaWrapper : ''
            }`}
            style={layout}
          >
            <video
              ref={(instance) => provideMediaRef(clientID, instance)}
              autoPlay
              playsInline
              muted={clientID === LOCAL_VIDEO || !participantSettings[clientID]?.audioEnabled}
              className={`${styles.video} ${
                clientID === LOCAL_VIDEO && !mediaState.video && !mediaState.screen ? styles.videoLocalHidden : ''
              } ${!participantSettings[clientID]?.videoEnabled ? styles.videoDisabled : ''}`}
            />
            
            {/* Индикатор демонстрации экрана */}
            {isScreenShare && (
              <div className={styles.screenShareBadge}>
                <span className={styles.screenShareIcon}>🖥️</span>
                <span className={styles.screenShareText}>
                  {isLocal ? 'Вы демонстрируете экран' : 'Демонстрация экрана'}
                </span>
              </div>
            )}
            
            {/* Плейсхолдер для участников без видео */}
            {(clientID !== LOCAL_VIDEO && (!peerMediaElements.current[clientID]?.srcObject || 
              (peerMediaElements.current[clientID]?.srcObject as MediaStream)?.getVideoTracks().length === 0)) && (
              <div className={styles.participantPlaceholder}>
                <div className={styles.participantAvatar}>
                  {getUserDisplayName(clientID).charAt(0)}
                </div>
                <div className={styles.participantName}>
                  {getUserDisplayName(clientID)}
                </div>
                <div className={styles.participantStatus}>
                  📹 Нет видео
                </div>
              </div>
            )}
            
            {/* Верхняя панель управления */}
            <div className={styles.videoTopControls}>
              {/* Кнопка полноэкранного режима */}
              <button 
                className={styles.fullscreenButton}
                onClick={() => toggleFullscreen(clientID)}
                title={fullscreenParticipant === clientID ? "Уменьшить" : "Увеличить"}
              >
                {fullscreenParticipant === clientID ? '⤢' : '⤡'}
              </button>

              {/* Кнопки управления для других участников */}
              {clientID !== LOCAL_VIDEO && (
                <div className={styles.participantControls}>
                  <button
                    className={`${styles.participantControlButton} ${
                      !participantSettings[clientID]?.videoEnabled ? styles.participantControlButtonActive : ''
                    }`}
                    onClick={() => toggleParticipantVideo(clientID)}
                    title={participantSettings[clientID]?.videoEnabled ? "Скрыть видео" : "Показать видео"}
                  >
                    📹
                  </button>
                  <button
                    className={`${styles.participantControlButton} ${
                      !participantSettings[clientID]?.audioEnabled ? styles.participantControlButtonActive : ''
                    }`}
                    onClick={() => toggleParticipantAudio(clientID)}
                    title={participantSettings[clientID]?.audioEnabled ? "Отключить звук" : "Включить звук"}
                  >
                    🎤
                  </button>
                </div>
              )}
            </div>

            {/* Нижняя метка пользователя */}
            <div className={styles.userLabel}>
              {getUserDisplayName(clientID)}
              
              {/* Индикаторы состояния медиа */}
              {!mediaState.audio && clientID === LOCAL_VIDEO && <span>🔇</span>}
              {!mediaState.video && !mediaState.screen && clientID === LOCAL_VIDEO && <span>📷</span>}
              {mediaState.screen && clientID === LOCAL_VIDEO && <span className={styles.screenShareIndicator}>🖥️</span>}
              
              {/* Индикаторы отключенного контента */}
              {!participantSettings[clientID]?.videoEnabled && clientID !== LOCAL_VIDEO && (
                <span className={styles.videoDisabledIndicator}>📹❌</span>
              )}
              {!participantSettings[clientID]?.audioEnabled && clientID !== LOCAL_VIDEO && (
                <span className={styles.audioDisabledIndicator}>🎤❌</span>
              )}
            </div>
          </div>
        );
      })}

      {/* Кнопка выхода из полноэкранного режима */}
      {fullscreenParticipant && (
        <button 
          className={styles.exitFullscreenButton}
          onClick={handleExitFullscreen}
          title="Выйти из полноэкранного режима"
        >
          ✕ Выйти из полноэкранного режима
        </button>
      )}

      {/* Панель управления */}
      <div className={styles.controls}>
        {/* Кнопка микрофона */}
        <button
          onClick={() => toggleMedia('audio')}
          className={`${styles.controlButton} ${
            mediaState.audio ? styles.controlButtonMicOn : styles.controlButtonMicOff
          }`}
          title={mediaState.audio ? 'Выключить микрофон' : 'Включить микрофон'}
          aria-label={mediaState.audio ? 'Выключить микрофон' : 'Включить микрофон'}
        >
          {mediaState.audio ? '🎤' : '🔇'}
        </button>

        {/* Кнопка камеры */}
        <button
          onClick={() => toggleMedia('video')}
          className={`${styles.controlButton} ${
            mediaState.video ? styles.controlButtonCamOn : styles.controlButtonCamOff
          }`}
          title={mediaState.video ? 'Выключить камеру' : 'Включить камеру'}
          aria-label={mediaState.video ? 'Выключить камеру' : 'Включить камеру'}
        >
          {mediaState.video ? '📹' : '📷'}
        </button>

        {/* Кнопка демонстрации экрана */}
        {!mediaState.screen ? (
          <button
            onClick={handleStartScreenShare}
            className={`${styles.controlButton} ${styles.controlButtonScreenShare}`}
            title="Начать демонстрацию экрана"
            aria-label="Начать демонстрацию экрана"
          >
            🖥️
          </button>
        ) : (
          <button
            onClick={handleStopScreenShare}
            className={`${styles.controlButton} ${styles.controlButtonScreenShareActive}`}
            title="Остановить демонстрацию экрана"
            aria-label="Остановить демонстрацию экрана"
          >
            ⏹️
          </button>
        )}

        {/* Кнопка списка участников */}
        <button
          onClick={() => setShowParticipants(!showParticipants)}
          className={`${styles.controlButton} ${
            showParticipants ? styles.controlButtonParticipantsActive : styles.controlButtonParticipants
          }`}
          title="Список участников"
          aria-label="Список участников"
        >
          👥
        </button>

        {/* Кнопка чата */}
        <button
          onClick={() => setShowChat(!showChat)}
          className={`${styles.controlButton} ${
            showChat ? styles.controlButtonChatActive : styles.controlButtonChat
          }`}
          title={showChat ? 'Скрыть чат' : 'Показать чат'}
          aria-label={showChat ? 'Скрыть чат' : 'Показать чат'}
        >
          💬
        </button>

        {/* Кнопка настроек */}
        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`${styles.controlButton} ${
            showSettings ? styles.controlButtonSettingsActive : styles.controlButtonSettings
          }`}
          title="Настройки"
          aria-label="Настройки"
        >
          ⚙️
        </button>

        {/* Кнопка копирования ссылки */}
        <button
          onClick={handleCopyLink}
          className={`${styles.controlButton} ${styles.copyButton}`}
          title="Скопировать ссылку на комнату"
          aria-label="Скопировать ссылку на комнату"
        >
          <span>🔗</span>
          {isCopied && <span className={styles.copyLabel}>Скопировано!</span>}
        </button>

        {/* Кнопка выхода */}
        <button
          onClick={handleLeaveRoom}
          className={`${styles.controlButton} ${styles.controlButtonLeave}`}
          title="Выйти из комнаты"
          aria-label="Выйти из комнаты"
        >
          🚪
        </button>
      </div>

      {/* Панель списка участников */}
      {showParticipants && (
        <div className={styles.participantsPanel}>
          <div className={styles.participantsHeader}>
            <h3>Участники ({participantsList.length})</h3>
            <button
              onClick={() => setShowParticipants(false)}
              className={styles.closeParticipantsButton}
              aria-label="Закрыть список участников"
            >
              ×
            </button>
          </div>
          
          <div className={styles.participantsList}>
            {participantsList.length === 0 ? (
              <div className={styles.noParticipants}>Нет участников</div>
            ) : (
              participantsList.map(participant => (
                <div 
                  key={participant.id} 
                  className={`${styles.participantItem} ${participant.isLocal ? styles.local : ''} ${
                    participant.isScreenSharing ? styles.screenSharing : ''
                  }`}
                >
                  <div className={`${styles.participantAvatar} ${participant.isLocal ? styles.local : ''}`}>
                    {participant.name.charAt(0)}
                  </div>
                  <div className={styles.participantInfo}>
                    <div className={styles.participantName}>
                      {participant.name}
                      {participant.isLocal && ' (Вы)'}
                      {participant.isScreenSharing && (
                        <span className={styles.screenSharingIndicator}>🖥️</span>
                      )}
                    </div>
                    <div className={styles.participantStatus}>
                      <span className={`${styles.statusIndicator} ${
                        participant.isOnline ? styles.online : styles.offline
                      }`} />
                      {participant.isOnline ? 'В сети' : 'Не в сети'}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Чат */}
      {showChat && (
        <div className={styles.chatContainer}>
          <div className={styles.chatHeader}>
            <span>Чат комнаты</span>
            <button
              onClick={() => setShowChat(false)}
              className={styles.chatCloseButton}
              aria-label="Закрыть чат"
            >
              ×
            </button>
          </div>
          <div ref={chatContainerRef} className={styles.chatMessages} aria-live="polite">
            {messages.length === 0 ? (
              <div className={styles.noMessages}>Нет сообщений</div>
            ) : (
              messages.map(msg => (
                <div
                  key={msg.id}
                  className={`${styles.message} ${msg.isLocal ? styles.messageLocal : ''}`}
                >
                  <div className={styles.messageSender}>{getSenderLabel(msg.sender)}</div>
                  <div
                    className={`${styles.messageBubble} ${
                      msg.isLocal ? styles.messageBubbleLocal : styles.messageBubbleRemote
                    }`}
                  >
                    {msg.text}
                  </div>
                  <div className={styles.messageTime}>
                    {msg.timestamp} {msg.isLocal ? '✓' : ''}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Поле ввода сообщения */}
          <div className={styles.chatInputContainer}>
            <button
              className={styles.attachmentButton}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Прикрепить файл"
            >
              📎
            </button>

            <input
              type="text"
              value={messageInput}
              onChange={handleInputChange}
              onKeyPress={handleKeyPress}
              placeholder="Введите сообщение..."
              className={styles.chatInput}
              aria-label="Введите сообщение"
            />

            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              className={styles.fileInput}
              aria-hidden="true"
            />

            <button
              onClick={handleSendMessage}
              disabled={!messageInput.trim()}
              className={`${styles.chatSendButton} ${
                !messageInput.trim() ? styles.chatSendButtonDisabled : ''
              }`}
              aria-label="Отправить сообщение"
            >
              Отправить
            </button>
          </div>
        </div>
      )}

      {/* Панель настроек */}
      {showSettings && (
        <div className={styles.settingsPanel}>
          <div className={styles.settingsHeader}>
            <h3 style={{ margin: 0 }}>Настройки</h3>
            <button
              onClick={() => setShowSettings(false)}
              className={styles.settingsCloseButton}
              aria-label="Закрыть настройки"
            >
              ×
            </button>
          </div>

          {/* Настройки имени */}
          <div className={styles.nameSettings}>
            <label className={styles.settingsLabel}>
              Ваше имя:
            </label>
            <div className={styles.currentName}>{userName || 'Не указано'}</div>
            <button
              onClick={() => setShowNameInput(true)}
              className={styles.changeNameButton}
            >
              Изменить имя
            </button>
          </div>

          {/* Выбор микрофона */}
          {availableDevices.audio.length > 0 && (
            <div className={styles.settingsSection}>
              <label className={styles.settingsLabel} htmlFor="audioDeviceSelect">
                Микрофон:
              </label>
              <select
                id="audioDeviceSelect"
                onChange={(e) => switchMediaDevice('audio', e.target.value)}
                className={styles.settingsSelect}
                aria-label="Выберите микрофон"
              >
                {availableDevices.audio.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Микрофон ${index + 1}`}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Выбор камеры */}
          {availableDevices.video.length > 0 && (
            <div className={styles.settingsSection}>
              <label className={styles.settingsLabel} htmlFor="videoDeviceSelect">
                Камера:
              </label>
              <select
                id="videoDeviceSelect"
                onChange={(e) => switchMediaDevice('video', e.target.value)}
                className={styles.settingsSelect}
                aria-label="Выберите камеру"
              >
                {availableDevices.video.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Камера ${index + 1}`}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/* Модальное окно изменения имени */}
      {showNameInput && (
        <div className={styles.nameInputOverlay}>
          <div className={styles.nameInputModal}>
            <h3>Изменение имени</h3>
            <input
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="Введите ваше имя"
              className={styles.nameInputField}
              maxLength={50}
            />
            <div className={styles.nameInputButtons}>
              <button
                onClick={() => setShowNameInput(false)}
                className={styles.cancelButton}
              >
                Отмена
              </button>
              <button
                onClick={handleSaveName}
                className={styles.saveButton}
              >
                Сохранить
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Контейнер для уведомлений */}
      <div className={styles.notificationsContainer}>
        {notifications.slice(-3).map((notification) => (
          <div 
            key={notification.id}
            className={`${styles.notification} ${styles[`notification${notification.type.charAt(0).toUpperCase() + notification.type.slice(1)}`]}`}
            onAnimationEnd={() => {
              setTimeout(() => {
                setNotifications(prev => 
                  prev.filter(n => n.id !== notification.id)
                );
              }, 3000);
            }}
          >
            <div className={styles.notificationIcon}>
              {notification.type === 'join' ? '➕' : 
               notification.type === 'leave' ? '➖' : '💬'}
            </div>
            <div className={styles.notificationContent}>
              <div className={styles.notificationMessage}>
                {notification.message}
              </div>
              <div className={styles.notificationTime}>
                {notification.timestamp}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Room;