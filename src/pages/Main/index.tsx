// Импорт необходимых зависимостей
import { useState } from "react";
import { useNavigate } from 'react-router-dom';
import { v4 } from 'uuid';
import { validate } from 'uuid';
import styles from './Main.module.css';

// Основной компонент приложения
const Main: React.FC = () => {
    // Хук для навигации между страницами
    const navigate = useNavigate();
    
    // Состояние для хранения введенного ID комнаты
    const [roomIdInput, setRoomIdInput] = useState('');
    const [error, setError] = useState('');

    // Обработчик создания новой комнаты
    const handleCreateRoom = () => {
        // Генерируем уникальный ID комнаты и переходим на страницу комнаты
        navigate(`/room/${v4()}`);
    };

    // Обработчик входа в существующую комнату
    const handleJoinRoom = () => {
        // Сбрасываем ошибку
        setError('');
        
        // Проверяем, что введен непустой ID комнаты
        const trimmedId = roomIdInput.trim();
        if (!trimmedId) {
            setError('Введите ID комнаты');
            return;
        }

        // Дополнительная валидация UUID
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        
        if (!uuidRegex.test(trimmedId)) {
            setError('Неверный формат ID комнаты. ID должен быть в формате UUID (например: 550e8400-e29b-41d4-a716-446655440000)');
            return;
        }
        
        // Проверка на XSS в ID (хотя маловероятно)
        if (/[<>"'`&]/.test(trimmedId)) {
            setError('ID комнаты содержит недопустимые символы');
            return;
        }

        // Переходим на страницу комнаты с введенным ID
        navigate(`/room/${trimmedId}`);
    };

    // Обработчик изменения поля ввода
    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        // Фильтрация на лету
        const filtered = value.replace(/[<>"'`&]/g, '');
        if (filtered.length <= 36) { // UUID макс длина 36 символов
            setRoomIdInput(filtered);
        }
        // Сбрасываем ошибку при изменении текста
        if (error) setError('');
    };

    // Рендер компонента
    return (
        <div className={styles.container}>
            <div className={styles.content}>
                {/* Заголовок приложения */}
                <h1 className={styles.title}>Video Conference</h1>

                {/* Блок управления комнатами */}
                <div className={styles.roomControls}>
                    {/* Кнопка создания новой комнаты */}
                    <button
                        onClick={handleCreateRoom}
                        className={styles.createButton}
                    >
                        Create New Room
                    </button>

                    {/* Блок для входа в существующую комнату */}
                    <div className={styles.joinContainer}>
                        {/* Поле ввода ID комнаты */}
                        <input
                            type="text"
                            value={roomIdInput}
                            onChange={handleInputChange}
                            placeholder="Enter Room ID (UUID format)"
                            className={styles.roomIdInput}
                            maxLength={36}
                        />
                        {/* Кнопка входа в комнату (активна только при введенном ID) */}
                        <button
                            onClick={handleJoinRoom}
                            disabled={!roomIdInput.trim()}
                            className={styles.joinButton}
                        >
                            Join Room
                        </button>
                    </div>

                    {/* Отображение ошибки */}
                    {error && (
                        <div className={styles.errorMessage}>
                            {error}
                        </div>
                    )}
                </div>

                {/* Информационный блок с инструкциями */}
                <div className={styles.infoBox}>
                    <h3 className={styles.infoTitle}>How it works:</h3>
                    <ol className={styles.infoList}>
                        <li>Create a new room to get a unique room ID</li>
                        <li>Share the room ID with participants</li>
                        <li>Join using the room ID you received</li>
                        <li>Room ID must be a valid UUID format</li>
                        <li>Example UUID: 550e8400-e29b-41d4-a716-446655440000</li>
                    </ol>
                </div>
            </div>
        </div>
    );
};

export default Main;