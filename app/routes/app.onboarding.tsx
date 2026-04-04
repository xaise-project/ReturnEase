import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useOutletContext } from "@remix-run/react";
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
  InlineStack,
  Select,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import type { Locale } from "../services/i18n-admin";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const settings = await prisma.storeSettings.findUnique({
    where: { shop: session.shop },
  });

  if (settings?.onboardingCompleted) {
    return redirect("/app");
  }

  // Fetch products for non-returnable selection
  let products: Array<{ id: string; title: string }> = [];
  try {
    const response = await admin.graphql(
      `#graphql
        query onboardingProducts {
          products(first: 40, sortKey: TITLE) {
            edges { node { id title } }
          }
        }
      `,
    );
    const data = await response.json();
    products = (data.data?.products?.edges || []).map((edge: any) => ({
      id: edge.node.id,
      title: edge.node.title,
    }));
  } catch {
    products = [];
  }

  return {
    settings: settings
      ? { ...settings, createdAt: settings.createdAt.toISOString(), updatedAt: settings.updatedAt.toISOString() }
      : null,
    shop: session.shop,
    products,
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "save_step_1") {
    const returnWindowDays = parseInt(formData.get("returnWindowDays") as string) || 30;
    const excludeDiscountedItems = formData.get("excludeDiscountedItems") === "true";
    const nonReturnableProductIds = (formData.get("nonReturnableProductIds") as string) || "";

    await prisma.storeSettings.upsert({
      where: { shop: session.shop },
      update: { returnWindowDays, excludeDiscountedItems, nonReturnableProductIds: nonReturnableProductIds || null },
      create: { shop: session.shop, returnWindowDays, excludeDiscountedItems, nonReturnableProductIds: nonReturnableProductIds || null },
    });
    return { success: true, step: 1 };
  }

  if (intent === "save_step_2") {
    const isAutoApprove = formData.get("isAutoApprove") === "true";
    const autoApproveUnderAmount = parseFloat((formData.get("autoApproveUnderAmount") as string) || "0");

    await prisma.storeSettings.upsert({
      where: { shop: session.shop },
      update: { isAutoApprove, autoApproveUnderAmount },
      create: { shop: session.shop, isAutoApprove, autoApproveUnderAmount },
    });
    return { success: true, step: 2 };
  }

  if (intent === "save_step_3") {
    const enableKeepIt = formData.get("enableKeepIt") === "true";
    const keepItMaxAmount = parseFloat((formData.get("keepItMaxAmount") as string) || "0");

    await prisma.storeSettings.upsert({
      where: { shop: session.shop },
      update: { enableKeepIt, keepItMaxAmount },
      create: { shop: session.shop, enableKeepIt, keepItMaxAmount },
    });
    return { success: true, step: 3 };
  }

  if (intent === "save_step_4") {
    const enableStoreCreditDiscountCode = formData.get("enableStoreCreditDiscountCode") === "true";
    const storeCreditBonusRate = parseFloat((formData.get("storeCreditBonusRate") as string) || "0");

    await prisma.storeSettings.upsert({
      where: { shop: session.shop },
      update: { enableStoreCreditDiscountCode, storeCreditBonusRate },
      create: { shop: session.shop, enableStoreCreditDiscountCode, storeCreditBonusRate },
    });
    return { success: true, step: 4 };
  }

  if (intent === "save_step_5") {
    const resendApiKey = (formData.get("resendApiKey") as string) || "";
    const emailFrom = (formData.get("emailFrom") as string) || "";
    const shippoApiKey = (formData.get("shippoApiKey") as string) || "";
    const enableAutoCustomerEmail = formData.get("enableAutoCustomerEmail") === "true";

    await prisma.storeSettings.upsert({
      where: { shop: session.shop },
      update: {
        resendApiKey: resendApiKey || null,
        emailFrom: emailFrom || null,
        shippoApiKey: shippoApiKey || null,
        enableAutoCustomerEmail,
      },
      create: {
        shop: session.shop,
        resendApiKey: resendApiKey || null,
        emailFrom: emailFrom || null,
        shippoApiKey: shippoApiKey || null,
        enableAutoCustomerEmail,
      },
    });
    return { success: true, step: 5 };
  }

  if (intent === "complete_onboarding") {
    await prisma.storeSettings.upsert({
      where: { shop: session.shop },
      update: { onboardingCompleted: true },
      create: { shop: session.shop, onboardingCompleted: true },
    });
    return redirect("/app");
  }

  if (intent === "generate_policy") {
    const returnWindowDays = (formData.get("returnWindowDays") as string) || "30";
    const isAutoApprove = formData.get("isAutoApprove") === "true";
    const enableKeepIt = formData.get("enableKeepIt") === "true";
    const keepItMaxAmount = (formData.get("keepItMaxAmount") as string) || "0";
    const storeCreditBonusRate = (formData.get("storeCreditBonusRate") as string) || "0";
    const excludeDiscountedItems = formData.get("excludeDiscountedItems") === "true";
    const locale = (formData.get("locale") as string) || "en";

    if (!process.env.ANTHROPIC_API_KEY) {
      return { success: false, error: "No API key" };
    }

    try {
      const lang = locale === "tr" ? "Turkish" : "English";
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          messages: [{
            role: "user",
            content: `Generate a return policy for an e-commerce store in ${lang} with these rules:
- Return window: ${returnWindowDays} days
- Auto-approve: ${isAutoApprove ? "yes" : "no"}
- Keep product option: ${enableKeepIt ? `yes, under $${keepItMaxAmount}` : "no"}
- Store credit bonus: ${parseFloat(storeCreditBonusRate) > 0 ? `${parseFloat(storeCreditBonusRate) * 100}% extra` : "no"}
- Excluded discounted items: ${excludeDiscountedItems ? "yes" : "no"}

Write a professional, friendly return policy. Include sections: Eligibility, Conditions, Exceptions, Refund Methods. Keep it under 300 words. Return ONLY the policy text, no extra commentary.`
          }]
        }),
      });
      const result = await response.json();
      const policyText = result.content?.[0]?.text || "";

      // Save the generated policy
      await prisma.storeSettings.upsert({
        where: { shop: session.shop },
        update: { returnPolicy: policyText },
        create: { shop: session.shop, returnPolicy: policyText },
      });

      return { success: true, policyText };
    } catch (e) {
      return { success: false, error: "AI generation failed" };
    }
  }

  return { success: false };
};

const STEPS = [
  { key: "policy", emoji: "📋", labelEn: "Return Policy Rules", labelTr: "İade Politikası Kuralları" },
  { key: "approve", emoji: "✅", labelEn: "Auto Approval", labelTr: "Otomatik Onay" },
  { key: "keepit", emoji: "🎁", labelEn: "Keep It", labelTr: "Ürünü Tut" },
  { key: "credit", emoji: "💳", labelEn: "Store Credit", labelTr: "Mağaza Kredisi" },
  { key: "integrations", emoji: "🔌", labelEn: "Integrations", labelTr: "Entegrasyonlar" },
];

export default function Onboarding() {
  const { settings, products, hasAnthropicKey } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const { t, locale } = useOutletContext<{ locale: Locale; t: Record<string, string> }>();

  const [currentStep, setCurrentStep] = useState(0);

  // Step 1: Policy Rules
  const [returnWindowDays, setReturnWindowDays] = useState(String(settings?.returnWindowDays ?? 30));
  const [excludeDiscountedItems, setExcludeDiscountedItems] = useState(settings?.excludeDiscountedItems ?? false);
  const [nonReturnableProductIds, setNonReturnableProductIds] = useState<string[]>(
    (settings?.nonReturnableProductIds || "").split(/\n|,/).map((v: string) => v.trim()).filter(Boolean),
  );

  // Step 2: Auto Approve
  const [isAutoApprove, setIsAutoApprove] = useState(settings?.isAutoApprove ?? false);
  const [autoApproveUnderAmount, setAutoApproveUnderAmount] = useState(
    settings?.autoApproveUnderAmount ? String(settings.autoApproveUnderAmount) : "0",
  );

  // Step 3: Keep It
  const [enableKeepIt, setEnableKeepIt] = useState(settings?.enableKeepIt ?? false);
  const [keepItMaxAmount, setKeepItMaxAmount] = useState(
    settings?.keepItMaxAmount ? String(settings.keepItMaxAmount) : "0",
  );

  // Step 4: Store Credit
  const [enableStoreCreditDiscountCode, setEnableStoreCreditDiscountCode] = useState(
    settings?.enableStoreCreditDiscountCode ?? false,
  );
  const [storeCreditBonusRate, setStoreCreditBonusRate] = useState(
    settings?.storeCreditBonusRate ? String(Number(settings.storeCreditBonusRate) * 100) : "0",
  );

  // Step 5: Integrations
  const [resendApiKey, setResendApiKey] = useState(settings?.resendApiKey ?? "");
  const [emailFrom, setEmailFrom] = useState(settings?.emailFrom ?? "");
  const [shippoApiKey, setShippoApiKey] = useState(settings?.shippoApiKey ?? "");
  const [enableAutoCustomerEmail, setEnableAutoCustomerEmail] = useState(settings?.enableAutoCustomerEmail ?? false);

  const [generatingPolicy, setGeneratingPolicy] = useState(false);
  const [policyGenerated, setPolicyGenerated] = useState(false);

  const saveCurrentStep = () => {
    const formData = new FormData();
    formData.set("intent", `save_step_${currentStep + 1}`);

    if (currentStep === 0) {
      formData.set("returnWindowDays", returnWindowDays);
      formData.set("excludeDiscountedItems", String(excludeDiscountedItems));
      formData.set("nonReturnableProductIds", nonReturnableProductIds.join("\n"));
    } else if (currentStep === 1) {
      formData.set("isAutoApprove", String(isAutoApprove));
      formData.set("autoApproveUnderAmount", autoApproveUnderAmount);
    } else if (currentStep === 2) {
      formData.set("enableKeepIt", String(enableKeepIt));
      formData.set("keepItMaxAmount", keepItMaxAmount);
    } else if (currentStep === 3) {
      formData.set("enableStoreCreditDiscountCode", String(enableStoreCreditDiscountCode));
      formData.set("storeCreditBonusRate", String(parseFloat(storeCreditBonusRate || "0") / 100));
    } else if (currentStep === 4) {
      formData.set("resendApiKey", resendApiKey);
      formData.set("emailFrom", emailFrom);
      formData.set("shippoApiKey", shippoApiKey);
      formData.set("enableAutoCustomerEmail", String(enableAutoCustomerEmail));
    }

    submit(formData, { method: "post" });
  };

  const handleNext = () => {
    saveCurrentStep();
    if (currentStep < 4) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 0) setCurrentStep(currentStep - 1);
  };

  const handleSkip = () => {
    if (currentStep < 4) setCurrentStep(currentStep + 1);
  };

  const handleComplete = () => {
    saveCurrentStep();
    setTimeout(() => {
      const formData = new FormData();
      formData.set("intent", "complete_onboarding");
      submit(formData, { method: "post" });
    }, 300);
  };

  const handleGeneratePolicy = () => {
    setGeneratingPolicy(true);
    const formData = new FormData();
    formData.set("intent", "generate_policy");
    formData.set("returnWindowDays", returnWindowDays);
    formData.set("isAutoApprove", String(isAutoApprove));
    formData.set("enableKeepIt", String(enableKeepIt));
    formData.set("keepItMaxAmount", keepItMaxAmount);
    formData.set("storeCreditBonusRate", String(parseFloat(storeCreditBonusRate || "0") / 100));
    formData.set("excludeDiscountedItems", String(excludeDiscountedItems));
    formData.set("locale", locale);
    submit(formData, { method: "post" });
    setTimeout(() => {
      setGeneratingPolicy(false);
      setPolicyGenerated(true);
    }, 3000);
  };

  const isTr = locale === "tr";

  return (
    <Page>
      <BlockStack gap="600">
        {/* Header */}
        <div style={{ textAlign: "center", padding: "20px 0 0" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🚀</div>
          <Text as="h1" variant="headingXl">
            {isTr ? "ReturnEase Kurulum Sihirbazı" : "ReturnEase Setup Wizard"}
          </Text>
          <div style={{ marginTop: 8 }}>
            <Text as="p" tone="subdued">
              {isTr
                ? "Mağazanızın iade sürecini birkaç adımda yapılandırın."
                : "Configure your store's return process in just a few steps."}
            </Text>
          </div>
        </div>

        {/* Progress Bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 0, padding: "0 20px" }}>
          {STEPS.map((step, idx) => {
            const isActive = idx === currentStep;
            const isDone = idx < currentStep;
            return (
              <div key={step.key} style={{ flex: 1, display: "flex", alignItems: "center" }}>
                <div
                  onClick={() => idx <= currentStep && setCurrentStep(idx)}
                  style={{
                    width: 44, height: 44, borderRadius: "50%",
                    background: isDone ? "#10B981" : isActive ? "#6366F1" : "#E5E7EB",
                    color: isDone || isActive ? "#fff" : "#9CA3AF",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: isDone ? 18 : 16, fontWeight: 700,
                    cursor: idx <= currentStep ? "pointer" : "default",
                    transition: "all 0.3s",
                    boxShadow: isActive ? "0 0 0 4px rgba(99,102,241,0.2)" : "none",
                    flexShrink: 0,
                  }}
                >
                  {isDone ? "✓" : step.emoji}
                </div>
                {idx < 4 && (
                  <div style={{
                    flex: 1, height: 3,
                    background: idx < currentStep ? "#10B981" : "#E5E7EB",
                    transition: "background 0.3s",
                  }} />
                )}
              </div>
            );
          })}
        </div>

        {/* Step Label */}
        <div style={{ textAlign: "center" }}>
          <Text as="p" variant="headingMd">
            {isTr
              ? `Adım ${currentStep + 1}/5 — ${STEPS[currentStep].labelTr}`
              : `Step ${currentStep + 1}/5 — ${STEPS[currentStep].labelEn}`}
          </Text>
        </div>

        {/* Step Content */}
        <Card>
          <BlockStack gap="400">
            {currentStep === 0 && (
              <>
                <Text as="h2" variant="headingMd">
                  {isTr ? "📋 İade Politikası Kuralları" : "📋 Return Policy Rules"}
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  {isTr
                    ? "Temel iade kurallarınızı belirleyin. Bu ayarları daha sonra değiştirebilirsiniz."
                    : "Set your basic return rules. You can change these later."}
                </Text>
                <Divider />
                <TextField
                  label={isTr ? "İade penceresi (gün)" : "Return window (days)"}
                  type="number"
                  value={returnWindowDays}
                  onChange={setReturnWindowDays}
                  min={1}
                  max={365}
                  helpText={isTr ? "Teslimat sonrası kaç gün içinde iade kabul edilir" : "How many days after delivery returns are accepted"}
                  autoComplete="off"
                />
                <Checkbox
                  label={isTr ? "İndirimli ürünleri iadeden hariç tut" : "Exclude discounted items from returns"}
                  checked={excludeDiscountedItems}
                  onChange={setExcludeDiscountedItems}
                />
                {products.length > 0 && (
                  <>
                    <Divider />
                    <Text as="h3" variant="headingSm">
                      {isTr ? "İade edilemez ürünler" : "Non-returnable products"}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {isTr ? "Seçtiğiniz ürünler iade portalında görünmeyecek." : "Selected products won't appear in the return portal."}
                    </Text>
                    <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid #E5E7EB", borderRadius: 8, padding: 8 }}>
                      {products.map((product) => (
                        <Checkbox
                          key={product.id}
                          label={product.title}
                          checked={nonReturnableProductIds.includes(product.id)}
                          onChange={(checked) =>
                            setNonReturnableProductIds((prev) =>
                              checked ? [...new Set([...prev, product.id])] : prev.filter((id) => id !== product.id),
                            )
                          }
                        />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {currentStep === 1 && (
              <>
                <Text as="h2" variant="headingMd">
                  {isTr ? "✅ Otomatik Onay" : "✅ Auto Approval"}
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  {isTr
                    ? "İade taleplerini otomatik olarak onaylayabilir veya manuel inceleme yapabilirsiniz."
                    : "Auto-approve return requests or review them manually."}
                </Text>
                <Divider />
                <Checkbox
                  label={isTr ? "İade taleplerini otomatik onayla" : "Auto-approve return requests"}
                  checked={isAutoApprove}
                  onChange={setIsAutoApprove}
                />
                {isAutoApprove && (
                  <div style={{
                    padding: "12px 14px", background: "#FFF7ED", border: "1px solid #FED7AA",
                    borderRadius: 8, display: "flex", gap: 10, alignItems: "flex-start",
                  }}>
                    <span style={{ fontSize: 18 }}>⚠️</span>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13, color: "#92400E" }}>
                        {isTr ? "Risk Uyarısı" : "Risk Warning"}
                      </div>
                      <div style={{ fontSize: 12, color: "#B45309", marginTop: 2 }}>
                        {isTr
                          ? "Otomatik onay tüm iadeleri inceleme olmadan kabul eder. Aşağıda bir tutar limiti belirlemenizi öneririz."
                          : "Auto-approve accepts all returns without review. We recommend setting an amount limit below."}
                      </div>
                    </div>
                  </div>
                )}
                <TextField
                  label={isTr ? "Otomatik onay tutar limiti ($)" : "Auto-approve amount limit ($)"}
                  type="number"
                  value={autoApproveUnderAmount}
                  onChange={setAutoApproveUnderAmount}
                  min={0}
                  step={0.01}
                  helpText={isTr ? "Bu tutarın altındaki iadeler otomatik onaylanır (0 = limit yok)" : "Returns under this amount are auto-approved (0 = no limit)"}
                  autoComplete="off"
                />
              </>
            )}

            {currentStep === 2 && (
              <>
                <Text as="h2" variant="headingMd">
                  {isTr ? "🎁 Ürünü Tut (Keep It)" : "🎁 Keep It"}
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  {isTr
                    ? "Düşük değerli ürünlerde müşterinin ürünü iade göndermeden tutmasına izin verin. Kargo maliyetini azaltır."
                    : "Allow customers to keep low-value items without shipping them back. Reduces shipping costs."}
                </Text>
                <Divider />
                <Checkbox
                  label={isTr ? "\"Ürünü Tut\" seçeneğini etkinleştir" : "Enable \"Keep It\" option"}
                  checked={enableKeepIt}
                  onChange={setEnableKeepIt}
                />
                {enableKeepIt && (
                  <>
                    <TextField
                      label={isTr ? "Maksimum ürün tutarı ($)" : "Maximum product value ($)"}
                      type="number"
                      value={keepItMaxAmount}
                      onChange={setKeepItMaxAmount}
                      min={0}
                      step={0.01}
                      helpText={isTr ? "Bu tutarın altındaki ürünlerde \"Ürünü Tut\" seçeneği sunulur" : "\"Keep It\" option is offered for products under this amount"}
                      autoComplete="off"
                    />
                    <div style={{
                      padding: "10px 14px", background: "#F0FDF4", border: "1px solid #BBF7D0",
                      borderRadius: 8, fontSize: 13, color: "#166534",
                    }}>
                      {isTr
                        ? `✅ $${keepItMaxAmount || "0"} altındaki ürünlerde müşteri ürünü geri göndermeden iade alabilir.`
                        : `✅ Customers can get a refund without returning items under $${keepItMaxAmount || "0"}.`}
                    </div>
                  </>
                )}
              </>
            )}

            {currentStep === 3 && (
              <>
                <Text as="h2" variant="headingMd">
                  {isTr ? "💳 Mağaza Kredisi" : "💳 Store Credit"}
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  {isTr
                    ? "Müşterileri mağaza kredisi seçmeye teşvik edin. İade gelir kaybını azaltır."
                    : "Encourage customers to choose store credit. Reduces revenue loss from returns."}
                </Text>
                <Divider />
                <Checkbox
                  label={isTr ? "Mağaza kredisi için indirim kodu oluştur" : "Generate discount code for store credit"}
                  checked={enableStoreCreditDiscountCode}
                  onChange={setEnableStoreCreditDiscountCode}
                />
                <TextField
                  label={isTr ? "Mağaza kredisi bonus oranı (%)" : "Store credit bonus rate (%)"}
                  type="number"
                  value={storeCreditBonusRate}
                  onChange={setStoreCreditBonusRate}
                  min={0}
                  max={50}
                  step={1}
                  suffix="%"
                  helpText={isTr
                    ? "Mağaza kredisi seçen müşterilere bu oranda ekstra kredi verilir"
                    : "Customers choosing store credit receive this % extra"}
                  autoComplete="off"
                />
                {parseFloat(storeCreditBonusRate) > 0 && (
                  <div style={{
                    padding: "10px 14px", background: "#F0FDF4", border: "1px solid #BBF7D0",
                    borderRadius: 8, fontSize: 13, color: "#166534",
                  }}>
                    {isTr
                      ? `✅ Portalda gösterilecek: $100.00 iade — veya — $${(100 * (1 + parseFloat(storeCreditBonusRate) / 100)).toFixed(2)} mağaza kredisi (+${storeCreditBonusRate}%)`
                      : `✅ Portal will show: $100.00 refund — or — $${(100 * (1 + parseFloat(storeCreditBonusRate) / 100)).toFixed(2)} store credit (+${storeCreditBonusRate}%)`}
                  </div>
                )}
              </>
            )}

            {currentStep === 4 && (
              <>
                <Text as="h2" variant="headingMd">
                  {isTr ? "🔌 Entegrasyonlar" : "🔌 Integrations"}
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  {isTr
                    ? "Email ve kargo entegrasyonlarını kurun. Bu adımı atlayıp sonra ayarlayabilirsiniz."
                    : "Set up email and shipping integrations. You can skip this step and configure later."}
                </Text>
                <Divider />

                {/* Email */}
                <div style={{
                  padding: "16px", background: "#F9FAFB", borderRadius: 10,
                  border: "1px solid #E5E7EB",
                }}>
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text as="h3" variant="headingSm">
                        {isTr ? "📧 Email Bildirimleri" : "📧 Email Notifications"}
                      </Text>
                    </InlineStack>
                    <Checkbox
                      label={isTr ? "Müşteriye otomatik email gönder" : "Send automatic emails to customers"}
                      checked={enableAutoCustomerEmail}
                      onChange={setEnableAutoCustomerEmail}
                    />
                    {enableAutoCustomerEmail && (
                      <>
                        <TextField
                          label="Resend API Key"
                          value={resendApiKey}
                          onChange={setResendApiKey}
                          type="password"
                          autoComplete="off"
                          helpText={isTr ? "resend.com adresinden ücretsiz alabilirsiniz" : "Get a free key from resend.com"}
                        />
                        <TextField
                          label={isTr ? "Gönderici email" : "From email"}
                          value={emailFrom}
                          onChange={setEmailFrom}
                          autoComplete="off"
                          helpText={isTr ? "Müşteriye gönderilecek emaillerin adresi" : "Email address for customer notifications"}
                        />
                      </>
                    )}
                  </BlockStack>
                </div>

                {/* Shipping */}
                <div style={{
                  padding: "16px", background: "#F9FAFB", borderRadius: 10,
                  border: "1px solid #E5E7EB",
                }}>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      {isTr ? "📦 Kargo Etiketi" : "📦 Shipping Labels"}
                    </Text>
                    <TextField
                      label="Shippo API Key"
                      value={shippoApiKey}
                      onChange={setShippoApiKey}
                      type="password"
                      autoComplete="off"
                      helpText={isTr ? "goshippo.com adresinden ücretsiz alabilirsiniz" : "Get a free key from goshippo.com"}
                    />
                  </BlockStack>
                </div>
              </>
            )}
          </BlockStack>
        </Card>

        {/* Navigation Buttons */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "0 0 40px",
        }}>
          <div>
            {currentStep > 0 && (
              <Button onClick={handleBack}>
                {isTr ? "← Geri" : "← Back"}
              </Button>
            )}
          </div>
          <InlineStack gap="200">
            {currentStep < 4 && (
              <Button onClick={handleSkip} variant="plain">
                {isTr ? "Adımı Atla →" : "Skip Step →"}
              </Button>
            )}
            {currentStep < 4 ? (
              <Button variant="primary" loading={isSubmitting} onClick={handleNext}>
                {isTr ? "Kaydet ve Devam →" : "Save & Continue →"}
              </Button>
            ) : (
              <Button variant="primary" loading={isSubmitting} onClick={handleComplete}>
                {isTr ? "🚀 Kurulumu Tamamla" : "🚀 Complete Setup"}
              </Button>
            )}
          </InlineStack>
        </div>

        {/* AI Policy Generation (shown after step 4 / on complete) */}
        {currentStep === 4 && hasAnthropicKey && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {isTr ? "🤖 AI ile İade Politikası Oluştur" : "🤖 Generate Return Policy with AI"}
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                {isTr
                  ? "Ayarlarınıza göre profesyonel bir iade politikası metni oluşturulur."
                  : "A professional return policy text will be generated based on your settings."}
              </Text>
              <Button
                onClick={handleGeneratePolicy}
                loading={generatingPolicy}
                disabled={policyGenerated}
              >
                {policyGenerated
                  ? (isTr ? "✅ Politika Oluşturuldu" : "✅ Policy Generated")
                  : (isTr ? "AI ile Politika Oluştur" : "Generate Policy with AI")}
              </Button>
              {policyGenerated && (
                <Banner tone="success">
                  {isTr
                    ? "İade politikanız oluşturuldu! İade Politikası sayfasından düzenleyebilirsiniz."
                    : "Your return policy has been generated! You can edit it from the Return Policy page."}
                </Banner>
              )}
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
