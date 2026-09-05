// server.js
//
// Serves /meta-feed.xml for Meta Commerce Manager to fetch on a schedule.
// Regenerates the feed from SheScale in the background on a timer, and
// serves the last-known-good cached copy instantly on each request —
// so a slow/flaky SheScale API never causes a failed fetch to Meta.

const express = require('express');
const { generateFeedXml } = require('./generateFeed');

const PORT = process.env.PORT || 3000;
const CACHE_TTL_MINUTES = Number(process.env.CACHE_TTL_MINUTES || 30);
const REFRESH_SECRET = process.env.REFRESH_SECRET; // optional shared secret to protect manual refresh

let cachedFeed = null;
let lastGeneratedAt = null;
let lastError = null;

async function refreshFeed() {
  try {
    cachedFeed = await generateFeedXml();
    lastGeneratedAt = new Date();
    lastError = null;
    console.log(`[${lastGeneratedAt.toISOString()}] Feed refreshed OK`);
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

app.listen(PORT, async () => {
  console.log(`Meta feed service listening on port ${PORT}`);
  await refreshFeed(); // generate once on boot so /meta-feed.xml isn't empty
  setInterval(refreshFeed, CACHE_TTL_MINUTES * 60 * 1000);
});
