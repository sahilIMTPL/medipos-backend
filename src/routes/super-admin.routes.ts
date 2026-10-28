import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";

export async function superAdminRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // 1. Global Platform Dashboard KPI & Multi-Store Health Overview
  server.get("/dashboard", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const [
        totalStoresCount,
        activeStoresCount,
        totalUsersCount,
        totalSalesAggregate,
        storesList,
        recentSalesList,
      ] = await Promise.all([
        prisma.store.count(),
        prisma.store.count({ where: { isActive: true } }),
        prisma.user.count({ where: { isActive: true } }),
        prisma.salesInvoice.aggregate({
          _sum: {
            grandTotal: true,
            paidAmount: true,
          },
          _count: {
            id: true,
          },
        }),
        prisma.store.findMany({
          include: {
            _count: {
              select: {
                products: true,
                salesInvoices: true,
                userAssignments: true,
              },
            },
            salesInvoices: {
              select: {
                grandTotal: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        }),
        prisma.salesInvoice.findMany({
          take: 10,
          orderBy: { createdAt: "desc" },
          include: {
            store: {
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
            customer: {
              select: {
                name: true,
                phone: true,
              },
            },
          },
        }),
      ]);

      const networkGmv = Number(totalSalesAggregate._sum.grandTotal || 0);
      const networkOrders = totalSalesAggregate._count.id || 0;

      // Calculate Store-by-Store summary
      const storesSummary = storesList.map((st) => {
        const storeRevenue = st.salesInvoices.reduce(
          (sum, inv) => sum + Number(inv.grandTotal || 0),
          0
        );
        return {
          id: st.id,
          name: st.name,
          code: st.code,
          city: st.city || "Gujarat",
          isActive: st.isActive,
          productCount: st._count.products,
          invoiceCount: st._count.salesInvoices,
          staffCount: st._count.userAssignments,
          totalRevenue: Math.round(storeRevenue * 100) / 100,
          gstin: st.gstin || "Not Registered",
          drugLicenseNo: st.drugLicenseNo || "DL-Pending",
        };
      });

      // Recent network sales ticker
      const recentSales = recentSalesList.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        storeName: inv.store?.name || "Main Branch",
        storeCode: inv.store?.code || "STR-001",
        customerName: inv.customer?.name || "Walk-in Customer",
        grandTotal: Number(inv.grandTotal || 0),
        paymentMethod: inv.paymentMethod,
        paymentStatus: inv.paymentStatus,
        createdAt: inv.createdAt.toISOString(),
      }));

      return reply.send({
        success: true,
        kpis: {
          networkGmv: Math.round(networkGmv * 100) / 100,
          networkOrders,
          totalStores: totalStoresCount,
          activeStores: activeStoresCount,
          suspendedStores: totalStoresCount - activeStoresCount,
          activeStaff: totalUsersCount,
          complianceAlerts: 0,
        },
        storesSummary,
        recentSales,
      });
    } catch (err: any) {
      server.log.error(err, "Failed to load super admin dashboard");
      return reply.status(500).send({
        success: false,
        message: err.message || "Failed to load super admin dashboard data",
      });
    }
  });

  // 2. Complete Store Branches Directory
  server.get("/stores", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const stores = await prisma.store.findMany({
        include: {
          userAssignments: {
            include: {
              user: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                  role: true,
                  phone: true,
                },
              },
            },
          },
          _count: {
            select: {
              products: true,
              batches: true,
              salesInvoices: true,
              userAssignments: true,
              customers: true,
            },
          },
          salesInvoices: {
            select: {
              grandTotal: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      const formatted = stores.map((st) => {
        const totalSales = st.salesInvoices.reduce(
          (sum, inv) => sum + Number(inv.grandTotal || 0),
          0
        );

        // Find primary store manager
        const managerAssignment =
          st.userAssignments.find((a) => a.user.role === "ADMIN") || st.userAssignments[0];

        return {
          id: st.id,
          name: st.name,
          code: st.code,
          address: st.address || "",
          city: st.city || "",
          state: st.state || "",
          pincode: st.pincode || "",
          phone: st.phone || "",
          email: st.email || "",
          gstin: st.gstin || "",
          drugLicenseNo: st.drugLicenseNo || "",
          isActive: st.isActive,
          createdAt: st.createdAt.toISOString(),
          productCount: st._count.products,
          batchCount: st._count.batches,
          orderCount: st._count.salesInvoices,
          staffCount: st._count.userAssignments,
          customerCount: st._count.customers,
          totalSales: Math.round(totalSales * 100) / 100,
          manager: managerAssignment
            ? {
                id: managerAssignment.user.id,
                name: managerAssignment.user.fullName,
                email: managerAssignment.user.email,
                phone: managerAssignment.user.phone || "",
              }
            : null,
        };
      });

      return reply.send({ success: true, stores: formatted });
    } catch (err: any) {
      server.log.error(err, "Failed to load store branches");
      return reply.status(500).send({
        success: false,
        message: err.message || "Failed to load store branches",
      });
    }
  });

  // 3. Provision / Onboard New Pharmacy Store Branch
  server.post("/stores", async (request: FastifyRequest, reply: FastifyReply) => {
    const {
      name,
      code,
      address,
      city,
      state,
      pincode,
      phone,
      email,
      gstin,
      drugLicenseNo,
      adminEmail,
    } = request.body as any;

    if (!name || !name.trim()) {
      return reply.status(400).send({ success: false, message: "Store branch name is required" });
    }

    if (!code || !code.trim()) {
      return reply.status(400).send({ success: false, message: "Store branch code is required" });
    }

    try {
      // Check if store code is unique
      const existingCode = await prisma.store.findUnique({
        where: { code: code.trim().toUpperCase() },
      });
      if (existingCode) {
        return reply.status(400).send({
          success: false,
          message: `Store code "${code.trim().toUpperCase()}" is already assigned to another branch.`,
        });
      }

      // Create Store
      const store = await prisma.store.create({
        data: {
          name: name.trim(),
          code: code.trim().toUpperCase(),
          address: address?.trim() || null,
          city: city?.trim() || "Ahmedabad",
          state: state?.trim() || "Gujarat",
          pincode: pincode?.trim() || "380001",
          phone: phone?.trim() || null,
          email: email?.trim() || null,
          gstin: gstin?.trim() || null,
          drugLicenseNo: drugLicenseNo?.trim() || null,
          isActive: true,
          settings: {
            create: {
              invoicePrefix: "INV",
              thermalPrintWidth: 80,
              expiryAlertDays: 90,
              lowStockThreshold: 10,
              maxDiscountPercent: 20,
              defaultTaxRate: 12,
              enableLooseSale: true,
              requireDoctorInfo: false,
            },
          },
        },
      });

      // If an existing admin user is specified by email, assign them to this store
      if (adminEmail && adminEmail.trim()) {
        const user = await prisma.user.findUnique({
          where: { email: adminEmail.trim().toLowerCase() },
        });
        if (user) {
          await prisma.userStoreAssignment.create({
            data: {
              userId: user.id,
              storeId: store.id,
              isDefault: false,
            },
          });
        }
      }

      return reply.status(201).send({
        success: true,
        store,
        message: `Pharmacy store branch "${store.name}" successfully onboarded.`,
      });
    } catch (err: any) {
      server.log.error(err, "Failed to create store branch");
      return reply.status(500).send({
        success: false,
        message: err.message || "Failed to onboard store branch",
      });
    }
  });

  // 4. Update Store Branch Details
  server.put("/stores/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { name, address, city, state, pincode, phone, email, gstin, drugLicenseNo } =
      request.body as any;

    try {
      const existing = await prisma.store.findUnique({ where: { id } });
      if (!existing) {
        return reply.status(404).send({ success: false, message: "Store branch not found" });
      }

      const updated = await prisma.store.update({
        where: { id },
        data: {
          name: name !== undefined ? name.trim() : undefined,
          address: address !== undefined ? address.trim() || null : undefined,
          city: city !== undefined ? city.trim() || null : undefined,
          state: state !== undefined ? state.trim() || null : undefined,
          pincode: pincode !== undefined ? pincode.trim() || null : undefined,
          phone: phone !== undefined ? phone.trim() || null : undefined,
          email: email !== undefined ? email.trim() || null : undefined,
          gstin: gstin !== undefined ? gstin.trim() || null : undefined,
          drugLicenseNo: drugLicenseNo !== undefined ? drugLicenseNo.trim() || null : undefined,
        },
      });

      return reply.send({
        success: true,
        store: updated,
        message: "Store branch details updated successfully",
      });
    } catch (err: any) {
      return reply.status(500).send({
        success: false,
        message: err.message || "Failed to update store branch",
      });
    }
  });

  // 5. Toggle Store Branch Status (Activate / Suspend)
  server.put("/stores/:id/status", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { isActive } = request.body as { isActive: boolean };

    try {
      const existing = await prisma.store.findUnique({ where: { id } });
      if (!existing) {
        return reply.status(404).send({ success: false, message: "Store branch not found" });
      }

      const updated = await prisma.store.update({
        where: { id },
        data: { isActive: Boolean(isActive) },
      });

      return reply.send({
        success: true,
        store: updated,
        message: `Store branch "${updated.name}" is now ${updated.isActive ? "ACTIVE" : "SUSPENDED"}.`,
      });
    } catch (err: any) {
      return reply.status(500).send({
        success: false,
        message: err.message || "Failed to toggle store status",
      });
    }
  });
}
