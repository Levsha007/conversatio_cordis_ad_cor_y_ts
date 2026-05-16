// src/hooks/useBandwidthMonitor.ts

import { useRef, useCallback, useEffect } from 'react';
import socket from '../socket';

interface BandwidthMetrics {
  inboundBps: number;
  outboundBps: number;
  rtt: number;
  packetsLost: number;
  fractionLost: number;
}

/** fractionLost есть в runtime (remote-inbound-rtp), но не во всех версиях lib.dom */
type RemoteInboundRtpStats = RTCStats & { fractionLost?: number };

export default function useBandwidthMonitor() {
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const monitorIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isMonitoringRef = useRef<boolean>(false);
  const lastStatsRef = useRef<Map<string, { bytesReceived: number; bytesSent: number; timestamp: number }>>(new Map());
  
  const registerPeerConnection = useCallback((peerId: string, pc: RTCPeerConnection) => {
    peerConnectionsRef.current.set(peerId, pc);
    console.log(`[BandwidthMonitor] Registered peer ${peerId.slice(-8)}`);
  }, []);
  
  const unregisterPeerConnection = useCallback((peerId: string) => {
    peerConnectionsRef.current.delete(peerId);
    lastStatsRef.current.delete(peerId);
    console.log(`[BandwidthMonitor] Unregistered peer ${peerId.slice(-8)}`);
  }, []);
  
  const getPeerStats = useCallback(async (peerId: string, pc: RTCPeerConnection): Promise<BandwidthMetrics | null> => {
    try {
      const stats = await pc.getStats();
      
      let inboundBps = 0;
      let outboundBps = 0;
      let rtt = 0;
      let packetsLost = 0;
      let fractionLost = 0;
      let currentBytesReceived = 0;
      let currentBytesSent = 0;
      const currentTimestamp = Date.now();
      
      const lastStats = lastStatsRef.current.get(peerId);
      
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.kind === 'audio')) {
          const inbound = report as RTCInboundRtpStreamStats;
          currentBytesReceived += inbound.bytesReceived || 0;
          packetsLost += inbound.packetsLost || 0;
        }

        if (report.type === 'remote-inbound-rtp') {
          const remoteInbound = report as RemoteInboundRtpStats;
          if (remoteInbound.fractionLost != null) {
            fractionLost = Math.max(fractionLost, remoteInbound.fractionLost);
          }
        }
        
        if (report.type === 'outbound-rtp' && (report.kind === 'video' || report.kind === 'audio')) {
          currentBytesSent += (report as RTCOutboundRtpStreamStats).bytesSent || 0;
        }
        
        if (report.type === 'candidate-pair' && (report as RTCIceCandidatePairStats).nominated) {
          const pairRtt = (report as RTCIceCandidatePairStats).currentRoundTripTime;
          if (pairRtt && (!rtt || pairRtt < rtt)) {
            rtt = pairRtt;
          }
        }
      });
      
      if (lastStats && lastStats.timestamp > 0) {
        const timeDiff = (currentTimestamp - lastStats.timestamp) / 1000;
        if (timeDiff > 0) {
          inboundBps = ((currentBytesReceived - (lastStats.bytesReceived || 0)) * 8) / timeDiff;
          outboundBps = ((currentBytesSent - (lastStats.bytesSent || 0)) * 8) / timeDiff;
        }
      }
      
      lastStatsRef.current.set(peerId, {
        bytesReceived: currentBytesReceived,
        bytesSent: currentBytesSent,
        timestamp: currentTimestamp
      });
      
      return {
        inboundBps: Math.max(inboundBps, 0),
        outboundBps: Math.max(outboundBps, 0),
        rtt: rtt ? Math.round(rtt * 1000) : 0,
        packetsLost,
        fractionLost
      };
    } catch (err) {
      console.error(`[BandwidthMonitor] Error getting stats for peer ${peerId.slice(-8)}:`, err);
      return null;
    }
  }, []);
  
  const collectAndSendStats = useCallback(async () => {
    const connections = Array.from(peerConnectionsRef.current.entries());
    if (connections.length === 0) return;

    let totalInbound = 0;
    let totalOutbound = 0;
    let bestRtt = 0;
    let hasMetrics = false;

    for (const [peerId, pc] of connections) {
      const stats = await getPeerStats(peerId, pc);
      if (!stats) continue;

      hasMetrics = true;
      totalInbound += stats.inboundBps;
      totalOutbound += stats.outboundBps;
      if (stats.rtt > 0 && (!bestRtt || stats.rtt < bestRtt)) {
        bestRtt = stats.rtt;
      }
    }

    if (!hasMetrics || !socket.id) return;

    socket.emit('bandwidth-report', {
      peerId: socket.id,
      inboundBps: Math.round(totalInbound),
      outboundBps: Math.round(totalOutbound),
      rtt: bestRtt
    });

    if (totalOutbound > 100000 || totalInbound > 100000) {
      console.log(
        `[Bandwidth] ↑${(totalOutbound / 1e6).toFixed(2)}Mbps ↓${(totalInbound / 1e6).toFixed(2)}Mbps (${connections.length} peer(s))`
      );
    }
  }, [getPeerStats]);
  
  const startMonitoring = useCallback((intervalMs: number = 5000) => {
    if (isMonitoringRef.current) return;
    
    isMonitoringRef.current = true;
    collectAndSendStats();
    
    monitorIntervalRef.current = setInterval(() => {
      collectAndSendStats();
    }, intervalMs);
    
    console.log(`[BandwidthMonitor] Started monitoring with interval ${intervalMs}ms`);
  }, [collectAndSendStats]);
  
  const stopMonitoring = useCallback(() => {
    if (monitorIntervalRef.current) {
      clearInterval(monitorIntervalRef.current);
      monitorIntervalRef.current = null;
    }
    isMonitoringRef.current = false;
    lastStatsRef.current.clear();
    console.log('[BandwidthMonitor] Stopped monitoring');
  }, []);
  
  const collectStatsNow = useCallback(async () => {
    await collectAndSendStats();
  }, [collectAndSendStats]);
  
  useEffect(() => {
    return () => {
      stopMonitoring();
    };
  }, [stopMonitoring]);
  
  return {
    registerPeerConnection,
    unregisterPeerConnection,
    startMonitoring,
    stopMonitoring,
    collectStatsNow,
    getPeerStats
  };
}
