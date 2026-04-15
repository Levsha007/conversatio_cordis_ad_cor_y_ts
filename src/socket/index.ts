import { io, Socket } from 'socket.io-client';
import { ACTIONS } from './actions';

interface ServerToClientEvents {
  [ACTIONS.ADD_PEER]: (params: { peerID: string; createOffer: boolean; userName?: string; hasMedia?: boolean }) => void;
  [ACTIONS.REMOVE_PEER]: (params: { peerID: string }) => void;
  [ACTIONS.CHAT_MESSAGE]: (params: { id: string; sender: string; message: string; timestamp: string; userName?: string }) => void;
  [ACTIONS.CHAT_HISTORY]: (messages: any[]) => void;
  [ACTIONS.RAISE_HAND]: (params: { peerID: string; userName: string }) => void;
  [ACTIONS.LOWER_HAND]: (params: { peerID: string; userName: string }) => void;
  
  'transport-created': (params: any) => void;
  'existing-peers': (peers: Array<{ peerId: string; userName: string; hasMedia: boolean }>) => void;
  'new-producer': (params: { peerId: string; peerName: string; kind: 'audio' | 'video'; consumerParameters: any }) => void;
  'producer-created': (params: { kind: 'audio' | 'video'; producerId: string }) => void;
  'user-name-updated': (params: { peerID: string; userName: string }) => void;
  'error': (params: { message: string }) => void;
}

interface ClientToServerEvents {
  [ACTIONS.JOIN]: (params: { room: string; userName?: string; hasMedia?: boolean }) => void;
  [ACTIONS.CHAT_MESSAGE]: (params: { roomID: string; message: string; id: string; timestamp: string; userName?: string }) => void;
  [ACTIONS.REQUEST_CHAT_HISTORY]: (params: { roomID: string }) => void;
  [ACTIONS.LEAVE]: () => void;
  [ACTIONS.RAISE_HAND]: (params: { roomID: string }) => void;
  [ACTIONS.LOWER_HAND]: (params: { roomID: string }) => void;
  
  'create-producer': (params: { kind: 'audio' | 'video'; rtpParameters: any }) => void;
  'resume-consumer': (params: { peerId: string; kind: 'audio' | 'video' }) => void;
  'update-user-name': (params: { roomID: string; userName: string }) => void;
}

const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
  process.env.REACT_APP_SERVER_URL || "http://localhost:3001",
  {
    transports: ["websocket", "polling"],
    withCredentials: true
  }
);

export default socket;