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
    """Check membership using user-scoped client with service client fallback."""
    try:
        result = (
            db.table("group_members")
            .select("id")
            .eq("group_id", group_id)
            .eq("user_id", user_id)
            .execute()
        )
        if result.data:
            return True
    except Exception as e:
        logger.info("_is_member user client check: %s", e)

    try:
        svc = get_service_client()
        result = (
            svc.table("group_members")
            .select("id")
            .eq("group_id", group_id)
            .eq("user_id", user_id)
            .execute()
        )
        return bool(result.data)
    except Exception as e:
        logger.error("_is_member service client check error: %s", e)
        return False


def _get_role(db, group_id: str, user_id: str):
    """Return the member's role ('admin'|'member') or None."""
    try:
        result = (
            db.table("group_members")
            .select("role")
            .eq("group_id", group_id)
            .eq("user_id", user_id)
            .execute()
        )
        if result.data:
            return result.data[0]["role"]
    except Exception:
        pass

    try:
        svc = get_service_client()
        result = (
            svc.table("group_members")
            .select("role")
            .eq("group_id", group_id)
            .eq("user_id", user_id)
            .execute()
        )
        return result.data[0]["role"] if result.data else None
    except Exception:
        return None


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
    """Returns the authenticated user's profile row. Auto-provisions if missing (e.g. fresh OAuth)."""
    db = current_user_client()
    try:
        result = db.table("profiles").select("*").eq("id", g.user_id).execute()
        if result.data:
            return jsonify(result.data[0])
    except Exception as e:
        logger.warning("Error fetching profile via user client: %s", e)

    # Fallback to service client or create profile from metadata
    svc = get_service_client()
    try:
        svc_res = svc.table("profiles").select("*").eq("id", g.user_id).execute()
        if svc_res.data:
            return jsonify(svc_res.data[0])
    except Exception as e:
        logger.warning("Error fetching profile via service client: %s", e)

    # Auto-provision profile for user
    meta = g.payload.get("user_metadata", {}) or {}
    email = g.payload.get("email", "")
    full_name = meta.get("full_name") or meta.get("name") or (email.split("@")[0] if email else "User")
    avatar_url = meta.get("avatar_url") or meta.get("picture")
    base_un = re.sub(r"[^a-z0-9_]", "", (meta.get("preferred_username") or (email.split("@")[0] if email else "user")).lower()) or "user"
    username = f"{base_un}_{secrets.token_hex(2)}"

    new_profile = {
        "id": g.user_id,
        "username": username,
        "display_name": full_name,
        "avatar_url": avatar_url,
    }
    try:
        ins = svc.table("profiles").insert(new_profile).execute()
        if ins.data:
            return jsonify(ins.data[0])
    except Exception as e:
        logger.error("Failed to auto-provision profile: %s", e)

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

    try:
        result = db.table("profiles").update(update).eq("id", g.user_id).execute()
    except Exception as e:
        logger.warning("Onboard profile update via user client failed: %s", e)
        result = None

    if not result or not result.data:
        svc = get_service_client()
        result = svc.table("profiles").update(update).eq("id", g.user_id).execute()

    return jsonify(result.data[0] if (result and result.data) else {})


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
    try:
        result = db.table("profiles").update(update).eq("id", g.user_id).execute()
    except Exception as e:
        logger.warning("Profile update via user client failed: %s", e)
        result = None

    if not result or not result.data:
        svc = get_service_client()
        result = svc.table("profiles").update(update).eq("id", g.user_id).execute()

    if not result or not result.data:
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
    Also links creator's Google Drive folder link for group media.
    Uses service-client fallback to prevent any creation failures.
    """
    data              = request.get_json(force=True)
    name              = (data.get("name") or "").strip()
    description       = (data.get("description") or "").strip() or None
    category          = (data.get("category") or "").strip() or None
    is_private        = bool(data.get("is_private", True))
    drive_folder_link = (data.get("drive_folder_link") or "").strip() or None

    if not name:
        return jsonify({"error": "Group name is required"}), 400
    if len(name) > 80:
        return jsonify({"error": "Group name must be 80 characters or fewer"}), 400

    svc = get_service_client()
    new_group_id = None

    # 1. Try create_group RPC first
    try:
        db = current_user_client()
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
    except Exception as rpc_err:
        logger.info("create_group RPC attempt info: %s", rpc_err)

    # 2. Direct insert with service client
    if not new_group_id:
        ins_data = {
            "name": name,
            "description": description,
            "category": category,
            "is_private": is_private,
            "created_by": g.user_id,
        }
        res = None
        # Try insert with drive_folder_link first
        if drive_folder_link:
            try:
                res = svc.table("groups").insert({**ins_data, "drive_folder_link": drive_folder_link}).execute()
            except Exception as e:
                logger.info("Direct insert with drive_folder_link column failed (column may not exist yet): %s", e)
                res = None

        if not res or not res.data:
            try:
                res = svc.table("groups").insert(ins_data).execute()
            except Exception as ins_err:
                logger.error("Direct group insert failed: %s", ins_err)
                return jsonify({"error": f"Failed to create group: {str(ins_err)}"}), 500

        if res and res.data and len(res.data) > 0:
            new_group_id = res.data[0]["id"]
            # Ensure creator is added as admin in group_members
            try:
                svc.table("group_members").insert({
                    "group_id": new_group_id,
                    "user_id": g.user_id,
                    "role": "admin"
                }).execute()
            except Exception as mem_err:
                logger.warning("Could not add creator to group_members: %s", mem_err)

    if not new_group_id:
        return jsonify({"error": "Failed to create group"}), 500

    # 3. Save drive_folder_link if provided
    if drive_folder_link:
        try:
            svc.table("groups").update({"drive_folder_link": drive_folder_link}).eq("id", new_group_id).execute()
        except Exception as e:
            logger.info("Could not update drive_folder_link on group: %s", e)

        try:
            svc.table("group_links").insert({
                "group_id": new_group_id,
                "platform": "drive",
                "title": "Google Drive Archive",
                "url": drive_folder_link,
                "created_by": g.user_id,
            }).execute()
        except Exception as link_err:
            logger.info("Could not insert default drive link: %s", link_err)

    # 4. Return created group object
    try:
        group = svc.table("groups").select("*").eq("id", new_group_id).single().execute()
        g_data = group.data or {}
        g_data["my_role"] = "admin"
        g_data["member_count"] = 1
        if drive_folder_link and not g_data.get("drive_folder_link"):
            g_data["drive_folder_link"] = drive_folder_link
        return jsonify(g_data), 201
    except Exception as fetch_err:
        logger.warning("Could not fetch full group row: %s", fetch_err)
        return jsonify({
            "id": new_group_id,
            "name": name,
            "description": description,
            "category": category,
            "is_private": is_private,
            "drive_folder_link": drive_folder_link,
            "created_by": g.user_id,
            "my_role": "admin",
            "member_count": 1,
        }), 201


@app.route("/api/groups", methods=["GET"])
@login_required
def list_groups():
    """
    Returns all groups the current user is a member of,
    with their role and member count.
    """
    svc = get_service_client()
    try:
        # Fetch memberships for the current user
        memberships = (
            svc.table("group_members")
            .select("role, group_id, groups(*)")
            .eq("user_id", g.user_id)
            .order("joined_at", desc=True)
            .execute()
        )

        groups = []
        for row in (memberships.data or []):
            group_data = row.get("groups")
            if not group_data:
                continue
            group_data["my_role"] = row.get("role", "member")

            # Get member count
            try:
                count_res = (
                    svc.table("group_members")
                    .select("id", count="exact")
                    .eq("group_id", row["group_id"])
                    .execute()
                )
                group_data["member_count"] = count_res.count if count_res.count is not None else 1
            except Exception:
                group_data["member_count"] = 1

            groups.append(group_data)

        return jsonify(groups)
    except Exception as e:
        logger.error("list_groups error: %s", e)
        # Try direct groups lookup where created_by = user
        try:
            created_res = svc.table("groups").select("*").eq("created_by", g.user_id).execute()
            res_groups = []
            for cg in (created_res.data or []):
                cg["my_role"] = "admin"
                cg["member_count"] = 1
                res_groups.append(cg)
            return jsonify(res_groups)
        except Exception:
            return jsonify([]), 200


@app.route("/api/groups/<group_id>", methods=["GET"])
@login_required
def get_group(group_id):
    """
    Returns a single group's details, current user's role,
    and the member list with profiles.
    """
    svc = get_service_client()
    db = current_user_client()

    group_res = None
    try:
        group_res = db.table("groups").select("*").eq("id", group_id).single().execute()
    except Exception:
        pass

    if not group_res or not group_res.data:
        try:
            group_res = svc.table("groups").select("*").eq("id", group_id).single().execute()
        except Exception:
            return jsonify({"error": "Group not found"}), 404

    if not group_res or not group_res.data:
        return jsonify({"error": "Group not found or access denied"}), 404

    group = group_res.data

    # Current user's role
    role = _get_role(db, group_id, g.user_id)
    if not role and group.get("created_by") == g.user_id:
        role = "admin"
    group["my_role"] = role

    # Member list with profile info
    try:
        members_res = (
            svc.table("group_members")
            .select("role, joined_at, user_id, profiles(id, username, display_name, avatar_url)")
            .eq("group_id", group_id)
            .execute()
        )
        group["members"] = members_res.data or []
    except Exception as e:
        logger.warning("Could not fetch members: %s", e)
        group["members"] = []

    # Member count
    group["member_count"] = len(group["members"]) if group["members"] else 1

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
    Any member or creator can create an invite.
    Code expires in 7 days.
    """
    svc = get_service_client()

    # Check if member or creator
    is_mem = _is_member(current_user_client(), group_id, g.user_id)
    if not is_mem:
        try:
            grp = svc.table("groups").select("created_by").eq("id", group_id).single().execute()
            if not grp.data or grp.data.get("created_by") != g.user_id:
                return jsonify({"error": "Not a member of this group"}), 403
        except Exception:
            return jsonify({"error": "Not a member of this group"}), 403

    code = _make_invite_code(8)
    expires_at = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()

    try:
        svc.table("group_invites").insert({
            "group_id":   group_id,
            "code":       code,
            "created_by": g.user_id,
            "expires_at": expires_at,
        }).execute()
    except Exception as ins_err:
        logger.error("Insert into group_invites error: %s", ins_err)
        return jsonify({"error": f"Failed to generate code: {str(ins_err)}"}), 500

    return jsonify({
        "code":       code,
        "expires_at": expires_at,
        "invite_url": f"?invite={code}",
    }), 201

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
# FEED & POSTS
# ════════════════════════════════════════════════════════════

@app.route("/api/feed", methods=["GET"])
@login_required
def get_feed():
    """
    Returns recent posts from all groups the user belongs to,
    plus public posts, ordered chronologically.
    """
    db = current_user_client()
    # Fetch posts respecting RLS
    posts_res = (
        db.table("group_posts")
        .select("id, group_id, author_id, content, media_url, media_type, is_public, created_at, profiles(id, username, display_name, avatar_url), groups(id, name, category, is_private)")
        .order("created_at", desc=True)
        .limit(50)
        .execute()
    )

    posts = posts_res.data or []
    # Count comments for each post
    svc = get_service_client()
    for p in posts:
        c_count = (
            svc.table("post_comments")
            .select("id", count="exact")
            .eq("post_id", p["id"])
            .execute()
        )
        p["comment_count"] = c_count.count if c_count.count is not None else 0

    return jsonify(posts)


@app.route("/api/groups/<group_id>/posts", methods=["GET"])
@login_required
def get_group_posts(group_id):
    """Returns all posts for a specific group (RLS enforced)."""
    db = current_user_client()
    if not _is_member(db, group_id, g.user_id):
        # Allow reading if group is public
        grp = db.table("groups").select("is_private").eq("id", group_id).single().execute()
        if not grp.data or grp.data["is_private"]:
            return jsonify({"error": "Access denied"}), 403

    posts_res = (
        db.table("group_posts")
        .select("id, group_id, author_id, content, media_url, media_type, is_public, created_at, profiles(id, username, display_name, avatar_url)")
        .eq("group_id", group_id)
        .order("created_at", desc=True)
        .execute()
    )
    posts = posts_res.data or []

    svc = get_service_client()
    for p in posts:
        c_count = (
            svc.table("post_comments")
            .select("id", count="exact")
            .eq("post_id", p["id"])
            .execute()
        )
        p["comment_count"] = c_count.count if c_count.count is not None else 0

    return jsonify(posts)


@app.route("/api/groups/<group_id>/posts", methods=["POST"])
@login_required
def create_group_post(group_id):
    """Creates a post in a group. Must be a member."""
    db = current_user_client()
    if not _is_member(db, group_id, g.user_id):
        return jsonify({"error": "Only group members can post"}), 403

    data = request.get_json(force=True)
    content = (data.get("content") or data.get("caption") or "").strip()
    media_url = (data.get("media_url") or "").strip() or None
    media_type = data.get("media_type") or ("image" if media_url else "none")
    is_public = bool(data.get("is_public", False))

    if not content and not media_url:
        return jsonify({"error": "Post must contain text content or media"}), 400

    new_post = {
        "group_id": group_id,
        "author_id": g.user_id,
        "content": content or None,
        "media_url": media_url,
        "media_type": media_type,
        "is_public": is_public,
    }

    res = None
    try:
        res = db.table("group_posts").insert(new_post).execute()
    except Exception as e:
        logger.warning("create_group_post user client insert: %s", e)

    if not res or not res.data:
        svc = get_service_client()
        res = svc.table("group_posts").insert(new_post).execute()

    if not res or not res.data:
        return jsonify({"error": "Failed to create post"}), 500

    post = res.data[0]
    # Attach author profile
    svc = get_service_client()
    try:
        prof = svc.table("profiles").select("id, username, display_name, avatar_url").eq("id", g.user_id).single().execute()
        post["profiles"] = prof.data or {}
    except Exception:
        post["profiles"] = {}
    post["comment_count"] = 0
    return jsonify(post), 201


@app.route("/api/posts/<post_id>/comments", methods=["GET"])
@login_required
def get_post_comments(post_id):
    """Returns comments for a post (RLS enforced)."""
    db = current_user_client()
    comments_res = (
        db.table("post_comments")
        .select("id, post_id, author_id, content, created_at, profiles(id, username, display_name, avatar_url)")
        .eq("post_id", post_id)
        .order("created_at", desc=False)
        .execute()
    )
    return jsonify(comments_res.data or [])


@app.route("/api/posts/<post_id>/comments", methods=["POST"])
@login_required
def add_post_comment(post_id):
    """Adds a comment to a post. User must be member of post's group."""
    db = current_user_client()
    data = request.get_json(force=True)
    content = (data.get("content") or "").strip()
    if not content:
        return jsonify({"error": "Comment cannot be empty"}), 400

    new_c = {
        "post_id": post_id,
        "author_id": g.user_id,
        "content": content,
    }
    res = db.table("post_comments").insert(new_c).execute()
    if not res.data:
        return jsonify({"error": "Failed to add comment"}), 500

    comment = res.data[0]
    prof = db.table("profiles").select("id, username, display_name, avatar_url").eq("id", g.user_id).single().execute()
    comment["profiles"] = prof.data or {}
    return jsonify(comment), 201


# ════════════════════════════════════════════════════════════
# POLLS & VOTING
# ════════════════════════════════════════════════════════════

@app.route("/api/groups/<group_id>/polls", methods=["GET"])
@login_required
def get_group_polls(group_id):
    """Returns all polls for the group with vote counts and user's vote formatted for frontend."""
    svc = get_service_client()
    try:
        polls_res = (
            svc.table("polls")
            .select("id, group_id, question, options, closes_at, created_at, created_by")
            .eq("group_id", group_id)
            .order("created_at", desc=True)
            .execute()
        )
        polls = polls_res.data or []

        # Get votes for these polls
        for p in polls:
            poll_id = p["id"]
            try:
                votes_res = svc.table("poll_votes").select("user_id, option_index").eq("poll_id", poll_id).execute()
                votes = votes_res.data or []
            except Exception:
                votes = []
            total_votes = len(votes)

            raw_options = p.get("options") or []
            tally = {idx: 0 for idx in range(len(raw_options))}
            user_voted_option_id = None

            for v in votes:
                idx = v.get("option_index")
                if idx in tally:
                    tally[idx] += 1
                if str(v.get("user_id")) == str(g.user_id):
                    user_voted_option_id = idx

            # Build options list expected by frontend
            options_list = []
            for i in range(len(raw_options)):
                opt = raw_options[i]
                opt_text = opt if isinstance(opt, str) else str(opt.get("option_text", opt.get("text", opt)))
                v_count = tally.get(i, 0)
                pct = round((v_count / total_votes * 100), 1) if total_votes > 0 else 0
                options_list.append({
                    "id": i,
                    "option_text": opt_text,
                    "vote_count": v_count,
                    "percentage": int(pct),
                })

            p["total_votes"] = total_votes
            p["my_vote"] = user_voted_option_id
            p["user_voted_option_id"] = user_voted_option_id
            p["status"] = "open"
            p["options"] = options_list
            p["tally"] = options_list

        return jsonify(polls)
    except Exception as e:
        logger.error("get_group_polls error: %s", e)
        return jsonify([]), 200


@app.route("/api/groups/<group_id>/polls", methods=["POST"])
@login_required
def create_poll(group_id):
    """Creates a poll in a group."""
    data = request.get_json(force=True)
    question = (data.get("question") or "").strip()
    raw_options = data.get("options") or []
    options = [str(o).strip() for o in raw_options if str(o).strip()]

    if not question:
        return jsonify({"error": "Poll question is required"}), 400
    if len(options) < 2:
        return jsonify({"error": "At least 2 poll options are required"}), 400

    new_poll = {
        "group_id": group_id,
        "created_by": g.user_id,
        "question": question,
        "options": options,
        "closes_at": data.get("closes_at"),
    }

    svc = get_service_client()
    try:
        res = svc.table("polls").insert(new_poll).execute()
        if res.data and len(res.data) > 0:
            return jsonify(res.data[0]), 201
    except Exception as e:
        logger.error("Failed to insert poll: %s", e)
        return jsonify({"error": f"Failed to create poll: {str(e)}"}), 500

    return jsonify({"success": True}), 201


@app.route("/api/polls/<poll_id>/vote", methods=["POST"])
@login_required
def vote_poll(poll_id):
    """Vote on a poll option (1 vote per user). Accepts option_id or option_index."""
    data = request.get_json(force=True)
    raw_idx = data.get("option_index")
    if raw_idx is None:
        raw_idx = data.get("option_id")

    if raw_idx is None:
        return jsonify({"error": "Valid option_id is required"}), 400

    try:
        option_index = int(raw_idx)
    except (ValueError, TypeError):
        return jsonify({"error": "option_id must be a number"}), 400

    svc = get_service_client()
    try:
        # Delete existing vote if any
        try:
            svc.table("poll_votes").delete().eq("poll_id", poll_id).eq("user_id", g.user_id).execute()
        except Exception:
            pass

        # Insert new vote
        svc.table("poll_votes").insert({
            "poll_id": poll_id,
            "user_id": g.user_id,
            "option_index": option_index,
        }).execute()
        return jsonify({"success": True, "poll_id": poll_id, "option_index": option_index})
    except Exception as e:
        logger.error("vote_poll error: %s", e)
        return jsonify({"error": f"Failed to vote: {str(e)}"}), 500


# ════════════════════════════════════════════════════════════
# GROUP ARCHIVE & STORAGE
# ════════════════════════════════════════════════════════════

@app.route("/api/groups/<group_id>/archive", methods=["GET"])
@login_required
def get_group_archive(group_id):
    """Returns archived photos, videos, and files for this group."""
    svc = get_service_client()
    try:
        res = (
            svc.table("group_media_archive")
            .select("id, file_name, file_url, description, created_at, uploaded_by")
            .eq("group_id", group_id)
            .order("created_at", desc=True)
            .execute()
        )
        items = []
        for r in (res.data or []):
            items.append({
                "id": r["id"],
                "title": r.get("description") or r.get("file_name") or "Archive Photo",
                "file_name": r.get("file_name") or "Photo",
                "file_url": r.get("file_url"),
                "created_at": r.get("created_at"),
            })
        return jsonify(items)
    except Exception as e:
        logger.error("get_group_archive error: %s", e)
        return jsonify([]), 200


@app.route("/api/groups/<group_id>/archive", methods=["POST"])
@login_required
def add_group_archive(group_id):
    """Add a photo or media file (or just a titled entry) to group archive."""
    data = request.get_json(force=True) or {}
    title     = (data.get("title") or "").strip()
    file_url  = (data.get("file_url") or "").strip() or None
    file_name = (data.get("file_name") or "").strip() or title or "Group File"

    if not title:
        return jsonify({"error": "title is required"}), 400

    svc = get_service_client()
    try:
        ins = svc.table("group_media_archive").insert({
            "group_id": group_id,
            "uploaded_by": g.user_id,
            "file_name": file_name,
            "file_url": file_url,
            "description": title,
        }).execute()
        return jsonify(ins.data[0] if ins.data else {"success": True}), 201
    except Exception as e:
        logger.error("add_group_archive error: %s", e)
        return jsonify({"error": f"Failed to save archive item: {str(e)}"}), 500


# ════════════════════════════════════════════════════════════
# EXPENSES & SETTLEMENTS
# ════════════════════════════════════════════════════════════

@app.route("/api/groups/<group_id>/expenses", methods=["GET"])
@login_required
def get_group_expenses(group_id):
    """
    Returns expenses for the group with splits and a calculated
    settlement balance summary ("who owes whom").
    """
    db = current_user_client()
    if not _is_member(db, group_id, g.user_id):
        return jsonify({"error": "Access denied"}), 403

    exp_res = (
        db.table("expenses")
        .select("id, group_id, title, amount, currency, split_type, settled, created_at, paid_by, profiles!expenses_paid_by_fkey(id, username, display_name, avatar_url)")
        .eq("group_id", group_id)
        .order("created_at", desc=True)
        .execute()
    )
    expenses = exp_res.data or []

    # Attach splits to each expense
    svc = get_service_client()
    total_spent = 0.0
    net_balances = {}  # user_id -> float

    for exp in expenses:
        splits_res = (
            svc.table("expense_splits")
            .select("id, user_id, amount_owed, settled, profiles(id, username, display_name, avatar_url)")
            .eq("expense_id", exp["id"])
            .execute()
        )
        splits = splits_res.data or []
        exp["splits"] = splits

        amt = float(exp.get("amount") or 0.0)
        total_spent += amt

        paid_by = exp.get("paid_by")
        if paid_by:
            net_balances[paid_by] = net_balances.get(paid_by, 0.0)

        for s in splits:
            owed = float(s.get("amount_owed") or 0.0)
            uid = s.get("user_id")
            if not s.get("settled") and not exp.get("settled"):
                if paid_by:
                    net_balances[paid_by] = net_balances.get(paid_by, 0.0) + owed
                net_balances[uid] = net_balances.get(uid, 0.0) - owed

    # Calculate recommended settlements between debtors and creditors
    debtors = []
    creditors = []
    for uid, bal in net_balances.items():
        if round(bal, 2) < -0.01:
            debtors.append({"user_id": uid, "amount": -bal})
        elif round(bal, 2) > 0.01:
            creditors.append({"user_id": uid, "amount": bal})

    debtors.sort(key=lambda x: x["amount"], reverse=True)
    creditors.sort(key=lambda x: x["amount"], reverse=True)

    settlements = []
    d_idx = 0
    c_idx = 0
    while d_idx < len(debtors) and c_idx < len(creditors):
        deb = debtors[d_idx]
        cred = creditors[c_idx]
        settle_amt = min(deb["amount"], cred["amount"])

        if round(settle_amt, 2) > 0:
            settlements.append({
                "from_user_id": deb["user_id"],
                "to_user_id": cred["user_id"],
                "amount": round(settle_amt, 2),
            })

        deb["amount"] -= settle_amt
        cred["amount"] -= settle_amt

        if round(deb["amount"], 2) <= 0.01:
            d_idx += 1
        if round(cred["amount"], 2) <= 0.01:
            c_idx += 1

    my_balance = round(net_balances.get(g.user_id, 0.0), 2)

    return jsonify({
        "expenses": expenses,
        "summary": {
            "total_spent": round(total_spent, 2),
            "my_balance": my_balance,
            "settlements": settlements,
        }
    })


@app.route("/api/groups/<group_id>/expenses", methods=["POST"])
@login_required
def create_group_expense(group_id):
    """Create an expense with equal or custom split among members."""
    db = current_user_client()
    if not _is_member(db, group_id, g.user_id):
        return jsonify({"error": "Access denied"}), 403

    data = request.get_json(force=True)
    title = (data.get("title") or "").strip()
    try:
        amount = float(data.get("amount") or 0)
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid expense amount"}), 400

    if not title:
        return jsonify({"error": "Expense title is required"}), 400
    if amount <= 0:
        return jsonify({"error": "Amount must be greater than zero"}), 400

    split_type = data.get("split_type") or "equal"
    currency = data.get("currency") or "USD"
    splits_data = data.get("splits") or []

    # Insert expense
    svc = get_service_client()
    exp_res = svc.table("expenses").insert({
        "group_id": group_id,
        "paid_by": g.user_id,
        "title": title,
        "amount": amount,
        "currency": currency,
        "split_type": split_type,
    }).execute()

    if not exp_res.data:
        return jsonify({"error": "Failed to create expense"}), 500

    expense = exp_res.data[0]
    exp_id = expense["id"]

    # Calculate splits
    if split_type == "equal":
        # Split equally among all group members if not specified
        if not splits_data:
            members = svc.table("group_members").select("user_id").eq("group_id", group_id).execute()
            uids = [m["user_id"] for m in (members.data or [])]
        else:
            uids = [s["user_id"] for s in splits_data]

        if not uids:
            uids = [g.user_id]

        share = round(amount / len(uids), 2)
        splits_to_insert = [
            {
                "expense_id": exp_id,
                "user_id": uid,
                "amount_owed": share,
                "settled": uid == g.user_id,  # payer doesn't owe themselves
            }
            for uid in uids
        ]
    else:
        # Custom split
        splits_to_insert = [
            {
                "expense_id": exp_id,
                "user_id": s["user_id"],
                "amount_owed": float(s.get("amount_owed") or 0),
                "settled": s["user_id"] == g.user_id,
            }
            for s in splits_data
        ]

    if splits_to_insert:
        svc.table("expense_splits").insert(splits_to_insert).execute()

    return jsonify(expense), 201


@app.route("/api/expenses/<expense_id>/settle", methods=["POST"])
@login_required
def settle_expense(expense_id):
    """Mark an entire expense and all its splits as settled."""
    svc = get_service_client()
    svc.table("expenses").update({"settled": True}).eq("id", expense_id).execute()
    svc.table("expense_splits").update({"settled": True}).eq("expense_id", expense_id).execute()
    return jsonify({"success": True, "expense_id": expense_id})


@app.route("/api/expense-splits/<split_id>/settle", methods=["POST"])
@login_required
def settle_split(split_id):
    """Mark an individual split as settled."""
    svc = get_service_client()
    svc.table("expense_splits").update({"settled": True}).eq("id", split_id).execute()
    return jsonify({"success": True, "split_id": split_id})


# ════════════════════════════════════════════════════════════
# DECISIONS & PROPOSAL VOTING
# ════════════════════════════════════════════════════════════

@app.route("/api/groups/<group_id>/proposals", methods=["GET"])
@login_required
def get_group_proposals(group_id):
    """Returns proposals with vote counts and user's vote."""
    db = current_user_client()
    if not _is_member(db, group_id, g.user_id):
        return jsonify({"error": "Access denied"}), 403

    prop_res = (
        db.table("proposals")
        .select("id, group_id, type, target_user_id, target_post_id, status, created_at, profiles!proposals_created_by_fkey(id, username, display_name)")
        .eq("group_id", group_id)
        .order("created_at", desc=True)
        .execute()
    )
    proposals = prop_res.data or []

    # Get total group members count for passing threshold (> 50%)
    svc = get_service_client()
    m_count_res = svc.table("group_members").select("id", count="exact").eq("group_id", group_id).execute()
    member_count = m_count_res.count or 1

    for p in proposals:
        votes_res = svc.table("proposal_votes").select("user_id, vote").eq("proposal_id", p["id"]).execute()
        votes = votes_res.data or []

        yes_count = sum(1 for v in votes if v["vote"] == "yes")
        no_count = sum(1 for v in votes if v["vote"] == "no")
        my_vote = next((v["vote"] for v in votes if v["user_id"] == g.user_id), None)

        p["yes_votes"] = yes_count
        p["no_votes"] = no_count
        p["total_members"] = member_count
        p["required_yes"] = (member_count // 2) + 1
        p["my_vote"] = my_vote

        # If target user or post is attached, get detail
        if p.get("target_user_id"):
            u_res = svc.table("profiles").select("id, username, display_name").eq("id", p["target_user_id"]).single().execute()
            p["target_user"] = u_res.data
        if p.get("target_post_id"):
            post_res = svc.table("group_posts").select("id, content").eq("id", p["target_post_id"]).single().execute()
            p["target_post"] = post_res.data

    return jsonify(proposals)


@app.route("/api/groups/<group_id>/proposals", methods=["POST"])
@login_required
def create_proposal(group_id):
    """Create a decision proposal (e.g. add/remove member, publish post)."""
    db = current_user_client()
    if not _is_member(db, group_id, g.user_id):
        return jsonify({"error": "Access denied"}), 403

    data = request.get_json(force=True)
    prop_type = data.get("type")
    if prop_type not in ("add_member", "remove_member", "publish_post"):
        return jsonify({"error": "Invalid proposal type"}), 400

    new_prop = {
        "group_id": group_id,
        "type": prop_type,
        "target_user_id": data.get("target_user_id"),
        "target_post_id": data.get("target_post_id"),
        "created_by": g.user_id,
        "status": "open",
    }

    svc = get_service_client()
    res = svc.table("proposals").insert(new_prop).execute()
    if not res.data:
        return jsonify({"error": "Failed to create proposal"}), 500

    prop = res.data[0]
    # Creator automatically votes 'yes'
    svc.table("proposal_votes").insert({
        "proposal_id": prop["id"],
        "user_id": g.user_id,
        "vote": "yes",
    }).execute()

    return jsonify(prop), 201


@app.route("/api/proposals/<proposal_id>/vote", methods=["POST"])
@login_required
def vote_proposal(proposal_id):
    """Vote yes or no on a proposal and trigger resolution check."""
    data = request.get_json(force=True)
    vote = data.get("vote")
    if vote not in ("yes", "no"):
        return jsonify({"error": "Vote must be 'yes' or 'no'"}), 400

    svc = get_service_client()
    prop_res = svc.table("proposals").select("id, group_id, status").eq("id", proposal_id).single().execute()
    if not prop_res.data or prop_res.data["status"] != "open":
        return jsonify({"error": "Proposal is closed or does not exist"}), 400

    group_id = prop_res.data["group_id"]
    db = current_user_client()
    if not _is_member(db, group_id, g.user_id):
        return jsonify({"error": "Access denied"}), 403

    svc.table("proposal_votes").upsert({
        "proposal_id": proposal_id,
        "user_id": g.user_id,
        "vote": vote,
    }).execute()

    # Trigger resolve_proposal() RPC function to check if passing threshold is met
    res = svc.rpc("resolve_proposal", {"p_proposal_id": proposal_id}).execute()
    outcome = res.data

    return jsonify({"success": True, "proposal_id": proposal_id, "vote": vote, "outcome": outcome})




@app.route("/api/groups/<group_id>/drive", methods=["PUT"])
@login_required
def update_group_drive(group_id):
    """Update the Google Drive folder link for a group."""
    db = current_user_client()
    role = _get_role(db, group_id, g.user_id)
    if role != "admin":
        return jsonify({"error": "Only admins can update the group Drive link"}), 403

    data = request.get_json(force=True)
    drive_link = (data.get("drive_folder_link") or data.get("folder_url") or "").strip() or None

    svc = get_service_client()
    svc.table("groups").update({"drive_folder_link": drive_link}).eq("id", group_id).execute()
    return jsonify({"success": True, "drive_folder_link": drive_link, "folder_url": drive_link})


# ════════════════════════════════════════════════════════════
# EXTERNAL APPLICATION LINKS
# ════════════════════════════════════════════════════════════

@app.route("/api/groups/<group_id>/links", methods=["GET"])
@login_required
def get_group_links(group_id):
    """Returns external links for this group."""
    db = current_user_client()
    if not _is_member(db, group_id, g.user_id):
        return jsonify({"error": "Access denied"}), 403

    res = db.table("external_links").select("*").eq("group_id", group_id).order("created_at", desc=False).execute()
    return jsonify(res.data or [])


@app.route("/api/groups/<group_id>/links", methods=["POST"])
@login_required
def add_group_link(group_id):
    """Add an external link (WhatsApp, Discord, Drive, Instagram, Telegram, etc.)."""
    db = current_user_client()
    if not _is_member(db, group_id, g.user_id):
        return jsonify({"error": "Access denied"}), 403

    data = request.get_json(force=True)
    platform = (data.get("platform") or "other").strip().lower()
    label = (data.get("label") or "").strip() or platform.capitalize()
    url = (data.get("url") or "").strip()

    if not url:
        return jsonify({"error": "Link URL is required"}), 400

    new_link = {
        "group_id": group_id,
        "platform": platform,
        "label": label,
        "url": url,
        "added_by": g.user_id,
    }

    res = db.table("external_links").insert(new_link).execute()
    if not res.data:
        return jsonify({"error": "Failed to add external link"}), 500

    # If WhatsApp, also sync to groups.whatsapp_link for fast access
    if platform == "whatsapp":
        svc = get_service_client()
        svc.table("groups").update({"whatsapp_link": url}).eq("id", group_id).execute()

    return jsonify(res.data[0]), 201


@app.route("/api/groups/<group_id>/links/<link_id>", methods=["DELETE"])
@login_required
def delete_group_link(group_id, link_id):
    """Delete an external link."""
    db = current_user_client()
    if not _is_member(db, group_id, g.user_id):
        return jsonify({"error": "Access denied"}), 403

    svc = get_service_client()
    svc.table("external_links").delete().eq("id", link_id).eq("group_id", group_id).execute()
    return jsonify({"success": True})


# ════════════════════════════════════════════════════════════
# EXPLORE & PUBLIC DISCOVERY
# ════════════════════════════════════════════════════════════

@app.route("/api/explore", methods=["GET"])
@login_required
def explore():
    """
    Explore public groups and public posts.
    Supports category filter and keyword search.
    Never exposes private groups or private data.
    """
    category = (request.args.get("category") or "").strip().lower()
    query = (request.args.get("q") or "").strip()

    db = current_user_client()

    # Query public groups
    grp_q = db.table("groups").select("id, name, description, category, is_private, cover_url, created_at").eq("is_private", False)
    if category:
        grp_q = grp_q.eq("category", category)
    if query:
        grp_q = grp_q.ilike("name", f"%{query}%")

    public_groups = grp_q.limit(20).execute().data or []

    # Attach member count
    svc = get_service_client()
    for g_item in public_groups:
        count_res = svc.table("group_members").select("id", count="exact").eq("group_id", g_item["id"]).execute()
        g_item["member_count"] = count_res.count or 1

    # Query public posts
    posts_q = db.table("group_posts").select("id, group_id, content, media_url, media_type, created_at, profiles(id, display_name, username, avatar_url), groups(id, name)").eq("is_public", True)
    if query:
        posts_q = posts_q.ilike("content", f"%{query}%")

    public_posts = posts_q.order("created_at", desc=True).limit(20).execute().data or []

    return jsonify({
        "groups": public_groups,
        "posts": public_posts,
    })


# ════════════════════════════════════════════════════════════
# RUN
# ════════════════════════════════════════════════════════════

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)

