import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { PaymentMethod, PaymentStatus } from "@prisma/client";
import { registerVendorPayment } from "../services/accounting.service";
import { resolveStoreTenant } from "../middleware/auth";

export async function supplierRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // 1. List Suppliers with metrics (invoice count, total spent, current balance)
  server.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId, q, status } = request.query as {
      storeId?: string;
      q?: string;
      status?: string;
    };

    let activeStoreId: string | null = null;
    try {
      activeStoreId = await resolveStoreTenant(request, storeId);
    } catch {
      activeStoreId = null;
    }

    const where: any = {};

    if (activeStoreId) {
      where.storeId = activeStoreId;
    }

    if (status && status !== "ALL") {
      where.isActive = status === "ACTIVE";
    }

    if (q) {
      where.OR = [
        { businessName: { contains: q, mode: "insensitive" } },
        { contactPerson: { contains: q, mode: "insensitive" } },
        { phone: { contains: q } },
        { gstin: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ];
    }

    const suppliers = await prisma.supplier.findMany({
      where,
      include: {
        _count: {
          select: { purchaseInvoices: true },
        },
        purchaseInvoices: {
          select: {
            totalAmount: true,
            paidAmount: true,
          },
        },
      },
      orderBy: { businessName: "asc" },
    });

    return reply.send({
      success: true,
      suppliers: suppliers.map((s) => {
        const totalPurchases = s.purchaseInvoices.reduce(
          (sum, inv) => sum + Number(inv.totalAmount),
          0
        );
        const totalPaid = s.purchaseInvoices.reduce(
          (sum, inv) => sum + Number(inv.paidAmount),
          0
        );

        return {
          id: s.id,
          businessName: s.businessName,
          contactPerson: s.contactPerson || "",
          phone: s.phone || "",
          email: s.email || "",
          address: s.address || "",
          gstin: s.gstin || "",
          drugLicenseNo: s.drugLicenseNo || "",
          paymentTerms: s.paymentTerms || "Net 30",
          openingBalance: Number(s.openingBalance),
          currentBalance: Number(s.currentBalance),
          totalPurchases,
          totalPaid,
          invoiceCount: s._count.purchaseInvoices,
          isActive: s.isActive,
          notes: s.notes || "",
          createdAt: s.createdAt.toISOString().split("T")[0],
        };
      }),
    });
  });

  // 2. Get Single Supplier Details with Purchase History and Payments
  server.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const supplier = await prisma.supplier.findUnique({
      where: { id },
      include: {
        purchaseInvoices: {
          orderBy: { invoiceDate: "desc" },
          take: 50,
          include: {
            items: {
              include: {
                product: { select: { name: true, sku: true } },
                unit: true,
              },
            },
          },
        },
        supplierPayments: {
          orderBy: { paymentDate: "desc" },
          take: 50,
        },
      },
    });

    if (!supplier) {
      return reply.status(404).send({ success: false, message: "Supplier not found" });
    }

    return reply.send({
      success: true,
      supplier: {
        ...supplier,
        openingBalance: Number(supplier.openingBalance),
        currentBalance: Number(supplier.currentBalance),
        purchaseInvoices: supplier.purchaseInvoices.map((inv) => ({
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          supplierInvoiceNumber: inv.supplierInvoiceNumber,
          invoiceDate: inv.invoiceDate.toISOString().split("T")[0],
          totalAmount: Number(inv.totalAmount),
          paidAmount: Number(inv.paidAmount),
          paymentStatus: inv.paymentStatus,
          itemCount: inv.items.length,
          items: inv.items.map((it) => ({
            productName: it.product.name,
            batchNumber: it.batchNumber,
            quantity: Number(it.purchaseQty),
            unit: it.unit.name,
            rate: Number(it.unitRate),
            total: Number(it.totalAmount),
          })),
        })),
        payments: supplier.supplierPayments.map((p) => ({
          id: p.id,
          date: p.paymentDate.toISOString().split("T")[0],
          amount: Number(p.amount),
          paymentMethod: p.paymentMethod,
          referenceNumber: p.referenceNumber || "",
          notes: p.notes || "",
        })),
      },
    });
  });

  // 3. Create Supplier
  server.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;

    if (!body.businessName || !body.businessName.trim()) {
      return reply.status(400).send({ success: false, message: "Business name is required." });
    }

    let storeId: string;
    try {
      storeId = await resolveStoreTenant(request, body.storeId);
    } catch {
      const defaultStore = await prisma.store.findFirst();
      storeId = defaultStore?.id || "";
    }

    const openingBalance = Number(body.openingBalance || 0);

    const supplier = await prisma.supplier.create({
      data: {
        storeId,
        businessName: body.businessName.trim(),
        contactPerson: body.contactPerson?.trim() || null,
        phone: body.phone?.trim() || null,
        email: body.email?.trim() || null,
        address: body.address?.trim() || null,
        gstin: body.gstin?.trim() || null,
        drugLicenseNo: body.drugLicenseNo?.trim() || null,
        paymentTerms: body.paymentTerms?.trim() || "Net 30",
        openingBalance,
        currentBalance: openingBalance,
        notes: body.notes?.trim() || null,
        isActive: true,
      },
    });

    return reply.status(201).send({ success: true, supplier });
  });

  // 4. Update Supplier
  server.put("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;

    const updated = await prisma.supplier.update({
      where: { id },
      data: {
        businessName: body.businessName !== undefined ? body.businessName.trim() : undefined,
        contactPerson: body.contactPerson !== undefined ? body.contactPerson?.trim() : undefined,
        phone: body.phone !== undefined ? body.phone?.trim() : undefined,
        email: body.email !== undefined ? body.email?.trim() : undefined,
        address: body.address !== undefined ? body.address?.trim() : undefined,
        gstin: body.gstin !== undefined ? body.gstin?.trim() : undefined,
        drugLicenseNo: body.drugLicenseNo !== undefined ? body.drugLicenseNo?.trim() : undefined,
        paymentTerms: body.paymentTerms !== undefined ? body.paymentTerms?.trim() : undefined,
        notes: body.notes !== undefined ? body.notes?.trim() : undefined,
        isActive: body.isActive !== undefined ? Boolean(body.isActive) : undefined,
      },
    });

    return reply.send({ success: true, supplier: updated });
  });

  // 5. Delete or Deactivate Supplier
  server.delete("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const invoiceCount = await prisma.purchaseInvoice.count({ where: { supplierId: id } });

    if (invoiceCount > 0) {
      // Per PRD Section 8: Supplier records referenced by posted transactions must be retained for reporting
      const deactivated = await prisma.supplier.update({
        where: { id },
        data: { isActive: false },
      });
      return reply.send({
        success: true,
        message: "Supplier has historical transactions and was deactivated rather than deleted.",
        supplier: deactivated,
      });
    }

    await prisma.supplier.delete({ where: { id } });
    return reply.send({ success: true, message: "Supplier deleted." });
  });

  // 6. Record Supplier Payment
  server.post("/:id/payments", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;

    const amount = Number(body.amount);
    if (!amount || amount <= 0) {
      return reply.status(400).send({ success: false, message: "Payment amount must be greater than 0." });
    }

    const supplier = await prisma.supplier.findUnique({ where: { id } });
    if (!supplier) {
      return reply.status(404).send({ success: false, message: "Supplier not found" });
    }

    let method: PaymentMethod = PaymentMethod.UPI;
    if (body.paymentMethod === "CASH") method = PaymentMethod.CASH;
    else if (body.paymentMethod === "CARD") method = PaymentMethod.CARD;
    else if (body.paymentMethod === "CREDIT") method = PaymentMethod.CREDIT;

    try {
      const result = await registerVendorPayment({
        supplierId: supplier.id,
        purchaseInvoiceId: body.purchaseInvoiceId || undefined,
        amount,
        paymentMethod: method,
        referenceNumber: body.referenceNumber || undefined,
        notes: body.notes || undefined,
        paymentDate: body.paymentDate ? new Date(body.paymentDate) : new Date(),
      });

      return reply.status(201).send({
        success: true,
        payment: result.payment,
        currentBalance: Number(result.supplier.currentBalance),
        invoice: result.invoice
          ? {
              id: result.invoice.id,
              paidAmount: Number(result.invoice.paidAmount),
              paymentStatus: result.invoice.paymentStatus,
            }
          : null,
      });
    } catch (err: any) {
      return reply.status(400).send({ success: false, message: err.message || "Failed to record payment" });
    }
  });
}
