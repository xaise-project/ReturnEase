-- AlterTable
ALTER TABLE "StoreSettings"
ADD COLUMN "blockMultipleReturnsSameOrder" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "requirePhotoForFraudReasons" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "highReturnRateThreshold" DECIMAL(65,30) NOT NULL DEFAULT 0.5,
ADD COLUMN "wardrobingWindowDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN "wardrobingMaxReturns" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN "ipRepeatWindowHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN "ipRepeatMaxReturns" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "ReturnRequest"
ADD COLUMN "clientIp" TEXT;
