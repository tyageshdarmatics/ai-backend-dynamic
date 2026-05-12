// Gemini model pricing (USD per 1 million tokens).
// Override any value via env vars: PRICE_<MODEL>_INPUT, PRICE_<MODEL>_OUTPUT
// e.g. PRICE_GEMINI_2_5_FLASH_INPUT=0.30
//      PRICE_GEMINI_2_5_FLASH_OUTPUT=2.50

const DEFAULT_PRICING = {
    'gemini-2.5-flash': {
        inputPerMillion: 0.30,
        outputPerMillion: 2.50,
    },
    'gemini-2.5-pro': {
        inputPerMillion: 1.25,
        outputPerMillion: 10.00,
    },
    'gemini-1.5-flash': {
        inputPerMillion: 0.075,
        outputPerMillion: 0.30,
    },
};

function envKey(model, suffix) {
    return `PRICE_${model.toUpperCase().replace(/[.-]/g, '_')}_${suffix}`;
}

export function getPricing(model) {
    const base = DEFAULT_PRICING[model] || { inputPerMillion: 0, outputPerMillion: 0 };
    const inputOverride = parseFloat(process.env[envKey(model, 'INPUT')]);
    const outputOverride = parseFloat(process.env[envKey(model, 'OUTPUT')]);
    return {
        inputPerMillion: Number.isFinite(inputOverride) ? inputOverride : base.inputPerMillion,
        outputPerMillion: Number.isFinite(outputOverride) ? outputOverride : base.outputPerMillion,
    };
}

export function calculateCost(model, usageMetadata) {
    const inputTokens = usageMetadata?.promptTokenCount || 0;
    const outputTokens = usageMetadata?.candidatesTokenCount || 0;
    const totalTokens = usageMetadata?.totalTokenCount || (inputTokens + outputTokens);
    const { inputPerMillion, outputPerMillion } = getPricing(model);

    const inputCostUsd = (inputTokens / 1_000_000) * inputPerMillion;
    const outputCostUsd = (outputTokens / 1_000_000) * outputPerMillion;

    return {
        inputTokens,
        outputTokens,
        totalTokens,
        inputCostUsd: round6(inputCostUsd),
        outputCostUsd: round6(outputCostUsd),
        totalCostUsd: round6(inputCostUsd + outputCostUsd),
    };
}

function round6(n) {
    return Math.round(n * 1_000_000) / 1_000_000;
}
