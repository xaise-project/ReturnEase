import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useActionData, useOutletContext } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  Text,
  Badge,
  BlockStack,
  InlineStack,
  Divider,
  Button,
  Banner,
  TextField,
  Select,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import type { Locale } from "../services/i18n-admin";
import { translateReason } from "../services/i18n-admin";
import { refreshLabelStatus } from "../services/shippo.server";
import { dispatchReturnNotifications } from "../services/notifications.server";

async function syncRestockToShopify(admin: any, returnRequest: any) {
  const variantIds = returnRequest.items
    .map((item: any) => item.variantId)
    .filter((id: string) => id && id !== "manual");
  if (variantIds.length === 0) return { ok: true, skipped: true };

  const locationResponse = await admin.graphql(
    `#graphql
      query getPrimaryLocation {
        locations(first: 1, query: "active:true") {
          edges { node { id } }
        }
      }
    `,
  );
  const locationData = await locationResponse.json();
  const locationId = locationData.data?.locations?.edges?.[0]?.node?.id;
  if (!locationId) return { ok: false, error: "No active location found." };

  const variantsResponse = await admin.graphql(
    `#graphql
      query getInventoryItems($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            inventoryItem { id }
          }
        }
      }
    `,
    { variables: { ids: variantIds } },
  );
  const variantData = await variantsResponse.json();
  const itemMap = new Map<string, string>();
  for (const node of variantData.data?.nodes || []) {
    if (node?.id && node?.inventoryItem?.id) itemMap.set(node.id, node.inventoryItem.id);
  }

  const changes = returnRequest.items
    .map((item: any) => {
      const inventoryItemId = itemMap.get(item.variantId);
      if (!inventoryItemId) return null;
      return { inventoryItemId, delta: item.quantity, locationId };
    })
    .filter(Boolean);

  if (changes.length === 0) return { ok: true, skipped: true };

  const adjustResponse = await admin.graphql(
    `#graphql
      mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) {
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        input: {
          reason: "correction",
          name: "available",
          changes,
        },
      },
    },
  );
  const adjustData = await adjustResponse.json();
  const userErrors = adjustData.data?.inventoryAdjustQuantities?.userErrors || [];
  if (userErrors.length > 0) {
    return { ok: false, error: userErrors.map((e: any) => e.message).join(", ") };
  }
  return { ok: true };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { id } = params;

  const returnRequest = await prisma.returnRequest.findFirst({
    where: { id, shop: session.shop },
    include: { items: true, resolution: true, shippingLabel: true },
  });

  if (!returnRequest) {
    throw new Response("Return not found", { status: 404 });
  }

  const actionLogs = await prisma.returnActionLog.findMany({
    where: { shop: session.shop, returnRequestId: String(id) },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return {
    returnRequest: {
      ...returnRequest,
      createdAt: returnRequest.createdAt.toISOString(),
      updatedAt: returnRequest.updatedAt.toISOString(),
      items: returnRequest.items.map((i) => ({ ...i, price: i.price.toString() })),
      resolution: returnRequest.resolution
        ? {
            ...returnRequest.resolution,
            amount: returnRequest.resolution.amount?.toString(),
            priceDifference: returnRequest.resolution.priceDifference?.toString(),
            createdAt: returnRequest.resolution.createdAt.toISOString(),
          }
        : null,
      shippingLabel: returnRequest.shippingLabel
        ? { ...returnRequest.shippingLabel, createdAt: returnRequest.shippingLabel.createdAt.toISOString() }
        : null,
      customerMessageSentAt: returnRequest.customerMessageSentAt?.toISOString() || null,
      stockSyncedAt: returnRequest.stockSyncedAt?.toISOString() || null,
    },
    actionLogs: actionLogs.map((log) => ({
      ...log,
      createdAt: log.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const { id } = params;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const returnRequest = await prisma.returnRequest.findFirst({
    where: { id, shop: session.shop },
    include: { items: true, resolution: true },
  });

  if (!returnRequest) {
    throw new Response("Return not found", { status: 404 });
  }
  const actor = `admin:${session.shop}`;
  const logAction = async (action: string, metadata?: Record<string, any>, note?: string) => {
    await prisma.returnActionLog.create({
      data: {
        shop: session.shop,
        returnRequestId: String(id),
        action,
        actor,
        note: note || null,
        metadata: metadata || undefined,
      },
    });
  };
  const fetchRemoteReturnStatus = async () => {
    if (!returnRequest.shopifyReturnId) return "";
    try {
      const response = await admin.graphql(
        `#graphql
          query getReturnStatus($id: ID!) {
            return(id: $id) {
              id
              status
            }
          }
        `,
        { variables: { id: returnRequest.shopifyReturnId } },
      );
      const data = await response.json();
      return String(data.data?.return?.status || "");
    } catch {
      return "";
    }
  };

  const finalizeReturn = async () => {
    let syncData: any = {
      status: "COMPLETED",
    };
    if (returnRequest.restockDecision === "RESTOCK") {
      try {
        const syncResult = await syncRestockToShopify(admin, returnRequest);
        if (syncResult.ok) {
          syncData.stockSyncStatus = "SYNCED";
          syncData.stockSyncedAt = new Date();
          syncData.stockSyncError = null;
        } else {
          syncData.stockSyncStatus = "FAILED";
          syncData.stockSyncError = syncResult.error || "Unknown stock sync error";
        }
      } catch (e: any) {
        syncData.stockSyncStatus = "FAILED";
        syncData.stockSyncError = e.message;
      }
    }
    await prisma.returnRequest.update({ where: { id }, data: syncData });
    await logAction("DETAIL_COMPLETE", { syncData });
    await dispatchReturnNotifications({
      shop: session.shop,
      event: "RETURN_COMPLETED",
      returnRequest: {
        id: String(id),
        orderName: returnRequest.orderName,
        customerEmail: returnRequest.customerEmail,
        reason: returnRequest.reason,
        status: "COMPLETED",
        resolutionType: returnRequest.resolution?.type || null,
      },
    });
    return json({ success: "completed" });
  };

  if (intent === "approve" && returnRequest.shopifyReturnId) {
    try {
      const remoteStatus = await fetchRemoteReturnStatus();
      if (remoteStatus === "APPROVED") {
        await prisma.returnRequest.update({ where: { id }, data: { status: "APPROVED" } });
        await logAction("DETAIL_APPROVE_RECONCILED", { remoteStatus });
        return json({ success: "approved" });
      }
      if (remoteStatus === "CLOSED") {
        await prisma.returnRequest.update({ where: { id }, data: { status: "COMPLETED" } });
        await logAction("DETAIL_APPROVE_SKIPPED", { remoteStatus });
        return json({ success: "completed" });
      }
      if (["DECLINED", "CANCELLED"].includes(remoteStatus)) {
        await prisma.returnRequest.update({ where: { id }, data: { status: "DECLINED" } });
        await logAction("DETAIL_APPROVE_SKIPPED", { remoteStatus });
        return json({ success: "declined" });
      }

      const response = await admin.graphql(
        `#graphql
          mutation returnApproveRequest($input: ReturnApproveRequestInput!) {
            returnApproveRequest(input: $input) {
              return { id status }
              userErrors { field message }
            }
          }
        `,
        { variables: { input: { id: returnRequest.shopifyReturnId } } },
      );
      const data = await response.json();
      const errors = data.data?.returnApproveRequest?.userErrors || [];
      const blockingErrors = errors.filter((e: any) => {
        const msg = String(e.message || "").toLowerCase();
        if (msg.includes("already")) return false;
        if (msg.includes("not approvable")) return false;
        if (msg.includes("only returns with status requested can be approved")) return false;
        return true;
      });
      if (blockingErrors.length > 0) {
        return json({ error: blockingErrors.map((e: any) => e.message).join(", ") });
      }
      const reconciledStatus = await fetchRemoteReturnStatus();
      if (reconciledStatus === "CLOSED") {
        await prisma.returnRequest.update({ where: { id }, data: { status: "COMPLETED" } });
        await logAction("DETAIL_APPROVE", { remoteStatus: reconciledStatus });
        return json({ success: "completed" });
      }
      if (["DECLINED", "CANCELLED"].includes(reconciledStatus)) {
        await prisma.returnRequest.update({ where: { id }, data: { status: "DECLINED" } });
        await logAction("DETAIL_APPROVE_SKIPPED", { remoteStatus: reconciledStatus });
        return json({ success: "declined" });
      }
      await prisma.returnRequest.update({
        where: { id },
        data: { status: "APPROVED" },
      });
      await logAction("DETAIL_APPROVE");
      await dispatchReturnNotifications({
        shop: session.shop,
        event: "RETURN_APPROVED",
        returnRequest: {
          id: String(id),
          orderName: returnRequest.orderName,
          customerEmail: returnRequest.customerEmail,
          reason: returnRequest.reason,
          status: "APPROVED",
          resolutionType: returnRequest.resolution?.type || null,
        },
      });
      return json({ success: "approved" });
    } catch (e: any) {
      return json({ error: e.message });
    }
  }

  if (intent === "decline" && returnRequest.shopifyReturnId) {
    try {
      const remoteStatus = await fetchRemoteReturnStatus();
      if (["DECLINED", "CANCELLED"].includes(remoteStatus)) {
        await prisma.returnRequest.update({ where: { id }, data: { status: "DECLINED" } });
        await logAction("DETAIL_DECLINE_RECONCILED", { remoteStatus });
        return json({ success: "declined" });
      }
      if (remoteStatus === "CLOSED") {
        await prisma.returnRequest.update({ where: { id }, data: { status: "COMPLETED" } });
        await logAction("DETAIL_DECLINE_SKIPPED", { remoteStatus });
        return json({ success: "completed" });
      }
      if (remoteStatus === "APPROVED") {
        await prisma.returnRequest.update({ where: { id }, data: { status: "APPROVED" } });
        await logAction("DETAIL_DECLINE_SKIPPED", { remoteStatus });
        return json({ success: "approved" });
      }

      const response = await admin.graphql(
        `#graphql
          mutation returnDeclineRequest($input: ReturnDeclineRequestInput!) {
            returnDeclineRequest(input: $input) {
              return { id status }
              userErrors { field message }
            }
          }
        `,
        { variables: { input: { id: returnRequest.shopifyReturnId, declineReason: "OTHER" } } },
      );
      const data = await response.json();
      const errors = data.data?.returnDeclineRequest?.userErrors || [];
      const blockingErrors = errors.filter((e: any) => {
        const msg = String(e.message || "").toLowerCase();
        if (msg.includes("already")) return false;
        if (msg.includes("not declinable")) return false;
        if (msg.includes("only non-refunded returns with status requested can be declined")) return false;
        return true;
      });
      if (blockingErrors.length > 0) {
        return json({ error: blockingErrors.map((e: any) => e.message).join(", ") });
      }
      const reconciledStatus = await fetchRemoteReturnStatus();
      const nextStatus = reconciledStatus === "CLOSED"
        ? "COMPLETED"
        : reconciledStatus === "APPROVED"
          ? "APPROVED"
          : "DECLINED";
      await prisma.returnRequest.update({
        where: { id },
        data: { status: nextStatus },
      });
      await logAction("DETAIL_DECLINE", { remoteStatus: reconciledStatus || "UNKNOWN" });
      if (nextStatus === "DECLINED") {
        await dispatchReturnNotifications({
          shop: session.shop,
          event: "RETURN_DECLINED",
          returnRequest: {
            id: String(id),
            orderName: returnRequest.orderName,
            customerEmail: returnRequest.customerEmail,
            reason: returnRequest.reason,
            status: "DECLINED",
            resolutionType: returnRequest.resolution?.type || null,
          },
        });
        return json({ success: "declined" });
      }
      if (nextStatus === "COMPLETED") return json({ success: "completed" });
      return json({ success: "approved" });
    } catch (e: any) {
      return json({ error: e.message });
    }
  }

  if (intent === "complete_from_pending") {
    if (returnRequest.shopifyReturnId) {
      try {
        const approveResponse = await admin.graphql(
          `#graphql
            mutation returnApproveRequest($input: ReturnApproveRequestInput!) {
              returnApproveRequest(input: $input) {
                return { id status }
                userErrors { field message }
              }
            }
          `,
          { variables: { input: { id: returnRequest.shopifyReturnId } } },
        );
        const approveData = await approveResponse.json();
        const approveErrors = approveData.data?.returnApproveRequest?.userErrors || [];
        const blockingApproveErrors = approveErrors.filter(
          (e: any) => !String(e.message || "").toLowerCase().includes("already"),
        );
        if (blockingApproveErrors.length > 0) {
          return json({ error: blockingApproveErrors.map((e: any) => e.message).join(", ") });
        }
      } catch (e: any) {
        return json({ error: e.message });
      }
    }

    if (returnRequest.resolution?.type === "REFUND" && returnRequest.shopifyReturnId) {
      try {
        await admin.graphql(
          `#graphql
            mutation returnClose($id: ID!) {
              returnClose(id: $id) {
                return { id status }
                userErrors { field message }
              }
            }
          `,
          { variables: { id: returnRequest.shopifyReturnId } },
        );
      } catch (e: any) {
        console.error("Return close error:", e.message);
      }
    }

    return finalizeReturn();
  }

  if (intent === "cancel_from_pending") {
    if (returnRequest.shopifyReturnId) {
      try {
        const response = await admin.graphql(
          `#graphql
            mutation returnDeclineRequest($input: ReturnDeclineRequestInput!) {
              returnDeclineRequest(input: $input) {
                return { id status }
                userErrors { field message }
              }
            }
          `,
          { variables: { input: { id: returnRequest.shopifyReturnId, declineReason: "OTHER" } } },
        );
        const data = await response.json();
        const errors = data.data?.returnDeclineRequest?.userErrors || [];
        if (errors.length > 0) {
          return json({ error: errors.map((e: any) => e.message).join(", ") });
        }
      } catch (e: any) {
        return json({ error: e.message });
      }
    }
    await prisma.returnRequest.update({
      where: { id },
      data: { status: "CANCELLED" },
    });
    await logAction("DETAIL_CANCEL_PENDING");
    await dispatchReturnNotifications({
      shop: session.shop,
      event: "RETURN_CANCELLED",
      returnRequest: {
        id: String(id),
        orderName: returnRequest.orderName,
        customerEmail: returnRequest.customerEmail,
        reason: returnRequest.reason,
        status: "CANCELLED",
        resolutionType: returnRequest.resolution?.type || null,
      },
    });
    return json({ success: "cancelled" });
  }

  if (intent === "complete") {
    // If resolution is REFUND, try to issue refund via Shopify
    if (returnRequest.resolution?.type === "REFUND" && returnRequest.shopifyReturnId) {
      try {
        // Close the return on Shopify side
        await admin.graphql(
          `#graphql
            mutation returnClose($id: ID!) {
              returnClose(id: $id) {
                return { id status }
                userErrors { field message }
              }
            }
          `,
          { variables: { id: returnRequest.shopifyReturnId } },
        );
      } catch (e: any) {
        console.error("Return close error:", e.message);
      }
    }
    return finalizeReturn();
  }

  if (intent === "save_internal_note") {
    const internalNote = (formData.get("internalNote") as string) || "";
    await prisma.returnRequest.update({
      where: { id },
      data: { internalNote },
    });
    await logAction("DETAIL_SAVE_NOTE", undefined, internalNote);
    return json({ success: "note_saved" });
  }

  if (intent === "send_customer_message") {
    const customerMessage = (formData.get("customerMessage") as string) || "";
    await prisma.returnRequest.update({
      where: { id },
      data: { customerMessage, customerMessageSentAt: new Date() },
    });
    await logAction("DETAIL_SEND_CUSTOMER_MESSAGE", { length: customerMessage.length });
    return json({ success: "message_sent" });
  }

  if (intent === "set_restock_decision") {
    const restockDecision = ((formData.get("restockDecision") as string) || "NO_RESTOCK") as "RESTOCK" | "NO_RESTOCK";
    await prisma.returnRequest.update({
      where: { id },
      data: {
        restockDecision,
        stockSyncStatus: restockDecision === "RESTOCK" ? "PENDING" : "SYNCED",
        stockSyncError: null,
      },
    });
    await logAction("DETAIL_SET_RESTOCK", { restockDecision });
    return json({ success: "restock_updated" });
  }

  if (intent === "refresh_label_status") {
    await refreshLabelStatus(session.shop, returnRequest.id);
    await logAction("DETAIL_REFRESH_LABEL");
    return json({ success: "label_refreshed" });
  }

  return json({});
};

export default function ReturnDetail() {
  const { returnRequest: r, actionLogs } = useLoaderData<typeof loader>();
  const actionData = useActionData<any>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const { locale, t } = useOutletContext<{ locale: Locale; t: Record<string, string> }>();
  const [internalNote, setInternalNote] = useState(r.internalNote || "");
  const [customerMessage, setCustomerMessage] = useState(r.customerMessage || "");
  const [restockDecision, setRestockDecision] = useState(r.restockDecision || "NO_RESTOCK");

  const dateFmt = locale === "tr" ? "tr-TR" : "en-US";

  const statusBadge = (s: string) => {
    const tone: Record<string, any> = {
      REQUESTED: "attention", APPROVED: "info", DECLINED: "critical", COMPLETED: "success", CANCELLED: "warning",
    };
    return <Badge tone={tone[s] || "new"}>{t[`status.${s}`] || s}</Badge>;
  };

  const totalAmount = r.items.reduce(
    (sum: number, item: any) => sum + parseFloat(item.price) * item.quantity, 0,
  );

  return (
    <Page
      backAction={{ url: "/app/returns" }}
      title={`${t["detail.return"]} — ${r.orderName}`}
      subtitle={r.customerEmail}
      titleMetadata={statusBadge(r.status)}
    >
      <TitleBar title={`${t["detail.return"]} — ${r.orderName}`} />
      <BlockStack gap="400">
        {actionData?.error && (
          <Banner tone="critical" onDismiss={() => {}}>
            {actionData.error}
          </Banner>
        )}
        {actionData?.success && (
          <Banner tone="success" onDismiss={() => {}}>
            {t[`detail.${actionData.success}`] || actionData.success}
          </Banner>
        )}

        {r.status === "REQUESTED" && (
          <Banner title={t["detail.pendingBanner"]} tone="warning">
            <InlineStack gap="200">
              <Button
                variant="primary"
                loading={isSubmitting}
                onClick={() => submit({ intent: "approve" }, { method: "post" })}
              >
                {t["detail.approveOnly"] || "Talebi Onayla"}
              </Button>
              <Button
                variant="primary"
                tone="critical"
                loading={isSubmitting}
                onClick={() => submit({ intent: "decline" }, { method: "post" })}
              >
                {t["detail.rejectRequest"] || "Reddet"}
              </Button>
            </InlineStack>
          </Banner>
        )}

        {r.status === "APPROVED" && (
          <Banner title={t["detail.approvedBanner"]} tone="info">
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">
                {t["detail.approvedInfo"] || "Müşteri onaylandı bilgilendirmesi gönderilir. Para iadesi tamamlandığında süreci Tamamlandı olarak işaretleyin."}
              </Text>
              <InlineStack gap="200">
                <Select
                  label={t["detail.restockDecision"] || "Restock Decision"}
                  options={[
                    { label: t["detail.noRestock"] || "Do not restock", value: "NO_RESTOCK" },
                    { label: t["detail.restock"] || "Restock returned items", value: "RESTOCK" },
                  ]}
                  value={restockDecision}
                  onChange={setRestockDecision}
                />
                <Button
                  onClick={() => submit({ intent: "set_restock_decision", restockDecision }, { method: "post" })}
                  loading={isSubmitting}
                >
                  {t["detail.saveRestockDecision"] || "Save decision"}
                </Button>
                <Button
                  variant="primary"
                  loading={isSubmitting}
                  onClick={() => submit({ intent: "complete" }, { method: "post" })}
                >
                  {t["detail.markComplete"]}
                </Button>
              </InlineStack>
            </BlockStack>
          </Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t["detail.orderInfo"]}</Text>
            <Divider />
            <InlineStack align="space-between">
              <Text as="span" tone="subdued">{t["detail.orderNo"]}</Text>
              <Text as="span" fontWeight="semibold">{r.orderName}</Text>
            </InlineStack>
            <InlineStack align="space-between">
              <Text as="span" tone="subdued">{t["detail.customerEmail"]}</Text>
              <Text as="span">{r.customerEmail}</Text>
            </InlineStack>
            <InlineStack align="space-between">
              <Text as="span" tone="subdued">{t["detail.returnDate"]}</Text>
              <Text as="span">{new Date(r.createdAt).toLocaleDateString(dateFmt)}</Text>
            </InlineStack>
            <InlineStack align="space-between">
              <Text as="span" tone="subdued">{t["detail.returnReason"]}</Text>
              <Text as="span">{r.reason ? translateReason(r.reason, t) : "—"}</Text>
            </InlineStack>
            {r.shopifyReturnId && (
              <InlineStack align="space-between">
                <Text as="span" tone="subdued">{t["detail.shopifyReturnId"]}</Text>
                <Text as="span" variant="bodySm">{r.shopifyReturnId}</Text>
              </InlineStack>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t["detail.returnedItems"]}</Text>
            <Divider />
            {r.items.map((item: any) => (
              <InlineStack key={item.id} align="space-between">
                <BlockStack gap="100">
                  <Text as="span" fontWeight="semibold">{item.title}</Text>
                  <Text as="span" variant="bodySm" tone="subdued">{t["detail.qty"]}: {item.quantity}</Text>
                </BlockStack>
                <Text as="span">{(parseFloat(item.price) * item.quantity).toFixed(2)}</Text>
              </InlineStack>
            ))}
            <Divider />
            <InlineStack align="space-between">
              <Text as="span" fontWeight="bold">{t["detail.total"]}</Text>
              <Text as="span" fontWeight="bold">{totalAmount.toFixed(2)}</Text>
            </InlineStack>
          </BlockStack>
        </Card>

        {r.resolution && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">{t["detail.resolutionSection"]}</Text>
              <Divider />
              <InlineStack align="space-between">
                <Text as="span" tone="subdued">{t["detail.type"]}</Text>
                <Text as="span" fontWeight="semibold">{t[`resolution.${r.resolution.type}`] || r.resolution.type}</Text>
              </InlineStack>
              {r.resolution.amount && (
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">{t["detail.amount"]}</Text>
                  <Text as="span">{parseFloat(r.resolution.amount).toFixed(2)} {r.resolution.currency}</Text>
                </InlineStack>
              )}
              {r.resolution.priceDifference && (
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">{t["detail.priceDifference"]}</Text>
                  <Text as="span">{parseFloat(r.resolution.priceDifference).toFixed(2)} {r.resolution.currency}</Text>
                </InlineStack>
              )}
              {r.resolution.discountCode && (
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">{t["detail.discountCode"]}</Text>
                  <Text as="span" fontWeight="semibold">{r.resolution.discountCode}</Text>
                </InlineStack>
              )}
              {r.resolution.paymentLinkUrl && (
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="span" tone="subdued">{t["detail.paymentLink"]}</Text>
                  <Button
                    url={r.resolution.paymentLinkUrl}
                    target="_blank"
                  >
                    {t["detail.paymentLink"]}
                  </Button>
                </InlineStack>
              )}
            </BlockStack>
          </Card>
        )}

        {r.shippingLabel && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">{t["detail.shippingLabel"]}</Text>
              <Divider />
              <InlineStack align="space-between">
                <Text as="span" tone="subdued">{t["detail.labelStatus"]}</Text>
                <Badge>{r.shippingLabel.status}</Badge>
              </InlineStack>
              {r.shippingLabel.trackingNumber && (
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">{t["detail.trackingNo"]}</Text>
                  <Text as="span">{r.shippingLabel.trackingNumber}</Text>
                </InlineStack>
              )}
              {r.shippingLabel.carrier && (
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">{t["detail.carrier"]}</Text>
                  <Text as="span">{r.shippingLabel.carrier}</Text>
                </InlineStack>
              )}
              <Button
                loading={isSubmitting}
                onClick={() => submit({ intent: "refresh_label_status" }, { method: "post" })}
              >
                {t["detail.refreshLabelStatus"] || "Refresh label status"}
              </Button>
            </BlockStack>
          </Card>
        )}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t["detail.internalNote"] || "İade notları ve iç yorumlar"}</Text>
            <Divider />
            <TextField
              label={t["detail.internalNote"] || "İç Not"}
              multiline={4}
              value={internalNote}
              onChange={setInternalNote}
              autoComplete="off"
            />
            <Button
              onClick={() => submit({ intent: "save_internal_note", internalNote }, { method: "post" })}
              loading={isSubmitting}
            >
              {t["detail.saveInternalNote"] || "Notu kaydet"}
            </Button>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t["detail.customerMessageTitle"] || "Müşteriye mesaj"}</Text>
            <Divider />
            <TextField
              label={t["detail.customerMessage"] || "Mesaj"}
              multiline={4}
              value={customerMessage}
              onChange={setCustomerMessage}
              autoComplete="off"
            />
            {r.customerMessageSentAt && (
              <Text as="p" variant="bodySm" tone="subdued">
                {`${t["detail.lastMessageSentAt"] || "Son gönderim"}: ${new Date(r.customerMessageSentAt).toLocaleString(dateFmt)}`}
              </Text>
            )}
            <Button
              variant="primary"
              onClick={() => submit({ intent: "send_customer_message", customerMessage }, { method: "post" })}
              loading={isSubmitting}
            >
              {t["detail.sendCustomerMessage"] || "Mesajı gönderildi olarak işaretle"}
            </Button>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">{t["detail.inventorySync"] || "Inventory Sync"}</Text>
            <Divider />
            <InlineStack align="space-between">
              <Text as="span" tone="subdued">{t["detail.restockDecision"] || "Restock decision"}</Text>
              <Badge>{r.restockDecision}</Badge>
            </InlineStack>
            <InlineStack align="space-between">
              <Text as="span" tone="subdued">{t["detail.stockSyncStatus"] || "Stock sync status"}</Text>
              <Badge>{r.stockSyncStatus}</Badge>
            </InlineStack>
            {r.stockSyncedAt && (
              <InlineStack align="space-between">
                <Text as="span" tone="subdued">{t["detail.stockSyncedAt"] || "Synced at"}</Text>
                <Text as="span">{new Date(r.stockSyncedAt).toLocaleString(dateFmt)}</Text>
              </InlineStack>
            )}
            {r.stockSyncError && <Banner tone="warning">{r.stockSyncError}</Banner>}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t["detail.auditTimeline"] || "Operasyon Zaman Tüneli"}</Text>
            <Divider />
            {actionLogs.length > 0 ? (
              <BlockStack gap="200">
                {actionLogs.map((log: any) => (
                  <Card key={log.id}>
                    <BlockStack gap="100">
                      <InlineStack align="space-between">
                        <Text as="span" fontWeight="semibold">{log.action}</Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {new Date(log.createdAt).toLocaleString(dateFmt)}
                        </Text>
                      </InlineStack>
                      {log.actor && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {`${t["detail.actor"] || "Aktör"}: ${log.actor}`}
                        </Text>
                      )}
                      {log.note && (
                        <Text as="p" variant="bodySm">{log.note}</Text>
                      )}
                    </BlockStack>
                  </Card>
                ))}
              </BlockStack>
            ) : (
              <Text as="p" tone="subdued">{t["detail.noAuditData"] || "Henüz işlem geçmişi yok."}</Text>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
