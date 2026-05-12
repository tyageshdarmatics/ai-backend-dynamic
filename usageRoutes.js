// Admin-only usage analytics endpoints.
// Auth: requires header `x-admin-key` to match env ADMIN_API_KEY.
// Rate limit: simple per-IP sliding window (warm-container scope).
import express from 'express';
import { getCollection } from './db.js';

const router = express.Router();

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const RATE_LIMIT_MAX = parseInt(process.env.ADMIN_RATE_LIMIT_MAX || '60', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.ADMIN_RATE_LIMIT_WINDOW_MS || '60000', 10);
const ipHits = new Map(); // ip -> [timestamps]

function rateLimit(req, res, next) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const arr = (ipHits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (arr.length >= RATE_LIMIT_MAX) {
        return res.status(429).json({ error: 'Too many requests' });
    }
    arr.push(now);
    ipHits.set(ip, arr);
    next();
}

function adminAuth(req, res, next) {
    if (!ADMIN_API_KEY) {
        return res.status(503).json({ error: 'ADMIN_API_KEY not configured on server' });
    }
    const provided = req.headers['x-admin-key'];
    if (!provided || provided !== ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

router.use(rateLimit, adminAuth);

// Per-user usage summary
router.get('/user/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const col = await getCollection('usage_logs');
        const [totals, byEndpoint, recent] = await Promise.all([
            col.aggregate([
                { $match: { userId } },
                {
                    $group: {
                        _id: null,
                        totalCalls: { $sum: 1 },
                        totalTokens: { $sum: '$totalTokens' },
                        totalCostUsd: { $sum: '$totalCostUsd' },
                        successCalls: { $sum: { $cond: ['$success', 1, 0] } },
                    }
                }
            ]).toArray(),
            col.aggregate([
                { $match: { userId } },
                {
                    $group: {
                        _id: '$endpoint',
                        calls: { $sum: 1 },
                        tokens: { $sum: '$totalTokens' },
                        costUsd: { $sum: '$totalCostUsd' },
                    }
                },
                { $sort: { costUsd: -1 } }
            ]).toArray(),
            col.find({ userId }).sort({ createdAt: -1 }).limit(100).toArray(),
        ]);

        res.json({
            userId,
            totals: totals[0] || { totalCalls: 0, totalTokens: 0, totalCostUsd: 0, successCalls: 0 },
            byEndpoint,
            recent,
        });
    } catch (error) {
        console.error('GET /api/usage/user error:', error);
        res.status(500).json({ error: error.message });
    }
});

// System-wide summary
router.get('/summary', async (req, res) => {
    try {
        const col = await getCollection('usage_logs');
        const [totals, byEndpoint, topUsers] = await Promise.all([
            col.aggregate([
                {
                    $group: {
                        _id: null,
                        totalCalls: { $sum: 1 },
                        totalTokens: { $sum: '$totalTokens' },
                        totalCostUsd: { $sum: '$totalCostUsd' },
                        uniqueUsers: { $addToSet: '$userId' },
                    }
                },
                {
                    $project: {
                        _id: 0,
                        totalCalls: 1,
                        totalTokens: 1,
                        totalCostUsd: 1,
                        uniqueUserCount: { $size: '$uniqueUsers' },
                    }
                }
            ]).toArray(),
            col.aggregate([
                {
                    $group: {
                        _id: '$endpoint',
                        calls: { $sum: 1 },
                        tokens: { $sum: '$totalTokens' },
                        costUsd: { $sum: '$totalCostUsd' },
                    }
                },
                { $sort: { costUsd: -1 } }
            ]).toArray(),
            col.aggregate([
                {
                    $group: {
                        _id: '$userId',
                        calls: { $sum: 1 },
                        tokens: { $sum: '$totalTokens' },
                        costUsd: { $sum: '$totalCostUsd' },
                    }
                },
                { $sort: { costUsd: -1 } },
                { $limit: 20 }
            ]).toArray(),
        ]);

        res.json({
            totals: totals[0] || { totalCalls: 0, totalTokens: 0, totalCostUsd: 0, uniqueUserCount: 0 },
            byEndpoint,
            topUsers,
        });
    } catch (error) {
        console.error('GET /api/usage/summary error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Per-shop usage
router.get('/by-shop/:shopDomain', async (req, res) => {
    try {
        const { shopDomain } = req.params;
        const col = await getCollection('usage_logs');
        const [totals, byEndpoint] = await Promise.all([
            col.aggregate([
                { $match: { shopDomain } },
                {
                    $group: {
                        _id: null,
                        totalCalls: { $sum: 1 },
                        totalTokens: { $sum: '$totalTokens' },
                        totalCostUsd: { $sum: '$totalCostUsd' },
                    }
                }
            ]).toArray(),
            col.aggregate([
                { $match: { shopDomain } },
                {
                    $group: {
                        _id: '$endpoint',
                        calls: { $sum: 1 },
                        tokens: { $sum: '$totalTokens' },
                        costUsd: { $sum: '$totalCostUsd' },
                    }
                },
                { $sort: { costUsd: -1 } }
            ]).toArray(),
        ]);

        res.json({
            shopDomain,
            totals: totals[0] || { totalCalls: 0, totalTokens: 0, totalCostUsd: 0 },
            byEndpoint,
        });
    } catch (error) {
        console.error('GET /api/usage/by-shop error:', error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
