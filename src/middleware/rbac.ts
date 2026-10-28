import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { Role } from "@prisma/client";

/**
 * Checks whether a user has a specific permission code for a given store.
 * Super Admin always has full bypass.
 */
export async function checkUserPermission(
  userId: string,
  storeId: string | null | undefined,
  permissionCode: string
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, isActive: true, status: true },
  });

  if (!user || !user.isActive || user.status === "SUSPENDED" || user.status === "EXPIRED") {
    return false;
  }

  // Super Admin has unrestricted access to all permissions
  if (user.role === Role.SUPER_ADMIN) {
    return true;
  }

  // Find user's role definitions for this store (or platform-wide)
  const roleAssignments = await prisma.userRoleAssignment.findMany({
    where: {
      userId,
      OR: [
        { storeId: storeId || undefined },
        { storeId: null },
      ],
    },
    include: {
      role: {
        include: {
          permissions: {
            include: { permission: true },
          },
        },
      },
    },
  });

  // Check if any assigned role contains the permission
  for (const ra of roleAssignments) {
    const hasCode = ra.role.permissions.some((p) => p.permission.code === permissionCode);
    if (hasCode) return true;
  }

  // Fallback: check based on primary User.role enum directly
  const primaryRoleDef = await prisma.roleDefinition.findUnique({
    where: { code: user.role },
    include: {
      permissions: {
        include: { permission: true },
      },
    },
  });

  if (primaryRoleDef) {
    return primaryRoleDef.permissions.some((p) => p.permission.code === permissionCode);
  }

  return false;
}

/**
 * Fastify preHandler guard ensuring the caller has a required permission code.
 */
export function requirePermission(permissionCode: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.status(401).send({ success: false, message: "Authentication required." });
    }

    if (authUser.role === Role.SUPER_ADMIN) {
      return;
    }

    const hasPerm = await checkUserPermission(authUser.userId, request.storeId, permissionCode);
    if (!hasPerm) {
      return reply.status(403).send({
        success: false,
        message: `Forbidden: Missing required permission [${permissionCode}].`,
      });
    }
  };
}

/**
 * Validates whether the acting user is authorized to manage a target user/role according to the User Management Authority Matrix:
 * - Super Admin can manage any user.
 * - Admin can manage Store Admin and Doctor within their assigned stores.
 * - Store Admin can manage Doctor and staff within their single assigned store.
 * - Doctor cannot manage any user.
 */
export async function assertCanManageUser(
  actingUserId: string,
  targetRole: Role,
  targetStoreIds: string[]
): Promise<{ allowed: boolean; reason?: string }> {
  const actor = await prisma.user.findUnique({
    where: { id: actingUserId },
    include: { storeAssignments: true },
  });

  if (!actor || !actor.isActive) {
    return { allowed: false, reason: "Acting user not found or inactive." };
  }

  // 1. Super Admin can manage all users and roles across all stores
  if (actor.role === Role.SUPER_ADMIN) {
    return { allowed: true };
  }

  // 2. Doctor cannot manage any users
  if (actor.role === Role.DOCTOR) {
    return { allowed: false, reason: "Doctors do not have user management privileges." };
  }

  // 3. Store Admin can only manage DOCTOR or store-level users within their SINGLE assigned store
  if (actor.role === Role.STORE_ADMIN) {
    if (targetRole === Role.SUPER_ADMIN || targetRole === Role.ADMIN || targetRole === Role.STORE_ADMIN) {
      return { allowed: false, reason: "Store Admins cannot create or modify administrative roles (Super Admin, Admin, Store Admin)." };
    }

    const actorStoreId = actor.storeAssignments[0]?.storeId;
    if (!actorStoreId) {
      return { allowed: false, reason: "Store Admin is not assigned to any store." };
    }

    const invalidStore = targetStoreIds.some((sId) => sId !== actorStoreId);
    if (invalidStore) {
      return { allowed: false, reason: "Store Admin can only manage users within their own assigned store." };
    }

    return { allowed: true };
  }

  // 4. Admin can manage STORE_ADMIN and DOCTOR across their assigned stores
  if (actor.role === Role.ADMIN) {
    if (targetRole === Role.SUPER_ADMIN || targetRole === Role.ADMIN) {
      return { allowed: false, reason: "Admins cannot create or modify Super Admins or peer Admins." };
    }

    const actorStoreIds = new Set(actor.storeAssignments.map((a) => a.storeId));
    const invalidStore = targetStoreIds.some((sId) => !actorStoreIds.has(sId));
    if (invalidStore) {
      return { allowed: false, reason: "Admin can only manage users within their own assigned stores." };
    }

    return { allowed: true };
  }

  return { allowed: false, reason: "Unauthorized user management attempt." };
}
