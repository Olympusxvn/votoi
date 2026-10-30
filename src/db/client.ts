import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Neon Postgres fast cache tier.
 *
 * The neon-http driver is stateless: each query is a single HTTPS request,
 * so there is no local pool to exhaust. Actual connection pooling happens
 * on Neon's side, which is why DATABASE_URL should use the "-pooler" host.
 * This keeps the chat route comfortably inside the 2 second budget
 * (RULE.md Boundary 1) in serverless and edge runtimes alike.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and fill in the Neon connection string.",
  );
}

export const db = drizzle(neon(databaseUrl), { schema });
export type Db = typeof db;
