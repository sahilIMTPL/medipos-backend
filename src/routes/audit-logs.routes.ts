import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";

// Reusable helper to record an audit log entry from anywhere in the backend
export async function recordAuditLog(params: {
  storeId?: string;
  actorId?: string;
  action: string;
  entity: string;
  entityId?: string;
  details?: Record<string, any>;
  ipAddress?: string;
}) {
  try {
    let resolvedStoreId = params.storeId;
    if (!resolvedStoreId) {
      const store = await prisma.store.findFirst({ where: { isActive: true } });
      resolvedStoreId = store?.id;
    }

    let resolvedActorId = params.actorId;
    if (!resolvedActorId) {
      const user = await prisma.user.findFirst();
      resolvedActorId = user?.id;
    }

    return await prisma.auditLog.create({
      data: {
        storeId: resolvedStoreId,
        actorId: resolvedActorId,
        action: params.action,
        entity: params.entity,
        entityId: params.entityId,
        details: params.details || {},
        ipAddress: params.ipAddress || "127.0.0.1",
      },
    });
  } catch (err) {
    console.error("Failed to record audit log:", err);
  }
}

export async function auditLogsRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // GET /api/audit-logs
  server.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const { action, entity, search, from, to, page = "1", limit = "30" } = request.query as {
      action?: string;
      entity?: string;
      search?: string;
      from?: string;
      to?: string;
      page?: string;
      limit?: string;
    };

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
    const skip = (pageNum - 1) * limitNum;

    const store = await prisma.store.findFirst({ where: { isActive: true } });
    const whereClause: any = {};

    if (store) {
      whereClause.storeId = store.id;
    }

    if (action && action !== "ALL") {
      whereClause.action = action;
    }

    if (entity && entity !== "ALL") {
      whereClause.entity = entity;
    }

    if (from || to) {
      whereClause.createdAt = {};
      if (from) whereClause.createdAt.gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        whereClause.createdAt.lte = toDate;
      }
    }

    if (search && search.trim()) {
      whereClause.OR = [
        { action: { contains: search, mode: "insensitive" } },
        { entity: { contains: search, mode: "insensitive" } },
        { entityId: { contains: search, mode: "insensitive" } },
      ];
    }

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where: whereClause }),
      prisma.auditLog.findMany({
        where: whereClause,
        include: {
          actor: { select: { id: true, fullName: true, role: true, username: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limitNum,
      }),
    ]);

    return reply.send({
      success: true,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
      logs: logs.map((log) => ({
        id: log.id,
        action: log.action,
        entity: log.entity,
        entityId: log.entityId,
        details: log.details,
        ipAddress: log.ipAddress,
        createdAt: log.createdAt,
        actorName: log.actor?.fullName || log.actor?.username || "System",
        actorRole: log.actor?.role || "ADMIN",
      })),
    });
  });

  // POST /api/audit-logs (Record custom audit log event)
  server.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      action: string;
      entity: string;
      entityId?: string;
      details?: Record<string, any>;
      actorId?: string;
    };

    if (!body.action || !body.entity) {
      return reply.status(400).send({
        success: false,
        message: "Action and Entity are required",
      });
    }

    const log = await recordAuditLog({
      action: body.action,
      entity: body.entity,
      entityId: body.entityId,
      details: body.details,
      actorId: body.actorId,
      ipAddress: request.ip,
    });

    return reply.status(201).send({
      success: true,
      log,
    });
  });
}
