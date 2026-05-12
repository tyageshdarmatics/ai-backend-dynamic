// Local smoke test — exercises every change end-to-end.
// Usage: node smoke-test.mjs [baseUrl]
//   default baseUrl: http://localhost:5000
// Env vars used: ADMIN_API_KEY (must match server), TEST_SHOP_DOMAIN (optional)

import 'dotenv/config';

const BASE = process.argv[2] || 'http://localhost:5000';
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const SHOP = process.env.TEST_SHOP_DOMAIN || null;
const USER_ID = `smoke_${Date.now()}`;

const c = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', dim: '\x1b[2m' };
const ok = m => console.log(`${c.green}PASS${c.reset} ${m}`);
const fail = (m, e) => console.log(`${c.red}FAIL${c.reset} ${m}\n  ${e}`);
const info = m => console.log(`${c.dim}${m}${c.reset}`);

async function call(method, path, { body, headers = {} } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, headers: Object.fromEntries(res.headers), data };
}

console.log(`\n=== Smoke test against ${BASE} ===`);
console.log(`User ID: ${USER_ID}`);
console.log(`Shop:    ${SHOP || '(none — testing default-store fallback)'}\n`);

// 1. Health
{
    const r = await call('GET', '/api/health');
    r.status === 200 && r.data?.status === 'success'
        ? ok('GET /api/health')
        : fail('GET /api/health', JSON.stringify(r));
}

// 2. Chat (cheapest Gemini call) — tests tracking pipeline
let chatOk = false;
{
    const r = await call('POST', '/api/chat', {
        headers: { 'x-user-id': USER_ID },
        body: { query: 'In one short sentence, what is niacinamide?', context: {} },
    });
    if (r.status === 200 && r.data?.response) {
        ok(`POST /api/chat (response: "${r.data.response.slice(0, 60)}...")`);
        chatOk = true;
    } else {
        fail('POST /api/chat', `${r.status} ${JSON.stringify(r.data)}`);
    }
}

// 3. Wait briefly for fire-and-forget usage log to land
if (chatOk) {
    info('Waiting 2s for usage_logs write...');
    await new Promise(r => setTimeout(r, 2000));
}

// 4. Admin: per-user usage (auth required)
if (ADMIN_KEY) {
    const r = await call('GET', `/api/usage/user/${USER_ID}`, {
        headers: { 'x-admin-key': ADMIN_KEY },
    });
    if (r.status === 200 && r.data?.totals?.totalCalls >= 1) {
        ok(`GET /api/usage/user/${USER_ID} — ${r.data.totals.totalCalls} call(s), $${r.data.totals.totalCostUsd?.toFixed(6)}`);
    } else {
        fail(`GET /api/usage/user/${USER_ID}`, `${r.status} ${JSON.stringify(r.data)}`);
    }

    // 5. Admin auth must reject missing key
    const r2 = await call('GET', `/api/usage/user/${USER_ID}`);
    r2.status === 401
        ? ok('Admin endpoint rejects missing x-admin-key (401)')
        : fail('Admin endpoint should 401 without key', `${r2.status} ${JSON.stringify(r2.data)}`);

    // 6. System summary
    const r3 = await call('GET', '/api/usage/summary', {
        headers: { 'x-admin-key': ADMIN_KEY },
    });
    r3.status === 200 && r3.data?.totals
        ? ok(`GET /api/usage/summary — ${r3.data.totals.totalCalls} total calls, $${r3.data.totals.totalCostUsd?.toFixed(6)}`)
        : fail('GET /api/usage/summary', `${r3.status} ${JSON.stringify(r3.data)}`);
} else {
    info('Skipping admin endpoints — set ADMIN_API_KEY in .env to enable');
}

// 7. Recommend-skin with NO shopDomain → should fall back to default Shopify env vars
{
    const r = await call('POST', '/api/recommend-skin', {
        headers: { 'x-user-id': USER_ID },
        body: {
            analysis: [{ category: 'Acne', conditions: [{ name: 'Mild Acne', confidence: 70, location: 'Forehead', description: 'small bumps' }] }],
            goals: ['clear skin'],
        },
    });
    r.status === 200
        ? ok(`POST /api/recommend-skin (no shopDomain — fallback) — ${Array.isArray(r.data) ? r.data.length : 0} routine(s)`)
        : fail('POST /api/recommend-skin (fallback)', `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
}

// 8. Recommend-skin WITH shopDomain → should look up credentials in Mongo
if (SHOP) {
    const r = await call('POST', '/api/recommend-skin', {
        headers: { 'x-user-id': USER_ID },
        body: {
            shopDomain: SHOP,
            analysis: [{ category: 'Acne', conditions: [{ name: 'Mild Acne', confidence: 70, location: 'Forehead', description: 'small bumps' }] }],
            goals: ['clear skin'],
        },
    });
    r.status === 200
        ? ok(`POST /api/recommend-skin (shopDomain=${SHOP}) — ${Array.isArray(r.data) ? r.data.length : 0} routine(s)`)
        : fail('POST /api/recommend-skin (dynamic shop)', `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);

    // 9. By-shop usage report
    if (ADMIN_KEY) {
        await new Promise(r => setTimeout(r, 1500));
        const r2 = await call('GET', `/api/usage/by-shop/${encodeURIComponent(SHOP)}`, {
            headers: { 'x-admin-key': ADMIN_KEY },
        });
        r2.status === 200 && r2.data?.totals
            ? ok(`GET /api/usage/by-shop/${SHOP} — ${r2.data.totals.totalCalls} call(s), $${r2.data.totals.totalCostUsd?.toFixed(6)}`)
            : fail('GET /api/usage/by-shop', `${r2.status} ${JSON.stringify(r2.data)}`);
    }
} else {
    info('Skipping dynamic-shop test — set TEST_SHOP_DOMAIN in .env to enable');
}

console.log(`\n${c.dim}Done. Check MongoDB → dermatics.usage_logs for the records written under userId="${USER_ID}".${c.reset}\n`);
