import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { PaymentMethod, MovementType, InvoiceStatus } from "@prisma/client";
import { recordAuditLog } from "./audit-logs.routes";
import { resolveStoreTenant } from "../middleware/auth";
import { realtimeService } from "../services/realtime.service";
import { computeShiftSummary } from "../services/shift.service";

export async function salesReturnsRoutes(server: FastifyInstance) {
  // 1. List Sales Returns
  server.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as {
      storeId?: string;
      q?: string;
      startDate?: string;
      endDate?: string;
    };

    let storeId: string;
    try {
      storeId = await resolveStoreTenant(request, query.storeId);
    } catch {
      const defaultStore = await prisma.store.findFirst();
      storeId = defaultStore?.id || "";
    }

    const whereClause: any = {
      storeId,
    };

    if (query.q) {
      const search = query.q.trim();
      whereClause.OR = [
        { returnNumber: { contains: search, mode: "insensitive" } },
        { originalInvoice: { invoiceNumber: { contains: search, mode: "insensitive" } } },
        { originalInvoice: { customer: { name: { contains: search, mode: "insensitive" } } } },
      ];
    }

    if (query.startDate || query.endDate) {
      whereClause.returnDate = {};
      if (query.startDate) whereClause.returnDate.gte = new Date(query.startDate);
      if (query.endDate) {
        const end = new Date(query.endDate);
        end.setHours(23, 59, 59, 999);
        whereClause.returnDate.lte = end;
      }
    }

    const returns = await prisma.salesReturn.findMany({
      where: whereClause,
      include: {
        originalInvoice: {
          select: {
            id: true,
            invoiceNumber: true,
            invoiceDate: true,
            grandTotal: true,
            customer: { select: { id: true, name: true, phone: true } },
          },
        },
        items: {
          include: {
            salesItem: {
              include: {
                product: { select: { name: true, genericName: true } },
                saleUnit: { select: { name: true } },
              },
            },
            batch: { select: { batchNumber: true, expiryDate: true } },
          },
        },
      },
      orderBy: { returnDate: "desc" },
    });

    const totalRefunded = returns.reduce((sum, r) => sum + Number(r.totalRefundAmount), 0);

    return reply.send({
      success: true,
      total: returns.length,
      totalRefunded: Number(totalRefunded.toFixed(2)),
      returns: returns.map((r) => ({
        id: r.id,
        returnNumber: r.returnNumber,
        returnDate: r.returnDate.toISOString(),
        originalInvoiceId: r.originalInvoice.id,
        originalInvoiceNumber: r.originalInvoice.invoiceNumber,
        originalInvoiceDate: r.originalInvoice.invoiceDate.toISOString(),
        customerName: r.originalInvoice.customer?.name || "Walk-in Customer",
        customerPhone: r.originalInvoice.customer?.phone || "",
        totalRefundAmount: Number(r.totalRefundAmount),
        refundMethod: r.refundMethod,
        reason: r.reason || "Customer return",
        itemCount: r.items.length,
        items: r.items.map((it) => ({
          id: it.id,
          productName: it.salesItem.product.name,
          genericName: it.salesItem.product.genericName,
          batchNumber: it.batch.batchNumber,
          returnQty: Number(it.returnQty),
          unit: it.salesItem.saleUnit.name,
          refundAmount: Number(it.refundAmount),
          isRestocked: it.isRestocked,
          reason: it.reason || "",
        })),
      })),
    });
  });

  // 2. Search Original Invoice for Return Eligibility
  server.get("/eligible/:invoiceNo", async (request: FastifyRequest, reply: FastifyReply) => {
    const { invoiceNo } = request.params as { invoiceNo: string };

    const invoice = await prisma.salesInvoice.findFirst({
      where: {
        invoiceNumber: { equals: invoiceNo.trim(), mode: "insensitive" },
      },
      include: {
        customer: true,
        prescription: true,
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                genericName: true,
                hsnCode: true,
                baseUnit: { select: { name: true } },
                saleUnit: { select: { name: true } },
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
            saleUnit: { select: { id: true, name: true } },
            salesReturnItems: {
              select: {
                returnQty: true,
                baseQuantity: true,
              },
            },
          },
        },
      },
    });

    if (!invoice) {
      return reply.status(404).send({
        success: false,
        message: `Sales invoice "${invoiceNo}" not found.`,
      });
    }

    const items = invoice.items.map((it) => {
      const previouslyReturnedQty = it.salesReturnItems.reduce(
        (sum, r) => sum + Number(r.returnQty),
        0
      );
      const remainingReturnableQty = Math.max(0, Number(it.quantity) - previouslyReturnedQty);
      const ratePerUnit = Number(it.totalAmount) / Number(it.quantity);

      return {
        salesItemId: it.id,
        productId: it.productId,
        productName: it.product.name,
        genericName: it.product.genericName,
        batchId: it.batchId,
        batchNumber: it.batch.batchNumber,
        expiryDate: it.batch.expiryDate.toISOString().split("T")[0],
        saleUnit: it.saleUnit.name,
        soldQuantity: Number(it.quantity),
        previouslyReturnedQty,
        remainingReturnableQty,
        unitPrice: Number(it.unitPrice),
        netRate: Number(it.netRate),
        ratePerUnit: Number(ratePerUnit.toFixed(2)),
        conversionFactor: Number(it.conversionFactor),
        canReturn: remainingReturnableQty > 0,
      };
    });

    return reply.send({
      success: true,
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate.toISOString(),
        customerName: invoice.customer?.name || "Walk-in Customer",
        customerPhone: invoice.customer?.phone || "",
        grandTotal: Number(invoice.grandTotal),
        paymentMethod: invoice.paymentMethod,
        items,
      },
    });
  });

  // 3. Get Single Sales Return Details for Credit Note / Return Slip Printing
  server.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const salesReturn = await prisma.salesReturn.findUnique({
      where: { id },
      include: {
        store: true,
        originalInvoice: {
          include: {
            customer: true,
            prescription: true,
          },
        },
        items: {
          include: {
            salesItem: {
              include: {
                product: {
                  select: {
                    id: true,
                    name: true,
                    genericName: true,
                    hsnCode: true,
                  },
                },
                saleUnit: { select: { name: true } },
              },
            },
            batch: {
              select: {
                id: true,
                batchNumber: true,
                expiryDate: true,
              },
            },
          },
        },
      },
    });

    if (!salesReturn) {
      return reply.status(404).send({ success: false, message: "Sales return not found" });
    }

    return reply.send({
      success: true,
      returnSlip: {
        id: salesReturn.id,
        returnNumber: salesReturn.returnNumber,
        returnDate: salesReturn.returnDate.toISOString(),
        originalInvoiceNumber: salesReturn.originalInvoice.invoiceNumber,
        originalInvoiceDate: salesReturn.originalInvoice.invoiceDate.toISOString(),
        store: {
          name: salesReturn.store.name,
          address: salesReturn.store.address || "Main Medical Road",
          city: salesReturn.store.city || "Ahmedabad",
          phone: salesReturn.store.phone || "+91 98765 43210",
          gstin: salesReturn.store.gstin || "24AABCM1234F1Z5",
          drugLicenseNo: salesReturn.store.drugLicenseNo || "DL-GJ-2026-MED",
        },
        customer: {
          name: salesReturn.originalInvoice.customer?.name || "Walk-in Customer",
          phone: salesReturn.originalInvoice.customer?.phone || "",
        },
        refundMethod: salesReturn.refundMethod,
        totalRefundAmount: Number(salesReturn.totalRefundAmount),
        reason: salesReturn.reason || "Patient return",
        items: salesReturn.items.map((it) => ({
          id: it.id,
          productName: it.salesItem.product.name,
          genericName: it.salesItem.product.genericName,
          hsnCode: it.salesItem.product.hsnCode || "3004",
          batchNumber: it.batch.batchNumber,
          expiryDate: it.batch.expiryDate.toISOString().split("T")[0],
          unit: it.salesItem.saleUnit.name,
          returnQty: Number(it.returnQty),
          refundAmount: Number(it.refundAmount),
          isRestocked: it.isRestocked,
          reason: it.reason || "",
        })),
      },
    });
  });

  // 4. Process Sales Return
  server.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      originalInvoiceId: string;
      refundMethod?: PaymentMethod;
      reason?: string;
      items: Array<{
        salesItemId: string;
        batchId: string;
        returnQty: number;
        refundAmount: number;
        isRestocked?: boolean;
        reason?: string;
      }>;
    };

    if (!body.originalInvoiceId) {
      return reply.status(400).send({ success: false, message: "Original invoice ID is required." });
    }

    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      return reply.status(400).send({ success: false, message: "Select at least one item to return." });
    }

    const invoice = await prisma.salesInvoice.findUnique({
      where: { id: body.originalInvoiceId },
      include: {
        items: {
          include: {
            salesReturnItems: true,
          },
        },
      },
    });

    if (!invoice) {
      return reply.status(404).send({ success: false, message: "Original sales invoice not found." });
    }

    // Validate quantities and build validated payload
    let totalRefundAmount = 0;
    const validatedItems: any[] = [];

    for (const returnReq of body.items) {
      const salesItem = invoice.items.find((it) => it.id === returnReq.salesItemId);
      if (!salesItem) {
        return reply.status(400).send({
          success: false,
          message: `Sales item ${returnReq.salesItemId} does not belong to this invoice.`,
        });
      }

      const previouslyReturned = salesItem.salesReturnItems.reduce(
        (sum, r) => sum + Number(r.returnQty),
        0
      );
      const remainingReturnable = Number(salesItem.quantity) - previouslyReturned;
      const requestedQty = Number(returnReq.returnQty);

      if (requestedQty <= 0) {
        return reply.status(400).send({
          success: false,
          message: `Return quantity must be greater than 0.`,
        });
      }

      if (requestedQty > remainingReturnable) {
        return reply.status(400).send({
          success: false,
          message: `Cannot return ${requestedQty} units. Maximum remaining returnable quantity for this item is ${remainingReturnable}.`,
        });
      }

      const factor = Number(salesItem.conversionFactor || 1);
      const baseQuantity = requestedQty * factor;
      const ratePerUnit = Number(salesItem.totalAmount) / Number(salesItem.quantity);
      const refundAmount = Number((requestedQty * ratePerUnit).toFixed(2));

      totalRefundAmount += refundAmount;

      validatedItems.push({
        salesItemId: salesItem.id,
        productId: salesItem.productId,
        batchId: salesItem.batchId,
        unitId: salesItem.saleUnitId,
        returnQty: requestedQty,
        baseQuantity,
        refundAmount,
        isRestocked: returnReq.isRestocked !== false, // default true
        reason: returnReq.reason || body.reason || "Patient return",
      });
    }

    totalRefundAmount = Number(totalRefundAmount.toFixed(2));

    // Generate sequential Return Number: RET-YYYY-XXXXX
    const currentUserId = (request as any).authUser?.userId || (request.user as any)?.userId || null;
    const now = new Date();

    // Execute atomic transaction: record return, restock batch if not expired, record stock movement
    const createdReturn = await prisma.$transaction(async (tx) => {
      // 1. Generate sequential collision-free return number
      const currentYear = now.getFullYear();
      const seq = await tx.invoiceSequence.upsert({
        where: {
          storeId_series_year: {
            storeId: invoice.storeId,
            series: "RETURN",
            year: currentYear,
          },
        },
        create: {
          storeId: invoice.storeId,
          series: "RETURN",
          year: currentYear,
          lastSequence: 101,
        },
        update: {
          lastSequence: { increment: 1 },
        },
      });
      const returnNumber = `RET-${currentYear}-${String(seq.lastSequence).padStart(5, "0")}`;

      // 2. Create SalesReturn master
      const sReturn = await tx.salesReturn.create({
        data: {
          storeId: invoice.storeId,
          returnNumber,
          originalInvoiceId: invoice.id,
          returnDate: now,
          totalRefundAmount,
          refundMethod: body.refundMethod || PaymentMethod.CASH,
          reason: body.reason || "Customer return",
          createdById: currentUserId,
        },
      });

      // 3. Create Items, adjust batch stock & movements
      for (const it of validatedItems) {
        // Drug Safety Check: Verify batch expiry before allowing restock
        const targetBatch = await tx.productBatch.findUnique({ where: { id: it.batchId } });
        const isExpired = targetBatch ? new Date(targetBatch.expiryDate) <= now : false;
        const allowRestock = it.isRestocked && !isExpired;

        await tx.salesReturnItem.create({
          data: {
            salesReturnId: sReturn.id,
            salesItemId: it.salesItemId,
            batchId: it.batchId,
            returnQty: it.returnQty,
            baseQuantity: it.baseQuantity,
            refundAmount: it.refundAmount,
            isRestocked: allowRestock,
            reason: it.reason,
          },
        });

        if (allowRestock) {
          // Increment Batch stock back into active inventory
          await tx.productBatch.update({
            where: { id: it.batchId },
            data: {
              availableQty: {
                increment: it.baseQuantity,
              },
            },
          });

          // Log Stock Movement: SALE_RETURN
          await tx.stockMovement.create({
            data: {
              storeId: invoice.storeId,
              productId: it.productId,
              batchId: it.batchId,
              movementType: MovementType.SALE_RETURN,
              quantity: it.returnQty,
              unitId: it.unitId,
              baseQuantity: it.baseQuantity,
              referenceType: "SALES_RETURN",
              referenceId: sReturn.id,
              userId: currentUserId,
              reason: `Restocked from Return ${returnNumber}: ${it.reason}`,
            },
          });
        } else {
          // Drug is expired or customer specified not restocked: Log as damaged / expired write-off (safety protection)
          await tx.stockMovement.create({
            data: {
              storeId: invoice.storeId,
              productId: it.productId,
              batchId: it.batchId,
              movementType: isExpired ? MovementType.EXPIRED_DISPOSAL : MovementType.DAMAGE,
              quantity: it.returnQty,
              unitId: it.unitId,
              baseQuantity: it.baseQuantity,
              referenceType: "SALES_RETURN",
              referenceId: sReturn.id,
              userId: currentUserId,
              reason: isExpired
                ? `Returned item batch ${targetBatch?.batchNumber || ""} has expired; quarantined/disposed rather than restocked.`
                : `Damaged/unsealed return not restocked: ${it.reason}`,
            },
          });
        }
      }

      // 4. Check if all items in original invoice are now returned
      const allOriginalItems = await tx.salesItem.findMany({
        where: { salesInvoiceId: invoice.id },
        include: { salesReturnItems: true },
      });

      const isFullyReturned = allOriginalItems.every((it) => {
        const totalRet = it.salesReturnItems.reduce((sum, r) => sum + Number(r.returnQty), 0);
        return totalRet >= Number(it.quantity);
      });

      if (isFullyReturned) {
        await tx.salesInvoice.update({
          where: { id: invoice.id },
          data: { status: InvoiceStatus.REFUNDED },
        });
      }

      return sReturn;
    });

    await recordAuditLog({
      storeId: invoice.storeId,
      action: "CREATE_SALE_RETURN",
      entity: "SalesReturn",
      entityId: createdReturn.id,
      details: {
        returnNumber: createdReturn.returnNumber,
        originalInvoiceNumber: invoice.invoiceNumber,
        totalRefundAmount,
        refundMethod: body.refundMethod || "CASH",
        reason: body.reason,
      },
      ipAddress: request.ip,
    });

    // Real-time WebSocket update for active shift
    try {
      const activeShift = await prisma.cashRegisterShift.findFirst({
        where: { storeId: invoice.storeId, status: "OPEN" },
        select: { id: true },
      });
      if (activeShift) {
        const updatedSummary = await computeShiftSummary(activeShift.id);
        realtimeService.notifySaleReturned(invoice.storeId, updatedSummary, {
          returnId: createdReturn.id,
          returnNumber: createdReturn.returnNumber,
          totalRefundAmount,
          refundMethod: body.refundMethod || "CASH",
        });
      }
    } catch (wsErr) {
      server.log.warn(wsErr, "Failed to broadcast real-time shift refund update");
    }

    return reply.send({
      success: true,
      message: "Sales return processed successfully.",
      returnId: createdReturn.id,
      returnNumber: createdReturn.returnNumber,
      totalRefundAmount,
    });
  });
}
