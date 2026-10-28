import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { resolveStoreTenant } from "../middleware/auth";
import { recordAuditLog } from "./audit-logs.routes";
import { DigiLockerService } from "../services/digilocker.service";

export async function digilockerRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // Helper to resolve active store
  const getStore = async (request: FastifyRequest, explicitStoreId?: string) => {
    const storeId = await resolveStoreTenant(request, explicitStoreId);
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      include: { settings: true },
    });
    if (!store) throw new Error("No active store found");
    return store;
  };

  // 1. Patient / Citizen ABHA or Aadhaar Verification
  server.post("/verify-patient", async (request: FastifyRequest, reply: FastifyReply) => {
    const { idType, idNumber, customerId } = request.body as {
      idType: "ABHA" | "AADHAAR";
      idNumber: string;
      customerId?: string;
    };

    if (!idNumber) {
      return reply.status(400).send({ success: false, message: "ID Number is required" });
    }

    try {
      const result = await DigiLockerService.verifyPatientIdentity(idType || "ABHA", idNumber);

      // If customerId is provided, link to customer profile
      if (customerId) {
        await prisma.customer.update({
          where: { id: customerId },
          data: {
            abhaId: result.abhaAddress || result.idNumber,
            digilockerVerified: true,
          },
        });
      }

      const store = await getStore(request);
      await recordAuditLog({
        storeId: store.id,
        action: "DIGILOCKER_PATIENT_VERIFIED",
        entity: "Customer",
        entityId: customerId || result.idNumber,
        details: { idType, name: result.fullName, abha: result.abhaAddress },
        ipAddress: request.ip,
      });

      return reply.send({
        success: true,
        verification: result,
      });
    } catch (err: any) {
      return reply.status(500).send({
        success: false,
        message: err.message || "DigiLocker verification failed",
      });
    }
  });

  // 2. Doctor Registration Verification (NMC / State Medical Council)
  server.post("/verify-doctor", async (request: FastifyRequest, reply: FastifyReply) => {
    const { doctorName, regNumber, stateCouncil } = request.body as {
      doctorName: string;
      regNumber: string;
      stateCouncil?: string;
    };

    if (!doctorName || !regNumber) {
      return reply.status(400).send({
        success: false,
        message: "Doctor name and Registration Number are required",
      });
    }

    try {
      const result = await DigiLockerService.verifyDoctorRegistration(
        doctorName,
        regNumber,
        stateCouncil
      );

      return reply.send({
        success: true,
        doctor: result,
      });
    } catch (err: any) {
      return reply.status(500).send({
        success: false,
        message: err.message || "Doctor registration verification failed",
      });
    }
  });

  // 3. Pharmacy Statutory Compliance Vault (Form GST REG-06, Drug License Form 20/21)
  server.get("/vault", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const store = await getStore(request);
      const docs = DigiLockerService.getComplianceVaultDocuments(
        store.gstin || "24AABCC1234D1Z5",
        store.drugLicenseNo || "G/20B/123456"
      );

      // Also fetch any recorded GST filings in our database
      const filings = await prisma.gstFilingRecord.findMany({
        where: { storeId: store.id },
        orderBy: { taxPeriod: "desc" },
      });

      const filingDocs = filings.map((f) => ({
        id: f.id,
        docType: f.returnType as any,
        title: `${f.returnType} Filing Acknowledgment (${f.taxPeriod})`,
        issuingAuthority: "GST Portal (GSTN)",
        documentNumber: f.arnNumber || "Pending ARN",
        validFrom: f.filingDate ? f.filingDate.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
        status: f.status === "FILED" ? "VERIFIED" : "ACTIVE",
        digilockerUri: f.digilockerDocId || `in.gov.gst.arn/${f.arnNumber || f.id}`,
        fileSize: "118 KB",
        downloadUrl: "#",
      }));

      return reply.send({
        success: true,
        store: {
          name: store.name,
          gstin: store.gstin,
          drugLicenseNo: store.drugLicenseNo,
          digilockerOrgName: store.settings?.digilockerOrgName || store.name,
          digilockerMode: store.settings?.digilockerMode || "SANDBOX",
        },
        documents: [...docs, ...filingDocs],
      });
    } catch (err: any) {
      return reply.status(500).send({
        success: false,
        message: err.message || "Failed to retrieve DigiLocker compliance vault",
      });
    }
  });

  // 4. Push Invoice to Citizen DigiLocker Vault
  server.post("/push-invoice", async (request: FastifyRequest, reply: FastifyReply) => {
    const { invoiceId } = request.body as { invoiceId: string };

    if (!invoiceId) {
      return reply.status(400).send({ success: false, message: "Invoice ID is required" });
    }

    try {
      const invoice = await prisma.salesInvoice.findUnique({
        where: { id: invoiceId },
        include: { customer: true, items: true },
      });

      if (!invoice) {
        return reply.status(404).send({ success: false, message: "Invoice not found" });
      }

      const result = DigiLockerService.pushInvoiceToDigiLocker({
        invoiceNumber: invoice.invoiceNumber,
        customerName: invoice.customer?.name || "Walk-in Retail Customer",
        customerPhone: invoice.customer?.phone || undefined,
        abhaId: invoice.customer?.abhaId || undefined,
        grandTotal: Number(invoice.grandTotal),
        itemsCount: invoice.items.length,
      });

      // Update SalesInvoice with DigiLocker URI
      await prisma.salesInvoice.update({
        where: { id: invoiceId },
        data: {
          digilockerDocUri: result.digilockerUri,
        },
      });

      return reply.send({
        success: true,
        receipt: result,
      });
    } catch (err: any) {
      return reply.status(500).send({
        success: false,
        message: err.message || "Failed to push invoice to DigiLocker",
      });
    }
  });

  // 5. DigiLocker Gateway Status & Configuration
  server.get("/status", async (request: FastifyRequest, reply: FastifyReply) => {
    const store = await getStore(request);
    const settings = store.settings;

    return reply.send({
      success: true,
      enabled: settings?.digilockerEnabled ?? true,
      mode: settings?.digilockerMode || "SANDBOX",
      orgName: settings?.digilockerOrgName || store.name,
      hasCredentials: Boolean(settings?.digilockerClientId && settings?.digilockerClientSecret),
      gatewayStatus: "CONNECTED",
      capabilities: [
        "Patient ABHA ID Verification",
        "Aadhaar Identity Verification",
        "Doctor Registration Verification",
        "Statutory GST REG-06 Vault",
        "Retail Drug License Form 20/21 Vault",
        "Citizen e-Prescription & Invoice Publishing",
      ],
    });
  });

  // 6. Update DigiLocker Settings
  server.put("/config", async (request: FastifyRequest, reply: FastifyReply) => {
    const store = await getStore(request);
    const body = request.body as {
      enabled?: boolean;
      clientId?: string;
      clientSecret?: string;
      orgName?: string;
      mode?: "SANDBOX" | "PRODUCTION";
    };

    await prisma.storeSetting.upsert({
      where: { storeId: store.id },
      create: {
        storeId: store.id,
        digilockerEnabled: body.enabled ?? true,
        digilockerClientId: body.clientId,
        digilockerClientSecret: body.clientSecret,
        digilockerOrgName: body.orgName || store.name,
        digilockerMode: body.mode || "SANDBOX",
      },
      update: {
        digilockerEnabled: body.enabled,
        digilockerClientId: body.clientId,
        digilockerClientSecret: body.clientSecret,
        digilockerOrgName: body.orgName,
        digilockerMode: body.mode,
      },
    });

    return reply.send({
      success: true,
      message: "DigiLocker integration settings updated successfully",
    });
  });
}
