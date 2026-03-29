import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const days = parseInt(url.searchParams.get("days") || "30");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const since = from ? new Date(from) : days === 0 ? new Date("2020-01-01") : new Date();
  if (!from && days > 0) since.setDate(since.getDate() - days);
  const until = to ? new Date(`${to}T23:59:59.999Z`) : new Date();

  const rowsData = await prisma.returnRequest.findMany({
    where: {
      shop: session.shop,
      createdAt: { gte: since, lte: until },
    },
    include: { items: true, resolution: true, shippingLabel: true },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  const header = [
    "return_id",
    "order_name",
    "customer_email",
    "status",
    "reason",
    "resolution_type",
    "item_count",
    "refund_amount",
    "saved_revenue",
    "shipping_cost",
    "created_at",
  ];

  const rows = rowsData.map((r) => {
    const refundAmount = r.resolution?.type === "REFUND"
      ? r.items.reduce((s, i) => s + Number(i.price) * i.quantity, 0)
      : 0;
    const saved = ["EXCHANGE", "EXCHANGE_DIFFERENT_PRODUCT", "EXCHANGE_WITH_PRICE_DIFF", "STORE_CREDIT"].includes(
      r.resolution?.type || "",
    )
      ? r.items.reduce((s, i) => s + Number(i.price) * i.quantity, 0)
      : 0;

    const columns = [
      r.id,
      r.orderName || "",
      r.customerEmail || "",
      r.status,
      r.reason || "",
      r.resolution?.type || "",
      String(r.items.length),
      refundAmount.toFixed(2),
      saved.toFixed(2),
      Number(r.shippingLabel?.cost || 0).toFixed(2),
      r.createdAt.toISOString(),
    ];
    return columns.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",");
  });

  const csv = [header.join(","), ...rows].join("\n");
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="returnease-analytics-${Date.now()}.csv"`,
    },
  });
};

export default function AnalyticsExportRoute() {
  return null;
}
