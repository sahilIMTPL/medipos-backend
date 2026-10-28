import { FastifyRequest, FastifyReply } from "fastify";

interface IdempotencyRecord {
  status: "PROCESSING" | "COMPLETED";
  statusCode?: number;
  response?: any;
  timestamp: number;
}

// In-memory TTL key-value store for active & recently completed idempotency keys
const idempotencyStore = new Map<string, IdempotencyRecord>();

// TTL: 120 seconds (2 minutes)
const IDEMPOTENCY_TTL_MS = 120 * 1000;

// Periodic cleanup of expired keys every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of idempotencyStore.entries()) {
    if (now - record.timestamp > IDEMPOTENCY_TTL_MS) {
      idempotencyStore.delete(key);
    }
  }
}, 60 * 1000).unref(); // unref so it does not prevent node process from exiting

/**
 * Fastify preHandler hook to guard mutating endpoints against concurrent duplicate submissions.
 */
export async function checkIdempotency(request: FastifyRequest, reply: FastifyReply) {
  // Only inspect state-mutating HTTP methods
  if (request.method !== "POST" && request.method !== "PUT" && request.method !== "PATCH") {
    return;
  }

  const idempotencyKey = (
    request.headers["x-idempotency-key"] ||
    request.headers["idempotency-key"]
  ) as string | undefined;

  if (!idempotencyKey || typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    return;
  }

  const cleanKey = idempotencyKey.trim();
  const existingRecord = idempotencyStore.get(cleanKey);

  if (existingRecord) {
    const isExpired = Date.now() - existingRecord.timestamp > IDEMPOTENCY_TTL_MS;

    if (!isExpired) {
      if (existingRecord.status === "PROCESSING") {
        // Multi-click in-flight: block immediately
        reply.header("X-Idempotency-Status", "PROCESSING-CONFLICT");
        return reply.status(409).send({
          success: false,
          isDuplicate: true,
          message: "A transaction with this request key is already in progress. Please wait.",
        });
      }

      if (existingRecord.status === "COMPLETED") {
        // Already executed: return cached response without double-charging or double-deducting
        reply.header("X-Idempotency-Status", "CACHED-REPLAY");
        return reply
          .status(existingRecord.statusCode || 200)
          .send(existingRecord.response);
      }
    } else {
      idempotencyStore.delete(cleanKey);
    }
  }

  // Register state as PROCESSING
  idempotencyStore.set(cleanKey, {
    status: "PROCESSING",
    timestamp: Date.now(),
  });

  // Attach key to request so onSend hook can capture response
  (request as any).idempotencyKey = cleanKey;
}

/**
 * Fastify onSend hook to record successful response for idempotency replay.
 */
export async function recordIdempotentResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: any
) {
  const cleanKey = (request as any).idempotencyKey as string | undefined;
  if (!cleanKey) return payload;

  try {
    let parsed = payload;
    if (typeof payload === "string") {
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = payload;
      }
    }

    // Only cache successful or client-accepted completions (200, 201)
    if (reply.statusCode >= 200 && reply.statusCode < 300) {
      idempotencyStore.set(cleanKey, {
        status: "COMPLETED",
        statusCode: reply.statusCode,
        response: parsed,
        timestamp: Date.now(),
      });
    } else {
      // If the operation failed with 4xx or 5xx, remove the lock so user can retry with valid input
      idempotencyStore.delete(cleanKey);
    }
  } catch (err) {
    console.error("Failed to store idempotent response:", err);
  }

  return payload;
}

