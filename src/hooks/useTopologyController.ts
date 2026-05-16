// src/hooks/useTopologyController.ts

import { useRef, useCallback, useState } from 'react';
import socket from '../socket';
import { ACTIONS } from '../socket/actions';

export interface TopologyEdge {
  from: string;
  to: string;
  type: 'direct' | 'relay';
}

export interface TopologyUpdate {
  edges: TopologyEdge[];
  relayAssignments: [string, string][];
  timestamp: number;
}

export interface RelayState {
  isRelayActive: boolean;
  relayedPeers: Set<string>;
  assignedRelay: string | null;
}

export default function useTopologyController(localPeerId: string | null) {
  const [currentTopology, setCurrentTopology] = useState<TopologyUpdate | null>(null);
  const [relayState, setRelayState] = useState<RelayState>({
    isRelayActive: false,
    relayedPeers: new Set(),
    assignedRelay: null
  });
  
  const relayConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const [canBeRelay, setCanBeRelay] = useState<boolean>(false);
  
  const requestTopology = useCallback(() => {
    socket.emit('request-topology');
  }, []);
  
  const syncFromTopologyUpdate = useCallback((data: {
    edges?: TopologyEdge[];
    relayAssignments?: [string, string][];
    timestamp?: number;
  }) => {
    const update: TopologyUpdate = {
      edges: data.edges || [],
      relayAssignments: data.relayAssignments || [],
      timestamp: data.timestamp ?? Date.now()
    };
    
    setCurrentTopology(update);
    
    if (localPeerId) {
      const isDesignatedRelay = update.edges.some(
        edge => edge.type === 'relay' && edge.to === localPeerId
      );
      
      let assignedRelay: string | null = null;
      for (const [weakPeer, strongPeer] of update.relayAssignments) {
        if (weakPeer === localPeerId) {
          assignedRelay = strongPeer;
          break;
        }
      }
      
      setRelayState(prev => ({
        ...prev,
        isRelayActive: isDesignatedRelay,
        assignedRelay
      }));
    }
    
    console.log('[Topology] Synced update:', update);
  }, [localPeerId]);
  
  const createRelayConnection = useCallback(async (
    sourcePeerId: string,
    targetPeerId: string,
    sourceStream: MediaStream
  ): Promise<RTCPeerConnection | null> => {
    const config: RTCConfiguration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };
    
    const pc = new RTCPeerConnection(config);
    const connectionKey = `${sourcePeerId}->${targetPeerId}`;
    
    sourceStream.getTracks().forEach(track => {
      pc.addTrack(track, sourceStream);
    });
    
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit(ACTIONS.RELAY_ICE, {
          peerID: targetPeerId,
          iceCandidate: event.candidate,
          isRelayForward: true,
          sourcePeerId
        });
      }
    };
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    socket.emit(ACTIONS.RELAY_SDP, {
      peerID: targetPeerId,
      sessionDescription: offer,
      isRelayForward: true,
      sourcePeerId
    });
    
    relayConnections.current.set(connectionKey, pc);
    return pc;
  }, []);
  
  const closeRelayConnection = useCallback((sourcePeerId: string, targetPeerId: string) => {
    const key = `${sourcePeerId}->${targetPeerId}`;
    const pc = relayConnections.current.get(key);
    if (pc) {
      pc.close();
      relayConnections.current.delete(key);
      console.log(`[Topology] Closed relay connection ${key}`);
    }
  }, []);
  
  const activateRelayMode = useCallback(async (
    incomingStreams: Map<string, MediaStream>,
    peersToRelay: string[]
  ) => {
    if (!canBeRelay) {
      console.warn('[Topology] Cannot activate relay mode - not capable');
      return false;
    }
    
    setRelayState(prev => ({ ...prev, isRelayActive: true }));
    
    for (const targetPeerId of peersToRelay) {
      const combinedStream = new MediaStream();
      for (const stream of incomingStreams.values()) {
        stream.getTracks().forEach(track => {
          if (!combinedStream.getTracks().some(t => t.id === track.id)) {
            combinedStream.addTrack(track);
          }
        });
      }
      
      await createRelayConnection('relay', targetPeerId, combinedStream);
    }
    
    socket.emit('become-relay');
    console.log('[Topology] Relay mode activated');
    return true;
  }, [canBeRelay, createRelayConnection]);
  
  const deactivateRelayMode = useCallback(() => {
    for (const [key, pc] of relayConnections.current) {
      pc.close();
      relayConnections.current.delete(key);
    }
    
    setRelayState(prev => ({ ...prev, isRelayActive: false }));
    socket.emit('stop-relay');
    console.log('[Topology] Relay mode deactivated');
  }, []);
  
  const configureAsWeakPeer = useCallback((relayPeerId: string) => {
    setRelayState(prev => ({ ...prev, assignedRelay: relayPeerId }));
    console.log(`[Topology] Configured as weak peer, assigned to relay ${relayPeerId}`);
  }, []);
  
  return {
    currentTopology,
    relayState,
    canBeRelay,
    setCanBeRelay,
    requestTopology,
    syncFromTopologyUpdate,
    activateRelayMode,
    deactivateRelayMode,
    configureAsWeakPeer,
    createRelayConnection,
    closeRelayConnection
  };
}
