-- CreateTable
CREATE TABLE "merchant_categories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_key" TEXT NOT NULL,
    "merchant_sample" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "source" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 1.0,
    "ai_response" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "merchant_categories_merchant_key_key" ON "merchant_categories"("merchant_key");

-- CreateIndex
CREATE INDEX "merchant_categories_category_idx" ON "merchant_categories"("category");
