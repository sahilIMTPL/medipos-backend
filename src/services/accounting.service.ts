import { prisma } from "../db";
import { AccountType, JournalType, PaymentMethod, PaymentStatus } from "@prisma/client";

export interface DefaultAccountDef {
  code: string;
  name: string;
  type: AccountType;
  description: string;
}

export const DEFAULT_ACCOUNTS: DefaultAccountDef[] = [
  // Current Assets
  { code: "101000", name: "Cash on Hand", type: AccountType.ASSET, description: "Physical cash in register / drawer" },
  { code: "102000", name: "Bank & UPI Account", type: AccountType.ASSET, description: "Operating bank account & digital payments (UPI/Card)" },
  { code: "105000", name: "Accounts Receivable (Debtors)", type: AccountType.ASSET, description: "Amounts owed by credit customers & regular patients" },
  { code: "106000", name: "Stock / Inventory Asset", type: AccountType.ASSET, description: "Total inventory valuation on hand" },
  { code: "107000", name: "Input Tax Credit (ITC)", type: AccountType.ASSET, description: "GST paid on purchases eligible for ITC offset" },

  // Current Liabilities
  { code: "201000", name: "Accounts Payable (Creditors)", type: AccountType.LIABILITY, description: "Amounts owed to pharmaceutical distributors & vendors" },
  { code: "202000", name: "Output Tax Payable (GST)", type: AccountType.LIABILITY, description: "GST collected on medicine & OTC sales to be remitted" },

  // Equity
  { code: "301000", name: "Owner's Capital", type: AccountType.EQUITY, description: "Initial and contributed store capital" },
  { code: "302000", name: "Retained Earnings", type: AccountType.EQUITY, description: "Cumulative net earnings retained in business" },

  // Income
  { code: "401000", name: "Sales Revenue", type: AccountType.INCOME, description: "Gross revenue from prescription & OTC medicines" },
  { code: "402000", name: "Discounts Received", type: AccountType.INCOME, description: "Cash/Trade discounts received from distributors" },

  // Expenses
  { code: "501000", name: "Cost of Goods Sold (COGS)", type: AccountType.EXPENSE, description: "Cost of medicines & pharmaceutical products sold" },
  { code: "502000", name: "Operating Expenses", type: AccountType.EXPENSE, description: "Store utilities, rent, and administrative costs" },
  { code: "503000", name: "Discounts & Round-off Allowed", type: AccountType.EXPENSE, description: "Discounts given to patients and fractional round-offs" },
];

export const DEFAULT_JOURNALS = [
  { code: "CSH", name: "Cash Journal", type: JournalType.CASH, accountCode: "101000" },
  { code: "BNK", name: "Bank & Digital Journal", type: JournalType.BANK, accountCode: "102000" },
  { code: "INV", name: "Customer Invoices", type: JournalType.SALE, accountCode: "401000" },
  { code: "BILL", name: "Vendor Bills", type: JournalType.PURCHASE, accountCode: "501000" },
  { code: "GEN", name: "Miscellaneous Operations", type: JournalType.GENERAL, accountCode: "301000" },
];

/**
 * Ensure default Chart of Accounts and Journals exist for a store.
 */
export async function ensureDefaultAccountingSetup(storeId: string) {
  const accountCount = await prisma.account.count({ where: { storeId } });

  if (accountCount === 0) {
    // 1. Create Default Accounts
    for (const acc of DEFAULT_ACCOUNTS) {
      await prisma.account.create({
        data: {
          storeId,
          code: acc.code,
          name: acc.name,
          type: acc.type,
          description: acc.description,
          currentBalance: 0,
        },
      });
    }
  }

  const journalCount = await prisma.journal.count({ where: { storeId } });
  if (journalCount === 0) {
    const storeAccounts = await prisma.account.findMany({ where: { storeId } });
    const accMap = new Map(storeAccounts.map((a) => [a.code, a.id]));

    for (const j of DEFAULT_JOURNALS) {
      await prisma.journal.create({
        data: {
          storeId,
          name: j.name,
          code: j.code,
          type: j.type,
          defaultAccountId: accMap.get(j.accountCode) || null,
        },
      });
    }
  }
}

/**
 * Helper to get or generate sequential entry number for a journal
 */
export async function getNextEntryNumber(storeId: string, journalCode: string): Promise<string> {
  const currentYear = new Date().getFullYear();
  const count = await prisma.journalEntry.count({
    where: {
      storeId,
      entryNumber: { startsWith: `${journalCode}/${currentYear}/` },
    },
  });
  return `${journalCode}/${currentYear}/${String(count + 1).padStart(5, "0")}`;
}

/**
 * Register double-entry journal entry for a Sales Invoice
 */
export async function postSalesInvoiceJournalEntry(invoiceId: string) {
  const invoice = await prisma.salesInvoice.findUnique({
    where: { id: invoiceId },
    include: {
      customer: true,
      store: true,
    },
  });

  if (!invoice) return null;

  await ensureDefaultAccountingSetup(invoice.storeId);

  const accounts = await prisma.account.findMany({ where: { storeId: invoice.storeId } });
  const accByCode = new Map(accounts.map((a) => [a.code, a]));

  const saleJournal = await prisma.journal.findFirst({
    where: { storeId: invoice.storeId, type: JournalType.SALE },
  });

  if (!saleJournal) return null;

  const total = Number(invoice.grandTotal);
  const tax = Number(invoice.taxTotal);
  const netRevenue = Number((total - tax).toFixed(2));

  const entryNumber = await getNextEntryNumber(invoice.storeId, saleJournal.code);

  const arAccount = accByCode.get("105000"); // Accounts Receivable
  const revAccount = accByCode.get("401000"); // Sales Revenue
  const gstAccount = accByCode.get("202000"); // Output Tax Payable

  if (!arAccount || !revAccount) return null;

  // Double entry:
  // Debit: Accounts Receivable (Full Total)
  // Credit: Sales Revenue (Net)
  // Credit: Output Tax Payable (Tax)
  const items: any[] = [
    {
      accountId: arAccount.id,
      partnerType: "CUSTOMER",
      partnerId: invoice.customerId || null,
      partnerName: invoice.customer?.name || "Walk-in Customer",
      label: `Sales Invoice ${invoice.invoiceNumber}`,
      name: `Receivable for ${invoice.invoiceNumber}`,
      debit: total,
      credit: 0,
    },
    {
      accountId: revAccount.id,
      label: `Revenue for ${invoice.invoiceNumber}`,
      name: `Revenue for ${invoice.invoiceNumber}`,
      debit: 0,
      credit: netRevenue,
    },
  ];

  if (tax > 0 && gstAccount) {
    items.push({
      accountId: gstAccount.id,
      label: `Output GST on ${invoice.invoiceNumber}`,
      name: `Output GST on ${invoice.invoiceNumber}`,
      debit: 0,
      credit: tax,
    });
  }

  const entry = await prisma.journalEntry.create({
    data: {
      storeId: invoice.storeId,
      journalId: saleJournal.id,
      entryNumber,
      reference: invoice.invoiceNumber,
      date: invoice.invoiceDate,
      status: "POSTED",
      narration: `Sales Invoice ${invoice.invoiceNumber}`,
      amount: total,
      salesInvoiceId: invoice.id,
      items: {
        create: items,
      },
    },
  });

  // Update account balances
  await prisma.account.update({
    where: { id: arAccount.id },
    data: { currentBalance: { increment: total } },
  });
  await prisma.account.update({
    where: { id: revAccount.id },
    data: { currentBalance: { increment: netRevenue } },
  });
  if (tax > 0 && gstAccount) {
    await prisma.account.update({
      where: { id: gstAccount.id },
      data: { currentBalance: { increment: tax } },
    });
  }

  // Update customer current balance if not a walk-in
  if (invoice.customerId) {
    const balanceDue = Number(invoice.grandTotal) - Number(invoice.paidAmount);
    if (balanceDue > 0) {
      await prisma.customer.update({
        where: { id: invoice.customerId },
        data: { currentBalance: { increment: balanceDue } },
      });
    }
  }

  return entry;
}

/**
 * Register double-entry journal entry for a Purchase Invoice (Vendor Bill)
 */
export async function postPurchaseInvoiceJournalEntry(purchaseId: string) {
  const purchase = await prisma.purchaseInvoice.findUnique({
    where: { id: purchaseId },
    include: {
      supplier: true,
      store: true,
    },
  });

  if (!purchase) return null;

  await ensureDefaultAccountingSetup(purchase.storeId);

  const accounts = await prisma.account.findMany({ where: { storeId: purchase.storeId } });
  const accByCode = new Map(accounts.map((a) => [a.code, a]));

  const billJournal = await prisma.journal.findFirst({
    where: { storeId: purchase.storeId, type: JournalType.PURCHASE },
  });

  if (!billJournal) return null;

  const total = Number(purchase.totalAmount);
  const tax = Number(purchase.taxTotal);
  const netCost = Number((total - tax).toFixed(2));

  const entryNumber = await getNextEntryNumber(purchase.storeId, billJournal.code);

  const apAccount = accByCode.get("201000"); // Accounts Payable
  const stockAccount = accByCode.get("106000"); // Stock / Inventory Asset
  const itcAccount = accByCode.get("107000"); // Input Tax Credit

  if (!apAccount || !stockAccount) return null;

  // Double entry:
  // Debit: Stock / Inventory Asset (Net Cost)
  // Debit: Input Tax Credit (Tax)
  // Credit: Accounts Payable (Distributor) (Full Total)
  const items: any[] = [
    {
      accountId: stockAccount.id,
      label: `Inventory stock from ${purchase.supplier.businessName} (${purchase.supplierInvoiceNumber || purchase.invoiceNumber})`,
      name: `Stock received - ${purchase.supplierInvoiceNumber || purchase.invoiceNumber}`,
      debit: netCost,
      credit: 0,
    },
  ];

  if (tax > 0 && itcAccount) {
    items.push({
      accountId: itcAccount.id,
      label: `Input Tax Credit (ITC) for ${purchase.invoiceNumber}`,
      name: `ITC on ${purchase.invoiceNumber}`,
      debit: tax,
      credit: 0,
    });
  }

  items.push({
    accountId: apAccount.id,
    partnerType: "SUPPLIER",
    partnerId: purchase.supplierId,
    partnerName: purchase.supplier.businessName,
    label: `Vendor Bill ${purchase.supplierInvoiceNumber || purchase.invoiceNumber}`,
    name: `Payable to ${purchase.supplier.businessName}`,
    debit: 0,
    credit: total,
  });

  const entry = await prisma.journalEntry.create({
    data: {
      storeId: purchase.storeId,
      journalId: billJournal.id,
      entryNumber,
      reference: purchase.supplierInvoiceNumber || purchase.invoiceNumber,
      date: purchase.invoiceDate,
      status: "POSTED",
      narration: `Vendor Bill from ${purchase.supplier.businessName}`,
      amount: total,
      purchaseInvoiceId: purchase.id,
      items: {
        create: items,
      },
    },
  });

  // Update account balances
  await prisma.account.update({
    where: { id: stockAccount.id },
    data: { currentBalance: { increment: netCost } },
  });
  if (tax > 0 && itcAccount) {
    await prisma.account.update({
      where: { id: itcAccount.id },
      data: { currentBalance: { increment: tax } },
    });
  }
  await prisma.account.update({
    where: { id: apAccount.id },
    data: { currentBalance: { increment: total } },
  });

  return entry;
}

/**
 * Register a customer payment (partial or full) against a Customer Invoice.
 */
export async function registerCustomerPayment(params: {
  salesInvoiceId: string;
  amount: number;
  paymentMethod: PaymentMethod;
  paymentDate?: Date;
  referenceNumber?: string;
  notes?: string;
}) {
  const { salesInvoiceId, amount, paymentMethod, paymentDate = new Date(), referenceNumber, notes } = params;

  if (amount <= 0) {
    throw new Error("Payment amount must be greater than zero.");
  }

  const invoice = await prisma.salesInvoice.findUnique({
    where: { id: salesInvoiceId },
    include: { customer: true },
  });

  if (!invoice) {
    throw new Error("Sales Invoice not found.");
  }

  const grandTotal = Number(invoice.grandTotal);
  const currentPaid = Number(invoice.paidAmount);
  const remainingDue = Number((grandTotal - currentPaid).toFixed(2));

  if (amount > remainingDue + 0.05) {
    throw new Error(`Payment amount (₹${amount}) exceeds remaining balance due (₹${remainingDue}).`);
  }

  const newPaidAmount = Number((currentPaid + amount).toFixed(2));
  let newStatus: PaymentStatus = PaymentStatus.PARTIAL;
  if (newPaidAmount >= grandTotal - 0.01) {
    newStatus = PaymentStatus.PAID;
  }

  await ensureDefaultAccountingSetup(invoice.storeId);
  const accounts = await prisma.account.findMany({ where: { storeId: invoice.storeId } });
  const accByCode = new Map(accounts.map((a) => [a.code, a]));

  const journalType = paymentMethod === PaymentMethod.CASH ? JournalType.CASH : JournalType.BANK;
  const journal = await prisma.journal.findFirst({
    where: { storeId: invoice.storeId, type: journalType },
  });

  const paymentAccountCode = paymentMethod === PaymentMethod.CASH ? "101000" : "102000";
  const paymentAccount = accByCode.get(paymentAccountCode);
  const arAccount = accByCode.get("105000"); // Accounts Receivable

  const result = await prisma.$transaction(async (tx) => {
    // Re-verify invoice inside transaction to prevent concurrent double-payments
    const freshInvoice = await tx.salesInvoice.findUnique({
      where: { id: salesInvoiceId },
    });

    if (!freshInvoice) {
      throw new Error("Sales Invoice not found.");
    }

    const freshGrandTotal = Number(freshInvoice.grandTotal);
    const freshCurrentPaid = Number(freshInvoice.paidAmount);
    const freshRemainingDue = Number((freshGrandTotal - freshCurrentPaid).toFixed(2));

    if (amount > freshRemainingDue + 0.05) {
      throw new Error(
        `Payment conflict: Invoice balance was already updated. Remaining due is ₹${freshRemainingDue.toFixed(2)}.`
      );
    }

    const freshNewPaidAmount = Number((freshCurrentPaid + amount).toFixed(2));
    let freshNewStatus: PaymentStatus = PaymentStatus.PARTIAL;
    if (freshNewPaidAmount >= freshGrandTotal - 0.01) {
      freshNewStatus = PaymentStatus.PAID;
    }

    // 1. Create Sales Payment
    const payment = await tx.salesPayment.create({
      data: {
        salesInvoiceId: freshInvoice.id,
        amount,
        paymentMethod,
        paymentDate,
        transactionRef: referenceNumber || null,
        notes: notes || `Payment against invoice ${freshInvoice.invoiceNumber}`,
      },
    });

    // 2. Update Sales Invoice
    const updatedInvoice = await tx.salesInvoice.update({
      where: { id: freshInvoice.id },
      data: {
        paidAmount: freshNewPaidAmount,
        paymentStatus: freshNewStatus,
      },
    });

    // 3. Decrement Customer currentBalance if customer exists
    if (invoice.customerId) {
      await tx.customer.update({
        where: { id: invoice.customerId },
        data: {
          currentBalance: {
            decrement: amount,
          },
        },
      });
    }

    // 4. Double-entry Journal Entry (Debit: Cash/Bank, Credit: Accounts Receivable)
    if (journal && paymentAccount && arAccount) {
      const entryNumber = await getNextEntryNumber(invoice.storeId, journal.code);
      await tx.journalEntry.create({
        data: {
          storeId: invoice.storeId,
          journalId: journal.id,
          entryNumber,
          reference: referenceNumber || invoice.invoiceNumber,
          date: paymentDate,
          status: "POSTED",
          narration: notes || `Payment for invoice ${invoice.invoiceNumber} (${paymentMethod})`,
          amount,
          salesInvoiceId: invoice.id,
          items: {
            create: [
              {
                accountId: paymentAccount.id,
                label: `Receipt from ${invoice.customer?.name || "Customer"} (${invoice.invoiceNumber})`,
                name: `Cash/Bank in from ${invoice.customer?.name || "Customer"}`,
                debit: amount,
                credit: 0,
              },
              {
                accountId: arAccount.id,
                partnerType: "CUSTOMER",
                partnerId: invoice.customerId || null,
                partnerName: invoice.customer?.name || "Customer",
                label: `Payment received for ${invoice.invoiceNumber}`,
                name: `Receivable reduction for ${invoice.invoiceNumber}`,
                debit: 0,
                credit: amount,
              },
            ],
          },
        },
      });

      // Update Account balances
      await tx.account.update({
        where: { id: paymentAccount.id },
        data: { currentBalance: { increment: amount } },
      });
      await tx.account.update({
        where: { id: arAccount.id },
        data: { currentBalance: { decrement: amount } },
      });
    }

    return { payment, invoice: updatedInvoice };
  });

  return result;
}

/**
 * Register a vendor payment (partial or full) against a Vendor Bill / Purchase Invoice.
 * Fixes previous bug: Updates PurchaseInvoice paidAmount & paymentStatus, updates Supplier balance, creates payment & journal entry.
 */
export async function registerVendorPayment(params: {
  purchaseInvoiceId?: string;
  supplierId: string;
  storeId?: string;
  amount: number;
  paymentMethod: PaymentMethod;
  paymentDate?: Date;
  referenceNumber?: string;
  notes?: string;
}) {
  const { purchaseInvoiceId, supplierId, amount, paymentMethod, paymentDate = new Date(), referenceNumber, notes } = params;

  if (amount <= 0) {
    throw new Error("Payment amount must be greater than zero.");
  }

  let invoice: any = null;
  if (purchaseInvoiceId) {
    invoice = await prisma.purchaseInvoice.findUnique({
      where: { id: purchaseInvoiceId },
    });
    if (!invoice) {
      throw new Error("Purchase Invoice not found.");
    }
  }

  const effectiveSupplierId = supplierId || invoice?.supplierId;
  if (!effectiveSupplierId) {
    throw new Error("Supplier / Vendor not found.");
  }

  const supplier = await prisma.supplier.findUnique({
    where: { id: effectiveSupplierId },
  });

  if (!supplier) {
    throw new Error("Supplier / Vendor not found.");
  }

  const storeId = params.storeId || supplier.storeId;

  await ensureDefaultAccountingSetup(storeId);
  const accounts = await prisma.account.findMany({ where: { storeId } });
  const accByCode = new Map(accounts.map((a) => [a.code, a]));

  const journalType = paymentMethod === PaymentMethod.CASH ? JournalType.CASH : JournalType.BANK;
  const journal = await prisma.journal.findFirst({
    where: { storeId, type: journalType },
  });

  const paymentAccountCode = paymentMethod === PaymentMethod.CASH ? "101000" : "102000";
  const paymentAccount = accByCode.get(paymentAccountCode);
  const apAccount = accByCode.get("201000"); // Accounts Payable

  const result = await prisma.$transaction(async (tx) => {
    // 1. Create Supplier Payment record
    const payment = await tx.supplierPayment.create({
      data: {
        storeId,
        supplierId,
        purchaseInvoiceId: invoice?.id || null,
        amount,
        paymentMethod,
        paymentDate,
        referenceNumber: referenceNumber || null,
        notes: notes || (invoice ? `Payment for bill ${invoice.supplierInvoiceNumber || invoice.invoiceNumber}` : `Vendor Payment`),
      },
    });

    // 2. If purchase invoice is specified, atomically re-verify and update paidAmount!
    let updatedInvoice: any = null;
    if (invoice) {
      const freshBill = await tx.purchaseInvoice.findUnique({
        where: { id: invoice.id },
      });

      if (!freshBill) {
        throw new Error("Purchase invoice / vendor bill not found.");
      }

      const currentPaid = Number(freshBill.paidAmount);
      const totalAmount = Number(freshBill.totalAmount);
      const remainingDue = Number((totalAmount - currentPaid).toFixed(2));

      if (amount > remainingDue + 0.05) {
        throw new Error(
          `Payment conflict: Bill balance was already updated. Remaining due is ₹${remainingDue.toFixed(2)}.`
        );
      }

      const newPaid = Number((currentPaid + amount).toFixed(2));

      let newStatus: PaymentStatus = PaymentStatus.PARTIAL;
      if (newPaid >= totalAmount - 0.01) {
        newStatus = PaymentStatus.PAID;
      }

      updatedInvoice = await tx.purchaseInvoice.update({
        where: { id: freshBill.id },
        data: {
          paidAmount: newPaid,
          paymentStatus: newStatus,
        },
      });
    }

    // 3. Decrement Supplier balance
    const updatedSupplier = await tx.supplier.update({
      where: { id: supplierId },
      data: {
        currentBalance: {
          decrement: amount,
        },
      },
    });

    // 4. Double-entry Journal Entry (Debit: Accounts Payable, Credit: Cash/Bank)
    if (journal && paymentAccount && apAccount) {
      const entryNumber = await getNextEntryNumber(storeId, journal.code);
      await tx.journalEntry.create({
        data: {
          storeId,
          journalId: journal.id,
          entryNumber,
          reference: referenceNumber || invoice?.supplierInvoiceNumber || invoice?.invoiceNumber || "VEND-PAY",
          date: paymentDate,
          status: "POSTED",
          narration: notes || `Payment to ${supplier.businessName} (${paymentMethod})`,
          amount,
          purchaseInvoiceId: invoice?.id || null,
          items: {
            create: [
              {
                accountId: apAccount.id,
                partnerType: "SUPPLIER",
                partnerId: supplier.id,
                partnerName: supplier.businessName,
                label: `Payment made to ${supplier.businessName} (${invoice ? invoice.supplierInvoiceNumber || invoice.invoiceNumber : "Account"})`,
                name: `Payable reduction to ${supplier.businessName}`,
                debit: amount,
                credit: 0,
              },
              {
                accountId: paymentAccount.id,
                label: `Disbursement to ${supplier.businessName}`,
                name: `Cash/Bank out to ${supplier.businessName}`,
                debit: 0,
                credit: amount,
              },
            ],
          },
        },
      });

      // Update Account balances
      await tx.account.update({
        where: { id: apAccount.id },
        data: { currentBalance: { decrement: amount } },
      });
      await tx.account.update({
        where: { id: paymentAccount.id },
        data: { currentBalance: { decrement: amount } },
      });
    }

    return { payment, invoice: updatedInvoice, supplier: updatedSupplier };
  });

  return result;
}

/**
 * Reconcile multiple journal items together
 */
export async function reconcileItems(itemIds: string[]) {
  if (itemIds.length < 2) {
    throw new Error("At least 2 journal items are required for reconciliation.");
  }

  const items = await prisma.journalItem.findMany({
    where: { id: { in: itemIds } },
  });

  if (items.length !== itemIds.length) {
    throw new Error("Some journal items could not be found.");
  }

  let totalDebit = 0;
  let totalCredit = 0;
  for (const it of items) {
    totalDebit += Number(it.debit);
    totalCredit += Number(it.credit);
  }

  const diff = Math.abs(totalDebit - totalCredit);
  if (diff > 0.05) {
    throw new Error(`Cannot reconcile: Debits (₹${totalDebit.toFixed(2)}) and Credits (₹${totalCredit.toFixed(2)}) must match.`);
  }

  const matchYear = new Date().getFullYear();
  const matchSeq = Math.floor(1000 + Math.random() * 9000);
  const matchingNumber = `REC-${matchYear}-${matchSeq}`;

  await prisma.journalItem.updateMany({
    where: { id: { in: itemIds } },
    data: {
      reconciled: true,
      matchingNumber,
    },
  });

  return { success: true, matchingNumber, itemCount: itemIds.length };
}
