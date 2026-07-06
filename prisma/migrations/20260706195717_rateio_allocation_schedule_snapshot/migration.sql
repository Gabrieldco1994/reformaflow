-- AlterTable
ALTER TABLE "rateio_allocations" ADD COLUMN "planned_data_inicio" DATETIME;
ALTER TABLE "rateio_allocations" ADD COLUMN "planned_data_pagamento" DATETIME;
ALTER TABLE "rateio_allocations" ADD COLUMN "planned_forma" TEXT;
ALTER TABLE "rateio_allocations" ADD COLUMN "planned_qtd_parcela" INTEGER;
ALTER TABLE "rateio_allocations" ADD COLUMN "planned_quantidade" INTEGER;
ALTER TABLE "rateio_allocations" ADD COLUMN "planned_valor" INTEGER;
ALTER TABLE "rateio_allocations" ADD COLUMN "planned_valor_total" INTEGER;
