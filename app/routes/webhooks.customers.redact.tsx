import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, payload } = await authenticate.webhook(request);

  if (topic !== "CUSTOMERS_REDACT") {
    return json({ error: "Invalid topic" }, { status: 400 });
  }

  const { customer, shop_domain } = payload;
  const customerEmail = customer?.email;

  if (!customerEmail) {
    return json({ message: "No customer email provided" });
  }

  // Anonymize customer data in return requests
  await prisma.returnRequest.updateMany({
    where: {
      shop: shop_domain,
      customerEmail,
    },
    data: {
      customerEmail: "redacted@redacted.com",
    },
  });

  return json({ message: "Customer data redacted" });
};
