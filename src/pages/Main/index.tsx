import { useEffect, useState, useRef } from "react";
import { useNavigate } from 'react-router-dom';
import { v4 } from 'uuid';
import socket from "../../socket";
import ACTIONS from "../../socket/actions";
import styles from './Main.module.css';

interface RoomListProps {
  rooms: string[];
  onJoinRoom: (roomID: string) => void;
}

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

const Main: React.FC = () => {
    const navigate = useNavigate();
    const [rooms, setRooms] = useState<string[]>([]);
    const rootNode = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleRoomsUpdate = ({ rooms = [] }: { rooms?: string[] } = {}) => {
            if (rootNode.current) {
                setRooms(rooms);
            }
        };

        socket.on(ACTIONS.SHARE_ROOMS, handleRoomsUpdate);
        socket.emit(ACTIONS.GET_ROOMS);

        socket.on('connect_error', (err: Error) => {
            console.error('Connection error:', err);
        });

        return () => {
            socket.off(ACTIONS.SHARE_ROOMS, handleRoomsUpdate);
            socket.off('connect_error');
        };
    }, []);

    const handleJoinRoom = (roomID: string) => {
        navigate(`/room/${roomID}`);
    };

    const handleCreateRoom = () => {
        navigate(`/room/${v4()}`);
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