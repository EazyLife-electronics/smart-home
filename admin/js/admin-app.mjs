// admin/js/admin-app.mjs
// Admin-only client: sign-in, load/save settings to /settings in RTDB
// Uses shared modules ../../js/firebase.mjs and ../../js/ui.mjs

import { initFirebase } from '../../js/firebase.mjs';
import { initThemeControls } from '../../js/ui.mjs';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-auth.js";
import { ref, get, set, onValue } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-database.js";

const { auth, database } = initFirebase();
const theme = initThemeControls();

// UI refs
const loginForm = document.getElementById('loginForm');
const adminPanel = document.getElementById('adminPanel');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const userEmailEl = document.getElementById('userEmail');
const errorBanner = document.getElementById('errorBanner');

const relaysSettingsContainer = document.getElementById('relaysSettings');
const firebasePrefixInput = document.getElementById('firebasePrefix');
const saveSettingsBtn = document.getElementById('saveSettings');
const revertBtn = document.getElementById('revertSettings');
const restoreDefaultsBtn = document.getElementById('restoreDefaults');

const SETTINGS_DB_PATH = '/settings'; // where admin settings are saved

// default devices (same defaults used by the main app)
const DEFAULT_RELAYS = [
  { id: 1, label: 'Bedroom Light', path: 'bedroom_light', type: 'switch' },
  { id: 2, label: 'Bedroom Socket', path: 'bedroom_socket', type: 'switch' },
  { id: 3, label: 'Sitting Room Light', path: 'sittingroom_light', type: 'switch' },
  { id: 4, label: 'Sitting Room Socket', path: 'sittingroom_socket', type: 'switch' },
  { id: 5, label: 'Bedroom Window', path: 'bedroom_window', type: 'slider' },
  { id: 6, label: 'Sitting Room Window', path: 'sittingroom_window', type: 'slider' }
];

const DEFAULT_PRESETS = {
  bedroom_window: { open: 100, half: 50, close: 0 },
  sittingroom_window: { open: 100, half: 50, close: 0 }
};

function showError(msg) {
  errorBanner.hidden = false;
  errorBanner.textContent = msg;
}
function clearError() {
  errorBanner.hidden = true;
  errorBanner.textContent = '';
}

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

function populateSettingsUI(settings) {
  relaysSettingsContainer.innerHTML = '';

  // Relays / devices (editable labels & paths)
  const relays = settings.relays || DEFAULT_RELAYS;
  relays.forEach(r => {
    const wrapper = document.createElement('div');
    wrapper.style.marginBottom = '10px';
    wrapper.innerHTML = `
      <label class="small">Label for device ${r.id}</label>
      <input data-relay-id="${r.id}" class="relay-label" value="${escapeHtml(r.label)}" />
      <label class="small">Path for device ${r.id}</label>
      <input data-relay-id="${r.id}" class="relay-path" value="${escapeHtml(r.path)}" />
    `;
    relaysSettingsContainer.appendChild(wrapper);
  });

  // Presets for slider devices
  const presets = settings.presets || {};
  const sliderDevices = (relays.filter(d => d.type === 'slider'));
  if (sliderDevices.length) {
    const presetsHeader = document.createElement('div');
    presetsHeader.innerHTML = `<h4 style="margin-top:12px">Window Presets</h4>`;
    relaysSettingsContainer.appendChild(presetsHeader);

    sliderDevices.forEach(dev => {
      const p = presets[dev.path] || DEFAULT_PRESETS[dev.path] || { open: 100, half: 50, close: 0 };
      const wrapper = document.createElement('div');
      wrapper.style.marginBottom = '10px';
      wrapper.innerHTML = `
        <div style="font-weight:600;margin-bottom:6px">${escapeHtml(dev.label)} (path: ${escapeHtml(dev.path)})</div>
        <label class="small">Open (%)</label>
        <input data-device="${dev.path}" class="preset-open" type="number" min="0" max="100" value="${Number(p.open)}" />
        <label class="small">Half (%)</label>
        <input data-device="${dev.path}" class="preset-half" type="number" min="0" max="100" value="${Number(p.half)}" />
        <label class="small">Close (%)</label>
        <input data-device="${dev.path}" class="preset-close" type="number" min="0" max="100" value="${Number(p.close)}" />
      `;
      relaysSettingsContainer.appendChild(wrapper);
    });
  }

  firebasePrefixInput.value = settings.prefix || '';
}

function readSettingsFromUI() {
  const labels = [...relaysSettingsContainer.querySelectorAll('.relay-label')];
  const paths = [...relaysSettingsContainer.querySelectorAll('.relay-path')];
  const relays = labels.map(lbl => {
    const id = Number(lbl.dataset.relayId);
    const pathInput = paths.find(p => Number(p.dataset.relayId) === id);
    return {
      id,
      label: String(lbl.value).trim() || `Device ${id}`,
      path: String(pathInput.value).trim() || `device${id}`,
      type: DEFAULT_RELAYS.find(d => d.id === id)?.type || 'switch'
    };
  });

  // Read presets
  const presetInputsOpen = [...relaysSettingsContainer.querySelectorAll('.preset-open')];
  const presets = {};
  presetInputsOpen.forEach(inp => {
    const device = inp.dataset.device;
    const open = Number(inp.value);
    const half = Number(relaysSettingsContainer.querySelector(`.preset-half[data-device="${device}"]`)?.value || 50);
    const close = Number(relaysSettingsContainer.querySelector(`.preset-close[data-device="${device}"]`)?.value || 0);
    presets[device] = {
      open: Number.isFinite(open) ? Math.min(100, Math.max(0, open)) : 100,
      half: Number.isFinite(half) ? Math.min(100, Math.max(0, half)) : 50,
      close: Number.isFinite(close) ? Math.min(100, Math.max(0, close)) : 0
    };
  });

  const prefix = String(firebasePrefixInput.value).trim().replace(/^\/+|\/+$/g, '');
  return { relays, prefix, presets };
}

// load settings from DB; if missing, use defaults
async function loadSettingsFromDB() {
  try {
    const snap = await get(ref(database, SETTINGS_DB_PATH));
    const val = snap.exists() ? snap.val() : null;
    if (val && typeof val === 'object') {
      // normalize relays array if stored as object
      let relays = [];
      if (Array.isArray(val.relays)) relays = val.relays;
      else if (val.relays && typeof val.relays === 'object') relays = Object.values(val.relays);
      else relays = DEFAULT_RELAYS;

      return {
        relays,
        prefix: val.prefix || '',
        presets: val.presets || DEFAULT_PRESETS
      };
    }
    return { relays: DEFAULT_RELAYS, prefix: '', presets: DEFAULT_PRESETS };
  } catch (err) {
    console.error('Failed to load settings:', err);
    showError('Failed to load settings: ' + (err.message || err));
    return { relays: DEFAULT_RELAYS, prefix: '', presets: DEFAULT_PRESETS };
  }
}

async function saveSettingsToDB(settings) {
  try {
    await set(ref(database, SETTINGS_DB_PATH), settings);
    clearError();
    alert('Settings saved.');
  } catch (err) {
    console.error('Failed to save settings:', err);
    showError('Failed to save settings: ' + (err.message || err));
  }
}

// wire buttons
loginBtn.addEventListener('click', async () => {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!email || !password) { showError('Please enter email and password.'); return; }
  try {
    await signInWithEmailAndPassword(auth, email, password);
    clearError();
  } catch (err) {
    console.error(err);
    showError('Login failed: ' + (err.message || err));
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await signOut(auth);
  } catch (err) {
    showError('Logout failed: ' + (err.message || err));
  }
});

restoreDefaultsBtn.addEventListener('click', () => {
  const defaults = { relays: DEFAULT_RELAYS, prefix: '', presets: DEFAULT_PRESETS };
  populateSettingsUI(defaults);
});

revertBtn.addEventListener('click', async () => {
  const s = await loadSettingsFromDB();
  populateSettingsUI(s);
});

saveSettingsBtn.addEventListener('click', async () => {
  const settings = readSettingsFromUI();
  // Basic validation: ensure unique paths
  const paths = settings.relays.map(r => r.path);
  const dup = paths.find((p, i) => paths.indexOf(p) !== i);
  if (dup) { showError('Device paths must be unique. Duplicate: ' + dup); return; }
  await saveSettingsToDB(settings);
});

// auth state handling: show admin panel only when signed in
onAuthStateChanged(auth, async (user) => {
  if (user) {
    loginForm.classList.add('hidden');
    adminPanel.classList.remove('hidden');
    logoutBtn.style.display = 'inline-flex';
    userEmailEl.style.display = 'inline-flex';
    userEmailEl.textContent = user.email || '';

    // load settings and populate UI
    const s = await loadSettingsFromDB();
    populateSettingsUI(s);

    // also listen for live changes (optional)
    const dbRef = ref(database, SETTINGS_DB_PATH);
    onValue(dbRef, (snap) => {
      const val = snap.exists() ? snap.val() : null;
      if (val) populateSettingsUI(val);
    });
  } else {
    adminPanel.classList.add('hidden');
    loginForm.classList.remove('hidden');
    logoutBtn.style.display = 'none';
    userEmailEl.style.display = 'none';
  }
});
