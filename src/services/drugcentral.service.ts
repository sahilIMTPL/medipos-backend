import { Pool } from "pg";
import { prisma } from "../db";

// Connect to the dedicated DrugCentral database
const drugcentralPool = new Pool({
  connectionString:
    process.env.DRUGCENTRAL_DATABASE_URL ||
    "postgresql://postgres:password123@localhost:5432/drugcentral",
  max: 10,
  idleTimeoutMillis: 30000,
});

export interface DrugCentralProductResult {
  id: number;
  productName: string;
  genericName: string;
  dosageForm: string;
  route: string;
  ndcProductCode: string;
  activeIngredients: {
    name: string;
    quantity: number | null;
    unit: string | null;
  }[];
}

export interface DrugInteractionResult {
  drug1: string;
  drug2: string;
  riskLevel: string;
  description: string;
}

export class DrugCentralService {
  /**
   * Search DrugCentral pharmaceutical catalog by brand or generic name
   */
  static async searchCatalog(
    query: string,
    limit = 25
  ): Promise<DrugCentralProductResult[]> {
    if (!query || query.trim().length < 2) return [];

    const clean = query.trim();
    const pattern = `%${clean}%`;

    const sql = `
      SELECT 
        p.id,
        p.product_name,
        p.generic_name,
        p.form,
        p.route,
        p.ndc_product_code,
        COALESCE(
          json_agg(
            json_build_object(
              'name', ai.substance_name,
              'quantity', ai.quantity,
              'unit', ai.unit
            )
          ) FILTER (WHERE ai.substance_name IS NOT NULL),
          '[]'
        ) AS active_ingredients
      FROM product p
      LEFT JOIN active_ingredient ai ON p.ndc_product_code = ai.ndc_product_code
      WHERE p.product_name ILIKE $1 
         OR p.generic_name ILIKE $1
      GROUP BY p.id, p.product_name, p.generic_name, p.form, p.route, p.ndc_product_code
      ORDER BY 
        CASE 
          WHEN p.product_name ILIKE $2 THEN 1
          WHEN p.product_name ILIKE $3 THEN 2
          ELSE 3
        END,
        p.product_name ASC
      LIMIT $4;
    `;

    try {
      const res = await drugcentralPool.query(sql, [
        pattern,
        `${clean}`,
        `${clean}%`,
        limit,
      ]);

      return res.rows.map((row: any) => ({
        id: row.id,
        productName: row.product_name || "Unknown Product",
        genericName: row.generic_name || "",
        dosageForm: row.form || "TABLET",
        route: row.route || "ORAL",
        ndcProductCode: row.ndc_product_code,
        activeIngredients: row.active_ingredients || [],
      }));
    } catch (err) {
      console.error("DrugCentral catalog search error:", err);
      return [];
    }
  }

  /**
   * Find bio-equivalent generic substitutes sharing identical active substances
   */
  static async getSubstitutes(
    productId: number,
    limit = 15
  ): Promise<DrugCentralProductResult[]> {
    const sql = `
      WITH target_ingredients AS (
        SELECT DISTINCT substance_name
        FROM active_ingredient
        WHERE ndc_product_code = (SELECT ndc_product_code FROM product WHERE id = $1 LIMIT 1)
      ),
      matching_products AS (
        SELECT DISTINCT p.id
        FROM product p
        JOIN active_ingredient ai ON p.ndc_product_code = ai.ndc_product_code
        WHERE ai.substance_name IN (SELECT substance_name FROM target_ingredients)
          AND p.id <> $1
      )
      SELECT 
        p.id,
        p.product_name,
        p.generic_name,
        p.form,
        p.route,
        p.ndc_product_code,
        COALESCE(
          json_agg(
            json_build_object(
              'name', ai.substance_name,
              'quantity', ai.quantity,
              'unit', ai.unit
            )
          ) FILTER (WHERE ai.substance_name IS NOT NULL),
          '[]'
        ) AS active_ingredients
      FROM product p
      JOIN matching_products mp ON p.id = mp.id
      LEFT JOIN active_ingredient ai ON p.ndc_product_code = ai.ndc_product_code
      GROUP BY p.id, p.product_name, p.generic_name, p.form, p.route, p.ndc_product_code
      LIMIT $2;
    `;

    try {
      const res = await drugcentralPool.query(sql, [productId, limit]);
      return res.rows.map((row: any) => ({
        id: row.id,
        productName: row.product_name,
        genericName: row.generic_name,
        dosageForm: row.form,
        route: row.route,
        ndcProductCode: row.ndc_product_code,
        activeIngredients: row.active_ingredients || [],
      }));
    } catch (err) {
      console.error("DrugCentral substitutes query error:", err);
      return [];
    }
  }

  /**
   * Clinical Drug-Drug Interaction (DDI) checker for multi-medicine cart/prescriptions
   */
  static async checkInteractions(
    drugNames: string[]
  ): Promise<DrugInteractionResult[]> {
    if (!drugNames || drugNames.length < 2) return [];

    const interactions: DrugInteractionResult[] = [];
    const cleanNames = drugNames.map((d) => d.trim().toLowerCase());

    // Pairwise check
    for (let i = 0; i < cleanNames.length; i++) {
      for (let j = i + 1; j < cleanNames.length; j++) {
        const d1 = cleanNames[i];
        const d2 = cleanNames[j];

        const sql = `
          SELECT drug_class1, drug_class2, ddi_risk, description
          FROM ddi
          WHERE (drug_class1 ILIKE $1 AND drug_class2 ILIKE $2)
             OR (drug_class1 ILIKE $2 AND drug_class2 ILIKE $1)
          LIMIT 3;
        `;

        try {
          const res = await drugcentralPool.query(sql, [
            `%${d1}%`,
            `%${d2}%`,
          ]);

          for (const row of res.rows) {
            interactions.push({
              drug1: row.drug_class1,
              drug2: row.drug_class2,
              riskLevel: row.ddi_risk,
              description: row.description,
            });
          }
        } catch (err) {
          console.error("DrugCentral interaction check error:", err);
        }
      }
    }

    return interactions;
  }

  /**
   * 1-Click Import medicine from DrugCentral into MedicalPOS Inventory Catalog
   */
  static async importMedicineToStore(
    productId: number,
    storeId?: string,
    defaultPrice = 50.0
  ) {
    // 1. Fetch details from DrugCentral
    const sql = `
      SELECT 
        p.id,
        p.product_name,
        p.generic_name,
        p.form,
        p.route,
        p.ndc_product_code,
        COALESCE(
          json_agg(
            json_build_object(
              'name', ai.substance_name,
              'quantity', ai.quantity,
              'unit', ai.unit
            )
          ) FILTER (WHERE ai.substance_name IS NOT NULL),
          '[]'
        ) AS active_ingredients
      FROM product p
      LEFT JOIN active_ingredient ai ON p.ndc_product_code = ai.ndc_product_code
      WHERE p.id = $1
      GROUP BY p.id, p.product_name, p.generic_name, p.form, p.route, p.ndc_product_code
      LIMIT 1;
    `;

    const res = await drugcentralPool.query(sql, [productId]);
    if (res.rows.length === 0) {
      throw new Error(`Medicine with ID ${productId} not found in DrugCentral.`);
    }

    const drug = res.rows[0];

    // Format strength string from active ingredients
    const strengthStr =
      drug.active_ingredients && drug.active_ingredients.length > 0
        ? drug.active_ingredients
            .map((ai: any) =>
              ai.quantity ? `${ai.name} ${ai.quantity}${ai.unit || ""}` : ai.name
            )
            .join(" + ")
        : undefined;

    // Standardize units in MedicalPOS
    let baseUnit = await prisma.unit.findFirst({
      where: { code: { in: ["TAB", "NOS", "UNIT"] } },
    });
    if (!baseUnit) {
      baseUnit = await prisma.unit.findFirst();
    }
    if (!baseUnit) {
      baseUnit = await prisma.unit.create({
        data: { name: "Tablet", code: "TAB" },
      });
    }

    let stripUnit = await prisma.unit.findFirst({
      where: { code: { in: ["STRIP", "BOX", "PACK"] } },
    });
    if (!stripUnit) {
      stripUnit = await prisma.unit.create({
        data: { name: "Strip", code: "STRIP" },
      });
    }

    // Default Category
    let category = await prisma.category.findFirst({
      where: { name: { contains: "Allopathic", mode: "insensitive" } },
    });
    if (!category) {
      category = await prisma.category.findFirst();
    }

    // Generate unique SKU
    const sku = `DC-${drug.id}-${Date.now().toString().slice(-4)}`;

    // Create the product in MedicalPOS
    const createdProduct = await prisma.product.create({
      data: {
        storeId: storeId || undefined,
        name: drug.product_name,
        genericName: drug.generic_name || strengthStr || drug.product_name,
        dosageForm: drug.form || "TABLET",
        strength: strengthStr,
        packDescription: `Strip of 10 ${drug.form || "Tablets"}`,
        sku,
        barcode: drug.ndc_product_code ? drug.ndc_product_code.replace(/[^0-9]/g, "").padEnd(12, "0").slice(0, 13) : undefined,
        categoryId: category?.id,
        baseUnitId: baseUnit.id,
        purchaseUnitId: stripUnit.id,
        saleUnitId: stripUnit.id,
        mrp: defaultPrice,
        defaultSellingPrice: defaultPrice,
        defaultPurchasePrice: Math.round(defaultPrice * 0.7 * 100) / 100,
        gstRate: 12.0,
        isPrescriptionRequired: true,
        isActive: true,
      },
    });

    // Create standard conversion (1 Strip = 10 Tablets)
    await prisma.productUnitConversion.create({
      data: {
        productId: createdProduct.id,
        fromUnitId: stripUnit.id,
        toUnitId: baseUnit.id,
        conversionFactor: 10,
      },
    });

    return createdProduct;
  }
}

