// Usage tracking — wraps Gemini calls and persists token/cost data to MongoDB.
import { getCollection } from './db.js';
import { calculateCost } from './pricing.js';

/**
 * Wrap any "generateContent"-style function so each call is logged with
 * token counts + cost. The original function is invoked unchanged; logging
 * is fire-and-forget so failures here never block API responses.
 *
 * @param {Function} generateFn  async function that calls Gemini and returns its response
 * @param {Object}   params      params object passed to generateFn (must include `model`)
 * @param {Object}   ctx         { userId, endpoint, requestId, shopDomain }
 */
export async function generateContentTracked(generateFn, params, ctx) {
    const start = Date.now();
    const tag = `[gemini] ${ctx?.endpoint || '?'} req=${ctx?.requestId || '?'} user=${ctx?.userId || 'anonymous'}`;
    console.log(`${tag} → calling model="${params.model}"`);
    let response = null;
    let error = null;
    try {
        response = await generateFn(params);
        return response;
    } catch (e) {
        error = e;
        console.error(`${tag} ✗ Gemini call failed: ${e.message}`);
        throw e;
    } finally {
        const durationMs = Date.now() - start;
        const cost = calculateCost(params.model, response?.usageMetadata);
        const record = {
            userId: ctx?.userId || 'anonymous',
            endpoint: ctx?.endpoint || 'unknown',
            model: params.model,
            inputTokens: cost.inputTokens,
            outputTokens: cost.outputTokens,
            totalTokens: cost.totalTokens,
            inputCostUsd: cost.inputCostUsd,
            outputCostUsd: cost.outputCostUsd,
            totalCostUsd: cost.totalCostUsd,
            shopDomain: ctx?.shopDomain || null,
            requestId: ctx?.requestId || null,
            durationMs,
            success: !error,
            errorMessage: error ? String(error.message || error) : null,
            createdAt: new Date(),
        };
        if (!error) {
            console.log(
                `${tag} ✓ ${durationMs}ms — input=${cost.inputTokens}t output=${cost.outputTokens}t cost=$${cost.totalCostUsd.toFixed(6)}`
            );
        }
        // Fire-and-forget — never block the response on log writes.
        logUsage(record).catch(err => console.error(`${tag} ✗ usage_logs write failed: ${err.message}`));
    }
}

export async function logUsage(record) {
    const col = await getCollection('usage_logs');
    await col.insertOne(record);
    console.log(
        `[usage] ✓ logged → user="${record.userId}" endpoint="${record.endpoint}" cost=$${record.totalCostUsd.toFixed(6)} tokens=${record.totalTokens}`
    );
}

/**
 * Extract a userId from request headers (preferred) or body (fallback).
 * Returns 'anonymous' when neither is present so tracking still works.
 */
export function getUserId(req) {
    const headerId = req.headers?.['x-user-id'];
    if (headerId && typeof headerId === 'string' && headerId.trim()) return headerId.trim();
    const bodyId = req.body?.userId;
    if (bodyId && typeof bodyId === 'string' && bodyId.trim()) return bodyId.trim();
    return 'anonymous';
}

export function newRequestId() {
    // Lightweight uuid-ish id without an extra dependency.
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
