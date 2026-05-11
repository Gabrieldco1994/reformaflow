-- CreateTable
CREATE TABLE "simulations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "simulations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_simulation_values" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "simulation_id" TEXT,
    "key" TEXT NOT NULL,
    "valor" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "simulation_values_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "simulation_values_simulation_id_fkey" FOREIGN KEY ("simulation_id") REFERENCES "simulations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_simulation_values" ("created_at", "id", "key", "project_id", "tenant_id", "updated_at", "valor") SELECT "created_at", "id", "key", "project_id", "tenant_id", "updated_at", "valor" FROM "simulation_values";
DROP TABLE "simulation_values";
ALTER TABLE "new_simulation_values" RENAME TO "simulation_values";
CREATE UNIQUE INDEX "simulation_values_simulation_id_project_id_tenant_id_key_key" ON "simulation_values"("simulation_id", "project_id", "tenant_id", "key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
