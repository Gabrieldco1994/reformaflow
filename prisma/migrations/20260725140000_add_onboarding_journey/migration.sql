-- CreateTable
CREATE TABLE "onboarding_journey_steps" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_type" TEXT NOT NULL,
    "step_key" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "skippable" BOOLEAN NOT NULL DEFAULT true,
    "label_override" TEXT,
    "subtitle_override" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_journey_steps_project_type_step_key_key" ON "onboarding_journey_steps"("project_type", "step_key");
