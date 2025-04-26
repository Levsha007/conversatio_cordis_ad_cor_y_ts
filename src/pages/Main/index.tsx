import { useEffect, useState, useRef } from "react";
import { useNavigate } from 'react-router-dom';
import { v4 } from 'uuid';
import socket from "../../socket";
import ACTIONS from "../../socket/actions";
import styles from './Main.module.css';

// Пропсы для компонента списка комнат
interface RoomListProps {
  rooms: string[]; // Массив ID комнат
  onJoinRoom: (roomID: string) => void; // Обработчик входа в комнату
}

// Компонент отображения списка доступных комнат
const RoomList: React.FC<RoomListProps> = ({ rooms, onJoinRoom }) => (
  <div className={styles.roomsList}>
    {rooms.map(roomID => (
      <div key={roomID} className={styles.roomItem}>
        <span className={styles.roomName}>Room: {roomID}</span>
        <button
          onClick={() => onJoinRoom(roomID)}
          className={styles.joinButton}
        >
          Join Room
        </button>
      </div>
    ))}
  </div>
);

// Компонент с инструкцией по использованию
const HowItWorks: React.FC = () => (
  <div className={styles.infoBox}>
    <h3 className={styles.infoTitle}>How it works:</h3>
    <ol className={styles.infoList}>
      <li>Create a new room or join an existing one</li>
      <li>Allow camera and microphone access when prompted</li>
      <li>Share the room URL with others to invite them</li>
    </ol>
  </div>
);

// Основной компонент главной страницы
const Main: React.FC = () => {
    const navigate = useNavigate();
    const [rooms, setRooms] = useState<string[]>([]); // Состояние списка комнат
    const rootNode = useRef<HTMLDivElement>(null); // Ref для корневого элемента

    useEffect(() => {
        // Обработчик обновления списка комнат
        const handleRoomsUpdate = ({ rooms = [] }: { rooms?: string[] } = {}) => {
            if (rootNode.current) {
                setRooms(rooms);
            }
        };

        // Подписка на события сокета
        socket.on(ACTIONS.SHARE_ROOMS, handleRoomsUpdate);
        socket.emit(ACTIONS.GET_ROOMS); // Запрос списка комнат

        // Обработчик ошибки подключения
        socket.on('connect_error', (err: Error) => {
            console.error('Connection error:', err);
        });

        // Отписка от событий при размонтировании
        return () => {
            socket.off(ACTIONS.SHARE_ROOMS, handleRoomsUpdate);
            socket.off('connect_error');
        };
    }, []);

    // Обработчик входа в существующую комнату
    const handleJoinRoom = (roomID: string) => {
        navigate(`/room/${roomID}`);
    };

    // Обработчик создания новой комнаты
    const handleCreateRoom = () => {
        navigate(`/room/${v4()}`); // Генерация уникального ID комнаты
    };

    return (
        <div ref={rootNode} className={styles.container}>
            <h1 className={styles.title}>Available Video Rooms</h1>

            {rooms.length > 0 ? (
                <RoomList rooms={rooms} onJoinRoom={handleJoinRoom} />
            ) : (
                <p className={styles.noRoomsMessage}>
                    No active rooms available. Create your own!
                </p>
            )}

            <button
                onClick={handleCreateRoom}
                className={styles.createButton}
            >
                Create New Room
            </button>

            <HowItWorks />
        </div>
    );
};

export default Main;