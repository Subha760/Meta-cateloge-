// metaConversions.js
//
// Sends server-side "Purchase" events to Meta's Conversions API whenever
// SheScale confirms an order — this is the workaround for not being able
// to install a Meta Pixel directly on the SheScale-hosted storefront.
//
// ASSUMPTION TO VERIFY: SheScale's order.status_changed webhook only
// includes {orderNumber, status} — not the order value or customer phone.
// To get those, this fetches full order details from what I'm assuming
// is `GET /orders/{orderNumber}` on the same partner API. This endpoint
// wasn't directly confirmed in the WooCommerce plugin source (the plugin
// only ever writes orders, never reads them back) — check
// api.shescale.in/api/docs to confirm the real path/response shape, and
// I'll adjust fetchOrderDetails() below if it's different.

const crypto = require('crypto');
const fetch = require('node-fetch');

const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_CAPI_ACCESS_TOKEN = process.env.META_CAPI_ACCESS_TOKEN;
const SHESCALE_API_BASE_URL = process.env.SHESCALE_API_BASE_URL || 'https://api.shescale.in/api/v1/partner/v1';
const SHESCALE_API_KEY = process.env.SHESCALE_API_KEY;
const CURRENCY = process.env.CURRENCY || 'INR';

// Dedupe so we never report the same order twice (in-memory — resets on
// restart, same known limitation as the WhatsApp pending-orders store).
const reportedOrders = new Set();

function sha256(value) {
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

/**
 * ASSUMED endpoint — see note at top of file.
 */
async function fetchOrderDetails(orderNumber) {
  const res = await fetch(`${SHESCALE_API_BASE_URL}/orders/${encodeURIComponent(orderNumber)}`, {
    headers: {
      Authorization: `Bearer ${SHESCALE_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Could not fetch order ${orderNumber}: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  return json && typeof json === 'object' && 'data' in json ? json.data : json;
}

async function sendPurchaseEvent({ orderNumber, value, phone, email }) {
  if (!META_PIXEL_ID || !META_CAPI_ACCESS_TOKEN) {
    console.error('Meta Conversions API skipped — META_PIXEL_ID / META_CAPI_ACCESS_TOKEN not set');
    return;
  }

  const userData = {};
  if (phone) userData.ph = [sha256(phone.replace(/\D/g, ''))];
  if (email) userData.em = [sha256(email)];

  const body = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      event_id: orderNumber, // dedupes correctly even if also fired client-side later
      action_source: 'system_generated',
      user_data: userData,
      custom_data: {
        currency: CURRENCY,
        value: Number(value) || 0,
        order_id: orderNumber,
      },
    }],
    access_token: META_CAPI_ACCESS_TOKEN,
  };

  const res = await fetch(`https://graph.facebook.com/v20.0/${META_PIXEL_ID}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const result = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Meta Conversions API error for order ${orderNumber}:`, JSON.stringify(result));
  } else {
    console.log(`Reported Purchase to Meta for order ${orderNumber}, value ${value} ${CURRENCY}`);
  }
}

/**
 * Call this from the SheScale webhook handler on every order.status_changed event.
 */
async function handleOrderStatusChanged(orderNumber, status) {
  if (!orderNumber) return;
  if (reportedOrders.has(orderNumber)) return; // already reported
  if (['CANCELLED', 'REFUSED'].includes(status)) return; // not a real purchase

  try {
    const order = await fetchOrderDetails(orderNumber);
    const value = order?.totalAmount ?? order?.amount ?? order?.total ?? 0;
    const phone = order?.customerPhone ?? order?.phone;
    const email = order?.customerEmail ?? order?.email;

    await sendPurchaseEvent({ orderNumber, value, phone, email });
    reportedOrders.add(orderNumber);
  } catch (err) {
    console.error(`Failed to report order ${orderNumber} to Meta:`, err.message);
    // Deliberately don't mark as reported — worth retrying on the next
    // status_changed event for the same order (e.g. shipped, delivered)
  }
}

module.exports = { handleOrderStatusChanged };
