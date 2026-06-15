# MONOLITHIC_DB archetype template

Single large database at the heart of the system; modernization centres on
extracting services and de-risking the DB boundary.

## When the Fabricator selects this archetype

The Fabricator selects MONOLITHIC_DB (C5a) when the evidence shows a single
database instance accreting the majority of business logic, cross-application
reads and writes converging on shared tables, and application teams treating
the schema as the de-facto integration contract. Typical tells include heavy
use of stored procedures, shared sequences, and release cycles gated by DBA
review.

## Contents of this directory

- `system_prompt.md` — archetype-scoped system prompt for the Investigation
  Fabricator, structured with XML tags matching
  `arbiter/fabricator/index.py::get_agent_fabricator_prompt()`.
- `investigation_agent_suite.yaml` — placeholder suite definition; the
  real agent list is populated iteratively per C15.
- `README.md` — this file: archetype summary, selection criteria, and
  provenance.

## Source

GOV-FW §Component 3 / C5a

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
