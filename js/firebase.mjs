// js/firebase.mjs
// Initializes Firebase and exports helpers.
// Note: this module uses the Firebase modular SDK via CDN imports.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-database.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-analytics.js";

// Default firebase config (kept as in original project).
const firebaseConfig = {
  apiKey: "AIzaSyDFfzHIoNCHOKcXR0WoOQZQPHFUM3_pznY",
  authDomain: "smart-homes-buliamix.firebaseapp.com",
  databaseURL: "https://smart-homes-buliamix-default-rtdb.firebaseio.com",
  projectId: "smart-homes-buliamix",
  storageBucket: "smart-homes-buliamix.firebasestorage.app",
  messagingSenderId: "397418885314",
  appId: "1:397418885314:web:8d1d944cd3ab3d61b94b5b",
  measurementId: "G-CZNGBWR2X0"
};

let cached = null;

export function initFirebase() {
  if (cached) return cached;
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const database = getDatabase(app);
  try { getAnalytics(app); } catch (e) { /* optional */ }
  cached = { app, auth, database };
  return cached;
}
