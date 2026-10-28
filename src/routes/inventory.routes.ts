import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { MovementType, BatchStatus } from "@prisma/client";
import { resolveStoreTenant } from "../middleware/auth";

export async function inventoryRoutes(server: FastifyInstance) {
  // 1. Inventory Overview & Valuation KPIs
  server.get("/overview", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { storeId?: string };

    let storeId: string;
    try {
      storeId = await resolveStoreTenant(request, query.storeId);
    } catch {
      const defaultStore = await prisma.store.findFirst();
      storeId = defaultStore?.id || "";
    }

    const batches = await prisma.productBatch.findMany({
      where: {
        storeId,
        status: { in: [BatchStatus.ACTIVE, BatchStatus.QUARANTINED] },
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            reorderLevel: true,
          },
        },
      },
    });

    let totalValuationCost = 0;
    let totalValuationMrp = 0;
    let totalBaseUnits = 0;
    const now = new Date();
    const ninetyDaysFuture = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    let nearExpiryCount = 0;
    let expiredCount = 0;

    for (const b of batches) {
      const qty = Number(b.availableQty);
      totalBaseUnits += qty;
      totalValuationCost += qty * Number(b.purchasePrice);
      totalValuationMrp += qty * Number(b.mrp);

      if (b.expiryDate < now) {
        expiredCount += 1;
      } else if (b.expiryDate <= ninetyDaysFuture) {
        nearExpiryCount += 1;
      }
    }

    const totalProducts = await prisma.product.count({ where: { storeId, isActive: true } });

    // Distinct low stock products
    const productStockMap = new Map<string, { stock: number; reorder: number }>();
    for (const b of batches) {
      const existing = productStockMap.get(b.productId) || { stock: 0, reorder: b.product.reorderLevel };
      existing.stock += Number(b.availableQty);
      productStockMap.set(b.productId, existing);
    }

    let lowStockCount = 0;
    productStockMap.forEach((val) => {
      if (val.stock <= val.reorder) lowStockCount += 1;
    });

    return reply.send({
      success: true,
      overview: {
        totalValuationCost: Number(totalValuationCost.toFixed(2)),
        totalValuationMrp: Number(totalValuationMrp.toFixed(2)),
        totalBaseUnits,
        totalProducts,
        totalBatches: batches.length,
        lowStockCount,
        nearExpiryCount,
        expiredCount,
      },
    });
  });

  // 2. Chronological Stock Movement Ledger
  server.get("/ledger", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as {
      storeId?: string;
      productId?: string;
      batchId?: string;
      movementType?: string;
      q?: string;
      startDate?: string;
      endDate?: string;
      page?: string;
      limit?: string;
    };

    let storeId: string;
    try {
      storeId = await resolveStoreTenant(request, query.storeId);
    } catch {
      const defaultStore = await prisma.store.findFirst();
      storeId = defaultStore?.id || "";
    }

    const page = Math.max(1, parseInt(query.page || "1", 10));
    const limit = Math.max(1, Math.min(100, parseInt(query.limit || "50", 10)));
    const skip = (page - 1) * limit;

    const whereClause: any = { storeId };

    if (query.productId) {
      whereClause.productId = query.productId;
    }

    if (query.batchId) {
      whereClause.batchId = query.batchId;
    }

    if (query.movementType && query.movementType !== "ALL") {
      whereClause.movementType = query.movementType as MovementType;
    }

    if (query.q) {
      const search = query.q.trim();
      whereClause.OR = [
        { product: { name: { contains: search, mode: "insensitive" } } },
        { product: { barcode: { contains: search } } },
        { batch: { batchNumber: { contains: search, mode: "insensitive" } } },
        { referenceId: { contains: search, mode: "insensitive" } },
        { reason: { contains: search, mode: "insensitive" } },
      ];
    }

    if (query.startDate || query.endDate) {
      whereClause.createdAt = {};
      if (query.startDate) whereClause.createdAt.gte = new Date(query.startDate);
      if (query.endDate) {
        const end = new Date(query.endDate);
        end.setHours(23, 59, 59, 999);
        whereClause.createdAt.lte = end;
      }
    }

    const [totalMovements, movements] = await Promise.all([
      prisma.stockMovement.count({ where: whereClause }),
      prisma.stockMovement.findMany({
        where: whereClause,
        include: {
          product: {
            select: {
              id: true,
              name: true,
              genericName: true,
              sku: true,
              packDescription: true,
            },
          },
          batch: {
            select: {
              id: true,
              batchNumber: true,
              expiryDate: true,
              availableQty: true,
            },
          },
          unit: { select: { id: true, name: true } },
          user: { select: { id: true, fullName: true, username: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    // Calculate Inflows vs Outflows for summary metrics
    const inflowTypes: MovementType[] = [MovementType.PURCHASE, MovementType.SALE_RETURN];

    return reply.send({
      success: true,
      total: totalMovements,
      page,
      limit,
      totalPages: Math.ceil(totalMovements / limit),
      movements: movements.map((m) => {
        const isInflow = inflowTypes.includes(m.movementType);
        const isOutflow = m.movementType === MovementType.SALE || m.movementType === MovementType.PURCHASE_RETURN || m.movementType === MovementType.EXPIRED_DISPOSAL;

        return {
          id: m.id,
          createdAt: m.createdAt.toISOString(),
          productId: m.productId,
          productName: m.product.name,
          genericName: m.product.genericName,
          sku: m.product.sku,
          batchNumber: m.batch?.batchNumber || "General",
          expiryDate: m.batch?.expiryDate.toISOString().split("T")[0] || null,
          movementType: m.movementType,
          isInflow,
          isOutflow,
          quantity: Number(m.quantity),
          baseQuantity: Number(m.baseQuantity),
          unitName: m.unit.name,
          currentBatchStock: Number(m.batch?.availableQty || 0),
          referenceType: m.referenceType || "N/A",
          referenceId: m.referenceId || "N/A",
          performedBy: m.user?.fullName || "Staff",
          reason: m.reason || "",
        };
      }),
    });
  });

  // 3. Physical Stock Count Worksheet for Reconciliation
  server.get("/reconciliation-worksheet", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { storeId?: string; categoryId?: string };

    let storeId: string;
    try {
      storeId = await resolveStoreTenant(request, query.storeId);
    } catch {
      const defaultStore = await prisma.store.findFirst();
      storeId = defaultStore?.id || "";
    }

    const whereClause: any = {
      storeId,
      status: BatchStatus.ACTIVE,
    };

    if (query.categoryId && query.categoryId !== "ALL") {
      whereClause.product = { categoryId: query.categoryId };
    }

    const batches = await prisma.productBatch.findMany({
      where: whereClause,
      include: {
        product: {
          include: {
            category: true,
            baseUnit: true,
            saleUnit: true,
            conversions: true,
          },
        },
      },
      orderBy: [{ product: { name: "asc" } }, { expiryDate: "asc" }],
    });

    return reply.send({
      success: true,
      totalBatches: batches.length,
      worksheet: batches.map((b) => {
        const factor =
          b.product.conversions && b.product.conversions.length > 0
            ? Number(b.product.conversions[0].conversionFactor)
            : 1;

        const systemQty = Number(b.availableQty);
        const systemPacks = factor > 0 ? Math.floor(systemQty / factor) : systemQty;

        return {
          batchId: b.id,
          productId: b.productId,
          productName: b.product.name,
          genericName: b.product.genericName || "",
          categoryName: b.product.category?.name || "Uncategorized",
          batchNumber: b.batchNumber,
          expiryDate: b.expiryDate.toISOString().split("T")[0],
          systemQty,
          systemPacks,
          factor,
          baseUnit: b.product.baseUnit.name,
          saleUnit: b.product.saleUnit.name,
          mrp: Number(b.mrp),
          purchasePrice: Number(b.purchasePrice),
        };
      }),
    });
  });

  // 4. Submit Stock Count & Execute Reconciliation
  server.post("/reconciliation", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      storeId?: string;
      notes?: string;
      items: Array<{
        batchId: string;
        countedQty: number; // in base units
        reason?: string;
      }>;
    };

    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      return reply.status(400).send({ success: false, message: "No batch counts provided for reconciliation." });
    }

    let storeId: string;
    try {
      storeId = await resolveStoreTenant(request, body.storeId);
    } catch {
      const defaultStore = await prisma.store.findFirst();
      storeId = defaultStore?.id || "";
    }

    const auditRef = `AUDIT-${new Date().getFullYear()}-${Date.now().toString().slice(-5)}`;
    let adjustedCount = 0;
    let totalSurplus = 0;
    let totalDeficit = 0;

    await prisma.$transaction(async (tx) => {
      for (const item of body.items) {
        const batch = await tx.productBatch.findUnique({
          where: { id: item.batchId },
          include: { product: { include: { baseUnit: true } } },
        });

        if (!batch) continue;

        const systemQty = Number(batch.availableQty);
        const countedQty = Math.max(0, Number(item.countedQty));
        const variance = countedQty - systemQty;

        if (variance !== 0) {
          adjustedCount += 1;
          if (variance > 0) totalSurplus += variance;
          else totalDeficit += Math.abs(variance);

          // Update batch availableQty to physical countedQty
          await tx.productBatch.update({
            where: { id: batch.id },
            data: { availableQty: countedQty },
          });

          // Record stock movement (ADJUSTMENT)
          const reasonText = item.reason || body.notes || "Physical stock count reconciliation";
          await tx.stockMovement.create({
            data: {
              storeId: batch.storeId,
              productId: batch.productId,
              batchId: batch.id,
              movementType: MovementType.ADJUSTMENT,
              quantity: Math.abs(variance),
              unitId: batch.product.baseUnitId,
              baseQuantity: Math.abs(variance),
              referenceType: "STOCK_RECONCILIATION",
              referenceId: auditRef,
              reason: `${variance > 0 ? "Surplus +" : "Deficit -"}${Math.abs(variance)} ${batch.product.baseUnit.name}(s) [System: ${systemQty} -> Counted: ${countedQty}]. ${reasonText}`,
            },
          });
        }
      }
    });

    return reply.send({
      success: true,
      message: `Stock reconciliation completed. Adjusted ${adjustedCount} batch(es).`,
      auditRef,
      adjustedCount,
      totalSurplus,
      totalDeficit,
    });
  });
}
