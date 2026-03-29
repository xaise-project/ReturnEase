-- AlterTable
ALTER TABLE "StoreSettings"
ADD COLUMN "shippingProvider" TEXT NOT NULL DEFAULT 'SHIPPO',
ADD COLUMN "easypostApiKey" TEXT,
ADD COLUMN "enableKlaviyo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "klaviyoApiKey" TEXT,
ADD COLUMN "enableSlackNotifications" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "slackWebhookUrl" TEXT,
ADD COLUMN "enableGorgias" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "gorgiasWebhookUrl" TEXT,
ADD COLUMN "enableZendesk" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "zendeskWebhookUrl" TEXT;
