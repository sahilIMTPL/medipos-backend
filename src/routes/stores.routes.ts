import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { recordAuditLog } from "./audit-logs.routes";
import { resolveStoreTenant } from "../middleware/auth";

export async function storeRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // 1. List all active stores
  server.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const stores = await prisma.store.findMany({
      where: { isActive: true },
      include: {
        _count: {
          select: {
            products: true,
            batches: true,
            salesInvoices: true,
          },
        },
      },
      orderBy: { name: "asc" },
    });

    return reply.send({
      success: true,
      stores: stores.map((s) => ({
        id: s.id,
        name: s.name,
        code: s.code,
        city: s.city,
        state: s.state,
        phone: s.phone,
        gstin: s.gstin,
        drugLicenseNo: s.drugLicenseNo,
        productCount: s._count.products,
        batchCount: s._count.batches,
        salesCount: s._count.salesInvoices,
      })),
    });
  });

  // 2. Get current active store profile + settings
  server.get("/current", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId } = request.query as { storeId?: string };
    let targetStoreId: string;
    try {
      targetStoreId = await resolveStoreTenant(request, storeId);
    } catch {
      const fallback = await prisma.store.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: "asc" },
      });
      if (!fallback) return reply.status(404).send({ success: false, message: "No active store found" });
      targetStoreId = fallback.id;
    }

    const store = await prisma.store.findUnique({
      where: { id: targetStoreId },
      include: { settings: true },
    });

    if (!store) {
      return reply.status(404).send({ success: false, message: "No active store found" });
    }

    // Ensure store settings exist
    const settings = store.settings || await prisma.storeSetting.create({
      data: {
        storeId: store.id,
        invoicePrefix: "INV",
        thermalPrintWidth: 80,
        expiryAlertDays: 90,
        lowStockThreshold: 10,
        maxDiscountPercent: 20.0,
        defaultTaxRate: 12.0,
        enableLooseSale: true,
        requireDoctorInfo: false,
      },
    });

    return reply.send({
      success: true,
      store: {
        id: store.id,
        name: store.name,
        code: store.code,
        address: store.address || "",
        city: store.city || "",
        state: store.state || "",
        pincode: store.pincode || "",
        phone: store.phone || "",
        email: store.email || "",
        gstin: store.gstin || "",
        drugLicenseNo: store.drugLicenseNo || "",
        settings: {
          invoicePrefix: settings.invoicePrefix,
          thermalPrintWidth: settings.thermalPrintWidth,
          expiryAlertDays: settings.expiryAlertDays,
          lowStockThreshold: settings.lowStockThreshold,
          maxDiscountPercent: Number(settings.maxDiscountPercent),
          defaultTaxRate: Number(settings.defaultTaxRate),
          enableLooseSale: settings.enableLooseSale,
          requireDoctorInfo: settings.requireDoctorInfo,
          gstScheme: settings.gstScheme || "REGULAR",
          filingFrequency: settings.filingFrequency || "MONTHLY",
          stateCode: settings.stateCode || "24 - Gujarat",
          compositionTaxRate: Number(settings.compositionTaxRate || 1.0),
          isEInvoicingEligible: settings.isEInvoicingEligible || false,
          digilockerEnabled: settings.digilockerEnabled ?? true,
          digilockerClientId: settings.digilockerClientId || "",
          digilockerClientSecret: settings.digilockerClientSecret || "",
          digilockerOrgName: settings.digilockerOrgName || store.name,
          digilockerMode: settings.digilockerMode || "SANDBOX",
        },
      },
    });
  });

  // 3. Update store profile
  server.put("/current", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const requestedStoreId = body?.storeId || (request.query as any)?.storeId;
    let targetStoreId: string;
    try {
      targetStoreId = await resolveStoreTenant(request, requestedStoreId);
    } catch {
      const fallback = await prisma.store.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: "asc" },
      });
      if (!fallback) return reply.status(404).send({ success: false, message: "Store not found" });
      targetStoreId = fallback.id;
    }

    const store = await prisma.store.findUnique({ where: { id: targetStoreId } });
    if (!store) {
      return reply.status(404).send({ success: false, message: "Store not found" });
    }

    const updated = await prisma.store.update({
      where: { id: store.id },
      data: {
        name: body.name ?? store.name,
        phone: body.phone ?? store.phone,
        email: body.email ?? store.email,
        address: body.address ?? store.address,
        city: body.city ?? store.city,
        state: body.state ?? store.state,
        pincode: body.pincode ?? store.pincode,
        gstin: body.gstin ?? store.gstin,
        drugLicenseNo: body.drugLicenseNo ?? store.drugLicenseNo,
      },
      include: { settings: true },
    });

    await recordAuditLog({
      storeId: store.id,
      action: "UPDATE_STORE_PROFILE",
      entity: "Store",
      entityId: store.id,
      details: body,
      ipAddress: request.ip,
    });

    return reply.send({
      success: true,
      message: "Store profile updated successfully",
      store: updated,
    });
  });

  // 4. Update store operational settings
  server.put("/settings", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body || {}) as {
      storeId?: string;
      invoicePrefix?: string;
      thermalPrintWidth?: number;
      expiryAlertDays?: number;
      lowStockThreshold?: number;
      maxDiscountPercent?: number;
      defaultTaxRate?: number;
      enableLooseSale?: boolean;
      requireDoctorInfo?: boolean;
      gstScheme?: string;
      filingFrequency?: string;
      stateCode?: string;
      compositionTaxRate?: number;
      isEInvoicingEligible?: boolean;
      digilockerEnabled?: boolean;
      digilockerClientId?: string;
      digilockerClientSecret?: string;
      digilockerOrgName?: string;
      digilockerMode?: string;
    };
    const requestedStoreId = body?.storeId || (request.query as any)?.storeId;
    let targetStoreId: string;
    try {
      targetStoreId = await resolveStoreTenant(request, requestedStoreId);
    } catch {
      const fallback = await prisma.store.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: "asc" },
      });
      if (!fallback) return reply.status(404).send({ success: false, message: "Store not found" });
      targetStoreId = fallback.id;
    }

    const store = await prisma.store.findUnique({ where: { id: targetStoreId } });
    if (!store) {
      return reply.status(404).send({ success: false, message: "Store not found" });
    }

    const updated = await prisma.storeSetting.upsert({
      where: { storeId: store.id },
      create: {
        storeId: store.id,
        invoicePrefix: body.invoicePrefix || "INV",
        thermalPrintWidth: body.thermalPrintWidth || 80,
        expiryAlertDays: body.expiryAlertDays || 90,
        lowStockThreshold: body.lowStockThreshold || 10,
        maxDiscountPercent: body.maxDiscountPercent || 20.0,
        defaultTaxRate: body.defaultTaxRate || 5.0,
        enableLooseSale: body.enableLooseSale !== false,
        requireDoctorInfo: body.requireDoctorInfo || false,
        gstScheme: body.gstScheme || "REGULAR",
        filingFrequency: body.filingFrequency || "MONTHLY",
        stateCode: body.stateCode || "24 - Gujarat",
        compositionTaxRate: body.compositionTaxRate || 1.0,
        isEInvoicingEligible: body.isEInvoicingEligible || false,
        digilockerEnabled: body.digilockerEnabled ?? true,
        digilockerClientId: body.digilockerClientId,
        digilockerClientSecret: body.digilockerClientSecret,
        digilockerOrgName: body.digilockerOrgName || store.name,
        digilockerMode: body.digilockerMode || "SANDBOX",
      },
      update: {
        invoicePrefix: body.invoicePrefix,
        thermalPrintWidth: body.thermalPrintWidth,
        expiryAlertDays: body.expiryAlertDays,
        lowStockThreshold: body.lowStockThreshold,
        maxDiscountPercent: body.maxDiscountPercent,
        defaultTaxRate: body.defaultTaxRate,
        enableLooseSale: body.enableLooseSale,
        requireDoctorInfo: body.requireDoctorInfo,
        gstScheme: body.gstScheme,
        filingFrequency: body.filingFrequency,
        stateCode: body.stateCode,
        compositionTaxRate: body.compositionTaxRate,
        isEInvoicingEligible: body.isEInvoicingEligible,
        digilockerEnabled: body.digilockerEnabled,
        digilockerClientId: body.digilockerClientId,
        digilockerClientSecret: body.digilockerClientSecret,
        digilockerOrgName: body.digilockerOrgName,
        digilockerMode: body.digilockerMode,
      },
    });

    await recordAuditLog({
      storeId: store.id,
      action: "UPDATE_STORE_SETTINGS",
      entity: "StoreSetting",
      entityId: updated.id,
      details: body,
      ipAddress: request.ip,
    });

    return reply.send({
      success: true,
      message: "Store operational settings updated successfully",
      settings: updated,
    });
  });

  // 5. Complete Database Backup & Export
  server.get("/backup", async (request: FastifyRequest, reply: FastifyReply) => {
    const store = await prisma.store.findFirst({ where: { isActive: true } });
    if (!store) {
      return reply.status(404).send({ success: false, message: "Store not found" });
    }

    const [
      categories,
      units,
      products,
      batches,
      suppliers,
      customers,
      recentSales,
      recentPurchases,
      settings,
    ] = await Promise.all([
      prisma.category.findMany(),
      prisma.unit.findMany(),
      prisma.product.findMany({ where: { storeId: store.id } }),
      prisma.productBatch.findMany({ where: { storeId: store.id } }),
      prisma.supplier.findMany({ where: { storeId: store.id } }),
      prisma.customer.findMany({ where: { storeId: store.id } }),
      prisma.salesInvoice.findMany({ where: { storeId: store.id }, take: 100 }),
      prisma.purchaseInvoice.findMany({ where: { storeId: store.id }, take: 100 }),
      prisma.storeSetting.findUnique({ where: { storeId: store.id } }),
    ]);

    const backupData = {
      backupVersion: "1.0",
      timestamp: new Date().toISOString(),
      store: {
        id: store.id,
        name: store.name,
        code: store.code,
        gstin: store.gstin,
        drugLicenseNo: store.drugLicenseNo,
        settings,
      },
      counts: {
        categories: categories.length,
        units: units.length,
        products: products.length,
        batches: batches.length,
        suppliers: suppliers.length,
        customers: customers.length,
        salesInvoices: recentSales.length,
        purchaseInvoices: recentPurchases.length,
      },
      data: {
        categories,
        units,
        products,
        batches,
        suppliers,
        customers,
        recentSales,
        recentPurchases,
      },
    };

    await recordAuditLog({
      storeId: store.id,
      action: "BACKUP_EXPORT",
      entity: "Database",
      details: { timestamp: backupData.timestamp, counts: backupData.counts },
      ipAddress: request.ip,
    });

    return reply.send({
      success: true,
      backup: backupData,
    });
  });
}
