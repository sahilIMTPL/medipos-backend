import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { Role } from "@prisma/client";

export interface AuthenticatedUserPayload {
  userId: string;
  email: string;
  role: Role;
  fullName: string;
  storeId?: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthenticatedUserPayload;
    storeId?: string;
  }
}

/**
 * Fastify preHandler hook to verify JWT authentication
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    const decoded = await request.jwtVerify<AuthenticatedUserPayload>();
    
    // Check if user account is still active in DB
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, isActive: true, role: true },
    });

    if (!user || !user.isActive) {
      return reply.status(401).send({
        success: false,
        message: "User session is invalid or account has been deactivated.",
      });
    }

    request.authUser = {
      ...decoded,
      role: user.role,
    };
  } catch (err: any) {
    return reply.status(401).send({
      success: false,
      message: "Authentication required. Please provide a valid Bearer token.",
    });
  }
}

/**
 * Role-Based Access Control (RBAC) guard
 */
export function requireRole(allowedRoles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.authUser) {
      return reply.status(401).send({ success: false, message: "Authentication required." });
    }

    if (!allowedRoles.includes(request.authUser.role)) {
      return reply.status(403).send({
        success: false,
        message: `Forbidden: Access restricted to [${allowedRoles.join(", ")}]. Current role: ${request.authUser.role}`,
      });
    }
  };
}

/**
 * Resolves and enforces store tenant boundary for the request.
 * Checks, in order of priority:
 * 1. Explicitly requestedStoreId argument
 * 2. "x-store-id" request header
 * 3. ?storeId query parameter
 * 4. body.storeId payload parameter
 * 5. User's default store assignment
 * 6. First active store fallback
 *
 * Enforces security: Super Admin can access any branch; regular staff can only
 * access stores they are assigned to.
 */
export async function resolveStoreTenant(
  request: FastifyRequest,
  requestedStoreId?: string | null
): Promise<string> {
  const authUser = request.authUser;
  const headerStoreId = (request.headers["x-store-id"] as string) || null;
  const queryStoreId = (request.query as any)?.storeId || null;
  const bodyStoreId = (request.body as any)?.storeId || null;
  const candidateStoreId = requestedStoreId || headerStoreId || queryStoreId || bodyStoreId || null;

  // 1. If Super Admin:
  if (authUser?.role === Role.SUPER_ADMIN) {
    if (candidateStoreId) {
      const store = await prisma.store.findUnique({ where: { id: candidateStoreId } });
      if (store) {
        request.storeId = store.id;
        return store.id;
      }
    }
    const defaultStore = await prisma.store.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
    });
    if (!defaultStore) throw new Error("No active store found in platform.");
    request.storeId = defaultStore.id;
    return defaultStore.id;
  }

  // 2. If Authenticated User (Store Admin, Cashier, Staff):
  if (authUser?.userId) {
    const assignments = await prisma.userStoreAssignment.findMany({
      where: { userId: authUser.userId },
      include: { store: true },
    });

    if (assignments.length === 0) {
      // If user is ADMIN with no explicit assignments, check if candidate exists
      if (authUser.role === Role.ADMIN && candidateStoreId) {
        const store = await prisma.store.findUnique({ where: { id: candidateStoreId } });
        if (store && store.isActive) {
          request.storeId = store.id;
          return store.id;
        }
      }
      throw new Error("User has no assigned medical stores. Contact platform administrator.");
    }

    if (candidateStoreId) {
      const match = assignments.find((a) => a.storeId === candidateStoreId && a.store.isActive);
      if (!match) {
        // Also allow Admin if branch exists
        if (authUser.role === Role.ADMIN) {
          const store = await prisma.store.findUnique({ where: { id: candidateStoreId } });
          if (store && store.isActive) {
            request.storeId = store.id;
            return store.id;
          }
        }
        throw new Error("Access denied: You do not have permissions for the requested store.");
      }
      request.storeId = match.storeId;
      return match.storeId;
    }

    // Default to default store assignment or first active assignment
    const defaultAssignment = assignments.find((a) => a.isDefault && a.store.isActive) || assignments[0];
    request.storeId = defaultAssignment.storeId;
    return defaultAssignment.storeId;
  }

  // 3. Fallback for unauthenticated legacy paths (graceful resolution to requested store or first active store)
  if (candidateStoreId) {
    const store = await prisma.store.findUnique({ where: { id: candidateStoreId } });
    if (store) {
      request.storeId = store.id;
      return store.id;
    }
  }
  const fallback = await prisma.store.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (!fallback) throw new Error("No active medical store available.");
  request.storeId = fallback.id;
  return fallback.id;
}
