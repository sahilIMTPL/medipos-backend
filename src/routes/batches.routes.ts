import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { BatchStatus, MovementType } from "@prisma/client";
import { resolveStoreTenant } from "../middleware/auth";

export async function batchRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // 1. List Batches with live expiry status calculations
  server.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId, filter, status, q } = request.query as {
      storeId?: string;
      filter?: string; // ALL, EXPIRED, CRITICAL_30, NEAR_90, GOOD
      status?: string; // ACTIVE, EXPIRED, QUARANTINED
      q?: string;
    };

    let activeStoreId: string | null = null;
    try {
      activeStoreId = await resolveStoreTenant(request, storeId);
    } catch {
      activeStoreId = null;
    }

    const where: any = {};
    const now = new Date();

    if (activeStoreId) where.storeId = activeStoreId;
    if (status && status !== "ALL") {
      where.status = status as BatchStatus;
    }

    if (q) {
      where.OR = [
        { batchNumber: { contains: q, mode: "insensitive" } },
        { product: { name: { contains: q, mode: "insensitive" } } },
        { product: { genericName: { contains: q, mode: "insensitive" } } },
        { supplier: { businessName: { contains: q, mode: "insensitive" } } },
      ];
    }

    // Apply expiry date filters
    if (filter === "EXPIRED") {
      where.OR = [
        { expiryDate: { lte: now } },
        { status: BatchStatus.EXPIRED },
      ];
    } else if (filter === "CRITICAL_30") {
      const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      where.expiryDate = { gt: now, lte: in30Days };
      where.status = BatchStatus.ACTIVE;
    } else if (filter === "NEAR_90") {
      const in90Days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      where.expiryDate = { gt: now, lte: in90Days };
      where.status = BatchStatus.ACTIVE;
    } else if (filter === "GOOD") {
      const in90Days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      where.expiryDate = { gt: in90Days };
      where.status = BatchStatus.ACTIVE;
    }

    const batches = await prisma.productBatch.findMany({
      where,
      include: {
        product: {
          include: {
            category: true,
            baseUnit: true,
            saleUnit: true,
            conversions: true,
          },
        },
        supplier: {
          select: { id: true, businessName: true, phone: true },
        },
      },
      orderBy: { expiryDate: "asc" }, // FEFO ordering
      take: 100,
    });

    return reply.send({
      success: true,
      batches: batches.map((b) => {
        const exp = new Date(b.expiryDate);
        const diffMs = exp.getTime() - now.getTime();
        const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        let expiryCategory: "EXPIRED" | "CRITICAL" | "WARNING" | "HEALTHY" = "HEALTHY";
        if (daysRemaining <= 0 || b.status === BatchStatus.EXPIRED) {
          expiryCategory = "EXPIRED";
        } else if (daysRemaining <= 30) {
          expiryCategory = "CRITICAL";
        } else if (daysRemaining <= 90) {
          expiryCategory = "WARNING";
        }

        const conv = b.product.conversions.find((c) => c.fromUnitId === b.product.saleUnitId);
        const factor = conv ? Number(conv.conversionFactor) : 1;
        const availableBase = Number(b.availableQty);
        const availablePacks = factor > 0 ? Math.floor(availableBase / factor) : availableBase;

        return {
          id: b.id,
          batchNumber: b.batchNumber,
          productId: b.productId,
          productName: b.product.name,
          genericName: b.product.genericName || "",
          categoryName: b.product.category?.name || "Uncategorized",
          packDescription: b.product.packDescription || "Standard",
          baseUnit: b.product.baseUnit.name,
          saleUnit: b.product.saleUnit.name,
          conversionFactor: factor,
          mfgDate: b.mfgDate ? b.mfgDate.toISOString().split("T")[0] : null,
          expiryDate: b.expiryDate.toISOString().split("T")[0],
          daysRemaining,
          expiryCategory,
          purchasePrice: Number(b.purchasePrice),
          mrp: Number(b.mrp),
          receivedQty: Number(b.receivedQty),
          availableQty: availableBase,
          availablePacks,
          status: b.status,
          supplierId: b.supplierId,
          supplierName: b.supplier?.businessName || "Direct / Unknown",
        };
      }),
    });
  });

  // 2. Quarantine Batch (Prevent from selling in POS)
  server.put("/:id/quarantine", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const batch = await prisma.productBatch.findUnique({ where: { id } });
    if (!batch) {
      return reply.status(404).send({ success: false, message: "Batch not found" });
    }

    const newStatus =
      batch.status === BatchStatus.QUARANTINED ? BatchStatus.ACTIVE : BatchStatus.QUARANTINED;

    const updated = await prisma.productBatch.update({
      where: { id },
      data: { status: newStatus },
    });

    return reply.send({
      success: true,
      message: `Batch is now ${newStatus}`,
      batch: updated,
    });
  });

  // 3. Stock Adjustment on Batch with reason (Physical count correction, damaged stock, breakage)
  server.put("/:id/adjust", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { adjustedQty, reason } = request.body as {
      adjustedQty: number;
      reason: string;
    };

    if (adjustedQty === undefined || adjustedQty < 0) {
      return reply.status(400).send({ success: false, message: "Valid adjusted quantity is required." });
    }

    const batch = await prisma.productBatch.findUnique({
      where: { id },
      include: { product: true },
    });

    if (!batch) {
      return reply.status(404).send({ success: false, message: "Batch not found" });
    }

    const currentQty = Number(batch.availableQty);
    const diff = adjustedQty - currentQty;

    const updated = await prisma.$transaction(async (tx) => {
      const updatedBatch = await tx.productBatch.update({
        where: { id },
        data: { availableQty: adjustedQty },
      });

      // Record Stock Movement
      await tx.stockMovement.create({
        data: {
          storeId: batch.storeId,
          productId: batch.productId,
          batchId: batch.id,
          movementType: MovementType.ADJUSTMENT,
          quantity: Math.abs(diff),
          unitId: batch.product.baseUnitId,
          baseQuantity: Math.abs(diff),
          referenceType: "MANUAL_ADJUSTMENT",
          referenceId: batch.id,
          reason: reason || (diff > 0 ? "Positive count adjustment" : "Damaged / expired adjustment"),
        },
      });

      return updatedBatch;
    });

    return reply.send({ success: true, message: "Batch stock adjusted successfully", batch: updated });
  });
}
