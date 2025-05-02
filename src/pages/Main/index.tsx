import { useState } from "react";
import { useNavigate } from 'react-router-dom';
import { v4 } from 'uuid';
import styles from './Main.module.css';

const Main: React.FC = () => {
    const navigate = useNavigate();
    const [roomIdInput, setRoomIdInput] = useState('');

    const handleCreateRoom = () => {
        navigate(`/room/${v4()}`);
    };

    const handleJoinRoom = () => {
        if (roomIdInput.trim()) {
            navigate(`/room/${roomIdInput.trim()}`);
        }
    };

    return (
        <div className={styles.container}>
            <h1 className={styles.title}>Video Conference</h1>

            <div className={styles.roomControls}>
                <button
                    onClick={handleCreateRoom}
                    className={styles.createButton}
                >
                    Create New Room
                </button>

                <div className={styles.joinContainer}>
                    <input
                        type="text"
                        value={roomIdInput}
                        onChange={(e) => setRoomIdInput(e.target.value)}
                        placeholder="Enter Room ID"
                        className={styles.roomIdInput}
                    />
                    <button
                        onClick={handleJoinRoom}
                        disabled={!roomIdInput.trim()}
                        className={styles.joinButton}
                    >
                        Join Room
                    </button>
                </div>
            </div>

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