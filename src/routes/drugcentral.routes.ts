import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { DrugCentralService } from "../services/drugcentral.service";
import { z } from "zod";

export const drugcentralRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  /**
   * Search DrugCentral Master Medicine Catalog
   * GET /api/drugcentral/search?q=amoxicillin
   */
  server.get("/search", async (request, reply) => {
    const querySchema = z.object({
      q: z.string().min(2),
      limit: z.coerce.number().optional().default(25),
    });

    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: "Search query must be at least 2 characters.",
      });
    }

    const { q, limit } = parsed.data;
    const results = await DrugCentralService.searchCatalog(q, limit);

    return reply.send({
      success: true,
      count: results.length,
      medicines: results,
    });
  });

  /**
   * Find Bio-Equivalent Generic Salt Substitutes
   * GET /api/drugcentral/substitutes/:id
   */
  server.get("/substitutes/:id", async (request, reply) => {
    const paramsSchema = z.object({
      id: z.coerce.number(),
    });

    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: "Valid numeric DrugCentral product ID is required.",
      });
    }

    const { id } = parsed.data;
    const substitutes = await DrugCentralService.getSubstitutes(id);

    return reply.send({
      success: true,
      count: substitutes.length,
      substitutes,
    });
  });

  /**
   * Clinical Drug-Drug Interaction (DDI) Checker
   * POST /api/drugcentral/check-interactions
   * Body: { drugs: ["Ciprofloxacin", "Theophylline"] }
   */
  server.post("/check-interactions", async (request, reply) => {
    const bodySchema = z.object({
      drugs: z.array(z.string()).min(2),
    });

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: "Provide an array with at least 2 medicine names to check interactions.",
      });
    }

    const { drugs } = parsed.data;
    const interactions = await DrugCentralService.checkInteractions(drugs);

    return reply.send({
      success: true,
      hasInteractions: interactions.length > 0,
      interactions,
    });
  });

  /**
   * 1-Click Import medicine from DrugCentral into MedicalPOS Inventory Catalog
   * POST /api/drugcentral/import
   * Body: { productId: 1234, storeId?: string, defaultPrice?: 45.0 }
   */
  server.post("/import", async (request, reply) => {
    const bodySchema = z.object({
      productId: z.number(),
      storeId: z.string().optional(),
      defaultPrice: z.number().optional().default(50.0),
    });

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: "Invalid import request parameters.",
      });
    }

    const { productId, storeId, defaultPrice } = parsed.data;
    try {
      const imported = await DrugCentralService.importMedicineToStore(
        productId,
        storeId,
        defaultPrice
      );

      return reply.send({
        success: true,
        message: `Successfully imported "${imported.name}" into inventory catalog.`,
        product: imported,
      });
    } catch (err: any) {
      return reply.code(500).send({
        success: false,
        error: err.message || "Failed to import medicine from DrugCentral.",
      });
    }
  });
};

