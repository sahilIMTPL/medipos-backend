import { prisma } from "../db";
import { CashMovementType, PaymentMethod, PaymentStatus, ShiftStatus } from "@prisma/client";

export interface DenominationBreakdown {
  [key: string]: number; // e.g. "500": 8, "200": 10, "100": 25, ...
}

export interface ShiftLiveSummary {
  shiftId: string;
  shiftNumber: number;
  status: ShiftStatus;
  openedAt: Date;
  closedAt: Date | null;
  openedBy: {
    id: string;
    fullName: string;
    email: string;
  };
  closedBy?: {
    id: string;
    fullName: string;
    email: string;
  } | null;
  openingCashFloat: number;
  openingBankBalance: number;
  openingNotes: string | null;

  // Real-time calculated counters
  invoiceCount: number;
  totalCashSales: number;
  totalUpiSales: number;
  totalCardSales: number;
  totalCreditSales: number;
  totalSalesRevenue: number;

  totalCustomerDuesCash: number;
  totalCustomerDuesBank: number;

  totalSupplierPaidCash: number;
  totalSupplierPaidBank: number;

  totalCashIn: number;
  totalCashOut: number;
  totalBankDrop: number;
  totalCashRefunds: number;

  expectedCash: number;
  expectedBank: number;

  // Final figures if closed
  actualClosingCash?: number;
  cashVariance?: number;
  denominations?: any;
  closingNotes?: string | null;

  recentMovements: Array<{
    id: string;
    type: CashMovementType;
    amount: number;
    reason: string;
    createdAt: Date;
  }>;
}

/**
 * Calculates live shift totals and expected drawer/bank balances
 */
export async function computeShiftSummary(shiftId: string): Promise<ShiftLiveSummary> {
  const shift = await prisma.cashRegisterShift.findUnique({
    where: { id: shiftId },
    include: {
      openedBy: { select: { id: true, fullName: true, email: true } },
      closedBy: { select: { id: true, fullName: true, email: true } },
      movements: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!shift) {
    throw new Error("Shift not found.");
  }

  const shiftStart = shift.openedAt;
  const shiftEnd = shift.closedAt || new Date();

  // 1. Fetch Sales Invoices linked directly to this shift or within shift timeframe
  const sales = await prisma.salesInvoice.findMany({
    where: {
      storeId: shift.storeId,
      OR: [
        { shiftId: shift.id },
        {
          createdAt: {
            gte: shiftStart,
            lte: shiftEnd,
          },
        },
      ],
      status: { not: "CANCELLED" },
    },
    select: {
      id: true,
      paymentMethod: true,
      grandTotal: true,
      paidAmount: true,
      changeAmount: true,
      paymentStatus: true,
    },
  });

  let totalCashSales = 0;
  let totalUpiSales = 0;
  let totalCardSales = 0;
  let totalCreditSales = 0;
  let totalSalesRevenue = 0;

  for (const s of sales) {
    const total = Number(s.grandTotal);
    const paid = Number(s.paidAmount);
    totalSalesRevenue += total;

    if (s.paymentMethod === PaymentMethod.CASH) {
      totalCashSales += paid;
    } else if (s.paymentMethod === PaymentMethod.UPI) {
      totalUpiSales += paid;
    } else if (s.paymentMethod === PaymentMethod.CARD) {
      totalCardSales += paid;
    } else if (s.paymentMethod === PaymentMethod.CREDIT) {
      totalCreditSales += total;
    } else if (s.paymentMethod === PaymentMethod.SPLIT) {
      // In split tender, attribute paid portion to cash and rest to digital
      totalCashSales += paid;
      totalUpiSales += Math.max(0, total - paid);
    }
  }

  // 2. Fetch Supplier / Vendor Payments during this shift
  const supplierPayments = await prisma.supplierPayment.findMany({
    where: {
      storeId: shift.storeId,
      createdAt: {
        gte: shiftStart,
        lte: shiftEnd,
      },
    },
    select: {
      amount: true,
      paymentMethod: true,
    },
  });

  let totalSupplierPaidCash = 0;
  let totalSupplierPaidBank = 0;
  for (const sp of supplierPayments) {
    const amt = Number(sp.amount);
    if (sp.paymentMethod === PaymentMethod.CASH) {
      totalSupplierPaidCash += amt;
    } else {
      totalSupplierPaidBank += amt;
    }
  }

  // 3. Fetch Cash Movements (Cash In, Cash Out / Petty Expense, Bank Drop)
  let totalCashIn = 0;
  let totalCashOut = 0;
  let totalBankDrop = 0;

  for (const m of shift.movements) {
    const amt = Number(m.amount);
    if (m.type === CashMovementType.CASH_IN) {
      totalCashIn += amt;
    } else if (m.type === CashMovementType.CASH_OUT) {
      totalCashOut += amt;
    } else if (m.type === CashMovementType.BANK_DROP) {
      totalBankDrop += amt;
    }
  }

  // 4. Fetch Sales Returns / Refunds during this shift
  const returns = await prisma.salesReturn.findMany({
    where: {
      storeId: shift.storeId,
      createdAt: {
        gte: shiftStart,
        lte: shiftEnd,
      },
    },
    select: {
      totalRefundAmount: true,
      refundMethod: true,
    },
  });

  let totalCashRefunds = 0;
  for (const ret of returns) {
    if (ret.refundMethod === PaymentMethod.CASH) {
      totalCashRefunds += Number(ret.totalRefundAmount);
    }
  }

  // Round all totals to 2 decimal places
  totalCashSales = Number(totalCashSales.toFixed(2));
  totalUpiSales = Number(totalUpiSales.toFixed(2));
  totalCardSales = Number(totalCardSales.toFixed(2));
  totalCreditSales = Number(totalCreditSales.toFixed(2));
  totalSalesRevenue = Number(totalSalesRevenue.toFixed(2));
  totalSupplierPaidCash = Number(totalSupplierPaidCash.toFixed(2));
  totalSupplierPaidBank = Number(totalSupplierPaidBank.toFixed(2));
  totalCashIn = Number(totalCashIn.toFixed(2));
  totalCashOut = Number(totalCashOut.toFixed(2));
  totalBankDrop = Number(totalBankDrop.toFixed(2));
  totalCashRefunds = Number(totalCashRefunds.toFixed(2));

  const openingCashFloat = Number(shift.openingCashFloat);
  const openingBankBalance = Number(shift.openingBankBalance);

  // Expected Cash Drawer Balance:
  // Opening Float + Net Cash Sales + Cash In - Supplier Paid Cash - Petty Expenses (Cash Out) - Bank Drops - Cash Refunds
  const expectedCash = Number(
    (
      openingCashFloat +
      totalCashSales +
      totalCashIn -
      totalSupplierPaidCash -
      totalCashOut -
      totalBankDrop -
      totalCashRefunds
    ).toFixed(2)
  );

  // Expected Bank / Digital Net:
  // UPI Sales + Card Sales - Supplier Paid Bank
  const expectedBank = Number(
    (totalUpiSales + totalCardSales - totalSupplierPaidBank).toFixed(2)
  );

  return {
    shiftId: shift.id,
    shiftNumber: shift.shiftNumber,
    status: shift.status,
    openedAt: shift.openedAt,
    closedAt: shift.closedAt,
    openedBy: shift.openedBy,
    closedBy: shift.closedBy,
    openingCashFloat,
    openingBankBalance,
    openingNotes: shift.openingNotes,

    invoiceCount: sales.length,
    totalCashSales,
    totalUpiSales,
    totalCardSales,
    totalCreditSales,
    totalSalesRevenue,

    totalCustomerDuesCash: 0,
    totalCustomerDuesBank: 0,

    totalSupplierPaidCash,
    totalSupplierPaidBank,

    totalCashIn,
    totalCashOut,
    totalBankDrop,
    totalCashRefunds,

    expectedCash,
    expectedBank,

    actualClosingCash: shift.status === ShiftStatus.CLOSED ? Number(shift.actualClosingCash) : undefined,
    cashVariance: shift.status === ShiftStatus.CLOSED ? Number(shift.cashVariance) : undefined,
    denominations: shift.denominations,
    closingNotes: shift.closingNotes,

    recentMovements: shift.movements.slice(0, 10).map((m) => ({
      id: m.id,
      type: m.type,
      amount: Number(m.amount),
      reason: m.reason,
      createdAt: m.createdAt,
    })),
  };
}

/**
 * Retrieve the currently OPEN shift for a store
 */
export async function getActiveShift(storeId: string) {
  const activeShift = await prisma.cashRegisterShift.findFirst({
    where: {
      storeId,
      status: ShiftStatus.OPEN,
    },
    orderBy: { openedAt: "desc" },
  });

  if (!activeShift) {
    return null;
  }

  return computeShiftSummary(activeShift.id);
}

/**
 * Open a new shift for the store
 */
export async function openShift(params: {
  storeId: string;
  openedById: string;
  openingCashFloat: number;
  openingBankBalance?: number;
  openingNotes?: string;
}) {
  const { storeId, openedById, openingCashFloat, openingBankBalance = 0, openingNotes } = params;

  // Check if an existing shift is already open
  const existing = await prisma.cashRegisterShift.findFirst({
    where: {
      storeId,
      status: ShiftStatus.OPEN,
    },
  });

  if (existing) {
    throw new Error(
      `Shift #${existing.shiftNumber} is currently open for this store. Please close it before opening a new shift.`
    );
  }

  // Determine next shiftNumber
  const lastShift = await prisma.cashRegisterShift.findFirst({
    where: { storeId },
    orderBy: { shiftNumber: "desc" },
    select: { shiftNumber: true },
  });

  const nextShiftNumber = (lastShift?.shiftNumber || 0) + 1;

  const newShift = await prisma.cashRegisterShift.create({
    data: {
      storeId,
      shiftNumber: nextShiftNumber,
      openedById,
      status: ShiftStatus.OPEN,
      openingCashFloat,
      openingBankBalance,
      openingNotes: openingNotes?.trim() || null,
    },
  });

  return computeShiftSummary(newShift.id);
}

/**
 * Record a petty cash in / out / bank drop movement
 */
export async function recordCashMovement(params: {
  shiftId: string;
  storeId: string;
  type: CashMovementType;
  amount: number;
  reason: string;
  createdById: string;
}) {
  const { shiftId, storeId, type, amount, reason, createdById } = params;

  if (amount <= 0) {
    throw new Error("Amount must be greater than zero.");
  }
  if (!reason || !reason.trim()) {
    throw new Error("A clear reason for the cash movement is required.");
  }

  const shift = await prisma.cashRegisterShift.findUnique({
    where: { id: shiftId },
  });

  if (!shift || shift.status !== ShiftStatus.OPEN) {
    throw new Error("Cannot add cash movement to an inactive or closed shift.");
  }

  const movement = await prisma.cashMovement.create({
    data: {
      shiftId,
      storeId,
      type,
      amount,
      reason: reason.trim(),
      createdById,
    },
  });

  return movement;
}

/**
 * Close shift, perform blind cash reconciliation, compute variance, and lock
 */
export async function closeShift(params: {
  shiftId: string;
  storeId: string;
  closedById: string;
  actualClosingCash: number;
  denominations?: DenominationBreakdown;
  closingNotes?: string;
}) {
  const { shiftId, storeId, closedById, actualClosingCash, denominations, closingNotes } = params;

  const shift = await prisma.cashRegisterShift.findUnique({
    where: { id: shiftId },
  });

  if (!shift || shift.status !== ShiftStatus.OPEN) {
    throw new Error("Shift is already closed or does not exist.");
  }

  // Compute live final summary
  const summary = await computeShiftSummary(shiftId);

  const expectedClosingCash = summary.expectedCash;
  const cashVariance = Number((actualClosingCash - expectedClosingCash).toFixed(2));
  const expectedClosingBank = summary.expectedBank;

  const updatedShift = await prisma.cashRegisterShift.update({
    where: { id: shiftId },
    data: {
      status: ShiftStatus.CLOSED,
      closedById,
      closedAt: new Date(),
      totalCashSales: summary.totalCashSales,
      totalUpiSales: summary.totalUpiSales,
      totalCardSales: summary.totalCardSales,
      totalCreditSales: summary.totalCreditSales,
      totalSupplierPaidCash: summary.totalSupplierPaidCash,
      totalSupplierPaidBank: summary.totalSupplierPaidBank,
      totalCashIn: summary.totalCashIn,
      totalCashOut: summary.totalCashOut,
      totalCashRefunds: summary.totalCashRefunds,
      expectedClosingCash,
      actualClosingCash,
      cashVariance,
      expectedClosingBank,
      denominations: denominations ? (denominations as any) : undefined,
      closingNotes: closingNotes?.trim() || null,
    },
  });

  return computeShiftSummary(updatedShift.id);
}

/**
 * Generate comprehensive Z-Report data ready for 80mm thermal receipt printing
 */
export async function getShiftZReport(shiftId: string) {
  const summary = await computeShiftSummary(shiftId);

  const shift = await prisma.cashRegisterShift.findUnique({
    where: { id: shiftId },
    include: {
      store: true,
      openedBy: { select: { fullName: true } },
      closedBy: { select: { fullName: true } },
      movements: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!shift) {
    throw new Error("Shift not found.");
  }

  return {
    store: {
      name: shift.store.name,
      address: shift.store.address || "Main Market",
      city: shift.store.city || "Ahmedabad",
      phone: shift.store.phone || "",
      gstin: shift.store.gstin || "",
      drugLicenseNo: shift.store.drugLicenseNo || "",
    },
    shiftNumber: shift.shiftNumber,
    openedAt: shift.openedAt,
    closedAt: shift.closedAt,
    cashierOpened: shift.openedBy.fullName,
    cashierClosed: shift.closedBy?.fullName || shift.openedBy.fullName,
    summary,
    movements: shift.movements.map((m) => ({
      type: m.type,
      amount: Number(m.amount),
      reason: m.reason,
      time: m.createdAt,
    })),
    denominations: shift.denominations,
  };
}

/**
 * Get historical shifts for the store
 */
export async function getShiftHistory(storeId: string, limit = 30) {
  const shifts = await prisma.cashRegisterShift.findMany({
    where: { storeId },
    orderBy: { openedAt: "desc" },
    take: limit,
    include: {
      openedBy: { select: { fullName: true } },
      closedBy: { select: { fullName: true } },
      _count: { select: { salesInvoices: true, movements: true } },
    },
  });

  return shifts.map((s) => ({
    id: s.id,
    shiftNumber: s.shiftNumber,
    status: s.status,
    openedAt: s.openedAt,
    closedAt: s.closedAt,
    openedBy: s.openedBy.fullName,
    closedBy: s.closedBy?.fullName || null,
    openingCashFloat: Number(s.openingCashFloat),
    totalCashSales: Number(s.totalCashSales),
    totalUpiSales: Number(s.totalUpiSales),
    totalCardSales: Number(s.totalCardSales),
    expectedClosingCash: Number(s.expectedClosingCash),
    actualClosingCash: Number(s.actualClosingCash),
    cashVariance: Number(s.cashVariance),
    invoiceCount: s._count.salesInvoices,
    movementCount: s._count.movements,
  }));
}
