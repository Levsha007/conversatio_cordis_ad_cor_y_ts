// src/socket/index.ts

import { io, Socket, ManagerOptions, SocketOptions } from 'socket.io-client';
import { ACTIONS, ClientToServerEvents, ServerToClientEvents } from './actions';

type CustomSocketOptions = Partial<ManagerOptions & SocketOptions> & {
  "force new connection"?: boolean;
};

const options: CustomSocketOptions = {
  "force new connection": true,
  reconnectionAttempts: Infinity,
  timeout: 10000,
  transports: ["websocket", "polling"],
  withCredentials: true
};

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || "https://conversatio-cordis-ad-cor-y-ts.onrender.com";

console.log('[Socket] Connecting to:', SOCKET_URL);

const socket = io(SOCKET_URL, options) as Socket<ServerToClientEvents, ClientToServerEvents>;

socket.on('connect', () => {
  console.log('[Socket] Connected, ID:', socket.id);
});

socket.on('connect_error', (err: Error) => {
  console.error('[Socket] Connection error:', err.message);
});

socket.on('disconnect', (reason: string) => {
  console.log('[Socket] Disconnected, reason:', reason);
});

(socket as any).on('reconnect', (attemptNumber: number) => {
  console.log('[Socket] Reconnected after', attemptNumber, 'attempts');
});

export default socket;