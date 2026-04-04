import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
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
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import type { Locale } from "../services/i18n-admin";
import { InfoTooltip } from "../components/InfoTooltip";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await prisma.storeSettings.findUnique({
    where: { shop: session.shop },
    select: {
      returnWindowDays: true,
      isAutoApprove: true,
      autoApproveUnderAmount: true,
      merchantAddress: true,
      returnPolicy: true,
    },
  });
  return { settings, shop: session.shop };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const returnWindowDays = parseInt(formData.get("returnWindowDays") as string) || 30;
  const isAutoApprove = formData.get("isAutoApprove") === "true";
  const autoApproveUnderAmount = parseFloat((formData.get("autoApproveUnderAmount") as string) || "0");
  const merchantAddress = (formData.get("merchantAddress") as string) || "";
  const returnPolicy = (formData.get("returnPolicy") as string) || "";

  await prisma.storeSettings.update({
    where: { shop: session.shop },
    data: { returnWindowDays, isAutoApprove, autoApproveUnderAmount, merchantAddress, returnPolicy },
  });

  return { success: true };
};

const POLICY_PRESETS_EN = [
  {
    label: "Standard (30-day)",
    text: "We accept returns within 30 days of delivery. Items must be unused, unwashed, and in their original packaging with tags attached. To initiate a return, please use our returns portal. Once we receive and inspect the item, your refund will be processed within 5–7 business days.",
  },
  {
    label: "Flexible (Exchange-first)",
    text: "We want you to love your purchase. If something isn't right, we offer exchanges or store credit within 45 days of delivery. Refunds are available within 14 days of delivery. Items must be in original condition. Start your return through our portal and we'll guide you through the process.",
  },
  {
    label: "Strict (Final sale)",
    text: "Returns are accepted within 14 days of delivery for defective or incorrect items only. All sale items are final sale and cannot be returned or exchanged. Items must be returned in their original condition and packaging. Please contact us before initiating a return.",
  },
];

const POLICY_PRESETS_TR = [
  {
    label: "Standart (30 gün)",
    text: "Teslimattan itibaren 30 gün içinde iade kabul ediyoruz. Ürünler kullanılmamış, yıkanmamış ve orijinal ambalajında etiketleri takılı olmalıdır. İade başlatmak için iade portalımızı kullanın. Ürünü aldıktan ve inceledikten sonra iadeniz 5-7 iş günü içinde işleme alınacaktır.",
  },
  {
    label: "Esnek (Değişim öncelikli)",
    text: "Satın alımınızı sevmenizi istiyoruz. Bir sorun varsa, teslimattan itibaren 45 gün içinde değişim veya mağaza kredisi sunuyoruz. İadeler teslimattan itibaren 14 gün içinde yapılabilir. Ürünler orijinal durumunda olmalıdır. Portalımızdan iade başlatın.",
  },
  {
    label: "Sıkı (Son satış)",
    text: "İadeler yalnızca kusurlu veya yanlış ürünler için teslimattan itibaren 14 gün içinde kabul edilir. İndirimli ürünler iade veya değişim yapılamaz. Ürünler orijinal durumunda ve ambalajında iade edilmelidir. İade başlatmadan önce bizimle iletişime geçin.",
  },
];

export default function PolicyPage() {
  const { settings } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const { t, locale } = useOutletContext<{ locale: Locale; t: Record<string, string> }>();

  const [returnWindowDays, setReturnWindowDays] = useState(String(settings?.returnWindowDays ?? 30));
  const [isAutoApprove, setIsAutoApprove] = useState(settings?.isAutoApprove ?? false);
  const [autoApproveUnderAmount, setAutoApproveUnderAmount] = useState(
    settings?.autoApproveUnderAmount ? String(settings.autoApproveUnderAmount) : "0",
  );
  const [merchantAddress, setMerchantAddress] = useState(settings?.merchantAddress ?? "");
  const [returnPolicy, setReturnPolicy] = useState(settings?.returnPolicy ?? "");
  const [saved, setSaved] = useState(false);

  const POLICY_PRESETS = locale === "tr" ? POLICY_PRESETS_TR : POLICY_PRESETS_EN;

  const handleSave = () => {
    setSaved(false);
    const formData = new FormData();
    formData.set("returnWindowDays", returnWindowDays);
    formData.set("isAutoApprove", String(isAutoApprove));
    formData.set("autoApproveUnderAmount", autoApproveUnderAmount);
    formData.set("merchantAddress", merchantAddress);
    formData.set("returnPolicy", returnPolicy);
    submit(formData, { method: "post" });
    setTimeout(() => setSaved(true), 300);
  };

  return (
    <Page fullWidth>
      <TitleBar title={t["policy.title"] || "Return Policy"} />
      <BlockStack gap="400">
        {saved && !isSubmitting && (
          <Banner title={t["settings.saved"]} tone="success" onDismiss={() => setSaved(false)} />
        )}

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">{t["settings.returnPolicy"]}</Text>
            </InlineStack>
            <Divider />
            <div style={{ display: "flex", alignItems: "center" }}>
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
              <InfoTooltip content={t["tooltip.returnWindow"] || "30 days is standard, 14 days is strict, 60 days is customer-friendly. Most Shopify stores use 30 days."} />
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center" }}>
                <Checkbox
                  label={t["settings.autoApprove"]}
                  checked={isAutoApprove}
                  onChange={setIsAutoApprove}
                  helpText={t["settings.autoApproveHelp"]}
                />
                <InfoTooltip content={t["tooltip.autoApprove"] || "Speeds up low-value returns but increases fraud risk. Recommended with an amount threshold."} />
              </div>
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
                      {t["settings.autoApproveRiskText"] || "Auto-approve will automatically accept all return requests without manual review. We recommend setting an amount limit below."}
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
            <Text as="h2" variant="headingMd">{t["settings.policyText"] || "Return Policy Text"}</Text>
            <Divider />
            <Text as="p" variant="bodySm" tone="subdued">
              {t["settings.policyPresetsHelp"] || "Choose a preset template to get started, then customize below."}
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
            <InfoTooltip
              content={t["tooltip.policyText"] || "This text is displayed on your returns portal. A clear policy reduces customer confusion and support tickets."}
              mode="expandable"
              label={t["tooltip.learnMore"] || "What makes a good policy?"}
            />
          </BlockStack>
        </Card>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button variant="primary" loading={isSubmitting} onClick={handleSave}>
            {t["settings.save"]}
          </Button>
        </div>
      </BlockStack>
    </Page>
  );
}
