# Meta Feed Service — store.choicematrix.in

Generates a Meta (Facebook/Instagram) Commerce Manager compatible XML feed
live from the SheScale API, and serves it at a stable URL that Meta can
poll on a schedule.

## Before deploying: adjust the field mapping

Open `generateFeed.js` and search for `ADJUST ME`. Every one of those spots
assumes a *typical* SheScale API shape (field names like `product.name`,
`product.price`, `product.stock`, etc.) — these are placeholders. Send me
(or check the SheScale API docs for) a real sample product response and
I'll wire up the exact field names so nothing gets silently dropped.

Also confirm:
- The real SheScale API base URL and product-list endpoint
- The auth method (Bearer token? `x-api-key` header? something else?)
- Whether product URLs on your site follow `/product/<slug>` or a
  different pattern — this becomes the required `link` field

## Local test

```bash
npm install
cp .env.example .env   # fill in real values
npm start
# then visit http://localhost:3000/meta-feed.xml
```

## Deploy to Render

1. Push this folder to a GitHub repo (Render deploys from a repo, private
   is fine).
2. In Render: **New → Web Service** → connect the repo.
3. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free is fine to start
4. Add the environment variables from `.env.example` under
   **Environment** (use real SheScale credentials, not the placeholders).
5. Deploy. Render gives you a URL like
   `https://meta-feed-service.onrender.com`.
6. Test it: visit `https://meta-feed-service.onrender.com/meta-feed.xml`
   and confirm it returns your product XML.

Note: on Render's free tier, a web service spins down after inactivity
and takes a few seconds to wake on the next request — fine for Meta's
hourly fetch, but if you want zero delay, a paid instance keeps it warm.

## Connect it to Meta Commerce Manager

1. Go to Commerce Manager → your catalog → **Data Sources**.
2. Add a **Data Feed** → **Set a schedule**.
3. Paste your feed URL: `https://<your-render-url>/meta-feed.xml`
4. Set fetch frequency to **Hourly**.
5. Meta will do a first fetch and flag any rejected items — check the
   **Items → Diagnostics** tab in Commerce Manager 24–48h after first
   connecting.

## Keeping the feed fresh

The server regenerates the feed from SheScale every `CACHE_TTL_MINUTES`
(default 30) in the background and always serves the last successful
copy instantly — so if SheScale's API is briefly down, Meta still gets a
valid (slightly stale) feed instead of an error.

Check `/status` any time to see when the feed last refreshed successfully.

## Price sync to your SheScale shop

On every refresh, before building the feed, the service also pushes the
computed price (`basePrice` + your markup) to your SheScale shop listing
via `POST /shop/products` + `PATCH /shop/products/{id}/price` — the same
calls the WooCommerce plugin makes on import and on price edits. This
keeps the Meta catalog price and the actual checkout price identical,
which matters: Meta flags/reject items where the feed price doesn't
match the landing page price.

Set `SYNC_PRICE_TO_SHOP=false` if you'd rather set prices manually on
SheScale and just use this service as a read-only feed.

## WhatsApp orders (catalog chats + click-to-WhatsApp ads)

When a customer orders through your WhatsApp catalog (including via a
"Click to WhatsApp" ad), WhatsApp sends a webhook — but notably, **it
does not include a delivery address**. This service handles that by:

1. Receiving the order webhook, noting which products/quantities were ordered
2. Replying on WhatsApp asking for the customer's address + PIN code
3. Treating their next message as the address, extracting the PIN code
4. Forwarding the completed order to SheScale (`POST /orders`, same call
   your WooCommerce plugin makes), as Cash on Delivery

### Setup

1. In Meta for Developers, open your WhatsApp Business app → **API Setup**
2. Note your **Phone number ID**, generate a permanent **access token**
   (System User token, not the 24h test token), and find your **App
   Secret** under App Settings → Basic
3. Add all four `WHATSAPP_*` env vars from `.env.example` to Render
4. Under **WhatsApp → Configuration → Webhook**, set:
   - Callback URL: `https://<your-render-url>/webhook/whatsapp`
   - Verify token: same value as `WHATSAPP_VERIFY_TOKEN`
5. Subscribe to the **messages** webhook field
6. Send a test order from WhatsApp to confirm it flows through — check
   Render logs for `Order from ... originated from ad ...` if it came
   through an ad click, or just the order processing if from the catalog directly

### Known limitation

Pending orders (waiting on the customer's address) are held in memory,
not a database. On the free Render tier this is fine for normal use, but
a mid-conversation restart would lose that pending order. If this
becomes an issue, ask me to move it to Render's Key Value store instead.

## SheScale → this service (instant price/stock updates)

Separate from the WhatsApp webhook above, SheScale itself can notify
this service the moment a price or stock level changes on their end —
so your Meta feed updates within seconds instead of waiting up to
`CACHE_TTL_MINUTES`.

1. On the SheScale seller dashboard: **Integrations → SheScale API &
   Webhooks → Webhooks**
2. Paste this URL: `https://<your-render-url>/webhook/shescale`
3. SheScale will show you a signing secret once — copy it into
   `SHESCALE_WEBHOOK_SECRET` on Render
4. On `product.price_changed` / `product.stock_changed`, this service
   immediately re-fetches and rebuilds the feed. `order.status_changed`
   and `order.tracking_updated` events are logged for now — worth wiring
   those to a WhatsApp status message to the customer later if you want it.
