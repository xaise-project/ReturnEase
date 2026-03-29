-- AlterTable
ALTER TABLE "StoreSettings"
ADD COLUMN "productReturnWindowsJson" TEXT DEFAULT '{}',
ADD COLUMN "collectionReturnWindowsJson" TEXT DEFAULT '{}',
ADD COLUMN "nonReturnableProductIds" TEXT,
ADD COLUMN "nonReturnableCollectionIds" TEXT,
ADD COLUMN "excludeDiscountedItems" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "minimumOrderAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN "maxReturnsPerCustomer" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "autoApproveUnderAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN "blockedCustomerEmails" TEXT,
ADD COLUMN "reasonPriorityJson" TEXT DEFAULT '{}';
