import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useActionData, useOutletContext } from "@remix-run/react";
import { useEffect } from "react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineGrid,
  Button,
  Badge,
  Divider,
  Banner,
  InlineStack,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import type { Locale } from "../services/i18n-admin";

const PLAN_FEATURES: Record<string, string[]> = {
  FREE: ["plan.free.f1", "plan.free.f2", "plan.free.f3"],
  STARTER: ["plan.starter.f1", "plan.starter.f2", "plan.starter.f3", "plan.starter.f4"],
  GROWTH: ["plan.growth.f1", "plan.growth.f2", "plan.growth.f3", "plan.growth.f4", "plan.growth.f5"],
};

const PLANS = [
  { id: "FREE", name: "Free", price: 0, limit: 10 },
  { id: "STARTER", name: "Starter", price: 14, limit: 300 },
  { id: "GROWTH", name: "Growth", price: 39, limit: -1 },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  const chargeId = url.searchParams.get("charge_id");
  if (chargeId) {
    try {
      const subResponse = await admin.graphql(
        `#graphql
          query getSubscription($id: ID!) {
            node(id: $id) {
              ... on AppSubscription { id name status }
            }
          }
        `,
        { variables: { id: `gid://shopify/AppSubscription/${chargeId}` } },
      );
      const subData = await subResponse.json();
      const subscription = subData.data?.node;

      if (subscription?.status === "ACTIVE") {
        const planId = subscription.name.includes("Growth") ? "GROWTH"
          : subscription.name.includes("Starter") ? "STARTER" : "FREE";
        await prisma.storeSettings.upsert({
          where: { shop: session.shop },
          update: { plan: planId, shopifySubscriptionId: subscription.id },
          create: { shop: session.shop, plan: planId, shopifySubscriptionId: subscription.id },
        });
      }
    } catch (e) {
      console.error("Subscription verification error:", e);
    }
  }

  const settings = await prisma.storeSettings.findUnique({ where: { shop: session.shop } });
  const currentPlan = settings?.plan || "FREE";
  const planConfig = PLANS.find((p) => p.id === currentPlan) || PLANS[0];

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const monthlyReturnCount = await prisma.returnRequest.count({
    where: { shop: session.shop, createdAt: { gte: monthStart } },
  });

  const commissionTotal = await prisma.usageRecord.aggregate({
    where: { shop: session.shop, createdAt: { gte: monthStart } },
    _sum: { commissionAmount: true, savedAmount: true },
    _count: true,
  });

  return {
    currentPlan, monthlyReturnCount,
    planLimit: planConfig.limit,
    planName: planConfig.name,
    plans: PLANS,
    commissionCount: commissionTotal._count || 0,
    commissionTotal: Number(commissionTotal._sum.commissionAmount || 0).toFixed(2),
    savedTotal: Number(commissionTotal._sum.savedAmount || 0).toFixed(2),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const planId = formData.get("planId") as string;

  if (intent === "subscribe") {
    const plan = PLANS.find((p) => p.id === planId);
    if (!plan || plan.price === 0) {
      await prisma.storeSettings.upsert({
        where: { shop: session.shop },
        update: { plan: "FREE", shopifySubscriptionId: null },
        create: { shop: session.shop, plan: "FREE" },
      });
      return null;
    }

    const response = await admin.graphql(
      `#graphql
        mutation appSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!, $test: Boolean) {
          appSubscriptionCreate(name: $name, lineItems: $lineItems, returnUrl: $returnUrl, test: $test) {
            appSubscription { id }
            confirmationUrl
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          name: `ReturnEase ${plan.name}`,
          test: true,
          returnUrl: `https://${session.shop}/admin/apps/returnease/app/billing`,
          lineItems: [
            { plan: { appRecurringPricingDetails: { price: { amount: plan.price, currencyCode: "USD" } } } },
            { plan: { appUsagePricingDetails: { terms: "2% commission on saved revenue (exchange + store credit)", cappedAmount: { amount: 1000, currencyCode: "USD" } } } },
          ],
        },
      },
    );

    const data = await response.json();
    const errors = data.data?.appSubscriptionCreate?.userErrors || [];
    if (errors.length > 0) {
      console.error("Billing error:", errors);
      return null;
    }
    const confirmationUrl = data.data?.appSubscriptionCreate?.confirmationUrl;
    if (confirmationUrl) return json({ confirmationUrl });
  }

  return json({ confirmationUrl: null });
};

export default function Billing() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<{ confirmationUrl: string | null }>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const { t } = useOutletContext<{ locale: Locale; t: Record<string, string> }>();

  useEffect(() => {
    if (actionData?.confirmationUrl) {
      if (window.top === window.self) {
        window.location.href = actionData.confirmationUrl;
      } else {
        open(actionData.confirmationUrl, "_top");
      }
    }
  }, [actionData]);

  const usagePercent = data.planLimit > 0 ? Math.round((data.monthlyReturnCount / data.planLimit) * 100) : 0;

  return (
    <Page>
      <TitleBar title={t["billing.title"]} />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">{t["billing.currentPlan"]}</Text>
              <Badge tone="info">{data.planName}</Badge>
            </InlineStack>
            <Divider />
            <InlineStack align="space-between">
              <Text as="span" tone="subdued">{t["billing.monthlyUsage"]}</Text>
              <Text as="span" fontWeight="bold">
                {data.monthlyReturnCount} / {data.planLimit === -1 ? "∞" : data.planLimit}
              </Text>
            </InlineStack>
            {data.planLimit > 0 && (
              <div style={{ background: "#e5e7eb", borderRadius: 4, height: 8, overflow: "hidden" }}>
                <div style={{
                  background: usagePercent > 80 ? "#ef4444" : usagePercent > 50 ? "#f59e0b" : "#22c55e",
                  height: "100%",
                  width: `${Math.min(usagePercent, 100)}%`,
                  borderRadius: 4,
                }} />
              </div>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t["billing.commissionTitle"]}</Text>
            <Divider />
            <InlineGrid columns={3} gap="400">
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">{t["billing.savedTotal"]}</Text>
                <Text as="p" variant="headingMd">${data.savedTotal}</Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">{t["billing.commission"]}</Text>
                <Text as="p" variant="headingMd">${data.commissionTotal}</Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">{t["billing.transactions"]}</Text>
                <Text as="p" variant="headingMd">{data.commissionCount}</Text>
              </BlockStack>
            </InlineGrid>
            <Banner tone="info">
              <Text as="p" variant="bodySm">{t["billing.commissionInfo"]}</Text>
            </Banner>
          </BlockStack>
        </Card>

        <Text as="h2" variant="headingMd">{t["billing.plans"]}</Text>
        <InlineGrid columns={3} gap="400">
          {data.plans.map((plan: any) => {
            const isCurrent = data.currentPlan === plan.id;
            const features = PLAN_FEATURES[plan.id] || [];
            return (
              <Card key={plan.id}>
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <Text as="h3" variant="headingMd">{plan.name}</Text>
                    {isCurrent && <Badge tone="success">{t["billing.activeBadge"]}</Badge>}
                  </InlineStack>
                  <Text as="p" variant="headingXl">
                    {plan.price === 0 ? t["billing.free"] : `$${plan.price}${t["billing.perMonth"]}`}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {plan.limit === -1 ? t["billing.unlimited"] : t["billing.returnsPerMonth"].replace("{limit}", String(plan.limit))}
                  </Text>
                  <Divider />
                  <BlockStack gap="100">
                    {features.map((fKey: string, i: number) => (
                      <Text key={i} as="p" variant="bodySm">✓ {t[fKey] || fKey}</Text>
                    ))}
                  </BlockStack>
                  <Box paddingBlockStart="200">
                    {isCurrent ? (
                      <Button disabled fullWidth>{t["billing.currentButton"]}</Button>
                    ) : (
                      <Button
                        variant={plan.id === "GROWTH" ? "primary" : undefined}
                        fullWidth
                        loading={isSubmitting}
                        onClick={() => {
                          const fd = new FormData();
                          fd.set("intent", "subscribe");
                          fd.set("planId", plan.id);
                          submit(fd, { method: "post" });
                        }}
                      >
                        {plan.price === 0 ? t["billing.freeStart"] : t["billing.subscribe"].replace("${price}", String(plan.price))}
                      </Button>
                    )}
                  </Box>
                </BlockStack>
              </Card>
            );
          })}
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
