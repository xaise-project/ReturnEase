import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { detectLocale, getTranslations, t } from "../services/i18n.server";
import { dispatchReturnNotifications } from "../services/notifications.server";
import { checkRateLimit, getClientIp } from "../services/rate-limit.server";
import { parseResolutionRules, evaluateRules } from "../services/resolution-rules.server";

const DRAFT_ORDER_CREATE_MUTATION = `#graphql
  mutation draftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        invoiceUrl
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DISCOUNT_CODE_BASIC_CREATE_MUTATION = `#graphql
  mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        codeDiscount {
          ... on DiscountCodeBasic {
            codes(first: 1) {
              nodes {
                code
              }
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const SHOP_LOGO_QUERY = `#graphql
  query shopBranding {
    shop {
      brand {
        logo {
          image {
            url
          }
        }
      }
    }
  }
`;

async function getShopLogoUrl(admin: any): Promise<string | null> {
  if (!admin) return null;
  try {
    const response = await admin.graphql(SHOP_LOGO_QUERY);
    const data = await response.json();
    return data.data?.shop?.brand?.logo?.image?.url || null;
  } catch {
    return null;
  }
}

function parseJsonMap(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) out[key] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function parseStringList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\n|,/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseReasonPriority(raw: string | null | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        out[key] = value.map((v) => String(v)).filter(Boolean);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function getResolutionOrderForReason(reason: string, settings: any): string[] {
  const reasonKey = String(reason || "").split(":")[0].trim();
  const ruleMap = parseReasonPriority(settings?.reasonPriorityJson);
  const preferred = ruleMap[reasonKey] || [];
  const defaults = [
    "REFUND",
    "EXCHANGE",
    "EXCHANGE_DIFFERENT_PRODUCT",
    "EXCHANGE_WITH_PRICE_DIFF",
    "STORE_CREDIT",
    "KEEP_IT",
  ];
  const seen = new Set<string>();
  const ordered = [...preferred, ...defaults].filter((v) => {
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  });
  return ordered;
}

function createDiscountCode(orderName: string) {
  const cleanOrder = orderName.replace(/[^A-Za-z0-9]/g, "").slice(-6) || "ORDER";
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RE-${cleanOrder}-${rand}`.slice(0, 24);
}

async function createPriceDifferenceInvoiceLink(
  admin: any,
  params: { orderName: string; email: string; amount: number; currencyCode: string },
) {
  const response = await admin.graphql(DRAFT_ORDER_CREATE_MUTATION, {
    variables: {
      input: {
        email: params.email,
        note: `ReturnEase price difference for ${params.orderName}`,
        lineItems: [
          {
            title: `Price difference for exchange (${params.orderName})`,
            quantity: 1,
            originalUnitPriceWithCurrency: {
              amount: params.amount.toFixed(2),
              currencyCode: params.currencyCode,
            },
            taxable: false,
            requiresShipping: false,
          },
        ],
      },
    },
  });
  const data = await response.json();
  const userErrors = data.data?.draftOrderCreate?.userErrors || [];
  if (userErrors.length > 0) {
    return { ok: false, error: userErrors.map((e: any) => e.message).join(", ") };
  }
  const invoiceUrl = data.data?.draftOrderCreate?.draftOrder?.invoiceUrl;
  if (!invoiceUrl) {
    return { ok: false, error: "Draft order invoice URL could not be created." };
  }
  return { ok: true, invoiceUrl };
}

async function createStoreCreditDiscountCode(
  admin: any,
  params: { code: string; customerId?: string; amount: number },
) {
  const startsAt = new Date().toISOString();
  const endsAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  const customerSelection = params.customerId
    ? { customers: { add: [params.customerId] } }
    : { all: true };

  const response = await admin.graphql(DISCOUNT_CODE_BASIC_CREATE_MUTATION, {
    variables: {
      basicCodeDiscount: {
        title: `ReturnEase Store Credit ${params.code}`,
        code: params.code,
        startsAt,
        endsAt,
        customerSelection,
        customerGets: {
          value: {
            discountAmount: {
              amount: params.amount.toFixed(2),
              appliesOnEachItem: false,
            },
          },
          items: { all: true },
        },
        appliesOncePerCustomer: true,
        usageLimit: 1,
      },
    },
  });

  const data = await response.json();
  const userErrors = data.data?.discountCodeBasicCreate?.userErrors || [];
  if (userErrors.length > 0) {
    return { ok: false, error: userErrors.map((e: any) => e.message).join(", ") };
  }
  const createdCode =
    data.data?.discountCodeBasicCreate?.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code || null;
  if (!createdCode) {
    return { ok: false, error: "Discount code was not returned by Shopify." };
  }
  return { ok: true, code: createdCode };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticate.public.appProxy(request);
  const { liquid, session } = auth;
  const admin = (auth as any).admin;
  const lang = detectLocale(request);

  let returnWindowDays = 30;
  let settings = null;
  const shopLogoUrl = await getShopLogoUrl(admin);
  if (session) {
    settings = await prisma.storeSettings.findUnique({
      where: { shop: session.shop },
    });
    returnWindowDays = settings?.returnWindowDays ?? 30;
  }
  const settingsForView = settings ? { ...settings, shopLogoUrl } : { shopLogoUrl };

  return liquid(portalHTML("search", { returnWindowDays, lang, settings: settingsForView }), { layout: false });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { liquid, admin, session } = await authenticate.public.appProxy(request);

  if (!session || !admin) {
    const lang = detectLocale(request);
    const L = getTranslations(lang);
    return liquid(portalHTML("error", { message: t(L, "portal.error.session"), lang }), { layout: false });
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const lang = (formData.get("lang") as string) || detectLocale(request);

  const settings = session ? await prisma.storeSettings.findUnique({ where: { shop: session.shop } }) : null;
  const shopLogoUrl = await getShopLogoUrl(admin);
  const settingsForView = settings ? { ...settings, shopLogoUrl } : { shopLogoUrl };

  if (intent === "search") {
    return handleOrderSearch(liquid, admin, session, formData, lang, settingsForView);
  }

  if (intent === "select_items") {
    return handleSelectItems(liquid, formData, lang, settingsForView);
  }

  if (intent === "select_reason") {
    return handleSelectReason(liquid, formData, lang, settingsForView);
  }

  if (intent === "select_exchange_variants") {
    return handleSelectExchangeVariants(liquid, admin, formData, lang, settingsForView);
  }

  if (intent === "create_return") {
    const clientIp = getClientIp(request);
    const rateCheck = checkRateLimit(clientIp);
    if (!rateCheck.allowed) {
      const L = getTranslations(lang);
      const waitMin = Math.ceil(rateCheck.resetInMs / 60000);
      return liquid(
        portalHTML("error", {
          message: t(L, "portal.error.rateLimit") || `Too many requests. Please try again in ${waitMin} minute(s).`,
          lang,
        }),
        { layout: false },
      );
    }
    return handleCreateReturn(liquid, admin, session, formData, lang, settingsForView, clientIp);
  }

  const L = getTranslations(lang);
  return liquid(portalHTML("error", { message: t(L, "portal.error.invalid"), lang }), { layout: false });
};

async function handleOrderSearch(
  liquid: any,
  admin: any,
  session: any,
  formData: FormData,
  lang: string,
  settings: any
) {
  const L = getTranslations(lang);
  const orderName = (formData.get("orderName") as string)?.trim();
  const email = (formData.get("email") as string)?.trim();

  if (!orderName || !email) {
    return liquid(portalHTML("error", { message: t(L, "portal.error.required"), lang }), { layout: false });
  }

  const normalizedEmail = String(email || "").toLowerCase();
  const normalizedOrderName = String(orderName || "").replace(/\s+/g, "");
  const cleanOrderName = normalizedOrderName.startsWith("#") ? normalizedOrderName : `#${normalizedOrderName}`;

  try {

  const returnWindowDays = settings?.returnWindowDays ?? 30;

  const orderResponse = await admin.graphql(
    `#graphql
      query getOrder($query: String!) {
        orders(first: 5, query: $query) {
          edges {
            node {
              id
              name
              email
              createdAt
              cancelledAt
              displayFinancialStatus
              displayFulfillmentStatus
              customer { id }
              totalPriceSet {
                shopMoney { amount currencyCode }
              }
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    title
                    quantity
                    variant {
                      id
                      title
                      price
                      image { url altText }
                    }
                    product { id title }
                    discountedTotalSet {
                      shopMoney { amount }
                    }
                    originalTotalSet {
                      shopMoney { amount }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { variables: { query: `name:${cleanOrderName}` } },
  );

  const orderData = await orderResponse.json();
  const orderCandidates = (orderData.data?.orders?.edges || []).map((e: any) => e.node);
  const order = orderCandidates.find(
    (candidate: any) => String(candidate?.email || "").trim().toLowerCase() === normalizedEmail,
  );

  if (!order) {
    return liquid(portalHTML("not_found", { orderName: cleanOrderName, email, lang, settings }), { layout: false });
  }

  const blockedEmails = new Set(parseStringList(settings?.blockedCustomerEmails).map((v) => v.toLowerCase()));
  if (blockedEmails.has(String(email).trim().toLowerCase())) {
    return liquid(portalHTML("error", { message: t(L, "portal.error.customerBlocked"), lang, settings }), { layout: false });
  }

  const orderAmount = Number(order.totalPriceSet?.shopMoney?.amount || 0);
  const minimumOrderAmount = Number(settings?.minimumOrderAmount || 0);
  if (minimumOrderAmount > 0 && orderAmount < minimumOrderAmount) {
    return liquid(
      portalHTML("error", {
        message: t(L, "portal.error.minimumOrderAmount", { amount: minimumOrderAmount.toFixed(2) }),
        lang,
        settings,
      }),
      { layout: false },
    );
  }

  const maxReturnsPerCustomer = Number(settings?.maxReturnsPerCustomer || 0);
  if (maxReturnsPerCustomer > 0) {
    const existingByCustomer = await prisma.returnRequest.count({
      where: { shop: session.shop, customerEmail: email },
    });
    if (existingByCustomer >= maxReturnsPerCustomer) {
      return liquid(
        portalHTML("error", {
          message: t(L, "portal.error.maxReturnsPerCustomer", { limit: maxReturnsPerCustomer }),
          lang,
          settings,
        }),
        { layout: false },
      );
    }
  }

  const existingReturn = await prisma.returnRequest.findFirst({
    where: { shop: session.shop, orderId: order.id },
    include: { resolution: true, items: true },
    orderBy: { createdAt: "desc" }
  });

  if (existingReturn) {
    const fraudEvents = await prisma.fraudEvent.findMany({
      where: {
        shop: session.shop,
        OR: [
          { returnRequestId: existingReturn.id },
          { orderId: order.id, customerEmail: email },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    return liquid(
      portalHTML("tracker", { returnRequest: existingReturn, fraudEvents, orderName: cleanOrderName, lang, settings }),
      { layout: false },
    );
  }

  if (order.cancelledAt) {
    return liquid(portalHTML("error", { message: t(L, "portal.cancelled"), lang, settings }), { layout: false });
  }

  const orderDate = new Date(order.createdAt);
  const now = new Date();
  const daysSinceOrder = Math.floor((now.getTime() - orderDate.getTime()) / (1000 * 60 * 60 * 24));
  const maxProductWindow = Math.max(...Object.values(parseJsonMap(settings?.productReturnWindowsJson)), 0);
  const maxCollectionWindow = Math.max(...Object.values(parseJsonMap(settings?.collectionReturnWindowsJson)), 0);
  const maxAllowedWindow = Math.max(returnWindowDays, maxProductWindow, maxCollectionWindow);
  if (daysSinceOrder > maxAllowedWindow) {
    return liquid(portalHTML("error", {
      message: t(L, "portal.expired", { window: maxAllowedWindow, days: daysSinceOrder }),
      lang,
      settings
    }), { layout: false });
  }

  if (order.displayFulfillmentStatus === "UNFULFILLED") {
    return liquid(portalHTML("error", { message: t(L, "portal.unfulfilled"), lang, settings }), { layout: false });
  }

  const returnableResponse = await admin.graphql(
    `#graphql
      query getReturnableFulfillments($orderId: ID!) {
        returnableFulfillments(orderId: $orderId, first: 50) {
          edges {
            node {
              fulfillment { id }
              returnableFulfillmentLineItems(first: 50) {
                edges {
                  node {
                    fulfillmentLineItem {
                      id
                      lineItem {
                        id
                        title
                        variant {
                          id
                          title
                          price
                          image { url altText }
                        }
                        discountedTotalSet {
                          shopMoney { amount }
                        }
                        originalTotalSet {
                          shopMoney { amount }
                        }
                        product {
                          id
                          title
                          collections(first: 20) {
                            edges {
                              node { id }
                            }
                          }
                        }
                      }
                    }
                    quantity
                  }
                }
              }
            }
          }
        }
      }
    `,
    { variables: { orderId: order.id } },
  );

  const returnableData = await returnableResponse.json();
  const fulfillments = returnableData.data?.returnableFulfillments?.edges || [];

  const productWindows = parseJsonMap(settings?.productReturnWindowsJson);
  const collectionWindows = parseJsonMap(settings?.collectionReturnWindowsJson);
  const blockedProductIds = new Set(parseStringList(settings?.nonReturnableProductIds));
  const blockedCollectionIds = new Set(parseStringList(settings?.nonReturnableCollectionIds));
  const excludeDiscountedItems = Boolean(settings?.excludeDiscountedItems);

  const returnableItems: any[] = [];
  for (const edge of fulfillments) {
    for (const itemEdge of edge.node.returnableFulfillmentLineItems.edges) {
      const item = itemEdge.node;
      const lineItem = item.fulfillmentLineItem.lineItem;
      if (item.quantity > 0 && lineItem) {
        const productId = lineItem.product?.id || "";
        const collectionIds: string[] = (lineItem.product?.collections?.edges || []).map((ce: any) => ce.node?.id).filter(Boolean);
        const originalTotal = Number(lineItem.originalTotalSet?.shopMoney?.amount || 0);
        const discountedTotal = Number(lineItem.discountedTotalSet?.shopMoney?.amount || 0);
        const isDiscounted = discountedTotal > 0 && originalTotal > discountedTotal;
        if (blockedProductIds.has(productId)) continue;
        if (collectionIds.some((id) => blockedCollectionIds.has(id))) continue;
        if (excludeDiscountedItems && isDiscounted) continue;

        let effectiveWindow = returnWindowDays;
        if (productId && productWindows[productId] !== undefined) {
          effectiveWindow = productWindows[productId];
        } else {
          const hit = collectionIds.map((id) => collectionWindows[id]).find((v) => v !== undefined);
          if (hit !== undefined) effectiveWindow = hit;
        }
        if (daysSinceOrder > effectiveWindow) continue;

        returnableItems.push({
          fulfillmentLineItemId: item.fulfillmentLineItem.id,
          lineItemId: lineItem.id,
          title: lineItem.title,
          variantTitle: lineItem.variant?.title || "",
          price: lineItem.variant?.price || "0",
          imageUrl: lineItem.variant?.image?.url || "",
          imageAlt: lineItem.variant?.image?.altText || lineItem.title,
          maxQuantity: item.quantity,
          productId,
          variantId: lineItem.variant?.id || "",
          collectionIds,
          isDiscounted,
          effectiveWindow,
        });
      }
    }
  }

  if (returnableItems.length === 0) {
    return liquid(portalHTML("error", { message: t(L, "portal.noItems"), lang, settings }), { layout: false });
  }

  return liquid(portalHTML("items", {
    order: {
      id: order.id,
      name: order.name,
      email: order.email,
      createdAt: order.createdAt,
      total: order.totalPriceSet.shopMoney,
      customerId: order.customer?.id || "",
    },
    items: returnableItems,
    shop: session.shop,
    lang,
    settings
  }), { layout: false });

  } catch (error: any) {
    console.error("Portal error:", error);
    const message = error?.message || t(L, "portal.error.unexpected");
    return liquid(portalHTML("error", { message: t(L, "portal.error.generic", { message }), lang, settings }), { layout: false });
  }
}

// ─── Select Items Handler ────────────────────────────────────

async function handleSelectItems(liquid: any, formData: FormData, lang: string, settings: any) {
  const L = getTranslations(lang);
  const orderId = formData.get("orderId") as string;
  const orderName = formData.get("orderName") as string;
  const email = formData.get("email") as string;
  const shop = formData.get("shop") as string;
  const customerId = formData.get("customerId") as string;
  const itemCount = parseInt(formData.get("itemCount") as string) || 0;

  const selectedItems: any[] = [];
  for (let i = 0; i < itemCount; i++) {
    const checked = formData.get(`item_${i}`);
    if (checked) {
      const meta = JSON.parse(formData.get(`meta_${i}`) as string);
      const qty = parseInt(formData.get(`qty_${i}`) as string) || 1;
      selectedItems.push({ ...meta, quantity: qty });
    }
  }

  if (selectedItems.length === 0) {
    return liquid(portalHTML("error", { message: t(L, "portal.error.selectItem"), lang, settings }), { layout: false });
  }

  return liquid(portalHTML("reason", {
    orderId, orderName, email, shop, customerId,
    selectedItems, lang, settings
  }), { layout: false });
}

// ─── Select Reason Handler ───────────────────────────────────

async function handleSelectReason(liquid: any, formData: FormData, lang: string, settings: any) {
  const L = getTranslations(lang);
  const orderId = formData.get("orderId") as string;
  const orderName = formData.get("orderName") as string;
  const email = formData.get("email") as string;
  const shop = formData.get("shop") as string;
  const customerId = formData.get("customerId") as string;
  const selectedItems = JSON.parse(formData.get("selectedItems") as string);
  const reason = formData.get("reason") as string;
  const reasonNote = formData.get("reasonNote") as string;
  const proofImageBase64 = formData.get("proofImageBase64") as string;

  if (!reason) {
    return liquid(portalHTML("error", { message: t(L, "portal.error.selectReason"), lang, settings }), { layout: false });
  }

  const fullReason = reasonNote ? `${reason}: ${reasonNote}` : reason;

  return liquid(portalHTML("resolution", {
    orderId, orderName, email, shop, customerId,
    selectedItems,
    reason: fullReason, proofImageBase64, lang, settings
  }), { layout: false });
}

// ─── Select Exchange Variants Handler ─────────────────────────

async function handleSelectExchangeVariants(
  liquid: any,
  admin: any,
  formData: FormData,
  lang: string,
  settings: any
) {
  const orderId = formData.get("orderId") as string;
  const orderName = formData.get("orderName") as string;
  const email = formData.get("email") as string;
  const shop = formData.get("shop") as string;
  const customerId = formData.get("customerId") as string;
  const selectedItems = JSON.parse(formData.get("selectedItems") as string);
  const reason = formData.get("reason") as string;
  const proofImageBase64 = formData.get("proofImageBase64") as string;
  const resolutionType = (formData.get("resolutionType") as string) || "EXCHANGE";

  const itemsWithVariants: any[] = [];
  let upsellProducts: any[] = [];

  if (resolutionType === "EXCHANGE") {
    for (const item of selectedItems) {
      if (!item.productId) continue;

      const variantResponse = await admin.graphql(
        `#graphql
          query getProductVariants($id: ID!) {
            product(id: $id) {
              id
              title
              priceRangeV2 { minVariantPrice { amount } }
              collections(first: 3) { edges { node { id } } }
              tags
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    price
                    availableForSale
                    inventoryQuantity
                  }
                }
              }
            }
          }
        `,
        { variables: { id: item.productId } },
      );

      const variantData = await variantResponse.json();
      const product = variantData.data?.product;
      const variants = product?.variants?.edges
        ?.map((e: any) => e.node)
        ?.filter((v: any) => v.availableForSale && v.id !== item.variantId) || [];

      itemsWithVariants.push({
        ...item,
        productTitle: product?.title || item.title,
        availableVariants: variants,
        basePrice: parseFloat(product?.priceRangeV2?.minVariantPrice?.amount || item.price),
      });

      // Fetch upsell candidates: same collection, higher price, in stock
      const collectionId = product?.collections?.edges?.[0]?.node?.id;
      if (collectionId && upsellProducts.length < 4) {
        try {
          const upsellResp = await admin.graphql(
            `#graphql
              query upsellProducts($collectionId: ID!, $minPrice: Decimal!) {
                collection(id: $collectionId) {
                  products(first: 6, sortKey: PRICE) {
                    edges {
                      node {
                        id
                        title
                        handle
                        featuredImage { url altText }
                        priceRangeV2 {
                          minVariantPrice { amount currencyCode }
                          maxVariantPrice { amount currencyCode }
                        }
                        variants(first: 5) {
                          edges {
                            node {
                              id
                              title
                              price
                              availableForSale
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            `,
            { variables: { collectionId, minPrice: item.price } },
          );
          const upsellData = await upsellResp.json();
          const candidates = (upsellData?.data?.collection?.products?.edges || [])
            .map((e: any) => e.node)
            .filter((p: any) =>
              p.id !== item.productId &&
              parseFloat(p.priceRangeV2?.minVariantPrice?.amount || "0") > parseFloat(item.price) &&
              p.variants?.edges?.some((v: any) => v.node.availableForSale)
            )
            .slice(0, 3)
            .map((p: any) => ({
              id: p.id,
              title: p.title,
              imageUrl: p.featuredImage?.url || "",
              imageAlt: p.featuredImage?.altText || p.title,
              minPrice: parseFloat(p.priceRangeV2?.minVariantPrice?.amount || "0"),
              maxPrice: parseFloat(p.priceRangeV2?.maxVariantPrice?.amount || "0"),
              currencyCode: p.priceRangeV2?.minVariantPrice?.currencyCode || "USD",
              variants: (p.variants?.edges || [])
                .map((v: any) => v.node)
                .filter((v: any) => v.availableForSale),
            }));

          upsellProducts = [...upsellProducts, ...candidates].slice(0, 4);
        } catch {
          // Upsell is non-blocking
        }
      }
    }
  } else {
    const catalogResponse = await admin.graphql(
      `#graphql
        query catalogVariants {
          products(first: 40, query: "status:active") {
            edges {
              node {
                title
                variants(first: 20) {
                  edges {
                    node {
                      id
                      title
                      price
                      availableForSale
                      inventoryQuantity
                    }
                  }
                }
              }
            }
          }
        }
      `,
    );
    const catalogData = await catalogResponse.json();
    const catalogVariants = (catalogData.data?.products?.edges || []).flatMap((edge: any) =>
      (edge.node?.variants?.edges || []).map((ve: any) => ({
        ...ve.node,
        title: `${edge.node.title} / ${ve.node.title}`,
      })),
    ).filter((v: any) => v.availableForSale);

    for (const item of selectedItems) {
      itemsWithVariants.push({
        ...item,
        productTitle: item.title,
        availableVariants: catalogVariants.filter((v: any) => v.id !== item.variantId),
      });
    }
  }

  return liquid(portalHTML("exchange_variants", {
    orderId, orderName, email, shop, customerId,
    selectedItems: itemsWithVariants,
    upsellProducts,
    reason, proofImageBase64, resolutionType, lang, settings
  }), { layout: false });
}

// ─── Create Return Handler ───────────────────────────────────

async function handleCreateReturn(
  liquid: any,
  admin: any,
  session: any,
  formData: FormData,
  lang: string,
  settings: any,
  clientIp: string
) {
  const L = getTranslations(lang);
  const orderId = formData.get("orderId") as string;
  const orderName = formData.get("orderName") as string;
  const email = formData.get("email") as string;
  const shop = formData.get("shop") as string;
  const customerId = formData.get("customerId") as string;
  const selectedItems = JSON.parse(formData.get("selectedItems") as string);
  const reason = formData.get("reason") as string;
  const proofImageBase64 = formData.get("proofImageBase64") as string;
  const resolutionType = formData.get("resolutionType") as string;
  const upsellVariantId = (formData.get("upsellVariantId") as string)?.trim() || null;
  const upsellProductId = (formData.get("upsellProductId") as string)?.trim() || null;

  if (
    !resolutionType ||
    !["REFUND", "STORE_CREDIT", "EXCHANGE", "EXCHANGE_DIFFERENT_PRODUCT", "EXCHANGE_WITH_PRICE_DIFF", "KEEP_IT"].includes(resolutionType)
  ) {
    return liquid(portalHTML("error", { message: t(L, "portal.error.invalidResolution"), lang, settings }), { layout: false });
  }

  try {
    const logFraudEvent = async (rule: string, outcome: string, details?: Record<string, any>, score?: number) => {
      await prisma.fraudEvent.create({
        data: {
          shop,
          orderId,
          customerEmail: email || null,
          clientIp: clientIp || null,
          rule,
          outcome,
          score: score === undefined ? null : score,
          details: details || undefined,
        },
      });
    };

    // Check plan limits (settings passed down)
    const plan = settings?.plan || "FREE";
    const planLimits: Record<string, number> = { FREE: 10, STARTER: 300, GROWTH: -1 };
    const limit = planLimits[plan] ?? 10;

    if (limit > 0) {
      const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const monthlyCount = await prisma.returnRequest.count({
        where: { shop, createdAt: { gte: monthStart } },
      });
      if (monthlyCount >= limit) {
        return liquid(portalHTML("error", {
          message: t(L, "portal.error.limit", { limit }),
          lang, settings
        }), { layout: false });
      }
    }

    const totalAmount = selectedItems.reduce(
      (sum: number, item: any) => sum + parseFloat(item.price) * item.quantity,
      0,
    );
    // Apply store credit bonus if applicable
    const storeCreditBonusRate = Number(settings?.storeCreditBonusRate || 0);
    const effectiveAmount = resolutionType === "STORE_CREDIT" && storeCreditBonusRate > 0
      ? Number((totalAmount * (1 + storeCreditBonusRate)).toFixed(2))
      : totalAmount;
    const reasonKey = String(reason || "").split(":")[0].trim();
    const selectedProductIds = selectedItems.map((item: any) => item.productId).filter(Boolean);
    const selectedVariantIds = selectedItems.map((item: any) => item.variantId).filter(Boolean);

    if (settings?.requirePhotoForFraudReasons && ["DEFECTIVE", "COLOR"].includes(reasonKey) && !proofImageBase64) {
      await logFraudEvent("PROOF_REQUIRED", "BLOCKED", { reasonKey });
      return liquid(
        portalHTML("error", { message: t(L, "portal.error.proofRequired"), lang, settings }),
        { layout: false },
      );
    }

    if (settings?.blockMultipleReturnsSameOrder) {
      const duplicate = await prisma.returnRequest.findFirst({
        where: {
          shop,
          orderId,
          status: { in: ["REQUESTED", "APPROVED", "COMPLETED"] },
          items: {
            some: {
              OR: [
                { productId: { in: selectedProductIds } },
                { variantId: { in: selectedVariantIds } },
              ],
            },
          },
        },
      });
      if (duplicate) {
        await logFraudEvent("DUPLICATE_ORDER_ITEM", "BLOCKED", { duplicateReturnId: duplicate.id });
        return liquid(
          portalHTML("error", { message: t(L, "portal.error.duplicateOrderReturn"), lang, settings }),
          { layout: false },
        );
      }
    }

    const wardrobingWindowDays = Number(settings?.wardrobingWindowDays || 30);
    const wardrobingMaxReturns = Number(settings?.wardrobingMaxReturns || 3);
    const wardrobingSince = new Date(Date.now() - wardrobingWindowDays * 24 * 60 * 60 * 1000);
    const recentReturnCount = await prisma.returnRequest.count({
      where: {
        shop,
        customerEmail: email,
        status: { in: ["REQUESTED", "APPROVED", "COMPLETED"] },
        createdAt: { gte: wardrobingSince },
      },
    });
    if (wardrobingMaxReturns > 0 && recentReturnCount >= wardrobingMaxReturns) {
      await logFraudEvent("WARDROBING", "BLOCKED", { recentReturnCount, wardrobingWindowDays, wardrobingMaxReturns });
      return liquid(
        portalHTML("error", {
          message: t(L, "portal.error.wardrobingDetected", { count: wardrobingMaxReturns, days: wardrobingWindowDays }),
          lang,
          settings,
        }),
        { layout: false },
      );
    }

    const ipRepeatWindowHours = Number(settings?.ipRepeatWindowHours || 24);
    const ipRepeatMaxReturns = Number(settings?.ipRepeatMaxReturns || 2);
    if (clientIp && clientIp !== "unknown") {
      const ipSince = new Date(Date.now() - ipRepeatWindowHours * 60 * 60 * 1000);
      const ipRepeatCount = await prisma.returnRequest.count({
        where: {
          shop,
          clientIp,
          status: { in: ["REQUESTED", "APPROVED", "COMPLETED"] },
          createdAt: { gte: ipSince },
        },
      });
      if (ipRepeatMaxReturns > 0 && ipRepeatCount >= ipRepeatMaxReturns) {
        await logFraudEvent("IP_REPEAT", "BLOCKED", { ipRepeatCount, ipRepeatWindowHours, ipRepeatMaxReturns });
        return liquid(
          portalHTML("error", {
            message: t(L, "portal.error.ipRepeatDetected", { count: ipRepeatMaxReturns, hours: ipRepeatWindowHours }),
            lang,
            settings,
          }),
          { layout: false },
        );
      }
    }

    let fraudWarning: string | null = null;
    const highRateThreshold = Number(settings?.highReturnRateThreshold || 0.5);
    const customerReturnTotal = await prisma.returnRequest.count({
      where: {
        shop,
        customerEmail: email,
        status: { in: ["REQUESTED", "APPROVED", "COMPLETED"] },
      },
    });
    if (highRateThreshold > 0) {
      try {
        const countResponse = await admin.graphql(
          `#graphql
            query customerOrdersCount($query: String!) {
              ordersCount(query: $query, limit: null) {
                count
              }
            }
          `,
          { variables: { query: `email:${email}` } },
        );
        const countData = await countResponse.json();
        const totalOrdersForCustomer = Number(countData.data?.ordersCount?.count || 0);
        if (totalOrdersForCustomer > 0) {
          const rate = customerReturnTotal / totalOrdersForCustomer;
          if (rate >= highRateThreshold) {
            fraudWarning = t(L, "portal.warning.highReturnRate", {
              rate: (rate * 100).toFixed(1),
            });
            await logFraudEvent("HIGH_RETURN_RATE", "WARNING", { totalOrdersForCustomer, customerReturnTotal }, rate);
          }
        }
      } catch {}
    }

    // ── Automated Resolution Rules ──────────────────────────
    // Evaluate merchant-defined rules; override customer's resolution choice if matched.
    const resolutionRules = parseResolutionRules(settings?.resolutionRulesJson);
    let appliedResolutionType = resolutionType;
    if (resolutionRules.length > 0) {
      // Fetch customer tags from Shopify if we have a customerId
      let customerTags: string[] = [];
      if (customerId) {
        try {
          const tagResp = await admin.graphql(
            `#graphql
              query getCustomerTags($id: ID!) {
                customer(id: $id) { tags }
              }
            `,
            { variables: { id: customerId } },
          );
          const tagData = await tagResp.json();
          customerTags = tagData.data?.customer?.tags || [];
        } catch {}
      }

      const ruleMatch = evaluateRules(resolutionRules, {
        orderAmount: totalAmount,
        customerTags,
        reason,
        customerReturnCount: customerReturnTotal,
      });

      if (ruleMatch && ruleMatch !== resolutionType) {
        // Log the rule override for audit trail
        appliedResolutionType = ruleMatch;
        // We'll log this after the returnRequest is created — store it for later
      }
    }
    const finalResolutionType = appliedResolutionType;

    if (finalResolutionType === "KEEP_IT") {
      if (!settings?.enableKeepIt) {
        return liquid(portalHTML("error", { message: t(L, "portal.error.keepItDisabled"), lang, settings }), { layout: false });
      }
      const maxAllowed = Number(settings?.keepItMaxAmount || 0);
      if (totalAmount > maxAllowed) {
        return liquid(
          portalHTML("error", {
            message: t(L, "portal.error.keepItLimit", { amount: maxAllowed.toFixed(2) }),
            lang,
            settings,
          }),
          { layout: false },
        );
      }

      const keepItRequest = await prisma.returnRequest.create({
        data: {
          shop,
          orderId,
          orderName,
          customerEmail: email,
          reason,
          status: "COMPLETED",
          clientIp,
          proofImages: proofImageBase64 ? [proofImageBase64] : [],
          items: {
            create: selectedItems.map((item: any) => ({
              productId: item.productId,
              variantId: item.variantId,
              title: item.title,
              quantity: item.quantity,
              price: parseFloat(item.price),
            })),
          },
          resolution: {
            create: {
              type: "KEEP_IT",
              amount: totalAmount,
              currency: "USD",
              metadata: { mode: "keep_it" },
            },
          },
        },
      });
      if (fraudWarning) {
        await prisma.fraudEvent.create({
          data: {
            shop,
            returnRequestId: keepItRequest.id,
            orderId,
            customerEmail: email,
            clientIp: clientIp || null,
            rule: "HIGH_RETURN_RATE",
            outcome: "WARNING",
          },
        });
      }
      await dispatchReturnNotifications({
        shop,
        event: "RETURN_COMPLETED",
        returnRequest: {
          id: keepItRequest.id,
          orderName,
          customerEmail: email,
          reason,
          status: "COMPLETED",
          resolutionType: "KEEP_IT",
          amount: totalAmount,
        },
      });

      return liquid(portalHTML("confirmation", {
        orderName,
        returnId: keepItRequest.id,
        items: selectedItems,
        reason,
        resolutionType: finalResolutionType,
        totalAmount: totalAmount.toFixed(2),
        fraudWarning,
        isAutoApproved: true,
        lang,
        settings,
      }), { layout: false });
    }

    const reasonMap: Record<string, string> = {
      "SIZE": "SIZE_TOO_SMALL",
      "COLOR": "COLOR",
      "DEFECTIVE": "DEFECTIVE",
      "UNWANTED": "UNWANTED",
    };

    const returnLineItems = selectedItems.map((item: any) => {
      const mappedReason = reasonMap[reason.split(":")[0]] || "OTHER";
      const lineItem: any = {
        fulfillmentLineItemId: item.fulfillmentLineItemId,
        quantity: item.quantity,
        returnReason: mappedReason,
      };
      if (mappedReason === "OTHER") {
        lineItem.returnReasonNote = reason.includes(":") ? reason.split(":").slice(1).join(":").trim() : reason;
      }
      return lineItem;
    });

    const returnInput: any = {
      orderId,
      returnLineItems,
      notifyCustomer: true,
    };

    let priceDifference = 0;
    let paymentLinkUrl: string | null = null;
    if (["EXCHANGE", "EXCHANGE_DIFFERENT_PRODUCT", "EXCHANGE_WITH_PRICE_DIFF"].includes(finalResolutionType)) {
      const exchangeLineItems: any[] = [];

      // If customer selected an upsell product, use that instead of the variant picker
      if (upsellVariantId && upsellProductId) {
        exchangeLineItems.push({
          variantId: upsellVariantId,
          quantity: selectedItems[0]?.quantity || 1,
          isUpsell: true,
        });
      } else {
        for (const item of selectedItems) {
          const exchangeVariantId = formData.get(`exchangeVariant_${item.fulfillmentLineItemId}`);
          if (exchangeVariantId) {
            exchangeLineItems.push({
              variantId: exchangeVariantId,
              quantity: item.quantity,
            });
          }
        }
      }

      if (exchangeLineItems.length === 0) {
        return liquid(portalHTML("error", { message: t(L, "portal.error.selectVariants"), lang, settings }), { layout: false });
      }

      if (finalResolutionType === "EXCHANGE_WITH_PRICE_DIFF") {
        const variantIds = exchangeLineItems.map((item) => item.variantId);
        const variantResponse = await admin.graphql(
          `#graphql
            query getVariantPrices($ids: [ID!]!) {
              nodes(ids: $ids) {
                ... on ProductVariant {
                  id
                  price
                }
              }
            }
          `,
          { variables: { ids: variantIds } },
        );
        const variantData = await variantResponse.json();
        const variantPriceMap: Record<string, number> = {};
        for (const node of variantData.data?.nodes || []) {
          if (node?.id) variantPriceMap[node.id] = parseFloat(node.price || "0");
        }
        const exchangeTotal = exchangeLineItems.reduce(
          (sum: number, item: any) => sum + (variantPriceMap[item.variantId] || 0) * item.quantity,
          0,
        );
        priceDifference = Math.max(0, Number((exchangeTotal - totalAmount).toFixed(2)));
        if (priceDifference > 0 && !settings?.enablePriceDiffExchange) {
          return liquid(
            portalHTML("error", {
              message: t(L, "portal.error.priceDiffDisabled"),
              lang,
              settings,
            }),
            { layout: false },
          );
        }
        if (priceDifference > 0) {
          const invoiceResult = await createPriceDifferenceInvoiceLink(admin, {
            orderName,
            email,
            amount: priceDifference,
            currencyCode: "USD",
          });
          if (!invoiceResult.ok) {
            return liquid(
              portalHTML("error", {
                message: t(L, "portal.error.paymentLinkFailed", { error: invoiceResult.error || "unknown" }),
                lang,
                settings,
              }),
              { layout: false },
            );
          }
          paymentLinkUrl = invoiceResult.invoiceUrl || null;
        }
      }
      // Strip custom fields (isUpsell) before passing to Shopify API
      returnInput.exchangeLineItems = exchangeLineItems.map(({ variantId, quantity }: any) => ({ variantId, quantity }));
    }

    // Call Shopify returnCreate mutation
    const returnResponse = await admin.graphql(
      `#graphql
        mutation returnCreate($returnInput: ReturnInput!) {
          returnCreate(returnInput: $returnInput) {
            return {
              id
              status
              order { id name }
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        variables: { returnInput },
      },
    );

    const returnData = await returnResponse.json();
    const userErrors = returnData.data?.returnCreate?.userErrors || [];

    if (userErrors.length > 0) {
      const errorMsg = userErrors.map((e: any) => e.message).join(", ");
      return liquid(portalHTML("error", { message: t(L, "portal.error.returnFailed", { error: errorMsg }), lang, settings }), { layout: false });
    }

    const shopifyReturn = returnData.data?.returnCreate?.return;
    if (!shopifyReturn) {
      return liquid(portalHTML("error", { message: t(L, "portal.error.returnRetry"), lang, settings }), { layout: false });
    }

    let generatedDiscountCode: string | null = null;
    if (finalResolutionType === "STORE_CREDIT" && settings?.enableStoreCreditDiscountCode) {
      const candidateCode = createDiscountCode(orderName);
      const discountResult = await createStoreCreditDiscountCode(admin, {
        code: candidateCode,
        customerId: customerId || undefined,
        amount: totalAmount,
      });
      if (!discountResult.ok) {
        return liquid(
          portalHTML("error", {
            message: t(L, "portal.error.discountCodeFailed", { error: discountResult.error || "unknown" }),
            lang,
            settings,
          }),
          { layout: false },
        );
      }
      generatedDiscountCode = discountResult.code || null;
    }

    const returnRequest = await prisma.returnRequest.create({
      data: {
        shop,
        shopifyReturnId: shopifyReturn.id,
        orderId,
        orderName,
        customerEmail: email,
        reason,
        status: "REQUESTED",
        clientIp,
        proofImages: proofImageBase64 ? [proofImageBase64] : [],
        items: {
          create: selectedItems.map((item: any) => ({
            productId: item.productId,
            variantId: item.variantId,
            title: item.title,
            quantity: item.quantity,
            price: parseFloat(item.price),
          })),
        },
        resolution: {
          create: {
            type: finalResolutionType as any,
            amount: effectiveAmount,
            priceDifference: finalResolutionType === "EXCHANGE_WITH_PRICE_DIFF" ? priceDifference : null,
            paymentLinkUrl,
            discountCode: generatedDiscountCode,
            currency: "USD",
            metadata: finalResolutionType === "EXCHANGE_WITH_PRICE_DIFF"
              ? { priceDifference, paymentLinkUrl }
              : finalResolutionType === "STORE_CREDIT" && storeCreditBonusRate > 0
                ? { bonusRate: storeCreditBonusRate, baseAmount: totalAmount, bonusAmount: effectiveAmount - totalAmount }
                : undefined,
          },
        },
      },
    });
    if (fraudWarning) {
      await prisma.fraudEvent.create({
        data: {
          shop,
          returnRequestId: returnRequest.id,
          orderId,
          customerEmail: email,
          clientIp: clientIp || null,
          rule: "HIGH_RETURN_RATE",
          outcome: "WARNING",
        },
      });
    }

    // Log rule override if resolution was changed by automation
    if (finalResolutionType !== resolutionType) {
      await prisma.returnActionLog.create({
        data: {
          shop,
          returnRequestId: returnRequest.id,
          action: "RULE_OVERRIDE",
          actor: "system:rules",
          note: `Resolution auto-changed: ${resolutionType} → ${finalResolutionType}`,
          metadata: { original: resolutionType, applied: finalResolutionType },
        },
      });
    }

    // Log upsell selection for analytics
    if (upsellVariantId && upsellProductId) {
      await prisma.returnActionLog.create({
        data: {
          shop,
          returnRequestId: returnRequest.id,
          action: "UPSELL_ACCEPTED",
          actor: "customer",
          note: `Customer accepted upsell during exchange`,
          metadata: { upsellVariantId, upsellProductId, originalItems: selectedItems.map((i: any) => i.variantId) },
        },
      });
    }

    await dispatchReturnNotifications({
      shop,
      event: "RETURN_RECEIVED",
      returnRequest: {
        id: returnRequest.id,
        orderName,
        customerEmail: email,
        reason,
        status: "REQUESTED",
        resolutionType: finalResolutionType,
        amount: totalAmount,
      },
    });

    // Issue Shopify native store credit if resolution is STORE_CREDIT
    // Only runs when enableStoreCreditDiscountCode is OFF (native credit takes priority)
    if (finalResolutionType === "STORE_CREDIT" && customerId && !settings?.enableStoreCreditDiscountCode) {
      try {
        // Step 1: Fetch the StoreCreditAccount GID for this customer
        const scAccountResp = await admin.graphql(
          `#graphql
            query getStoreCreditAccount($customerId: ID!) {
              customer(id: $customerId) {
                storeCreditAccounts(first: 1) {
                  edges { node { id } }
                }
              }
            }
          `,
          { variables: { customerId } },
        );
        const scAccountData = await scAccountResp.json();
        const scAccountId = scAccountData?.data?.customer?.storeCreditAccounts?.edges?.[0]?.node?.id;
        const creditTargetId = scAccountId || customerId;

        // Step 2: Issue the credit
        const scMutResp = await admin.graphql(
          `#graphql
            mutation storeCreditAccountCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
              storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
                storeCreditAccountTransaction {
                  id
                  amount { amount currencyCode }
                }
                userErrors { field message }
              }
            }
          `,
          {
            variables: {
              id: creditTargetId,
              creditInput: {
                creditAmount: { amount: effectiveAmount.toFixed(2), currencyCode: "USD" },
              },
            },
          },
        );
        const scMutData = await scMutResp.json();
        const scErrors = scMutData?.data?.storeCreditAccountCredit?.userErrors || [];
        if (scErrors.length > 0) {
          // Log to ReturnActionLog so merchant can see it in admin
          await prisma.returnActionLog.create({
            data: {
              shop,
              returnRequestId: returnRequest.id,
              action: "STORE_CREDIT_FAILED",
              actor: "system:portal",
              note: scErrors.map((e: any) => e.message).join(", "),
              metadata: { customerId, amount: totalAmount, currencyCode: "USD" },
            },
          });
        } else {
          await prisma.returnActionLog.create({
            data: {
              shop,
              returnRequestId: returnRequest.id,
              action: "STORE_CREDIT_ISSUED",
              actor: "system:portal",
              note: `$${totalAmount.toFixed(2)} USD store credit issued`,
              metadata: { customerId, scAccountId: creditTargetId, amount: totalAmount },
            },
          });
        }
      } catch (scError: any) {
        await prisma.returnActionLog.create({
          data: {
            shop,
            returnRequestId: returnRequest.id,
            action: "STORE_CREDIT_FAILED",
            actor: "system:portal",
            note: scError.message,
            metadata: { customerId, amount: totalAmount },
          },
        });
      }
    }

    if (
      finalResolutionType === "EXCHANGE" ||
      finalResolutionType === "EXCHANGE_DIFFERENT_PRODUCT" ||
      finalResolutionType === "EXCHANGE_WITH_PRICE_DIFF" ||
      finalResolutionType === "STORE_CREDIT"
    ) {
      const commissionAmount = totalAmount * 0.02;
      const usageRecord = await prisma.usageRecord.create({
        data: {
          shop,
          returnRequestId: returnRequest.id,
          type: finalResolutionType as any,
          savedAmount: totalAmount,
          commissionRate: 0.02,
          commissionAmount,
          currency: "USD",
        },
      });

      // Report usage to Shopify (for billing)
      if (settings?.shopifySubscriptionId && commissionAmount > 0) {
        try {
          const usageResponse = await admin.graphql(
            `#graphql
              mutation appUsageRecordCreate($subscriptionLineItemId: ID!, $price: MoneyInput!, $description: String!) {
                appUsageRecordCreate(subscriptionLineItemId: $subscriptionLineItemId, price: $price, description: $description) {
                  appUsageRecord { id }
                  userErrors { field message }
                }
              }
            `,
            {
              variables: {
                subscriptionLineItemId: settings.shopifySubscriptionId,
                price: { amount: commissionAmount.toFixed(2), currencyCode: "USD" },
                description: `ReturnEase commission: ${finalResolutionType} - $${effectiveAmount.toFixed(2)} USD @ 2%`,
              },
            },
          );
          const usageData = await usageResponse.json();
          if (!usageData.data?.appUsageRecordCreate?.userErrors?.length) {
            await prisma.usageRecord.update({
              where: { id: usageRecord.id },
              data: { charged: true },
            });
          }
        } catch (usageError: any) {
          console.error("Usage record billing error:", usageError.message);
        }
      }
    }

    const autoApproveUnderAmount = Number(settings?.autoApproveUnderAmount || 0);
    const shouldAutoApprove = Boolean(settings?.isAutoApprove) || (autoApproveUnderAmount > 0 && totalAmount <= autoApproveUnderAmount);
    if (shouldAutoApprove) {
      // Auto-approve: call returnApproveRequest
      await admin.graphql(
        `#graphql
          mutation returnApproveRequest($input: ReturnApproveRequestInput!) {
            returnApproveRequest(input: $input) {
              return { id status }
              userErrors { field message }
            }
          }
        `,
        {
          variables: {
            input: { id: shopifyReturn.id },
          },
        },
      );

      await prisma.returnRequest.update({
        where: { id: returnRequest.id },
        data: { status: "APPROVED" },
      });
    }

    return liquid(portalHTML("confirmation", {
      orderName,
      returnId: returnRequest.id,
      items: selectedItems,
      reason,
      resolutionType: finalResolutionType,
      priceDifference: finalResolutionType === "EXCHANGE_WITH_PRICE_DIFF" ? priceDifference.toFixed(2) : null,
      paymentLinkUrl,
      discountCode: generatedDiscountCode,
      totalAmount: effectiveAmount.toFixed(2),
      baseAmount: totalAmount.toFixed(2),
      storeCreditBonus: finalResolutionType === "STORE_CREDIT" && storeCreditBonusRate > 0
        ? { rate: Math.round(storeCreditBonusRate * 100), extra: (effectiveAmount - totalAmount).toFixed(2) }
        : null,
      fraudWarning,
      isAutoApproved: shouldAutoApprove,
      lang, settings
    }), { layout: false });

  } catch (error: any) {
    console.error("Return create error:", error);
    const message = error?.message || t(L, "portal.error.unexpected");
    return liquid(portalHTML("error", { message: t(L, "portal.error.returnFailed", { error: message }), lang, settings }), { layout: false });
  }
}

// ─── HTML Templates ──────────────────────────────────────────

function portalHTML(view: string, data: any = {}): string {
  const lang = data.lang || "en";
  const L = getTranslations(lang);
  const _ = (key: string, vars?: Record<string, string | number>) => t(L, key, vars);
  const htmlLang = lang === "tr" ? "tr" : "en";
  const brandColor = data.settings?.brandColor || "#000000";
  const logoUrl = data.settings?.shopLogoUrl || "";
  const returnPolicy = data.settings?.returnPolicy || "";

  const renderLogo = (showSubtitle: boolean = false) => `
    <div class="logo">
      ${logoUrl ? `<img src="${logoUrl}" alt="${_("portal.title")}" style="max-height:48px; margin-bottom:12px;" />` : `<h1>${_("portal.title")}</h1>`}
      ${showSubtitle ? `<p>${_("portal.subtitle")}</p>` : ''}
    </div>
  `;

  const styles = `
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: #f6f6f7; color: #1a1a1a; }
      .portal { max-width: 600px; margin: 40px auto; padding: 0 16px; }
      .card { background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 16px; }
      .logo { text-align: center; margin-bottom: 24px; }
      .logo h1 { font-size: 24px; font-weight: 600; }
      .logo p { color: #6b7280; font-size: 14px; margin-top: 4px; }
      label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 6px; color: #374151; }
      input[type="text"], input[type="email"] {
        width: 100%; padding: 10px 14px; border: 1px solid #d1d5db; border-radius: 8px;
        font-size: 15px; margin-bottom: 16px; transition: border-color 0.2s;
      }
      input:focus { outline: none; border-color: ${brandColor}; box-shadow: 0 0 0 1px ${brandColor}; }
      .btn {
        width: 100%; padding: 12px; background: ${brandColor}; color: #fff; border: none;
        border-radius: 8px; font-size: 15px; font-weight: 500; cursor: pointer;
        transition: opacity 0.2s;
      }
      .btn:hover { opacity: 0.9; }
      .btn:disabled { background: #9ca3af; cursor: not-allowed; }
      .error { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
      .info { background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
      .order-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #e5e7eb; }
      .order-header h2 { font-size: 18px; }
      .order-header span { color: #6b7280; font-size: 14px; }
      .item { display: flex; align-items: center; padding: 16px 0; border-bottom: 1px solid #f3f4f6; }
      .item:last-child { border-bottom: none; }
      .item-img { width: 64px; height: 64px; border-radius: 8px; object-fit: cover; background: #f3f4f6; margin-right: 16px; flex-shrink: 0; }
      .item-info { flex: 1; }
      .item-title { font-size: 15px; font-weight: 500; }
      .item-variant { font-size: 13px; color: #6b7280; margin-top: 2px; }
      .item-price { font-size: 14px; font-weight: 500; margin-top: 4px; }
      .item-controls { display: flex; align-items: center; gap: 12px; }
      .item-controls input[type="checkbox"] { width: 20px; height: 20px; cursor: pointer; }
      .qty-select { padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; }
      .back-link { display: inline-block; color: #6b7280; font-size: 14px; text-decoration: none; margin-bottom: 16px; transition: color 0.1s; }
      .back-link:hover { color: ${brandColor}; }
      @media (max-width: 480px) { .portal { margin: 16px auto; } .card { padding: 20px; } .item-img { width: 48px; height: 48px; } }
    </style>
  `;

  if (view === "search") {
    return `
      <!DOCTYPE html>
      <html lang="${htmlLang}">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${_("portal.title")}</title></head>
      <body>
      ${styles}
      <div class="portal">
        <div class="card">
          ${renderLogo(true)}
          <form method="POST" action="/apps/returns">
            <input type="hidden" name="intent" value="search" />
            <input type="hidden" name="lang" value="${lang}" />
            <label for="orderName">${_("portal.orderNumber")}</label>
            <input type="text" id="orderName" name="orderName" placeholder="#1234" required />
            <label for="email">${_("portal.email")}</label>
            <input type="email" id="email" name="email" placeholder="email@example.com" required />
            <button type="submit" class="btn">${_("portal.search")}</button>
          </form>
        </div>
        <p style="text-align:center;font-size:12px;color:#9ca3af;margin-bottom:12px;">${_("portal.returnWindow", { days: data.returnWindowDays })}</p>
        ${returnPolicy ? `
          <div class="card" style="padding:20px; text-align:center;">
            <details>
              <summary style="cursor:pointer; font-weight:500; font-size:14px; color:${brandColor}; outline:none;">${_("portal.policyTitle")}</summary>
              <div style="margin-top:12px; font-size:13px; color:#4b5563; text-align:left; white-space:pre-wrap;">${returnPolicy}</div>
            </details>
          </div>
        ` : ""}
      </div>
      </body>
      </html>
    `;
  }

  if (view === "not_found") {
    return `
      <!DOCTYPE html>
      <html lang="${htmlLang}">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${_("portal.title")}</title></head>
      <body>
      ${styles}
      <div class="portal">
        <div class="card">
          ${renderLogo(false)}
          <div class="error">${_("portal.notFound", { order: data.orderName })}</div>
          <form method="POST" action="/apps/returns">
            <input type="hidden" name="intent" value="search" />
            <input type="hidden" name="lang" value="${lang}" />
            <label for="orderName">${_("portal.orderNumber")}</label>
            <input type="text" id="orderName" name="orderName" value="${data.orderName}" required />
            <label for="email">${_("portal.email")}</label>
            <input type="email" id="email" name="email" value="${data.email}" required />
            <button type="submit" class="btn">${_("portal.searchAgain")}</button>
          </form>
        </div>
      </div>
      </body>
      </html>
    `;
  }

  if (view === "tracker") {
    const r = data.returnRequest;
    return `
      <!DOCTYPE html>
      <html lang="${htmlLang}">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${_("portal.title")}</title></head>
      <body>
      ${styles}
      <div class="portal">
        <div class="card">
          ${renderLogo(false)}
          <div class="order-header">
            <h2>${_("portal.tracker.title")}</h2>
            <span>${data.orderName}</span>
          </div>
          <div style="margin-bottom:20px; text-align:center;">
            <span style="display:inline-block; padding:8px 16px; border-radius:20px; font-weight:600; font-size:14px; background:${r.status === 'APPROVED' ? '#dcfce7' : r.status === 'DECLINED' ? '#fee2e2' : '#fef3c7'}; color:${r.status === 'APPROVED' ? '#166534' : r.status === 'DECLINED' ? '#991b1b' : '#92400e'};">
              ${_("portal.tracker.status")}: ${r.status}
            </span>
          </div>
          <p style="margin-bottom:8px"><strong>${_("portal.tracker.reason")}:</strong> ${r.reason}</p>
          <p style="margin-bottom:20px"><strong>${_("portal.tracker.resolution")}:</strong> ${r.resolution?.type} (${r.resolution?.amount} ${r.resolution?.currency})</p>
          
          <h3 style="font-size:16px; margin-bottom:12px; border-bottom:1px solid #eee; padding-bottom:8px;">${_("portal.confirmation.items")}</h3>
          <div style="margin-bottom:24px">
            ${r.items.map((item: any) => `
              <div class="item">
                <div class="item-info">
                  <div class="item-title">${item.quantity}x ${item.title}</div>
                  <div class="item-price">${item.price} ${r.resolution?.currency}</div>
                </div>
              </div>
            `).join("")}
          </div>
          ${(data.fraudEvents && data.fraudEvents.length > 0) ? `
          <h3 style="font-size:16px; margin-bottom:12px; border-bottom:1px solid #eee; padding-bottom:8px;">Fraud Analiz Geçmişi</h3>
          <div style="margin-bottom:20px">
            ${data.fraudEvents.map((event: any) => `
              <div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:8px;background:#f9fafb;">
                <div style="font-size:13px;font-weight:600;">${event.rule} · ${event.outcome}</div>
                <div style="font-size:12px;color:#6b7280;">${new Date(event.createdAt).toLocaleString()}</div>
              </div>
            `).join("")}
          </div>
          ` : ""}
          
          <a href="/apps/returns" class="btn" style="display:block;text-align:center;text-decoration:none;">${_("portal.backHome")}</a>
        </div>
      </div>
      </body>
      </html>
    `;
  }

  if (view === "error") {
    return `
      <!DOCTYPE html>
      <html lang="${htmlLang}">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${_("portal.title")}</title></head>
      <body>
      ${styles}
      <div class="portal">
        <div class="card">
          ${renderLogo(false)}
          <div class="error">${data.message}</div>
          <a href="/apps/returns" class="btn" style="display:block;text-align:center;text-decoration:none;">${_("portal.goBack")}</a>
        </div>
      </div>
      </body>
      </html>
    `;
  }

  if (view === "items") {
    const itemsHTML = data.items.map((item: any, i: number) => `
      <div class="item">
        ${item.imageUrl ? `<img src="${item.imageUrl}" alt="${item.imageAlt}" class="item-img" />` : `<div class="item-img"></div>`}
        <div class="item-info">
          <div class="item-title">${item.title}</div>
          ${item.variantTitle ? `<div class="item-variant">${item.variantTitle}</div>` : ""}
          <div class="item-price">${data.order.total.currencyCode} ${item.price}</div>
        </div>
        <div class="item-controls">
          ${item.maxQuantity > 1 ? `
            <select name="qty_${i}" class="qty-select">
              ${Array.from({ length: item.maxQuantity }, (_, q) => `<option value="${q + 1}">${q + 1}</option>`).join("")}
            </select>
          ` : ""}
          <input type="checkbox" name="item_${i}" value="${item.fulfillmentLineItemId}" />
          <input type="hidden" name="meta_${i}" value='${JSON.stringify({
            fulfillmentLineItemId: item.fulfillmentLineItemId,
            productId: item.productId,
            variantId: item.variantId,
            title: item.title,
            price: item.price,
          })}' />
        </div>
      </div>
    `).join("");

    return `
      <!DOCTYPE html>
      <html lang="${htmlLang}">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${_("portal.title")}</title></head>
      <body>
      ${styles}
      <div class="portal">
        <div class="card">
          <div class="order-header">
            <h2>${_("portal.confirmation.order")} ${data.order.name}</h2>
            <span>${new Date(data.order.createdAt).toLocaleDateString(htmlLang === "tr" ? "tr-TR" : "en-US")}</span>
          </div>
          <div class="info">${_("portal.selectItems")}</div>
          <form method="POST" action="/apps/returns" id="returnForm">
            <input type="hidden" name="intent" value="select_items" />
            <input type="hidden" name="lang" value="${lang}" />
            <input type="hidden" name="orderId" value="${data.order.id}" />
            <input type="hidden" name="orderName" value="${data.order.name}" />
            <input type="hidden" name="email" value="${data.order.email}" />
            <input type="hidden" name="shop" value="${data.shop}" />
            <input type="hidden" name="customerId" value="${data.order.customerId}" />
            <input type="hidden" name="itemCount" value="${data.items.length}" />
            ${itemsHTML}
            <button type="submit" class="btn" style="margin-top: 20px;">${_("portal.continue")}</button>
          </form>
        </div>
      </div>
      <script>
        document.getElementById('returnForm').addEventListener('submit', function(e) {
          var checked = this.querySelectorAll('input[type="checkbox"]:checked');
          if (checked.length === 0) {
            e.preventDefault();
            alert('${_("portal.selectAtLeast")}');
          }
        });
      </script>
      </body>
      </html>
    `;
  }

  if (view === "reason") {
    const itemsSummary = data.selectedItems.map((item: any) =>
      `<div class="item" style="border-bottom:1px solid #f3f4f6;padding:12px 0;">
        <div class="item-info">
          <div class="item-title">${item.title}</div>
          <div class="item-variant">${_("portal.itemSummary", { qty: item.quantity, price: item.price })}</div>
        </div>
      </div>`
    ).join("");

    return `
      <!DOCTYPE html>
      <html lang="${htmlLang}">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${_("portal.selectReason")}</title></head>
      <body>
      ${styles}
      <style>
        .reason-option { display: block; padding: 14px 16px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 8px; cursor: pointer; transition: all 0.2s; }
        .reason-option:hover { border-color: #000; background: #fafafa; }
        .reason-option input[type="radio"] { margin-right: 10px; }
        .reason-option.selected { border-color: #000; background: #f9fafb; }
        .note-field { width: 100%; padding: 10px 14px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; resize: vertical; min-height: 60px; margin-top: 12px; display: none; }
        .note-field:focus { outline: none; border-color: #000; }
      </style>
      <div class="portal">
        <a href="/apps/returns" class="back-link">${_("portal.back")}</a>
        <div class="card">
          <h2 style="font-size:18px;margin-bottom:16px;">${_("portal.selectReason")}</h2>
          <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #e5e7eb;">
            ${itemsSummary}
          </div>
          <form method="POST" action="/apps/returns" id="reasonForm">
            <input type="hidden" name="intent" value="select_reason" />
            <input type="hidden" name="lang" value="${lang}" />
            <input type="hidden" name="orderId" value="${data.orderId}" />
            <input type="hidden" name="orderName" value="${data.orderName}" />
            <input type="hidden" name="email" value="${data.email}" />
            <input type="hidden" name="shop" value="${data.shop}" />
            <input type="hidden" name="customerId" value="${data.customerId}" />
            <input type="hidden" name="selectedItems" value='${JSON.stringify(data.selectedItems)}' />

            <label class="reason-option">
              <input type="radio" name="reason" value="SIZE" required /> ${_("portal.reason.size")}
            </label>
            <label class="reason-option">
              <input type="radio" name="reason" value="COLOR" /> ${_("portal.reason.color")}
            </label>
            <label class="reason-option">
              <input type="radio" name="reason" value="DEFECTIVE" /> ${_("portal.reason.defective")}
            </label>
            <label class="reason-option">
              <input type="radio" name="reason" value="UNWANTED" /> ${_("portal.reason.unwanted")}
            </label>
            <label class="reason-option">
              <input type="radio" name="reason" value="OTHER" id="otherRadio" /> ${_("portal.reason.other")}
            </label>
            <textarea name="reasonNote" class="note-field" id="noteField" placeholder="${_("portal.reason.note")}"></textarea>

            <div id="uploadBox" style="display:none; margin-top:16px;">
              <label style="font-weight:600; font-size:14px; margin-bottom:8px;">${_("portal.uploadLabel")}</label>
              <p style="font-size:13px; color:#6b7280; margin-bottom:8px;">${_("portal.uploadHelp")}</p>
              <input type="file" id="proofFileInput" accept="image/*" style="font-size:14px;" />
              <input type="hidden" name="proofImageBase64" id="proofImageBase64" />
              <div id="proofPreview" style="margin-top:8px; display:none;">
                <img src="" style="max-height:80px; border-radius:8px; border:1px solid #e5e7eb;" />
              </div>
            </div>

            <button type="submit" class="btn" style="margin-top:16px;">${_("portal.continue")}</button>
          </form>
        </div>
      </div>
      <script>
        document.getElementById('proofFileInput').addEventListener('change', function(e) {
          if (e.target.files && e.target.files[0]) {
            var reader = new FileReader();
            reader.onload = function(evt) {
              document.getElementById('proofImageBase64').value = evt.target.result;
              var preview = document.getElementById('proofPreview');
              preview.style.display = 'block';
              preview.querySelector('img').src = evt.target.result;
            };
            reader.readAsDataURL(e.target.files[0]);
          }
        });

        document.querySelectorAll('input[name="reason"]').forEach(function(r) {
          r.addEventListener('change', function() {
            document.getElementById('noteField').style.display = this.value === 'OTHER' ? 'block' : 'none';
            document.getElementById('uploadBox').style.display = this.value === 'DEFECTIVE' ? 'block' : 'none';
            document.querySelectorAll('.reason-option').forEach(function(o) { o.classList.remove('selected'); });
            this.closest('.reason-option').classList.add('selected');
          });
        });
      </script>
      </body>
      </html>
    `;
  }

  if (view === "resolution") {
    const totalAmount = data.selectedItems.reduce(
      (sum: number, item: any) => sum + parseFloat(item.price) * item.quantity, 0
    ).toFixed(2);
    const enableKeepIt = Boolean(data.settings?.enableKeepIt);
    const enablePriceDiffExchange = Boolean(data.settings?.enablePriceDiffExchange);
    const keepItMaxAmount = Number(data.settings?.keepItMaxAmount || 0);
    const canUseKeepIt = enableKeepIt && Number(totalAmount) <= keepItMaxAmount;
    const storeCreditBonusRate = Number(data.settings?.storeCreditBonusRate || 0);
    const bonusAmount = storeCreditBonusRate > 0
      ? (Number(totalAmount) * (1 + storeCreditBonusRate)).toFixed(2)
      : null;
    const orderedTypes = getResolutionOrderForReason(data.reason || "", data.settings);
    const cardHTML: Record<string, string> = {
      REFUND: `
            <div class="resolution-card" onclick="selectResolution('REFUND', this)">
              <h3>💰 ${_("portal.refund")}</h3>
              <p>${_("portal.refundDesc", { amount: totalAmount })}</p>
            </div>`,
      EXCHANGE: `
            <div class="resolution-card" onclick="selectResolution('EXCHANGE', this)">
              <h3>🔄 ${_("portal.exchange")}</h3>
              <p>${_("portal.exchangeDesc")}</p>
            </div>`,
      EXCHANGE_DIFFERENT_PRODUCT: `
            <div class="resolution-card" onclick="selectResolution('EXCHANGE_DIFFERENT_PRODUCT', this)">
              <h3>🧩 ${_("portal.exchangeDifferent")}</h3>
              <p>${_("portal.exchangeDifferentDesc")}</p>
            </div>`,
      EXCHANGE_WITH_PRICE_DIFF: `
            <div class="resolution-card" onclick="selectResolution('EXCHANGE_WITH_PRICE_DIFF', this)">
              <h3>💳 ${_("portal.exchangePriceDiff")}</h3>
              <p>${_("portal.exchangePriceDiffDesc")}</p>
            </div>`,
      STORE_CREDIT: `
            <div class="resolution-card" onclick="selectResolution('STORE_CREDIT', this)" style="position:relative;">
              ${bonusAmount ? `<div style="position:absolute;top:12px;right:12px;background:#16A34A;color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:20px;">+${Math.round(storeCreditBonusRate * 100)}% BONUS</div>` : ""}
              <h3>🏷️ ${_("portal.storeCredit")}</h3>
              ${bonusAmount
                ? `<p style="color:#16A34A;font-weight:600;">$${bonusAmount} store credit <span style="color:#9ca3af;font-weight:400;font-size:12px;">vs $${totalAmount} refund</span></p>
                   <p style="font-size:12px;color:#6b7280;margin-top:4px;">${_("portal.storeCreditBonusDesc") || "Get extra value when you choose store credit!"}</p>`
                : `<p>${_("portal.storeCreditDesc", { amount: totalAmount })}</p>`
              }
            </div>`,
      KEEP_IT: `
            <div class="resolution-card" onclick="selectResolution('KEEP_IT', this)">
              <h3>📦 ${_("portal.keepIt")}</h3>
              <p>${_("portal.keepItDesc")}</p>
            </div>`,
    };
    const visibleTypes = orderedTypes.filter((type) => {
      if (type === "EXCHANGE_WITH_PRICE_DIFF") return enablePriceDiffExchange;
      if (type === "KEEP_IT") return canUseKeepIt;
      return cardHTML[type] !== undefined;
    });

    return `
      <!DOCTYPE html>
      <html lang="${htmlLang}">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${_("portal.selectResolution")}</title></head>
      <body>
      ${styles}
      <style>
        .resolution-card { border: 2px solid #e5e7eb; border-radius: 12px; padding: 20px; margin-bottom: 12px; cursor: pointer; transition: all 0.2s; }
        .resolution-card:hover { border-color: #000; }
        .resolution-card h3 { font-size: 16px; margin-bottom: 4px; }
        .resolution-card p { font-size: 13px; color: #6b7280; }
        .resolution-card.selected { border-color: #000; background: #f9fafb; }
      </style>
      <div class="portal">
        <a href="/apps/returns" class="back-link">${_("portal.backHome")}</a>
        <div class="card">
          <h2 style="font-size:18px;margin-bottom:8px;">${_("portal.selectResolution")}</h2>
          <p style="color:#6b7280;font-size:14px;margin-bottom:20px;">${_("portal.totalAmount")}: <strong>${totalAmount}</strong></p>

          <form method="POST" action="/apps/returns" id="resolutionForm">
            <input type="hidden" name="intent" id="intentField" value="create_return" />
            <input type="hidden" name="lang" value="${lang}" />
            <input type="hidden" name="orderId" value="${data.orderId}" />
            <input type="hidden" name="orderName" value="${data.orderName}" />
            <input type="hidden" name="email" value="${data.email}" />
            <input type="hidden" name="shop" value="${data.shop}" />
            <input type="hidden" name="customerId" value="${data.customerId}" />
            <input type="hidden" name="selectedItems" value='${JSON.stringify(data.selectedItems)}' />
            <input type="hidden" name="reason" value="${data.reason}" />
            <input type="hidden" name="proofImageBase64" value="${data.proofImageBase64 || ''}" />
            <input type="hidden" name="resolutionType" id="resolutionType" value="" />

            ${visibleTypes.map((type) => cardHTML[type]).join("")}

            <button type="submit" class="btn" style="margin-top:16px;" id="submitBtn" disabled>${_("portal.submit")}</button>
          </form>
        </div>
      </div>
      <script>
        var submitted = false;
        var labels = { variant: '${_("portal.selectVariant")}', submit: '${_("portal.submit")}', submitting: '${_("portal.submitting")}', selectRes: '${_("portal.error.selectResolution")}' };
        function selectResolution(type, el) {
          document.getElementById('resolutionType').value = type;
          var needsVariantStep = ['EXCHANGE', 'EXCHANGE_DIFFERENT_PRODUCT', 'EXCHANGE_WITH_PRICE_DIFF'].includes(type);
          document.getElementById('intentField').value = needsVariantStep ? 'select_exchange_variants' : 'create_return';
          document.getElementById('submitBtn').textContent = needsVariantStep ? labels.variant : labels.submit;
          document.querySelectorAll('.resolution-card').forEach(function(c) { c.classList.remove('selected'); });
          el.classList.add('selected');
          document.getElementById('submitBtn').disabled = false;
        }
        document.getElementById('resolutionForm').addEventListener('submit', function(e) {
          if (!document.getElementById('resolutionType').value) { e.preventDefault(); alert(labels.selectRes); return; }
          if (submitted) { e.preventDefault(); return; }
          submitted = true;
          document.getElementById('submitBtn').disabled = true;
          document.getElementById('submitBtn').textContent = labels.submitting;
        });
      </script>
      </body>
      </html>
    `;
  }

  if (view === "exchange_variants") {
    const resolutionType = data.resolutionType || "EXCHANGE";
    const titleByType: Record<string, string> = {
      EXCHANGE: _("portal.exchangeVariant"),
      EXCHANGE_DIFFERENT_PRODUCT: _("portal.exchangeDifferent"),
      EXCHANGE_WITH_PRICE_DIFF: _("portal.exchangePriceDiff"),
    };
    const descByType: Record<string, string> = {
      EXCHANGE: _("portal.exchangeVariantDesc"),
      EXCHANGE_DIFFERENT_PRODUCT: _("portal.exchangeDifferentSelectDesc"),
      EXCHANGE_WITH_PRICE_DIFF: _("portal.exchangePriceDiffSelectDesc"),
    };
    const itemsHTML = data.selectedItems.map((item: any) => {
      const variantOptions = item.availableVariants?.length > 0
        ? item.availableVariants.map((v: any) =>
          `<option value="${v.id}">${v.title} — ${v.price}${v.inventoryQuantity <= 0 ? ` ${_("portal.outOfStock")}` : ""}</option>`
        ).join("")
        : `<option value="" disabled>${_("portal.noVariants")}</option>`;

      return `
        <div style="padding:16px 0;border-bottom:1px solid #f3f4f6;">
          <div style="font-weight:500;margin-bottom:4px;">${item.title}</div>
          <div style="font-size:13px;color:#6b7280;margin-bottom:8px;">${_("portal.current")}: ${item.variantId ? item.title : "—"} · ${item.quantity} pcs · ${item.price}</div>
          <label style="font-size:13px;font-weight:500;margin-bottom:4px;">${_("portal.selectNew")}</label>
          <select name="exchangeVariant_${item.fulfillmentLineItemId}" class="qty-select" style="width:100%;padding:10px;" required>
            <option value="">${_("portal.select")}</option>
            ${variantOptions}
          </select>
        </div>
      `;
    }).join("");

    const upsells: any[] = data.upsellProducts || [];
    const upsellHTML = upsells.length > 0 ? `
      <div style="margin-top:24px;">
        <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:12px;display:flex;align-items:center;gap:6px;">
          ✨ ${_("portal.upsell.title") || "You might also like"}
          <span style="font-size:11px;font-weight:500;color:#6B7280;">${_("portal.upsell.subtitle") || "Upgrade your exchange"}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;">
          ${upsells.map((p: any) => `
            <div class="upsell-card" data-product-id="${p.id}" onclick="selectUpsell(this)" style="border:2px solid #E5E7EB;border-radius:10px;padding:12px;cursor:pointer;transition:all 0.15s;position:relative;">
              ${p.imageUrl ? `<img src="${p.imageUrl}" alt="${p.imageAlt}" style="width:100%;height:90px;object-fit:cover;border-radius:6px;margin-bottom:8px;" />` : `<div style="width:100%;height:90px;background:#F3F4F6;border-radius:6px;margin-bottom:8px;display:flex;align-items:center;justify-content:center;font-size:24px;">📦</div>`}
              <div style="font-size:12px;font-weight:600;color:#111827;margin-bottom:4px;line-height:1.3;">${p.title}</div>
              <div style="font-size:13px;font-weight:700;color:#6366F1;">$${p.minPrice.toFixed(2)}</div>
              <select name="upsellVariant_${p.id}" style="width:100%;margin-top:6px;padding:5px;font-size:12px;border:1px solid #D1D5DB;border-radius:6px;display:none;" class="upsell-variant-select">
                <option value="">${_("portal.select") || "Select"}</option>
                ${p.variants.map((v: any) => `<option value="${v.id}">${v.title} — $${parseFloat(v.price).toFixed(2)}</option>`).join("")}
              </select>
              <div class="upsell-selected-badge" style="display:none;position:absolute;top:8px;right:8px;background:#6366F1;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;">✓ Selected</div>
            </div>
          `).join("")}
        </div>
        <p style="font-size:11px;color:#9CA3AF;margin-top:8px;">${_("portal.upsell.note") || "Selecting an upgrade will replace your exchange item."}</p>
      </div>
    ` : "";

    return `
      <!DOCTYPE html>
      <html lang="${htmlLang}">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titleByType[resolutionType] || _("portal.exchangeVariant")}</title></head>
      <body>
      ${styles}
      <style>
        .upsell-card:hover { border-color: #6366F1; box-shadow: 0 2px 8px rgba(99,102,241,0.15); }
        .upsell-card.selected { border-color: #6366F1; background: #F5F3FF; }
      </style>
      <div class="portal">
        <a href="/apps/returns" class="back-link">${_("portal.backHome")}</a>
        <div class="card">
          <h2 style="font-size:18px;margin-bottom:8px;">${titleByType[resolutionType] || _("portal.exchangeVariant")}</h2>
          <p style="color:#6b7280;font-size:14px;margin-bottom:20px;">${descByType[resolutionType] || _("portal.exchangeVariantDesc")}</p>

          <form method="POST" action="/apps/returns" id="exchangeForm">
            <input type="hidden" name="intent" value="create_return" />
            <input type="hidden" name="lang" value="${lang}" />
            <input type="hidden" name="orderId" value="${data.orderId}" />
            <input type="hidden" name="orderName" value="${data.orderName}" />
            <input type="hidden" name="email" value="${data.email}" />
            <input type="hidden" name="shop" value="${data.shop}" />
            <input type="hidden" name="customerId" value="${data.customerId}" />
            <input type="hidden" name="selectedItems" value='${JSON.stringify(data.selectedItems.map((i: any) => ({ fulfillmentLineItemId: i.fulfillmentLineItemId, productId: i.productId, variantId: i.variantId, title: i.title, price: i.price, quantity: i.quantity })))}' />
            <input type="hidden" name="reason" value="${data.reason}" />
            <input type="hidden" name="proofImageBase64" value="${data.proofImageBase64 || ''}" />
            <input type="hidden" name="resolutionType" value="${resolutionType}" />
            <input type="hidden" name="upsellProductId" id="upsellProductId" value="" />
            <input type="hidden" name="upsellVariantId" id="upsellVariantId" value="" />

            ${itemsHTML}
            ${upsellHTML}

            <button type="submit" class="btn" style="margin-top:20px;" id="exchangeBtn">${_("portal.exchangeSubmit")}</button>
          </form>
        </div>
      </div>
      <script>
        var submitted = false;

        function selectUpsell(card) {
          document.querySelectorAll('.upsell-card').forEach(function(c) {
            c.classList.remove('selected');
            c.querySelector('.upsell-selected-badge').style.display = 'none';
            c.querySelector('.upsell-variant-select').style.display = 'none';
          });
          card.classList.add('selected');
          card.querySelector('.upsell-selected-badge').style.display = 'block';
          var sel = card.querySelector('.upsell-variant-select');
          sel.style.display = 'block';
          document.getElementById('upsellProductId').value = card.dataset.productId;
          sel.addEventListener('change', function() {
            document.getElementById('upsellVariantId').value = sel.value;
          });
        }

        document.getElementById('exchangeForm').addEventListener('submit', function(e) {
          if (submitted) { e.preventDefault(); return; }
          submitted = true;
          document.getElementById('exchangeBtn').disabled = true;
          document.getElementById('exchangeBtn').textContent = '${_("portal.submitting")}';
        });
      </script>
      </body>
      </html>
    `;
  }

  if (view === "confirmation") {
    const itemsHTML = data.items.map((item: any) =>
      `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f3f4f6;">
        <span>${item.title} × ${item.quantity}</span>
        <span>${(parseFloat(item.price) * item.quantity).toFixed(2)}</span>
      </div>`
    ).join("");

    const resolutionLabels: Record<string, string> = {
      REFUND: _("portal.refund"),
      EXCHANGE: _("portal.exchange"),
      EXCHANGE_DIFFERENT_PRODUCT: _("portal.exchangeDifferent"),
      EXCHANGE_WITH_PRICE_DIFF: _("portal.exchangePriceDiff"),
      STORE_CREDIT: _("portal.storeCredit"),
      KEEP_IT: _("portal.keepIt"),
    };
    const resolutionLabel = resolutionLabels[data.resolutionType] || data.resolutionType;
    const statusMsg = data.isAutoApproved
      ? _("portal.confirmation.autoApproved")
      : _("portal.confirmation.pending");

    return `
      <!DOCTYPE html>
      <html lang="${htmlLang}">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${_("portal.confirmation.title")}</title></head>
      <body>
      ${styles}
      <div class="portal">
        <div class="card" style="text-align:center;">
          <div style="font-size:48px;margin-bottom:16px;">✅</div>
          <h2 style="font-size:20px;margin-bottom:8px;">${_("portal.confirmation.title")}</h2>
          <p style="color:#6b7280;font-size:14px;margin-bottom:24px;">${statusMsg}</p>
          ${data.fraudWarning ? `
          <div style="text-align:left;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:12px;margin-bottom:16px;color:#9a3412;font-size:13px;">
            ⚠️ ${data.fraudWarning}
          </div>
          ` : ""}

          <div style="text-align:left;background:#f9fafb;border-radius:8px;padding:16px;margin-bottom:16px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
              <span style="color:#6b7280;font-size:13px;">${_("portal.confirmation.order")}</span>
              <span style="font-weight:500;">${data.orderName}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
              <span style="color:#6b7280;font-size:13px;">${_("portal.confirmation.returnId")}</span>
              <span style="font-weight:500;font-size:13px;">${data.returnId}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
              <span style="color:#6b7280;font-size:13px;">${_("portal.confirmation.reason")}</span>
              <span style="font-weight:500;">${data.reason}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
              <span style="color:#6b7280;font-size:13px;">${_("portal.confirmation.resolution")}</span>
              <span style="font-weight:500;">${resolutionLabel}</span>
            </div>
            <div style="display:flex;justify-content:space-between;">
              <span style="color:#6b7280;font-size:13px;">${_("portal.confirmation.amount")}</span>
              <span style="font-weight:600;">${data.totalAmount}</span>
            </div>
            ${data.storeCreditBonus ? `
            <div style="margin-top:10px;padding:10px 14px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span style="font-size:13px;color:#166534;font-weight:600;">🎁 Store Credit Bonus</span>
                <span style="font-size:13px;color:#166534;font-weight:700;">+$${data.storeCreditBonus.extra} (+${data.storeCreditBonus.rate}%)</span>
              </div>
              <div style="font-size:11px;color:#16A34A;margin-top:2px;">Base: $${data.baseAmount} + Bonus: $${data.storeCreditBonus.extra} = $${data.totalAmount} total credit</div>
            </div>
            ` : ""}
            ${data.priceDifference ? `
            <div style="display:flex;justify-content:space-between;margin-top:8px;">
              <span style="color:#6b7280;font-size:13px;">${_("portal.confirmation.priceDifference")}</span>
              <span style="font-weight:600;">${data.priceDifference}</span>
            </div>
            ` : ""}
            ${data.discountCode ? `
            <div style="display:flex;justify-content:space-between;margin-top:8px;">
              <span style="color:#6b7280;font-size:13px;">${_("portal.confirmation.discountCode")}</span>
              <span style="font-weight:600;">${data.discountCode}</span>
            </div>
            ` : ""}
            ${data.paymentLinkUrl ? `
            <div style="margin-top:12px;">
              <a href="${data.paymentLinkUrl}" target="_blank" rel="noopener noreferrer" class="btn" style="text-decoration:none;text-align:center;display:block;">
                ${_("portal.confirmation.paymentLink")}
              </a>
            </div>
            ` : ""}
          </div>

          <div style="text-align:left;margin-bottom:16px;">
            <p style="font-size:13px;font-weight:500;margin-bottom:8px;">${_("portal.confirmation.items")}</p>
            ${itemsHTML}
          </div>

          <a href="/apps/returns" class="btn" style="display:block;text-decoration:none;text-align:center;">${_("portal.goHome")}</a>
        </div>
      </div>
      </body>
      </html>
    `;
  }

  return `<!DOCTYPE html><html lang="${htmlLang}"><head><meta charset="utf-8"></head><body>${styles}<div class="portal"><div class="card"><p>${_("portal.error.unexpected")}</p></div></div></body></html>`;
}
