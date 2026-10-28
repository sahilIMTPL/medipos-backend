import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { config } from "../config";

export async function authRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // 1. Login
  server.post("/login", async (request: FastifyRequest, reply: FastifyReply) => {
    const { emailOrUsername, password } = request.body as any;

    if (!emailOrUsername || !password) {
      return reply.status(400).send({
        success: false,
        message: "Email/username and password are required.",
      });
    }

    // Search user by email or username
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: emailOrUsername.trim().toLowerCase() },
          { username: emailOrUsername.trim() },
        ],
      },
      include: {
        storeAssignments: {
          include: {
            store: true,
          },
        },
      },
    });

    // Check account existence and password
    const isPasswordValid = user ? await bcrypt.compare(password, user.passwordHash) : false;

    // Log the authentication attempt
    await prisma.loginEvent.create({
      data: {
        userId: user?.id || null,
        username: emailOrUsername,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] || null,
        isSuccess: Boolean(user && isPasswordValid && user.isActive),
        reason: !user
          ? "User not found"
          : !isPasswordValid
          ? "Invalid password"
          : !user.isActive
          ? "Account inactive"
          : "Successful login",
      },
    });

    if (!user || !isPasswordValid) {
      // Generic error per PRD Section 3.2
      return reply.status(401).send({
        success: false,
        message: "Invalid credentials. Please verify your email/username and password.",
      });
    }

    if (!user.isActive) {
      return reply.status(403).send({
        success: false,
        message: "This account has been deactivated. Please contact platform administrator.",
      });
    }

    // Determine default store
    const defaultAssignment =
      user.storeAssignments.find((a) => a.isDefault) || user.storeAssignments[0];

    const store = defaultAssignment?.store || null;

    // Generate JWT token
    const token = server.jwt.sign({
      userId: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
      storeId: store?.id || null,
    });

    return reply.send({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
      },
      store: store
        ? {
            id: store.id,
            name: store.name,
            code: store.code,
            address: store.address,
            city: store.city,
            gstin: store.gstin,
            drugLicenseNo: store.drugLicenseNo,
          }
        : null,
      assignedStores: user.storeAssignments.map((a) => ({
        id: a.store.id,
        name: a.store.name,
        code: a.store.code,
        city: a.store.city,
        isDefault: a.isDefault,
      })),
    });
  });

  // 2. Get Current Authenticated Profile
  server.get("/me", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const decoded = request.user as any;

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        include: {
          storeAssignments: {
            include: {
              store: true,
            },
          },
        },
      });

      if (!user || !user.isActive) {
        return reply.status(401).send({ success: false, message: "User session expired or invalid" });
      }

      return reply.send({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          fullName: user.fullName,
          role: user.role,
        },
        assignedStores: user.storeAssignments.map((a) => ({
          id: a.store.id,
          name: a.store.name,
          code: a.store.code,
          isDefault: a.isDefault,
        })),
      });
    } catch (err) {
      return reply.status(401).send({ success: false, message: "Invalid authorization token" });
    }
  });

  // 3. Forgot Password (generates single-use signed reset token valid for 15 minutes)
  server.post("/forgot-password", async (request: FastifyRequest, reply: FastifyReply) => {
    const { email } = request.body as any;

    if (!email) {
      return reply.status(400).send({ success: false, message: "Email is required." });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = await prisma.user.findUnique({
      where: { email: cleanEmail },
    });

    let resetToken: string | null = null;

    if (user && user.isActive) {
      // Create cryptographically signed, single-use token tied to current password hash slice
      // If the password changes once, tokenSig immediately changes and invalidates any replay attempt.
      const tokenSig = user.passwordHash.slice(-10);
      resetToken = server.jwt.sign(
        {
          userId: user.id,
          email: user.email,
          purpose: "pwd_reset",
          tokenSig,
        },
        { expiresIn: "15m" }
      );

      await prisma.auditLog.create({
        data: {
          actorId: user.id,
          action: "PASSWORD_RESET_REQUESTED",
          entity: "USER",
          entityId: user.id,
          details: { requestedAt: new Date().toISOString() },
          ipAddress: request.ip,
        },
      });
    }

    return reply.send({
      success: true,
      message: "If the email is registered in MediPOS, recovery instructions have been dispatched.",
      // In development mode or local setups, provide token for test workflows
      resetToken: config.env === "development" ? resetToken : undefined,
    });
  });

  // 4. Reset Password (Requires valid single-use token)
  server.post("/reset-password", async (request: FastifyRequest, reply: FastifyReply) => {
    const { email, newPassword, resetToken } = request.body as any;

    if (!newPassword || newPassword.length < 8) {
      return reply.status(400).send({
        success: false,
        message: "New password must be at least 8 characters long.",
      });
    }

    if (!resetToken) {
      return reply.status(401).send({
        success: false,
        message: "Password reset token is required for security verification.",
      });
    }

    let decoded: any;
    try {
      decoded = server.jwt.verify(resetToken);
    } catch (err: any) {
      return reply.status(401).send({
        success: false,
        message: "Password reset token is invalid or has expired. Please request a new link.",
      });
    }

    if (decoded.purpose !== "pwd_reset" || !decoded.userId) {
      return reply.status(401).send({
        success: false,
        message: "Invalid token purpose.",
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
    });

    if (!user || !user.isActive) {
      return reply.status(404).send({
        success: false,
        message: "Account not found or has been deactivated.",
      });
    }

    // Verify token has not already been used (single-use enforcement)
    const currentSig = user.passwordHash.slice(-10);
    if (decoded.tokenSig !== currentSig) {
      return reply.status(401).send({
        success: false,
        message: "This password reset token has already been used and is no longer valid.",
      });
    }

    const newHash = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash },
    });

    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: "PASSWORD_RESET_COMPLETED",
        entity: "USER",
        entityId: user.id,
        details: { resetAt: new Date().toISOString() },
        ipAddress: request.ip,
      },
    });

    return reply.send({
      success: true,
      message: "Password has been successfully updated. Please login with your new credentials.",
    });
  });

  // 5. Authenticated Change Password
  server.post("/change-password", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ success: false, message: "Authentication required." });
    }

    const authUser = request.user as any;
    const { currentPassword, newPassword } = request.body as any;

    if (!currentPassword || !newPassword) {
      return reply.status(400).send({
        success: false,
        message: "Current password and new password are required.",
      });
    }

    if (newPassword.length < 8) {
      return reply.status(400).send({
        success: false,
        message: "New password must be at least 8 characters long.",
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
    });

    if (!user) {
      return reply.status(404).send({ success: false, message: "User not found." });
    }

    const isCurrentValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isCurrentValid) {
      return reply.status(400).send({ success: false, message: "Incorrect current password." });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash },
    });

    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: "PASSWORD_CHANGED",
        entity: "USER",
        entityId: user.id,
        details: { changedAt: new Date().toISOString() },
        ipAddress: request.ip,
      },
    });

    return reply.send({
      success: true,
      message: "Password successfully updated.",
    });
  });
}
