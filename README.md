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
