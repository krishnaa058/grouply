/**
 * app.js — Grouply Main App Controller (Milestone 1 + 2)
 *
 * Handles:
 * - Route guard + auth state
 * - Tab switching
 * - Profile load + render
 * - Groups: load, render cards, create, open detail sheet
 * - Group detail: members, invite code, WhatsApp link
 * - Join by invite code
 * - Chat tab: list groups with WhatsApp links
 */

import {
  getSession, onAuthStateChange, signOut, callApiJson, callApi,
} from "./frontend_auth.js";

// ── Tiny helpers ──────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const CATEGORY_META = {
  travel:   { emoji: "✈️",  label: "Travel",   gradient: "linear-gradient(135deg,#1e3a5f,#2d6a4f)" },
  sports:   { emoji: "⚽",  label: "Sports",   gradient: "linear-gradient(135deg,#7f1d1d,#b45309)" },
  music:    { emoji: "🎵",  label: "Music",    gradient: "linear-gradient(135deg,#4c1d95,#6d28d9)" },
  food:     { emoji: "🍕",  label: "Food",     gradient: "linear-gradient(135deg,#78350f,#dc2626)" },
  gaming:   { emoji: "🎮",  label: "Gaming",   gradient: "linear-gradient(135deg,#064e3b,#065f46)" },
  art:      { emoji: "🎨",  label: "Art",      gradient: "linear-gradient(135deg,#831843,#9d174d)" },
  outdoors: { emoji: "🏔️", label: "Outdoors", gradient: "linear-gradient(135deg,#1e3a2f,#166534)" },
  tech:     { emoji: "💻",  label: "Tech",     gradient: "linear-gradient(135deg,#172554,#1e40af)" },
  other:    { emoji: "📦",  label: "Other",    gradient: "linear-gradient(135deg,#292524,#44403c)" },
};

function getCategoryMeta(cat) {
  return CATEGORY_META[cat] || CATEGORY_META.other;
}

function getInitial(name) {
  return (name || "?")[0].toUpperCase();
}

function setLoading(btnId, loading, originalText) {
  const btn = $(btnId);
  if (!btn) return;
  if (loading) {
    btn.dataset.origText = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';
    btn.disabled = true;
  } else {
    btn.innerHTML = originalText || btn.dataset.origText || btn.innerHTML;
    btn.disabled = false;
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser    = null;
let currentProfile = null;
let myGroups       = [];          // [{id, name, my_role, member_count, ...}]
let activeGroupId  = null;        // the group whose detail sheet is open

// ── Route guard ───────────────────────────────────────────────────────────────
(async () => {
  const session = await getSession();
  if (!session) { window.location.href = "login.html"; return; }
  currentUser = session.user;
  await loadProfile();
  await loadMyGroups();
  checkInviteCodeInUrl();
})();

onAuthStateChange(async (event, session) => {
  if (event === "SIGNED_OUT")                        { window.location.href = "login.html"; return; }
  if ((event === "TOKEN_REFRESHED" || event === "SIGNED_IN") && session) {
    currentUser = session.user;
  }
});

// ── Profile ───────────────────────────────────────────────────────────────────
async function loadProfile() {
  try {
    currentProfile = await callApiJson("/api/me");
    if (!currentProfile.display_name) {
      window.location.href = "onboarding.html"; return;
    }
    renderProfile(currentProfile);
  } catch (err) {
    if (err?.status === 401) { window.location.href = "login.html"; }
    console.warn("Could not load profile:", err);
  }
}

function renderProfile(profile) {
  let avatarEl = $("profile-avatar");
  if (avatarEl) {
    if (profile.avatar_url) {
      if (avatarEl.tagName === "IMG") {
        avatarEl.src = profile.avatar_url;
      } else {
        const img = document.createElement("img");
        img.id = "profile-avatar";
        img.src = profile.avatar_url;
        img.alt = profile.display_name || "Profile";
        img.className = "avatar avatar-xl";
        img.style.cssText = "width:96px;height:96px;object-fit:cover;border-radius:50%";
        avatarEl.replaceWith(img);
      }
    } else {
      if (avatarEl.tagName === "IMG") {
        const div = document.createElement("div");
        div.id = "profile-avatar";
        div.className = "avatar avatar-xl";
        div.textContent = getInitial(profile.display_name);
        avatarEl.replaceWith(div);
      } else {
        avatarEl.textContent = getInitial(profile.display_name);
      }
    }
  }
  const dn = $("profile-display-name");
  const un = $("profile-username");
  const bio = $("profile-bio");
  if (dn)  dn.textContent  = profile.display_name || profile.username;
  if (un)  un.textContent  = `@${profile.username}`;
  if (bio) bio.textContent = profile.bio || "";
}

// ── Groups: load + render ─────────────────────────────────────────────────────
async function loadMyGroups() {
  try {
    myGroups = await callApiJson("/api/groups");
  } catch (err) {
    console.warn("Could not load groups:", err);
    myGroups = [];
  }
  renderGroupsTab();
  renderProfileTab();
  renderChatTab();
}

// ---------- Groups tab ----------
function renderGroupsTab() {
  const emptyEl = $("groups-empty");
  const listEl  = $("groups-list");

  if (!myGroups.length) {
    emptyEl.style.display = "flex";
    listEl.classList.add("hidden");
    return;
  }

  emptyEl.style.display = "none";
  listEl.classList.remove("hidden");
  listEl.innerHTML = "";

  myGroups.forEach((g) => {
    listEl.appendChild(buildGroupCard(g, "groups"));
  });
}

// ---------- Profile tab "flex" (Milestone 3) ----------
function renderProfileTab() {
  const countEl      = $("profile-groups-count");
  const adminCountEl = $("profile-admin-count");
  const catCountEl   = $("profile-categories-count");
  const emptyEl      = $("profile-empty-groups");
  const listEl       = $("profile-groups-list");

  const totalGroups = myGroups.length;
  const adminGroups = myGroups.filter((g) => g.my_role === "admin").length;
  const uniqueCats  = new Set(myGroups.map((g) => g.category).filter(Boolean)).size;

  if (countEl)      countEl.textContent      = totalGroups;
  if (adminCountEl) adminCountEl.textContent = adminGroups;
  if (catCountEl)   catCountEl.textContent   = uniqueCats;

  if (!listEl) return;

  if (totalGroups === 0) {
    if (emptyEl) emptyEl.classList.remove("hidden");
    listEl.innerHTML = "";
    return;
  }

  if (emptyEl) emptyEl.classList.add("hidden");
  listEl.innerHTML = "";
  myGroups.forEach((g) => {
    listEl.appendChild(buildGroupCard(g, "profile"));
  });
}

// ---------- Chat tab ----------
function renderChatTab() {
  const noGroupsState   = $("chat-no-groups-state");
  const groupsState     = $("chat-groups-state");
  const chatListEl      = $("chat-groups-list");

  const groupsWithWA = myGroups.filter(g => g.whatsapp_link);

  if (!myGroups.length) {
    noGroupsState.classList.remove("hidden");
    groupsState.classList.add("hidden");
    return;
  }

  noGroupsState.classList.add("hidden");
  groupsState.classList.remove("hidden");
  chatListEl.innerHTML = "";

  myGroups.forEach((g) => {
    const meta = getCategoryMeta(g.category);
    const hasWA = !!g.whatsapp_link;

    const card = document.createElement("div");
    card.style.cssText = `
      background:var(--bg-card);border:1px solid var(--border-subtle);
      border-radius:var(--radius-lg);padding:14px 16px;
      display:flex;align-items:center;gap:12px;cursor:pointer;
      transition:transform 0.2s ease,box-shadow 0.2s ease;
    `;
    card.innerHTML = `
      <div style="
        width:44px;height:44px;border-radius:var(--radius-md);flex-shrink:0;
        ${meta.gradient};display:flex;align-items:center;justify-content:center;
        font-size:1.3rem">${meta.emoji}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:0.95rem;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(g.name)}</div>
        <div style="font-size:0.78rem;color:var(--text-muted);margin-top:2px">
          ${g.member_count} member${g.member_count === 1 ? "" : "s"}
          ${g.my_role === "admin" ? " · Admin" : ""}
        </div>
      </div>
      ${hasWA
        ? `<span style="font-size:1.3rem" title="WhatsApp linked">💬</span>`
        : `<span style="font-size:0.75rem;color:var(--text-muted)">No WA link</span>`}
    `;

    card.addEventListener("mouseenter", () => { card.style.transform = "translateY(-2px)"; });
    card.addEventListener("mouseleave", () => { card.style.transform = ""; });

    if (hasWA) {
      card.addEventListener("click", () => {
        window.open(g.whatsapp_link, "_blank", "noopener,noreferrer");
      });
    } else {
      card.addEventListener("click", () => openGroupDetail(g.id));
      card.title = "Open group to add WhatsApp link";
    }

    chatListEl.appendChild(card);
  });

  if (!groupsWithWA.length) {
    const note = document.createElement("p");
    note.style.cssText = "color:var(--text-muted);font-size:0.82rem;padding:8px 4px;text-align:center";
    note.textContent = "None of your groups have a WhatsApp link yet. Open a group to add one.";
    chatListEl.appendChild(note);
  }
}

// ---------- Shared group card builder ----------
function buildGroupCard(g, context) {
  const meta = getCategoryMeta(g.category);

  const card = document.createElement("div");
  card.className = "group-card";
  card.dataset.groupId = g.id;

  card.innerHTML = `
    <div class="group-card-cover"
         style="${meta.gradient};display:flex;align-items:center;
                justify-content:center;font-size:2.5rem"
         aria-hidden="true">${meta.emoji}</div>
    <div class="group-card-body">
      <div class="group-card-name">${escHtml(g.name)}</div>
      <div class="group-card-meta">
        <span>${g.member_count} member${g.member_count === 1 ? "" : "s"}</span>
        ${g.category ? `<span>·</span><span>${escHtml(meta.label)}</span>` : ""}
        ${g.is_private ? `<span>·</span><span>🔒 Private</span>` : `<span>·</span><span>🌐 Public</span>`}
        ${g.my_role === "admin" ? `<span>·</span><span style="color:var(--brand-400)">Admin</span>` : ""}
      </div>
    </div>
  `;

  card.addEventListener("click", () => openGroupDetail(g.id));
  return card;
}

// ── Group Detail Sheet ────────────────────────────────────────────────────────
async function openGroupDetail(groupId) {
  activeGroupId = groupId;
  const modal = $("group-detail-modal");

  // Show immediately with loading state
  modal.classList.add("open");
  $("gd-members-list").innerHTML = `<div style="color:var(--text-muted);font-size:0.875rem">Loading…</div>`;
  $("gd-invite-result").classList.add("hidden");

  try {
    const g = await callApiJson(`/api/groups/${groupId}`);
    const meta = getCategoryMeta(g.category);

    // Header
    $("gd-title").textContent  = g.name;
    $("gd-name").textContent   = g.name;
    $("gd-cover").style.background = meta.gradient;
    $("gd-category-emoji").textContent  = meta.emoji;
    $("gd-category-label").textContent  = g.category ? meta.label : "";

    // Badges
    $("gd-privacy-badge").textContent  = g.is_private ? "🔒 Private" : "🌐 Public";
    $("gd-member-badge").textContent   = `${g.member_count} member${g.member_count === 1 ? "" : "s"}`;
    const roleBadge = $("gd-role-badge");
    if (g.my_role === "admin") {
      roleBadge.textContent = "⭐ Admin";
      roleBadge.style.display = "inline-flex";
      roleBadge.style.background = "rgba(251,191,36,0.15)";
      roleBadge.style.color = "var(--accent-amber)";
    } else {
      roleBadge.style.display = "none";
    }

    // Description
    const descEl = $("gd-description");
    if (g.description) {
      descEl.textContent = g.description;
      descEl.style.display = "block";
    } else {
      descEl.style.display = "none";
    }

    // WhatsApp button
    const waBtn = $("gd-whatsapp-btn");
    if (g.whatsapp_link) {
      waBtn.href = g.whatsapp_link;
      waBtn.classList.remove("hidden");
    } else {
      waBtn.classList.add("hidden");
    }

    // Members list
    renderMembersList(g.members || []);

  } catch (err) {
    $("gd-members-list").innerHTML =
      `<div style="color:var(--error);font-size:0.875rem">Failed to load group details.</div>`;
    console.error("loadGroupDetail error:", err);
  }
}

function renderMembersList(members) {
  const listEl = $("gd-members-list");
  listEl.innerHTML = "";

  if (!members.length) {
    listEl.innerHTML = `<div style="color:var(--text-muted);font-size:0.85rem">No members yet</div>`;
    return;
  }

  members.forEach((m) => {
    const profile = m.profiles || {};
    const name    = profile.display_name || profile.username || "Unknown";
    const isAdmin = m.role === "admin";
    const userId  = m.user_id || profile.id;

    const row = document.createElement("div");
    row.style.cssText = `
      display:flex;align-items:center;gap:10px;padding:6px 8px;
      border-radius:var(--radius-sm);cursor:pointer;
      transition:background 0.15s ease;
    `;
    row.title = "View profile & circles";
    row.addEventListener("mouseenter", () => { row.style.background = "var(--bg-input)"; });
    row.addEventListener("mouseleave", () => { row.style.background = ""; });

    row.innerHTML = `
      <div class="avatar avatar-sm">
        ${profile.avatar_url
          ? `<img src="${escHtml(profile.avatar_url)}" alt="${escHtml(name)}"
                  style="width:32px;height:32px;border-radius:50%;object-fit:cover">`
          : getInitial(name)}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:0.88rem;font-weight:600;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(name)}</div>
        <div style="font-size:0.72rem;color:var(--text-muted)">
          @${escHtml(profile.username || "")}
        </div>
      </div>
      ${isAdmin ? `<span class="badge" style="background:rgba(251,191,36,0.15);color:var(--accent-amber)">Admin</span>` : ""}
      <span style="font-size:0.75rem;color:var(--text-muted)">›</span>
    `;

    if (userId) {
      row.addEventListener("click", () => openUserProfileModal(userId));
    }

    listEl.appendChild(row);
  });
}

// Invite code generation
$("gd-invite-btn").addEventListener("click", async () => {
  if (!activeGroupId) return;
  setLoading("gd-invite-btn", true);
  try {
    const data = await callApiJson(`/api/groups/${activeGroupId}/invite`, { method: "POST" });
    $("gd-invite-code").textContent = data.code;
    $("gd-invite-result").classList.remove("hidden");
  } catch (err) {
    console.error("Invite error:", err);
    alert("Could not generate invite link. Try again.");
  }
  setLoading("gd-invite-btn", false, "🔗 Generate Invite Link");
});

// Copy code to clipboard
$("gd-copy-btn").addEventListener("click", () => {
  const code = $("gd-invite-code").textContent;
  navigator.clipboard.writeText(code).then(() => {
    $("gd-copy-btn").textContent = "Copied!";
    setTimeout(() => { $("gd-copy-btn").textContent = "Copy"; }, 2000);
  });
});

// Close detail sheet
$("group-detail-close").addEventListener("click", () => {
  $("group-detail-modal").classList.remove("open");
  activeGroupId = null;
});
$("group-detail-modal").addEventListener("click", (e) => {
  if (e.target === $("group-detail-modal")) {
    $("group-detail-modal").classList.remove("open");
    activeGroupId = null;
  }
});

// ── Join by Code Modal ────────────────────────────────────────────────────────
function openJoinCodeModal() {
  $("join-code-modal").classList.add("open");
  $("join-code-input").value = "";
  $("join-code-alert").className = "alert";
  $("join-code-input").focus();
}

function closeJoinCodeModal() {
  $("join-code-modal").classList.remove("open");
}

$("open-join-code-btn").addEventListener("click", openJoinCodeModal);
$("join-code-close").addEventListener("click", closeJoinCodeModal);
$("join-code-close-link").addEventListener("click", closeJoinCodeModal);
$("join-code-modal").addEventListener("click", (e) => {
  if (e.target === $("join-code-modal")) closeJoinCodeModal();
});

// Auto-uppercase as user types
$("join-code-input").addEventListener("input", (e) => {
  const pos = e.target.selectionStart;
  e.target.value = e.target.value.toUpperCase();
  e.target.setSelectionRange(pos, pos);
});

$("join-code-submit").addEventListener("click", async () => {
  const code = $("join-code-input").value.trim().toUpperCase();
  const alertEl = $("join-code-alert");

  if (code.length < 4) {
    alertEl.textContent = "Enter the invite code (8 characters).";
    alertEl.className = "alert alert-error show";
    return;
  }

  setLoading("join-code-submit", true);
  try {
    const data = await callApiJson("/api/groups/join-by-code", {
      method: "POST",
      body: { code },
    });
    alertEl.textContent = `✅ Joined "${data.group?.name}"!`;
    alertEl.className = "alert alert-success show";
    await loadMyGroups();
    setTimeout(() => {
      closeJoinCodeModal();
      switchTab("groups");
    }, 1500);
  } catch (err) {
    alertEl.textContent = err.data?.error || err.message || "Invalid or expired code.";
    alertEl.className = "alert alert-error show";
  }
  setLoading("join-code-submit", false, "Join Group 🚀");
});

// Check if URL has ?invite=CODE on load
function checkInviteCodeInUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("invite");
  if (code) {
    $("join-code-input").value = code.toUpperCase();
    openJoinCodeModal();
    // Clean URL
    window.history.replaceState({}, "", window.location.pathname);
  }
}

// ── Create Group Modal ────────────────────────────────────────────────────────
const createModal = $("create-group-modal");

function openCreateGroup() {
  createModal.classList.add("open");
  $("cg-name").focus();
}

function closeCreateGroup() {
  createModal.classList.remove("open");
  $("cg-name").value   = "";
  $("cg-desc").value   = "";
  $("cg-category").value = "";
  $("cg-private").checked = true;
  $("cg-name-err").classList.remove("show");
  $("cg-name").classList.remove("error");
  $("create-group-alert").className = "alert";
  $("create-group-alert").textContent = "";
}

$("create-group-close").addEventListener("click", closeCreateGroup);
$("create-group-btn-empty").addEventListener("click", openCreateGroup);
$("fab-create-group").addEventListener("click", openCreateGroup);
createModal.addEventListener("click", (e) => { if (e.target === createModal) closeCreateGroup(); });

$("create-group-submit").addEventListener("click", async () => {
  const name       = $("cg-name").value.trim();
  const desc       = $("cg-desc").value.trim();
  const category   = $("cg-category").value;
  const is_private = $("cg-private").checked;
  const alertEl    = $("create-group-alert");

  if (!name) {
    $("cg-name-err").textContent = "Group name is required";
    $("cg-name-err").classList.add("show");
    $("cg-name").classList.add("error");
    return;
  }
  $("cg-name-err").classList.remove("show");
  $("cg-name").classList.remove("error");

  setLoading("create-group-submit", true);
  alertEl.className = "alert";

  try {
    const group = await callApiJson("/api/groups", {
      method: "POST",
      body: { name, description: desc || null, category: category || null, is_private },
    });

    alertEl.textContent = `✅ "${group.name}" created!`;
    alertEl.className   = "alert alert-success show";

    await loadMyGroups();

    setTimeout(() => {
      closeCreateGroup();
      switchTab("groups");
    }, 900);
  } catch (err) {
    alertEl.textContent = err.data?.error || err.message || "Failed to create group.";
    alertEl.className   = "alert alert-error show";
    setLoading("create-group-submit", false, "Create Group 🎉");
  }
});

// ── Tab switching ─────────────────────────────────────────────────────────────
const TAB_CFG = {
  feed:    { title: null,      logo: true,  action: false },
  explore: { title: "Explore", logo: false, action: false },
  groups:  { title: "Groups",  logo: false, action: true,  actionLabel: "＋" },
  chat:    { title: "Chat",    logo: false, action: false },
  profile: { title: "Profile", logo: false, action: false },
};

function switchTab(tabName) {
  document.querySelectorAll(".tab-item").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".screen").forEach((s)  => s.classList.remove("active"));

  $(`tab-${tabName}`).classList.add("active");
  $(`screen-${tabName}`).classList.add("active");

  const cfg     = TAB_CFG[tabName];
  const logoEl  = $("topbar-logo");
  const titleEl = $("topbar-title");
  const actEl   = $("topbar-action");

  if (cfg.logo) {
    logoEl.classList.remove("hidden");
    titleEl.classList.add("hidden");
  } else {
    logoEl.classList.add("hidden");
    titleEl.textContent = cfg.title;
    titleEl.classList.remove("hidden");
  }

  actEl.classList.toggle("hidden", !cfg.action);
  if (cfg.action) actEl.textContent = cfg.actionLabel || "＋";

  $("fab-create-group").classList.toggle("hidden", tabName !== "groups");
}

document.querySelectorAll(".tab-item").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

$("topbar-action").addEventListener("click", openCreateGroup);

// Chat tab "View my groups" button
$("chat-go-groups").addEventListener("click", () => switchTab("groups"));

// ── Sign out ──────────────────────────────────────────────────────────────────
$("signout-btn").addEventListener("click", async () => { await signOut(); });

// ── Explore category tiles ────────────────────────────────────────────────────
document.querySelectorAll(".category-tile").forEach((tile) => {
  tile.addEventListener("click", () => {
    const cat      = tile.dataset.category;
    const resultsEl = $("explore-results");
    const titleEl   = $("explore-results-title");
    titleEl.textContent = (CATEGORY_META[cat]?.label || cat) + " groups";
    resultsEl.style.display = "block";
    $("explore-results-list").innerHTML =
      `<p class="text-muted" style="text-align:center;padding:20px 0">
         Public group discovery coming in Milestone 10.
       </p>`;
  });
});

$("explore-search").addEventListener("input", (e) => {
  // Full search in Milestone 10
  console.log("Search:", e.target.value.trim());
});

// ── Member Profile Modal (Milestone 3 — The Flex) ────────────────────────────
async function openUserProfileModal(userId) {
  const modal = $("user-profile-modal");
  modal.classList.add("open");
  $("user-profile-loading").classList.remove("hidden");
  $("user-profile-content").classList.add("hidden");

  try {
    const data = await callApiJson(`/api/profiles/${userId}`);
    const prof = data.profile;
    const totalCount = data.total_groups_count || 0;
    const visibleGroups = data.visible_groups || [];

    // Render avatar
    const av = $("up-avatar");
    if (prof.avatar_url) {
      av.innerHTML = `<img src="${escHtml(prof.avatar_url)}" alt="${escHtml(prof.display_name || prof.username)}" style="width:96px;height:96px;border-radius:50%;object-fit:cover">`;
    } else {
      av.textContent = getInitial(prof.display_name || prof.username);
    }

    $("up-display-name").textContent = prof.display_name || prof.username;
    $("up-username").textContent = `@${prof.username}`;
    $("up-bio").textContent = prof.bio || "No bio yet.";
    $("up-groups-count").textContent = totalCount;
    $("up-shared-count").textContent = visibleGroups.length;

    const listEl = $("up-groups-list");
    listEl.innerHTML = "";

    if (!visibleGroups.length) {
      listEl.innerHTML = `
        <div style="text-align:center;padding:24px 12px;color:var(--text-muted);font-size:0.85rem">
          🔒 Private circles only (not shared with you).
        </div>`;
    } else {
      visibleGroups.forEach((g) => {
        const meta = getCategoryMeta(g.category);
        const card = document.createElement("div");
        card.className = "group-card";
        card.dataset.groupId = g.id;
        card.innerHTML = `
          <div class="group-card-cover"
               style="${meta.gradient};display:flex;align-items:center;justify-content:center;font-size:2.2rem"
               aria-hidden="true">${meta.emoji}</div>
          <div class="group-card-body">
            <div class="group-card-name">${escHtml(g.name)}</div>
            <div class="group-card-meta">
              <span>${meta.label}</span>
              <span>·</span>
              <span>${g.is_private ? "🔒 Private" : "🌐 Public"}</span>
              ${g.role === "admin" ? `<span>·</span><span style="color:var(--accent-amber)">Admin</span>` : ""}
            </div>
          </div>
        `;
        card.addEventListener("click", () => {
          modal.classList.remove("open");
          openGroupDetail(g.id);
        });
        listEl.appendChild(card);
      });
    }

    $("user-profile-loading").classList.add("hidden");
    $("user-profile-content").classList.remove("hidden");
  } catch (err) {
    $("user-profile-loading").innerHTML =
      `<div style="color:var(--error);font-size:0.875rem">Could not load member profile.</div>`;
    console.error("openUserProfileModal error:", err);
  }
}

$("user-profile-close").addEventListener("click", () => {
  $("user-profile-modal").classList.remove("open");
});
$("user-profile-modal").addEventListener("click", (e) => {
  if (e.target === $("user-profile-modal")) $("user-profile-modal").classList.remove("open");
});

// ── Edit Profile Modal (Milestone 3) ──────────────────────────────────────────
let editUsernameTimer = null;
let editUsernameValid = true;

function openEditProfile() {
  if (!currentProfile) return;
  const modal = $("edit-profile-modal");
  $("ep-display-name").value = currentProfile.display_name || "";
  $("ep-username").value     = currentProfile.username || "";
  $("ep-bio").value          = currentProfile.bio || "";
  $("ep-avatar-url").value   = currentProfile.avatar_url || "";

  $("ep-display-name-err").classList.remove("show");
  $("ep-username-err").classList.remove("show");
  $("edit-profile-alert").className = "alert";
  $("edit-profile-alert").textContent = "";

  editUsernameValid = true;
  modal.classList.add("open");
  $("ep-display-name").focus();
}

function closeEditProfile() {
  $("edit-profile-modal").classList.remove("open");
}

$("profile-edit-btn").addEventListener("click", openEditProfile);
$("edit-profile-close").addEventListener("click", closeEditProfile);
$("edit-profile-cancel-btn").addEventListener("click", closeEditProfile);
$("edit-profile-modal").addEventListener("click", (e) => {
  if (e.target === $("edit-profile-modal")) closeEditProfile();
});

// Live username availability check on edit
$("ep-username").addEventListener("input", (e) => {
  const raw = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "");
  e.target.value = raw;
  clearTimeout(editUsernameTimer);

  const errEl = $("ep-username-err");
  if (!raw) {
    errEl.textContent = "Username is required";
    errEl.classList.add("show");
    editUsernameValid = false;
    return;
  }
  if (raw.length < 3 || raw.length > 30) {
    errEl.textContent = "Must be 3–30 characters";
    errEl.classList.add("show");
    editUsernameValid = false;
    return;
  }

  // If unchanged from current profile username, it's valid
  if (currentProfile && raw === currentProfile.username) {
    errEl.classList.remove("show");
    editUsernameValid = true;
    return;
  }

  errEl.textContent = "Checking availability…";
  errEl.className = "form-error show";
  errEl.style.color = "var(--text-muted)";

  editUsernameTimer = setTimeout(async () => {
    try {
      const res = await callApiJson(`/api/username/check?username=${encodeURIComponent(raw)}`);
      if (res.available) {
        errEl.textContent = "✓ Username available";
        errEl.style.color = "var(--success)";
        editUsernameValid = true;
      } else {
        errEl.textContent = "✗ Username already taken";
        errEl.style.color = "var(--error)";
        editUsernameValid = false;
      }
    } catch {
      errEl.classList.remove("show");
      editUsernameValid = true;
    }
  }, 400);
});

// Save Profile Submit
$("edit-profile-submit").addEventListener("click", async () => {
  const displayName = $("ep-display-name").value.trim();
  const username    = $("ep-username").value.trim().toLowerCase();
  const bio         = $("ep-bio").value.trim();
  const avatarUrl   = $("ep-avatar-url").value.trim();
  const alertEl     = $("edit-profile-alert");
  const dnErr       = $("ep-display-name-err");

  if (!displayName) {
    dnErr.textContent = "Display name is required";
    dnErr.classList.add("show");
    return;
  }
  dnErr.classList.remove("show");

  if (!editUsernameValid) {
    alertEl.textContent = "Please pick a valid, available username.";
    alertEl.className = "alert alert-error show";
    return;
  }

  setLoading("edit-profile-submit", true);
  alertEl.className = "alert";

  try {
    const updated = await callApiJson("/api/me", {
      method: "PUT",
      body: {
        display_name: displayName,
        username: username,
        bio: bio || null,
        avatar_url: avatarUrl || null,
      },
    });

    currentProfile = updated;
    renderProfile(currentProfile);

    alertEl.textContent = "Profile updated successfully! ✨";
    alertEl.className = "alert alert-success show";

    setTimeout(() => {
      closeEditProfile();
    }, 800);
  } catch (err) {
    alertEl.textContent = err.data?.error || err.message || "Failed to update profile.";
    alertEl.className = "alert alert-error show";
  }
  setLoading("edit-profile-submit", false, "Save Changes");
});

// ── XSS helper ───────────────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
