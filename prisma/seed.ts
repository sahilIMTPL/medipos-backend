import { PrismaClient, Role, BatchStatus, MovementType, PaymentMethod, PaymentStatus, InvoiceStatus } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Populating Real Medical POS Database Data...");

  // 1. Clean existing records for fresh real seed
  await prisma.salesReturnItem.deleteMany();
  await prisma.salesReturn.deleteMany();
  await prisma.salesPayment.deleteMany();
  await prisma.salesItem.deleteMany();
  await prisma.salesInvoice.deleteMany();
  await prisma.purchaseReturnItem.deleteMany();
  await prisma.purchaseReturn.deleteMany();
  await prisma.supplierPayment.deleteMany();
  await prisma.purchaseItem.deleteMany();
  await prisma.purchaseInvoice.deleteMany();
  await prisma.stockMovement.deleteMany();
  await prisma.productBatch.deleteMany();
  await prisma.productUnitConversion.deleteMany();
  await prisma.product.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.userStoreAssignment.deleteMany();
  await prisma.storeSetting.deleteMany();
  await prisma.invoiceSequence.deleteMany();
  await prisma.store.deleteMany();
  await prisma.user.deleteMany();
  await prisma.category.deleteMany();
  await prisma.unit.deleteMany();

  // 2. Units of Measurement
  const unitsData = [
    { name: "Tablet", code: "TAB", isBaseUnit: true },
    { name: "Capsule", code: "CAP", isBaseUnit: true },
    { name: "Strip", code: "STRIP", isBaseUnit: false },
    { name: "Box", code: "BOX", isBaseUnit: false },
    { name: "Bottle", code: "BTL", isBaseUnit: true },
    { name: "Vial", code: "VIAL", isBaseUnit: true },
    { name: "Millilitre", code: "ML", isBaseUnit: true },
  ];
  const units: Record<string, any> = {};
  for (const u of unitsData) {
    units[u.code] = await prisma.unit.create({ data: u });
  }

  // 3. Medicine Categories
  const categoriesData = [
    { name: "Analgesic", description: "Pain relief & fever" },
    { name: "Antibiotic", description: "Bacterial infections" },
    { name: "Anti-ulcer", description: "Stomach & acidity" },
    { name: "Anti-fungal", description: "Fungal infections" },
    { name: "Vitamin", description: "Supplements & immunity" },
  ];
  const categories: Record<string, any> = {};
  for (const c of categoriesData) {
    categories[c.name] = await prisma.category.create({ data: c });
  }

  // 4. Primary Store (City Medical Store from UI/UX)
  const store = await prisma.store.create({
    data: {
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
      isActive: true,
      settings: {
        create: {
          invoicePrefix: "INV",
          thermalPrintWidth: 80,
          expiryAlertDays: 30,
          lowStockThreshold: 15,
          defaultTaxRate: 12.0,
          enableLooseSale: true,
        },
      },
      invoiceSequences: {
        create: {
          series: "SALES",
          year: new Date().getFullYear(),
          lastSequence: 124,
        },
      },
    },
  });

  // Secondary Store for multi-store demonstration
  await prisma.store.create({
    data: {
      name: "Apollo MedCare Hub",
      code: "STORE-002",
      address: "Station Road",
      city: "Ahmedabad",
      state: "Gujarat",
      phone: "+91 9876543211",
      email: "apollo@medcare.com",
      gstin: "24AAACA1111A1Z9",
      drugLicenseNo: "GJ-AHM-2024-DL-9912",
      isActive: true,
    },
  });

  // 5. Admin Users
  const adminPasswordHash = await bcrypt.hash("StoreAdmin@123", 10);
  const storeAdmin = await prisma.user.create({
    data: {
      email: "admin@citymedical.com",
      username: "admin",
      fullName: "Admin",
      phone: "+91 9876543210",
      passwordHash: adminPasswordHash,
      role: Role.ADMIN,
      isActive: true,
      storeAssignments: {
        create: {
          storeId: store.id,
          isDefault: true,
        },
      },
    },
  });

  const superAdminPasswordHash = await bcrypt.hash("SuperAdmin@123", 10);
  await prisma.user.create({
    data: {
      email: "superadmin@medipos.com",
      username: "superadmin",
      fullName: "Super Admin",
      passwordHash: superAdminPasswordHash,
      role: Role.SUPER_ADMIN,
      isActive: true,
    },
  });

  // 6. Real Customers
  const customerWalkin = await prisma.customer.create({
    data: { storeId: store.id, name: "Walk-in", phone: null },
  });
  const customerRajesh = await prisma.customer.create({
    data: { storeId: store.id, name: "Rajesh Kumar", phone: "+91 9876543210" },
  });
  const customerSuresh = await prisma.customer.create({
    data: { storeId: store.id, name: "Suresh Patel", phone: "+91 9876543212" },
  });

  // 7. Real Suppliers
  const supplierABC = await prisma.supplier.create({
    data: {
      storeId: store.id,
      businessName: "ABC Pharma Distributors",
      contactPerson: "Rajesh Shah",
      phone: "9876543210",
      email: "orders@abcpharma.com",
      address: "Naroda GIDC, Ahmedabad",
      gstin: "24AABCA1234F1Z8",
      drugLicenseNo: "DL-GJ-DIST-0012",
      paymentTerms: "Net 30",
    },
  });

  // 8. Products Matching UI/UX Screen
  const productsList = [
    {
      name: "Paracetamol 500mg",
      brandName: "Cipla",
      genericName: "Paracetamol 500mg",
      category: "Analgesic",
      dosageForm: "Tablet",
      strength: "500 mg",
      packDescription: "Strip (10)",
      sku: "MED-PARA-500",
      barcode: "8901111000101",
      hsnCode: "30049060",
      mrp: 32.0,
      cost: 20.0,
      reorderLevel: 50,
      unitsPerStrip: 10,
    },
    {
      name: "Crocin 650",
      brandName: "GSK",
      genericName: "Paracetamol 650mg",
      category: "Analgesic",
      dosageForm: "Tablet",
      strength: "650 mg",
      packDescription: "Strip (15)",
      sku: "MED-CROC-650",
      barcode: "8901111000102",
      hsnCode: "30049060",
      mrp: 45.0,
      cost: 28.0,
      reorderLevel: 50,
      unitsPerStrip: 15,
    },
    {
      name: "Azithromycin 500",
      brandName: "Alembic",
      genericName: "Azithromycin 500mg",
      category: "Antibiotic",
      dosageForm: "Tablet",
      strength: "500 mg",
      packDescription: "Strip (5)",
      sku: "MED-AZIT-500",
      barcode: "8901111000103",
      hsnCode: "30042010",
      mrp: 120.0,
      cost: 75.0,
      reorderLevel: 50,
      unitsPerStrip: 5,
    },
    {
      name: "Pantoprazole 40mg",
      brandName: "Alkem",
      genericName: "Pantoprazole 40mg",
      category: "Anti-ulcer",
      dosageForm: "Tablet",
      strength: "40 mg",
      packDescription: "Strip (10)",
      sku: "MED-PANT-40",
      barcode: "8901111000104",
      hsnCode: "30049039",
      mrp: 95.0,
      cost: 60.0,
      reorderLevel: 50,
      unitsPerStrip: 10,
    },
    {
      name: "Amoxicillin 500mg",
      brandName: "Cipla",
      genericName: "Amoxicillin 500mg",
      category: "Antibiotic",
      dosageForm: "Capsule",
      strength: "500 mg",
      packDescription: "Capsule (10)",
      sku: "MED-AMOX-500",
      barcode: "8901111000105",
      hsnCode: "30042010",
      mrp: 75.0,
      cost: 45.0,
      reorderLevel: 50,
      unitsPerStrip: 10,
    },
  ];

  const createdProds: Record<string, any> = {};
  const now = new Date();

  for (const p of productsList) {
    const prod = await prisma.product.create({
      data: {
        storeId: store.id,
        name: p.name,
        brandName: p.brandName,
        genericName: p.genericName,
        categoryId: categories[p.category].id,
        dosageForm: p.dosageForm,
        strength: p.strength,
        packDescription: p.packDescription,
        sku: p.sku,
        barcode: p.barcode,
        hsnCode: p.hsnCode,
        gstRate: 12.0,
        mrp: p.mrp,
        defaultPurchasePrice: p.cost,
        defaultSellingPrice: p.mrp,
        baseUnitId: units["TAB"].id,
        purchaseUnitId: units["BOX"].id,
        saleUnitId: units["STRIP"].id,
        reorderLevel: p.reorderLevel,
      },
    });

    createdProds[p.name] = prod;

    // Unit conversion: 1 STRIP = p.unitsPerStrip TAB
    await prisma.productUnitConversion.create({
      data: {
        productId: prod.id,
        fromUnitId: units["STRIP"].id,
        toUnitId: units["TAB"].id,
        conversionFactor: p.unitsPerStrip,
      },
    });

    // Create 2 Active Batches per medicine
    const expDate1 = new Date(now.getFullYear() + 1, now.getMonth() + 4, 15);
    await prisma.productBatch.create({
      data: {
        storeId: store.id,
        productId: prod.id,
        batchNumber: `BAT-${p.sku.slice(-4)}-A`,
        mfgDate: new Date(now.getFullYear(), now.getMonth() - 3, 1),
        expiryDate: expDate1,
        purchasePrice: p.cost / p.unitsPerStrip,
        mrp: p.mrp / p.unitsPerStrip,
        receivedQty: 500,
        availableQty: 450,
        supplierId: supplierABC.id,
        status: BatchStatus.ACTIVE,
      },
    });
  }

  // 9. Add Expiring Soon Batches (< 30 Days) -> 26 items demonstration
  const nearExpiryDate = new Date(now);
  nearExpiryDate.setDate(nearExpiryDate.getDate() + 18); // 18 days from today

  for (let i = 1; i <= 26; i++) {
    const targetProd = createdProds[productsList[i % productsList.length].name];
    await prisma.productBatch.create({
      data: {
        storeId: store.id,
        productId: targetProd.id,
        batchNumber: `EXP-NEAR-${100 + i}`,
        mfgDate: new Date(now.getFullYear() - 1, now.getMonth(), 1),
        expiryDate: nearExpiryDate,
        purchasePrice: 2.0,
        mrp: 3.5,
        receivedQty: 50,
        availableQty: 1, // 1 item each
        supplierId: supplierABC.id,
        status: BatchStatus.ACTIVE,
      },
    });
  }

  // 10. Add Expired Batches -> 5 items demonstration
  const pastExpiryDate = new Date(now);
  pastExpiryDate.setDate(pastExpiryDate.getDate() - 15); // expired 15 days ago

  for (let i = 1; i <= 5; i++) {
    const targetProd = createdProds[productsList[i - 1].name];
    await prisma.productBatch.create({
      data: {
        storeId: store.id,
        productId: targetProd.id,
        batchNumber: `EXP-PAST-${200 + i}`,
        mfgDate: new Date(now.getFullYear() - 2, now.getMonth(), 1),
        expiryDate: pastExpiryDate,
        purchasePrice: 2.5,
        mrp: 4.0,
        receivedQty: 20,
        availableQty: 1,
        supplierId: supplierABC.id,
        status: BatchStatus.EXPIRED,
      },
    });
  }

  // 11. Add Low Stock Products (18 items demonstration)
  for (let i = 1; i <= 13; i++) {
    const dummyProd = await prisma.product.create({
      data: {
        storeId: store.id,
        name: `Low Stock Medicine #${i}`,
        sku: `MED-LOW-${i}`,
        mrp: 50.0,
        defaultPurchasePrice: 30.0,
        defaultSellingPrice: 50.0,
        baseUnitId: units["TAB"].id,
        purchaseUnitId: units["BOX"].id,
        saleUnitId: units["STRIP"].id,
        reorderLevel: 50,
      },
    });

    await prisma.productBatch.create({
      data: {
        storeId: store.id,
        productId: dummyProd.id,
        batchNumber: `LOW-B-${i}`,
        expiryDate: new Date(now.getFullYear() + 1, 5, 1),
        purchasePrice: 3.0,
        mrp: 5.0,
        receivedQty: 10,
        availableQty: 8, // below 50 reorder level
        status: BatchStatus.ACTIVE,
      },
    });
  }

  // 12. Create Recent 5 Invoices matching image exactly:
  // INV-000124 | 04:12 PM | Walk-in | ₹ 450
  // INV-000123 | 03:50 PM | Walk-in | ₹ 1,280
  // INV-000122 | 03:20 PM | Rajesh Kumar | ₹ 620
  // INV-000121 | 02:45 PM | Walk-in | ₹ 320
  // INV-000120 | 02:10 PM | Suresh Patel | ₹ 950
  const sampleInvoices = [
    { no: "INV-000124", customer: customerWalkin, amount: 450, hoursAgo: 1, minsAgo: 10 },
    { no: "INV-000123", customer: customerWalkin, amount: 1280, hoursAgo: 1, minsAgo: 32 },
    { no: "INV-000122", customer: customerRajesh, amount: 620, hoursAgo: 2, minsAgo: 2 },
    { no: "INV-000121", customer: customerWalkin, amount: 320, hoursAgo: 2, minsAgo: 37 },
    { no: "INV-000120", customer: customerSuresh, amount: 950, hoursAgo: 3, minsAgo: 12 },
  ];

  for (const inv of sampleInvoices) {
    const invTime = new Date(now);
    invTime.setHours(now.getHours() - inv.hoursAgo, now.getMinutes() - inv.minsAgo);

    await prisma.salesInvoice.create({
      data: {
        storeId: store.id,
        invoiceNumber: inv.no,
        customerId: inv.customer.id,
        invoiceDate: invTime,
        subtotal: inv.amount,
        grandTotal: inv.amount,
        paidAmount: inv.amount,
        paymentStatus: PaymentStatus.PAID,
        paymentMethod: PaymentMethod.CASH,
        status: InvoiceStatus.COMPLETED,
        createdById: storeAdmin.id,
      },
    });
  }

  // Add 19 more invoices today so Today's Sales = 24 Invoices and ₹12,450
  const remainingTodayAmount = 12450 - (450 + 1280 + 620 + 320 + 950); // ₹8,830 across 19 invoices (~₹464 each)
  const perBill = Math.round(remainingTodayAmount / 19);

  for (let i = 1; i <= 19; i++) {
    const invTime = new Date(now);
    invTime.setHours(9 + Math.floor(i / 3), (i * 17) % 60);

    const billAmt = i === 19 ? remainingTodayAmount - perBill * 18 : perBill;

    await prisma.salesInvoice.create({
      data: {
        storeId: store.id,
        invoiceNumber: `INV-0001${100 - i}`,
        customerId: customerWalkin.id,
        invoiceDate: invTime,
        subtotal: billAmt,
        grandTotal: billAmt,
        paidAmount: billAmt,
        paymentStatus: PaymentStatus.PAID,
        paymentMethod: PaymentMethod.UPI,
        status: InvoiceStatus.COMPLETED,
        createdById: storeAdmin.id,
      },
    });
  }

  // 13. Top Selling Medicines (Today) - create sales items
  // 1: Paracetamol 500mg | 35 | ₹ 1,750
  // 2: Crocin 650 | 20 | ₹ 1,600
  // 3: Azithromycin 500 | 12 | ₹ 1,440
  // 4: Pantoprazole 40mg | 10 | ₹ 900
  // 5: Amoxicillin 500mg | 8 | ₹ 800
  const topSalesData = [
    { name: "Paracetamol 500mg", qty: 35, amount: 1750 },
    { name: "Crocin 650", qty: 20, amount: 1600 },
    { name: "Azithromycin 500", qty: 12, amount: 1440 },
    { name: "Pantoprazole 40mg", qty: 10, amount: 900 },
    { name: "Amoxicillin 500mg", qty: 8, amount: 800 },
  ];

  const firstInvoice = await prisma.salesInvoice.findFirst({ where: { storeId: store.id } });
  if (firstInvoice) {
    for (const item of topSalesData) {
      const prod = createdProds[item.name];
      const batch = await prisma.productBatch.findFirst({ where: { productId: prod.id } });
      if (batch) {
        await prisma.salesItem.create({
          data: {
            salesInvoiceId: firstInvoice.id,
            productId: prod.id,
            batchId: batch.id,
            saleUnitId: units["STRIP"].id,
            quantity: item.qty,
            baseQuantity: item.qty * 10,
            unitPrice: item.amount / item.qty,
            netRate: item.amount / item.qty,
            subtotal: item.amount,
            totalAmount: item.amount,
          },
        });
      }
    }
  }

  // 14. Today's Purchases (2 Invoices = ₹8,200)
  await prisma.purchaseInvoice.create({
    data: {
      storeId: store.id,
      supplierId: supplierABC.id,
      invoiceNumber: "PUR-00045",
      supplierInvoiceNumber: "SUPP-8921",
      invoiceDate: now,
      subtotal: 6700,
      totalAmount: 6700,
      paidAmount: 6700,
      paymentStatus: PaymentStatus.PAID,
      createdById: storeAdmin.id,
    },
  });

  await prisma.purchaseInvoice.create({
    data: {
      storeId: store.id,
      supplierId: supplierABC.id,
      invoiceNumber: "PUR-00046",
      supplierInvoiceNumber: "SUPP-8922",
      invoiceDate: now,
      subtotal: 1500,
      totalAmount: 1500,
      paidAmount: 1500,
      paymentStatus: PaymentStatus.PAID,
      createdById: storeAdmin.id,
    },
  });

  // 15. Previous 6 Days Sales vs Purchases Data
  // Days: 18, 19, 20, 21, 22, 23
  const pastDaysData = [
    { daysAgo: 6, sales: 13800, purchases: 6200 },
    { daysAgo: 5, sales: 12200, purchases: 7900 },
    { daysAgo: 4, sales: 10900, purchases: 6500 },
    { daysAgo: 3, sales: 8500, purchases: 4100 },
    { daysAgo: 2, sales: 11700, purchases: 5800 },
    { daysAgo: 1, sales: 15200, purchases: 8900 },
  ];

  for (const p of pastDaysData) {
    const pastDate = new Date(now);
    pastDate.setDate(pastDate.getDate() - p.daysAgo);

    await prisma.salesInvoice.create({
      data: {
        storeId: store.id,
        invoiceNumber: `INV-HIST-${p.daysAgo}`,
        customerId: customerWalkin.id,
        invoiceDate: pastDate,
        subtotal: p.sales,
        grandTotal: p.sales,
        paidAmount: p.sales,
        paymentStatus: PaymentStatus.PAID,
        paymentMethod: PaymentMethod.CASH,
        status: InvoiceStatus.COMPLETED,
        createdById: storeAdmin.id,
      },
    });

    await prisma.purchaseInvoice.create({
      data: {
        storeId: store.id,
        supplierId: supplierABC.id,
        invoiceNumber: `PUR-HIST-${p.daysAgo}`,
        supplierInvoiceNumber: `SUPP-H-${p.daysAgo}`,
        invoiceDate: pastDate,
        subtotal: p.purchases,
        totalAmount: p.purchases,
        paidAmount: p.purchases,
        paymentStatus: PaymentStatus.PAID,
        createdById: storeAdmin.id,
      },
    });
  }

  console.log("✅ Seed finished successfully! All tables populated with live PostgreSQL data.");
}

main()
  .catch((e) => {
    console.error("Error during seeding:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
