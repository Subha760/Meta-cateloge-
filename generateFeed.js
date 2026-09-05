// generateFeed.js
//
// Pulls the product catalog from the SheScale API, converts it into a
// Meta (Facebook/Instagram) Commerce Manager compatible XML feed, and
// pushes the same computed price back to your SheScale shop listing so
// the price shown in the Meta feed always matches what customers are
// actually charged at store.choicematrix.in (single source of truth,
// same approach as the SheScale WooCommerce plugin's price-sync).

const fetch = require('node-fetch');
const { create } = require('xmlbuilder2');

// Confirmed from the SheScale WooCommerce plugin source (class-shescale-api.php
// and class-shescale-importer.php) — this is the real partner API shape.
const SHESCALE_API_BASE_URL = process.env.SHESCALE_API_BASE_URL || 'https://api.shescale.in/api/v1/partner/v1';
const SHESCALE_API_KEY = process.env.SHESCALE_API_KEY;
const SITE_BASE_URL = process.env.SITE_BASE_URL || 'https://store.choicematrix.in';
const DEFAULT_ORIGIN_COUNTRY = process.env.DEFAULT_ORIGIN_COUNTRY || 'IN';
const CURRENCY = process.env.CURRENCY || 'INR';
const MARKUP_TYPE = process.env.MARKUP_TYPE || 'percent'; // 'percent' or 'flat'
const MARKUP_VALUE = Number(process.env.MARKUP_VALUE || 30);
// When true (default), pushes the computed price to your SheScale shop
// listing on every feed refresh — same effect as the WooCommerce plugin's
// push_price_on_save, so Meta's price always matches checkout.
const SYNC_PRICE_TO_SHOP = process.env.SYNC_PRICE_TO_SHOP !== 'false';

function markupPrice(base) {
  const price = MARKUP_TYPE === 'flat' ? base + MARKUP_VALUE : base * (1 + MARKUP_VALUE / 100);
  return Math.round(Math.max(price, base));
}

/**
 * Matches store.choicematrix.in's URL pattern, confirmed from a live
 * product page: https://store.choicematrix.in/product/trendy-womens-...
 * The site slugifies the title — lowercase, non-alphanumeric to hyphens,
 * collapsed/trimmed. If SheScale ever adds numeric suffixes for duplicate
 * titles, this won't catch that — spot-check a few generated links after
 * deploy against the live site.
 */
function slugify(title) {
  return String(title)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Fetches the full product list from SheScale, paging through /products
 * since it's paginated (limit/page), same as the WooCommerce plugin does.
 */
async function fetchShescaleProducts() {
  if (!SHESCALE_API_KEY) {
    throw new Error('SHESCALE_API_KEY must be set as an env var');
  }

  const all = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const res = await fetch(`${SHESCALE_API_BASE_URL}/products?page=${page}&limit=${limit}`, {
      headers: {
        Authorization: `Bearer ${SHESCALE_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`SheScale API error: ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    // Standard envelope: {success, data: {products: [...], total: N}}
    const data = json && typeof json === 'object' && 'data' in json ? json.data : json;
    const items = data?.products || [];
    const total = Number(data?.total || items.length);

    all.push(...items);

    if (all.length >= total || items.length === 0) break;
    page += 1;
  }

  return all;
}

/**
 * Fetches full detail for a single product (needed for variants/stock,
 * which the list endpoint may not fully include).
 */
async function fetchShescaleProductDetail(id) {
  const res = await fetch(`${SHESCALE_API_BASE_URL}/products/${encodeURIComponent(id)}`, {
    headers: {
      Authorization: `Bearer ${SHESCALE_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json && typeof json === 'object' && 'data' in json ? json.data : json;
}

/**
 * Ensures a product is listed on your SheScale shop, then pushes the
 * given selling price. Mirrors what the WooCommerce plugin does on
 * import + on every price edit. Both calls are safe to repeat — listing
 * an already-listed product and re-setting the same price are no-ops.
 */
async function syncPriceToShop(productId, price) {
  const headers = {
    Authorization: `Bearer ${SHESCALE_API_KEY}`,
    'Content-Type': 'application/json',
  };

  // List on shop (ignore errors here — most likely already listed)
  await fetch(`${SHESCALE_API_BASE_URL}/shop/products`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ productId: String(productId) }),
  }).catch(() => {});

  const res = await fetch(`${SHESCALE_API_BASE_URL}/shop/products/${encodeURIComponent(productId)}/price`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ sellingPrice: price }),
  });

  if (!res.ok) {
    console.error(`Price sync failed for product ${productId}: ${res.status} ${res.statusText}`);
  }
}

/**
 * Maps a single SheScale product into one or more Meta catalog items —
 * one item PER VARIANT (size/color), matching how store.choicematrix.in
 * actually sells them (same model as the WooCommerce plugin's variable
 * products). All variants of one product share item_group_id so Meta
 * shows them as one listing with a size/colour picker, not duplicates.
 *
 * Field names confirmed from the SheScale WooCommerce plugin:
 *   id, title, description, basePrice, images[], category.name, variants[]
 *   variant: { id, size, color, stockQuantity, isUnlimited }
 */
function mapProductToMetaItems(product) {
  const productId = String(product.id);
  const title = product.title ?? '';
  const description = product.description ?? title;
  const basePrice = Number(product.basePrice ?? 0);
  const price = markupPrice(basePrice);
  const priceStr = `${price.toFixed(2)} ${CURRENCY}`;

  const link = `${SITE_BASE_URL}/product/${slugify(title)}`;
  const images = Array.isArray(product.images) ? product.images : [];
  const imageUrl = images[0];
  const additionalImages = images.slice(1, 11); // Meta allows up to 10 additional images
  const category = product.category?.name;
  const brand = category ?? 'SheScale';

  const variants = Array.isArray(product.variants) ? product.variants : [];

  const baseFields = {
    title,
    description,
    condition: 'new',
    price: priceStr,
    link,
    image_link: imageUrl,
    additional_image_link: additionalImages,
    brand,
    product_type: category,
    origin_country: DEFAULT_ORIGIN_COUNTRY,
  };

  if (variants.length === 0) {
    // No variants — single item, id = product id
    return [{
      id: productId,
      ...baseFields,
      availability: 'in stock', // no stock data to check against
    }];
  }

  // One feed item per variant, grouped under item_group_id
  return variants.map((v) => {
    const stock = v.isUnlimited ? 1 : Number(v.stockQuantity || 0);
    return {
      id: `${productId}-${v.id}`,
      item_group_id: productId,
      ...baseFields,
      availability: stock > 0 ? 'in stock' : 'out of stock',
      color: v.color || undefined,
      size: v.size || undefined,
    };
  });
}

/**
 * Builds the full Meta-compatible XML feed string.
 */
async function generateFeedXml() {
  const products = await fetchShescaleProducts();

  if (SYNC_PRICE_TO_SHOP) {
    // Push each product's computed price to the SheScale shop listing
    // before building the feed, so the feed and checkout always agree.
    // Runs sequentially with a tiny delay to stay well under any rate limit.
    for (const product of products) {
      const price = markupPrice(Number(product.basePrice ?? 0));
      await syncPriceToShop(product.id, price);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  const items = products
    .flatMap(mapProductToMetaItems)
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
    if (item.item_group_id) entry.ele('g:item_group_id').txt(item.item_group_id).up();
    entry.ele('g:title').txt(item.title).up();
    entry.ele('g:description').txt(item.description).up();
    entry.ele('g:availability').txt(item.availability).up();
    entry.ele('g:condition').txt(item.condition).up();
    entry.ele('g:price').txt(item.price).up();
    entry.ele('g:link').txt(item.link).up();
    entry.ele('g:image_link').txt(item.image_link).up();
    for (const extra of item.additional_image_link || []) {
      entry.ele('g:additional_image_link').txt(extra).up();
    }
    entry.ele('g:brand').txt(item.brand).up();
    if (item.product_type) entry.ele('g:product_type').txt(item.product_type).up();
    if (item.color) entry.ele('g:color').txt(item.color).up();
    if (item.size) entry.ele('g:size').txt(item.size).up();
    entry.ele('g:origin_country').txt(item.origin_country).up();
    entry.up();
  }

  return doc.end({ prettyPrint: true });
}

module.exports = { generateFeedXml };
