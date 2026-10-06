import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  signInAnonymously, signOut, RecaptchaVerifier, signInWithPhoneNumber,
  PhoneAuthProvider, linkWithCredential, signInWithCredential
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const $ = id => document.getElementById(id);
const statusEl = $("accountStatus");
const messageEl = $("authMessage");
const googleBtn = $("googleLoginBtn");
const guestBtn = $("guestLoginBtn");
const sendBtn = $("sendOtpBtn");
const verifyBtn = $("verifyOtpBtn");
const signOutBtn = $("signOutBtn");
let auth = null, db = null, recaptcha = null, confirmation = null, phoneNumber = "";
let cloudReady = false;
let saveTimer = null;

function message(text, bad=false) {
  if (!messageEl) return;
  messageEl.textContent = text || "";
  messageEl.style.color = bad ? "#ff8a8a" : "#ffd166";
}
function configReady() {
  return firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_") &&
    firebaseConfig.projectId && !firebaseConfig.projectId.startsWith("YOUR_") &&
    firebaseConfig.appId && !firebaseConfig.appId.startsWith("YOUR_");
}
function currentLocalProfile() {
  try {
    const p = JSON.parse(localStorage.getItem("4gaprush_profile") || "null");
    if (p && typeof p === "object") return {
      points: Math.max(0, Number(p.points) || 0),
      owned: Array.isArray(p.owned) ? [...new Set(["starter", ...p.owned])] : ["starter"],
      equipped: p.equipped || "starter",
      lastRewardRace: p.lastRewardRace || ""
    };
  } catch {}
  return {points:0, owned:["starter"], equipped:"starter", lastRewardRace:""};
}
function applyProfile(p) {
  const clean = {
    points: Math.max(0, Number(p?.points) || 0),
    owned: Array.isArray(p?.owned) ? [...new Set(["starter", ...p.owned])] : ["starter"],
    equipped: p?.equipped || "starter",
    lastRewardRace: p?.lastRewardRace || ""
  };
  if (!clean.owned.includes(clean.equipped)) clean.equipped = "starter";
  localStorage.setItem("4gaprush_profile", JSON.stringify(clean));
  // The existing game owns its profile object; reload once so every shop/race
  // subsystem reads the authenticated cloud profile consistently.
  location.reload();
}
async function readCloudProfile(user) {
  if (!db || !user) return null;
  try {
    const snap = await getDoc(doc(db, "playerProfiles", user.uid));
    return snap.exists() ? snap.data() : null;
  } catch (e) {
    console.warn("4 GAP RUSH profile read failed:", e);
    message("Login works, but cloud profile storage is not ready. Check Firestore setup/rules.", true);
    return null;
  }
}
async function saveCloudProfile(profile) {
  if (!db || !auth?.currentUser || !cloudReady) return;
  const user = auth.currentUser;
  const payload = {
    points: Math.max(0, Number(profile.points) || 0),
    owned: Array.isArray(profile.owned) ? [...new Set(["starter", ...profile.owned])] : ["starter"],
    equipped: profile.equipped || "starter",
    lastRewardRace: profile.lastRewardRace || "",
    displayName: user.displayName || "",
    email: user.email || "",
    updatedAt: serverTimestamp()
  };
  try {
    await setDoc(doc(db, "playerProfiles", user.uid), payload, {merge:true});
  } catch (e) {
    console.warn("4 GAP RUSH profile save failed:", e);
    message("Signed in, but points/outfits could not sync. Enable Firestore and its rules.", true);
  }
}
async function afterSignIn(user) {
  if (!user) return;
  const local = currentLocalProfile();
  const cloud = await readCloudProfile(user);
  if (cloud) {
    // Cloud is the durable account profile. Preserve any progress made locally
    // since the last sync rather than silently discarding it.
    const merged = {
      points: Math.max(local.points, Number(cloud.points) || 0),
      owned: [...new Set(["starter", ...(cloud.owned || []), ...local.owned])],
      equipped: local.equipped && (local.owned.includes(local.equipped) || (cloud.owned||[]).includes(local.equipped))
        ? local.equipped : (cloud.equipped || "starter"),
      lastRewardRace: local.lastRewardRace || cloud.lastRewardRace || ""
    };
    cloudReady = true;
    applyProfile(merged);
    return;
  }
  cloudReady = true;
  await saveCloudProfile(local);
  statusEl.textContent = user.isAnonymous
    ? "Guest account active on this device."
    : "Signed in: " + (user.displayName || user.phoneNumber || user.email || "Player");
}
function setUserUI(user) {
  if (user) {
    statusEl.textContent = (user.isAnonymous ? "👤 Guest account" : "✅ Signed in: " +
      (user.displayName || user.phoneNumber || user.email || "Player")) +
      (user.isAnonymous ? " • link Google/phone to keep progress" : "");
    googleBtn.textContent = user.isAnonymous ? "Link Google account" : "Continue with Google";
    guestBtn.classList.toggle("hidden", !!user);
    signOutBtn.classList.remove("hidden");
  } else {
    statusEl.textContent = "Not signed in — guest play is available.";
    googleBtn.textContent = "Continue with Google";
    guestBtn.classList.remove("hidden");
    signOutBtn.classList.add("hidden");
  }
}
function setupRecaptcha() {
  if (recaptcha) {
    try { recaptcha.clear(); } catch {}
  }
  recaptcha = new RecaptchaVerifier(auth, "recaptcha-container", { size: "normal" });
  return recaptcha;
}
if (!configReady()) {
  message("Firebase setup pending: Google/OTP login need your Firebase web config. Guest play works now.");
  googleBtn.addEventListener("click", () => message("Add your Firebase Web App config to public/firebase-config.js first.", true));
  guestBtn.addEventListener("click", () => {
    const name = $("name")?.value?.trim() || "Guest";
    localStorage.setItem("4gaprush_guest_name", name);
    message("Guest mode is ready. You can create or join a room.");
    statusEl.textContent = "👤 Guest play on this device (cloud account not configured).";
    guestBtn.textContent = "GUEST READY";
  });
  sendBtn.addEventListener("click", () => message("Configure Firebase and enable Phone sign-in before requesting OTP.", true));
  verifyBtn.addEventListener("click", () => message("Request an OTP after Firebase setup.", true));
} else {
  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    auth.useDeviceLanguage();
    onAuthStateChanged(auth, user => {
      setUserUI(user);
      if (user) afterSignIn(user).catch(e => message(e.message || "Could not load profile.", true));
      else cloudReady = false;
    });
    googleBtn.addEventListener("click", async () => {
      try {
        const provider = new GoogleAuthProvider();
        const user = auth.currentUser;
        if (user?.isAnonymous) await linkWithPopup(user, provider);
        else await signInWithPopup(auth, provider);
        message("Google account connected.");
      } catch (e) {
        message(e.code === "auth/unauthorized-domain"
          ? "This domain is not authorized in Firebase Authentication."
          : (e.message || "Google sign-in failed."), true);
      }
    });
    guestBtn.addEventListener("click", async () => {
      try {
        await signInAnonymously(auth);
        message("Guest account created. Link Google or phone later to keep progress.");
      } catch (e) { message(e.message || "Guest sign-in failed. Enable Anonymous provider.", true); }
    });
    sendBtn.addEventListener("click", async () => {
      try {
        phoneNumber = $("phoneNumber").value.trim().replace(/[\s()-]/g, "");
        if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
          message("Use international format, e.g. +919876543210.", true); return;
        }
        const verifier = setupRecaptcha();
        confirmation = await signInWithPhoneNumber(auth, phoneNumber, verifier);
        $("otpStep").classList.remove("hidden");
        message("OTP sent. Enter the code from SMS.");
      } catch (e) {
        try { recaptcha?.clear(); } catch {}
        recaptcha = null;
        message(e.message || "Could not send OTP. Check Phone provider, domain and SMS region settings.", true);
      }
    });
    verifyBtn.addEventListener("click", async () => {
      try {
        const code = $("otpCode").value.trim();
        if (!/^\d{6}$/.test(code)) { message("Enter the 6-digit OTP.", true); return; }
        if (!confirmation) { message("Tap SEND OTP first.", true); return; }
        const credential = PhoneAuthProvider.credential(confirmation.verificationId, code);
        if (auth.currentUser?.isAnonymous) await linkWithCredential(auth.currentUser, credential);
        else await signInWithCredential(auth, credential);
        confirmation = null;
        message("Phone verified successfully.");
      } catch (e) {
        message(e.message || "OTP verification failed.", true);
      }
    });
    signOutBtn.addEventListener("click", async () => {
      try { await signOut(auth); message("Signed out. You can still play as guest."); }
      catch (e) { message(e.message || "Sign out failed.", true); }
    });
    window.addEventListener("4gaprush-profile-changed", e => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveCloudProfile(e.detail), 350);
    });
  } catch (e) {
    console.error("Firebase initialization failed:", e);
    message("Firebase config could not initialize. Guest play remains available.", true);
  }
}
