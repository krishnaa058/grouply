/**
 * app.js — Grouply Main App Controller
 *
 * Full functional implementation:
 * - Route guard, session persistence, auth state
 * - Theme management (Light / Dark / System with persistence)
 * - Lucide SVG icon rendering (Zero emojis)
 * - Desktop sidebar + mobile topbar & bottom nav
 * - Feed: Group posts, media, captions, comments modal
 * - Explore: Search and category filtering for public groups & posts
 * - Groups: My groups, create group, join by 8-char code
 * - Group Detail with 7 dedicated sub-tabs:
 *     1. Feed: Group posts & post creation
 *     2. Archive: Google Drive folder link & shared archive media
 *     3. Polls: Create poll & live vote tally with percentage bars
 *     4. Expenses: Split calculations, debtor/creditor settlements, log & settle
 *     5. Decisions: Proposals (add/remove member, publish post) & collective voting
 *     6. Members: Member roster & 7-day invite code generation
 *     7. Links: WhatsApp, Discord, Telegram, Drive links
 * - Chat: Direct launch into connected group communication channels
 * - Profile: Stats, circles flex, member profile viewer, profile edit
 */

import {
  getSession, onAuthStateChange, signOut, callApiJson, callApi,
} from "./frontend_auth.js";
import { renderIcons, getIcon } from "./icons.js";

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const CATEGORY_META = {
  travel:   { icon: "compass", label: "Travel",   gradient: "linear-gradient(135deg,#1e3a5f,#2d6a4f)" },
  sports:   { icon: "award",   label: "Sports",   gradient: "linear-gradient(135deg,#7f1d1d,#b45309)" },
  music:    { icon: "music",   label: "Music",    gradient: "linear-gradient(135deg,#4c1d95,#6d28d9)" },
  food:     { icon: "coffee",  label: "Food",     gradient: "linear-gradient(135deg,#78350f,#dc2626)" },
  gaming:   { icon: "gamepad", label: "Gaming",   gradient: "linear-gradient(135deg,#064e3b,#065f46)" },
  art:      { icon: "image",   label: "Art",      gradient: "linear-gradient(135deg,#831843,#9d174d)" },
  outdoors: { icon: "sun",     label: "Outdoors", gradient: "linear-gradient(135deg,#1e3a2f,#166534)" },
  tech:     { icon: "code",    label: "Tech",     gradient: "linear-gradient(135deg,#172554,#1e40af)" },
  other:    { icon: "users",   label: "Other",    gradient: "linear-gradient(135deg,#292524,#44403c)" },
};

function getCategoryMeta(cat) {
  return CATEGORY_META[cat] || CATEGORY_META.other;
}

function getInitial(name) {
  return (name || "?")[0].toUpperCase();
}

function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function setLoading(btnId, loading, originalText) {
  const btn = $(btnId);
  if (!btn) return;
  if (loading) {
    btn.dataset.origText = btn.innerHTML;
    btn.innerHTML = '<span class="spinner" style="width:16px;height:16px"></span>';
    btn.disabled = true;
  } else {
    btn.innerHTML = originalText || btn.dataset.origText || btn.innerHTML;
    btn.disabled = false;
  }
}

// ── Application State ─────────────────────────────────────────────────────────
let currentUser    = null;
let currentProfile = null;
let myGroups       = [];
let activeGroupId  = null;
let activeGroupData= null;
let activePostId   = null; // For comments modal

// ── Theme Management ──────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem("grouply_theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const current = saved || (prefersDark ? "dark" : "light");
  applyTheme(current);
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("grouply_theme", theme);

  const isDark = theme === "dark";
  const label = isDark ? "Light mode" : "Dark mode";
  const icon = isDark ? "sun" : "moon";

  const dLabel = $("desktop-theme-label");
  const dIcon = $("desktop-theme-icon");
  if (dLabel) dLabel.textContent = label;
  if (dIcon) dIcon.setAttribute("data-icon", icon);

  const mIcon = $("mobile-theme-icon");
  if (mIcon) mIcon.setAttribute("data-icon", icon);

  const pLabel = $("profile-theme-label");
  if (pLabel) pLabel.textContent = `${isDark ? "Light" : "Dark"} Mode`;

  renderIcons();
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
}

// ── Route Guard & Boot ────────────────────────────────────────────────────────
(async () => {
  initTheme();
  renderIcons();

  let session = await getSession();
  if (!session && window.location.hash.includes("access_token")) {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 200));
      session = await getSession();
      if (session) break;
    }
  }

  if (!session) {
    window.location.href = "login.html";
    return;
  }

  currentUser = session.user;
  await loadProfile();
  await loadMyGroups();
  await loadFeed();
  checkInviteCodeInUrl();

  renderIcons();
})();

onAuthStateChange(async (event, session) => {
  if (event === "SIGNED_OUT") {
    window.location.href = "login.html";
    return;
  }
  if ((event === "TOKEN_REFRESHED" || event === "SIGNED_IN") && session) {
    currentUser = session.user;
  }
});

// ── Profile Loading ───────────────────────────────────────────────────────────
async function loadProfile() {
  try {
    currentProfile = await callApiJson("/api/me");
    if (!currentProfile.display_name) {
      window.location.href = "onboarding.html";
      return;
    }
    renderUserProfile(currentProfile);
  } catch (err) {
    console.warn("Could not load profile from API:", err);
    if (err?.status === 401) {
      const activeSession = await getSession();
      if (!activeSession) {
        window.location.href = "login.html";
        return;
      }
    }
    const meta = currentUser?.user_metadata || {};
    currentProfile = {
      display_name: meta.full_name || meta.name || currentUser?.email || "User",
      username: meta.preferred_username || "user",
      avatar_url: meta.avatar_url || meta.picture || null,
      bio: "",
    };
    renderUserProfile(currentProfile);
  }
}

function renderUserProfile(prof) {
  // Sidebar user pill
  const sName = $("sidebar-user-name");
  const sHandle = $("sidebar-user-handle");
  const sAvatar = $("sidebar-avatar");
  if (sName) sName.textContent = prof.display_name || prof.username;
  if (sHandle) sHandle.textContent = `@${prof.username}`;
  if (sAvatar) {
    if (prof.avatar_url) {
      sAvatar.innerHTML = `<img src="${escHtml(prof.avatar_url)}" alt="${escHtml(prof.display_name)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    } else {
      sAvatar.textContent = getInitial(prof.display_name);
    }
  }

  // Feed post creation avatar
  const postAv = $("post-create-avatar");
  if (postAv) {
    if (prof.avatar_url) {
      postAv.innerHTML = `<img src="${escHtml(prof.avatar_url)}" alt="${escHtml(prof.display_name)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    } else {
      postAv.textContent = getInitial(prof.display_name);
    }
  }

  // Profile screen
  const pAvatar = $("profile-avatar");
  const pName = $("profile-display-name");
  const pUser = $("profile-username");
  const pBio = $("profile-bio");

  if (pAvatar) {
    if (prof.avatar_url) {
      pAvatar.innerHTML = `<img src="${escHtml(prof.avatar_url)}" alt="${escHtml(prof.display_name)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    } else {
      pAvatar.textContent = getInitial(prof.display_name);
    }
  }
  if (pName) pName.textContent = prof.display_name || prof.username;
  if (pUser) pUser.textContent = `@${prof.username}`;
  if (pBio) pBio.textContent = prof.bio || "No bio yet.";
}

// ── Groups Loading ────────────────────────────────────────────────────────────
async function loadMyGroups() {
  try {
    myGroups = await callApiJson("/api/groups");
  } catch (err) {
    console.warn("Could not load groups:", err);
    myGroups = [];
  }
  populateFeedGroupSelect();
  renderGroupsTab();
  renderProfileTab();
  renderChatTab();
  renderIcons();
}

function populateFeedGroupSelect() {
  const sel = $("feed-post-group-select");
  if (!sel) return;
  sel.innerHTML = '<option value="">Select Group...</option>';
  myGroups.forEach((g) => {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = g.name;
    sel.appendChild(opt);
  });
}

function renderGroupsTab() {
  const emptyEl = $("groups-empty");
  const listEl = $("groups-list");
  if (!listEl) return;

  if (!myGroups.length) {
    emptyEl.style.display = "flex";
    listEl.classList.add("hidden");
    return;
  }

  emptyEl.style.display = "none";
  listEl.classList.remove("hidden");
  listEl.innerHTML = "";

  myGroups.forEach((g) => {
    listEl.appendChild(buildGroupCard(g));
  });
}

function buildGroupCard(g) {
  const meta = getCategoryMeta(g.category);
  const card = document.createElement("div");
  card.className = "group-card card";
  card.dataset.groupId = g.id;

  card.innerHTML = `
    <div class="group-card-cover" style="${meta.gradient};display:flex;align-items:center;justify-content:center;height:100px;border-radius:var(--radius-lg) var(--radius-lg) 0 0">
      <span class="icon-wrap" data-icon="${meta.icon}" style="color:#fff;width:32px;height:32px"></span>
    </div>
    <div class="card-body" style="padding:var(--space-3)">
      <div style="font-weight:700;font-size:1rem;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(g.name)}</div>
      <div style="display:flex;gap:var(--space-2);margin-top:var(--space-2);align-items:center;flex-wrap:wrap">
        <span class="badge badge-neutral" style="font-size:0.75rem">${g.member_count} member${g.member_count === 1 ? "" : "s"}</span>
        <span class="badge badge-brand" style="font-size:0.75rem">${meta.label}</span>
        ${g.is_private ? '<span class="badge badge-neutral" style="font-size:0.75rem">Private</span>' : '<span class="badge badge-neutral" style="font-size:0.75rem">Public</span>'}
        ${g.my_role === "admin" ? '<span class="badge badge-warning" style="font-size:0.75rem">Admin</span>' : ""}
      </div>
      ${g.description ? `<p style="font-size:0.82rem;color:var(--text-secondary);margin-top:var(--space-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(g.description)}</p>` : ""}
    </div>
  `;

  card.addEventListener("click", () => openGroupDetail(g.id));
  return card;
}

function renderProfileTab() {
  const countEl = $("profile-groups-count");
  const adminCountEl = $("profile-admin-count");
  const catCountEl = $("profile-categories-count");
  const emptyEl = $("profile-empty-groups");
  const listEl = $("profile-groups-list");

  const total = myGroups.length;
  const adminCount = myGroups.filter((g) => g.my_role === "admin").length;
  const uniqueCats = new Set(myGroups.map((g) => g.category).filter(Boolean)).size;

  if (countEl) countEl.textContent = total;
  if (adminCountEl) adminCountEl.textContent = adminCount;
  if (catCountEl) catCountEl.textContent = uniqueCats;

  if (!listEl) return;

  if (total === 0) {
    if (emptyEl) emptyEl.classList.remove("hidden");
    listEl.innerHTML = "";
    return;
  }

  if (emptyEl) emptyEl.classList.add("hidden");
  listEl.innerHTML = "";
  myGroups.forEach((g) => {
    listEl.appendChild(buildGroupCard(g));
  });
}

function renderChatTab() {
  const noGroupsState = $("chat-no-groups-state");
  const groupsState = $("chat-groups-state");
  const listEl = $("chat-groups-list");
  if (!listEl) return;

  if (!myGroups.length) {
    if (noGroupsState) noGroupsState.classList.remove("hidden");
    if (groupsState) groupsState.classList.add("hidden");
    return;
  }

  if (noGroupsState) noGroupsState.classList.add("hidden");
  if (groupsState) groupsState.classList.remove("hidden");
  listEl.innerHTML = "";

  myGroups.forEach((g) => {
    const meta = getCategoryMeta(g.category);
    const hasWA = !!g.whatsapp_link;

    const row = document.createElement("div");
    row.className = "card";
    row.style.cssText = "padding:var(--space-3) var(--space-4);display:flex;align-items:center;gap:var(--space-3);cursor:pointer";

    row.innerHTML = `
      <div style="width:40px;height:40px;border-radius:var(--radius-md);${meta.gradient};display:flex;align-items:center;justify-content:center;color:#fff;flex-shrink:0">
        <span class="icon-wrap" data-icon="${meta.icon}" style="width:20px;height:20px"></span>
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:0.95rem;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(g.name)}</div>
        <div style="font-size:0.8rem;color:var(--text-secondary)">${g.member_count} members ${hasWA ? "· WhatsApp connected" : "· No chat linked"}</div>
      </div>
      ${hasWA
        ? `<button class="btn btn-primary btn-sm" style="gap:var(--space-1);flex-shrink:0">
             <span class="icon-wrap" data-icon="external-link"></span>
             <span>Open</span>
           </button>`
        : `<button class="btn btn-ghost btn-sm" style="flex-shrink:0">Link</button>`}
    `;

    row.addEventListener("click", () => {
      if (hasWA) {
        window.open(g.whatsapp_link, "_blank", "noopener,noreferrer");
      } else {
        openGroupDetail(g.id);
        switchGroupSubtab("links");
      }
    });

    listEl.appendChild(row);
  });
}

// ── Feed Loading & Rendering ──────────────────────────────────────────────────
async function loadFeed() {
  const emptyEl = $("feed-empty");
  const listEl = $("feed-list");
  if (!listEl) return;

  try {
    const posts = await callApiJson("/api/feed");
    if (!posts || !posts.length) {
      emptyEl.classList.remove("hidden");
      listEl.classList.add("hidden");
      return;
    }

    emptyEl.classList.add("hidden");
    listEl.classList.remove("hidden");
    listEl.innerHTML = "";

    posts.forEach((p) => {
      listEl.appendChild(buildPostCard(p));
    });
    renderIcons();
  } catch (err) {
    console.warn("Could not load feed:", err);
    emptyEl.classList.remove("hidden");
    listEl.classList.add("hidden");
  }
}

function buildPostCard(p) {
  const card = document.createElement("article");
  card.className = "card post-card";
  card.style.overflow = "hidden";

  const groupName = p.groups?.name || "Group";
  const author = p.profiles || {};
  const authorName = author.display_name || author.username || "Member";
  const time = formatDate(p.created_at);

  card.innerHTML = `
    <div class="card-header" style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-4)">
      <div class="avatar avatar-sm" style="width:36px;height:36px;border-radius:50%;background:var(--accent-subtle);color:var(--brand-accent);font-weight:700;display:flex;align-items:center;justify-content:center;font-size:0.85rem">
        ${author.avatar_url ? `<img src="${escHtml(author.avatar_url)}" alt="${escHtml(authorName)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">` : getInitial(authorName)}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:0.9rem;color:var(--text-primary)">
          ${escHtml(authorName)} <span style="font-weight:400;color:var(--text-secondary);font-size:0.8rem">in</span> <strong style="color:var(--brand-accent);cursor:pointer" class="post-group-link">${escHtml(groupName)}</strong>
        </div>
        <div style="font-size:0.75rem;color:var(--text-tertiary)">${time}</div>
      </div>
      ${p.is_public ? '<span class="badge badge-neutral" style="font-size:0.75rem">Public</span>' : ""}
    </div>

    ${p.media_url ? `
      <div style="width:100%;max-height:480px;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;overflow:hidden">
        <img src="${escHtml(p.media_url)}" alt="Post media" style="width:100%;height:auto;object-fit:cover;max-height:480px" onerror="this.style.display='none'">
      </div>
    ` : ""}

    <div class="card-body" style="padding:var(--space-3) var(--space-4)">
      ${p.caption ? `<p style="font-size:0.95rem;line-height:1.5;color:var(--text-primary)">${escHtml(p.caption)}</p>` : ""}

      <div style="display:flex;align-items:center;gap:var(--space-4);margin-top:var(--space-3);padding-top:var(--space-2);border-top:1px solid var(--border-subtle)">
        <button class="btn btn-ghost btn-sm post-comment-btn" style="gap:var(--space-2);font-size:0.85rem;padding:var(--space-1) var(--space-2)">
          <span class="icon-wrap" data-icon="message-square"></span>
          <span>Comments</span>
        </button>
      </div>
    </div>
  `;

  // Click on group link opens group detail
  const gLink = card.querySelector(".post-group-link");
  if (gLink && p.group_id) {
    gLink.addEventListener("click", () => openGroupDetail(p.group_id));
  }

  // Click comments button opens comments modal
  const cBtn = card.querySelector(".post-comment-btn");
  if (cBtn) {
    cBtn.addEventListener("click", () => openCommentsModal(p.id));
  }

  return card;
}

// Post creation in feed
$("feed-post-submit").addEventListener("click", async () => {
  const groupId = $("feed-post-group-select").value;
  const caption = $("feed-post-caption").value.trim();
  const mediaUrl = $("feed-post-media").value.trim();
  const isPublic = $("feed-post-public").checked;

  if (!groupId) {
    alert("Please select a group to post to.");
    return;
  }
  if (!caption && !mediaUrl) {
    alert("Please enter a caption or an image URL.");
    return;
  }

  setLoading("feed-post-submit", true);
  try {
    await callApiJson(`/api/groups/${groupId}/posts`, {
      method: "POST",
      body: { caption: caption || null, media_url: mediaUrl || null, is_public: isPublic },
    });

    $("feed-post-caption").value = "";
    $("feed-post-media").value = "";
    $("feed-post-public").checked = false;

    await loadFeed();
  } catch (err) {
    alert(err.message || "Failed to create post.");
  }
  setLoading("feed-post-submit", false, "Post");
  renderIcons();
});

// ── Comments Modal ────────────────────────────────────────────────────────────
async function openCommentsModal(postId) {
  activePostId = postId;
  const modal = $("comments-modal");
  const listEl = $("comments-list");
  modal.classList.add("open");
  listEl.innerHTML = '<div style="text-align:center;padding:var(--space-4)"><span class="spinner" style="width:20px;height:20px"></span></div>';

  try {
    const comments = await callApiJson(`/api/posts/${postId}/comments`);
    listEl.innerHTML = "";
    if (!comments.length) {
      listEl.innerHTML = '<p style="text-align:center;color:var(--text-secondary);font-size:0.875rem;padding:var(--space-4)">No comments yet. Start the conversation!</p>';
    } else {
      comments.forEach((c) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:var(--space-2);align-items:flex-start";
        const author = c.profiles || {};
        const name = author.display_name || author.username || "Member";
        row.innerHTML = `
          <div class="avatar avatar-sm" style="width:28px;height:28px;border-radius:50%;background:var(--accent-subtle);color:var(--brand-accent);font-size:0.75rem;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            ${author.avatar_url ? `<img src="${escHtml(author.avatar_url)}" alt="${escHtml(name)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">` : getInitial(name)}
          </div>
          <div style="background:var(--bg-secondary);padding:var(--space-2) var(--space-3);border-radius:var(--radius-md);flex:1">
            <div style="font-weight:600;font-size:0.85rem;color:var(--text-primary)">${escHtml(name)}</div>
            <div style="font-size:0.875rem;color:var(--text-primary);margin-top:2px">${escHtml(c.content)}</div>
          </div>
        `;
        listEl.appendChild(row);
      });
    }
  } catch (err) {
    listEl.innerHTML = `<p style="color:var(--danger);font-size:0.85rem">Could not load comments.</p>`;
  }
}

$("comment-submit").addEventListener("click", async () => {
  if (!activePostId) return;
  const input = $("comment-input");
  const content = input.value.trim();
  if (!content) return;

  setLoading("comment-submit", true);
  try {
    await callApiJson(`/api/posts/${activePostId}/comments`, {
      method: "POST",
      body: { content },
    });
    input.value = "";
    await openCommentsModal(activePostId);
  } catch (err) {
    alert("Could not post comment.");
  }
  setLoading("comment-submit", false, "Post");
});

$("comments-close").addEventListener("click", () => $("comments-modal").classList.remove("open"));
$("comments-modal").addEventListener("click", (e) => {
  if (e.target === $("comments-modal")) $("comments-modal").classList.remove("open");
});

// ── Explore Screen (Search & Categories) ──────────────────────────────────────
async function loadExplore(query = "", category = "") {
  try {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (category) params.set("category", category);

    const data = await callApiJson(`/api/explore?${params.toString()}`);

    const gList = $("explore-groups-list");
    const pList = $("explore-posts-list");
    gList.innerHTML = "";
    pList.innerHTML = "";

    const groups = data.groups || [];
    const posts = data.posts || [];

    if (!groups.length) {
      gList.innerHTML = '<p style="color:var(--text-secondary);font-size:0.875rem">No public groups found.</p>';
    } else {
      groups.forEach((g) => {
        gList.appendChild(buildGroupCard(g));
      });
    }

    if (!posts.length) {
      pList.innerHTML = '<p style="color:var(--text-secondary);font-size:0.875rem">No public posts found.</p>';
    } else {
      posts.forEach((p) => {
        pList.appendChild(buildPostCard(p));
      });
    }
    renderIcons();
  } catch (err) {
    console.warn("loadExplore error:", err);
  }
}

let searchTimer = null;
$("explore-search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => {
    loadExplore(q);
  }, 400);
});

document.querySelectorAll(".category-tile").forEach((tile) => {
  tile.addEventListener("click", () => {
    const cat = tile.dataset.category;
    const title = $("explore-results-title");
    title.textContent = `Discover ${CATEGORY_META[cat]?.label || cat} Circles`;
    loadExplore("", cat);
  });
});

$("explore-cat-clear").addEventListener("click", () => {
  $("explore-results-title").textContent = "Discover Public Circles";
  $("explore-search").value = "";
  loadExplore();
});

// ── Group Detail Full Implementation ──────────────────────────────────────────
async function openGroupDetail(groupId) {
  activeGroupId = groupId;
  const modal = $("group-detail-modal");
  modal.classList.add("open");

  // Reset to Feed subtab
  switchGroupSubtab("feed");

  try {
    activeGroupData = await callApiJson(`/api/groups/${groupId}`);
    const g = activeGroupData;
    const meta = getCategoryMeta(g.category);

    // Header updates
    $("gd-title").textContent = g.name;
    $("gd-name").textContent = g.name;
    $("gd-cover").style.background = meta.gradient;
    $("gd-category-label").textContent = g.category ? meta.label : "";
    $("gd-category-icon").setAttribute("data-icon", meta.icon);

    $("gd-privacy-badge").textContent = g.is_private ? "Private" : "Public";
    $("gd-member-badge").textContent = `${g.member_count} member${g.member_count === 1 ? "" : "s"}`;

    const roleBadge = $("gd-role-badge");
    if (g.my_role === "admin") {
      roleBadge.textContent = "Admin";
      roleBadge.style.display = "inline-flex";
    } else {
      roleBadge.style.display = "none";
    }

    const descEl = $("gd-description");
    if (g.description) {
      descEl.textContent = g.description;
      descEl.style.display = "block";
    } else {
      descEl.style.display = "none";
    }

    // Load active tab data
    await loadGroupSubtabData("feed");
    renderIcons();
  } catch (err) {
    console.error("openGroupDetail error:", err);
    alert("Could not load group details.");
  }
}

function switchGroupSubtab(tabName) {
  document.querySelectorAll(".subnav-tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".subnav-panel").forEach((p) => {
    p.classList.remove("active");
    p.classList.add("hidden");
  });

  const tabBtn = $(`subtab-${tabName}`);
  const panel = $(`gd-panel-${tabName}`);
  if (tabBtn) tabBtn.classList.add("active");
  if (panel) {
    panel.classList.remove("hidden");
    panel.classList.add("active");
  }

  loadGroupSubtabData(tabName);
}

document.querySelectorAll(".subnav-tab").forEach((btn) => {
  btn.addEventListener("click", () => switchGroupSubtab(btn.dataset.subtab));
});

async function loadGroupSubtabData(tabName) {
  if (!activeGroupId) return;

  switch (tabName) {
    case "feed":
      await loadGroupFeed(activeGroupId);
      break;
    case "archive":
      await loadGroupArchive(activeGroupId);
      break;
    case "polls":
      await loadGroupPolls(activeGroupId);
      break;
    case "expenses":
      await loadGroupExpenses(activeGroupId);
      break;
    case "decisions":
      await loadGroupDecisions(activeGroupId);
      break;
    case "members":
      renderGroupMembers(activeGroupData?.members || []);
      break;
    case "links":
      await loadGroupLinks(activeGroupId);
      break;
  }
  renderIcons();
}

// 1. Group Feed
async function loadGroupFeed(groupId) {
  const listEl = $("gd-feed-list");
  listEl.innerHTML = '<div style="text-align:center;padding:var(--space-4)"><span class="spinner" style="width:20px;height:20px"></span></div>';
  try {
    const posts = await callApiJson(`/api/groups/${groupId}/posts`);
    listEl.innerHTML = "";
    if (!posts.length) {
      listEl.innerHTML = '<p style="text-align:center;color:var(--text-secondary);font-size:0.875rem;padding:var(--space-4)">No group posts yet. Share something with your circle!</p>';
    } else {
      posts.forEach((p) => {
        listEl.appendChild(buildPostCard(p));
      });
    }
  } catch (err) {
    listEl.innerHTML = '<p style="color:var(--danger);font-size:0.85rem">Failed to load group posts.</p>';
  }
}

$("gd-post-submit").addEventListener("click", async () => {
  if (!activeGroupId) return;
  const caption = $("gd-post-caption").value.trim();
  const mediaUrl = $("gd-post-media").value.trim();
  if (!caption && !mediaUrl) {
    alert("Please enter a caption or media URL.");
    return;
  }

  setLoading("gd-post-submit", true);
  try {
    await callApiJson(`/api/groups/${activeGroupId}/posts`, {
      method: "POST",
      body: { caption: caption || null, media_url: mediaUrl || null, is_public: false },
    });
    $("gd-post-caption").value = "";
    $("gd-post-media").value = "";
    await loadGroupFeed(activeGroupId);
  } catch (err) {
    alert(err.message || "Failed to post.");
  }
  setLoading("gd-post-submit", false, "Post");
  renderIcons();
});

// 2. Archive & Google Drive
async function loadGroupArchive(groupId) {
  const g = activeGroupData || {};
  const statusEl = $("gd-drive-status");
  const connView = $("gd-drive-connected-view");
  const launchBtn = $("gd-drive-launch-btn");
  const linkInput = $("gd-drive-link-input");

  if (g.google_drive_folder_url) {
    statusEl.textContent = "Connected";
    statusEl.className = "badge badge-success";
    connView.classList.remove("hidden");
    launchBtn.href = g.google_drive_folder_url;
    linkInput.value = g.google_drive_folder_url;
  } else {
    statusEl.textContent = "Not connected";
    statusEl.className = "badge badge-neutral";
    connView.classList.add("hidden");
    linkInput.value = "";
  }

  const listEl = $("gd-archive-list");
  listEl.innerHTML = "";
  try {
    const items = await callApiJson(`/api/groups/${groupId}/archive`);
    if (!items.length) {
      listEl.innerHTML = '<p style="color:var(--text-secondary);font-size:0.85rem;grid-column:1/-1;text-align:center;padding:var(--space-4)">No archived files yet.</p>';
    } else {
      items.forEach((item) => {
        const card = document.createElement("div");
        card.className = "card";
        card.style.cssText = "padding:var(--space-3);display:flex;flex-direction:column;gap:var(--space-2)";
        card.innerHTML = `
          <div style="font-weight:600;font-size:0.875rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(item.title)}</div>
          ${item.file_url ? `<a href="${escHtml(item.file_url)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm" style="margin-top:auto">Open file</a>` : ""}
        `;
        listEl.appendChild(card);
      });
    }
  } catch (err) {
    console.warn("loadGroupArchive error:", err);
  }
}

$("gd-drive-save-btn").addEventListener("click", async () => {
  if (!activeGroupId) return;
  const url = $("gd-drive-link-input").value.trim();
  setLoading("gd-drive-save-btn", true);
  try {
    await callApiJson(`/api/groups/${activeGroupId}/drive`, {
      method: "PUT",
      body: { folder_url: url || null },
    });
    if (activeGroupData) activeGroupData.google_drive_folder_url = url;
    await loadGroupArchive(activeGroupId);
    alert("Drive folder updated.");
  } catch (err) {
    alert(err.message || "Failed to update Drive folder.");
  }
  setLoading("gd-drive-save-btn", false, "Save");
});

// 3. Polls
async function loadGroupPolls(groupId) {
  const listEl = $("gd-polls-list");
  listEl.innerHTML = '<div style="text-align:center;padding:var(--space-4)"><span class="spinner" style="width:20px;height:20px"></span></div>';
  try {
    const polls = await callApiJson(`/api/groups/${groupId}/polls`);
    listEl.innerHTML = "";
    if (!polls.length) {
      listEl.innerHTML = '<p style="text-align:center;color:var(--text-secondary);font-size:0.875rem;padding:var(--space-4)">No active polls. Create one to collect member opinions!</p>';
      return;
    }

    polls.forEach((poll) => {
      const card = document.createElement("div");
      card.className = "card";
      card.style.padding = "var(--space-3) var(--space-4)";

      const hasVoted = poll.user_voted_option_id !== null;
      let optionsHtml = "";

      (poll.options || []).forEach((opt) => {
        const pct = opt.percentage || 0;
        const isUserChoice = opt.id === poll.user_voted_option_id;

        optionsHtml += `
          <div style="margin-top:var(--space-2)">
            <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:4px">
              <span style="font-weight:${isUserChoice ? "700" : "500"};color:${isUserChoice ? "var(--brand-accent)" : "var(--text-primary)"}">
                ${escHtml(opt.option_text)} ${isUserChoice ? "✓" : ""}
              </span>
              <span style="color:var(--text-secondary);font-size:0.8rem">${opt.vote_count} votes (${pct}%)</span>
            </div>
            <div style="background:var(--bg-secondary);height:8px;border-radius:var(--radius-full);overflow:hidden;position:relative">
              <div style="background:var(--brand-accent);width:${pct}%;height:100%;transition:width 0.3s ease"></div>
            </div>
            ${!hasVoted ? `
              <button class="btn btn-secondary btn-sm poll-vote-btn" data-opt-id="${opt.id}" style="margin-top:6px;font-size:0.8rem;padding:2px 10px">
                Vote
              </button>
            ` : ""}
          </div>
        `;
      });

      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h5 style="font-weight:700;font-size:0.95rem;color:var(--text-primary)">${escHtml(poll.question)}</h5>
          <span class="badge ${poll.status === "open" ? "badge-brand" : "badge-neutral"}" style="font-size:0.75rem">${poll.status}</span>
        </div>
        <div style="font-size:0.78rem;color:var(--text-secondary);margin-top:2px">${poll.total_votes} total vote${poll.total_votes === 1 ? "" : "s"}</div>
        <div style="margin-top:var(--space-2)">${optionsHtml}</div>
      `;

      card.querySelectorAll(".poll-vote-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const optId = btn.dataset.optId;
          try {
            await callApiJson(`/api/polls/${poll.id}/vote`, {
              method: "POST",
              body: { option_id: optId },
            });
            await loadGroupPolls(groupId);
          } catch (err) {
            alert(err.message || "Failed to submit vote.");
          }
        });
      });

      listEl.appendChild(card);
    });
  } catch (err) {
    listEl.innerHTML = '<p style="color:var(--danger);font-size:0.85rem">Could not load polls.</p>';
  }
}

$("gd-create-poll-btn").addEventListener("click", () => {
  $("create-poll-modal").classList.add("open");
  $("poll-question").value = "";
  $("create-poll-alert").className = "alert";
  $("create-poll-alert").textContent = "";
});

$("create-poll-close").addEventListener("click", () => $("create-poll-modal").classList.remove("open"));
$("create-poll-modal").addEventListener("click", (e) => {
  if (e.target === $("create-poll-modal")) $("create-poll-modal").classList.remove("open");
});

$("poll-add-opt-btn").addEventListener("click", () => {
  const container = $("poll-options-container");
  const count = container.querySelectorAll(".poll-opt-input").length + 1;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "input poll-opt-input";
  input.placeholder = `Option ${count}`;
  container.appendChild(input);
});

$("create-poll-submit").addEventListener("click", async () => {
  if (!activeGroupId) return;
  const question = $("poll-question").value.trim();
  const optionInputs = document.querySelectorAll(".poll-opt-input");
  const options = Array.from(optionInputs).map((i) => i.value.trim()).filter(Boolean);

  if (!question) {
    alert("Please enter a question.");
    return;
  }
  if (options.length < 2) {
    alert("Please provide at least 2 options.");
    return;
  }

  setLoading("create-poll-submit", true);
  try {
    await callApiJson(`/api/groups/${activeGroupId}/polls`, {
      method: "POST",
      body: { question, options },
    });
    $("create-poll-modal").classList.remove("open");
    await loadGroupPolls(activeGroupId);
  } catch (err) {
    alert(err.message || "Failed to create poll.");
  }
  setLoading("create-poll-submit", false, "Launch Poll");
});

// 4. Expenses & Settlements
async function loadGroupExpenses(groupId) {
  const listEl = $("gd-expenses-list");
  const settlementsEl = $("gd-settlements-list");
  listEl.innerHTML = '<div style="text-align:center;padding:var(--space-4)"><span class="spinner" style="width:20px;height:20px"></span></div>';
  settlementsEl.innerHTML = "";

  try {
    const data = await callApiJson(`/api/groups/${groupId}/expenses`);
    const expenses = data.expenses || [];
    const settlements = data.settlements || [];
    const balances = data.balances || {};

    // Calculate totals
    let totalSpent = 0;
    expenses.forEach((e) => { totalSpent += parseFloat(e.amount || 0); });
    $("gd-exp-total").textContent = `$${totalSpent.toFixed(2)}`;

    // Current user's net
    const myNet = currentUser ? (balances[currentUser.id] || 0) : 0;
    const netEl = $("gd-exp-net");
    netEl.textContent = `${myNet >= 0 ? "+" : ""}$${myNet.toFixed(2)}`;
    netEl.style.color = myNet > 0 ? "var(--success)" : myNet < 0 ? "var(--danger)" : "var(--brand-accent)";

    // Suggested settlements
    if (!settlements.length) {
      settlementsEl.innerHTML = '<span style="color:var(--text-secondary)">All expenses are fully settled! No outstanding debts.</span>';
    } else {
      settlements.forEach((s) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:var(--space-1) 0";
        row.innerHTML = `
          <span><strong>${escHtml(s.from_name)}</strong> owes <strong>${escHtml(s.to_name)}</strong></span>
          <span class="badge badge-brand">$${parseFloat(s.amount).toFixed(2)}</span>
        `;
        settlementsEl.appendChild(row);
      });
    }

    // Expense list
    listEl.innerHTML = "";
    if (!expenses.length) {
      listEl.innerHTML = '<p style="text-align:center;color:var(--text-secondary);font-size:0.875rem;padding:var(--space-4)">No expenses recorded yet.</p>';
      return;
    }

    expenses.forEach((exp) => {
      const card = document.createElement("div");
      card.className = "card";
      card.style.padding = "var(--space-3) var(--space-4)";

      const payer = exp.payer?.display_name || exp.payer?.username || "Someone";
      const isSettled = exp.is_settled;

      let splitsHtml = "";
      (exp.splits || []).forEach((sp) => {
        const member = sp.profiles?.display_name || sp.profiles?.username || "Member";
        splitsHtml += `
          <div style="display:flex;justify-content:space-between;font-size:0.8rem;color:var(--text-secondary);margin-top:2px">
            <span>${escHtml(member)}: $${parseFloat(sp.amount).toFixed(2)}</span>
            <span>${sp.is_settled ? '<span class="badge badge-success" style="font-size:0.7rem">Settled</span>' : '<span class="badge badge-neutral" style="font-size:0.7rem">Unsettled</span>'}</span>
          </div>
        `;
      });

      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-weight:700;font-size:0.95rem;color:var(--text-primary)">${escHtml(exp.description)}</div>
            <div style="font-size:0.8rem;color:var(--text-secondary)">Paid by ${escHtml(payer)} · ${formatDate(exp.created_at)}</div>
          </div>
          <div style="text-align:right">
            <div style="font-weight:800;font-size:1.1rem;color:var(--text-primary)">$${parseFloat(exp.amount).toFixed(2)}</div>
            <span class="badge ${isSettled ? "badge-success" : "badge-neutral"}" style="font-size:0.75rem">${isSettled ? "Settled" : "Open"}</span>
          </div>
        </div>
        <div style="margin-top:var(--space-2);padding-top:var(--space-2);border-top:1px solid var(--border-subtle)">
          ${splitsHtml}
        </div>
        ${!isSettled ? `
          <div style="margin-top:var(--space-3);text-align:right">
            <button class="btn btn-secondary btn-sm settle-exp-btn" data-exp-id="${exp.id}" style="font-size:0.8rem">
              Mark Expense Settled
            </button>
          </div>
        ` : ""}
      `;

      const sBtn = card.querySelector(".settle-exp-btn");
      if (sBtn) {
        sBtn.addEventListener("click", async () => {
          try {
            await callApiJson(`/api/expenses/${exp.id}/settle`, { method: "POST" });
            await loadGroupExpenses(groupId);
          } catch (err) {
            alert(err.message || "Failed to settle expense.");
          }
        });
      }

      listEl.appendChild(card);
    });
  } catch (err) {
    listEl.innerHTML = '<p style="color:var(--danger);font-size:0.85rem">Could not load expenses.</p>';
  }
}

// Add Expense modal trigger
$("gd-add-expense-btn").addEventListener("click", () => {
  const modal = $("add-expense-modal");
  modal.classList.add("open");
  $("exp-desc").value = "";
  $("exp-amount").value = "";

  // Populate payers and split members from active group members
  const members = activeGroupData?.members || [];
  const payerSel = $("exp-payer");
  const picker = $("exp-members-picker");
  payerSel.innerHTML = "";
  picker.innerHTML = "";

  members.forEach((m) => {
    const prof = m.profiles || {};
    const name = prof.display_name || prof.username || "Member";
    const uId = m.user_id || prof.id;

    // Payer option
    const opt = document.createElement("option");
    opt.value = uId;
    opt.textContent = name;
    if (currentUser && uId === currentUser.id) opt.selected = true;
    payerSel.appendChild(opt);

    // Split checkbox row
    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:4px 0;font-size:0.85rem;cursor:pointer";
    row.innerHTML = `
      <span style="display:flex;align-items:center;gap:var(--space-2)">
        <input type="checkbox" class="exp-member-chk" value="${uId}" checked />
        <span>${escHtml(name)}</span>
      </span>
      <input type="number" step="0.01" class="input exp-member-custom-amt hidden" placeholder="Amount" style="width:90px;padding:2px 8px;font-size:0.8rem" />
    `;
    picker.appendChild(row);
  });
});

$("add-expense-close").addEventListener("click", () => $("add-expense-modal").classList.remove("open"));
$("add-expense-modal").addEventListener("click", (e) => {
  if (e.target === $("add-expense-modal")) $("add-expense-modal").classList.remove("open");
});

document.querySelectorAll('input[name="exp-split-type"]').forEach((r) => {
  r.addEventListener("change", (e) => {
    const isCustom = e.target.value === "custom";
    document.querySelectorAll(".exp-member-custom-amt").forEach((input) => {
      input.classList.toggle("hidden", !isCustom);
    });
  });
});

$("add-expense-submit").addEventListener("click", async () => {
  if (!activeGroupId) return;
  const desc = $("exp-desc").value.trim();
  const amt = parseFloat($("exp-amount").value);
  const currency = $("exp-currency").value;
  const payerId = $("exp-payer").value;
  const splitType = document.querySelector('input[name="exp-split-type"]:checked').value;

  if (!desc || isNaN(amt) || amt <= 0) {
    alert("Please enter a valid description and amount.");
    return;
  }

  const chks = document.querySelectorAll(".exp-member-chk:checked");
  if (!chks.length) {
    alert("Please select at least one member to split the expense.");
    return;
  }

  let splits = [];
  if (splitType === "equal") {
    const share = Math.round((amt / chks.length) * 100) / 100;
    chks.forEach((c) => {
      splits.push({ user_id: c.value, amount: share });
    });
  } else {
    chks.forEach((c) => {
      const customInput = c.closest("label").querySelector(".exp-member-custom-amt");
      const customAmt = parseFloat(customInput.value) || 0;
      splits.push({ user_id: c.value, amount: customAmt });
    });
  }

  setLoading("add-expense-submit", true);
  try {
    await callApiJson(`/api/groups/${activeGroupId}/expenses`, {
      method: "POST",
      body: {
        description: desc,
        amount: amt,
        currency,
        paid_by: payerId,
        split_type: splitType,
        splits,
      },
    });
    $("add-expense-modal").classList.remove("open");
    await loadGroupExpenses(activeGroupId);
  } catch (err) {
    alert(err.message || "Failed to add expense.");
  }
  setLoading("add-expense-submit", false, "Save Expense");
});

// 5. Decisions & Voting (Proposals)
async function loadGroupDecisions(groupId) {
  const listEl = $("gd-decisions-list");
  listEl.innerHTML = '<div style="text-align:center;padding:var(--space-4)"><span class="spinner" style="width:20px;height:20px"></span></div>';
  try {
    const proposals = await callApiJson(`/api/groups/${groupId}/proposals`);
    listEl.innerHTML = "";
    if (!proposals.length) {
      listEl.innerHTML = '<p style="text-align:center;color:var(--text-secondary);font-size:0.875rem;padding:var(--space-4)">No proposals yet. Any member can propose a collective decision!</p>';
      return;
    }

    const memberCount = activeGroupData?.member_count || 1;
    const threshold = Math.floor(memberCount / 2) + 1;

    proposals.forEach((prop) => {
      const card = document.createElement("div");
      card.className = "card";
      card.style.padding = "var(--space-3) var(--space-4)";

      const yesVotes = prop.votes_yes || 0;
      const noVotes = prop.votes_no || 0;
      const pct = Math.min(100, Math.round((yesVotes / threshold) * 100));
      const hasVoted = prop.user_vote !== undefined && prop.user_vote !== null;

      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <span class="badge badge-neutral" style="font-size:0.75rem;text-transform:uppercase">${prop.proposal_type.replace("_", " ")}</span>
            <h5 style="font-weight:700;font-size:1rem;color:var(--text-primary);margin-top:4px">${escHtml(prop.title)}</h5>
            ${prop.description ? `<p style="font-size:0.85rem;color:var(--text-secondary);margin-top:2px">${escHtml(prop.description)}</p>` : ""}
          </div>
          <span class="badge ${prop.status === "passed" ? "badge-success" : prop.status === "rejected" ? "badge-danger" : "badge-brand"}" style="font-size:0.75rem">
            ${prop.status}
          </span>
        </div>

        <div style="margin-top:var(--space-3)">
          <div style="display:flex;justify-content:space-between;font-size:0.8rem;color:var(--text-secondary);margin-bottom:4px">
            <span>Approval Progress (${yesVotes} / ${threshold} votes needed)</span>
            <span>${pct}%</span>
          </div>
          <div style="background:var(--bg-secondary);height:8px;border-radius:var(--radius-full);overflow:hidden">
            <div style="background:var(--brand-accent);width:${pct}%;height:100%;transition:width 0.3s ease"></div>
          </div>
        </div>

        ${prop.status === "open" ? `
          <div style="display:flex;gap:var(--space-2);justify-content:flex-end;margin-top:var(--space-3)">
            <button class="btn ${prop.user_vote === true ? "btn-primary" : "btn-secondary"} btn-sm decision-vote-btn" data-vote="yes" data-prop-id="${prop.id}">
              Approve (${yesVotes})
            </button>
            <button class="btn ${prop.user_vote === false ? "btn-primary" : "btn-secondary"} btn-sm decision-vote-btn" data-vote="no" data-prop-id="${prop.id}">
              Reject (${noVotes})
            </button>
          </div>
        ` : ""}
      `;

      card.querySelectorAll(".decision-vote-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const voteVal = btn.dataset.vote === "yes";
          try {
            await callApiJson(`/api/proposals/${prop.id}/vote`, {
              method: "POST",
              body: { vote: voteVal },
            });
            await loadGroupDecisions(groupId);
          } catch (err) {
            alert(err.message || "Failed to vote.");
          }
        });
      });

      listEl.appendChild(card);
    });
  } catch (err) {
    listEl.innerHTML = '<p style="color:var(--danger);font-size:0.85rem">Could not load proposals.</p>';
  }
}

$("gd-propose-btn").addEventListener("click", () => {
  $("propose-decision-modal").classList.add("open");
  $("prop-title").value = "";
  $("prop-desc").value = "";
});

$("propose-decision-close").addEventListener("click", () => $("propose-decision-modal").classList.remove("open"));
$("propose-decision-modal").addEventListener("click", (e) => {
  if (e.target === $("propose-decision-modal")) $("propose-decision-modal").classList.remove("open");
});

$("propose-decision-submit").addEventListener("click", async () => {
  if (!activeGroupId) return;
  const pType = $("prop-type").value;
  const title = $("prop-title").value.trim();
  const desc = $("prop-desc").value.trim();

  if (!title) {
    alert("Please enter a title for this proposal.");
    return;
  }

  setLoading("propose-decision-submit", true);
  try {
    await callApiJson(`/api/groups/${activeGroupId}/proposals`, {
      method: "POST",
      body: { proposal_type: pType, title, description: desc || null },
    });
    $("propose-decision-modal").classList.remove("open");
    await loadGroupDecisions(activeGroupId);
  } catch (err) {
    alert(err.message || "Failed to propose decision.");
  }
  setLoading("propose-decision-submit", false, "Submit Proposal");
});

// 6. Members & Invites
function renderGroupMembers(members) {
  const listEl = $("gd-members-list");
  listEl.innerHTML = "";
  if (!members.length) {
    listEl.innerHTML = '<p style="color:var(--text-secondary);font-size:0.85rem">No members found.</p>';
    return;
  }

  members.forEach((m) => {
    const prof = m.profiles || {};
    const name = prof.display_name || prof.username || "Member";
    const uId = m.user_id || prof.id;
    const isAdmin = m.role === "admin";

    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:var(--space-3);padding:var(--space-2) var(--space-3);border-radius:var(--radius-md);cursor:pointer;background:var(--bg-secondary);border:1px solid var(--border-subtle)";
    row.innerHTML = `
      <div class="avatar avatar-sm" style="width:32px;height:32px;border-radius:50%;background:var(--accent-subtle);color:var(--brand-accent);font-weight:700;display:flex;align-items:center;justify-content:center;font-size:0.85rem">
        ${prof.avatar_url ? `<img src="${escHtml(prof.avatar_url)}" alt="${escHtml(name)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">` : getInitial(name)}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:0.875rem;color:var(--text-primary)">${escHtml(name)}</div>
        <div style="font-size:0.75rem;color:var(--text-secondary)">@${escHtml(prof.username || "")}</div>
      </div>
      ${isAdmin ? '<span class="badge badge-warning" style="font-size:0.75rem">Admin</span>' : '<span class="badge badge-neutral" style="font-size:0.75rem">Member</span>'}
    `;

    if (uId) {
      row.addEventListener("click", () => openUserProfileModal(uId));
    }

    listEl.appendChild(row);
  });
}

$("gd-invite-btn").addEventListener("click", async () => {
  if (!activeGroupId) return;
  setLoading("gd-invite-btn", true);
  try {
    const data = await callApiJson(`/api/groups/${activeGroupId}/invite`, { method: "POST" });
    $("gd-invite-code").textContent = data.code;
    $("gd-invite-result").classList.remove("hidden");
  } catch (err) {
    alert("Could not generate invite code.");
  }
  setLoading("gd-invite-btn", false, "Generate Code");
});

$("gd-copy-btn").addEventListener("click", () => {
  const code = $("gd-invite-code").textContent;
  navigator.clipboard.writeText(code).then(() => {
    $("gd-copy-btn").textContent = "Copied!";
    setTimeout(() => { $("gd-copy-btn").textContent = "Copy"; }, 2000);
  });
});

// 7. External Links
async function loadGroupLinks(groupId) {
  const listEl = $("gd-links-list");
  listEl.innerHTML = '<div style="text-align:center;padding:var(--space-4)"><span class="spinner" style="width:20px;height:20px"></span></div>';
  try {
    const links = await callApiJson(`/api/groups/${groupId}/links`);
    listEl.innerHTML = "";
    if (!links.length) {
      listEl.innerHTML = '<p style="text-align:center;color:var(--text-secondary);font-size:0.875rem;padding:var(--space-4)">No external spaces linked yet.</p>';
      return;
    }

    links.forEach((l) => {
      const card = document.createElement("div");
      card.className = "card";
      card.style.cssText = "padding:var(--space-3) var(--space-4);display:flex;align-items:center;justify-content:space-between";
      card.innerHTML = `
        <div>
          <span class="badge badge-brand" style="font-size:0.75rem;text-transform:capitalize">${escHtml(l.platform)}</span>
          <div style="font-weight:700;font-size:0.95rem;color:var(--text-primary);margin-top:2px">${escHtml(l.title || l.platform)}</div>
        </div>
        <a href="${escHtml(l.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm" style="gap:var(--space-1)">
          <span class="icon-wrap" data-icon="external-link"></span>
          <span>Open</span>
        </a>
      `;
      listEl.appendChild(card);
    });
  } catch (err) {
    listEl.innerHTML = '<p style="color:var(--danger);font-size:0.85rem">Could not load links.</p>';
  }
}

$("gd-add-link-btn").addEventListener("click", () => {
  $("add-link-modal").classList.add("open");
  $("link-title").value = "";
  $("link-url").value = "";
});

$("add-link-close").addEventListener("click", () => $("add-link-modal").classList.remove("open"));
$("add-link-modal").addEventListener("click", (e) => {
  if (e.target === $("add-link-modal")) $("add-link-modal").classList.remove("open");
});

$("add-link-submit").addEventListener("click", async () => {
  if (!activeGroupId) return;
  const platform = $("link-platform").value;
  const title = $("link-title").value.trim();
  const url = $("link-url").value.trim();

  if (!url) {
    alert("Please enter a URL.");
    return;
  }

  setLoading("add-link-submit", true);
  try {
    await callApiJson(`/api/groups/${activeGroupId}/links`, {
      method: "POST",
      body: { platform, title: title || platform, url },
    });
    $("add-link-modal").classList.remove("open");
    await loadGroupLinks(activeGroupId);
  } catch (err) {
    alert(err.message || "Failed to add link.");
  }
  setLoading("add-link-submit", false, "Save Link");
});

$("group-detail-close").addEventListener("click", () => {
  $("group-detail-modal").classList.remove("open");
  activeGroupId = null;
  activeGroupData = null;
});
$("group-detail-modal").addEventListener("click", (e) => {
  if (e.target === $("group-detail-modal")) {
    $("group-detail-modal").classList.remove("open");
    activeGroupId = null;
    activeGroupData = null;
  }
});

// ── Modals: Create Group & Join Group ─────────────────────────────────────────
function openCreateGroupModal() {
  $("create-group-modal").classList.add("open");
  $("cg-name").focus();
}

function closeCreateGroupModal() {
  $("create-group-modal").classList.remove("open");
  $("cg-name").value = "";
  $("cg-desc").value = "";
  $("cg-category").value = "";
  $("cg-private").checked = true;
  $("create-group-alert").className = "alert";
}

$("open-create-group-btn").addEventListener("click", openCreateGroupModal);
$("create-group-btn-empty").addEventListener("click", openCreateGroupModal);
$("fab-create-group").addEventListener("click", openCreateGroupModal);
$("create-group-close").addEventListener("click", closeCreateGroupModal);
$("create-group-modal").addEventListener("click", (e) => {
  if (e.target === $("create-group-modal")) closeCreateGroupModal();
});

$("create-group-submit").addEventListener("click", async () => {
  const name = $("cg-name").value.trim();
  const desc = $("cg-desc").value.trim();
  const category = $("cg-category").value;
  const isPrivate = $("cg-private").checked;

  if (!name) {
    $("cg-name-err").textContent = "Group name is required.";
    $("cg-name-err").classList.add("show");
    return;
  }
  $("cg-name-err").classList.remove("show");

  setLoading("create-group-submit", true);
  try {
    const group = await callApiJson("/api/groups", {
      method: "POST",
      body: { name, description: desc || null, category: category || null, is_private: isPrivate },
    });

    closeCreateGroupModal();
    await loadMyGroups();
    openGroupDetail(group.id);
  } catch (err) {
    const alertEl = $("create-group-alert");
    alertEl.textContent = err.message || "Failed to create group.";
    alertEl.className = "alert alert-error show";
  }
  setLoading("create-group-submit", false, "Create Circle");
});

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
$("join-group-btn-empty").addEventListener("click", openJoinCodeModal);
$("join-code-close").addEventListener("click", closeJoinCodeModal);
$("join-code-modal").addEventListener("click", (e) => {
  if (e.target === $("join-code-modal")) closeJoinCodeModal();
});

$("join-code-input").addEventListener("input", (e) => {
  const pos = e.target.selectionStart;
  e.target.value = e.target.value.toUpperCase();
  e.target.setSelectionRange(pos, pos);
});

$("join-code-submit").addEventListener("click", async () => {
  const code = $("join-code-input").value.trim().toUpperCase();
  const alertEl = $("join-code-alert");

  if (code.length < 4) {
    alertEl.textContent = "Please enter an 8-character invite code.";
    alertEl.className = "alert alert-error show";
    return;
  }

  setLoading("join-code-submit", true);
  try {
    const data = await callApiJson("/api/groups/join-by-code", {
      method: "POST",
      body: { code },
    });
    alertEl.textContent = `Joined "${data.group?.name}"!`;
    alertEl.className = "alert alert-success show";

    await loadMyGroups();
    setTimeout(() => {
      closeJoinCodeModal();
      if (data.group?.id) openGroupDetail(data.group.id);
    }, 1000);
  } catch (err) {
    alertEl.textContent = err.message || "Invalid or expired code.";
    alertEl.className = "alert alert-error show";
  }
  setLoading("join-code-submit", false, "Join Circle");
});

function checkInviteCodeInUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("invite");
  if (code) {
    $("join-code-input").value = code.toUpperCase();
    openJoinCodeModal();
    window.history.replaceState({}, "", window.location.pathname);
  }
}

// ── Profile Edit & Member Profile Modals ──────────────────────────────────────
function openEditProfileModal() {
  if (!currentProfile) return;
  $("edit-profile-modal").classList.add("open");
  $("ep-display-name").value = currentProfile.display_name || "";
  $("ep-username").value = currentProfile.username || "";
  $("ep-bio").value = currentProfile.bio || "";
  $("ep-avatar-url").value = currentProfile.avatar_url || "";
}

$("profile-edit-btn").addEventListener("click", openEditProfileModal);
$("edit-profile-close").addEventListener("click", () => $("edit-profile-modal").classList.remove("open"));
$("edit-profile-modal").addEventListener("click", (e) => {
  if (e.target === $("edit-profile-modal")) $("edit-profile-modal").classList.remove("open");
});

$("edit-profile-submit").addEventListener("click", async () => {
  const displayName = $("ep-display-name").value.trim();
  const username = $("ep-username").value.trim().toLowerCase();
  const bio = $("ep-bio").value.trim();
  const avatarUrl = $("ep-avatar-url").value.trim();

  if (!displayName || !username) {
    alert("Display name and username are required.");
    return;
  }

  setLoading("edit-profile-submit", true);
  try {
    const updated = await callApiJson("/api/me", {
      method: "PUT",
      body: { display_name: displayName, username, bio: bio || null, avatar_url: avatarUrl || null },
    });
    currentProfile = updated;
    renderUserProfile(currentProfile);
    $("edit-profile-modal").classList.remove("open");
  } catch (err) {
    alert(err.message || "Failed to update profile.");
  }
  setLoading("edit-profile-submit", false, "Save Changes");
});

async function openUserProfileModal(userId) {
  const modal = $("user-profile-modal");
  modal.classList.add("open");
  $("user-profile-loading").classList.remove("hidden");
  $("user-profile-content").classList.add("hidden");

  try {
    const data = await callApiJson(`/api/profiles/${userId}`);
    const prof = data.profile || {};
    const visibleGroups = data.visible_groups || [];

    const av = $("up-avatar");
    if (prof.avatar_url) {
      av.innerHTML = `<img src="${escHtml(prof.avatar_url)}" alt="${escHtml(prof.display_name)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    } else {
      av.textContent = getInitial(prof.display_name || prof.username);
    }

    $("up-display-name").textContent = prof.display_name || prof.username;
    $("up-username").textContent = `@${prof.username}`;
    $("up-bio").textContent = prof.bio || "No bio yet.";
    $("up-groups-count").textContent = data.total_groups_count || 0;
    $("up-shared-count").textContent = visibleGroups.length;

    const listEl = $("up-groups-list");
    listEl.innerHTML = "";
    if (!visibleGroups.length) {
      listEl.innerHTML = '<p style="color:var(--text-secondary);font-size:0.85rem;text-align:center;padding:var(--space-4)">No visible groups shared with you.</p>';
    } else {
      visibleGroups.forEach((g) => {
        listEl.appendChild(buildGroupCard(g));
      });
    }

    $("user-profile-loading").classList.add("hidden");
    $("user-profile-content").classList.remove("hidden");
    renderIcons();
  } catch (err) {
    $("user-profile-loading").innerHTML = '<p style="color:var(--danger);font-size:0.85rem">Could not load member profile.</p>';
  }
}

$("user-profile-close").addEventListener("click", () => $("user-profile-modal").classList.remove("open"));
$("user-profile-modal").addEventListener("click", (e) => {
  if (e.target === $("user-profile-modal")) $("user-profile-modal").classList.remove("open");
});

// ── Tab Switching ─────────────────────────────────────────────────────────────
const TAB_CFG = {
  feed:    { title: "Feed",    logo: true,  action: false },
  explore: { title: "Explore", logo: false, action: false },
  groups:  { title: "Groups",  logo: false, action: true },
  chat:    { title: "Chat",    logo: false, action: false },
  profile: { title: "Profile", logo: false, action: false },
};

function switchTab(tabName) {
  // Mobile tab items
  document.querySelectorAll(".tab-item").forEach((t) => t.classList.remove("active"));
  const mTab = $(`tab-${tabName}`);
  if (mTab) mTab.classList.add("active");

  // Desktop sidebar nav items
  document.querySelectorAll(".sidebar-nav-item").forEach((t) => t.classList.remove("active"));
  const dTab = $(`side-tab-${tabName}`);
  if (dTab) dTab.classList.add("active");

  // Screens
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  const sc = $(`screen-${tabName}`);
  if (sc) sc.classList.add("active");

  const cfg = TAB_CFG[tabName] || {};
  const logoEl = $("topbar-logo");
  const titleEl = $("topbar-title");
  const actEl = $("topbar-action");

  if (cfg.logo) {
    if (logoEl) logoEl.classList.remove("hidden");
    if (titleEl) titleEl.classList.add("hidden");
  } else {
    if (logoEl) logoEl.classList.add("hidden");
    if (titleEl) {
      titleEl.textContent = cfg.title;
      titleEl.classList.remove("hidden");
    }
  }

  if (actEl) actEl.style.display = cfg.action ? "inline-flex" : "none";

  const fab = $("fab-create-group");
  if (fab) fab.classList.toggle("hidden", tabName !== "groups");

  // Load screen data if needed
  if (tabName === "feed") loadFeed();
  if (tabName === "explore") loadExplore();
  if (tabName === "groups") loadMyGroups();

  renderIcons();
}

document.querySelectorAll(".tab-item").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

document.querySelectorAll(".sidebar-nav-item").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

$("topbar-action").addEventListener("click", openCreateGroupModal);
$("feed-go-groups").addEventListener("click", () => switchTab("groups"));
$("chat-go-groups").addEventListener("click", () => switchTab("groups"));
$("sidebar-user-pill").addEventListener("click", () => switchTab("profile"));

// ── Theme Switcher Triggers ───────────────────────────────────────────────────
$("desktop-theme-toggle").addEventListener("click", toggleTheme);
$("mobile-theme-toggle").addEventListener("click", toggleTheme);
$("profile-theme-btn").addEventListener("click", toggleTheme);

// ── Sign Out ──────────────────────────────────────────────────────────────────
$("signout-btn").addEventListener("click", async () => {
  await signOut();
});
