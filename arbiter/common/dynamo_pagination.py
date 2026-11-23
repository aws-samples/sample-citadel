"""Shared bounded DynamoDB pagination helper (mirrors the fix in 920e557).

Every unbounded ``while True: ... LastEvaluatedKey ...`` scan/query loop in
this tree is a latent CI hang: a unit test that stubs the table with a bare
``MagicMock`` makes ``response.get("LastEvaluatedKey")`` return a fresh
(truthy) ``MagicMock`` forever, since a Mock attribute access always
succeeds and the result is itself truthy. A loop that only checks
``if not last_key: break`` never terminates against that stand-in. Real
DynamoDB responses are unaffected by the extra guards below: a well-formed
paginated scan/query always yields a non-empty ``dict`` key until the final
page (which omits the key entirely), and legitimate pagination stays far
below the page cap.

:func:`paginate_pages` centralises the defensive termination that
``arbiter/governance/hierarchy.py``'s ``_scan_all`` introduced ad hoc, so
every other caller gets the same guarantees without re-deriving them.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Iterator

logger = logging.getLogger(__name__)

DEFAULT_MAX_PAGES = 10000


class PaginationPageCapExceeded(RuntimeError):
    """Raised when a paginated call exceeds its page cap and ``raise_on_cap``
    is True.
    """


def paginate_pages(
    call: Callable[..., dict[str, Any]],
    *,
    max_pages: int = DEFAULT_MAX_PAGES,
    raise_on_cap: bool = False,
    **kwargs: Any,
) -> Iterator[dict[str, Any]]:
    """Yield each page of a DynamoDB ``scan``/``query``-shaped ``call``.

    ``call`` is typically a bound ``table.scan`` or ``table.query`` method.
    Each page's ``LastEvaluatedKey`` (if present and a non-empty ``dict``)
    is threaded back in as ``ExclusiveStartKey`` for the next call, exactly
    like boto3's own pagination contract.

    Termination guards (defensive, not just the happy path):

    * Pagination stops as soon as ``LastEvaluatedKey`` is absent, or is not
      a non-empty ``dict`` — this is the MagicMock guard: a stubbed table in
      a unit test returns a truthy ``MagicMock`` for any attribute access,
      including ``.get("LastEvaluatedKey")``, which would loop forever
      under the naive ``if not last_key: break`` check alone.
    * Pagination stops after ``max_pages`` pages (default
      :data:`DEFAULT_MAX_PAGES`) regardless of what the key looks like, as a
      hard backstop against any other unbounded-pagination shape. By
      default this logs a warning and returns the pages collected so far;
      pass ``raise_on_cap=True`` to raise :class:`PaginationPageCapExceeded`
      instead, for callers that would rather fail loudly than silently
      return a possibly-incomplete result.

    Args:
        call: Bound callable such as ``table.scan`` or ``table.query``.
        max_pages: Hard cap on the number of pages fetched.
        raise_on_cap: If True, raise :class:`PaginationPageCapExceeded` when
            the cap is hit instead of logging and stopping.
        **kwargs: Forwarded verbatim to ``call`` on every page (e.g.
            ``FilterExpression``, ``ExpressionAttributeNames``,
            ``ExpressionAttributeValues``). ``ExclusiveStartKey`` is managed
            internally and must not be passed in.

    Yields:
        Each raw response page (``dict``) returned by ``call``.
    """
    page_kwargs: dict[str, Any] = dict(kwargs)
    pages = 0
    while True:
        response = call(**page_kwargs)
        yield response

        last_key = response.get("LastEvaluatedKey")
        if not isinstance(last_key, dict) or not last_key:
            return

        pages += 1
        if pages >= max_pages:
            message = (
                "paginate_pages: hit the %d-page cap; aborting pagination "
                "with a possibly-incomplete result."
            )
            if raise_on_cap:
                raise PaginationPageCapExceeded(message % max_pages)
            logger.warning(message, max_pages)
            return

        page_kwargs["ExclusiveStartKey"] = last_key


def collect_items(
    call: Callable[..., dict[str, Any]],
    *,
    max_pages: int = DEFAULT_MAX_PAGES,
    raise_on_cap: bool = False,
    **kwargs: Any,
) -> list[dict[str, Any]]:
    """Convenience wrapper: flatten every page's ``Items`` into one list.

    Equivalent to the common ``items = []; for page in paginate_pages(...):
    items.extend(page.get("Items", []))`` pattern used by most callers.
    """
    items: list[dict[str, Any]] = []
    for page in paginate_pages(
        call, max_pages=max_pages, raise_on_cap=raise_on_cap, **kwargs
    ):
        items.extend(page.get("Items", []))
    return items
