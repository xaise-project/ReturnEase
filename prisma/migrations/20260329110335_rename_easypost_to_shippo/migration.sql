/*
  Warnings:

  - You are about to drop the column `easypostApiKey` on the `StoreSettings` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "StoreSettings" DROP COLUMN "easypostApiKey",
ADD COLUMN     "shippoApiKey" TEXT;
