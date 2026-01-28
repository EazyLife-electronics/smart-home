// js/app.mjs
// Main application (feedback-first): UI driven only by feedback nodes.
// Commands are requests written to control paths; UI updates only when feedback changes.
// Debounced slider writes; smooth animation for feedback-driven slider updates.

import { initFirebase } from './firebase.mjs';
import { initThemeControls } from './ui.mjs';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-auth.js";
import { ref, onValue, set, get } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-database.js";

const { auth, database } = initFirebase();
console.log('Auth object:', auth);
initThemeControls();

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

// Heartbeat offline threshold (ms)
const HEARTBEAT_STALE_MS = 7000; // consider offline if no heartbeat within ~7s

// Debounce config
const SLIDER_DEBOUNCE_MS = 300;

// Pending confirmation timeout
const PENDING_CONFIRM_TIMEOUT_MS = 8000;

// Devices: note controlPath (where UI writes commands) and feedbackPath (truth source, used for all UI)
const DEVICES = [
  // relays (switch type)
  { id: 1, label: 'Sitting Room Light', controlPath: '/control/sittingRoomLight', feedbackPath: '/feedback/sittingRoomLightFeedback', type: 'switch', feedbackMode: 'verified' },
  { id: 2, label: 'Bedroom Light', controlPath: '/control/bedRoomLight', feedbackPath: '/feedback/bedRoomLightFeedback', type: 'switch', feedbackMode: 'verified' },
  { id: 3, label: 'Sitting Room Socket', controlPath: '/control/sittingRoomSocket', feedbackPath: null, type: 'switch', feedbackMode: 'assumed' },
  { id: 4, label: 'Bedroom Socket', controlPath: '/control/bedRoomSocket', feedbackPath: null, type: 'switch', feedbackMode: 'assumed' },

  // sliders (servo percentage)
  { id: 5, label: 'Bedroom Window', controlPath: '/control/bedRoomWindow', feedbackPath: null, type: 'slider', feedbackMode: 'assumed' },
  { id: 6, label: 'Sitting Room Window', controlPath: '/control/sittingRoomWindow', feedbackPath: null, type: 'slider', feedbackMode: 'assumed' }
];

// Local default presets if none in DB (admin can set /settings/presets/<deviceKey>)
const LOCAL_DEFAULT_PRESETS = {
  '/bedRoomWindow': { open: 100, half: 50, close: 0 },
  '/sittingRoomWindow': { open: 100, half: 50, close: 0 }
};

// runtime state
const listeners = [];
// pendingMap: controlPath -> { expectedValue, cmdId, timeoutId }
const pendingMap = new Map();
const sliderDebounceTimers = new Map(); // controlPath -> timer id
let lastHeartbeat = 0;
let heartbeatUnsub = null;
let offline = false;

// Helpers
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

function createCard(device) {
  const card = document.createElement('article');
  card.className = 'card relay-card';
  card.id = `card-${device.id}`;

  const displayedPath = device.feedbackPath ?? device.controlPath;

  if (device.type === 'slider') {
    card.innerHTML = `
      <div class="relay-header">
        <div class="relay-icon" aria-hidden="true">🪟</div>
        <div style="flex:1;margin-left:8px">
          <div class="relay-title">${device.label}</div>
          <div class="small">Path: <span class="small muted">${displayedPath}</span></div>
        </div>
      </div>

      <div style="margin-top:12px;">
        <div style="display:flex;align-items:center;gap:12px;">
          <input id="slider${device.id}" type="range" min="0" max="100" value="0" />
          <div style="min-width:46px;text-align:right"><span id="sliderValue${device.id}">0%</span></div>
        </div>

        <div style="margin-top:8px;display:flex;gap:8px;justify-content:flex-end;">
          <button id="presetOpen${device.id}" class="btn ghost" title="Open">Open</button>
          <button id="presetHalf${device.id}" class="btn ghost" title="Half">Half</button>
          <button id="presetClose${device.id}" class="btn ghost" title="Close">Close</button>
        </div>

        <div id="pending${device.id}" class="small" style="margin-top:8px;color:var(--muted-00);display:none">Pending...</div>
      </div>
    `;
  } else {
    card.innerHTML = `
      <div class="relay-header">
        <div class="relay-icon" aria-hidden="true">🔌</div>
        <div style="flex:1;margin-left:8px">
          <div class="relay-title">${device.label}</div>
          <div class="small">Path: <span class="small muted">${displayedPath}</span></div>
        </div>
      </div>

      <div style="display:flex;align-items:center;margin-top:12px;">
        <div class="status">
          <div id="indicator${device.id}" class="indicator skeleton" aria-hidden="true"></div>
          <div style="min-width:56px"><span id="statusText${device.id}" class="small skeleton" style="padding:6px 10px;border-radius:6px;display:inline-block">Loading...</span></div>
        </div>

        <div style="margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;">
          <div class="switch">
            <label class="track" id="track${device.id}" tabindex="0" role="switch" aria-checked="false">
              <div class="knob"></div>
            </label>
          </div>
          <div id="pending${device.id}" class="small" style="margin-top:6px;color:var(--muted-00);display:none">Pending...</div>
        </div>
      </div>
    `;
  }

  return card;
}

function applyOfflineVisual(card, isOffline) {
  if (isOffline) {
    card.style.opacity = '0.5';
    card.querySelectorAll('button, input[type="range"], label.track').forEach(el => {
      el.setAttribute('disabled', 'disabled');
      if (el.tagName === 'LABEL') el.setAttribute('aria-disabled', 'true');
    });
  } else {
    card.style.opacity = '';
    card.querySelectorAll('button, input[type="range"], label.track').forEach(el => {
      el.removeAttribute('disabled');
      if (el.tagName === 'LABEL') el.removeAttribute('aria-disabled');
    });
  }
}

function updateSwitchUI(deviceId, value) {
  const track = document.getElementById(`track${deviceId}`);
  const statusText = document.getElementById(`statusText${deviceId}`);
  const indicator = document.getElementById(`indicator${deviceId}`);

  if (!track || !statusText || !indicator) return;

  const on = !!value;
  track.classList.toggle('on', on);
  track.setAttribute('aria-checked', on ? 'true' : 'false');

  statusText.textContent = on ? 'ON' : 'OFF';
  statusText.classList.toggle('muted', !on);

  indicator.classList.toggle('on', on);
  indicator.classList.toggle('off', !on);
}

// Smoothly animate slider value from current to target (ms duration)
function animateSliderTo(sliderEl, valueEl, from, to, duration = 300) {
  if (!sliderEl || !valueEl) return;
  const start = performance.now();
  const diff = to - from;
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    const cur = Math.round(from + diff * t);
    sliderEl.value = cur;
    valueEl.textContent = `${cur}%`;
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

let heartbeatInterval = null;

// Pending helpers
function setPending(dev, expectedValue, cmdId = undefined) {
  const controlPath = dev.controlPath;
  // clear existing pending for path
  clearPending(controlPath);

  // show pending indicator on card if exists
  const pendingEl = document.getElementById(`pending${dev.id}`);
  if (pendingEl) pendingEl.style.display = 'block';

  // set pending with timeout
  const timeoutId = setTimeout(() => {
    // on timeout, clear pending and show a warning
    clearPending(controlPath);
    if (pendingEl) {
      pendingEl.style.display = 'none';
    }
    showError('Command not confirmed (timeout).');
  }, PENDING_CONFIRM_TIMEOUT_MS);

  pendingMap.set(controlPath, { expectedValue, cmdId, timeoutId });
}

function clearPending(controlPath) {
  const info = pendingMap.get(controlPath);
  if (!info) return;
  if (info.timeoutId) clearTimeout(info.timeoutId);
  pendingMap.delete(controlPath);
}

async function confirmPendingIfMatches(dev) {
  const info = pendingMap.get(dev.controlPath);
  if (!info || typeof info.expectedValue === 'undefined') return;
  if (!info.cmdId) return; // no cmdId attached

  // derive device key from controlPath: '/control/sittingRoomLight' => '/sittingRoomLight'
  const deviceKey = dev.controlPath.replace('/control', '');
  const metaPath = '/feedbackMeta' + deviceKey;

  try {
    const metaSnap = await get(ref(database, metaPath));
    if (metaSnap && metaSnap.exists()) {
      const meta = metaSnap.val();
      const lastCmdId = meta && meta.lastCmdId ? meta.lastCmdId : null;
      if (lastCmdId && lastCmdId === info.cmdId) {
        // hide pending
        clearPending(dev.controlPath);
        const pendingEl = document.getElementById(`pending${dev.id}`);
        if (pendingEl) pendingEl.style.display = 'none';
      }
    }
  } catch (e) {
    console.warn('confirmPendingIfMatches error', e);
  }
}

// Configure UI and listeners driven by feedback only
async function startFeedbackFirstControl() {
  // create cards
  relayGrid.innerHTML = '';
  DEVICES.forEach(dev => relayGrid.appendChild(createCard(dev)));

  // subscribe to feedback paths and feedbackMeta ack paths
  DEVICES.forEach(dev => {
    // feedback listener (value)
    if (dev.feedbackPath) {
      const fbRef = ref(database, dev.feedbackPath);
      const unsubFeedback = onValue(fbRef, (snap) => {
        // heartbeat may indicate offline => handled separately
        const val = snap.val();

        // Update UI from feedback (truth)
        if (dev.type === 'slider') {
          const slider = document.getElementById(`slider${dev.id}`);
          const valueEl = document.getElementById(`sliderValue${dev.id}`);
          const pendingEl = document.getElementById(`pending${dev.id}`);
          const current = Number(slider?.value || 0);
          const target = Number(val ?? 0);

          // hide pending if feedback equals expected value
          const pendingInfo = pendingMap.get(dev.controlPath);
          if (pendingInfo && pendingInfo.expectedValue !== undefined && pendingInfo.expectedValue === target) {
            // command confirmed
            clearPending(dev.controlPath);
            if (pendingEl) pendingEl.style.display = 'none';
          }

          // animate to new feedback value (always animate regardless of feedbackMode)
          animateSliderTo(slider, valueEl, current, target, 300);

        } else { // switch
          const statusText = document.getElementById(`statusText${dev.id}`);
          const indicator = document.getElementById(`indicator${dev.id}`);
          const track = document.getElementById(`track${dev.id}`);
          const pendingEl = document.getElementById(`pending${dev.id}`);

          const fbState = !!val;

          // hide pending if matches expectation
          const pendingInfo = pendingMap.get(dev.controlPath);
          if (pendingInfo && pendingInfo.expectedValue !== undefined && (!!pendingInfo.expectedValue) === fbState) {
            clearPending(dev.controlPath);
            if (pendingEl) pendingEl.style.display = 'none';
          }

          // update UI from feedback (truth)
          statusText.classList.remove('skeleton');
          indicator.classList.remove('skeleton');
          statusText.textContent = fbState ? 'ON' : 'OFF';
          statusText.classList.toggle('muted', !fbState);
          indicator.classList.toggle('on', !!fbState);
          indicator.classList.toggle('off', !fbState);
          if (track) {
            track.classList.toggle('on', !!fbState);
            track.setAttribute('aria-checked', fbState ? 'true' : 'false');
          }
        }
        // Update online count based on feedback values (sliders > 0 considered ON)
        refreshOnlineCount();
      }, (err) => {
        console.error('Feedback onValue error for', dev.feedbackPath, err);
      });

      listeners.push(unsubFeedback);
    }

    // ack listener: listen to /feedbackMeta/<deviceKey>
    // This is used to clear pending when device processed the command even if value didn't change
    const deviceKey = dev.controlPath.replace('/control', '');
    const metaRef = ref(database, '/feedbackMeta' + deviceKey);
    const unsubMeta = onValue(metaRef, (snap) => {
      if (!snap || !snap.exists()) return;
      const meta = snap.val();
      const lastCmdId = meta && meta.lastCmdId ? meta.lastCmdId : null;
      if (!lastCmdId) return;

      const pendingInfo = pendingMap.get(dev.controlPath);
      if (pendingInfo && pendingInfo.cmdId && pendingInfo.cmdId === lastCmdId) {
        // command acknowledged by device
        clearPending(dev.controlPath);
        const pendingEl = document.getElementById(`pending${dev.id}`);
        if (pendingEl) pendingEl.style.display = 'none';
      }
    }, (err) => {
      // ignore meta errors
    });
    listeners.push(unsubMeta);

    // UI actions: on user interaction write to controlPath but DO NOT update UI from command
    if (dev.type === 'slider') {
      const slider = document.getElementById(`slider${dev.id}`);
      const btnOpen = document.getElementById(`presetOpen${dev.id}`);
      const btnHalf = document.getElementById(`presetHalf${dev.id}`);
      const btnClose = document.getElementById(`presetClose${dev.id}`);
      const pendingEl = document.getElementById(`pending${dev.id}`);
      const valueEl = document.getElementById(`sliderValue${dev.id}`);

      // debounce on input: schedule write; but UI values only come from feedback
      slider.addEventListener('input', (ev) => {
        // show pending indicator
        if (pendingEl) pendingEl.style.display = 'block';

        const next = Number(ev.target.value);
        // debounce
        const key = dev.controlPath;
        if (sliderDebounceTimers.has(key)) clearTimeout(sliderDebounceTimers.get(key));
        const t = setTimeout(async () => {
          try {
            if (dev.feedbackMode === 'verified') {
              // generate cmdId and write both children
              const cmdId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
              await set(ref(database, dev.controlPath + '/value'), next);
              await set(ref(database, dev.controlPath + '/cmdId'), cmdId);
              // record pending with cmdId
              setPending(dev, next, cmdId);
              // also trigger immediate confirmation check
              confirmPendingIfMatches(dev);
            } else {
              // assumed success → update slider UI immediately and write only value
              await set(ref(database, dev.controlPath + '/value'), next);
              if (valueEl) valueEl.textContent = `${next}%`;
              if (slider) slider.value = next;
              if (pendingEl) pendingEl.style.display = 'none';
            }
          } catch (err) {
            console.error('Slider write error', err);
            showError('Failed to send slider command: ' + (err.message || err));
            if (pendingEl) pendingEl.style.display = 'none';
            clearPending(dev.controlPath);
          } finally {
            sliderDebounceTimers.delete(key);
          }
        }, SLIDER_DEBOUNCE_MS);
        sliderDebounceTimers.set(key, t);
      });

      // immediate write on change (release)
      slider.addEventListener('change', async (ev) => {
        const key = dev.controlPath;
        if (sliderDebounceTimers.has(key)) {
          clearTimeout(sliderDebounceTimers.get(key));
          sliderDebounceTimers.delete(key);
        }
        const next = Number(ev.target.value);
        try {
          if (dev.feedbackMode === 'verified') {
            const cmdId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            await set(ref(database, dev.controlPath + '/value'), next);
            await set(ref(database, dev.controlPath + '/cmdId'), cmdId);
            setPending(dev, next, cmdId);
            if (pendingEl) pendingEl.style.display = 'block';
            confirmPendingIfMatches(dev);
          } else {
            await set(ref(database, dev.controlPath + '/value'), next);
            if (valueEl) valueEl.textContent = `${next}%`;
            if (slider) slider.value = next;
            if (pendingEl) pendingEl.style.display = 'none';
          }
        } catch (err) {
          console.error('Slider immediate write error', err);
          showError('Failed to send slider command: ' + (err.message || err));
          if (pendingEl) pendingEl.style.display = 'none';
          clearPending(dev.controlPath);
        }
      });

      // presets: fetch preset from /settings/presets/<controlPath> or fallback local defaults
      async function applyPreset(which) {
        if (pendingEl) pendingEl.style.display = 'block';
        try {
          const presetSnap = await get(ref(database, '/settings/presets' + dev.controlPath));
          let presets = null;
          if (presetSnap && presetSnap.exists()) presets = presetSnap.val();
          let value = null;
          if (presets && typeof presets[which] !== 'undefined') value = Number(presets[which]);
          else {
            const local = LOCAL_DEFAULT_PRESETS[dev.controlPath] || { open: 100, half: 50, close: 0 };
            value = Number(local[which]);
          }

          if (dev.feedbackMode === 'verified') {
            const cmdId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            await set(ref(database, dev.controlPath + '/value'), value);
            await set(ref(database, dev.controlPath + '/cmdId'), cmdId);
            setPending(dev, value, cmdId);
            confirmPendingIfMatches(dev);
          } else {
            await set(ref(database, dev.controlPath + '/value'), value);
            const valueEl = document.getElementById(`sliderValue${dev.id}`);
            const sliderEl = document.getElementById(`slider${dev.id}`);
            if (valueEl) valueEl.textContent = `${value}%`;
            if (sliderEl) sliderEl.value = value;
            if (pendingEl) pendingEl.style.display = 'none';
          }
        } catch (err) {
          console.error('Preset apply failed', err);
          showError('Failed to apply preset: ' + (err.message || err));
          if (pendingEl) pendingEl.style.display = 'none';
          clearPending(dev.controlPath);
        }
      }

      btnOpen.addEventListener('click', () => applyPreset('open'));
      btnHalf.addEventListener('click', () => applyPreset('half'));
      btnClose.addEventListener('click', () => applyPreset('close'));

    } else { // switch
      const track = document.getElementById(`track${dev.id}`);
      const pendingEl = document.getElementById(`pending${dev.id}`);

      // clicking track writes control request to controlPath; UI remains driven by feedback only
      async function onToggleRequest() {
        if (pendingEl) pendingEl.style.display = 'block';

        try {
          let requested;

          if (dev.feedbackMode === 'verified') {
            // read current feedback to decide requested toggled value
            const fbSnap = await get(ref(database, dev.feedbackPath));
            const current = fbSnap && fbSnap.exists() ? !!fbSnap.val() : false;
            const pending = pendingMap.get(dev.controlPath);
            if (pending && typeof pending.expectedValue !== 'undefined') {
              requested = pending.expectedValue === 1 ? 0 : 1;
            } else {
              requested = current ? 0 : 1;
            }

            // generate cmdId and write both children
            const cmdId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            await set(ref(database, dev.controlPath + '/value'), requested);
            await set(ref(database, dev.controlPath + '/cmdId'), cmdId);
            setPending(dev, requested, cmdId);
            // check immediately if device already acknowledged
            confirmPendingIfMatches(dev);

          } else {
            // assumed device → toggle UI state (immediate)
            const trackOn = track.classList.contains('on');
            requested = trackOn ? 0 : 1; // if currently on, we want 0; else 1
            updateSwitchUI(dev.id, requested);
            await set(ref(database, dev.controlPath), requested); // legacy clients may expect root scalar
            if (pendingEl) pendingEl.style.display = 'none';
          }

        } catch (err) {
          console.error('Toggle request failed', err);
          showError('Failed to send toggle request');
          if (pendingEl) pendingEl.style.display = 'none';
        }
      }


      // support click and keyboard activation
      track.addEventListener('click', onToggleRequest);
      track.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onToggleRequest(); }
      });
    }
  }); // end devices.forEach

  // After listeners are attached, try to initialize UI from current feedback values
  // This prevents UI showing stale/unknown states and avoids creating pending that never clears
  await initializeUIFromFeedback();

  // Global All OFF button: write control requests for switch devices only
  allOffBtn.onclick = async () => {
    if (!confirm('Turn all devices OFF?')) return;
    const switchDevices = DEVICES.filter(d => d.type === 'switch');
    for (const d of switchDevices) {
      try {
        const pendingEl = document.getElementById(`pending${d.id}`);
        if (d.feedbackMode === 'verified') {
          const cmdId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          await set(ref(database, d.controlPath + '/value'), 0);
          await set(ref(database, d.controlPath + '/cmdId'), cmdId);
          setPending(d, 0, cmdId);
          if (pendingEl) pendingEl.style.display = 'block';
          confirmPendingIfMatches(d);
        } else {
          // assumed: update UI immediately
          updateSwitchUI(d.id, 0);
          await set(ref(database, d.controlPath), 0); // legacy write
          if (pendingEl) pendingEl.style.display = 'none';
        }
      } catch (err) {
        console.error('AllOff write failed', err);
        showError('Failed to send All Off: ' + (err.message || err));
      }
    }
  };

  // Heartbeat subscription
  const hbRef = ref(database, '/heartbeat');
  const unsubHb = onValue(hbRef, (snap) => {
    if (snap.exists()) {
      lastHeartbeat = Number(snap.val());
      lastHeartbeatReceivedAt = Date.now();
      if (offline) {
        offline = false;
        DEVICES.forEach(d => {
          const card = document.getElementById(`card-${d.id}`);
          if (card) applyOfflineVisual(card, false);
        });
        clearError();
      }
    }
  }, (err) => {
    console.warn('Heartbeat subscription error', err);
  });
  listeners.push(unsubHb);

  // check periodically for stale heartbeat
  if (!heartbeatInterval) {
    heartbeatInterval = setInterval(checkHeartbeatAlive, 1500);
  }

}

// Initialize UI from current feedback snaps (run once after listeners setup)
async function initializeUIFromFeedback() {
  try {
    const tasks = DEVICES.map(async (dev) => {
      if (!dev.feedbackPath) {
        // For assumed devices leave initial UI as defaults (or could read controlPath if stored)
        return;
      }
      try {
        const snap = await get(ref(database, dev.feedbackPath));
        if (!snap || !snap.exists()) return;
        const val = snap.val();

        if (dev.type === 'slider') {
          const slider = document.getElementById(`slider${dev.id}`);
          const valueEl = document.getElementById(`sliderValue${dev.id}`);
          const target = Number(val ?? 0);
          // set without animation for first render
          if (slider) slider.value = target;
          if (valueEl) valueEl.textContent = `${target}%`;
        } else {
          const fbState = !!val;
          updateSwitchUI(dev.id, fbState);
          // ensure no pending left if expected equals current
          const pendingInfo = pendingMap.get(dev.controlPath);
          if (pendingInfo && (!!pendingInfo.expectedValue) === fbState) {
            clearPending(dev.controlPath);
            const pendingEl = document.getElementById(`pending${dev.id}`);
            if (pendingEl) pendingEl.style.display = 'none';
          }
        }
      } catch (e) {
        console.warn('initializeUIFromFeedback error for', dev.feedbackPath, e);
      }
    });
    await Promise.all(tasks);
    // refresh count after initialization
    refreshOnlineCount();
  } catch (e) {
    console.warn('initializeUIFromFeedback error', e);
  }
}

let lastHeartbeatReceivedAt = 0;
(function ensureHeartbeatReceiver() {
  const hbRef = ref(database, '/heartbeat');
  onValue(hbRef, (snap) => {
    if (snap && snap.exists()) {
      lastHeartbeat = Number(snap.val());
      lastHeartbeatReceivedAt = Date.now();
      // mark online if previously offline
      if (offline) {
        offline = false;
        // restore visuals
        DEVICES.forEach(d => {
          const card = document.getElementById(`card-${d.id}`);
          if (card) applyOfflineVisual(card, false);
        });
      }
    }
  }, (err) => { /* ignore additional heartbeat errors here */ });
})();

// Check function uses lastHeartbeatReceivedAt
function checkHeartbeatAlive() {
  if (!lastHeartbeatReceivedAt) return;
  const elapsed = Date.now() - lastHeartbeatReceivedAt;
  const wasOffline = offline;
  offline = (elapsed > HEARTBEAT_STALE_MS);
  if (offline !== wasOffline) {
    // toggle visuals for all devices
    DEVICES.forEach(d => {
      const card = document.getElementById(`card-${d.id}`);
      if (card) applyOfflineVisual(card, offline);
    });
    // show message
    if (offline) showError('Device offline (no heartbeat)');
    else clearError();
  }
}

// Count devices ON based on feedback values
async function refreshOnlineCount() {
  try {
    const checks = DEVICES.map(async d => {
      if (!d.feedbackPath) return false;
      const fbSnap = await get(ref(database, d.feedbackPath));
      if (!fbSnap || !fbSnap.exists()) return false;
      const val = fbSnap.val();
      if (d.type === 'slider') return Number(val) > 0;
      return !!val;
    });
    const results = await Promise.all(checks);
    const count = results.filter(Boolean).length;
    onlineCountEl.textContent = `${count}/${DEVICES.length} ON`;
  } catch (e) {
    console.warn('refreshOnlineCount error', e);
  }
}

// Authentication & UI visibility
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

onAuthStateChanged(auth, (user) => {
  if (user) {
    // Show dashboard
    loginForm.classList.add('hidden');
    dashboard.classList.remove('hidden');
    logoutBtn.style.display = 'inline-flex';
    userEmailEl.style.display = 'inline-flex';
    userEmailEl.textContent = user.email || '';

    // Try initializing feedback-driven UI safely
    try {
      // startFeedbackFirstControl is async; we intentionally don't await here
      startFeedbackFirstControl();
    } catch (err) {
      console.error('Dashboard initialization failed', err);
      showError('Dashboard failed to load: ' + (err.message || err));
    }
  } else {
    // Hide dashboard and show login
    dashboard.classList.add('hidden');
    loginForm.classList.remove('hidden');
    logoutBtn.style.display = 'none';
    userEmailEl.style.display = 'none';

    // Clean up any existing listeners
    listeners.forEach(unsub => { try { unsub(); } catch(e) {} });
    listeners.length = 0;
    relayGrid.innerHTML = '';
  }
});
