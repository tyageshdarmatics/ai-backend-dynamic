// Multi-store Shopify product loader.
//
// Resolution order for credentials:
//   1. If `shop` matches the default `SHOPIFY_DOMAIN` env, use `SHOPIFY_ACCESS_TOKEN`
//      directly (no Mongo lookup). This is the Flutter-app / no-header path.
//   2. Otherwise look up `{ shop, isInstalled: true }` in the `Shop` collection.
//
// Caching:
//   - In-memory cache (per process) with TTL.
//   - Mongo-persisted cache (`product_cache` collection) so Lambda cold starts and
//     fresh Node processes don't re-fetch the entire catalog from Shopify.
//
import { getShopCollection, getCollection } from './db.js';

const ADMIN_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || '2024-01';
const PRODUCT_CACHE_TTL_MS = Number(process.env.SHOPIFY_PRODUCT_CACHE_TTL_MS) || 60 * 60 * 1000; // 1h
const CRED_TTL_MS = 5 * 60 * 1000;
const PRODUCT_CACHE_COLLECTION = 'product_cache';

const shopProductCache = new Map();      // shop -> { products, fetchedAt }
const shopCredCache = new Map();         // shop -> { accessToken, fetchedAt }
const inflightFetches = new Map();       // shop -> Promise (dedupe concurrent fetches)

function defaultShop() {
    return (process.env.SHOPIFY_DOMAIN || '').trim().toLowerCase();
}

function defaultAccessToken() {
    return process.env.SHOPIFY_ACCESS_TOKEN || '';
}

function normalize(shop) {
    return (shop || '').trim().toLowerCase();
}

async function getShopCredentials(shop) {
    const cached = shopCredCache.get(shop);
    if (cached && (Date.now() - cached.fetchedAt) < CRED_TTL_MS) return cached;

    // Default shop → env-token fast path (no Mongo).
    if (shop === defaultShop() && defaultAccessToken()) {
        const cred = { accessToken: defaultAccessToken(), fetchedAt: Date.now(), source: 'env' };
        shopCredCache.set(shop, cred);
        console.log(`[shopify] using env access token for default shop="${shop}"`);
        return cred;
    }

    const col = await getShopCollection();
    console.log(`[shopify] looking up credentials for shop="${shop}" in Mongo db="${col.dbName}", collection="${col.collectionName}"`);
    const doc = await col.findOne({ shop, isInstalled: true });
    if (!doc) {
        const err = new Error(`No installed shop record found for shop="${shop}" in db="${col.dbName}", collection="${col.collectionName}"`);
        console.error(`[shopify] ✗ ${err.message}`);
        throw err;
    }
    if (!doc.accessToken) {
        const err = new Error(`Shop record for "${shop}" has no accessToken`);
        console.error(`[shopify] ✗ ${err.message}`);
        throw err;
    }

    const cred = { accessToken: doc.accessToken, fetchedAt: Date.now(), source: 'mongo' };
    shopCredCache.set(shop, cred);
    console.log(`[shopify] ✓ credentials loaded for shop="${shop}" (token=shpat_***${doc.accessToken.slice(-4)})`);
    return cred;
}

async function readPersistedCache(shop) {
    try {
        const col = await getCollection(PRODUCT_CACHE_COLLECTION);
        const doc = await col.findOne({ shop });
        if (!doc) return null;
        if (!doc.fetchedAt || (Date.now() - new Date(doc.fetchedAt).getTime()) > PRODUCT_CACHE_TTL_MS) return null;
        return Array.isArray(doc.products) ? doc.products : null;
    } catch (e) {
        console.warn(`[shopify] persisted cache read failed for shop="${shop}": ${e.message}`);
        return null;
    }
}

async function writePersistedCache(shop, products) {
    try {
        const col = await getCollection(PRODUCT_CACHE_COLLECTION);
        await col.updateOne(
            { shop },
            { $set: { shop, products, fetchedAt: new Date(), count: products.length } },
            { upsert: true }
        );
    } catch (e) {
        console.warn(`[shopify] persisted cache write failed for shop="${shop}": ${e.message}`);
    }
}

export async function getProductsForShop(shopRaw) {
    const shop = normalize(shopRaw);
    if (!shop) throw new Error('shop (domain) is required');

    const memCached = shopProductCache.get(shop);
    if (memCached && (Date.now() - memCached.fetchedAt) < PRODUCT_CACHE_TTL_MS) {
        console.log(`[shopify] mem cache hit for shop="${shop}" — ${memCached.products.length} products`);
        return memCached.products;
    }

    // Dedupe concurrent fetches for the same shop.
    if (inflightFetches.has(shop)) {
        console.log(`[shopify] joining in-flight fetch for shop="${shop}"`);
        return inflightFetches.get(shop);
    }

    const fetchPromise = (async () => {
        const persisted = await readPersistedCache(shop);
        if (persisted) {
            shopProductCache.set(shop, { products: persisted, fetchedAt: Date.now() });
            console.log(`[shopify] mongo cache hit for shop="${shop}" — ${persisted.length} products`);
            return persisted;
        }

        const startedAt = Date.now();
        console.log(`[shopify] fetching products for shop="${shop}" (Admin API ${ADMIN_API_VERSION})`);
        const { accessToken } = await getShopCredentials(shop);
        // console.log("accessToken:::", accessToken)
        const products = await fetchAllProductsFromShop(shop, accessToken);
        shopProductCache.set(shop, { products, fetchedAt: Date.now() });
        writePersistedCache(shop, products).catch(() => { }); // fire-and-forget
        console.log(`[shopify] ✓ fetched ${products.length} products for shop="${shop}" in ${Date.now() - startedAt}ms`);
        return products;
    })();

    inflightFetches.set(shop, fetchPromise);
    try {
        return await fetchPromise;
    } finally {
        inflightFetches.delete(shop);
    }
}

// Eager pre-warm — call at startup so the first Flutter request doesn't pay the fetch cost.
export async function prewarmShop(shopRaw) {
    const shop = normalize(shopRaw);
    if (!shop) return;
    try {
        const products = await getProductsForShop(shop);
        console.log(`[shopify] ✓ pre-warmed shop="${shop}" — ${products.length} products cached`);
    } catch (e) {
        console.warn(`[shopify] ⚠ pre-warm failed for shop="${shop}": ${e.message}`);
    }
}

async function fetchAllProductsFromShop(shop, accessToken) {
    const allEdges = [];
    let hasNextPage = true;
    let endCursor = null;
    let currencyCode = 'USD';
    let pageCount = 0;

    while (hasNextPage) {
        pageCount += 1;
        const query = `
        {
          ${pageCount === 1 ? 'shop { currencyCode }' : ''}
          products(first: 250${endCursor ? `, after: "${endCursor}"` : ''}) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                title
                description
                productType
                handle
                onlineStoreUrl
                status
                featuredImage { url }
                images(first: 1) { edges { node { url } } }
                variants(first: 1) {
                  edges {
                    node {
                      id
                      price
                      compareAtPrice
                    }
                  }
                }
                tags
              }
            }
          }
        }`;
        const url = `https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': accessToken,
            },
            body: JSON.stringify({ query }),
        });

        // console.log("fetchAllProductsFromShop:::response:::", response);

        if (!response.ok) {
            const text = await response.text();
            const err = new Error(`Shopify Admin API error ${response.status}: ${text.slice(0, 200)}`);
            console.error(`[shopify] ✗ ${err.message}`);
            throw err;
        }

        const json = await response.json();
        if (json.errors?.length) {
            const err = new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
            console.error(`[shopify] ✗ ${err.message}`);
            throw err;
        }

        if (pageCount === 1 && json.data?.shop?.currencyCode) {
            currencyCode = json.data.shop.currencyCode;
            console.log(`[shopify] shop currency for "${shop}" = ${currencyCode}`);
        }

        const pageInfo = json.data?.products?.pageInfo || {};
        const edges = json.data?.products?.edges || [];
        allEdges.push(...edges);
        hasNextPage = pageInfo.hasNextPage || false;
        endCursor = pageInfo.endCursor || null;
        console.log(`[shopify] page ${pageCount} for "${shop}" — ${edges.length} products (hasNextPage=${hasNextPage})`);
    }

    return allEdges
        .map(edge => edge.node)
        .filter(node => node.status !== 'ARCHIVED')
        .map(node => {
            const variant = node.variants?.edges?.[0]?.node;
            const priceStr = formatMoney(variant?.price, currencyCode);
            const compareAtStr = formatMoney(variant?.compareAtPrice, currencyCode);
            const imageUrl =
                node.featuredImage?.url ||
                node.images?.edges?.[0]?.node?.url ||
                'https://placehold.co/200x200?text=No+Image';
            return {
                productId: node.id,
                name: node.title,
                url: node.onlineStoreUrl || `https://${shop}/products/${node.handle}`,
                imageUrl,
                variantId: variant?.id,
                price: priceStr,
                compareAtPrice: compareAtStr,
                tags: node.tags || []
            };
        });
}

function formatMoney(money, currencyCode) {
    if (money == null) return 'N/A';
    if (typeof money === 'string') return `${currencyCode} ${parseFloat(money).toFixed(2)}`;
    if (typeof money === 'object' && money.amount != null) {
        return `${money.currencyCode || currencyCode} ${parseFloat(money.amount).toFixed(2)}`;
    }
    return 'N/A';
}

export function clearShopCache(shopRaw) {
    if (shopRaw) {
        const shop = normalize(shopRaw);
        shopProductCache.delete(shop);
        shopCredCache.delete(shop);
    } else {
        shopProductCache.clear();
        shopCredCache.clear();
    }
}

// ---------- Catalog filtering / prompt-shrinking helpers ----------
//
// The single biggest perf win is shrinking the catalog we hand to Gemini.
// Sending 600+ products as JSON balloons input to ~25k tokens; the model then
// takes 60-70s to think. Capping to ~120 ranked, compact lines cuts the AI
// call to roughly 10-15s.

const HAIR_KEYWORDS = ['hair', 'scalp', 'shampoo', 'conditioner', 'minoxidil', 'follihair', 'mintop', 'anaboom', 'oil', 'serum', 'tablet', 'capsule', 'solution', 'biotin', 'keratin', 'finasteride', 'redensyl', 'trichology'];
const SKIN_NEGATIVE_KEYWORDS = ['shampoo', 'conditioner', 'scalp', 'minoxidil', 'follihair', 'mintop', 'anaboom'];
const SKIN_POSITIVE_KEYWORDS = ['skin', 'face', 'cleanser', 'serum', 'moisturizer', 'sunscreen', 'spf', 'retinol', 'niacinamide', 'vitamin c', 'hyaluronic', 'acne', 'pigmentation', 'glow', 'cream', 'lotion', 'toner', 'exfoliant', 'aha', 'bha'];

const DEFAULT_MAX_CATALOG = Number(process.env.AI_MAX_CATALOG_SIZE) || 120;

function scoreProduct(product, positiveKeywords, analysisString = '') {
    const name = (product.name || '').toLowerCase();
    const tags = (product.tags || []).join(' ').toLowerCase();
    const haystack = `${name} ${tags}`;
    const analysis = (analysisString || '').toLowerCase();
    let score = 0;
    for (const kw of positiveKeywords) {
        if (haystack.includes(kw)) score += 2;
        if (analysis.includes(kw)) score += 1; // analysis-mentioned keywords boost matches
    }
    return score;
}

export function filterHairCatalog(products, { analysisString = '', max = DEFAULT_MAX_CATALOG } = {}) {
    const filtered = (products || []).filter(p => {
        const name = (p.name || '').toLowerCase();
        return HAIR_KEYWORDS.some(term => name.includes(term));
    });
    const ranked = filtered
        .map(p => ({ p, s: scoreProduct(p, HAIR_KEYWORDS, analysisString) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, max)
        .map(x => x.p);
    return ranked;
}

export function filterSkinCatalog(products, { analysisString = '', max = DEFAULT_MAX_CATALOG } = {}) {
    const filtered = (products || []).filter(p => {
        const name = (p.name || '').toLowerCase();
        return !SKIN_NEGATIVE_KEYWORDS.some(term => name.includes(term));
    });
    const ranked = filtered
        .map(p => ({ p, s: scoreProduct(p, SKIN_POSITIVE_KEYWORDS, analysisString) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, max)
        .map(x => x.p);
    return ranked;
}

// Compact `id|name` per line — ~3-4x smaller than JSON for the same data.
export function toPromptCatalog(products) {
    return (products || [])
        .map(p => `${p.variantId}|${p.name}`)
        .join('\n');
}
