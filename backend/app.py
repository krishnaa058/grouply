"""
app.py — Grouply Flask backend
Milestones 1 + 2: Auth routes + Groups core.
"""

import logging
import os
import re
import secrets
import string
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, g, request
from flask_cors import CORS
from dotenv import load_dotenv

from backend_auth import (
    login_required, current_user_client, get_service_client
)

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-change-me")

CORS(app, resources={r"/api/*": {"origins": "*"}}, supports_credentials=True)


# ════════════════════════════════════════════════════════════
# UTILITIES
# ════════════════════════════════════════════════════════════

def _make_invite_code(length: int = 8) -> str:
    """Generate a short, URL-safe alphanumeric invite code."""
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _is_member(db, group_id: str, user_id: str) -> bool:
    """Check membership using user-scoped client (RLS-safe)."""
    result = (
        db.table("group_members")
        .select("id")
        .eq("group_id", group_id)
        .eq("user_id", user_id)
        .execute()
    )
    return bool(result.data)


def _get_role(db, group_id: str, user_id: str):
    """Return the member's role ('admin'|'member') or None."""
    result = (
        db.table("group_members")
        .select("role")
        .eq("group_id", group_id)
        .eq("user_id", user_id)
        .execute()
    )
    return result.data[0]["role"] if result.data else None


# ════════════════════════════════════════════════════════════
# HEALTH
# ════════════════════════════════════════════════════════════

@app.route("/")
def index():
    return jsonify({
        "service": "grouply-backend",
        "status": "online",
        "message": "Grouply API is running. Access the frontend app to use Grouply."
    })


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "service": "grouply-backend"})


# ════════════════════════════════════════════════════════════
# AUTH / PROFILE  (Milestone 1)
# ════════════════════════════════════════════════════════════

@app.route("/api/me")
@login_required
def me():
    """Returns the authenticated user's profile row."""
    db = current_user_client()
    result = db.table("profiles").select("*").eq("id", g.user_id).single().execute()
    if result.data:
        return jsonify(result.data)
    return jsonify({"error": "Profile not found"}), 404


@app.route("/api/me/onboard", methods=["POST"])
@login_required
def onboard():
    """First-login profile setup: save username, display name, bio."""
    data         = request.get_json(force=True)
    username     = (data.get("username") or "").strip().lower()
    display_name = (data.get("display_name") or "").strip()
    avatar_url   = data.get("avatar_url")
    bio          = data.get("bio")

    if not username:
        return jsonify({"error": "username is required"}), 400
    if not re.match(r'^[a-z0-9_]{3,30}$', username):
        return jsonify({"error": "Username must be 3–30 chars, only a-z, 0-9, _"}), 400

    db = current_user_client()
    existing = db.table("profiles").select("id").eq("username", username).execute()
    if existing.data and existing.data[0]["id"] != g.user_id:
        return jsonify({"error": "Username already taken"}), 409

    update = {"username": username, "display_name": display_name}
    if avatar_url is not None:
        update["avatar_url"] = avatar_url
    if bio is not None:
        update["bio"] = bio

    result = db.table("profiles").update(update).eq("id", g.user_id).execute()
    return jsonify(result.data[0] if result.data else {})


@app.route("/api/username/check")
@login_required
def check_username():
    """Live username availability check."""
    username = (request.args.get("username") or "").strip().lower()
    if not username:
        return jsonify({"error": "username param required"}), 400
    db = current_user_client()
    result = db.table("profiles").select("id").eq("username", username).execute()
    taken = bool(result.data and result.data[0]["id"] != g.user_id)
    return jsonify({"available": not taken, "username": username})


@app.route("/api/me", methods=["PUT", "PATCH"])
@login_required
def update_profile():
    """Update authenticated user's profile (Milestone 3)."""
    data = request.get_json(force=True)
    update = {}

    if "display_name" in data:
        display_name = (data.get("display_name") or "").strip()
        if not display_name:
            return jsonify({"error": "Display name cannot be empty"}), 400
        update["display_name"] = display_name

    if "bio" in data:
        update["bio"] = (data.get("bio") or "").strip()

    if "avatar_url" in data:
        update["avatar_url"] = (data.get("avatar_url") or "").strip() or None

    if "username" in data:
        username = (data.get("username") or "").strip().lower()
        if not username:
            return jsonify({"error": "Username cannot be empty"}), 400
        if not re.match(r'^[a-z0-9_]{3,30}$', username):
            return jsonify({"error": "Username must be 3–30 chars, only a-z, 0-9, _"}), 400

        db = current_user_client()
        existing = db.table("profiles").select("id").eq("username", username).execute()
        if existing.data and existing.data[0]["id"] != g.user_id:
            return jsonify({"error": "Username already taken"}), 409
        update["username"] = username

    if not update:
        return jsonify({"error": "No fields to update"}), 400

    db = current_user_client()
    result = db.table("profiles").update(update).eq("id", g.user_id).execute()
    if not result.data:
        return jsonify({"error": "Failed to update profile"}), 500
    return jsonify(result.data[0])


@app.route("/api/profiles/<user_id>")
@login_required
def get_user_profile(user_id: str):
    """
    Get profile and visible groups ('the flex') for a user (Milestone 3).
    Visible groups are those readable by the requesting user via RLS (public or mutual).
    """
    db = current_user_client()
    prof_res = (
        db.table("profiles")
        .select("id, username, display_name, avatar_url, bio, created_at")
        .eq("id", user_id)
        .single()
        .execute()
    )
    if not prof_res.data:
        return jsonify({"error": "Profile not found"}), 404

    # Fetch groups this user belongs to
    memberships = (
        db.table("group_members")
        .select("role, groups(id, name, description, category, is_private, cover_url)")
        .eq("user_id", user_id)
        .execute()
    )

    # Total groups count using service client
    svc = get_service_client()
    count_res = (
        svc.table("group_members")
        .select("id", count="exact")
        .eq("user_id", user_id)
        .execute()
    )
    total_groups_count = count_res.count if count_res.count is not None else len(memberships.data or [])

    visible_groups = []
    for m in (memberships.data or []):
        grp = m.get("groups")
        if grp:
            visible_groups.append({
                "id": grp["id"],
                "name": grp["name"],
                "description": grp.get("description"),
                "category": grp.get("category"),
                "is_private": grp.get("is_private"),
                "cover_url": grp.get("cover_url"),
                "role": m.get("role", "member"),
            })

    return jsonify({
        "profile": prof_res.data,
        "total_groups_count": total_groups_count,
        "visible_groups": visible_groups,
    })


# ════════════════════════════════════════════════════════════
# GROUPS  (Milestone 2)
# ════════════════════════════════════════════════════════════

@app.route("/api/groups", methods=["POST"])
@login_required
def create_group():
    """
    Create a group and add the creator as admin.
    Uses the SECURITY DEFINER create_group() SQL function to avoid
    the RLS chicken-and-egg problem.
    """
    data        = request.get_json(force=True)
    name        = (data.get("name") or "").strip()
    description = (data.get("description") or "").strip() or None
    category    = (data.get("category") or "").strip() or None
    is_private  = bool(data.get("is_private", True))

    if not name:
        return jsonify({"error": "Group name is required"}), 400
    if len(name) > 80:
        return jsonify({"error": "Group name must be 80 characters or fewer"}), 400

    db = current_user_client()
    # Call the SECURITY DEFINER function — it inserts group + admin membership atomically
    result = db.rpc(
        "create_group",
        {
            "p_name":        name,
            "p_description": description,
            "p_category":    category,
            "p_is_private":  is_private,
        },
    ).execute()

    new_group_id = result.data
    if not new_group_id:
        logger.error("create_group RPC returned no data: %s", result)
        return jsonify({"error": "Failed to create group"}), 500

    # Fetch the full group row to return to the client
    group = db.table("groups").select("*").eq("id", new_group_id).single().execute()
    return jsonify(group.data), 201


@app.route("/api/groups", methods=["GET"])
@login_required
def list_groups():
    """
    Returns all groups the current user is a member of,
    with their role and member count.
    """
    db = current_user_client()

    # Fetch memberships for the current user, joining group info
    memberships = (
        db.table("group_members")
        .select("role, group_id, groups(*)")
        .eq("user_id", g.user_id)
        .order("joined_at", desc=True)
        .execute()
    )

    groups = []
    for row in (memberships.data or []):
        group_data = row.get("groups") or {}
        group_data["my_role"] = row["role"]

        # Get member count (uses service client to bypass any RLS quirks on counts)
        count_res = (
            db.table("group_members")
            .select("id", count="exact")
            .eq("group_id", row["group_id"])
            .execute()
        )
        group_data["member_count"] = count_res.count if count_res.count is not None else 0
        groups.append(group_data)

    return jsonify(groups)


@app.route("/api/groups/<group_id>", methods=["GET"])
@login_required
def get_group(group_id):
    """
    Returns a single group's details, current user's role,
    and the member list with profiles.
    """
    db = current_user_client()

    # RLS will return nothing if user is not a member of a private group
    group_res = db.table("groups").select("*").eq("id", group_id).single().execute()
    if not group_res.data:
        return jsonify({"error": "Group not found or access denied"}), 404

    group = group_res.data

    # Current user's role
    role = _get_role(db, group_id, g.user_id)
    group["my_role"] = role

    # Member list with profile info
    members_res = (
        db.table("group_members")
        .select("role, joined_at, user_id, profiles(id, username, display_name, avatar_url)")
        .eq("group_id", group_id)
        .execute()
    )
    group["members"] = members_res.data or []

    # Member count
    group["member_count"] = len(group["members"])

    return jsonify(group)


@app.route("/api/groups/<group_id>/join", methods=["POST"])
@login_required
def join_group(group_id):
    """
    Join a PUBLIC group directly.
    Private groups require an invite code — use /api/groups/join-by-code instead.
    """
    svc = get_service_client()

    # Check group exists and is public
    group_res = svc.table("groups").select("id, is_private, name").eq("id", group_id).single().execute()
    if not group_res.data:
        return jsonify({"error": "Group not found"}), 404

    group = group_res.data
    if group["is_private"]:
        return jsonify({"error": "This is a private group. Use an invite link to join."}), 403

    # Check not already a member
    existing = (
        svc.table("group_members")
        .select("id")
        .eq("group_id", group_id)
        .eq("user_id", g.user_id)
        .execute()
    )
    if existing.data:
        return jsonify({"error": "Already a member of this group"}), 409

    svc.table("group_members").insert({
        "group_id": group_id,
        "user_id":  g.user_id,
        "role":     "member",
    }).execute()

    return jsonify({"success": True, "group_name": group["name"]}), 201


@app.route("/api/groups/<group_id>/invite", methods=["POST"])
@login_required
def create_invite(group_id):
    """
    Generate a single-use invite code for a private group.
    Any member can create an invite (not just admins).
    Code expires in 7 days.
    """
    db = current_user_client()

    # Must be a member
    if not _is_member(db, group_id, g.user_id):
        return jsonify({"error": "Not a member of this group"}), 403

    code = _make_invite_code(8)
    expires_at = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()

    svc = get_service_client()
    svc.table("group_invites").insert({
        "group_id":   group_id,
        "code":       code,
        "created_by": g.user_id,
        "expires_at": expires_at,
    }).execute()

    return jsonify({
        "code":       code,
        "expires_at": expires_at,
        "invite_url": f"?invite={code}",   # frontend appends to base URL
    }), 201


@app.route("/api/groups/join-by-code", methods=["POST"])
@login_required
def join_by_code():
    """
    Consume a single-use invite code and add the user as a member.
    Uses service-role client because normal users can't read group_invites
    (only admins can read their own group's codes).
    """
    data = request.get_json(force=True)
    code = (data.get("code") or "").strip().upper()
    if not code:
        return jsonify({"error": "Invite code is required"}), 400

    svc = get_service_client()

    # Look up the invite
    invite_res = (
        svc.table("group_invites")
        .select("*")
        .eq("code", code)
        .is_("used_by", "null")   # not yet used
        .execute()
    )

    if not invite_res.data:
        return jsonify({"error": "Invalid or already-used invite code"}), 404

    invite = invite_res.data[0]

    # Check expiry
    expires_at = datetime.fromisoformat(invite["expires_at"].replace("Z", "+00:00"))
    if datetime.now(timezone.utc) > expires_at:
        return jsonify({"error": "This invite link has expired"}), 410

    group_id = invite["group_id"]

    # Check not already a member
    existing = (
        svc.table("group_members")
        .select("id")
        .eq("group_id", group_id)
        .eq("user_id", g.user_id)
        .execute()
    )
    if existing.data:
        # Mark code as used anyway so it can't be replayed
        svc.table("group_invites").update({"used_by": g.user_id}).eq("id", invite["id"]).execute()
        return jsonify({"error": "Already a member of this group"}), 409

    # Add member
    svc.table("group_members").insert({
        "group_id": group_id,
        "user_id":  g.user_id,
        "role":     "member",
    }).execute()

    # Mark code as used (single-use)
    svc.table("group_invites").update({"used_by": g.user_id}).eq("id", invite["id"]).execute()

    # Fetch group name for response
    group_res = svc.table("groups").select("id, name, category, is_private").eq("id", group_id).single().execute()
    return jsonify({
        "success": True,
        "group":   group_res.data,
    }), 201


# ════════════════════════════════════════════════════════════
# RUN
# ════════════════════════════════════════════════════════════

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
