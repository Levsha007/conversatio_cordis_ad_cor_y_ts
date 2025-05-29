// Импорт необходимых зависимостей
import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
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
}

/**
 * Кастомный хук для определения мобильного устройства
 * @returns {boolean} Флаг, является ли устройство мобильным
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
 * Кастомный хук для синхронизации вкладок и предотвращения дубликатов
 * @param roomId - ID комнаты
 */
const useTabSync = (roomId: string) => {
  const navigate = useNavigate();
  useEffect(() => {
    if (!roomId) return;

    // Создаем уникальный идентификатор для текущей вкладки
    const tabId = sessionStorage.getItem(`vc_tab_${roomId}`) || Date.now().toString();
    sessionStorage.setItem(`vc_tab_${roomId}`, tabId);

    // Создаем канал для обмена сообщениями между вкладками
    const channel = new BroadcastChannel(`vc_${roomId}`);
    const handleMessage = (e: MessageEvent) => {
      // Если другая вкладка с таким же roomId активна
      if (e.data.type === 'TAB_ACTIVE' && e.data.tabId !== tabId) {
        // Закрываем соединение и перенаправляем на главную
        socket.emit(ACTIONS.LEAVE);
        navigate('/', { replace: true });
      }
    };
    channel.addEventListener('message', handleMessage);

    // Сообщаем другим вкладкам о своем существовании
    channel.postMessage({ type: 'TAB_ACTIVE', tabId });

    // Очистка при размонтировании компонента
    return () => {
      channel.removeEventListener('message', handleMessage);
      channel.close();
      sessionStorage.removeItem(`vc_tab_${roomId}`);
    };
  }, [roomId, navigate]);
};

/**
 * Функция расчета расположения видео элементов
 */
function calculateLayout(clientsCount: number = 1, isMobile: boolean): LayoutItem[] {
  if (isMobile) {
    return Array(clientsCount).fill({
      width: '100%',
      height: `${100 / Math.min(clientsCount, 4)}%`
    });
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

/**
 * Основной компонент комнаты видеоконференции
 */
const Room: React.FC = () => {
  // Хуки навигации и параметров маршрута
  const navigate = useNavigate();
  const { id: roomID } = useParams<{ id: string }>();
  const { search } = useLocation();

  // Используем хук для синхронизации вкладок
  useTabSync(roomID || '');

  // Определение типа устройства
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

  // Реф для input[type="file"]
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Получение метки отправителя сообщения
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
      if (copyTimeout.current) clearTimeout(copyTimeout.current);
      copyTimeout.current = setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Ошибка при копировании ссылки:', err);
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
    const trimmedMessage = messageInput.trim();
    if (trimmedMessage && roomID) {
      const messageId = `${socket.id}-${Date.now()}`;
      const newMessage: ChatMessage = {
        id: messageId,
        text: trimmedMessage,
        isLocal: true,
        timestamp: new Date().toLocaleTimeString(),
        sender: socket.id || 'unknown'
      };
      addChatMessage(newMessage);
      setMessages(prev => [...prev, newMessage]);
      setMessageInput('');
      socket.emit(ACTIONS.CHAT_MESSAGE, {
        roomID,
        message: trimmedMessage,
        id: messageId,
        timestamp: new Date().toISOString()
      });
    }
  };

  /**
   * Обработчик выбора файла — отправляем как обычное сообщение
   */
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && roomID) {
      const fileId = `${socket.id}-${Date.now()}`;
      const fileNameWithIcon = `📄 ${file.name}`;
      const newMessage: ChatMessage = {
        id: fileId,
        text: fileNameWithIcon,
        isLocal: true,
        timestamp: new Date().toLocaleTimeString(),
        sender: socket.id || 'unknown'
      };
      addChatMessage(newMessage);
      setMessages(prev => [...prev, newMessage]);

      // Отправляем сообщение как обычное текстовое сообщение
      socket.emit(ACTIONS.CHAT_MESSAGE, {
        roomID,
        message: fileNameWithIcon,
        id: fileId,
        timestamp: new Date().toISOString()
      });
    }

    // Сбрасываем значение инпута, чтобы можно было выбрать тот же файл снова
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Автопрокрутка чата к последнему сообщению
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  // Подписка на события чата и запрос истории
  useEffect(() => {
    const chatMessageHandler = (msg: {
      id: string;
      message: string;
      sender: string;
      timestamp: string;
    }) => {
      setMessages(prev => {
        if (prev.some(m => m.id === msg.id)) return prev;
        return [
          ...prev,
          {
            id: msg.id,
            text: msg.message,
            isLocal: msg.sender === socket.id,
            timestamp: new Date(msg.timestamp).toLocaleTimeString(),
            sender: msg.sender
          }
        ];
      });
    };

    socket.on(ACTIONS.CHAT_MESSAGE, chatMessageHandler);
    if (roomID) {
      socket.emit(ACTIONS.REQUEST_CHAT_HISTORY, { roomID });
    }

    return () => {
      socket.off(ACTIONS.CHAT_MESSAGE, chatMessageHandler);
    };
  }, [roomID]);

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
      {/* Оверлей с ошибками */}
      {!isMediaReady || clients.length === 0 || !webRTCStatus.isSupported ? (
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
      {clients.map((clientID, index) => (
        <div key={`${clientID}-${retryCount}`} className={styles.videoWrapper} style={videoLayout[index]}>
          <video
            ref={(instance) => provideMediaRef(clientID, instance)}
            autoPlay
            playsInline
            muted={clientID === LOCAL_VIDEO}
            className={`${styles.video} ${
              clientID === LOCAL_VIDEO && !mediaState.video ? styles.videoLocalHidden : ''
            }`}
          />
          {/* Метка пользователя */}
          <div className={styles.userLabel}>
            {clientID === LOCAL_VIDEO ? 'Вы' : `Участник ${index + 1}`}
            {/* Индикаторы состояния медиа */}
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
            {/* Кнопка скрепки 📎 */}
            <button
              className={styles.attachmentButton}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Прикрепить файл"
            >
              📎
            </button>

            {/* Поле ввода текста */}
            <input
              type="text"
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
              placeholder="Введите сообщение..."
              className={styles.chatInput}
              aria-label="Введите сообщение"
            />

            {/* Скрытое поле для файла */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              className={styles.fileInput}
              aria-hidden="true"
            />

            {/* Кнопка отправки */}
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

          {/* Выбор микрофона */}
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

          {/* Выбор камеры */}
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
        </div>
      )}
    </div>
  );
};

export default Room;