// MongoDB connection helper — Lambda-safe with cached client across warm invocations.
// Supports multiple databases on the same cluster:
//   MONGODB_DB       → primary db for writes (usage_logs)
//   MONGODB_SHOP_DB  → db where the Shop credentials collection lives (read-only)
import { MongoClient } from 'mongodb';

const PRIMARY_DB_NAME = () => process.env.MONGODB_DB || 'dermatics_app_remix';
const SHOP_DB_NAME = () => process.env.MONGODB_SHOP_DB || process.env.MONGODB_DB_NAME_FOR_ACCESSTOKEN_FETCH || PRIMARY_DB_NAME();

let cachedClient = null;
let cachedDbs = new Map();   // dbName -> Db instance
let connectPromise = null;
let indexesEnsured = false;

function maskUri(uri) {
    try {
        const u = new URL(uri);
        return `${u.protocol}//${u.username ? u.username + ':***@' : ''}${u.host}${u.pathname}`;
    } catch {
        return '<unparseable uri>';
    }
}

async function ensureClient() {
    if (cachedClient) return cachedClient;

    const MONGODB_URI = process.env.MONGODB_URI;
    if (!MONGODB_URI) {
        const err = new Error('MONGODB_URI is not set in environment variables.');
        console.error('[mongo] ✗ connection failed:', err.message);
        throw err;
    }

    if (!connectPromise) {
        connectPromise = (async () => {
            const startedAt = Date.now();
            console.log(`[mongo] connecting → ${maskUri(MONGODB_URI)} (primary db="${PRIMARY_DB_NAME()}", shop db="${SHOP_DB_NAME()}")`);
            const client = new MongoClient(MONGODB_URI, {
                maxPoolSize: 5,
                serverSelectionTimeoutMS: 5000,
            });
            await client.connect();
            cachedClient = client;

            const host = client.options?.hosts?.[0]?.host || client.options?.srvHost || 'unknown';
            console.log(`[mongo] ✓ connected in ${Date.now() - startedAt}ms — cluster="${host}"`);
            return client;
        })().catch(err => {
            connectPromise = null;
            console.error('[mongo] ✗ connection failed:', err.message);
            throw err;
        });
    }

    return connectPromise;
}

export async function getDb(dbName) {
    const name = dbName || PRIMARY_DB_NAME();
    if (cachedDbs.has(name)) return cachedDbs.get(name);
    const client = await ensureClient();
    const db = client.db(name);
    cachedDbs.set(name, db);
    console.log(`[mongo] ✓ db handle ready: "${name}"`);

    // Ensure indexes only on primary (usage_logs lives there).
    if (name === PRIMARY_DB_NAME() && !indexesEnsured) {
        indexesEnsured = true;
        ensureIndexes(db)
            .then(() => console.log(`[mongo] ✓ indexes ensured on usage_logs (db="${name}")`))
            .catch(err => {
                console.error('[mongo] ✗ failed to ensure indexes:', err.message);
                indexesEnsured = false;
            });
    }
    return db;
}

async function ensureIndexes(db) {
    await Promise.all([
        db.collection('usage_logs').createIndex({ userId: 1, createdAt: -1 }),
        db.collection('usage_logs').createIndex({ endpoint: 1, createdAt: -1 }),
        db.collection('usage_logs').createIndex({ requestId: 1 }),
        db.collection('usage_logs').createIndex({ shopDomain: 1, createdAt: -1 }),
    ]);
}

export async function getCollection(name, dbName) {
    const db = await getDb(dbName);
    return db.collection(name);
}

export async function getShopCollection() {
    const collName = process.env.MONGODB_SHOP_COLLECTION
        || process.env.MONGODB_DB_CONNECTION_FOR_ACCESSTOKEN_FETCH
        || 'Shop';
    return getCollection(collName, SHOP_DB_NAME());
}

// Eager-connect helper (for startup logging). Safe to ignore failures here —
// requests will retry the connection on demand.
export async function tryEagerConnect() {
    try {
        await getDb();
        return true;
    } catch {
        return false;
    }
}
