"""Planning document tools — business_plan and commercial_plan generation and editing."""
import json
import os
from strands.tools import tool
from tools.kb import s3_get, s3_put, load_json_from_s3, save_json_to_s3
from tools.design import SECTION_KEY, RESOURCING_KEY, RESOURCING_INPUTS_KEY, SYSTEM_PROMPT, _assessment_summary, _rolling_summary
from config import bedrock, AGENT_MODEL_ID

TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), '..', 'templates')

BUSINESS_PLAN_KEY = "{session_id}/planning/business_plan.md"
COMMERCIAL_PLAN_KEY = "{session_id}/planning/commercial_plan.md"
COMMERCIAL_CONFIG_KEY = "{session_id}/planning/commercial_config.json"


def _load_planning_template(name: str) -> dict:
    with open(os.path.join(TEMPLATES_DIR, name)) as f:
        return json.load(f)


def _generate_planning_doc(session_id: str, template: dict, extra_context: str = "") -> str:
    assessment_ctx = _assessment_summary(session_id)
    design_summary = _rolling_summary(session_id)
    resourcing = s3_get(RESOURCING_KEY.format(session_id=session_id)) or ""

    parts = [f"# {template.get('document_title', template['sections'][0]['title'].split()[0] + ' Plan')}\n\n---\n\n"]

    for section in template['sections']:
        prompt = f"""Write section "{section['id']}. {section['title']}" for a planning document.

Description: {section['description']}

Required content:
{chr(10).join(f"- {c}" for c in section['required_content'])}

--- Assessment context ---
{assessment_ctx}

--- Technical design summary ---
{design_summary}

--- Resourcing report ---
{resourcing}

{extra_context}

Write in markdown. Start with ## {section['title']}. Be specific and concise — no filler."""

        response = bedrock.converse(
            modelId=AGENT_MODEL_ID,
            system=[{'text': SYSTEM_PROMPT}],
            messages=[{'role': 'user', 'content': [{'text': prompt}]}],
            inferenceConfig={'maxTokens': 4096},
        )
        content = response['output']['message']['content'][0]['text']
        parts.append(content)
        parts.append("\n\n---\n\n")

    return ''.join(parts)


def _calc_infra_cost(agents: list, agent_infra: dict, monthly_invocations: int) -> dict:
    """Calculate monthly infra cost per agent and total from sizing."""
    fixed = agent_infra['fixed_monthly']
    per_k = agent_infra['per_1000_invocations']
    rows = []
    for a in agents:
        s = a['size']
        cost = fixed[s] + round(per_k[s] * monthly_invocations / 1000)
        rows.append({'name': a['name'], 'size': s, 'fixed': fixed[s], 'usage': round(per_k[s] * monthly_invocations / 1000), 'total': cost})
    return {'rows': rows, 'monthly_total': sum(r['total'] for r in rows), 'monthly_invocations': monthly_invocations}


def _commercial_extra(config: dict) -> str:
    infra = config.get('infra_breakdown', {})
    infra_detail = ""
    if infra.get('rows'):
        rows = '\n'.join(f"  - {r['name']} ({r['size']}): ${r['fixed']} fixed + ${r['usage']} usage = ${r['total']}/month" for r in infra['rows'])
        infra_detail = f"\nInfra cost breakdown ({infra['monthly_invocations']} invocations/month per agent):\n{rows}\nTotal infra: ${infra['monthly_total']}/month"
    return (
        f"Day rate: {config['currency']} {config['day_rate']}/day. "
        f"Monthly infrastructure estimate: {config['currency']} {config.get('infra_cost_monthly', infra.get('monthly_total', 0))}."
        f"{infra_detail}"
    )


@tool
def generate_business_plan(session_id: str) -> str:
    """Generate the Business Plan document (strategic context, stakeholders, risks, recommendation & build path).
    Saves to {session_id}/planning/business_plan.md.

    Args:
        session_id: The session ID

    Returns:
        Confirmation with word count.
    """
    template = _load_planning_template('business_plan_template.json')
    section2 = s3_get(SECTION_KEY.format(session_id=session_id, section_id='2')) or ''
    extra = f"--- Agent definitions (for build path classification) ---\n{section2}"
    doc = _generate_planning_doc(session_id, template, extra)
    s3_put(BUSINESS_PLAN_KEY.format(session_id=session_id), doc)

    from tools.state import _internal_update_progress as update_intake_progress
    update_intake_progress(session_id=session_id, phase='planning', progress=66, change_summary='Business plan generated')

    return f"Business Plan saved ({len(doc.split())} words) to planning/business_plan.md."


@tool
def generate_commercial_plan(session_id: str, day_rate: int = 0) -> str:
    """Generate the Commercial Plan document (resourcing, budget, ROI).
    Saves to {session_id}/planning/commercial_plan.md. Persists day_rate and infra cost for future edits.

    Args:
        session_id: The session ID
        day_rate: Developer day rate in USD (0 = use template default)

    Returns:
        Confirmation with word count.
    """
    tmpl = _load_planning_template('commercial_plan_template.json')
    resourcing_inputs = load_json_from_s3(RESOURCING_INPUTS_KEY.format(session_id=session_id)) or {}
    agents = resourcing_inputs.get('agents', [])

    agent_infra = tmpl['agent_infra']
    monthly_invocations = agent_infra['default_monthly_invocations']
    infra_breakdown = _calc_infra_cost(agents, agent_infra, monthly_invocations) if agents else {}

    config = {
        'day_rate': day_rate if day_rate > 0 else tmpl['default_day_rate'],
        'infra_cost_monthly': infra_breakdown.get('monthly_total', tmpl['infra_cost_monthly_estimate']),
        'infra_breakdown': infra_breakdown,
        'currency': tmpl['currency'],
        'agent_infra': agent_infra,
        'monthly_invocations': monthly_invocations,
    }
    save_json_to_s3(COMMERCIAL_CONFIG_KEY.format(session_id=session_id), config)

    doc = _generate_planning_doc(session_id, tmpl, _commercial_extra(config))
    s3_put(COMMERCIAL_PLAN_KEY.format(session_id=session_id), doc)

    from tools.state import _internal_update_progress as update_intake_progress
    update_intake_progress(session_id=session_id, phase='planning', progress=100, change_summary='Commercial plan generated — planning complete')

    return f"Commercial Plan saved ({len(doc.split())} words) to planning/commercial_plan.md."


@tool
def get_planning_doc(session_id: str, doc_type: str) -> str:
    """Read the current content of a planning document.

    Args:
        session_id: The session ID
        doc_type: 'business' or 'commercial'

    Returns:
        Current markdown content of the document.
    """
    key_map = {'business': BUSINESS_PLAN_KEY, 'commercial': COMMERCIAL_PLAN_KEY}
    key = key_map.get(doc_type)
    if not key:
        return "doc_type must be 'business' or 'commercial'."
    content = s3_get(key.format(session_id=session_id))
    return content if content else f"No {doc_type} plan found. Generate one first."


@tool
def update_planning_doc(session_id: str, doc_type: str, edit_instruction: str) -> str:
    """Edit a planning document. For the commercial plan, also handles changes to day rate or infra cost.

    Args:
        session_id: The session ID
        doc_type: 'business' or 'commercial'
        edit_instruction: Plain-language description of what to change (e.g. "change day rate to 1500")

    Returns:
        Confirmation with updated word count.
    """
    key_map = {'business': BUSINESS_PLAN_KEY, 'commercial': COMMERCIAL_PLAN_KEY}
    tmpl_map = {'business': 'business_plan_template.json', 'commercial': 'commercial_plan_template.json'}
    key = key_map.get(doc_type)
    if not key:
        return "doc_type must be 'business' or 'commercial'."

    template = _load_planning_template(tmpl_map[doc_type])
    existing = s3_get(key.format(session_id=session_id)) or ''

    # For commercial: patch config via converse() then regenerate with updated rates
    if doc_type == 'commercial':
        config = load_json_from_s3(COMMERCIAL_CONFIG_KEY.format(session_id=session_id)) or {
            'day_rate': template['default_day_rate'],
            'infra_cost_monthly': template['infra_cost_monthly_estimate'],
            'currency': template['currency'],
        }
        patch_prompt = f"""Update this commercial plan config JSON based on the edit instruction. Return ONLY valid JSON, no markdown.

Edit instruction: {edit_instruction}

Current config:
{json.dumps(config)}"""

        response = bedrock.converse(
            modelId=AGENT_MODEL_ID,
            messages=[{'role': 'user', 'content': [{'text': patch_prompt}]}],
            inferenceConfig={'maxTokens': 256},
        )
        import re
        raw = response['output']['message']['content'][0]['text']
        match = re.search(r'\{.*\}', raw, re.DOTALL)
        if match:
            config = json.loads(match.group(0))
            # Recalculate infra breakdown if agent_infra or monthly_invocations changed
            resourcing_inputs = load_json_from_s3(RESOURCING_INPUTS_KEY.format(session_id=session_id)) or {}
            agents = resourcing_inputs.get('agents', [])
            if agents and config.get('agent_infra'):
                config['infra_breakdown'] = _calc_infra_cost(agents, config['agent_infra'], config.get('monthly_invocations', 1000))
                config['infra_cost_monthly'] = config['infra_breakdown']['monthly_total']
            save_json_to_s3(COMMERCIAL_CONFIG_KEY.format(session_id=session_id), config)

        extra = _commercial_extra(config) + f"\n\nEdit instruction: {edit_instruction}\n\nExisting document to revise:\n{existing}"
    else:
        extra = f"Edit instruction: {edit_instruction}\n\nExisting document to revise:\n{existing}"

    doc = _generate_planning_doc(session_id, template, extra)
    s3_put(key.format(session_id=session_id), doc)
    return f"{doc_type.title()} Plan updated ({len(doc.split())} words)."
