import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { realtimeService } from "../services/realtime.service";

export async function realtimeRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // WebSocket upgrade endpoint
  server.get("/ws", { websocket: true }, (connection, req: FastifyRequest) => {
    const query = req.query as { storeId?: string };
    const storeId = query.storeId || (req.headers["x-store-id"] as string);
    const userId = (req as any).authUser?.userId;

    realtimeService.registerClient(connection.socket, storeId, userId);
  });

  // HTTP status endpoint for health monitoring
  server.get("/api/realtime/status", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId } = request.query as { storeId?: string };
    return reply.send({
      success: true,
      websocketEnabled: true,
      activeClients: realtimeService.getConnectedClientsCount(storeId),
      totalClients: realtimeService.getConnectedClientsCount(),
      timestamp: new Date().toISOString(),
    });
  });
}
