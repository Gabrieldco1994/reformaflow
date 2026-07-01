-- CreateTable
CREATE TABLE "pendencias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "due_date" DATETIME,
    "owner" TEXT,
    "room_id" TEXT,
    "schedule_task_id" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "pendencias_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "pendencias_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "pendencias_schedule_task_id_fkey" FOREIGN KEY ("schedule_task_id") REFERENCES "schedule_tasks" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "pendencias_project_id_idx" ON "pendencias"("project_id");

-- CreateIndex
CREATE INDEX "pendencias_room_id_idx" ON "pendencias"("room_id");

-- CreateIndex
CREATE INDEX "pendencias_schedule_task_id_idx" ON "pendencias"("schedule_task_id");
