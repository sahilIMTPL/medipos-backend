import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { BatchStatus, MovementType, PaymentMethod, PaymentStatus } from "@prisma/client";
import { recordAuditLog } from "./audit-logs.routes";
import { resolveStoreTenant } from "../middleware/auth";
import { postPurchaseInvoiceJournalEntry } from "../services/accounting.service";

export async function purchaseRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // 1. List Purchases with search and filters
  server.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId, supplierId, paymentStatus, q, limit } = request.query as {
      storeId?: string;
      supplierId?: string;
      paymentStatus?: string;
      q?: string;
      limit?: string;
    };

    let activeStoreId: string | null = null;
    try {
      activeStoreId = await resolveStoreTenant(request, storeId);
    } catch {
      activeStoreId = null;
    }

    const where: any = {};

    if (activeStoreId) where.storeId = activeStoreId;
    if (supplierId && supplierId !== "ALL") where.supplierId = supplierId;
    if (paymentStatus && paymentStatus !== "ALL") {
      where.paymentStatus = paymentStatus as PaymentStatus;
    }

    if (q) {
      where.OR = [
        { invoiceNumber: { contains: q, mode: "insensitive" } },
        { supplierInvoiceNumber: { contains: q, mode: "insensitive" } },
        { supplier: { businessName: { contains: q, mode: "insensitive" } } },
      ];
    }

    const purchases = await prisma.purchaseInvoice.findMany({
      where,
      include: {
        supplier: {
          select: {
            id: true,
            businessName: true,
            phone: true,
            gstin: true,
          },
        },
        payments: {
          select: {
            id: true,
            amount: true,
            paymentMethod: true,
            paymentDate: true,
            referenceNumber: true,
          },
          orderBy: { paymentDate: "desc" },
        },
        _count: {
          select: { items: true },
        },
      },
      orderBy: { invoiceDate: "desc" },
      take: limit ? Number(limit) : 50,
    });

    return reply.send({
      success: true,
      purchases: purchases.map((p) => ({
        id: p.id,
        invoiceNumber: p.invoiceNumber,
        supplierInvoiceNumber: p.supplierInvoiceNumber,
        supplierId: p.supplierId,
        supplierName: p.supplier.businessName,
        supplierPhone: p.supplier.phone || "",
        supplierGstin: p.supplier.gstin || "",
        invoiceDate: p.invoiceDate.toISOString().split("T")[0],
        subtotal: Number(p.subtotal),
        discountTotal: Number(p.discountTotal),
        taxTotal: Number(p.taxTotal),
        totalAmount: Number(p.totalAmount),
        paidAmount: Number(p.paidAmount),
        balanceDue: Number(p.totalAmount) - Number(p.paidAmount),
        paymentStatus: p.paymentStatus,
        status: p.status,
        itemCount: p._count.items,
        payments: p.payments.map((pm) => ({
          id: pm.id,
          voucherNumber: `VCH-${pm.id.slice(0, 8).toUpperCase()}`,
          receiptNumber: `VCH-${pm.id.slice(0, 8).toUpperCase()}`,
          date: pm.paymentDate.toISOString().split("T")[0],
          amount: Number(pm.amount),
          paymentMethod: pm.paymentMethod,
          ref: pm.referenceNumber || "",
          referenceNumber: pm.referenceNumber || "",
        })),
      })),
    });
  });

  // 2. Get Single Purchase Details with all line items and batches
  server.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const purchase = await prisma.purchaseInvoice.findUnique({
      where: { id },
      include: {
        store: true,
        supplier: true,
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                genericName: true,
                packDescription: true,
                sku: true,
                baseUnit: { select: { name: true } },
              },
            },
            unit: true,
          },
        },
        payments: {
          orderBy: { paymentDate: "desc" },
        },
      },
    });

    if (!purchase) {
      return reply.status(404).send({ success: false, message: "Purchase invoice not found" });
    }

    return reply.send({
      success: true,
      purchase: {
        id: purchase.id,
        invoiceNumber: purchase.invoiceNumber,
        supplierInvoiceNumber: purchase.supplierInvoiceNumber,
        invoiceDate: purchase.invoiceDate.toISOString().split("T")[0],
        receivedDate: purchase.receivedDate.toISOString().split("T")[0],
        supplierId: purchase.supplierId,
        supplierName: purchase.supplier.businessName,
        subtotal: Number(purchase.subtotal),
        discountTotal: Number(purchase.discountTotal),
        taxTotal: Number(purchase.taxTotal),
        totalAmount: Number(purchase.totalAmount),
        paidAmount: Number(purchase.paidAmount),
        balanceDue: Number(purchase.totalAmount) - Number(purchase.paidAmount),
        paymentStatus: purchase.paymentStatus,
        status: purchase.status,
        store: purchase.store
          ? {
              name: purchase.store.name,
              address: purchase.store.address || "123 Main Street, Navrangpura",
              city: purchase.store.city || "Ahmedabad",
              phone: purchase.store.phone || "+91 98765 43210",
              gstin: purchase.store.gstin || "24AAAAA0000A1Z5",
              drugLicenseNo: purchase.store.drugLicenseNo || "GJ-AHM-2024-DL-8842",
            }
          : null,
        supplier: {
          id: purchase.supplier.id,
          businessName: purchase.supplier.businessName,
          contactPerson: purchase.supplier.contactPerson,
          phone: purchase.supplier.phone,
          email: purchase.supplier.email,
          address: purchase.supplier.address,
          gstin: purchase.supplier.gstin,
          drugLicenseNo: purchase.supplier.drugLicenseNo,
        },
        items: purchase.items.map((it) => ({
          id: it.id,
          productId: it.productId,
          productName: it.product.name,
          genericName: it.product.genericName,
          sku: it.product.sku,
          packDescription: it.product.packDescription,
          batchNumber: it.batchNumber,
          mfgDate: it.mfgDate ? it.mfgDate.toISOString().split("T")[0] : null,
          expiryDate: it.expiryDate.toISOString().split("T")[0],
          purchaseQty: Number(it.purchaseQty),
          unit: it.unit.name,
          conversionFactor: Number(it.conversionFactor),
          baseQuantity: Number(it.baseQuantity),
          baseUnit: it.product.baseUnit.name,
          unitRate: Number(it.unitRate),
          discountAmount: Number(it.discountAmount),
          gstRate: Number(it.gstRate),
          gstAmount: Number(it.gstAmount),
          totalAmount: Number(it.totalAmount),
        })),
        payments: purchase.payments.map((pm) => ({
          id: pm.id,
          voucherNumber: `VCH-${pm.id.slice(0, 8).toUpperCase()}`,
          receiptNumber: `VCH-${pm.id.slice(0, 8).toUpperCase()}`,
          date: pm.paymentDate.toISOString().split("T")[0],
          amount: Number(pm.amount),
          paymentMethod: pm.paymentMethod,
          ref: pm.referenceNumber || "",
          referenceNumber: pm.referenceNumber || "",
        })),
      },
    });
  });

  // 3. Create New Purchase & Goods Receipt (Batch receiving + Stock update)
  server.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;

    if (!body.supplierId) {
      return reply.status(400).send({ success: false, message: "Supplier is required." });
    }
    if (!body.supplierInvoiceNumber) {
      return reply.status(400).send({ success: false, message: "Supplier bill/invoice number is required." });
    }
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      return reply.status(400).send({ success: false, message: "At least one medicine item is required." });
    }

    let storeId: string;
    try {
      storeId = await resolveStoreTenant(request, body.storeId);
    } catch (err: any) {
      return reply.status(403).send({ success: false, message: err.message || "Unauthorized store access" });
    }

    const currentUserId = (request as any).authUser?.userId || (request.user as any)?.userId || null;
    const invoiceDate = body.invoiceDate ? new Date(body.invoiceDate) : new Date();
    const paidAmount = Number(body.paidAmount || 0);

    // Compute totals
    let subtotal = 0;
    let discountTotal = 0;
    let taxTotal = 0;
    let grandTotal = 0;

    const validatedItems: any[] = [];

    for (const it of body.items) {
      const product = await prisma.product.findUnique({
        where: { id: it.productId },
        include: { baseUnit: true, purchaseUnit: true },
      });

      if (!product) {
        return reply.status(400).send({ success: false, message: `Product ${it.productId} not found.` });
      }

      const qty = Number(it.purchaseQty || 1);
      const factor = Number(it.conversionFactor || 1);
      const baseQuantity = qty * factor;
      const unitRate = Number(it.unitRate || 0);
      const lineSubtotal = qty * unitRate;
      const disc = Number(it.discountAmount || 0);
      const taxable = Math.max(0, lineSubtotal - disc);
      const gstRate = Number(it.gstRate || product.gstRate || 0);
      const gstAmount = Number(((taxable * gstRate) / 100).toFixed(2));
      const lineTotal = taxable + gstAmount;

      subtotal += lineSubtotal;
      discountTotal += disc;
      taxTotal += gstAmount;
      grandTotal += lineTotal;

      validatedItems.push({
        product,
        batchNumber: (it.batchNumber || `BAT-${Math.floor(1000 + Math.random() * 9000)}`).trim().toUpperCase(),
        mfgDate: it.mfgDate ? new Date(it.mfgDate) : null,
        expiryDate: new Date(it.expiryDate || new Date(new Date().setFullYear(new Date().getFullYear() + 2))),
        purchaseQty: qty,
        unitId: it.unitId || product.purchaseUnitId,
        conversionFactor: factor,
        baseQuantity,
        unitRate,
        discountAmount: disc,
        gstRate,
        gstAmount,
        totalAmount: lineTotal,
        mrp: Number(it.mrp || product.mrp),
      });
    }

    grandTotal = Number(grandTotal.toFixed(2));
    subtotal = Number(subtotal.toFixed(2));
    discountTotal = Number(discountTotal.toFixed(2));
    taxTotal = Number(taxTotal.toFixed(2));

    let paymentStatus: PaymentStatus = PaymentStatus.UNPAID;
    if (paidAmount >= grandTotal) {
      paymentStatus = PaymentStatus.PAID;
    } else if (paidAmount > 0) {
      paymentStatus = PaymentStatus.PARTIAL;
    }

    // Execute atomic transaction for Purchase, Batches, Stock Movements and Balance
    const result = await prisma.$transaction(async (tx) => {
      // 1. Generate unique sequential collision-free purchase number
      const currentYear = invoiceDate.getFullYear();
      const seq = await tx.invoiceSequence.upsert({
        where: {
          storeId_series_year: {
            storeId,
            series: "PURCHASE",
            year: currentYear,
          },
        },
        create: {
          storeId,
          series: "PURCHASE",
          year: currentYear,
          lastSequence: 1,
        },
        update: {
          lastSequence: { increment: 1 },
        },
      });
      const invoiceNumber = `PUR-${currentYear}-${String(seq.lastSequence).padStart(5, "0")}`;

      // 2. Create Purchase Invoice
      const purchaseInvoice = await tx.purchaseInvoice.create({
        data: {
          storeId,
          supplierId: body.supplierId,
          invoiceNumber,
          supplierInvoiceNumber: body.supplierInvoiceNumber.trim(),
          invoiceDate,
          receivedDate: new Date(),
          subtotal,
          discountTotal,
          taxTotal,
          totalAmount: grandTotal,
          paidAmount,
          paymentStatus,
          status: "POSTED",
          createdById: currentUserId,
        },
      });

      // 2. Process each item: Batch receiving & stock movement
      for (const it of validatedItems) {
        // Find existing batch or create new batch for this store, product, batchNumber
        let batch = await tx.productBatch.findUnique({
          where: {
            storeId_productId_batchNumber: {
              storeId,
              productId: it.product.id,
              batchNumber: it.batchNumber,
            },
          },
        });

        // Price per base unit
        const costPerBaseUnit = it.conversionFactor > 0 ? it.unitRate / it.conversionFactor : it.unitRate;
        const mrpPerBaseUnit = it.conversionFactor > 0 ? it.mrp / it.conversionFactor : it.mrp;

        if (batch) {
          batch = await tx.productBatch.update({
            where: { id: batch.id },
            data: {
              receivedQty: { increment: it.baseQuantity },
              availableQty: { increment: it.baseQuantity },
              purchasePrice: costPerBaseUnit,
              mrp: mrpPerBaseUnit,
              expiryDate: it.expiryDate,
              supplierId: body.supplierId,
              purchaseInvoiceId: purchaseInvoice.id,
              status: BatchStatus.ACTIVE,
            },
          });
        } else {
          batch = await tx.productBatch.create({
            data: {
              storeId,
              productId: it.product.id,
              batchNumber: it.batchNumber,
              mfgDate: it.mfgDate,
              expiryDate: it.expiryDate,
              purchasePrice: costPerBaseUnit,
              mrp: mrpPerBaseUnit,
              receivedQty: it.baseQuantity,
              availableQty: it.baseQuantity,
              supplierId: body.supplierId,
              purchaseInvoiceId: purchaseInvoice.id,
              status: BatchStatus.ACTIVE,
            },
          });
        }

        // Create Purchase Item
        await tx.purchaseItem.create({
          data: {
            purchaseInvoiceId: purchaseInvoice.id,
            productId: it.product.id,
            batchId: batch.id,
            batchNumber: it.batchNumber,
            mfgDate: it.mfgDate,
            expiryDate: it.expiryDate,
            purchaseQty: it.purchaseQty,
            unitId: it.unitId,
            conversionFactor: it.conversionFactor,
            baseQuantity: it.baseQuantity,
            unitRate: it.unitRate,
            discountAmount: it.discountAmount,
            gstRate: it.gstRate,
            gstAmount: it.gstAmount,
            totalAmount: it.totalAmount,
          },
        });

        // Record Stock Movement (PURCHASE)
        await tx.stockMovement.create({
          data: {
            storeId,
            productId: it.product.id,
            batchId: batch.id,
            movementType: MovementType.PURCHASE,
            quantity: it.purchaseQty,
            unitId: it.unitId,
            baseQuantity: it.baseQuantity,
            referenceType: "PURCHASE_INVOICE",
            referenceId: purchaseInvoice.id,
            reason: `Purchase receipt from invoice ${body.supplierInvoiceNumber}`,
          },
        });
      }

      // 3. Update Supplier Balance (outstanding amount increases by grandTotal - paidAmount)
      const balanceIncrement = grandTotal - paidAmount;
      await tx.supplier.update({
        where: { id: body.supplierId },
        data: {
          currentBalance: {
            increment: balanceIncrement,
          },
        },
      });

      // 4. Record Supplier Payment if initial payment made
      if (paidAmount > 0) {
        let pMethod: PaymentMethod = PaymentMethod.UPI;
        if (body.paymentMethod === "CASH") pMethod = PaymentMethod.CASH;
        else if (body.paymentMethod === "CARD") pMethod = PaymentMethod.CARD;
        else if (body.paymentMethod === "CREDIT") pMethod = PaymentMethod.CREDIT;

        await tx.supplierPayment.create({
          data: {
            storeId,
            supplierId: body.supplierId,
            purchaseInvoiceId: purchaseInvoice.id,
            amount: paidAmount,
            paymentMethod: pMethod,
            referenceNumber: body.paymentReference || null,
            notes: `Paid at purchase receipt (${invoiceNumber})`,
          },
        });
      }

      return purchaseInvoice;
    });

    // Post double-entry journal entry in background
    postPurchaseInvoiceJournalEntry(result.id).catch((err) => {
      server.log.error(err, "Failed to create purchase journal entry");
    });

    await recordAuditLog({
      storeId,
      actorId: currentUserId || undefined,
      action: "CREATE_PURCHASE",
      entity: "PurchaseInvoice",
      entityId: result.id,
      details: {
        invoiceNumber: result.invoiceNumber,
        supplierInvoiceNumber: result.supplierInvoiceNumber,
        grandTotal: Number(result.totalAmount),
        supplierId: body.supplierId,
        itemCount: validatedItems.length,
      },
      ipAddress: request.ip,
    });

    return reply.status(201).send({ success: true, purchase: result });
  });
}
