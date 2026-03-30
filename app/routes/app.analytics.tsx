import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSearchParams, useOutletContext } from "@remix-run/react";
import { useState, useCallback } from "react";
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
  Badge,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import type { Locale } from "../services/i18n-admin";
import { translateReason } from "../services/i18n-admin";

// ─── Loader ──────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const days = parseInt(url.searchParams.get("days") || "30");

  const since = days === 0 ? new Date("2020-01-01") : new Date();
  if (days > 0) since.setDate(since.getDate() - days);

  const shop = session.shop;

  const [
    totalReturns, pendingReturns, approvedReturns, completedReturns, declinedReturns,
    refundCount, exchangeCount, storeCreditCount, allReturns,
  ] = await Promise.all([
    prisma.returnRequest.count({ where: { shop, createdAt: { gte: since } } }),
    prisma.returnRequest.count({ where: { shop, status: "REQUESTED", createdAt: { gte: since } } }),
    prisma.returnRequest.count({ where: { shop, status: "APPROVED", createdAt: { gte: since } } }),
    prisma.returnRequest.count({ where: { shop, status: "COMPLETED", createdAt: { gte: since } } }),
    prisma.returnRequest.count({ where: { shop, status: "DECLINED", createdAt: { gte: since } } }),
    prisma.returnRequest.count({ where: { shop, resolution: { type: "REFUND" }, createdAt: { gte: since } } }),
    prisma.returnRequest.count({
      where: {
        shop,
        resolution: { type: { in: ["EXCHANGE", "EXCHANGE_DIFFERENT_PRODUCT", "EXCHANGE_WITH_PRICE_DIFF"] } },
        createdAt: { gte: since },
      },
    }),
    prisma.returnRequest.count({ where: { shop, resolution: { type: "STORE_CREDIT" }, createdAt: { gte: since } } }),
    prisma.returnRequest.findMany({
      where: { shop, createdAt: { gte: since } },
      include: { items: true, resolution: true },
      orderBy: { createdAt: "asc" },
      take: 1000,
    }),
  ]);

  // ── Saved revenue & refund ─────────────────────────────────
  const savedRevenue = allReturns
    .filter((r) => ["EXCHANGE", "EXCHANGE_DIFFERENT_PRODUCT", "EXCHANGE_WITH_PRICE_DIFF", "STORE_CREDIT"].includes(r.resolution?.type || ""))
    .reduce((sum, r) => sum + r.items.reduce((s, i) => s + Number(i.price) * i.quantity, 0), 0);

  const totalRefundAmount = allReturns
    .filter((r) => r.resolution?.type === "REFUND")
    .reduce((sum, r) => sum + r.items.reduce((s, i) => s + Number(i.price) * i.quantity, 0), 0);

  // ── Daily trend (group by date) ────────────────────────────
  const dailyCounts: Record<string, { date: string; total: number; saved: number; refunded: number }> = {};

  // Generate date range
  const numDays = days === 0 ? 90 : Math.min(days, 90);
  for (let d = numDays - 1; d >= 0; d--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - d);
    const key = dt.toISOString().slice(0, 10);
    dailyCounts[key] = { date: key, total: 0, saved: 0, refunded: 0 };
  }

  for (const r of allReturns) {
    const key = r.createdAt.toISOString().slice(0, 10);
    if (!dailyCounts[key]) continue;
    dailyCounts[key].total++;
    if (["EXCHANGE", "EXCHANGE_DIFFERENT_PRODUCT", "EXCHANGE_WITH_PRICE_DIFF", "STORE_CREDIT"].includes(r.resolution?.type || "")) {
      dailyCounts[key].saved += r.items.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
    }
    if (r.resolution?.type === "REFUND") {
      dailyCounts[key].refunded += r.items.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
    }
  }
  const trendData = Object.values(dailyCounts);

  // ── Top products ───────────────────────────────────────────
  const productCounts: Record<string, { title: string; count: number }> = {};
  for (const r of allReturns) {
    for (const item of r.items) {
      if (!productCounts[item.title]) productCounts[item.title] = { title: item.title, count: 0 };
      productCounts[item.title].count += item.quantity;
    }
  }
  const topProducts = Object.values(productCounts).sort((a, b) => b.count - a.count).slice(0, 10);

  // ── Top reasons ────────────────────────────────────────────
  const reasonCounts: Record<string, number> = {};
  for (const r of allReturns) {
    const reason = r.reason?.split(":")[0]?.trim() || "N/A";
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }
  const topReasons = Object.entries(reasonCounts).sort(([, a], [, b]) => b - a).slice(0, 5);
  const totalReasonCount = Object.values(reasonCounts).reduce((s, n) => s + n, 0);
  const reasonDistribution = Object.entries(reasonCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([reason, count]) => ({ reason, count, percent: totalReasonCount > 0 ? (count / totalReasonCount) * 100 : 0 }))
    .slice(0, 8);

  // ── Solution distribution ──────────────────────────────────
  const solutionDistribution = [
    { key: "REFUND", count: refundCount, percent: totalReturns > 0 ? (refundCount / totalReturns) * 100 : 0 },
    { key: "EXCHANGE", count: exchangeCount, percent: totalReturns > 0 ? (exchangeCount / totalReturns) * 100 : 0 },
    { key: "STORE_CREDIT", count: storeCreditCount, percent: totalReturns > 0 ? (storeCreditCount / totalReturns) * 100 : 0 },
  ];

  return {
    days,
    totalReturns, pendingReturns, approvedReturns, completedReturns, declinedReturns,
    refundCount, exchangeCount, storeCreditCount,
    savedRevenue: savedRevenue.toFixed(2),
    totalRefundAmount: totalRefundAmount.toFixed(2),
    topProducts, topReasons,
    reasonDistribution,
    solutionDistribution,
    trendData,
  };
};

// ─── SVG Line Chart ───────────────────────────────────────────

function LineChart({ data, height = 160 }: { data: { date: string; total: number }[]; height?: number }) {
  if (!data.length) return null;
  const max = Math.max(...data.map((d) => d.total), 1);
  const W = 100; // viewBox width %
  const H = height;
  const pad = { top: 12, right: 4, bottom: 24, left: 28 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;

  const points = data.map((d, i) => ({
    x: pad.left + (i / Math.max(data.length - 1, 1)) * chartW,
    y: pad.top + chartH - (d.total / max) * chartH,
    d,
  }));

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const areaD = `${pathD} L ${points[points.length - 1].x} ${pad.top + chartH} L ${points[0].x} ${pad.top + chartH} Z`;

  // Y axis labels
  const yTicks = [0, Math.round(max / 2), max];
  // X axis: show only ~5 labels
  const xStep = Math.max(1, Math.floor(data.length / 5));
  const xLabels = data.filter((_, i) => i % xStep === 0 || i === data.length - 1);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: H, display: "block" }}
      preserveAspectRatio="none"
    >
      {/* Grid lines */}
      {yTicks.map((v) => {
        const y = pad.top + chartH - (v / max) * chartH;
        return (
          <g key={v}>
            <line x1={pad.left} y1={y} x2={pad.left + chartW} y2={y} stroke="#E5E7EB" strokeWidth="0.5" />
            <text x={pad.left - 2} y={y + 3} fontSize="5" fill="#9CA3AF" textAnchor="end">{v}</text>
          </g>
        );
      })}

      {/* Area fill */}
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6366F1" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#6366F1" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaD} fill="url(#areaGrad)" />

      {/* Line */}
      <path d={pathD} fill="none" stroke="#6366F1" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />

      {/* Dots on data points */}
      {points.map((p, i) => (
        p.d.total > 0 ? (
          <circle key={i} cx={p.x} cy={p.y} r="1.5" fill="#6366F1" />
        ) : null
      ))}

      {/* X axis labels */}
      {xLabels.map((d) => {
        const idx = data.indexOf(d);
        const x = pad.left + (idx / Math.max(data.length - 1, 1)) * chartW;
        const label = d.date.slice(5); // MM-DD
        return (
          <text key={d.date} x={x} y={H - 4} fontSize="4.5" fill="#9CA3AF" textAnchor="middle">{label}</text>
        );
      })}
    </svg>
  );
}

// ─── Stat Card ────────────────────────────────────────────────

function StatCard({
  label, value, sub, color = "#6366F1", icon,
}: { label: string; value: string | number; sub?: string; color?: string; icon?: string }) {
  return (
    <div style={{
      background: "#fff",
      borderRadius: 12,
      padding: "20px 24px",
      boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
      borderLeft: `4px solid ${color}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 4 }}>{label}</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#111827", lineHeight: 1.2 }}>{value}</div>
          {sub && <div style={{ fontSize: 12, color: "#9CA3AF", marginTop: 4 }}>{sub}</div>}
        </div>
        {icon && (
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: `${color}18`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 18,
          }}>
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Progress Bar ─────────────────────────────────────────────

function ProgressRow({ label, count, percent, color }: { label: string; count: number; percent: number; color: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 13, color: "#374151" }}>{label}</span>
        <span style={{ fontSize: 13, color: "#6B7280" }}>{count} · {percent.toFixed(1)}%</span>
      </div>
      <div style={{ height: 8, background: "#F3F4F6", borderRadius: 99, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.max(2, percent)}%`, background: color, borderRadius: 99, transition: "width 0.6s ease" }} />
      </div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────

export default function Analytics() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useOutletContext<{ locale: Locale; t: Record<string, string> }>();
  const [exporting, setExporting] = useState(false);

  const exchangeRate = data.totalReturns > 0 ? ((data.exchangeCount / data.totalReturns) * 100).toFixed(1) : "0";
  const storeCreditRate = data.totalReturns > 0 ? ((data.storeCreditCount / data.totalReturns) * 100).toFixed(1) : "0";

  const reasonColors = ["#6366F1", "#8B5CF6", "#EC4899", "#F59E0B", "#10B981", "#3B82F6", "#EF4444", "#14B8A6"];
  const solutionColors: Record<string, string> = {
    REFUND: "#EF4444",
    EXCHANGE: "#6366F1",
    STORE_CREDIT: "#10B981",
  };

  // CSV export via fetch → blob download (works in embedded app)
  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams(searchParams);
      const res = await fetch(`/app/analytics/export?${params.toString()}`);
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `returnease-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(false);
    }
  }, [searchParams]);

  // Trend: compute change vs previous period
  const trendData = data.trendData || [];
  const half = Math.floor(trendData.length / 2);
  const firstHalf = trendData.slice(0, half).reduce((s, d) => s + d.total, 0);
  const secondHalf = trendData.slice(half).reduce((s, d) => s + d.total, 0);
  const trendChange = firstHalf > 0 ? (((secondHalf - firstHalf) / firstHalf) * 100).toFixed(1) : null;
  const trendUp = trendChange !== null && parseFloat(trendChange) >= 0;

  return (
    <Page>
      <TitleBar title={t["analytics.title"]} />
      <BlockStack gap="500">

        {/* ── Toolbar ── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
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
            onChange={(v) => setSearchParams({ days: v })}
          />
          <Button loading={exporting} onClick={handleExport}>
            {t["analytics.exportCsv"] || "CSV Export"}
          </Button>
        </div>

        {/* ── KPI Cards ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
          <StatCard
            label={t["analytics.totalReturns"]}
            value={data.totalReturns}
            sub={trendChange !== null ? `${trendUp ? "▲" : "▼"} ${Math.abs(parseFloat(trendChange))}% vs previous period` : undefined}
            color="#6366F1"
            icon="📦"
          />
          <StatCard
            label={t["analytics.savedRevenue"]}
            value={data.savedRevenue}
            sub={`Exchange ${exchangeRate}% · Credit ${storeCreditRate}%`}
            color="#10B981"
            icon="💰"
          />
          <StatCard
            label={t["analytics.totalRefund"]}
            value={data.totalRefundAmount}
            color="#EF4444"
            icon="↩️"
          />
          <StatCard
            label={t["analytics.pending"] || "Pending"}
            value={data.pendingReturns}
            color="#F59E0B"
            icon="⏳"
          />
        </div>

        {/* ── Status breakdown ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12 }}>
          {[
            { label: t["analytics.pending"], value: data.pendingReturns, color: "#F59E0B" },
            { label: t["analytics.approved"], value: data.approvedReturns, color: "#6366F1" },
            { label: t["analytics.completed"], value: data.completedReturns, color: "#10B981" },
            { label: t["analytics.declined"], value: data.declinedReturns, color: "#EF4444" },
          ].map((s) => (
            <div key={s.label} style={{
              background: "#fff", borderRadius: 10, padding: "16px",
              boxShadow: "0 1px 2px rgba(0,0,0,0.06)", textAlign: "center",
              borderTop: `3px solid ${s.color}`,
            }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: "#111827" }}>{s.value}</div>
              <div style={{ fontSize: 12, color: "#6B7280", marginTop: 4 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* ── Trend Chart ── */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">
                {t["analytics.trend"] || "Return Trend"}
              </Text>
              {trendChange !== null && (
                <Badge tone={trendUp ? "warning" : "success"}>
                  {trendUp ? "▲" : "▼"} {Math.abs(parseFloat(trendChange))}%
                </Badge>
              )}
            </InlineStack>
            <Divider />
            {trendData.length > 1 ? (
              <div style={{ paddingTop: 8 }}>
                <LineChart data={trendData} height={180} />
                <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 8 }}>
                  <span style={{ fontSize: 12, color: "#6B7280" }}>
                    <span style={{ display: "inline-block", width: 12, height: 3, background: "#6366F1", borderRadius: 2, verticalAlign: "middle", marginRight: 4 }} />
                    {t["analytics.totalReturns"]}
                  </span>
                </div>
              </div>
            ) : (
              <Text as="p" tone="subdued">{t["analytics.noData"]}</Text>
            )}
          </BlockStack>
        </Card>

        {/* ── Reason + Solution distribution ── */}
        <InlineGrid columns={2} gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">{t["analytics.topReasons"]}</Text>
              <Divider />
              {(data.reasonDistribution || []).length > 0 ? (
                (data.reasonDistribution as any[]).map((item, i) => (
                  <ProgressRow
                    key={item.reason}
                    label={translateReason(item.reason, t)}
                    count={item.count}
                    percent={item.percent}
                    color={reasonColors[i % reasonColors.length]}
                  />
                ))
              ) : (
                <Text as="p" tone="subdued">{t["analytics.noData"]}</Text>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">{t["analytics.solutionDistribution"] || "Resolution Breakdown"}</Text>
              <Divider />
              {(data.solutionDistribution as any[]).map((item) => (
                <ProgressRow
                  key={item.key}
                  label={t[`resolution.${item.key}`] || item.key}
                  count={item.count}
                  percent={item.percent}
                  color={solutionColors[item.key] || "#6366F1"}
                />
              ))}
              <Divider />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, paddingTop: 4 }}>
                {(data.solutionDistribution as any[]).map((item) => (
                  <div key={item.key} style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: solutionColors[item.key] || "#6366F1" }}>{item.count}</div>
                    <div style={{ fontSize: 11, color: "#6B7280" }}>{t[`resolution.${item.key}`] || item.key}</div>
                  </div>
                ))}
              </div>
            </BlockStack>
          </Card>
        </InlineGrid>

        {/* ── Top Products + Top Reasons table ── */}
        <InlineGrid columns={2} gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">{t["analytics.topProducts"]}</Text>
              <Divider />
              {(data.topProducts || []).length > 0 ? (
                <DataTable
                  columnContentTypes={["text", "numeric"]}
                  headings={[t["analytics.product"], t["analytics.count"]]}
                  rows={(data.topProducts as any[]).map((p) => [p.title, p.count])}
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
              {(data.topReasons || []).length > 0 ? (
                <DataTable
                  columnContentTypes={["text", "numeric"]}
                  headings={[t["analytics.reason"], t["analytics.count"]]}
                  rows={(data.topReasons as any[]).map(([reason, count]) => [translateReason(reason, t), count])}
                />
              ) : (
                <Text as="p" tone="subdued">{t["analytics.noData"]}</Text>
              )}
            </BlockStack>
          </Card>
        </InlineGrid>

      </BlockStack>
    </Page>
  );
}
