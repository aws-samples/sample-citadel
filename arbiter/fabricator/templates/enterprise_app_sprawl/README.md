# ENTERPRISE_APP_SPRAWL archetype template

Many interconnected enterprise applications; modernization centres on
rationalizing integrations and consolidating overlapping capability.

## When the Fabricator selects this archetype

The Fabricator selects ENTERPRISE_APP_SPRAWL (C5b) when the evidence shows
a large catalogue of applications with overlapping capabilities, a dense
and poorly documented integration graph, and organizational ownership that
is distributed across many business units. Typical tells include duplicate
master-data stores, middleware congestion, and consolidation programmes
that have stalled on ownership disputes.

## Contents of this directory

- `system_prompt.md` — archetype-scoped system prompt for the Investigation
  Fabricator, structured with XML tags matching
  `arbiter/fabricator/index.py::get_agent_fabricator_prompt()`.
- `investigation_agent_suite.yaml` — placeholder suite definition; the
  real agent list is populated iteratively per C15.
- `README.md` — this file: archetype summary, selection criteria, and
  provenance.

## Source

GOV-FW §Component 3 / C5b

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
