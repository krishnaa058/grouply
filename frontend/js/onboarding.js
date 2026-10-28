/**
 * onboarding.js — Profile setup page controller
 * Shows after first login. Saves chosen username + display name to the backend.
 */

import {
  getSession, onAuthStateChange, callApi, callApiJson,
} from "./frontend_auth.js";

const $ = (id) => document.getElementById(id);

// ── Route guard ───────────────────────────────────────────────────────────────
(async () => {
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
  // Pre-fill from Google metadata if available
  await prefillFromProfile(session);
})();

onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") window.location.href = "login.html";
});

// ── Pre-fill form from existing profile ───────────────────────────────────────
async function prefillFromProfile(session) {
  try {
    const profile = await callApiJson("/api/me");

    // If profile already has display_name, user somehow landed here again
    // Check if they already have a complete profile; if so, go to app
    if (profile.display_name && profile.username &&
        !profile.username.match(/^[a-z0-9]+_[a-f0-9]{4}$/)) {
      // Looks like a manually-chosen username, skip onboarding
      window.location.href = "index.html";
      return;
    }

    // Pre-fill display name from Google name or existing value
    const meta = session.user?.user_metadata || {};
    const nameVal = profile.display_name || meta.full_name || meta.name || "";
    $("ob-name").value = nameVal;
    updateAvatarPreview(nameVal);

    // Pre-fill username (the auto-generated one)
    if (profile.username) {
      $("ob-username").value = profile.username;
    }

    // Pre-fill avatar if Google provides it
    if (profile.avatar_url || meta.avatar_url) {
      const url = profile.avatar_url || meta.avatar_url;
      const img = document.createElement("img");
      img.src = url;
      img.className = "avatar avatar-xl";
      img.alt = "Profile photo";
      img.style.cssText = "width:96px;height:96px";
      img.onerror = () => {};
      $("avatar-preview").replaceWith(img);
    }
  } catch {
    // Backend not running — still show the form
  }
}

// ── Avatar initial ────────────────────────────────────────────────────────────
$("ob-name").addEventListener("input", () => {
  updateAvatarPreview($("ob-name").value);
});

function updateAvatarPreview(name) {
  const el = $("avatar-preview");
  if (!el || el.tagName === "IMG") return;
  const initial = (name || "?")[0].toUpperCase();
  el.textContent = initial;
}

// ── Live username availability check ──────────────────────────────────────────
let checkTimer = null;

$("ob-username").addEventListener("input", () => {
  clearTimeout(checkTimer);
  const status = $("username-status");
  const val = $("ob-username").value.trim().toLowerCase();

  if (!val) { status.textContent = ""; status.className = "username-status"; return; }
  if (!/^[a-z0-9_]{3,30}$/.test(val)) {
    status.textContent = "3–30 chars, only a–z, 0–9, _";
    status.className = "username-status taken";
    return;
  }

  status.textContent = "Checking…";
  status.className = "username-status checking";

  checkTimer = setTimeout(async () => {
    try {
      const data = await callApiJson(`/api/username/check?username=${encodeURIComponent(val)}`);
      if (data.available) {
        status.textContent = "✓ Available";
        status.className = "username-status available";
        $("ob-username").classList.remove("error");
        $("ob-username").classList.add("success");
      } else {
        status.textContent = "✗ Already taken";
        status.className = "username-status taken";
        $("ob-username").classList.add("error");
        $("ob-username").classList.remove("success");
      }
    } catch {
      status.textContent = "";
      status.className = "username-status";
    }
  }, 500);
});

// ── Alert helper ──────────────────────────────────────────────────────────────
function showAlert(msg, type = "error") {
  const el = $("onboard-alert");
  el.textContent = msg;
  el.className = `alert alert-${type} show`;
}

function setLoading(loading) {
  const btn = $("onboard-submit");
  if (loading) {
    btn.dataset.origText = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span>';
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.origText || "Continue to Grouply";
    btn.disabled = false;
  }
}

// ── Form submit ───────────────────────────────────────────────────────────────
$("onboard-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAlert("", "error"); // clear

  const username    = $("ob-username").value.trim().toLowerCase();
  const displayName = $("ob-name").value.trim();
  const bio         = $("ob-bio").value.trim();

  let valid = true;

  if (!username || !/^[a-z0-9_]{3,30}$/.test(username)) {
    $("ob-username-err").textContent = "Enter a valid username (3–30 chars, a–z, 0–9, _)";
    $("ob-username-err").classList.add("show");
    valid = false;
  } else {
    $("ob-username-err").classList.remove("show");
  }

  if (!displayName) {
    $("ob-name-err").textContent = "Display name is required";
    $("ob-name-err").classList.add("show");
    valid = false;
  } else {
    $("ob-name-err").classList.remove("show");
  }

  if (!valid) return;

  setLoading(true);
  try {
    await callApiJson("/api/me/onboard", {
      method: "POST",
      body: { username, display_name: displayName, bio: bio || null },
    });
    window.location.href = "index.html";
  } catch (err) {
    setLoading(false);
    if (err.status === 409) {
      showAlert("That username is already taken — try another.");
      $("username-status").textContent = "✗ Already taken";
      $("username-status").className = "username-status taken";
    } else {
      showAlert(err.message || "Something went wrong. Please try again.");
    }
  }
});
