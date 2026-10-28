import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { resolveStoreTenant } from "../middleware/auth";
import { recordAuditLog } from "./audit-logs.routes";
import { BatchStatus } from "@prisma/client";

export interface PrescribedMedicineItem {
  productId?: string;
  productName: string;
  genericName?: string;
  dosage: string; // e.g. "1 Tablet", "5 ml"
  frequency: string; // e.g. "OD", "BD", "TDS", "QID", "SOS"
  timing: string; // e.g. "After Food", "Before Food"
  duration: string; // e.g. "5 Days", "10 Days", "1 Month"
  quantity: number; // calculated e.g. 10
  instructions?: string;
}

export interface PrescriptionPayloadNotes {
  version: "2.0";
  diagnosis: string;
  symptoms?: string[];
  vitals?: {
    bp?: string;
    pulse?: string;
    temp?: string;
    weight?: string;
    height?: string;
    spo2?: string;
    bloodSugar?: string;
  };
  allergies?: string[];
  clinicalNotes?: string;
  items: PrescribedMedicineItem[];
}

export const REGISTERED_DOCTORS = [
  {
    id: "doc-001",
    name: "Dr. Rajesh Sharma, MD",
    mciNumber: "MCI-48291/2012",
    email: "dr.sharma@medcare.com",
    specialization: "Consultant Physician & Internal Medicine",
    clinicName: "MedCare Multi-Speciality OPD Clinic",
    password: "Doctor@123",
  },
  {
    id: "doc-002",
    name: "Dr. Priya Patel, MBBS, DCH",
    mciNumber: "GMC-32190/2015",
    email: "dr.priya@medcare.com",
    specialization: "Pediatrician & Child Health Specialist",
    clinicName: "Apollo Child Care Clinic",
    password: "Doctor@123",
  },
  {
    id: "doc-003",
    name: "Dr. Vikram Joshi, MS (Ortho)",
    mciNumber: "MCI-59124/2010",
    email: "dr.joshi@medcare.com",
    specialization: "Orthopedic & Joint Replacement Surgeon",
    clinicName: "Joshi Bone & Joint Clinic",
    password: "Doctor@123",
  },
];

export async function doctorRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // 0a. Doctor Login
  server.post("/login", async (request: FastifyRequest, reply: FastifyReply) => {
    const { mciOrEmail, password, storeId } = request.body as any;

    if (!mciOrEmail || !password) {
      return reply.status(400).send({
        success: false,
        message: "Doctor MCI Registration No. or Email and password are required.",
      });
    }

    const cleanInput = mciOrEmail.trim().toLowerCase();
    const doc = REGISTERED_DOCTORS.find(
      (d) =>
        d.mciNumber.toLowerCase() === cleanInput ||
        d.email.toLowerCase() === cleanInput ||
        d.name.toLowerCase().includes(cleanInput)
    );

    if (!doc || doc.password !== password.trim()) {
      return reply.status(401).send({
        success: false,
        message: "Invalid credentials. Please enter a valid Doctor MCI No. / Email and password.",
      });
    }

    // Resolve store
    let targetStore: any = null;
    if (storeId) {
      targetStore = await prisma.store.findUnique({ where: { id: storeId } });
    }
    if (!targetStore) {
      targetStore = await prisma.store.findFirst({ where: { isActive: true } });
    }

    const token = server.jwt.sign({
      doctorId: doc.id,
      name: doc.name,
      mciNumber: doc.mciNumber,
      role: "DOCTOR",
      storeId: targetStore?.id,
    });

    return reply.send({
      success: true,
      message: `Welcome, ${doc.name}`,
      token,
      doctor: {
        id: doc.id,
        name: doc.name,
        mciNumber: doc.mciNumber,
        email: doc.email,
        specialization: doc.specialization,
        clinicName: doc.clinicName,
        storeId: targetStore?.id,
        storeName: targetStore?.name,
      },
    });
  });

  // 0b. List Registered Doctors for Quick-Login
  server.get("/registered-list", async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      success: true,
      doctors: REGISTERED_DOCTORS.map(({ password, ...rest }) => rest),
    });
  });

  // 0c. List Pharmacy Stores for Doctor Selection
  server.get("/stores", async (request: FastifyRequest, reply: FastifyReply) => {
    const stores = await prisma.store.findMany({
      where: { isActive: true },
      select: { id: true, name: true, city: true, phone: true },
    });
    return reply.send({ success: true, stores });
  });

  // 1. Get Live Formulary Medicines with Pharmacy Stock Indicators
  server.get("/medicines", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId, q, limit } = request.query as {
      storeId?: string;
      q?: string;
      limit?: string;
    };

    let targetStoreId: string;
    try {
      targetStoreId = await resolveStoreTenant(request, storeId);
    } catch {
      const fallback = await prisma.store.findFirst({ where: { isActive: true } });
      if (!fallback) return reply.send({ success: true, medicines: [] });
      targetStoreId = fallback.id;
    }

    const now = new Date();
    const where: any = {
      isActive: true,
      OR: [{ storeId: targetStoreId }, { storeId: null }],
    };

    if (q && q.trim()) {
      const search = q.trim();
      where.AND = [
        {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { genericName: { contains: search, mode: "insensitive" } },
            { brandName: { contains: search, mode: "insensitive" } },
          ],
        },
      ];
    }

    const products = await prisma.product.findMany({
      where,
      include: {
        baseUnit: true,
        saleUnit: true,
        conversions: true,
        batches: {
          where: {
            storeId: targetStoreId,
            status: BatchStatus.ACTIVE,
            expiryDate: { gt: now },
            availableQty: { gt: 0 },
          },
          orderBy: { expiryDate: "asc" },
        },
      },
      orderBy: { name: "asc" },
      take: limit ? Number(limit) : 80,
    });

    const medicines = products.map((prod) => {
      const totalBaseQty = prod.batches.reduce(
        (sum, b) => sum + Number(b.availableQty),
        0
      );

      const factor =
        prod.conversions && prod.conversions.length > 0
          ? Number(prod.conversions[0].conversionFactor)
          : 10;

      const packQty = factor > 0 ? Math.floor(totalBaseQty / factor) : totalBaseQty;
      const looseQty = factor > 0 ? totalBaseQty % factor : 0;

      let stockStatus: "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK" = "OUT_OF_STOCK";
      if (totalBaseQty === 0) {
        stockStatus = "OUT_OF_STOCK";
      } else if (totalBaseQty <= (prod.reorderLevel || 15)) {
        stockStatus = "LOW_STOCK";
      } else {
        stockStatus = "IN_STOCK";
      }

      // Earliest expiry batch for FEFO pricing
      const earliestBatch = prod.batches[0] || null;

      return {
        id: prod.id,
        name: prod.name,
        brandName: prod.brandName,
        genericName: prod.genericName,
        strength: prod.strength,
        dosageForm: prod.dosageForm || "Tablet",
        packDescription: prod.packDescription,
        mrp: Number(earliestBatch?.mrp || prod.mrp),
        baseUnit: prod.baseUnit.name,
        saleUnit: prod.saleUnit.name,
        conversionFactor: factor,
        totalBaseQty,
        packQty,
        looseQty,
        stockStatus,
        isPrescriptionRequired: prod.isPrescriptionRequired,
        earliestExpiry: earliestBatch
          ? earliestBatch.expiryDate.toISOString().split("T")[0]
          : null,
      };
    });

    return reply.send({ success: true, count: medicines.length, medicines });
  });

  // 2. Patient Clinical History & Past Prescribed Medicines
  server.get("/patient-history", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId, query: patientQuery, customerId } = request.query as {
      storeId?: string;
      query?: string;
      customerId?: string;
    };

    let targetStoreId: string;
    try {
      targetStoreId = await resolveStoreTenant(request, storeId);
    } catch {
      const fallback = await prisma.store.findFirst({ where: { isActive: true } });
      if (!fallback) return reply.send({ success: true, patient: null });
      targetStoreId = fallback.id;
    }

    if (!patientQuery && !customerId) {
      return reply.status(400).send({
        success: false,
        message: "Customer ID or query (phone/name) is required to fetch patient history.",
      });
    }

    // Locate customer
    let customer: any = null;
    if (customerId) {
      customer = await prisma.customer.findUnique({
        where: { id: customerId },
        include: {
          prescriptions: {
            where: { storeId: targetStoreId },
            include: { salesInvoices: true },
            orderBy: { createdAt: "desc" },
          },
          salesInvoices: {
            where: { storeId: targetStoreId },
            include: {
              items: {
                include: { product: true, saleUnit: true },
              },
            },
            orderBy: { invoiceDate: "desc" },
            take: 20,
          },
        },
      });
    } else if (patientQuery) {
      const clean = patientQuery.trim();
      customer = await prisma.customer.findFirst({
        where: {
          storeId: targetStoreId,
          OR: [
            { phone: { equals: clean } },
            { name: { contains: clean, mode: "insensitive" } },
          ],
        },
        include: {
          prescriptions: {
            where: { storeId: targetStoreId },
            include: { salesInvoices: true },
            orderBy: { createdAt: "desc" },
          },
          salesInvoices: {
            where: { storeId: targetStoreId },
            include: {
              items: {
                include: { product: true, saleUnit: true },
              },
            },
            orderBy: { invoiceDate: "desc" },
            take: 20,
          },
        },
      });
    }

    if (!customer) {
      return reply.send({
        success: true,
        patient: null,
        message: "No patient record found for given query",
      });
    }

    // Extract past diagnoses, allergies, and structured past prescriptions
    const pastVisits: any[] = [];
    const pastMedicinesMap = new Map<string, any>();
    const chronicDiseases = new Set<string>();
    const knownAllergies = new Set<string>();

    for (const rx of customer.prescriptions) {
      let structuredNotes: PrescriptionPayloadNotes | null = null;
      let rawDiagnosis = "";

      if (rx.notes && rx.notes.trim().startsWith("{")) {
        try {
          structuredNotes = JSON.parse(rx.notes);
          if (structuredNotes?.diagnosis) {
            rawDiagnosis = structuredNotes.diagnosis;
            structuredNotes.diagnosis
              .split(/[,;&+]/)
              .map((d) => d.trim())
              .filter(Boolean)
              .forEach((d) => chronicDiseases.add(d));
          }
          if (structuredNotes?.allergies && Array.isArray(structuredNotes.allergies)) {
            structuredNotes.allergies.forEach((a) => knownAllergies.add(a));
          }
        } catch {
          // ignore parsing error
        }
      } else if (rx.notes) {
        rawDiagnosis = rx.notes;
      }

      const items: PrescribedMedicineItem[] = structuredNotes?.items || [];

      // Record medicines in aggregated history
      items.forEach((it) => {
        const key = it.productName.toLowerCase();
        if (!pastMedicinesMap.has(key)) {
          pastMedicinesMap.set(key, {
            productName: it.productName,
            genericName: it.genericName || "",
            lastPrescribedDate: rx.createdAt.toISOString().split("T")[0],
            lastDosage: it.dosage,
            lastFrequency: it.frequency,
            lastTiming: it.timing,
            lastDuration: it.duration,
            doctorName: rx.doctorName,
          });
        }
      });

      pastVisits.push({
        id: rx.id,
        date: rx.createdAt.toISOString().split("T")[0],
        doctorName: rx.doctorName,
        doctorRegNo: rx.doctorRegNo,
        clinicName: rx.clinicName,
        diagnosis: rawDiagnosis || "General Consultation",
        vitals: structuredNotes?.vitals || null,
        symptoms: structuredNotes?.symptoms || [],
        allergies: structuredNotes?.allergies || [],
        clinicalNotes: structuredNotes?.clinicalNotes || "",
        items,
        isDispensed: rx.salesInvoices.length > 0,
      });
    }

    // Also collect any medicines dispensed through sales invoices if not in prescriptions
    for (const inv of customer.salesInvoices) {
      for (const item of inv.items) {
        const key = item.product.name.toLowerCase();
        if (!pastMedicinesMap.has(key)) {
          pastMedicinesMap.set(key, {
            productName: item.product.name,
            genericName: item.product.genericName || "",
            lastPrescribedDate: inv.invoiceDate.toISOString().split("T")[0],
            lastDosage: `Dispensed ${Number(item.quantity)} ${item.saleUnit.name}`,
            lastFrequency: "From Invoice",
            lastTiming: "-",
            lastDuration: "-",
            doctorName: "Pharmacy Direct Sale",
          });
        }
      }
    }

    return reply.send({
      success: true,
      patient: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
        chronicDiseases: Array.from(chronicDiseases),
        allergies: Array.from(knownAllergies),
        totalVisits: customer.prescriptions.length,
        pastVisits,
        previouslyGivenMedicines: Array.from(pastMedicinesMap.values()),
      },
    });
  });

  // 3. Create & Queue Doctor Prescription directly to POS
  server.post("/prescriptions", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      storeId?: string;
      patientName: string;
      patientPhone?: string;
      patientAddress?: string;
      patientAge?: string | number;
      patientGender?: string;
      customerId?: string;
      doctorName: string;
      doctorRegNo?: string;
      clinicName?: string;
      specialization?: string;
      diagnosis: string;
      symptoms?: string[];
      vitals?: {
        bp?: string;
        pulse?: string;
        temp?: string;
        weight?: string;
        height?: string;
        spo2?: string;
        bloodSugar?: string;
      };
      allergies?: string[];
      clinicalNotes?: string;
      items: PrescribedMedicineItem[];
    };

    if (!body.patientName || !body.patientName.trim()) {
      return reply.status(400).send({ success: false, message: "Patient Name is required." });
    }
    if (!body.doctorName || !body.doctorName.trim()) {
      return reply.status(400).send({ success: false, message: "Doctor Name is required." });
    }
    if (!body.items || body.items.length === 0) {
      return reply.status(400).send({ success: false, message: "At least one medicine must be prescribed." });
    }

    let targetStoreId: string;
    try {
      targetStoreId = await resolveStoreTenant(request, body.storeId);
    } catch {
      const fallback = await prisma.store.findFirst({ where: { isActive: true } });
      if (!fallback) return reply.status(400).send({ success: false, message: "No active store found" });
      targetStoreId = fallback.id;
    }

    // Customer resolution or creation
    let customerId = body.customerId;
    const cleanPatientName = body.patientName.trim();
    const cleanPatientPhone = body.patientPhone?.trim() || null;

    if (!customerId) {
      let existingCustomer: any = null;
      if (cleanPatientPhone) {
        existingCustomer = await prisma.customer.findFirst({
          where: { storeId: targetStoreId, phone: cleanPatientPhone },
        });
      }
      if (!existingCustomer) {
        existingCustomer = await prisma.customer.findFirst({
          where: {
            storeId: targetStoreId,
            name: { equals: cleanPatientName, mode: "insensitive" },
          },
        });
      }

      if (existingCustomer) {
        customerId = existingCustomer.id;
      } else {
        const createdCustomer = await prisma.customer.create({
          data: {
            storeId: targetStoreId,
            name: cleanPatientName,
            phone: cleanPatientPhone,
            address: body.patientAddress?.trim() || null,
          },
        });
        customerId = createdCustomer.id;
      }
    }

    // Prepare rich structured notes payload
    const structuredNotes: PrescriptionPayloadNotes = {
      version: "2.0",
      diagnosis: body.diagnosis?.trim() || "General Consultation",
      symptoms: body.symptoms || [],
      vitals: body.vitals || {},
      allergies: body.allergies || [],
      clinicalNotes: body.clinicalNotes?.trim() || "",
      items: body.items,
    };

    const notesJson = JSON.stringify(structuredNotes);

    const prescription = await prisma.prescription.create({
      data: {
        storeId: targetStoreId,
        customerId: customerId || null,
        doctorName: body.doctorName.trim(),
        doctorRegNo: body.doctorRegNo?.trim() || null,
        clinicName: body.clinicName?.trim() || (body.specialization ? `${body.specialization} Clinic` : null),
        prescriptionDate: new Date(),
        notes: notesJson,
      },
      include: {
        customer: true,
      },
    });

    const currentUserId = (request as any).authUser?.userId || (request.user as any)?.userId || null;
    await recordAuditLog({
      storeId: targetStoreId,
      actorId: currentUserId || undefined,
      action: "DOCTOR_CREATE_PRESCRIPTION",
      entity: "Prescription",
      entityId: prescription.id,
      details: {
        doctorName: prescription.doctorName,
        doctorRegNo: prescription.doctorRegNo,
        patientName: cleanPatientName,
        medicinesCount: body.items.length,
        diagnosis: body.diagnosis,
      },
      ipAddress: request.ip,
    });

    return reply.status(201).send({
      success: true,
      message: `Prescription issued for ${cleanPatientName} and beamed directly to Pharmacy POS queue.`,
      prescriptionId: prescription.id,
      rxNumber: `RX-${prescription.createdAt.getFullYear()}-${prescription.id.slice(0, 6).toUpperCase()}`,
      prescription,
    });
  });

  // 4. Pending Doctor Prescriptions Queue (Awaiting POS Billing & Auto-Dispense)
  server.get("/pending-pos-queue", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId } = request.query as { storeId?: string };

    let targetStoreId: string;
    try {
      targetStoreId = await resolveStoreTenant(request, storeId);
    } catch {
      const fallback = await prisma.store.findFirst({ where: { isActive: true } });
      if (!fallback) return reply.send({ success: true, pendingRxList: [] });
      targetStoreId = fallback.id;
    }

    const now = new Date();

    // Prescriptions that have NOT been dispensed yet (salesInvoices.length === 0)
    const pendingPrescriptions = await prisma.prescription.findMany({
      where: {
        storeId: targetStoreId,
        salesInvoices: { none: {} },
      },
      include: {
        customer: true,
      },
      orderBy: { createdAt: "desc" },
      take: 40,
    });

    // Check pharmacy inventory stock in real-time for each prescribed medicine
    const enrichedQueue = await Promise.all(
      pendingPrescriptions.map(async (rx) => {
        let structured: PrescriptionPayloadNotes | null = null;
        let plainMedicines: string[] = [];

        if (rx.notes && rx.notes.trim().startsWith("{")) {
          try {
            structured = JSON.parse(rx.notes);
          } catch {}
        } else if (rx.notes) {
          plainMedicines = rx.notes.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
        }

        const rawItems: PrescribedMedicineItem[] = structured?.items || [];

        // If legacy prescription without structured items, convert plain text lines
        if (rawItems.length === 0 && plainMedicines.length > 0) {
          plainMedicines.forEach((m) => {
            rawItems.push({
              productName: m,
              dosage: "1 Unit",
              frequency: "OD",
              timing: "After Food",
              duration: "5 Days",
              quantity: 5,
            });
          });
        }

        // Live Pharmacy Inventory Match & FEFO evaluation
        const evaluatedItems: Array<
          PrescribedMedicineItem & {
            isAvailable: boolean;
            matchedProductId: string | null;
            availableQty: number;
            feffoBatch: {
              id: string;
              batchNumber: string;
              expiryDate: string;
              mrp: number;
              availableQty: number;
            } | null;
            suggestedSubstitute?: {
              id: string;
              name: string;
              genericName: string;
              mrp: number;
              availableQty: number;
            } | null;
          }
        > = [];

        let availableCount = 0;
        let outOfStockCount = 0;

        for (const it of rawItems) {
          let matchedProduct: any = null;

          if (it.productId) {
            matchedProduct = await prisma.product.findUnique({
              where: { id: it.productId },
              include: {
                baseUnit: true,
                saleUnit: true,
                conversions: true,
                batches: {
                  where: {
                    storeId: targetStoreId,
                    status: BatchStatus.ACTIVE,
                    expiryDate: { gt: now },
                    availableQty: { gt: 0 },
                  },
                  orderBy: { expiryDate: "asc" },
                },
              },
            });
          }

          if (!matchedProduct && it.productName) {
            matchedProduct = await prisma.product.findFirst({
              where: {
                OR: [
                  { name: { equals: it.productName.trim(), mode: "insensitive" } },
                  { name: { contains: it.productName.trim(), mode: "insensitive" } },
                ],
                isActive: true,
              },
              include: {
                baseUnit: true,
                saleUnit: true,
                conversions: true,
                batches: {
                  where: {
                    storeId: targetStoreId,
                    status: BatchStatus.ACTIVE,
                    expiryDate: { gt: now },
                    availableQty: { gt: 0 },
                  },
                  orderBy: { expiryDate: "asc" },
                },
              },
            });
          }

          if (matchedProduct && matchedProduct.batches.length > 0) {
            const earliest = matchedProduct.batches[0];
            const totalStock = matchedProduct.batches.reduce(
              (s: number, b: any) => s + Number(b.availableQty),
              0
            );

            availableCount++;
            evaluatedItems.push({
              ...it,
              productId: matchedProduct.id,
              isAvailable: true,
              matchedProductId: matchedProduct.id,
              availableQty: totalStock,
              feffoBatch: {
                id: earliest.id,
                batchNumber: earliest.batchNumber,
                expiryDate: earliest.expiryDate.toISOString().split("T")[0],
                mrp: Number(earliest.mrp),
                availableQty: Number(earliest.availableQty),
              },
            });
          } else {
            outOfStockCount++;

            // Attempt to find generic substitute with available stock
            let substitute: any = null;
            if (matchedProduct?.genericName || it.genericName) {
              const salt = (matchedProduct?.genericName || it.genericName || "").trim();
              const subProduct = await prisma.product.findFirst({
                where: {
                  storeId: targetStoreId,
                  genericName: { contains: salt, mode: "insensitive" },
                  id: matchedProduct ? { not: matchedProduct.id } : undefined,
                  batches: {
                    some: {
                      storeId: targetStoreId,
                      status: BatchStatus.ACTIVE,
                      expiryDate: { gt: now },
                      availableQty: { gt: 0 },
                    },
                  },
                },
                include: {
                  batches: {
                    where: {
                      storeId: targetStoreId,
                      status: BatchStatus.ACTIVE,
                      expiryDate: { gt: now },
                      availableQty: { gt: 0 },
                    },
                    orderBy: { expiryDate: "asc" },
                  },
                },
              });

              if (subProduct && subProduct.batches.length > 0) {
                substitute = {
                  id: subProduct.id,
                  name: subProduct.name,
                  genericName: subProduct.genericName,
                  mrp: Number(subProduct.batches[0].mrp),
                  availableQty: subProduct.batches.reduce(
                    (s: number, b: any) => s + Number(b.availableQty),
                    0
                  ),
                };
              }
            }

            evaluatedItems.push({
              ...it,
              productId: matchedProduct?.id || it.productId,
              isAvailable: false,
              matchedProductId: matchedProduct?.id || null,
              availableQty: 0,
              feffoBatch: null,
              suggestedSubstitute: substitute,
            });
          }
        }

        return {
          id: rx.id,
          rxNumber: `RX-${rx.createdAt.getFullYear()}-${rx.id.slice(0, 6).toUpperCase()}`,
          createdAt: rx.createdAt.toISOString(),
          timeAgo: formatTimeDifference(rx.createdAt),
          patientName: rx.customer?.name || "Walk-in Patient",
          patientPhone: rx.customer?.phone || "",
          patientAddress: rx.customer?.address || "",
          customerId: rx.customerId,
          doctorName: rx.doctorName,
          doctorRegNo: rx.doctorRegNo || "N/A",
          clinicName: rx.clinicName || "OPD Clinic",
          diagnosis: structured?.diagnosis || rx.notes || "General Consultation",
          vitals: structured?.vitals || null,
          allergies: structured?.allergies || [],
          clinicalNotes: structured?.clinicalNotes || "",
          totalItems: rawItems.length,
          availableCount,
          outOfStockCount,
          isFullyAvailable: outOfStockCount === 0 && availableCount > 0,
          items: evaluatedItems,
        };
      })
    );

    return reply.send({
      success: true,
      count: enrichedQueue.length,
      pendingRxList: enrichedQueue,
    });
  });
}

function formatTimeDifference(date: Date): string {
  const diffSec = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (diffSec < 60) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDays = Math.floor(diffHour / 24);
  return `${diffDays}d ago`;
}
