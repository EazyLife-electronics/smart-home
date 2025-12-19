// js/app.mjs
// Main application logic: auth, relay control, settings integration
// Updated: default relay names/paths changed to match smart-home device names:
// - Bedroom Light, Bedroom Socket, Sitting Room Light, Sitting Room Socket

import { initFirebase } from './firebase.mjs';
import { initThemeControls, initModal } from './ui.mjs';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-auth.js";
import { ref, onValue, set, get } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-database.js";

// Initialize firebase instances
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

// Settings & Theme
const themeControls = initThemeControls();
const settingsModal = initModal('settingsModal', 'settingsBtn', 'closeSettings');
const saveSettingsBtn = document.getElementById('saveSettings');
const cancelSettingsBtn = document.getElementById('cancelSettings');
const relaysSettingsContainer = document.getElementById('relaysSettings');
const restoreDefaultsBtn = document.getElementById('restoreDefaults');
const firebasePrefixInput = document.getElementById('firebasePrefix');

// Settings persistence
const SETTINGS_KEY = 'smart_home_settings_v1';
// DEFAULT_RELAYS updated to semantic device names and friendly, stable paths (no spaces)
const DEFAULT_RELAYS = [
  { id: 1, label: 'Bedroom Light', path: 'bedroom_light' },
  { id: 2, label: 'Bedroom Socket', path: 'bedroom_socket' },
  { id: 3, label: 'Sitting Room Light', path: 'sittingroom_light' },
  { id: 4, label: 'Sitting Room Socket', path: 'sittingroom_socket' }
];

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { relays: DEFAULT_RELAYS.slice(), prefix: '' };
    const parsed = JSON.parse(raw);
    return {
      relays: parsed.relays || DEFAULT_RELAYS.slice(),
      prefix: parsed.prefix || ''
    };
  } catch (e) {
    console.warn('Failed to load settings, using defaults', e);
    return { relays: DEFAULT_RELAYS.slice(), prefix: '' };
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// Populate settings dialog
function populateSettingsUI(settings) {
  relaysSettingsContainer.innerHTML = '';
  settings.relays.forEach(r => {
    const wrapper = document.createElement('div');
    wrapper.className = 'relay-settings';
    wrapper.innerHTML = `
      <label class="small">Label for device ${r.id}</label>
      <input data-relay-id="${r.id}" class="relay-label" value="${escapeHtml(r.label)}" />
      <label class="small">Path for device ${r.id}</label>
      <input data-relay-id="${r.id}" class="relay-path" value="${escapeHtml(r.path)}" />
    `;
    relaysSettingsContainer.appendChild(wrapper);
  });
  firebasePrefixInput.value = settings.prefix || '';
}

// Simple escape helper for input values to avoid inadvertent HTML injection
function escapeHtml(str) {
  return String(str).replace(/[&<>"'`=\/]/g, function(s) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '/': '&#x2F;',
      '`': '&#x60;',
      '=': '&#x3D;'
    }[s];
  });
}

// Read settings UI back
function readSettingsFromUI() {
  const labels = [...relaysSettingsContainer.querySelectorAll('.relay-label')];
  const paths = [...relaysSettingsContainer.querySelectorAll('.relay-path')];
  const relays = labels.map(lbl => {
    const id = Number(lbl.dataset.relayId);
    const pathInput = paths.find(p => Number(p.dataset.relayId) === id);
    return {
      id,
      label: String(lbl.value).trim() || `Device ${id}`,
      path: String(pathInput.value).trim() || `device${id}`
    };
  });
  const prefix = String(firebasePrefixInput.value).trim().replace(/^\/+|\/+$/g, ''); // trim slashes
  return { relays, prefix };
}

// Relay runtime state
let currentSettings = loadSettings();
populateSettingsUI(currentSettings);

// Theme radio values reflect current setting
function initSettingsDialogValues() {
  const themeVal = localStorage.getItem('smart_home_theme') || 'system';
  const radios = document.querySelectorAll('input[name="themeOption"]');
  radios.forEach(r => r.checked = (r.value === themeVal));
}
initSettingsDialogValues();

// Settings actions
restoreDefaultsBtn.addEventListener('click', () => {
  currentSettings = { relays: DEFAULT_RELAYS.slice(), prefix: '' };
  populateSettingsUI(currentSettings);
  firebasePrefixInput.value = '';
});

saveSettingsBtn.addEventListener('click', () => {
  // apply theme option
  const themeOption = document.querySelector('input[name="themeOption"]:checked')?.value || 'system';
  themeControls.applyThemeSetting(themeOption);

  // read relays & prefix and persist
  const s = readSettingsFromUI();
  currentSettings = s;
  saveSettings(currentSettings);

  // close modal and reconfigure relays
  settingsModal.close();
  reconfigureRelays();
});

cancelSettingsBtn.addEventListener('click', () => {
  // restore UI to current settings
  populateSettingsUI(currentSettings);
  initSettingsDialogValues();
  settingsModal.close();
});

// ---------- Authentication ----------

loginBtn.addEventListener('click', async () => {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!email || !password) { showError('Please enter email and password.'); return; }
  try {
    await signInWithEmailAndPassword(auth, email, password);
    clearError();
    // UI state handled by onAuthStateChanged
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

onAuthStateChanged(auth, user => {
  if (user) {
    loginForm.classList.add('hidden');
    dashboard.classList.remove('hidden');
    logoutBtn.style.display = 'inline-flex';
    userEmailEl.style.display = 'inline-flex';
    userEmailEl.textContent = user.email;
    startRelayControl();
  } else {
    dashboard.classList.add('hidden');
    loginForm.classList.remove('hidden');
    logoutBtn.style.display = 'none';
    userEmailEl.style.display = 'none';
    stopRelayControl();
  }
});

// ---------- Relay control ----------

// runtime listeners so we can unsubscribe
let listeners = [];
let currentRelays = currentSettings.relays.slice();

function buildFullPath(prefix, path) {
  if (!prefix) return path;
  return prefix + '/' + path.replace(/^\/+/, '');
}

function showError(msg) {
  errorBanner.hidden = false;
  errorBanner.textContent = msg;
}
function clearError() {
  errorBanner.hidden = true;
  errorBanner.textContent = '';
}

function createRelayCard(relay) {
  const card = document.createElement('article');
  card.className = 'card relay-card';
  card.id = `card-${relay.id}`;

  // Accessible and mobile-friendly layout with skeleton placeholders
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
        <div class="relay-title">${escapeHtml(relay.label)}</div>
        <div class="small">Path: <span class="small muted">${escapeHtml(relay.path)}</span></div>
      </div>
    </div>

    <div style="display:flex;align-items:center;margin-top:12px;">
      <div class="status">
        <div id="indicator${relay.id}" class="indicator skeleton" aria-hidden="true"></div>
        <div style="min-width:56px"><span id="statusText${relay.id}" class="small skeleton" style="padding:6px 10px;border-radius:6px;display:inline-block">Loading...</span></div>
      </div>

      <div class="switch" style="margin-left:auto;">
        <label class="track" id="track${relay.id}" for="switch${relay.id}" tabindex="0" role="switch" aria-checked="false">
          <div class="knob"></div>
        </label>
        <input type="checkbox" id="switch${relay.id}" aria-labelledby="switch${relay.id}" style="display:none;">
      </div>
    </div>
  `;
  return card;
}

function clearRelayGrid() {
  relayGrid.innerHTML = '';
}

// unsubscribe & cleanup
function stopRelayControl() {
  listeners.forEach(unsub => {
    try { unsub(); } catch (e) { /* ignore */ }
  });
  listeners = [];
  clearRelayGrid();
}

function reconfigureRelays() {
  stopRelayControl();
  currentRelays = loadSettings().relays.slice();
  startRelayControl();
}

function startRelayControl() {
  clearError();
  // build cards
  clearRelayGrid();
  const settings = loadSettings();
  const prefix = settings.prefix || '';
  currentRelays = settings.relays.slice();

  currentRelays.forEach(r => {
    const card = createRelayCard(r);
    relayGrid.appendChild(card);
  });

  // attach listeners
  const unsubscribers = [];
  currentRelays.forEach(r => {
    const fullPath = buildFullPath(settings.prefix, r.path);
    const dbRef = ref(database, '/' + fullPath);

    // local UI elements
    const statusText = document.getElementById(`statusText${r.id}`);
    const indicator = document.getElementById(`indicator${r.id}`);
    const track = document.getElementById(`track${r.id}`);

    // helper to update UI
    function updateUI(state) {
      // remove skeleton classes if present
      statusText.classList.remove('skeleton');
      indicator.classList.remove('skeleton');

      statusText.textContent = (state ? 'ON' : 'OFF');
      statusText.classList.toggle('muted', !state);
      indicator.classList.toggle('on', !!state);
      indicator.classList.toggle('off', !state);
      track.classList.toggle('on', !!state);
      track.setAttribute('aria-checked', !!state);
    }

    // realtime listener
    const unsub = onValue(dbRef, (snap) => {
      updateUI(!!snap.val());
      // update online summary (count of ON)
      refreshOnlineCount();
    }, (err) => {
      console.error('Realtime error', err);
      showError('Realtime DB error: ' + (err.message || err));
    });

    unsubscribers.push(unsub);

    // toggle handler (optimistic)
    const toggle = async () => {
      track.style.pointerEvents = 'none';
      try {
        const snap = await get(dbRef);
        const next = !snap.val();
        updateUI(next);
        await set(dbRef, next);
        clearError();
      } catch (err) {
        console.error('Toggle failed', err);
        showError('Failed to toggle: ' + (err.message || err));
        // try to refresh UI
        try {
          const snap2 = await get(dbRef);
          updateUI(!!snap2.val());
        } catch {}
      } finally {
        track.style.pointerEvents = '';
        refreshOnlineCount();
      }
    };

    // wire up click & keyboard
    track.addEventListener('click', toggle);
    track.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
    });
  });

  listeners = unsubscribers;
  // wire up global "all off"
  allOffBtn.onclick = async () => {
    if (!confirm('Turn all devices OFF?')) return;
    const settingsNow = loadSettings();
    const promises = settingsNow.relays.map(r => {
      const fullPath = buildFullPath(settingsNow.prefix, r.path);
      const dbRef = ref(database, '/' + fullPath);
      return set(dbRef, false).catch(err => { console.error('AllOff error', err); showError('All Off error: ' + err.message); });
    });
    await Promise.all(promises);
  };

  // initial refresh
  refreshOnlineCount();
}

async function refreshOnlineCount() {
  try {
    const settingsNow = loadSettings();
    const arr = await Promise.all(settingsNow.relays.map(r => {
      const fullPath = buildFullPath(settingsNow.prefix, r.path);
      return get(ref(database, '/' + fullPath)).then(s => !!s.val()).catch(() => false);
    }));
    const countOn = arr.filter(Boolean).length;
    onlineCountEl.textContent = `${countOn}/${arr.length} ON`;
  } catch (e) {
    console.warn('refreshOnlineCount failed', e);
  }
}

// initialize settings UI after DOM loaded
populateSettingsUI(currentSettings);
initSettingsDialogValues();

// expose for manual reconfigure if needed
window.smartHome = {
  reconfigureRelays,
  getSettings: () => loadSettings()
};
