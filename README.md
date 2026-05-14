# AI Skin & Hair Care Backend

Node.js + Express API that powers AI-driven skin and hair analysis, personalized
product recommendations, and clinical-style reports. Recommendations are sourced
from **Shopify stores** — the API switches between stores dynamically based on a
request header, with a default store fallback for clients that don't supply one
(e.g. the Flutter mobile app).

---

## Architecture overview

```
                ┌─────────────────────────────┐
                │   Flutter app   /   Shopify │
                │   (no header)       app     │
                └────────┬─────────────┬──────┘
                         │             │ x-shop-domain: <shop>
                         ▼             ▼
                ┌──────────────────────────────┐
                │       Express server         │
                │   resolveShop(req)           │
                │   ─ header → body → default  │
                └──────────────┬───────────────┘
                               │
              ┌────────────────┴─────────────────┐
              ▼                                  ▼
   ┌─────────────────────┐            ┌─────────────────────┐
   │   Shopify Admin API │            │      Gemini AI      │
   │   (per-shop token   │            │   (analysis +       │
   │    from Mongo)      │            │    recommendations) │
   └──────────┬──────────┘            └─────────────────────┘
              │
              ▼
   ┌─────────────────────┐
   │  Two-tier cache     │
   │  ─ in-memory (1h)   │
   │  ─ Mongo (1h TTL)   │
   └─────────────────────┘
```

### Shop resolution priority

Every endpoint resolves the target Shopify store through `resolveShop(req)`:

1. **`x-shop-domain` header** — used by the embedded Shopify app.
2. **`shopDomain` in the JSON body** — back-compat with older clients.
3. **Default `SHOPIFY_DOMAIN` env var** — the Flutter app / no-header path.

### Credential resolution

- If the resolved shop equals the **default** `SHOPIFY_DOMAIN` *and*
  `SHOPIFY_ACCESS_TOKEN` is set → uses the env token directly (no Mongo lookup).
- Otherwise → looks up `{ shop, isInstalled: true }` in the **`Shop`** collection
  of the `MONGODB_SHOP_DB` database and uses that record's `accessToken`.

### Caching

| Layer | Where | TTL | Purpose |
|---|---|---|---|
| Credentials | in-memory `Map` | 5 min | Avoid repeated Mongo lookups |
| Products | in-memory `Map` | 1 hour | Avoid repeated Shopify fetches in a hot process |
| Products | Mongo `product_cache` | 1 hour | Survives process restarts & Lambda cold starts |
| In-flight fetch | `Map` of `Promise` | per-call | Dedupes concurrent fetches for the same shop |

A startup pre-warm fetches the default shop's catalog so the first request from
the Flutter app doesn't pay the Shopify fetch cost.

### Performance optimization for recommend endpoints

The slowest path used to be the Gemini call (≈70s for a 600-product catalog).
Two changes brought it under 30s:

1. **Aggressive catalog pre-filter + ranking** — `filterHairCatalog` and
   `filterSkinCatalog` reduce the catalog to ≤120 keyword-scored products before
   sending to Gemini, cutting input from ~25k tokens to ~3-4k tokens.
2. **Mongo-persisted product cache** — eliminates the ~5-10s Shopify fetch on
   warm processes and Lambda cold starts.

Configurable via env: `AI_MAX_CATALOG_SIZE` (default `120`),
`SHOPIFY_PRODUCT_CACHE_TTL_MS` (default `3600000`).

---

## Environment variables

Create a `.env` at the project root:

```env
# --- Gemini API (comma-separated for fail-over) ---
GEMINI_API_KEY=AIzaSy...

# --- Default Shopify store (used when no x-shop-domain header is sent) ---
SHOPIFY_DOMAIN=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_ADMIN_API_VERSION=2024-10        # optional, defaults to 2024-01

# --- MongoDB Atlas ---
MONGODB_URI=mongodb+srv://USER:PASS@cluster.mongodb.net/
MONGODB_DB=collection_name         # primary db (usage_logs, product_cache)
MONGODB_SHOP_DB=database_name      # where the Shop credential collection lives

# --- Admin usage analytics endpoints ---
ADMIN_API_KEY=replace_with_a_strong_secret
ADMIN_RATE_LIMIT_MAX=60
ADMIN_RATE_LIMIT_WINDOW_MS=60000

# --- Optional perf knobs ---
# AI_MAX_CATALOG_SIZE=120
# SHOPIFY_PRODUCT_CACHE_TTL_MS=3600000
```

### Where to get the Admin API token

Shopify admin → **Apps** → **Develop apps** → your app → **API credentials** →
"Admin API access token". Required scopes: `read_products` at minimum.

---

## Getting started

```bash
npm install
npm start             # node server.js → http://localhost:5000
```

Healthcheck:

```bash
curl http://localhost:5000/api/health
```

You should see startup logs along these lines:

```
[startup] ✓ Server running on http://localhost:5000
[startup] Gemini API keys loaded: 1
[startup] Default Shopify domain: your-store.myshopify.com
[mongo] ✓ connected
[shopify] ✓ pre-warmed shop="your-store.myshopify.com" — N products cached
```

---

## API reference

All endpoints accept JSON. Recommend endpoints respect the
`x-shop-domain` header for multi-shop routing.

### Public endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness check |
| `POST` | `/api/analyze-skin` | Detects skin conditions from base64 images |
| `POST` | `/api/analyze-hair` | Detects hair/scalp conditions from base64 images |
| `POST` | `/api/recommend-skin` | Returns AM/PM skincare routine for the resolved shop |
| `POST` | `/api/recommend-hair` | Returns AM/PM haircare routine for the resolved shop |
| `POST` | `/api/doctor-report` | Generates an HTML clinical report |
| `POST` | `/api/chat` | General skin/hair AI assistant |
| `POST` | `/api/skinchat` | Skin-only chat (strict topic) |
| `POST` | `/api/hairchat` | Hair-only chat (strict topic) |

### Admin endpoints (`x-admin-key: $ADMIN_API_KEY`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/usage/user/:userId` | Per-user usage & spend |
| `GET` | `/api/usage/summary` | Aggregate usage rollup |
| `GET` | `/api/usage/by-shop/:shop` | Per-shop usage |

### Example — multi-shop recommendation

```bash
curl -X POST http://localhost:5000/api/recommend-skin \
  -H "Content-Type: application/json" \
  -H "x-shop-domain: someclient.myshopify.com" \
  -d '{
    "analysis": [
      {
        "category": "Acne & Blemishes",
        "conditions": [
          { "name": "Acne Pustules", "confidence": 78, "location": "Left Cheek",
            "description": "Inflamed papules on the left cheek." }
        ]
      }
    ],
    "goals": ["Clear acne", "Even skin tone"]
  }'
```

Without the header, the request routes to `SHOPIFY_DOMAIN`.

`recommend-skin` and `recommend-hair` return `400` when `analysis` is missing
or empty — they will not waste a Gemini call.

---

## Using the admin usage endpoints

These three admin endpoints all share the same auth and rate limit. Here's the
full picture.

### Auth

Every request needs the header:

```
x-admin-key: your_random_long_string
```

That value comes from `ADMIN_API_KEY` in your `.env`. Wrong/missing key →
`401 Unauthorized`. More than 60 requests from the same IP per minute →
`429 Too many requests`.

### Where does the data come from?

The `usage_logs` Mongo collection is populated automatically every time any
endpoint calls Gemini (via the `generateContentTracked` wrapper in
`tracking.js`). Each record stores:

```
userId, endpoint, model, inputTokens, outputTokens, totalTokens,
inputCostUsd, outputCostUsd, totalCostUsd,
shopDomain, requestId, durationMs, success, createdAt
```

`userId` comes from the `x-user-id` request header (or `userId` in the JSON
body); defaults to `"anonymous"`.
`shopDomain` is the resolved shop for the call.

So if you want to test the admin endpoints with realistic data, first hit a few
recommend/analyze endpoints with various `x-user-id` and `x-shop-domain`
headers, then query the admin endpoints.

### Endpoint 1: `GET /api/usage/user/:userId`

Per-user spend and call history (last 100 calls).

**Postman**

| Field | Value |
|---|---|
| Method | `GET` |
| URL | `http://localhost:5000/api/usage/user/anonymous` |
| Headers | `x-admin-key: your_random_long_string` |

Replace `anonymous` with whatever `userId` you've used (e.g. `user_123`).

**PowerShell**

```powershell
$admin = "your_random_long_string"
$userId = "anonymous"
Invoke-RestMethod -Method Get -Uri "http://localhost:5000/api/usage/user/$userId" `
  -Headers @{ "x-admin-key" = $admin } | ConvertTo-Json -Depth 6
```

**curl**

```bash
curl -H "x-admin-key: your_random_long_string" \
     http://localhost:5000/api/usage/user/anonymous
```

**Response shape**

```json
{
  "userId": "anonymous",
  "totals": {
    "totalCalls": 12,
    "totalTokens": 45382,
    "totalCostUsd": 0.018472,
    "successCalls": 11
  },
  "byEndpoint": [
    { "_id": "/api/recommend-hair", "calls": 5, "tokens": 30100, "costUsd": 0.012 },
    { "_id": "/api/analyze-skin",   "calls": 4, "tokens": 12200, "costUsd": 0.005 }
  ],
  "recent": [ /* last 100 raw usage_logs entries, newest first */ ]
}
```

### Endpoint 2: `GET /api/usage/summary`

System-wide rollup + top 20 users by spend.

**Postman**

| Field | Value |
|---|---|
| Method | `GET` |
| URL | `http://localhost:5000/api/usage/summary` |
| Headers | `x-admin-key: your_random_long_string` |

**PowerShell**

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:5000/api/usage/summary" `
  -Headers @{ "x-admin-key" = "your_random_long_string" } | ConvertTo-Json -Depth 6
```

**curl**

```bash
curl -H "x-admin-key: your_random_long_string" \
     http://localhost:5000/api/usage/summary
```

**Response shape**

```json
{
  "totals": {
    "totalCalls": 248,
    "totalTokens": 932410,
    "totalCostUsd": 0.382,
    "uniqueUserCount": 17
  },
  "byEndpoint": [
    { "_id": "/api/recommend-hair", "calls": 80, "tokens": 480000, "costUsd": 0.19 },
    { "_id": "/api/recommend-skin", "calls": 65, "tokens": 280000, "costUsd": 0.11 }
  ],
  "topUsers": [
    { "_id": "user_42", "calls": 30, "tokens": 110000, "costUsd": 0.045 }
  ]
}
```

### Endpoint 3: `GET /api/usage/by-shop/:shopDomain`

Per-shop spend and endpoint breakdown.

**Postman**

| Field | Value |
|---|---|
| Method | `GET` |
| URL | `http://localhost:5000/api/usage/by-shop/dermatics-in.myshopify.com` |
| Headers | `x-admin-key: your_random_long_string` |

**PowerShell**

```powershell
$shop = "your-store.myshopify.com"
Invoke-RestMethod -Method Get -Uri "http://localhost:5000/api/usage/by-shop/$shop" `
  -Headers @{ "x-admin-key" = "your_random_long_string" } | ConvertTo-Json -Depth 6
```

**curl**

```bash
curl -H "x-admin-key: your_random_long_string" \
     http://localhost:5000/api/usage/by-shop/your-store.myshopify.com
```

**Response shape**

```json
{
  "shopDomain": "your-store.myshopify.com",
  "totals": { "totalCalls": 134, "totalTokens": 502000, "totalCostUsd": 0.21 },
  "byEndpoint": [
    { "_id": "/api/recommend-hair", "calls": 60, "tokens": 350000, "costUsd": 0.14 },
    { "_id": "/api/recommend-skin", "calls": 45, "tokens": 120000, "costUsd": 0.05 }
  ]
}
```

### Common error responses

| Status | Body | Meaning |
|---|---|---|
| `401` | `{"error":"Unauthorized"}` | Missing or wrong `x-admin-key` |
| `429` | `{"error":"Too many requests"}` | More than 60 req/min from your IP |
| `503` | `{"error":"ADMIN_API_KEY not configured on server"}` | Server's `.env` is missing the key |
| `500` | `{"error":"..."}` | Mongo issue — check server logs |

### Quick end-to-end test in PowerShell

This makes a recommend call, then immediately queries usage for that user and
shop:

```powershell
$admin = "your_random_long_string"

# 1. Generate one usage record
Invoke-RestMethod -Method Post -Uri "http://localhost:5000/api/recommend-skin" `
  -Headers @{
    "Content-Type"   = "application/json";
    "x-shop-domain"  = "dermatics-in.myshopify.com";
    "x-user-id"      = "smoketest_user";
  } `
  -Body '{"analysis":[{"category":"Acne","conditions":[{"name":"Pustules","confidence":80,"location":"Cheek","description":"x"}]}],"goals":["Clear acne"]}' | Out-Null

# 2. Query usage
Invoke-RestMethod -Uri "http://localhost:5000/api/usage/user/smoketest_user" -Headers @{ "x-admin-key" = $admin }
Invoke-RestMethod -Uri "http://localhost:5000/api/usage/by-shop/your-store.myshopify.com" -Headers @{ "x-admin-key" = $admin }
Invoke-RestMethod -Uri "http://localhost:5000/api/usage/summary" -Headers @{ "x-admin-key" = $admin }
```

You should see `totalCalls: 1` and one entry under `byEndpoint` for
`/api/recommend-skin`.

---

## Data model

### `Shop` collection (read-only, in `MONGODB_SHOP_DB`)

Created by the Remix/embedded Shopify app on install.

```js
{
  shop: "someclient.myshopify.com",
  accessToken: "shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  isInstalled: true,
  // ... other fields written by the install flow
}
```

### `product_cache` collection (in `MONGODB_DB`)

Managed by this server.

```js
{
  shop: "someclient.myshopify.com",
  products: [ { productId, name, url, imageUrl, variantId, price, compareAtPrice, tags } ],
  fetchedAt: ISODate(...),
  count: 56
}
```

### `usage_logs` collection (in `MONGODB_DB`)

```js
{
  userId, endpoint, model,
  inputTokens, outputTokens, totalTokens,
  inputCostUsd, outputCostUsd, totalCostUsd,
  shopDomain, requestId, durationMs,
  success, errorMessage, createdAt
}
```

Indexed on `userId+createdAt`, `endpoint+createdAt`, `requestId`, `shopDomain+createdAt`.

---

## Deployment

The same `server.js` runs as either a long-lived Node process or an AWS Lambda
function (via `serverless-http`). Lambda is auto-detected via
`AWS_LAMBDA_FUNCTION_NAME`; in that mode, the file system is read-only except
`/tmp`, so generated HTML reports are written there.

Lambda handler: `server.handler`.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Startup log: `[shopify] ⚠ pre-warm failed ... 401` | `SHOPIFY_ACCESS_TOKEN` in `.env` is wrong, expired, or not an Admin token (must start with `shpat_`). |
| `[shopify] ✗ Shopify Admin API error 401` for a specific shop | That shop's stored `accessToken` in the `Shop` collection is stale — re-install the Shopify app on that store. |
| `/api/recommend-*` returns `[]` with very low Gemini output tokens (~7t) | The request body is missing `analysis`. The endpoint now returns `400` in that case. |
| Slow first request to a shop | First fetch (no cache) is ~5-10s. Subsequent requests within 1h hit the cache and are <1s. |
| `getAllProducts` / `getAllProductsforshopify` referenced but unused | Legacy default-shop Storefront-API helpers — safe to delete in a follow-up; kept to avoid surprises during the migration. |

---

## Project layout

```
server.js          Express app + endpoint handlers
shopify.js         Multi-store product loader, catalog filter helpers, cache
db.js              Mongo client + db handle cache + index ensure
tracking.js        Wraps Gemini calls, logs token usage + cost
pricing.js         Gemini per-model pricing table
usageRoutes.js     Admin analytics endpoints
.env               Local secrets (not committed)
```
