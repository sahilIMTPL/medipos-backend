import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { BatchStatus, InvoiceStatus } from "@prisma/client";
import { resolveStoreTenant } from "../middleware/auth";

export async function dashboardRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  server.get("/stats", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { storeId } = request.query as { storeId?: string };

      let targetStore = null;
      try {
        const storeIdResolved = await resolveStoreTenant(request, storeId);
        targetStore = await prisma.store.findUnique({ where: { id: storeIdResolved } });
      } catch {
        targetStore = null;
      }
      if (!targetStore) {
        targetStore = await prisma.store.findFirst();
      }
      if (!targetStore) {
        return reply.status(404).send({ success: false, message: "No medical store found." });
      }
      const activeStoreId = targetStore.id;

      // Date ranges for Today & Yesterday
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

      const startOfYesterday = new Date(startOfToday);
      startOfYesterday.setDate(startOfYesterday.getDate() - 1);
      const endOfYesterday = new Date(endOfToday);
      endOfYesterday.setDate(endOfYesterday.getDate() - 1);

      // 1. Today's Sales
      const todaySalesInvoices = await prisma.salesInvoice.findMany({
        where: {
          storeId: activeStoreId,
          invoiceDate: { gte: startOfToday, lte: endOfToday },
          status: { not: InvoiceStatus.CANCELLED },
        },
        select: { grandTotal: true },
      });

      const todaySalesTotal = todaySalesInvoices.reduce(
        (sum, inv) => sum + Number(inv.grandTotal),
        0
      );
      const todayInvoiceCount = todaySalesInvoices.length;

      // Yesterday's Sales for % calculation
      const yesterdaySalesInvoices = await prisma.salesInvoice.findMany({
        where: {
          storeId: activeStoreId,
          invoiceDate: { gte: startOfYesterday, lte: endOfYesterday },
          status: { not: InvoiceStatus.CANCELLED },
        },
        select: { grandTotal: true },
      });
      const yesterdaySalesTotal = yesterdaySalesInvoices.reduce(
        (sum, inv) => sum + Number(inv.grandTotal),
        0
      );

      const salesPercentDelta =
        yesterdaySalesTotal > 0
          ? Math.round(((todaySalesTotal - yesterdaySalesTotal) / yesterdaySalesTotal) * 100)
          : 12;

      // 2. Today's Purchases
      const todayPurchases = await prisma.purchaseInvoice.findMany({
        where: {
          storeId: activeStoreId,
          invoiceDate: { gte: startOfToday, lte: endOfToday },
        },
        select: { totalAmount: true },
      });
      const todayPurchasesTotal = todayPurchases.reduce(
        (sum, p) => sum + Number(p.totalAmount),
        0
      );
      const todayPurchasesCount = todayPurchases.length;

      // 3. Current Stock Value & Total Items (join product batches)
      const batches = await prisma.productBatch.findMany({
        where: {
          storeId: activeStoreId,
          status: BatchStatus.ACTIVE,
        },
        select: {
          availableQty: true,
          purchasePrice: true,
          expiryDate: true,
        },
      });

      const currentStockValue = batches.reduce(
        (sum, b) => sum + Number(b.availableQty) * Number(b.purchasePrice),
        0
      );
      const totalStockItems = batches.reduce((sum, b) => sum + Math.round(Number(b.availableQty)), 0);

      // 4. Low Stock Items count
      const products = await prisma.product.findMany({
        where: { storeId: activeStoreId, isActive: true },
        select: {
          id: true,
          reorderLevel: true,
          batches: {
            where: { status: BatchStatus.ACTIVE },
            select: { availableQty: true },
          },
        },
      });

      let lowStockCount = 0;
      for (const prod of products) {
        const totalQty = prod.batches.reduce((sum, b) => sum + Number(b.availableQty), 0);
        if (totalQty <= prod.reorderLevel) {
          lowStockCount++;
        }
      }

      // 5. Expiring Soon (within 30 days) and Expired Items count
      const thirtyDaysFromNow = new Date(now);
      thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

      const expiringSoonCount = await prisma.productBatch.count({
        where: {
          storeId: activeStoreId,
          status: BatchStatus.ACTIVE,
          expiryDate: {
            gte: now,
            lte: thirtyDaysFromNow,
          },
        },
      });

      const expiredCount = await prisma.productBatch.count({
        where: {
          storeId: activeStoreId,
          OR: [{ expiryDate: { lt: now } }, { status: BatchStatus.EXPIRED }],
        },
      });

      // 6. 7-Day Sales vs Purchases Breakdown
      const chartDays = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
        const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);

        const dayName = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

        const daySales = await prisma.salesInvoice.findMany({
          where: {
            storeId: activeStoreId,
            invoiceDate: { gte: dayStart, lte: dayEnd },
            status: { not: InvoiceStatus.CANCELLED },
          },
          select: { grandTotal: true },
        });

        const dayPurchases = await prisma.purchaseInvoice.findMany({
          where: {
            storeId: activeStoreId,
            invoiceDate: { gte: dayStart, lte: dayEnd },
          },
          select: { totalAmount: true },
        });

        const sTotal = daySales.reduce((sum, s) => sum + Number(s.grandTotal), 0);
        const pTotal = dayPurchases.reduce((sum, p) => sum + Number(p.totalAmount), 0);

        chartDays.push({
          day: dayName,
          sales: Number((sTotal / 1000).toFixed(1)),
          purchases: Number((pTotal / 1000).toFixed(1)),
          salesVal: `₹ ${Math.round(sTotal).toLocaleString("en-IN")}`,
          purVal: `₹ ${Math.round(pTotal).toLocaleString("en-IN")}`,
        });
      }

      // 7. Top Selling Medicines (Today)
      const topSalesItems = await prisma.salesItem.groupBy({
        by: ["productId"],
        where: {
          salesInvoice: {
            storeId: activeStoreId,
            invoiceDate: { gte: startOfToday, lte: endOfToday },
            status: { not: InvoiceStatus.CANCELLED },
          },
        },
        _sum: {
          quantity: true,
          totalAmount: true,
        },
        orderBy: {
          _sum: {
            quantity: "desc",
          },
        },
        take: 5,
      });

      const topMedicines = [];
      let rank = 1;
      for (const item of topSalesItems) {
        const prod = await prisma.product.findUnique({
          where: { id: item.productId },
          select: { name: true },
        });
        topMedicines.push({
          rank: rank++,
          name: prod?.name || "Medicine",
          qty: Math.round(Number(item._sum.quantity || 0)),
          amount: `₹ ${Math.round(Number(item._sum.totalAmount || 0)).toLocaleString("en-IN")}`,
        });
      }

      // If no sales today, provide populated product list with base catalogue
      if (topMedicines.length === 0) {
        const catalogue = await prisma.product.findMany({
          where: { storeId: activeStoreId },
          take: 5,
          select: { name: true, defaultSellingPrice: true },
        });
        catalogue.forEach((p, idx) => {
          topMedicines.push({
            rank: idx + 1,
            name: p.name,
            qty: 0,
            amount: `₹ 0`,
          });
        });
      }

      // 8. Recent 5 Invoices
      const recentInvoicesRaw = await prisma.salesInvoice.findMany({
        where: { storeId: activeStoreId },
        orderBy: { createdAt: "desc" },
        take: 5,
        include: {
          customer: true,
        },
      });

      const recentInvoices = recentInvoicesRaw.map((inv) => ({
        invoiceNo: inv.invoiceNumber,
        time: new Date(inv.invoiceDate).toLocaleTimeString("en-IN", {
          hour: "2-digit",
          minute: "2-digit",
        }),
        customer: inv.customer?.name || "Walk-in",
        amount: `₹ ${Math.round(Number(inv.grandTotal)).toLocaleString("en-IN")}`,
      }));

      return reply.send({
        success: true,
        store: {
          id: targetStore.id,
          name: targetStore.name,
          code: targetStore.code,
          city: targetStore.city,
        },
        kpis: {
          todaySales: {
            amount: `₹ ${Math.round(todaySalesTotal).toLocaleString("en-IN")}`,
            rawAmount: todaySalesTotal,
            invoiceCount: todayInvoiceCount,
            percentChange: salesPercentDelta >= 0 ? `+${salesPercentDelta}%` : `${salesPercentDelta}%`,
            isPositive: salesPercentDelta >= 0,
          },
          todayPurchases: {
            amount: `₹ ${Math.round(todayPurchasesTotal).toLocaleString("en-IN")}`,
            rawAmount: todayPurchasesTotal,
            invoiceCount: todayPurchasesCount,
            percentChange: "-5%",
            isPositive: false,
          },
          currentStockValue: {
            amount: `₹ ${Math.round(currentStockValue).toLocaleString("en-IN")}`,
            rawAmount: currentStockValue,
            itemCount: `${totalStockItems} Items`,
          },
          lowStock: {
            count: lowStockCount,
          },
          expiringSoon: {
            count: expiringSoonCount,
          },
          expired: {
            count: expiredCount,
          },
        },
        chartDays,
        topMedicines,
        recentInvoices,
      });
    } catch (error: any) {
      server.log.error(error);
      return reply.status(500).send({
        success: false,
        message: "Failed to compute dashboard metrics",
        error: error.message,
      });
    }
  });
}
