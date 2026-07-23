"""Internal KB and S3 helpers — no @tool decorator, used by extract.py and design.py."""
import json
from dataclasses import dataclass
from config import bedrock_agent, s3, KNOWLEDGE_BASE_ID, SESSION_BUCKET


@dataclass(frozen=True)
class KBResult:
    """Outcome of a KB retrieval — distinguishes error/empty/content.

    status:  'content' — chunks were retrieved (in ``content``)
             'empty'   — the query ran but returned no chunks (also used when
                         no knowledge base is configured)
             'error'   — the retrieval FAILED; ``detail`` carries the
                         diagnostic for logs only and must NEVER be surfaced
                         as document content.
    """
    status: str
    content: str = ""
    detail: str = ""


def kb_retrieve(query: str, session_id: str, n: int = 3) -> KBResult:
    """Run a single KB query scoped to session_id with an honest outcome.

    Never raises and never smuggles error text into ``content`` — the old
    contract returned "KB error: {e}" strings as if they were document
    content, which downstream extraction then treated as context.
    """
    if not KNOWLEDGE_BASE_ID:
        return KBResult(status="empty", detail="knowledge base not configured")
    try:
        resp = bedrock_agent.retrieve(
            knowledgeBaseId=KNOWLEDGE_BASE_ID,
            retrievalQuery={'text': query},
            retrievalConfiguration={
                'vectorSearchConfiguration': {
                    'numberOfResults': n,
                    'filter': {'equals': {'key': 'session_id', 'value': session_id}},
                    'overrideSearchType': 'HYBRID',
                }
            },
        )
        chunks = [r['content']['text'] for r in resp.get('retrievalResults', []) if r.get('content', {}).get('text')]
        if not chunks:
            return KBResult(status="empty")
        return KBResult(status="content", content="\n\n---\n\n".join(chunks))
    except Exception as e:
        return KBResult(status="error", detail=str(e))


def kb_query(query: str, session_id: str, n: int = 3) -> str:
    """Back-compat wrapper: returns retrieved content, or '' on empty/error.

    Never returns error text as content (see kb_retrieve).
    """
    return kb_retrieve(query, session_id, n).content


def s3_get(key: str) -> str | None:
    try:
        resp = s3.get_object(Bucket=SESSION_BUCKET, Key=key)
        return resp['Body'].read().decode()
    except Exception:
        return None


def s3_put(key: str, body: str, content_type: str = 'text/plain'):
    s3.put_object(Bucket=SESSION_BUCKET, Key=key, Body=body.encode(), ContentType=content_type)


def load_json_from_s3(key: str) -> dict | None:
    raw = s3_get(key)
    return json.loads(raw) if raw else None


def save_json_to_s3(key: str, data: dict):
    s3_put(key, json.dumps(data, indent=2), 'application/json')
