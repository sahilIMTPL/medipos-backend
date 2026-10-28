import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";

export async function categoryRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // 1. List Categories with product count
  server.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const categories = await prisma.category.findMany({
      include: {
        _count: {
          select: { products: true },
        },
      },
      orderBy: { name: "asc" },
    });

    return reply.send({
      success: true,
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description || "",
        isActive: c.isActive,
        productCount: c._count.products,
      })),
    });
  });

  // 2. Create Category
  server.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const { name, description } = request.body as any;

    if (!name || !name.trim()) {
      return reply.status(400).send({ success: false, message: "Category name is required." });
    }

    const existing = await prisma.category.findFirst({
      where: { name: { equals: name.trim(), mode: "insensitive" } },
    });

    if (existing) {
      return reply.status(409).send({ success: false, message: "Category already exists." });
    }

    const category = await prisma.category.create({
      data: {
        name: name.trim(),
        description: description?.trim() || null,
        isActive: true,
      },
    });

    return reply.status(201).send({ success: true, category });
  });

  // 3. Update Category
  server.put("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { name, description, isActive } = request.body as any;

    const updated = await prisma.category.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : undefined,
        description: description !== undefined ? description?.trim() : undefined,
        isActive: isActive !== undefined ? Boolean(isActive) : undefined,
      },
    });

    return reply.send({ success: true, category: updated });
  });

  // 4. Delete Category
  server.delete("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const count = await prisma.product.count({ where: { categoryId: id } });
    if (count > 0) {
      return reply.status(400).send({
        success: false,
        message: `Cannot delete category: ${count} products are assigned to it. Please reassign products first.`,
      });
    }

    await prisma.category.delete({ where: { id } });
    return reply.send({ success: true, message: "Category deleted." });
  });
}
