// server/bandwidth-manager.ts

export interface BandwidthReport {
  peerId: string;
  inboundBps: number;
  outboundBps: number;
  rtt: number;
  timestamp: number;
}

export interface PeerCapability {
  peerId: string;
  uploadSpeed: number;
  downloadSpeed: number;
  avgRtt: number;
  isRelayCapable: boolean;
  lastUpdate: number;
}

export interface TopologyEdge {
  from: string;
  to: string;
  type: 'direct' | 'relay';
}

export interface TopologyUpdate {
  edges: TopologyEdge[];
  relayAssignments: Map<string, string>;
  timestamp: number;
}

class BandwidthManager {
  private peerReports: Map<string, Map<string, BandwidthReport[]>> = new Map();
  private peerCapabilities: Map<string, Map<string, PeerCapability>> = new Map();
  private currentTopologies: Map<string, TopologyUpdate> = new Map();
  private updateIntervals: Map<string, NodeJS.Timeout> = new Map();
  
  // Исправленные пороги для ваших данных (скорости 0.5-2.5 Mbps)
  private readonly STRONG_THRESHOLD = 2.5;
  private readonly WEAK_THRESHOLD = 1.0;
  private readonly RELAY_CAPABLE_THRESHOLD = 2.0;
  
  private readonly TOPOLOGY_RECALC_INTERVAL_MS = 10000;
  
  initRoom(roomId: string): void {
    if (!this.peerReports.has(roomId)) {
      this.peerReports.set(roomId, new Map());
      this.peerCapabilities.set(roomId, new Map());
      
      const interval = setInterval(() => {
        this.recalculateTopology(roomId);
      }, this.TOPOLOGY_RECALC_INTERVAL_MS);
      
      this.updateIntervals.set(roomId, interval);
      console.log(`[BandwidthManager] Room ${roomId.slice(-8)} initialized, recalculation every ${this.TOPOLOGY_RECALC_INTERVAL_MS/1000}s`);
    }
  }
  
  cleanupRoom(roomId: string): void {
    const interval = this.updateIntervals.get(roomId);
    if (interval) {
      clearInterval(interval);
      this.updateIntervals.delete(roomId);
    }
    this.peerReports.delete(roomId);
    this.peerCapabilities.delete(roomId);
    this.currentTopologies.delete(roomId);
    console.log(`[BandwidthManager] Room ${roomId.slice(-8)} cleaned up`);
  }
  
  addBandwidthReport(roomId: string, peerId: string, report: BandwidthReport): void {
    if (!this.peerReports.has(roomId)) {
      this.initRoom(roomId);
    }
    
    const reports = this.peerReports.get(roomId)!;
    if (!reports.has(peerId)) {
      reports.set(peerId, []);
    }
    
    const peerReports = reports.get(peerId)!;
    peerReports.push(report);
    
    while (peerReports.length > 10) {
      peerReports.shift();
    }
    
    this.updatePeerCapability(roomId, peerId);
    this.logPeerSpeed(roomId, peerId);
  }
  
  private logPeerSpeed(roomId: string, peerId: string): void {
    const cap = this.peerCapabilities.get(roomId)?.get(peerId);
    if (cap && cap.uploadSpeed > 0) {
      const shortId = peerId.slice(-8);
      const status = cap.isRelayCapable ? '🚀' : (cap.uploadSpeed < this.WEAK_THRESHOLD ? '🐢' : '•');
      console.log(`[Speed] ${status} ${shortId}: ↑${cap.uploadSpeed.toFixed(2)}Mbps ↓${cap.downloadSpeed.toFixed(2)}Mbps`);
    }
  }
  
  private updatePeerCapability(roomId: string, peerId: string): void {
    const reports = this.peerReports.get(roomId)?.get(peerId) || [];
    if (reports.length === 0) return;
    
    let avgUpload = 0;
    let avgDownload = 0;
    let avgRtt = 0;
    
    for (const report of reports) {
      avgUpload += report.outboundBps;
      avgDownload += report.inboundBps;
      avgRtt += report.rtt;
    }
    
    avgUpload = (avgUpload / reports.length) / 1e6;
    avgDownload = (avgDownload / reports.length) / 1e6;
    avgRtt = avgRtt / reports.length;
    
    const isRelayCapable = avgUpload >= this.RELAY_CAPABLE_THRESHOLD;
    
    const capabilities = this.peerCapabilities.get(roomId)!;
    capabilities.set(peerId, {
      peerId,
      uploadSpeed: avgUpload,
      downloadSpeed: avgDownload,
      avgRtt,
      isRelayCapable,
      lastUpdate: Date.now()
    });
  }
  
  getRoomParticipants(roomId: string): Map<string, PeerCapability> {
    return this.peerCapabilities.get(roomId) || new Map();
  }
  
  private logRoomSummary(roomId: string): void {
    const participants = this.getRoomParticipants(roomId);
    if (participants.size === 0) return;
    
    console.log(`\n[Room ${roomId.slice(-8)}] Speed summary (${participants.size} participants):`);
    for (const [peerId, cap] of participants) {
      const shortId = peerId.slice(-8);
      const status = cap.isRelayCapable ? '🚀' : (cap.uploadSpeed < this.WEAK_THRESHOLD ? '🐢' : '•');
      console.log(`  ${status} ${shortId}: ↑${cap.uploadSpeed.toFixed(2)}Mbps ↓${cap.downloadSpeed.toFixed(2)}Mbps`);
    }
  }
  
  private recalculateTopology(roomId: string): void {
    const participants = this.getRoomParticipants(roomId);
    const allPeerIds = Array.from(participants.keys());
    
    this.logRoomSummary(roomId);
    
    if (allPeerIds.length < 3) {
      const edges: TopologyEdge[] = [];
      if (allPeerIds.length === 2) {
        edges.push({ from: allPeerIds[0], to: allPeerIds[1], type: 'direct' });
      }
      const update: TopologyUpdate = {
        edges,
        relayAssignments: new Map(),
        timestamp: Date.now()
      };
      this.currentTopologies.set(roomId, update);
      console.log(`[Topology] Room ${roomId.slice(-8)}: ${allPeerIds.length} participants -> direct P2P only`);
      return;
    }
    
    const strongPeers: PeerCapability[] = [];
    const weakPeers: PeerCapability[] = [];
    const potentialRelays: PeerCapability[] = [];
    
    for (const [_, cap] of participants) {
      if (cap.uploadSpeed >= this.STRONG_THRESHOLD) {
        strongPeers.push(cap);
      } else if (cap.uploadSpeed <= this.WEAK_THRESHOLD) {
        weakPeers.push(cap);
      }
      
      if (cap.isRelayCapable) {
        potentialRelays.push(cap);
      }
    }
    
    const relayCount = Math.max(1, Math.min(potentialRelays.length, Math.ceil(weakPeers.length / 2)));
    const relays = potentialRelays.slice(0, relayCount);
    
    const edges: TopologyEdge[] = [];
    const relayAssignments = new Map<string, string>();
    
    const allStrong = [...strongPeers, ...relays];
    for (let i = 0; i < allStrong.length; i++) {
      for (let j = i + 1; j < allStrong.length; j++) {
        edges.push({
          from: allStrong[i].peerId,
          to: allStrong[j].peerId,
          type: 'direct'
        });
      }
    }
    
    for (const weak of weakPeers) {
      let bestRelay = relays[0];
      let bestRtt = Infinity;
      
      for (const relay of relays) {
        if (relay.avgRtt < bestRtt) {
          bestRtt = relay.avgRtt;
          bestRelay = relay;
        }
      }
      
      if (bestRelay) {
        edges.push({
          from: weak.peerId,
          to: bestRelay.peerId,
          type: 'relay'
        });
        relayAssignments.set(weak.peerId, bestRelay.peerId);
        
        const weakShort = weak.peerId.slice(-8);
        const relayShort = bestRelay.peerId.slice(-8);
        console.log(`[Topology] Weak peer ${weakShort} → relay ${relayShort}`);
      }
    }
    
    const update: TopologyUpdate = {
      edges,
      relayAssignments,
      timestamp: Date.now()
    };
    
    this.currentTopologies.set(roomId, update);
    
    console.log(`[Topology] Room ${roomId.slice(-8)}: ${strongPeers.length} strong, ${weakPeers.length} weak, ${relays.length} relays, ${edges.length} edges`);
  }
  
  getTopology(roomId: string): TopologyUpdate | null {
    return this.currentTopologies.get(roomId) || null;
  }
  
  removePeer(roomId: string, peerId: string): void {
    const reports = this.peerReports.get(roomId);
    if (reports) {
      reports.delete(peerId);
    }
    
    const capabilities = this.peerCapabilities.get(roomId);
    if (capabilities) {
      capabilities.delete(peerId);
    }
    
    if (this.peerCapabilities.get(roomId)?.size === 0) {
      this.cleanupRoom(roomId);
    } else {
      this.recalculateTopology(roomId);
    }
  }
  
  isRelay(roomId: string, peerId: string): boolean {
    const capabilities = this.peerCapabilities.get(roomId);
    if (!capabilities) return false;
    
    const cap = capabilities.get(peerId);
    return cap?.isRelayCapable || false;
  }
  
  getRelayForPeer(roomId: string, peerId: string): string | null {
    const topology = this.currentTopologies.get(roomId);
    if (!topology) return null;
    
    return topology.relayAssignments.get(peerId) || null;
  }
}

export const bandwidthManager = new BandwidthManager();