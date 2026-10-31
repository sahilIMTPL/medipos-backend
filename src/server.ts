import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config";
import { prisma } from "./db";
import { authRoutes } from "./routes/auth.routes";
import { dashboardRoutes } from "./routes/dashboard.routes";
import { storeRoutes } from "./routes/stores.routes";
import { productRoutes } from "./routes/products.routes";
import { categoryRoutes } from "./routes/categories.routes";
import { unitRoutes } from "./routes/units.routes";
import { supplierRoutes } from "./routes/suppliers.routes";
import { purchaseRoutes } from "./routes/purchases.routes";
import { batchRoutes } from "./routes/batches.routes";
import { salesRoutes } from "./routes/sales.routes";
import { customerRoutes } from "./routes/customers.routes";
import { salesReturnsRoutes } from "./routes/sales-returns.routes";
import { purchaseReturnsRoutes } from "./routes/purchase-returns.routes";
import { inventoryRoutes } from "./routes/inventory.routes";
import { reportsRoutes } from "./routes/reports.routes";
import { notificationsRoutes } from "./routes/notifications.routes";
import { auditLogsRoutes, recordAuditLog } from "./routes/audit-logs.routes";
import { superAdminRoutes } from "./routes/super-admin.routes";
import { usersRoutes } from "./routes/users.routes";
import { shiftRoutes } from "./routes/shifts.routes";
import { prescriptionRoutes } from "./routes/prescriptions.routes";
import { doctorRoutes } from "./routes/doctor.routes";
import { gstRoutes } from "./routes/gst.routes";
import { digilockerRoutes } from "./routes/digilocker.routes";
import { accountingRoutes } from "./routes/accounting.routes";
import { drugcentralRoutes } from "./routes/drugcentral.routes";
import { checkIdempotency, recordIdempotentResponse } from "./middleware/idempotency";
import { tenantScopeHook } from "./middleware/tenantScope";
import { taskQueue } from "./services/asyncQueue.service";
import {
  postSalesInvoiceJournalEntry,
  postPurchaseInvoiceJournalEntry,
} from "./services/accounting.service";

export async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({
    logger: {
      level: config.env === "development" ? "info" : "warn",
    },
  });

  // Enable CORS
  await server.register(cors, {
    origin: (origin, cb) => {
      cb(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  // Enable JWT
  await server.register(jwt, {
    secret: config.jwtSecret,
  });

  // Enable Rate Limiting (High-Traffic DoS Protection)
  await server.register(rateLimit, {
    max: 600, // 600 requests per minute per IP
    timeWindow: "1 minute",
    allowList: ["127.0.0.1", "localhost"],
  });

  // Register background task queue worker handlers
  taskQueue.registerHandler("RECORD_AUDIT_LOG", async (payload) => {
    await recordAuditLog(payload);
  });
  taskQueue.registerHandler("POST_SALES_JOURNAL", async (payload) => {
    await postSalesInvoiceJournalEntry(payload.invoiceId);
  });
  taskQueue.registerHandler("POST_PURCHASE_JOURNAL", async (payload) => {
    await postPurchaseInvoiceJournalEntry(payload.purchaseId);
  });

  // Health check endpoint
  server.get("/api/health", async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return {
        status: "healthy",
        uptime: process.uptime(),
        database: "connected (PostgreSQL 16)",
        timestamp: new Date().toISOString(),
      };
    } catch (err: any) {
      server.log.error(err, "Database health check failed");
      return {
        status: "degraded",
        uptime: process.uptime(),
        database: "disconnected",
        error: err.message,
        timestamp: new Date().toISOString(),
      };
    }
  });

  // Global JWT Token Parsing Hook (attaches authUser if token is present)
  server.addHook("preHandler", async (request) => {
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const decoded = await request.jwtVerify<any>();
        (request as any).authUser = decoded;
      } catch {
        // Token invalid or expired - request.authUser remains undefined
      }
    }
  });

  // Global Store Tenant Resolution Hook (automatically extracts & scopes x-store-id)
  server.addHook("preHandler", tenantScopeHook);

  // Global Idempotency Hooks (Double-submission & multi-click concurrency guard)
  server.addHook("preHandler", checkIdempotency);
  server.addHook("onSend", recordIdempotentResponse);

  // Register API Routes
  await server.register(authRoutes, { prefix: "/api/auth" });
  await server.register(dashboardRoutes, { prefix: "/api/dashboard" });
  await server.register(storeRoutes, { prefix: "/api/stores" });
  await server.register(productRoutes, { prefix: "/api/products" });
  await server.register(categoryRoutes, { prefix: "/api/categories" });
  await server.register(unitRoutes, { prefix: "/api/units" });
  await server.register(supplierRoutes, { prefix: "/api/suppliers" });
  await server.register(purchaseRoutes, { prefix: "/api/purchases" });
  await server.register(batchRoutes, { prefix: "/api/batches" });
  await server.register(salesRoutes, { prefix: "/api/sales" });
  await server.register(customerRoutes, { prefix: "/api/customers" });
  await server.register(prescriptionRoutes, { prefix: "/api/prescriptions" });
  await server.register(doctorRoutes, { prefix: "/api/doctor" });
  await server.register(salesReturnsRoutes, { prefix: "/api/sales-returns" });
  await server.register(purchaseReturnsRoutes, { prefix: "/api/purchase-returns" });
  await server.register(inventoryRoutes, { prefix: "/api/inventory" });
  await server.register(reportsRoutes, { prefix: "/api/reports" });
  await server.register(gstRoutes, { prefix: "/api/gst" });
  await server.register(digilockerRoutes, { prefix: "/api/digilocker" });
  await server.register(accountingRoutes, { prefix: "/api/accounting" });
  await server.register(drugcentralRoutes, { prefix: "/api/drugcentral" });
  await server.register(notificationsRoutes, { prefix: "/api/notifications" });
  await server.register(auditLogsRoutes, { prefix: "/api/audit-logs" });
  await server.register(superAdminRoutes, { prefix: "/api/super-admin" });
  await server.register(usersRoutes, { prefix: "/api/users" });
  await server.register(shiftRoutes, { prefix: "/api/shifts" });

  // Global Error Handler
  server.setErrorHandler((error, request, reply) => {
    server.log.error(error);
    const statusCode = error.statusCode || 500;
    reply.status(statusCode).send({
      success: false,
      error: error.name || "InternalServerError",
      message: error.message || "An unexpected error occurred",
    });
  });

  return server;
}
