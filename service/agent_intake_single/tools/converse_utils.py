"""Shared Bedrock Converse response parsing helpers."""


def extract_text(resp: dict) -> str:
    """Return the first text block from a Bedrock Converse response, stripped.

    Reasoning-enabled models prepend a reasoningContent block to
    output.message.content, so content[0] is not guaranteed to carry a
    'text' key — the old ``resp['output']['message']['content'][0]['text']``
    idiom raised KeyError: 'text'. This iterates the content blocks and
    returns the first one that has 'text', skipping reasoningContent,
    toolUse, and any other block types.

    Args:
        resp: The raw bedrock.converse() response dict.

    Returns:
        The first text block's content, stripped of surrounding whitespace.

    Raises:
        ValueError: When no text block exists (never KeyError), naming the
            block types that were found so the failure is diagnosable.
    """
    content = ((resp.get("output") or {}).get("message") or {}).get("content") or []
    for block in content:
        if isinstance(block, dict) and "text" in block:
            return block["text"].strip()
    block_types = [
        ", ".join(sorted(block.keys())) if isinstance(block, dict) else type(block).__name__
        for block in content
    ]
    raise ValueError(
        "No text block in Converse response output.message.content; "
        f"found block types: {block_types if block_types else '(empty content)'}"
    )
