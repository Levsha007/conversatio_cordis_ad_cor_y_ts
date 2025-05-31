import { useEffect, useRef, useCallback, useState } from 'react';
import useStateWithCallback from './useStateWithCallback';
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

interface UseWebRTCReturn {
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
}

function checkWebRTCAvailability(): WebRTCStatus {
    const errors: string[] = [];
    
    if (!navigator) {
        errors.push('WebRTC не поддерживается: navigator недоступен');
        return { isSupported: false, errors };
    }

    if (!navigator.mediaDevices) {
        errors.push('WebRTC не поддерживается: mediaDevices недоступен');
    }

    if (!window.RTCPeerConnection) {
        errors.push('WebRTC не поддерживается: RTCPeerConnection недоступен');
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
    const [mediaState, setMediaState] = useState<MediaState>({ audio: true, video: true });
    const [availableDevices, setAvailableDevices] = useState<AvailableDevices>({ audio: [], video: [] });
    
    const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
    const localMediaStream = useRef<MediaStream | null>(null);
    const peerMediaElements = useRef<Record<string, HTMLVideoElement | null>>({ [LOCAL_VIDEO]: null });
    const chatMessages = useRef<ChatMessage[]>([]);

    const iceServers = useRef<RTCIceServer[]>([
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]);

    const addNewClient = useCallback((newClient: string, cb?: () => void) => {
        updateClients(list => {
            if (!list.includes(newClient)) return [...list, newClient];
            return list;
        }, cb);
    }, [updateClients]);

    const getMediaConstraints = useCallback((): MediaStreamConstraints => ({
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        },
        video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 }
        }
    }), []);

    const enumerateDevices = useCallback(async (): Promise<void> => {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            setAvailableDevices({
                audio: devices.filter(d => d.kind === 'audioinput'),
                video: devices.filter(d => d.kind === 'videoinput')
            });
        } catch (err) {
            console.error('Error enumerating devices:', err);
        }
    }, []);

    const startMediaStream = useCallback(async (): Promise<MediaStream | null> => {
        setMediaError(null);
        setIsMediaReady(false);

        try {
            const { isSupported, errors } = checkWebRTCAvailability();
            if (!isSupported) throw new Error(`WebRTC не поддерживается: ${errors.join(', ')}`);

            if (localMediaStream.current) {
                localMediaStream.current.getTracks().forEach(track => track.stop());
                localMediaStream.current = null;
            }

            const stream = await navigator.mediaDevices.getUserMedia(getMediaConstraints());
            await enumerateDevices();
            setIsMediaReady(true);
            return stream;
        } catch (err) {
            console.error('Media stream error:', err);
            setMediaError(err as Error);
            return null;
        }
    }, [getMediaConstraints, enumerateDevices]);

    const reconnect = useCallback(async () => {
        try {
            Object.values(peerConnections.current).forEach(pc => pc.close());
            peerConnections.current = {};
            
            if (localMediaStream.current) {
                localMediaStream.current.getTracks().forEach(track => track.stop());
                localMediaStream.current = null;
            }

            updateClients([], () => {});

            const stream = await startMediaStream();
            if (!stream) return;

            localMediaStream.current = stream;
            addNewClient(LOCAL_VIDEO, () => {
                const localVideo = peerMediaElements.current[LOCAL_VIDEO];
                if (localVideo) {
                    localVideo.srcObject = stream;
                    localVideo.volume = 0;
                    localVideo.play().catch(e => console.error('Local video play error:', e));
                }
            });

            if (roomID) socket.emit(ACTIONS.JOIN, { room: roomID });
        } catch (err) {
            console.error('Reconnection error:', err);
            setMediaError(err as Error);
        }
    }, [roomID, startMediaStream, addNewClient, updateClients]);

    const toggleMedia = useCallback((type: 'audio' | 'video') => {
        setMediaState(prev => {
            const newState = {...prev, [type]: !prev[type]};
            
            if (localMediaStream.current) {
                localMediaStream.current.getTracks()
                    .filter(track => track.kind === type)
                    .forEach(track => {
                        track.enabled = newState[type];
                    });
            }
            
            return newState;
        });
    }, []);

    const switchMediaDevice = useCallback(async (
        type: 'audio' | 'video',
        deviceId?: string
    ): Promise<boolean> => {
        try {
            const oldTracks = localMediaStream.current?.getTracks()
                .filter(track => track.kind === type) || [];
            
            oldTracks.forEach(track => {
                track.stop();
                localMediaStream.current?.removeTrack(track);
            });
    
            const constraints: MediaStreamConstraints = {
                [type]: deviceId ? { deviceId: { exact: deviceId } } : true
            };
    
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            const newTracks = stream.getTracks();
    
            if (!localMediaStream.current) {
                localMediaStream.current = new MediaStream();
            }
            
            newTracks.forEach(track => {
                localMediaStream.current?.addTrack(track);
                track.enabled = mediaState[type];
            });
    
            Object.values(peerConnections.current).forEach(pc => {
                const senders = pc.getSenders();
                senders.forEach(sender => {
                    if (sender.track?.kind === type) {
                        const newTrack = newTracks.find(t => t.kind === type);
                        if (newTrack) sender.replaceTrack(newTrack);
                    }
                });
            });
    
            const localVideo = peerMediaElements.current[LOCAL_VIDEO];
            if (localVideo) {
                localVideo.srcObject = new MediaStream(
                    localMediaStream.current.getTracks()
                );
                localVideo.play().catch(e => console.error('Local video play error:', e));
            }
    
            await enumerateDevices();
            return true;
        } catch (err) {
            console.error(`Ошибка переключения устройства ${type}:`, err);
            return false;
        }
    }, [enumerateDevices, mediaState]);

    const setupPeerConnection = useCallback(async (
        peerID: string, 
        createOffer: boolean
    ) => {
        if (peerID in peerConnections.current) return;

        const pc = new RTCPeerConnection({ 
            iceServers: iceServers.current,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        });

        peerConnections.current[peerID] = pc;

        pc.ontrack = ({ streams: [remoteStream] }) => {
            if (!remoteStream) return;
            
            addNewClient(peerID, () => {
                const element = peerMediaElements.current[peerID];
                if (element) {
                    element.srcObject = remoteStream;
                    element.play().catch(e => console.error('Remote video play error:', e));
                }
            });
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit(ACTIONS.RELAY_ICE, {
                    peerID,
                    iceCandidate: event.candidate,
                });
            }
        };

        if (localMediaStream.current) {
            localMediaStream.current.getTracks().forEach(track => {
                pc.addTrack(track, localMediaStream.current!);
            });
        }

        if (createOffer) {
            try {
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
                console.error('Ошибка создания оффера:', err);
            }
        }
    }, [addNewClient]);

    const addChatMessage = useCallback((message: ChatMessage) => {
        chatMessages.current = [...chatMessages.current, message];
    }, []);

    const getChatMessages = useCallback((): ChatMessage[] => {
        return chatMessages.current;
    }, []);

    useEffect(() => {
        const { isSupported, errors } = checkWebRTCAvailability();
        setWebRTCStatus({ isSupported, errors });

        if (!isSupported) {
            setMediaError(new Error(`WebRTC не поддерживается: ${errors.join(', ')}`));
            return;
        }

        let isMounted = true;
        let stream: MediaStream | null = null;

        async function init() {
            try {
                stream = await startMediaStream();
                if (!isMounted || !stream) return;

                localMediaStream.current = stream;
                addNewClient(LOCAL_VIDEO, () => {
                    const localVideo = peerMediaElements.current[LOCAL_VIDEO];
                    if (localVideo) {
                        localVideo.srcObject = stream;
                        localVideo.volume = 0;
                        localVideo.play().catch(e => console.error('Local video play error:', e));
                    }
                });

                if (roomID) socket.emit(ACTIONS.JOIN, { room: roomID });
            } catch (err) {
                console.error('Initialization error:', err);
                setMediaError(err as Error);
            }
        }

        init();

        return () => {
            isMounted = false;
            Object.values(peerConnections.current).forEach(pc => pc.close());
            peerConnections.current = {};

            if (stream) stream.getTracks().forEach(track => track.stop());
            if (localMediaStream.current) {
                localMediaStream.current.getTracks().forEach(track => track.stop());
                localMediaStream.current = null;
            }
            
            socket.emit(ACTIONS.LEAVE);
        };
    }, [roomID, startMediaStream, addNewClient]);

    useEffect(() => {
        const handleAddPeer = ({ peerID, createOffer }: { 
            peerID: string; 
            createOffer: boolean 
        }) => {
            setupPeerConnection(peerID, createOffer);
        };
        
        const handleSessionDescription = async ({ 
            peerID, 
            sessionDescription 
        }: { 
            peerID: string; 
            sessionDescription: RTCSessionDescriptionInit 
        }) => {
            const pc = peerConnections.current[peerID];
            if (!pc) return;

            try {
                await pc.setRemoteDescription(
                    new RTCSessionDescription(sessionDescription)
                );
                if (sessionDescription.type === 'offer') {
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    socket.emit(ACTIONS.RELAY_SDP, {
                        peerID,
                        sessionDescription: answer,
                    });
                }
            } catch (err) {
                console.error('setRemoteDescription error:', err);
            }
        };
        
        const handleIceCandidate = ({ 
            peerID, 
            iceCandidate 
        }: { 
            peerID: string; 
            iceCandidate: RTCIceCandidateInit 
        }) => {
            const pc = peerConnections.current[peerID];
            if (pc) pc.addIceCandidate(new RTCIceCandidate(iceCandidate));
        };
        
        const handleRemovePeer = ({ peerID }: { peerID: string }) => {
            const pc = peerConnections.current[peerID];
            if (pc) {
                pc.close();
                delete peerConnections.current[peerID];
                delete peerMediaElements.current[peerID];
                updateClients(list => list.filter(c => c !== peerID));
            }
        };

        const handleChatMessage = (msg: {
            id: string;
            message: string;
            sender: string;
            timestamp: string;
        }) => {
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

        return () => {
            socket.off(ACTIONS.ADD_PEER, handleAddPeer);
            socket.off(ACTIONS.SESSION_DESCRIPTION, handleSessionDescription);
            socket.off(ACTIONS.ICE_CANDIDATE, handleIceCandidate);
            socket.off(ACTIONS.REMOVE_PEER, handleRemovePeer);
            socket.off(ACTIONS.CHAT_MESSAGE, handleChatMessage);
        };
    }, [setupPeerConnection, updateClients, addChatMessage]);

    const provideMediaRef = useCallback((
        id: string, 
        node: HTMLVideoElement | null
    ) => {
        if (node) {
            node.autoplay = true;
            node.playsInline = true;
            node.muted = id === LOCAL_VIDEO;
            peerMediaElements.current[id] = node;
        }
    }, []);

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
        reconnect
    };
}