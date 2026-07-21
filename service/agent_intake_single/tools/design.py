"""generate_technical_design tool — bedrock.converse() loop, one section per call."""
import json
import os
from strands.tools import tool
from tools.kb import kb_query, load_json_from_s3, save_json_to_s3, s3_get, s3_put
from tools.converse_utils import extract_text
from concurrent.futures import ThreadPoolExecutor, as_completed
from config import bedrock, get_agent_model_id

TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), '..', 'templates')

DESIGN_METADATA_KEY = "{session_id}/design/td_metadata.json"
SECTION_KEY = "{session_id}/design/td_{section_id}.md"
SUMMARY_KEY = "{session_id}/design/td_rolling_summary.md"
FINAL_KEY = "{session_id}/design/technical_design.md"
RESOURCING_KEY = "{session_id}/design/resourcing_report.md"
RESOURCING_INPUTS_KEY = "{session_id}/design/resourcing_inputs.json"
RESOURCING_DEFAULTS_KEY = "{session_id}/design/resourcing_defaults.json"

SYSTEM_PROMPT = """You are a senior solution architect specialising in agentic AI systems.
Your task is to write one section of a Technical Design document.
Be specific — reference real system names, agent names, field names, and decision rules from the context provided.
Do not reference specific cloud provider services (e.g. no "Amazon SES", "AWS Lambda", "DynamoDB") — use generic terms instead (e.g. "email service", "serverless function", "NoSQL database").
Do not mention specific AI frameworks, SDKs, or orchestration libraries (e.g. no "Strands SDK", "LangChain", "LangGraph") — refer to agents and tools generically.
No generic filler. Write in markdown."""


def _load_template() -> dict:
    with open(os.path.join(TEMPLATES_DIR, 'technical_design_template.json')) as f:
        return json.load(f)


def _load_metadata(session_id: str) -> dict | None:
    return load_json_from_s3(DESIGN_METADATA_KEY.format(session_id=session_id))


def _save_metadata(session_id: str, meta: dict):
    save_json_to_s3(DESIGN_METADATA_KEY.format(session_id=session_id), meta)


def _rolling_summary(session_id: str) -> str:
    return s3_get(SUMMARY_KEY.format(session_id=session_id)) or ""


def _append_rolling_summary(session_id: str, section_title: str, one_liner: str):
    existing = _rolling_summary(session_id)
    updated = existing + f"\n- **{section_title}**: {one_liner}"
    s3_put(SUMMARY_KEY.format(session_id=session_id), updated.strip())


def _assessment_summary(session_id: str) -> str:
    """Load a compact assessment summary for context."""
    lines = []
    for pillar in ['business', 'technical', 'governance']:
        data = load_json_from_s3(f"{session_id}/assessment/{pillar}.json")
        if not data:
            continue
        for section in data['sections'].values():
            for field in section['fields'].values():
                if field.get('value'):
                    lines.append(f"- {field['label']}: {str(field['value'])[:150]}")
    return '\n'.join(lines[:30])  # cap at 30 fields to keep context tight


def _generate_section(session_id: str, section: dict, assessment_summary: str) -> str:
    """Call bedrock.converse() for a single section. Returns generated markdown."""
    rolling = _rolling_summary(session_id)

    # Gather KB context using section-specific queries
    kb_parts = []
    for query in section.get('kb_queries', [section['description']]):
        result = kb_query(query, session_id)
        if result and 'error' not in result.lower():
            kb_parts.append(result)
    kb_context = "\n\n---\n\n".join(kb_parts) if kb_parts else "No additional KB context found."

    user_message = f"""## Section to write: {section['id']}. {section['title']}

**Description:** {section['description']}

**Required content:**
{chr(10).join(f"- {c}" for c in section['required_content'])}

---

## Assessment context (go/no-go inputs):
{assessment_summary}

---

## Prior sections summary:
{rolling if rolling else "This is the first section."}

---

## Relevant content from uploaded documents:
{kb_context}

---

Write the section now in markdown. Start with ## {section['id']}. {section['title']}

After the section content, add a final line in this exact format (do not omit it):
<!-- summary: one sentence describing the key decisions or content of this section -->"""

    response = bedrock.converse(
        modelId=get_agent_model_id(),
        system=[{'text': SYSTEM_PROMPT}],
        messages=[{'role': 'user', 'content': [{'text': user_message}]}],
        inferenceConfig={'maxTokens': 8192},
    )
    return extract_text(response)


@tool
def generate_technical_design(session_id: str) -> str:
    """Generate the Technical Design document section by section using focused LLM calls.
    Safe to call multiple times — resumes from where it left off.
    Publishes progress events to EventBridge after each section.
    Returns when all sections are complete and the document is assembled.

    Args:
        session_id: The session ID

    Returns:
        Progress update or completion confirmation.
    """
    # Import here to avoid circular import
    from tools.state import _internal_update_progress as update_intake_progress

    template = _load_template()
    total = len(template['sections'])
    meta = _load_metadata(session_id)

    if meta is None:
        meta = {
            'session_id': session_id,
            'total_sections': total,
            'completed_sections': 0,
            'sections': {s['id']: 'PENDING' for s in template['sections']},
        }
        _save_metadata(session_id, meta)

    assessment_summary = _assessment_summary(session_id)

    import re

    def _process_section(section):
        content = _generate_section(session_id, section, assessment_summary)
        s3_put(SECTION_KEY.format(session_id=session_id, section_id=section['id']), content)
        match = re.search(r'<!--\s*summary:\s*(.+?)\s*-->', content)
        one_liner = match.group(1) if match else next((l.strip() for l in content.splitlines() if l.strip() and not l.startswith('#')), content[:150])
        return section, one_liner

    def _complete_section(section, one_liner):
        meta['sections'][section['id']] = 'COMPLETE'
        meta['completed_sections'] += 1
        _save_metadata(session_id, meta)
        _append_rolling_summary(session_id, section['title'], one_liner)
        pct = int(meta['completed_sections'] / total * 100)
        update_intake_progress(
            session_id=session_id,
            phase='design',
            progress=pct,
            change_summary=f"{section['title']} complete",
        )

    # Split into independent and dependent sections
    pending = [s for s in template['sections'] if meta['sections'][s['id']] == 'PENDING']
    independent = [s for s in pending if not s.get('depends_on')]
    dependent = [s for s in pending if s.get('depends_on')]

    # Phase 1: Independent sections in parallel
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(_process_section, s): s for s in independent}
        for fut in as_completed(futures):
            section, one_liner = fut.result()
            _complete_section(section, one_liner)

    # Phase 2: Dependent sections sequentially
    for section in dependent:
        section, one_liner = _process_section(section)
        _complete_section(section, one_liner)

    _assemble_and_save(session_id, template)

    full_doc = s3_get(FINAL_KEY.format(session_id=session_id)) or ""
    word_count = len(full_doc.split())

    # Auto-update project progress
    from tools.state import _internal_update_progress as update_intake_progress
    update_intake_progress(session_id=session_id, phase='design', progress=100, change_summary=f'Technical design complete ({word_count} words)')

    return f"Technical Design complete: {word_count} words, {total} sections assembled."


def _load_resourcing_template() -> dict:
    with open(os.path.join(TEMPLATES_DIR, 'resourcing_template.json')) as f:
        return json.load(f)


# Token budgets for the resourcing-inputs extraction call. The old 2048
# budget truncated the JSON on real designs (stopReason=max_tokens), which
# then crashed json.loads — live-confirmed as 14 consecutive tool failures.
RESOURCING_MAX_TOKENS = 4096
RESOURCING_RETRY_MAX_TOKENS = 8192


def _resourcing_error(reason: str) -> dict:
    """Structured, retryable tool error (copy rules: what changed = nothing,
    ONE plain-language reason, ONE next action — never raw error text)."""
    return {
        'error': {
            'what_changed': 'Nothing was changed — no resourcing inputs were inferred.',
            'reason': reason,
            'next_action': 'Run the resourcing inference again shortly.',
            'retryable': True,
        }
    }


def _first_text_block(response: dict) -> str | None:
    """First TEXT content block, skipping reasoningContent/toolUse blocks.
    Returns None (instead of raising) when no text block exists."""
    try:
        return extract_text(response)
    except ValueError:
        return None


def _find_balanced_json(raw: str) -> str | None:
    """Return the first balanced top-level {...} block in ``raw``.

    String-aware (braces inside JSON strings don't count). Scans only from
    the FIRST '{': a truncated top-level object therefore yields None rather
    than silently matching a small balanced inner object. Replaces the old
    greedy r'\\{.*\\}' regex, which spanned to the LAST '}' in the reply and
    broke on any trailing prose containing a brace.
    """
    start = raw.find('{')
    if start == -1:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(raw)):
        ch = raw[i]
        if in_str:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return raw[start:i + 1]
    return None


def _extract_resourcing_inputs(session_id: str) -> dict:
    """Use a single converse() call to extract agents+sizing and integrations+sizing from the design.

    Robust against the three live failure modes:
      - reasoningContent-only replies (no text block): one retry requesting
        plain output, then a structured retryable error;
      - stopReason=max_tokens truncation: one retry with a higher token
        budget — a truncated body is NEVER json.loads'd;
      - malformed / prose-wrapped JSON: balanced-brace extraction +
        JSONDecodeError converted to a structured retryable error.
    """
    section2 = s3_get(SECTION_KEY.format(session_id=session_id, section_id='2')) or ''
    section4 = s3_get(SECTION_KEY.format(session_id=session_id, section_id='4')) or ''
    section5 = s3_get(SECTION_KEY.format(session_id=session_id, section_id='5')) or ''

    tmpl = _load_resourcing_template()
    criteria = tmpl['agent_sizing_criteria']
    int_criteria = tmpl['integration_sizing_criteria']

    prompt = f"""Extract resourcing inputs from these Technical Design sections. Return ONLY valid JSON, no markdown.

Agent sizing criteria: S={criteria['S']} | M={criteria['M']} | L={criteria['L']}
Integration sizing criteria: S={int_criteria['S']} | M={int_criteria['M']} | L={int_criteria['L']}

## Section 2 – Agent Definitions:
{section2}

## Section 4 – Integrations:
{section4}

## Section 5 – Human-in-the-Loop:
{section5}

Return JSON:
{{
  "agents": [{{"name": "...", "size": "S|M|L", "reason": "one line"}}],
  "integrations": [{{"name": "...", "size": "S|M|L", "reason": "one line"}}],
  "hitl_points": <integer count of distinct HITL trigger points>
}}"""

    def _converse(user_prompt: str, max_tokens: int) -> dict:
        return bedrock.converse(
            modelId=get_agent_model_id(),
            messages=[{'role': 'user', 'content': [{'text': user_prompt}]}],
            inferenceConfig={'maxTokens': max_tokens},
        )

    response = _converse(prompt, RESOURCING_MAX_TOKENS)

    # (a) Select the TEXT block explicitly; if the reply carried only
    # reasoningContent, retry ONCE steering the model to plain output.
    raw = _first_text_block(response)
    if raw is None:
        response = _converse(
            prompt + "\n\nIMPORTANT: reply with ONLY the JSON object as plain text — no reasoning, no markdown.",
            RESOURCING_MAX_TOKENS,
        )
        raw = _first_text_block(response)
        if raw is None:
            return _resourcing_error('The model reply contained no readable text output.')

    # (b) Respect stopReason: a max_tokens stop means the JSON body is
    # truncated. Retry ONCE with a higher budget; never parse a truncated body.
    if response.get('stopReason') == 'max_tokens':
        response = _converse(prompt, RESOURCING_RETRY_MAX_TOKENS)
        raw = _first_text_block(response)
        if raw is None:
            return _resourcing_error('The model reply contained no readable text output.')
        if response.get('stopReason') == 'max_tokens':
            return _resourcing_error('The model reply was cut short twice, so the data would be incomplete.')

    # (c) Balanced-brace extraction + explicit decode handling.
    body = _find_balanced_json(raw)
    if body is None:
        return _resourcing_error('The model reply did not contain a complete set of resourcing data.')
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return _resourcing_error('The model reply could not be read as resourcing data.')


@tool
def infer_resourcing_inputs(session_id: str) -> str:
    """Analyse the Technical Design and infer agents (with S/M/L sizing), integrations, and HITL points.
    Call this before generate_resourcing_report to get inputs for user confirmation.

    Args:
        session_id: The session ID

    Returns:
        JSON with inferred agents, integrations, and hitl_points for user confirmation.
    """
    inputs = _extract_resourcing_inputs(session_id)
    return json.dumps(inputs, indent=2)


def _build_resourcing_report(inputs: dict, defaults: dict) -> str:
    """Pure calculation — build the markdown report from inputs + defaults dicts."""
    sizing = defaults['sizing']
    overhead = defaults['overhead']

    agent_list = inputs['agents']
    int_list = inputs['integrations']
    hitl_points = inputs['hitl_points']
    ui_touchpoints = inputs['ui_touchpoints']

    agent_days = sum(sizing['agent'][a['size']] for a in agent_list)
    int_days = sum(sizing['integration'][i['size']] for i in int_list)
    hitl_days = hitl_points * sizing['hitl_point']
    ui_days = ui_touchpoints * sizing['ui_touchpoint']
    base = agent_days + int_days + hitl_days + ui_days + overhead['discovery_days'] + overhead['testing_days'] + overhead['deployment_days']
    buffer = round(base * overhead['pm_buffer_pct'] / 100)
    total = base + buffer
    low = round(total * (1 - defaults['confidence_band_pct'] / 100))
    high = round(total * (1 + defaults['confidence_band_pct'] / 100))
    weeks_mid = round(total / defaults['days_per_week'], 1)
    weeks_low = round(low / defaults['days_per_week'], 1)
    weeks_high = round(high / defaults['days_per_week'], 1)

    agent_rows = '\n'.join(f"| {a['name']} | {a['size']} | {sizing['agent'][a['size']]} |" for a in agent_list)
    int_rows = '\n'.join(f"| {i['name']} | {i['size']} | {sizing['integration'][i['size']]} |" for i in int_list)

    return f"""# Resourcing Estimate

## Summary

| | |
|---|---|
| **Total effort (mid)** | {total} days ({weeks_mid} weeks) |
| **Range** | {low}–{high} days ({weeks_low}–{weeks_high} weeks) |
| **Confidence band** | ±{defaults['confidence_band_pct']}% |

---

## Breakdown

### Agents ({len(agent_list)} total — {agent_days} days)

| Agent | Size | Days |
|---|---|---|
{agent_rows}

### Integrations ({len(int_list)} total — {int_days} days)

| Integration | Size | Days |
|---|---|---|
{int_rows}

### Other

| Item | Count | Days each | Total |
|---|---|---|---|
| Human-in-the-Loop points | {hitl_points} | {sizing['hitl_point']} | {hitl_days} |
| UI touchpoints | {ui_touchpoints} | {sizing['ui_touchpoint']} | {ui_days} |

---

## Overhead

| Item | Days |
|---|---|
| Discovery & requirements | {overhead['discovery_days']} |
| Testing & QA | {overhead['testing_days']} |
| Deployment & handover | {overhead['deployment_days']} |
| PM buffer ({overhead['pm_buffer_pct']}%) | {buffer} |

---

## Assumptions
- Agent sizing: S={sizing['agent']['S']}d, M={sizing['agent']['M']}d, L={sizing['agent']['L']}d
- Integration sizing: S={sizing['integration']['S']}d, M={sizing['integration']['M']}d, L={sizing['integration']['L']}d
- {defaults['days_per_week']}-day working week
- Estimates cover build and unit test only; UAT and production rollout are excluded
- Confidence band reflects requirements uncertainty at this stage
""", total, low, high, weeks_low, weeks_high


@tool
def generate_resourcing_report(
    session_id: str,
    agents: str,
    integrations: str,
    hitl_points: int,
    ui_touchpoints: int,
) -> str:
    """Generate the resourcing estimate report and save it to S3.
    Call this after the user has confirmed the inferred inputs (agents, integrations, hitl_points) and provided ui_touchpoints.

    Args:
        session_id: The session ID
        agents: JSON array of confirmed agents e.g. [{"name":"..","size":"M"}]
        integrations: JSON array of confirmed integrations e.g. [{"name":"..","size":"S"}]
        hitl_points: Number of human-in-the-loop trigger points
        ui_touchpoints: Number of UI touchpoints provided by the user

    Returns:
        Confirmation with total effort estimate.
    """
    defaults = _load_resourcing_template()
    inputs = {
        'agents': json.loads(agents) if isinstance(agents, str) else agents,
        'integrations': json.loads(integrations) if isinstance(integrations, str) else integrations,
        'hitl_points': hitl_points,
        'ui_touchpoints': ui_touchpoints,
    }

    # Persist session copies
    save_json_to_s3(RESOURCING_INPUTS_KEY.format(session_id=session_id), inputs)
    save_json_to_s3(RESOURCING_DEFAULTS_KEY.format(session_id=session_id), defaults)

    report, total, low, high, weeks_low, weeks_high = _build_resourcing_report(inputs, defaults)
    s3_put(RESOURCING_KEY.format(session_id=session_id), report)

    from tools.state import _internal_update_progress as update_intake_progress
    update_intake_progress(session_id=session_id, phase='planning', progress=33, change_summary='Resourcing report generated')

    return f"Resourcing report saved. Estimated effort: {low}–{high} days ({weeks_low}–{weeks_high} weeks)."


@tool
def get_resourcing_report(session_id: str) -> str:
    """Read the current resourcing report and its underlying inputs and defaults.
    Call this when the user wants to review or edit the resourcing estimate.

    Args:
        session_id: The session ID

    Returns:
        JSON with report markdown, current inputs, and current defaults.
    """
    report = s3_get(RESOURCING_KEY.format(session_id=session_id))
    inputs = load_json_from_s3(RESOURCING_INPUTS_KEY.format(session_id=session_id))
    defaults = load_json_from_s3(RESOURCING_DEFAULTS_KEY.format(session_id=session_id))
    if not report:
        return "No resourcing report found. Generate one first."
    return json.dumps({'report': report, 'inputs': inputs, 'defaults': defaults})


@tool
def update_resourcing_report(session_id: str, edit_instruction: str) -> str:
    """Apply an edit to the resourcing report — e.g. change agent sizes, day values, counts, or overhead.
    Interprets the instruction, patches inputs/defaults, recalculates, and overwrites the report.

    Args:
        session_id: The session ID
        edit_instruction: Plain-language description of what to change

    Returns:
        Confirmation with updated effort estimate.
    """
    inputs = load_json_from_s3(RESOURCING_INPUTS_KEY.format(session_id=session_id))
    defaults = load_json_from_s3(RESOURCING_DEFAULTS_KEY.format(session_id=session_id))
    if not inputs or not defaults:
        return "No resourcing report found. Generate one first."

    prompt = f"""You are updating a resourcing estimate. Apply the edit instruction to the inputs and/or defaults below.
Return ONLY valid JSON with two keys: "inputs" and "defaults". Do not change anything not mentioned in the instruction.

Edit instruction: {edit_instruction}

Current inputs:
{json.dumps(inputs, indent=2)}

Current defaults:
{json.dumps(defaults, indent=2)}"""

    response = bedrock.converse(
        modelId=get_agent_model_id(),
        messages=[{'role': 'user', 'content': [{'text': prompt}]}],
        inferenceConfig={'maxTokens': 2048},
    )
    raw = extract_text(response)
    import re
    match = re.search(r'\{.*\}', raw, re.DOTALL)
    if not match:
        return "Could not parse updated values. Please rephrase the edit instruction."

    updated = json.loads(match.group(0))
    new_inputs = updated.get('inputs', inputs)
    new_defaults = updated.get('defaults', defaults)

    save_json_to_s3(RESOURCING_INPUTS_KEY.format(session_id=session_id), new_inputs)
    save_json_to_s3(RESOURCING_DEFAULTS_KEY.format(session_id=session_id), new_defaults)

    report, total, low, high, weeks_low, weeks_high = _build_resourcing_report(new_inputs, new_defaults)
    s3_put(RESOURCING_KEY.format(session_id=session_id), report)
    return f"Resourcing report updated. New estimate: {low}–{high} days ({weeks_low}–{weeks_high} weeks)."


def _assemble_and_save(session_id: str, template: dict):
    import re
    parts = [f"# {template['document_title']}\n\n---\n\n"]
    for section in template['sections']:
        content = s3_get(SECTION_KEY.format(session_id=session_id, section_id=section['id'])) or f"## {section['title']}\n\n*Missing*"
        content = re.sub(r'\n*<!--\s*summary:.*?-->\n*', '\n', content, flags=re.DOTALL)
        parts.append(content)
        parts.append("\n\n---\n\n")
    s3_put(FINAL_KEY.format(session_id=session_id), ''.join(parts))


@tool
def get_design_structure(session_id: str) -> str:
    """Return the list of sections in the Technical Design so the user can choose which to edit.

    Args:
        session_id: The session ID

    Returns:
        JSON list of section id + title.
    """
    template = _load_template()
    return json.dumps([{'id': s['id'], 'title': s['title']} for s in template['sections']])


@tool
def get_design_section(session_id: str, section_id: str) -> str:
    """Read the current content of a specific Technical Design section.

    Args:
        session_id: The session ID
        section_id: Section ID (1–5)

    Returns:
        Current markdown content of the section.
    """
    content = s3_get(SECTION_KEY.format(session_id=session_id, section_id=section_id))
    if not content:
        return f"Section {section_id} has not been generated yet."
    import re
    return re.sub(r'\n*<!--\s*summary:.*?-->\n*', '\n', content, flags=re.DOTALL).strip()


@tool
def update_design_section(session_id: str, section_id: str, edit_instruction: str) -> str:
    """Regenerate a single Technical Design section based on an edit instruction, then reassemble the full document.

    Args:
        session_id: The session ID
        section_id: Section ID to regenerate (1–5)
        edit_instruction: Plain-language description of what to change

    Returns:
        Confirmation with word count of updated section.
    """
    template = _load_template()
    section = next((s for s in template['sections'] if s['id'] == section_id), None)
    if not section:
        return f"Section {section_id} not found."

    existing = get_design_section(session_id, section_id)
    assessment_summary = _assessment_summary(session_id)

    # Inject edit instruction into the section prompt
    original_section = dict(section)
    original_section['description'] = (
        f"{section['description']}\n\n"
        f"**Edit instruction:** {edit_instruction}\n\n"
        f"**Existing content to revise:**\n{existing}"
    )

    content = _generate_section(session_id, original_section, assessment_summary)
    s3_put(SECTION_KEY.format(session_id=session_id, section_id=section_id), content)

    # Update rolling summary entry for this section
    import re
    match = re.search(r'<!--\s*summary:\s*(.+?)\s*-->', content)
    if match:
        summary_text = s3_get(SUMMARY_KEY.format(session_id=session_id)) or ""
        # Replace existing entry for this section title
        updated = re.sub(
            rf'- \*\*{re.escape(section["title"])}\*\*:.*',
            f'- **{section["title"]}**: {match.group(1)}',
            summary_text,
        )
        s3_put(SUMMARY_KEY.format(session_id=session_id), updated)

    _assemble_and_save(session_id, template)

    word_count = len(content.split())
    return f"Section {section_id} '{section['title']}' updated ({word_count} words). Full document reassembled."

