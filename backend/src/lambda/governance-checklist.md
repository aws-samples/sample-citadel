# Governance Checklist — Executive Audit

Derived from [GOV-FW-CTO §Recommendations, p12]. Twenty pass/fail questions
across five clusters used by `runProgramReview(projectId)` to
evaluate project evidence against the AI-Accelerated Modernization Framework.
Each question pairs with machine-checkable evidence drawn from the governance
entities (ADR, ExecutionSpecification, InterrogationRound, AgentDesignAssessment).

Do not reword question text without a spec-level PR — question IDs are a
stable contract consumed by the ProgramReview resolver.

**Scope note:** Governance evaluation in this checklist is org-uniform. Every question applies identically regardless of the originating organization. Resource visibility is scoped separately via the `orgId` field on RegistryAgentRecord, AgentConfig, ToolConfig, Workflow, Integration, DataStore, and Execution — but governance rules themselves are not per-org.

## Investigation Design

### Q001: Four-dimension assessment completed

The project must have a completed agent design assessment that classifies the
archetype and ranks all four framework dimensions (technical, governance,
business, commercial). Partial or unclassified assessments fail this check.

Required evidence: An AgentDesignAssessment row for the project with archetypeStatus='CLASSIFIED' and all four dimensions present in dimensionRanking.

Source: [GOV-FW-CTO §Recommendations, p12]

### Q002: Operations staff interviewed during discovery

Discovery must include direct interviews with the operations staff who run the
target systems day-to-day, not only architects or product owners. Evidence must
show ops-role participation captured in the interrogation record.

Required evidence: ≥1 InterrogationRound row for the project with participantRoles containing 'OPERATIONS' and status in ('STABILISED','COMPLETE').

Source: [GOV-FW-CTO §Recommendations, p12]

### Q003: Integration archaeology performed

A deliberate integration archaeology pass must map undocumented upstream and
downstream dependencies of the target system. Assessments missing this
dimension cannot pass.

Required evidence: An AgentDesignAssessment row for the project with dimensionRanking entries including dimension='INTEGRATION_ARCHAEOLOGY' and coverage='COMPLETE'.

Source: [GOV-FW-CTO §Recommendations, p12]

### Q004: Non-functional constraints surfaced before design

Non-functional constraints (latency, throughput, compliance, data residency)
must be surfaced during investigation, not deferred to execution. The
assessment record must enumerate at least the mandatory NFR classes.

Required evidence: An AgentDesignAssessment row for the project with nonFunctionalConstraints listing at minimum ['PERFORMANCE','SECURITY','COMPLIANCE'].

Source: [GOV-FW-CTO §Recommendations, p12]

## Advisory Structure

### Q005: Advisory runs as a multi-round loop

Advisory must be iterative — a single workshop does not satisfy the framework.
At least three stabilised interrogation rounds are required to demonstrate a
genuine loop rather than a one-shot consultation.

Required evidence: ≥3 InterrogationRound rows for the project with status='STABILISED'.

Source: [GOV-FW-CTO §Recommendations, p13]

### Q006: Decisions captured as locked ADRs

Architecture decisions emerging from advisory must be recorded as ADRs and
locked so they cannot be silently rewritten. Unlocked or absent ADRs fail.

Required evidence: ≥1 ADR with status='LOCKED' linked to the project.

Source: [GOV-FW-CTO §Recommendations, p13]

### Q007: Constraints injected into the advisory loop

Each interrogation round must consume the constraints surfaced in prior rounds
or the initial assessment, proving constraints actually shape advisory output.

Required evidence: ≥1 InterrogationRound row for the project with injectedConstraintIds non-empty and status='STABILISED'.

Source: [GOV-FW-CTO §Recommendations, p13]

### Q008: Advisory rounds reach stabilisation, not just closure

Rounds closed without stabilisation indicate forced timelines overriding
advisory quality. The ratio of stabilised to total rounds must demonstrate
convergence.

Required evidence: For the project, count(InterrogationRound.status='STABILISED') / count(InterrogationRound) ≥ 0.75.

Source: [GOV-FW-CTO §Recommendations, p13]

## Execution Design

### Q009: Design agents are separate from execution tools

The program must maintain a clean separation between design-time agents and
execution-time tooling. Evidence requires distinct entity lineage between the
assessment/ADR layer and the execution specification layer.

Required evidence: ≥1 ExecutionSpecification row linked to the project whose sourceDesignArtifactType is in ('ADR','AgentDesignAssessment') and whose executorKind is not 'DESIGN_AGENT'.

Source: [GOV-FW-CTO §Recommendations, p14]

### Q010: Specifications validated by humans before execution

Every execution specification must carry a human approval stamp before it can
be executed. Auto-approved or unapproved specs fail.

Required evidence: ≥1 ExecutionSpecification with status='APPROVED' and approvedBy referencing a human principal, linked to the project.

Source: [GOV-FW-CTO §Recommendations, p14]

### Q011: Execution specs trace back to locked ADRs

Each execution specification must cite the ADR(s) it implements so that
downstream drift from the design of record is detectable.

Required evidence: ≥1 ExecutionSpecification linked to the project with sourceAdrIds referencing ADR rows whose status='LOCKED'.

Source: [GOV-FW-CTO §Recommendations, p14]

### Q012: Execution specs are human-readable, not only machine-generated

Specs generated purely by an agent without a reviewed narrative do not meet the
framework's transparency requirement. A reviewed narrative artefact must be
attached.

Required evidence: ≥1 ExecutionSpecification for the project with narrativeReviewStatus='REVIEWED' and status='APPROVED'.

Source: [GOV-FW-CTO §Recommendations, p14]

## Investment Framing

### Q013: Design investment is a named line item

Design work must appear as its own budget line, distinct from execution. If the
program review cannot read a design budget share, the project fails this check.

Required evidence: ≥1 ProgramReview row for the project with investmentBreakdown.designPct present and ≥ 0.

Source: [GOV-FW-CTO §Recommendations, p15]

### Q014: Design share of budget meets the framework floor

The framework recommends that design-phase investment account for at least 20%
of the total program budget. Programs below this threshold fail unless
explicitly waived and recorded.

Required evidence: ≥1 ProgramReview row for the project with investmentBreakdown.designPct ≥ 0.20.

Source: [GOV-FW-CTO §Recommendations, p15]

### Q015: Execution spend does not dominate pre-design

No execution spend should precede the locked design — investment sequencing is
checked against ADR lock timestamps.

Required evidence: ≥1 ProgramReview row for the project with investmentBreakdown.executionSpendBeforeAdrLockPct ≤ 0.10.

Source: [GOV-FW-CTO §Recommendations, p15]

### Q016: Contingency reserved for re-design, not only overruns

The investment plan must carry a contingency pool explicitly earmarked for
re-design triggered by advisory findings, not only for execution overruns.

Required evidence: ≥1 ProgramReview row for the project with investmentBreakdown.redesignContingencyPct ≥ 0.05.

Source: [GOV-FW-CTO §Recommendations, p15]

## Partner Capability

### Q017: Partner has comparable prior engagements on record

The delivery partner must be able to cite at least two comparable prior
engagements with verifiable outcomes, captured on the program review.

Required evidence: ≥1 ProgramReview row for the project with partnerCapability.priorEngagements length ≥ 2 and each entry carrying outcomeReference.

Source: [GOV-FW-CTO §Recommendations, p16]

### Q018: Partner staffed senior design roles, not only delivery

The partner's staffing plan must include senior design roles (principal
architect, staff engineer, or equivalent), not only implementation staff.

Required evidence: ≥1 ProgramReview row for the project with partnerCapability.seniorDesignRoleCount ≥ 1.

Source: [GOV-FW-CTO §Recommendations, p16]

### Q019: Partner accepted framework-aligned governance terms

The partner contract must reference framework-aligned governance obligations
(ADR lock, stabilised rounds, human approval) rather than substituting an
internal methodology.

Required evidence: ≥1 ProgramReview row for the project with partnerCapability.governanceTermsAccepted=true and frameworkRef='GOV-FW-CTO'.

Source: [GOV-FW-CTO §Recommendations, p16]

### Q020: Partner participates in continuous program review

The partner must be a named participant in the ongoing program review, closing
the loop between delivery and governance audit.

Required evidence: ≥1 ProgramReview row for the project with partnerCapability.participatesInReview=true and reviewStatus in ('ACTIVE','STABILISED').

Source: [GOV-FW-CTO §Recommendations, p16]
