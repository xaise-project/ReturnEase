-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN     "billingCycleStart" TIMESTAMP(3),
ADD COLUMN     "easypostApiKey" TEXT,
ADD COLUMN     "monthlyReturnCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'FREE',
ADD COLUMN     "shopifySubscriptionId" TEXT;

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "returnRequestId" TEXT NOT NULL,
    "type" "ResolutionType" NOT NULL,
    "savedAmount" DECIMAL(65,30) NOT NULL,
    "commissionRate" DECIMAL(65,30) NOT NULL DEFAULT 0.02,
    "commissionAmount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "charged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageRecord_shop_idx" ON "UsageRecord"("shop");

-- CreateIndex
CREATE INDEX "UsageRecord_returnRequestId_idx" ON "UsageRecord"("returnRequestId");
