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
    setCanBeRelay,
    requestTopology,
    syncFromTopologyUpdate,
    activateRelayMode,
    deactivateRelayMode,
    configureAsWeakPeer
  } = useTopologyController(socket.id || null);
  
  const [isRelayMode, setIsRelayMode] = useState(false);
  const [isWeakMode, setIsWeakMode] = useState(false);
  const [assignedRelayId, setAssignedRelayId] = useState<string | null>(null);
  
  const incomingStreams = useRef<Map<string, MediaStream>>(new Map());
  const knownPeers = useRef<Set<string>>(new Set());
  const pendingIceCandidates = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  
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

  const closePeerConnection = useCallback((peerID: string) => {
    const pc = peerConnections.current[peerID];
    if (pc) {
      pc.close();
      delete peerConnections.current[peerID];
      unregisterPeerConnection(peerID);
      pendingIceCandidates.current.delete(peerID);
      incomingStreams.current.delete(peerID);
    }
  }, [unregisterPeerConnection]);

  const flushIceCandidates = useCallback(async (peerID: string, pc: RTCPeerConnection) => {
    const pending = pendingIceCandidates.current.get(peerID) || [];
    pendingIceCandidates.current.delete(peerID);

    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn(`[Peer] Deferred ICE candidate failed for ${peerID.slice(-8)}:`, err);
      }
    }
  }, []);

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

  const enumerateDevices = useCallback(async (): Promise<void> => {
    try {
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
      console.error('Error getting devices:', err);
    }
  }, [selectedAudioDevice, selectedVideoDevice]);

  const initializeMedia = useCallback(async (constraints: { audio: boolean; video: boolean }, name?: string) => {
    setMediaError(null);
    setIsMediaReady(false);
    
    await enumerateDevices();
    
    try {
      const { isSupported, errors } = checkWebRTCAvailability();
      if (!isSupported) throw new Error(`WebRTC not supported: ${errors.join(', ')}`);

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
            setMediaError(new Error('Please allow camera and microphone access in browser settings'));
          } else if (err.name === 'NotFoundError') {
            setMediaError(new Error('Camera or microphone not found. Check device connections.'));
          } else {
            setMediaError(err);
          }
        }
        
        stream = new MediaStream();
        
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
        audio: constraints.audio && (stream?.getAudioTracks().length || 0) > 0,
        video: constraints.video && (stream?.getVideoTracks().length || 0) > 0,
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
        
        let tabId = sessionStorage.getItem('vc_tab_id');
        if (!tabId) {
          tabId = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
          sessionStorage.setItem('vc_tab_id', tabId);
        }
        
        socket.emit(ACTIONS.JOIN, { 
          room: roomID, 
          userName: name || 'Participant',
          tabId: tabId
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
    createOffer: boolean
  ) => {
    if (peerConnections.current[peerID]) {
      console.log(`[Peer] Connection for ${peerID.slice(-8)} already exists`);
      return;
    }

    console.log(`[Peer] Setting up for ${peerID.slice(-8)}, createOffer: ${createOffer}`);

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

    if (activeStream) {
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

  const applyTopology = useCallback(async (edges: { from: string; to: string; type: string }[]) => {
    if (!socket.id) return;

    const allowedPeers = new Set<string>();
    const connectionsToOpen: { peerId: string; createOffer: boolean }[] = [];

    for (const edge of edges) {
      if (edge.from === socket.id && edge.to !== LOCAL_VIDEO) {
        allowedPeers.add(edge.to);
        connectionsToOpen.push({ peerId: edge.to, createOffer: true });
      } else if (edge.to === socket.id && edge.from !== LOCAL_VIDEO) {
        allowedPeers.add(edge.from);
        connectionsToOpen.push({ peerId: edge.from, createOffer: false });
      }
    }

    if (allowedPeers.size === 0 && knownPeers.current.size > 0) {
      for (const peerId of knownPeers.current) {
        allowedPeers.add(peerId);
        connectionsToOpen.push({
          peerId,
          createOffer: socket.id < peerId
        });
      }
    }

    for (const peerId of Object.keys(peerConnections.current)) {
      if (!allowedPeers.has(peerId)) {
        closePeerConnection(peerId);
        updateClients(list => list.filter(id => id !== peerId));
        delete peerMediaElements.current[peerId];
      }
    }

    for (const { peerId, createOffer } of connectionsToOpen) {
      if (!peerConnections.current[peerId]) {
        await setupPeerConnection(peerId, createOffer);
      }
    }
  }, [setupPeerConnection, closePeerConnection, updateClients]);

  useEffect(() => {
    const handleTopologyUpdate = (data: { edges: any[]; relayAssignments: [string, string][] }) => {
      console.log('[WebRTC] Topology update received');

      syncFromTopologyUpdate(data);

      setIsWeakMode(false);
      setIsRelayMode(false);
      setAssignedRelayId(null);

      if (socket.id) {
        const weakPeersForRelay: string[] = [];

        for (const [weak, strong] of data.relayAssignments) {
          if (weak === socket.id) {
            setIsWeakMode(true);
            setAssignedRelayId(strong);
            configureAsWeakPeer(strong);
          }
          if (strong === socket.id) {
            setIsRelayMode(true);
            weakPeersForRelay.push(weak);
          }
        }

        if (weakPeersForRelay.length > 0) {
          activateRelayMode(incomingStreams.current, weakPeersForRelay);
        } else {
          deactivateRelayMode();
        }
      }

      applyTopology(data.edges);
    };
    
    socket.on('topology-update', handleTopologyUpdate);
    
    return () => {
      socket.off('topology-update', handleTopologyUpdate);
      deactivateRelayMode();
    };
  }, [applyTopology, activateRelayMode, configureAsWeakPeer, syncFromTopologyUpdate, deactivateRelayMode]);

  const stopScreenShare = useCallback((): void => {
    console.log('[ScreenShare] Stopping...');
    
    if (screenShareStream.current) {
      screenShareStream.current.getTracks().forEach(track => {
        if (track.kind === 'video') {
          track.stop();
        }
      });
      screenShareStream.current = null;
    }

    const originalStream = localMediaStream.current;
    const localVideo = peerMediaElements.current[LOCAL_VIDEO];
    
    if (localVideo && originalStream) {
      localVideo.srcObject = originalStream;
      localVideo.muted = true;
      localVideo.play().catch(e => console.warn('[ScreenShare] Restore local video:', e));
    } else if (localVideo) {
      localVideo.srcObject = null;
    }

    Object.entries(peerConnections.current).forEach(async ([peerID, pc]) => {
      try {
        const senders = pc.getSenders();
        
        const originalVideoTrack = originalStream?.getVideoTracks()[0];
        const videoSender = senders.find(s => s.track?.kind === 'video');
        
        if (originalVideoTrack && videoSender) {
          await videoSender.replaceTrack(originalVideoTrack);
          console.log(`[ScreenShare] Restored original video for ${peerID.slice(-8)}`);
        } else if (videoSender && !originalVideoTrack) {
          if (videoSender.track) {
            videoSender.track.enabled = false;
          }
        }

        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        });
        
        await pc.setLocalDescription(offer);
        
        socket.emit(ACTIONS.RELAY_SDP, {
          peerID,
          sessionDescription: offer,
        });
        
      } catch (err) {
        console.error(`[ScreenShare] Error restoring peer ${peerID.slice(-8)}:`, err);
      }
    });

    setMediaState(prev => ({ ...prev, screen: false }));
    console.log('[ScreenShare] Stopped');
  }, []);

  const startScreenShare = useCallback(async (): Promise<void> => {
    try {
      console.log('[ScreenShare] Starting...');
      
      if (screenShareStream.current) {
        screenShareStream.current.getTracks().forEach(track => track.stop());
        screenShareStream.current = null;
      }

      const videoConstraints: any = {
        frameRate: { ideal: 30, max: 60 },
        cursor: "always"
      };

      const displayMediaOptions: DisplayMediaStreamOptions = {
        video: videoConstraints,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      };

      let displayStream: MediaStream;
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
        console.log('[ScreenShare] Display stream obtained, audio tracks:', displayStream.getAudioTracks().length);
      } catch (err) {
        console.warn('[ScreenShare] Could not get display with audio, retrying without audio:', err);
        const fallbackVideoConstraints: any = {
          frameRate: { ideal: 30, max: 60 },
          cursor: "always"
        };
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: fallbackVideoConstraints,
          audio: false
        });
      }
      
      const screenVideoTrack = displayStream.getVideoTracks()[0];
      if (!screenVideoTrack) {
        throw new Error('Failed to get screen video');
      }

      const newScreenStream = new MediaStream();
      newScreenStream.addTrack(screenVideoTrack);
      
      const originalAudioTrack = localMediaStream.current?.getAudioTracks()[0];
      
      if (originalAudioTrack && originalAudioTrack.enabled) {
        newScreenStream.addTrack(originalAudioTrack);
        console.log('[ScreenShare] Added microphone audio track to screen stream');
      } else {
        console.warn('[ScreenShare] No audio track available from local stream');
        
        try {
          const audioOnlyStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const micAudioTrack = audioOnlyStream.getAudioTracks()[0];
          if (micAudioTrack) {
            newScreenStream.addTrack(micAudioTrack);
            console.log('[ScreenShare] Obtained fresh microphone audio track');
            if (!localMediaStream.current) {
              localMediaStream.current = new MediaStream();
            }
            localMediaStream.current.addTrack(micAudioTrack);
            setMediaState(prev => ({ ...prev, audio: true }));
          }
        } catch (audioErr) {
          console.error('[ScreenShare] Could not get microphone access:', audioErr);
        }
      }
      
      screenShareStream.current = newScreenStream;
      setMediaState(prev => ({ ...prev, screen: true }));

      const localVideo = peerMediaElements.current[LOCAL_VIDEO];
      if (localVideo) {
        localVideo.srcObject = newScreenStream;
        localVideo.muted = true;
        localVideo.play().catch(e => console.warn('[ScreenShare] Local video play:', e));
      }

      const updatePromises = Object.entries(peerConnections.current).map(async ([peerID, pc]) => {
        try {
          console.log(`[ScreenShare] Updating peer ${peerID.slice(-8)}`);
          
          const senders = pc.getSenders();
          
          const audioSender = senders.find(s => s.track?.kind === 'audio');
          const currentAudioTrack = newScreenStream.getAudioTracks()[0];
          
          if (currentAudioTrack && audioSender) {
            if (audioSender.track?.id !== currentAudioTrack.id) {
              await audioSender.replaceTrack(currentAudioTrack);
              console.log(`[ScreenShare] Replaced audio track for ${peerID.slice(-8)}`);
            }
          } else if (currentAudioTrack && !audioSender) {
            pc.addTrack(currentAudioTrack, newScreenStream);
            console.log(`[ScreenShare] Added audio track for ${peerID.slice(-8)}`);
          }

          const videoSender = senders.find(s => s.track?.kind === 'video');
          const screenVideo = newScreenStream.getVideoTracks()[0];
          
          if (screenVideo) {
            if (videoSender) {
              await videoSender.replaceTrack(screenVideo);
              console.log(`[ScreenShare] Replaced video with screen for ${peerID.slice(-8)}`);
            } else {
              pc.addTrack(screenVideo, newScreenStream);
              console.log(`[ScreenShare] Added screen video for ${peerID.slice(-8)}`);
            }
          }

          const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
          });
          
          await pc.setLocalDescription(offer);
          
          socket.emit(ACTIONS.RELAY_SDP, {
            peerID,
            sessionDescription: offer,
          });

          console.log(`[ScreenShare] Offer sent to ${peerID.slice(-8)}`);

        } catch (err) {
          console.error(`[ScreenShare] Error updating peer ${peerID.slice(-8)}:`, err);
        }
      });

      await Promise.all(updatePromises);
      console.log('[ScreenShare] All peers updated');

      screenVideoTrack.addEventListener('ended', () => {
        console.log('[ScreenShare] Ended by user');
        stopScreenShare();
      });
      
      screenVideoTrack.addEventListener('mute', () => {
        console.log('[ScreenShare] Video muted');
      });

    } catch (err) {
      console.error('[ScreenShare] Error:', err);
      setMediaError(err as Error);
      alert('Failed to start screen share. Please check permissions.');
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
      console.error(`Error switching device ${type}:`, err);
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
    knownPeers.current.clear();
    pendingIceCandidates.current.clear();
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
    setParticipantSettings(prev => {
      const videoEnabled = !(prev[peerId]?.videoEnabled ?? true);
      const element = peerMediaElements.current[peerId];
      if (element) {
        element.style.display = videoEnabled ? 'block' : 'none';
      }
      return {
        ...prev,
        [peerId]: {
          videoEnabled,
          audioEnabled: prev[peerId]?.audioEnabled ?? true
        }
      };
    });
  }, []);

  const toggleParticipantAudio = useCallback((peerId: string) => {
    setParticipantSettings(prev => {
      const audioEnabled = !(prev[peerId]?.audioEnabled ?? true);
      const element = peerMediaElements.current[peerId];
      if (element) {
        element.muted = !audioEnabled;
      }
      return {
        ...prev,
        [peerId]: {
          videoEnabled: prev[peerId]?.videoEnabled ?? true,
          audioEnabled
        }
      };
    });
  }, []);

  useEffect(() => {
    const handleAddPeer = ({ peerID }: { peerID: string }) => {
      knownPeers.current.add(peerID);
      addNewClient(peerID);
      requestTopology();
    };

    const handleSessionDescription = async ({ peerID, sessionDescription }: any) => {
      const pc = peerConnections.current[peerID];
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sessionDescription));
        await flushIceCandidates(peerID, pc);
        if (sessionDescription.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit(ACTIONS.RELAY_SDP, { peerID, sessionDescription: answer });
        }
      } catch (err) {
        console.error('Error setRemoteDescription:', err);
      }
    };

    const handleIceCandidate = async ({ peerID, iceCandidate }: any) => {
      const pc = peerConnections.current[peerID];
      if (!pc || !pc.remoteDescription) {
        const queue = pendingIceCandidates.current.get(peerID) || [];
        queue.push(iceCandidate);
        pendingIceCandidates.current.set(peerID, queue);
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(iceCandidate));
      } catch (err) {
        console.warn(`[Peer] ICE candidate error for ${peerID.slice(-8)}:`, err);
      }
    };

    const handleRemovePeer = ({ peerID }: { peerID: string }) => {
      knownPeers.current.delete(peerID);
      closePeerConnection(peerID);
      delete peerMediaElements.current[peerID];
      updateClients(list => list.filter(c => c !== peerID));
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
  }, [addNewClient, requestTopology, flushIceCandidates, closePeerConnection, updateClients, addChatMessage]);

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
      knownPeers.current.clear();
      pendingIceCandidates.current.clear();
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