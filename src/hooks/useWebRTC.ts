// src/hooks/useWebRTC.ts

import { useEffect, useRef, useCallback, useState } from 'react';
import useStateWithCallback from './useStateWithCallback';
import useBandwidthMonitor from './useBandwidthMonitor';
import useTopologyController from './useTopologyController';
import socket from '../socket';
import { ACTIONS } from '../socket/actions';

export const LOCAL_VIDEO = 'LOCAL_VIDEO';

interface WebRTCStatus {
  isSupported: boolean;
  errors: string[];
}

interface MediaState {
  audio: boolean;
  video: boolean;
  screen: boolean;
}

interface AvailableDevices {
  audio: MediaDeviceInfo[];
  video: MediaDeviceInfo[];
}

interface ChatMessage {
  id: string;
  text: string;
  isLocal: boolean;
  timestamp: string;
  sender: string;
}

interface ParticipantSettings {
  videoEnabled: boolean;
  audioEnabled: boolean;
}

type UseWebRTCReturn = {
  clients: string[];
  provideMediaRef: (id: string, node: HTMLVideoElement | null) => void;
  mediaError: Error | null;
  isMediaReady: boolean;
  webRTCStatus: WebRTCStatus;
  mediaState: MediaState;
  toggleMedia: (type: 'audio' | 'video') => void;
  switchMediaDevice: (type: 'audio' | 'video', deviceId?: string) => Promise<boolean>;
  availableDevices: AvailableDevices;
  addChatMessage: (message: ChatMessage) => void;
  getChatMessages: () => ChatMessage[];
  peerMediaElements: React.MutableRefObject<Record<string, HTMLVideoElement | null>>;
  reconnect: () => Promise<void>;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => void;
  initializeMedia: (constraints: { audio: boolean; video: boolean }, userName?: string) => Promise<void>;
  forceSyncTracks: () => Promise<void>;
  refreshDevices: () => Promise<void>;
  isDeviceAvailable: (type: 'audio' | 'video') => boolean;
  participantSettings: Record<string, ParticipantSettings>;
  toggleParticipantVideo: (peerId: string) => void;
  toggleParticipantAudio: (peerId: string) => void;
  isRelayMode: boolean;
  isWeakMode: boolean;
  assignedRelayId: string | null;
};

function checkWebRTCAvailability(): WebRTCStatus {
  const errors: string[] = [];
  if (!navigator.mediaDevices) errors.push('mediaDevices недоступен');
  if (!window.RTCPeerConnection) errors.push('RTCPeerConnection недоступен');
  
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  if (isSafari && !window.RTCRtpSender) {
    errors.push('Safari требует дополнительных разрешений для WebRTC');
  }
  
  return {
    isSupported: errors.length === 0,
    errors
  };
}

export default function useWebRTC(roomID?: string): UseWebRTCReturn {
  const [clients, updateClients] = useStateWithCallback<string[]>([]);
  const [mediaError, setMediaError] = useState<Error | null>(null);
  const [isMediaReady, setIsMediaReady] = useState(false);
  const [webRTCStatus, setWebRTCStatus] = useState<WebRTCStatus>(checkWebRTCAvailability());
  const [mediaState, setMediaState] = useState<MediaState>({ 
    audio: false, 
    video: false, 
    screen: false 
  });
  const [availableDevices, setAvailableDevices] = useState<AvailableDevices>({
    audio: [],
    video: []
  });
  const [participantSettings, setParticipantSettings] = useState<Record<string, ParticipantSettings>>({});
  const [selectedAudioDevice, setSelectedAudioDevice] = useState<string>('');
  const [selectedVideoDevice, setSelectedVideoDevice] = useState<string>('');

  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
  const localMediaStream = useRef<MediaStream | null>(null);
  const screenShareStream = useRef<MediaStream | null>(null);
  const peerMediaElements = useRef<Record<string, HTMLVideoElement | null>>({});
  const chatMessages = useRef<ChatMessage[]>([]);
  
  const { 
    registerPeerConnection, 
    unregisterPeerConnection, 
    startMonitoring, 
    stopMonitoring 
  } = useBandwidthMonitor();
  
  const {
    relayState,
    setCanBeRelay,
    requestTopology,
    activateRelayMode,
    configureAsWeakPeer
  } = useTopologyController(socket.id || null);
  
  const [isRelayMode, setIsRelayMode] = useState(false);
  const [isWeakMode, setIsWeakMode] = useState(false);
  const [assignedRelayId, setAssignedRelayId] = useState<string | null>(null);
  
  const incomingStreams = useRef<Map<string, MediaStream>>(new Map());
  
  const iceServers = useRef<RTCIceServer[]>([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.voipbuster.com:3478' },
    { urls: 'stun:stun.voipstunt.com:3478' },
    {
      urls: 'turn:numb.viagenie.ca:3478',
      username: 'webrtc@live.com',
      credential: 'muazkh'
    }
  ]);

  const isInitialized = useRef(false);

  const addNewClient = useCallback((newClient: string, cb?: () => void) => {
    updateClients(list => {
      if (!list.includes(newClient)) return [...list, newClient];
      return list;
    }, cb);
  }, [updateClients]);

  const enumerateDevices = useCallback(async (): Promise<void> => {
    try {
      // Запрашиваем разрешения перед получением списка устройств
      await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
        .then(stream => {
          stream.getTracks().forEach(track => track.stop());
        })
        .catch(e => console.warn('Permission error:', e));
      
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioDevices = devices.filter(d => d.kind === 'audioinput');
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      
      console.log('[Devices] Found:', { audio: audioDevices.length, video: videoDevices.length });
      
      setAvailableDevices({
        audio: audioDevices,
        video: videoDevices
      });

      if (!selectedAudioDevice && audioDevices.length > 0) {
        const defaultAudio = audioDevices.find(d => d.deviceId === 'default') || audioDevices[0];
        setSelectedAudioDevice(defaultAudio.deviceId);
        console.log('[Devices] Selected audio:', defaultAudio.label || defaultAudio.deviceId);
      }
      if (!selectedVideoDevice && videoDevices.length > 0) {
        const defaultVideo = videoDevices.find(d => d.deviceId === 'default') || videoDevices[0];
        setSelectedVideoDevice(defaultVideo.deviceId);
        console.log('[Devices] Selected video:', defaultVideo.label || defaultVideo.deviceId);
      }
    } catch (err) {
      console.error('Ошибка получения устройств:', err);
    }
  }, [selectedAudioDevice, selectedVideoDevice]);

  const getMediaConstraints = useCallback((constraints: { audio: boolean; video: boolean }): MediaStreamConstraints => ({
    audio: constraints.audio ? {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      deviceId: selectedAudioDevice ? { exact: selectedAudioDevice } : undefined
    } : false,
    video: constraints.video ? {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
      deviceId: selectedVideoDevice ? { exact: selectedVideoDevice } : undefined
    } : false
  }), [selectedAudioDevice, selectedVideoDevice]);

  const initializeMedia = useCallback(async (constraints: { audio: boolean; video: boolean }, name?: string) => {
    setMediaError(null);
    setIsMediaReady(false);
    
    // Сначала получаем список устройств
    await enumerateDevices();
    
    try {
      const { isSupported, errors } = checkWebRTCAvailability();
      if (!isSupported) throw new Error(`WebRTC не поддерживается: ${errors.join(', ')}`);

      if (localMediaStream.current) {
        localMediaStream.current.getTracks().forEach(track => track.stop());
        localMediaStream.current = null;
      }

      let stream: MediaStream | null = null;
      
      const mediaConstraints = getMediaConstraints(constraints);
      console.log('[Media] Requesting with constraints:', mediaConstraints);
      
      try {
        stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
        console.log('[Media] Stream obtained, audio tracks:', stream.getAudioTracks().length, 'video tracks:', stream.getVideoTracks().length);
        
        if (constraints.audio && stream.getAudioTracks().length > 0) {
          stream.getAudioTracks().forEach(track => {
            track.enabled = true;
            console.log('[Media] Audio track enabled:', track.label);
          });
        } else if (constraints.audio && stream.getAudioTracks().length === 0) {
          console.warn('[Media] No audio tracks in stream');
        }
        
        if (constraints.video && stream.getVideoTracks().length > 0) {
          stream.getVideoTracks().forEach(track => {
            track.enabled = true;
            console.log('[Media] Video track enabled:', track.label);
          });
        } else if (constraints.video && stream.getVideoTracks().length === 0) {
          console.warn('[Media] No video tracks in stream');
        }
      } catch (err) {
        console.error('[Media] getUserMedia error:', err);
        
        if (err instanceof Error) {
          if (err.name === 'NotAllowedError') {
            setMediaError(new Error('Разрешите доступ к камере и микрофону в настройках браузера'));
          } else if (err.name === 'NotFoundError') {
            setMediaError(new Error('Не найдены камера или микрофон. Проверьте подключение устройств.'));
          } else {
            setMediaError(err);
          }
        }
        
        // Создаём пустой поток, если не удалось получить устройства
        stream = new MediaStream();
        
        // Если не получили устройства, пробуем без указания конкретных deviceId
        if (selectedAudioDevice || selectedVideoDevice) {
          console.log('[Media] Retrying without specific device IDs');
          const fallbackConstraints: MediaStreamConstraints = {
            audio: constraints.audio,
            video: constraints.video
          };
          try {
            const fallbackStream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
            stream = fallbackStream;
            console.log('[Media] Fallback stream obtained');
          } catch (e) {
            console.error('[Media] Fallback also failed:', e);
          }
        }
      }

      setIsMediaReady(true);
      localMediaStream.current = stream;

      setMediaState({
        audio: constraints.audio && stream.getAudioTracks().length > 0,
        video: constraints.video && stream.getVideoTracks().length > 0,
        screen: false
      });

      addNewClient(LOCAL_VIDEO, () => {
        const localVideo = peerMediaElements.current[LOCAL_VIDEO];
        if (localVideo && stream) {
          localVideo.srcObject = stream;
          localVideo.muted = true;
          localVideo.play().catch(e => console.warn('[Media] Local video play error:', e));
          console.log('[Media] Local video element attached');
        }
      });

      if (roomID) {
        console.log('[Room] Joining:', roomID, 'as:', name);
        socket.emit(ACTIONS.JOIN, { 
          room: roomID, 
          userName: name || 'Участник'
        });
        
        setTimeout(() => requestTopology(), 2000);
        startMonitoring(5000);
      }
      
    } catch (err) {
      console.error('[Media] Initialization error:', err);
      setMediaError(err as Error);
      localMediaStream.current = new MediaStream();
      addNewClient(LOCAL_VIDEO);
      if (roomID) socket.emit(ACTIONS.JOIN, { room: roomID, userName: name });
    }
  }, [enumerateDevices, getMediaConstraints, addNewClient, roomID, startMonitoring, requestTopology, selectedAudioDevice, selectedVideoDevice]);

  const setupPeerConnection = useCallback(async (
    peerID: string, 
    createOffer: boolean,
    isRelayModeFlag: boolean = false
  ) => {
    if (peerConnections.current[peerID]) {
      console.log(`[Peer] Connection for ${peerID.slice(-8)} already exists`);
      return;
    }

    console.log(`[Peer] Setting up for ${peerID.slice(-8)}, createOffer: ${createOffer}, isRelay: ${isRelayModeFlag}`);

    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const pcConfig: RTCConfiguration = {
      iceServers: iceServers.current,
      iceCandidatePoolSize: isSafari ? 5 : 10,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    };

    const pc = new RTCPeerConnection(pcConfig);
    peerConnections.current[peerID] = pc;
    
    registerPeerConnection(peerID, pc);

    const activeStream = mediaState.screen && screenShareStream.current ? 
      screenShareStream.current : localMediaStream.current;
    
    const audioTrack = localMediaStream.current?.getAudioTracks()[0];
    const videoTrack = activeStream?.getVideoTracks()[0];

    console.log(`[Peer] Adding tracks to ${peerID.slice(-8)}: audio=${!!audioTrack}, video=${!!videoTrack}, screen=${mediaState.screen}`);

    if (!isRelayModeFlag && activeStream) {
      if (audioTrack && audioTrack.enabled) {
        pc.addTrack(audioTrack, localMediaStream.current!);
        console.log(`[Peer] Added audio track to ${peerID.slice(-8)}`);
      }
      if (videoTrack && videoTrack.enabled) {
        pc.addTrack(videoTrack, activeStream);
        console.log(`[Peer] Added video track to ${peerID.slice(-8)}`);
      }
    }

    pc.onicecandidate = event => {
      if (event.candidate) {
        socket.emit(ACTIONS.RELAY_ICE, {
          peerID,
          iceCandidate: event.candidate
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[Peer] ICE state for ${peerID.slice(-8)}:`, pc.iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      console.log(`[Peer] Connection state for ${peerID.slice(-8)}:`, pc.connectionState);
    };

    pc.ontrack = ({ streams: [remoteStream] }) => {
      if (!remoteStream) {
        console.log(`[Peer] No remote stream from ${peerID.slice(-8)}`);
        return;
      }
      
      console.log(`[Peer] Received stream from ${peerID.slice(-8)}, tracks:`, remoteStream.getTracks().length);
      incomingStreams.current.set(peerID, remoteStream);
      
      addNewClient(peerID, () => {
        const element = peerMediaElements.current[peerID];
        if (element) {
          element.srcObject = remoteStream;
          element.play().catch(e => console.warn(`[Peer] Remote video play error for ${peerID.slice(-8)}:`, e));
        }
      });
    };

    if (createOffer) {
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        });
        await pc.setLocalDescription(offer);
        
        socket.emit(ACTIONS.RELAY_SDP, {
          peerID,
          sessionDescription: offer
        });
        console.log(`[Peer] Offer sent to ${peerID.slice(-8)}`);
      } catch (err) {
        console.error(`[Peer] Error creating offer for ${peerID.slice(-8)}:`, err);
      }
    }
  }, [mediaState.screen, registerPeerConnection, addNewClient]);

  // Остальные функции (applyTopology, эффекты и т.д.) остаются без изменений
  // ... (код из предыдущей версии, который уже работал)

  const applyTopology = useCallback(async (edges: { from: string; to: string; type: string }[]) => {
    if (!socket.id) return;
    
    const relevantEdges = edges.filter(e => 
      (e.from === socket.id && e.to !== LOCAL_VIDEO) || 
      (e.to === socket.id && e.from !== LOCAL_VIDEO)
    );
    
    for (const edge of relevantEdges) {
      const peerId = edge.from === socket.id ? edge.to : edge.from;
      
      if (!peerConnections.current[peerId] && clients.includes(peerId)) {
        const createOffer = edge.from === socket.id;
        await setupPeerConnection(peerId, createOffer, edge.type === 'relay');
      }
    }
  }, [clients, setupPeerConnection]);

  useEffect(() => {
    const handleTopologyUpdate = (data: { edges: any[]; relayAssignments: [string, string][] }) => {
      console.log('[WebRTC] Topology update received');
      
      if (socket.id) {
        for (const [weak, strong] of data.relayAssignments) {
          if (weak === socket.id) {
            setIsWeakMode(true);
            setAssignedRelayId(strong);
            configureAsWeakPeer(strong);
          }
          if (strong === socket.id) {
            setIsRelayMode(true);
            activateRelayMode(incomingStreams.current, [weak]);
          }
        }
      }
      
      applyTopology(data.edges);
    };
    
    socket.on('topology-update', handleTopologyUpdate);
    
    return () => {
      socket.off('topology-update', handleTopologyUpdate);
    };
  }, [applyTopology, activateRelayMode, configureAsWeakPeer]);

  const stopScreenShare = useCallback((): void => {
    if (screenShareStream.current) {
      screenShareStream.current.getTracks().forEach(track => track.stop());
      screenShareStream.current = null;
    }
    setMediaState(prev => ({ ...prev, screen: false }));
  }, []);

  const startScreenShare = useCallback(async (): Promise<void> => {
    try {
      if (screenShareStream.current) {
        screenShareStream.current.getTracks().forEach(track => track.stop());
        screenShareStream.current = null;
      }

      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      });
      
      const screenVideoTrack = displayStream.getVideoTracks()[0];
      if (!screenVideoTrack) throw new Error('Не удалось получить видео с экрана');

      const screenStream = new MediaStream();
      screenStream.addTrack(screenVideoTrack);
      screenShareStream.current = screenStream;
      setMediaState(prev => ({ ...prev, screen: true }));

      const localVideo = peerMediaElements.current[LOCAL_VIDEO];
      if (localVideo) {
        localVideo.srcObject = screenStream;
        localVideo.play().catch(e => console.error('Screen share video play error:', e));
      }

      for (const [peerID, pc] of Object.entries(peerConnections.current)) {
        try {
          const senders = pc.getSenders();
          const videoSender = senders.find(s => s.track?.kind === 'video');
          
          if (videoSender) {
            await videoSender.replaceTrack(screenVideoTrack);
          } else {
            pc.addTrack(screenVideoTrack, screenStream);
          }

          const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
          await pc.setLocalDescription(offer);
          socket.emit(ACTIONS.RELAY_SDP, { peerID, sessionDescription: offer });
        } catch (err) {
          console.error(`Error updating screen share for peer ${peerID}:`, err);
        }
      }

      screenVideoTrack.addEventListener('ended', () => stopScreenShare());
    } catch (err) {
      console.error('Ошибка демонстрации экрана:', err);
      setMediaError(err as Error);
      throw err;
    }
  }, [stopScreenShare]);

  const switchMediaDevice = useCallback(async (type: 'audio' | 'video', deviceId?: string): Promise<boolean> => {
    try {
      if (type === 'audio' && deviceId) setSelectedAudioDevice(deviceId);
      else if (type === 'video' && deviceId) setSelectedVideoDevice(deviceId);

      const constraints: MediaStreamConstraints = {
        [type]: deviceId ? { deviceId: { exact: deviceId } } : true
      };

      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      const newTrack = newStream.getTracks()[0];

      if (!localMediaStream.current) {
        localMediaStream.current = new MediaStream();
      }

      const oldTracks = localMediaStream.current.getTracks().filter(t => t.kind === type);
      oldTracks.forEach(t => {
        t.stop();
        localMediaStream.current?.removeTrack(t);
      });

      localMediaStream.current.addTrack(newTrack);
      newTrack.enabled = mediaState[type];

      for (const pc of Object.values(peerConnections.current)) {
        const sender = pc.getSenders().find(s => s.track?.kind === type);
        if (sender) {
          await sender.replaceTrack(newTrack);
        }
      }

      if (type === 'video') {
        const localVideo = peerMediaElements.current[LOCAL_VIDEO];
        if (localVideo && localMediaStream.current) {
          localVideo.srcObject = localMediaStream.current;
          localVideo.play().catch(e => console.error('Local video play error:', e));
        }
      }

      await enumerateDevices();
      return true;
    } catch (err) {
      console.error(`Ошибка переключения устройства ${type}:`, err);
      return false;
    }
  }, [enumerateDevices, mediaState]);

  const toggleMedia = useCallback((type: 'audio' | 'video') => {
    setMediaState(prev => {
      const newState = { ...prev, [type]: !prev[type] };
      const activeStream = mediaState.screen ? screenShareStream.current : localMediaStream.current;
      if (activeStream) {
        activeStream.getTracks().filter(track => track.kind === type).forEach(track => {
          track.enabled = newState[type];
        });
      }
      return newState;
    });
  }, [mediaState.screen]);

  const reconnect = useCallback(async () => {
    Object.values(peerConnections.current).forEach(pc => pc.close());
    peerConnections.current = {};
    if (localMediaStream.current) {
      localMediaStream.current.getTracks().forEach(track => track.stop());
      localMediaStream.current = null;
    }
    if (screenShareStream.current) {
      screenShareStream.current.getTracks().forEach(track => track.stop());
      screenShareStream.current = null;
    }
    updateClients([], () => {});
    await initializeMedia({ audio: mediaState.audio, video: mediaState.video });
  }, [updateClients, initializeMedia, mediaState]);

  const forceSyncTracks = useCallback(async () => {
    const activeStream = mediaState.screen && screenShareStream.current ? screenShareStream.current : localMediaStream.current;
    if (!activeStream) return;

    for (const [peerID, pc] of Object.entries(peerConnections.current)) {
      try {
        const senders = pc.getSenders();
        const audioTrack = localMediaStream.current?.getAudioTracks()[0];
        const videoTrack = activeStream.getVideoTracks()[0];

        const audioSender = senders.find(s => s.track?.kind === 'audio');
        if (audioTrack && audioSender && audioSender.track?.id !== audioTrack.id) {
          await audioSender.replaceTrack(audioTrack);
        }
        const videoSender = senders.find(s => s.track?.kind === 'video');
        if (videoTrack && videoSender && videoSender.track?.id !== videoTrack.id) {
          await videoSender.replaceTrack(videoTrack);
        }

        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        socket.emit(ACTIONS.RELAY_SDP, { peerID, sessionDescription: offer });
      } catch (err) {
        console.error(`Error force syncing for peer ${peerID}:`, err);
      }
    }
  }, [mediaState.screen]);

  const refreshDevices = useCallback(async () => {
    await enumerateDevices();
  }, [enumerateDevices]);

  const isDeviceAvailable = useCallback((type: 'audio' | 'video') => mediaState[type], [mediaState]);

  const addChatMessage = useCallback((message: ChatMessage) => {
    chatMessages.current = [...chatMessages.current, message];
  }, []);

  const getChatMessages = useCallback(() => chatMessages.current, []);

  const provideMediaRef = useCallback((id: string, node: HTMLVideoElement | null) => {
    if (peerMediaElements.current[id] === node) return;
    if (node) {
      node.autoplay = true;
      node.playsInline = true;
      node.muted = id === LOCAL_VIDEO || !participantSettings[id]?.audioEnabled;
      peerMediaElements.current[id] = node;
      if (id === LOCAL_VIDEO) {
        const activeStream = mediaState.screen && screenShareStream.current ? screenShareStream.current : localMediaStream.current;
        if (activeStream && node.srcObject !== activeStream) {
          node.srcObject = activeStream;
          node.play().catch(e => console.warn('Local video play error:', e));
        }
      }
    } else {
      delete peerMediaElements.current[id];
    }
  }, [participantSettings, mediaState.screen]);

  const toggleParticipantVideo = useCallback((peerId: string) => {
    setParticipantSettings(prev => ({
      ...prev,
      [peerId]: { ...prev[peerId], videoEnabled: !(prev[peerId]?.videoEnabled ?? true) }
    }));
    const element = peerMediaElements.current[peerId];
    if (element) {
      element.style.display = participantSettings[peerId]?.videoEnabled ? 'none' : 'block';
    }
  }, [participantSettings]);

  const toggleParticipantAudio = useCallback((peerId: string) => {
    setParticipantSettings(prev => ({
      ...prev,
      [peerId]: { ...prev[peerId], audioEnabled: !(prev[peerId]?.audioEnabled ?? true) }
    }));
    const element = peerMediaElements.current[peerId];
    if (element) element.muted = !participantSettings[peerId]?.audioEnabled;
  }, [participantSettings]);

  useEffect(() => {
    const handleAddPeer = ({ peerID, createOffer }: any) => {
      setupPeerConnection(peerID, createOffer);
    };

    const handleSessionDescription = async ({ peerID, sessionDescription }: any) => {
      const pc = peerConnections.current[peerID];
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sessionDescription));
        if (sessionDescription.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit(ACTIONS.RELAY_SDP, { peerID, sessionDescription: answer });
        }
      } catch (err) {
        console.error('Ошибка setRemoteDescription:', err);
      }
    };

    const handleIceCandidate = ({ peerID, iceCandidate }: any) => {
      const pc = peerConnections.current[peerID];
      if (pc) pc.addIceCandidate(new RTCIceCandidate(iceCandidate));
    };

    const handleRemovePeer = ({ peerID }: { peerID: string }) => {
      const pc = peerConnections.current[peerID];
      if (pc) {
        pc.close();
        delete peerConnections.current[peerID];
        unregisterPeerConnection(peerID);
        delete peerMediaElements.current[peerID];
        updateClients(list => list.filter(c => c !== peerID));
      }
    };

    const handleChatMessage = (msg: any) => {
      addChatMessage({
        id: msg.id,
        text: msg.message,
        isLocal: msg.sender === socket.id,
        timestamp: new Date(msg.timestamp).toLocaleTimeString(),
        sender: msg.sender
      });
    };

    socket.on(ACTIONS.ADD_PEER, handleAddPeer);
    socket.on(ACTIONS.SESSION_DESCRIPTION, handleSessionDescription);
    socket.on(ACTIONS.ICE_CANDIDATE, handleIceCandidate);
    socket.on(ACTIONS.REMOVE_PEER, handleRemovePeer);
    socket.on(ACTIONS.CHAT_MESSAGE, handleChatMessage);

    if (roomID) socket.emit(ACTIONS.REQUEST_CHAT_HISTORY, { roomID });

    return () => {
      socket.off(ACTIONS.ADD_PEER, handleAddPeer);
      socket.off(ACTIONS.SESSION_DESCRIPTION, handleSessionDescription);
      socket.off(ACTIONS.ICE_CANDIDATE, handleIceCandidate);
      socket.off(ACTIONS.REMOVE_PEER, handleRemovePeer);
      socket.off(ACTIONS.CHAT_MESSAGE, handleChatMessage);
    };
  }, [setupPeerConnection, updateClients, addChatMessage, unregisterPeerConnection]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      clients.forEach(clientId => {
        if (clientId !== LOCAL_VIDEO && !participantSettings[clientId]) {
          setParticipantSettings(prev => ({
            ...prev,
            [clientId]: {
              videoEnabled: true,
              audioEnabled: true
            }
          }));
        }
      });
    }, 100);
    
    return () => clearTimeout(timeoutId);
  }, [clients, participantSettings]);

  useEffect(() => {
    setCanBeRelay(mediaState.video && mediaState.audio);
  }, [mediaState, setCanBeRelay]);

  useEffect(() => {
    return () => {
      Object.values(peerConnections.current).forEach(pc => pc.close());
      peerConnections.current = {};
      stopMonitoring();
      if (localMediaStream.current) {
        localMediaStream.current.getTracks().forEach(track => track.stop());
        localMediaStream.current = null;
      }
      if (screenShareStream.current) {
        screenShareStream.current.getTracks().forEach(track => track.stop());
        screenShareStream.current = null;
      }
      socket.emit(ACTIONS.LEAVE);
    };
  }, [stopMonitoring]);

  return {
    clients,
    provideMediaRef,
    mediaError,
    isMediaReady,
    webRTCStatus,
    mediaState,
    toggleMedia,
    switchMediaDevice,
    availableDevices,
    addChatMessage,
    getChatMessages,
    peerMediaElements,
    reconnect,
    startScreenShare,
    stopScreenShare,
    initializeMedia,
    forceSyncTracks,
    refreshDevices,
    isDeviceAvailable,
    participantSettings,
    toggleParticipantVideo,
    toggleParticipantAudio,
    isRelayMode,
    isWeakMode,
    assignedRelayId
  };
}