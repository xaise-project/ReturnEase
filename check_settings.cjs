const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const settings = await prisma.storeSettings.findFirst();
  console.log("Email Provider:", settings?.emailProvider);
  console.log("Resend API Key set:", !!settings?.resendApiKey);
  console.log("Email From set:", !!settings?.emailFrom);
  console.log("Enable Auto Customer Email:", settings?.enableAutoCustomerEmail);
}

main().catch(console.error).finally(() => prisma.$disconnect());
