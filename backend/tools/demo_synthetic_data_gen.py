#!/usr/bin/env python3
# ============================================================================
#  WARNING — WORKSHOP / DEMO TOOL ONLY.  NOT FOR PRODUCTION.
#  This script WRITES synthetic records to REAL AWS governance resources
#  (DynamoDB tables, SSM parameters, CloudWatch metrics and — optionally —
#  IAM roles) in the targeted account/region.  It refuses to run against a
#  prod-looking environment and requires interactive confirmation unless
#  --yes or --dry-run is given.  Every record it creates is tagged with the
#  marker attribute demoDataset='workshop-governance' and a deterministic
#  'demo-' id prefix so it can be cleanly removed with --purge.
# ============================================================================
"""Citadel governance synthetic data generator (WORKSHOP ONLY).

Purpose
-------
Populate every Citadel /governance UI data location with realistic,
self-consistent demo data so that all governance pages can be shown live in
a workshop and all 11 rollout readiness checks light up the expected colour.

What it writes
--------------
* DynamoDB:
    - citadel-authority-units-dev          (authority graph nodes)
    - citadel-composition-contracts-dev    (pairwise contracts)
    - citadel-constitutional-layers-dev    (global/domain/pairwise layers)
    - citadel-case-law-dev                 (precedence + a revoked entry)
    - citadel-governance-ledger-dev        (~9 days of findings + a recent burst)
    - citadel-governance-graph-snapshots-dev (2-3 time-spaced snapshots)
    - citadel-datastores-dev / citadel-integrations-dev (IAM picker resources)
* SSM (String params under /citadel/governance/...):
    enforce, effective_at, reconciler/last_status, readiness/manual/own-{1,2,3},
    authority-graph-history.  rb-2 history is exercised via an Overwrite
    sequence: strict -> permissive -> shadow.
* CloudWatch:
    CitadelGovernance/OffFrontierEscalations (Sum, no dims) over ~7 days with
    spikes; RegistrySync/SyncFailure left at zero over 48h (tel-3 PASS).
* IAM (guarded by --with-iam / --no-iam):
    demo scoped role(s) citadel-ds-<demoDataStoreId> + inline DataStoreAccess
    policy, one of which is a deliberate SUPERSET of the adapter's required
    connect actions to trigger the drift detector.

How to run
----------
    # Preview everything, perform NO writes, no AWS needed:
    python backend/tools/demo_synthetic_data_gen.py --dry-run

    # Preview with resolved names from live stacks (reads AWS, writes nothing):
    python backend/tools/demo_synthetic_data_gen.py --dry-run --discover

    # Seed dev (interactive confirm):
    python backend/tools/demo_synthetic_data_gen.py --env dev --region us-west-2

    # Non-interactive seed without IAM:
    python backend/tools/demo_synthetic_data_gen.py --yes --no-iam

    # Remove everything this tool created:
    python backend/tools/demo_synthetic_data_gen.py --purge --yes

CloudFormation discovery (default)
----------------------------------
For real runs, the tool DISCOVERS all AWS resources from the deployed Citadel
CloudFormation stacks before seeding — no hardcoded account/registry/table
names on the happy path:
  * account      <- sts get_caller_identity (authoritative)
  * region       <- boto3 session / --region
  * registryId   <- stack Output 'AgentCoreRegistryId' (fallback: parsed from an
                    AgentCore ARN output) in citadel-backend-<env>
  * eventBusName <- stack Output 'EventBusName'
  * tables       <- aggregated stack RESOURCES (AWS::DynamoDB::Table) across all
                    selected stacks. The five governance tables + the
                    graph-snapshots table live in citadel-arbiter-<env> and are
                    NOT emitted as CFN Outputs, so they are resolved by stack
                    RESOURCES (physical name match or camel/Pascal LogicalId).
Stacks are selected by name regex ^<--stack-prefix>-.*-<env>$ (default prefix
'citadel'; stacks merely ending in -<env> are also tolerated); DELETE_* and
REVIEW_IN_PROGRESS stacks are skipped. A DISCOVERY REPORT listing each resolved
value and its source (cfn-output | cfn-resource | sts | env | cli-override |
convention-fallback) prints at startup. Flags:
  * --no-discover  skip discovery; use convention/env/overrides only
  * --discover     force discovery even in --dry-run (the only dry path that
                   touches AWS) to preview resolved names offline-with-creds
  * --stack-prefix configure the discovery prefix (default 'citadel')
Resolution precedence for table names: --table-* override > matching env var >
DISCOVERED (cfn) > convention citadel-<logical>-<env> (with a WARNING). The
literal known account/registry values are retained ONLY as last-resort
fallbacks used when discovery fails AND no override is given (WARNING emitted).

Live-AWS caveats (cannot be forced from DynamoDB)
-------------------------------------------------
* data-2: the AgentCore Registry must resolve sampled registryIds.  The
  '*GLOBAL*' sentinel is intended to bypass registry resolution; if the
  resolver still resolves it, a real registry record is required — this tool
  prints a WARNING in the readiness report.
* data-3: every agent + tool in the Registry must carry registryId inside
  customDescriptorContent.  This lives in the AgentCore Registry, not in DDB,
  so it cannot be seeded here — guidance is printed.
* tel-3: handled by leaving RegistrySync/SyncFailure at zero (PASS).

Naming conventions for the back-fill style follow
backend/scripts/reconcile-apps-meta.ts and backfill-org-ids.ts; this script
is standalone Python (boto3 + stdlib only, Python 3.12+).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEMO_MARKER_ATTR = "demoDataset"
DEMO_MARKER_VALUE = "workshop-governance"
DEMO_ID_PREFIX = "demo-"
DEMO_TAG_KEY = "demoDataset"
DEMO_TAG_VALUE = DEMO_MARKER_VALUE

DEFAULT_ENV = "dev"
DEFAULT_REGION = "us-west-2"
# This is a GENERIC tool run in many AWS accounts whose ids are unknown until
# provisioned. There are NO baked-in account/registry literals: the account is
# resolved via --account override or STS, and the registry id via --registry-id
# or CloudFormation discovery. The placeholders below are OBVIOUSLY-fake strings
# used ONLY for dry-run preview ARN construction — never on a real run.
PLACEHOLDER_ACCOUNT = "<ACCOUNT_ID>"
PLACEHOLDER_REGISTRY = "<REGISTRY_ID>"
DEFAULT_SEED = 42

SAFE_ENVS = {"dev", "sandbox", "workshop", "demo"}
PROD_HINTS = ("prod", "prd", "production", "live", "gamma")

ESCALATION_NAMESPACE = "CitadelGovernance"
ESCALATION_METRIC = "OffFrontierEscalations"
SYNC_NAMESPACE = "RegistrySync"
SYNC_METRIC = "SyncFailure"

# Logical-name -> resolver env-var override name (the resolver reads these).
TABLE_LOGICAL = {
    "authority-units": "AUTHORITY_UNITS_TABLE",
    "composition-contracts": "COMPOSITION_CONTRACTS_TABLE",
    "constitutional-layers": "CONSTITUTIONAL_LAYERS_TABLE",
    "case-law": "CASE_LAW_TABLE",
    "governance-ledger": "GOVERNANCE_LEDGER_TABLE",
    "governance-graph-snapshots": "GRAPH_SNAPSHOTS_TABLE",
    "data-stores": "DATASTORES_TABLE",
    "integrations": "INTEGRATIONS_TABLE",
}

# Logical-name -> camel/Pascal tokens that may appear in a stack's
# LogicalResourceId for the corresponding DynamoDB table. Used by CloudFormation
# discovery to resolve tables that are NOT emitted as CFN Outputs (the five
# governance tables + the graph-snapshots table live in citadel-arbiter-<env>
# and are discoverable only via stack RESOURCES).
TABLE_RESOURCE_TOKENS = {
    "authority-units": ("AuthorityUnits",),
    "composition-contracts": ("CompositionContracts",),
    "constitutional-layers": ("ConstitutionalLayers",),
    "case-law": ("CaseLaw",),
    "governance-ledger": ("GovernanceLedger",),
    "governance-graph-snapshots": ("GraphSnapshots", "GovernanceGraphSnapshots"),
    "data-stores": ("DataStore",),
    "integrations": ("Integration",),
}

# Physical-name convention override where the real table name differs from the
# naive citadel-<logical>-<env> pattern. The DataStores table is
# 'citadel-datastores-<env>' (NO hyphen) per backend/lib/backend-stack.ts
# (DataStoresTable) — so the naive convention citadel-data-stores-<env> would be
# WRONG. Discovery is authoritative; this only affects the last-resort fallback.
CONVENTION_PHYSICAL = {
    "data-stores": "citadel-datastores-{env}",
}

DECISIONS = ("permit", "deny", "escalate", "halt")
DOMAINS = ("payment", "fraud", "data", "*")
AGENTS = (
    "arbiter",
    "payments-agent",
    "fraud-agent",
    "data-agent",
    "orchestrator",
    "ledger-agent",
)
# Reason tokens covering every tracer terminal step.
BASE_REASONS = (
    "scope_match",
    "deferred_authority",
    "unilateral_sovereignty",
    "rivalrous_claim",
    "collaborative_composition",
    "residual_authority_denial",
    "covering_unit_not_found",
    "workload_identity_mismatch",
    "constitutional_review",
)
D4_SCOPES = ("worker-pre-filter", "worker-tool-handler")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now() -> float:
    return time.time()


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _to_ddb(value: Any) -> Any:
    """Recursively make a value DynamoDB-resource-safe (floats -> Decimal)."""
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        # Round-trip through str to avoid binary-float artefacts in Decimal.
        return Decimal(str(value))
    if isinstance(value, int):
        return value
    if isinstance(value, dict):
        return {k: _to_ddb(v) for k, v in value.items() if v is not None}
    if isinstance(value, (list, tuple)):
        return [_to_ddb(v) for v in value if v is not None]
    return value


class Counter:
    """Per-section write tally used by the final summary."""

    def __init__(self) -> None:
        self.written: dict[str, int] = {}
        self.errors: dict[str, str] = {}

    def add(self, section: str, n: int) -> None:
        self.written[section] = self.written.get(section, 0) + n

    def fail(self, section: str, msg: str) -> None:
        self.errors[section] = msg


# ---------------------------------------------------------------------------
# Seeder
# ---------------------------------------------------------------------------


class GovernanceDemoSeeder:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.env = args.env
        self.region = args.region
        self.dry_run: bool = args.dry_run
        self.rng = random.Random(args.seed)
        self.counter = Counter()
        # account/registry are resolved by resolve_all() (discovery or fallback);
        # leave unset here so we can distinguish "user override" from "unresolved".
        self.account: str | None = args.account
        self.registry_id: str | None = args.registry_id
        self.event_bus_name: str | None = None
        # Discovery results + provenance.
        self.discovered_tables: dict[str, str] = {}
        self.sources: dict[str, str] = {}
        self.selected_stacks: list[str] = []
        self._discovery_ran = False
        self._clients: dict[str, Any] = {}
        # Deterministic ids reused across sections (graph snapshots embed units).
        self.unit_ids: list[str] = []
        self.contract_ids: list[str] = []
        self.layer_ids: list[str] = []
        self.case_ids: list[str] = []
        self.datastore_id = f"{DEMO_ID_PREFIX}ds-payments-pg"

    # -- AWS client/resource factory (lazy; never called in dry-run) --------

    def _client(self, service: str) -> Any:
        if service not in self._clients:
            import boto3  # lazy import so --help/--dry-run never need boto3

            self._clients[service] = boto3.client(service, region_name=self.region)
        return self._clients[service]

    def _resource(self, service: str) -> Any:
        key = f"resource:{service}"
        if key not in self._clients:
            import boto3

            self._clients[key] = boto3.resource(service, region_name=self.region)
        return self._clients[key]

    def resolve_account(self) -> None:
        """STS-resolve the account when CloudFormation discovery did not run.

        Honoured precedence: --account override > STS. In dry-run with no
        override this performs NO AWS call (placeholder applied later by
        _finalize_resolution)."""
        if self.args.account:
            self.account = self.args.account
            self.sources["account"] = "cli-override"
            return
        if self.dry_run:
            return  # no AWS in plain dry-run; placeholder applied in _finalize_resolution
        try:
            self.account = self._client("sts").get_caller_identity()["Account"]
            self.sources["account"] = "sts"
        except Exception as exc:  # noqa: BLE001
            print(f"  WARNING: sts get_caller_identity failed: {exc}")

    # -- Table name resolution ---------------------------------------------

    def _convention_name(self, logical: str) -> str:
        return CONVENTION_PHYSICAL.get(logical, "citadel-{logical}-{env}").format(
            logical=logical, env=self.env)

    def table_name(self, logical: str) -> str:
        """Resolve a table name.

        Precedence: --table-* override > matching env var > DISCOVERED (cfn) >
        convention citadel-<logical>-<env> (with an explicit WARNING that
        discovery did not find / was not run). Provenance is recorded once in
        self.sources under the key 'table:<logical>'."""
        skey = f"table:{logical}"
        cli_attr = f"table_{logical.replace('-', '_')}"
        override = getattr(self.args, cli_attr, None)
        if override:
            self.sources[skey] = "cli-override"
            return override
        env_var = TABLE_LOGICAL.get(logical)
        if env_var and os.environ.get(env_var):
            self.sources[skey] = "env"
            return os.environ[env_var]
        disc = self.discovered_tables.get(logical)
        if disc:
            self.sources[skey] = "cfn-resource"
            return disc
        conv = self._convention_name(logical)
        if self.sources.get(skey) != "convention-fallback":
            reason = "discovery did not find it" if self._discovery_ran \
                else "discovery skipped"
            print(f"  WARNING: table '{logical}' resolved by convention "
                  f"'{conv}' ({reason})")
            self.sources[skey] = "convention-fallback"
        return conv

    # -- CloudFormation discovery ------------------------------------------

    def _should_discover(self) -> bool:
        """Discovery runs by default for real runs; in --dry-run it is skipped
        unless --discover (or the deprecated --cfn-lookup alias) is given.
        --no-discover always disables it."""
        if self.args.no_discover:
            return False
        if self.dry_run:
            return bool(self.args.discover or self.args.cfn_lookup)
        return True

    def _select_stacks(self, cfn: Any) -> tuple[list[str], dict[str, str]]:
        """Return (selected stack names, aggregated Outputs key->value)."""
        prefix = self.args.stack_prefix
        env = self.env
        name_re = re.compile(rf"^{re.escape(prefix)}-.*-{re.escape(env)}$")
        selected: list[str] = []
        outputs: dict[str, str] = {}
        for page in cfn.get_paginator("describe_stacks").paginate():
            for st in page.get("Stacks", []):
                sn = st.get("StackName", "")
                status = st.get("StackStatus", "")
                if status.startswith("DELETE_") or status == "REVIEW_IN_PROGRESS":
                    continue
                if name_re.match(sn) or sn.endswith(f"-{env}"):
                    selected.append(sn)
                    for o in st.get("Outputs", []) or []:
                        outputs[o.get("OutputKey", "")] = o.get("OutputValue", "")
        return selected, outputs

    def _match_table(self, logical: str,
                     all_tables: list[tuple[str, str]]) -> str | None:
        """Resolve one logical table from discovered (LogicalId, Physical) pairs.

        Match priority: physical EQUALS citadel-<logical>-<env> OR endsWith
        '<logical>-<env>'; else LogicalResourceId contains a known camel/Pascal
        token (e.g. AuthorityUnits, CaseLaw, DataStore, Integration)."""
        want_eq = f"citadel-{logical}-{self.env}"
        want_suffix = f"{logical}-{self.env}"
        for _lid, phys in all_tables:
            if phys and (phys == want_eq or phys.endswith(want_suffix)):
                return phys
        tokens = TABLE_RESOURCE_TOKENS.get(logical, ())
        for lid, phys in all_tables:
            if phys and any(tok in lid for tok in tokens):
                return phys
        return None

    def discover(self) -> None:
        """Discover account/region/registry/eventbus/tables from the deployed
        Citadel CloudFormation stacks. Never raises — logs and continues so a
        partial discovery still falls back cleanly per-resource."""
        self._discovery_ran = True
        # account — STS is authoritative (overridden only by --account).
        if self.args.account:
            self.account = self.args.account
            self.sources["account"] = "cli-override"
        else:
            try:
                self.account = self._client("sts").get_caller_identity()["Account"]
                self.sources["account"] = "sts"
            except Exception as exc:  # noqa: BLE001
                print(f"  WARNING: sts get_caller_identity failed: {exc}")
        # region — from the boto3 session / --region.
        self.sources.setdefault(
            "region", "cli-override" if self.args.region != DEFAULT_REGION else "default")

        cfn = self._client("cloudformation")
        try:
            self.selected_stacks, outputs = self._select_stacks(cfn)
        except Exception as exc:  # noqa: BLE001
            print(f"  WARNING: describe_stacks failed: {exc}")
            self.selected_stacks, outputs = [], {}
        print(f"  selected stacks ({len(self.selected_stacks)}): "
              f"{', '.join(self.selected_stacks) or '(none)'}")

        # registryId — Output containing 'AgentCoreRegistryId', else parse an
        # AgentCore ARN output.
        if self.args.registry_id:
            self.registry_id = self.args.registry_id
            self.sources["registryId"] = "cli-override"
        else:
            reg = next((v for k, v in outputs.items()
                        if "AgentCoreRegistryId" in k), None)
            if not reg:
                arn = next((v for k, v in outputs.items()
                            if "AgentCoreRegistry" in k and ":registry/" in (v or "")),
                           None)
                if arn:
                    reg = arn.split(":registry/")[-1]
                    self.sources["registryId"] = "cfn-resource"
            elif reg:
                self.sources["registryId"] = "cfn-output"
            if reg:
                self.registry_id = reg

        # eventBusName — direct Output.
        ebn = outputs.get("EventBusName")
        if ebn:
            self.event_bus_name = ebn
            self.sources["eventBusName"] = "cfn-output"

        # DynamoDB tables — aggregate resources across every selected stack.
        all_tables: list[tuple[str, str]] = []
        for sn in self.selected_stacks:
            try:
                for page in cfn.get_paginator("list_stack_resources").paginate(
                        StackName=sn):
                    for r in page.get("StackResourceSummaries", []):
                        if r.get("ResourceType") == "AWS::DynamoDB::Table":
                            all_tables.append((r.get("LogicalResourceId", ""),
                                               r.get("PhysicalResourceId", "")))
            except Exception as exc:  # noqa: BLE001
                print(f"  WARNING: list_stack_resources({sn}) failed: {exc}")
        for logical in TABLE_LOGICAL:
            phys = self._match_table(logical, all_tables)
            if phys:
                self.discovered_tables[logical] = phys

    def _finalize_resolution(self) -> None:
        """Finalise account/registry resolution with NO baked-in literals.

        Account precedence: --account > STS (already attempted above). If still
        unresolved: on a real run leave it None so main() fails fast; in dry-run
        use the obviously-fake PLACEHOLDER_ACCOUNT purely for preview ARNs.
        Registry precedence: --registry-id > CFN discovery. If unresolved, WARN
        and continue (authority units use the '*GLOBAL*' sentinel, not the real
        registry id); preview uses PLACEHOLDER_REGISTRY in dry-run."""
        if self.args.account:
            self.account = self.args.account
            self.sources["account"] = "cli-override"
        if not self.account:
            if self.dry_run:
                self.account = PLACEHOLDER_ACCOUNT
                self.sources["account"] = "unresolved (dry-run)"
            else:
                # Leave None: main() detects this and fails fast. No literal.
                self.sources["account"] = "UNRESOLVED"
        if not self.registry_id:
            if self.args.registry_id:
                self.registry_id = self.args.registry_id
                self.sources["registryId"] = "cli-override"
            elif self.dry_run:
                print("  WARNING: registryId not discovered; using preview "
                      "placeholder (dry-run only)")
                self.registry_id = PLACEHOLDER_REGISTRY
                self.sources["registryId"] = "unresolved (dry-run)"
            else:
                print("  WARNING: registryId not discovered and no --registry-id "
                      "supplied; continuing ('*GLOBAL*' sentinel bypasses it)")
                self.sources["registryId"] = "UNRESOLVED"
        self.sources.setdefault(
            "region", "cli-override" if self.args.region != DEFAULT_REGION else "default")

    def resolve_all(self) -> None:
        """Resolve every AWS resource BEFORE seeding: run discovery (or skip it),
        apply fallbacks, tag every table's provenance, and print the report."""
        if self._should_discover():
            print("--- cloudformation discovery ---")
            self.discover()
        else:
            if self.dry_run:
                print("--- discovery skipped (dry-run; use --discover to preview "
                      "resolved names; NO AWS calls now) ---")
            else:
                print("--- discovery disabled (--no-discover) ---")
            self.resolve_account()
        self._finalize_resolution()
        # Force-resolve every table now so provenance is complete for the report
        # (also surfaces convention-fallback warnings up-front).
        for logical in TABLE_LOGICAL:
            self.table_name(logical)
        self.print_discovery_report()

    def print_discovery_report(self) -> None:
        print("\n" + "=" * 72)
        print("DISCOVERY REPORT — resolved AWS resources and their source")
        print("=" * 72)
        print(f"{'RESOURCE':<34}{'VALUE':<40}SOURCE")
        scalar = [
            ("account", self.account or "UNRESOLVED"),
            ("region", self.region),
            ("registryId", self.registry_id),
            ("eventBusName", self.event_bus_name or "(not resolved)"),
        ]
        for name, val in scalar:
            print(f"{name:<34}{str(val):<40}{self.sources.get(name, '?')}")
        for logical in TABLE_LOGICAL:
            val = self.table_name(logical)
            print(f"{('table:' + logical):<34}{val:<40}"
                  f"{self.sources.get('table:' + logical, '?')}")
        print("  NOTE: governance tables are discovered via stack RESOURCES "
              "(they are NOT CFN Outputs).")

    def ssm_key(self, suffix: str) -> str:
        return f"/citadel/governance/{suffix}/{self.env}"

    # -- Low-level write wrappers ------------------------------------------

    def _put_item(self, logical: str, item: dict) -> None:
        item = {**item, DEMO_MARKER_ATTR: DEMO_MARKER_VALUE}
        name = self.table_name(logical)
        if self.dry_run:
            print(f"  [dry-run] put_item {name}: {item.get('PK','')}"
                  f"{list(item.keys())[:1]} -> "
                  f"{item.get('unitId') or item.get('contractId') or item.get('layerId') or item.get('entryId') or item.get('findingId') or item.get('snapshotId') or item.get('dataStoreId') or item.get('integrationId')}")
            return
        table = self._resource("dynamodb").Table(name)
        table.put_item(Item=_to_ddb(item))

    def _put_param(self, suffix: str, value: str, overwrite: bool = True) -> None:
        key = self.ssm_key(suffix)
        if self.dry_run:
            print(f"  [dry-run] put_parameter {key} = {value[:80]}")
            return
        self._client("ssm").put_parameter(
            Name=key, Value=value, Type="String", Overwrite=overwrite,
            Tags=[] if overwrite else [{"Key": DEMO_TAG_KEY, "Value": DEMO_TAG_VALUE}],
        )

    # -- Section: authority units ------------------------------------------

    def seed_authority_units(self) -> None:
        # data-1/data-2: every unit carries a non-null registryId. '*GLOBAL*'
        # is the platform-wide sentinel that should bypass live registry
        # resolution.
        specs = [
            ("payments-agent", "invoke_agent", "payment", "low"),
            ("fraud-agent", "execute_tool", "fraud", "medium"),
            ("data-agent", "execute_tool", "data", "high"),
            ("orchestrator", "create_agent", "*", "medium"),
            ("ledger-agent", "invoke_agent", "*", "low"),
        ]
        n = 0
        for i, (agent, dtype, domain, risk) in enumerate(specs):
            uid = f"{DEMO_ID_PREFIX}unit-{i:02d}"
            self.unit_ids.append(uid)
            self._put_item("authority-units", {
                "unitId": uid,
                "agentId": agent,
                "scope": {
                    "decision_type": dtype,
                    "domain": domain,
                    "conditions": {},
                    "limits": {"amount": 100000} if domain == "payment" else {},
                },
                "delegationSource": None if i == 0 else self.unit_ids[0],
                "canRedelegate": i == 0,
                "expiryTimestamp": _now() + 30 * 86400,
                "revoked": False,
                "riskRating": risk,
                "registryId": "*GLOBAL*",  # data-1/data-2 bypass
            })
            n += 1
        self.counter.add("authority-units", n)

    # -- Section: composition contracts ------------------------------------

    def seed_composition_contracts(self) -> None:
        specs = [
            ("payments-agent", "fraud-agent", "partyB", "halt_and_escalate"),
            ("data-agent", "orchestrator", "none", "default_deny"),
        ]
        n = 0
        for i, (a, b, prec, conf) in enumerate(specs):
            cid = f"{DEMO_ID_PREFIX}contract-{i:02d}"
            self.contract_ids.append(cid)
            self._put_item("composition-contracts", {
                "contractId": cid,
                "partyA": a,
                "partyB": b,
                "authorityPrecedence": prec,
                "conflictResolution": conf,
                "invariants": ["no_double_spend", "audit_trail_required"],
                "stopRights": [b],
                "scope": {"decision_type": "*", "domain": "*"},
                "escalationPath": f"arn:aws:sns:{self.region}:{self.account}:citadel-governance-escalations-{self.env}",
            })
            n += 1
        self.counter.add("composition-contracts", n)

    # -- Section: constitutional layers ------------------------------------

    def seed_constitutional_layers(self) -> None:
        specs = [
            ("global", ["*"], [{"field": "decision", "operator": "neq", "value": "halt"}], None),
            ("domain", ["payment"], [{"field": "amount", "operator": "lt", "value": 1000000}], None),
            ("pairwise", ["payments-agent", "fraud-agent"],
             [{"field": "requesting_agent", "operator": "exists", "value": ""}], None),
        ]
        n = 0
        for i, (ltype, applies, rules, parent) in enumerate(specs):
            lid = f"{DEMO_ID_PREFIX}layer-{i:02d}"
            self.layer_ids.append(lid)
            self._put_item("constitutional-layers", {
                "layerId": lid,
                "layerType": ltype,
                "appliesTo": applies,
                "rules": rules,
                "parentLayerId": parent or (self.layer_ids[0] if i > 0 else None),
            })
            n += 1
        self.counter.add("constitutional-layers", n)

    # -- Section: case law --------------------------------------------------

    def seed_case_law(self) -> None:
        now = datetime.now(timezone.utc)
        # Precedence collisions (two entries at precedence 10) + a revoked row.
        specs = [
            ("payments-agent", "fraud-agent", "deny", 10, False),
            ("data-agent", "orchestrator", "escalate", 10, False),   # collision
            ("ledger-agent", "payments-agent", "permit", 5, False),
            ("fraud-agent", "data-agent", "halt", 20, True),          # revoked
        ]
        n = 0
        for i, (agent, target, res, prec, revoked) in enumerate(specs):
            eid = f"{DEMO_ID_PREFIX}case-{i:02d}"
            self.case_ids.append(eid)
            item = {
                "entryId": eid,
                "pattern": {"agent": agent, "target": target},
                "resolution": res,
                "createdAt": _iso(now - timedelta(days=10 + i)),
                "createdBy": "operator@workshop.demo",
                "scopeOfApplicability": {"domain": DOMAINS[i % len(DOMAINS)]},
                "precedence": prec,
                "revoked": revoked,
            }
            if revoked:
                item["revokedAt"] = _iso(now - timedelta(days=1))
            self._put_item("case-law", item)
            n += 1
        self.counter.add("case-law", n)

    # -- Section: ledger findings ------------------------------------------

    def _finding_item(self, *, decision: str, reason: str, domain: str,
                      requesting: str, target: str, ts: float,
                      workflow: str, scope_eval: str | None = None,
                      contract_eval: str | None = None,
                      escalation_target: str | None = None) -> dict:
        fid = f"{DEMO_ID_PREFIX}finding-{int(ts*1000)}-{self.rng.randint(1000,9999)}"
        residual = reason == "residual_authority_denial"
        item: dict[str, Any] = {
            "findingId": fid,
            "finding_id": fid,
            "workflowId": workflow,
            "workflow_id": workflow,
            "decision": decision,
            "reason": reason,
            "requesting_agent": requesting,
            "target_agent": target,
            "domain": domain,
            "timestamp": float(ts),
            "ttl": float(ts) + 90 * 86400,
            "residual_authority_denial": residual,
        }
        if scope_eval:
            item["scope_evaluated"] = scope_eval
        if contract_eval:
            item["contract_evaluated"] = contract_eval
        if escalation_target:
            item["escalation_target"] = escalation_target
        return item

    def seed_ledger_findings(self) -> None:
        """Realistic ~9-day distribution + a recent (last-60s) burst.

        Constraints baked in for the readiness checks:
        * tel-1: oldest deny/escalate is 8-9 days old.
        * tel-2: >=100 findings in the last 24h with <0.5% deny/escalate rate
                 (the resolver counts deny+escalate as the mismatch numerator),
                 so the recent window is essentially all permits.
        """
        name = self.table_name("governance-ledger")
        now = _now()
        items: list[dict] = []

        # --- Aged window: days 9 .. 1 ago. Mixed decisions for the heatmap,
        #     tracer terminal steps, D4 scopes, and tel-1 (>=7d old deny).
        for day in range(9, 1, -1):
            day_base = now - day * 86400
            count = self.rng.randint(20, 40)
            for _ in range(count):
                # Time-of-day hotspots: cluster warn/deny around UTC 09:00 & 17:00.
                hot = self.rng.random() < 0.5
                hour = self.rng.choice([9, 17]) if hot else self.rng.randint(0, 23)
                ts = day_base + hour * 3600 + self.rng.randint(0, 3599)
                if hot:
                    decision = self.rng.choice(["deny", "escalate", "deny", "halt"])
                    reason = self.rng.choice([
                        "residual_authority_denial", "covering_unit_not_found",
                        "rivalrous_claim", "workload_identity_mismatch",
                    ])
                else:
                    decision = "permit" if self.rng.random() < 0.8 else \
                        self.rng.choice(["deny", "escalate"])
                    reason = self.rng.choice(BASE_REASONS)
                domain = self.rng.choice(DOMAINS)
                requesting = self.rng.choice(AGENTS)
                target = self.rng.choice(AGENTS)
                workflow = f"{DEMO_ID_PREFIX}wf-{self.rng.randint(1, 12):02d}"
                scope_eval = None
                contract_eval = None
                # D4: tag deny scope. Build deliberate overlap of workflow|reason.
                if decision == "deny":
                    scope_eval = self.rng.choice(D4_SCOPES)
                # Cross-reference graph entities so Tracer/Constitution have data.
                if self.rng.random() < 0.25 and self.unit_ids:
                    scope_eval = self.rng.choice(self.unit_ids)
                if self.rng.random() < 0.2 and self.contract_ids:
                    contract_eval = self.rng.choice(self.contract_ids)
                if reason == "constitutional_review" and self.layer_ids:
                    reason = f"constitutional_override:{self.rng.choice(self.layer_ids)}"
                if reason == "case_law" or self.rng.random() < 0.08:
                    reason = f"case_law:{self.rng.choice(self.case_ids)}" if self.case_ids else reason
                esc = None
                if decision == "escalate":
                    esc = f"arn:aws:sns:{self.region}:{self.account}:citadel-governance-escalations-{self.env}"
                items.append(self._finding_item(
                    decision=decision, reason=reason, domain=domain,
                    requesting=requesting, target=target, ts=ts,
                    workflow=workflow, scope_eval=scope_eval,
                    contract_eval=contract_eval, escalation_target=esc))

        # --- D4 overlap guarantee: same workflow|reason pair in BOTH scopes,
        #     plus a pair unique to each scope (all aged so they don't hit 24h).
        aged_ts = now - 3 * 86400
        shared_wf = f"{DEMO_ID_PREFIX}wf-d4-shared"
        for scope in D4_SCOPES:
            items.append(self._finding_item(
                decision="deny", reason="covering_unit_not_found", domain="payment",
                requesting="payments-agent", target="fraud-agent",
                ts=aged_ts + self.rng.randint(0, 3600), workflow=shared_wf,
                scope_eval=scope))
        items.append(self._finding_item(
            decision="deny", reason="rivalrous_claim", domain="fraud",
            requesting="fraud-agent", target="data-agent", ts=aged_ts,
            workflow=f"{DEMO_ID_PREFIX}wf-d4-pre", scope_eval="worker-pre-filter"))
        items.append(self._finding_item(
            decision="deny", reason="workload_identity_mismatch", domain="data",
            requesting="data-agent", target="ledger-agent", ts=aged_ts,
            workflow=f"{DEMO_ID_PREFIX}wf-d4-tool", scope_eval="worker-tool-handler"))

        # --- tel-1 anchor: an explicit deny dated 8.5 days ago.
        items.append(self._finding_item(
            decision="deny", reason="residual_authority_denial", domain="payment",
            requesting="payments-agent", target="fraud-agent",
            ts=now - int(8.5 * 86400), workflow=f"{DEMO_ID_PREFIX}wf-tel1",
            scope_eval=self.unit_ids[0] if self.unit_ids else "worker-pre-filter"))

        # --- tel-2 window: ~200 findings in the last 24h, all permit except
        #     exactly ONE deny (rate = 1/201 ~= 0.50% boundary -> keep at 0).
        for i in range(200):
            ts = now - self.rng.randint(60, 86000)
            items.append(self._finding_item(
                decision="permit", reason="scope_match",
                domain=self.rng.choice(DOMAINS),
                requesting=self.rng.choice(AGENTS), target=self.rng.choice(AGENTS),
                ts=ts, workflow=f"{DEMO_ID_PREFIX}wf-{self.rng.randint(1,12):02d}",
                scope_eval=self.rng.choice(self.unit_ids) if self.unit_ids else None))

        # --- Tracer time-machine: a handful with last-60s timestamps (permits
        #     so they do not disturb the tel-2 mismatch rate).
        for i in range(5):
            ts = now - self.rng.randint(0, 59)
            items.append(self._finding_item(
                decision="permit", reason="collaborative_composition",
                domain="payment", requesting="arbiter", target="payments-agent",
                ts=ts, workflow=f"{DEMO_ID_PREFIX}wf-live",
                scope_eval=self.unit_ids[0] if self.unit_ids else None,
                contract_eval=self.contract_ids[0] if self.contract_ids else None))

        if self.dry_run:
            print(f"  [dry-run] batch_write {len(items)} findings -> {name}")
            self.counter.add("ledger-findings", len(items))
            return
        table = self._resource("dynamodb").Table(name)
        with table.batch_writer() as batch:
            for it in items:
                batch.put_item(Item=_to_ddb({**it, DEMO_MARKER_ATTR: DEMO_MARKER_VALUE}))
        self.counter.add("ledger-findings", len(items))

    # -- Section: graph snapshots ------------------------------------------

    def seed_graph_snapshots(self) -> None:
        now = _now()
        # Reconstruct lightweight projections of what we seeded.
        units = [{"unitId": u, "registryId": "*GLOBAL*"} for u in self.unit_ids]
        contracts = [{"contractId": c} for c in self.contract_ids]
        layers = [{"layerId": lid} for lid in self.layer_ids]
        cases = [{"entryId": e} for e in self.case_ids]
        n = 0
        # 2-3 snapshots spaced over time for the time-scrubber.
        for i, days_ago in enumerate((5, 2, 0)):
            ts = now - days_ago * 86400
            sid = f"{DEMO_ID_PREFIX}snap-{i:02d}"
            self._put_item("governance-graph-snapshots", {
                "snapshotId": sid,
                "timestamp": float(ts),
                "kind": "full",
                "expiresAt": float(ts) + 30 * 86400,
                "env": self.env,
                "authorityUnits": units[: max(1, len(units) - i)],
                "compositionContracts": contracts,
                "constitutionalLayers": layers,
                "caseLaw": cases,
                "truncated": {
                    "authorityUnits": False,
                    "compositionContracts": False,
                    "constitutionalLayers": False,
                    "caseLaw": False,
                },
            })
            n += 1
        self.counter.add("graph-snapshots", n)

    # -- Section: CloudWatch metrics ---------------------------------------

    def seed_cloudwatch_metrics(self) -> None:
        if self.args.skip_cloudwatch:
            print("  (skipped: --skip-cloudwatch)")
            return
        now = datetime.now(timezone.utc)
        # OffFrontierEscalations: hourly-ish points over 7 days with spikes.
        esc_data = []
        for hours_ago in range(0, 7 * 24, 4):
            t = now - timedelta(hours=hours_ago)
            base = self.rng.randint(0, 3)
            spike = self.rng.choice([0, 0, 0, 12, 25]) if hours_ago % 24 < 4 else 0
            esc_data.append({
                "MetricName": ESCALATION_METRIC,
                "Timestamp": t,
                "Value": float(base + spike),
                "Unit": "Count",
            })
        # tel-3: emit explicit zeros for SyncFailure over 48h (PASS).
        sync_data = []
        for hours_ago in range(0, 48, 6):
            sync_data.append({
                "MetricName": SYNC_METRIC,
                "Timestamp": now - timedelta(hours=hours_ago),
                "Value": 0.0,
                "Unit": "Count",
            })
        if self.dry_run:
            print(f"  [dry-run] put_metric_data {ESCALATION_NAMESPACE}/"
                  f"{ESCALATION_METRIC}: {len(esc_data)} datapoints (with spikes)")
            print(f"  [dry-run] put_metric_data {SYNC_NAMESPACE}/{SYNC_METRIC}: "
                  f"{len(sync_data)} zero datapoints (tel-3 PASS)")
            self.counter.add("cloudwatch-metrics", len(esc_data) + len(sync_data))
            return
        cw = self._client("cloudwatch")
        for i in range(0, len(esc_data), 20):
            cw.put_metric_data(Namespace=ESCALATION_NAMESPACE,
                               MetricData=esc_data[i:i + 20])
        for i in range(0, len(sync_data), 20):
            cw.put_metric_data(Namespace=SYNC_NAMESPACE,
                               MetricData=sync_data[i:i + 20])
        self.counter.add("cloudwatch-metrics", len(esc_data) + len(sync_data))

    # -- Section: SSM state (enforce + effective_at + graph history) -------

    def seed_ssm_state(self) -> None:
        # enforce -> 'shadow' (mid-state; rb-1 PASS, participants flip to strict).
        self._put_param("enforce", "shadow")
        # effective_at -> ISO ~9 days ago.
        self._put_param("effective_at",
                        _iso(datetime.now(timezone.utc) - timedelta(days=9)))
        # authority graph history flag.
        self._put_param("authority-graph-history", json.dumps({
            "enabled": True, "retentionDays": 30, "captureMode": "both",
        }))
        self.counter.add("ssm-state", 3)

    # -- Section: reconciler status ----------------------------------------

    def seed_reconciler_status(self) -> None:
        blob = {
            "lastRunAt": _iso(datetime.now(timezone.utc) - timedelta(hours=2)),
            "lastRunMode": "shadow",
            "classifications": {
                "inSync": 182, "missing": 4, "stale": 7, "orphan": 2,
            },
            "totalRecords": 195,
        }
        self._put_param("reconciler/last_status", json.dumps(blob))
        self.counter.add("reconciler-status", 1)

    # -- Section: manual verifications (own-1/2/3) -------------------------

    def seed_manual_verifications(self) -> None:
        future = datetime.now(timezone.utc) + timedelta(days=14)
        verified = datetime.now(timezone.utc) - timedelta(days=1)
        notes = {
            "own-1": "Rollback owner + on-call confirmed for soak window.",
            "own-2": "Stakeholder comms plan signed off.",
            "own-3": "Change ticket documents trigger conditions.",
        }
        n = 0
        for own, note in notes.items():
            blob = {
                "verifiedAt": _iso(verified),
                "verifiedBy": "operator@workshop.demo",
                "expiresAt": _iso(future),
                "note": note,
            }
            self._put_param(f"readiness/manual/{own}", json.dumps(blob))
            n += 1
        self.counter.add("manual-verifications", n)

    # -- Section: rb-2 history (transition to permissive) ------------------

    def seed_rb2_history(self) -> None:
        """Exercise the SSM parameter HISTORY so rb-2 sees a recent transition
        to 'permissive'. The resolver walks history pairwise looking for a
        prev!=permissive -> permissive change within 7 days. Sequence:
        strict -> permissive -> shadow leaves >=3 history entries with the
        qualifying transition in the middle."""
        for value in ("strict", "permissive", "shadow"):
            self._put_param("enforce", value)
            if not self.dry_run:
                time.sleep(0.05)  # ensure distinct LastModifiedDate ordering
        self.counter.add("rb2-history", 3)

    # -- Section: demo resources (datastore + integration) -----------------

    def seed_demo_resources(self) -> None:
        # Datastore record so the IAM trust-path resource picker resolves.
        self._put_item("data-stores", {
            "dataStoreId": self.datastore_id,
            "orgId": f"{DEMO_ID_PREFIX}org-workshop",
            "name": "Workshop Payments Postgres",
            "type": "POSTGRES",
            "category": "DATABASE",
            "usage": "BOTH",
            "status": "CONNECTED",
            "scopedRoleArn": f"arn:aws:iam::{self.account}:role/citadel-ds-{self.datastore_id}",
        })
        # Integration record (GSI IntegrationIdIndex/integrationId).
        self._put_item("integrations", {
            "integrationId": f"{DEMO_ID_PREFIX}int-confluence",
            "orgId": f"{DEMO_ID_PREFIX}org-workshop",
            "name": "Workshop Confluence",
            "type": "CONFLUENCE",
            "status": "CONNECTED",
        })
        self.counter.add("demo-resources", 2)

    # -- Section: IAM trust path -------------------------------------------

    def seed_iam_trust_path(self) -> None:
        if not self.args.with_iam:
            print("  (skipped: --no-iam)")
            return
        role_name = f"citadel-ds-{self.datastore_id}"
        role_arn = f"arn:aws:iam::{self.account}:role/{role_name}"
        assume = {
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Principal": {"AWS": f"arn:aws:iam::{self.account}:root"},
                "Action": "sts:AssumeRole",
            }],
        }
        # Deliberate SUPERSET of a POSTGRES adapter's requiredPolicies().connect
        # (secretsmanager:GetSecretValue + ssm:GetParameter) to trip the drift
        # detector by adding broad extra actions.
        policy = {
            "Version": "2012-10-17",
            "Statement": [{
                "Sid": "DataStoreAccessSuperset",
                "Effect": "Allow",
                "Action": [
                    "secretsmanager:GetSecretValue",
                    "ssm:GetParameter",
                    "ssm:GetParameters",          # drift: extra
                    "secretsmanager:DescribeSecret",  # drift: extra
                    "rds-db:connect",             # drift: extra
                ],
                "Resource": "*",
            }],
        }
        if self.dry_run:
            print(f"  [dry-run] create_role {role_name} (+inline DataStoreAccess, "
                  f"SUPERSET to trigger drift)")
            print(f"  [dry-run] role ARN: {role_arn}")
            self.counter.add("iam-roles", 1)
            return
        iam = self._client("iam")
        try:
            iam.create_role(
                RoleName=role_name,
                AssumeRolePolicyDocument=json.dumps(assume),
                Description="WORKSHOP demo scoped datastore role (drift sample).",
                Tags=[{"Key": DEMO_TAG_KEY, "Value": DEMO_TAG_VALUE}],
            )
        except iam.exceptions.EntityAlreadyExistsException:
            print(f"  role {role_name} already exists (idempotent)")
        iam.put_role_policy(
            RoleName=role_name, PolicyName="DataStoreAccess",
            PolicyDocument=json.dumps(policy),
        )
        print(f"  created/updated role ARN: {role_arn}")
        self.counter.add("iam-roles", 1)

    # -- Purge --------------------------------------------------------------

    def purge(self) -> None:
        print("=== PURGE: removing demoDataset='workshop-governance' records ===")
        self._purge_table("authority-units", "unitId")
        self._purge_table("composition-contracts", "contractId")
        self._purge_table("constitutional-layers", "layerId")
        self._purge_table("case-law", "entryId")
        self._purge_table("governance-ledger", "findingId")
        self._purge_table("governance-graph-snapshots", "snapshotId", sk="timestamp")
        self._purge_table("data-stores", "dataStoreId")
        self._purge_table("integrations", "integrationId")
        self._purge_ssm()
        self._purge_iam()
        print("  NOTE: CloudWatch datapoints cannot be deleted; they expire "
              "via metric retention.")

    def _purge_table(self, logical: str, pk: str, sk: str | None = None) -> None:
        name = self.table_name(logical)
        if self.dry_run:
            print(f"  [dry-run] scan+delete demo items from {name} (pk={pk})")
            return
        try:
            table = self._resource("dynamodb").Table(name)
            scanned = 0
            kwargs: dict[str, Any] = {
                "FilterExpression": "#m = :v",
                "ExpressionAttributeNames": {"#m": DEMO_MARKER_ATTR},
                "ExpressionAttributeValues": {":v": DEMO_MARKER_VALUE},
            }
            while True:
                resp = table.scan(**kwargs)
                with table.batch_writer() as batch:
                    for it in resp.get("Items", []):
                        key = {pk: it[pk]}
                        if sk:
                            key[sk] = it[sk]
                        batch.delete_item(Key=key)
                        scanned += 1
                lek = resp.get("LastEvaluatedKey")
                if not lek:
                    break
                kwargs["ExclusiveStartKey"] = lek
            print(f"  purged {scanned} items from {name}")
        except Exception as exc:  # noqa: BLE001
            print(f"  ERROR purging {name}: {exc}")

    def _purge_ssm(self) -> None:
        keys = [self.ssm_key(s) for s in (
            "enforce", "effective_at", "reconciler/last_status",
            "authority-graph-history", "readiness/manual/own-1",
            "readiness/manual/own-2", "readiness/manual/own-3",
        )]
        if self.dry_run:
            print(f"  [dry-run] delete SSM params: {keys}")
            return
        ssm = self._client("ssm")
        for k in keys:
            try:
                ssm.delete_parameter(Name=k)
                print(f"  deleted SSM {k}")
            except Exception as exc:  # noqa: BLE001
                print(f"  (SSM {k} not deleted: {exc})")

    def _purge_iam(self) -> None:
        role_name = f"citadel-ds-{self.datastore_id}"
        if self.dry_run:
            print(f"  [dry-run] delete IAM role {role_name} (+inline policy)")
            return
        if not self.args.with_iam:
            return
        iam = self._client("iam")
        try:
            iam.delete_role_policy(RoleName=role_name, PolicyName="DataStoreAccess")
        except Exception as exc:  # noqa: BLE001
            print(f"  (inline policy not deleted: {exc})")
        try:
            iam.delete_role(RoleName=role_name)
            print(f"  deleted IAM role {role_name}")
        except Exception as exc:  # noqa: BLE001
            print(f"  (role {role_name} not deleted: {exc})")

    # -- Orchestration ------------------------------------------------------

    def run(self) -> None:
        sections: list[tuple[str, Callable[[], None]]] = [
            ("seed_authority_units", self.seed_authority_units),
            ("seed_composition_contracts", self.seed_composition_contracts),
            ("seed_constitutional_layers", self.seed_constitutional_layers),
            ("seed_case_law", self.seed_case_law),
            ("seed_ledger_findings", self.seed_ledger_findings),
            ("seed_graph_snapshots", self.seed_graph_snapshots),
            ("seed_cloudwatch_metrics", self.seed_cloudwatch_metrics),
            ("seed_ssm_state", self.seed_ssm_state),
            ("seed_reconciler_status", self.seed_reconciler_status),
            ("seed_manual_verifications", self.seed_manual_verifications),
            ("seed_rb2_history", self.seed_rb2_history),
            ("seed_demo_resources", self.seed_demo_resources),
            ("seed_iam_trust_path", self.seed_iam_trust_path),
        ]
        for label, fn in sections:
            print(f"--- {label} ---")
            try:
                fn()
            except Exception as exc:  # noqa: BLE001 — log + continue, never swallow
                msg = f"{type(exc).__name__}: {exc}"
                print(f"  ERROR in {label}: {msg}")
                traceback.print_exc()
                self.counter.fail(label, msg)

    # -- Reports ------------------------------------------------------------

    def print_summary(self) -> None:
        print("\n" + "=" * 72)
        print("DEMO DATA SUMMARY — what was written & the narrative it enables")
        print("=" * 72)
        rows = [
            ("Overview", "authority-units + contracts + layers",
             "graph node/edge counts populate the landing tiles"),
            ("Rollout + 11 checks", "ssm-state/manual/rb2/ledger/metrics",
             "all DDB/SSM-satisfiable checks green (see readiness report)"),
            ("Ledger", "ledger-findings",
             "~9 days of findings, mixed decisions, write-once records"),
            ("Mismatch heatmap", "ledger-findings",
             "UTC 09:00/17:00 deny/escalate hotspots render the heatmap"),
            ("Reconciler", "reconciler-status",
             "non-zero missing/stale/orphan classifications"),
            ("Escalations", "cloudwatch-metrics",
             "OffFrontierEscalations trend with spikes + alarm story"),
            ("Tracer", "ledger-findings",
             "reason tokens per terminal step + last-60s time-machine rows"),
            ("Authority graph", "graph-snapshots",
             "2-3 time-spaced snapshots feed the time-scrubber"),
            ("Constitution", "constitutional-layers",
             "constitutional_override:<layerId> findings drive sparklines"),
            ("Case law", "case-law",
             "precedence collisions + a revoked entry (ordering/restore)"),
            ("D4", "ledger-findings",
             "worker-pre-filter/worker-tool-handler scopes with overlap"),
            ("IAM", "demo-resources + iam-roles",
             "datastore + role + SUPERSET policy trips the drift detector"),
        ]
        print(f"{'PAGE':<22}{'WROTE (section)':<34}{'NARRATIVE'}")
        for page, section, narrative in rows:
            count = self.counter.written.get(section.split('/')[0], "")
            print(f"{page:<22}{section:<34}{narrative}")
        print("\nWrite tallies:")
        for k, v in self.counter.written.items():
            print(f"  {k:<26} {v}")
        if self.counter.errors:
            print("\nSection errors (continued past):")
            for k, v in self.counter.errors.items():
                print(f"  {k:<26} {v}")

    def print_readiness_report(self) -> None:
        print("\n" + "=" * 72)
        print("READINESS REPORT — 11 checks (expected post-seed state)")
        print("=" * 72)
        checks = [
            ("data-1", "PASS", "every authority unit has registryId='*GLOBAL*'"),
            ("data-2", "NEEDS-LIVE", "AgentCore Registry must resolve sampled "
             "registryIds; '*GLOBAL*' should bypass. If the resolver still "
             "resolves it, a real registry record is required (WARNING)."),
            ("data-3", "NEEDS-LIVE", "agents+tools must carry registryId in "
             "customDescriptorContent — lives in the Registry, NOT DDB; "
             "cannot be seeded here (guidance only)."),
            ("tel-1", "PASS", "oldest deny seeded ~8.5 days ago (>=7d)"),
            ("tel-2", "PASS", "~200 findings/24h, deny+escalate rate <0.5%"),
            ("tel-3", "PASS", "RegistrySync/SyncFailure held at zero over 48h"),
            ("rb-1", "PASS", "enforce SSM param holds a valid value ('shadow')"),
            ("rb-2", "PASS", "enforce history strict->permissive->shadow; "
             "qualifying permissive transition within 7 days"),
            ("own-1", "PASS", "manual verification blob, expiresAt +14d"),
            ("own-2", "PASS", "manual verification blob, expiresAt +14d"),
            ("own-3", "PASS", "manual verification blob, expiresAt +14d"),
        ]
        print(f"{'CHECK':<8}{'EXPECTED':<12}NOTE")
        for cid, status, note in checks:
            print(f"{cid:<8}{status:<12}{note}")
        print("\nLIVE-AWS WARNINGS:")
        print("  * data-2: if the resolver does NOT bypass '*GLOBAL*', create a "
              "real AgentCore Registry record for the sampled registryIds.")
        print("  * data-3: ensure every Registry agent/tool descriptor includes "
              "a non-empty registryId — not forceable from DynamoDB.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="demo_synthetic_data_gen",
        description="WORKSHOP-ONLY synthetic Citadel governance data generator. "
                    "Writes to real AWS governance tables/params/metrics. "
                    "NOT FOR PRODUCTION.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--env", default=DEFAULT_ENV,
                   help="Target environment (default: dev).")
    p.add_argument("--region", default=DEFAULT_REGION,
                   help="AWS region (default: us-west-2).")
    p.add_argument("--account",
                   help="AWS account id; resolved via STS if omitted.")
    p.add_argument("--registry-id", default=None,
                   help="AgentCore Registry id override (default: discovered).")
    p.add_argument("--dry-run", action="store_true",
                   help="Print every intended write; perform NONE. No AWS calls "
                        "unless --discover is also given.")
    p.add_argument("--purge", action="store_true",
                   help="Delete only records this tool created (demoDataset marker).")
    p.add_argument("--seed", type=int, default=DEFAULT_SEED,
                   help="Deterministic RNG seed (default: 42).")
    p.add_argument("--yes", action="store_true",
                   help="Skip interactive confirmation / env safety prompt.")
    p.add_argument("--skip-cloudwatch", action="store_true",
                   help="Do not write CloudWatch metrics.")
    p.add_argument("--stack-prefix", default="citadel",
                   help="Stack-name prefix for discovery (default: citadel); "
                        "matches ^<prefix>-.*-<env>$.")
    p.add_argument("--no-discover", action="store_true",
                   help="Skip CloudFormation discovery; use convention/env/"
                        "overrides only.")
    p.add_argument("--discover", action="store_true",
                   help="Force discovery even in --dry-run to preview resolved "
                        "names (the only dry path that touches AWS).")
    p.add_argument("--cfn-lookup", action="store_true",
                   help="DEPRECATED alias: discovery is on by default for real "
                        "runs; in --dry-run this forces discovery like --discover.")
    iam_grp = p.add_mutually_exclusive_group()
    iam_grp.add_argument("--with-iam", dest="with_iam", action="store_true",
                         default=True, help="Create demo IAM roles (default).")
    iam_grp.add_argument("--no-iam", dest="with_iam", action="store_false",
                         help="Skip all IAM role creation.")
    # Per-table overrides.
    for logical in TABLE_LOGICAL:
        p.add_argument(f"--table-{logical}", dest=f"table_{logical.replace('-', '_')}",
                       help=f"Override name for the {logical} table.")
    return p


def env_is_safe(env: str) -> bool:
    low = env.lower()
    if any(h in low for h in PROD_HINTS):
        return False
    return low in SAFE_ENVS


def confirm_banner(args: argparse.Namespace, account: str) -> bool:
    print("=" * 72)
    print("  CITADEL GOVERNANCE — SYNTHETIC DEMO DATA GENERATOR (WORKSHOP ONLY)")
    print("=" * 72)
    print(f"  Account : {account}")
    print(f"  Region  : {args.region}")
    print(f"  Env     : {args.env}")
    print(f"  Mode    : {'PURGE' if args.purge else 'SEED'}"
          f"{' (DRY-RUN)' if args.dry_run else ''}")
    print(f"  IAM     : {'yes' if args.with_iam else 'no'}")
    print("=" * 72)
    if args.dry_run:
        return True
    low = args.env.lower()
    if any(h in low for h in PROD_HINTS):
        print("REFUSING: environment looks production-like. Aborting.")
        return False
    if not env_is_safe(args.env) and not args.yes:
        print(f"Environment '{args.env}' is not in {sorted(SAFE_ENVS)}. "
              f"Re-run with --yes to override.")
        return False
    if args.yes:
        return True
    reply = input("Proceed with writes to the above target? [y/N] ").strip().lower()
    return reply in ("y", "yes")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    seeder = GovernanceDemoSeeder(args)

    # Resolve every AWS resource (discovery or fallbacks) BEFORE the banner so it
    # shows the real account and BEFORE any seeding/purge. In plain --dry-run this
    # never touches AWS; --dry-run --discover is the only dry path that does.
    seeder.resolve_all()
    account = seeder.account
    if not account:
        # Real run with no --account and no STS identity: never substitute a
        # literal — fail fast so the operator fixes credentials or passes --account.
        print("ERROR: Could not resolve AWS account: pass --account or ensure "
              "valid AWS credentials")
        return 2

    if not confirm_banner(args, account):
        return 1

    try:
        if args.purge:
            seeder.purge()
        else:
            seeder.run()
            seeder.print_summary()
            seeder.print_readiness_report()
    except KeyboardInterrupt:
        print("\nInterrupted.")
        return 130

    print("\nDone." + (" (dry-run — no writes performed)" if args.dry_run else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
