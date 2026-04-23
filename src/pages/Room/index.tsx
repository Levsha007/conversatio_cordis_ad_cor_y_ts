// src/pages/Room/index.tsx

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
  const [availableDevices, setAvailableDevices] = useState<{ audio: MediaDeviceInfo[]; video: MediaDeviceInfo[] }>({
    audio: [],
    video: []
  });
  const [hasMediaError, setHasMediaError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const getDevices = async () => {
      try {
        setIsLoading(true);
        let hasAudio = false;
        let hasVideo = false;
        
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
          hasAudio = stream.getAudioTracks().length > 0;
          hasVideo = stream.getVideoTracks().length > 0;
          stream.getTracks().forEach(track => track.stop());
        } catch (err) {
          console.warn('[DeviceSelection] Could not get initial media:', err);
        }
        
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioDevices = devices.filter(d => d.kind === 'audioinput');
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        
        setAvailableDevices({
          audio: audioDevices,
          video: videoDevices
        });
        
        setInitialSettings({
          audio: hasAudio && audioDevices.length > 0,
          video: hasVideo && videoDevices.length > 0
        });
        
        setHasMediaError(audioDevices.length === 0 && videoDevices.length === 0);
      } catch (err) {
        console.error('[DeviceSelection] Error getting devices:', err);
        setHasMediaError(true);
      } finally {
        setIsLoading(false);
      }
    };
    
    getDevices();
  }, []);

  const handleJoin = () => {
    onJoin(initialSettings, name.trim() || `Участник ${Math.floor(Math.random() * 1000) + 1}`);
  };

  const toggleAudio = () => {
    setInitialSettings(prev => ({ ...prev, audio: !prev.audio }));
  };

  const toggleVideo = () => {
    setInitialSettings(prev => ({ ...prev, video: !prev.video }));
  };

  if (isLoading) {
    return (
      <div className={styles.deviceSelectionOverlay}>
        <div className={styles.deviceSelectionModal}>
          <h2>Загрузка...</h2>
          <p>Проверка устройств...</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.deviceSelectionOverlay}>
      <div className={styles.deviceSelectionModal}>
        <h2>Настройка перед входом</h2>
        
        {hasMediaError && (
          <div style={{ marginBottom: '20px', padding: '10px', background: 'rgba(255, 0, 0, 0.2)', borderRadius: '8px' }}>
            <p style={{ color: '#ff9999', fontWeight: 'bold' }}>
              ⚠️ Не удалось получить доступ к медиаустройствам. Проверьте разрешения в браузере.
            </p>
          </div>
        )}
        
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

        <p>Выберите устройства для использования:</p>
        
        <div className={styles.deviceOptions}>
          <div className={styles.deviceOptionRow}>
            <div className={styles.deviceStatus}>
              <span className={styles.deviceIcon}>🎤</span>
              <span className={styles.deviceName}>Микрофон</span>
              {availableDevices.audio.length > 0 ? (
                <span className={`${styles.deviceState} ${initialSettings.audio ? styles.deviceOn : styles.deviceOff}`}>
                  {initialSettings.audio ? 'Будет использоваться' : 'Не будет использоваться'}
                </span>
              ) : (
                <span className={styles.deviceOff}>Нет устройств</span>
              )}
            </div>
            <button
              className={`${styles.toggleButton} ${initialSettings.audio ? styles.toggleOn : styles.toggleOff}`}
              onClick={toggleAudio}
              type="button"
              disabled={availableDevices.audio.length === 0}
            >
              <div className={styles.toggleSlider} />
            </button>
          </div>

          <div className={styles.deviceOptionRow}>
            <div className={styles.deviceStatus}>
              <span className={styles.deviceIcon}>📹</span>
              <span className={styles.deviceName}>Камера</span>
              {availableDevices.video.length > 0 ? (
                <span className={`${styles.deviceState} ${initialSettings.video ? styles.deviceOn : styles.deviceOff}`}>
                  {initialSettings.video ? 'Будет использоваться' : 'Не будет использоваться'}
                </span>
              ) : (
                <span className={styles.deviceOff}>Нет устройств</span>
              )}
            </div>
            <button
              className={`${styles.toggleButton} ${initialSettings.video ? styles.toggleOn : styles.toggleOff}`}
              onClick={toggleVideo}
              type="button"
              disabled={availableDevices.video.length === 0}
            >
              <div className={styles.toggleSlider} />
            </button>
          </div>
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

function calculateLayoutWithScreenShare(
  clients: string[],
  isMobile: boolean,
  screenShareParticipant: string | null,
  fullscreenParticipant: string | null = null
): { clientID: string; layout: LayoutItem; isScreenShare: boolean }[] {
  if (fullscreenParticipant) {
    return clients.map(client => ({
      clientID: client,
      layout: { width: '100%', height: '100%' },
      isScreenShare: client === screenShareParticipant
    }));
  }

  const screenShareClient = screenShareParticipant && clients.includes(screenShareParticipant) 
    ? screenShareParticipant 
    : null;
  
  if (screenShareClient) {
    const otherClients = clients.filter(client => client !== screenShareClient);
    
    if (isMobile) {
      return clients.map(client => {
        if (client === screenShareClient) {
          return {
            clientID: client,
            layout: { width: '100%', height: '70%' },
            isScreenShare: true
          };
        } else {
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
      return clients.map(client => {
        if (client === screenShareClient) {
          return {
            clientID: client,
            layout: { width: '70%', height: '100%' },
            isScreenShare: true
          };
        } else {
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
  
  const layout = calculateLayout(clients.length, isMobile, fullscreenParticipant);
  return clients.map((client, index) => ({
    clientID: client,
    layout: layout[index],
    isScreenShare: false
  }));
}

const Room: React.FC = () => {
  const navigate = useNavigate();
  const { id: roomID } = useParams<{ id: string }>();
  useTabSync(roomID || '');
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
    forceSyncTracks,
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
  const [initialMediaState, setInitialMediaState] = useState<DeviceSettings | null>(null);
  
  const [isHandRaised, setIsHandRaised] = useState(false);
  const [raisedHands, setRaisedHands] = useState<Set<string>>(new Set());

  const screenShareParticipant = useMemo(() => {
    if (mediaState.screen) {
      return LOCAL_VIDEO;
    }
    
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

  const videoLayouts = useMemo(() => 
    calculateLayoutWithScreenShare(
      clients, 
      isMobile, 
      screenShareParticipant,
      fullscreenParticipant
    ),
    [clients, isMobile, screenShareParticipant, fullscreenParticipant]
  );

  const participantsList = useMemo(() => {
    return allParticipants.map(participant => ({
      id: participant.id,
      name: participant.name,
      isOnline: participant.isOnline,
      isLocal: participant.id === socket.id,
      isScreenSharing: participant.id === screenShareParticipant,
      isHandRaised: raisedHands.has(participant.id)
    }));
  }, [allParticipants, screenShareParticipant, raisedHands]);

  const getUserDisplayName = useCallback((userId: string): string => {
    if (userId === LOCAL_VIDEO) return userName || 'Вы';
    return userNames[userId] || (userNumbers[userId] ? `Участник ${userNumbers[userId]}` : `Участник`);
  }, [userName, userNumbers, userNames]);

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
        if (socket.id) {
          newSet.delete(socket.id);
        }
        return newSet;
      });
    } else {
      socket.emit(ACTIONS.RAISE_HAND, { roomID });
      setIsHandRaised(true);
      setRaisedHands(prev => {
        const newSet = new Set(prev);
        if (socket.id) {
          newSet.add(socket.id);
        }
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
        videoWrapper.requestFullscreen().catch(err => {
          console.error('Ошибка при входе в полноэкранный режим:', err);
        });
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

  const handleStopScreenShare = useCallback(() => {
    stopScreenShare();
  }, [stopScreenShare]);

  const handleScreenShare = useCallback(async () => {
    if (mediaState.screen) {
      handleStopScreenShare();
    } else {
      if (isHandRaised && roomID) {
        toggleHandRaise();
      }
      try {
        await handleStartScreenShare();
      } catch (err) {
        console.error('Ошибка демонстрации экрана:', err);
      }
    }
  }, [mediaState.screen, handleStartScreenShare, handleStopScreenShare, isHandRaised, roomID, toggleHandRaise]);

  const handleSaveName = useCallback(() => {
    if (userName.trim()) {
      const newName = userName.trim();
      setUserName(newName);
      
      socket.emit('update-user-name', {
        roomID: roomID || '',
        userName: newName
      });
      
      setUserNames(prev => ({ ...prev, [socket.id as string]: newName }));
      setShowNameInput(false);
      
      setNotifications(prev => [...prev, {
        id: `name-updated-${Date.now()}`,
        message: `Имя изменено на "${newName}"`,
        type: 'system',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }]);
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

  useEffect(() => {
    if (getChatMessages) {
      setMessages(getChatMessages());
    }
  }, [getChatMessages]);

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

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

  useEffect(() => {
    const handleAddPeer = ({ peerID, createOffer, userNumber, userName: peerUserName }: { 
      peerID: string; 
      createOffer: boolean;
      userNumber?: number;
      userName?: string;
    }) => {
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

    socket.on(ACTIONS.ADD_PEER, handleAddPeer);
    socket.on(ACTIONS.REMOVE_PEER, handleRemovePeer);

    return () => {
      socket.off(ACTIONS.ADD_PEER, handleAddPeer);
      socket.off(ACTIONS.REMOVE_PEER, handleRemovePeer);
    };
  }, []);

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
        setNotifications(prev => [...prev.slice(-2), {
          id: `join-${peerID}-${Date.now()}`,
          message: `${joinedUserName} подключился`,
          type: 'join',
          timestamp: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }]);
      }
      
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
      setNotifications(prev => [...prev.slice(-2), {
        id: `leave-${peerID}-${Date.now()}`,
        message: `${leftUserName} отключился`,
        type: 'leave',
        timestamp: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }]);
      
      if (participants) {
        setAllParticipants(participants);
      }
    };

    const handleParticipantsList = (participants: Participant[]) => {
      setAllParticipants(participants);
    };

    const handleUserNameUpdated = ({ peerID, userName: updatedName }: { peerID: string; userName: string }) => {
      setUserNames(prev => ({ ...prev, [peerID]: updatedName }));
      setAllParticipants(prev => 
        prev.map(p => p.id === peerID ? { ...p, name: updatedName } : p)
      );
      
      if (peerID !== socket.id) {
        setNotifications(prev => [...prev.slice(-2), {
          id: `name-update-${peerID}-${Date.now()}`,
          message: `${updatedName} изменил(а) имя`,
          type: 'system',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }]);
      }
    };

    const handleRaiseHand = ({ peerID, userName }: { peerID: string; userName: string }) => {
      setRaisedHands(prev => new Set(prev).add(peerID));
      
      if (peerID !== socket.id) {
        setNotifications(prev => [...prev.slice(-2), {
          id: `hand-${peerID}-${Date.now()}`,
          message: `${userName} поднял(а) руку`,
          type: 'system',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }]);
      }
    };

    const handleLowerHand = ({ peerID, userName }: { peerID: string; userName: string }) => {
      setRaisedHands(prev => {
        const newSet = new Set(prev);
        newSet.delete(peerID);
        return newSet;
      });
      
      if (peerID === socket.id) {
        setIsHandRaised(false);
      }
    };

    socket.on('user-joined', handleUserJoined);
    socket.on('user-left', handleUserLeft);
    socket.on('participants-list', handleParticipantsList);
    socket.on('user-name-updated', handleUserNameUpdated);
    socket.on(ACTIONS.RAISE_HAND, handleRaiseHand);
    socket.on(ACTIONS.LOWER_HAND, handleLowerHand);
    
    return () => {
      socket.off('user-joined', handleUserJoined);
      socket.off('user-left', handleUserLeft);
      socket.off('participants-list', handleParticipantsList);
      socket.off('user-name-updated', handleUserNameUpdated);
      socket.off(ACTIONS.RAISE_HAND, handleRaiseHand);
      socket.off(ACTIONS.LOWER_HAND, handleLowerHand);
    };
  }, []);

  useEffect(() => {
    if (roomID && devicesInitialized) {
      socket.emit('get-participants', { roomID });
    }
  }, [roomID, devicesInitialized]);

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

  useEffect(() => {
    if (devicesInitialized && forceSyncTracks) {
      const timer = setTimeout(() => {
        forceSyncTracks();
      }, 2000);
      
      return () => clearTimeout(timer);
    }
  }, [devicesInitialized, forceSyncTracks]);

  return (
    <div className={styles.roomContainer}>
      {showDeviceSelection && (
        <DeviceSelection onJoin={handleDeviceSelection} />
      )}

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
            
            {isScreenShare && (
              <div className={styles.screenShareBadge}>
                <span className={styles.screenShareIcon}>🖥️</span>
                <span className={styles.screenShareText}>
                  {isLocal ? 'Вы демонстрируете экран' : 'Демонстрация экрана'}
                </span>
              </div>
            )}
            
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
                <div className={styles.participantStatus}>
                  📹 Нет видео
                </div>
              </div>
            )}
            
            <div className={styles.videoTopControls}>
              <button 
                className={styles.fullscreenButton}
                onClick={() => toggleFullscreen(clientID)}
                title={fullscreenParticipant === clientID ? "Уменьшить" : "Увеличить"}
              >
                {fullscreenParticipant === clientID ? '⤢' : '⤡'}
              </button>

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

            <div className={styles.userLabel}>
              {escapeHtml(getUserDisplayName(clientID))}
              
              {!mediaState.audio && clientID === LOCAL_VIDEO && <span>🔇</span>}
              {!mediaState.video && !mediaState.screen && clientID === LOCAL_VIDEO && <span>📷</span>}
              {mediaState.screen && clientID === LOCAL_VIDEO && <span className={styles.screenShareIndicator}>🖥️</span>}
              
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

      {fullscreenParticipant && (
        <button 
          className={styles.exitFullscreenButton}
          onClick={handleExitFullscreen}
          title="Выйти из полноэкранного режима"
        >
          ✕ Выйти из полноэкранного режима
        </button>
      )}

      <div className={styles.controls}>
        <button
          onClick={() => toggleMedia('audio')}
          className={`${styles.controlButton} ${
            mediaState.audio ? styles.controlButtonMicOn : styles.controlButtonMicOff
          } ${!isDeviceEnabled('audio') ? styles.controlButtonDisabled : ''}`}
          title={mediaState.audio ? 'Выключить микрофон' : 'Включить микрофон'}
          disabled={!isDeviceEnabled('audio')}
        >
          {mediaState.audio ? '🎤' : '🔇'}
        </button>

        <button
          onClick={() => toggleMedia('video')}
          className={`${styles.controlButton} ${
            mediaState.video ? styles.controlButtonCamOn : styles.controlButtonCamOff
          } ${!isDeviceEnabled('video') ? styles.controlButtonDisabled : ''}`}
          title={mediaState.video ? 'Выключить камеру' : 'Включить камеру'}
          disabled={!isDeviceEnabled('video')}
        >
          {mediaState.video ? '📹' : '📷'}
        </button>

        {!isMobile && (
          !mediaState.screen ? (
            <button
              onClick={handleScreenShare}
              className={`${styles.controlButton} ${styles.controlButtonScreenShare}`}
              title="Начать демонстрацию экрана"
            >
              🖥️
            </button>
          ) : (
            <button
              onClick={handleScreenShare}
              className={`${styles.controlButton} ${styles.controlButtonScreenShareActive}`}
              title="Остановить демонстрацию экрана"
            >
              ⏹️
            </button>
          )
        )}

        <button
          onClick={toggleHandRaise}
          className={`${styles.controlButton} ${
            isHandRaised ? styles.controlButtonHandRaised : styles.controlButtonHand
          }`}
          title={isHandRaised ? "Опустить руку" : "Поднять руку"}
        >
          {isHandRaised ? '👇' : '✋'}
        </button>

        <button
          onClick={() => setShowParticipants(!showParticipants)}
          className={`${styles.controlButton} ${
            showParticipants ? styles.controlButtonParticipantsActive : styles.controlButtonParticipants
          }`}
          title="Список участников"
        >
          👥
        </button>

        <button
          onClick={() => setShowChat(!showChat)}
          className={`${styles.controlButton} ${
            showChat ? styles.controlButtonChatActive : styles.controlButtonChat
          }`}
          title={showChat ? 'Скрыть чат' : 'Показать чат'}
        >
          💬
        </button>

        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`${styles.controlButton} ${
            showSettings ? styles.controlButtonSettingsActive : styles.controlButtonSettings
          }`}
          title="Настройки"
        >
          ⚙️
        </button>

        <button
          onClick={handleCopyLink}
          className={`${styles.controlButton} ${styles.copyButton}`}
          title="Скопировать ссылку на комнату"
        >
          <span>🔗</span>
          {isCopied && <span className={styles.copyLabel}>Скопировано!</span>}
        </button>

        <button
          onClick={handleLeaveRoom}
          className={`${styles.controlButton} ${styles.controlButtonLeave}`}
          title="Выйти из комнаты"
        >
          🚪
        </button>
      </div>

      {showParticipants && (
        <div className={styles.participantsPanel}>
          <div className={styles.participantsHeader}>
            <h3>Участники ({participantsList.length})</h3>
            <button
              onClick={() => setShowParticipants(false)}
              className={styles.closeParticipantsButton}
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
                  className={`${styles.participantItem} ${participant.isLocal ? styles.local : ''}`}
                >
                  <div className={`${styles.participantAvatar} ${participant.isLocal ? styles.local : ''} ${
                    participant.isScreenSharing ? styles.screenSharing : ''
                  } ${participant.isHandRaised ? styles.handRaised : ''}`}>
                    {participant.isHandRaised && (
                      <div className={styles.avatarHandIcon}>✋</div>
                    )}
                    {participant.isScreenSharing && (
                      <div className={styles.avatarScreenIcon}>🖥️</div>
                    )}
                    <span className={styles.avatarInitial}>
                      {escapeHtml(participant.name.charAt(0))}
                    </span>
                  </div>
                  <div className={styles.participantInfo}>
                    <div className={styles.participantName}>
                      {escapeHtml(participant.name)}
                      {participant.isLocal && ' (Вы)'}
                    </div>
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
            <button
              onClick={() => setShowChat(false)}
              className={styles.chatCloseButton}
            >
              ×
            </button>
          </div>
          <div ref={chatContainerRef} className={styles.chatMessages}>
            {messages.length === 0 ? (
              <div className={styles.noMessages}>Нет сообщений</div>
            ) : (
              messages.map(msg => (
                <div
                  key={msg.id}
                  className={`${styles.message} ${msg.isLocal ? styles.messageLocal : ''}`}
                >
                  <div className={styles.messageSender}>
                    {escapeHtml(getSenderLabel(msg.sender))}
                  </div>
                  <div
                    className={`${styles.messageBubble} ${
                      msg.isLocal ? styles.messageBubbleLocal : styles.messageBubbleRemote
                    }`}
                    dangerouslySetInnerHTML={{ 
                      __html: escapeHtml(msg.text).replace(/\n/g, '<br>') 
                    }}
                  />
                  <div className={styles.messageTime}>
                    {msg.timestamp} {msg.isLocal ? '✓' : ''}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className={styles.chatInputContainer}>
            <button
              className={styles.attachmentButton}
              onClick={() => fileInputRef.current?.click()}
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
            />

            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              className={styles.fileInput}
            />

            <button
              onClick={handleSendMessage}
              disabled={!messageInput.trim()}
              className={`${styles.chatSendButton} ${
                !messageInput.trim() ? styles.chatSendButtonDisabled : ''
              }`}
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
            <button
              onClick={() => setShowSettings(false)}
              className={styles.settingsCloseButton}
            >
              ×
            </button>
          </div>

          <div className={styles.nameSettings}>
            <label className={styles.settingsLabel}>
              Ваше имя:
            </label>
            <div className={styles.currentName}>{escapeHtml(userName || 'Не указано')}</div>
            <button
              onClick={() => setShowNameInput(true)}
              className={styles.changeNameButton}
            >
              Изменить имя
            </button>
          </div>

          {availableDevices.audio.length > 0 && (
            <div className={styles.settingsSection}>
              <label className={styles.settingsLabel}>
                Микрофон:
              </label>
              <select
                onChange={(e) => switchMediaDevice('audio', e.target.value)}
                className={styles.settingsSelect}
              >
                {availableDevices.audio.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Микрофон ${index + 1}`}
                  </option>
                ))}
              </select>
            </div>
          )}

          {availableDevices.video.length > 0 && (
            <div className={styles.settingsSection}>
              <label className={styles.settingsLabel}>
                Камера:
              </label>
              <select
                onChange={(e) => switchMediaDevice('video', e.target.value)}
                className={styles.settingsSelect}
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
                {escapeHtml(notification.message)}
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