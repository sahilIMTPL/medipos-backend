import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { resolveStoreTenant } from "../middleware/auth";

export async function reportsRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // Helper to get active store for current tenant session
  const getStore = async (request: FastifyRequest, explicitStoreId?: string) => {
    const storeId = await resolveStoreTenant(request, explicitStoreId);
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) throw new Error("No active store found");
    return store;
  };

  // 1. Sales Report
  server.get("/sales", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId, from, to, paymentMethod } = request.query as {
      storeId?: string;
      from?: string;
      to?: string;
      paymentMethod?: string;
    };

    const store = await getStore(request, storeId);
    const whereClause: any = {
      storeId: store.id,
      status: "COMPLETED",
    };

    if (from || to) {
      whereClause.createdAt = {};
      if (from) whereClause.createdAt.gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        whereClause.createdAt.lte = toDate;
      }
    }

    const invoices = await prisma.salesInvoice.findMany({
      where: whereClause,
      include: {
        customer: true,
        prescription: true,
        createdBy: { select: { fullName: true } },
        payments: true,
        items: {
          include: {
            product: { select: { name: true, genericName: true, sku: true } },
            batch: { select: { batchNumber: true } },
            saleUnit: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Filter by payment method if specified
    const filteredInvoices = paymentMethod && paymentMethod !== "ALL"
      ? invoices.filter((inv) => inv.payments.some((p) => p.paymentMethod === paymentMethod))
      : invoices;

    let totalGross = 0;
    let totalDiscount = 0;
    let totalTax = 0;
    let totalNet = 0;
    const paymentBreakdown: Record<string, number> = { CASH: 0, UPI: 0, CARD: 0, SPLIT: 0, CREDIT: 0 };
    const productSalesMap = new Map<string, { name: string; quantity: number; revenue: number }>();

    for (const inv of filteredInvoices) {
      totalGross += Number(inv.subtotal);
      totalDiscount += Number(inv.discountTotal);
      totalTax += Number(inv.taxTotal);
      totalNet += Number(inv.grandTotal);

      for (const p of inv.payments) {
        paymentBreakdown[p.paymentMethod] = (paymentBreakdown[p.paymentMethod] || 0) + Number(p.amount);
      }

      for (const item of inv.items) {
        const existing = productSalesMap.get(item.productId) || {
          name: item.product.name,
          quantity: 0,
          revenue: 0,
        };
        existing.quantity += Number(item.quantity);
        existing.revenue += Number(item.totalAmount);
        productSalesMap.set(item.productId, existing);
      }
    }

    const topSellingProducts = Array.from(productSalesMap.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    return reply.send({
      success: true,
      summary: {
        invoiceCount: filteredInvoices.length,
        totalGross: Number(totalGross.toFixed(2)),
        totalDiscount: Number(totalDiscount.toFixed(2)),
        totalTax: Number(totalTax.toFixed(2)),
        totalNet: Number(totalNet.toFixed(2)),
        paymentBreakdown,
      },
      topSellingProducts,
      invoices: filteredInvoices.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        date: inv.createdAt,
        customerName: inv.customer?.name || "Walk-in Customer",
        customerPhone: inv.customer?.phone || null,
        doctorName: inv.prescription?.doctorName || null,
        itemCount: inv.items.length,
        subtotal: Number(inv.subtotal),
        discount: Number(inv.discountTotal),
        tax: Number(inv.taxTotal),
        grandTotal: Number(inv.grandTotal),
        paymentMethod: inv.payments[0]?.paymentMethod || "CASH",
        cashier: inv.createdBy?.fullName || "Admin",
      })),
    });
  });

  // 2. Purchase Report
  server.get("/purchases", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId, from, to, supplierId } = request.query as {
      storeId?: string;
      from?: string;
      to?: string;
      supplierId?: string;
    };

    const store = await getStore(request, storeId);
    const whereClause: any = {
      storeId: store.id,
    };

    if (supplierId && supplierId !== "ALL") {
      whereClause.supplierId = supplierId;
    }

    if (from || to) {
      whereClause.invoiceDate = {};
      if (from) whereClause.invoiceDate.gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        whereClause.invoiceDate.lte = toDate;
      }
    }

    const purchases = await prisma.purchaseInvoice.findMany({
      where: whereClause,
      include: {
        supplier: true,
        createdBy: { select: { fullName: true } },
        items: {
          include: {
            product: { select: { name: true } },
            batch: { select: { batchNumber: true, expiryDate: true } },
            unit: { select: { name: true } },
          },
        },
      },
      orderBy: { invoiceDate: "desc" },
    });

    let totalAmount = 0;
    let totalTax = 0;
    let totalDiscount = 0;
    const supplierSpendMap = new Map<string, { supplierName: string; count: number; spend: number }>();

    for (const p of purchases) {
      totalAmount += Number(p.totalAmount);
      totalTax += Number(p.taxTotal);
      totalDiscount += Number(p.discountTotal);

      const sName = p.supplier?.businessName || "Unknown Supplier";
      const existing = supplierSpendMap.get(p.supplierId) || { supplierName: sName, count: 0, spend: 0 };
      existing.count += 1;
      existing.spend += Number(p.totalAmount);
      supplierSpendMap.set(p.supplierId, existing);
    }

    return reply.send({
      success: true,
      summary: {
        purchaseCount: purchases.length,
        totalAmount: Number(totalAmount.toFixed(2)),
        totalTax: Number(totalTax.toFixed(2)),
        totalDiscount: Number(totalDiscount.toFixed(2)),
        supplierSpend: Array.from(supplierSpendMap.values()).sort((a, b) => b.spend - a.spend),
      },
      purchases: purchases.map((p) => ({
        id: p.id,
        invoiceNumber: p.invoiceNumber,
        invoiceDate: p.invoiceDate,
        supplierName: p.supplier?.businessName || "Unknown",
        supplierGstin: p.supplier?.gstin || null,
        itemCount: p.items.length,
        subtotal: Number(p.subtotal),
        tax: Number(p.taxTotal),
        grandTotal: Number(p.totalAmount),
        paymentStatus: p.paymentStatus,
      })),
    });
  });

  // 3. Real-time Inventory Valuation Report
  server.get("/inventory-valuation", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId } = request.query as { storeId?: string };
    const store = await getStore(request, storeId);

    const batches = await prisma.productBatch.findMany({
      where: {
        storeId: store.id,
        availableQty: { gt: 0 },
      },
      include: {
        product: {
          include: {
            category: true,
            baseUnit: true,
            saleUnit: true,
          },
        },
      },
      orderBy: { expiryDate: "asc" },
    });

    let totalCostValuation = 0;
    let totalRetailValuation = 0;
    const categoryValuationMap = new Map<string, { categoryName: string; stockCount: number; costVal: number; retailVal: number }>();

    for (const b of batches) {
      const qty = Number(b.availableQty);
      const cost = qty * Number(b.purchasePrice);
      const retail = qty * Number(b.mrp);

      totalCostValuation += cost;
      totalRetailValuation += retail;

      const catName = b.product.category?.name || "General Medicines";
      const catId = b.product.categoryId || "uncategorized";
      const existing = categoryValuationMap.get(catId) || {
        categoryName: catName,
        stockCount: 0,
        costVal: 0,
        retailVal: 0,
      };
      existing.stockCount += qty;
      existing.costVal += cost;
      existing.retailVal += retail;
      categoryValuationMap.set(catId, existing);
    }

    const potentialGrossProfit = totalRetailValuation - totalCostValuation;
    const marginPercentage = totalRetailValuation > 0 ? (potentialGrossProfit / totalRetailValuation) * 100 : 0;

    return reply.send({
      success: true,
      summary: {
        totalBatches: batches.length,
        costValuation: Number(totalCostValuation.toFixed(2)),
        retailValuation: Number(totalRetailValuation.toFixed(2)),
        potentialGrossProfit: Number(potentialGrossProfit.toFixed(2)),
        marginPercentage: Number(marginPercentage.toFixed(1)),
        categoryBreakdown: Array.from(categoryValuationMap.values()).sort((a, b) => b.costVal - a.costVal),
      },
      batches: batches.map((b) => ({
        id: b.id,
        batchNumber: b.batchNumber,
        productName: b.product.name,
        genericName: b.product.genericName,
        category: b.product.category?.name || "General",
        expiryDate: b.expiryDate,
        availableQty: Number(b.availableQty),
        unit: b.product.baseUnit.name,
        purchasePrice: Number(b.purchasePrice),
        mrp: Number(b.mrp),
        costTotal: Number((Number(b.availableQty) * Number(b.purchasePrice)).toFixed(2)),
        retailTotal: Number((Number(b.availableQty) * Number(b.mrp)).toFixed(2)),
      })),
    });
  });

  // 4. FEFO Expiry Aging Schedule
  server.get("/expiry-schedule", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId } = request.query as { storeId?: string };
    const store = await getStore(request, storeId);
    const now = new Date();
    const d30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const d60 = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
    const d90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const batches = await prisma.productBatch.findMany({
      where: {
        storeId: store.id,
        availableQty: { gt: 0 },
      },
      include: {
        product: {
          include: {
            baseUnit: true,
            saleUnit: true,
          },
        },
      },
      orderBy: { expiryDate: "asc" },
    });

    const expired: any[] = [];
    const expiring30: any[] = [];
    const expiring60: any[] = [];
    const expiring90: any[] = [];

    let expiredRiskValue = 0;
    let riskValue30 = 0;
    let riskValue60 = 0;
    let riskValue90 = 0;

    for (const b of batches) {
      const exp = new Date(b.expiryDate);
      const qty = Number(b.availableQty);
      const costVal = qty * Number(b.purchasePrice);
      const itemData = {
        id: b.id,
        batchNumber: b.batchNumber,
        productName: b.product.name,
        genericName: b.product.genericName,
        expiryDate: b.expiryDate,
        availableQty: qty,
        unit: b.product.baseUnit.name,
        purchasePrice: Number(b.purchasePrice),
        mrp: Number(b.mrp),
        costVal: Number(costVal.toFixed(2)),
        daysLeft: Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
      };

      if (exp < now) {
        expired.push(itemData);
        expiredRiskValue += costVal;
      } else if (exp <= d30) {
        expiring30.push(itemData);
        riskValue30 += costVal;
      } else if (exp <= d60) {
        expiring60.push(itemData);
        riskValue60 += costVal;
      } else if (exp <= d90) {
        expiring90.push(itemData);
        riskValue90 += costVal;
      }
    }

    return reply.send({
      success: true,
      summary: {
        expiredCount: expired.length,
        expiredRiskValue: Number(expiredRiskValue.toFixed(2)),
        expiring30Count: expiring30.length,
        riskValue30: Number(riskValue30.toFixed(2)),
        expiring60Count: expiring60.length,
        riskValue60: Number(riskValue60.toFixed(2)),
        expiring90Count: expiring90.length,
        riskValue90: Number(riskValue90.toFixed(2)),
        totalRiskValue: Number((expiredRiskValue + riskValue30 + riskValue60 + riskValue90).toFixed(2)),
      },
      expired,
      expiring30,
      expiring60,
      expiring90,
    });
  });

  // 5. Profit & Loss Report
  server.get("/profit-loss", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId, from, to } = request.query as { storeId?: string; from?: string; to?: string };
    const store = await getStore(request, storeId);

    const whereClause: any = {
      storeId: store.id,
      status: "COMPLETED",
    };

    if (from || to) {
      whereClause.createdAt = {};
      if (from) whereClause.createdAt.gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        whereClause.createdAt.lte = toDate;
      }
    }

    const invoices = await prisma.salesInvoice.findMany({
      where: whereClause,
      include: {
        items: {
          include: {
            batch: true,
          },
        },
      },
    });

    let grossRevenue = 0;
    let totalDiscount = 0;
    let totalTaxCollected = 0;
    let costOfGoodsSold = 0;

    for (const inv of invoices) {
      grossRevenue += Number(inv.subtotal);
      totalDiscount += Number(inv.discountTotal);
      totalTaxCollected += Number(inv.taxTotal);

      for (const it of inv.items) {
        const baseQty = Number(it.baseQuantity || it.quantity);
        const purchasePrice = Number(it.batch?.purchasePrice || 0);
        costOfGoodsSold += baseQty * purchasePrice;
      }
    }

    const netRevenue = grossRevenue - totalDiscount;
    const grossProfit = netRevenue - costOfGoodsSold;
    const grossMarginPercent = netRevenue > 0 ? (grossProfit / netRevenue) * 100 : 0;

    return reply.send({
      success: true,
      report: {
        period: { from: from || "All Time", to: to || "Current" },
        invoiceCount: invoices.length,
        grossRevenue: Number(grossRevenue.toFixed(2)),
        totalDiscount: Number(totalDiscount.toFixed(2)),
        netRevenue: Number(netRevenue.toFixed(2)),
        costOfGoodsSold: Number(costOfGoodsSold.toFixed(2)),
        totalTaxCollected: Number(totalTaxCollected.toFixed(2)),
        grossProfit: Number(grossProfit.toFixed(2)),
        grossMarginPercent: Number(grossMarginPercent.toFixed(1)),
      },
    });
  });

  // 6. GST Tax Reconciliation
  server.get("/gst", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId, from, to } = request.query as { storeId?: string; from?: string; to?: string };
    const store = await getStore(request, storeId);

    const salesWhere: any = { storeId: store.id, status: "COMPLETED" };
    const purchaseWhere: any = { storeId: store.id };

    if (from || to) {
      salesWhere.createdAt = {};
      purchaseWhere.invoiceDate = {};
      if (from) {
        salesWhere.createdAt.gte = new Date(from);
        purchaseWhere.invoiceDate.gte = new Date(from);
      }
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        salesWhere.createdAt.lte = toDate;
        purchaseWhere.invoiceDate.lte = toDate;
      }
    }

    const [salesItems, purchaseInvoices] = await Promise.all([
      prisma.salesItem.findMany({
        where: { salesInvoice: salesWhere },
        select: {
          gstRate: true,
          subtotal: true,
          gstAmount: true,
          totalAmount: true,
        },
      }),
      prisma.purchaseInvoice.findMany({
        where: purchaseWhere,
        select: {
          subtotal: true,
          taxTotal: true,
          totalAmount: true,
        },
      }),
    ]);

    // Group sales GST by tax slabs
    const taxSlabs: Record<string, { taxableAmount: number; cgst: number; sgst: number; totalTax: number }> = {
      "0": { taxableAmount: 0, cgst: 0, sgst: 0, totalTax: 0 },
      "5": { taxableAmount: 0, cgst: 0, sgst: 0, totalTax: 0 },
      "12": { taxableAmount: 0, cgst: 0, sgst: 0, totalTax: 0 },
      "18": { taxableAmount: 0, cgst: 0, sgst: 0, totalTax: 0 },
      "28": { taxableAmount: 0, cgst: 0, sgst: 0, totalTax: 0 },
    };

    let totalOutputGst = 0;
    let totalTaxableSales = 0;

    for (const item of salesItems) {
      const rate = Math.round(Number(item.gstRate)).toString();
      const taxable = Number(item.subtotal);
      const tax = Number(item.gstAmount);

      totalTaxableSales += taxable;
      totalOutputGst += tax;

      if (!taxSlabs[rate]) {
        taxSlabs[rate] = { taxableAmount: 0, cgst: 0, sgst: 0, totalTax: 0 };
      }

      taxSlabs[rate].taxableAmount += taxable;
      taxSlabs[rate].cgst += tax / 2;
      taxSlabs[rate].sgst += tax / 2;
      taxSlabs[rate].totalTax += tax;
    }

    let totalInputGst = 0;
    let totalTaxablePurchases = 0;
    for (const pur of purchaseInvoices) {
      totalTaxablePurchases += Number(pur.subtotal);
      totalInputGst += Number(pur.taxTotal);
    }

    const netGstPayable = totalOutputGst - totalInputGst;

    return reply.send({
      success: true,
      summary: {
        totalTaxableSales: Number(totalTaxableSales.toFixed(2)),
        totalOutputGst: Number(totalOutputGst.toFixed(2)),
        totalTaxablePurchases: Number(totalTaxablePurchases.toFixed(2)),
        totalInputGst: Number(totalInputGst.toFixed(2)),
        netGstPayable: Number(netGstPayable.toFixed(2)),
      },
      taxSlabs,
    });
  });
}
