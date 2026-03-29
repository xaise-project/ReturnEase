import prisma from "../db.server";

const SHIPPO_API_URL = "https://api.goshippo.com";

interface Address {
  name: string;
  street1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  email?: string;
}

interface ShipmentResult {
  shipmentId: string;
  trackingNumber: string;
  labelUrl: string;
  carrier: string;
  rate: string;
}

async function shippoFetch(apiKey: string, endpoint: string, body: any) {
  const response = await fetch(`${SHIPPO_API_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `ShippoToken ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || error?.message || `Shippo API error: ${response.status}`);
  }

  return response.json();
}

async function shippoGet(apiKey: string, endpoint: string) {
  const response = await fetch(`${SHIPPO_API_URL}${endpoint}`, {
    method: "GET",
    headers: {
      "Authorization": `ShippoToken ${apiKey}`,
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || error?.message || `Shippo API error: ${response.status}`);
  }
  return response.json();
}

function buildShippoAddress(addr: Address) {
  return {
    name: addr.name,
    street1: addr.street1,
    city: addr.city,
    state: addr.state,
    zip: addr.zip,
    country: addr.country,
    phone: addr.phone || "",
    email: addr.email || "",
  };
}

export async function createReturnLabel(
  shop: string,
  returnRequestId: string,
  customerAddress: Address,
): Promise<ShipmentResult | null> {
  const settings = await prisma.storeSettings.findUnique({ where: { shop } });

  if (!settings?.shippoApiKey) {
    console.warn("Shippo API key not configured for shop:", shop);
    return null;
  }

  if (!settings.merchantAddress) {
    console.warn("Merchant address not configured for shop:", shop);
    return null;
  }

  // Parse merchant address (stored as multiline text)
  const addressLines = settings.merchantAddress.split("\n").map((l) => l.trim()).filter(Boolean);
  const merchantAddr: Address = {
    name: addressLines[0] || shop,
    street1: addressLines[1] || "",
    city: addressLines[2] || "",
    state: addressLines[3] || "",
    zip: addressLines[4] || "",
    country: addressLines[5] || "US",
  };

  try {
    // Shippo: create a shipment (for return, swap from/to so label goes from customer to merchant)
    const shipment = await shippoFetch(settings.shippoApiKey, "/shipments", {
      address_from: buildShippoAddress(customerAddress),
      address_to: buildShippoAddress(merchantAddr),
      parcels: [
        {
          length: "20",
          width: "15",
          height: "10",
          distance_unit: "cm",
          weight: "0.5",
          mass_unit: "kg",
        },
      ],
      async: false,
    });

    // Get rates from shipment
    const rates = shipment.rates || [];
    if (rates.length === 0) {
      throw new Error("No shipping rates available");
    }

    // Pick the lowest rate
    const lowestRate = rates.sort(
      (a: any, b: any) => parseFloat(a.amount) - parseFloat(b.amount)
    )[0];

    // Create transaction (buy the label)
    const transaction = await shippoFetch(settings.shippoApiKey, "/transactions", {
      rate: lowestRate.object_id,
      label_file_type: "PDF",
      async: false,
    });

    if (transaction.status !== "SUCCESS") {
      throw new Error(transaction.messages?.map((m: any) => m.text).join(", ") || "Label creation failed");
    }

    const result: ShipmentResult = {
      shipmentId: shipment.object_id,
      trackingNumber: transaction.tracking_number || "",
      labelUrl: transaction.label_url || "",
      carrier: lowestRate.provider || "",
      rate: lowestRate.amount || "0",
    };

    // Save to database
    await prisma.shippingLabel.upsert({
      where: { returnRequestId },
      update: {
        trackingNumber: result.trackingNumber,
        labelUrl: result.labelUrl,
        carrier: result.carrier,
        status: "CREATED",
      },
      create: {
        returnRequestId,
        trackingNumber: result.trackingNumber,
        labelUrl: result.labelUrl,
        carrier: result.carrier,
        status: "CREATED",
      },
    });

    return result;
  } catch (error: any) {
    console.error("Shippo label creation error:", error.message);
    return null;
  }
}

export async function refreshLabelStatus(shop: string, returnRequestId: string) {
  const settings = await prisma.storeSettings.findUnique({ where: { shop } });
  if (!settings?.shippoApiKey) return null;

  const label = await prisma.shippingLabel.findUnique({ where: { returnRequestId } });
  if (!label?.trackingNumber || !label.carrier) return label;

  try {
    const tracking = await shippoGet(
      settings.shippoApiKey,
      `/tracks/${encodeURIComponent(label.carrier)}/${encodeURIComponent(label.trackingNumber)}`,
    );
    const externalStatus = String(tracking?.tracking_status?.status || "").toUpperCase();
    const mappedStatus =
      externalStatus === "DELIVERED"
        ? "DELIVERED"
        : externalStatus === "TRANSIT" || externalStatus === "IN_TRANSIT"
          ? "IN_TRANSIT"
          : "CREATED";

    return await prisma.shippingLabel.update({
      where: { returnRequestId },
      data: { status: mappedStatus as any },
    });
  } catch (e: any) {
    console.error("Shippo status refresh error:", e.message);
    return null;
  }
}
