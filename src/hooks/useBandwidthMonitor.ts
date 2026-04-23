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

interface PeerConnectionInfo {
  peerId: string;
  pc: RTCPeerConnection;
}

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
      let currentTimestamp = Date.now();
      
      const lastStats = lastStatsRef.current.get(peerId);
      
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          currentBytesReceived = (report as any).bytesReceived || 0;
          packetsLost = (report as any).packetsLost || 0;
          fractionLost = (report as any).fractionLost || 0;
        }
        
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          currentBytesSent = (report as any).bytesSent || 0;
        }
        
        if (report.type === 'candidate-pair' && (report as any).nominated === true) {
          rtt = (report as any).currentRtt || 0;
        }
      });
      
      // Вычисляем битрейт на основе разницы с предыдущим замером
      if (lastStats && lastStats.timestamp > 0) {
        const timeDiff = (currentTimestamp - lastStats.timestamp) / 1000;
        if (timeDiff > 0) {
          inboundBps = ((currentBytesReceived - (lastStats.bytesReceived || 0)) * 8) / timeDiff;
          outboundBps = ((currentBytesSent - (lastStats.bytesSent || 0)) * 8) / timeDiff;
        }
      }
      
      // Сохраняем текущие значения для следующего замера
      lastStatsRef.current.set(peerId, {
        bytesReceived: currentBytesReceived,
        bytesSent: currentBytesSent,
        timestamp: currentTimestamp
      });
      
      return {
        inboundBps: Math.max(inboundBps, 0),
        outboundBps: Math.max(outboundBps, 0),
        rtt: rtt || 0,
        packetsLost,
        fractionLost: fractionLost / 256
      };
    } catch (err) {
      console.error(`[BandwidthMonitor] Error getting stats for peer ${peerId.slice(-8)}:`, err);
      return null;
    }
  }, []);
  
  const collectAndSendStats = useCallback(async () => {
    const connections = Array.from(peerConnectionsRef.current.entries());
    
    for (const [peerId, pc] of connections) {
      const stats = await getPeerStats(peerId, pc);
      
      if (stats) {
        socket.emit('bandwidth-report', {
          peerId,
          inboundBps: Math.round(stats.inboundBps),
          outboundBps: Math.round(stats.outboundBps),
          rtt: stats.rtt
        });
        
        if (stats.outboundBps > 100000 || stats.inboundBps > 100000) {
          console.log(`[Bandwidth] ${peerId.slice(-8)}: ↑${(stats.outboundBps / 1e6).toFixed(2)}Mbps ↓${(stats.inboundBps / 1e6).toFixed(2)}Mbps`);
        }
      }
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