// js/main.mjs
// Main application logic for non-admin UI: auth, device control, theme integration.
// Uses shared modules js/firebase.mjs and js/ui.mjs

import { initFirebase } from './firebase.mjs';
import { initThemeControls } from './ui.mjs';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-auth.js";
import { getDatabase, ref, onValue, set, get } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-database.js";

// Initialize firebase
const { auth, database } = initFirebase();

// UI refs
const loginForm = document.getElementById('loginForm');
const dashboard = document.getElementById('dashboard');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const userEmailEl = document.getElementById('userEmail');
const relayGrid = document.getElementById('relayGrid');
const onlineCountEl = document.getElementById('onlineCount');
const allOffBtn = document.getElementById('allOffBtn');
const errorBanner = document.getElementById('errorBanner');

// Theme
initThemeControls();

// Default devices (friendly names and stable paths)
const DEFAULT_DEVICES = [
  { id: 1, label: 'Bedroom Light', path: 'bedroom_light' },
  { id: 2, label: 'Bedroom Socket', path: 'bedroom_socket' },
  { id: 3, label: 'Sitting Room Light', path: 'sittingroom_light' },
  { id: 4, label: 'Sitting Room Socket', path: 'sittingroom_socket' }
];

// In this simplified non-admin app we use localStorage for user-local settings (if needed).
// The admin UI (admin/) is responsible for global settings stored in DB.

function showError(msg) {
  if (!errorBanner) return;
  errorBanner.hidden = false;
  errorBanner.textContent = msg;
}
function clearError() {
  if (!errorBanner) return;
  errorBanner.hidden = true;
  errorBanner.textContent = '';
}

// Create device card
function createDeviceCard(device) {
  const card = document.createElement('article');
  card.className = 'card relay-card';
  card.id = `card-${device.id}`;
  card.innerHTML = `
    <div class="relay-header">
      <div class="relay-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d="M3 12h18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
          <rect x="4" y="6" width="6" height="4" rx="1" stroke="currentColor" stroke-width="1.2" opacity="0.8"/>
          <rect x="14" y="14" width="6" height="4" rx="1" stroke="currentColor" stroke-width="1.2" opacity="0.8"/>
        </svg>
      </div>
      <div style="flex:1;margin-left:8px">
        <div class="relay-title">${device.label}</div>
        <div class="small">Path: <span class="small muted">${device.path}</span></div>
      </div>
    </div>

    <div style="display:flex;align-items:center;margin-top:12px;">
      <div class="status">
        <div id="indicator${device.id}" class="indicator skeleton" aria-hidden="true"></div>
        <div style="min-width:56px"><span id="statusText${device.id}" class="small skeleton" style="padding:6px 10px;border-radius:6px;display:inline-block">Loading...</span></div>
      </div>

      <div class="switch" style="margin-left:auto;">
        <label class="track" id="track${device.id}" for="switch${device.id}" tabindex="0" role="switch" aria-checked="false">
          <div class="knob"></div>
        </label>
        <input type="checkbox" id="switch${device.id}" aria-labelledby="switch${device.id}" style="display:none;">
      </div>
    </div>
  `;
  return card;
}

function clearRelayGrid() {
  relayGrid.innerHTML = '';
}

let listeners = [];

// Helper to compute DB path; in this non-admin main app we assume no prefix (admin can set global prefix in DB)
function dbPathFor(devicePath) {
  // If you want to support a local prefix saved in localStorage, you can implement here.
  return '/' + devicePath;
}

async function startDeviceControl(devices = DEFAULT_DEVICES) {
  clearError();
  clearRelayGrid();
  listeners.forEach(unsub => { try { unsub(); } catch(e) {} });
  listeners = [];

  // Build UI
  devices.forEach(d => relayGrid.appendChild(createDeviceCard(d)));

  // Attach DB listeners and handlers
  devices.forEach(d => {
    const path = dbPathFor(d.path);
    const dbRef = ref(database, path);

    const statusText = document.getElementById(`statusText${d.id}`);
    const indicator = document.getElementById(`indicator${d.id}`);
    const track = document.getElementById(`track${d.id}`);

    function updateUI(state) {
      statusText.classList.remove('skeleton');
      indicator.classList.remove('skeleton');
      statusText.textContent = state ? 'ON' : 'OFF';
      statusText.classList.toggle('muted', !state);
      indicator.classList.toggle('on', !!state);
      indicator.classList.toggle('off', !state);
      track.classList.toggle('on', !!state);
      track.setAttribute('aria-checked', !!state);
    }

    const unsub = onValue(dbRef, (snap) => {
      updateUI(!!snap.val());
      refreshOnlineCount(devices);
    }, (err) => {
      console.error('Realtime error', err);
      showError('Realtime DB error: ' + (err.message || err));
    });

    listeners.push(unsub);

    const toggle = async () => {
      track.style.pointerEvents = 'none';
      try {
        const snap = await get(dbRef);
        const next = !snap.val();
        updateUI(next); // optimistic
        await set(dbRef, next);
        clearError();
      } catch (err) {
        console.error('Toggle failed', err);
        showError('Failed to toggle: ' + (err.message || err));
        // refresh UI state
        try {
          const snap2 = await get(dbRef);
          updateUI(!!snap2.val());
        } catch {}
      } finally {
        track.style.pointerEvents = '';
        refreshOnlineCount(devices);
      }
    };

    track.addEventListener('click', toggle);
    track.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
    });
  });

  allOffBtn.onclick = async () => {
    if (!confirm('Turn all devices OFF?')) return;
    const promises = devices.map(d => {
      const p = dbPathFor(d.path);
      return set(ref(database, p), false).catch(err => { console.error('AllOff error', err); showError('All Off error: ' + (err.message || err)); });
    });
    await Promise.all(promises);
  };

  // initial count
  refreshOnlineCount(devices);
}

async function refreshOnlineCount(devices = DEFAULT_DEVICES) {
  try {
    const arr = await Promise.all(devices.map(d => get(ref(database, dbPathFor(d.path))).then(s => !!s.val()).catch(() => false)));
    const countOn = arr.filter(Boolean).length;
    onlineCountEl.textContent = `${countOn}/${arr.length} ON`;
  } catch (e) {
    console.warn('refreshOnlineCount failed', e);
  }
}

// Authentication handlers
loginBtn.addEventListener('click', async () => {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!email || !password) { showError('Please enter email and password.'); return; }
  try {
    await signInWithEmailAndPassword(auth, email, password);
    clearError();
  } catch (err) {
    showError('Login failed: ' + (err.message || err));
    console.error(err);
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await signOut(auth);
  } catch (err) {
    showError('Logout failed: ' + (err.message || err));
    console.error(err);
  }
});

// Show/hide UI based on auth
onAuthStateChanged(auth, (user) => {
  if (user) {
    loginForm.classList.add('hidden');
    dashboard.classList.remove('hidden');
    logoutBtn.style.display = 'inline-flex';
    userEmailEl.style.display = 'inline-flex';
    userEmailEl.textContent = user.email || '';

    // Start control with default device set (admin-managed global settings are not used here)
    startDeviceControl();
  } else {
    dashboard.classList.add('hidden');
    loginForm.classList.remove('hidden');
    logoutBtn.style.display = 'none';
    userEmailEl.style.display = 'none';

    // cleanup listeners and UI
    listeners.forEach(unsub => { try { unsub(); } catch (e) {} });
    listeners = [];
    clearRelayGrid();
  }
});
