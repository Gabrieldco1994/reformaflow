-- AlterTable: adiciona coluna email (nullable) à tabela users, preservando usuários existentes sem email
ALTER TABLE "users" ADD COLUMN "email" TEXT;

-- CreateIndex: email único quando presente (SQLite trata múltiplos NULL como distintos)
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
