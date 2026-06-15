"""Internal KB and S3 helpers — no @tool decorator, used by extract.py and design.py."""
import json
from config import bedrock_agent, s3, KNOWLEDGE_BASE_ID, SESSION_BUCKET


def kb_query(query: str, session_id: str, n: int = 3) -> str:
    """Run a single KB query scoped to session_id. Returns concatenated text chunks."""
    if not KNOWLEDGE_BASE_ID:
        return ""
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
        return "\n\n---\n\n".join(chunks)
    except Exception as e:
        return f"KB error: {e}"


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
