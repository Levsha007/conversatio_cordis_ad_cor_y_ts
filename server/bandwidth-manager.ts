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

type TopologyBroadcastHandler = (roomId: string, topology: TopologyUpdate) => void;

const DEFAULT_CAPABILITY: Omit<PeerCapability, 'peerId'> = {
  uploadSpeed: 5,
  downloadSpeed: 5,
  avgRtt: 50,
  isRelayCapable: true,
  lastUpdate: Date.now()
};

class BandwidthManager {
  private peerReports: Map<string, Map<string, BandwidthReport[]>> = new Map();
  private peerCapabilities: Map<string, Map<string, PeerCapability>> = new Map();
  private currentTopologies: Map<string, TopologyUpdate> = new Map();
  private topologySignatures: Map<string, string> = new Map();
  private updateIntervals: Map<string, NodeJS.Timeout> = new Map();
  private logCounters: Map<string, number> = new Map();
  private topologyBroadcast: TopologyBroadcastHandler | null = null;
  
  private readonly STRONG_THRESHOLD = 2.5;
  private readonly WEAK_THRESHOLD = 1.0;
  private readonly RELAY_CAPABLE_THRESHOLD = 2.0;
  private readonly TOPOLOGY_RECALC_INTERVAL_MS = 10000;
  private readonly MIN_REPORTS_FOR_CLASSIFICATION = 2;
  
  setTopologyBroadcast(handler: TopologyBroadcastHandler): void {
    this.topologyBroadcast = handler;
  }
  
  initRoom(roomId: string): void {
    if (!this.peerReports.has(roomId)) {
      this.peerReports.set(roomId, new Map());
      this.peerCapabilities.set(roomId, new Map());
      this.logCounters.set(roomId, 0);
      
      const interval = setInterval(() => {
        this.recalculateTopology(roomId);
      }, this.TOPOLOGY_RECALC_INTERVAL_MS);
      
      this.updateIntervals.set(roomId, interval);
      console.log(`[BWMGR] Room ${roomId.slice(-8)} initialized`);
    }
  }
  
  registerPeer(roomId: string, peerId: string): void {
    this.initRoom(roomId);
    const capabilities = this.peerCapabilities.get(roomId)!;
    
    if (!capabilities.has(peerId)) {
      capabilities.set(peerId, { peerId, ...DEFAULT_CAPABILITY });
      this.recalculateTopology(roomId);
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
    this.topologySignatures.delete(roomId);
    this.logCounters.delete(roomId);
    console.log(`[BWMGR] Room ${roomId.slice(-8)} cleaned up`);
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
    this.recalculateTopology(roomId);
  }
  
  private updatePeerCapability(roomId: string, peerId: string): void {
    const reports = this.peerReports.get(roomId)?.get(peerId) || [];
    const capabilities = this.peerCapabilities.get(roomId)!;
    
    if (reports.length < this.MIN_REPORTS_FOR_CLASSIFICATION) {
      if (!capabilities.has(peerId)) {
        capabilities.set(peerId, { peerId, ...DEFAULT_CAPABILITY });
      }
      return;
    }
    
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
  
  private topologySignature(topology: TopologyUpdate): string {
    const edges = [...topology.edges]
      .map(e => `${e.from}:${e.to}:${e.type}`)
      .sort()
      .join('|');
    const relays = Array.from(topology.relayAssignments.entries())
      .map(([weak, strong]) => `${weak}->${strong}`)
      .sort()
      .join('|');
    return `${edges}#${relays}`;
  }
  
  private publishTopologyIfChanged(roomId: string, update: TopologyUpdate): void {
    const signature = this.topologySignature(update);
    if (this.topologySignatures.get(roomId) === signature) {
      return;
    }
    
    this.topologySignatures.set(roomId, signature);
    this.currentTopologies.set(roomId, update);
    this.topologyBroadcast?.(roomId, update);
  }
  
  private logSpeedUpdate(roomId: string): void {
    const participants = this.getRoomParticipants(roomId);
    if (participants.size === 0) return;
    
    const counter = (this.logCounters.get(roomId) || 0) + 1;
    this.logCounters.set(roomId, counter);
    
    if (counter % 6 === 0) {
      console.log(`[BWMGR] Room ${roomId.slice(-8)} speed summary (${participants.size} users):`);
      for (const [peerId, cap] of participants) {
        const shortId = peerId.slice(-8);
        const type = cap.isRelayCapable ? 'RELAY' : (cap.uploadSpeed < this.WEAK_THRESHOLD ? 'WEAK' : 'NORMAL');
        console.log(`  ${type} ${shortId}: up=${cap.uploadSpeed.toFixed(2)}Mbps down=${cap.downloadSpeed.toFixed(2)}Mbps`);
      }
    }
  }
  
  recalculateTopology(roomId: string): boolean {
    const participants = this.getRoomParticipants(roomId);
    const allPeerIds = Array.from(participants.keys());
    
    this.logSpeedUpdate(roomId);
    
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
      this.publishTopologyIfChanged(roomId, update);
      if (allPeerIds.length === 2) {
        console.log(`[TOPOLOGY] Room ${roomId.slice(-8)}: 2 users -> direct P2P`);
      }
      return true;
    }
    
    const strongPeers: PeerCapability[] = [];
    const weakPeers: PeerCapability[] = [];
    const potentialRelays: PeerCapability[] = [];
    
    for (const [, cap] of participants) {
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
        console.log(`[TOPOLOGY] Room ${roomId.slice(-8)}: ${weak.peerId.slice(-8)} -> relay ${bestRelay.peerId.slice(-8)}`);
      }
    }
    
    const update: TopologyUpdate = {
      edges,
      relayAssignments,
      timestamp: Date.now()
    };
    
    this.publishTopologyIfChanged(roomId, update);
    
    if (weakPeers.length > 0) {
      console.log(`[TOPOLOGY] Room ${roomId.slice(-8)}: strong=${strongPeers.length} weak=${weakPeers.length} relays=${relays.length} edges=${edges.length}`);
    }
    
    return true;
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
