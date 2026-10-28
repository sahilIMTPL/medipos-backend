import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { BatchStatus } from "@prisma/client";
import { cache } from "../services/cache.service";
import { resolveStoreTenant } from "../middleware/auth";

export async function productRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // 1. List Products with search, filtering, and FEFO stock aggregates
  server.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const { storeId, q, categoryId, manufacturer, status } = request.query as {
      storeId?: string;
      q?: string;
      categoryId?: string;
      manufacturer?: string;
      status?: string;
    };

    let activeStoreId: string | null = null;
    try {
      activeStoreId = await resolveStoreTenant(request, storeId);
    } catch {
      activeStoreId = null;
    }

    const cacheKey = `products:${activeStoreId || "all"}:${categoryId || "all"}:${manufacturer || "all"}:${status || "all"}:${q || "all"}`;
    const cached = cache.get<any>(cacheKey);
    if (cached) {
      reply.header("X-Cache-Lookup", "HIT-MEMORY");
      return reply.send(cached);
    }

    const whereConditions: any[] = [];

    if (activeStoreId) {
      whereConditions.push({
        OR: [{ storeId: activeStoreId }, { storeId: null }],
      });
    }

    if (categoryId && categoryId !== "ALL") {
      whereConditions.push({ categoryId });
    }

    if (manufacturer && manufacturer !== "ALL") {
      whereConditions.push({ manufacturer: { equals: manufacturer, mode: "insensitive" } });
    }

    if (status && status !== "ALL") {
      whereConditions.push({ isActive: status === "ACTIVE" });
    }

    if (q) {
      whereConditions.push({
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { genericName: { contains: q, mode: "insensitive" } },
          { brandName: { contains: q, mode: "insensitive" } },
          { barcode: { contains: q } },
          { sku: { contains: q, mode: "insensitive" } },
        ],
      });
    }

    const where: any = whereConditions.length > 0 ? { AND: whereConditions } : {};

    const products = await prisma.product.findMany({
      where,
      include: {
        category: true,
        baseUnit: true,
        purchaseUnit: true,
        saleUnit: true,
        conversions: {
          include: {
            fromUnit: true,
            toUnit: true,
          },
        },
        batches: {
          where: {
            status: BatchStatus.ACTIVE,
            ...(activeStoreId ? { storeId: activeStoreId } : {}),
          },
          orderBy: { expiryDate: "asc" }, // FEFO ordering
        },
      },
      orderBy: { name: "asc" },
      take: 100,
    });

    const responsePayload = {
      success: true,
      total: products.length,
      products: products.map((p) => {
        const totalBaseStock = p.batches.reduce((sum, b) => sum + Number(b.availableQty), 0);
        // Calculate strips/packs if conversion exists
        const stripConversion = p.conversions.find((c) => c.fromUnitId === p.saleUnitId);
        const factor = stripConversion ? Number(stripConversion.conversionFactor) : 1;
        const totalPacks = factor > 0 ? Math.floor(totalBaseStock / factor) : totalBaseStock;

        return {
          id: p.id,
          name: p.name,
          brandName: p.brandName || "",
          genericName: p.genericName || "",
          manufacturer: p.manufacturer || "",
          categoryId: p.categoryId,
          categoryName: p.category?.name || "Uncategorized",
          dosageForm: p.dosageForm || "Tablet",
          strength: p.strength || "",
          packDescription: p.packDescription || "Strip (10)",
          sku: p.sku,
          barcode: p.barcode || "",
          hsnCode: p.hsnCode || "3004",
          gstRate: Number(p.gstRate),
          mrp: Number(p.mrp),
          defaultPurchasePrice: Number(p.defaultPurchasePrice),
          defaultSellingPrice: Number(p.defaultSellingPrice),
          baseUnitId: p.baseUnitId,
          saleUnitId: p.saleUnitId,
          baseUnit: p.baseUnit.name,
          purchaseUnit: p.purchaseUnit.name,
          saleUnit: p.saleUnit.name,
          reorderLevel: p.reorderLevel,
          isPrescriptionRequired: p.isPrescriptionRequired,
          isActive: p.isActive,
          totalBaseStock,
          totalPacks,
          isLowStock: totalBaseStock <= p.reorderLevel,
          batches: p.batches.map((b) => ({
            id: b.id,
            batchNumber: b.batchNumber,
            mfgDate: b.mfgDate ? b.mfgDate.toISOString().split("T")[0] : null,
            expiryDate: b.expiryDate.toISOString().split("T")[0],
            availableQty: Number(b.availableQty),
            mrp: Number(b.mrp),
            purchasePrice: Number(b.purchasePrice),
          })),
          conversions: p.conversions.map((c) => ({
            fromUnit: c.fromUnit.name,
            toUnit: c.toUnit.name,
            factor: Number(c.conversionFactor),
          })),
        };
      }),
    };

    cache.set(cacheKey, responsePayload, 180); // 3-minute TTL
    return reply.send(responsePayload);
  });

  // 2. Distinct Manufacturers list with product counts and valuation
  server.get("/manufacturers", async (request: FastifyRequest, reply: FastifyReply) => {
    const prods = await prisma.product.findMany({
      where: { isActive: true },
      select: {
        manufacturer: true,
        id: true,
        name: true,
        mrp: true,
        batches: {
          where: { status: BatchStatus.ACTIVE },
          select: { availableQty: true },
        },
      },
    });

    const mfgMap = new Map<string, { name: string; productCount: number; inStockCount: number; totalStock: number }>();

    for (const p of prods) {
      const mfgName = p.manufacturer?.trim() || "Unspecified / Generic";
      const totalStock = p.batches.reduce((sum, b) => sum + Number(b.availableQty), 0);
      const existing = mfgMap.get(mfgName) || {
        name: mfgName,
        productCount: 0,
        inStockCount: 0,
        totalStock: 0,
      };

      existing.productCount += 1;
      if (totalStock > 0) existing.inStockCount += 1;
      existing.totalStock += totalStock;
      mfgMap.set(mfgName, existing);
    }

    const sorted = Array.from(mfgMap.values()).sort((a, b) => b.productCount - a.productCount);
    return reply.send({
      success: true,
      manufacturers: sorted.map((m) => m.name),
      details: sorted,
    });
  });

  // Barcode / QR Fast Scanner Lookup
  server.get("/lookup-barcode/:code", async (request: FastifyRequest, reply: FastifyReply) => {
    const { code } = request.params as { code: string };
    const cleanCode = decodeURIComponent(code).trim();

    if (!cleanCode) {
      return reply.status(400).send({ success: false, message: "Barcode or code required" });
    }

    let activeStoreId: string | null = null;
    try {
      activeStoreId = await resolveStoreTenant(request, (request.query as any)?.storeId);
    } catch {
      activeStoreId = null;
    }

    // Parse potential QR format string: barcode|batchNumber|expiryDate|mrp
    const qrTokens = cleanCode.split("|").map((p) => p.trim()).filter(Boolean);
    const primaryToken = qrTokens[0] || cleanCode;
    const secondaryBatchToken = qrTokens[1] || "";
    
    // Build comprehensive barcode candidate variants (handles scanner prefix drops, UPC-A vs EAN-13, and India GS1 890 prefixes)
    const candidateSet = new Set<string>();
    [cleanCode, primaryToken].forEach((tok) => {
      if (!tok) return;
      candidateSet.add(tok);
      
      const stripped = tok.replace(/[\s-_]/g, "");
      if (stripped) {
        candidateSet.add(stripped);
        tok = stripped;
      }

      // 13-digit standard EAN-13 (890...)
      if (tok.length === 13 && tok.startsWith("890")) {
        candidateSet.add(tok.slice(1)); // 90... (12 digits)
        candidateSet.add("99" + tok.slice(3)); // 99... (12 digits)
        candidateSet.add(tok.slice(3)); // 10-digit core
      }
      if (tok.length === 13 && tok.startsWith("0")) {
        candidateSet.add(tok.slice(1));
      }

      // 12-digit scans (UPC-A truncation or prefix shift)
      if (tok.length === 12) {
        candidateSet.add("0" + tok);
        if (tok.startsWith("90")) {
          candidateSet.add("8" + tok); // 890...
          candidateSet.add("99" + tok.slice(2)); // 99...
          candidateSet.add(tok.slice(2)); // 10-digit core
        }
        if (tok.startsWith("99")) {
          candidateSet.add("90" + tok.slice(2)); // 90...
          candidateSet.add("890" + tok.slice(2)); // 890...
          candidateSet.add(tok.slice(2)); // 10-digit core
        }
        if (tok.startsWith("89")) {
          candidateSet.add("890" + tok.slice(2));
        }
      }

      // 11-digit scans (leading 2 digits dropped by scanner buffer or transmission)
      if (tok.length === 11) {
        candidateSet.add("89" + tok);
        if (tok.startsWith("0")) {
          candidateSet.add("89" + tok); // 890...
          candidateSet.add("9" + tok);  // 90...
        }
        if (tok.startsWith("90")) {
          candidateSet.add("8" + tok);
        }
        candidateSet.add("890" + tok.slice(1));
      }

      // 10-digit core scans (first 3 digits 890/900/990 dropped)
      if (tok.length === 10) {
        candidateSet.add("890" + tok);
        candidateSet.add("90" + tok);
        candidateSet.add("99" + tok);
        candidateSet.add("0" + tok);
      }
    });

    const barcodeCandidates = Array.from(candidateSet).filter(Boolean);

    // 1. Check exact match on product barcode or SKU
    let product = await prisma.product.findFirst({
      where: {
        OR: [
          { barcode: { in: barcodeCandidates, mode: "insensitive" } },
          { sku: { in: barcodeCandidates, mode: "insensitive" } },
        ],
      },
      include: {
        category: true,
        baseUnit: true,
        saleUnit: true,
        conversions: {
          include: { fromUnit: true, toUnit: true },
        },
        batches: {
          where: {
            status: BatchStatus.ACTIVE,
            ...(activeStoreId ? { storeId: activeStoreId } : {}),
          },
          orderBy: { expiryDate: "asc" },
        },
      },
    });

    if (product) {
      const totalBaseStock = product.batches.reduce((sum, b) => sum + Number(b.availableQty), 0);
      const stripConversion = product.conversions.find((c) => c.fromUnitId === product?.saleUnitId);
      const factor = stripConversion ? Number(stripConversion.conversionFactor) : 1;
      const totalPacks = factor > 0 ? Math.floor(totalBaseStock / factor) : totalBaseStock;

      return reply.send({
        success: true,
        matchType: "PRODUCT",
        product: {
          id: product.id,
          name: product.name,
          brandName: product.brandName || "",
          genericName: product.genericName || "",
          manufacturer: product.manufacturer || "",
          categoryName: product.category?.name || "Uncategorized",
          dosageForm: product.dosageForm || "Tablet",
          packDescription: product.packDescription || "Strip (10)",
          sku: product.sku,
          barcode: product.barcode || "",
          mrp: Number(product.mrp),
          baseUnit: product.baseUnit.name,
          saleUnit: product.saleUnit.name,
          totalBaseStock,
          totalPacks,
          factor,
          conversions: product.conversions.map((c) => ({
            id: c.id,
            fromUnitId: c.fromUnitId,
            toUnitId: c.toUnitId,
            factor: Number(c.conversionFactor),
            conversionFactor: Number(c.conversionFactor),
          })),
          batches: product.batches.map((b) => ({
            id: b.id,
            batchNumber: b.batchNumber,
            expiryDate: b.expiryDate.toISOString().split("T")[0],
            availableQty: Number(b.availableQty),
            mrp: Number(b.mrp),
            purchasePrice: Number(b.purchasePrice),
          })),
        },
      });
    }

    // 2. Check match on batch number (with clean prefix strip like B:EXP-114 -> EXP-114)
    const batchCandidates = Array.from(
      new Set([
        cleanCode,
        cleanCode.replace(/^(?:B|BAT|BATCH|LOT|BCH):\s*/i, ""),
        secondaryBatchToken,
        secondaryBatchToken.replace(/^(?:B|BAT|BATCH|LOT|BCH):\s*/i, ""),
      ])
    ).filter(Boolean);

    let batch = await prisma.productBatch.findFirst({
      where: {
        batchNumber: { in: batchCandidates, mode: "insensitive" },
        status: BatchStatus.ACTIVE,
        ...(activeStoreId ? { storeId: activeStoreId } : {}),
      },
      include: {
        product: {
          include: {
            category: true,
            baseUnit: true,
            saleUnit: true,
            conversions: { include: { fromUnit: true, toUnit: true } },
            batches: {
              where: {
                status: BatchStatus.ACTIVE,
                ...(activeStoreId ? { storeId: activeStoreId } : {}),
              },
              orderBy: { expiryDate: "asc" },
            },
          },
        },
      },
    });

    if (batch && batch.product) {
      const p = batch.product;
      const totalBaseStock = p.batches.reduce((sum: number, b: any) => sum + Number(b.availableQty), 0);
      const stripConversion = p.conversions.find((c: any) => c.fromUnitId === p.saleUnitId);
      const factor = stripConversion ? Number(stripConversion.conversionFactor) : 1;
      const totalPacks = factor > 0 ? Math.floor(totalBaseStock / factor) : totalBaseStock;

      return reply.send({
        success: true,
        matchType: "BATCH",
        matchedBatch: {
          id: batch.id,
          batchNumber: batch.batchNumber,
          expiryDate: batch.expiryDate.toISOString().split("T")[0],
          availableQty: Number(batch.availableQty),
          mrp: Number(batch.mrp),
          purchasePrice: Number(batch.purchasePrice),
        },
        product: {
          id: p.id,
          name: p.name,
          brandName: p.brandName || "",
          genericName: p.genericName || "",
          manufacturer: p.manufacturer || "",
          categoryName: p.category?.name || "Uncategorized",
          dosageForm: p.dosageForm || "Tablet",
          packDescription: p.packDescription || "Strip (10)",
          sku: p.sku,
          barcode: p.barcode || "",
          mrp: Number(p.mrp),
          baseUnit: p.baseUnit.name,
          saleUnit: p.saleUnit.name,
          totalBaseStock,
          totalPacks,
          factor,
          batches: p.batches.map((b: any) => ({
            id: b.id,
            batchNumber: b.batchNumber,
            expiryDate: b.expiryDate.toISOString().split("T")[0],
            availableQty: Number(b.availableQty),
            mrp: Number(b.mrp),
            purchasePrice: Number(b.purchasePrice),
          })),
        },
      });
    }

    // 3. Fallback: Fuzzy / Contains match on Product Name, Generic Name, or partial Barcode
    const fallbackProduct = await prisma.product.findFirst({
      where: {
        OR: [
          { name: { contains: cleanCode, mode: "insensitive" } },
          { genericName: { contains: cleanCode, mode: "insensitive" } },
          { brandName: { contains: cleanCode, mode: "insensitive" } },
          ...barcodeCandidates.map((c) => ({ barcode: { contains: c } })),
          { sku: { contains: cleanCode, mode: "insensitive" } },
        ],
      },
      include: {
        category: true,
        baseUnit: true,
        saleUnit: true,
        conversions: { include: { fromUnit: true, toUnit: true } },
        batches: {
          where: {
            status: BatchStatus.ACTIVE,
            ...(activeStoreId ? { storeId: activeStoreId } : {}),
          },
          orderBy: { expiryDate: "asc" },
        },
      },
    });

    if (fallbackProduct) {
      const totalBaseStock = fallbackProduct.batches.reduce((sum, b) => sum + Number(b.availableQty), 0);
      const stripConversion = fallbackProduct.conversions.find((c) => c.fromUnitId === fallbackProduct?.saleUnitId);
      const factor = stripConversion ? Number(stripConversion.conversionFactor) : 1;
      const totalPacks = factor > 0 ? Math.floor(totalBaseStock / factor) : totalBaseStock;

      return reply.send({
        success: true,
        matchType: "PRODUCT",
        product: {
          id: fallbackProduct.id,
          name: fallbackProduct.name,
          brandName: fallbackProduct.brandName || "",
          genericName: fallbackProduct.genericName || "",
          manufacturer: fallbackProduct.manufacturer || "",
          categoryName: fallbackProduct.category?.name || "Uncategorized",
          dosageForm: fallbackProduct.dosageForm || "Tablet",
          packDescription: fallbackProduct.packDescription || "Strip (10)",
          sku: fallbackProduct.sku,
          barcode: fallbackProduct.barcode || "",
          mrp: Number(fallbackProduct.mrp),
          baseUnit: fallbackProduct.baseUnit.name,
          saleUnit: fallbackProduct.saleUnit.name,
          totalBaseStock,
          totalPacks,
          factor,
          conversions: fallbackProduct.conversions.map((c) => ({
            id: c.id,
            fromUnitId: c.fromUnitId,
            toUnitId: c.toUnitId,
            factor: Number(c.conversionFactor),
            conversionFactor: Number(c.conversionFactor),
          })),
          batches: fallbackProduct.batches.map((b) => ({
            id: b.id,
            batchNumber: b.batchNumber,
            expiryDate: b.expiryDate.toISOString().split("T")[0],
            availableQty: Number(b.availableQty),
            mrp: Number(b.mrp),
            purchasePrice: Number(b.purchasePrice),
          })),
        },
      });
    }

    return reply.status(404).send({
      success: false,
      notFound: true,
      searchedCode: cleanCode,
      message: `No medicine or batch found matching "${cleanCode}".`,
    });
  });

  // Assign or update barcode for a medicine
  server.post("/assign-barcode", async (request: FastifyRequest, reply: FastifyReply) => {
    const { productId, barcode, storeId } = request.body as { productId: string; barcode: string; storeId?: string };
    if (!productId || !barcode) {
      return reply.status(400).send({
        success: false,
        message: "productId and barcode are required",
      });
    }

    let activeStoreId: string | null = null;
    try {
      activeStoreId = await resolveStoreTenant(request, storeId);
    } catch {
      activeStoreId = null;
    }

    const cleanBarcode = barcode.trim();

    // Check if another product already uses this barcode
    const existing = await prisma.product.findFirst({
      where: {
        barcode: { equals: cleanBarcode, mode: "insensitive" },
        id: { not: productId },
      },
    });

    if (existing) {
      return reply.status(409).send({
        success: false,
        message: `Barcode "${cleanBarcode}" is already assigned to "${existing.name}" (${existing.sku}).`,
      });
    }

    const updated = await prisma.product.update({
      where: { id: productId },
      data: { barcode: cleanBarcode },
      include: {
        category: true,
        baseUnit: true,
        saleUnit: true,
        batches: {
          where: {
            status: BatchStatus.ACTIVE,
            ...(activeStoreId ? { storeId: activeStoreId } : {}),
          },
          orderBy: { expiryDate: "asc" },
        },
      },
    });

    return reply.send({
      success: true,
      message: `Barcode "${cleanBarcode}" successfully assigned to "${updated.name}".`,
      product: updated,
    });
  });

  // Server-side text/image scan helper
  server.post("/decode-server", async (request: FastifyRequest, reply: FastifyReply) => {
    const { text, query } = request.body as { text?: string; query?: string };
    const raw = (text || query || "").trim();
    if (!raw) {
      return reply.status(400).send({ success: false, message: "Search text or barcode required" });
    }

    // Extract potential barcode numbers (8-14 digits)
    const numMatch = raw.match(/\b(890\d{10}|\d{8,14})\b/);
    // Extract potential batch numbers (e.g. EXP-NEAR-114, BAT-500-A)
    const batchMatch = raw.match(/\b(?:B:?|BAT:?)?([A-Z0-9]+-[A-Z0-9-]+)\b/i);

    const candidates = [
      numMatch ? numMatch[1] : null,
      batchMatch ? batchMatch[1] : null,
      raw,
    ].filter(Boolean) as string[];

    for (const code of candidates) {
      const product = await prisma.product.findFirst({
        where: {
          OR: [
            { barcode: { equals: code } },
            { sku: { equals: code, mode: "insensitive" } },
            { name: { contains: code, mode: "insensitive" } },
          ],
        },
        include: {
          category: true,
          baseUnit: true,
          saleUnit: true,
          conversions: { include: { fromUnit: true, toUnit: true } },
          batches: {
            where: { status: BatchStatus.ACTIVE },
            orderBy: { expiryDate: "asc" },
          },
        },
      });

      if (product) {
        const totalBaseStock = product.batches.reduce((sum, b) => sum + Number(b.availableQty), 0);
        const stripConversion = product.conversions.find((c) => c.fromUnitId === product?.saleUnitId);
        const factor = stripConversion ? Number(stripConversion.conversionFactor) : 1;
        const totalPacks = factor > 0 ? Math.floor(totalBaseStock / factor) : totalBaseStock;

        return reply.send({
          success: true,
          matchType: "PRODUCT",
          product: {
            id: product.id,
            name: product.name,
            brandName: product.brandName || "",
            genericName: product.genericName || "",
            manufacturer: product.manufacturer || "",
            categoryName: product.category?.name || "Uncategorized",
            dosageForm: product.dosageForm || "Tablet",
            packDescription: product.packDescription || "Strip (10)",
            sku: product.sku,
            barcode: product.barcode || "",
            mrp: Number(product.mrp),
            baseUnit: product.baseUnit.name,
            saleUnit: product.saleUnit.name,
            totalBaseStock,
            totalPacks,
            factor,
            batches: product.batches.map((b) => ({
              id: b.id,
              batchNumber: b.batchNumber,
              expiryDate: b.expiryDate.toISOString().split("T")[0],
              availableQty: Number(b.availableQty),
              mrp: Number(b.mrp),
              purchasePrice: Number(b.purchasePrice),
            })),
          },
        });
      }
    }

    return reply.status(404).send({ success: false, message: "No medicine matched from server analysis" });
  });

  // 3a. Generic Salt / Active Ingredient Substitute Finder
  server.get("/substitutes/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const targetProduct = await prisma.product.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        genericName: true,
        strength: true,
        dosageForm: true,
        mrp: true,
        storeId: true,
      },
    });

    if (!targetProduct) {
      return reply.status(404).send({ success: false, message: "Target medicine not found" });
    }

    if (!targetProduct.genericName || !targetProduct.genericName.trim()) {
      return reply.send({
        success: true,
        target: targetProduct,
        substitutes: [],
        message: "No generic salt/composition specified for this medicine.",
      });
    }

    // Clean salt name (e.g. "Paracetamol 650mg" -> "Paracetamol", "Cetirizine Hydrochloride" -> "Cetirizine")
    const rawSalt = targetProduct.genericName.trim();
    const cleanedSalt = rawSalt
      .replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|ml|iu|%)\b/gi, "")
      .replace(/\b(tablets?|capsules?|syrup|suspension|injection|ip|bp|usp|hydrochloride|hcl)\b/gi, "")
      .replace(/[\s\-_]+/g, " ")
      .trim();

    const searchSalt = cleanedSalt.length >= 3 ? cleanedSalt : rawSalt;

    const substitutes = await prisma.product.findMany({
      where: {
        id: { not: targetProduct.id },
        isActive: true,
        OR: [
          { genericName: { contains: searchSalt, mode: "insensitive" } },
          { genericName: { contains: rawSalt, mode: "insensitive" } },
        ],
      },
      include: {
        baseUnit: true,
        saleUnit: true,
        conversions: true,
        batches: {
          where: {
            status: BatchStatus.ACTIVE,
            availableQty: { gt: 0 },
            expiryDate: { gt: new Date() },
          },
          orderBy: { expiryDate: "asc" },
        },
      },
      take: 10,
    });

    return reply.send({
      success: true,
      target: targetProduct,
      totalFound: substitutes.length,
      substitutes: substitutes.map((sub) => {
        const totalBaseStock = sub.batches.reduce((sum, b) => sum + Number(b.availableQty), 0);
        const conv = sub.conversions.find((c) => c.fromUnitId === sub.saleUnitId);
        const factor = conv ? Number(conv.conversionFactor) : 1;
        const totalPacks = factor > 0 ? Math.floor(totalBaseStock / factor) : totalBaseStock;

        return {
          id: sub.id,
          name: sub.name,
          brandName: sub.brandName || "",
          genericName: sub.genericName,
          manufacturer: sub.manufacturer || "",
          dosageForm: sub.dosageForm || "Tablet",
          strength: sub.strength || "",
          packDescription: sub.packDescription || "Standard",
          mrp: Number(sub.mrp),
          baseUnit: sub.baseUnit.name,
          saleUnit: sub.saleUnit.name,
          factor,
          totalBaseStock,
          totalPacks,
          inStock: totalBaseStock > 0,
          batches: sub.batches.map((b) => ({
            id: b.id,
            batchNumber: b.batchNumber,
            expiryDate: b.expiryDate.toISOString().split("T")[0],
            availableQty: Number(b.availableQty),
            mrp: Number(b.mrp),
          })),
        };
      }),
    });
  });

  // 3b. Get Single Product by ID
  server.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    let activeStoreId: string | null = null;
    try {
      activeStoreId = await resolveStoreTenant(request, (request.query as any)?.storeId);
    } catch {
      activeStoreId = null;
    }

    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        category: true,
        baseUnit: true,
        purchaseUnit: true,
        saleUnit: true,
        conversions: {
          include: { fromUnit: true, toUnit: true },
        },
        batches: {
          where: {
            ...(activeStoreId ? { storeId: activeStoreId } : {}),
          },
          orderBy: { expiryDate: "asc" },
        },
        stockMovements: {
          where: {
            ...(activeStoreId ? { storeId: activeStoreId } : {}),
          },
          orderBy: { createdAt: "desc" },
          take: 20,
          include: { unit: true, user: true },
        },
      },
    });

    if (!product) {
      return reply.status(404).send({ success: false, message: "Medicine not found" });
    }

    return reply.send({ success: true, product });
  });

  // 4. Create Product with Unit Conversions & Optional Opening Batch
  server.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;

    if (!body.name || !body.sku) {
      return reply.status(400).send({ success: false, message: "Product name and SKU are required." });
    }

    // Default or resolve store
    let storeId = body.storeId;
    if (!storeId) {
      const defaultStore = await prisma.store.findFirst();
      storeId = defaultStore?.id;
    }

    // Resolve or fallback default units (Base: TAB, Purchase: BOX, Sale: STRIP)
    const baseUnit = body.baseUnitId
      ? await prisma.unit.findUnique({ where: { id: body.baseUnitId } })
      : await prisma.unit.findFirst({ where: { isBaseUnit: true } });

    const saleUnit = body.saleUnitId
      ? await prisma.unit.findUnique({ where: { id: body.saleUnitId } })
      : await prisma.unit.findFirst({ where: { code: "STRIP" } }) || baseUnit;

    const purchaseUnit = body.purchaseUnitId
      ? await prisma.unit.findUnique({ where: { id: body.purchaseUnitId } })
      : await prisma.unit.findFirst({ where: { code: "BOX" } }) || baseUnit;

    if (!baseUnit || !saleUnit || !purchaseUnit) {
      return reply.status(400).send({ success: false, message: "Valid units are required." });
    }

    const product = await prisma.product.create({
      data: {
        storeId,
        name: body.name,
        brandName: body.brandName || null,
        genericName: body.genericName || null,
        manufacturer: body.manufacturer || null,
        categoryId: body.categoryId || null,
        dosageForm: body.dosageForm || "Tablet",
        strength: body.strength || null,
        packDescription: body.packDescription || "Strip (10)",
        sku: body.sku,
        barcode: body.barcode || `890${Math.floor(1000000000 + Math.random() * 9000000000)}`,
        hsnCode: body.hsnCode || "30049060",
        gstRate: body.gstRate ? Number(body.gstRate) : 12.0,
        mrp: Number(body.mrp || 0),
        defaultPurchasePrice: Number(body.defaultPurchasePrice || 0),
        defaultSellingPrice: Number(body.defaultSellingPrice || body.mrp || 0),
        baseUnitId: baseUnit.id,
        purchaseUnitId: purchaseUnit.id,
        saleUnitId: saleUnit.id,
        reorderLevel: Number(body.reorderLevel || 15),
        isPrescriptionRequired: Boolean(body.isPrescriptionRequired),
        isActive: true,
      },
    });

    // Add conversion if pack size provided (e.g. 10 tabs per strip)
    const conversionFactor = Number(body.unitsPerPack || 10);
    if (saleUnit.id !== baseUnit.id && conversionFactor > 1) {
      await prisma.productUnitConversion.create({
        data: {
          productId: product.id,
          fromUnitId: saleUnit.id,
          toUnitId: baseUnit.id,
          conversionFactor,
        },
      });
    }

    // Optional: Opening Stock Batch
    if (body.initialBatchNumber && body.initialExpiryDate && Number(body.initialQuantity) > 0) {
      const expDate = new Date(body.initialExpiryDate);
      const qtyInBaseUnits = Number(body.initialQuantity) * conversionFactor;

      await prisma.productBatch.create({
        data: {
          storeId,
          productId: product.id,
          batchNumber: body.initialBatchNumber,
          mfgDate: body.initialMfgDate ? new Date(body.initialMfgDate) : null,
          expiryDate: expDate,
          purchasePrice: Number(body.defaultPurchasePrice || 0) / conversionFactor,
          mrp: Number(body.mrp || 0) / conversionFactor,
          receivedQty: qtyInBaseUnits,
          availableQty: qtyInBaseUnits,
          status: BatchStatus.ACTIVE,
        },
      });
    }

    cache.invalidatePrefix("products:");
    return reply.status(201).send({ success: true, product });
  });

  // 5. Update Product
  server.put("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;

    const updated = await prisma.product.update({
      where: { id },
      data: {
        name: body.name,
        brandName: body.brandName,
        genericName: body.genericName,
        manufacturer: body.manufacturer,
        categoryId: body.categoryId,
        dosageForm: body.dosageForm,
        strength: body.strength,
        packDescription: body.packDescription,
        barcode: body.barcode,
        hsnCode: body.hsnCode,
        gstRate: body.gstRate ? Number(body.gstRate) : undefined,
        mrp: body.mrp ? Number(body.mrp) : undefined,
        defaultPurchasePrice: body.defaultPurchasePrice ? Number(body.defaultPurchasePrice) : undefined,
        defaultSellingPrice: body.defaultSellingPrice ? Number(body.defaultSellingPrice) : undefined,
        reorderLevel: body.reorderLevel ? Number(body.reorderLevel) : undefined,
        isPrescriptionRequired: body.isPrescriptionRequired !== undefined ? Boolean(body.isPrescriptionRequired) : undefined,
        isActive: body.isActive !== undefined ? Boolean(body.isActive) : undefined,
      },
    });

    cache.invalidatePrefix("products:");
    return reply.send({ success: true, product: updated });
  });

  // 6. Delete or Deactivate Product
  server.delete("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    // Soft deactivate per PRD to maintain posted invoice integrity
    const deactivated = await prisma.product.update({
      where: { id },
      data: { isActive: false },
    });

    cache.invalidatePrefix("products:");
    return reply.send({ success: true, message: "Product deactivated", product: deactivated });
  });
}
