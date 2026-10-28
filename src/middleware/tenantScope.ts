import { FastifyRequest, FastifyReply } from "fastify";
import { resolveStoreTenant } from "./auth";

/**
 * Fastify preHandler hook that automatically resolves and scopes the store tenant.
 * Attaches request.storeId from header, query, payload, or user assignment.
 */
export async function tenantScopeHook(request: FastifyRequest, reply: FastifyReply) {
  try {
    const storeId = await resolveStoreTenant(request);
    request.storeId = storeId;
  } catch {
    // Graceful pass-through for non-tenant endpoints like health, auth login, etc.
  }
}

/**
 * Strict guard for endpoints that require a validated, authorized store tenant.
 */
export async function requireStoreTenant(request: FastifyRequest, reply: FastifyReply) {
  try {
    const storeId = await resolveStoreTenant(request);
    request.storeId = storeId;
  } catch (err: any) {
    return reply.status(403).send({
      success: false,
      message: err.message || "Store tenant could not be resolved or access denied.",
    });
  }
}

export { resolveStoreTenant };

