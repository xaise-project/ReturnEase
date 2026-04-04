const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const logs = await prisma.returnActionLog.findMany({
    where: { action: "NOTIFY_CUSTOMER_FAILED" },
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  console.log(JSON.stringify(logs, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
