"""Reserved top-level attribute names on the workflow tracking DynamoDB item
(finding 679abf74, extended to the fabricator's agent-id write paths).

Shared via the ``common`` layer package so BOTH the supervisor (writer of
the workflow tracking record) and the fabricator (producer of the
``agent_id`` values that end up as node ids on that record) can enforce the
same reserved set without duplicating the literal. A node id/agent id must
never collide with one of these, since they are the record's own identity
key (``requestId``) and the nested per-node payload map (``data``) written
by ``create_workflow_tracking_record`` and read by
``update_orchestration_with_results`` in ``arbiter/supervisor/index.py``.

Previously an agent named ``data`` or ``requestId`` was only rejected much
later, when the supervisor tried to create the workflow tracking record —
after the fabricator had already persisted the agent config to DynamoDB
and/or the AgentCore Registry. Importing this constant in the fabricator's
``store_agent_config_dynamo``/``store_agent_config_registry`` lets the
collision be rejected at the source, before any write.
"""
from __future__ import annotations

RESERVED_WORKFLOW_TRACKING_KEYS = frozenset({"requestId", "data"})
