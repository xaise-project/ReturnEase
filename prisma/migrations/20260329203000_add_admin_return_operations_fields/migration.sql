-- CreateEnum
CREATE TYPE "RestockDecision" AS ENUM ('RESTOCK', 'NO_RESTOCK');

-- CreateEnum
CREATE TYPE "StockSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED');

-- AlterTable
ALTER TABLE "ReturnRequest"
ADD COLUMN "internalNote" TEXT,
ADD COLUMN "customerMessage" TEXT,
ADD COLUMN "customerMessageSentAt" TIMESTAMP(3),
ADD COLUMN "restockDecision" "RestockDecision" NOT NULL DEFAULT 'NO_RESTOCK',
ADD COLUMN "stockSyncStatus" "StockSyncStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "stockSyncedAt" TIMESTAMP(3),
ADD COLUMN "stockSyncError" TEXT,
ADD COLUMN "isManual" BOOLEAN NOT NULL DEFAULT false;
