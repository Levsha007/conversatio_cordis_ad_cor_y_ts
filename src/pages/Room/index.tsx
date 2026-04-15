import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import useWebRTC, { LOCAL_VIDEO } from '../../hooks/useWebRTC';
import socket from '../../socket';
import { ACTIONS } from '../../socket/actions';
import styles from './Room.module.css';

interface LayoutItem {
  width: string;
  height: string;
}

interface ChatMessage {
  id: string;
  text: string;
  isLocal: boolean;
  timestamp: string;
  sender: string;
  userName?: string;
}

interface DeviceSettings {
  audio: boolean;
  video: boolean;
}

interface Participant {
  id: string;
  name: string;
  isOnline: boolean;
}

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

const escapeHtml = (text: string): string => {
  if (!text) return '';
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
};

const DeviceSelection: React.FC<{
  onJoin: (settings: DeviceSettings, userName: string) => void;
}> = ({ onJoin }) => {
  const [name, setName] = useState('');
  const [initialSettings, setInitialSettings] = useState<DeviceSettings>({
    audio: true,
    video: true
  });

  const handleJoin = () => {
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
        </div>

        <p>Выберите устройства для использования:</p>
        
        <div className={styles.deviceOptions}>
          <div className={styles.deviceOptionRow}>
            <div className={styles.deviceStatus}>
              <span className={styles.deviceIcon}>🎤</span>
              <span className={styles.deviceName}>Микрофон</span>
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

        <div className={styles.deviceSelectionButtons}>
          <button onClick={handleJoin} className={styles.joinButton}>
            Войти в комнату
          </button>
        </div>
      </div>
    </div>
  );
};

function calculateLayout(clientsCount: number = 1, isMobile: boolean): LayoutItem[] {
  if (isMobile) {
    if (clientsCount === 1) {
      return [{ width: '100%', height: '100%' }];
    } else if (clientsCount === 2) {
      return [
        { width: '100%', height: '50%' },
        { width: '100%', height: '50%' }
      ];
    } else {
      const cols = Math.ceil(Math.sqrt(clientsCount));
      const rows = Math.ceil(clientsCount / cols);
      const width = `${100 / cols}%`;
      const height = `${100 / rows}%`;
      return Array(clientsCount).fill({ width, height });
    }
  }

  const cols = Math.ceil(Math.sqrt(clientsCount));
  const rows = Math.ceil(clientsCount / cols);
  const width = `${100 / cols}%`;
  const height = `${100 / rows}%`;
  return Array(clientsCount).fill({ width, height });
}

const Room: React.FC = () => {
  const navigate = useNavigate();
  const { id: roomID } = useParams<{ id: string }>();
  const isMobile = useIsMobile();

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
    isDeviceAvailable,
    participantSettings,
    toggleParticipantVideo,
    toggleParticipantAudio
  } = useWebRTC(roomID || '');

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
  const [initialMediaState, setInitialMediaState] = useState<DeviceSettings | null>(null);
  const [isHandRaised, setIsHandRaised] = useState(false);
  const [raisedHands, setRaisedHands] = useState<Set<string>>(new Set());

  const videoLayouts = useMemo(() => {
    const layout = calculateLayout(clients.length, isMobile);
    return clients.map((client, index) => ({
      clientID: client,
      layout: layout[index],
      isScreenShare: false
    }));
  }, [clients, isMobile]);

  const participantsList = useMemo(() => {
    return allParticipants.map(participant => ({
      id: participant.id,
      name: participant.name,
      isOnline: participant.isOnline,
      isLocal: participant.id === socket.id,
      isHandRaised: raisedHands.has(participant.id)
    }));
  }, [allParticipants, raisedHands]);

  const getUserDisplayName = useCallback((userId: string): string => {
    if (userId === LOCAL_VIDEO) return userName || 'Вы';
    return userNames[userId] || `Участник`;
  }, [userName, userNames]);

  const getSenderLabel = useCallback((senderId: string): string => {
    if (senderId === socket.id) return userName || 'Вы';
    return userNames[senderId] || `Участник`;
  }, [userName, userNames]);

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
      
      socket.emit(ACTIONS.CHAT_MESSAGE, {
        roomID,
        message: trimmedMessage,
        id: messageId,
        timestamp: new Date().toISOString(),
        userName: userName
      });
    }
  }, [messageInput, roomID, addChatMessage, userName]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value.length <= 1000) {
      setMessageInput(value);
    }
  }, []);

  const handleKeyPress = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSendMessage();
    }
  }, [handleSendMessage]);

  const toggleHandRaise = useCallback(() => {
    if (!roomID) return;
    
    if (isHandRaised) {
      socket.emit(ACTIONS.LOWER_HAND, { roomID });
      setIsHandRaised(false);
      setRaisedHands(prev => {
        const newSet = new Set(prev);
        if (socket.id) newSet.delete(socket.id);
        return newSet;
      });
    } else {
      socket.emit(ACTIONS.RAISE_HAND, { roomID });
      setIsHandRaised(true);
      setRaisedHands(prev => {
        const newSet = new Set(prev);
        if (socket.id) newSet.add(socket.id);
        return newSet;
      });
    }
  }, [roomID, isHandRaised]);

  const handleDeviceSelection = async (settings: DeviceSettings, name: string) => {
    setShowDeviceSelection(false);
    setUserName(name);
    setUserNames(prev => ({ ...prev, [socket.id as string]: name }));
    setInitialMediaState(settings);
    await initializeMedia(settings, name);
    setDevicesInitialized(true);
  };

  const toggleFullscreen = useCallback((clientID: string) => {
    if (fullscreenParticipant === clientID) {
      setFullscreenParticipant(null);
      if (document.fullscreenElement) {
        document.exitFullscreen();
      }
    } else {
      setFullscreenParticipant(clientID);
      const videoWrapper = document.querySelector(`[data-client-id="${clientID}"]`) as HTMLElement;
      if (videoWrapper && videoWrapper.requestFullscreen) {
        videoWrapper.requestFullscreen().catch(console.error);
      }
    }
  }, [fullscreenParticipant]);

  const handleExitFullscreen = useCallback(() => {
    setFullscreenParticipant(null);
    if (document.fullscreenElement) {
      document.exitFullscreen();
    }
  }, []);

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

  const handleLeaveRoom = useCallback(() => {
    if (window.confirm('Вы уверены, что хотите выйти из комнаты?')) {
      if (isHandRaised && roomID) {
        socket.emit(ACTIONS.LOWER_HAND, { roomID });
      }
      navigate('/');
    }
  }, [navigate, isHandRaised, roomID]);

  const handleRetry = useCallback(async () => {
    setRetryCount(prev => prev + 1);
    errorShown.current = false;
    await reconnect();
  }, [reconnect]);

  const handleScreenShare = useCallback(async () => {
    if (mediaState.screen) {
      stopScreenShare();
    } else {
      if (isHandRaised && roomID) toggleHandRaise();
      try {
        await startScreenShare();
      } catch (err) {
        console.error('Ошибка демонстрации экрана:', err);
      }
    }
  }, [mediaState.screen, startScreenShare, stopScreenShare, isHandRaised, roomID, toggleHandRaise]);

  const handleSaveName = useCallback(() => {
    if (userName.trim()) {
      const newName = userName.trim();
      setUserName(newName);
      socket.emit('update-user-name', { roomID: roomID || '', userName: newName });
      setUserNames(prev => ({ ...prev, [socket.id as string]: newName }));
      setShowNameInput(false);
    }
  }, [userName, roomID]);

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
      
      if (addChatMessage) addChatMessage(newMessage);
      setMessages(prev => [...prev, newMessage]);

      socket.emit(ACTIONS.CHAT_MESSAGE, {
        roomID,
        message: fileNameWithIcon,
        id: fileId,
        timestamp: new Date().toISOString(),
        userName: userName
      });
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [roomID, addChatMessage, userName]);

  useEffect(() => {
    if (getChatMessages) setMessages(getChatMessages());
  }, [getChatMessages]);

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) setFullscreenParticipant(null);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Подписка на события чата
  useEffect(() => {
    const chatMessageHandler = (msg: {
      id: string;
      message: string;
      sender: string;
      timestamp: string;
      userName?: string;
    }) => {
      setMessages(prev => {
        if (prev.some(m => m.id === msg.id)) return prev;
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
        if (addChatMessage) addChatMessage(newMessage);
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
        if (msg.userName && msg.sender !== socket.id) {
          setUserNames(prev => ({ ...prev, [msg.sender]: msg.userName }));
        }
      });
    };

    socket.on(ACTIONS.CHAT_MESSAGE, chatMessageHandler);
    socket.on(ACTIONS.CHAT_HISTORY, chatHistoryHandler);
    
    if (roomID) socket.emit(ACTIONS.REQUEST_CHAT_HISTORY, { roomID });

    return () => {
      socket.off(ACTIONS.CHAT_MESSAGE, chatMessageHandler);
      socket.off(ACTIONS.CHAT_HISTORY, chatHistoryHandler);
    };
  }, [roomID, addChatMessage]);

  // Подписка на события участников - ИСПОЛЬЗУЕМ any ДЛЯ ОБХОДА ТИПИЗАЦИИ
  useEffect(() => {
    // Обработчик подключения участника
    const handleUserJoined = (data: any) => {
      const { peerID, userName: joinedUserName, participants } = data;
      
      if (peerID !== socket.id) {
        setNotifications(prev => [...prev.slice(-2), {
          id: `join-${peerID}-${Date.now()}`,
          message: `${joinedUserName || 'Участник'} подключился`,
          type: 'join',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }]);
      }
      
      if (participants && Array.isArray(participants)) {
        setAllParticipants(participants);
      }
    };

    // Обработчик отключения участника
    const handleUserLeft = (data: any) => {
      const { peerID, userName: leftUserName, participants } = data;
      
      setNotifications(prev => [...prev.slice(-2), {
        id: `leave-${peerID}-${Date.now()}`,
        message: `${leftUserName || 'Участник'} отключился`,
        type: 'leave',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }]);
      
      if (participants && Array.isArray(participants)) {
        setAllParticipants(participants);
      }
    };

    // Обработчик списка участников
    const handleParticipantsList = (participants: Participant[]) => {
      setAllParticipants(participants);
    };

    // Обработчик обновления имени
    const handleUserNameUpdated = (data: any) => {
      const { peerID, userName: updatedName } = data;
      setUserNames(prev => ({ ...prev, [peerID]: updatedName }));
      setAllParticipants(prev => 
        prev.map(p => p.id === peerID ? { ...p, name: updatedName } : p)
      );
    };

    // Обработчик поднятия руки
    const handleRaiseHand = (data: any) => {
      const { peerID, userName: handUserName } = data;
      setRaisedHands(prev => new Set(prev).add(peerID));
      if (peerID !== socket.id) {
        setNotifications(prev => [...prev.slice(-2), {
          id: `hand-${peerID}-${Date.now()}`,
          message: `${handUserName} поднял(а) руку`,
          type: 'system',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }]);
      }
    };

    // Обработчик опускания руки
    const handleLowerHand = (data: any) => {
      const { peerID } = data;
      setRaisedHands(prev => {
        const newSet = new Set(prev);
        newSet.delete(peerID);
        return newSet;
      });
      if (peerID === socket.id) setIsHandRaised(false);
    };

    // Используем (socket as any) для обхода TypeScript типов
    const s = socket as any;
    
    s.on('participant-joined', handleUserJoined);
    s.on('participant-left', handleUserLeft);
    s.on('participants-list', handleParticipantsList);
    s.on('user-name-updated', handleUserNameUpdated);
    s.on(ACTIONS.RAISE_HAND, handleRaiseHand);
    s.on(ACTIONS.LOWER_HAND, handleLowerHand);
    
    return () => {
      s.off('participant-joined', handleUserJoined);
      s.off('participant-left', handleUserLeft);
      s.off('participants-list', handleParticipantsList);
      s.off('user-name-updated', handleUserNameUpdated);
      s.off(ACTIONS.RAISE_HAND, handleRaiseHand);
      s.off(ACTIONS.LOWER_HAND, handleLowerHand);
    };
  }, []);

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

  const isDeviceEnabled = useCallback((type: 'audio' | 'video'): boolean => {
    if (!initialMediaState) return true;
    return initialMediaState[type];
  }, [initialMediaState]);

  return (
    <div className={styles.roomContainer}>
      {showDeviceSelection && <DeviceSelection onJoin={handleDeviceSelection} />}

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
              <button onClick={handleRetry} className={styles.retryButton}>Попробовать снова</button>
            </>
          ) : (
            <>
              <h2 className={styles.errorTitle}>Подключение к комнате...</h2>
              <div>Загрузка...</div>
            </>
          )}
        </div>
      ) : null}

      {videoLayouts.map(({ clientID, layout }) => {
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
            } ${fullscreenParticipant && fullscreenParticipant !== clientID ? styles.videoWrapperHidden : ''}`}
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
            
            {raisedHands.has(clientID) && (
              <div className={styles.handRaisedBadge}>
                <div className={styles.handIconWrapper}>
                  <span className={styles.handIcon}>✋</span>
                </div>
              </div>
            )}
            
            {(clientID !== LOCAL_VIDEO && (!peerMediaElements.current[clientID]?.srcObject || 
              (peerMediaElements.current[clientID]?.srcObject as MediaStream)?.getVideoTracks().length === 0)) && (
              <div className={styles.participantPlaceholder}>
                <div className={styles.participantAvatar}>
                  {escapeHtml(getUserDisplayName(clientID).charAt(0))}
                </div>
                <div className={styles.participantName}>
                  {escapeHtml(getUserDisplayName(clientID))}
                </div>
                <div className={styles.participantStatus}>📹 Нет видео</div>
              </div>
            )}
            
            <div className={styles.videoTopControls}>
              <button className={styles.fullscreenButton} onClick={() => toggleFullscreen(clientID)}>
                {fullscreenParticipant === clientID ? '⤢' : '⤡'}
              </button>

              {clientID !== LOCAL_VIDEO && (
                <div className={styles.participantControls}>
                  <button
                    className={`${styles.participantControlButton} ${
                      !participantSettings[clientID]?.videoEnabled ? styles.participantControlButtonActive : ''
                    }`}
                    onClick={() => toggleParticipantVideo(clientID)}
                  >
                    📹
                  </button>
                  <button
                    className={`${styles.participantControlButton} ${
                      !participantSettings[clientID]?.audioEnabled ? styles.participantControlButtonActive : ''
                    }`}
                    onClick={() => toggleParticipantAudio(clientID)}
                  >
                    🎤
                  </button>
                </div>
              )}
            </div>

            <div className={styles.userLabel}>
              {escapeHtml(getUserDisplayName(clientID))}
              {!mediaState.audio && clientID === LOCAL_VIDEO && <span>🔇</span>}
              {!mediaState.video && !mediaState.screen && clientID === LOCAL_VIDEO && <span>📷</span>}
              {mediaState.screen && clientID === LOCAL_VIDEO && <span className={styles.screenShareIndicator}>🖥️</span>}
              {!participantSettings[clientID]?.videoEnabled && clientID !== LOCAL_VIDEO && <span>📹❌</span>}
              {!participantSettings[clientID]?.audioEnabled && clientID !== LOCAL_VIDEO && <span>🎤❌</span>}
            </div>
          </div>
        );
      })}

      {fullscreenParticipant && (
        <button className={styles.exitFullscreenButton} onClick={handleExitFullscreen}>
          ✕ Выйти из полноэкранного режима
        </button>
      )}

      <div className={styles.controls}>
        <button
          onClick={() => toggleMedia('audio')}
          className={`${styles.controlButton} ${
            mediaState.audio ? styles.controlButtonMicOn : styles.controlButtonMicOff
          } ${!isDeviceEnabled('audio') ? styles.controlButtonDisabled : ''}`}
          disabled={!isDeviceEnabled('audio')}
        >
          {mediaState.audio ? '🎤' : '🔇'}
        </button>

        <button
          onClick={() => toggleMedia('video')}
          className={`${styles.controlButton} ${
            mediaState.video ? styles.controlButtonCamOn : styles.controlButtonCamOff
          } ${!isDeviceEnabled('video') ? styles.controlButtonDisabled : ''}`}
          disabled={!isDeviceEnabled('video')}
        >
          {mediaState.video ? '📹' : '📷'}
        </button>

        {!isMobile && (
          !mediaState.screen ? (
            <button onClick={handleScreenShare} className={`${styles.controlButton} ${styles.controlButtonScreenShare}`}>
              🖥️
            </button>
          ) : (
            <button onClick={handleScreenShare} className={`${styles.controlButton} ${styles.controlButtonScreenShareActive}`}>
              ⏹️
            </button>
          )
        )}

        <button
          onClick={toggleHandRaise}
          className={`${styles.controlButton} ${isHandRaised ? styles.controlButtonHandRaised : styles.controlButtonHand}`}
        >
          {isHandRaised ? '👇' : '✋'}
        </button>

        <button
          onClick={() => setShowParticipants(!showParticipants)}
          className={`${styles.controlButton} ${showParticipants ? styles.controlButtonParticipantsActive : styles.controlButtonParticipants}`}
        >
          👥
        </button>

        <button
          onClick={() => setShowChat(!showChat)}
          className={`${styles.controlButton} ${showChat ? styles.controlButtonChatActive : styles.controlButtonChat}`}
        >
          💬
        </button>

        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`${styles.controlButton} ${showSettings ? styles.controlButtonSettingsActive : styles.controlButtonSettings}`}
        >
          ⚙️
        </button>

        <button onClick={handleCopyLink} className={`${styles.controlButton} ${styles.copyButton}`}>
          <span>🔗</span>
          {isCopied && <span className={styles.copyLabel}>Скопировано!</span>}
        </button>

        <button onClick={handleLeaveRoom} className={`${styles.controlButton} ${styles.controlButtonLeave}`}>
          🚪
        </button>
      </div>

      {showParticipants && (
        <div className={styles.participantsPanel}>
          <div className={styles.participantsHeader}>
            <h3>Участники ({participantsList.length})</h3>
            <button onClick={() => setShowParticipants(false)} className={styles.closeParticipantsButton}>×</button>
          </div>
          <div className={styles.participantsList}>
            {participantsList.length === 0 ? (
              <div className={styles.noParticipants}>Нет участников</div>
            ) : (
              participantsList.map(participant => (
                <div key={participant.id} className={`${styles.participantItem} ${participant.isLocal ? styles.local : ''}`}>
                  <div className={`${styles.participantAvatar} ${participant.isLocal ? styles.local : ''} ${participant.isHandRaised ? styles.handRaised : ''}`}>
                    {participant.isHandRaised && <div className={styles.avatarHandIcon}>✋</div>}
                    <span className={styles.avatarInitial}>{escapeHtml(participant.name.charAt(0))}</span>
                  </div>
                  <div className={styles.participantInfo}>
                    <div className={styles.participantName}>{escapeHtml(participant.name)}{participant.isLocal && ' (Вы)'}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {showChat && (
        <div className={styles.chatContainer}>
          <div className={styles.chatHeader}>
            <span>Чат комнаты</span>
            <button onClick={() => setShowChat(false)} className={styles.chatCloseButton}>×</button>
          </div>
          <div ref={chatContainerRef} className={styles.chatMessages}>
            {messages.length === 0 ? (
              <div className={styles.noMessages}>Нет сообщений</div>
            ) : (
              messages.map(msg => (
                <div key={msg.id} className={`${styles.message} ${msg.isLocal ? styles.messageLocal : ''}`}>
                  <div className={styles.messageSender}>{escapeHtml(getSenderLabel(msg.sender))}</div>
                  <div 
                    className={`${styles.messageBubble} ${msg.isLocal ? styles.messageBubbleLocal : styles.messageBubbleRemote}`}
                    dangerouslySetInnerHTML={{ __html: escapeHtml(msg.text).replace(/\n/g, '<br>') }} 
                  />
                  <div className={styles.messageTime}>{msg.timestamp} {msg.isLocal ? '✓' : ''}</div>
                </div>
              ))
            )}
          </div>

          <div className={styles.chatInputContainer}>
            <button className={styles.attachmentButton} onClick={() => fileInputRef.current?.click()}>📎</button>
            <input 
              type="text" 
              value={messageInput} 
              onChange={handleInputChange} 
              onKeyPress={handleKeyPress}
              placeholder="Введите сообщение..." 
              className={styles.chatInput} 
            />
            <input type="file" ref={fileInputRef} onChange={handleFileChange} className={styles.fileInput} />
            <button 
              onClick={handleSendMessage} 
              disabled={!messageInput.trim()}
              className={`${styles.chatSendButton} ${!messageInput.trim() ? styles.chatSendButtonDisabled : ''}`}
            >
              Отправить
            </button>
          </div>
        </div>
      )}

      {showSettings && (
        <div className={styles.settingsPanel}>
          <div className={styles.settingsHeader}>
            <h3>Настройки</h3>
            <button onClick={() => setShowSettings(false)} className={styles.settingsCloseButton}>×</button>
          </div>

          <div className={styles.nameSettings}>
            <label className={styles.settingsLabel}>Ваше имя:</label>
            <div className={styles.currentName}>{escapeHtml(userName || 'Не указано')}</div>
            <button onClick={() => setShowNameInput(true)} className={styles.changeNameButton}>Изменить имя</button>
          </div>

          {availableDevices.audio.length > 0 && (
            <div className={styles.settingsSection}>
              <label className={styles.settingsLabel}>Микрофон:</label>
              <select onChange={(e) => switchMediaDevice('audio', e.target.value)} className={styles.settingsSelect}>
                {availableDevices.audio.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>{device.label || `Микрофон ${index + 1}`}</option>
                ))}
              </select>
            </div>
          )}

          {availableDevices.video.length > 0 && (
            <div className={styles.settingsSection}>
              <label className={styles.settingsLabel}>Камера:</label>
              <select onChange={(e) => switchMediaDevice('video', e.target.value)} className={styles.settingsSelect}>
                {availableDevices.video.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>{device.label || `Камера ${index + 1}`}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

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
              <button onClick={() => setShowNameInput(false)} className={styles.cancelButton}>Отмена</button>
              <button onClick={handleSaveName} className={styles.saveButton}>Сохранить</button>
            </div>
          </div>
        </div>
      )}

      <div className={styles.notificationsContainer}>
        {notifications.slice(-3).map((notification) => (
          <div 
            key={notification.id} 
            className={`${styles.notification} ${styles[`notification${notification.type.charAt(0).toUpperCase() + notification.type.slice(1)}`]}`}
          >
            <div className={styles.notificationIcon}>
              {notification.type === 'join' ? '➕' : notification.type === 'leave' ? '➖' : '💬'}
            </div>
            <div className={styles.notificationContent}>
              <div className={styles.notificationMessage}>{escapeHtml(notification.message)}</div>
              <div className={styles.notificationTime}>{notification.timestamp}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Room;