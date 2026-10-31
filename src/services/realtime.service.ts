import { WebSocket } from "ws";

export type RealtimeEventType =
  | "CONNECTED"
  | "HEARTBEAT"
  | "SHIFT_OPENED"
  | "SHIFT_CLOSED"
  | "SHIFT_UPDATED"
  | "CASH_MOVEMENT"
  | "SALE_COMPLETED"
  | "SALE_RETURNED";

export interface RealtimeMessage {
  type: RealtimeEventType;
  storeId?: string;
  data: any;
  timestamp: string;
}

interface ClientConnection {
  socket: WebSocket;
  storeId?: string;
  userId?: string;
  isAlive: boolean;
  connectedAt: Date;
}

class RealtimeService {
  private clients = new Set<ClientConnection>();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startHeartbeat();
  }

  /**
   * Register a new client socket connection
   */
  public registerClient(socket: WebSocket, initialStoreId?: string, userId?: string): ClientConnection {
    const client: ClientConnection = {
      socket,
      storeId: initialStoreId,
      userId,
      isAlive: true,
      connectedAt: new Date(),
    };

    this.clients.add(client);

    // Setup socket listeners
    socket.on("pong", () => {
      client.isAlive = true;
    });

    socket.on("message", (raw: string | Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "SUBSCRIBE" && msg.storeId) {
          client.storeId = String(msg.storeId);
        } else if (msg.type === "PING") {
          this.sendToClient(client, {
            type: "HEARTBEAT",
            data: { status: "pong" },
            timestamp: new Date().toISOString(),
          });
        }
      } catch {
        // Ignore invalid JSON payloads
      }
    });

    socket.on("close", () => {
      this.clients.delete(client);
    });

    socket.on("error", () => {
      this.clients.delete(client);
    });

    // Send immediate connection acknowledgement
    this.sendToClient(client, {
      type: "CONNECTED",
      storeId: client.storeId,
      data: {
        message: "Real-time POS and Cash Counter link active",
        activeConnections: this.clients.size,
      },
      timestamp: new Date().toISOString(),
    });

    return client;
  }

  /**
   * Update client store subscription
   */
  public updateClientStore(client: ClientConnection, storeId: string) {
    client.storeId = storeId;
  }

  /**
   * Safely send message to a single client
   */
  private sendToClient(client: ClientConnection, message: RealtimeMessage) {
    if (client.socket.readyState === WebSocket.OPEN) {
      try {
        client.socket.send(JSON.stringify(message));
      } catch (err) {
        console.error("Failed to send WebSocket message:", err);
      }
    }
  }

  /**
   * Broadcast an event to all clients belonging to a specific store
   */
  public broadcastToStore(storeId: string, type: RealtimeEventType, data: any) {
    const payload: RealtimeMessage = {
      type,
      storeId,
      data,
      timestamp: new Date().toISOString(),
    };

    const targetStoreId = String(storeId);

    for (const client of this.clients) {
      // Send if client is subscribed to this store, or if client has no specific store (e.g. Super Admin)
      if (!client.storeId || client.storeId === targetStoreId) {
        this.sendToClient(client, payload);
      }
    }
  }

  /**
   * Broadcast an event to all connected clients across all stores
   */
  public broadcastAll(type: RealtimeEventType, data: any) {
    const payload: RealtimeMessage = {
      type,
      data,
      timestamp: new Date().toISOString(),
    };

    for (const client of this.clients) {
      this.sendToClient(client, payload);
    }
  }

  /**
   * Helpers for shift and cash counter real-time events
   */
  public notifyShiftOpened(storeId: string, shiftSummary: any) {
    this.broadcastToStore(storeId, "SHIFT_OPENED", {
      shift: shiftSummary,
      shiftSummary,
    });
  }

  public notifyShiftClosed(storeId: string, closedShift: any) {
    this.broadcastToStore(storeId, "SHIFT_CLOSED", {
      shift: closedShift,
      shiftSummary: null,
    });
  }

  public notifyShiftUpdated(storeId: string, shiftSummary: any, metadata?: any) {
    this.broadcastToStore(storeId, "SHIFT_UPDATED", {
      shift: shiftSummary,
      shiftSummary,
      metadata,
    });
  }

  public notifyCashMovement(storeId: string, shiftSummary: any, movement: any) {
    this.broadcastToStore(storeId, "CASH_MOVEMENT", {
      shift: shiftSummary,
      shiftSummary,
      movement,
    });
  }

  public notifySaleCompleted(storeId: string, shiftSummary: any, saleDetails: any) {
    this.broadcastToStore(storeId, "SALE_COMPLETED", {
      shift: shiftSummary,
      shiftSummary,
      sale: saleDetails,
    });
  }

  public notifySaleReturned(storeId: string, shiftSummary: any, returnDetails: any) {
    this.broadcastToStore(storeId, "SALE_RETURNED", {
      shift: shiftSummary,
      shiftSummary,
      return: returnDetails,
    });
  }

  /**
   * Periodic ping heartbeat to prune dead sockets
   */
  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      for (const client of this.clients) {
        if (!client.isAlive) {
          try {
            client.socket.terminate();
          } catch {}
          this.clients.delete(client);
          continue;
        }

        client.isAlive = false;
        try {
          client.socket.ping();
        } catch {
          this.clients.delete(client);
        }
      }
    }, 30000);
  }

  public getConnectedClientsCount(storeId?: string): number {
    if (!storeId) return this.clients.size;
    let count = 0;
    for (const client of this.clients) {
      if (!client.storeId || client.storeId === storeId) {
        count++;
      }
    }
    return count;
  }
}

export const realtimeService = new RealtimeService();
