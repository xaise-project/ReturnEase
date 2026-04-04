import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useOutletContext } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  Button,
  Banner,
  Divider,
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
      blockMultipleReturnsSameOrder: true,
      requirePhotoForFraudReasons: true,
      highReturnRateThreshold: true,
      wardrobingWindowDays: true,
      wardrobingMaxReturns: true,
      ipRepeatWindowHours: true,
      ipRepeatMaxReturns: true,
    },
  });

  return { settings };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const blockMultipleReturnsSameOrder = formData.get("blockMultipleReturnsSameOrder") === "true";
  const requirePhotoForFraudReasons = formData.get("requirePhotoForFraudReasons") === "true";
  const highReturnRateThreshold = parseFloat((formData.get("highReturnRateThreshold") as string) || "0.5");
  const wardrobingWindowDays = parseInt((formData.get("wardrobingWindowDays") as string) || "30", 10) || 30;
  const wardrobingMaxReturns = parseInt((formData.get("wardrobingMaxReturns") as string) || "3", 10) || 3;
  const ipRepeatWindowHours = parseInt((formData.get("ipRepeatWindowHours") as string) || "24", 10) || 24;
  const ipRepeatMaxReturns = parseInt((formData.get("ipRepeatMaxReturns") as string) || "2", 10) || 2;

  await prisma.storeSettings.update({
    where: { shop: session.shop },
    data: {
      blockMultipleReturnsSameOrder,
      requirePhotoForFraudReasons,
      highReturnRateThreshold,
      wardrobingWindowDays,
      wardrobingMaxReturns,
      ipRepeatWindowHours,
      ipRepeatMaxReturns,
    },
  });

  return { success: true };
};

export default function AbusePrevention() {
  const { settings } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const { t } = useOutletContext<{ locale: Locale; t: Record<string, string> }>();
  const [saved, setSaved] = useState(false);

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

  const handleSave = () => {
    setSaved(false);
    const formData = new FormData();
    formData.set("blockMultipleReturnsSameOrder", String(blockMultipleReturnsSameOrder));
    formData.set("requirePhotoForFraudReasons", String(requirePhotoForFraudReasons));
    formData.set("highReturnRateThreshold", highReturnRateThreshold);
    formData.set("wardrobingWindowDays", wardrobingWindowDays);
    formData.set("wardrobingMaxReturns", wardrobingMaxReturns);
    formData.set("ipRepeatWindowHours", ipRepeatWindowHours);
    formData.set("ipRepeatMaxReturns", ipRepeatMaxReturns);
    submit(formData, { method: "post" });
    setTimeout(() => setSaved(true), 500);
  };

  return (
    <Page fullWidth>
      <TitleBar title={t["abusePrevention.title"] || "Kötüye Kullanım Önleme"} />
      <BlockStack gap="400">
        {saved && !isSubmitting && (
          <Banner title={t["settings.saved"]} tone="success" onDismiss={() => setSaved(false)} />
        )}

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">{t["settings.fraudPrevention"] || "🛡️ Kötüye Kullanım Önleme"}</Text>
            <Text as="p" tone="subdued" variant="bodySm">
              Mağazanızı iade kötüye kullanımından korur. Bir profil seçin veya kuralları kendiniz ayarlayın.
            </Text>
            <Divider />

            {/* Koruma Profilleri */}
            <Text as="p" variant="bodyMd" fontWeight="semibold">Koruma Profili</Text>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
              {[
                { key: "rahat", emoji: "🟢", label: "Rahat", sub: "Müşteri odaklı" },
                { key: "dengeli", emoji: "🟡", label: "Dengeli ⭐", sub: "Önerilen" },
                { key: "siki", emoji: "🔴", label: "Sıkı", sub: "Maksimum koruma" },
                { key: "ozel", emoji: "⚙️", label: "Özel", sub: "Manuel ayar" },
              ].map((profile) => {
                const currentProfile = (() => {
                  const threshold = parseFloat(highReturnRateThreshold);
                  const wDays = parseInt(wardrobingWindowDays);
                  const ipHours = parseInt(ipRepeatWindowHours);
                  if (threshold === 0.3 && wDays === 60 && ipHours === 48) return "rahat";
                  if (threshold === 0.5 && wDays === 30 && ipHours === 24) return "dengeli";
                  if (threshold === 0.7 && wDays === 14 && ipHours === 12) return "siki";
                  return "ozel";
                })();
                const isSelected = currentProfile === profile.key;
                return (
                  <div
                    key={profile.key}
                    onClick={() => {
                      if (profile.key === "rahat") {
                        setHighReturnRateThreshold("0.3");
                        setWardrobingWindowDays("60");
                        setWardrobingMaxReturns("5");
                        setIpRepeatWindowHours("48");
                        setIpRepeatMaxReturns("3");
                        setBlockMultipleReturnsSameOrder(false);
                        setRequirePhotoForFraudReasons(false);
                      } else if (profile.key === "dengeli") {
                        setHighReturnRateThreshold("0.5");
                        setWardrobingWindowDays("30");
                        setWardrobingMaxReturns("3");
                        setIpRepeatWindowHours("24");
                        setIpRepeatMaxReturns("2");
                        setBlockMultipleReturnsSameOrder(true);
                        setRequirePhotoForFraudReasons(true);
                      } else if (profile.key === "siki") {
                        setHighReturnRateThreshold("0.7");
                        setWardrobingWindowDays("14");
                        setWardrobingMaxReturns("2");
                        setIpRepeatWindowHours("12");
                        setIpRepeatMaxReturns("1");
                        setBlockMultipleReturnsSameOrder(true);
                        setRequirePhotoForFraudReasons(true);
                      }
                    }}
                    style={{
                      padding: "14px 12px",
                      borderRadius: 10,
                      border: `2px solid ${isSelected ? "#6366F1" : "#E5E7EB"}`,
                      background: isSelected ? "#F5F3FF" : "#fff",
                      cursor: profile.key === "ozel" ? "default" : "pointer",
                      textAlign: "center",
                      transition: "border-color 0.15s, background 0.15s",
                    }}
                  >
                    <div style={{ fontSize: 20, marginBottom: 4 }}>{profile.emoji}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: isSelected ? "#6366F1" : "#111827" }}>{profile.label}</div>
                    <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>{profile.sub}</div>
                  </div>
                );
              })}
            </div>

            <Divider />

            {/* Kural Kartları */}
            <BlockStack gap="300">

              {/* Aynı siparişe 2. iade */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", background: "#F9FAFB", borderRadius: 10, border: "1px solid #E5E7EB" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#111827", marginBottom: 3 }}>
                    🔒 Aynı Siparişe 2. İade Engeli
                  </div>
                  <div style={{ fontSize: 12, color: "#6B7280" }}>
                    Bir siparişteki ürün zaten iade edildiyse tekrar iade başvurusunu engeller.
                  </div>
                </div>
                <div
                  onClick={() => setBlockMultipleReturnsSameOrder(!blockMultipleReturnsSameOrder)}
                  style={{
                    width: 44, height: 24, borderRadius: 99,
                    background: blockMultipleReturnsSameOrder ? "#6366F1" : "#D1D5DB",
                    position: "relative", cursor: "pointer",
                    transition: "background 0.2s", flexShrink: 0, marginLeft: 16,
                  }}
                >
                  <div style={{
                    width: 18, height: 18, borderRadius: "50%", background: "#fff",
                    position: "absolute", top: 3,
                    left: blockMultipleReturnsSameOrder ? 23 : 3,
                    transition: "left 0.2s",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                  }} />
                </div>
              </div>

              {/* Fotoğraf zorunluluğu */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", background: "#F9FAFB", borderRadius: 10, border: "1px solid #E5E7EB" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#111827", marginBottom: 3 }}>
                    📷 Hasarlı Ürün İçin Fotoğraf Zorunlu
                  </div>
                  <div style={{ fontSize: 12, color: "#6B7280" }}>
                    Müşteri "hasarlı" veya "yanlış ürün" seçince iade öncesi fotoğraf yüklemesi istenir.
                  </div>
                </div>
                <div
                  onClick={() => setRequirePhotoForFraudReasons(!requirePhotoForFraudReasons)}
                  style={{
                    width: 44, height: 24, borderRadius: 99,
                    background: requirePhotoForFraudReasons ? "#6366F1" : "#D1D5DB",
                    position: "relative", cursor: "pointer",
                    transition: "background 0.2s", flexShrink: 0, marginLeft: 16,
                  }}
                >
                  <div style={{
                    width: 18, height: 18, borderRadius: "50%", background: "#fff",
                    position: "absolute", top: 3,
                    left: requirePhotoForFraudReasons ? 23 : 3,
                    transition: "left 0.2s",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                  }} />
                </div>
              </div>

              {/* Riskli müşteri uyarısı */}
              <div style={{ padding: "14px 16px", background: "#F9FAFB", borderRadius: 10, border: "1px solid #E5E7EB" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#111827", marginBottom: 3 }}>
                      🚨 Riskli Müşteri Uyarısı
                    </div>
                    <div style={{ fontSize: 12, color: "#6B7280" }}>
                      Siparişlerinin büyük çoğunluğunu iade eden müşteriler işaretlenir. İade engellenmez, sadece uyarı gösterilir.
                    </div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#6366F1", background: "#EEF2FF", padding: "2px 10px", borderRadius: 99, whiteSpace: "nowrap", marginLeft: 12 }}>
                    %{Math.round(parseFloat(highReturnRateThreshold || "0.5") * 100)}+
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {[
                    { label: "Düşük", sub: "%30+", value: "0.3" },
                    { label: "Orta", sub: "%50+", value: "0.5" },
                    { label: "Yüksek", sub: "%70+", value: "0.7" },
                  ].map((opt) => (
                    <div
                      key={opt.value}
                      onClick={() => setHighReturnRateThreshold(opt.value)}
                      style={{
                        flex: 1, textAlign: "center", padding: "8px 4px",
                        borderRadius: 8, cursor: "pointer",
                        border: `2px solid ${highReturnRateThreshold === opt.value ? "#6366F1" : "#E5E7EB"}`,
                        background: highReturnRateThreshold === opt.value ? "#EEF2FF" : "#fff",
                        transition: "border-color 0.15s",
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 600, color: highReturnRateThreshold === opt.value ? "#6366F1" : "#374151" }}>{opt.label}</div>
                      <div style={{ fontSize: 11, color: "#9CA3AF" }}>{opt.sub}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Wardrobing */}
              <div style={{ padding: "14px 16px", background: "#F9FAFB", borderRadius: 10, border: "1px solid #E5E7EB" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>👗 Wardrobing Koruması</span>
                      <InfoTooltip content={t["tooltip.wardrobing"] || "Müşteri ürünü kullanıp iade ediyor. Örn: bir etkinlik için elbise alıp geri göndermek. Sık iade yapan müşterileri tespit eder."} />
                    </div>
                    <div style={{ fontSize: 12, color: "#6B7280" }}>
                      Belirli bir süre içinde çok sık iade yapan müşterileri tespit eder.
                    </div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#6366F1", background: "#EEF2FF", padding: "2px 10px", borderRadius: 99, whiteSpace: "nowrap", marginLeft: 12 }}>
                    {wardrobingWindowDays} gün / {wardrobingMaxReturns} iade
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 4 }}>Kontrol penceresi</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {[{ label: "14 gün", value: "14" }, { label: "30 gün", value: "30" }, { label: "60 gün", value: "60" }].map((opt) => (
                        <div
                          key={opt.value}
                          onClick={() => setWardrobingWindowDays(opt.value)}
                          style={{
                            flex: 1, textAlign: "center", padding: "6px 4px",
                            borderRadius: 8, cursor: "pointer", fontSize: 12,
                            border: `2px solid ${wardrobingWindowDays === opt.value ? "#6366F1" : "#E5E7EB"}`,
                            background: wardrobingWindowDays === opt.value ? "#EEF2FF" : "#fff",
                            fontWeight: wardrobingWindowDays === opt.value ? 600 : 400,
                            color: wardrobingWindowDays === opt.value ? "#6366F1" : "#374151",
                            transition: "border-color 0.15s",
                          }}
                        >{opt.label}</div>
                      ))}
                    </div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 4 }}>Max iade sayısı</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {[{ label: "2 iade", value: "2" }, { label: "3 iade", value: "3" }, { label: "5 iade", value: "5" }].map((opt) => (
                        <div
                          key={opt.value}
                          onClick={() => setWardrobingMaxReturns(opt.value)}
                          style={{
                            flex: 1, textAlign: "center", padding: "6px 4px",
                            borderRadius: 8, cursor: "pointer", fontSize: 12,
                            border: `2px solid ${wardrobingMaxReturns === opt.value ? "#6366F1" : "#E5E7EB"}`,
                            background: wardrobingMaxReturns === opt.value ? "#EEF2FF" : "#fff",
                            fontWeight: wardrobingMaxReturns === opt.value ? 600 : 400,
                            color: wardrobingMaxReturns === opt.value ? "#6366F1" : "#374151",
                            transition: "border-color 0.15s",
                          }}
                        >{opt.label}</div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Aynı cihazdan tekrar iade */}
              <div style={{ padding: "14px 16px", background: "#F9FAFB", borderRadius: 10, border: "1px solid #E5E7EB" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>🖥️ Aynı Cihazdan Tekrar İade</span>
                      <InfoTooltip content={t["tooltip.ipDetection"] || "Ofis veya VPN kullanan müşterilerde yanlış pozitif tetiklenebilir. Düşük hassasiyet ile başlamanızı öneririz."} />
                    </div>
                    <div style={{ fontSize: 12, color: "#6B7280" }}>
                      Kısa süre içinde aynı cihazdan (IP) gelen toplu iade girişimlerini engeller.
                    </div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#6366F1", background: "#EEF2FF", padding: "2px 10px", borderRadius: 99, whiteSpace: "nowrap", marginLeft: 12 }}>
                    {parseInt(ipRepeatWindowHours) === 0 ? "Kapalı" : `${ipRepeatWindowHours} saat`}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {[
                    { label: "Kapalı", sub: "—", hours: "0", returns: "0" },
                    { label: "Düşük", sub: "48 saat", hours: "48", returns: "3" },
                    { label: "Orta", sub: "24 saat", hours: "24", returns: "2" },
                    { label: "Yüksek", sub: "12 saat", hours: "12", returns: "1" },
                  ].map((opt) => {
                    const isSelected = opt.hours === "0"
                      ? parseInt(ipRepeatWindowHours) === 0
                      : ipRepeatWindowHours === opt.hours;
                    return (
                      <div
                        key={opt.hours}
                        onClick={() => {
                          setIpRepeatWindowHours(opt.hours === "0" ? "1" : opt.hours);
                          setIpRepeatMaxReturns(opt.returns === "0" ? "1" : opt.returns);
                          if (opt.hours === "0") setIpRepeatWindowHours("0");
                        }}
                        style={{
                          flex: 1, textAlign: "center", padding: "8px 4px",
                          borderRadius: 8, cursor: "pointer",
                          border: `2px solid ${isSelected ? "#6366F1" : "#E5E7EB"}`,
                          background: isSelected ? "#EEF2FF" : "#fff",
                          transition: "border-color 0.15s",
                        }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 600, color: isSelected ? "#6366F1" : "#374151" }}>{opt.label}</div>
                        <div style={{ fontSize: 11, color: "#9CA3AF" }}>{opt.sub}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

            </BlockStack>

            <Divider />

            {/* Canlı Özet */}
            <div style={{ padding: "14px 16px", background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#166534", marginBottom: 8 }}>✅ Aktif Korumalar</div>
              <BlockStack gap="100">
                {blockMultipleReturnsSameOrder && (
                  <Text as="p" variant="bodySm">• Aynı siparişe 2. iade engellendi</Text>
                )}
                {requirePhotoForFraudReasons && (
                  <Text as="p" variant="bodySm">• Hasar nedeniyle iade için fotoğraf isteniyor</Text>
                )}
                {parseFloat(highReturnRateThreshold) > 0 && (
                  <Text as="p" variant="bodySm">• Siparişlerinin %{Math.round(parseFloat(highReturnRateThreshold) * 100)}+ iade eden müşteriler işaretleniyor</Text>
                )}
                {parseInt(wardrobingWindowDays) > 0 && (
                  <Text as="p" variant="bodySm">• {wardrobingWindowDays} gün içinde {wardrobingMaxReturns}+ iade yapan müşteriler tespit ediliyor</Text>
                )}
                {parseInt(ipRepeatWindowHours) > 0 && (
                  <Text as="p" variant="bodySm">• {ipRepeatWindowHours} saat içinde aynı cihazdan {ipRepeatMaxReturns}+ iade girişimi engelleniyor</Text>
                )}
                {!blockMultipleReturnsSameOrder && !requirePhotoForFraudReasons && parseFloat(highReturnRateThreshold) === 0 && parseInt(ipRepeatWindowHours) === 0 && (
                  <Text as="p" variant="bodySm" tone="subdued">Hiçbir koruma aktif değil.</Text>
                )}
              </BlockStack>
            </div>

          </BlockStack>
        </Card>

        <Button variant="primary" loading={isSubmitting} onClick={handleSave}>
          {t["settings.save"]}
        </Button>
      </BlockStack>
    </Page>
  );
}
