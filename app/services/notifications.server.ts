import prisma from "../db.server";

type NotificationEvent =
  | "RETURN_RECEIVED"
  | "RETURN_APPROVED"
  | "RETURN_DECLINED"
  | "RETURN_COMPLETED"
  | "RETURN_CANCELLED"
  | "CUSTOM_EMAIL";

type ReturnPayload = {
  id: string;
  orderName: string;
  customerEmail?: string | null;
  reason?: string | null;
  status: string;
  resolutionType?: string | null;
  amount?: number;
  customSubject?: string;
  customMessage?: string;
};

function applyTemplate(template: string, vars: Record<string, string>) {
  let output = template;
  for (const [key, value] of Object.entries(vars)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }
  return output;
}

function defaultBodyByEvent(event: NotificationEvent) {
  if (event === "RETURN_RECEIVED") return "İade talebiniz alındı. Sipariş: {{orderName}}";
  if (event === "RETURN_APPROVED") return "İade talebiniz onaylandı. Sipariş: {{orderName}}";
  if (event === "RETURN_DECLINED") return "İade talebiniz reddedildi. Sipariş: {{orderName}}";
  if (event === "RETURN_COMPLETED") return "İade süreciniz tamamlandı. Sipariş: {{orderName}}";
  if (event === "CUSTOM_EMAIL") return "{{customMessage}}";
  return "İade talebiniz güncellendi. Sipariş: {{orderName}}";
}

function subjectByEvent(event: NotificationEvent) {
  if (event === "RETURN_RECEIVED") return "Return received";
  if (event === "RETURN_APPROVED") return "Return approved";
  if (event === "RETURN_DECLINED") return "Return declined";
  if (event === "RETURN_COMPLETED") return "Return completed";
  if (event === "CUSTOM_EMAIL") return "{{customSubject}}";
  return "Return update";
}

async function sendResendEmail(params: {
  apiKey: string;
  from: string;
  replyTo?: string | null;
  to: string;
  subject: string;
  html: string;
}) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: params.from,
      to: params.to,
      subject: params.subject,
      html: params.html,
      reply_to: params.replyTo || undefined,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Resend error ${response.status}`);
  }
}

async function postWebhook(url: string, payload: Record<string, any>) {
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function sendKlaviyoEvent(apiKey: string, payload: {
  event: NotificationEvent;
  shop: string;
  returnRequest: ReturnPayload;
}) {
  const response = await fetch("https://a.klaviyo.com/api/events/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Klaviyo-API-Key ${apiKey}`,
      "revision": "2024-05-15",
    },
    body: JSON.stringify({
      data: {
        type: "event",
        attributes: {
          properties: {
            shop: payload.shop,
            event: payload.event,
            returnId: payload.returnRequest.id,
            orderName: payload.returnRequest.orderName,
            reason: payload.returnRequest.reason || "",
            status: payload.returnRequest.status,
            resolutionType: payload.returnRequest.resolutionType || "",
            amount: payload.returnRequest.amount || 0,
          },
          metric: {
            data: {
              type: "metric",
              attributes: { name: `ReturnEase ${payload.event}` },
            },
          },
          profile: payload.returnRequest.customerEmail
            ? {
                data: {
                  type: "profile",
                  attributes: { email: payload.returnRequest.customerEmail },
                },
              }
            : undefined,
        },
      },
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Klaviyo error ${response.status}`);
  }
}

export async function dispatchReturnNotifications(params: {
  shop: string;
  event: NotificationEvent;
  returnRequest: ReturnPayload;
}) {
  const settings = await prisma.storeSettings.findUnique({ where: { shop: params.shop } });
  if (!settings) return;

  const vars = {
    orderName: params.returnRequest.orderName || "-",
    returnId: params.returnRequest.id || "-",
    reason: params.returnRequest.reason || "-",
    resolutionType: params.returnRequest.resolutionType || "-",
    amount: (params.returnRequest.amount || 0).toFixed(2),
    status: params.returnRequest.status || "-",
  };

  const header = settings.emailTemplateHeaderText || "ReturnEase";
  const footer = settings.emailTemplateFooterText || "ReturnEase ekibi";
  
  let bodyTemplate: string;
  if (params.event === "CUSTOM_EMAIL" && params.returnRequest.customMessage) {
    bodyTemplate = params.returnRequest.customMessage;
  } else {
    bodyTemplate =
      (params.event === "RETURN_RECEIVED" && settings.emailTemplateReceived) ||
      (params.event === "RETURN_APPROVED" && settings.emailTemplateApproved) ||
      (params.event === "RETURN_DECLINED" && settings.emailTemplateDeclined) ||
      (params.event === "RETURN_COMPLETED" && settings.emailTemplateCompleted) ||
      defaultBodyByEvent(params.event);
  }
  
  const body = applyTemplate(bodyTemplate, vars);
  const html = `<div style="font-family:Arial,sans-serif"><h2 style="color:${settings.brandColor || "#000000"}">${header}</h2><p>${body}</p><p style="margin-top:24px;color:#6b7280">${footer}</p></div>`;

  if (
    (settings.enableAutoCustomerEmail || params.event === "CUSTOM_EMAIL") &&
    settings.emailProvider === "RESEND" &&
    settings.resendApiKey &&
    settings.emailFrom &&
    params.returnRequest.customerEmail
  ) {
    try {
      await sendResendEmail({
        apiKey: settings.resendApiKey,
        from: settings.emailFrom,
        replyTo: settings.emailReplyTo,
        to: params.returnRequest.customerEmail,
        subject: params.event === "CUSTOM_EMAIL" && params.returnRequest.customSubject 
          ? params.returnRequest.customSubject 
          : subjectByEvent(params.event),
        html,
      });
    } catch (e: any) {
      await prisma.returnActionLog.create({
        data: {
          shop: params.shop,
          returnRequestId: params.returnRequest.id,
          action: "NOTIFY_CUSTOMER_FAILED",
          actor: "system:notifications",
          note: e.message,
          metadata: { event: params.event },
        },
      });
    }
  }

  if (
    params.event === "RETURN_RECEIVED" &&
    settings.enableMerchantNewReturnNotification &&
    settings.emailProvider === "RESEND" &&
    settings.resendApiKey &&
    settings.emailFrom &&
    settings.merchantNotificationEmail
  ) {
    try {
      await sendResendEmail({
        apiKey: settings.resendApiKey,
        from: settings.emailFrom,
        replyTo: settings.emailReplyTo,
        to: settings.merchantNotificationEmail,
        subject: "New return request",
        html,
      });
    } catch (e: any) {
      await prisma.returnActionLog.create({
        data: {
          shop: params.shop,
          returnRequestId: params.returnRequest.id,
          action: "NOTIFY_MERCHANT_FAILED",
          actor: "system:notifications",
          note: e.message,
          metadata: { event: params.event },
        },
      });
    }
  }

  const webhookPayload = {
    event: params.event,
    shop: params.shop,
    returnRequest: params.returnRequest,
    sentAt: new Date().toISOString(),
  };

  if (settings.enableSmsNotifications && settings.smsWebhookUrl) {
    try {
      await postWebhook(settings.smsWebhookUrl, { channel: "sms", ...webhookPayload });
    } catch {}
  }
  if (settings.enableWhatsAppNotifications && settings.whatsappWebhookUrl) {
    try {
      await postWebhook(settings.whatsappWebhookUrl, { channel: "whatsapp", ...webhookPayload });
    } catch {}
  }
  if (settings.enableFlowWebhook && settings.flowWebhookUrl) {
    try {
      await postWebhook(settings.flowWebhookUrl, { channel: "shopify_flow", ...webhookPayload });
    } catch {}
  }
  if (settings.enableSlackNotifications && settings.slackWebhookUrl) {
    try {
      await postWebhook(settings.slackWebhookUrl, {
        text: `ReturnEase • ${params.event}\nShop: ${params.shop}\nOrder: ${params.returnRequest.orderName}\nStatus: ${params.returnRequest.status}`,
        event: params.event,
        returnRequest: params.returnRequest,
      });
    } catch {}
  }
  if (settings.enableGorgias && settings.gorgiasWebhookUrl) {
    try {
      await postWebhook(settings.gorgiasWebhookUrl, { channel: "gorgias", ...webhookPayload });
    } catch {}
  }
  if (settings.enableZendesk && settings.zendeskWebhookUrl) {
    try {
      await postWebhook(settings.zendeskWebhookUrl, { channel: "zendesk", ...webhookPayload });
    } catch {}
  }
  if (settings.enableKlaviyo && settings.klaviyoApiKey) {
    try {
      await sendKlaviyoEvent(settings.klaviyoApiKey, {
        event: params.event,
        shop: params.shop,
        returnRequest: params.returnRequest,
      });
    } catch (e: any) {
      await prisma.returnActionLog.create({
        data: {
          shop: params.shop,
          returnRequestId: params.returnRequest.id,
          action: "NOTIFY_KLAVIYO_FAILED",
          actor: "system:notifications",
          note: e.message,
          metadata: { event: params.event },
        },
      });
    }
  }

  await prisma.returnActionLog.create({
    data: {
      shop: params.shop,
      returnRequestId: params.returnRequest.id,
      action: "NOTIFY_DISPATCHED",
      actor: "system:notifications",
      metadata: { event: params.event },
    },
  });
}
