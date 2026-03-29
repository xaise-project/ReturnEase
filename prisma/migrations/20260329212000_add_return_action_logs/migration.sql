-- CreateTable
CREATE TABLE "ReturnActionLog" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "returnRequestId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "actor" TEXT,
  "note" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReturnActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReturnActionLog_shop_returnRequestId_createdAt_idx" ON "ReturnActionLog"("shop", "returnRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "ReturnActionLog_shop_action_createdAt_idx" ON "ReturnActionLog"("shop", "action", "createdAt");
