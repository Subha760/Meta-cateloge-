// whatsappOrders.js
//
// Handles orders placed via WhatsApp — whether the customer came from
// your catalog directly, or clicked a "Click to WhatsApp" ad (Meta
// attaches a `referral` block to the first message in that case, which
// we log for attribution).
//
// FLOW:
//   1. Customer taps items in your WhatsApp catalog and sends an order.
//   2. WhatsApp sends us a webhook with message.type === "order",
//      listing product_retailer_id (matches the `id` field from your
//      Meta feed) + quantities.
//   3. WhatsApp order messages do NOT include a delivery address, so we
//      reply asking for it and hold the order as "pending" in memory.
//   4. Customer's next text message is treated as their address; we pull
//      a 6-digit PIN code out of it and forward the completed order to
//      SheScale via POST /orders — same call your WooCommerce plugin
//      makes on checkout.
//
// NOTE ON STORAGE: pending orders are held in memory (a plain object).
// That's fine for normal traffic, but a Render restart/idle-spindown
// will drop anything mid-conversation (rare, but possible on the free
// tier). If that becomes a problem in practice, move `pendingOrders` to
// Render's Key Value store instead of an in-memory object — say the
// word and I'll wire that in.

const crypto = require('crypto');
const fetch = require('node-fetch');

const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const SHESCALE_API_BASE_URL = process.env.SHESCALE_API_BASE_URL || 'https://api.shescale.in/api/v1/partner/v1';
const SHESCALE_API_KEY = process.env.SHESCALE_API_KEY;

const pendingOrders = {}; // wa_id -> { items, customerName, adRef, createdAt }

function verifySignature(rawBody, signatureHeader) {
  if (!WHATSAPP_APP_SECRET) return true; // allow through if not configured yet (dev mode)
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', WHATSAPP_APP_SECRET).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

async function sendWhatsAppText(to, body) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.error('WhatsApp send skipped — WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set');
    return;
  }
  await fetch(`https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  }).catch((err) => console.error('WhatsApp send failed:', err.message));
}

/**
 * product_retailer_id in the WhatsApp order matches the `id` field from
 * your Meta feed: "<productId>-<variantId>" for variant items, or just
 * "<productId>" for products with no variants.
 */
function parseRetailerId(retailerId) {
  const idx = retailerId.lastIndexOf('-');
  // Guard against product IDs that themselves contain hyphens by only
  // splitting if what's after the last hyphen looks like a variant id
  // (SheScale ids are typically alphanumeric — adjust if yours differ).
  if (idx === -1) return { productId: retailerId, variantId: null };
  return { productId: retailerId.slice(0, idx), variantId: retailerId.slice(idx + 1) };
}

async function forwardOrderToShescale({ customerName, phone, addressText, items, adRef }) {
  const pincodeMatch = addressText.match(/\b\d{6}\b/);
  const pincode = pincodeMatch ? pincodeMatch[0] : null;

  if (!pincode) {
    return { ok: false, error: 'no_pincode_found' };
  }

  const body = {
    customerName,
    customerPhone: phone.slice(-10),
    shippingAddress: {
      addressLine1: addressText.replace(pincode, '').trim().slice(0, 200) || addressText.slice(0, 200),
      city: '',
      state: '',
      pincode,
    },
    items: items.map((i) => ({
      productId: i.productId,
      variantId: i.variantId,
      quantity: i.quantity,
    })),
    paymentMethod: 'COD', // WhatsApp catalog orders have no payment step — COD is the safe default
    externalRef: `WA-${phone}-${Date.now()}${adRef ? '-AD' : ''}`,
  };

  const idem = 'wa-' + crypto.createHash('md5').update(phone + JSON.stringify(items) + Date.now()).digest('hex');

  const res = await fetch(`${SHESCALE_API_BASE_URL}/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SHESCALE_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idem,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: data?.message || `${res.status} ${res.statusText}` };
  }
  return { ok: true, orderNumber: data?.orderNumber || data?.data?.orderNumber };
}

/**
 * Main webhook handler. Call this from your Express route with the
 * already-verified-and-JSON-parsed request body.
 */
async function handleWebhookEvent(body) {
  const entries = body.entry || [];

  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contact = (value.contacts || [])[0];
      const customerName = contact?.profile?.name || 'WhatsApp Customer';

      for (const message of value.messages || []) {
        const from = message.from; // wa_id, e.g. "9198xxxxxxxx"
        const adRef = message.referral && message.referral.source_type === 'ad' ? message.referral : null;

        if (message.type === 'order') {
          const items = (message.order?.product_items || []).map((pi) => {
            const { productId, variantId } = parseRetailerId(pi.product_retailer_id);
            return { productId, variantId, quantity: pi.quantity || 1 };
          });

          if (adRef) {
            console.log(`Order from ${from} originated from ad ${adRef.source_id}`);
          }

          pendingOrders[from] = { items, customerName, adRef, createdAt: Date.now() };
          await sendWhatsAppText(
            from,
            `Thanks for your order! Please reply with your full delivery address including your 6-digit PIN code so we can ship it.`
          );
          continue;
        }

        if (message.type === 'text' && pendingOrders[from]) {
          const pending = pendingOrders[from];
          const addressText = message.text?.body || '';
          const result = await forwardOrderToShescale({
            customerName: pending.customerName,
            phone: from,
            addressText,
            items: pending.items,
            adRef: pending.adRef,
          });

          if (result.ok) {
            delete pendingOrders[from];
            await sendWhatsAppText(from, `Order confirmed! Your order number is ${result.orderNumber}. We'll notify you once it ships.`);
          } else if (result.error === 'no_pincode_found') {
            await sendWhatsAppText(from, `I couldn't find a 6-digit PIN code in that message — could you resend your address including the PIN code?`);
          } else {
            console.error('Order forwarding failed:', result.error);
            await sendWhatsAppText(from, `Sorry, something went wrong placing your order. Our team will follow up with you shortly.`);
          }
        }
      }
    }
  }
}

module.exports = { verifySignature, handleWebhookEvent, WHATSAPP_VERIFY_TOKEN };
