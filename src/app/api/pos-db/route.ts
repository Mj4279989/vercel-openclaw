import { connection } from "next/server";
import mysql from "mysql2/promise";
import { getInitializedMeta } from "@/server/store/store";

let pool: mysql.Pool | null = null;

function getDbPool() {
  if (!pool) {
    const host = process.env.AIVEN_MYSQL_HOST;
    const port = process.env.AIVEN_MYSQL_PORT ? parseInt(process.env.AIVEN_MYSQL_PORT) : 12433;
    const user = process.env.AIVEN_MYSQL_USER;
    const password = process.env.AIVEN_MYSQL_PASSWORD;
    const database = process.env.AIVEN_MYSQL_DATABASE || "defaultdb";

    if (!host || !user || !password) {
      throw new Error("Aiven MySQL environment variables are not configured.");
    }

    pool = mysql.createPool({
      host,
      port,
      user,
      password,
      database,
      ssl: {
        rejectUnauthorized: false,
      },
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
  }
  return pool;
}

async function verifyAuth(request: Request): Promise<boolean> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.substring(7).trim();
  const meta = await getInitializedMeta();
  return token === meta.gatewayToken;
}

export async function POST(request: Request): Promise<Response> {
  await connection();

  if (!(await verifyAuth(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { action, data } = body;
  if (!action) {
    return Response.json({ error: "Action is required" }, { status: 400 });
  }

  try {
    const db = getDbPool();

    // Disable primary key requirement globally or per session if needed
    await db.query("SET SESSION sql_require_primary_key = OFF").catch(() => {});

    switch (action) {
      case "list-products": {
        const limit = parseInt(data?.limit || "10");
        const page = parseInt(data?.page || "1");
        const offset = (page - 1) * limit;
        const search = data?.search || "";

        let query = `
          SELECT p.id, p.code, p.name, p.cost, p.price, p.type, p.stock_alert,
                 c.name as category,
                 u.ShortName as unit,
                 COALESCE(SUM(pw.qte), 0) as quantity
          FROM products p
          LEFT JOIN categories c ON p.category_id = c.id
          LEFT JOIN units u ON p.unit_id = u.id
          LEFT JOIN product_warehouse pw ON p.id = pw.product_id AND pw.deleted_at IS NULL
          WHERE p.deleted_at IS NULL
        `;
        const params: any[] = [];

        if (search) {
          query += ` AND (p.name LIKE ? OR p.code LIKE ? OR c.name LIKE ?)`;
          const wildcard = `%${search}%`;
          params.push(wildcard, wildcard, wildcard);
        }

        query += ` GROUP BY p.id ORDER BY p.id DESC`;

        // Get total count
        const [countRows]: any = await db.query(
          `SELECT COUNT(DISTINCT p.id) as total FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.deleted_at IS NULL ${
            search ? " AND (p.name LIKE ? OR p.code LIKE ? OR c.name LIKE ?)" : ""
          }`,
          search ? params : []
        );
        const totalRows = countRows[0]?.total || 0;

        query += ` LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const [products]: any = await db.query(query, params);

        // Format quantities
        const formattedProducts = products.map((p: any) => ({
          ...p,
          cost: parseFloat(p.cost).toFixed(2),
          price: parseFloat(p.price).toFixed(2),
          quantity: `${parseFloat(p.quantity).toFixed(2)} ${p.unit || "Pc"}`,
        }));

        return Response.json({ products: formattedProducts, totalRows });
      }

      case "get-product": {
        const id = data?.id;
        if (!id) return Response.json({ error: "Product ID is required" }, { status: 400 });

        const [rows]: any = await db.query(
          `SELECT p.*, c.name as category, u.ShortName as unit
           FROM products p
           LEFT JOIN categories c ON p.category_id = c.id
           LEFT JOIN units u ON p.unit_id = u.id
           WHERE p.id = ? AND p.deleted_at IS NULL`,
          [id]
        );

        if (rows.length === 0) {
          return Response.json({ error: "Product not found" }, { status: 404 });
        }

        const product = rows[0];

        // Fetch warehouse stocks
        const [stocks]: any = await db.query(
          `SELECT pw.warehouse_id, w.name as warehouse_name, pw.qte
           FROM product_warehouse pw
           JOIN warehouses w ON pw.warehouse_id = w.id
           WHERE pw.product_id = ? AND pw.deleted_at IS NULL AND w.deleted_at IS NULL`,
          [id]
        );

        const totalStock = stocks.reduce((sum: number, s: any) => sum + parseFloat(s.qte || 0), 0);

        return Response.json({
          product: {
            ...product,
            cost: parseFloat(product.cost).toFixed(2),
            price: parseFloat(product.price).toFixed(2),
            quantity: `${totalStock.toFixed(2)} ${product.unit || "Pc"}`,
            warehouse_stock: stocks.map((s: any) => ({
              warehouse_name: s.warehouse_name,
              qte: parseFloat(s.qte).toFixed(2),
            })),
          },
        });
      }

      case "create-product": {
        const payload = data?.data;
        if (!payload || !payload.name || !payload.code) {
          return Response.json({ error: "Name and Code are required" }, { status: 400 });
        }

        const cost = parseFloat(payload.cost || "0");
        const price = parseFloat(payload.price || "0");
        const categoryId = parseInt(payload.category_id || "1");
        const unitId = parseInt(payload.unit_id || "1");
        const stockAlert = parseFloat(payload.stock_alert || "0");
        const type = payload.type || "is_single";

        // Check if code already exists
        const [existing]: any = await db.query(
          "SELECT id FROM products WHERE code = ? AND deleted_at IS NULL",
          [payload.code]
        );
        if (existing.length > 0) {
          return Response.json({ error: `Product with code ${payload.code} already exists` }, { status: 400 });
        }

        const [result]: any = await db.query(
          `INSERT INTO products (code, Type_barcode, name, cost, price, category_id, unit_id, unit_sale_id, unit_purchase_id, TaxNet, tax_method, stock_alert, is_variant, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '1', ?, 0, 1, NOW(), NOW())`,
          [payload.code, "CODE128", payload.name, cost, price, categoryId, unitId, unitId, unitId, stockAlert]
        );

        const newProductId = result.insertId;

        // Add initial stock row for warehouse 1 (or the first available warehouse)
        const [warehouses]: any = await db.query("SELECT id FROM warehouses WHERE deleted_at IS NULL LIMIT 1");
        const warehouseId = warehouses[0]?.id || 1;
        const initialQty = parseFloat(payload.quantity || "0");

        await db.query(
          `INSERT INTO product_warehouse (product_id, warehouse_id, qte, created_at, updated_at)
           VALUES (?, ?, ?, NOW(), NOW())`,
          [newProductId, warehouseId, initialQty]
        );

        return Response.json({ success: true, id: newProductId, name: payload.name });
      }

      case "update-product": {
        const id = data?.id;
        const payload = data?.data;
        if (!id || !payload) {
          return Response.json({ error: "Product ID and update data are required" }, { status: 400 });
        }

        const cost = parseFloat(payload.cost || "0");
        const price = parseFloat(payload.price || "0");
        const categoryId = parseInt(payload.category_id || "1");
        const unitId = parseInt(payload.unit_id || "1");
        const stockAlert = parseFloat(payload.stock_alert || "0");

        await db.query(
          `UPDATE products 
           SET name = ?, code = ?, cost = ?, price = ?, category_id = ?, unit_id = ?, stock_alert = ?, updated_at = NOW()
           WHERE id = ? AND deleted_at IS NULL`,
          [payload.name, payload.code, cost, price, categoryId, unitId, stockAlert, id]
        );

        return Response.json({ success: true });
      }

      case "delete-product": {
        const id = data?.id;
        if (!id) return Response.json({ error: "Product ID is required" }, { status: 400 });

        await db.query("UPDATE products SET deleted_at = NOW() WHERE id = ?", [id]);
        await db.query("UPDATE product_warehouse SET deleted_at = NOW() WHERE product_id = ?", [id]);

        return Response.json({ success: true });
      }

      case "list-sales": {
        const limit = parseInt(data?.limit || "10");
        const page = parseInt(data?.page || "1");
        const offset = (page - 1) * limit;

        const [sales]: any = await db.query(
          `SELECT s.id, s.date, s.Ref, s.GrandTotal, s.paid_amount, s.payment_statut, s.statut,
                  cl.name as client_name, w.name as warehouse_name
           FROM sales s
           LEFT JOIN clients cl ON s.client_id = cl.id
           LEFT JOIN warehouses w ON s.warehouse_id = w.id
           WHERE s.deleted_at IS NULL
           ORDER BY s.id DESC
           LIMIT ? OFFSET ?`,
          [limit, offset]
        );

        const [countRows]: any = await db.query(
          "SELECT COUNT(*) as total FROM sales WHERE deleted_at IS NULL"
        );
        const totalRows = countRows[0]?.total || 0;

        return Response.json({ sales, totalRows });
      }

      case "get-sale": {
        const id = data?.id;
        if (!id) return Response.json({ error: "Sale ID is required" }, { status: 400 });

        const [rows]: any = await db.query(
          `SELECT s.*, cl.name as client_name, cl.email as client_email, cl.phone as client_phone, cl.adresse as client_address,
                  w.name as warehouse_name
           FROM sales s
           LEFT JOIN clients cl ON s.client_id = cl.id
           LEFT JOIN warehouses w ON s.warehouse_id = w.id
           WHERE s.id = ? AND s.deleted_at IS NULL`,
          [id]
        );

        if (rows.length === 0) {
          return Response.json({ error: "Sale not found" }, { status: 404 });
        }

        const sale = rows[0];

        const [details]: any = await db.query(
          `SELECT sd.*, p.name as product_name, p.code as product_code, u.ShortName as unit
           FROM sale_details sd
           JOIN products p ON sd.product_id = p.id
           LEFT JOIN units u ON p.unit_id = u.id
           WHERE sd.sale_id = ?`,
          [id]
        );

        return Response.json({ sale, details });
      }

      case "create-sale": {
        const payload = data?.data;
        if (!payload || !payload.client_id || !payload.details || payload.details.length === 0) {
          return Response.json({ error: "Client and sale details are required" }, { status: 400 });
        }

        const conn = await db.getConnection();
        await conn.beginTransaction();

        try {
          // Disable PK req for connection
          await conn.query("SET SESSION sql_require_primary_key = OFF").catch(() => {});

          // Generate reference Ref
          const [maxIdRow]: any = await conn.query("SELECT COALESCE(MAX(id), 0) as max_id FROM sales");
          const nextId = (maxIdRow[0]?.max_id || 0) + 1;
          const ref = `SL_${String(nextId).padStart(5, "0")}`;

          // Calculate grand total from details
          let grandTotal = 0;
          for (const item of payload.details) {
            const qty = parseFloat(item.quantity || "1");
            const price = parseFloat(item.price || "0");
            const discount = parseFloat(item.discount || "0");
            const itemTotal = (price - discount) * qty;
            grandTotal += itemTotal;
          }

          // Apply tax, shipping, discount
          const taxRate = parseFloat(payload.tax_rate || "0");
          const discountVal = parseFloat(payload.discount || "0");
          const shipping = parseFloat(payload.shipping || "0");
          
          const taxNet = grandTotal * (taxRate / 100);
          const finalTotal = grandTotal + taxNet + shipping - discountVal;

          const warehouseId = parseInt(payload.warehouse_id || "1");
          const paymentStatus = payload.payment?.status || "received"; // received, partial, unpaid
          const paidAmount = paymentStatus === "received" ? finalTotal : 0;
          const status = "completed";

          const saleUuid = payload.sale_uuid || crypto.randomUUID();

          // Insert sale
          const [saleResult]: any = await conn.query(
            `INSERT INTO sales (user_id, date, Ref, is_pos, client_id, warehouse_id, tax_rate, TaxNet, discount, shipping, GrandTotal, paid_amount, payment_statut, statut, notes, sale_uuid, created_at, updated_at)
             VALUES (1, CURDATE(), ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [ref, payload.client_id, warehouseId, taxRate, taxNet, discountVal, shipping, finalTotal, paidAmount, paymentStatus, status, payload.notes || "", saleUuid]
          );

          const saleId = saleResult.insertId;

          // Insert details and update stocks
          for (const item of payload.details) {
            const qty = parseFloat(item.quantity || "1");
            const price = parseFloat(item.price || "0");
            const discount = parseFloat(item.discount || "0");
            const itemTotal = (price - discount) * qty;

            await conn.query(
              `INSERT INTO sale_details (date, sale_id, product_id, price, TaxNet, tax_method, discount, discount_method, total, quantity, created_at, updated_at)
               VALUES (CURDATE(), ?, ?, ?, 0, '1', ?, '1', ?, ?, NOW(), NOW())`,
              [saleId, item.product_id, price, discount, itemTotal, qty]
            );

            // Deduct stock in warehouse
            const [stockRows]: any = await conn.query(
              "SELECT id, qte FROM product_warehouse WHERE product_id = ? AND warehouse_id = ? AND deleted_at IS NULL",
              [item.product_id, warehouseId]
            );

            if (stockRows.length > 0) {
              await conn.query(
                "UPDATE product_warehouse SET qte = qte - ?, updated_at = NOW() WHERE id = ?",
                [qty, stockRows[0].id]
              );
            } else {
              await conn.query(
                `INSERT INTO product_warehouse (product_id, warehouse_id, qte, created_at, updated_at)
                 VALUES (?, ?, ?, NOW(), NOW())`,
                [item.product_id, warehouseId, -qty]
              );
            }
          }

          // If paid, insert a payment record
          if (paymentStatus === "received" || paidAmount > 0) {
            const [maxPaymentIdRow]: any = await conn.query("SELECT COALESCE(MAX(id), 0) as max_id FROM payment_sales");
            const nextPaymentId = (maxPaymentIdRow[0]?.max_id || 0) + 1;
            const payRef = `INV_${String(nextPaymentId).padStart(5, "0")}`;

            const methodStr = (payload.payment?.Reglement || payload.payment?.method || "Cash").trim().toLowerCase();
            let paymentMethodId = 2; // Default to Cash (ID: 2)
            if (methodStr.includes("credit") || methodStr.includes("card")) {
              paymentMethodId = 1;
            } else if (methodStr.includes("cash")) {
              paymentMethodId = 2;
            } else if (methodStr.includes("check")) {
              paymentMethodId = 3;
            } else if (methodStr.includes("tpe")) {
              paymentMethodId = 4;
            } else if (methodStr.includes("western") || methodStr.includes("union")) {
              paymentMethodId = 5;
            } else if (methodStr.includes("transfer") || methodStr.includes("bank")) {
              paymentMethodId = 6;
            } else if (methodStr.includes("other")) {
              paymentMethodId = 7;
            }

            await conn.query(
              `INSERT INTO payment_sales (user_id, date, Ref, sale_id, payment_method_id, montant, \`change\`, created_at, updated_at)
               VALUES (1, CURDATE(), ?, ?, ?, ?, 0, NOW(), NOW())`,
              [payRef, saleId, paymentMethodId, paidAmount]
            );
          }

          await conn.commit();
          conn.release();

          // Return invoice details for receipt generation
          const [saleObj]: any = await db.query(
            `SELECT s.*, cl.name as client_name, cl.phone as client_phone, w.name as warehouse_name
             FROM sales s
             LEFT JOIN clients cl ON s.client_id = cl.id
             LEFT JOIN warehouses w ON s.warehouse_id = w.id
             WHERE s.id = ?`,
            [saleId]
          );

          const [detailRows]: any = await db.query(
            `SELECT sd.*, p.name as product_name, p.code as product_code
             FROM sale_details sd
             JOIN products p ON sd.product_id = p.id
             WHERE sd.sale_id = ?`,
            [saleId]
          );

          return Response.json({
            success: true,
            sale: saleObj[0],
            details: detailRows,
          });

        } catch (txError: any) {
          await conn.rollback();
          conn.release();
          throw txError;
        }
      }

      case "list-customers": {
        const limit = parseInt(data?.limit || "10");
        const page = parseInt(data?.page || "1");
        const offset = (page - 1) * limit;
        const search = data?.search || "";

        let query = "SELECT * FROM clients WHERE deleted_at IS NULL";
        const params: any[] = [];

        if (search) {
          query += " AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)";
          const wildcard = `%${search}%`;
          params.push(wildcard, wildcard, wildcard);
        }

        query += " ORDER BY id DESC LIMIT ? OFFSET ?";
        params.push(limit, offset);

        const [clients]: any = await db.query(query, params);

        const [countRows]: any = await db.query(
          `SELECT COUNT(*) as total FROM clients WHERE deleted_at IS NULL ${
            search ? " AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)" : ""
          }`,
          search ? params.slice(0, 3) : []
        );
        const totalRows = countRows[0]?.total || 0;

        return Response.json({ clients, totalRows });
      }

      case "create-customer": {
        const payload = data?.data;
        if (!payload || !payload.name) {
          return Response.json({ error: "Customer Name is required" }, { status: 400 });
        }

        const email = payload.email || "";
        const phone = payload.phone || "";
        const country = payload.country || "";
        const city = payload.city || "";
        const address = payload.adresse || payload.address || "";

        const [maxCodeRow]: any = await db.query("SELECT COALESCE(MAX(code), 0) + 1 as next_code FROM clients");
        const nextCode = maxCodeRow[0]?.next_code || 1000;

        const [result]: any = await db.query(
          `INSERT INTO clients (name, code, email, country, city, phone, adresse, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [payload.name, nextCode, email, country, city, phone, address]
        );

        return Response.json({ success: true, id: result.insertId, name: payload.name, code: nextCode });
      }

      case "dashboard-summary": {
        const [salesSum]: any = await db.query("SELECT SUM(GrandTotal) as total, COUNT(*) as orders FROM sales WHERE deleted_at IS NULL");
        const [productsCount]: any = await db.query("SELECT COUNT(*) as total FROM products WHERE deleted_at IS NULL");
        const [clientsCount]: any = await db.query("SELECT COUNT(*) as total FROM clients WHERE deleted_at IS NULL");

        const [recentSales]: any = await db.query(
          `SELECT s.id, s.Ref, s.GrandTotal, cl.name as client_name, s.date
           FROM sales s
           LEFT JOIN clients cl ON s.client_id = cl.id
           WHERE s.deleted_at IS NULL
           ORDER BY s.id DESC LIMIT 5`
        );

        return Response.json({
          totalRevenue: parseFloat(salesSum[0]?.total || 0).toFixed(2),
          totalOrders: salesSum[0]?.orders || 0,
          activeProducts: productsCount[0]?.total || 0,
          customerBase: clientsCount[0]?.total || 0,
          recentSales,
        });
      }

      case "stock-alerts": {
        const [alerts]: any = await db.query(
          `SELECT p.id, p.code, p.name, p.stock_alert, u.ShortName as unit,
                  COALESCE(SUM(pw.qte), 0) as quantity
           FROM products p
           LEFT JOIN units u ON p.unit_id = u.id
           LEFT JOIN product_warehouse pw ON p.id = pw.product_id AND pw.deleted_at IS NULL
           WHERE p.deleted_at IS NULL
           GROUP BY p.id
           HAVING quantity <= p.stock_alert
           ORDER BY quantity ASC`
        );

        const formatted = alerts.map((a: any) => ({
          ...a,
          stock_alert: parseFloat(a.stock_alert).toFixed(2),
          quantity: `${parseFloat(a.quantity).toFixed(2)} ${a.unit || "Pc"}`,
        }));

        return Response.json(formatted);
      }

      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error: any) {
    console.error("API error executing direct db control:", error);
    return Response.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
