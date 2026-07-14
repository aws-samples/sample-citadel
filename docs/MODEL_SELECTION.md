# Configurable Model Selection

Citadel lets operators choose which Bedrock foundation model each part of the
arbiter uses — the Supervisor, the Fabricator, and the intake/extraction
agents — without editing code or redeploying. Model choices are curated in
DynamoDB against a catalog that is discovered from the live Bedrock inventory,
edited through an admin-only UI, and resolved at runtime by a pure,
dependency-free resolver that always falls back to a safe default.

The system is **data-driven**: outside of a single deployment-time seed, no
model id is hardcoded anywhere. The set of valid models lives entirely in the
catalog table, and every runtime decision is validated against it.

## Overview & purpose

- **Per-slot model choice.** Each arbiter role ("slot") — `supervisor`,
  `fabricator`, `intake_agent`, `extraction` — can be pointed at a different
  model, or left on a shared global default.
- **Operator-curated catalog.** A daily sync keeps an inventory of invokable
  foundation models current with what Bedrock exposes in the account/region.
  Operators enable, disable, or deprecate entries; only `enabled` models can be
  selected.
- **Safe by construction.** Resolution is a pure function with a bulletproof
  fallback. A missing config, a malformed catalog row, a disabled model, or any
  read failure returns the caller's previous default rather than raising —
  model configuration can never break agent dispatch.
- **Region-aware.** A chosen model is mapped to a cross-region inference profile
  appropriate to the deployment region, with an optional data-locality policy.

## Architecture & data flow

```
                    ┌───────────────────────────────────────────┐
   Bedrock APIs     │  Catalog sync (model-catalog-sync.ts)     │
   ListFoundation   │  · daily EventBridge schedule (24h)       │
   Models / Infer.  │  · on-demand via syncModelCatalog         │
   Profiles ───────▶│  discover → refresh (preserve status) →   │
                    │  deprecate models Bedrock no longer lists │
                    └───────────────────┬──────────────────────-┘
                                        │ upsert
                                        ▼
                        DynamoDB: citadel-model-catalog-{env}
                                        ▲
                     read (validate)    │    read (list)
                                        │
   Operator UI ─────────────────────────┼─────────────────────────┐
   Model Configuration page             │                         │
   updateModelConfig / setStatus        ▼                         │
                        DynamoDB: citadel-model-config-{env}      │
                                        │                         │
                                        │ read (config + catalog) │
                                        ▼                         ▼
                    Arbiter / Services runtime loaders   ─────────
                    supervisor · fabricator · intake/extraction
                                        │
                                        ▼
                    Pure resolver (model_resolver.py)
                    precedence walk → validate for slot →
                    map to inference-profile id  (else bootstrap fallback)
                                        │
                                        ▼
                    Effective inference-profile id used for Bedrock calls
```

There are three moving parts:

1. **Discovery (write path).** A scheduled Lambda reconciles the catalog table
   against the live Bedrock inventory.
2. **Configuration (write path).** An admin edits resolved defaults and per-slot
   choices through the GraphQL API / UI, which writes the config table after
   validating every referenced model against the catalog.
3. **Resolution (read path).** At runtime each arbiter entry point reads the
   config + catalog, runs the pure resolver, and uses the resulting
   inference-profile id — falling back to its previous default on any miss.

## Data model

Both tables are defined in `backend/lib/backend-stack.ts` with on-demand
billing (`PAY_PER_REQUEST`) and point-in-time recovery enabled.

### `citadel-model-catalog-{env}` — model inventory

Partition key: `modelKey` (a slug derived from the Bedrock model id).

| Field | Type | Notes |
|-------|------|-------|
| `modelKey` | String (PK) | Stable slug, e.g. derived from the base model id |
| `provider` | String | Lowercased provider name (e.g. `anthropic`) |
| `baseModelId` | String | Raw Bedrock model id |
| `status` | String | `enabled` \| `disabled` \| `deprecated` \| `discovered` |
| `modality` | String | `text` \| `embedding` \| `image` \| `other` |
| `invocationMode` | String | `converse` (text) or `invoke_model` |
| `supportsTools` | Boolean | Tool-use capability (from provider overlay) |
| `supportsSystemPrompt` | Boolean | System-prompt capability |
| `supportsStreaming` | Boolean | From the Bedrock API |
| `regionProfiles` | AWSJSON | Map of cross-region prefix → inference-profile id (e.g. `{"us": "...", "global": "..."}`) |
| `discoveredAt` | String | Timestamp first seen by the sync |

### `citadel-model-config-{env}` — resolved defaults & overrides

Partition key: `scope` (the platform-wide row uses `scope = "platform"`).

| Field | Type | Notes |
|-------|------|-------|
| `scope` | String (PK) | Defaults to `platform` |
| `globalDefaultKey` | String \| null | Catalog `modelKey` used when no more specific default applies |
| `slotDefaults` | AWSJSON | Map of slot → `modelKey` |
| `orgDefaults` | AWSJSON | Map of slot → `modelKey` (part of the resolution precedence and data model; not editable through the current UI) |
| `agentOverrides` | AWSJSON | Map of agent id → `modelKey` (see [Per-agent scope](#per-agent-and-per-slot-scope)) |
| `localityMode` | String | `off` \| `regional_preferred` \| `strict` |
| `updatedAt` / `updatedBy` | String | Stamped by the resolver on each update |

## Resolution core

The resolution logic is a set of pure, I/O-free modules shared across arbiter
Lambdas via the bundled layer (`arbiter/common/`, mirrored in
`service/agent_intake_single/`): `model_types.py` (value types),
`model_resolver.py` (the selection walk), `model_mapping.py` (item → type
mapping), and `region.py` (prefix helper).

**Precedence.** For a given slot the resolver walks configured layers in order
and takes the first candidate that exists in the catalog, is valid for the
slot, and resolves to a profile:

1. Agent override (when an agent id is supplied) — `agentOverrides[agentId]`
2. Org default for the slot — `orgDefaults[slot]`
3. Slot default — `slotDefaults[slot]`
4. Global default — `globalDefaultKey`
5. **Bootstrap fallback** — the caller-supplied default id (never fails)

**Validity for a slot.** A candidate must be `enabled`, match the slot's
required `modality`, support tools if the slot requires them, and use the
`converse` invocation mode if required. The `supervisor`, `fabricator`, and
`intake_agent` slots require tools; `extraction` does not; all four require
text + converse.

**Profile mapping & data locality.** The chosen entry is mapped to a concrete
inference-profile id from its `regionProfiles`, keyed by the deployment
region's cross-region prefix:

| `localityMode` | Behavior |
|----------------|----------|
| `off` | Prefer the regional profile, else the `global` profile, else construct `{prefix}.{baseModelId}` by Bedrock convention |
| `regional_preferred` | Same as `off`, but attaches a warning when it has to fall back to global/constructed |
| `strict` | Only a known regional profile is acceptable; if none exists the candidate is rejected and resolution moves on |

Cross-region prefixes (`arbiter/common/region.py`):

| Region prefix | Inference-profile prefix |
|---------------|--------------------------|
| `us-*` | `us` |
| `eu-*` | `eu` |
| `ap-southeast-2` | `au` |
| other `ap-*` | `apac` |
| `me-*` | `me` |
| `ca-*` | `ca` |
| `sa-*` | `sa` |
| `af-*` | `af` |
| anything else | `us` (default) |

## GraphQL API

The API is served by `backend/src/lambda/model-config-resolver.ts`, which
dispatches on `event.info.fieldName`. Query fields are open to authenticated
callers; every mutation is admin-gated in the resolver.

```graphql
type Query {
  # Operator-facing model catalog + resolved model-selection config.
  listModelCatalog: [ModelCatalogEntry!]!
  getModelConfig(scope: String): ModelConfig
}

type Mutation {
  # Admin-gated + validated in the resolver.
  updateModelConfig(input: UpdateModelConfigInput!): ModelConfig
  setModelCatalogEntryStatus(modelKey: String!, status: String!): ModelCatalogEntry
  # On-demand catalog sync trigger (admin-gated).
  syncModelCatalog: ModelCatalogSyncResult!
}
```

- **`listModelCatalog`** returns every catalog row.
- **`getModelConfig(scope)`** returns the resolved config for a scope (defaults
  to `platform`); when no row exists it returns a well-formed empty skeleton
  (`localityMode: "off"`, empty maps) rather than null.
- **`updateModelConfig`** accepts `UpdateModelConfigInput` — `scope`,
  `globalDefaultKey`, `slotDefaults` (AWSJSON), and `localityMode`. It merges
  the partial input onto the existing row, and **validates** that every
  referenced `modelKey` exists in the catalog *and* is `enabled` (rejecting
  unknown/disabled models) and that `localityMode` is one of the three allowed
  values. It stamps `updatedAt`/`updatedBy` and emits a model-config-changed
  event.
- **`setModelCatalogEntryStatus`** changes one catalog entry's lifecycle status
  (validated against `enabled`/`disabled`/`deprecated`/`discovered`).
- **`syncModelCatalog`** publishes a `model.catalog.sync_requested` event onto
  the custom agent bus (source `citadel.backend`) and returns
  `{ triggered, message }`. It never invokes the sync Lambda directly — an
  event-pattern rule routes the event (see [Catalog sync](#catalog-sync)).

Admin gating uses `isAdminFromEvent`; non-admin callers receive an error.
Mutations emit EventBridge events for auditability (a model-config-changed
event on config/status changes, and a catalog-synced summary from the sync
Lambda).

## Operator UI

The **Model Configuration** page (`frontend/src/pages/ModelConfiguration.tsx`)
is admin-only — non-admins see an "Administrator access required" notice. Data
is loaded by the `useModelConfig` hook (catalog + `platform` config on mount,
with an explicit `refresh`), and mutations go through
`frontend/src/services/modelConfigService.ts`, which parses the AWSJSON map
fields on read and stringifies `slotDefaults` on write.

The page has two areas:

- **Defaults** — a **Global default** dropdown (populated only with `enabled`
  entries), **Per-slot defaults** for `intake_agent`, `extraction`,
  `supervisor`, `fabricator`, and `fabricated_agent_default` (each with a "Use
  global default" option that clears the slot), and a **Data locality** selector
  (`off` / `regional_preferred` / `strict`).
- **Model Catalog** — a table of every entry (model, provider, capabilities,
  region count, status) with a per-row **Status** dropdown
  (`enabled`/`disabled`/`deprecated`).

Two header actions: **Model Sync** triggers `syncModelCatalog` (new models
appear after the sync completes — use Refresh a few seconds later), and
**Refresh** re-fetches the catalog and config. Each mutation shows a success or
error toast.

A separate catalog-backed control, `ModelOverrideSelect.tsx`, edits a
per-agent-binding model override (see below). It stores a catalog `modelKey` or
an empty value meaning "use the platform default", and preserves any legacy
free-text value as a "Current: …" option so editing a binding never silently
drops it.

## Per-agent and per-slot scope

Each arbiter entry point resolves its slot at cold start via a small,
non-pure I/O loader (`model_config_loader.py`) that reads the
`MODEL_CONFIG_TABLE` and `MODEL_CATALOG_TABLE` env vars, fetches the `platform`
config row plus the catalog, and delegates to the pure resolver:

| Slot | Where | Requires tools |
|------|-------|----------------|
| `supervisor` | `arbiter/supervisor/index.py` (`MODEL_ID`) | yes |
| `fabricator` | `arbiter/fabricator/index.py` (`FABRICATOR_MODEL_ID`) | yes |
| `intake_agent` | `service/agent_intake_single` (`load_intake_model_id`) | yes |
| `extraction` | `service/agent_intake_single` (`load_extraction_model_id`) | no |

Each loader is handed a **bootstrap fallback** model id by its caller (a
region-prefixed default constant defined at the call site) and returns that
fallback on any failure, logging a warning — it never raises.

**Per-agent binding override.** In addition to slot defaults, the Supervisor
reads a per-binding `modelOverride` (a `String` on the agent binding — see
`UpdateRegistryAgentBindingInput` in the schema, edited via
`ModelOverrideSelect`). At dispatch it resolves that catalog key to a concrete
inference-profile id (`resolve_agent_override`) and forwards it in the worker
dispatch payload. This path is a no-op unless a binding actually sets
`modelOverride` and the key resolves against an `enabled` catalog entry, and any
resolution failure is swallowed so a bad override can never break dispatch.

> Note: the config table's `agentOverrides` map and `orgDefaults` map are part
> of the resolver's precedence chain and data model, but the current per-slot
> loaders resolve without passing an agent id and the operator UI's update path
> does not edit those two maps — so the active override mechanism today is the
> per-binding `modelOverride` field described above.

## Catalog sync

The sync Lambda (`backend/src/lambda/model-catalog-sync.ts`) keeps the catalog
current with the live Bedrock inventory. It is entirely data-driven — it
contains no model-id or model-family literals — and layers tool/system-prompt/
Converse capability onto the API-derived fields via a small overlay keyed by
**provider name** with a conservative default.

Each run:

1. Lists foundation models (`ListFoundationModels`) and inference profiles
   (`ListInferenceProfiles`, paginated) and builds a `baseModelId → {prefix →
   inferenceProfileId}` map.
2. **Upserts** each live model: brand-new entries are written with status
   `discovered`; known entries have their API-derived metadata refreshed while
   **preserving the operator-owned `status`**.
3. **Deprecates** catalog entries Bedrock no longer returns (status →
   `deprecated`).
4. Emits a summary event (`{ discovered, updated, deprecated, total, syncedAt }`).

**Triggers** (wired in `backend/lib/backend-stack.ts`):

- **Scheduled** — `ModelCatalogSyncRule`, a daily EventBridge schedule
  (`rate(24 hours)`).
- **On-demand** — the `syncModelCatalog` mutation publishes
  `model.catalog.sync_requested` onto the `citadel-agents-{env}` bus;
  `ModelCatalogSyncRequestRule` (an event-pattern rule) routes it to the *same*
  Lambda. EventBridge invokes the target via the rule's managed permission — the
  resolver holds no `lambda:InvokeFunction` grant.

**Permissions.** The sync function is granted read-only Bedrock discovery
(`ListFoundationModels`, `ListInferenceProfiles`, `GetFoundationModel`,
`GetInferenceProfile`), read/write on the catalog table, and put-events on the
bus. The Bedrock actions are on `*` (account/region-level enumeration APIs, with
a documented cdk-nag suppression) and are strictly read-only — the sync never
mutates Bedrock.

**Seed baseline.** A CloudFormation custom resource
(`backend/src/lambda/seed-model-catalog/index.ts`) writes one baseline catalog
entry (the seed `modelKey` `anthropic-claude-sonnet-5`, `enabled`) and one
`platform` config row on deploy. Both writes are conditional
(`attribute_not_exists`), so a redeploy never clobbers operator edits. This
seed file is the single sanctioned place a concrete model id appears.

## Operational notes

- **Fallback is total.** If the tables are empty, unreachable, or misconfigured,
  every arbiter slot keeps running on its caller-supplied bootstrap default.
  Nothing about model configuration is on the critical path for dispatch.
- **Cold-start reads.** Each loader performs one config `GetItem` + one catalog
  `Scan` per Lambda container; TTL caching can be layered on later without
  changing the contract.
- **Least privilege.** The Supervisor (`arbiter-stack.ts`) and the intake
  runtime (`services-stack.ts`) receive **read-only** grants on both tables; only
  the resolver and the sync Lambda write.
- **Only `enabled` models are selectable.** The UI populates dropdowns from
  `enabled` entries and the resolver rejects non-`enabled` candidates; the
  `discovered` status is applied by the sync and is not offered in the UI status
  dropdown.
- **Regions.** Choose `localityMode: strict` to guarantee an in-region
  inference profile (candidates without one are rejected); `off` /
  `regional_preferred` allow global or constructed profiles.

## Source map

| Concern | File(s) |
|---------|---------|
| GraphQL resolver | `backend/src/lambda/model-config-resolver.ts` |
| Catalog sync | `backend/src/lambda/model-catalog-sync.ts` |
| Seed baseline | `backend/src/lambda/seed-model-catalog/index.ts` |
| Tables, sync schedule/rules | `backend/lib/backend-stack.ts` |
| Supervisor grants | `backend/lib/arbiter-stack.ts` |
| Intake grants | `backend/lib/services-stack.ts` |
| Resolution core (pure) | `arbiter/common/model_resolver.py`, `model_types.py`, `model_mapping.py`, `region.py` |
| Runtime loaders | `arbiter/supervisor/model_config_loader.py`, `arbiter/fabricator/model_config_loader.py`, `service/agent_intake_single/model_config_loader.py` |
| Operator UI | `frontend/src/pages/ModelConfiguration.tsx`, `frontend/src/components/ModelOverrideSelect.tsx`, `frontend/src/hooks/useModelConfig.ts`, `frontend/src/services/modelConfigService.ts` |
