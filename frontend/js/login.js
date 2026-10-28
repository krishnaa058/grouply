/**
 * login.js — Auth page controller
 * Handles: login, signup, Google OAuth, forgot password, reset password.
 * On success → redirect to index.html (main app) or onboarding.html.
 */

import {
  signIn, signUp, signInWithGoogle,
  resetPasswordForEmail, updatePassword,
  getSession, onAuthStateChange,
  callApiJson,
} from "./frontend_auth.js";

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function showAlert(msg, type = "error") {
  const el = $("auth-alert");
  el.textContent = msg;
  el.className = `alert alert-${type} show`;
}
function clearAlert() {
  const el = $("auth-alert");
  el.className = "alert";
  el.textContent = "";
}

function showPanel(name) {
  document.querySelectorAll(".auth-panel").forEach((p) => p.classList.remove("active"));
  $(`panel-${name}`).classList.add("active");
  clearAlert();
}

function setLoading(btnId, loading) {
  const btn = $(btnId);
  if (loading) {
    btn.dataset.origText = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span>';
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.origText || btn.textContent;
    btn.disabled = false;
  }
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function togglePw(inputId) {
  const inp = $(inputId);
  inp.type = inp.type === "password" ? "text" : "password";
}

// ── Redirect after successful auth ────────────────────────────────────────────
async function handlePostAuth() {
  try {
    const profile = await callApiJson("/api/me");
    // If profile has no chosen display name, send to onboarding
    // (Trigger creates a username but display_name might be null for email signups)
    if (!profile.display_name) {
      window.location.href = "onboarding.html";
    } else {
      window.location.href = "index.html";
    }
  } catch {
    // If backend unreachable or no profile yet, go to onboarding
    window.location.href = "onboarding.html";
  }
}

// ── Check if already signed in ────────────────────────────────────────────────
(async () => {
  const session = await getSession();
  if (session) {
    await handlePostAuth();
    return;
  }

  // Check if this is a password-reset redirect (Supabase adds #type=recovery)
  const hash = window.location.hash;
  if (hash.includes("type=recovery") || hash.includes("type=signup")) {
    // supabase-js v2 detects session from URL hash automatically
    // Wait briefly for it to settle
    setTimeout(async () => {
      const s = await getSession();
      if (s && hash.includes("type=recovery")) {
        showPanel("reset");
      }
    }, 500);
  }
})();

// React to auth state changes (e.g. OAuth redirect lands here)
onAuthStateChange(async (event, session) => {
  if (event === "SIGNED_IN" && session) {
    await handlePostAuth();
  }
  if (event === "PASSWORD_RECOVERY") {
    showPanel("reset");
  }
});

// ── Password toggle ───────────────────────────────────────────────────────────
$("login-pw-toggle").addEventListener("click",  () => togglePw("login-password"));
$("signup-pw-toggle").addEventListener("click", () => togglePw("signup-password"));
$("reset-pw-toggle").addEventListener("click",  () => togglePw("reset-password"));

// ── Panel navigation ──────────────────────────────────────────────────────────
$("goto-signup").addEventListener("click",  () => showPanel("signup"));
$("goto-login").addEventListener("click",   () => showPanel("login"));
$("goto-forgot").addEventListener("click",  () => showPanel("forgot"));
$("forgot-back").addEventListener("click",  () => showPanel("login"));

// ── LOGIN form ────────────────────────────────────────────────────────────────
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert();

  const email    = $("login-email").value.trim();
  const password = $("login-password").value;
  let valid = true;

  if (!validateEmail(email)) {
    $("login-email-err").textContent = "Enter a valid email";
    $("login-email-err").classList.add("show");
    $("login-email").classList.add("error");
    valid = false;
  } else {
    $("login-email-err").classList.remove("show");
    $("login-email").classList.remove("error");
  }

  if (!password) {
    $("login-pw-err").textContent = "Password is required";
    $("login-pw-err").classList.add("show");
    valid = false;
  } else {
    $("login-pw-err").classList.remove("show");
  }

  if (!valid) return;

  setLoading("login-submit", true);
  const { error } = await signIn(email, password);
  setLoading("login-submit", false);

  if (error) {
    showAlert(error.message === "Invalid login credentials"
      ? "Incorrect email or password."
      : error.message);
  }
  // On success, onAuthStateChange fires SIGNED_IN → handlePostAuth
});

// ── SIGNUP form ───────────────────────────────────────────────────────────────
$("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert();

  const name     = $("signup-name").value.trim();
  const email    = $("signup-email").value.trim();
  const password = $("signup-password").value;
  let valid = true;

  if (!validateEmail(email)) {
    $("signup-email-err").textContent = "Enter a valid email";
    $("signup-email-err").classList.add("show");
    $("signup-email").classList.add("error");
    valid = false;
  } else {
    $("signup-email-err").classList.remove("show");
    $("signup-email").classList.remove("error");
  }

  if (password.length < 8) {
    $("signup-pw-err").textContent = "Password must be at least 8 characters";
    $("signup-pw-err").classList.add("show");
    $("signup-password").classList.add("error");
    valid = false;
  } else {
    $("signup-pw-err").classList.remove("show");
    $("signup-password").classList.remove("error");
  }

  if (!valid) return;

  setLoading("signup-submit", true);
  const { data, error } = await signUp(email, password, name);
  setLoading("signup-submit", false);

  if (error) {
    showAlert(error.message);
    return;
  }

  // Supabase sends confirmation email. If email confirm is required,
  // the session won't be set yet.
  if (data?.user && !data.session) {
    showAlert(
      "✉️ Check your email to confirm your account, then sign in.",
      "info"
    );
    showPanel("login");
  }
  // If confirm is disabled (dev mode), SIGNED_IN fires → handlePostAuth
});

// ── GOOGLE buttons ────────────────────────────────────────────────────────────
async function handleGoogle() {
  clearAlert();
  const { error } = await signInWithGoogle(`${window.location.origin}/login.html`);
  if (error) showAlert(error.message);
  // Browser redirects to Google; on return supabase-js handles session
}
$("google-signin-btn").addEventListener("click", handleGoogle);
$("google-signup-btn").addEventListener("click", handleGoogle);

// ── FORGOT PASSWORD form ──────────────────────────────────────────────────────
$("forgot-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert();

  const email = $("forgot-email").value.trim();
  if (!validateEmail(email)) {
    $("forgot-email-err").textContent = "Enter a valid email";
    $("forgot-email-err").classList.add("show");
    return;
  }
  $("forgot-email-err").classList.remove("show");

  setLoading("forgot-submit", true);
  const { error } = await resetPasswordForEmail(
    email,
    `${window.location.origin}/login.html`
  );
  setLoading("forgot-submit", false);

  if (error) {
    showAlert(error.message);
  } else {
    showAlert("✉️ Reset link sent! Check your email.", "success");
  }
});

// ── RESET PASSWORD form ───────────────────────────────────────────────────────
$("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert();

  const pw      = $("reset-password").value;
  const confirm = $("reset-confirm").value;
  let valid = true;

  if (pw.length < 8) {
    $("reset-pw-err").textContent = "Minimum 8 characters";
    $("reset-pw-err").classList.add("show");
    valid = false;
  } else {
    $("reset-pw-err").classList.remove("show");
  }

  if (pw !== confirm) {
    $("reset-confirm-err").textContent = "Passwords do not match";
    $("reset-confirm-err").classList.add("show");
    valid = false;
  } else {
    $("reset-confirm-err").classList.remove("show");
  }

  if (!valid) return;

  setLoading("reset-submit", true);
  const { error } = await updatePassword(pw);
  setLoading("reset-submit", false);

  if (error) {
    showAlert(error.message);
  } else {
    showAlert("✅ Password updated! Signing you in…", "success");
    setTimeout(() => (window.location.href = "index.html"), 1500);
  }
});
