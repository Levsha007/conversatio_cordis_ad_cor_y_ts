import { types } from 'mediasoup';
import MediasoupWorker from './mediasoup-worker';
import { SFUPeer } from './peer';

interface RoomInfo {
  id: string;
  router: types.Router;
  peers: Map<string, SFUPeer>;
  audioLevels: Map<string, number>;
  createdAt: Date;
}

class RoomManager {
  private static instance: RoomManager;
  private rooms: Map<string, RoomInfo> = new Map();

  private constructor() {}

  static getInstance(): RoomManager {
    if (!RoomManager.instance) {
      RoomManager.instance = new RoomManager();
    }
    return RoomManager.instance;
  }

  async getOrCreateRoom(roomId: string): Promise<RoomInfo> {
    if (this.rooms.has(roomId)) {
      return this.rooms.get(roomId)!;
    }

    const worker = MediasoupWorker.getInstance();
    const router = await worker.getRouter(roomId);

    const roomInfo: RoomInfo = {
      id: roomId,
      router,
      peers: new Map(),
      audioLevels: new Map(),
      createdAt: new Date()
    };

    this.rooms.set(roomId, roomInfo);
    console.log(`Room created: ${roomId}`);
    
    return roomInfo;
  }

  getRoom(roomId: string): RoomInfo | undefined {
    return this.rooms.get(roomId);
  }

  async addPeer(roomId: string, peerId: string, peer: SFUPeer): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room) {
      room.peers.set(peerId, peer);
      console.log(`Peer ${peerId} added to room ${roomId}, total: ${room.peers.size}`);
    }
  }

  removePeer(roomId: string, peerId: string): void {
    const room = this.rooms.get(roomId);
    if (room) {
      room.peers.delete(peerId);
      console.log(`Peer ${peerId} removed from room ${roomId}, remaining: ${room.peers.size}`);

      // Если комната пуста, удаляем её
      if (room.peers.size === 0) {
        this.cleanupRoom(roomId);
      }
    }
  }

  async cleanupRoom(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room) {
      // Закрываем все peer соединения
      for (const peer of room.peers.values()) {
        await peer.close();
      }
      
      // Закрываем router
      await MediasoupWorker.getInstance().closeRouter(roomId);
      
      this.rooms.delete(roomId);
      console.log(`Room cleaned up: ${roomId}`);
    }
  }

  getPeer(roomId: string, peerId: string): SFUPeer | undefined {
    const room = this.rooms.get(roomId);
    return room?.peers.get(peerId);
  }

  getAllPeers(roomId: string): SFUPeer[] {
    const room = this.rooms.get(roomId);
    return room ? Array.from(room.peers.values()) : [];
  }

  getPeerCount(roomId: string): number {
    return this.rooms.get(roomId)?.peers.size || 0;
  }

  updateAudioLevel(roomId: string, peerId: string, level: number): void {
    const room = this.rooms.get(roomId);
    if (room) {
      room.audioLevels.set(peerId, level);
    }
  }

  getActiveSpeaker(roomId: string): string | null {
    const room = this.rooms.get(roomId);
    if (!room || room.audioLevels.size === 0) return null;

    let maxLevel = -Infinity;
    let activeSpeaker: string | null = null;

    for (const [peerId, level] of room.audioLevels) {
      if (level > maxLevel) {
        maxLevel = level;
        activeSpeaker = peerId;
      }
    }

    return activeSpeaker;
  }
}

export default RoomManager;
export type { RoomInfo };