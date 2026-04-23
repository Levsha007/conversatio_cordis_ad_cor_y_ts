// server/socket/topology-handler.ts

import { Server, Socket } from 'socket.io';
import { bandwidthManager, BandwidthReport, TopologyUpdate } from '../bandwidth-manager';

export const TOPOLOGY_EVENTS = {
  BANDWIDTH_REPORT: 'bandwidth-report',
  TOPOLOGY_UPDATE: 'topology-update',
  REQUEST_TOPOLOGY: 'request-topology',
  BECOME_RELAY: 'become-relay',
  STOP_RELAY: 'stop-relay'
};

interface BandwidthReportPayload {
  peerId: string;
  inboundBps: number;
  outboundBps: number;
  rtt: number;
}

/**
 * Настройка обработчиков топологии для сокета
 */
export function setupTopologyHandlers(io: Server, socket: Socket): void {
  const rooms = new Set<string>();
  
  // Отслеживаем комнаты, в которые входит пользователь
  const originalJoin = socket.join.bind(socket);
  socket.join = function(room: string) {
    rooms.add(room);
    bandwidthManager.initRoom(room);
    return originalJoin(room);
  };
  
  /**
   * Получение отчёта о пропускной способности
   */
  socket.on(TOPOLOGY_EVENTS.BANDWIDTH_REPORT, (data: BandwidthReportPayload) => {
    const { peerId, inboundBps, outboundBps, rtt } = data;
    
    for (const roomId of rooms) {
      const room = io.sockets.adapter.rooms.get(roomId);
      if (room && room.has(socket.id)) {
        const report: BandwidthReport = {
          peerId: socket.id,
          inboundBps,
          outboundBps,
          rtt,
          timestamp: Date.now()
        };
        
        bandwidthManager.addBandwidthReport(roomId, socket.id, report);
        
        const topology = bandwidthManager.getTopology(roomId);
        if (topology) {
          io.to(roomId).emit(TOPOLOGY_EVENTS.TOPOLOGY_UPDATE, {
            edges: topology.edges,
            relayAssignments: Array.from(topology.relayAssignments.entries()),
            timestamp: topology.timestamp
          });
        }
        break;
      }
    }
  });
  
  /**
   * Запрос текущей топологии
   */
  socket.on(TOPOLOGY_EVENTS.REQUEST_TOPOLOGY, () => {
    for (const roomId of rooms) {
      const topology = bandwidthManager.getTopology(roomId);
      if (topology) {
        socket.emit(TOPOLOGY_EVENTS.TOPOLOGY_UPDATE, {
          edges: topology.edges,
          relayAssignments: Array.from(topology.relayAssignments.entries()),
          timestamp: topology.timestamp
        });
      }
      break;
    }
  });
  
  /**
   * Участник готов стать ретранслятором
   */
  socket.on(TOPOLOGY_EVENTS.BECOME_RELAY, () => {
    for (const roomId of rooms) {
      console.log(`[Relay] ${socket.id.slice(-8)} ready to become relay in room ${roomId.slice(-8)}`);
      bandwidthManager.addBandwidthReport(roomId, socket.id, {
        peerId: socket.id,
        inboundBps: 15000000,
        outboundBps: 15000000,
        rtt: 50,
        timestamp: Date.now()
      });
      break;
    }
  });
  
  /**
   * Участник больше не ретранслятор
   */
  socket.on(TOPOLOGY_EVENTS.STOP_RELAY, () => {
    for (const roomId of rooms) {
      bandwidthManager.addBandwidthReport(roomId, socket.id, {
        peerId: socket.id,
        inboundBps: 1000000,
        outboundBps: 1000000,
        rtt: 100,
        timestamp: Date.now()
      });
      break;
    }
  });
  
  /**
   * При отключении очищаем данные
   */
  socket.on('disconnect', () => {
    for (const roomId of rooms) {
      bandwidthManager.removePeer(roomId, socket.id);
    }
  });
}