import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { MovementType } from "@prisma/client";
import { resolveStoreTenant } from "../middleware/auth";

export async function purchaseReturnsRoutes(server: FastifyInstance) {
  // 1. List Purchase Returns / Debit Notes
  server.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as {
      storeId?: string;
      q?: string;
      supplierId?: string;
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

    const whereClause: any = { storeId };

    if (query.supplierId) {
      whereClause.supplierId = query.supplierId;
    }

    if (query.q) {
      const search = query.q.trim();
      whereClause.OR = [
        { returnNumber: { contains: search, mode: "insensitive" } },
        { supplier: { businessName: { contains: search, mode: "insensitive" } } },
        { purchaseInvoice: { invoiceNumber: { contains: search, mode: "insensitive" } } },
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

    const returns = await prisma.purchaseReturn.findMany({
      where: whereClause,
      include: {
        supplier: {
          select: {
            id: true,
            businessName: true,
            contactPerson: true,
            phone: true,
            gstin: true,
          },
        },
        purchaseInvoice: {
          select: {
            id: true,
            invoiceNumber: true,
            invoiceDate: true,
          },
        },
        items: true,
      },
      orderBy: { returnDate: "desc" },
    });

    const totalDebit = returns.reduce((sum, r) => sum + Number(r.totalAmount), 0);

    return reply.send({
      success: true,
      total: returns.length,
      totalDebit: Number(totalDebit.toFixed(2)),
      returns: returns.map((r) => ({
        id: r.id,
        returnNumber: r.returnNumber,
        returnDate: r.returnDate.toISOString(),
        supplierId: r.supplierId,
        supplierName: r.supplier.businessName,
        supplierPhone: r.supplier.phone || "",
        supplierGstin: r.supplier.gstin || "",
        purchaseInvoiceNumber: r.purchaseInvoice?.invoiceNumber || "Direct Stock Return",
        totalAmount: Number(r.totalAmount),
        reason: r.reason || "Supplier Return / Debit Note",
        itemCount: r.items.length,
      })),
    });
  });

  // 2. Search Purchase Invoice for Eligible Return Items
  server.get("/eligible/:invoiceNo", async (request: FastifyRequest, reply: FastifyReply) => {
    const { invoiceNo } = request.params as { invoiceNo: string };

    const invoice = await prisma.purchaseInvoice.findFirst({
      where: {
        invoiceNumber: { equals: invoiceNo.trim(), mode: "insensitive" },
      },
      include: {
        supplier: true,
        items: {
          include: {
            product: { select: { id: true, name: true, genericName: true } },
            batch: true,
            unit: true,
          },
        },
      },
    });

    if (!invoice) {
      return reply.status(404).send({
        success: false,
        message: `Purchase invoice "${invoiceNo}" not found.`,
      });
    }

    return reply.send({
      success: true,
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate.toISOString(),
        supplierId: invoice.supplierId,
        supplierName: invoice.supplier.businessName,
        supplierGstin: invoice.supplier.gstin || "",
        items: invoice.items.map((it) => ({
          productId: it.productId,
          productName: it.product.name,
          genericName: it.product.genericName,
          batchId: it.batchId,
          batchNumber: it.batch?.batchNumber || "N/A",
          expiryDate: it.batch?.expiryDate.toISOString().split("T")[0] || "",
          availableQty: Number(it.batch?.availableQty || 0),
          receivedQty: Number(it.purchaseQty),
          unit: it.unit.name,
          unitCost: Number(it.unitRate),
        })),
      },
    });
  });

  // 3. Get Single Purchase Return / Debit Note Details for Printing
  server.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const pReturn = await prisma.purchaseReturn.findUnique({
      where: { id },
      include: {
        store: true,
        supplier: true,
        purchaseInvoice: true,
        items: true,
      },
    });

    if (!pReturn) {
      return reply.status(404).send({ success: false, message: "Purchase return not found." });
    }

    // Load product names and batches for items
    const enrichedItems = await Promise.all(
      pReturn.items.map(async (it) => {
        const product = await prisma.product.findUnique({
          where: { id: it.productId },
          select: { name: true, genericName: true, hsnCode: true, baseUnit: { select: { name: true } } },
        });
        const batch = await prisma.productBatch.findUnique({
          where: { id: it.batchId },
          select: { batchNumber: true, expiryDate: true },
        });

        return {
          id: it.id,
          productName: product?.name || "Medicine",
          genericName: product?.genericName || "",
          hsnCode: product?.hsnCode || "3004",
          batchNumber: batch?.batchNumber || "N/A",
          expiryDate: batch?.expiryDate.toISOString().split("T")[0] || "",
          returnQty: Number(it.returnQty),
          unit: product?.baseUnit.name || "Units",
          unitRate: Number(it.unitRate),
          totalAmount: Number(it.totalAmount),
          reason: it.reason || "",
        };
      })
    );

    return reply.send({
      success: true,
      debitNote: {
        id: pReturn.id,
        returnNumber: pReturn.returnNumber,
        returnDate: pReturn.returnDate.toISOString(),
        purchaseInvoiceNumber: pReturn.purchaseInvoice?.invoiceNumber || "Direct Debit Note",
        purchaseInvoiceDate: pReturn.purchaseInvoice?.invoiceDate.toISOString() || null,
        store: {
          name: pReturn.store.name,
          address: pReturn.store.address || "Main Medical Road",
          city: pReturn.store.city || "Ahmedabad",
          phone: pReturn.store.phone || "+91 98765 43210",
          gstin: pReturn.store.gstin || "24AABCM1234F1Z5",
          drugLicenseNo: pReturn.store.drugLicenseNo || "DL-GJ-2026-MED",
        },
        supplier: {
          name: pReturn.supplier.businessName,
          contactPerson: pReturn.supplier.contactPerson || "",
          phone: pReturn.supplier.phone || "",
          address: pReturn.supplier.address || "",
          gstin: pReturn.supplier.gstin || "",
          drugLicenseNo: pReturn.supplier.drugLicenseNo || "",
        },
        totalAmount: Number(pReturn.totalAmount),
        reason: pReturn.reason || "Vendor Return",
        items: enrichedItems,
      },
    });
  });

  // 4. Create Purchase Return (Debit Note)
  server.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      supplierId: string;
      purchaseInvoiceId?: string;
      reason?: string;
      items: Array<{
        productId: string;
        batchId: string;
        returnQty: number;
        unitRate: number;
        reason?: string;
      }>;
    };

    if (!body.supplierId) {
      return reply.status(400).send({ success: false, message: "Supplier ID is required." });
    }

    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      return reply.status(400).send({ success: false, message: "Select at least one medicine batch to return." });
    }

    const supplier = await prisma.supplier.findUnique({
      where: { id: body.supplierId },
    });

    if (!supplier) {
      return reply.status(404).send({ success: false, message: "Supplier not found." });
    }

    let totalDebitAmount = 0;
    const validatedItems: any[] = [];

    for (const item of body.items) {
      const batch = await prisma.productBatch.findUnique({
        where: { id: item.batchId },
        include: { product: { include: { baseUnit: true } } },
      });

      if (!batch) {
        return reply.status(400).send({
          success: false,
          message: `Batch ${item.batchId} not found in inventory.`,
        });
      }

      const reqQty = Number(item.returnQty);
      if (reqQty <= 0) {
        return reply.status(400).send({ success: false, message: "Return quantity must be greater than 0." });
      }

      if (Number(batch.availableQty) < reqQty) {
        return reply.status(400).send({
          success: false,
          message: `Cannot return ${reqQty} units of batch ${batch.batchNumber}. Available inventory stock is only ${batch.availableQty}.`,
        });
      }

      const rate = Number(item.unitRate || batch.purchasePrice);
      const lineTotal = Number((reqQty * rate).toFixed(2));
      totalDebitAmount += lineTotal;

      validatedItems.push({
        productId: item.productId,
        batch,
        returnQty: reqQty,
        unitRate: rate,
        totalAmount: lineTotal,
        reason: item.reason || body.reason || "Vendor Return",
      });
    }

    totalDebitAmount = Number(totalDebitAmount.toFixed(2));

    // Generate sequential Debit Note Number: DN-YYYY-XXXXX
    const count = await prisma.purchaseReturn.count({ where: { storeId: supplier.storeId } });
    const returnNumber = `DN-${new Date().getFullYear()}-${String(count + 101).padStart(5, "0")}`;

    const now = new Date();

    // Atomic transaction: create return, decrement batch availableQty, decrement supplier balance, log stock movement
    const createdReturn = await prisma.$transaction(async (tx) => {
      // 1. Create PurchaseReturn
      const pReturn = await tx.purchaseReturn.create({
        data: {
          storeId: supplier.storeId,
          supplierId: supplier.id,
          purchaseInvoiceId: body.purchaseInvoiceId || null,
          returnNumber,
          returnDate: now,
          totalAmount: totalDebitAmount,
          reason: body.reason || "Stock returned to supplier",
        },
      });

      // 2. Create Items, deduct Batch available stock, log movement
      for (const it of validatedItems) {
        await tx.purchaseReturnItem.create({
          data: {
            purchaseReturnId: pReturn.id,
            productId: it.productId,
            batchId: it.batch.id,
            returnQty: it.returnQty,
            unitRate: it.unitRate,
            totalAmount: it.totalAmount,
            reason: it.reason,
          },
        });

        // Deduct from batch stock
        await tx.productBatch.update({
          where: { id: it.batch.id },
          data: {
            availableQty: {
              decrement: it.returnQty,
            },
          },
        });

        // Log Stock Movement: PURCHASE_RETURN
        await tx.stockMovement.create({
          data: {
            storeId: supplier.storeId,
            productId: it.productId,
            batchId: it.batch.id,
            movementType: MovementType.PURCHASE_RETURN,
            quantity: it.returnQty,
            unitId: it.batch.product.baseUnitId,
            baseQuantity: it.returnQty,
            referenceType: "PURCHASE_RETURN",
            referenceId: pReturn.id,
            reason: `Returned to ${supplier.businessName} (DN: ${returnNumber}): ${it.reason}`,
          },
        });
      }

      // 3. Decrement supplier outstanding balance by debit amount
      await tx.supplier.update({
        where: { id: supplier.id },
        data: {
          currentBalance: {
            decrement: totalDebitAmount,
          },
        },
      });

      return pReturn;
    });

    return reply.send({
      success: true,
      message: "Purchase return debit note created successfully.",
      returnId: createdReturn.id,
      returnNumber: createdReturn.returnNumber,
      totalDebitAmount,
    });
  });
}
