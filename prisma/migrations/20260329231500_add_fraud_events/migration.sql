-- CreateTable
CREATE TABLE "FraudEvent" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "returnRequestId" TEXT,
  "orderId" TEXT,
  "customerEmail" TEXT,
  "clientIp" TEXT,
  "rule" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "score" DECIMAL(65,30),
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FraudEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FraudEvent_shop_createdAt_idx" ON "FraudEvent"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "FraudEvent_shop_rule_createdAt_idx" ON "FraudEvent"("shop", "rule", "createdAt");

-- CreateIndex
CREATE INDEX "FraudEvent_shop_customerEmail_createdAt_idx" ON "FraudEvent"("shop", "customerEmail", "createdAt");
