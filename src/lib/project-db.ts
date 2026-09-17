import mysql, { type Pool } from "mysql2/promise";
const globalDb = globalThis as typeof globalThis & { polarisPool?: Pool };
export function databaseConfigured() { return Boolean(process.env.MYSQL_HOST && process.env.MYSQL_USER && process.env.MYSQL_PASSWORD && process.env.MYSQL_DATABASE); }
export function database() {
  if (!databaseConfigured()) throw new Error("Database is not configured");
  if (!globalDb.polarisPool) globalDb.polarisPool = mysql.createPool({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE, connectionLimit: 5, queueLimit: 20, waitForConnections: true, connectTimeout: 5000, charset: "utf8mb4", timezone: "Z", dateStrings: true, enableKeepAlive: true });
  return globalDb.polarisPool;
}
