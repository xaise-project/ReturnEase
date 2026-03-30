import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams, useSubmit, useNavigation, useActionData, useOutletContext } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  IndexTable,
  Text,
  Badge,
  Filters,
  ChoiceList,
  Pagination,
  EmptyState,
  BlockStack,
  InlineStack,
  Banner,
  Button,
  TextField,
  ButtonGroup,
  Select,
  useIndexResourceState,
  Autocomplete,
  Modal,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import type { Locale } from "../services/i18n-admin";
import { translateReason } from "../services/i18n-admin";
import { dispatchReturnNotifications } from "../services/notifications.server";

const PAGE_SIZE = 20;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  const status = url.searchParams.get("status") || "";
  const resolutionType = url.searchParams.get("type") || "";
  const search = url.searchParams.get("search") || "";
  const page = parseInt(url.searchParams.get("page") || "1");
  const sortBy = url.searchParams.get("sortBy") || "createdAt";
  const sortOrder = url.searchParams.get("sortOrder") || "desc";

  const where: any = { shop: session.shop };
  if (status) where.status = status;
  if (resolutionType) where.resolution = { type: resolutionType };
  if (search) {
    where.OR = [
      { orderName: { contains: search, mode: "insensitive" } },
      { customerEmail: { contains: search, mode: "insensitive" } },
    ];
  }

  // Build orderBy clause based on sort parameters
  const orderBy: any = {};
  switch (sortBy) {
    case "orderName":
      orderBy.orderName = sortOrder;
      break;
    case "customerEmail":
      orderBy.customerEmail = sortOrder;
      break;
    case "status":
      orderBy.status = sortOrder;
      break;
    case "reason":
      orderBy.reason = sortOrder;
      break;
    case "resolution":
      orderBy.resolution = { type: sortOrder };
      break;
    case "itemsCount":
      // For items count, we'll sort by the number of items
      orderBy.items = { _count: sortOrder };
      break;
    case "createdAt":
    default:
      orderBy.createdAt = sortOrder;
      break;
  }

  const [returns, total] = await Promise.all([
    prisma.returnRequest.findMany({
      where,
      include: { items: true, resolution: true },
      orderBy,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.returnRequest.count({ where }),
  ]);

  let manualCustomers: Array<{ value: string; label: string }> = [];
  let manualOrders: Array<{
    value: string;
    label: string;
    email: string;
    items: Array<{
      value: string;
      label: string;
      productId: string;
      variantId: string;
      quantity: number;
      price: string;
      selectable: boolean;
    }>;
  }> = [];

  try {
    const response = await admin.graphql(
      `#graphql
        query adminManualReturnData {
          customers(first: 50, reverse: true) {
            edges {
              node {
                email
                firstName
                lastName
              }
            }
          }
          orders(first: 50, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id
                name
                email
                lineItems(first: 50) {
                  edges {
                    node {
                      id
                      name
                      quantity
                      variant {
                        id
                      }
                      product {
                        id
                      }
                      originalUnitPriceSet {
                        shopMoney {
                          amount
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
    );
    const data = await response.json();
    const completed = await prisma.returnRequest.findMany({
      where: { shop: session.shop, status: "COMPLETED" },
      include: { items: true },
    });
    const pending = await prisma.returnRequest.findMany({
      where: { shop: session.shop, status: "REQUESTED" },
      include: { items: true },
    });
    const completedVariantKeys = new Set<string>();
    const completedProductKeys = new Set<string>();
    for (const ret of completed) {
      for (const item of ret.items) {
        if (ret.orderId && item.variantId && item.variantId !== "manual") {
          completedVariantKeys.add(`${ret.orderId}::${item.variantId}`);
        }
        if (ret.orderId && item.productId && item.productId !== "manual") {
          completedProductKeys.add(`${ret.orderId}::${item.productId}`);
        }
      }
    }
    for (const ret of pending) {
      for (const item of ret.items) {
        if (ret.orderId && item.variantId && item.variantId !== "manual") {
          completedVariantKeys.add(`${ret.orderId}::${item.variantId}`);
        }
        if (ret.orderId && item.productId && item.productId !== "manual") {
          completedProductKeys.add(`${ret.orderId}::${item.productId}`);
        }
      }
    }

    manualCustomers = (data.data?.customers?.edges || [])
      .map((edge: any) => edge.node)
      .filter((node: any) => node?.email)
      .map((node: any) => ({
        value: node.email,
        label: `${[node.firstName, node.lastName].filter(Boolean).join(" ").trim() || node.email} (${node.email})`,
      }));
    manualOrders = (data.data?.orders?.edges || [])
      .map((edge: any) => edge.node)
      .filter((node: any) => node?.name)
      .map((node: any) => ({
        value: node.id,
        label: node.name,
        email: node.email || "",
        items: (node.lineItems?.edges || [])
          .map((itemEdge: any) => itemEdge.node)
          .filter((li: any) => li?.variant?.id && li?.product?.id)
          .map((li: any) => {
            const variantId = li.variant.id;
            const productId = li.product.id;
            const isCompletedByVariant = completedVariantKeys.has(`${node.id}::${variantId}`);
            const isCompletedByProduct = completedProductKeys.has(`${node.id}::${productId}`);
            return {
              value: li.id,
              label: li.name,
              productId,
              variantId,
              quantity: Number(li.quantity || 1),
              price: String(li.originalUnitPriceSet?.shopMoney?.amount || "0"),
              selectable: !(isCompletedByVariant || isCompletedByProduct),
            };
          }),
      }));
  } catch (e) {
    manualCustomers = [];
    manualOrders = [];
  }

  return {
    returns: returns.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      items: r.items.map((i) => ({ ...i, price: i.price.toString() })),
      resolution: r.resolution
        ? { ...r.resolution, amount: r.resolution.amount?.toString(), createdAt: r.resolution.createdAt.toISOString() }
        : null,
    })),
    total,
    page,
    totalPages: Math.ceil(total / PAGE_SIZE),
    manualCustomers,
    manualOrders,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const actor = `admin:${session.shop}`;

  async function logReturnAction(
    returnRequestId: string,
    action: string,
    metadata?: Record<string, any>,
    note?: string,
  ) {
    await prisma.returnActionLog.create({
      data: {
        shop: session.shop,
        returnRequestId,
        action,
        actor,
        note: note || null,
        metadata: metadata || undefined,
      },
    });
  }

  async function fetchRemoteReturnStatus(shopifyReturnId: string) {
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
        { variables: { id: shopifyReturnId } },
      );
      const data = await response.json();
      return String(data.data?.return?.status || "");
    } catch {
      return "";
    }
  }

  async function finalizePending(returnId: string) {
    const record = await prisma.returnRequest.findFirst({
      where: { id: returnId, shop: session.shop },
      include: { resolution: true },
    });
    if (!record) return { ok: false, error: "Return not found" };
    if (record.status !== "REQUESTED") return { ok: false, error: "Return is not pending" };

    if (!record.shopifyReturnId) {
      await prisma.returnRequest.update({
        where: { id: returnId },
        data: { status: "COMPLETED" },
      });
      await logReturnAction(returnId, "FINALIZE_PENDING", { source: "local_only" });
      await dispatchReturnNotifications({
        shop: session.shop,
        event: "RETURN_COMPLETED",
        returnRequest: {
          id: returnId,
          orderName: record.orderName,
          customerEmail: record.customerEmail,
          reason: record.reason,
          status: "COMPLETED",
          resolutionType: record.resolution?.type || null,
        },
      });
      return { ok: true };
    }

    const remoteStatus = await fetchRemoteReturnStatus(record.shopifyReturnId);
    if (remoteStatus && remoteStatus !== "REQUESTED") {
      if (["APPROVED", "CLOSED"].includes(remoteStatus)) {
        await prisma.returnRequest.update({
          where: { id: returnId },
          data: { status: "COMPLETED" },
        });
        await logReturnAction(returnId, "FINALIZE_PENDING", { source: "remote_reconciled", remoteStatus });
        await dispatchReturnNotifications({
          shop: session.shop,
          event: "RETURN_COMPLETED",
          returnRequest: {
            id: returnId,
            orderName: record.orderName,
            customerEmail: record.customerEmail,
            reason: record.reason,
            status: "COMPLETED",
            resolutionType: record.resolution?.type || null,
          },
        });
        return { ok: true };
      }
      if (["DECLINED", "CANCELLED"].includes(remoteStatus)) {
        await prisma.returnRequest.update({
          where: { id: returnId },
          data: { status: "CANCELLED" },
        });
        await logReturnAction(returnId, "FINALIZE_PENDING_SKIPPED", { source: "remote_reconciled", remoteStatus });
        return { ok: false, error: "Return is not pending" };
      }
    }

    const approveResponse = await admin.graphql(
      `#graphql
        mutation returnApproveRequest($input: ReturnApproveRequestInput!) {
          returnApproveRequest(input: $input) {
            return { id status }
            userErrors { field message }
          }
        }
      `,
      { variables: { input: { id: record.shopifyReturnId } } },
    );
    const approveData = await approveResponse.json();
    const approveErrors = approveData.data?.returnApproveRequest?.userErrors || [];
    const blockingApproveErrors = approveErrors.filter((e: any) => {
      const msg = String(e.message || "").toLowerCase();
      if (msg.includes("already")) return false;
      if (msg.includes("only returns with status requested can be approved")) return false;
      return true;
    });
    if (blockingApproveErrors.length > 0) {
      return { ok: false, error: blockingApproveErrors.map((e: any) => e.message).join(", ") };
    }

    if (approveErrors.length > 0 && blockingApproveErrors.length === 0) {
      const reconciledStatus = await fetchRemoteReturnStatus(record.shopifyReturnId);
      if (["APPROVED", "CLOSED"].includes(reconciledStatus)) {
        await prisma.returnRequest.update({
          where: { id: returnId },
          data: { status: "COMPLETED" },
        });
        await logReturnAction(returnId, "FINALIZE_PENDING", { source: "approve_reconciled", remoteStatus: reconciledStatus });
        return { ok: true };
      }
      if (["DECLINED", "CANCELLED"].includes(reconciledStatus)) {
        await prisma.returnRequest.update({
          where: { id: returnId },
          data: { status: "CANCELLED" },
        });
        await logReturnAction(returnId, "FINALIZE_PENDING_SKIPPED", { source: "approve_reconciled", remoteStatus: reconciledStatus });
        return { ok: false, error: "Return is not pending" };
      }
    }

    if (record.resolution?.type === "REFUND") {
      await admin.graphql(
        `#graphql
          mutation returnClose($id: ID!) {
            returnClose(id: $id) {
              return { id status }
              userErrors { field message }
            }
          }
        `,
        { variables: { id: record.shopifyReturnId } },
      );
    }

    await prisma.returnRequest.update({
      where: { id: returnId },
      data: { status: "COMPLETED" },
    });
    await logReturnAction(returnId, "FINALIZE_PENDING", { source: "approved_and_closed" });
    await dispatchReturnNotifications({
      shop: session.shop,
      event: "RETURN_COMPLETED",
      returnRequest: {
        id: returnId,
        orderName: record.orderName,
        customerEmail: record.customerEmail,
        reason: record.reason,
        status: "COMPLETED",
        resolutionType: record.resolution?.type || null,
      },
    });
    return { ok: true };
  }

  async function cancelPending(returnId: string) {
    const record = await prisma.returnRequest.findFirst({
      where: { id: returnId, shop: session.shop },
    });
    if (!record) return { ok: false, error: "Return not found" };
    if (record.status !== "REQUESTED") return { ok: false, error: "Return is not pending" };

    if (record.shopifyReturnId) {
      const response = await admin.graphql(
        `#graphql
          mutation returnDeclineRequest($input: ReturnDeclineRequestInput!) {
            returnDeclineRequest(input: $input) {
              return { id status }
              userErrors { field message }
            }
          }
        `,
        { variables: { input: { id: record.shopifyReturnId, declineReason: "OTHER" } } },
      );
      const data = await response.json();
      const userErrors = data.data?.returnDeclineRequest?.userErrors || [];
      if (userErrors.length > 0) {
        return { ok: false, error: userErrors.map((e: any) => e.message).join(", ") };
      }
    }
    await prisma.returnRequest.update({
      where: { id: returnId },
      data: { status: "CANCELLED" },
    });
    await logReturnAction(returnId, "CANCEL_PENDING", { source: "bulk_or_list" });
    await dispatchReturnNotifications({
      shop: session.shop,
      event: "RETURN_CANCELLED",
      returnRequest: {
        id: returnId,
        orderName: record.orderName,
        customerEmail: record.customerEmail,
        reason: record.reason,
        status: "CANCELLED",
        resolutionType: null,
      },
    });
    return { ok: true };
  }

  async function declinePending(returnId: string) {
    const record = await prisma.returnRequest.findFirst({
      where: { id: returnId, shop: session.shop },
      include: { resolution: true },
    });
    if (!record) return { ok: false, error: "Return not found" };
    if (record.status !== "REQUESTED") return { ok: false, error: "Return is not pending" };

    if (!record.shopifyReturnId) {
      await prisma.returnRequest.update({
        where: { id: returnId },
        data: { status: "DECLINED" },
      });
      await logReturnAction(returnId, "DECLINE_PENDING", { source: "local_only" });
      await dispatchReturnNotifications({
        shop: session.shop,
        event: "RETURN_DECLINED",
        returnRequest: {
          id: returnId,
          orderName: record.orderName,
          customerEmail: record.customerEmail,
          reason: record.reason,
          status: "DECLINED",
          resolutionType: record.resolution?.type || null,
        },
      });
      return { ok: true };
    }

    const remoteStatus = await fetchRemoteReturnStatus(record.shopifyReturnId);
    if (["DECLINED", "CANCELLED"].includes(remoteStatus)) {
      await prisma.returnRequest.update({ where: { id: returnId }, data: { status: "DECLINED" } });
      await logReturnAction(returnId, "DECLINE_PENDING", { source: "remote_reconciled", remoteStatus });
      return { ok: true };
    }
    if (remoteStatus === "CLOSED") {
      await prisma.returnRequest.update({ where: { id: returnId }, data: { status: "COMPLETED" } });
      await logReturnAction(returnId, "DECLINE_PENDING_SKIPPED", { source: "remote_reconciled", remoteStatus });
      return { ok: true };
    }
    if (remoteStatus === "APPROVED") {
      await prisma.returnRequest.update({ where: { id: returnId }, data: { status: "APPROVED" } });
      await logReturnAction(returnId, "DECLINE_PENDING_SKIPPED", { source: "remote_reconciled", remoteStatus });
      return { ok: true };
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
      { variables: { input: { id: record.shopifyReturnId, declineReason: "OTHER" } } },
    );
    const data = await response.json();
    const userErrors = data.data?.returnDeclineRequest?.userErrors || [];
    const blockingErrors = userErrors.filter((e: any) => {
      const msg = String(e.message || "").toLowerCase();
      if (msg.includes("already")) return false;
      if (msg.includes("not declinable")) return false;
      if (msg.includes("only non-refunded returns with status requested can be declined")) return false;
      return true;
    });
    if (blockingErrors.length > 0) {
      return { ok: false, error: blockingErrors.map((e: any) => e.message).join(", ") };
    }

    const reconciledStatus = await fetchRemoteReturnStatus(record.shopifyReturnId);
    const nextStatus = reconciledStatus === "CLOSED"
      ? "COMPLETED"
      : reconciledStatus === "APPROVED"
        ? "APPROVED"
        : "DECLINED";
    await prisma.returnRequest.update({
      where: { id: returnId },
      data: { status: nextStatus },
    });
    await logReturnAction(returnId, "DECLINE_PENDING", { source: "decline_mutation", remoteStatus: reconciledStatus || "UNKNOWN" });
    if (nextStatus === "DECLINED") {
      await dispatchReturnNotifications({
        shop: session.shop,
        event: "RETURN_DECLINED",
        returnRequest: {
          id: returnId,
          orderName: record.orderName,
          customerEmail: record.customerEmail,
          reason: record.reason,
          status: "DECLINED",
          resolutionType: record.resolution?.type || null,
        },
      });
    }
    return { ok: true };
  }

  async function approvePending(returnId: string) {
    const record = await prisma.returnRequest.findFirst({
      where: { id: returnId, shop: session.shop },
      include: { resolution: true },
    });
    if (!record) return { ok: false, error: "Return not found" };
    if (record.status !== "REQUESTED") return { ok: false, error: "Return is not pending" };

    if (!record.shopifyReturnId) {
      await prisma.returnRequest.update({
        where: { id: returnId },
        data: { status: "APPROVED" },
      });
      await logReturnAction(returnId, "APPROVE_PENDING", { source: "local_only" });
      await dispatchReturnNotifications({
        shop: session.shop,
        event: "RETURN_APPROVED",
        returnRequest: {
          id: returnId,
          orderName: record.orderName,
          customerEmail: record.customerEmail,
          reason: record.reason,
          status: "APPROVED",
          resolutionType: record.resolution?.type || null,
        },
      });
      return { ok: true, status: "APPROVED" as const };
    }

    const remoteStatus = await fetchRemoteReturnStatus(record.shopifyReturnId);
    if (remoteStatus === "APPROVED") {
      await prisma.returnRequest.update({ where: { id: returnId }, data: { status: "APPROVED" } });
      await logReturnAction(returnId, "APPROVE_PENDING", { source: "remote_reconciled", remoteStatus });
      return { ok: true, status: "APPROVED" as const };
    }
    if (remoteStatus === "CLOSED") {
      await prisma.returnRequest.update({ where: { id: returnId }, data: { status: "COMPLETED" } });
      await logReturnAction(returnId, "APPROVE_PENDING_SKIPPED", { source: "remote_reconciled", remoteStatus });
      return { ok: true, status: "COMPLETED" as const };
    }
    if (["DECLINED", "CANCELLED"].includes(remoteStatus)) {
      await prisma.returnRequest.update({ where: { id: returnId }, data: { status: "DECLINED" } });
      await logReturnAction(returnId, "APPROVE_PENDING_SKIPPED", { source: "remote_reconciled", remoteStatus });
      return { ok: true, status: "DECLINED" as const };
    }

    if (record.shopifyReturnId) {
      const response = await admin.graphql(
        `#graphql
          mutation returnApproveRequest($input: ReturnApproveRequestInput!) {
            returnApproveRequest(input: $input) {
              return { id status }
              userErrors { field message }
            }
          }
        `,
        { variables: { input: { id: record.shopifyReturnId } } },
      );
      const data = await response.json();
      const userErrors = data.data?.returnApproveRequest?.userErrors || [];
      const blockingErrors = userErrors.filter((e: any) => {
        const msg = String(e.message || "").toLowerCase();
        if (msg.includes("already")) return false;
        if (msg.includes("not approvable")) return false;
        if (msg.includes("only returns with status requested can be approved")) return false;
        return true;
      });
      if (blockingErrors.length > 0) {
        return { ok: false, error: blockingErrors.map((e: any) => e.message).join(", ") };
      }

      const reconciledStatus = await fetchRemoteReturnStatus(record.shopifyReturnId);
      if (reconciledStatus === "CLOSED") {
        await prisma.returnRequest.update({ where: { id: returnId }, data: { status: "COMPLETED" } });
        await logReturnAction(returnId, "APPROVE_PENDING", { source: "approve_mutation", remoteStatus: reconciledStatus });
        return { ok: true, status: "COMPLETED" as const };
      }
      if (["DECLINED", "CANCELLED"].includes(reconciledStatus)) {
        await prisma.returnRequest.update({ where: { id: returnId }, data: { status: "DECLINED" } });
        await logReturnAction(returnId, "APPROVE_PENDING_SKIPPED", { source: "approve_mutation", remoteStatus: reconciledStatus });
        return { ok: true, status: "DECLINED" as const };
      }
    }

    await prisma.returnRequest.update({
      where: { id: returnId },
      data: { status: "APPROVED" },
    });
    await logReturnAction(returnId, "APPROVE_PENDING", { source: "quick_modal" });
    await dispatchReturnNotifications({
      shop: session.shop,
      event: "RETURN_APPROVED",
      returnRequest: {
        id: returnId,
        orderName: record.orderName,
        customerEmail: record.customerEmail,
        reason: record.reason,
        status: "APPROVED",
        resolutionType: record.resolution?.type || null,
      },
    });
    return { ok: true, status: "APPROVED" as const };
  }

  async function completeApproved(returnId: string, completionMode: "REFUND_DONE" | "ITEM_RESENT") {
    const record = await prisma.returnRequest.findFirst({
      where: { id: returnId, shop: session.shop },
      include: { resolution: true },
    });
    if (!record) return { ok: false, error: "Return not found" };
    if (record.status !== "APPROVED") return { ok: false, error: "Return is not approved" };

    if (record.resolution?.type === "REFUND" && record.shopifyReturnId) {
      await admin.graphql(
        `#graphql
          mutation returnClose($id: ID!) {
            returnClose(id: $id) {
              return { id status }
              userErrors { field message }
            }
          }
        `,
        { variables: { id: record.shopifyReturnId } },
      );
    }

    await prisma.returnRequest.update({
      where: { id: returnId },
      data: { status: "COMPLETED" },
    });
    await logReturnAction(returnId, "COMPLETE_APPROVED", { source: "quick_modal", completionMode });
    await dispatchReturnNotifications({
      shop: session.shop,
      event: "RETURN_COMPLETED",
      returnRequest: {
        id: returnId,
        orderName: record.orderName,
        customerEmail: record.customerEmail,
        reason: record.reason,
        status: "COMPLETED",
        resolutionType: record.resolution?.type || null,
      },
    });
    return { ok: true };
  }

  if (intent === "sync") {
    // Fetch orders with returns from Shopify
    let synced = 0;
    try {
      const response = await admin.graphql(
        `#graphql
          query getOrdersWithReturns {
            orders(first: 20, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  id
                  name
                  email
                  returns(first: 5) {
                    edges {
                      node {
                        id
                        status
                        name
                        returnLineItems(first: 10) {
                          edges {
                            node {
                              ... on ReturnLineItem {
                                id
                                quantity
                                returnReason
                                returnReasonNote
                                fulfillmentLineItem {
                                  lineItem {
                                    title
                                    product { id }
                                    variant { price }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `,
      );

      const data = await response.json();
      const orders = data.data?.orders?.edges || [];

      const statusMap: Record<string, string> = {
        OPEN: "REQUESTED",
        REQUESTED: "REQUESTED",
        APPROVED: "APPROVED",
        DECLINED: "DECLINED",
        CLOSED: "COMPLETED",
        CANCELLED: "CANCELLED",
      };

      for (const orderEdge of orders) {
        const order = orderEdge.node;
        const returns = order.returns?.edges || [];

        for (const retEdge of returns) {
          const ret = retEdge.node;

          const lineItems = ret.returnLineItems?.edges?.map((e: any) => e.node) || [];
          const reason = lineItems[0]?.returnReason || "OTHER";
          const reasonNote = lineItems[0]?.returnReasonNote || "";
          const fullReason = reasonNote ? `${reason}: ${reasonNote}` : reason;

          const mappedStatus = (statusMap[ret.status] || "REQUESTED") as any;
          const existing = await prisma.returnRequest.findFirst({
            where: { shop: session.shop, shopifyReturnId: ret.id },
          });
          if (existing) {
            const nextData: any = {};
            if (existing.status !== mappedStatus) nextData.status = mappedStatus;
            if (!existing.reason && fullReason) nextData.reason = fullReason;
            if (!existing.customerEmail && order.email) nextData.customerEmail = order.email;
            if (existing.orderName !== (order.name || ret.name || "—")) {
              nextData.orderName = order.name || ret.name || "—";
            }

            if (Object.keys(nextData).length > 0) {
              await prisma.returnRequest.update({
                where: { id: existing.id },
                data: nextData,
              });
              synced++;
            }
            continue;
          }

          const items = lineItems.map((li: any) => ({
            productId: li.fulfillmentLineItem?.lineItem?.product?.id || "",
            variantId: "",
            title: li.fulfillmentLineItem?.lineItem?.title || "Unknown",
            quantity: li.quantity || 1,
            price: parseFloat(li.fulfillmentLineItem?.lineItem?.variant?.price || "0"),
          }));

          if (items.length === 0) continue;

          await prisma.returnRequest.create({
            data: {
              shop: session.shop,
              shopifyReturnId: ret.id,
              orderId: order.id,
              orderName: order.name || ret.name || "—",
              customerEmail: order.email || "",
              reason: fullReason,
              status: mappedStatus,
              items: { create: items },
              resolution: { create: { type: "REFUND" } },
            },
          });
          synced++;
        }
      }
    } catch (error: any) {
      console.error("Sync error:", error.message);
      return json({ syncError: error.message });
    }

    return json({ synced });
  }

  if (intent === "bulk_pending_action") {
    const ids = JSON.parse((formData.get("ids") as string) || "[]");
    const bulkAction = (formData.get("bulkAction") as string) || "";
    if (!Array.isArray(ids) || ids.length === 0) return json({ bulkError: "No return selected" });
    if (!["finalize", "cancel"].includes(bulkAction)) return json({ bulkError: "Invalid action" });

    let success = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try {
        const result = bulkAction === "finalize" ? await finalizePending(id) : await cancelPending(id);
        if (result.ok) {
          success++;
        } else if (String(result.error).includes("not pending")) {
          skipped++;
        } else {
          errors.push(`${id}: ${result.error}`);
        }
      } catch (e: any) {
        errors.push(`${id}: ${e.message}`);
      }
    }
    return json({
      bulkSuccess: success,
      bulkSkipped: skipped,
      bulkError: errors.length > 0 ? errors.slice(0, 3).join(" | ") : null,
    });
  }

  if (intent === "quick_approve") {
    const id = (formData.get("id") as string) || "";
    const result = await approvePending(id);
    if (!result.ok) return json({ quickError: result.error });
    const success = result.status === "COMPLETED" ? "completed" : result.status === "DECLINED" ? "declined" : "approved";
    return json({ quickSuccess: success });
  }

  if (intent === "quick_decline") {
    const id = (formData.get("id") as string) || "";
    const result = await declinePending(id);
    if (!result.ok) return json({ quickError: result.error });
    return json({ quickSuccess: "declined" });
  }

  if (intent === "quick_complete") {
    const id = (formData.get("id") as string) || "";
    const completionMode = ((formData.get("completionMode") as string) || "REFUND_DONE") as "REFUND_DONE" | "ITEM_RESENT";
    const result = await completeApproved(id, completionMode);
    if (!result.ok) return json({ quickError: result.error });
    return json({ quickSuccess: "completed" });
  }

  if (intent === "manual_create") {
    const orderName = (formData.get("orderName") as string)?.trim();
    const orderId = (formData.get("orderId") as string)?.trim();
    const customerEmail = (formData.get("customerEmail") as string)?.trim();
    const adminReason = (formData.get("adminReason") as string)?.trim();
    const notifyCustomer = formData.get("notifyCustomer") === "true";
    const emailSubject = (formData.get("emailSubject") as string)?.trim();
    const emailBody = (formData.get("emailBody") as string)?.trim();
    
    if (!adminReason) {
      return json({ manualError: "Yönetici iade nedeni seçmelisiniz." });
    }
    
    const reason = `ADMIN: ${adminReason}`;
    const resolutionType = (formData.get("resolutionType") as string) || "REFUND";
    const itemTitle = (formData.get("itemTitle") as string)?.trim() || "Manual item";
    const productId = (formData.get("productId") as string)?.trim() || "manual";
    const variantId = (formData.get("variantId") as string)?.trim() || "manual";
    const quantity = Math.max(1, parseInt((formData.get("quantity") as string) || "1", 10) || 1);
    const price = parseFloat((formData.get("price") as string) || "0");

    if (!orderId || !orderName || !customerEmail || !Number.isFinite(price) || !productId || productId === "manual" || !variantId || variantId === "manual") {
      return json({ manualError: "Sipariş ve sipariş ürünü seçimi zorunludur." });
    }

    const existingPending = await prisma.returnRequest.findFirst({
      where: {
        shop: session.shop,
        orderId,
        status: "REQUESTED",
        items: {
          some: {
            OR: [{ variantId }, { productId }],
          },
        },
      },
    });
    if (existingPending) {
      return json({ manualError: "Bu ürün için bekleyen bir iade talebi zaten var." });
    }

    const created = await prisma.returnRequest.create({
      data: {
        shop: session.shop,
        orderId: orderId || `manual:${Date.now()}`,
        orderName,
        customerEmail,
        reason,
        status: "REQUESTED",
        isManual: true,
        items: {
          create: [{
            productId,
            variantId,
            title: itemTitle,
            quantity,
            price,
          }],
        },
        resolution: { create: { type: resolutionType as any, amount: quantity * price, currency: "TRY" } },
      },
    });
    await logReturnAction(created.id, "MANUAL_CREATE", {
      orderId,
      resolutionType,
      quantity,
      price,
      productId,
      variantId,
    });
    await dispatchReturnNotifications({
      shop: session.shop,
      event: "RETURN_RECEIVED",
      returnRequest: {
        id: created.id,
        orderName: created.orderName,
        customerEmail: created.customerEmail,
        reason: created.reason,
        status: created.status,
        resolutionType,
        amount: quantity * price,
      },
    });

    // Send admin-specific email notification if requested
    let emailSent = false;
    let emailErrorMsg = "";
    
    if (notifyCustomer && customerEmail && emailBody) {
      // First check if email settings are configured
      const settings = await prisma.storeSettings.findUnique({ where: { shop: session.shop } });
      if (!settings?.resendApiKey || !settings?.emailFrom) {
        emailErrorMsg = "E-posta ayarları (Resend API Key ve Gönderen E-posta) eksik olduğu için müşteriye bildirim gönderilemedi. Lütfen ayarları kontrol edin.";
      } else {
        try {
          // Send email notification
          await dispatchReturnNotifications({
            shop: session.shop,
            event: "CUSTOM_EMAIL",
            returnRequest: {
              id: created.id,
              orderName: created.orderName,
              customerEmail: created.customerEmail,
              reason: created.reason,
              status: created.status,
              resolutionType,
              amount: quantity * price,
              customSubject: emailSubject || "İade İşleminiz Hakkında",
              customMessage: emailBody,
            },
          });
          emailSent = true;
        } catch (emailError: any) {
          console.error("Failed to send admin email notification:", emailError);
          emailErrorMsg = `E-posta gönderimi başarısız oldu: ${emailError.message}`;
        }
      }
    }

    return json({ 
      manualCreatedId: created.id,
      emailWarning: emailErrorMsg || undefined
    });
  }

  return json({});
};

export default function Returns() {
  const { returns, total, page, totalPages, manualCustomers, manualOrders } = useLoaderData<typeof loader>();
  const actionData = useActionData<any>();
  const navigate = useNavigate();
  const submit = useSubmit();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { locale, t } = useOutletContext<{ locale: Locale; t: Record<string, string> }>();
  const [manualOrderName, setManualOrderName] = useState("");
  const [manualOrderId, setManualOrderId] = useState("");
  const [manualOrderQuery, setManualOrderQuery] = useState("");
  const [manualOrderItemId, setManualOrderItemId] = useState("");
  const [manualOrderItemQuery, setManualOrderItemQuery] = useState("");
  const [manualCustomerEmail, setManualCustomerEmail] = useState("");
  const [manualCustomerQuery, setManualCustomerQuery] = useState("");
  const [manualReasonList, setManualReasonList] = useState<string[]>([]);
  const [otherReasonText, setOtherReasonText] = useState("");
  const [manualResolutionType, setManualResolutionType] = useState("REFUND");
  const [manualItemTitle, setManualItemTitle] = useState("");
  const [manualProductId, setManualProductId] = useState("manual");
  const [manualVariantId, setManualVariantId] = useState("manual");
  const [manualQuantity, setManualQuantity] = useState("1");
  const [manualPrice, setManualPrice] = useState("0");
  const [manualAdminReason, setManualAdminReason] = useState("");
  const [manualNotifyCustomer, setManualNotifyCustomer] = useState(true);
  const [manualEmailSubject, setManualEmailSubject] = useState("İade İşleminiz Hakkında");
  const [manualEmailBody, setManualEmailBody] = useState("Merhaba,\n\nİade işleminiz başarıyla oluşturulmuştur.");
  const [quickModalOpen, setQuickModalOpen] = useState(false);
  const [quickReturn, setQuickReturn] = useState<any | null>(null);
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<any | null>(null);
  const [sortColumn, setSortColumn] = useState<string>("createdAt");
  const [sortDirection, setSortDirection] = useState<"ascending" | "descending">("descending");

  const isSyncing = navigation.state !== "idle" && navigation.formData?.get("intent") === "sync";
  const isBulkSubmitting = navigation.state !== "idle" && navigation.formData?.get("intent") === "bulk_pending_action";
  const isManualSubmitting = navigation.state !== "idle" && navigation.formData?.get("intent") === "manual_create";
  const isQuickSubmitting = navigation.state !== "idle" && String(navigation.formData?.get("intent") || "").startsWith("quick_");

  const reasonChoices = [
    { label: t["reason.SIZE"] || "SIZE", value: "SIZE" },
    { label: t["reason.COLOR"] || "COLOR", value: "COLOR" },
    { label: t["reason.DEFECTIVE"] || "DEFECTIVE", value: "DEFECTIVE" },
    { label: t["reason.UNWANTED"] || "UNWANTED", value: "UNWANTED" },
    { label: t["reason.OTHER"] || "OTHER", value: "OTHER" },
  ];

  const adminReasonChoices = [
    { label: t["returns.adminReason.OUT_OF_STOCK"] || "Out of Stock", value: "OUT_OF_STOCK" },
    { label: t["returns.adminReason.DAMAGED_INVENTORY"] || "Damaged Inventory", value: "DAMAGED_INVENTORY" },
    { label: t["returns.adminReason.GHOST_INVENTORY"] || "Ghost Inventory", value: "GHOST_INVENTORY" },
    { label: t["returns.adminReason.CUSTOMER_REQUEST"] || "Customer Request", value: "CUSTOMER_REQUEST" },
    { label: t["returns.adminReason.ORDER_ERROR"] || "Order Error", value: "ORDER_ERROR" },
    { label: t["returns.adminReason.QUALITY_ISSUE"] || "Quality Issue", value: "QUALITY_ISSUE" },
  ];

  const orderOptions = manualOrders
    .filter((o) => o.items.some((item) => item.selectable))
    .filter((o) => o.label.toLowerCase().includes(manualOrderQuery.toLowerCase()))
    .slice(0, 20)
    .map((o) => ({ value: o.value, label: `${o.label}${o.email ? ` • ${o.email}` : ""}` }));
  const customerOptions = manualCustomers
    .filter((c) => c.label.toLowerCase().includes(manualCustomerQuery.toLowerCase()) || c.value.toLowerCase().includes(manualCustomerQuery.toLowerCase()))
    .slice(0, 20);
  const selectedOrder = manualOrders.find((o) => o.value === manualOrderId);
  const orderItemOptions = (selectedOrder?.items || [])
    .filter((item) => item.selectable && item.label.toLowerCase().includes(manualOrderItemQuery.toLowerCase()))
    .slice(0, 30)
    .map((item) => ({ value: item.value, label: `${item.label} • ${item.quantity} x ${item.price}` }));

  const status = searchParams.get("status") || "";
  const type = searchParams.get("type") || "";
  const search = searchParams.get("search") || "";
  const sortBy = searchParams.get("sortBy") || "createdAt";
  const sortOrder = searchParams.get("sortOrder") || "desc";

  const statusBadge = (s: string) => {
    const tone: Record<string, any> = {
      REQUESTED: "attention", APPROVED: "info", DECLINED: "critical", COMPLETED: "success", CANCELLED: "warning",
    };
    return <Badge tone={tone[s] || "new"}>{t[`status.${s}`] || s}</Badge>;
  };

  const resLabel = (tp: string | null | undefined) =>
    tp ? (t[`resolution.${tp}`] || tp) : "—";

  const updateFilter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(key, value);
    else params.delete(key);
    params.set("page", "1");
    setSearchParams(params);
  };

  const clearFilters = () => setSearchParams({});

  const handleSort = (column: string) => {
    const newSortOrder = sortBy === column && sortOrder === "asc" ? "desc" : "asc";
    const params = new URLSearchParams(searchParams);
    params.set("sortBy", column);
    params.set("sortOrder", newSortOrder);
    setSearchParams(params);
  };

  const openCustomerModal = (returnItem: any) => {
    setSelectedCustomer(returnItem);
    setCustomerModalOpen(true);
  };

  const filters = [
    {
      key: "status",
      label: t["returns.filterStatus"],
      filter: (
        <ChoiceList
          title={t["returns.filterStatus"]}
          titleHidden
          choices={[
            { label: t["status.REQUESTED"], value: "REQUESTED" },
            { label: t["status.APPROVED"], value: "APPROVED" },
            { label: t["status.DECLINED"], value: "DECLINED" },
            { label: t["status.COMPLETED"], value: "COMPLETED" },
            { label: t["status.CANCELLED"], value: "CANCELLED" },
          ]}
          selected={status ? [status] : []}
          onChange={(v) => updateFilter("status", v[0] || "")}
        />
      ),
      shortcut: true,
    },
    {
      key: "type",
      label: t["returns.filterType"],
      filter: (
        <ChoiceList
          title={t["returns.filterType"]}
          titleHidden
          choices={[
            { label: t["resolution.REFUND"], value: "REFUND" },
            { label: t["resolution.EXCHANGE"], value: "EXCHANGE" },
            { label: t["resolution.EXCHANGE_DIFFERENT_PRODUCT"], value: "EXCHANGE_DIFFERENT_PRODUCT" },
            { label: t["resolution.EXCHANGE_WITH_PRICE_DIFF"], value: "EXCHANGE_WITH_PRICE_DIFF" },
            { label: t["resolution.STORE_CREDIT"], value: "STORE_CREDIT" },
            { label: t["resolution.KEEP_IT"], value: "KEEP_IT" },
          ]}
          selected={type ? [type] : []}
          onChange={(v) => updateFilter("type", v[0] || "")}
        />
      ),
      shortcut: true,
    },
  ];

  const appliedFilters = [
    ...(status ? [{ key: "status", label: `${t["returns.filterStatus"]}: ${t[`status.${status}`] || status}`, onRemove: () => updateFilter("status", "") }] : []),
    ...(type ? [{ key: "type", label: `${t["returns.filterType"]}: ${t[`resolution.${type}`] || type}`, onRemove: () => updateFilter("type", "") }] : []),
  ];

  const emptyState = (
    <EmptyState
      heading={t["returns.emptyTitle"]}
      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
    >
      <p>{t["returns.emptyDescription"]}</p>
    </EmptyState>
  );

  const rowMarkup = returns.map((r: any, index: number) => (
    <IndexTable.Row id={r.id} key={r.id} position={index}>
      <IndexTable.Cell>
        <Text variant="bodyMd" fontWeight="bold" as="span">{r.orderName}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{r.customerEmail}</IndexTable.Cell>
      <IndexTable.Cell>{statusBadge(r.status)}</IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd">{translateReason(r.reason || "OTHER", t)}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{resLabel(r.resolution?.type)}</IndexTable.Cell>
      <IndexTable.Cell>{r.items.length} {t["returns.items"]}</IndexTable.Cell>
      <IndexTable.Cell>
        <BlockStack gap="100">
          <Text as="span" variant="bodySm">
            {new Date(r.createdAt).toLocaleDateString(locale === "tr" ? "tr-TR" : "en-US")}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {new Date(r.createdAt).toLocaleTimeString(locale === "tr" ? "tr-TR" : "en-US", {
              hour: '2-digit',
              minute: '2-digit'
            })}
          </Text>
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Button
          size="slim"
          onClick={() => {
            if (r.status === "REQUESTED" || r.status === "APPROVED") {
              setQuickReturn(r);
              setQuickModalOpen(true);
              return;
            }
            openCustomerModal(r);
          }}
        >
          {t["returns.viewDetail"] || "Detay"}
        </Button>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(returns);

  return (
    <Page>
      <TitleBar title={t["returns.title"]} />
      <BlockStack gap="400">
        {/* Sync banner */}
        {actionData?.synced !== undefined && (
          <Banner
            tone={actionData.synced > 0 ? "success" : "info"}
            onDismiss={() => {}}
          >
            {actionData.synced > 0
              ? t["returns.syncSuccess"].replace("{count}", String(actionData.synced))
              : t["returns.syncNone"]}
          </Banner>
        )}
        {actionData?.syncError && (
          <Banner tone="critical" onDismiss={() => {}}>
            Sync error: {actionData.syncError}
          </Banner>
        )}
        {actionData?.bulkSuccess !== undefined && (
          <Banner tone={actionData.bulkError ? "warning" : "success"} onDismiss={() => {}}>
            {`Bulk işlem tamamlandı: ${actionData.bulkSuccess} kayıt güncellendi.`}
            {actionData.bulkSkipped ? ` Bekleyen olmadığı için atlanan: ${actionData.bulkSkipped}` : ""}
            {actionData.bulkError ? ` Hata: ${actionData.bulkError}` : ""}
          </Banner>
        )}
        {actionData?.manualCreatedId && (
          <Banner tone="success" onDismiss={() => {}}>
            <BlockStack gap="100">
              <Text as="p">{`Manuel iade oluşturuldu: ${actionData.manualCreatedId}`}</Text>
              {actionData.emailWarning && (
                <Text as="p" tone="critical">{actionData.emailWarning}</Text>
              )}
            </BlockStack>
          </Banner>
        )}
        {actionData?.manualError && (
          <Banner tone="critical" onDismiss={() => {}}>
            {actionData.manualError}
          </Banner>
        )}
        {actionData?.quickError && (
          <Banner tone="critical" onDismiss={() => {}}>
            {actionData.quickError}
          </Banner>
        )}
        {actionData?.quickSuccess && (
          <Banner tone="success" onDismiss={() => {}}>
            {t[`detail.${actionData.quickSuccess}`] || actionData.quickSuccess}
          </Banner>
        )}

        <InlineStack align="space-between">
          <InlineStack gap="200">
            <Button
              loading={isBulkSubmitting}
              disabled={selectedResources.length === 0}
              onClick={() => {
                const fd = new FormData();
                fd.set("intent", "bulk_pending_action");
                fd.set("ids", JSON.stringify(selectedResources));
                fd.set("bulkAction", "finalize");
                submit(fd, { method: "post" });
                clearSelection();
              }}
            >
              {t["returns.bulkFinalize"] || "Toplu İadeyi Bitir"}
            </Button>
            <Button
              tone="critical"
              loading={isBulkSubmitting}
              disabled={selectedResources.length === 0}
              onClick={() => {
                const fd = new FormData();
                fd.set("intent", "bulk_pending_action");
                fd.set("ids", JSON.stringify(selectedResources));
                fd.set("bulkAction", "cancel");
                submit(fd, { method: "post" });
                clearSelection();
              }}
            >
              {t["returns.bulkCancel"] || "Toplu İptal Et"}
            </Button>
          </InlineStack>
          <Button
            loading={isSyncing}
            onClick={() => {
              const fd = new FormData();
              fd.set("intent", "sync");
              submit(fd, { method: "post" });
            }}
          >
            {isSyncing ? t["returns.syncing"] : t["returns.syncButton"]}
          </Button>
        </InlineStack>

        <Modal
          open={quickModalOpen}
          onClose={() => {
            setQuickModalOpen(false);
            setQuickReturn(null);
          }}
          title={quickReturn ? `${quickReturn.orderName} • ${translateReason(quickReturn.reason || "OTHER", t)}` : (t["returns.quickProcess"] || "Hızlı İşlem")}
          primaryAction={quickReturn?.status === "REQUESTED" ? {
            content: t["detail.approveOnly"] || "Talebi Onayla",
            loading: isQuickSubmitting,
            onAction: () => {
              if (!quickReturn) return;
              const fd = new FormData();
              fd.set("intent", "quick_approve");
              fd.set("id", quickReturn.id);
              submit(fd, { method: "post" });
              setQuickModalOpen(false);
              setQuickReturn(null);
            },
          } : undefined}
          secondaryActions={[
            ...(quickReturn?.status === "REQUESTED"
              ? [{
                  content: t["detail.rejectRequest"] || "Reddet",
                  destructive: true,
                  onAction: () => {
                    if (!quickReturn) return;
                    const fd = new FormData();
                    fd.set("intent", "quick_decline");
                    fd.set("id", quickReturn.id);
                    submit(fd, { method: "post" });
                    setQuickModalOpen(false);
                    setQuickReturn(null);
                  },
                }]
              : []),
            ...(quickReturn?.status === "APPROVED"
              ? [
                  {
                    content: t["returns.refundComplete"] || "Ücreti İade Et ve Tamamla",
                    onAction: () => {
                      if (!quickReturn) return;
                      const fd = new FormData();
                      fd.set("intent", "quick_complete");
                      fd.set("id", quickReturn.id);
                      fd.set("completionMode", "REFUND_DONE");
                      submit(fd, { method: "post" });
                      setQuickModalOpen(false);
                      setQuickReturn(null);
                    },
                  },
                  {
                    content: t["returns.resendComplete"] || "Ürünü Gönderildi Olarak Tamamla",
                    onAction: () => {
                      if (!quickReturn) return;
                      const fd = new FormData();
                      fd.set("intent", "quick_complete");
                      fd.set("id", quickReturn.id);
                      fd.set("completionMode", "ITEM_RESENT");
                      submit(fd, { method: "post" });
                      setQuickModalOpen(false);
                      setQuickReturn(null);
                    },
                  },
                ]
              : []),
            {
              content: t["returns.fullDetail"] || "Detay Sayfasına Git",
              onAction: () => {
                if (!quickReturn) return;
                navigate(`/app/returns/${quickReturn.id}`);
                setQuickModalOpen(false);
                setQuickReturn(null);
              },
            },
          ]}
        >
          <Modal.Section>
            {quickReturn && (
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">{quickReturn.customerEmail}</Text>
                <Text as="p" variant="bodySm">
                  {`${t["returns.status"] || "Durum"}: ${t[`status.${quickReturn.status}`] || quickReturn.status}`}
                </Text>
                <Text as="p" variant="bodySm">
                  {`${t["returns.resolution"] || "Çözüm"}: ${resLabel(quickReturn.resolution?.type)}`}
                </Text>
                {quickReturn.status === "APPROVED" && (
                  <Banner tone="info">
                    {t["returns.approvedQuickHelp"] || "Onaylanan iadede ücret iadesi veya ürün yeniden gönderiminden sonra bu pencereden süreci tamamlayabilirsiniz."}
                  </Banner>
                )}
              </BlockStack>
            )}
          </Modal.Section>
        </Modal>

        <Modal
          open={customerModalOpen}
          onClose={() => {
            setCustomerModalOpen(false);
            setSelectedCustomer(null);
          }}
          title={selectedCustomer ? `${t["returns.customerDetail"] || "Customer Details"} - ${selectedCustomer.orderName}` : ""}
          primaryAction={{
            content: t["returns.viewDetail"] || "View Full Detail",
            onAction: () => {
              if (selectedCustomer) {
                navigate(`/app/returns/${selectedCustomer.id}`);
                setCustomerModalOpen(false);
                setSelectedCustomer(null);
              }
            },
          }}
          secondaryActions={[{
            content: "Kapat",
            onAction: () => {
              setCustomerModalOpen(false);
              setSelectedCustomer(null);
            },
          }]}
        >
          <Modal.Section>
            {selectedCustomer && (
              <BlockStack gap="300">
                <Card padding="200">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">{t["returns.orderDetail"] || "Order Details"}</Text>
                    <InlineStack gap="200">
                      <Text as="span" variant="bodySm" fontWeight="bold">{t["returns.order"]}:</Text>
                      <Text as="span" variant="bodySm">{selectedCustomer.orderName}</Text>
                    </InlineStack>
                    <InlineStack gap="200">
                      <Text as="span" variant="bodySm" fontWeight="bold">{t["returns.customer"]}:</Text>
                      <Text as="span" variant="bodySm">{selectedCustomer.customerEmail}</Text>
                    </InlineStack>
                    <InlineStack gap="200">
                      <Text as="span" variant="bodySm" fontWeight="bold">{t["returns.status"]}:</Text>
                      {statusBadge(selectedCustomer.status)}
                    </InlineStack>
                    <InlineStack gap="200">
                      <Text as="span" variant="bodySm" fontWeight="bold">{t["returns.reason"]}:</Text>
                      <Text as="span" variant="bodySm">{translateReason(selectedCustomer.reason || "OTHER", t)}</Text>
                    </InlineStack>
                    <InlineStack gap="200">
                      <Text as="span" variant="bodySm" fontWeight="bold">{t["returns.resolution"]}:</Text>
                      <Text as="span" variant="bodySm">{resLabel(selectedCustomer.resolution?.type)}</Text>
                    </InlineStack>
                  </BlockStack>
                </Card>
                <Card padding="200">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">{t["returns.products"] || "Products"}</Text>
                    {selectedCustomer.items.map((item: any, index: number) => (
                      <InlineStack key={index} gap="200" align="space-between">
                        <Text as="span" variant="bodySm">{item.title}</Text>
                        <Text as="span" variant="bodySm" tone="subdued">{item.quantity} x {item.price}</Text>
                      </InlineStack>
                    ))}
                  </BlockStack>
                </Card>
                <Card padding="200">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">{t["returns.date"] || "Date"}</Text>
                    <InlineStack gap="200">
                      <Text as="span" variant="bodySm" fontWeight="bold">{t["returns.createdAt"]}:</Text>
                      <Text as="span" variant="bodySm">
                        {new Date(selectedCustomer.createdAt).toLocaleDateString(locale === "tr" ? "tr-TR" : "en-US")}
                        {" "}
                        {new Date(selectedCustomer.createdAt).toLocaleTimeString(locale === "tr" ? "tr-TR" : "en-US", {
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </Text>
                    </InlineStack>
                    {selectedCustomer.updatedAt !== selectedCustomer.createdAt && (
                      <InlineStack gap="200">
                        <Text as="span" variant="bodySm" fontWeight="bold">{t["returns.updatedAt"]}:</Text>
                        <Text as="span" variant="bodySm">
                          {new Date(selectedCustomer.updatedAt).toLocaleDateString(locale === "tr" ? "tr-TR" : "en-US")}
                          {" "}
                          {new Date(selectedCustomer.updatedAt).toLocaleTimeString(locale === "tr" ? "tr-TR" : "en-US", {
                            hour: '2-digit',
                            minute: '2-digit'
                          })}
                        </Text>
                      </InlineStack>
                    )}
                  </BlockStack>
                </Card>
              </BlockStack>
            )}
          </Modal.Section>
        </Modal>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t["returns.adminCreate"] || "Yönetici Tarafından İade Oluştur"}</Text>
            <InlineStack gap="200" align="start">
              <Autocomplete
                options={orderOptions}
                selected={manualOrderId ? [manualOrderId] : []}
                onSelect={(selected) => {
                  const id = selected[0] || "";
                  setManualOrderId(id);
                  setManualOrderItemId("");
                  setManualOrderItemQuery("");
                  setManualProductId("manual");
                  setManualVariantId("manual");
                  setManualItemTitle("");
                  setManualQuantity("1");
                  setManualPrice("0");
                  const order = manualOrders.find((o) => o.value === id);
                  if (order) {
                    setManualOrderName(order.label);
                    setManualOrderQuery(order.label);
                    if (!manualCustomerEmail && order.email) {
                      setManualCustomerEmail(order.email);
                      setManualCustomerQuery(order.email);
                    }
                  }
                }}
                textField={
                  <Autocomplete.TextField
                    label={t["returns.order"]}
                    value={manualOrderQuery}
                    onChange={(value) => {
                      setManualOrderQuery(value);
                      setManualOrderName(value);
                      if (!value) {
                        setManualOrderId("");
                        setManualOrderItemId("");
                        setManualOrderItemQuery("");
                      }
                    }}
                    autoComplete="off"
                    placeholder={t["returns.orderSearchHint"] || "Sipariş no yazın (#1001 gibi)"}
                  />
                }
              />
              <Autocomplete
                options={orderItemOptions}
                selected={manualOrderItemId ? [manualOrderItemId] : []}
                onSelect={(selected) => {
                  const value = selected[0] || "";
                  setManualOrderItemId(value);
                  const item = selectedOrder?.items.find((it) => it.value === value);
                  if (item) {
                    setManualOrderItemQuery(item.label);
                    setManualItemTitle(item.label);
                    setManualProductId(item.productId);
                    setManualVariantId(item.variantId);
                    setManualQuantity(String(item.quantity));
                    setManualPrice(item.price);
                  }
                }}
                textField={
                  <Autocomplete.TextField
                    label={t["returns.orderItem"] || "Sipariş Ürünü"}
                    value={manualOrderItemQuery}
                    onChange={(value) => {
                      setManualOrderItemQuery(value);
                      if (!value) {
                        setManualOrderItemId("");
                        setManualItemTitle("");
                        setManualProductId("manual");
                        setManualVariantId("manual");
                        setManualQuantity("1");
                        setManualPrice("0");
                      }
                    }}
                    autoComplete="off"
                    disabled={!manualOrderId}
                    placeholder={t["returns.orderItemSearchHint"] || "Sipariş ürünü seçin"}
                  />
                }
              />
              <Autocomplete
                options={customerOptions}
                selected={manualCustomerEmail ? [manualCustomerEmail] : []}
                onSelect={(selected) => {
                  const value = selected[0] || "";
                  setManualCustomerEmail(value);
                  setManualCustomerQuery(value);
                }}
                textField={
                  <Autocomplete.TextField
                    label={t["returns.customer"]}
                    value={manualCustomerQuery}
                    onChange={(value) => {
                      setManualCustomerQuery(value);
                      setManualCustomerEmail(value);
                    }}
                    autoComplete="off"
                    placeholder={t["returns.customerSearchHint"] || "Müşteri adı veya email yazın"}
                  />
                }
              />
            </InlineStack>
            <ChoiceList
              title={t["returns.adminCreateReasons"] || "Admin Return Reasons"}
              choices={adminReasonChoices}
              selected={manualAdminReason ? [manualAdminReason] : []}
              onChange={(selected) => {
                const reason = selected[0] || "";
                setManualAdminReason(reason);
                
                // Seçilen nedene göre Türkçe e-posta şablonunu otomatik doldur
                if (reason === "OUT_OF_STOCK" || reason === "DAMAGED_INVENTORY" || reason === "GHOST_INVENTORY") {
                  setManualEmailSubject("Siparişiniz Hakkında - Ürün Temin Edilemiyor");
                  setManualEmailBody(`Merhaba,\n\nSiparişinizdeki "${manualItemTitle || 'ilgili ürün'}" stoklarımızda kalmadığı/hasarlı olduğu için iptal/iade işlemi başlatılmış ve ücret iadeniz gerçekleştirilmiştir.\n\nAnlayışınız için teşekkür ederiz.`);
                } else if (reason === "QUALITY_ISSUE") {
                  setManualEmailSubject("Siparişiniz Hakkında - Kalite Kontrol");
                  setManualEmailBody(`Merhaba,\n\nSiparişinizdeki "${manualItemTitle || 'ilgili ürün'}" kalite kontrol standartlarımızı geçemediği için iptal/iade işlemi başlatılmış ve ücret iadeniz gerçekleştirilmiştir.\n\nAnlayışınız için teşekkür ederiz.`);
                } else if (reason === "ORDER_ERROR") {
                  setManualEmailSubject("Siparişiniz Hakkında - Sistem Hatası");
                  setManualEmailBody(`Merhaba,\n\nSiparişinizin işlenmesi sırasında sistemsel bir hata oluştuğu için "${manualItemTitle || 'ilgili ürün'}" için iptal/iade işlemi başlatılmış ve ücret iadeniz gerçekleştirilmiştir.\n\nAnlayışınız için teşekkür ederiz.`);
                } else {
                  setManualEmailSubject("İade İşleminiz Hakkında");
                  setManualEmailBody(`Merhaba,\n\nSiparişinizdeki "${manualItemTitle || 'ilgili ürün'}" için iade işleminiz başarıyla oluşturulmuş ve ücret iadeniz gerçekleştirilmiştir.`);
                }
              }}
            />
            <Card padding="200">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">{t["returns.notifyCustomer"] || "Notify Customer"}</Text>
                <InlineStack gap="200" align="start">
                  <ChoiceList
                    title={t["returns.notifyCustomer"] || "Notify Customer"}
                    titleHidden
                    choices={[{ label: t["returns.notifyCustomerHelp"] || "İade oluşturulduğunda müşteriye e-posta gönder", value: "notify" }]}
                    selected={manualNotifyCustomer ? ["notify"] : []}
                    onChange={(selected) => setManualNotifyCustomer(selected.includes("notify"))}
                  />
                </InlineStack>
                {manualNotifyCustomer && (
                  <BlockStack gap="300">
                    <TextField
                      label="E-posta Konusu"
                      value={manualEmailSubject}
                      onChange={setManualEmailSubject}
                      autoComplete="off"
                    />
                    <TextField
                      label="E-posta Mesajı"
                      value={manualEmailBody}
                      onChange={setManualEmailBody}
                      autoComplete="off"
                      multiline={6}
                      helpText="Bu mesaj tam olarak yazdığınız şekilde müşteriye gönderilecektir."
                    />
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
            <InlineStack gap="200" align="start">
              <Select
                label={t["returns.resolution"]}
                options={[
                  { label: t["resolution.REFUND"], value: "REFUND" },
                  { label: t["resolution.EXCHANGE"], value: "EXCHANGE" },
                  { label: t["resolution.EXCHANGE_DIFFERENT_PRODUCT"], value: "EXCHANGE_DIFFERENT_PRODUCT" },
                  { label: t["resolution.EXCHANGE_WITH_PRICE_DIFF"], value: "EXCHANGE_WITH_PRICE_DIFF" },
                  { label: t["resolution.STORE_CREDIT"], value: "STORE_CREDIT" },
                  { label: t["resolution.KEEP_IT"], value: "KEEP_IT" },
                ]}
                value={manualResolutionType}
                onChange={setManualResolutionType}
              />
              <TextField label={t["returns.itemTitle"] || "Ürün"} value={manualItemTitle} onChange={setManualItemTitle} autoComplete="off" />
              <TextField label={t["detail.qty"]} type="number" value={manualQuantity} onChange={setManualQuantity} autoComplete="off" />
              <TextField label={t["detail.amount"]} type="number" value={manualPrice} onChange={setManualPrice} autoComplete="off" />
            </InlineStack>
            <ButtonGroup>
              <Button
                variant="primary"
                loading={isManualSubmitting}
                onClick={() => {
                  const fd = new FormData();
                  fd.set("intent", "manual_create");
                  fd.set("orderId", manualOrderId);
                  fd.set("orderName", manualOrderName);
                  fd.set("customerEmail", manualCustomerEmail);
                  fd.set("adminReason", manualAdminReason);
                  fd.set("notifyCustomer", String(manualNotifyCustomer));
                  fd.set("emailSubject", manualEmailSubject);
                  fd.set("emailBody", manualEmailBody);
                  fd.set("resolutionType", manualResolutionType);
                  fd.set("productId", manualProductId);
                  fd.set("variantId", manualVariantId);
                  fd.set("itemTitle", manualItemTitle);
                  fd.set("quantity", manualQuantity);
                  fd.set("price", manualPrice);
                  submit(fd, { method: "post" });
                }}
              >
                {t["returns.adminCreate"] || "Yönetici Tarafından İade Oluştur"}
              </Button>
            </ButtonGroup>
          </BlockStack>
        </Card>

        <Card padding="0">
          <Filters
            queryValue={search}
            queryPlaceholder={t["returns.searchPlaceholder"]}
            filters={filters}
            appliedFilters={appliedFilters}
            onQueryChange={(v) => updateFilter("search", v)}
            onQueryClear={() => updateFilter("search", "")}
            onClearAll={clearFilters}
          />
          <IndexTable
            resourceName={{ singular: "return", plural: "returns" }}
            itemCount={returns.length}
            emptyState={emptyState}
            sortDirection="descending"
            headings={[
              { 
                title: t["returns.order"], 
                sortable: true, 
                sorted: sortBy === "orderName",
                sortDirection: sortBy === "orderName" ? (sortOrder === "asc" ? "ascending" : "descending") : undefined,
                onSort: () => handleSort("orderName")
              },
              { 
                title: t["returns.customer"], 
                sortable: true, 
                sorted: sortBy === "customerEmail",
                sortDirection: sortBy === "customerEmail" ? (sortOrder === "asc" ? "ascending" : "descending") : undefined,
                onSort: () => handleSort("customerEmail")
              },
              { 
                title: t["returns.status"], 
                sortable: true, 
                sorted: sortBy === "status",
                sortDirection: sortBy === "status" ? (sortOrder === "asc" ? "ascending" : "descending") : undefined,
                onSort: () => handleSort("status")
              },
              { 
                title: t["returns.reason"], 
                sortable: true, 
                sorted: sortBy === "reason",
                sortDirection: sortBy === "reason" ? (sortOrder === "asc" ? "ascending" : "descending") : undefined,
                onSort: () => handleSort("reason")
              },
              { 
                title: t["returns.resolution"], 
                sortable: true, 
                sorted: sortBy === "resolution",
                sortDirection: sortBy === "resolution" ? (sortOrder === "asc" ? "ascending" : "descending") : undefined,
                onSort: () => handleSort("resolution")
              },
              { 
                title: t["returns.products"], 
                sortable: true, 
                sorted: sortBy === "itemsCount",
                sortDirection: sortBy === "itemsCount" ? (sortOrder === "asc" ? "ascending" : "descending") : undefined,
                onSort: () => handleSort("itemsCount")
              },
              { 
                title: t["returns.date"], 
                sortable: true, 
                sorted: sortBy === "createdAt",
                sortDirection: sortBy === "createdAt" ? (sortOrder === "asc" ? "ascending" : "descending") : undefined,
                onSort: () => handleSort("createdAt")
              },
              { title: t["returns.action"] || "İşlem" },
            ]}
            sortDirection={sortOrder === "asc" ? "ascending" : "descending"}
            selectable
            selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
            onSelectionChange={handleSelectionChange}
          >
            {rowMarkup}
          </IndexTable>
        </Card>

        {totalPages > 1 && (
          <InlineStack align="center">
            <Pagination
              hasPrevious={page > 1}
              hasNext={page < totalPages}
              onPrevious={() => updateFilter("page", String(page - 1))}
              onNext={() => updateFilter("page", String(page + 1))}
            />
          </InlineStack>
        )}

        <Text as="p" variant="bodySm" tone="subdued" alignment="center">
          {t["returns.total"].replace("{count}", String(total))}
        </Text>
      </BlockStack>
    </Page>
  );
}
