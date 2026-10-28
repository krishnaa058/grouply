/**
 * frontend_auth.js — Grouply
 *
 * Supabase-js v2 auth helpers.
 * Provides: signUp, signIn, signInWithGoogle, signOut, getSession,
 *           onAuthStateChange, resetPasswordForEmail, updatePassword,
 *           callApi (authenticated fetch to Flask backend).
 *
 * The Supabase client is exported as `supabase` so other modules can use it.
 * Config is read from window.GROUPLY_CONFIG injected by the HTML page.
 */

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// ── Init ──────────────────────────────────────────────────────────────────────
const { SUPABASE_URL, SUPABASE_ANON_KEY, API_BASE_URL } = window.GROUPLY_CONFIG;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,   // handles OAuth redirect fragment automatically
  },
});

// ── Auth helpers ──────────────────────────────────────────────────────────────

/** Sign up with email + password. Supabase sends confirmation email. */
export async function signUp(email, password, displayName) {
  return supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: displayName },
    },
  });
}

/** Sign in with email + password. */
export async function signIn(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

/**
 * Sign in with Google via OAuth redirect.
 * Supabase handles the redirect back and stores the session.
 * @param {string} [redirectTo] – full URL to land on after sign-in (defaults to origin)
 */
export async function signInWithGoogle(redirectTo) {
  return supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: redirectTo || `${window.location.origin}/`,
      queryParams: {
        access_type: "offline",
        prompt: "consent",
      },
    },
  });
}

/** Sign out and clear local session. */
export async function signOut() {
  return supabase.auth.signOut();
}

/**
 * Get the current session.
 * Always call this fresh — never cache the token yourself.
 * Returns null if no session.
 */
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

/** Subscribe to auth state changes (SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED). */
export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
}

/**
 * Send a password-reset email.
 * @param {string} email
 * @param {string} redirectTo – the URL of your reset-password page
 */
export async function resetPasswordForEmail(email, redirectTo) {
  return supabase.auth.resetPasswordForEmail(email, {
    redirectTo: redirectTo || `${window.location.origin}/login.html#reset`,
  });
}

/**
 * Update the authenticated user's password (call from the reset-password page,
 * after the user has clicked the email link and been redirected back).
 */
export async function updatePassword(newPassword) {
  return supabase.auth.updateUser({ password: newPassword });
}

// ── Authenticated API calls to Flask backend ──────────────────────────────────

/**
 * callApi — wrapper around fetch that injects the Supabase JWT as a Bearer token.
 *
 * @param {string} path    – e.g. "/api/me"
 * @param {object} options – standard fetch options; body will be JSON-stringified if object
 * @returns {Promise<Response>}
 */
export async function callApi(path, options = {}) {
  const session = await getSession();
  if (!session) {
    throw new Error("Not authenticated");
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.access_token}`,
    ...(options.headers || {}),
  };

  let body = options.body;
  if (body && typeof body === "object" && !(body instanceof FormData)) {
    body = JSON.stringify(body);
    // If body is a plain object, Content-Type is already set to JSON above.
  } else if (body instanceof FormData) {
    // Let browser set multipart Content-Type (with boundary)
    delete headers["Content-Type"];
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    body,
  });

  return response;
}

/**
 * Convenience: callApi + parse JSON.
 * Throws if the response is not ok.
 */
export async function callApiJson(path, options = {}) {
  const res = await callApi(path, options);
  const data = await res.json();
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "API error"), { status: res.status, data });
  }
  return data;
}
