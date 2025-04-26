import { useParams, useNavigate } from 'react-router-dom';
import useWebRTC, { LOCAL_VIDEO } from '../../hooks/useWebRTC';
import { useEffect, useRef, useState } from 'react';
import socket from '../../socket';
import { ACTIONS } from '../../socket/actions';
import styles from './Room.module.css';

// Интерфейс для размеров видео элементов
interface LayoutItem {
  width: string;
  height: string;
}

// Интерфейс сообщения чата
interface ChatMessage {
  id: string;
  text: string;
  isLocal: boolean;
  timestamp: string;
  sender: string;
}

// Кастомный хук для определения мобильного устройства
const useIsMobile = (): boolean => {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkIsMobile = () => {
      setIsMobile(window.innerWidth <= 767); // Проверка ширины экрана
    };
    
    checkIsMobile();
    window.addEventListener('resize', checkIsMobile);
    return () => window.removeEventListener('resize', checkIsMobile);
  }, []);

  return isMobile;
};

// Функция расчета расположения видео элементов
function calculateLayout(clientsCount: number = 1): LayoutItem[] {
  const pairs = Array.from({ length: clientsCount })
    .reduce<Array<Array<undefined>>>((acc, _, index, arr) => {
      if (index % 2 === 0) {
        acc.push(arr.slice(index, index + 2) as undefined[]);
      }
      return acc;
    }, []);

  const rowsNumber = pairs.length;
  const height = `${100 / rowsNumber}%`;

  return pairs.map((row, index, arr) => {
    if (index === arr.length - 1 && row.length === 1) {
      return [{
        width: '100%',
        height,
      }];
    }

    return row.map(() => ({
      width: '50%',
      height,
    }));
  }).flat();
}

// Основной компонент комнаты
const Room: React.FC = () => {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { id: roomID } = useParams<{ id: string }>();
  
  // Использование хука WebRTC
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
    reconnect
  } = useWebRTC(roomID || '');
  
  const videoLayout = calculateLayout(clients.length);
  const [retryCount, setRetryCount] = useState(0);
  const errorShown = useRef(false);
  const [messageInput, setMessageInput] = useState('');
  const [showChat, setShowChat] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(getChatMessages());

  // Обработчик выхода из комнаты
  const handleLeaveRoom = () => {
    if (window.confirm('Вы уверены, что хотите выйти из комнаты?')) {
      navigate('/');
    }
  };

  // Обработчик повторного подключения
  const handleRetry = async () => {
    setRetryCount(prev => prev + 1);
    errorShown.current = false;
    await reconnect();
  };

  // Обработчик отправки сообщения
  const handleSendMessage = () => {
    if (messageInput.trim() && roomID) {
      const messageId = `${socket.id}-${Date.now()}`;
      const newMessage: ChatMessage = {
        id: messageId,
        text: messageInput,
        isLocal: true,
        timestamp: new Date().toLocaleTimeString(),
        sender: socket.id || 'unknown'
      };
      
      addChatMessage(newMessage);
      setMessages(prev => [...prev, newMessage]);
      setMessageInput('');
      
      socket.emit(ACTIONS.CHAT_MESSAGE, { 
        roomID, 
        message: messageInput,
        id: messageId,
        timestamp: new Date().toISOString()
      });
    }
  };

  // Автопрокрутка чата при новых сообщениях
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  // Подписка на сообщения чата
  useEffect(() => {
    const chatMessageHandler = (msg: {
      id: string;
      message: string;
      sender: string;
      timestamp: string;
    }) => {
      if (!msg.sender) {
        console.warn('Received message without sender:', msg);
        return;
      }

      setMessages(prev => {
        if (prev.some(m => m.id === msg.id)) return prev;
        return [...prev, {
          id: msg.id,
          text: msg.message,
          isLocal: msg.sender === socket.id,
          timestamp: new Date(msg.timestamp).toLocaleTimeString(),
          sender: msg.sender
        }];
      });
    };

    socket.on(ACTIONS.CHAT_MESSAGE as any, chatMessageHandler);
    if (roomID) {
      socket.emit(ACTIONS.REQUEST_CHAT_HISTORY, { roomID });
    }

    return () => {
      socket.off(ACTIONS.CHAT_MESSAGE as any, chatMessageHandler);
    };
  }, [roomID]);

  // Обработка ошибок медиа
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
        errorMessage = `Ошибка: ${mediaError?.message || 'Unknown error'}`;
      }

      console.error('Error:', errorMessage);
      alert(errorMessage);
    }
  }, [mediaError, webRTCStatus, retryCount]);

  return (
    <div className={styles.roomContainer}>
      {/* Блок ошибок и загрузки */}
      {!isMediaReady || clients.length === 0 || !webRTCStatus.isSupported ? (
        <div className={styles.errorOverlay}>
          {!webRTCStatus.isSupported ? (
            <>
              <h2 className={styles.errorTitle}>
                WebRTC не поддерживается в вашем браузере
              </h2>
              <p className={styles.errorDescription}>
                {webRTCStatus.errors.join(', ')}
              </p>
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
              <button 
                onClick={handleRetry}
                className={styles.retryButton}
              >
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

      {/* Видео элементы участников */}
      {clients.map((clientID, index) => (
        <div 
          key={`${clientID}-${retryCount}`}
          className={styles.videoWrapper}
          style={videoLayout[index]}
        >
          <video
            ref={instance => provideMediaRef(clientID, instance)}
            autoPlay
            playsInline
            muted={clientID === LOCAL_VIDEO}
            className={`${styles.video} ${
              clientID === LOCAL_VIDEO && !mediaState.video ? styles.videoLocalHidden : ''
            }`}
          />
          <div className={styles.userLabel}>
            {clientID === LOCAL_VIDEO ? 'Вы' : `Участник ${index + 1}`}
            {!mediaState.audio && clientID === LOCAL_VIDEO && <span>🔇</span>}
            {!mediaState.video && clientID === LOCAL_VIDEO && <span>📷</span>}
          </div>
        </div>
      ))}

      {/* Панель управления */}
      <div className={styles.controls}>
        <button
          onClick={() => toggleMedia('audio')}
          className={`${styles.controlButton} ${
            mediaState.audio ? styles.controlButtonMicOn : styles.controlButtonMicOff
          }`}
          title={mediaState.audio ? 'Выключить микрофон' : 'Включить микрофон'}
        >
          {mediaState.audio ? '🎤' : '🔇'}
        </button>

        <button
          onClick={() => toggleMedia('video')}
          className={`${styles.controlButton} ${
            mediaState.video ? styles.controlButtonCamOn : styles.controlButtonCamOff
          }`}
          title={mediaState.video ? 'Выключить камеру' : 'Включить камеру'}
        >
          {mediaState.video ? '📹' : '📷'}
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
          onClick={handleLeaveRoom}
          className={`${styles.controlButton} ${styles.controlButtonLeave}`}
          title="Выйти из комнаты"
        >
          🚪
        </button>
      </div>

      {/* Чат комнаты */}
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
          
          <div 
            ref={chatContainerRef}
            className={styles.chatMessages}
          >
            {messages.length === 0 ? (
              <div className={styles.noMessages}>
                Нет сообщений
              </div>
            ) : (
              messages.map(msg => (
                <div 
                  key={msg.id}
                  className={`${styles.message} ${
                    msg.isLocal ? styles.messageLocal : ''
                  }`}
                >
                  <div className={`${styles.messageBubble} ${
                    msg.isLocal ? styles.messageBubbleLocal : styles.messageBubbleRemote
                  }`}>
                    {msg.text}
                  </div>
                  <div className={styles.messageTime}>
                    {msg.timestamp} {msg.isLocal ? '✓' : ''}
                  </div>
                </div>
              ))
            )}
          </div>
          
          <div className={styles.chatInputContainer}>
            <input
              type="text"
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
              placeholder="Введите сообщение..."
              className={styles.chatInput}
            />
            <button
              onClick={handleSendMessage}
              disabled={!messageInput.trim()}
              className={`${styles.chatSendButton} ${
                !messageInput.trim() ? styles.chatSendButtonDisabled : ''
              }`}
            >
              Отпр
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
            >
              ×
            </button>
          </div>

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
        </div>
      )}
    </div>
  );
};

export default Room;