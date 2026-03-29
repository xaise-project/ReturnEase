-- AlterEnum
ALTER TYPE "ResolutionType" ADD VALUE 'EXCHANGE_DIFFERENT_PRODUCT';
ALTER TYPE "ResolutionType" ADD VALUE 'EXCHANGE_WITH_PRICE_DIFF';
ALTER TYPE "ResolutionType" ADD VALUE 'KEEP_IT';

-- AlterTable
ALTER TABLE "Resolution"
ADD COLUMN "discountCode" TEXT,
ADD COLUMN "metadata" JSONB,
ADD COLUMN "paymentLinkUrl" TEXT,
ADD COLUMN "priceDifference" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "StoreSettings"
ADD COLUMN "enableKeepIt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "enablePriceDiffExchange" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "enableStoreCreditDiscountCode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "keepItMaxAmount" DECIMAL(65,30) NOT NULL DEFAULT 0;
