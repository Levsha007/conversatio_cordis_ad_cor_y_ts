// Импорт необходимых зависимостей
import { useState } from "react";
import { useNavigate } from 'react-router-dom';
import { v4 } from 'uuid';
import styles from './Main.module.css';

// Основной компонент приложения
const Main: React.FC = () => {
    // Хук для навигации между страницами
    const navigate = useNavigate();
    
    // Состояние для хранения введенного ID комнаты
    const [roomIdInput, setRoomIdInput] = useState('');

    // Обработчик создания новой комнаты
    const handleCreateRoom = () => {
        // Генерируем уникальный ID комнаты и переходим на страницу комнаты
        navigate(`/room/${v4()}`);
    };

    // Обработчик входа в существующую комнату
    const handleJoinRoom = () => {
        // Проверяем, что введен непустой ID комнаты
        if (roomIdInput.trim()) {
            // Переходим на страницу комнаты с введенным ID
            navigate(`/room/${roomIdInput.trim()}`);
        }
    };

    // Рендер компонента
    return (
        <div className={styles.container}>
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
                        onChange={(e) => setRoomIdInput(e.target.value)}
                        placeholder="Enter Room ID"
                        className={styles.roomIdInput}
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
            </div>

            {/* Информационный блок с инструкциями */}
            <div className={styles.infoBox}>
                <h3 className={styles.infoTitle}>How it works:</h3>
                <ol className={styles.infoList}>
                    <li>Create a new room to get a unique room ID</li>
                    <li>Share the room ID with participants</li>
                    <li>Join using the room ID you received</li>
                    <li>Room ID is case-sensitive and must be exact</li>
                </ol>
            </div>
        </div>
    );
};

export default Main;