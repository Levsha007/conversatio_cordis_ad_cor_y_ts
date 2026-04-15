import * as mediasoup from 'mediasoup';
import { types } from 'mediasoup';

// Конфигурация медиа-воркера
const workerSettings: types.WorkerSettings = {
  logLevel: 'warn',
  logTags: [
    'info',
    'ice',
    'dtls',
    'rtp',
    'srtp',
    'rtcp'
  ],
  rtcMinPort: 40000,
  rtcMaxPort: 40100
};

// Кодеки для поддержки (с добавленными preferredPayloadType)
const mediaCodecs: types.RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 111,
    parameters: {
      useinbandfec: 1,
      stereo: 1
    }
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    preferredPayloadType: 96,
    parameters: {
      'x-google-start-bitrate': 1000
    }
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    preferredPayloadType: 102,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1
    }
  },
  {
    kind: 'video',
    mimeType: 'video/rtx',
    clockRate: 90000,
    preferredPayloadType: 97
  }
];

class MediasoupWorker {
  private static instance: MediasoupWorker;
  private worker: types.Worker | null = null;
  private routers: Map<string, types.Router> = new Map();

  private constructor() {}

  static getInstance(): MediasoupWorker {
    if (!MediasoupWorker.instance) {
      MediasoupWorker.instance = new MediasoupWorker();
    }
    return MediasoupWorker.instance;
  }

  async init(): Promise<void> {
    if (this.worker) {
      console.log('Mediasoup worker already initialized');
      return;
    }

    try {
      this.worker = await mediasoup.createWorker(workerSettings);
      console.log(`Mediasoup worker created with pid: ${this.worker.pid}`);

      this.worker.on('died', () => {
        console.error('Mediasoup worker died, exiting...');
        process.exit(1);
      });
    } catch (error) {
      console.error('Failed to create mediasoup worker:', error);
      throw error;
    }
  }

  async getRouter(roomId: string): Promise<types.Router> {
    if (this.routers.has(roomId)) {
      return this.routers.get(roomId)!;
    }

    if (!this.worker) {
      throw new Error('Mediasoup worker not initialized');
    }

    const router = await this.worker.createRouter({
      mediaCodecs,
      appData: { roomId }
    });

    this.routers.set(roomId, router);
    console.log(`Router created for room: ${roomId}`);
    
    return router;
  }

  async closeRouter(roomId: string): Promise<void> {
    const router = this.routers.get(roomId);
    if (router) {
      router.close();
      this.routers.delete(roomId);
      console.log(`Router closed for room: ${roomId}`);
    }
  }

  getWorker(): types.Worker | null {
    return this.worker;
  }
}

export default MediasoupWorker;
export { mediaCodecs };