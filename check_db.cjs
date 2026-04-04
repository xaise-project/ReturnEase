const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const settings = await prisma.storeSettings.findMany({
    select: { shop: true, resendApiKey: true, emailFrom: true }
  });
  console.log(JSON.stringify(settings, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
