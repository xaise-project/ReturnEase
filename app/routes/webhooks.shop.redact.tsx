import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, payload } = await authenticate.webhook(request);

  if (topic !== "SHOP_REDACT") {
    return json({ error: "Invalid topic" }, { status: 400 });
  }

  const { shop_domain } = payload;

  // Delete all data associated with this shop
  // Cascade deletes will handle ReturnItem, Resolution, ShippingLabel
  await prisma.returnRequest.deleteMany({
    where: { shop: shop_domain },
  });

  await prisma.storeSettings.deleteMany({
    where: { shop: shop_domain },
  });

  return json({ message: "Shop data redacted" });
};
