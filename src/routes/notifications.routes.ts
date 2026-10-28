import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { resolveStoreTenant } from "../middleware/auth";

// In-memory set of read notification keys for session and store timestamps
const readNotificationIds = new Set<string>();
const storeMarkAllReadTimestamps: Record<string, number> = {};
let globalMarkAllReadTimestamp: number = 0;

export async function notificationsRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  server.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId } = request.query as { storeId?: string };
    let targetStoreId: string;
    try {
      targetStoreId = await resolveStoreTenant(request, storeId);
    } catch {
      const fallback = await prisma.store.findFirst({ where: { isActive: true } });
      if (!fallback) return reply.send({ success: true, unreadCount: 0, notifications: [] });
      targetStoreId = fallback.id;
    }

    const store = await prisma.store.findUnique({ where: { id: targetStoreId } });
    if (!store) {
      return reply.send({ success: true, unreadCount: 0, notifications: [] });
    }

    const now = new Date();
    const d30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const d90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    // 1. Fetch batches expiring within 90 days or expired
    const nearExpiryBatches = await prisma.productBatch.findMany({
      where: {
        storeId: store.id,
        availableQty: { gt: 0 },
        expiryDate: { lte: d90 },
      },
      include: {
        product: { select: { id: true, name: true, genericName: true } },
      },
      orderBy: { expiryDate: "asc" },
      take: 50,
    });

    // 2. Fetch products with low or zero stock
    const productsWithBatches = await prisma.product.findMany({
      where: {
        storeId: store.id,
        isActive: true,
      },
      include: {
        batches: {
          where: { availableQty: { gt: 0 } },
          select: { availableQty: true },
        },
      },
      take: 100,
    });

    // 3. Fetch unbilled Doctor Prescriptions waiting in POS queue
    const pendingDoctorRxs = await prisma.prescription.findMany({
      where: {
        storeId: store.id,
        salesInvoices: { none: {} },
      },
      include: {
        customer: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    const notifications: Array<{
      id: string;
      title: string;
      description: string;
      severity: "CRITICAL" | "WARNING" | "INFO";
      type: "EXPIRY" | "LOW_STOCK" | "OUT_OF_STOCK" | "SYSTEM" | "DOCTOR_RX";
      link: string;
      createdAt: string;
      isRead: boolean;
    }> = [];

    const storeMarkedAt = (store?.id && storeMarkAllReadTimestamps[store.id]) || globalMarkAllReadTimestamp;

    // Process near expiry batches
    for (const b of nearExpiryBatches) {
      const expDate = new Date(b.expiryDate);
      const isExpired = expDate < now;
      const daysLeft = Math.ceil((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      const notifId = `exp-${b.id}`;
      const isRead = readNotificationIds.has(notifId) || (storeMarkedAt ? true : false);

      notifications.push({
        id: notifId,
        title: isExpired
          ? `Expired Batch: ${b.product.name}`
          : `Expiring Soon (${daysLeft}d): ${b.product.name}`,
        description: isExpired
          ? `Batch ${b.batchNumber} has expired (${b.expiryDate}). Available qty: ${b.availableQty}. Restrict sales immediately.`
          : `Batch ${b.batchNumber} expires on ${b.expiryDate}. Available qty: ${b.availableQty}. Prioritize under FEFO.`,
        severity: isExpired ? "CRITICAL" : daysLeft <= 30 ? "CRITICAL" : "WARNING",
        type: "EXPIRY",
        link: "/batches-expiry",
        createdAt: new Date().toISOString(),
        isRead,
      });
    }

    // Process low stock products
    for (const p of productsWithBatches) {
      const totalStock = p.batches.reduce((sum, b) => sum + Number(b.availableQty), 0);
      const notifId = `stock-${p.id}`;
      const isRead = readNotificationIds.has(notifId) || (storeMarkedAt ? true : false);

      if (totalStock <= 0) {
        notifications.push({
          id: notifId,
          title: `Out of Stock: ${p.name}`,
          description: `All batches depleted. Create a purchase order to restock ${p.name}.`,
          severity: "CRITICAL",
          type: "OUT_OF_STOCK",
          link: "/inventory",
          createdAt: new Date().toISOString(),
          isRead,
        });
      } else if (totalStock <= (p.reorderLevel || 10)) {
        notifications.push({
          id: notifId,
          title: `Low Stock: ${p.name}`,
          description: `Current stock (${totalStock}) is below reorder threshold (${p.reorderLevel}).`,
          severity: "WARNING",
          type: "LOW_STOCK",
          link: "/inventory",
          createdAt: new Date().toISOString(),
          isRead,
        });
      }
    }

    // Process pending doctor prescriptions waiting in POS
    for (const rx of pendingDoctorRxs) {
      const notifId = `rx-${rx.id}`;
      const isRead =
        readNotificationIds.has(notifId) ||
        (storeMarkedAt ? rx.createdAt.getTime() <= storeMarkedAt : false);

      notifications.push({
        id: notifId,
        title: `Doctor Rx: ${rx.doctorName}`,
        description: `Prescription for ${rx.customer?.name || "Patient"} waiting for POS dispensing.`,
        severity: "INFO",
        type: "DOCTOR_RX",
        link: "/pos",
        createdAt: rx.createdAt.toISOString(),
        isRead,
      });
    }

    // Sort by severity (CRITICAL first, then WARNING, then INFO)
    const severityOrder = { CRITICAL: 0, WARNING: 1, INFO: 2 };
    notifications.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    const unreadCount = notifications.filter((n) => !n.isRead).length;

    return reply.send({
      success: true,
      unreadCount,
      notifications,
    });
  });

  // Mark single, list or all notifications as read
  server.post("/mark-read", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const { id, markAll, ids, storeId } = body;

    let targetStoreId: string | null = null;
    try {
      targetStoreId = await resolveStoreTenant(request, storeId);
    } catch {
      targetStoreId = storeId || null;
    }

    if (Array.isArray(ids)) {
      ids.forEach((item: string) => {
        if (item && typeof item === "string") readNotificationIds.add(item);
      });
    }

    if (id && typeof id === "string") {
      readNotificationIds.add(id);
    }

    if (markAll) {
      if (targetStoreId) {
        storeMarkAllReadTimestamps[targetStoreId] = Date.now();
      }
      globalMarkAllReadTimestamp = Date.now();

      // Find all batches and products across target store or all stores
      const storeFilter = targetStoreId ? { storeId: targetStoreId } : {};
      const [batches, products] = await Promise.all([
        prisma.productBatch.findMany({
          where: storeFilter,
          select: { id: true },
        }),
        prisma.product.findMany({
          where: storeFilter,
          select: { id: true },
        }),
      ]);

      batches.forEach((b) => readNotificationIds.add(`exp-${b.id}`));
      products.forEach((p) => readNotificationIds.add(`stock-${p.id}`));
    }

    return reply.send({
      success: true,
      message: "Notifications marked as read",
    });
  });
}
