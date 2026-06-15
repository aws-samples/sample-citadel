# HYBRID_IT_OT archetype template

Mixed IT and Operational Technology; modernization must respect real-world
device safety, deterministic timing, and regulatory constraints.

## When the Fabricator selects this archetype

The Fabricator selects HYBRID_IT_OT (C5c) when the evidence shows
operational technology in scope alongside conventional IT: industrial
control systems, connected physical assets, safety-regulated processes, or
deterministic-timing requirements. Typical tells include Purdue-model
network zoning, vendor-certified control software, maintenance windows
tied to physical operations, and sector-specific regulatory regimes.

## Contents of this directory

- `system_prompt.md` — archetype-scoped system prompt for the Investigation
  Fabricator, structured with XML tags matching
  `arbiter/fabricator/index.py::get_agent_fabricator_prompt()`.
- `investigation_agent_suite.yaml` — placeholder suite definition; the
  real agent list is populated iteratively per C15.
- `README.md` — this file: archetype summary, selection criteria, and
  provenance.

## Source

GOV-FW §Component 3 / C5c

## Refinement cadence

This template is reviewed and refined on the cadence defined by US-GOV
Task 7.2 (quarterly L2 template refinement). Inter-cycle changes are
permitted only when a live investigation surfaces a safety-relevant gap.

## Compound-learning note (C15)

The placeholder content is intentional. Per the C15 compound-learning
effect, each archetype suite improves as it is exercised against real
assessments: findings feed back into the suite definition, which in turn
sharpens the next assessment. Resist the urge to over-specify this
template before field evidence is available.
