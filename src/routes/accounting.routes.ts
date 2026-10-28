import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db";
import { AccountType, JournalType, PaymentMethod, PaymentStatus, Role } from "@prisma/client";
import {
  ensureDefaultAccountingSetup,
  registerCustomerPayment,
  registerVendorPayment,
  reconcileItems,
  postSalesInvoiceJournalEntry,
  postPurchaseInvoiceJournalEntry,
} from "../services/accounting.service";
import { recordAuditLog } from "./audit-logs.routes";
import { resolveStoreTenant } from "../middleware/auth";

export async function accountingRoutes(server: FastifyInstance, options: FastifyPluginOptions) {
  // Enforce role separation: Clinical/Doctor accounts cannot access accounting
  server.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authUser?.role === Role.DOCTOR) {
      return reply.status(403).send({
        success: false,
        message: "Forbidden: Clinical/Doctor accounts do not have access to financial accounting.",
      });
    }
  });

  // Helper to resolve store ID
  async function getStoreId(req: FastifyRequest): Promise<string> {
    try {
      const queryStoreId = (req.query as any)?.storeId;
      const bodyStoreId = (req.body as any)?.storeId;
      return await resolveStoreTenant(req, queryStoreId || bodyStoreId);
    } catch {
      const store = await prisma.store.findFirst();
      return store?.id || "";
    }
  }

  // 1. Accounting Dashboard / Overview
  server.get("/dashboard", async (request: FastifyRequest, reply: FastifyReply) => {
    const storeId = await getStoreId(request);
    await ensureDefaultAccountingSetup(storeId);

    // Accounts balances
    const accounts = await prisma.account.findMany({
      where: { storeId },
    });

    const accMap = new Map(accounts.map((a) => [a.code, a]));

    const cashBankBalance =
      Number(accMap.get("101000")?.currentBalance || 0) + Number(accMap.get("102000")?.currentBalance || 0);
    const receivables = Number(accMap.get("105000")?.currentBalance || 0);
    const payables = Number(accMap.get("201000")?.currentBalance || 0);
    const inventoryValuation = Number(accMap.get("106000")?.currentBalance || 0);
    const salesRevenue = Number(accMap.get("401000")?.currentBalance || 0);
    const cogs = Number(accMap.get("501000")?.currentBalance || 0);
    const operatingExpenses = Number(accMap.get("502000")?.currentBalance || 0);

    // Unpaid & Partial Invoices
    const dueInvoices = await prisma.salesInvoice.findMany({
      where: {
        storeId,
        paymentStatus: { in: [PaymentStatus.UNPAID, PaymentStatus.PARTIAL] },
      },
      select: {
        id: true,
        grandTotal: true,
        paidAmount: true,
      },
    });

    const totalInvoicesDue = dueInvoices.reduce(
      (sum, inv) => sum + (Number(inv.grandTotal) - Number(inv.paidAmount)),
      0
    );

    // Unpaid & Partial Vendor Bills
    const dueBills = await prisma.purchaseInvoice.findMany({
      where: {
        storeId,
        paymentStatus: { in: [PaymentStatus.UNPAID, PaymentStatus.PARTIAL] },
      },
      select: {
        id: true,
        totalAmount: true,
        paidAmount: true,
      },
    });

    const totalBillsDue = dueBills.reduce(
      (sum, b) => sum + (Number(b.totalAmount) - Number(b.paidAmount)),
      0
    );

    // Recent 10 Journal Entries
    const recentEntries = await prisma.journalEntry.findMany({
      where: { storeId },
      include: {
        journal: { select: { name: true, code: true, type: true } },
        items: {
          include: {
            account: { select: { code: true, name: true } },
          },
        },
      },
      orderBy: { date: "desc" },
      take: 10,
    });

    return reply.send({
      success: true,
      stats: {
        cashBankBalance: Number(cashBankBalance.toFixed(2)),
        accountsReceivable: Number(receivables.toFixed(2)),
        accountsPayable: Number(payables.toFixed(2)),
        inventoryValuation: Number(inventoryValuation.toFixed(2)),
        salesRevenue: Number(salesRevenue.toFixed(2)),
        netProfitEstimate: Number((salesRevenue - cogs - operatingExpenses).toFixed(2)),
        openInvoicesCount: dueInvoices.length,
        totalInvoicesDue: Number(totalInvoicesDue.toFixed(2)),
        openBillsCount: dueBills.length,
        totalBillsDue: Number(totalBillsDue.toFixed(2)),
      },
      recentEntries: recentEntries.map((e) => ({
        id: e.id,
        entryNumber: e.entryNumber,
        reference: e.reference || "",
        date: e.date.toISOString().split("T")[0],
        journalName: e.journal.name,
        journalCode: e.journal.code,
        notes: e.narration || "",
        totalAmount: e.items.reduce((sum, it) => sum + Number(it.debit), 0),
        items: e.items.map((it) => ({
          accountCode: it.account.code,
          accountName: it.account.name,
          label: it.label || it.name || "",
          debit: Number(it.debit),
          credit: Number(it.credit),
          partnerName: it.partnerName || "",
        })),
      })),
    });
  });

  // 2. Chart of Accounts (COA)
  server.get("/accounts", async (request: FastifyRequest, reply: FastifyReply) => {
    const storeId = await getStoreId(request);
    await ensureDefaultAccountingSetup(storeId);

    const accounts = await prisma.account.findMany({
      where: { storeId },
      orderBy: { code: "asc" },
    });

    return reply.send({
      success: true,
      accounts: accounts.map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        currentBalance: Number(a.currentBalance),
        description: a.description || "",
        isActive: a.isActive,
      })),
    });
  });

  // Create Custom Account
  server.post("/accounts", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const storeId = await getStoreId(request);

    if (!body.code || !body.name || !body.type) {
      return reply.status(400).send({ success: false, message: "Code, Name, and Account Type are required." });
    }

    const existing = await prisma.account.findUnique({
      where: { storeId_code: { storeId, code: body.code.trim() } },
    });

    if (existing) {
      return reply.status(400).send({ success: false, message: `Account code ${body.code} already exists.` });
    }

    const account = await prisma.account.create({
      data: {
        storeId,
        code: body.code.trim(),
        name: body.name.trim(),
        type: body.type as AccountType,
        description: body.description?.trim() || null,
        currentBalance: Number(body.openingBalance || 0),
      },
    });

    return reply.status(201).send({ success: true, account });
  });

  // 3. List Journals
  server.get("/journals", async (request: FastifyRequest, reply: FastifyReply) => {
    const storeId = await getStoreId(request);
    await ensureDefaultAccountingSetup(storeId);

    const journals = await prisma.journal.findMany({
      where: { storeId },
      include: {
        defaultAccount: { select: { code: true, name: true } },
        _count: { select: { entries: true } },
      },
      orderBy: { code: "asc" },
    });

    return reply.send({
      success: true,
      journals: journals.map((j) => ({
        id: j.id,
        code: j.code,
        name: j.name,
        type: j.type,
        defaultAccount: j.defaultAccount ? `${j.defaultAccount.code} - ${j.defaultAccount.name}` : null,
        entryCount: j._count.entries,
      })),
    });
  });

  // 4. Journal Entries list with filters
  server.get("/journal-entries", async (request: FastifyRequest, reply: FastifyReply) => {
    const { journalId, startDate, endDate, q, limit } = request.query as any;
    const storeId = await getStoreId(request);

    const where: any = { storeId };
    if (journalId && journalId !== "ALL") where.journalId = journalId;
    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = new Date(startDate);
      if (endDate) {
        const d = new Date(endDate);
        d.setHours(23, 59, 59, 999);
        where.date.lte = d;
      }
    }
    if (q) {
      where.OR = [
        { entryNumber: { contains: q, mode: "insensitive" } },
        { reference: { contains: q, mode: "insensitive" } },
        { narration: { contains: q, mode: "insensitive" } },
      ];
    }

    const entries = await prisma.journalEntry.findMany({
      where,
      include: {
        journal: { select: { name: true, code: true, type: true } },
        items: {
          include: {
            account: { select: { code: true, name: true, type: true } },
          },
          orderBy: { debit: "desc" },
        },
      },
      orderBy: { date: "desc" },
      take: limit ? Number(limit) : 50,
    });

    return reply.send({
      success: true,
      entries: entries.map((e) => {
        const totalDebit = e.items.reduce((s, it) => s + Number(it.debit), 0);
        const totalCredit = e.items.reduce((s, it) => s + Number(it.credit), 0);
        return {
          id: e.id,
          entryNumber: e.entryNumber,
          reference: e.reference || "",
          date: e.date.toISOString().split("T")[0],
          journalName: e.journal.name,
          journalCode: e.journal.code,
          journalType: e.journal.type,
          state: e.status,
          notes: e.narration || "",
          totalDebit: Number(totalDebit.toFixed(2)),
          totalCredit: Number(totalCredit.toFixed(2)),
          isBalanced: Math.abs(totalDebit - totalCredit) < 0.05,
          items: e.items.map((it) => ({
            id: it.id,
            accountId: it.accountId,
            accountCode: it.account.code,
            accountName: it.account.name,
            accountType: it.account.type,
            partnerType: it.partnerType,
            partnerId: it.partnerId,
            partnerName: it.partnerName || "",
            label: it.label || it.name || "",
            debit: Number(it.debit),
            credit: Number(it.credit),
            reconciled: it.reconciled,
            matchingNumber: it.matchingNumber || "",
          })),
        };
      }),
    });
  });

  // 5. General Ledger (Account-wise running balance report)
  server.get("/general-ledger", async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId, startDate, endDate } = request.query as any;
    const storeId = await getStoreId(request);

    const whereAccount: any = { storeId };
    if (accountId && accountId !== "ALL") whereAccount.id = accountId;

    const accounts = await prisma.account.findMany({
      where: whereAccount,
      include: {
        journalItems: {
          where: {
            entry: {
              storeId,
              status: "POSTED",
              ...(startDate || endDate
                ? {
                    date: {
                      ...(startDate ? { gte: new Date(startDate) } : {}),
                      ...(endDate ? { lte: new Date(endDate) } : {}),
                    },
                  }
                : {}),
            },
          },
          include: {
            entry: {
              select: {
                id: true,
                entryNumber: true,
                date: true,
                reference: true,
                journal: { select: { code: true, name: true } },
              },
            },
          },
          orderBy: {
            entry: { date: "asc" },
          },
        },
      },
      orderBy: { code: "asc" },
    });

    const report = accounts.map((acc) => {
      let runningBalance = 0;
      let totalDebit = 0;
      let totalCredit = 0;

      const lines = acc.journalItems.map((item) => {
        const debit = Number(item.debit);
        const credit = Number(item.credit);
        totalDebit += debit;
        totalCredit += credit;

        // Assets and Expenses increase on debit; Liabilities, Equity, and Income increase on credit
        if (acc.type === AccountType.ASSET || acc.type === AccountType.EXPENSE) {
          runningBalance += debit - credit;
        } else {
          runningBalance += credit - debit;
        }

        return {
          id: item.id,
          date: item.entry.date.toISOString().split("T")[0],
          entryNumber: item.entry.entryNumber,
          reference: item.entry.reference || "",
          journalCode: item.entry.journal.code,
          partnerName: item.partnerName || "",
          label: item.label || item.name || "",
          debit,
          credit,
          balance: Number(runningBalance.toFixed(2)),
          matchingNumber: item.matchingNumber || "",
        };
      });

      return {
        accountId: acc.id,
        accountCode: acc.code,
        accountName: acc.name,
        accountType: acc.type,
        totalDebit: Number(totalDebit.toFixed(2)),
        totalCredit: Number(totalCredit.toFixed(2)),
        endingBalance: Number(runningBalance.toFixed(2)),
        lineCount: lines.length,
        lines,
      };
    });

    return reply.send({ success: true, report });
  });

  // 6. Partner Ledger (Customer / Debtor Ledger & Vendor / Creditor Ledger)
  server.get("/partner-ledger", async (request: FastifyRequest, reply: FastifyReply) => {
    const { partnerType = "ALL", partnerId, startDate, endDate } = request.query as any;
    const storeId = await getStoreId(request);

    const where: any = {
      entry: {
        storeId,
        status: "POSTED",
      },
    };

    if (partnerType && partnerType !== "ALL") {
      where.partnerType = partnerType;
    } else {
      where.partnerType = { in: ["CUSTOMER", "SUPPLIER"] };
    }

    if (partnerId && partnerId !== "ALL") {
      where.partnerId = partnerId;
    }

    if (startDate || endDate) {
      where.entry.date = {};
      if (startDate) where.entry.date.gte = new Date(startDate);
      if (endDate) {
        const d = new Date(endDate);
        d.setHours(23, 59, 59, 999);
        where.entry.date.lte = d;
      }
    }

    const items = await prisma.journalItem.findMany({
      where,
      include: {
        account: { select: { code: true, name: true, type: true } },
        entry: {
          select: {
            entryNumber: true,
            date: true,
            reference: true,
            journal: { select: { code: true, name: true } },
          },
        },
      },
      orderBy: { entry: { date: "asc" } },
    });

    // Group by partner
    const partnerMap = new Map<string, any>();

    for (const item of items) {
      const key = `${item.partnerType}_${item.partnerId || item.partnerName || "Unknown"}`;
      if (!partnerMap.has(key)) {
        partnerMap.set(key, {
          partnerKey: key,
          partnerType: item.partnerType,
          partnerId: item.partnerId,
          partnerName: item.partnerName || "Unknown Partner",
          totalDebit: 0,
          totalCredit: 0,
          balance: 0,
          lines: [],
        });
      }

      const p = partnerMap.get(key);
      const debit = Number(item.debit);
      const credit = Number(item.credit);
      p.totalDebit += debit;
      p.totalCredit += credit;

      // For Customers: Debit increases receivable, Credit (payment) decreases it
      // For Vendors: Credit increases payable, Debit (payment) decreases it
      if (item.partnerType === "CUSTOMER") {
        p.balance += debit - credit;
      } else {
        p.balance += credit - debit;
      }

      p.lines.push({
        id: item.id,
        date: item.entry.date.toISOString().split("T")[0],
        entryNumber: item.entry.entryNumber,
        reference: item.entry.reference || "",
        journalCode: item.entry.journal.code,
        accountCode: item.account.code,
        label: item.label || item.name || "",
        debit,
        credit,
        runningBalance: Number(p.balance.toFixed(2)),
        matchingNumber: item.matchingNumber || "",
        reconciled: item.reconciled,
      });
    }

    const partners = Array.from(partnerMap.values()).map((p) => ({
      ...p,
      totalDebit: Number(p.totalDebit.toFixed(2)),
      totalCredit: Number(p.totalCredit.toFixed(2)),
      balance: Number(p.balance.toFixed(2)),
    }));

    return reply.send({ success: true, partners });
  });

  // 7. Get open Invoices Due (for registering payments)
  server.get("/invoices-due", async (request: FastifyRequest, reply: FastifyReply) => {
    const storeId = await getStoreId(request);

    const invoices = await prisma.salesInvoice.findMany({
      where: {
        storeId,
        paymentStatus: { in: [PaymentStatus.UNPAID, PaymentStatus.PARTIAL] },
      },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        payments: {
          select: {
            id: true,
            amount: true,
            paymentMethod: true,
            paymentDate: true,
            transactionRef: true,
          },
          orderBy: { paymentDate: "desc" },
        },
      },
      orderBy: { invoiceDate: "desc" },
    });

    return reply.send({
      success: true,
      invoices: invoices.map((inv) => {
        const grandTotal = Number(inv.grandTotal);
        const paidAmount = Number(inv.paidAmount);
        const remainingDue = Number((grandTotal - paidAmount).toFixed(2));
        return {
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: inv.invoiceDate.toISOString().split("T")[0],
          customerName: inv.customer?.name || "Walk-in Customer",
          customerPhone: inv.customer?.phone || "",
          customerId: inv.customer?.id || null,
          grandTotal,
          paidAmount,
          remainingDue,
          paymentStatus: inv.paymentStatus,
          payments: inv.payments.map((p) => ({
            id: p.id,
            amount: Number(p.amount),
            paymentMethod: p.paymentMethod,
            date: p.paymentDate.toISOString().split("T")[0],
            ref: p.transactionRef || "",
          })),
        };
      }),
    });
  });

  // 8. Get open Vendor Bills Due (for registering payments)
  server.get("/bills-due", async (request: FastifyRequest, reply: FastifyReply) => {
    const storeId = await getStoreId(request);

    const bills = await prisma.purchaseInvoice.findMany({
      where: {
        storeId,
        paymentStatus: { in: [PaymentStatus.UNPAID, PaymentStatus.PARTIAL] },
      },
      include: {
        supplier: { select: { id: true, businessName: true, phone: true } },
        payments: {
          select: {
            id: true,
            amount: true,
            paymentMethod: true,
            paymentDate: true,
            referenceNumber: true,
          },
          orderBy: { paymentDate: "desc" },
        },
      },
      orderBy: { invoiceDate: "desc" },
    });

    return reply.send({
      success: true,
      bills: bills.map((b) => {
        const totalAmount = Number(b.totalAmount);
        const paidAmount = Number(b.paidAmount);
        const remainingDue = Number((totalAmount - paidAmount).toFixed(2));
        return {
          id: b.id,
          invoiceNumber: b.invoiceNumber,
          supplierInvoiceNumber: b.supplierInvoiceNumber || "",
          invoiceDate: b.invoiceDate.toISOString().split("T")[0],
          supplierId: b.supplier.id,
          supplierName: b.supplier.businessName,
          supplierPhone: b.supplier.phone || "",
          totalAmount,
          paidAmount,
          remainingDue,
          paymentStatus: b.paymentStatus,
          payments: b.payments.map((p) => ({
            id: p.id,
            amount: Number(p.amount),
            paymentMethod: p.paymentMethod,
            date: p.paymentDate.toISOString().split("T")[0],
            ref: p.referenceNumber || "",
          })),
        };
      }),
    });
  });

  // 9. Register Customer Payment (Multi-payment on invoice)
  server.post("/customer-payments", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;

    if (!body.salesInvoiceId) {
      return reply.status(400).send({ success: false, message: "Sales Invoice ID is required." });
    }

    const amount = Number(body.amount);
    if (!amount || amount <= 0) {
      return reply.status(400).send({ success: false, message: "Payment amount must be greater than 0." });
    }

    let paymentMethod: PaymentMethod = PaymentMethod.CASH;
    if (body.paymentMethod === "UPI") paymentMethod = PaymentMethod.UPI;
    else if (body.paymentMethod === "CARD") paymentMethod = PaymentMethod.CARD;
    else if (body.paymentMethod === "CREDIT") paymentMethod = PaymentMethod.CREDIT;

    try {
      const result = await registerCustomerPayment({
        salesInvoiceId: body.salesInvoiceId,
        amount,
        paymentMethod,
        paymentDate: body.paymentDate ? new Date(body.paymentDate) : new Date(),
        referenceNumber: body.referenceNumber?.trim(),
        notes: body.notes?.trim(),
      });

      return reply.status(201).send({
        success: true,
        message: `Payment of ₹${amount} recorded successfully.`,
        payment: result.payment,
        invoice: {
          id: result.invoice.id,
          paidAmount: Number(result.invoice.paidAmount),
          paymentStatus: result.invoice.paymentStatus,
        },
      });
    } catch (err: any) {
      return reply.status(400).send({ success: false, message: err.message || "Failed to record payment." });
    }
  });

  // 10. Register Vendor Payment (Multi-payment on bill)
  server.post("/vendor-payments", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;

    let supplierId = body.supplierId?.trim();
    let purchaseInvoiceId = body.purchaseInvoiceId?.trim();

    if (purchaseInvoiceId) {
      const inv = await prisma.purchaseInvoice.findFirst({
        where: {
          OR: [
            { id: purchaseInvoiceId },
            { invoiceNumber: purchaseInvoiceId },
            { supplierInvoiceNumber: purchaseInvoiceId },
          ],
        },
        select: { id: true, supplierId: true },
      });
      if (inv) {
        purchaseInvoiceId = inv.id;
        if (!supplierId) {
          supplierId = inv.supplierId;
        }
      }
    }

    if (!supplierId && !purchaseInvoiceId) {
      return reply.status(400).send({ success: false, message: "Supplier ID or Bill ID is required." });
    }

    const amount = Number(body.amount);
    if (!amount || amount <= 0) {
      return reply.status(400).send({ success: false, message: "Payment amount must be greater than 0." });
    }

    let paymentMethod: PaymentMethod = PaymentMethod.UPI;
    if (body.paymentMethod === "CASH") paymentMethod = PaymentMethod.CASH;
    else if (body.paymentMethod === "CARD") paymentMethod = PaymentMethod.CARD;
    else if (body.paymentMethod === "CREDIT") paymentMethod = PaymentMethod.CREDIT;

    try {
      const result = await registerVendorPayment({
        purchaseInvoiceId: purchaseInvoiceId || undefined,
        supplierId: supplierId || "",
        amount,
        paymentMethod,
        paymentDate: body.paymentDate ? new Date(body.paymentDate) : new Date(),
        referenceNumber: body.referenceNumber?.trim(),
        notes: body.notes?.trim(),
      });

      return reply.status(201).send({
        success: true,
        message: `Payment of ₹${amount} recorded to vendor successfully.`,
        payment: result.payment,
        invoice: result.invoice
          ? {
              id: result.invoice.id,
              paidAmount: Number(result.invoice.paidAmount),
              paymentStatus: result.invoice.paymentStatus,
            }
          : null,
        supplierCurrentBalance: Number(result.supplier.currentBalance),
      });
    } catch (err: any) {
      return reply.status(400).send({ success: false, message: err.message || "Failed to record payment." });
    }
  });

  // 11. Unreconciled Items for Matching
  server.get("/unreconciled", async (request: FastifyRequest, reply: FastifyReply) => {
    const { partnerType = "ALL" } = request.query as any;
    const storeId = await getStoreId(request);

    const where: any = {
      reconciled: false,
      entry: {
        storeId,
        status: "POSTED",
      },
    };

    if (partnerType && partnerType !== "ALL") {
      where.partnerType = partnerType;
    }

    const items = await prisma.journalItem.findMany({
      where,
      include: {
        account: { select: { code: true, name: true, type: true } },
        entry: {
          select: {
            entryNumber: true,
            date: true,
            reference: true,
            journal: { select: { code: true, name: true } },
          },
        },
      },
      orderBy: { entry: { date: "desc" } },
      take: 100,
    });

    return reply.send({
      success: true,
      items: items.map((it) => ({
        id: it.id,
        date: it.entry.date.toISOString().split("T")[0],
        entryNumber: it.entry.entryNumber,
        reference: it.entry.reference || "",
        journalCode: it.entry.journal.code,
        accountCode: it.account.code,
        accountName: it.account.name,
        partnerType: it.partnerType,
        partnerId: it.partnerId,
        partnerName: it.partnerName || "No Partner",
        label: it.label || it.name || "",
        debit: Number(it.debit),
        credit: Number(it.credit),
      })),
    });
  });

  // 12. Reconcile Journal Items
  server.post("/reconcile", async (request: FastifyRequest, reply: FastifyReply) => {
    const { itemIds } = request.body as any;

    if (!itemIds || !Array.isArray(itemIds) || itemIds.length < 2) {
      return reply.status(400).send({
        success: false,
        message: "Please select at least 2 matching items (debits & credits) to reconcile.",
      });
    }

    try {
      const res = await reconcileItems(itemIds);
      return reply.send(res);
    } catch (err: any) {
      return reply.status(400).send({ success: false, message: err.message || "Reconciliation failed." });
    }
  });

  // 13. Auto-sync existing sales and purchases into Journal Entries if they don't have one yet
  server.post("/sync-historical-entries", async (request: FastifyRequest, reply: FastifyReply) => {
    const storeId = await getStoreId(request);
    await ensureDefaultAccountingSetup(storeId);

    // Find sales invoices without journal entry
    const unpostedSales = await prisma.salesInvoice.findMany({
      where: {
        storeId,
        journalEntries: { none: {} },
      },
      take: 100,
    });

    let salesPosted = 0;
    for (const sale of unpostedSales) {
      await postSalesInvoiceJournalEntry(sale.id);
      salesPosted++;
    }

    // Find purchase invoices without journal entry
    const unpostedPurchases = await prisma.purchaseInvoice.findMany({
      where: {
        storeId,
        journalEntries: { none: {} },
      },
      take: 100,
    });

    let purchasesPosted = 0;
    for (const pur of unpostedPurchases) {
      await postPurchaseInvoiceJournalEntry(pur.id);
      purchasesPosted++;
    }

    return reply.send({
      success: true,
      message: `Synced ${salesPosted} sales invoices and ${purchasesPosted} purchase invoices to Journal Entries.`,
    });
  });

  // 14. Edit Account (Name, Description, Balance, Status) with Audit Logging
  server.put("/accounts/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;
    const currentUserId = (request as any).authUser?.userId || null;

    const existing = await prisma.account.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ success: false, message: "Account not found." });
    }

    const changes: Array<{ field: string; label: string; from: any; to: any }> = [];

    if (body.name !== undefined && body.name.trim() !== existing.name) {
      changes.push({ field: "name", label: "Account Name", from: existing.name, to: body.name.trim() });
    }
    if (body.description !== undefined && body.description !== existing.description) {
      changes.push({ field: "description", label: "Description", from: existing.description || "", to: body.description || "" });
    }
    if (body.isActive !== undefined && Boolean(body.isActive) !== existing.isActive) {
      changes.push({ field: "isActive", label: "Status", from: existing.isActive ? "Active" : "Archived", to: Boolean(body.isActive) ? "Active" : "Archived" });
    }
    if (body.currentBalance !== undefined && Number(body.currentBalance) !== Number(existing.currentBalance)) {
      changes.push({ field: "currentBalance", label: "Balance (₹)", from: Number(existing.currentBalance), to: Number(body.currentBalance) });
    }

    if (changes.length === 0) {
      return reply.send({ success: true, message: "No changes detected.", account: existing });
    }

    const updated = await prisma.account.update({
      where: { id },
      data: {
        name: body.name !== undefined ? body.name.trim() : undefined,
        description: body.description !== undefined ? body.description?.trim() || null : undefined,
        isActive: body.isActive !== undefined ? Boolean(body.isActive) : undefined,
        currentBalance: body.currentBalance !== undefined ? Number(body.currentBalance) : undefined,
      },
    });

    await recordAuditLog({
      storeId: existing.storeId,
      actorId: currentUserId || undefined,
      action: "UPDATE_ACCOUNT",
      entity: "Account",
      entityId: existing.id,
      details: {
        accountCode: existing.code,
        accountName: existing.name,
        changes,
      },
      ipAddress: request.ip,
    });

    return reply.send({ success: true, message: `Account ${existing.code} updated successfully.`, account: updated });
  });

  // 15. Edit Journal (Name, Code, Default Account) with Audit Logging
  server.put("/journals/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;
    const currentUserId = (request as any).authUser?.userId || null;

    const existing = await prisma.journal.findUnique({
      where: { id },
      include: { defaultAccount: true },
    });
    if (!existing) {
      return reply.status(404).send({ success: false, message: "Journal not found." });
    }

    const changes: Array<{ field: string; label: string; from: any; to: any }> = [];

    if (body.name !== undefined && body.name.trim() !== existing.name) {
      changes.push({ field: "name", label: "Journal Name", from: existing.name, to: body.name.trim() });
    }
    if (body.code !== undefined && body.code.trim().toUpperCase() !== existing.code) {
      changes.push({ field: "code", label: "Journal Code", from: existing.code, to: body.code.trim().toUpperCase() });
    }
    if (body.defaultAccountId !== undefined && body.defaultAccountId !== existing.defaultAccountId) {
      changes.push({ field: "defaultAccountId", label: "Default Account ID", from: existing.defaultAccountId || "None", to: body.defaultAccountId || "None" });
    }

    if (changes.length === 0) {
      return reply.send({ success: true, message: "No changes detected.", journal: existing });
    }

    const updated = await prisma.journal.update({
      where: { id },
      data: {
        name: body.name !== undefined ? body.name.trim() : undefined,
        code: body.code !== undefined ? body.code.trim().toUpperCase() : undefined,
        defaultAccountId: body.defaultAccountId !== undefined ? body.defaultAccountId || null : undefined,
      },
    });

    await recordAuditLog({
      storeId: existing.storeId,
      actorId: currentUserId || undefined,
      action: "UPDATE_JOURNAL",
      entity: "Journal",
      entityId: existing.id,
      details: {
        journalCode: existing.code,
        journalName: existing.name,
        changes,
      },
      ipAddress: request.ip,
    });

    return reply.send({ success: true, message: `Journal ${existing.code} updated successfully.`, journal: updated });
  });

  // 16. Edit Journal Entry (Date, Reference, Narration, Status) with Audit Logging
  server.put("/journal-entries/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;
    const currentUserId = (request as any).authUser?.userId || null;

    const existing = await prisma.journalEntry.findUnique({
      where: { id },
      include: { journal: true },
    });
    if (!existing) {
      return reply.status(404).send({ success: false, message: "Journal entry not found." });
    }

    const changes: Array<{ field: string; label: string; from: any; to: any }> = [];

    if (body.reference !== undefined && body.reference !== existing.reference) {
      changes.push({ field: "reference", label: "Reference", from: existing.reference || "", to: body.reference || "" });
    }
    if (body.narration !== undefined && body.narration !== existing.narration) {
      changes.push({ field: "narration", label: "Narration / Memo", from: existing.narration || "", to: body.narration || "" });
    }
    if (body.status !== undefined && body.status !== existing.status) {
      changes.push({ field: "status", label: "Status", from: existing.status, to: body.status });
    }
    if (body.date !== undefined) {
      const newDateStr = new Date(body.date).toISOString().split("T")[0];
      const oldDateStr = existing.date.toISOString().split("T")[0];
      if (newDateStr !== oldDateStr) {
        changes.push({ field: "date", label: "Date", from: oldDateStr, to: newDateStr });
      }
    }

    if (changes.length === 0) {
      return reply.send({ success: true, message: "No changes detected.", entry: existing });
    }

    const updated = await prisma.journalEntry.update({
      where: { id },
      data: {
        reference: body.reference !== undefined ? body.reference?.trim() || null : undefined,
        narration: body.narration !== undefined ? body.narration?.trim() || null : undefined,
        status: body.status !== undefined ? body.status : undefined,
        date: body.date !== undefined ? new Date(body.date) : undefined,
      },
    });

    await recordAuditLog({
      storeId: existing.storeId,
      actorId: currentUserId || undefined,
      action: "UPDATE_JOURNAL_ENTRY",
      entity: "JournalEntry",
      entityId: existing.id,
      details: {
        entryNumber: existing.entryNumber,
        reference: existing.reference,
        journalCode: existing.journal.code,
        changes,
      },
      ipAddress: request.ip,
    });

    return reply.send({ success: true, message: `Entry ${existing.entryNumber} updated successfully.`, entry: updated });
  });

  // 17. Edit Payment (Customer or Vendor Payment) with Audit Logging & Balance Recalculation
  server.put("/payments/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;
    const currentUserId = (request as any).authUser?.userId || null;
    const paymentType = body.paymentType || "CUSTOMER"; // "CUSTOMER" or "VENDOR"

    const changes: Array<{ field: string; label: string; from: any; to: any }> = [];

    if (paymentType === "CUSTOMER") {
      const existing = await prisma.salesPayment.findUnique({
        where: { id },
        include: { salesInvoice: { include: { customer: true } } },
      });

      if (!existing) {
        return reply.status(404).send({ success: false, message: "Customer payment not found." });
      }

      if (body.paymentMethod && body.paymentMethod !== existing.paymentMethod) {
        changes.push({ field: "paymentMethod", label: "Payment Mode", from: existing.paymentMethod, to: body.paymentMethod });
      }
      if (body.referenceNumber !== undefined && body.referenceNumber !== existing.transactionRef) {
        changes.push({ field: "referenceNumber", label: "Reference #", from: existing.transactionRef || "", to: body.referenceNumber || "" });
      }
      if (body.notes !== undefined && body.notes !== existing.notes) {
        changes.push({ field: "notes", label: "Notes", from: existing.notes || "", to: body.notes || "" });
      }
      if (body.paymentDate !== undefined) {
        const newD = new Date(body.paymentDate).toISOString().split("T")[0];
        const oldD = existing.paymentDate.toISOString().split("T")[0];
        if (newD !== oldD) changes.push({ field: "paymentDate", label: "Payment Date", from: oldD, to: newD });
      }

      const oldAmount = Number(existing.amount);
      const newAmount = body.amount !== undefined ? Number(body.amount) : oldAmount;
      const amountChanged = Math.abs(newAmount - oldAmount) > 0.001;

      if (amountChanged) {
        changes.push({ field: "amount", label: "Amount (₹)", from: oldAmount, to: newAmount });
      }

      if (changes.length === 0) {
        return reply.send({ success: true, message: "No changes detected.", payment: existing });
      }

      const delta = newAmount - oldAmount;
      const invoice = existing.salesInvoice;
      const newInvoicePaid = Number(invoice.paidAmount) + delta;
      const grandTotal = Number(invoice.grandTotal);

      let newStatus: PaymentStatus = PaymentStatus.PARTIAL;
      if (newInvoicePaid >= grandTotal - 0.01) newStatus = PaymentStatus.PAID;
      else if (newInvoicePaid <= 0.01) newStatus = PaymentStatus.UNPAID;

      await prisma.$transaction(async (tx) => {
        await tx.salesPayment.update({
          where: { id },
          data: {
            amount: newAmount,
            paymentMethod: body.paymentMethod ? (body.paymentMethod as PaymentMethod) : undefined,
            paymentDate: body.paymentDate ? new Date(body.paymentDate) : undefined,
            transactionRef: body.referenceNumber !== undefined ? body.referenceNumber || null : undefined,
            notes: body.notes !== undefined ? body.notes || null : undefined,
          },
        });

        if (amountChanged) {
          await tx.salesInvoice.update({
            where: { id: invoice.id },
            data: {
              paidAmount: newInvoicePaid,
              paymentStatus: newStatus,
            },
          });

          if (invoice.customerId) {
            // If payment increased, customer owes less (decrement); if payment decreased, customer owes more (increment)
            await tx.customer.update({
              where: { id: invoice.customerId },
              data: {
                currentBalance: {
                  decrement: delta,
                },
              },
            });
          }
        }
      });

      await recordAuditLog({
        storeId: invoice.storeId,
        actorId: currentUserId || undefined,
        action: "UPDATE_PAYMENT",
        entity: "SalesPayment",
        entityId: existing.id,
        details: {
          invoiceNumber: invoice.invoiceNumber,
          customerName: invoice.customer?.name || "Customer",
          changes,
        },
        ipAddress: request.ip,
      });

      return reply.send({ success: true, message: "Payment updated successfully.", changesCount: changes.length });
    } else {
      // VENDOR PAYMENT
      const existing = await prisma.supplierPayment.findUnique({
        where: { id },
        include: { supplier: true, purchaseInvoice: true },
      });

      if (!existing) {
        return reply.status(404).send({ success: false, message: "Vendor payment not found." });
      }

      if (body.paymentMethod && body.paymentMethod !== existing.paymentMethod) {
        changes.push({ field: "paymentMethod", label: "Payment Mode", from: existing.paymentMethod, to: body.paymentMethod });
      }
      if (body.referenceNumber !== undefined && body.referenceNumber !== existing.referenceNumber) {
        changes.push({ field: "referenceNumber", label: "Reference #", from: existing.referenceNumber || "", to: body.referenceNumber || "" });
      }
      if (body.notes !== undefined && body.notes !== existing.notes) {
        changes.push({ field: "notes", label: "Notes", from: existing.notes || "", to: body.notes || "" });
      }
      if (body.paymentDate !== undefined) {
        const newD = new Date(body.paymentDate).toISOString().split("T")[0];
        const oldD = existing.paymentDate.toISOString().split("T")[0];
        if (newD !== oldD) changes.push({ field: "paymentDate", label: "Payment Date", from: oldD, to: newD });
      }

      const oldAmount = Number(existing.amount);
      const newAmount = body.amount !== undefined ? Number(body.amount) : oldAmount;
      const amountChanged = Math.abs(newAmount - oldAmount) > 0.001;

      if (amountChanged) {
        changes.push({ field: "amount", label: "Amount (₹)", from: oldAmount, to: newAmount });
      }

      if (changes.length === 0) {
        return reply.send({ success: true, message: "No changes detected.", payment: existing });
      }

      const delta = newAmount - oldAmount;

      await prisma.$transaction(async (tx) => {
        await tx.supplierPayment.update({
          where: { id },
          data: {
            amount: newAmount,
            paymentMethod: body.paymentMethod ? (body.paymentMethod as PaymentMethod) : undefined,
            paymentDate: body.paymentDate ? new Date(body.paymentDate) : undefined,
            referenceNumber: body.referenceNumber !== undefined ? body.referenceNumber || null : undefined,
            notes: body.notes !== undefined ? body.notes || null : undefined,
          },
        });

        if (amountChanged) {
          if (existing.purchaseInvoice) {
            const newPaid = Number(existing.purchaseInvoice.paidAmount) + delta;
            const total = Number(existing.purchaseInvoice.totalAmount);
            let newStatus: PaymentStatus = PaymentStatus.PARTIAL;
            if (newPaid >= total - 0.01) newStatus = PaymentStatus.PAID;
            else if (newPaid <= 0.01) newStatus = PaymentStatus.UNPAID;

            await tx.purchaseInvoice.update({
              where: { id: existing.purchaseInvoice.id },
              data: {
                paidAmount: newPaid,
                paymentStatus: newStatus,
              },
            });
          }

          // Supplier balance
          await tx.supplier.update({
            where: { id: existing.supplierId },
            data: {
              currentBalance: {
                decrement: delta,
              },
            },
          });
        }
      });

      await recordAuditLog({
        storeId: existing.storeId,
        actorId: currentUserId || undefined,
        action: "UPDATE_PAYMENT",
        entity: "SupplierPayment",
        entityId: existing.id,
        details: {
          supplierName: existing.supplier.businessName,
          billNumber: existing.purchaseInvoice?.supplierInvoiceNumber || existing.purchaseInvoice?.invoiceNumber || "General",
          changes,
        },
        ipAddress: request.ip,
      });

      return reply.send({ success: true, message: "Vendor payment updated successfully.", changesCount: changes.length });
    }
  });

  // 18. Accounting Audit & Change Logs
  server.get("/audit-logs", async (request: FastifyRequest, reply: FastifyReply) => {
    const { limit = "50", entity, search } = request.query as any;
    const storeId = await getStoreId(request);

    const where: any = {
      storeId,
      entity: entity && entity !== "ALL"
        ? entity
        : { in: ["Account", "Journal", "JournalEntry", "Payment", "SalesPayment", "SupplierPayment", "SalesInvoice", "PurchaseInvoice"] },
    };

    if (search && search.trim()) {
      where.OR = [
        { action: { contains: search, mode: "insensitive" } },
        { entityId: { contains: search, mode: "insensitive" } },
      ];
    }

    const logs = await prisma.auditLog.findMany({
      where,
      include: {
        actor: { select: { id: true, fullName: true, username: true, role: true } },
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(200, Number(limit) || 50),
    });

    return reply.send({
      success: true,
      logs: logs.map((l) => ({
        id: l.id,
        action: l.action,
        entity: l.entity,
        entityId: l.entityId || "",
        details: l.details || {},
        createdAt: l.createdAt.toISOString(),
        actorName: l.actor?.fullName || l.actor?.username || "System Administrator",
        actorRole: l.actor?.role || "ADMIN",
        ipAddress: l.ipAddress || "",
      })),
    });
  });

  // Helper: Indian Currency Words Converter
  function formatIndianCurrencyWords(num: number): string {
    const a = [
      "", "One ", "Two ", "Three ", "Four ", "Five ", "Six ", "Seven ", "Eight ", "Nine ", "Ten ",
      "Eleven ", "Twelve ", "Thirteen ", "Fourteen ", "Fifteen ", "Sixteen ", "Seventeen ", "Eighteen ", "Nineteen "
    ];
    const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
    const n = Math.floor(Math.abs(num));
    const paise = Math.round((Math.abs(num) - n) * 100);

    if (n === 0 && paise === 0) return "Zero Rupees Only";

    function convertTwoDigits(val: number): string {
      if (val < 20) return a[val];
      return b[Math.floor(val / 10)] + (val % 10 !== 0 ? " " + a[val % 10] : " ");
    }

    let words = "";
    let remainder = n;

    if (remainder >= 10000000) {
      words += convertTwoDigits(Math.floor(remainder / 10000000)) + "Crore ";
      remainder %= 10000000;
    }
    if (remainder >= 100000) {
      words += convertTwoDigits(Math.floor(remainder / 100000)) + "Lakh ";
      remainder %= 100000;
    }
    if (remainder >= 1000) {
      words += convertTwoDigits(Math.floor(remainder / 1000)) + "Thousand ";
      remainder %= 1000;
    }
    if (remainder >= 100) {
      words += convertTwoDigits(Math.floor(remainder / 100)) + "Hundred ";
      remainder %= 100;
    }
    if (remainder > 0) {
      words += convertTwoDigits(remainder);
    }

    let result = words.trim() + " Rupees";
    if (paise > 0) {
      result += " and " + convertTwoDigits(paise).trim() + " Paise";
    }
    return result + " Only";
  }

  // 19. Unified List of Payments (Customer Receipts & Vendor Disbursements)
  server.get("/payments", async (request: FastifyRequest, reply: FastifyReply) => {
    const { type = "ALL", paymentMethod, q, startDate, endDate, limit = "100" } = request.query as any;
    const storeId = await getStoreId(request);

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        name: true,
        code: true,
        address: true,
        city: true,
        state: true,
        pincode: true,
        phone: true,
        email: true,
        gstin: true,
        drugLicenseNo: true,
      },
    });

    const storeMeta = store || {
      id: storeId,
      name: "City Medical Store",
      code: "STORE-001",
      address: "123 Main Street, Navrangpura",
      city: "Ahmedabad",
      state: "Gujarat",
      pincode: "380009",
      phone: "+91 9876543210",
      email: "store@citymedical.com",
      gstin: "24AAAAA0000A1Z5",
      drugLicenseNo: "GJ-AHM-2024-DL-8842",
    };

    const unifiedList: any[] = [];

    // A. Customer Payments (SalesPayment)
    if (type === "ALL" || type === "CUSTOMER") {
      const spWhere: any = {
        salesInvoice: { storeId },
      };
      if (paymentMethod && paymentMethod !== "ALL") {
        spWhere.paymentMethod = paymentMethod;
      }
      if (startDate || endDate) {
        spWhere.paymentDate = {};
        if (startDate) spWhere.paymentDate.gte = new Date(startDate);
        if (endDate) {
          const d = new Date(endDate);
          d.setHours(23, 59, 59, 999);
          spWhere.paymentDate.lte = d;
        }
      }
      if (q && q.trim()) {
        spWhere.OR = [
          { transactionRef: { contains: q, mode: "insensitive" } },
          { notes: { contains: q, mode: "insensitive" } },
          { salesInvoice: { invoiceNumber: { contains: q, mode: "insensitive" } } },
          { salesInvoice: { customer: { name: { contains: q, mode: "insensitive" } } } },
        ];
      }

      const salesPayments = await prisma.salesPayment.findMany({
        where: spWhere,
        include: {
          salesInvoice: {
            include: {
              customer: true,
            },
          },
        },
        orderBy: { paymentDate: "desc" },
        take: Number(limit) || 100,
      });

      for (const sp of salesPayments) {
        const inv = sp.salesInvoice;
        const grandTotal = Number(inv.grandTotal);
        const paidAmount = Number(inv.paidAmount);
        const remaining = Number((grandTotal - paidAmount).toFixed(2));
        const amountNum = Number(sp.amount);

        unifiedList.push({
          id: sp.id,
          paymentNumber: `REC-${sp.id.slice(0, 8).toUpperCase()}`,
          paymentType: "CUSTOMER",
          date: sp.paymentDate.toISOString(),
          amount: amountNum,
          amountInWords: formatIndianCurrencyWords(amountNum),
          paymentMethod: sp.paymentMethod,
          transactionRef: sp.transactionRef || "",
          notes: sp.notes || "",
          partnerId: inv.customerId || "",
          partnerName: inv.customer?.name || "Walk-in Customer",
          partnerPhone: inv.customer?.phone || "",
          partnerAddress: inv.customer?.address || "",
          partnerGstin: inv.customer?.gstin || "",
          partnerType: "CUSTOMER",
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          invoiceTotal: grandTotal,
          invoicePaid: paidAmount,
          invoiceBalanceRemaining: remaining,
          invoiceStatus: inv.paymentStatus,
          store: storeMeta,
        });
      }
    }

    // B. Vendor Payments (SupplierPayment)
    if (type === "ALL" || type === "VENDOR") {
      const supWhere: any = { storeId };
      if (paymentMethod && paymentMethod !== "ALL") {
        supWhere.paymentMethod = paymentMethod;
      }
      if (startDate || endDate) {
        supWhere.paymentDate = {};
        if (startDate) supWhere.paymentDate.gte = new Date(startDate);
        if (endDate) {
          const d = new Date(endDate);
          d.setHours(23, 59, 59, 999);
          supWhere.paymentDate.lte = d;
        }
      }
      if (q && q.trim()) {
        supWhere.OR = [
          { referenceNumber: { contains: q, mode: "insensitive" } },
          { notes: { contains: q, mode: "insensitive" } },
          { supplier: { businessName: { contains: q, mode: "insensitive" } } },
          { purchaseInvoice: { invoiceNumber: { contains: q, mode: "insensitive" } } },
          { purchaseInvoice: { supplierInvoiceNumber: { contains: q, mode: "insensitive" } } },
        ];
      }

      const supplierPayments = await prisma.supplierPayment.findMany({
        where: supWhere,
        include: {
          supplier: true,
          purchaseInvoice: true,
        },
        orderBy: { paymentDate: "desc" },
        take: Number(limit) || 100,
      });

      for (const sup of supplierPayments) {
        const pinv = sup.purchaseInvoice;
        const totalAmount = pinv ? Number(pinv.totalAmount) : Number(sup.amount);
        const paidAmount = pinv ? Number(pinv.paidAmount) : Number(sup.amount);
        const remaining = pinv ? Number((totalAmount - paidAmount).toFixed(2)) : 0;
        const amountNum = Number(sup.amount);

        unifiedList.push({
          id: sup.id,
          paymentNumber: `PMT-${sup.id.slice(0, 8).toUpperCase()}`,
          paymentType: "VENDOR",
          date: sup.paymentDate.toISOString(),
          amount: amountNum,
          amountInWords: formatIndianCurrencyWords(amountNum),
          paymentMethod: sup.paymentMethod,
          transactionRef: sup.referenceNumber || "",
          notes: sup.notes || "",
          partnerId: sup.supplier.id,
          partnerName: sup.supplier.businessName,
          partnerPhone: sup.supplier.phone || "",
          partnerAddress: sup.supplier.address || "",
          partnerGstin: sup.supplier.gstin || "",
          partnerType: "SUPPLIER",
          invoiceId: pinv?.id || null,
          invoiceNumber: pinv?.supplierInvoiceNumber || pinv?.invoiceNumber || "General Supplier Account",
          invoiceTotal: totalAmount,
          invoicePaid: paidAmount,
          invoiceBalanceRemaining: remaining,
          invoiceStatus: pinv?.paymentStatus || "PAID",
          store: storeMeta,
        });
      }
    }

    // Sort unified list descending by date
    unifiedList.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Calculate Summary Metrics
    const totalReceipts = unifiedList
      .filter((p) => p.paymentType === "CUSTOMER")
      .reduce((sum, p) => sum + p.amount, 0);
    const totalDisbursements = unifiedList
      .filter((p) => p.paymentType === "VENDOR")
      .reduce((sum, p) => sum + p.amount, 0);

    return reply.send({
      success: true,
      payments: unifiedList,
      summary: {
        totalReceipts,
        totalDisbursements,
        netCashflow: totalReceipts - totalDisbursements,
        count: unifiedList.length,
      },
    });
  });

  // 20. Single Payment Detailed View (for GST Voucher / Official Receipt)
  server.get("/payments/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    // Try Customer Payment
    const salesPayment = await prisma.salesPayment.findUnique({
      where: { id },
      include: {
        salesInvoice: {
          include: {
            customer: true,
            store: true,
            payments: {
              orderBy: { paymentDate: "asc" },
            },
            items: {
              include: {
                product: { select: { id: true, name: true, hsnCode: true } },
                batch: { select: { id: true, batchNumber: true, expiryDate: true } },
              },
              take: 10,
            },
          },
        },
      },
    });

    if (salesPayment) {
      const inv = salesPayment.salesInvoice;
      const amountNum = Number(salesPayment.amount);
      const grandTotal = Number(inv.grandTotal);
      const paidAmount = Number(inv.paidAmount);

      return reply.send({
        success: true,
        payment: {
          id: salesPayment.id,
          paymentNumber: `REC-${salesPayment.id.slice(0, 8).toUpperCase()}`,
          paymentType: "CUSTOMER",
          date: salesPayment.paymentDate.toISOString(),
          amount: amountNum,
          amountInWords: formatIndianCurrencyWords(amountNum),
          paymentMethod: salesPayment.paymentMethod,
          transactionRef: salesPayment.transactionRef || "",
          notes: salesPayment.notes || "",
          partnerId: inv.customerId || "",
          partnerName: inv.customer?.name || "Walk-in Customer",
          partnerPhone: inv.customer?.phone || "",
          partnerAddress: inv.customer?.address || "",
          partnerGstin: inv.customer?.gstin || "",
          partnerType: "CUSTOMER",
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          invoiceTotal: grandTotal,
          invoicePaid: paidAmount,
          invoiceBalanceRemaining: Number((grandTotal - paidAmount).toFixed(2)),
          invoiceStatus: inv.paymentStatus,
          store: inv.store,
          installments: inv.payments.map((p) => ({
            id: p.id,
            amount: Number(p.amount),
            date: p.paymentDate.toISOString(),
            method: p.paymentMethod,
            ref: p.transactionRef || "",
          })),
          previewItems: inv.items.map((it) => ({
            productName: it.product.name,
            hsn: it.product.hsnCode || "",
            batch: it.batch.batchNumber,
            qty: Number(it.quantity),
            rate: Number(it.unitPrice),
            total: Number(it.totalAmount),
          })),
        },
      });
    }

    // Try Vendor Payment
    const supplierPayment = await prisma.supplierPayment.findUnique({
      where: { id },
      include: {
        supplier: true,
        purchaseInvoice: {
          include: {
            payments: {
              orderBy: { paymentDate: "asc" },
            },
            items: {
              include: {
                product: { select: { id: true, name: true, hsnCode: true } },
                batch: { select: { id: true, batchNumber: true, expiryDate: true } },
              },
              take: 10,
            },
          },
        },
      },
    });

    if (supplierPayment) {
      const pinv = supplierPayment.purchaseInvoice;
      const amountNum = Number(supplierPayment.amount);
      const totalAmount = pinv ? Number(pinv.totalAmount) : amountNum;
      const paidAmount = pinv ? Number(pinv.paidAmount) : amountNum;

      const store = await prisma.store.findUnique({
        where: { id: supplierPayment.storeId },
      });

      return reply.send({
        success: true,
        payment: {
          id: supplierPayment.id,
          paymentNumber: `PMT-${supplierPayment.id.slice(0, 8).toUpperCase()}`,
          paymentType: "VENDOR",
          date: supplierPayment.paymentDate.toISOString(),
          amount: amountNum,
          amountInWords: formatIndianCurrencyWords(amountNum),
          paymentMethod: supplierPayment.paymentMethod,
          transactionRef: supplierPayment.referenceNumber || "",
          notes: supplierPayment.notes || "",
          partnerId: supplierPayment.supplier.id,
          partnerName: supplierPayment.supplier.businessName,
          partnerPhone: supplierPayment.supplier.phone || "",
          partnerAddress: supplierPayment.supplier.address || "",
          partnerGstin: supplierPayment.supplier.gstin || "",
          partnerType: "SUPPLIER",
          invoiceId: pinv?.id || null,
          invoiceNumber: pinv?.supplierInvoiceNumber || pinv?.invoiceNumber || "General Supplier Account",
          invoiceTotal: totalAmount,
          invoicePaid: paidAmount,
          invoiceBalanceRemaining: pinv ? Number((totalAmount - paidAmount).toFixed(2)) : 0,
          invoiceStatus: pinv?.paymentStatus || "PAID",
          store: store || {
            name: "City Medical Store",
            address: "123 Main Street, Navrangpura",
            city: "Ahmedabad",
            phone: "+91 9876543210",
            gstin: "24AAAAA0000A1Z5",
            drugLicenseNo: "GJ-AHM-2024-DL-8842",
          },
          installments: pinv
            ? pinv.payments.map((p: any) => ({
                id: p.id,
                amount: Number(p.amount),
                date: p.paymentDate.toISOString(),
                method: p.paymentMethod,
                ref: p.referenceNumber || "",
              }))
            : [],
          previewItems: pinv
            ? pinv.items.map((it: any) => ({
                productName: it.product.name,
                hsn: it.product.hsnCode || "",
                batch: it.batch.batchNumber,
                qty: Number(it.quantity),
                rate: Number(it.purchaseRate),
                total: Number(it.totalAmount),
              }))
            : [],
        },
      });
    }

    return reply.status(404).send({ success: false, message: "Payment receipt / voucher not found." });
  });
}
