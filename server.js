// server.js
//
// Serves /meta-feed.xml for Meta Commerce Manager to fetch on a schedule.
// Regenerates the feed from SheScale in the background on a timer, and
// serves the last-known-good cached copy instantly on each request —
// so a slow/flaky SheScale API never causes a failed fetch to Meta.

const express = require('express');
const crypto = require('crypto');
const { generateFeedXml } = require('./generateFeed');
const { verifySignature, handleWebhookEvent, WHATSAPP_VERIFY_TOKEN } = require('./whatsappOrders');

const SHESCALE_WEBHOOK_SECRET = process.env.SHESCALE_WEBHOOK_SECRET;

const PORT = process.env.PORT || 3000;
const CACHE_TTL_MINUTES = Number(process.env.CACHE_TTL_MINUTES || 30);
const REFRESH_SECRET = process.env.REFRESH_SECRET; // optional shared secret to protect manual refresh

let cachedFeed = null;
let lastGeneratedAt = null;
let lastError = null;
let lastProductCount = null;
let lastItemCount = null;

async function refreshFeed() {
  try {
    const result = await generateFeedXml();
    cachedFeed = result.xml;
    lastProductCount = result.productCount;
    lastItemCount = result.itemCount;
    lastGeneratedAt = new Date();
    lastError = null;
    console.log(`[${lastGeneratedAt.toISOString()}] Feed refreshed OK — ${result.productCount} products, ${result.itemCount} feed items`);
  } catch (err) {
    lastError = err.message;
    console.error(`Feed refresh failed: ${err.message}`);
    // Deliberately keep serving the old cachedFeed if refresh fails
  }
}

const app = express();

app.get('/meta-feed.xml', (req, res) => {
  if (!cachedFeed) {
    return res.status(503).send('Feed not generated yet, try again shortly.');
  }
  res.type('application/xml').send(cachedFeed);
});

// Simple health/status check — useful for confirming the last successful sync
app.get('/status', (req, res) => {
  res.json({
    lastGeneratedAt,
    lastError,
    lastProductCount,
    lastItemCount,
    cacheTtlMinutes: CACHE_TTL_MINUTES,
  });
});

// Optional manual trigger, e.g. to force-refresh right after a price change
app.post('/refresh', async (req, res) => {
  if (REFRESH_SECRET && req.query.secret !== REFRESH_SECRET) {
    return res.status(403).send('Forbidden');
  }
  await refreshFeed();
  res.json({ ok: !lastError, lastGeneratedAt, lastError });
});

// --- WhatsApp order webhook ---
// Meta calls this GET once when you register the webhook URL, to verify you own it.
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Needs the raw body (not pre-parsed JSON) to verify Meta's HMAC signature
app.post('/webhook/whatsapp', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.header('x-hub-signature-256');
  if (!verifySignature(req.body, signature)) {
    return res.sendStatus(403);
  }
  // Acknowledge immediately — Meta expects a fast 200, process after
  res.sendStatus(200);
  try {
    const parsed = JSON.parse(req.body.toString('utf8'));
    await handleWebhookEvent(parsed);
  } catch (err) {
    console.error('WhatsApp webhook processing error:', err.message);
  }
});

// --- SheScale inbound webhook ---
// SheScale pushes order/product events here (paste this URL into
// SheScale → Integrations → API & Webhooks → Webhooks field).
// On product.price_changed / product.stock_changed we refresh the feed
// immediately instead of waiting for the next scheduled cycle.
app.post('/webhook/shescale', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!SHESCALE_WEBHOOK_SECRET) {
    return res.status(503).send('SHESCALE_WEBHOOK_SECRET not configured');
  }
  const signature = req.header('x-shescale-signature');
  const expected = 'sha256=' + crypto.createHmac('sha256', SHESCALE_WEBHOOK_SECRET).update(req.body).digest('hex');
  const valid = signature && (() => {
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  })();

  if (!valid) {
    return res.sendStatus(401);
  }

  res.sendStatus(200); // acknowledge immediately

  try {
    const payload = JSON.parse(req.body.toString('utf8'));
    const event = payload.event || '';
    console.log(`SheScale webhook received: ${event}`);

    if (event === 'product.price_changed' || event === 'product.stock_changed') {
      await refreshFeed(); // pulls fresh data, re-syncs prices, rebuilds the feed
    }
    // order.status_changed / order.tracking_updated: logged for now.
    // Could be wired to message the customer on WhatsApp with their
    // order status if you want that later.
  } catch (err) {
    console.error('SheScale webhook processing error:', err.message);
  }
});

app.listen(PORT, async () => {
  console.log(`Meta feed service listening on port ${PORT}`);
  await refreshFeed(); // generate once on boot so /meta-feed.xml isn't empty
  setInterval(refreshFeed, CACHE_TTL_MINUTES * 60 * 1000);
});
