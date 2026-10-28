import { PrismaClient, Role, AccountStatus } from "@prisma/client";

const prisma = new PrismaClient();

const PERMISSIONS = [
  // Platform & Store Provisioning
  { code: "platform:system_settings", resource: "platform", action: "manage", category: "Platform Governance", description: "Manage global platform settings, SMS/Email gateways, backups" },
  { code: "stores:create_onboard", resource: "stores", action: "create", category: "Platform Governance", description: "Onboard and provision new pharmacy store branches" },
  { code: "stores:suspend_activate", resource: "stores", action: "edit", category: "Platform Governance", description: "Suspend or reactivate store branches" },

  // User Management
  { code: "users:manage_all", resource: "users", action: "manage", category: "User Governance", description: "Manage all users across the entire platform" },
  { code: "users:manage_multi_store", resource: "users", action: "manage", category: "User Governance", description: "Manage Store Admins & Doctors across own assigned stores" },
  { code: "users:manage_store_users", resource: "users", action: "manage", category: "User Governance", description: "Manage Doctors and staff within own store" },

  // POS Billing
  { code: "pos:checkout", resource: "pos", action: "create", category: "Point of Sale", description: "Execute POS checkout and generate sales invoices" },
  { code: "pos:reprint_bill", resource: "pos", action: "view", category: "Point of Sale", description: "Reprint thermal and A4 receipts" },
  { code: "pos:apply_discount", resource: "pos", action: "edit", category: "Point of Sale", description: "Apply cart-level discounts" },

  // Inventory & Batches
  { code: "inventory:view_manage", resource: "inventory", action: "view", category: "Inventory Management", description: "View medicine catalog, stock levels, and batch expiry" },
  { code: "inventory:adjust_stock", resource: "inventory", action: "edit", category: "Inventory Management", description: "Perform stock count adjustments and reconciliation" },

  // Purchases & Vendor Bills
  { code: "purchases:view_create", resource: "purchases", action: "create", category: "Purchases & Inwards", description: "Receive goods, create purchase bills, handle vendor returns" },
  { code: "purchases:pay_bills", resource: "purchases", action: "edit", category: "Purchases & Inwards", description: "Disburse vendor payments and manage supplier ledgers" },

  // Accounting & Ledgers
  { code: "accounting:view_post", resource: "accounting", action: "create", category: "Double-Entry Accounting", description: "View accounts, post manual journal entries, bank reconciliation" },
  { code: "accounting:reports", resource: "accounting", action: "export", category: "Double-Entry Accounting", description: "Generate P&L, Balance Sheet, and General Ledger reports" },

  // GST Compliance
  { code: "gst:file_download", resource: "gst", action: "export", category: "GST Compliance", description: "File GSTR-1, GSTR-3B and download JSON filing packages" },

  // Doctor OPD Desk
  { code: "doctor:prescribe_rx", resource: "doctor", action: "create", category: "Doctor OPD Desk", description: "Write and issue digital electronic prescriptions" },
  { code: "doctor:patient_dossier", resource: "doctor", action: "view", category: "Doctor OPD Desk", description: "Access patient clinical medical history, allergies, vitals" },

  // DigiLocker & Identity Verification
  { code: "digilocker:verify_patient", resource: "digilocker", action: "view", category: "Statutory Verification", description: "Verify patient ABHA ID and Aadhaar identity" },
  { code: "digilocker:verify_doctor", resource: "digilocker", action: "view", category: "Statutory Verification", description: "Verify Doctor NMC medical council registration" },
];

const ROLES = [
  {
    code: Role.SUPER_ADMIN,
    name: "Super Admin",
    description: "Platform Owner with full software governance, branch onboarding, and user management authority across all stores.",
    isSystem: true,
    permissions: PERMISSIONS.map((p) => p.code), // All permissions
  },
  {
    code: Role.ADMIN,
    name: "Multi-Store Admin",
    description: "Multi-branch franchisee or owner managing multiple assigned store branches and their operational staff.",
    isSystem: true,
    permissions: [
      "users:manage_multi_store",
      "users:manage_store_users",
      "pos:checkout",
      "pos:reprint_bill",
      "pos:apply_discount",
      "inventory:view_manage",
      "inventory:adjust_stock",
      "purchases:view_create",
      "purchases:pay_bills",
      "accounting:view_post",
      "accounting:reports",
      "gst:file_download",
      "digilocker:verify_patient",
      "digilocker:verify_doctor",
    ],
  },
  {
    code: Role.STORE_ADMIN,
    name: "Store Admin",
    description: "Branch manager assigned strictly to one store with full store operational authority and management of own store users.",
    isSystem: true,
    permissions: [
      "users:manage_store_users",
      "pos:checkout",
      "pos:reprint_bill",
      "pos:apply_discount",
      "inventory:view_manage",
      "inventory:adjust_stock",
      "purchases:view_create",
      "purchases:pay_bills",
      "accounting:view_post",
      "accounting:reports",
      "gst:file_download",
      "digilocker:verify_patient",
      "doctor:patient_dossier",
    ],
  },
  {
    code: Role.DOCTOR,
    name: "Doctor",
    description: "Healthcare practitioner with dedicated OPD consultation panel, digital prescription writing, and patient clinical history.",
    isSystem: true,
    permissions: [
      "doctor:prescribe_rx",
      "doctor:patient_dossier",
      "digilocker:verify_patient",
      "inventory:view_manage",
    ],
  },
];

export async function seedRbac() {
  console.log("Seeding RBAC permissions...");
  for (const perm of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: perm.code },
      update: {
        resource: perm.resource,
        action: perm.action,
        category: perm.category,
        description: perm.description,
      },
      create: perm,
    });
  }

  console.log("Seeding RBAC roles & role-permission mappings...");
  for (const r of ROLES) {
    const roleDef = await prisma.roleDefinition.upsert({
      where: { code: r.code },
      update: {
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
      },
      create: {
        code: r.code,
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
      },
    });

    // Clear and link permissions
    const permissions = await prisma.permission.findMany({
      where: { code: { in: r.permissions } },
    });

    for (const p of permissions) {
      await prisma.rolePermissionMapping.upsert({
        where: {
          roleId_permissionId: {
            roleId: roleDef.id,
            permissionId: p.id,
          },
        },
        update: {},
        create: {
          roleId: roleDef.id,
          permissionId: p.id,
        },
      });
    }
  }

  // Assign existing users to their respective roleDefinitions
  const users = await prisma.user.findMany({
    include: { storeAssignments: true },
  });

  for (const u of users) {
    const roleDef = await prisma.roleDefinition.findUnique({
      where: { code: u.role },
    });
    if (roleDef) {
      if (u.role === Role.SUPER_ADMIN) {
        const existing = await prisma.userRoleAssignment.findFirst({
          where: {
            userId: u.id,
            roleId: roleDef.id,
            storeId: null,
          },
        });
        if (!existing) {
          await prisma.userRoleAssignment.create({
            data: {
              userId: u.id,
              roleId: roleDef.id,
              storeId: null,
            },
          });
        }
      } else {
        for (const assign of u.storeAssignments) {
          const existingAssign = await prisma.userRoleAssignment.findFirst({
            where: {
              userId: u.id,
              roleId: roleDef.id,
              storeId: assign.storeId,
            },
          });
          if (!existingAssign) {
            await prisma.userRoleAssignment.create({
              data: {
                userId: u.id,
                roleId: roleDef.id,
                storeId: assign.storeId,
              },
            });
          }
        }
      }
    }
  }

  console.log("RBAC seeding complete!");
}

if (require.main === module) {
  seedRbac()
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
