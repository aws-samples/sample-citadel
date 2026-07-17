/**
 * Client-side mirror of the worker-side systemPromptAddition size cap
 * (decision 67caf7b0). The worker reads its cap from the
 * WORKER_MAX_PROMPT_ADDITION_CHARS env var (default 4000) and SKIPS any
 * oversized override entirely — never truncating it — so the UI blocks
 * input past the cap and shows a live character counter for early feedback.
 */
export const MAX_SYSTEM_PROMPT_ADDITION_CHARS = 4000;
