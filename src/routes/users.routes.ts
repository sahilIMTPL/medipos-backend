import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { Role, AccountStatus } from "@prisma/client";
import { authenticate } from "../middleware/auth";
import { assertCanManageUser } from "../middleware/rbac";

export async function usersRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // Apply JWT authentication to all user management routes
  server.addHook("preHandler", authenticate);

  // 1. List Users governed by role hierarchy
  server.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const authUser = request.authUser!;
    const { storeId, role, status, q } = request.query as {
      storeId?: string;
      role?: string;
      status?: string;
      q?: string;
    };

    try {
      const where: any = {};

      // Role Hierarchy Scoping:
      if (authUser.role === Role.SUPER_ADMIN) {
        // Super Admin can view all users, with optional filter by storeId
        if (storeId) {
          where.storeAssignments = { some: { storeId } };
        }
      } else if (authUser.role === Role.ADMIN) {
        // Multi-Store Admin: only users assigned to their own stores
        const myStores = await prisma.userStoreAssignment.findMany({
          where: { userId: authUser.userId },
          select: { storeId: true },
        });
        const myStoreIds = myStores.map((s) => s.storeId);
        where.storeAssignments = { some: { storeId: { in: myStoreIds } } };
      } else if (authUser.role === Role.STORE_ADMIN) {
        // Store Admin: strictly users assigned to their single store
        const myStore = await prisma.userStoreAssignment.findFirst({
          where: { userId: authUser.userId },
          select: { storeId: true },
        });
        if (!myStore) {
          return reply.send({ success: true, users: [] });
        }
        where.storeAssignments = { some: { storeId: myStore.storeId } };
      } else {
        // Doctor has no user management access
        return reply.status(403).send({
          success: false,
          message: "Doctors do not have permissions to view user accounts.",
        });
      }

      if (role && role !== "ALL") {
        where.role = role as Role;
      }

      if (status && status !== "ALL") {
        where.status = status as AccountStatus;
      }

      if (q) {
        where.OR = [
          { fullName: { contains: q, mode: "insensitive" } },
          { username: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
          { phone: { contains: q } },
        ];
      }

      const users = await prisma.user.findMany({
        where,
        select: {
          id: true,
          username: true,
          email: true,
          fullName: true,
          phone: true,
          role: true,
          status: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
          storeAssignments: {
            include: {
              store: {
                select: {
                  id: true,
                  name: true,
                  code: true,
                  city: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      return reply.send({
        success: true,
        total: users.length,
        users: users.map((u) => ({
          ...u,
          stores: u.storeAssignments.map((a) => a.store),
        })),
      });
    } catch (err: any) {
      server.log.error(err, "Failed to list users");
      return reply.status(500).send({
        success: false,
        message: err.message || "Failed to list users",
      });
    }
  });

  // 2. Create User (enforces User Management Authority Matrix)
  server.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const authUser = request.authUser!;
    const {
      fullName,
      email,
      username,
      password,
      phone,
      role = Role.STORE_ADMIN,
      storeIds = [],
    } = request.body as any;

    if (!fullName || !fullName.trim()) {
      return reply.status(400).send({ success: false, message: "Full name is required." });
    }
    if (!email || !email.trim()) {
      return reply.status(400).send({ success: false, message: "Email address is required." });
    }
    if (!username || !username.trim()) {
      return reply.status(400).send({ success: false, message: "Username is required." });
    }
    if (!password || password.length < 6) {
      return reply.status(400).send({ success: false, message: "Password must be at least 6 characters." });
    }

    // Role-specific store requirements:
    // Store Admin must be assigned to strictly ONE store
    if (role === Role.STORE_ADMIN && (!storeIds || storeIds.length !== 1)) {
      return reply.status(400).send({
        success: false,
        message: "Store Admin must be assigned to strictly ONE store branch.",
      });
    }

    // Doctor must be assigned to at least one store
    if (role === Role.DOCTOR && (!storeIds || storeIds.length === 0)) {
      return reply.status(400).send({
        success: false,
        message: "Doctor must be assigned to at least one clinic or store branch.",
      });
    }

    // Check authority to create this role in these stores
    const authCheck = await assertCanManageUser(authUser.userId, role as Role, storeIds);
    if (!authCheck.allowed) {
      return reply.status(403).send({
        success: false,
        message: authCheck.reason || "Forbidden: You cannot create this role.",
      });
    }

    // Check unique email / username
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email: email.trim().toLowerCase() },
          { username: username.trim() },
        ],
      },
    });

    if (existing) {
      return reply.status(409).send({
        success: false,
        message: existing.email.toLowerCase() === email.trim().toLowerCase()
          ? "A user with this email already exists."
          : "A user with this username already exists.",
      });
    }

    try {
      const passwordHash = await bcrypt.hash(password, 10);

      const newUser = await prisma.user.create({
        data: {
          fullName: fullName.trim(),
          email: email.trim().toLowerCase(),
          username: username.trim(),
          passwordHash,
          phone: phone?.trim() || null,
          role: role as Role,
          status: AccountStatus.ACTIVE,
          isActive: true,
          storeAssignments: {
            create: storeIds.map((storeId: string, idx: number) => ({
              storeId,
              isDefault: idx === 0,
            })),
          },
        },
        include: {
          storeAssignments: {
            include: { store: true },
          },
        },
      });

      // Link to roleDefinition
      const roleDef = await prisma.roleDefinition.findUnique({ where: { code: role } });
      if (roleDef) {
        for (const storeId of storeIds) {
          await prisma.userRoleAssignment.create({
            data: {
              userId: newUser.id,
              roleId: roleDef.id,
              storeId,
            },
          });
        }
      }

      return reply.status(201).send({
        success: true,
        message: `User "${newUser.fullName}" successfully created with role [${newUser.role}].`,
        user: {
          id: newUser.id,
          fullName: newUser.fullName,
          username: newUser.username,
          email: newUser.email,
          role: newUser.role,
          status: newUser.status,
          stores: newUser.storeAssignments.map((a) => a.store),
        },
      });
    } catch (err: any) {
      server.log.error(err, "Failed to create user");
      return reply.status(500).send({
        success: false,
        message: err.message || "Failed to create user account",
      });
    }
  });

  // 3. Update User
  server.put("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const authUser = request.authUser!;
    const { id } = request.params as { id: string };
    const { fullName, email, phone, role, password, storeIds } = request.body as any;

    const targetUser = await prisma.user.findUnique({
      where: { id },
      include: { storeAssignments: true },
    });

    if (!targetUser) {
      return reply.status(404).send({ success: false, message: "User not found." });
    }

    const targetStoreIds = storeIds || targetUser.storeAssignments.map((a) => a.storeId);
    const newRole = (role as Role) || targetUser.role;

    const authCheck = await assertCanManageUser(authUser.userId, newRole, targetStoreIds);
    if (!authCheck.allowed) {
      return reply.status(403).send({
        success: false,
        message: authCheck.reason || "Forbidden: You cannot modify this user.",
      });
    }

    // Role-specific constraint check
    if (newRole === Role.STORE_ADMIN && targetStoreIds.length !== 1) {
      return reply.status(400).send({
        success: false,
        message: "Store Admin must be assigned to strictly ONE store branch.",
      });
    }

    try {
      let passwordHash: string | undefined = undefined;
      if (password && password.trim()) {
        if (password.length < 6) {
          return reply.status(400).send({ success: false, message: "Password must be at least 6 characters." });
        }
        passwordHash = await bcrypt.hash(password.trim(), 10);
      }

      // Update user details
      const updated = await prisma.user.update({
        where: { id },
        data: {
          fullName: fullName !== undefined ? fullName.trim() : undefined,
          email: email !== undefined ? email.trim().toLowerCase() : undefined,
          phone: phone !== undefined ? phone.trim() || null : undefined,
          role: role !== undefined ? (role as Role) : undefined,
          passwordHash,
        },
        include: {
          storeAssignments: { include: { store: true } },
        },
      });

      // If storeIds are explicitly updated
      if (Array.isArray(storeIds)) {
        await prisma.userStoreAssignment.deleteMany({ where: { userId: id } });
        await prisma.userRoleAssignment.deleteMany({ where: { userId: id } });

        for (let i = 0; i < storeIds.length; i++) {
          await prisma.userStoreAssignment.create({
            data: {
              userId: id,
              storeId: storeIds[i],
              isDefault: i === 0,
            },
          });
        }

        const roleDef = await prisma.roleDefinition.findUnique({ where: { code: updated.role } });
        if (roleDef) {
          for (const sId of storeIds) {
            await prisma.userRoleAssignment.create({
              data: {
                userId: id,
                roleId: roleDef.id,
                storeId: sId,
              },
            });
          }
        }
      }

      return reply.send({
        success: true,
        message: "User account updated successfully.",
        user: updated,
      });
    } catch (err: any) {
      server.log.error(err, "Failed to update user");
      return reply.status(500).send({
        success: false,
        message: err.message || "Failed to update user account",
      });
    }
  });

  // 4. Update User Lifecycle Status (ACTIVE / SUSPENDED / EXPIRED)
  server.put("/:id/status", async (request: FastifyRequest, reply: FastifyReply) => {
    const authUser = request.authUser!;
    const { id } = request.params as { id: string };
    const { status } = request.body as { status: AccountStatus };

    if (!status || !Object.values(AccountStatus).includes(status)) {
      return reply.status(400).send({ success: false, message: "Valid status is required." });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id },
      include: { storeAssignments: true },
    });

    if (!targetUser) {
      return reply.status(404).send({ success: false, message: "User not found." });
    }

    const targetStoreIds = targetUser.storeAssignments.map((a) => a.storeId);
    const authCheck = await assertCanManageUser(authUser.userId, targetUser.role, targetStoreIds);
    if (!authCheck.allowed) {
      return reply.status(403).send({
        success: false,
        message: authCheck.reason || "Forbidden: You cannot change status for this user.",
      });
    }

    const isActive = status === AccountStatus.ACTIVE;

    const updated = await prisma.user.update({
      where: { id },
      data: {
        status,
        isActive,
      },
    });

    return reply.send({
      success: true,
      message: `User "${updated.fullName}" status updated to ${updated.status}.`,
      user: updated,
    });
  });

  // 5. Get Available Roles & Permissions Matrix
  server.get("/roles", async (request: FastifyRequest, reply: FastifyReply) => {
    const roles = await prisma.roleDefinition.findMany({
      include: {
        permissions: {
          include: { permission: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return reply.send({
      success: true,
      roles: roles.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        permissions: r.permissions.map((p) => p.permission.code),
      })),
    });
  });
}
