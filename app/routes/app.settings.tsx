import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useOutletContext, useRevalidator } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  TextField,
  Checkbox,
  Button,
  Banner,
  Divider,
  Badge,
  InlineStack,
  Select,
  Tabs,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import type { Locale } from "../services/i18n-admin";

type CatalogOption = { id: string; title: string };
type CustomerOption = { email: string; label: string };

function parseJsonMap(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function parseJsonReason(raw: string | null | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) out[k] = v.map((item) => String(item)).filter(Boolean);
    }
    return out;
  } catch {
    return {};
  }
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const settings = await prisma.storeSettings.findUnique({
    where: { shop: session.shop },
  });

  let products: CatalogOption[] = [];
  let collections: CatalogOption[] = [];
  let customers: CustomerOption[] = [];
  try {
    const response = await admin.graphql(
      `#graphql
        query settingsData {
          products(first: 40, sortKey: TITLE) {
            edges { node { id title } }
          }
          collections(first: 40, sortKey: TITLE) {
            edges { node { id title } }
          }
          customers(first: 40, reverse: true) {
            edges { node { email firstName lastName } }
          }
        }
      `,
    );
    const data = await response.json();
    products = (data.data?.products?.edges || []).map((edge: any) => ({
      id: edge.node.id,
      title: edge.node.title,
    }));
    collections = (data.data?.collections?.edges || []).map((edge: any) => ({
      id: edge.node.id,
      title: edge.node.title,
    }));
    customers = (data.data?.customers?.edges || [])
      .map((edge: any) => edge.node)
      .filter((node: any) => node.email)
      .map((node: any) => ({
        email: node.email,
        label: `${[node.firstName, node.lastName].filter(Boolean).join(" ").trim() || node.email} (${node.email})`,
      }));
  } catch {
    products = [];
    collections = [];
    customers = [];
  }

  return {
    settings: settings
      ? { ...settings, createdAt: settings.createdAt.toISOString(), updatedAt: settings.updatedAt.toISOString() }
      : null,
    shop: session.shop,
    products,
    collections,
    customers,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const returnWindowDays = parseInt(formData.get("returnWindowDays") as string) || 30;
  const isAutoApprove = formData.get("isAutoApprove") === "true";
  const merchantAddress = (formData.get("merchantAddress") as string) || "";
  const shippoApiKey = (formData.get("shippoApiKey") as string) || "";
  const locale = (formData.get("locale") as string) || "en";
  const returnPolicy = (formData.get("returnPolicy") as string) || "";
  const brandColor = (formData.get("brandColor") as string) || "#000000";
  const enableKeepIt = formData.get("enableKeepIt") === "true";
  const keepItMaxAmount = parseFloat((formData.get("keepItMaxAmount") as string) || "0");
  const enablePriceDiffExchange = formData.get("enablePriceDiffExchange") === "true";
  const enableStoreCreditDiscountCode = formData.get("enableStoreCreditDiscountCode") === "true";
  const storeCreditBonusRate = parseFloat((formData.get("storeCreditBonusRate") as string) || "0");
  const productReturnWindowsJson = (formData.get("productReturnWindowsJson") as string) || "{}";
  const collectionReturnWindowsJson = (formData.get("collectionReturnWindowsJson") as string) || "{}";
  const nonReturnableProductIds = parseJsonArray(formData.get("nonReturnableProductIds") as string);
  const nonReturnableCollectionIds = parseJsonArray(formData.get("nonReturnableCollectionIds") as string);
  const excludeDiscountedItems = formData.get("excludeDiscountedItems") === "true";
  const minimumOrderAmount = parseFloat((formData.get("minimumOrderAmount") as string) || "0");
  const maxReturnsPerCustomer = parseInt((formData.get("maxReturnsPerCustomer") as string) || "0", 10) || 0;
  const autoApproveUnderAmount = parseFloat((formData.get("autoApproveUnderAmount") as string) || "0");
  const blockedCustomerEmails = parseJsonArray(formData.get("blockedCustomerEmails") as string);
  const reasonPriorityJson = (formData.get("reasonPriorityJson") as string) || "{}";
  const enableAutoCustomerEmail = formData.get("enableAutoCustomerEmail") === "true";
  const emailProvider = (formData.get("emailProvider") as string) || "RESEND";
  const resendApiKey = (formData.get("resendApiKey") as string) || "";
  const emailFrom = (formData.get("emailFrom") as string) || "";
  const emailReplyTo = (formData.get("emailReplyTo") as string) || "";
  const merchantNotificationEmail = (formData.get("merchantNotificationEmail") as string) || "";
  const enableMerchantNewReturnNotification = formData.get("enableMerchantNewReturnNotification") === "true";
  const emailTemplateHeaderText = (formData.get("emailTemplateHeaderText") as string) || "";
  const emailTemplateFooterText = (formData.get("emailTemplateFooterText") as string) || "";
  const emailTemplateReceived = (formData.get("emailTemplateReceived") as string) || "";
  const emailTemplateApproved = (formData.get("emailTemplateApproved") as string) || "";
  const emailTemplateDeclined = (formData.get("emailTemplateDeclined") as string) || "";
  const emailTemplateCompleted = (formData.get("emailTemplateCompleted") as string) || "";
  const enableSmsNotifications = formData.get("enableSmsNotifications") === "true";
  const smsWebhookUrl = (formData.get("smsWebhookUrl") as string) || "";
  const enableWhatsAppNotifications = formData.get("enableWhatsAppNotifications") === "true";
  const whatsappWebhookUrl = (formData.get("whatsappWebhookUrl") as string) || "";
  const enableFlowWebhook = formData.get("enableFlowWebhook") === "true";
  const flowWebhookUrl = (formData.get("flowWebhookUrl") as string) || "";
  const enableKlaviyo = formData.get("enableKlaviyo") === "true";
  const klaviyoApiKey = (formData.get("klaviyoApiKey") as string) || "";
  const enableSlackNotifications = formData.get("enableSlackNotifications") === "true";
  const slackWebhookUrl = (formData.get("slackWebhookUrl") as string) || "";
  const enableGorgias = formData.get("enableGorgias") === "true";
  const gorgiasWebhookUrl = (formData.get("gorgiasWebhookUrl") as string) || "";
  const enableZendesk = formData.get("enableZendesk") === "true";
  const zendeskWebhookUrl = (formData.get("zendeskWebhookUrl") as string) || "";
  const shippingProvider = (formData.get("shippingProvider") as string) || "SHIPPO";
  const easypostApiKey = (formData.get("easypostApiKey") as string) || "";
  const blockMultipleReturnsSameOrder = formData.get("blockMultipleReturnsSameOrder") === "true";
  const requirePhotoForFraudReasons = formData.get("requirePhotoForFraudReasons") === "true";
  const highReturnRateThreshold = parseFloat((formData.get("highReturnRateThreshold") as string) || "0.5");
  const wardrobingWindowDays = parseInt((formData.get("wardrobingWindowDays") as string) || "30", 10) || 30;
  const wardrobingMaxReturns = parseInt((formData.get("wardrobingMaxReturns") as string) || "3", 10) || 3;
  const ipRepeatWindowHours = parseInt((formData.get("ipRepeatWindowHours") as string) || "24", 10) || 24;
  const ipRepeatMaxReturns = parseInt((formData.get("ipRepeatMaxReturns") as string) || "2", 10) || 2;
  const resolutionRulesJson = (formData.get("resolutionRulesJson") as string) || "[]";

  await prisma.storeSettings.upsert({
    where: { shop: session.shop },
    update: {
      returnWindowDays,
      isAutoApprove,
      merchantAddress,
      shippoApiKey: shippoApiKey || null,
      shippingProvider,
      easypostApiKey: easypostApiKey || null,
      locale,
      returnPolicy,
      brandColor,
      enableKeepIt,
      keepItMaxAmount,
      enablePriceDiffExchange,
      enableStoreCreditDiscountCode,
      storeCreditBonusRate,
      productReturnWindowsJson,
      collectionReturnWindowsJson,
      nonReturnableProductIds: nonReturnableProductIds.join("\n") || null,
      nonReturnableCollectionIds: nonReturnableCollectionIds.join("\n") || null,
      excludeDiscountedItems,
      minimumOrderAmount,
      maxReturnsPerCustomer,
      autoApproveUnderAmount,
      blockedCustomerEmails: blockedCustomerEmails.join("\n") || null,
      reasonPriorityJson,
      enableAutoCustomerEmail,
      emailProvider,
      resendApiKey: resendApiKey || null,
      emailFrom: emailFrom || null,
      emailReplyTo: emailReplyTo || null,
      merchantNotificationEmail: merchantNotificationEmail || null,
      enableMerchantNewReturnNotification,
      emailTemplateHeaderText: emailTemplateHeaderText || null,
      emailTemplateFooterText: emailTemplateFooterText || null,
      emailTemplateReceived: emailTemplateReceived || null,
      emailTemplateApproved: emailTemplateApproved || null,
      emailTemplateDeclined: emailTemplateDeclined || null,
      emailTemplateCompleted: emailTemplateCompleted || null,
      enableSmsNotifications,
      smsWebhookUrl: smsWebhookUrl || null,
      enableWhatsAppNotifications,
      whatsappWebhookUrl: whatsappWebhookUrl || null,
      enableFlowWebhook,
      flowWebhookUrl: flowWebhookUrl || null,
      enableKlaviyo,
      klaviyoApiKey: klaviyoApiKey || null,
      enableSlackNotifications,
      slackWebhookUrl: slackWebhookUrl || null,
      enableGorgias,
      gorgiasWebhookUrl: gorgiasWebhookUrl || null,
      enableZendesk,
      zendeskWebhookUrl: zendeskWebhookUrl || null,
      blockMultipleReturnsSameOrder,
      requirePhotoForFraudReasons,
      highReturnRateThreshold,
      wardrobingWindowDays,
      wardrobingMaxReturns,
      ipRepeatWindowHours,
      ipRepeatMaxReturns,
      resolutionRulesJson,
    },
    create: {
      shop: session.shop,
      returnWindowDays,
      isAutoApprove,
      merchantAddress,
      shippoApiKey: shippoApiKey || null,
      shippingProvider,
      easypostApiKey: easypostApiKey || null,
      locale,
      returnPolicy,
      brandColor,
      enableKeepIt,
      keepItMaxAmount,
      enablePriceDiffExchange,
      enableStoreCreditDiscountCode,
      storeCreditBonusRate,
      productReturnWindowsJson,
      collectionReturnWindowsJson,
      nonReturnableProductIds: nonReturnableProductIds.join("\n") || null,
      nonReturnableCollectionIds: nonReturnableCollectionIds.join("\n") || null,
      excludeDiscountedItems,
      minimumOrderAmount,
      maxReturnsPerCustomer,
      autoApproveUnderAmount,
      blockedCustomerEmails: blockedCustomerEmails.join("\n") || null,
      reasonPriorityJson,
      enableAutoCustomerEmail,
      emailProvider,
      resendApiKey: resendApiKey || null,
      emailFrom: emailFrom || null,
      emailReplyTo: emailReplyTo || null,
      merchantNotificationEmail: merchantNotificationEmail || null,
      enableMerchantNewReturnNotification,
      emailTemplateHeaderText: emailTemplateHeaderText || null,
      emailTemplateFooterText: emailTemplateFooterText || null,
      emailTemplateReceived: emailTemplateReceived || null,
      emailTemplateApproved: emailTemplateApproved || null,
      emailTemplateDeclined: emailTemplateDeclined || null,
      emailTemplateCompleted: emailTemplateCompleted || null,
      enableSmsNotifications,
      smsWebhookUrl: smsWebhookUrl || null,
      enableWhatsAppNotifications,
      whatsappWebhookUrl: whatsappWebhookUrl || null,
      enableFlowWebhook,
      flowWebhookUrl: flowWebhookUrl || null,
      enableKlaviyo,
      klaviyoApiKey: klaviyoApiKey || null,
      enableSlackNotifications,
      slackWebhookUrl: slackWebhookUrl || null,
      enableGorgias,
      gorgiasWebhookUrl: gorgiasWebhookUrl || null,
      enableZendesk,
      zendeskWebhookUrl: zendeskWebhookUrl || null,
      blockMultipleReturnsSameOrder,
      requirePhotoForFraudReasons,
      highReturnRateThreshold,
      wardrobingWindowDays,
      wardrobingMaxReturns,
      ipRepeatWindowHours,
      ipRepeatMaxReturns,
      resolutionRulesJson,
    },
  });

  return { success: true };
};

export default function Settings() {
  const { settings, products, collections, customers } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const isSubmitting = navigation.state === "submitting";
  const { t, locale: currentLocale } = useOutletContext<{ locale: Locale; t: Record<string, string> }>();
  const [selectedTab, setSelectedTab] = useState(0);

  const [returnWindowDays, setReturnWindowDays] = useState(String(settings?.returnWindowDays ?? 30));
  const [isAutoApprove, setIsAutoApprove] = useState(settings?.isAutoApprove ?? false);
  const [merchantAddress, setMerchantAddress] = useState(settings?.merchantAddress ?? "");
  const [shippoApiKey, setShippoApiKey] = useState(settings?.shippoApiKey ?? "");
  const [shippingProvider, setShippingProvider] = useState(settings?.shippingProvider ?? "SHIPPO");
  const [easypostApiKey, setEasypostApiKey] = useState(settings?.easypostApiKey ?? "");
  const [locale, setLocale] = useState(settings?.locale ?? "en");
  const [returnPolicy, setReturnPolicy] = useState(settings?.returnPolicy ?? "");
  const [enableKeepIt, setEnableKeepIt] = useState(settings?.enableKeepIt ?? false);
  const [keepItMaxAmount, setKeepItMaxAmount] = useState(
    settings?.keepItMaxAmount ? String(settings.keepItMaxAmount) : "0",
  );
  const [enablePriceDiffExchange, setEnablePriceDiffExchange] = useState(settings?.enablePriceDiffExchange ?? false);
  const [enableStoreCreditDiscountCode, setEnableStoreCreditDiscountCode] = useState(
    settings?.enableStoreCreditDiscountCode ?? false,
  );
  const [storeCreditBonusRate, setStoreCreditBonusRate] = useState(
    settings?.storeCreditBonusRate ? String(Number(settings.storeCreditBonusRate) * 100) : "0",
  );
  const [productWindows, setProductWindows] = useState<Record<string, string>>(() => {
    const parsed = parseJsonMap(settings?.productReturnWindowsJson);
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
  });
  const [collectionWindows, setCollectionWindows] = useState<Record<string, string>>(() => {
    const parsed = parseJsonMap(settings?.collectionReturnWindowsJson);
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
  });
  const [nonReturnableProductIds, setNonReturnableProductIds] = useState<string[]>(
    (settings?.nonReturnableProductIds || "").split(/\n|,/).map((v: string) => v.trim()).filter(Boolean),
  );
  const [nonReturnableCollectionIds, setNonReturnableCollectionIds] = useState<string[]>(
    (settings?.nonReturnableCollectionIds || "").split(/\n|,/).map((v: string) => v.trim()).filter(Boolean),
  );
  const [excludeDiscountedItems, setExcludeDiscountedItems] = useState(settings?.excludeDiscountedItems ?? false);
  const [minimumOrderAmount, setMinimumOrderAmount] = useState(
    settings?.minimumOrderAmount ? String(settings.minimumOrderAmount) : "0",
  );
  const [maxReturnsPerCustomer, setMaxReturnsPerCustomer] = useState(
    settings?.maxReturnsPerCustomer ? String(settings.maxReturnsPerCustomer) : "0",
  );
  const [autoApproveUnderAmount, setAutoApproveUnderAmount] = useState(
    settings?.autoApproveUnderAmount ? String(settings.autoApproveUnderAmount) : "0",
  );
  const [blockedCustomerEmails, setBlockedCustomerEmails] = useState<string[]>(
    (settings?.blockedCustomerEmails || "").split(/\n|,/).map((v: string) => v.trim()).filter(Boolean),
  );
  const [reasonPriority, setReasonPriority] = useState<Record<string, string[]>>(
    parseJsonReason(settings?.reasonPriorityJson),
  );
  const [enableAutoCustomerEmail, setEnableAutoCustomerEmail] = useState(settings?.enableAutoCustomerEmail ?? false);
  const [emailProvider, setEmailProvider] = useState(settings?.emailProvider ?? "RESEND");
  const [resendApiKey, setResendApiKey] = useState(settings?.resendApiKey ?? "");
  const [emailFrom, setEmailFrom] = useState(settings?.emailFrom ?? "");
  const [emailReplyTo, setEmailReplyTo] = useState(settings?.emailReplyTo ?? "");
  const [merchantNotificationEmail, setMerchantNotificationEmail] = useState(settings?.merchantNotificationEmail ?? "");
  const [enableMerchantNewReturnNotification, setEnableMerchantNewReturnNotification] = useState(
    settings?.enableMerchantNewReturnNotification ?? false,
  );
  const [emailTemplateHeaderText, setEmailTemplateHeaderText] = useState(settings?.emailTemplateHeaderText ?? "ReturnEase");
  const [emailTemplateFooterText, setEmailTemplateFooterText] = useState(settings?.emailTemplateFooterText ?? "ReturnEase ekibi");
  const [emailTemplateReceived, setEmailTemplateReceived] = useState(
    settings?.emailTemplateReceived ?? "İade talebiniz alındı. Sipariş: {{orderName}}",
  );
  const [emailTemplateApproved, setEmailTemplateApproved] = useState(
    settings?.emailTemplateApproved ?? "İade talebiniz onaylandı. Sipariş: {{orderName}}",
  );
  const [emailTemplateDeclined, setEmailTemplateDeclined] = useState(
    settings?.emailTemplateDeclined ?? "İade talebiniz reddedildi. Sipariş: {{orderName}}",
  );
  const [emailTemplateCompleted, setEmailTemplateCompleted] = useState(
    settings?.emailTemplateCompleted ?? "İade süreciniz tamamlandı. Sipariş: {{orderName}}",
  );
  const [enableSmsNotifications, setEnableSmsNotifications] = useState(settings?.enableSmsNotifications ?? false);
  const [smsWebhookUrl, setSmsWebhookUrl] = useState(settings?.smsWebhookUrl ?? "");
  const [enableWhatsAppNotifications, setEnableWhatsAppNotifications] = useState(settings?.enableWhatsAppNotifications ?? false);
  const [whatsappWebhookUrl, setWhatsappWebhookUrl] = useState(settings?.whatsappWebhookUrl ?? "");
  const [enableFlowWebhook, setEnableFlowWebhook] = useState(settings?.enableFlowWebhook ?? false);
  const [flowWebhookUrl, setFlowWebhookUrl] = useState(settings?.flowWebhookUrl ?? "");
  const [enableKlaviyo, setEnableKlaviyo] = useState(settings?.enableKlaviyo ?? false);
  const [klaviyoApiKey, setKlaviyoApiKey] = useState(settings?.klaviyoApiKey ?? "");
  const [enableSlackNotifications, setEnableSlackNotifications] = useState(settings?.enableSlackNotifications ?? false);
  const [slackWebhookUrl, setSlackWebhookUrl] = useState(settings?.slackWebhookUrl ?? "");
  const [enableGorgias, setEnableGorgias] = useState(settings?.enableGorgias ?? false);
  const [gorgiasWebhookUrl, setGorgiasWebhookUrl] = useState(settings?.gorgiasWebhookUrl ?? "");
  const [enableZendesk, setEnableZendesk] = useState(settings?.enableZendesk ?? false);
  const [zendeskWebhookUrl, setZendeskWebhookUrl] = useState(settings?.zendeskWebhookUrl ?? "");
  const [blockMultipleReturnsSameOrder, setBlockMultipleReturnsSameOrder] = useState(
    settings?.blockMultipleReturnsSameOrder ?? true,
  );
  const [requirePhotoForFraudReasons, setRequirePhotoForFraudReasons] = useState(
    settings?.requirePhotoForFraudReasons ?? true,
  );
  const [highReturnRateThreshold, setHighReturnRateThreshold] = useState(
    settings?.highReturnRateThreshold ? String(settings.highReturnRateThreshold) : "0.5",
  );
  const [wardrobingWindowDays, setWardrobingWindowDays] = useState(
    settings?.wardrobingWindowDays ? String(settings.wardrobingWindowDays) : "30",
  );
  const [wardrobingMaxReturns, setWardrobingMaxReturns] = useState(
    settings?.wardrobingMaxReturns ? String(settings.wardrobingMaxReturns) : "3",
  );
  const [ipRepeatWindowHours, setIpRepeatWindowHours] = useState(
    settings?.ipRepeatWindowHours ? String(settings.ipRepeatWindowHours) : "24",
  );
  const [ipRepeatMaxReturns, setIpRepeatMaxReturns] = useState(
    settings?.ipRepeatMaxReturns ? String(settings.ipRepeatMaxReturns) : "2",
  );
  const [resolutionRules, setResolutionRules] = useState<Array<{ id: string; condition: string; value: string; resolution: string }>>(() => {
    try { return JSON.parse(settings?.resolutionRulesJson || "[]"); } catch { return []; }
  });
  const [saved, setSaved] = useState(false);
  const [customerSearch, setCustomerSearch] = useState("");

  const POLICY_PRESETS = [
    {
      label: t["settings.policyPreset1Label"] || "Standard (30-day)",
      text: t["settings.policyPreset1"] || "We accept returns within 30 days of delivery. Items must be unused, unwashed, and in their original packaging with tags attached. To initiate a return, please use our returns portal. Once we receive and inspect the item, your refund will be processed within 5–7 business days.",
    },
    {
      label: t["settings.policyPreset2Label"] || "Flexible (Exchange-first)",
      text: t["settings.policyPreset2"] || "We want you to love your purchase. If something isn't right, we offer exchanges or store credit within 45 days of delivery. Refunds are available within 14 days of delivery. Items must be in original condition. Start your return through our portal and we'll guide you through the process.",
    },
    {
      label: t["settings.policyPreset3Label"] || "Strict (Final sale)",
      text: t["settings.policyPreset3"] || "Returns are accepted within 14 days of delivery for defective or incorrect items only. All sale items are final sale and cannot be returned or exchanged. Items must be returned in their original condition and packaging. Please contact us before initiating a return.",
    },
  ];

  const handleSave = () => {
    setSaved(false);
    const formData = new FormData();
    formData.set("returnWindowDays", returnWindowDays);
    formData.set("isAutoApprove", String(isAutoApprove));
    formData.set("merchantAddress", merchantAddress);
    formData.set("shippoApiKey", shippoApiKey);
    formData.set("shippingProvider", shippingProvider);
    formData.set("easypostApiKey", easypostApiKey);
    formData.set("locale", locale);
    formData.set("returnPolicy", returnPolicy);
    formData.set("enableKeepIt", String(enableKeepIt));
    formData.set("keepItMaxAmount", keepItMaxAmount);
    formData.set("enablePriceDiffExchange", String(enablePriceDiffExchange));
    formData.set("enableStoreCreditDiscountCode", String(enableStoreCreditDiscountCode));
    formData.set("storeCreditBonusRate", String(parseFloat(storeCreditBonusRate || "0") / 100));
    formData.set(
      "productReturnWindowsJson",
      JSON.stringify(
        Object.fromEntries(
          Object.entries(productWindows)
            .map(([id, days]) => [id, Number(days)] as [string, number])
            .filter(([, days]) => Number.isFinite(days) && days > 0),
        ),
      ),
    );
    formData.set(
      "collectionReturnWindowsJson",
      JSON.stringify(
        Object.fromEntries(
          Object.entries(collectionWindows)
            .map(([id, days]) => [id, Number(days)] as [string, number])
            .filter(([, days]) => Number.isFinite(days) && days > 0),
        ),
      ),
    );
    formData.set("nonReturnableProductIds", JSON.stringify(nonReturnableProductIds));
    formData.set("nonReturnableCollectionIds", JSON.stringify(nonReturnableCollectionIds));
    formData.set("excludeDiscountedItems", String(excludeDiscountedItems));
    formData.set("minimumOrderAmount", minimumOrderAmount);
    formData.set("maxReturnsPerCustomer", maxReturnsPerCustomer);
    formData.set("autoApproveUnderAmount", autoApproveUnderAmount);
    formData.set("blockedCustomerEmails", JSON.stringify(blockedCustomerEmails));
    formData.set("reasonPriorityJson", JSON.stringify(reasonPriority));
    formData.set("enableAutoCustomerEmail", String(enableAutoCustomerEmail));
    formData.set("emailProvider", emailProvider);
    formData.set("resendApiKey", resendApiKey);
    formData.set("emailFrom", emailFrom);
    formData.set("emailReplyTo", emailReplyTo);
    formData.set("merchantNotificationEmail", merchantNotificationEmail);
    formData.set("enableMerchantNewReturnNotification", String(enableMerchantNewReturnNotification));
    formData.set("emailTemplateHeaderText", emailTemplateHeaderText);
    formData.set("emailTemplateFooterText", emailTemplateFooterText);
    formData.set("emailTemplateReceived", emailTemplateReceived);
    formData.set("emailTemplateApproved", emailTemplateApproved);
    formData.set("emailTemplateDeclined", emailTemplateDeclined);
    formData.set("emailTemplateCompleted", emailTemplateCompleted);
    formData.set("enableSmsNotifications", String(enableSmsNotifications));
    formData.set("smsWebhookUrl", smsWebhookUrl);
    formData.set("enableWhatsAppNotifications", String(enableWhatsAppNotifications));
    formData.set("whatsappWebhookUrl", whatsappWebhookUrl);
    formData.set("enableFlowWebhook", String(enableFlowWebhook));
    formData.set("flowWebhookUrl", flowWebhookUrl);
    formData.set("enableKlaviyo", String(enableKlaviyo));
    formData.set("klaviyoApiKey", klaviyoApiKey);
    formData.set("enableSlackNotifications", String(enableSlackNotifications));
    formData.set("slackWebhookUrl", slackWebhookUrl);
    formData.set("enableGorgias", String(enableGorgias));
    formData.set("gorgiasWebhookUrl", gorgiasWebhookUrl);
    formData.set("enableZendesk", String(enableZendesk));
    formData.set("zendeskWebhookUrl", zendeskWebhookUrl);
    formData.set("blockMultipleReturnsSameOrder", String(blockMultipleReturnsSameOrder));
    formData.set("requirePhotoForFraudReasons", String(requirePhotoForFraudReasons));
    formData.set("highReturnRateThreshold", highReturnRateThreshold);
    formData.set("wardrobingWindowDays", wardrobingWindowDays);
    formData.set("wardrobingMaxReturns", wardrobingMaxReturns);
    formData.set("ipRepeatWindowHours", ipRepeatWindowHours);
    formData.set("ipRepeatMaxReturns", ipRepeatMaxReturns);
    formData.set("resolutionRulesJson", JSON.stringify(resolutionRules));
    submit(formData, { method: "post" });
    setTimeout(() => {
      setSaved(true);
      // Revalidate parent to refresh translations
      if (locale !== currentLocale) {
        revalidator.revalidate();
      }
    }, 500);
  };

  const resolutionOptions = [
    { label: t["resolution.REFUND"], value: "REFUND" },
    { label: t["resolution.EXCHANGE"], value: "EXCHANGE" },
    { label: t["resolution.EXCHANGE_DIFFERENT_PRODUCT"], value: "EXCHANGE_DIFFERENT_PRODUCT" },
    { label: t["resolution.EXCHANGE_WITH_PRICE_DIFF"], value: "EXCHANGE_WITH_PRICE_DIFF" },
    { label: t["resolution.STORE_CREDIT"], value: "STORE_CREDIT" },
    { label: t["resolution.KEEP_IT"], value: "KEEP_IT" },
  ];

  const reasonKeys = ["SIZE", "COLOR", "DEFECTIVE", "UNWANTED", "OTHER"];
  const tabs = [
    { id: "general", content: t["settings.tabGeneral"], accessibilityLabel: t["settings.tabGeneral"], panelID: "general-panel" },
    { id: "rule-engine", content: t["settings.tabRules"], accessibilityLabel: t["settings.tabRules"], panelID: "rules-panel" },
    { id: "catalog", content: t["settings.tabCatalog"], accessibilityLabel: t["settings.tabCatalog"], panelID: "catalog-panel" },
    { id: "customers", content: t["settings.tabCustomers"], accessibilityLabel: t["settings.tabCustomers"], panelID: "customers-panel" },
    { id: "notifications", content: t["settings.tabNotifications"] || "Bildirimler", accessibilityLabel: t["settings.tabNotifications"] || "Bildirimler", panelID: "notifications-panel" },
  ];

  return (
    <Page>
      <TitleBar title={t["settings.title"]} />
      <BlockStack gap="400">
        {saved && !isSubmitting && (
          <Banner title={t["settings.saved"]} tone="success" onDismiss={() => setSaved(false)} />
        )}

        <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
          <Box paddingBlockStart="400">
            {selectedTab === 0 && (
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">{t["settings.language"]}</Text>
                    <Divider />
                    <Select
                      label={t["settings.language"]}
                      options={[
                        { label: "English", value: "en" },
                        { label: "Türkçe", value: "tr" },
                      ]}
                      value={locale}
                      onChange={setLocale}
                      helpText={t["settings.languageHelp"]}
                    />
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">{t["settings.returnPolicy"]}</Text>
                    <Divider />
                    <TextField
                      label={t["settings.returnWindow"]}
                      type="number"
                      value={returnWindowDays}
                      onChange={setReturnWindowDays}
                      helpText={t["settings.returnWindowHelp"]}
                      min={1}
                      max={365}
                      autoComplete="off"
                    />
                    <div>
                      <Checkbox
                        label={t["settings.autoApprove"]}
                        checked={isAutoApprove}
                        onChange={setIsAutoApprove}
                        helpText={t["settings.autoApproveHelp"]}
                      />
                      {isAutoApprove && (
                        <div style={{
                          marginTop: 10, padding: "10px 14px",
                          background: "#FFF7ED", border: "1px solid #FED7AA",
                          borderRadius: 8, display: "flex", gap: 10, alignItems: "flex-start",
                        }}>
                          <span style={{ fontSize: 18 }}>⚠️</span>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 13, color: "#92400E" }}>
                              {t["settings.autoApproveRiskTitle"] || "Risk Warning"}
                            </div>
                            <div style={{ fontSize: 12, color: "#B45309", marginTop: 2 }}>
                              {t["settings.autoApproveRiskText"] || "Auto-approve will automatically accept all return requests without manual review. This may increase return fraud risk. We recommend enabling a maximum order amount limit below."}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                    <TextField
                      label={t["settings.autoApproveUnderAmount"]}
                      type="number"
                      value={autoApproveUnderAmount}
                      onChange={setAutoApproveUnderAmount}
                      min={0}
                      step={0.01}
                      helpText={t["settings.autoApproveUnderAmountHelp"]}
                      autoComplete="off"
                    />
                    <TextField
                      label={t["settings.merchantAddress"]}
                      value={merchantAddress}
                      onChange={setMerchantAddress}
                      multiline={3}
                      helpText={t["settings.merchantAddressHelp"]}
                      autoComplete="off"
                    />
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">{t["settings.policyText"] || "Return Policy"}</Text>
                    <Divider />
                    <Text as="p" variant="bodySm" tone="subdued">
                      {t["settings.policyPresetsHelp"] || "Choose a preset template to get started, then customize the text below."}
                    </Text>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {POLICY_PRESETS.map((preset, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setReturnPolicy(preset.text)}
                          style={{
                            padding: "6px 14px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                            cursor: "pointer", border: "1.5px solid #6366F1",
                            background: returnPolicy === preset.text ? "#6366F1" : "#fff",
                            color: returnPolicy === preset.text ? "#fff" : "#6366F1",
                            transition: "all 0.15s",
                          }}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                    <TextField
                      label={t["settings.policyText"] || "Policy Text"}
                      value={returnPolicy}
                      onChange={setReturnPolicy}
                      multiline={5}
                      helpText={t["settings.policyTextHelp"]}
                      autoComplete="off"
                    />
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text as="h2" variant="headingMd">{t["settings.shippingLabel"]}</Text>
                      {shippoApiKey ? (
                        <Badge tone="success">{t["settings.connected"]}</Badge>
                      ) : (
                        <Badge tone="attention">{t["settings.setupRequired"]}</Badge>
                      )}
                    </InlineStack>
                    <Divider />
                    <Select
                      label={t["settings.shippingProvider"] || "Shipping Provider"}
                      options={[
                        { label: "Shippo", value: "SHIPPO" },
                        { label: "EasyPost", value: "EASYPOST" },
                      ]}
                      value={shippingProvider}
                      onChange={setShippingProvider}
                    />
                    {shippingProvider === "SHIPPO" && (
                      <div>
                        <div style={{
                          background: "#F0F9FF", border: "1px solid #BAE6FD",
                          borderRadius: 8, padding: "12px 14px", marginBottom: 12,
                        }}>
                          <div style={{ fontWeight: 600, fontSize: 13, color: "#0369A1", marginBottom: 6 }}>
                            {t["settings.shippoInstructionsTitle"] || "How to get your Shippo API key"}
                          </div>
                          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#0284C7", lineHeight: 1.7 }}>
                            <li>{t["settings.shippoStep1"] || "Go to goshippo.com and create a free account."}</li>
                            <li>{t["settings.shippoStep2"] || "In your dashboard, navigate to Settings → API."}</li>
                            <li>{t["settings.shippoStep3"] || "Click \"Generate Token\" and copy your API token."}</li>
                            <li>{t["settings.shippoStep4"] || "Paste it below. Use a test token for development."}</li>
                          </ol>
                        </div>
                        <TextField
                          label={t["settings.shippoApiToken"]}
                          value={shippoApiKey}
                          onChange={setShippoApiKey}
                          type="password"
                          helpText={t["settings.shippoHelp"]}
                          autoComplete="off"
                        />
                      </div>
                    )}
                    {shippingProvider === "EASYPOST" && (
                      <div>
                        <div style={{
                          background: "#F0F9FF", border: "1px solid #BAE6FD",
                          borderRadius: 8, padding: "12px 14px", marginBottom: 12,
                        }}>
                          <div style={{ fontWeight: 600, fontSize: 13, color: "#0369A1", marginBottom: 6 }}>
                            {t["settings.easypostInstructionsTitle"] || "How to get your EasyPost API key"}
                          </div>
                          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#0284C7", lineHeight: 1.7 }}>
                            <li>{t["settings.easypostStep1"] || "Go to easypost.com and create a free account."}</li>
                            <li>{t["settings.easypostStep2"] || "In your dashboard, go to API Keys section."}</li>
                            <li>{t["settings.easypostStep3"] || "Copy your Test or Production API key."}</li>
                            <li>{t["settings.easypostStep4"] || "Paste it below. Use the test key for development."}</li>
                          </ol>
                        </div>
                        <TextField
                          label={t["settings.easypostApiToken"] || "EasyPost API Token"}
                          value={easypostApiKey}
                          onChange={setEasypostApiKey}
                          type="password"
                          autoComplete="off"
                        />
                      </div>
                    )}
                  </BlockStack>
                </Card>
              </BlockStack>
            )}

            {selectedTab === 1 && (
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">{t["settings.ruleEngine"]}</Text>
                    <Divider />
                    <Checkbox
                      label={t["settings.enableKeepIt"]}
                      checked={enableKeepIt}
                      onChange={setEnableKeepIt}
                      helpText={t["settings.enableKeepItHelp"]}
                    />
                    <TextField
                      label={t["settings.keepItMaxAmount"]}
                      type="number"
                      value={keepItMaxAmount}
                      onChange={setKeepItMaxAmount}
                      min={0}
                      step={0.01}
                      disabled={!enableKeepIt}
                      helpText={t["settings.keepItMaxAmountHelp"]}
                      autoComplete="off"
                    />
                    <Checkbox
                      label={t["settings.enablePriceDiffExchange"]}
                      checked={enablePriceDiffExchange}
                      onChange={setEnablePriceDiffExchange}
                      helpText={t["settings.enablePriceDiffExchangeHelp"]}
                    />
                    <Checkbox
                      label={t["settings.enableStoreCreditDiscountCode"]}
                      checked={enableStoreCreditDiscountCode}
                      onChange={setEnableStoreCreditDiscountCode}
                      helpText={t["settings.enableStoreCreditDiscountCodeHelp"]}
                    />
                    <div>
                      <TextField
                        label={t["settings.storeCreditBonusRate"] || "Store Credit Bonus (%)"}
                        type="number"
                        value={storeCreditBonusRate}
                        onChange={setStoreCreditBonusRate}
                        min={0}
                        max={50}
                        step={1}
                        suffix="%"
                        helpText={t["settings.storeCreditBonusRateHelp"] || "Customers choosing store credit will receive this % extra. E.g. 15 = they get $115 credit instead of $100 refund."}
                        autoComplete="off"
                      />
                      {parseFloat(storeCreditBonusRate) > 0 && (
                        <div style={{
                          marginTop: 8, padding: "10px 14px",
                          background: "#F0FDF4", border: "1px solid #BBF7D0",
                          borderRadius: 8, fontSize: 13, color: "#166534",
                        }}>
                          ✅ {t["settings.storeCreditBonusPreview"] || "Portal will show:"} <strong>${"100.00"} refund — or — ${(100 * (1 + parseFloat(storeCreditBonusRate) / 100)).toFixed(2)} store credit (+{storeCreditBonusRate}%)</strong>
                        </div>
                      )}
                    </div>
                    <Checkbox
                      label={t["settings.excludeDiscountedItems"]}
                      checked={excludeDiscountedItems}
                      onChange={setExcludeDiscountedItems}
                      helpText={t["settings.excludeDiscountedItemsHelp"]}
                    />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <TextField
                        label={t["settings.minimumOrderAmount"]}
                        type="number"
                        value={minimumOrderAmount}
                        onChange={setMinimumOrderAmount}
                        min={0}
                        step={0.01}
                        helpText={t["settings.minimumOrderAmountHelp"]}
                        autoComplete="off"
                      />
                      <TextField
                        label={t["settings.maxReturnsPerCustomer"]}
                        type="number"
                        value={maxReturnsPerCustomer}
                        onChange={setMaxReturnsPerCustomer}
                        min={0}
                        step={1}
                        helpText={t["settings.maxReturnsPerCustomerHelp"]}
                        autoComplete="off"
                      />
                    </div>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">{t["settings.reasonPriority"]}</Text>
                    <Divider />
                    {reasonKeys.map((reasonKey) => (
                      <InlineStack key={reasonKey} align="space-between" blockAlign="start">
                        <Text as="p" variant="bodyMd">{t[`reason.${reasonKey}`]}</Text>
                        <InlineStack gap="200">
                          <Select
                            label={t["settings.firstPriority"]}
                            options={[{ label: "—", value: "" }, ...resolutionOptions]}
                            value={reasonPriority[reasonKey]?.[0] || ""}
                            onChange={(value) =>
                              setReasonPriority((prev) => ({
                                ...prev,
                                [reasonKey]: [value, prev[reasonKey]?.[1] || ""].filter(Boolean),
                              }))
                            }
                          />
                          <Select
                            label={t["settings.secondPriority"]}
                            options={[{ label: "—", value: "" }, ...resolutionOptions]}
                            value={reasonPriority[reasonKey]?.[1] || ""}
                            onChange={(value) =>
                              setReasonPriority((prev) => ({
                                ...prev,
                                [reasonKey]: [prev[reasonKey]?.[0] || "", value].filter(Boolean),
                              }))
                            }
                          />
                        </InlineStack>
                      </InlineStack>
                    ))}
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">{t["settings.fraudPrevention"] || "Fraud & Kötüye Kullanım Önleme"}</Text>
                    <Divider />
                    <Checkbox
                      label={t["settings.blockMultipleReturnsSameOrder"] || "Aynı siparişe birden fazla iade engeli"}
                      checked={blockMultipleReturnsSameOrder}
                      onChange={setBlockMultipleReturnsSameOrder}
                    />
                    <Checkbox
                      label={t["settings.requirePhotoForFraudReasons"] || "Hasar/yanlış ürün nedenlerinde fotoğraf zorunlu"}
                      checked={requirePhotoForFraudReasons}
                      onChange={setRequirePhotoForFraudReasons}
                    />
                    <TextField
                      label={t["settings.highReturnRateThreshold"] || "Yüksek iade oranı eşiği (0-1)"}
                      type="number"
                      value={highReturnRateThreshold}
                      onChange={setHighReturnRateThreshold}
                      min={0}
                      max={1}
                      step={0.01}
                      autoComplete="off"
                    />
                    <TextField
                      label={t["settings.wardrobingWindowDays"] || "Wardrobing pencere (gün)"}
                      type="number"
                      value={wardrobingWindowDays}
                      onChange={setWardrobingWindowDays}
                      min={1}
                      step={1}
                      autoComplete="off"
                    />
                    <TextField
                      label={t["settings.wardrobingMaxReturns"] || "Wardrobing max iade"}
                      type="number"
                      value={wardrobingMaxReturns}
                      onChange={setWardrobingMaxReturns}
                      min={1}
                      step={1}
                      autoComplete="off"
                    />
                    <TextField
                      label={t["settings.ipRepeatWindowHours"] || "IP tekrar kontrol penceresi (saat)"}
                      type="number"
                      value={ipRepeatWindowHours}
                      onChange={setIpRepeatWindowHours}
                      min={1}
                      step={1}
                      autoComplete="off"
                    />
                    <TextField
                      label={t["settings.ipRepeatMaxReturns"] || "IP tekrar max iade"}
                      type="number"
                      value={ipRepeatMaxReturns}
                      onChange={setIpRepeatMaxReturns}
                      min={1}
                      step={1}
                      autoComplete="off"
                    />
                  </BlockStack>
                </Card>

                {/* ── Automated Resolution Rules ── */}
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text as="h2" variant="headingMd">{t["settings.resolutionRules"] || "Automated Resolution Rules"}</Text>
                      <Button
                        size="slim"
                        onClick={() => setResolutionRules((prev) => [
                          ...prev,
                          { id: `r${Date.now()}`, condition: "ORDER_AMOUNT_GTE", value: "", resolution: "STORE_CREDIT" },
                        ])}
                      >
                        {t["settings.addRule"] || "+ Add Rule"}
                      </Button>
                    </InlineStack>
                    <Text as="p" tone="subdued" variant="bodySm">
                      {t["settings.resolutionRulesHelp"] || "Rules are evaluated top-to-bottom. First match overrides the customer's resolution choice."}
                    </Text>
                    <Divider />
                    {resolutionRules.length === 0 ? (
                      <Text as="p" tone="subdued">{t["settings.noRules"] || "No rules defined. Add a rule to automate resolution decisions."}</Text>
                    ) : (
                      <BlockStack gap="300">
                        {resolutionRules.map((rule, idx) => (
                          <div key={rule.id} style={{
                            display: "grid",
                            gridTemplateColumns: "auto 1fr 1fr 1fr auto",
                            gap: 10,
                            alignItems: "center",
                            padding: "10px 12px",
                            background: "#F9FAFB",
                            borderRadius: 8,
                            border: "1px solid #E5E7EB",
                          }}>
                            <span style={{ fontSize: 12, color: "#9CA3AF", fontWeight: 600 }}>#{idx + 1}</span>
                            <Select
                              label=""
                              labelHidden
                              options={[
                                { label: t["settings.rule.ORDER_AMOUNT_GTE"] || "Order amount ≥", value: "ORDER_AMOUNT_GTE" },
                                { label: t["settings.rule.ORDER_AMOUNT_LTE"] || "Order amount ≤", value: "ORDER_AMOUNT_LTE" },
                                { label: t["settings.rule.CUSTOMER_TAG"] || "Customer has tag", value: "CUSTOMER_TAG" },
                                { label: t["settings.rule.REASON"] || "Reason contains", value: "REASON" },
                                { label: t["settings.rule.RETURN_COUNT_GTE"] || "Return count ≥", value: "RETURN_COUNT_GTE" },
                              ]}
                              value={rule.condition}
                              onChange={(v) => setResolutionRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, condition: v } : r))}
                            />
                            <TextField
                              label=""
                              labelHidden
                              placeholder={
                                rule.condition === "CUSTOMER_TAG" ? "VIP" :
                                rule.condition === "REASON" ? "DAMAGED" :
                                "100"
                              }
                              value={rule.value}
                              onChange={(v) => setResolutionRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, value: v } : r))}
                              autoComplete="off"
                            />
                            <Select
                              label=""
                              labelHidden
                              options={[
                                { label: t["settings.rule.res.STORE_CREDIT"] || "→ Store Credit", value: "STORE_CREDIT" },
                                { label: t["settings.rule.res.EXCHANGE"] || "→ Exchange", value: "EXCHANGE" },
                                { label: t["settings.rule.res.REFUND"] || "→ Refund", value: "REFUND" },
                                { label: t["settings.rule.res.KEEP_IT"] || "→ Keep It", value: "KEEP_IT" },
                              ]}
                              value={rule.resolution}
                              onChange={(v) => setResolutionRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, resolution: v } : r))}
                            />
                            <Button
                              tone="critical"
                              size="slim"
                              onClick={() => setResolutionRules((prev) => prev.filter((r) => r.id !== rule.id))}
                            >
                              ✕
                            </Button>
                          </div>
                        ))}
                      </BlockStack>
                    )}
                  </BlockStack>
                </Card>

              </BlockStack>
            )}

            {selectedTab === 2 && (
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">{t["settings.productReturnWindows"]}</Text>
                    <Divider />
                    {products.map((product) => (
                      <Checkbox
                        key={product.id}
                        label={product.title}
                        checked={Boolean(productWindows[product.id])}
                        onChange={(checked) =>
                          setProductWindows((prev) => {
                            if (!checked) {
                              const next = { ...prev };
                              delete next[product.id];
                              return next;
                            }
                            return { ...prev, [product.id]: "30" };
                          })
                        }
                      />
                    ))}
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">{t["settings.collectionReturnWindows"]}</Text>
                    <Divider />
                    {collections.map((collection) => (
                      <Checkbox
                        key={collection.id}
                        label={collection.title}
                        checked={Boolean(collectionWindows[collection.id])}
                        onChange={(checked) =>
                          setCollectionWindows((prev) => {
                            if (!checked) {
                              const next = { ...prev };
                              delete next[collection.id];
                              return next;
                            }
                            return { ...prev, [collection.id]: "30" };
                          })
                        }
                      />
                    ))}
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">{t["settings.nonReturnables"]}</Text>
                    <Divider />
                    <Text as="p" variant="bodySm" tone="subdued">{t["settings.nonReturnablesHelp"]}</Text>
                    <Text as="h3" variant="headingSm">{t["settings.nonReturnableProductIds"]}</Text>
                    {products.map((product) => (
                      <Checkbox
                        key={`nrp-${product.id}`}
                        label={product.title}
                        checked={nonReturnableProductIds.includes(product.id)}
                        onChange={(checked) =>
                          setNonReturnableProductIds((prev) =>
                            checked ? [...new Set([...prev, product.id])] : prev.filter((id) => id !== product.id),
                          )
                        }
                      />
                    ))}
                    <Divider />
                    <Text as="h3" variant="headingSm">{t["settings.nonReturnableCollectionIds"]}</Text>
                    {collections.map((collection) => (
                      <Checkbox
                        key={`nrc-${collection.id}`}
                        label={collection.title}
                        checked={nonReturnableCollectionIds.includes(collection.id)}
                        onChange={(checked) =>
                          setNonReturnableCollectionIds((prev) =>
                            checked ? [...new Set([...prev, collection.id])] : prev.filter((id) => id !== collection.id),
                          )
                        }
                      />
                    ))}
                  </BlockStack>
                </Card>
              </BlockStack>
            )}

            {selectedTab === 3 && (
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">{t["settings.blockedCustomerEmails"] || "Block Customers"}</Text>
                    <Divider />
                    <Text as="p" variant="bodySm" tone="subdued">{t["settings.blockedCustomerEmailsHelp"] || "Search for customers and add them to the blocked list."}</Text>
                    <div style={{ position: "relative" }}>
                      <input
                        type="text"
                        value={customerSearch}
                        onChange={(e) => setCustomerSearch(e.target.value)}
                        placeholder={t["settings.customerSearchPlaceholder"] || "Search customers by name or email..."}
                        style={{
                          width: "100%", boxSizing: "border-box",
                          padding: "8px 12px", borderRadius: 8, fontSize: 14,
                          border: "1.5px solid #D1D5DB", outline: "none",
                        }}
                      />
                      {customerSearch.length > 0 && (
                        <div style={{
                          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 10,
                          background: "#fff", border: "1px solid #E5E7EB",
                          borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                          maxHeight: 220, overflowY: "auto", marginTop: 4,
                        }}>
                          {customers
                            .filter((c) =>
                              !blockedCustomerEmails.includes(c.email) &&
                              c.label.toLowerCase().includes(customerSearch.toLowerCase())
                            )
                            .slice(0, 10)
                            .map((customer) => (
                              <div
                                key={customer.email}
                                onClick={() => {
                                  setBlockedCustomerEmails((prev) => [...new Set([...prev, customer.email])]);
                                  setCustomerSearch("");
                                }}
                                style={{
                                  padding: "8px 14px", cursor: "pointer", fontSize: 13,
                                  borderBottom: "1px solid #F3F4F6",
                                  transition: "background 0.1s",
                                }}
                                onMouseEnter={(e) => (e.currentTarget.style.background = "#F9FAFB")}
                                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                              >
                                {customer.label}
                              </div>
                            ))}
                          {customers.filter((c) =>
                            !blockedCustomerEmails.includes(c.email) &&
                            c.label.toLowerCase().includes(customerSearch.toLowerCase())
                          ).length === 0 && (
                            <div style={{ padding: "10px 14px", fontSize: 13, color: "#9CA3AF" }}>
                              {t["settings.noCustomersFound"] || "No customers found"}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </BlockStack>
                </Card>

                {blockedCustomerEmails.length > 0 && (
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">{t["settings.blockedCustomersList"] || "Blocked Customers"}</Text>
                      <Divider />
                      {blockedCustomerEmails.map((email) => {
                        const customer = customers.find((c) => c.email === email);
                        return (
                          <div key={email} style={{
                            display: "flex", justifyContent: "space-between", alignItems: "center",
                            padding: "8px 0", borderBottom: "1px solid #F3F4F6",
                          }}>
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 500 }}>
                                {customer ? customer.label : email}
                              </div>
                              {customer && <div style={{ fontSize: 11, color: "#9CA3AF" }}>{email}</div>}
                            </div>
                            <button
                              type="button"
                              onClick={() => setBlockedCustomerEmails((prev) => prev.filter((e) => e !== email))}
                              style={{
                                background: "#FEE2E2", color: "#EF4444", border: "none",
                                borderRadius: 6, padding: "4px 10px", fontSize: 12,
                                fontWeight: 600, cursor: "pointer",
                              }}
                            >
                              {t["settings.unblock"] || "Remove"}
                            </button>
                          </div>
                        );
                      })}
                    </BlockStack>
                  </Card>
                )}
              </BlockStack>
            )}

            {selectedTab === 4 && (
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">{t["settings.notificationEmail"] || "Email Bildirimleri"}</Text>
                    <Divider />
                    <Checkbox
                      label={t["settings.enableAutoCustomerEmail"] || "Müşteriye otomatik email gönder"}
                      checked={enableAutoCustomerEmail}
                      onChange={setEnableAutoCustomerEmail}
                    />
                    <Select
                      label={t["settings.emailProvider"] || "Email sağlayıcı"}
                      options={[{ label: "Resend", value: "RESEND" }]}
                      value={emailProvider}
                      onChange={setEmailProvider}
                    />
                    <TextField
                      label={t["settings.resendApiKey"] || "Resend API Key"}
                      value={resendApiKey}
                      onChange={setResendApiKey}
                      type="password"
                      autoComplete="off"
                    />
                    <TextField
                      label={t["settings.emailFrom"] || "From Email"}
                      value={emailFrom}
                      onChange={setEmailFrom}
                      autoComplete="off"
                    />
                    <TextField
                      label={t["settings.emailReplyTo"] || "Reply-To Email"}
                      value={emailReplyTo}
                      onChange={setEmailReplyTo}
                      autoComplete="off"
                    />
                    <Checkbox
                      label={t["settings.enableMerchantNewReturnNotification"] || "Merchant’a yeni iade email bildirimi"}
                      checked={enableMerchantNewReturnNotification}
                      onChange={setEnableMerchantNewReturnNotification}
                    />
                    <TextField
                      label={t["settings.merchantNotificationEmail"] || "Merchant bildirim email"}
                      value={merchantNotificationEmail}
                      onChange={setMerchantNotificationEmail}
                      autoComplete="off"
                    />
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">{t["settings.emailTemplates"] || "Email Şablonları"}</Text>
                    <Divider />
                    <TextField label={t["settings.emailTemplateHeaderText"] || "Header"} value={emailTemplateHeaderText} onChange={setEmailTemplateHeaderText} autoComplete="off" />
                    <TextField label={t["settings.emailTemplateFooterText"] || "Footer"} value={emailTemplateFooterText} onChange={setEmailTemplateFooterText} autoComplete="off" />
                    <TextField label={t["settings.emailTemplateReceived"] || "İade alındı"} value={emailTemplateReceived} onChange={setEmailTemplateReceived} multiline={3} autoComplete="off" />
                    <TextField label={t["settings.emailTemplateApproved"] || "Onaylandı"} value={emailTemplateApproved} onChange={setEmailTemplateApproved} multiline={3} autoComplete="off" />
                    <TextField label={t["settings.emailTemplateDeclined"] || "Reddedildi"} value={emailTemplateDeclined} onChange={setEmailTemplateDeclined} multiline={3} autoComplete="off" />
                    <TextField label={t["settings.emailTemplateCompleted"] || "Tamamlandı"} value={emailTemplateCompleted} onChange={setEmailTemplateCompleted} multiline={3} autoComplete="off" />
                    <Text as="p" tone="subdued" variant="bodySm">
                      {`Desteklenen değişkenler: {{orderName}}, {{returnId}}, {{reason}}, {{resolutionType}}, {{amount}}, {{status}}`}
                    </Text>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">{t["settings.otherChannels"] || "SMS / WhatsApp / Flow"}</Text>
                    <Divider />
                    <Checkbox
                      label={t["settings.enableSmsNotifications"] || "SMS bildirimlerini etkinleştir"}
                      checked={enableSmsNotifications}
                      onChange={setEnableSmsNotifications}
                    />
                    <TextField
                      label={t["settings.smsWebhookUrl"] || "SMS Webhook URL"}
                      value={smsWebhookUrl}
                      onChange={setSmsWebhookUrl}
                      autoComplete="off"
                    />
                    <Checkbox
                      label={t["settings.enableWhatsAppNotifications"] || "WhatsApp bildirimlerini etkinleştir"}
                      checked={enableWhatsAppNotifications}
                      onChange={setEnableWhatsAppNotifications}
                    />
                    <TextField
                      label={t["settings.whatsappWebhookUrl"] || "WhatsApp Webhook URL"}
                      value={whatsappWebhookUrl}
                      onChange={setWhatsappWebhookUrl}
                      autoComplete="off"
                    />
                    <Checkbox
                      label={t["settings.enableFlowWebhook"] || "Shopify Flow webhook entegrasyonu"}
                      checked={enableFlowWebhook}
                      onChange={setEnableFlowWebhook}
                    />
                    <TextField
                      label={t["settings.flowWebhookUrl"] || "Flow Webhook URL"}
                      value={flowWebhookUrl}
                      onChange={setFlowWebhookUrl}
                      autoComplete="off"
                    />
                    <Checkbox
                      label={t["settings.enableKlaviyo"] || "Klaviyo event entegrasyonu"}
                      checked={enableKlaviyo}
                      onChange={setEnableKlaviyo}
                    />
                    <TextField
                      label={t["settings.klaviyoApiKey"] || "Klaviyo API Key"}
                      value={klaviyoApiKey}
                      onChange={setKlaviyoApiKey}
                      type="password"
                      autoComplete="off"
                    />
                    <Checkbox
                      label={t["settings.enableSlackNotifications"] || "Slack merchant bildirimleri"}
                      checked={enableSlackNotifications}
                      onChange={setEnableSlackNotifications}
                    />
                    <TextField
                      label={t["settings.slackWebhookUrl"] || "Slack Webhook URL"}
                      value={slackWebhookUrl}
                      onChange={setSlackWebhookUrl}
                      autoComplete="off"
                    />
                    <Checkbox
                      label={t["settings.enableGorgias"] || "Gorgias entegrasyonu"}
                      checked={enableGorgias}
                      onChange={setEnableGorgias}
                    />
                    <TextField
                      label={t["settings.gorgiasWebhookUrl"] || "Gorgias Webhook URL"}
                      value={gorgiasWebhookUrl}
                      onChange={setGorgiasWebhookUrl}
                      autoComplete="off"
                    />
                    <Checkbox
                      label={t["settings.enableZendesk"] || "Zendesk entegrasyonu"}
                      checked={enableZendesk}
                      onChange={setEnableZendesk}
                    />
                    <TextField
                      label={t["settings.zendeskWebhookUrl"] || "Zendesk Webhook URL"}
                      value={zendeskWebhookUrl}
                      onChange={setZendeskWebhookUrl}
                      autoComplete="off"
                    />
                  </BlockStack>
                </Card>
              </BlockStack>
            )}
          </Box>
        </Tabs>

        <Button variant="primary" loading={isSubmitting} onClick={handleSave}>
          {t["settings.save"]}
        </Button>
      </BlockStack>
    </Page>
  );
}
