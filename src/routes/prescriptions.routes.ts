import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { resolveStoreTenant } from "../middleware/auth";
import { recordAuditLog } from "./audit-logs.routes";

export async function prescriptionRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // 1. List Prescriptions with filters and dispensing status
  server.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId, q, startDate, endDate, limit } = request.query as {
      storeId?: string;
      q?: string;
      startDate?: string;
      endDate?: string;
      limit?: string;
    };

    let targetStoreId: string;
    try {
      targetStoreId = await resolveStoreTenant(request, storeId);
    } catch {
      const fallback = await prisma.store.findFirst({ where: { isActive: true } });
      if (!fallback) return reply.send({ success: true, prescriptions: [] });
      targetStoreId = fallback.id;
    }

    const where: any = { storeId: targetStoreId };

    if (q && q.trim()) {
      const search = q.trim();
      where.OR = [
        { doctorName: { contains: search, mode: "insensitive" } },
        { clinicName: { contains: search, mode: "insensitive" } },
        { doctorRegNo: { contains: search, mode: "insensitive" } },
        { customer: { name: { contains: search, mode: "insensitive" } } },
        { customer: { phone: { contains: search } } },
        { notes: { contains: search, mode: "insensitive" } },
      ];
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }

    const prescriptions = await prisma.prescription.findMany({
      where,
      include: {
        customer: {
          select: { id: true, name: true, phone: true, email: true, address: true },
        },
        salesInvoices: {
          select: {
            id: true,
            invoiceNumber: true,
            invoiceDate: true,
            grandTotal: true,
            items: {
              select: {
                product: { select: { name: true, strength: true, dosageForm: true } },
                quantity: true,
                saleUnit: { select: { name: true } },
              },
            },
          },
          orderBy: { invoiceDate: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit ? Number(limit) : 50,
    });

    return reply.send({
      success: true,
      total: prescriptions.length,
      prescriptions: prescriptions.map((p, index) => {
        const isDispensed = p.salesInvoices.length > 0;
        const dispensedMedicines: string[] = [];

        p.salesInvoices.forEach((inv) => {
          inv.items.forEach((it) => {
            dispensedMedicines.push(
              `${it.product.name} ${it.product.strength || ""} (${Number(it.quantity)} ${it.saleUnit.name})`
            );
          });
        });

        // Extract medicines from notes if not yet dispensed
        const notesMedicines = p.notes
          ? p.notes
              .split(/[,;\n]/)
              .map((s) => s.trim())
              .filter(Boolean)
          : [];

        const medicinesList =
          dispensedMedicines.length > 0 ? Array.from(new Set(dispensedMedicines)) : notesMedicines;

        return {
          id: p.id,
          rxNumber: `RX-${p.createdAt.getFullYear()}-${String(index + 101).padStart(4, "0")}`,
          patientName: p.customer?.name || "Walk-in Patient",
          patientPhone: p.customer?.phone || "",
          patientAddress: p.customer?.address || "",
          customerId: p.customerId,
          doctorName: p.doctorName,
          doctorRegNo: p.doctorRegNo || "N/A",
          clinicName: p.clinicName || "Private Clinic",
          prescriptionDate: p.prescriptionDate
            ? p.prescriptionDate.toISOString().split("T")[0]
            : p.createdAt.toISOString().split("T")[0],
          date: p.createdAt.toISOString().split("T")[0],
          imageUrl: p.imageUrl || null,
          notes: p.notes || "",
          status: isDispensed ? "Dispensed" : "Pending",
          medicines: medicinesList.length > 0 ? medicinesList : ["General Rx Medicines"],
          salesInvoices: p.salesInvoices.map((inv) => ({
            id: inv.id,
            invoiceNumber: inv.invoiceNumber,
            date: inv.invoiceDate.toISOString().split("T")[0],
            grandTotal: Number(inv.grandTotal),
          })),
        };
      }),
    });
  });

  // 2. Get Single Prescription Details
  server.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const prescription = await prisma.prescription.findUnique({
      where: { id },
      include: {
        customer: true,
        salesInvoices: {
          include: {
            items: {
              include: {
                product: true,
                batch: true,
                saleUnit: true,
              },
            },
          },
        },
      },
    });

    if (!prescription) {
      return reply.status(404).send({ success: false, message: "Prescription not found" });
    }

    return reply.send({ success: true, prescription });
  });

  // 3. Create Prescription Record
  server.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;

    if (!body.doctorName || !body.doctorName.trim()) {
      return reply.status(400).send({ success: false, message: "Doctor Name is required." });
    }

    let targetStoreId: string;
    try {
      targetStoreId = await resolveStoreTenant(request, body.storeId);
    } catch {
      const fallback = await prisma.store.findFirst({ where: { isActive: true } });
      if (!fallback) return reply.status(400).send({ success: false, message: "No active store found" });
      targetStoreId = fallback.id;
    }

    // Customer handling
    let customerId = body.customerId;
    const cleanPatientName = body.patientName?.trim() || body.customerName?.trim();
    const cleanPatientPhone = body.patientPhone?.trim() || body.customerPhone?.trim();

    if (!customerId && cleanPatientName && cleanPatientName !== "Walk-in") {
      let existing: any = null;
      if (cleanPatientPhone) {
        existing = await prisma.customer.findFirst({
          where: { storeId: targetStoreId, phone: cleanPatientPhone },
        });
      }
      if (!existing) {
        existing = await prisma.customer.findFirst({
          where: { storeId: targetStoreId, name: { equals: cleanPatientName, mode: "insensitive" } },
        });
      }

      if (existing) {
        customerId = existing.id;
      } else {
        const newCust = await prisma.customer.create({
          data: {
            storeId: targetStoreId,
            name: cleanPatientName,
            phone: cleanPatientPhone || null,
            address: body.patientAddress?.trim() || null,
          },
        });
        customerId = newCust.id;
      }
    }

    const prescription = await prisma.prescription.create({
      data: {
        storeId: targetStoreId,
        customerId: customerId || null,
        doctorName: body.doctorName.trim(),
        doctorRegNo: body.doctorRegNo?.trim() || null,
        clinicName: body.clinicName?.trim() || null,
        prescriptionDate: body.prescriptionDate ? new Date(body.prescriptionDate) : new Date(),
        imageUrl: body.imageUrl?.trim() || null,
        notes: body.notes?.trim() || (Array.isArray(body.medicines) ? body.medicines.join(", ") : null),
      },
      include: {
        customer: true,
      },
    });

    const currentUserId = (request as any).authUser?.userId || (request.user as any)?.userId || null;
    await recordAuditLog({
      storeId: targetStoreId,
      actorId: currentUserId || undefined,
      action: "CREATE_PRESCRIPTION",
      entity: "Prescription",
      entityId: prescription.id,
      details: {
        doctorName: prescription.doctorName,
        doctorRegNo: prescription.doctorRegNo,
        patientName: cleanPatientName,
      },
      ipAddress: request.ip,
    });

    return reply.status(201).send({
      success: true,
      message: "Prescription recorded successfully",
      prescription,
    });
  });

  // 4. Update Prescription
  server.put("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;

    const existing = await prisma.prescription.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ success: false, message: "Prescription not found" });
    }

    const updated = await prisma.prescription.update({
      where: { id },
      data: {
        doctorName: body.doctorName ? body.doctorName.trim() : existing.doctorName,
        doctorRegNo: body.doctorRegNo !== undefined ? body.doctorRegNo?.trim() || null : existing.doctorRegNo,
        clinicName: body.clinicName !== undefined ? body.clinicName?.trim() || null : existing.clinicName,
        prescriptionDate: body.prescriptionDate ? new Date(body.prescriptionDate) : existing.prescriptionDate,
        imageUrl: body.imageUrl !== undefined ? body.imageUrl?.trim() || null : existing.imageUrl,
        notes: body.notes !== undefined ? body.notes?.trim() || null : existing.notes,
      },
    });

    return reply.send({ success: true, prescription: updated });
  });

  // 5. Delete Prescription (if not attached to posted sales invoices)
  server.delete("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const prescription = await prisma.prescription.findUnique({
      where: { id },
      include: { _count: { select: { salesInvoices: true } } },
    });

    if (!prescription) {
      return reply.status(404).send({ success: false, message: "Prescription not found" });
    }

    if (prescription._count.salesInvoices > 0) {
      return reply.status(400).send({
        success: false,
        message: `Cannot delete prescription: It is linked to ${prescription._count.salesInvoices} completed sales invoice(s). Prescriptions attached to dispensed drugs must be retained for legal compliance.`,
      });
    }

    await prisma.prescription.delete({ where: { id } });
    return reply.send({ success: true, message: "Prescription deleted successfully" });
  });
}
