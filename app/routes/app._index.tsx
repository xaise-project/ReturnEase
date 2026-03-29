import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, useOutletContext } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineGrid,
  Badge,
  Button,
  InlineStack,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import type { Locale } from "../services/i18n-admin";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const [totalReturns, pendingReturns, approvedReturns, completedReturns, recentReturns] = await Promise.all([
    prisma.returnRequest.count({ where: { shop: session.shop } }),
    prisma.returnRequest.count({ where: { shop: session.shop, status: "REQUESTED" } }),
    prisma.returnRequest.count({ where: { shop: session.shop, status: "APPROVED" } }),
    prisma.returnRequest.count({ where: { shop: session.shop, status: "COMPLETED" } }),
    prisma.returnRequest.findMany({
      where: { shop: session.shop },
      include: { resolution: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  return {
    totalReturns,
    pendingReturns,
    approvedReturns,
    completedReturns,
    recentReturns: recentReturns.map((r) => ({
      id: r.id,
      orderName: r.orderName,
      customerEmail: r.customerEmail,
      status: r.status,
      resolutionType: r.resolution?.type || null,
      createdAt: r.createdAt.toISOString(),
    })),
  };
};

export default function Index() {
  const { totalReturns, pendingReturns, approvedReturns, completedReturns, recentReturns } =
    useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const { locale, t } = useOutletContext<{ locale: Locale; t: Record<string, string> }>();

  const statusBadge = (status: string) => {
    const tone: Record<string, any> = {
      REQUESTED: "attention", APPROVED: "info", DECLINED: "critical", COMPLETED: "success", CANCELLED: "warning",
    };
    return <Badge tone={tone[status] || "new"}>{t[`status.${status}`] || status}</Badge>;
  };

  return (
    <Page>
      <TitleBar title="ReturnEase" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingLg">{t["dashboard.welcome"]}</Text>
                <Text as="p" variant="bodyMd">{t["dashboard.description"]}</Text>
                <InlineStack gap="200">
                  <Button onClick={() => navigate("/app/returns")}>{t["dashboard.viewReturns"]}</Button>
                  <Button onClick={() => navigate("/app/analytics")}>{t["dashboard.analytics"]}</Button>
                  <Button onClick={() => navigate("/app/settings")}>{t["dashboard.settings"]}</Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <InlineGrid columns={4} gap="400">
              <Card>
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd" tone="subdued">{t["dashboard.totalReturns"]}</Text>
                  <Text as="p" variant="headingXl">{totalReturns}</Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd" tone="subdued">{t["dashboard.pending"]}</Text>
                  <InlineGrid columns="1fr auto" alignItems="center">
                    <Text as="p" variant="headingXl">{pendingReturns}</Text>
                    {pendingReturns > 0 && <Badge tone="attention">{t["dashboard.new"]}</Badge>}
                  </InlineGrid>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd" tone="subdued">{t["dashboard.approved"]}</Text>
                  <Text as="p" variant="headingXl">{approvedReturns}</Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd" tone="subdued">{t["dashboard.completed"]}</Text>
                  <Text as="p" variant="headingXl">{completedReturns}</Text>
                </BlockStack>
              </Card>
            </InlineGrid>
          </Layout.Section>

          {recentReturns.length > 0 && (
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">{t["dashboard.recentReturns"]}</Text>
                    <Button variant="plain" onClick={() => navigate("/app/returns")}>{t["dashboard.viewAll"]}</Button>
                  </InlineStack>
                  <Divider />
                  {recentReturns.map((r: any) => (
                    <div
                      key={r.id}
                      style={{ cursor: "pointer", padding: "8px 0", borderBottom: "1px solid #f3f4f6" }}
                      onClick={() => navigate(`/app/returns/${r.id}`)}
                    >
                      <InlineStack align="space-between">
                        <BlockStack gap="100">
                          <Text as="span" fontWeight="semibold">{r.orderName}</Text>
                          <Text as="span" variant="bodySm" tone="subdued">{r.customerEmail}</Text>
                        </BlockStack>
                        <BlockStack gap="100" inlineAlign="end">
                          {statusBadge(r.status)}
                          <Text as="span" variant="bodySm" tone="subdued">
                            {new Date(r.createdAt).toLocaleDateString(locale === "tr" ? "tr-TR" : "en-US")}
                          </Text>
                        </BlockStack>
                      </InlineStack>
                    </div>
                  ))}
                </BlockStack>
              </Card>
            </Layout.Section>
          )}
        </Layout>
      </BlockStack>
    </Page>
  );
}
