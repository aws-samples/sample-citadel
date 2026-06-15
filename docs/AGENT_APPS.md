# Agent Apps Platform (Superseded)

> **STATUS: Superseded.** The Agent Apps Platform has been migrated to the
> AgentCore Registry as of PR 3 of the governance retrofit. Authoritative
> reference: [Agent Records](./AGENT_RECORDS.md).

## Migration Summary

- The legacy DynamoDB `AppsTable` has been replaced as the authoritative
  catalogue by the AWS Bedrock AgentCore Registry, accessed via
  `BedrockAgentCoreControlClient`. `AppsTable` itself is retained only for
  per-app agent bindings during the deprecation window — see
  [What Moved Where](#what-moved-where) for the boundary.
- The primary identifier `appId` has been replaced by the Registry-native
  `recordId` (12-alphanumeric, allocated by the Registry).
- The `AgentApp.status` enum (`DRAFT` / `ACTIVE` / `ARCHIVED`) has been
  replaced by `RegistryRecordStatus` (`DRAFT` / `PENDING_APPROVAL` /
  `APPROVED` / `REJECTED` / `DEPRECATED`). The new status domain aligns with
  governance Decision #3.
- The shim resolver `backend/src/lambda/agent-app-shim-resolver.ts`
  preserves the `type AgentApp` GraphQL surface and every original
  `citadel.apps` EventBridge detail-type during the `@deprecated` grace
  window (Decision #5, SPLIT verdict). Subscribers and clients require no
  code changes for the duration of the window.

## What Moved Where

| Legacy concept                                     | Registry equivalent                                                                      |
|----------------------------------------------------|------------------------------------------------------------------------------------------|
| `AppsTable` row (catalogue side)                   | `RegistryAgentRecord` in the AgentCore Registry (see [AGENT_RECORDS.md](./AGENT_RECORDS.md)) |
| Component table GSI (`AGENT#`, `PERMISSION#`, `CONFIG#`) | `customDescriptorContent.manifest` JSON on the registry record                     |
| `backend/src/lambda/app-resolver.ts`               | `backend/src/lambda/agent-app-shim-resolver.ts`                                          |
| `citadel-agent-{appId}` per-app IAM role           | Per-record workload-identity attribute on the registry record (Decision #6)              |
| `AuthorityUnit.appId`                              | `AuthorityUnit.registryId` (Decision #9)                                                 |

## Sunset Timeline

- PR 3 of the governance retrofit landed the registry-backed implementation
  and the `agent-app-shim-resolver.ts` shim. `type AgentApp` carries the
  `@deprecated` directive in the GraphQL schema from PR 3 onward.
- The `@deprecated type AgentApp` GraphQL surface remains callable through
  PR 6 (post-MVP) to give downstream clients a migration window.
- PR 6 removes the `@deprecated` type and retires the shim. Gate conditions
  for PR 6: registry MVP stable for at least one release cycle, explicit
  frontend sign-off, and zero `@deprecated` `AgentApp` reads observed in
  client telemetry for a full rolling observation window.

## Where To Go Next

- [docs/AGENT_RECORDS.md](./AGENT_RECORDS.md) — authoritative data model for
  the AgentCore Registry, lifecycle, governance integration, and adapter APIs.
- [docs/GOVERNANCE_ROLLOUT_RUNBOOK.md](./GOVERNANCE_ROLLOUT_RUNBOOK.md) —
  operational procedure for rolling the governance gate from permissive
  through shadow to strict in production.
- [docs/EVENTBRIDGE_CATALOG.md](./EVENTBRIDGE_CATALOG.md) — specifically the
  `App Lifecycle Events (source: citadel.apps)` section for the registry-
  backed event envelope contract.

## Historical Note

The original 52 KB architecture, component-management, and test-strategy
documentation for the Agent Apps platform is preserved in git history at
commit `1748d9b` for archaeological reference. Use `git show 1748d9b:docs/AGENT_APPS.md`
to retrieve the pre-retrofit content.
