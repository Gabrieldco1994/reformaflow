-- CreateTable
CREATE TABLE "journeys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME
);

-- CreateTable
CREATE TABLE "journey_triggers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "journey_id" TEXT NOT NULL,
    "trigger_type" TEXT NOT NULL,
    "target_project_type" TEXT,
    "target_project_id" TEXT,
    "cross_project" BOOLEAN NOT NULL DEFAULT false,
    "screen_key" TEXT,
    "action_key" TEXT,
    "device" TEXT NOT NULL DEFAULT 'any',
    "repeat_policy" TEXT NOT NULL DEFAULT 'ONCE_PER_USER',
    "dismiss_policy" TEXT NOT NULL DEFAULT 'manual',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "journey_triggers_journey_id_fkey" FOREIGN KEY ("journey_id") REFERENCES "journeys" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "journey_steps" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "journey_id" TEXT NOT NULL,
    "step_key" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "experience" TEXT NOT NULL DEFAULT 'FULL',
    "label" TEXT NOT NULL,
    "subtitle" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "skippable" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "journey_steps_journey_id_fkey" FOREIGN KEY ("journey_id") REFERENCES "journeys" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "journey_completions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "journey_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT,
    "project_id" TEXT,
    "completion_key" TEXT NOT NULL,
    "completed_at" DATETIME,
    "dismissed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "journey_completions_journey_id_fkey" FOREIGN KEY ("journey_id") REFERENCES "journeys" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "journeys_key_key" ON "journeys"("key");

-- CreateIndex
CREATE INDEX "journey_triggers_journey_id_idx" ON "journey_triggers"("journey_id");

-- CreateIndex
CREATE UNIQUE INDEX "journey_triggers_journey_id_trigger_type_target_project_type_target_project_id_screen_key_action_key_key" ON "journey_triggers"("journey_id", "trigger_type", "target_project_type", "target_project_id", "screen_key", "action_key");

-- CreateIndex
CREATE INDEX "journey_steps_journey_id_idx" ON "journey_steps"("journey_id");

-- CreateIndex
CREATE UNIQUE INDEX "journey_steps_journey_id_step_key_key" ON "journey_steps"("journey_id", "step_key");

-- CreateIndex
CREATE INDEX "journey_completions_tenant_id_idx" ON "journey_completions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "journey_completions_journey_id_completion_key_key" ON "journey_completions"("journey_id", "completion_key");
