import { io, Socket, ManagerOptions, SocketOptions } from 'socket.io-client';
import { ACTIONS } from './actions';

// Объединяем типы опций
type CustomSocketOptions = Partial<ManagerOptions & SocketOptions> & {
  "force new connection"?: boolean;
};

const options: CustomSocketOptions = {
  "force new connection": true,
  reconnectionAttempts: Infinity, // Используем number вместо строки "Infinity"
  timeout: 10000,
  transports: ["websocket"],
  withCredentials: true
};

interface ServerToClientEvents {
  [ACTIONS.SHARE_ROOMS]: (params: { rooms: string[] }) => void;
  [ACTIONS.ADD_PEER]: (params: { peerID: string, createOffer: boolean }) => void;
  [ACTIONS.REMOVE_PEER]: (params: { peerID: string }) => void;
  [ACTIONS.ICE_CANDIDATE]: (params: { peerID: string, iceCandidate: RTCIceCandidate }) => void;
  [ACTIONS.SESSION_DESCRIPTION]: (params: { peerID: string, sessionDescription: RTCSessionDescriptionInit }) => void;
  [ACTIONS.CHAT_MESSAGE]: (params: { 
    id: string;
    sender: string;
    message: string;
    timestamp: string;
  }) => void;
}

interface ClientToServerEvents {
  [ACTIONS.JOIN]: (params: { room: string }) => void;
  [ACTIONS.GET_ROOMS]: () => void;
  [ACTIONS.RELAY_ICE]: (params: { peerID: string, iceCandidate: RTCIceCandidate }) => void;
  [ACTIONS.RELAY_SDP]: (params: { peerID: string, sessionDescription: RTCSessionDescriptionInit }) => void;
  [ACTIONS.CHAT_MESSAGE]: (params: { 
    roomID: string;
    message: string;
    id: string;
    timestamp: string;
  }) => void;
  [ACTIONS.REQUEST_CHAT_HISTORY]: (params: { roomID: string }) => void;
}

const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
  "https://conversatio-cordis-ad-cor.onrender.com", 
  {
    ...options,
    transports: ["websocket", "polling"] as const // Явное указание типа
  }
);

export default socket;