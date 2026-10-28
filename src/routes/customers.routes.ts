import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { resolveStoreTenant } from "../middleware/auth";

export async function customerRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // 1. List or search customers with rich sales history and KPIs
  server.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId, q } = request.query as { storeId?: string; q?: string };

    let activeStoreId: string | null = null;
    try {
      activeStoreId = await resolveStoreTenant(request, storeId);
    } catch {
      activeStoreId = null;
    }

    const where: any = {};
    if (activeStoreId) where.storeId = activeStoreId;
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { phone: { contains: q } },
        { email: { contains: q, mode: "insensitive" } },
        { id: { contains: q, mode: "insensitive" } },
      ];
    }

    const customers = await prisma.customer.findMany({
      where,
      include: {
        salesInvoices: {
          select: {
            id: true,
            invoiceNumber: true,
            invoiceDate: true,
            grandTotal: true,
            paidAmount: true,
            paymentStatus: true,
            paymentMethod: true,
            items: {
              select: { id: true },
            },
          },
          orderBy: { invoiceDate: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    // Calculate month boundary for "New Customers this month"
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    let storeTotalOrders = 0;
    let storeTotalSales = 0;
    let newCustomersCount = 0;

    const formattedCustomers = customers.map((c) => {
      const orders = c.salesInvoices.length;
      const paid = c.salesInvoices.reduce((sum, inv) => sum + Number(inv.paidAmount || inv.grandTotal || 0), 0);
      const lastInvoice = c.salesInvoices[0];

      storeTotalOrders += orders;
      storeTotalSales += paid;
      if (new Date(c.createdAt) >= startOfMonth) {
        newCustomersCount++;
      }

      return {
        id: c.id,
        name: c.name,
        phone: c.phone || "",
        email: c.email || "",
        address: c.address || "",
        notes: c.notes || "",
        openingBalance: Number(c.openingBalance || 0),
        currentBalance: Number(c.currentBalance || 0),
        createdAt: c.createdAt.toISOString(),
        invoiceCount: orders,
        totalOrders: orders,
        totalPaid: Math.round(paid * 100) / 100,
        lastPurchase: lastInvoice ? lastInvoice.invoiceDate.toISOString() : null,
        salesInvoices: c.salesInvoices.map((inv) => ({
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: inv.invoiceDate.toISOString(),
          itemCount: inv.items.length,
          grandTotal: Number(inv.grandTotal || 0),
          paidAmount: Number(inv.paidAmount || 0),
          paymentStatus: inv.paymentStatus,
          paymentMethod: inv.paymentMethod,
        })),
      };
    });

    return reply.send({
      success: true,
      customers: formattedCustomers,
      stats: {
        totalCustomers: customers.length,
        totalOrders: storeTotalOrders,
        totalSales: Math.round(storeTotalSales * 100) / 100,
        newCustomersThisMonth: newCustomersCount,
      },
    });
  });

  // 2. Quick create customer from POS or Directory
  server.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId, name, phone, email, address, notes } = request.body as any;

    if (!name || !name.trim()) {
      return reply.status(400).send({ success: false, message: "Customer name is required" });
    }

    let targetStoreId: string;
    try {
      targetStoreId = await resolveStoreTenant(request, storeId);
    } catch {
      const defaultStore = await prisma.store.findFirst();
      targetStoreId = defaultStore?.id || "";
    }

    // Check if customer with phone already exists
    if (phone && phone.trim()) {
      const existing = await prisma.customer.findFirst({
        where: {
          storeId: targetStoreId,
          phone: phone.trim(),
        },
      });
      if (existing) {
        return reply.send({ success: true, customer: existing, existed: true });
      }
    }

    // Also check if customer with same name already exists
    if (name && name.trim()) {
      const existingByName = await prisma.customer.findFirst({
        where: {
          storeId: targetStoreId,
          name: { equals: name.trim(), mode: "insensitive" },
        },
      });
      if (existingByName) {
        if (!existingByName.phone && phone?.trim()) {
          const updated = await prisma.customer.update({
            where: { id: existingByName.id },
            data: { phone: phone.trim() },
          });
          return reply.send({ success: true, customer: updated, existed: true });
        }
        return reply.send({ success: true, customer: existingByName, existed: true });
      }
    }

    const customer = await prisma.customer.create({
      data: {
        storeId: targetStoreId,
        name: name.trim(),
        phone: phone?.trim() || null,
        email: email?.trim() || null,
        address: address?.trim() || null,
        notes: notes?.trim() || null,
      },
    });

    return reply.status(201).send({ success: true, customer, existed: false });
  });

  // 3. Update customer details
  server.put("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { name, phone, email, address, notes } = request.body as any;

    const existing = await prisma.customer.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ success: false, message: "Customer not found" });
    }

    const updated = await prisma.customer.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : undefined,
        phone: phone !== undefined ? phone.trim() || null : undefined,
        email: email !== undefined ? email.trim() || null : undefined,
        address: address !== undefined ? address.trim() || null : undefined,
        notes: notes !== undefined ? notes.trim() || null : undefined,
      },
    });

    return reply.send({ success: true, customer: updated });
  });

  // 4. Delete customer
  server.delete("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const existing = await prisma.customer.findUnique({
      where: { id },
      include: {
        _count: {
          select: { salesInvoices: true },
        },
      },
    });

    if (!existing) {
      return reply.status(404).send({ success: false, message: "Customer not found" });
    }

    if (existing._count.salesInvoices > 0) {
      return reply.status(400).send({
        success: false,
        message: `Cannot delete customer with ${existing._count.salesInvoices} existing sales invoices. Profile has active billing records.`,
      });
    }

    await prisma.customer.delete({ where: { id } });
    return reply.send({ success: true, message: "Customer deleted successfully" });
  });
}
