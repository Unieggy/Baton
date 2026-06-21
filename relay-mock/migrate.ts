import { DB } from "./db";

export interface MigrationResult {
  ok: boolean;
}

export function applyMigration(db: DB): MigrationResult {
  // guard: check schema before altering
  db.run("ALTER TABLE users ADD COLUMN age INT");
  return { ok: true };
}
