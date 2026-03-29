import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const SHOPIFY_STATUS_MAP: Record<string, string> = {
  REQUESTED: "REQUESTED",
  APPROVED: "APPROVED",
  DECLINED: "DECLINED",
  CLOSED: "COMPLETED",
  CANCELLED: "CANCELLED",
  // Shopify may also send lowercase or different casing
  requested: "REQUESTED",
  approved: "APPROVED",
  declined: "DECLINED",
  closed: "COMPLETED",
  cancelled: "CANCELLED",
  open: "REQUESTED",
  OPEN: "REQUESTED",
};

function mapShopifyStatus(shopifyStatus: string): string | null {
  return SHOPIFY_STATUS_MAP[shopifyStatus] ?? null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop } = await authenticate.webhook(request);

  console.log(`Received returns/update webhook for ${shop}`);

  const { id, status } = payload as { id: string; status: string };

  if (!id || !status) {
    console.error("Missing id or status in returns/update payload");
    return new Response(null, { status: 200 });
  }

  const mappedStatus = mapShopifyStatus(status);

  if (!mappedStatus) {
    console.error(`Unknown Shopify return status: ${status}`);
    return new Response(null, { status: 200 });
  }

  const incomingId = String(id);
  const candidateIds = incomingId.startsWith("gid://shopify/Return/")
    ? [incomingId]
    : [incomingId, `gid://shopify/Return/${incomingId}`];

  const existingReturn = await prisma.returnRequest.findFirst({
    where: { shop, shopifyReturnId: { in: candidateIds } },
  });

  if (!existingReturn) {
    console.log(
      `No matching ReturnRequest found for shopifyReturnId: ${incomingId}`,
    );
    return new Response(null, { status: 200 });
  }

  await prisma.returnRequest.update({
    where: { id: existingReturn.id },
    data: { status: mappedStatus as any },
  });

  console.log(
    `Updated ReturnRequest ${existingReturn.id} status to ${mappedStatus}`,
  );

  return new Response(null, { status: 200 });
};
