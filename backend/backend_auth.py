"""
backend_auth.py — Grouply
JWT verification + user-scoped Supabase client.

Supports both:
  - JWT_MODE=asymmetric  (new Supabase projects: RS256/ES256 via JWKS)
  - JWT_MODE=symmetric   (legacy: HS256 shared secret)

The correct mode is auto-detected from the JWT_MODE environment variable.
"""

import os
import functools
import logging
from typing import Optional

import jwt                        # PyJWT
from jwt import PyJWKClient, ExpiredSignatureError, InvalidTokenError
from supabase import create_client, Client
from dotenv import load_dotenv
from flask import request, jsonify, g

load_dotenv()

logger = logging.getLogger(__name__)

# ── Environment ──────────────────────────────────────────────────────────────
SUPABASE_URL           = os.environ["SUPABASE_URL"]
SUPABASE_ANON_KEY      = os.environ["SUPABASE_ANON_KEY"]
SUPABASE_SERVICE_KEY   = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
JWT_MODE               = os.environ.get("JWT_MODE", "asymmetric").lower()
JWT_SECRET             = os.environ.get("SUPABASE_JWT_SECRET", "")   # only for symmetric

# Audience claim required by Supabase
_AUDIENCE = "authenticated"

# ── JWKS client (asymmetric mode) ────────────────────────────────────────────
_jwks_client: Optional[PyJWKClient] = None

def _get_jwks_client() -> PyJWKClient:
    """Lazily initialize and cache the PyJWKClient for the project's JWKS endpoint."""
    global _jwks_client
    if _jwks_client is None:
        jwks_url = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json"
        _jwks_client = PyJWKClient(jwks_url, cache_keys=True)
        logger.info("JWKS client initialised for %s", jwks_url)
    return _jwks_client


# ── Token verification ────────────────────────────────────────────────────────
def verify_token(token: str) -> dict:
    """
    Verify a Supabase JWT and return its decoded payload.
    Raises jwt.InvalidTokenError (or subclass) on failure.
    """
    if JWT_MODE == "symmetric":
        # Legacy HS256 — shared secret
        payload = jwt.decode(
            token,
            JWT_SECRET,
            algorithms=["HS256"],
            audience=_AUDIENCE,
        )
    else:
        # Asymmetric RS256 / ES256 via JWKS
        client = _get_jwks_client()
        signing_key = client.get_signing_key_from_jwt(token)
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256", "ES256"],
            audience=_AUDIENCE,
        )

    return payload


# ── User-scoped Supabase client ───────────────────────────────────────────────
def get_user_scoped_client(token: str) -> Client:
    """
    Returns a supabase-py client configured with the user's JWT so that
    RLS policies are enforced for every query made through it.
    """
    client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    # supabase-py v2: set_session expects access_token + refresh_token.
    # We only have the access token here; pass "" for refresh_token.
    client.postgrest.auth(token)
    return client


# ── Service-role client (trusted server operations only) ─────────────────────
def get_service_client() -> Client:
    """
    Returns a supabase-py client using the service-role key.
    NEVER send this client's responses directly to the browser.
    Use only for:
      - Storing Drive refresh tokens in group_drive_connections
      - Resolving proposals server-side
      - Administrative tasks
    """
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


# ── Flask decorator ───────────────────────────────────────────────────────────
def login_required(f):
    """
    Flask route decorator.
    Extracts and verifies the Bearer token from Authorization header.
    Sets g.user_id and g.token for use in the route.
    """
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return jsonify({"error": "Missing or invalid Authorization header"}), 401

        token = auth_header.split(" ", 1)[1]

        try:
            payload = verify_token(token)
        except ExpiredSignatureError:
            return jsonify({"error": "Token expired"}), 401
        except InvalidTokenError as exc:
            logger.warning("Invalid token: %s", exc)
            return jsonify({"error": "Invalid token"}), 401

        # Store on Flask's request-local g
        g.user_id = payload.get("sub")
        g.token   = token
        g.payload = payload

        return f(*args, **kwargs)
    return decorated


# ── Helper: get user-scoped client for current request ───────────────────────
def current_user_client() -> Client:
    """Call inside a @login_required route to get an RLS-respecting client."""
    return get_user_scoped_client(g.token)
