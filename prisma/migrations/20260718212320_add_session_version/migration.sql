-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_price_monitor_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "query" TEXT,
    "url" TEXT,
    "product_url" TEXT,
    "notes" TEXT,
    "reference_price_cents" INTEGER,
    "target_price" REAL,
    "target_price_cents" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "alert_sent" BOOLEAN NOT NULL DEFAULT false,
    "monitoring_end_date" DATETIME,
    "last_best_price_cents" INTEGER,
    "last_best_price" REAL,
    "last_best_store" TEXT,
    "last_best_link" TEXT,
    "last_checked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "price_monitor_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_price_monitor_items" ("created_at", "deleted_at", "id", "is_active", "last_best_link", "last_best_price_cents", "last_best_store", "last_checked_at", "notes", "product_url", "project_id", "query", "reference_price_cents", "target_price_cents", "tenant_id", "title", "updated_at") SELECT "created_at", "deleted_at", "id", "is_active", "last_best_link", "last_best_price_cents", "last_best_store", "last_checked_at", "notes", "product_url", "project_id", "query", "reference_price_cents", "target_price_cents", "tenant_id", "title", "updated_at" FROM "price_monitor_items";
DROP TABLE "price_monitor_items";
ALTER TABLE "new_price_monitor_items" RENAME TO "price_monitor_items";
CREATE INDEX "price_monitor_items_project_id_is_active_idx" ON "price_monitor_items"("project_id", "is_active");
CREATE INDEX "price_monitor_items_tenant_id_project_id_title_idx" ON "price_monitor_items"("tenant_id", "project_id", "title");
CREATE INDEX "price_monitor_items_target_price_idx" ON "price_monitor_items"("target_price");
CREATE INDEX "price_monitor_items_monitoring_end_date_idx" ON "price_monitor_items"("monitoring_end_date");
CREATE TABLE "new_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "external_id" TEXT,
    "username" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "is_guest" BOOLEAN NOT NULL DEFAULT false,
    "password_hash" TEXT,
    "allowed_modules" TEXT NOT NULL DEFAULT '[]',
    "allowed_projects" TEXT NOT NULL DEFAULT '[]',
    "allowed_project_types" TEXT NOT NULL DEFAULT '[]',
    "created_by_user_id" TEXT,
    "session_version" INTEGER NOT NULL DEFAULT 0,
    "last_login_at" DATETIME,
    "last_activity_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_users" ("allowed_modules", "allowed_project_types", "allowed_projects", "created_at", "created_by_user_id", "deleted_at", "external_id", "id", "is_guest", "last_activity_at", "last_login_at", "name", "password_hash", "role", "tenant_id", "updated_at", "username") SELECT "allowed_modules", "allowed_project_types", "allowed_projects", "created_at", "created_by_user_id", "deleted_at", "external_id", "id", "is_guest", "last_activity_at", "last_login_at", "name", "password_hash", "role", "tenant_id", "updated_at", "username" FROM "users";
DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";
CREATE UNIQUE INDEX "users_external_id_key" ON "users"("external_id");
CREATE UNIQUE INDEX "users_tenant_id_username_key" ON "users"("tenant_id", "username");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
