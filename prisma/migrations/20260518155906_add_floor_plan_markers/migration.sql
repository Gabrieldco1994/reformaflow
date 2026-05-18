-- CreateTable
CREATE TABLE "floor_plan_markers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "floor_plan_id" TEXT NOT NULL,
    "expense_id" TEXT NOT NULL,
    "bounds" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "floor_plan_markers_floor_plan_id_fkey" FOREIGN KEY ("floor_plan_id") REFERENCES "floor_plans" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "floor_plan_markers_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
