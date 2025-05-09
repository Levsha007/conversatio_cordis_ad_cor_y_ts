// Импорт необходимых зависимостей
import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import useWebRTC, { LOCAL_VIDEO } from '../../hooks/useWebRTC';
import socket from '../../socket';
import { ACTIONS } from '../../socket/actions';
import styles from './Room.module.css';

/**
 * Интерфейс для описания layout видео элементов
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
}

/**
 * Кастомный хук для определения мобильного устройства
 * @returns {boolean} Флаг, является ли устройство мобильным
 */
const useIsMobile = (): boolean => {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    // Функция проверки размера экрана
    const checkIsMobile = () => setIsMobile(window.innerWidth <= 767);
    
    // Первоначальная проверка
    checkIsMobile();
    
    // Подписка на изменение размера окна
    window.addEventListener('resize', checkIsMobile);
    
    // Отписка при размонтировании
    return () => window.removeEventListener('resize', checkIsMobile);
  }, []);

  return isMobile;
};

/**
 * Функция расчета расположения видео элементов
 * @param {number} clientsCount - Количество клиентов
 * @param {boolean} isMobile - Флаг мобильного устройства
 * @returns {LayoutItem[]} Массив с параметрами layout
 */
function calculateLayout(clientsCount: number = 1, isMobile: boolean): LayoutItem[] {
  // Для мобильных устройств - вертикальный стек
  if (isMobile) {
    return Array(clientsCount).fill({
      width: '100%',
      height: `${100 / Math.min(clientsCount, 4)}%` // Макс 4 участника на экране
    });
  }
  
  // Для десктопа - сетка 2x2
  const pairs = Array.from({ length: clientsCount })
    .reduce<Array<Array<undefined>>>((acc, _, index, arr) => {
      if (index % 2 === 0) acc.push(arr.slice(index, index + 2) as undefined[]);
      return acc;
    }, []);

  return pairs.map((row, index, arr) => {
    const height = `${100 / pairs.length}%`;
    if (index === arr.length - 1 && row.length === 1) {
      return [{ width: '100%', height }];
    }
    return row.map(() => ({ width: '50%', height }));
  }).flat();
}

/**
 * Основной компонент комнаты видеоконференции
 */
const Room: React.FC = () => {
  // Хуки навигации и параметров
  const navigate = useNavigate();
  const { id: roomID } = useParams<{ id: string }>();
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
    reconnect
  } = useWebRTC(roomID || '');

  // Состояния компонента
  const videoLayout = calculateLayout(clients.length, isMobile);
  const [retryCount, setRetryCount] = useState(0);
  const errorShown = useRef(false);
  const [messageInput, setMessageInput] = useState('');
  const [showChat, setShowChat] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(getChatMessages());
  const [isCopied, setIsCopied] = useState(false);
  const copyTimeout = useRef<NodeJS.Timeout | null>(null);

  /**
   * Получение метки отправителя сообщения
   * @param {string} senderId - ID отправителя
   * @returns {string} Понятное имя отправителя
   */
  const getSenderLabel = (senderId: string): string => {
    if (senderId === socket.id) return 'Вы';
    const peerIndex = clients.indexOf(senderId);
    return peerIndex !== -1 ? `Участник ${peerIndex + 1}` : 'Неизвестный';
  };

  /**
   * Копирование ссылки на комнату в буфер обмена
   */
  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setIsCopied(true);
      
      // Сброс флага через 2 секунды
      if (copyTimeout.current) clearTimeout(copyTimeout.current);
      copyTimeout.current = setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy link:', err);
    }
  };

  /**
   * Выход из комнаты с подтверждением
   */
  const handleLeaveRoom = () => {
    if (window.confirm('Вы уверены, что хотите выйти из комнаты?')) {
      navigate('/');
    }
  };

  /**
   * Повторная попытка подключения
   */
  const handleRetry = async () => {
    setRetryCount(prev => prev + 1);
    errorShown.current = false;
    await reconnect();
  };

  /**
   * Отправка сообщения в чат
   */
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
      
      // Добавление сообщения локально
      addChatMessage(newMessage);
      setMessages(prev => [...prev, newMessage]);
      setMessageInput('');
      
      // Отправка сообщения через сокет
      socket.emit(ACTIONS.CHAT_MESSAGE, { 
        roomID, 
        message: messageInput,
        id: messageId,
        timestamp: new Date().toISOString()
      });
    }
  };

  // Автопрокрутка чата к последнему сообщению
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  // Подписка на сообщения чата
  useEffect(() => {
    /**
     * Обработчик входящих сообщений чата
     */
    const chatMessageHandler = (msg: {
      id: string;
      message: string;
      sender: string;
      timestamp: string;
    }) => {
      setMessages(prev => {
        // Проверка на дубликаты
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

    // Подписка на события чата
    socket.on(ACTIONS.CHAT_MESSAGE, chatMessageHandler);
    
    // Запрос истории чата при загрузке
    if (roomID) {
      socket.emit(ACTIONS.REQUEST_CHAT_HISTORY, { roomID });
    }

    // Отписка при размонтировании
    return () => {
      socket.off(ACTIONS.CHAT_MESSAGE, chatMessageHandler);
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

  // Рендер компонента
  return (
    <div className={styles.roomContainer}>
      {/* Оверлей с ошибками */}
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

      {/* Видео потоки участников */}
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
        {/* Кнопка микрофона */}
        <button
          onClick={() => toggleMedia('audio')}
          className={`${styles.controlButton} ${
            mediaState.audio ? styles.controlButtonMicOn : styles.controlButtonMicOff
          }`}
          title={mediaState.audio ? 'Выключить микрофон' : 'Включить микрофон'}
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
        >
          {mediaState.video ? '📹' : '📷'}
        </button>

        {/* Кнопка чата */}
        <button
          onClick={() => setShowChat(!showChat)}
          className={`${styles.controlButton} ${
            showChat ? styles.controlButtonChatActive : styles.controlButtonChat
          }`}
          title={showChat ? 'Скрыть чат' : 'Показать чат'}
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
        >
          ⚙️
        </button>

        {/* Кнопка копирования ссылки */}
        <button
          onClick={handleCopyLink}
          className={`${styles.controlButton} ${styles.copyButton}`}
          title="Скопировать ссылку на комнату"
        >
          <span>🔗</span>
          {isCopied && <span className={styles.copyLabel}>Скопировано!</span>}
        </button>

        {/* Кнопка выхода */}
        <button
          onClick={handleLeaveRoom}
          className={`${styles.controlButton} ${styles.controlButtonLeave}`}
          title="Выйти из комнаты"
        >
          🚪
        </button>
      </div>

      {/* Чат */}
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
                  <div className={styles.messageSender}>
                    {getSenderLabel(msg.sender)}
                  </div>
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
          
          {/* Поле ввода сообщения */}
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
            >
              ×
            </button>
          </div>

          {/* Выбор микрофона */}
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

          {/* Выбор камеры */}
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