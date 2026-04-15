import { types } from 'mediasoup';
import { Socket } from 'socket.io';

export interface PeerData {
  id: string;
  socketId: string;
  userName: string;
  hasMedia: boolean;
  joinedAt: Date;
}

export class SFUPeer {
  public id: string;
  public socketId: string;
  public userName: string;
  public hasMedia: boolean;
  public joinedAt: Date;
  
  public transport: types.Transport | null = null;
  public producers: Map<string, types.Producer> = new Map();
  public consumers: Map<string, types.Consumer> = new Map();
  
  private socket: Socket | null = null;

  constructor(data: PeerData) {
    this.id = data.id;
    this.socketId = data.socketId;
    this.userName = data.userName;
    this.hasMedia = data.hasMedia;
    this.joinedAt = data.joinedAt;
  }

  setSocket(socket: Socket): void {
    this.socket = socket;
  }

  getSocket(): Socket | null {
    return this.socket;
  }

  async setTransport(transport: types.Transport): Promise<void> {
    this.transport = transport;
  }

  getTransport(): types.Transport | null {
    return this.transport;
  }

  addProducer(kind: string, producer: types.Producer): void {
    this.producers.set(kind, producer);
    console.log(`Producer added for peer ${this.id}: ${kind}`);
  }

  removeProducer(kind: string): void {
    const producer = this.producers.get(kind);
    if (producer) {
      producer.close();
      this.producers.delete(kind);
      console.log(`Producer removed for peer ${this.id}: ${kind}`);
    }
  }

  getProducer(kind: string): types.Producer | undefined {
    return this.producers.get(kind);
  }

  hasProducer(kind: string): boolean {
    return this.producers.has(kind);
  }

  addConsumer(peerId: string, kind: string, consumer: types.Consumer): void {
    const key = `${peerId}:${kind}`;
    this.consumers.set(key, consumer);
  }

  removeConsumer(peerId: string, kind: string): void {
    const key = `${peerId}:${kind}`;
    const consumer = this.consumers.get(key);
    if (consumer) {
      consumer.close();
      this.consumers.delete(key);
    }
  }

  getConsumer(peerId: string, kind: string): types.Consumer | undefined {
    const key = `${peerId}:${kind}`;
    return this.consumers.get(key);
  }

  async close(): Promise<void> {
    // Закрываем все producers
    for (const producer of this.producers.values()) {
      producer.close();
    }
    this.producers.clear();

    // Закрываем все consumers
    for (const consumer of this.consumers.values()) {
      consumer.close();
    }
    this.consumers.clear();

    // Закрываем transport
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }

    console.log(`Peer ${this.id} closed`);
  }

  toJSON(): object {
    return {
      id: this.id,
      userName: this.userName,
      hasMedia: this.hasMedia,
      joinedAt: this.joinedAt,
      hasTransport: !!this.transport,
      producerCount: this.producers.size,
      consumerCount: this.consumers.size
    };
  }
}