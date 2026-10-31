import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { resolveStoreTenant } from "../middleware/auth";
import { recordAuditLog } from "./audit-logs.routes";
import {
  getActiveShift,
  openShift,
  recordCashMovement,
  closeShift,
  computeShiftSummary,
  getShiftZReport,
  getShiftHistory,
} from "../services/shift.service";
import { CashMovementType } from "@prisma/client";

export async function shiftRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // Helper to extract store ID safely
  async function getTargetStoreId(req: FastifyRequest, overrideId?: string): Promise<string> {
    try {
      const qStore = (req.query as any)?.storeId;
      const bStore = (req.body as any)?.storeId;
      return await resolveStoreTenant(req, overrideId || qStore || bStore);
    } catch {
      return (req as any).storeId || "";
    }
  }

  // 1. Get currently open shift for the active store
  server.get("/current", async (request: FastifyRequest, reply: FastifyReply) => {
    const storeId = await getTargetStoreId(request);
    if (!storeId) {
      return reply.status(400).send({ success: false, message: "Store tenant context is required." });
    }

    try {
      const activeShift = await getActiveShift(storeId);
      return reply.send({
        success: true,
        shift: activeShift, // null if no shift open
      });
    } catch (err: any) {
      server.log.error(err, "Failed to get active shift");
      return reply.status(500).send({ success: false, message: err.message || "Failed to get active shift" });
    }
  });

  // 2. Open a new register shift
  server.post("/open", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body || {}) as {
      storeId?: string;
      openingCashFloat?: number;
      openingBankBalance?: number;
      openingNotes?: string;
    };

    const storeId = await getTargetStoreId(request, body.storeId);
    if (!storeId) {
      return reply.status(400).send({ success: false, message: "Store tenant context is required." });
    }

    const currentUserId = (request as any).authUser?.userId || (request as any).user?.userId;
    if (!currentUserId) {
      return reply.status(401).send({ success: false, message: "Authentication required to open shift." });
    }

    const openingCashFloat = Number(body.openingCashFloat || 0);
    if (openingCashFloat < 0) {
      return reply.status(400).send({ success: false, message: "Opening cash float cannot be negative." });
    }

    try {
      const shift = await openShift({
        storeId,
        openedById: currentUserId,
        openingCashFloat,
        openingBankBalance: Number(body.openingBankBalance || 0),
        openingNotes: body.openingNotes,
      });

      await recordAuditLog({
        storeId,
        actorId: currentUserId,
        action: "OPEN_SHIFT",
        entity: "CashRegisterShift",
        entityId: shift.shiftId,
        details: {
          shiftNumber: shift.shiftNumber,
          openingCashFloat,
          openingBankBalance: shift.openingBankBalance,
        },
        ipAddress: request.ip,
      });

      return reply.status(201).send({
        success: true,
        message: `Shift #${shift.shiftNumber} opened successfully with ₹${openingCashFloat.toFixed(2)} opening float.`,
        shift,
      });
    } catch (err: any) {
      return reply.status(400).send({ success: false, message: err.message || "Failed to open shift." });
    }
  });

  // 3. Get live calculated summary for a shift
  server.get("/:id/summary", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    try {
      const summary = await computeShiftSummary(id);
      return reply.send({ success: true, summary });
    } catch (err: any) {
      return reply.status(404).send({ success: false, message: err.message || "Shift not found." });
    }
  });

  // 4. Record petty cash in / cash out / bank drop
  server.post("/cash-movement", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body || {}) as {
      shiftId: string;
      storeId?: string;
      type: CashMovementType;
      amount: number;
      reason: string;
    };

    if (!body.shiftId) {
      return reply.status(400).send({ success: false, message: "shiftId is required." });
    }

    const storeId = await getTargetStoreId(request, body.storeId);
    const currentUserId = (request as any).authUser?.userId || (request as any).user?.userId;
    if (!currentUserId) {
      return reply.status(401).send({ success: false, message: "Authentication required." });
    }

    const amount = Number(body.amount);
    if (!amount || amount <= 0) {
      return reply.status(400).send({ success: false, message: "Amount must be greater than zero." });
    }

    try {
      const movement = await recordCashMovement({
        shiftId: body.shiftId,
        storeId,
        type: body.type,
        amount,
        reason: body.reason,
        createdById: currentUserId,
      });

      await recordAuditLog({
        storeId,
        actorId: currentUserId,
        action: "CASH_MOVEMENT",
        entity: "CashMovement",
        entityId: movement.id,
        details: {
          shiftId: body.shiftId,
          type: body.type,
          amount,
          reason: body.reason,
        },
        ipAddress: request.ip,
      });

      const updatedSummary = await computeShiftSummary(body.shiftId);

      return reply.status(201).send({
        success: true,
        message: `Recorded ${body.type.replace("_", " ")} of ₹${amount.toFixed(2)}.`,
        movement,
        summary: updatedSummary,
      });
    } catch (err: any) {
      return reply.status(400).send({ success: false, message: err.message || "Failed to record cash movement." });
    }
  });

  // 5. Close shift & perform blind cash drawer reconciliation
  server.post("/close", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body || {}) as {
      shiftId: string;
      storeId?: string;
      actualClosingCash: number;
      denominations?: Record<string, number>;
      closingNotes?: string;
    };

    if (!body.shiftId) {
      return reply.status(400).send({ success: false, message: "shiftId is required." });
    }

    const storeId = await getTargetStoreId(request, body.storeId);
    const currentUserId = (request as any).authUser?.userId || (request as any).user?.userId;
    if (!currentUserId) {
      return reply.status(401).send({ success: false, message: "Authentication required to close shift." });
    }

    const actualClosingCash = Number(body.actualClosingCash !== undefined ? body.actualClosingCash : 0);
    if (actualClosingCash < 0) {
      return reply.status(400).send({ success: false, message: "Counted cash cannot be negative." });
    }

    try {
      const closedShift = await closeShift({
        shiftId: body.shiftId,
        storeId,
        closedById: currentUserId,
        actualClosingCash,
        denominations: body.denominations,
        closingNotes: body.closingNotes,
      });

      await recordAuditLog({
        storeId,
        actorId: currentUserId,
        action: "CLOSE_SHIFT",
        entity: "CashRegisterShift",
        entityId: closedShift.shiftId,
        details: {
          shiftNumber: closedShift.shiftNumber,
          expectedCash: closedShift.expectedCash,
          actualClosingCash,
          cashVariance: closedShift.cashVariance,
        },
        ipAddress: request.ip,
      });

      return reply.send({
        success: true,
        message: `Shift #${closedShift.shiftNumber} closed successfully. Variance: ₹${(closedShift.cashVariance || 0).toFixed(2)}`,
        shift: closedShift,
      });
    } catch (err: any) {
      return reply.status(400).send({ success: false, message: err.message || "Failed to close shift." });
    }
  });

  // 6. Get Z-Report formatted printable slip
  server.get("/:id/z-report", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    try {
      const zReport = await getShiftZReport(id);
      return reply.send({ success: true, zReport });
    } catch (err: any) {
      return reply.status(404).send({ success: false, message: err.message || "Z-Report not found." });
    }
  });

  // 7. Get historical shifts for store
  server.get("/history", async (request: FastifyRequest, reply: FastifyReply) => {
    const storeId = await getTargetStoreId(request);
    const { limit = "30" } = request.query as { limit?: string };

    try {
      const shifts = await getShiftHistory(storeId, Number(limit));
      return reply.send({ success: true, shifts });
    } catch (err: any) {
      return reply.status(500).send({ success: false, message: err.message || "Failed to load shift history." });
    }
  });
}
