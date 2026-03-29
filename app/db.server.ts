import { PrismaClient } from "@prisma/client";

declare global {
  var prismaGlobalV2: PrismaClient;
}

let prisma: PrismaClient;

if (process.env.NODE_ENV === "production") {
  prisma = new PrismaClient();
} else {
  if (!global.prismaGlobalV2) {
    global.prismaGlobalV2 = new PrismaClient();
  }
  prisma = global.prismaGlobalV2;
}

export default prisma;
