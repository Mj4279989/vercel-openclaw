import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config({ path: ".env.prod.decrypted" });

async function main() {
  const host = process.env.AIVEN_MYSQL_HOST;
  const port = process.env.AIVEN_MYSQL_PORT ? parseInt(process.env.AIVEN_MYSQL_PORT) : 12433;
  const user = process.env.AIVEN_MYSQL_USER;
  const password = process.env.AIVEN_MYSQL_PASSWORD;
  const database = process.env.AIVEN_MYSQL_DATABASE || "defaultdb";

  const connection = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
    ssl: {
      rejectUnauthorized: false,
    }
  });

  console.log("\n--- SELECT * FROM settings ---");
  const [settings]: any = await connection.query("SELECT * FROM settings");
  console.table(settings);

  await connection.end();
}

main().catch(console.error);
