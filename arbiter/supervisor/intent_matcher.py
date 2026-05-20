"""Intent-to-workflow matching for multi-workflow apps.

Pure-function module for deterministic keyword-based intent matching.
Used by the Supervisor to route incoming requests to the appropriate
workflow based on keyword overlap scoring.
"""

import re

STOP_WORDS = frozenset({
    'the', 'a', 'an', 'is', 'are', 'was', 'were',
    'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with',
})


def tokenize(text: str) -> list[str]:
    """Lowercase, split on whitespace/punctuation, remove stop words."""
    words = re.findall(r'[a-z0-9]+', text.lower())
    return [w for w in words if w not in STOP_WORDS]


def compute_relevance_score(request_tokens: list[str], keywords: list[str]) -> float:
    """Keyword overlap score: count of matching tokens / total keywords."""
    if not keywords:
        return 0.0
    keyword_set = {k.lower() for k in keywords}
    matches = sum(1 for t in request_tokens if t in keyword_set)
    return matches / len(keyword_set)


def match_intent(
    request_text: str,
    workflows: list[dict],
    min_threshold: float = 0.3,
) -> dict | None:
    """Match request to best workflow by keyword relevance.

    Returns the workflow dict with the highest score above threshold,
    or None if no workflow meets the threshold.
    """
    tokens = tokenize(request_text)
    best_score = 0.0
    best_workflow = None

    for wf in workflows:
        routing = wf.get('routingRule', {})
        keywords = routing.get('keywords', [])
        score = compute_relevance_score(tokens, keywords)
        if score > best_score:
            best_score = score
            best_workflow = wf

    if best_score >= min_threshold and best_workflow:
        return best_workflow
    return None


def route_explicit(workflow_id: str, workflows: list[dict]) -> dict | None:
    """Select workflow by exact workflowId match.

    Returns the matching workflow dict, or None if not found.
    """
    for wf in workflows:
        if wf.get('workflowId') == workflow_id:
            return wf
    return None
