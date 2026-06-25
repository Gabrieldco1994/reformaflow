-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "external_id" TEXT,
    "username" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "password_hash" TEXT,
    "allowed_modules" TEXT NOT NULL DEFAULT '[]',
    "allowed_projects" TEXT NOT NULL DEFAULT '[]',
    "allowed_project_types" TEXT NOT NULL DEFAULT '[]',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_users" ("allowed_modules", "allowed_projects", "created_at", "deleted_at", "external_id", "id", "name", "password_hash", "role", "tenant_id", "updated_at", "username") SELECT "allowed_modules", "allowed_projects", "created_at", "deleted_at", "external_id", "id", "name", "password_hash", "role", "tenant_id", "updated_at", "username" FROM "users";
DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";
CREATE UNIQUE INDEX "users_external_id_key" ON "users"("external_id");
CREATE UNIQUE INDEX "users_tenant_id_username_key" ON "users"("tenant_id", "username");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
