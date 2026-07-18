// auth.js — sign-in gate + Firestore progress sync.
//
// Loaded as a plain classic script, AFTER app.js. app.js no longer calls
// boot() itself; it assigns `window.__appReady = boot`. This file decides
// when to actually call it: immediately, in local-only mode, if Firebase
// isn't configured yet or is unreachable, or once a user is signed in.
//
// This keeps the site working (local-only, exactly as before) at every
// point in the rollout — before Firebase is set up, while it's being set
// up, and if the CDN/network is unavailable — and switches on the real
// account gate the moment a valid config is present and reachable.
(() => {
  "use strict";

  const APP_ID = "nablyudatel";
  const SDK = "https://www.gstatic.com/firebasejs/10.14.1/";
  // The owner's account is always auto-approved (and self-heals if the
  // Firestore flag is ever accidentally left off) — everyone else who signs
  // in starts as "pending" until approved manually via the Firebase Console:
  // Firestore -> apps/nablyudatel/users/{uid} -> set approved: true.
  const OWNER_EMAIL = "omarumarov1@gmail.com";

  const gateEl = document.getElementById("authGate");
  const appRootEl = document.getElementById("app");
  const accountBtn = document.getElementById("accountToggle");
  const accountModal = document.getElementById("accountModal");
  const pendingEl = document.getElementById("pendingGate");
  const pendingEmailEl = document.getElementById("pendingEmail");
  const pendingSignOutBtn = document.getElementById("pendingSignOutBtn");

  function showPending(user) {
    if (!pendingEl) return;
    if (pendingEmailEl) pendingEmailEl.textContent = user.email || user.displayName || "";
    pendingEl.classList.remove("hidden");
  }
  function hidePending() {
    if (pendingEl) pendingEl.classList.add("hidden");
  }

  function revealApp() {
    gateEl.classList.add("hidden");
    appRootEl.classList.remove("hidden");
  }

  function startApp() {
    if (window.__appStarted) return;
    window.__appStarted = true;
    window.__appReady && window.__appReady();
  }

  function localOnlyMode() {
    revealApp();
    if (accountBtn) accountBtn.classList.add("hidden");
    startApp();
  }

  const cfg = window.FIREBASE_CONFIG;
  const isConfigured = !!(cfg && cfg.apiKey && cfg.apiKey.indexOf("REPLACE_ME") === -1);
  if (!isConfigured) { localOnlyMode(); return; }

  (async () => {
    let firebaseApp, authApi, fsApi;
    try {
      const [{ initializeApp }, authNs, fsNs] = await Promise.all([
        import(SDK + "firebase-app.js"),
        import(SDK + "firebase-auth.js"),
        import(SDK + "firebase-firestore.js"),
      ]);
      authApi = authNs;
      fsApi = fsNs;
      firebaseApp = initializeApp(cfg);
    } catch (err) {
      console.warn("Firebase unavailable — continuing in local-only mode.", err);
      localOnlyMode();
      return;
    }

    const {
      getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
      createUserWithEmailAndPassword, signInWithEmailAndPassword,
      sendPasswordResetEmail, signOut,
    } = authApi;
    const { getFirestore, doc, getDoc, setDoc, serverTimestamp } = fsApi;

    const auth = getAuth(firebaseApp);
    const db = getFirestore(firebaseApp);

    const googleBtn = document.getElementById("authGoogleBtn");
    const form = document.getElementById("authForm");
    const emailInput = document.getElementById("authEmail");
    const passwordInput = document.getElementById("authPassword");
    const submitBtn = document.getElementById("authSubmitBtn");
    const modeToggleBtn = document.getElementById("authModeToggle");
    const forgotLink = document.getElementById("authForgotLink");
    const errorEl = document.getElementById("authError");
    const accountEmailEl = document.getElementById("accountEmail");
    const signOutBtn = document.getElementById("signOutBtn");

    let mode = "signin";
    let pushTimer = null;

    function setError(msg) { errorEl.textContent = msg || ""; }

    function setMode(next) {
      mode = next;
      submitBtn.textContent = mode === "signin" ? "Sign in" : "Create account";
      modeToggleBtn.textContent = mode === "signin"
        ? "New here? Create an account"
        : "Already have an account? Sign in";
      setError("");
    }

    function friendlyError(err) {
      const map = {
        "auth/invalid-email": "That email address doesn't look right.",
        "auth/user-not-found": "No account found with that email.",
        "auth/wrong-password": "Incorrect password.",
        "auth/invalid-credential": "Incorrect email or password.",
        "auth/email-already-in-use": "An account already exists with that email — try signing in instead.",
        "auth/weak-password": "Password should be at least 6 characters.",
        "auth/popup-closed-by-user": "Sign-in window closed before completing.",
        "auth/network-request-failed": "Network error — check your connection and try again.",
      };
      return (err && map[err.code]) || (err && err.message) || "Something went wrong. Please try again.";
    }

    googleBtn.addEventListener("click", async () => {
      setError("");
      try { await signInWithPopup(auth, new GoogleAuthProvider()); }
      catch (err) { setError(friendlyError(err)); }
    });

    form.addEventListener("submit", async e => {
      e.preventDefault();
      setError("");
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (!email || !password) { setError("Enter an email and password."); return; }
      submitBtn.disabled = true;
      try {
        if (mode === "signin") await signInWithEmailAndPassword(auth, email, password);
        else await createUserWithEmailAndPassword(auth, email, password);
      } catch (err) {
        setError(friendlyError(err));
      } finally {
        submitBtn.disabled = false;
      }
    });

    modeToggleBtn.addEventListener("click", () => setMode(mode === "signin" ? "signup" : "signin"));

    forgotLink.addEventListener("click", async e => {
      e.preventDefault();
      const email = emailInput.value.trim();
      if (!email) { setError('Enter your email above first, then click "Forgot password?".'); return; }
      try {
        await sendPasswordResetEmail(auth, email);
        setError("Password reset email sent — check your inbox.");
      } catch (err) {
        setError(friendlyError(err));
      }
    });

    if (accountBtn) {
      accountBtn.addEventListener("click", () => accountModal.classList.remove("hidden"));
      document.getElementById("accountClose").addEventListener("click", () => accountModal.classList.add("hidden"));
      accountModal.addEventListener("click", e => { if (e.target === accountModal) accountModal.classList.add("hidden"); });
      signOutBtn.addEventListener("click", () => signOut(auth));
    }
    if (pendingSignOutBtn) {
      pendingSignOutBtn.addEventListener("click", () => signOut(auth));
    }

    window.CloudSync = {
      appId: APP_ID,
      user: null,
      async pullProgress() {
        if (!this.user) return null;
        const snap = await getDoc(doc(db, "apps", APP_ID, "users", this.user.uid));
        if (!snap.exists()) return null;
        const data = snap.data();
        if (!data.progressJson) return null;
        try { return JSON.parse(data.progressJson); } catch (e) { return null; }
      },
      pushProgress(payload) {
        if (!this.user) return;
        clearTimeout(pushTimer);
        pushTimer = setTimeout(() => {
          setDoc(doc(db, "apps", APP_ID, "users", this.user.uid), {
            email: this.user.email || null,
            displayName: this.user.displayName || null,
            progressJson: JSON.stringify(payload),
            updatedAt: serverTimestamp(),
          }, { merge: true }).catch(() => { /* offline — next save will retry */ });
        }, 800);
      },
    };

    onAuthStateChanged(auth, async user => {
      window.CloudSync.user = user;
      if (user) {
        const ref = doc(db, "apps", APP_ID, "users", user.uid);
        const isOwner = !!(user.email && user.email.toLowerCase() === OWNER_EMAIL);
        let approved = isOwner;
        try {
          const existing = await getDoc(ref);
          const patch = {
            email: user.email || null,
            displayName: user.displayName || null,
            lastSeen: serverTimestamp(),
          };
          if (!existing.exists()) {
            patch.createdAt = serverTimestamp();
            patch.approved = isOwner; // owner auto-approved; everyone else starts pending
          } else if (isOwner && existing.data().approved !== true) {
            patch.approved = true; // never let the owner get locked out
          }
          await setDoc(ref, patch, { merge: true });
          approved = isOwner || (existing.exists() ? existing.data().approved === true : isOwner);
        } catch (e) { /* offline — profile touch skipped, fall back to isOwner only */ }

        if (!approved) {
          gateEl.classList.add("hidden");
          appRootEl.classList.add("hidden");
          showPending(user);
          return;
        }
        hidePending();

        revealApp();
        if (accountBtn) {
          accountBtn.classList.remove("hidden");
          accountEmailEl.textContent = user.email || user.displayName || "Signed in";
        }
        startApp();
      } else {
        window.__appStarted = false;
        hidePending();
        gateEl.classList.remove("hidden");
        appRootEl.classList.add("hidden");
        if (accountBtn) accountBtn.classList.add("hidden");
        if (accountModal) accountModal.classList.add("hidden");
      }
    });
  })();
})();
