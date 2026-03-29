import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, payload } = await authenticate.webhook(request);

  if (topic !== "CUSTOMERS_DATA_REQUEST") {
    return json({ error: "Invalid topic" }, { status: 400 });
  }

  const { customer, shop_domain } = payload;
  const customerEmail = customer?.email;

  if (!customerEmail) {
    return json({ message: "No customer email provided" });
  }

  const returns = await prisma.returnRequest.findMany({
    where: {
      shop: shop_domain,
      customerEmail,
    },
    include: {
      items: true,
      resolution: true,
      shippingLabel: true,
    },
  });

  // Shopify expects a 200 response — actual data is sent to the merchant
  return json({
    customer: { email: customerEmail },
    returns: returns.map((r) => ({
      id: r.id,
      orderName: r.orderName,
      status: r.status,
      reason: r.reason,
      createdAt: r.createdAt,
      items: r.items.map((i) => ({
        title: i.title,
        quantity: i.quantity,
        price: i.price.toString(),
      })),
      resolution: r.resolution
        ? { type: r.resolution.type, amount: r.resolution.amount?.toString() }
        : null,
    })),
  });
};
