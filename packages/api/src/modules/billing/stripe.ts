import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyStripeWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
  toleranceSec = 300,
): boolean {
  const parts = signatureHeader.split(",").map((p) => p.trim());
  const timestampPart = parts.find((p) => p.startsWith("t="));
  // During webhook-secret rotation Stripe signs with BOTH secrets and sends
  // multiple v1 entries — the event is authentic if ANY of them matches, so
  // checking only the first would drop valid events mid-rotation.
  const sigParts = parts.filter((p) => p.startsWith("v1="));
  if (!timestampPart || sigParts.length === 0) return false;

  const timestampRaw = timestampPart.slice(2);
  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > toleranceSec) return false;

  // Sign over the EXACT timestamp bytes Stripe sent, not the Number()-normalized
  // form: Stripe's scheme HMACs the literal `t=` value, so normalizing (e.g.
  // stripping a leading zero or `+`) would hash a different payload than Stripe
  // signed and reject an authentic event.
  const payload = `${timestampRaw}.${rawBody.toString("utf8")}`;
  const digest = createHmac("sha256", secret).update(payload).digest("hex");

  return sigParts.some((part) => {
    try {
      return timingSafeEqual(Buffer.from(digest), Buffer.from(part.slice(3)));
    } catch {
      return false;
    }
  });
}

// Partial views of Stripe payloads — exactly the fields the webhook handler
// reads. Everything is optional: the shapes come off the wire, so the handler
// must tolerate absence rather than trust a cast.
export interface StripeCheckoutSession {
  customer?: string | null;
  metadata?: Record<string, string>;
  amount_total?: number | null;
}

export interface StripeSubscription {
  customer?: string | null;
  status?: string;
  items?: { data?: Array<{ price?: { id?: string } }> };
}

export interface StripeInvoice {
  customer?: string | null;
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export async function createStripeMeterEvent(
  secretKey: string,
  params: {
    eventName: string;
    stripeCustomerId: string;
    value: number;
    identifier: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const body = new URLSearchParams({
    event_name: params.eventName,
    "payload[stripe_customer_id]": params.stripeCustomerId,
    "payload[value]": String(params.value),
    identifier: params.identifier,
  });

  const res = await fetchImpl("https://api.stripe.com/v1/billing/meter_events", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) return null;
  const json = (await res.json()) as { identifier?: string };
  return json.identifier ?? params.identifier;
}
