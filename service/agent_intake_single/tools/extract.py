"""extract_information tool — KB retrieval + LLM extraction with running scorecard."""
import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from strands.tools import tool
from tools.kb import kb_retrieve, load_json_from_s3, save_json_to_s3
from tools.converse_utils import extract_text
from config import bedrock, AWS_REGION
from region import cross_region_prefix
from model_config_loader import load_extraction_model_id

logger = logging.getLogger(__name__)

TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), '..', 'templates')
# fourth assessment pillar 'dimensions' appended per QT2B-3.
# Minimum-churn addition — get_next_assessment_question, _init_if_needed,
# _all_fields_scorecard, and every other function that iterates PILLARS picks
# up the new pillar automatically. Existing in-flight sessions grandfather
# cleanly because _init_if_needed only creates pillar state that's missing.
PILLARS = ['business', 'technical', 'governance', 'dimensions']

_FALLBACK_EXTRACTION_MODEL = os.environ.get("EXTRACTION_MODEL") or f"{cross_region_prefix(AWS_REGION)}.anthropic.claude-haiku-4-5-20251001-v1:0"
EXTRACTION_MODEL = load_extraction_model_id(region=AWS_REGION, fallback_model_id=_FALLBACK_EXTRACTION_MODEL)

EXTRACTION_SYSTEM_PROMPT = """You are extracting specific information from business documents to assess whether a process is suitable for agentification.
For each field, extract a concise, specific value from the document context provided.
If the information is not present in the context, respond with null for that field.
Respond only with a JSON object — no explanation."""

# Readiness probe backoff. A just-uploaded document can report INDEXED while
# the vector index is not yet queryable — retrieval returns empty for a short
# window and a later retry succeeds. Total sleep budget ≈ 45s across 7
# attempts (one immediate + these delays).
READINESS_PROBE_DELAYS = (2, 3, 5, 8, 12, 15)

# Seam for tests; production sleeps for real.
_probe_sleep = time.sleep


def _probe_document_searchable(session_id: str, probe_query: str) -> bool:
    """Bounded probe that the session's documents are actually retrievable.

    Retrieval is scoped to the session, so ANY returned chunk proves the
    uploaded content has become searchable. Backs off up to ~45s total;
    returns False when the KB is still returning nothing (or erroring).
    """
    for attempt, delay in enumerate((0,) + READINESS_PROBE_DELAYS):
        if delay:
            _probe_sleep(delay)
        result = kb_retrieve(probe_query, session_id)
        if result.status == 'content':
            return True
        if result.status == 'error':
            logger.warning(
                "readiness probe attempt %d failed session=%s: %s",
                attempt + 1, session_id, result.detail,
            )
    return False


def _assessment_key(session_id: str, pillar: str) -> str:
    return f"{session_id}/assessment/{pillar}.json"

def _load_template(pillar: str) -> dict:
    with open(os.path.join(TEMPLATES_DIR, f'assessment_{pillar}.json')) as f:
        return json.load(f)

def _init_if_needed(session_id: str):
    for pillar in PILLARS:
        key = _assessment_key(session_id, pillar)
        if load_json_from_s3(key) is None:
            save_json_to_s3(key, _load_template(pillar))

def _completion(data: dict) -> tuple[int, int]:
    filled = total = 0
    for section in data['sections'].values():
        for field in section['fields'].values():
            if field.get('required'):
                total += 1
                if field['value'] is not None:
                    filled += 1
    return filled, total

def _all_fields_scorecard(session_id: str) -> tuple[list[dict], list[dict]]:
    """Returns (completed_fields, pending_fields) across all pillars."""
    completed, pending = [], []
    for pillar in PILLARS:
        data = load_json_from_s3(_assessment_key(session_id, pillar))
        if not data:
            continue
        for section_key, section in data['sections'].items():
            for field_key, field in section['fields'].items():
                if not field.get('required'):
                    continue
                entry = {
                    'pillar': pillar,
                    'section': section_key,
                    'field': field_key,
                    'label': field['label'],
                    'kb_hint': field.get('kb_hint', field['label']),
                }
                if field['value'] is not None:
                    entry['value'] = str(field['value'])[:100]
                    completed.append(entry)
                else:
                    pending.append(entry)
    return completed, pending

def _all_fields_scorecard_from_data(pillar_data: dict) -> tuple[list[dict], list[dict]]:
    """Compute scorecard from in-memory pillar data without S3 reads."""
    completed, pending = [], []
    for pillar, data in pillar_data.items():
        if not data:
            continue
        for section_key, section in data['sections'].items():
            for field_key, field in section['fields'].items():
                if not field.get('required'):
                    continue
                entry = {
                    'pillar': pillar,
                    'section': section_key,
                    'field': field_key,
                    'label': field['label'],
                    'kb_hint': field.get('kb_hint', field['label']),
                }
                if field['value'] is not None:
                    entry['value'] = str(field['value'])[:100]
                    completed.append(entry)
                else:
                    pending.append(entry)
    return completed, pending

def _extract_field_with_llm(session_id: str, field: dict, kb_context: str, completed: list[dict], pending: list[dict]) -> str | None:
    """Single LLM call to extract one field value, with full scorecard context."""
    completed_lines = '\n'.join(f" ✓ {f['label']}: {f.get('value', '')}" for f in completed) or ' (none yet)'
    pending_labels = '\n'.join(f" • {f['label']}" for f in pending)

    prompt = f"""## Extraction task
We are assessing a business process for agentification suitability.
We need to extract {len(completed) + len(pending)} fields in total.

## Already extracted ({len(completed)} fields):
{completed_lines}

## Still to extract ({len(pending)} fields):
{pending_labels}

## Current field to extract:
Field: {field['label']}
Description: {field.get('kb_hint', field['label'])}

## Document context:
{kb_context}

## Instructions:
Extract the value for "{field['label']}" from the document context above.
Use the already-extracted fields for context (e.g. if process name is known, use it to interpret ambiguous text).
If the information is clearly present, return: {{"value": "<extracted value>"}}
If not present or too ambiguous, return: {{"value": null}}
JSON only, no explanation."""

    response = bedrock.converse(
        modelId=EXTRACTION_MODEL,
        system=[{'text': EXTRACTION_SYSTEM_PROMPT}],
        messages=[{'role': 'user', 'content': [{'text': prompt}]}],
        inferenceConfig={'maxTokens': 256},
    )
    raw = extract_text(response)
    # Strip markdown code fences if present
    if raw.startswith('```'):
        raw = raw.split('```')[1]
        if raw.startswith('json'):
            raw = raw[4:]
        raw = raw.strip()
    try:
        value = json.loads(raw).get('value')
    except Exception:
        value = None

    return value

@tool
def extract_information(session_id: str) -> str:
    """Extract assessment information from uploaded documents.
    Queries the KB for each field and uses an LLM to extract clean values.
    Each extraction call includes a scorecard of completed and pending fields for context.
    Safe to call multiple times — skips already-filled fields.

    Args:
        session_id: The session ID

    Returns:
        JSON with completion stats and remaining gaps.
    """
    _init_if_needed(session_id)

    # Load all pillar data once into memory
    pillar_data = {}
    for pillar in PILLARS:
        pillar_data[pillar] = load_json_from_s3(_assessment_key(session_id, pillar))

    completed, pending = _all_fields_scorecard_from_data(pillar_data)

    # Honest emptiness: before the field-extraction pass, verify the
    # just-uploaded document is actually retrievable. A document can report
    # INDEXED while the index is not yet queryable — the old code then
    # silently reported 0/N fields extracted.
    if pending:
        probe_hint = pending[0].get('kb_hint', pending[0]['label'])
        if not _probe_document_searchable(session_id, probe_hint):
            # Copy rules: what changed (nothing), ONE plain reason, ONE next
            # action — never raw error text.
            return json.dumps({
                'status': 'document_not_searchable',
                'what_changed': 'Nothing was extracted — the assessment is unchanged.',
                'reason': 'The uploaded document is still being made searchable.',
                'next_action': 'Wait a short moment, then run the extraction again.',
                'retryable': True,
            })

    # Group pending fields by section for batched KB queries
    sections: dict[tuple, list[dict]] = {}
    for field in pending:
        key = (field['pillar'], field['section'])
        sections.setdefault(key, []).append(field)

    # One KB query per section, with one bounded retry on a FAILED lookup.
    # A failed section is marked skipped in the result — never silently
    # treated as empty.
    section_contexts: dict[tuple, str] = {}
    skipped_sections: list[dict] = []
    for key, fields in sections.items():
        hint = fields[0].get('kb_hint', fields[0]['label'])
        result = kb_retrieve(hint, session_id)
        if result.status == 'error':
            logger.warning(
                "KB lookup failed for section %s/%s (retrying once): %s",
                key[0], key[1], result.detail,
            )
            result = kb_retrieve(hint, session_id)
        if result.status == 'error':
            logger.warning(
                "KB lookup failed twice for section %s/%s — marking skipped: %s",
                key[0], key[1], result.detail,
            )
            skipped_sections.append({
                'pillar': key[0],
                'section': key[1],
                'reason': 'The document lookup for this section failed — it will be retried on the next extraction run.',
            })
            continue
        if result.status == 'content':
            section_contexts[key] = result.content

    # Parallel extraction
    filled_this_run = 0
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = {}
        for key, ctx in section_contexts.items():
            for field_meta in sections[key]:
                fut = pool.submit(
                    _extract_field_with_llm, session_id, field_meta, ctx, completed, pending
                )
                futures[fut] = field_meta

        for fut in as_completed(futures):
            field_meta = futures[fut]
            try:
                value = fut.result()
            except Exception:
                continue
            if value is None:
                continue
            pillar_data[field_meta['pillar']]['sections'][field_meta['section']]['fields'][field_meta['field']]['value'] = value
            filled_this_run += 1

    # Bulk S3 write — once per pillar
    for pillar in PILLARS:
        save_json_to_s3(_assessment_key(session_id, pillar), pillar_data[pillar])

    # Final completion count from in-memory data
    total_filled = total_required = 0
    still_missing = []
    for pillar in PILLARS:
        data = pillar_data[pillar]
        if not data:
            continue
        f, t = _completion(data)
        total_filled += f
        total_required += t
        for section_key, section in data['sections'].items():
            for field_key, field in section['fields'].items():
                if field.get('required') and field['value'] is None:
                    still_missing.append({'pillar': pillar, 'section': section_key,
                                          'field': field_key, 'label': field['label']})

    return json.dumps({
        'filled_this_run': filled_this_run,
        'total_filled': total_filled,
        'total_required': total_required,
        'completion_pct': round(total_filled / total_required * 100, 1) if total_required else 0,
        'still_missing': still_missing,
        'skipped_sections': skipped_sections,
    })

@tool
def get_assessment_summary(session_id: str) -> str:
    """Get a compact summary of all filled assessment fields for the go/no-go decision.

    Args:
        session_id: The session ID

    Returns:
        Markdown summary of assessment data.
    """
    lines = []
    for pillar in PILLARS:
        data = load_json_from_s3(_assessment_key(session_id, pillar))
        if not data:
            continue
        lines.append(f"## {pillar.title()}")
        for section_key, section in data['sections'].items():
            lines.append(f"### {section.get('title', section_key)}")
            for field_key, field in section['fields'].items():
                val = field.get('value')
                if val:
                    lines.append(f"- **{field['label']}**: {str(val)[:200]}")
    return '\n'.join(lines) if lines else "No assessment data found."

@tool
def get_next_assessment_question(session_id: str) -> str:
    """Get the next unanswered required assessment field to ask the user about.
    Returns one field at a time. Returns 'complete' when all required fields are filled.

    Args:
        session_id: The session ID

    Returns:
        JSON with pillar, section, field, label, completion_pct — or 'complete'.
    """
    _init_if_needed(session_id)
    for pillar in PILLARS:
        data = load_json_from_s3(_assessment_key(session_id, pillar))
        if not data:
            continue
        for section_key, section in data['sections'].items():
            for field_key, field in section['fields'].items():
                if field.get('required') and field['value'] is None:
                    filled, total = _completion(data)
                    return json.dumps({
                        'pillar': pillar,
                        'section': section_key,
                        'field': field_key,
                        'label': field['label'],
                        'hint': field.get('hint', ''),
                        'completion_pct': round(filled / total * 100, 1) if total else 0,
                    })
    return 'complete'

@tool
def update_assessment_field(session_id: str, pillar: str, section: str, field: str, value: str) -> str:
    """Save a single assessment field value provided by the user in conversation.

    Args:
        session_id: The session ID
        pillar: business, technical, governance, or dimensions
        section: Section key within the pillar
        field: Field key within the section
        value: The value to save

    Returns:
        Confirmation with updated completion percentage.
    """
    key = _assessment_key(session_id, pillar)
    data = load_json_from_s3(key)
    if data is None:
        _init_if_needed(session_id)
        data = load_json_from_s3(key)

    if section not in data['sections'] or field not in data['sections'][section]['fields']:
        return f"Unknown field: {pillar}.{section}.{field}"

    data['sections'][section]['fields'][field]['value'] = value
    save_json_to_s3(key, data)

    filled, total = _completion(data)
    return f"Saved {pillar}.{section}.{field}. Pillar completion: {filled}/{total}"
