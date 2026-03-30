import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useActionData, useOutletContext } from "@remix-run/react";
import { useEffect } from "react";
import { Page, Text, BlockStack, Divider } from "@shopify/polaris";
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
  { id: "FREE", name: "Free", price: 0, limit: 10, color: "#6B7280" },
  { id: "STARTER", name: "Starter", price: 14, limit: 300, color: "#6366F1" },
  { id: "GROWTH", name: "Growth", price: 39, limit: -1, color: "#10B981" },
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
    } catch (e) { console.error("Subscription verification error:", e); }
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
  const planId = formData.get("planId") as string;
  const plan = PLANS.find((p) => p.id === planId);

  if (!plan || plan.price === 0) {
    await prisma.storeSettings.upsert({
      where: { shop: session.shop },
      update: { plan: "FREE", shopifySubscriptionId: null },
      create: { shop: session.shop, plan: "FREE" },
    });
    return json({ confirmationUrl: null });
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
          { plan: { appUsagePricingDetails: { terms: "2% commission on saved revenue", cappedAmount: { amount: 1000, currencyCode: "USD" } } } },
        ],
      },
    },
  );

  const data = await response.json();
  const confirmationUrl = data.data?.appSubscriptionCreate?.confirmationUrl;
  return json({ confirmationUrl: confirmationUrl || null });
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
      window.top === window.self
        ? (window.location.href = actionData.confirmationUrl)
        : open(actionData.confirmationUrl, "_top");
    }
  }, [actionData]);

  const usagePercent = data.planLimit > 0 ? Math.round((data.monthlyReturnCount / data.planLimit) * 100) : 0;
  const currentPlanConfig = PLANS.find((p) => p.id === data.currentPlan) || PLANS[0];

  return (
    <Page narrowWidth>
      <TitleBar title={t["billing.title"]} />
      <BlockStack gap="500">

        {/* ── Current plan + commission side by side ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

          {/* Current plan card */}
          <div style={{
            background: "#fff", borderRadius: 12, padding: 24,
            boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
            borderTop: `4px solid ${currentPlanConfig.color}`,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <Text as="h2" variant="headingMd">{t["billing.currentPlan"]}</Text>
              <span style={{
                background: `${currentPlanConfig.color}18`,
                color: currentPlanConfig.color,
                padding: "3px 10px", borderRadius: 20, fontSize: 13, fontWeight: 600,
              }}>
                {data.planName}
              </span>
            </div>
            <Divider />
            <div style={{ marginTop: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <Text as="span" tone="subdued">{t["billing.monthlyUsage"]}</Text>
                <Text as="span" fontWeight="bold">
                  {data.monthlyReturnCount} / {data.planLimit === -1 ? "∞" : data.planLimit}
                </Text>
              </div>
              {data.planLimit > 0 && (
                <div style={{ background: "#F3F4F6", borderRadius: 999, height: 8, overflow: "hidden" }}>
                  <div style={{
                    height: "100%",
                    width: `${Math.min(usagePercent, 100)}%`,
                    background: usagePercent > 80 ? "#EF4444" : usagePercent > 50 ? "#F59E0B" : currentPlanConfig.color,
                    borderRadius: 999, transition: "width 0.4s",
                  }} />
                </div>
              )}
              {data.planLimit > 0 && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {usagePercent}% {t["billing.monthlyUsage"]}
                </Text>
              )}
            </div>
          </div>

          {/* Commission card */}
          <div style={{
            background: "#fff", borderRadius: 12, padding: 24,
            boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
            borderTop: "4px solid #6366F1",
          }}>
            <div style={{ marginBottom: 16 }}>
              <Text as="h2" variant="headingMd">{t["billing.commissionTitle"]}</Text>
              <Text as="p" variant="bodySm" tone="subdued" breakWord>
                {t["billing.commissionInfo"]}
              </Text>
            </div>
            <Divider />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginTop: 16 }}>
              {[
                { label: t["billing.savedTotal"], value: `$${data.savedTotal}`, color: "#10B981" },
                { label: t["billing.commission"], value: `$${data.commissionTotal}`, color: "#6366F1" },
                { label: t["billing.transactions"], value: String(data.commissionCount), color: "#6B7280" },
              ].map((s) => (
                <div key={s.label} style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Plans ── */}
        <div>
          <Text as="h2" variant="headingMd">{t["billing.plans"]}</Text>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
          {data.plans.map((plan: any) => {
            const isCurrent = data.currentPlan === plan.id;
            const features = PLAN_FEATURES[plan.id] || [];
            const planColor = plan.color;

            return (
              <div key={plan.id} style={{
                background: "#fff", borderRadius: 12, padding: 24,
                boxShadow: isCurrent ? `0 0 0 2px ${planColor}` : "0 1px 3px rgba(0,0,0,0.08)",
                position: "relative", display: "flex", flexDirection: "column",
              }}>
                {isCurrent && (
                  <div style={{
                    position: "absolute", top: -1, right: 16,
                    background: planColor, color: "#fff",
                    fontSize: 11, fontWeight: 600, padding: "3px 10px",
                    borderRadius: "0 0 8px 8px",
                  }}>
                    {t["billing.activeBadge"]}
                  </div>
                )}

                <div style={{ marginBottom: 4 }}>
                  <Text as="h3" variant="headingMd">{plan.name}</Text>
                </div>

                <div style={{ margin: "12px 0" }}>
                  <span style={{ fontSize: 30, fontWeight: 800, color: planColor }}>
                    {plan.price === 0 ? t["billing.free"] : `$${plan.price}`}
                  </span>
                  {plan.price > 0 && (
                    <span style={{ fontSize: 13, color: "#9CA3AF" }}>{t["billing.perMonth"]}</span>
                  )}
                </div>

                <Text as="p" variant="bodySm" tone="subdued">
                  {plan.limit === -1
                    ? t["billing.unlimited"]
                    : t["billing.returnsPerMonth"].replace("{limit}", String(plan.limit))}
                </Text>

                <Divider />

                <BlockStack gap="100">
                  {features.map((fKey: string, i: number) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 6 }}>
                      <span style={{ color: planColor, fontSize: 14, fontWeight: 700 }}>✓</span>
                      <Text as="p" variant="bodySm">{t[fKey] || fKey}</Text>
                    </div>
                  ))}
                </BlockStack>

                <div style={{ marginTop: "auto", paddingTop: 20 }}>
                  {isCurrent ? (
                    <div style={{
                      textAlign: "center", padding: "8px 0", background: `${planColor}12`,
                      borderRadius: 8, color: planColor, fontSize: 13, fontWeight: 600,
                    }}>
                      {t["billing.currentButton"]}
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        const fd = new FormData();
                        fd.set("planId", plan.id);
                        submit(fd, { method: "post" });
                      }}
                      disabled={isSubmitting}
                      style={{
                        width: "100%", padding: "9px 0",
                        background: plan.id === "GROWTH" ? planColor : "#fff",
                        color: plan.id === "GROWTH" ? "#fff" : planColor,
                        border: `1.5px solid ${planColor}`,
                        borderRadius: 8, fontSize: 13, fontWeight: 600,
                        cursor: isSubmitting ? "not-allowed" : "pointer",
                        opacity: isSubmitting ? 0.6 : 1,
                      }}
                    >
                      {plan.price === 0
                        ? t["billing.freeStart"]
                        : t["billing.subscribe"].replace("${price}", String(plan.price))}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

      </BlockStack>
    </Page>
  );
}
