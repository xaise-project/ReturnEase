import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSearchParams, useOutletContext } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineGrid,
  Select,
  Divider,
  DataTable,
  Button,
  InlineStack,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import type { Locale } from "../services/i18n-admin";
import { translateReason } from "../services/i18n-admin";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const days = parseInt(url.searchParams.get("days") || "30");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const since = from ? new Date(from) : days === 0 ? new Date("2020-01-01") : new Date();
  if (!from && days > 0) since.setDate(since.getDate() - days);
  const until = to ? new Date(`${to}T23:59:59.999Z`) : new Date();

  const shop = session.shop;
  const fraudEventDelegate = (prisma as any).fraudEvent;

  const [
    totalReturns, pendingReturns, approvedReturns, completedReturns, declinedReturns,
    refundCount, exchangeCount, storeCreditCount, recentReturns, fraudEvents,
  ] = await Promise.all([
    prisma.returnRequest.count({ where: { shop, createdAt: { gte: since, lte: until } } }),
    prisma.returnRequest.count({ where: { shop, status: "REQUESTED", createdAt: { gte: since, lte: until } } }),
    prisma.returnRequest.count({ where: { shop, status: "APPROVED", createdAt: { gte: since, lte: until } } }),
    prisma.returnRequest.count({ where: { shop, status: "COMPLETED", createdAt: { gte: since, lte: until } } }),
    prisma.returnRequest.count({ where: { shop, status: "DECLINED", createdAt: { gte: since, lte: until } } }),
    prisma.returnRequest.count({ where: { shop, resolution: { type: "REFUND" }, createdAt: { gte: since, lte: until } } }),
    prisma.returnRequest.count({
      where: {
        shop,
        resolution: { type: { in: ["EXCHANGE", "EXCHANGE_DIFFERENT_PRODUCT", "EXCHANGE_WITH_PRICE_DIFF"] } },
        createdAt: { gte: since, lte: until },
      },
    }),
    prisma.returnRequest.count({ where: { shop, resolution: { type: "STORE_CREDIT" }, createdAt: { gte: since, lte: until } } }),
    prisma.returnRequest.findMany({
      where: { shop, createdAt: { gte: since, lte: until } },
      include: { items: true, resolution: true, shippingLabel: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    fraudEventDelegate
      ? fraudEventDelegate.findMany({
          where: { shop, createdAt: { gte: since, lte: until } },
          orderBy: { createdAt: "desc" },
          take: 2000,
        })
      : Promise.resolve([]),
  ]);

  let totalOrders = 0;
  try {
    const ordersCountResponse = await admin.graphql(
      `#graphql
        query ordersCount {
          ordersCount(limit: null) {
            count
          }
        }
      `,
    );
    const ordersCountData = await ordersCountResponse.json();
    totalOrders = Number(ordersCountData.data?.ordersCount?.count || 0);
  } catch {
    totalOrders = 0;
  }

  const savedRevenue = recentReturns
    .filter((r) =>
      r.resolution?.type === "EXCHANGE" ||
      r.resolution?.type === "EXCHANGE_DIFFERENT_PRODUCT" ||
      r.resolution?.type === "EXCHANGE_WITH_PRICE_DIFF" ||
      r.resolution?.type === "STORE_CREDIT",
    )
    .reduce((sum, r) => sum + r.items.reduce((s, i) => s + Number(i.price) * i.quantity, 0), 0);

  const totalRefundAmount = recentReturns
    .filter((r) => r.resolution?.type === "REFUND")
    .reduce((sum, r) => sum + r.items.reduce((s, i) => s + Number(i.price) * i.quantity, 0), 0);

  const productCounts: Record<string, { title: string; count: number }> = {};
  for (const r of recentReturns) {
    for (const item of r.items) {
      if (!productCounts[item.title]) productCounts[item.title] = { title: item.title, count: 0 };
      productCounts[item.title].count += item.quantity;
    }
  }
  const topProducts = Object.values(productCounts).sort((a, b) => b.count - a.count).slice(0, 10);

  const reasonCounts: Record<string, number> = {};
  for (const r of recentReturns) {
    const reason = r.reason?.split(":")[0] || "N/A";
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }
  const topReasons = Object.entries(reasonCounts).sort(([, a], [, b]) => b - a).slice(0, 5);
  const totalReasonCount = Object.values(reasonCounts).reduce((s, n) => s + n, 0);
  const reasonDistribution = Object.entries(reasonCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([reason, count]) => ({
      reason,
      count,
      percent: totalReasonCount > 0 ? (count / totalReasonCount) * 100 : 0,
    }))
    .slice(0, 8);

  const solutionDistribution = [
    {
      key: "REFUND",
      label: "REFUND",
      count: refundCount,
      percent: totalReturns > 0 ? (refundCount / totalReturns) * 100 : 0,
    },
    {
      key: "EXCHANGE",
      label: "EXCHANGE",
      count: exchangeCount,
      percent: totalReturns > 0 ? (exchangeCount / totalReturns) * 100 : 0,
    },
    {
      key: "STORE_CREDIT",
      label: "STORE_CREDIT",
      count: storeCreditCount,
      percent: totalReturns > 0 ? (storeCreditCount / totalReturns) * 100 : 0,
    },
  ];

  const customerCounts: Record<string, number> = {};
  for (const r of recentReturns) {
    if (!r.customerEmail) continue;
    customerCounts[r.customerEmail] = (customerCounts[r.customerEmail] || 0) + 1;
  }
  const topCustomers = Object.entries(customerCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  const shippingCostTotal = recentReturns.reduce(
    (sum, r) => sum + Number(r.shippingLabel?.cost || 0),
    0,
  );

  const returnRate = totalOrders > 0 ? ((totalReturns / totalOrders) * 100).toFixed(2) : "0.00";
  const fraudBlockedCount = fraudEvents.filter((e) => e.outcome === "BLOCKED").length;
  const fraudWarningCount = fraudEvents.filter((e) => e.outcome === "WARNING").length;
  const fraudRuleCounts: Record<string, number> = {};
  for (const event of fraudEvents) {
    fraudRuleCounts[event.rule] = (fraudRuleCounts[event.rule] || 0) + 1;
  }
  const topFraudRules = Object.entries(fraudRuleCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  return {
    days, from: from || "", to: to || "",
    totalReturns, pendingReturns, approvedReturns, completedReturns, declinedReturns,
    refundCount, exchangeCount, storeCreditCount,
    savedRevenue: savedRevenue.toFixed(2),
    totalRefundAmount: totalRefundAmount.toFixed(2),
    topProducts, topReasons,
    reasonDistribution,
    solutionDistribution,
    topCustomers,
    shippingCostTotal: shippingCostTotal.toFixed(2),
    returnRate,
    fraudBlockedCount,
    fraudWarningCount,
    topFraudRules,
  };
};

export default function Analytics() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useOutletContext<{ locale: Locale; t: Record<string, string> }>();
  const [fromDate, setFromDate] = useState(data.from || "");
  const [toDate, setToDate] = useState(data.to || "");

  const exchangeRate = data.totalReturns > 0 ? ((data.exchangeCount / data.totalReturns) * 100).toFixed(1) : "0";
  const storeCreditRate = data.totalReturns > 0 ? ((data.storeCreditCount / data.totalReturns) * 100).toFixed(1) : "0";
  const barColor = "#0A65FF";
  const topProducts = data.topProducts || [];
  const topReasons = data.topReasons || [];
  const reasonDistribution = data.reasonDistribution || [];
  const solutionDistribution = data.solutionDistribution || [];
  const topCustomers = data.topCustomers || [];
  const totalReturns = Number(data.totalReturns || 0);
  const savedRevenue = String(data.savedRevenue || "0.00");
  const totalRefundAmount = String(data.totalRefundAmount || "0.00");
  const shippingCostTotal = String(data.shippingCostTotal || "0.00");
  const returnRate = String(data.returnRate || "0.00");
  const pendingReturns = Number(data.pendingReturns || 0);
  const approvedReturns = Number(data.approvedReturns || 0);
  const completedReturns = Number(data.completedReturns || 0);
  const declinedReturns = Number(data.declinedReturns || 0);
  const refundCount = Number(data.refundCount || 0);
  const exchangeCount = Number(data.exchangeCount || 0);
  const storeCreditCount = Number(data.storeCreditCount || 0);
  const fraudBlockedCount = Number((data as any).fraudBlockedCount || 0);
  const fraudWarningCount = Number((data as any).fraudWarningCount || 0);
  const topFraudRules = (data as any).topFraudRules || [];

  return (
    <Page>
      <TitleBar title={t["analytics.title"]} />
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="end">
          <InlineStack gap="200">
            <Select
              label=""
              options={[
                { label: t["analytics.last7"], value: "7" },
                { label: t["analytics.last30"], value: "30" },
                { label: t["analytics.last90"], value: "90" },
                { label: t["analytics.last365"], value: "365" },
                { label: t["analytics.allTime"], value: "0" },
              ]}
              value={String(data.days)}
              onChange={(v) => {
                const params = new URLSearchParams(searchParams);
                params.set("days", v);
                params.delete("from");
                params.delete("to");
                setSearchParams(params);
              }}
            />
            <TextField
              label={t["analytics.from"] || "From"}
              type="date"
              value={fromDate}
              onChange={setFromDate}
              autoComplete="off"
            />
            <TextField
              label={t["analytics.to"] || "To"}
              type="date"
              value={toDate}
              onChange={setToDate}
              autoComplete="off"
            />
            <Button
              onClick={() => {
                const params = new URLSearchParams(searchParams);
                params.set("days", "0");
                if (fromDate) params.set("from", fromDate); else params.delete("from");
                if (toDate) params.set("to", toDate); else params.delete("to");
                setSearchParams(params);
              }}
            >
              {t["analytics.applyFilter"] || "Uygula"}
            </Button>
          </InlineStack>
          <Button
            url={`/app/analytics/export?${(() => {
              const params = new URLSearchParams(searchParams);
              return params.toString();
            })()}`}
            target="_blank"
          >
            {t["analytics.exportCsv"] || "CSV Export"}
          </Button>
        </InlineStack>

        <InlineGrid columns={3} gap="400">
          <Card>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">{t["analytics.totalReturns"]}</Text>
              <Text as="p" variant="headingXl">{totalReturns}</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {`${t["analytics.returnRate"] || "Return rate"}: ${returnRate}%`}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">{t["analytics.savedRevenue"]}</Text>
              <Text as="p" variant="headingXl">{savedRevenue}</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Exchange: {exchangeRate}% · Store Credit: {storeCreditRate}%
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">{t["analytics.totalRefund"]}</Text>
              <Text as="p" variant="headingXl">{totalRefundAmount}</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {`${t["analytics.shippingCost"] || "Shipping cost"}: ${shippingCostTotal}`}
              </Text>
            </BlockStack>
          </Card>
        </InlineGrid>

        <InlineGrid columns={2} gap="400">
          <Card>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">{t["analytics.fraudBlocked"] || "Fraud Engellenen İstek"}</Text>
              <Text as="p" variant="headingXl">{fraudBlockedCount}</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">{t["analytics.fraudWarnings"] || "Fraud Uyarı"}</Text>
              <Text as="p" variant="headingXl">{fraudWarningCount}</Text>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t["analytics.topFraudRules"] || "En Sık Fraud Kuralları"}</Text>
            <Divider />
            {topFraudRules.length > 0 ? (
              <DataTable
                columnContentTypes={["text", "numeric"]}
                headings={[t["analytics.rule"] || "Kural", t["analytics.count"]]}
                rows={topFraudRules.map(([rule, count]: any) => [rule, count])}
              />
            ) : (
              <Text as="p" tone="subdued">{t["analytics.noData"]}</Text>
            )}
          </BlockStack>
        </Card>

        <InlineGrid columns={4} gap="400">
          <Card><BlockStack gap="100"><Text as="p" variant="bodySm" tone="subdued">{t["analytics.pending"]}</Text><Text as="p" variant="headingLg">{pendingReturns}</Text></BlockStack></Card>
          <Card><BlockStack gap="100"><Text as="p" variant="bodySm" tone="subdued">{t["analytics.approved"]}</Text><Text as="p" variant="headingLg">{approvedReturns}</Text></BlockStack></Card>
          <Card><BlockStack gap="100"><Text as="p" variant="bodySm" tone="subdued">{t["analytics.completed"]}</Text><Text as="p" variant="headingLg">{completedReturns}</Text></BlockStack></Card>
          <Card><BlockStack gap="100"><Text as="p" variant="bodySm" tone="subdued">{t["analytics.declined"]}</Text><Text as="p" variant="headingLg">{declinedReturns}</Text></BlockStack></Card>
        </InlineGrid>

        <InlineGrid columns={2} gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">{t["analytics.topProducts"]}</Text>
              <Divider />
              {topProducts.length > 0 ? (
                <DataTable
                  columnContentTypes={["text", "numeric"]}
                  headings={[t["analytics.product"], t["analytics.count"]]}
                  rows={topProducts.map((p: any) => [p.title, p.count])}
                />
              ) : (
                <Text as="p" tone="subdued">{t["analytics.noData"]}</Text>
              )}
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">{t["analytics.topReasons"]}</Text>
              <Divider />
              {topReasons.length > 0 ? (
                <DataTable
                  columnContentTypes={["text", "numeric"]}
                  headings={[t["analytics.reason"], t["analytics.count"]]}
                  rows={topReasons.map(([reason, count]: any) => [translateReason(reason, t), count])}
                />
              ) : (
                <Text as="p" tone="subdued">{t["analytics.noData"]}</Text>
              )}
            </BlockStack>
          </Card>
        </InlineGrid>

        <InlineGrid columns={2} gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">{t["analytics.reasonDistribution"] || "İade Nedeni Dağılımı"}</Text>
              <Divider />
              {reasonDistribution.length > 0 ? (
                <BlockStack gap="200">
                  {reasonDistribution.map((item: any) => (
                    <BlockStack key={item.reason} gap="100">
                      <InlineStack align="space-between">
                        <Text as="span">{translateReason(item.reason, t)}</Text>
                        <Text as="span" tone="subdued">{`${item.count} • ${item.percent.toFixed(1)}%`}</Text>
                      </InlineStack>
                      <div style={{ width: "100%", height: 8, background: "#E5E7EB", borderRadius: 999 }}>
                        <div
                          style={{
                            width: `${Math.max(2, item.percent)}%`,
                            height: 8,
                            background: barColor,
                            borderRadius: 999,
                          }}
                        />
                      </div>
                    </BlockStack>
                  ))}
                </BlockStack>
              ) : (
                <Text as="p" tone="subdued">{t["analytics.noData"]}</Text>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">{t["analytics.solutionDistribution"] || "Çözüm Dağılımı"}</Text>
              <Divider />
              <BlockStack gap="200">
                {solutionDistribution.map((item: any) => (
                  <BlockStack key={item.key} gap="100">
                    <InlineStack align="space-between">
                      <Text as="span">{t[`resolution.${item.label}`] || item.label}</Text>
                      <Text as="span" tone="subdued">{`${item.count} • ${item.percent.toFixed(1)}%`}</Text>
                    </InlineStack>
                    <div style={{ width: "100%", height: 8, background: "#E5E7EB", borderRadius: 999 }}>
                      <div
                        style={{
                          width: `${Math.max(2, item.percent)}%`,
                          height: 8,
                          background: barColor,
                          borderRadius: 999,
                        }}
                      />
                    </div>
                  </BlockStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t["analytics.topCustomers"] || "Müşteri başına iade sayısı"}</Text>
            <Divider />
            {topCustomers.length > 0 ? (
              <DataTable
                columnContentTypes={["text", "numeric"]}
                headings={[t["analytics.customer"] || "Customer", t["analytics.count"]]}
                rows={topCustomers.map(([email, count]: any) => [email, count])}
              />
            ) : (
              <Text as="p" tone="subdued">{t["analytics.noData"]}</Text>
            )}
          </BlockStack>
        </Card>

        <InlineGrid columns={3} gap="400">
          <Card><BlockStack gap="100"><Text as="p" variant="bodySm" tone="subdued">{t["analytics.refund"]}</Text><Text as="p" variant="headingLg">{refundCount}</Text></BlockStack></Card>
          <Card><BlockStack gap="100"><Text as="p" variant="bodySm" tone="subdued">{t["analytics.exchange"]}</Text><Text as="p" variant="headingLg">{exchangeCount}</Text></BlockStack></Card>
          <Card><BlockStack gap="100"><Text as="p" variant="bodySm" tone="subdued">{t["analytics.storeCredit"]}</Text><Text as="p" variant="headingLg">{storeCreditCount}</Text></BlockStack></Card>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
