// generateFeed.js
//
// Pulls the product catalog from the SheScale API and converts it into a
// Meta (Facebook/Instagram) Commerce Manager compatible XML feed.
//
// !! IMPORTANT !!
// The field names below (name, price, imageUrl, etc.) are PLACEHOLDERS.
// Replace them with the real field names from your SheScale API response
// once you share a sample product object — right now this assumes a
// reasonably typical shape. Search for "ADJUST ME" to find every spot
// that depends on the real SheScale response shape.

const fetch = require('node-fetch');
const { create } = require('xmlbuilder2');

const SHESCALE_API_BASE_URL = process.env.SHESCALE_API_BASE_URL; // e.g. https://api.shescale.in/v1
const SHESCALE_API_KEY = process.env.SHESCALE_API_KEY;
const SITE_BASE_URL = process.env.SITE_BASE_URL || 'https://store.choicematrix.in';
const DEFAULT_ORIGIN_COUNTRY = process.env.DEFAULT_ORIGIN_COUNTRY || 'IN';
const CURRENCY = process.env.CURRENCY || 'INR';

/**
 * Fetches the raw product list from SheScale.
 * ADJUST ME: confirm the endpoint path and auth header format.
 */
async function fetchShescaleProducts() {
  if (!SHESCALE_API_BASE_URL || !SHESCALE_API_KEY) {
    throw new Error('SHESCALE_API_BASE_URL and SHESCALE_API_KEY must be set as env vars');
  }

  const res = await fetch(`${SHESCALE_API_BASE_URL}/products`, {
    headers: {
      // ADJUST ME: SheScale may use a different auth scheme
      // (Bearer token, x-api-key header, query param, etc.)
      Authorization: `Bearer ${SHESCALE_API_KEY}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`SheScale API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  // ADJUST ME: unwrap whatever envelope SheScale wraps the array in,
  // e.g. data.products, data.data, data.items, or just data itself.
  return Array.isArray(data) ? data : data.products || data.items || data.data || [];
}

/**
 * Maps a single SheScale product object to Meta catalog fields.
 * ADJUST ME: match these to the real SheScale field names.
 */
function mapProductToMetaItem(product) {
  const id = String(product.id ?? product.sku ?? product.productId);
  const title = product.name ?? product.title ?? '';
  const description = product.description ?? product.shortDescription ?? title;
  const price = Number(product.price ?? product.sellingPrice ?? 0);
  const stock = Number(product.stock ?? product.quantity ?? product.inventory ?? 0);
  const imageUrl = product.imageUrl ?? product.image ?? (Array.isArray(product.images) ? product.images[0] : undefined);
  const brand = product.brand ?? 'SheScale';
  const slug = product.slug ?? id;

  return {
    id,
    title,
    description,
    availability: stock > 0 ? 'in stock' : 'out of stock',
    condition: 'new',
    price: `${price.toFixed(2)} ${CURRENCY}`,
    link: `${SITE_BASE_URL}/product/${slug}`,
    image_link: imageUrl,
    brand,
    origin_country: product.originCountry ?? DEFAULT_ORIGIN_COUNTRY,
  };
}

/**
 * Builds the full Meta-compatible XML feed string.
 */
async function generateFeedXml() {
  const products = await fetchShescaleProducts();
  const items = products
    .map(mapProductToMetaItem)
    // Drop anything missing a required field rather than let Meta reject the whole feed
    .filter((item) => item.id && item.title && item.link && item.image_link && item.price);

  const doc = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('rss', { version: '2.0', 'xmlns:g': 'http://base.google.com/ns/1.0' })
    .ele('channel')
    .ele('title').txt('store.choicematrix.in product feed').up()
    .ele('link').txt(SITE_BASE_URL).up()
    .ele('description').txt('Meta Commerce Manager feed for store.choicematrix.in').up();

  for (const item of items) {
    const entry = doc.ele('item');
    entry.ele('g:id').txt(item.id).up();
    entry.ele('g:title').txt(item.title).up();
    entry.ele('g:description').txt(item.description).up();
    entry.ele('g:availability').txt(item.availability).up();
    entry.ele('g:condition').txt(item.condition).up();
    entry.ele('g:price').txt(item.price).up();
    entry.ele('g:link').txt(item.link).up();
    entry.ele('g:image_link').txt(item.image_link).up();
    entry.ele('g:brand').txt(item.brand).up();
    entry.ele('g:origin_country').txt(item.origin_country).up();
    entry.up();
  }

  return doc.end({ prettyPrint: true });
}

module.exports = { generateFeedXml };
