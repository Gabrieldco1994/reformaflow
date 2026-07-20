-- AlterTable: adiciona coluna email à tabela users (nullable por enquanto, para dados existentes)
ALTER TABLE "users" ADD COLUMN "email" TEXT;
