import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import {
  BatchStatus,
  DiscountType,
  InvoiceStatus,
  MovementType,
  PaymentMethod,
  PaymentStatus,
  Role,
} from "@prisma/client";
import { recordAuditLog } from "./audit-logs.routes";
import { resolveStoreTenant } from "../middleware/auth";
import { postSalesInvoiceJournalEntry } from "../services/accounting.service";
import { taskQueue } from "../services/asyncQueue.service";
import { cache } from "../services/cache.service";
import { realtimeService } from "../services/realtime.service";
import { computeShiftSummary } from "../services/shift.service";

export async function salesRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // 1. List Sales Invoices with filters and search
  server.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId, q, startDate, endDate, paymentMethod, paymentStatus, limit } = request.query as {
      storeId?: string;
      q?: string;
      startDate?: string;
      endDate?: string;
      paymentMethod?: string;
      paymentStatus?: string;
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
    if (paymentMethod && paymentMethod !== "ALL") {
      where.paymentMethod = paymentMethod as PaymentMethod;
    }
    if (paymentStatus && paymentStatus !== "ALL") {
      where.paymentStatus = paymentStatus as PaymentStatus;
    }

    if (startDate || endDate) {
      where.invoiceDate = {};
      if (startDate) where.invoiceDate.gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        where.invoiceDate.lte = end;
      }
    }

    if (q) {
      where.OR = [
        { invoiceNumber: { contains: q, mode: "insensitive" } },
        { customer: { name: { contains: q, mode: "insensitive" } } },
        { customer: { phone: { contains: q } } },
      ];
    }

    const invoices = await prisma.salesInvoice.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        prescription: { select: { doctorName: true, clinicName: true } },
        payments: {
          select: {
            id: true,
            amount: true,
            paymentMethod: true,
            paymentDate: true,
            transactionRef: true,
          },
          orderBy: { paymentDate: "desc" },
        },
        _count: { select: { items: true } },
      },
      orderBy: { invoiceDate: "desc" },
      take: limit ? Number(limit) : 50,
    });

    return reply.send({
      success: true,
      invoices: invoices.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: inv.invoiceDate.toISOString(),
        customerName: inv.customer?.name || "Walk-in Customer",
        customerPhone: inv.customer?.phone || "",
        doctorName: inv.prescription?.doctorName || "",
        subtotal: Number(inv.subtotal),
        discountTotal: Number(inv.discountTotal),
        taxTotal: Number(inv.taxTotal),
        grandTotal: Number(inv.grandTotal),
        paidAmount: Number(inv.paidAmount),
        changeAmount: Number(inv.changeAmount),
        paymentMethod: inv.paymentMethod,
        paymentStatus: inv.paymentStatus,
        status: inv.status,
        itemCount: inv._count.items,
        payments: inv.payments.map((p) => ({
          id: p.id,
          receiptNumber: `REC-${p.id.slice(0, 8).toUpperCase()}`,
          amount: Number(p.amount),
          paymentMethod: p.paymentMethod,
          date: p.paymentDate.toISOString(),
          ref: p.transactionRef || "",
        })),
      })),
    });
  });

  // 2. Get Single Sales Invoice Details for Thermal / A4 Print
  server.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const invoice = await prisma.salesInvoice.findUnique({
      where: { id },
      include: {
        store: true,
        customer: true,
        prescription: true,
        createdBy: { select: { fullName: true, username: true } },
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                genericName: true,
                hsnCode: true,
                packDescription: true,
                isPrescriptionRequired: true,
              },
            },
            batch: {
              select: {
                id: true,
                batchNumber: true,
                expiryDate: true,
                mrp: true,
              },
            },
            saleUnit: true,
          },
        },
        payments: true,
      },
    });

    if (!invoice) {
      return reply.status(404).send({ success: false, message: "Invoice not found" });
    }

    return reply.send({
      success: true,
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate.toISOString(),
        store: {
          name: invoice.store.name,
          address: invoice.store.address || "Main Medical Road",
          city: invoice.store.city || "Ahmedabad",
          phone: invoice.store.phone || "+91 98765 43210",
          gstin: invoice.store.gstin || "24AABCM1234F1Z5",
          drugLicenseNo: invoice.store.drugLicenseNo || "DL-GJ-2026-MED",
        },
        customer: {
          name: invoice.customer?.name || "Walk-in Customer",
          phone: invoice.customer?.phone || "",
          address: invoice.customer?.address || "",
        },
        prescription: invoice.prescription
          ? {
              doctorName: invoice.prescription.doctorName,
              doctorRegNo: invoice.prescription.doctorRegNo || "",
              clinicName: invoice.prescription.clinicName || "",
            }
          : null,
        cashier: invoice.createdBy?.fullName || "Staff",
        subtotal: Number(invoice.subtotal),
        discountTotal: Number(invoice.discountTotal),
        taxTotal: Number(invoice.taxTotal),
        cgstTotal: Number(invoice.cgstTotal),
        sgstTotal: Number(invoice.sgstTotal),
        igstTotal: Number(invoice.igstTotal),
        grandTotal: Number(invoice.grandTotal),
        paidAmount: Number(invoice.paidAmount),
        changeAmount: Number(invoice.changeAmount),
        paymentMethod: invoice.paymentMethod,
        paymentStatus: invoice.paymentStatus,
        status: invoice.status,
        notes: invoice.notes || "",
        items: invoice.items.map((it) => ({
          id: it.id,
          productId: it.productId,
          productName: it.product.name,
          genericName: it.product.genericName,
          hsnCode: it.product.hsnCode || "3004",
          packDescription: it.product.packDescription,
          batchNumber: it.batch.batchNumber,
          expiryDate: it.batch.expiryDate.toISOString().split("T")[0],
          unit: it.saleUnit.name,
          quantity: Number(it.quantity),
          unitPrice: Number(it.unitPrice),
          discountType: it.discountType,
          discountValue: Number(it.discountValue),
          discountAmount: Number(it.discountAmount),
          netRate: Number(it.netRate),
          gstRate: Number(it.gstRate),
          gstAmount: Number(it.gstAmount),
          subtotal: Number(it.subtotal),
          totalAmount: Number(it.totalAmount),
        })),
        payments: invoice.payments.map((p) => ({
          id: p.id,
          receiptNumber: `REC-${p.id.slice(0, 8).toUpperCase()}`,
          method: p.paymentMethod,
          paymentMethod: p.paymentMethod,
          amount: Number(p.amount),
          reference: p.transactionRef || "",
          date: p.paymentDate ? p.paymentDate.toISOString() : p.createdAt.toISOString(),
        })),
      },
    });
  });

  // 3. POS Billing Checkout (Atomic stock deduction + sequential invoice generation)
  server.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    if ((request as any).authUser?.role === Role.DOCTOR) {
      return reply.status(403).send({ success: false, message: "Doctors cannot create sales billing invoices." });
    }

    const body = request.body as any;

    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      return reply.status(400).send({ success: false, message: "Cart cannot be empty." });
    }

    let storeId: string;
    try {
      storeId = await resolveStoreTenant(request, body.storeId);
    } catch (err: any) {
      return reply.status(403).send({ success: false, message: err.message || "Unauthorized store access" });
    }

    const currentUserId = (request as any).authUser?.userId || (request.user as any)?.userId || null;

    // Customer handling (De-duplicate by customerId, phone, or name)
    let customerId = body.customerId;
    const cleanCustomerName = body.customerName?.trim();
    const cleanCustomerPhone = body.customerPhone?.trim();

    if (customerId) {
      const existingById = await prisma.customer.findUnique({ where: { id: customerId } });
      if (!existingById) {
        customerId = null;
      }
    }

    if (!customerId && cleanCustomerName && cleanCustomerName !== "Walk-in") {
      let existingCust: any = null;

      // 1. Check by phone if provided
      if (cleanCustomerPhone) {
        existingCust = await prisma.customer.findFirst({
          where: {
            storeId,
            phone: cleanCustomerPhone,
          },
        });
      }

      // 2. Check by name (case-insensitive) if not found by phone
      if (!existingCust && cleanCustomerName) {
        existingCust = await prisma.customer.findFirst({
          where: {
            storeId,
            name: { equals: cleanCustomerName, mode: "insensitive" },
          },
        });
      }

      if (existingCust) {
        customerId = existingCust.id;
        if (!existingCust.phone && cleanCustomerPhone) {
          await prisma.customer.update({
            where: { id: existingCust.id },
            data: { phone: cleanCustomerPhone },
          });
        }
      } else {
        const cust = await prisma.customer.create({
          data: {
            storeId,
            name: cleanCustomerName,
            phone: cleanCustomerPhone || null,
          },
        });
        customerId = cust.id;
      }
    }

    // Prescription handling if provided
    let prescriptionId: string | null = null;
    if (body.prescriptionId) {
      prescriptionId = body.prescriptionId;
    } else if (body.doctorName && body.doctorName.trim()) {
      const presc = await prisma.prescription.create({
        data: {
          storeId,
          customerId: customerId || null,
          doctorName: body.doctorName.trim(),
          doctorRegNo: body.doctorRegNo?.trim() || null,
          clinicName: body.clinicName?.trim() || null,
        },
      });
      prescriptionId = presc.id;
    }

    const now = new Date();

    // Line items verification and calculation
    let subtotal = 0;
    let discountTotal = 0;
    let taxTotal = 0;
    let grandTotal = 0;

    const validatedItems: any[] = [];

    for (const item of body.items) {
      const product = await prisma.product.findUnique({
        where: { id: item.productId },
        include: { baseUnit: true, saleUnit: true, conversions: true },
      });

      if (!product) {
        return reply.status(400).send({ success: false, message: `Product ${item.productId} not found.` });
      }

      const qty = Number(item.quantity || 1);
      const factor = Number(item.conversionFactor || 1);
      const baseQuantity = qty * factor;

      let batch: any = null;
      if (item.batchId) {
        batch = await prisma.productBatch.findUnique({ where: { id: item.batchId } });
      } else {
        batch = await prisma.productBatch.findFirst({
          where: {
            productId: product.id,
            status: BatchStatus.ACTIVE,
            availableQty: { gte: baseQuantity },
            expiryDate: { gt: now },
          },
          orderBy: { expiryDate: "asc" }, // FEFO with sufficient stock
        });

        if (!batch) {
          batch = await prisma.productBatch.findFirst({
            where: {
              productId: product.id,
              status: BatchStatus.ACTIVE,
              availableQty: { gt: 0 },
              expiryDate: { gt: now },
            },
            orderBy: { expiryDate: "asc" },
          });
        }
      }

      if (!batch) {
        return reply.status(400).send({
          success: false,
          message: `No active available batch found for medicine "${product.name}".`,
        });
      }

      if (batch.status === BatchStatus.QUARANTINED || batch.status === BatchStatus.EXPIRED) {
        return reply.status(400).send({
          success: false,
          message: `Batch ${batch.batchNumber} for "${product.name}" is ${batch.status} and cannot be sold.`,
        });
      }

      if (new Date(batch.expiryDate) <= now) {
        return reply.status(400).send({
          success: false,
          message: `Batch ${batch.batchNumber} for "${product.name}" has expired (${new Date(batch.expiryDate).toISOString().split("T")[0]}) and cannot be sold.`,
        });
      }

      if (Number(batch.availableQty) < baseQuantity) {
        return reply.status(400).send({
          success: false,
          message: `Insufficient stock in batch ${batch.batchNumber} for "${product.name}". Available: ${batch.availableQty} ${product.baseUnit.name}(s), Requested: ${baseQuantity} ${product.baseUnit.name}(s).`,
        });
      }

      const unitPrice = Number(item.unitPrice || Number(batch.mrp) * factor);
      const lineGross = qty * unitPrice;

      // Calculate discount
      let discountAmount = 0;
      const discountType: DiscountType =
        item.discountType === "FIXED" ? DiscountType.FIXED : DiscountType.PERCENTAGE;
      const discountValue = Number(item.discountValue || 0);

      if (discountType === DiscountType.PERCENTAGE) {
        discountAmount = (lineGross * discountValue) / 100;
      } else {
        discountAmount = discountValue;
      }
      discountAmount = Math.min(lineGross, Number(discountAmount.toFixed(2)));

      // Statutory Indian Pharma MRP-Inclusive Tax Calculation:
      // MRP includes all taxes. The customer pays (lineGross - discountAmount).
      const gstRate = Number(item.gstRate !== undefined ? item.gstRate : product.gstRate);
      const linePayable = Number((lineGross - discountAmount).toFixed(2));
      const taxable = Number((linePayable / (1 + gstRate / 100)).toFixed(2));
      const gstAmount = Number((linePayable - taxable).toFixed(2));
      const lineTotal = linePayable;
      const netRate = Number((taxable / qty).toFixed(2));

      subtotal += lineGross;
      discountTotal += discountAmount;
      taxTotal += gstAmount;
      grandTotal += lineTotal;

      validatedItems.push({
        product,
        batch,
        saleUnitId: item.saleUnitId || product.saleUnitId,
        quantity: qty,
        conversionFactor: factor,
        baseQuantity,
        unitPrice,
        discountType,
        discountValue,
        discountAmount,
        netRate,
        gstRate,
        gstAmount,
        subtotal: lineGross,
        totalAmount: lineTotal,
      });
    }

    grandTotal = Number(grandTotal.toFixed(2));
    subtotal = Number(subtotal.toFixed(2));
    discountTotal = Number(discountTotal.toFixed(2));
    taxTotal = Number(taxTotal.toFixed(2));

    // CGST and SGST split equally (50% each) for intra-state pharmacy billing
    const cgstTotal = Number((taxTotal / 2).toFixed(2));
    const sgstTotal = Number((taxTotal - cgstTotal).toFixed(2));

    const paidAmount = Number(body.paidAmount !== undefined ? body.paidAmount : grandTotal);
    const changeAmount = Number(body.changeAmount || (paidAmount > grandTotal ? paidAmount - grandTotal : 0));

    let paymentMethod: PaymentMethod = PaymentMethod.CASH;
    if (body.paymentMethod === "UPI") paymentMethod = PaymentMethod.UPI;
    else if (body.paymentMethod === "CARD") paymentMethod = PaymentMethod.CARD;
    else if (body.paymentMethod === "SPLIT") paymentMethod = PaymentMethod.SPLIT;
    else if (body.paymentMethod === "CREDIT") paymentMethod = PaymentMethod.CREDIT;

    let paymentStatus: PaymentStatus = PaymentStatus.PAID;
    if (paidAmount < grandTotal && paidAmount > 0) paymentStatus = PaymentStatus.PARTIAL;
    else if (paidAmount === 0) paymentStatus = PaymentStatus.UNPAID;

    // Execute atomic transaction for checkout
    try {
      const invoice = await prisma.$transaction(async (tx) => {
        // 1. Generate sequential collision-free invoice number using InvoiceSequence
        const currentYear = now.getFullYear();
        const seq = await tx.invoiceSequence.upsert({
          where: {
            storeId_series_year: {
              storeId,
              series: "SALES",
              year: currentYear,
            },
          },
          create: {
            storeId,
            series: "SALES",
            year: currentYear,
            lastSequence: 101,
          },
          update: {
            lastSequence: { increment: 1 },
          },
        });

        const invoiceNumber = `INV-${currentYear}-${String(seq.lastSequence).padStart(5, "0")}`;

        // Find active open shift for this store
        const activeShift = await tx.cashRegisterShift.findFirst({
          where: { storeId, status: "OPEN" },
          select: { id: true },
        });

        // 2. Create Sales Invoice
        const createdInvoice = await tx.salesInvoice.create({
          data: {
            storeId,
            shiftId: body.shiftId || activeShift?.id || null,
            invoiceNumber,
            customerId: customerId || null,
            prescriptionId,
            invoiceDate: now,
            subtotal,
            discountTotal,
            taxTotal,
            cgstTotal,
            sgstTotal,
            igstTotal: 0,
            grandTotal,
            paidAmount: Math.min(paidAmount, grandTotal),
            changeAmount,
            paymentStatus,
            paymentMethod,
            status: InvoiceStatus.COMPLETED,
            notes: body.notes || null,
            createdById: currentUserId,
          },
        });

        // 3. Create Items, conditionally decrement Batch stock atomically, and log Stock Movements
        for (const it of validatedItems) {
          // Conditional decrement inside transaction: Guarantees availableQty >= baseQuantity
          const updateResult = await tx.productBatch.updateMany({
            where: {
              id: it.batch.id,
              availableQty: { gte: it.baseQuantity },
              status: BatchStatus.ACTIVE,
            },
            data: {
              availableQty: {
                decrement: it.baseQuantity,
              },
            },
          });

          if (updateResult.count === 0) {
            throw new Error(
              `Stock conflict: Batch ${it.batch.batchNumber} for "${it.product.name}" has insufficient stock or was sold by another counter. Please refresh.`
            );
          }

          await tx.salesItem.create({
            data: {
              salesInvoiceId: createdInvoice.id,
              productId: it.product.id,
              batchId: it.batch.id,
              saleUnitId: it.saleUnitId,
              quantity: it.quantity,
              conversionFactor: it.conversionFactor,
              baseQuantity: it.baseQuantity,
              unitPrice: it.unitPrice,
              discountType: it.discountType,
              discountValue: it.discountValue,
              discountAmount: it.discountAmount,
              netRate: it.netRate,
              gstRate: it.gstRate,
              gstAmount: it.gstAmount,
              subtotal: it.subtotal,
              totalAmount: it.totalAmount,
            },
          });

          // Record stock movement (SALE)
          await tx.stockMovement.create({
            data: {
              storeId,
              productId: it.product.id,
              batchId: it.batch.id,
              movementType: MovementType.SALE,
              quantity: it.quantity,
              unitId: it.saleUnitId,
              baseQuantity: it.baseQuantity,
              referenceType: "SALES_INVOICE",
              referenceId: createdInvoice.id,
              userId: currentUserId,
              reason: `Sold on invoice ${invoiceNumber}`,
            },
          });
        }

        // 4. Create Sales Payment if any paid amount
        if (paidAmount > 0) {
          await tx.salesPayment.create({
            data: {
              salesInvoiceId: createdInvoice.id,
              paymentMethod,
              amount: Math.min(paidAmount, grandTotal),
              transactionRef: body.paymentRef || null,
            },
          });
        }

        // 5. Update Customer Current Balance if not fully paid and customer is linked
        const unpaidBalance = grandTotal - Math.min(paidAmount, grandTotal);
        if (customerId && unpaidBalance > 0) {
          await tx.customer.update({
            where: { id: customerId },
            data: {
              currentBalance: {
                increment: unpaidBalance,
              },
            },
          });
        }

        return createdInvoice;
      });

      // Dispatch background accounting journal entry and audit log asynchronously (sub-millisecond non-blocking)
      taskQueue.enqueue("POST_SALES_JOURNAL", { invoiceId: invoice.id });
      taskQueue.enqueue("RECORD_AUDIT_LOG", {
        storeId,
        actorId: currentUserId || undefined,
        action: "CREATE_SALE",
        entity: "SalesInvoice",
        entityId: invoice.id,
        details: {
          invoiceNumber: invoice.invoiceNumber,
          grandTotal: Number(invoice.grandTotal),
          itemsCount: body.items.length,
          paymentMethod,
          customerName: body.customerName,
        },
        ipAddress: request.ip,
      });

      cache.invalidatePrefix("products:");

      // Instant Real-Time WebSocket Broadcast to Cash Registers & Staff Screens
      if (invoice.shiftId) {
        try {
          const shiftSummary = await computeShiftSummary(invoice.shiftId);
          realtimeService.notifySaleCompleted(storeId, shiftSummary, {
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            grandTotal,
            paidAmount,
            changeAmount,
            paymentMethod,
          });
        } catch (wsErr) {
          server.log.warn(wsErr, "Failed to broadcast real-time shift sale update");
        }
      }

      return reply.status(201).send({
        success: true,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        grandTotal,
        paidAmount,
        changeAmount,
        message: "Invoice completed successfully and stock deducted",
      });
    } catch (err: any) {
      server.log.error(err, "Sales transaction checkout failed");
      return reply.status(400).send({
        success: false,
        message: err.message || "Checkout failed due to a stock or database constraint.",
      });
    }
  });
}
