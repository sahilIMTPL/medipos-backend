import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";

export async function unitRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // 1. List all Units
  server.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const units = await prisma.unit.findMany({
      orderBy: { name: "asc" },
    });
    return reply.send({ success: true, units });
  });

  // 2. Create Unit
  server.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const { name, code, isBaseUnit } = request.body as any;

    if (!name || !code) {
      return reply.status(400).send({ success: false, message: "Unit name and code are required." });
    }

    const unit = await prisma.unit.create({
      data: {
        name: name.trim(),
        code: code.trim().toUpperCase(),
        isBaseUnit: Boolean(isBaseUnit),
      },
    });

    return reply.status(201).send({ success: true, unit });
  });

  // 3. List Unit Conversions
  server.get("/conversions", async (request: FastifyRequest, reply: FastifyReply) => {
    const conversions = await prisma.productUnitConversion.findMany({
      include: {
        product: { select: { id: true, name: true, sku: true } },
        fromUnit: true,
        toUnit: true,
      },
      orderBy: { product: { name: "asc" } },
    });

    return reply.send({
      success: true,
      conversions: conversions.map((c) => ({
        id: c.id,
        productId: c.productId,
        productName: c.product.name,
        sku: c.product.sku,
        fromUnit: c.fromUnit.name,
        toUnit: c.toUnit.name,
        factor: Number(c.conversionFactor),
      })),
    });
  });

  // 4. Add/Update Unit Conversion for a Product
  server.post("/conversions", async (request: FastifyRequest, reply: FastifyReply) => {
    const { productId, fromUnitId, toUnitId, conversionFactor } = request.body as any;

    if (!productId || !fromUnitId || !toUnitId || !conversionFactor) {
      return reply.status(400).send({
        success: false,
        message: "productId, fromUnitId, toUnitId and conversionFactor are required.",
      });
    }

    const conversion = await prisma.productUnitConversion.upsert({
      where: {
        productId_fromUnitId_toUnitId: {
          productId,
          fromUnitId,
          toUnitId,
        },
      },
      update: {
        conversionFactor: Number(conversionFactor),
      },
      create: {
        productId,
        fromUnitId,
        toUnitId,
        conversionFactor: Number(conversionFactor),
      },
      include: {
        product: { select: { name: true } },
        fromUnit: true,
        toUnit: true,
      },
    });

    return reply.send({ success: true, conversion });
  });
}
