"""Typed exceptions raised by :class:`ai_guard.client.AiGuardClient`.

Mirrors the TypeScript SDK's error hierarchy (``AiGuardError`` /
``PolicyBlockedError`` / ``SafetyBlockedError``) while surfacing the API's
structured error envelope (``code``, ``message``, ``details``, ``requestId``,
and the block-specific top-level fields) as first-class attributes.
"""

from __future__ import annotations

from typing import Any, Dict, Optional


class AiGuardError(Exception):
    """Base error carrying the HTTP status and the API's structured error body.

    The Ai-Guard error envelope looks like::

        {
          "error": {
            "code": "policy_blocked",
            "message": "...",
            "details": { ... },
            "requestId": "550e8400-...",      # HTTP trace id (UUID)
            "auditRequestId": "req_42",       # audit-log row (block/safety only)
            ...
          }
        }

    Attributes:
        status: HTTP status code (0 if the request never got a response).
        code: The stable ``error.code`` string (e.g. ``"policy_blocked"``).
        message: Human-readable ``error.message``.
        details: The ``error.details`` object, if present.
        request_id: ``error.requestId`` — the HTTP trace id (UUID).
        audit_request_id: ``error.auditRequestId`` — the ``req_<n>`` audit id,
            present on policy/safety/budget blocks. Use with
            ``ai-guard requests show``.
        body: The full parsed response body.
    """

    def __init__(
        self,
        status: int,
        code: str,
        body: Any = None,
        *,
        message: Optional[str] = None,
    ) -> None:
        self.status = status
        self.code = code
        self.body = body

        error = body.get("error") if isinstance(body, dict) else None
        error_obj: Dict[str, Any] = error if isinstance(error, dict) else {}

        self.message: str = message or error_obj.get("message") or code
        self.details: Optional[Dict[str, Any]] = (
            error_obj.get("details") if isinstance(error_obj.get("details"), dict) else None
        )
        self.request_id: Optional[str] = error_obj.get("requestId")
        self.audit_request_id: Optional[str] = error_obj.get("auditRequestId")

        super().__init__(f"ai-guard request failed ({status}): {code} - {self.message}")


class PolicyBlockedError(AiGuardError):
    """Raised on 403 ``policy_blocked`` or ``budget_exceeded``.

    Inspect :attr:`~AiGuardError.body` / :attr:`~AiGuardError.details` for the
    block reason, and :attr:`~AiGuardError.audit_request_id` for the audit id.
    """


class SafetyBlockedError(AiGuardError):
    """Raised on 403 ``safety_blocked`` (PII or prompt injection)."""


__all__ = ["AiGuardError", "PolicyBlockedError", "SafetyBlockedError"]
