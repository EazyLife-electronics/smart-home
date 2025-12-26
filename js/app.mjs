// js/app.mjs
// Main application (feedback-first): UI driven only by feedback nodes.
// Commands are requests written to control paths; UI updates only when feedback changes.
// Debounced slider writes; smooth animation for feedback-driven slider updates.

import { initFirebase } from './firebase.mjs';
import { initThemeControls } from './ui.mjs';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-auth.js";
import { ref, onValue, set, get } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-database.js";

const { auth, database } = initFirebase();
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

// Devices: note controlPath (where UI writes commands) and feedbackPath (truth source, used for all UI)
const DEVICES = [
  // relays (switch type)
  { id: 1, label: 'Sitting Room Light', controlPath: '/sittingRoomLight', feedbackPath: '/feedback/sittingRoomLightFeedback', type: 'switch' },
  { id: 2, label: 'Bedroom Light', controlPath: '/bedRoomLight', feedbackPath: '/feedback/bedRoomLightFeedback', type: 'switch' },
  { id: 3, label: 'Sitting Room Socket', controlPath: '/sittingRoomSocket', feedbackPath: '/feedback/sittingRoomSocketFeedback', type: 'switch' },
  { id: 4, label: 'Bedroom Socket', controlPath: '/bedRoomSocket', feedbackPath: '/feedback/bedRoomSocketFeedback', type: 'switch' },

  // sliders (servo percentage)
  { id: 5, label: 'Bedroom Window', controlPath: '/bedRoomWindow', feedbackPath: '/feedback/bedRoomWindow', type: 'slider' },
  { id: 6, label: 'Sitting Room Window', controlPath: '/sittingRoomWindow', feedbackPath: '/feedback/sittingRoomWindow', type: 'slider' }
];

// Local default presets if none in DB (admin can set /settings/presets/<deviceKey>)
const LOCAL_DEFAULT_PRESETS = {
  '/bedRoomWindow': { open: 100, half: 50, close: 0 },
  '/sittingRoomWindow': { open: 100, half: 50, close: 0 }
};

// runtime state
const listeners = [];
const pendingMap = new Map(); // controlPath -> { expectedValue, timeout? }
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

  if (device.type === 'slider') {
    card.innerHTML = `
      <div class="relay-header">
        <div class="relay-icon" aria-hidden="true">🪟</div>
        <div style="flex:1;margin-left:8px">
          <div class="relay-title">${device.label}</div>
          <div class="small">Path: <span class="small muted">${device.feedbackPath}</span></div>
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
          <div class="small">Path: <span class="small muted">${device.feedbackPath}</span></div>
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
    card.querySelectorAll('button, input[type="range"], label.track').forEach(el => el.setAttribute('disabled', 'disabled'));
  } else {
    card.style.opacity = '';
    card.querySelectorAll('button, input[type="range"], label.track').forEach(el => el.removeAttribute('disabled'));
  }
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

// Configure UI and listeners driven by feedback only
function startFeedbackFirstControl() {
  // create cards
  relayGrid.innerHTML = '';
  DEVICES.forEach(dev => relayGrid.appendChild(createCard(dev)));

  // subscribe to feedback paths
  DEVICES.forEach(dev => {
    // feedback listener
    const fbRef = ref(database, dev.feedbackPath);
    const unsubFeedback = onValue(fbRef, (snap) => {
      // heartbeat may indicate offline => handled separately
      const val = snap.val();

      // Update UI from feedback (truth)
      if (dev.type === 'slider') {
        const slider = document.getElementById(`slider${dev.id}`);
        const valueEl = document.getElementById(`sliderValue${dev.id}`);
        const pendingEl = document.getElementById(`pending${dev.id}`);
        const current = Number(slider.value || 0);
        const target = Number(val ?? 0);

        // hide pending if feedback equals expected value
        const pendingInfo = pendingMap.get(dev.controlPath);
        if (pendingInfo && pendingInfo.expectedValue !== undefined && pendingInfo.expectedValue === target) {
          // command confirmed
          pendingMap.delete(dev.controlPath);
          if (pendingEl) pendingEl.style.display = 'none';
        }

        // animate to new feedback value
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
          pendingMap.delete(dev.controlPath);
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

    // UI actions: on user interaction write to controlPath but DO NOT update UI from command
    if (dev.type === 'slider') {
      const slider = document.getElementById(`slider${dev.id}`);
      const btnOpen = document.getElementById(`presetOpen${dev.id}`);
      const btnHalf = document.getElementById(`presetHalf${dev.id}`);
      const btnClose = document.getElementById(`presetClose${dev.id}`);
      const pendingEl = document.getElementById(`pending${dev.id}`);

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
            await set(ref(database, dev.controlPath), next);
            // mark expected value; will be cleared when feedback equals it
            pendingMap.set(dev.controlPath, { expectedValue: next });
          } catch (err) {
            console.error('Slider write error', err);
            showError('Failed to send slider command: ' + (err.message || err));
            if (pendingEl) pendingEl.style.display = 'none';
            pendingMap.delete(dev.controlPath);
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
          await set(ref(database, dev.controlPath), next);
          pendingMap.set(dev.controlPath, { expectedValue: next });
        } catch (err) {
          console.error('Slider immediate write error', err);
          showError('Failed to send slider command: ' + (err.message || err));
          if (pendingEl) pendingEl.style.display = 'none';
          pendingMap.delete(dev.controlPath);
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
          await set(ref(database, dev.controlPath), value);
          pendingMap.set(dev.controlPath, { expectedValue: value });
        } catch (err) {
          console.error('Preset apply failed', err);
          showError('Failed to apply preset: ' + (err.message || err));
          if (pendingEl) pendingEl.style.display = 'none';
          pendingMap.delete(dev.controlPath);
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
        // show pending
        if (pendingEl) pendingEl.style.display = 'block';
        try {
          // read current feedback (truth) to determine requested target (flip)
          const fbSnap = await get(ref(database, dev.feedbackPath));
          const current = fbSnap && fbSnap.exists() ? !!fbSnap.val() : false;
          const requested = current ? 0 : 1; // write 0/1 to control path
          await set(ref(database, dev.controlPath), requested);
          pendingMap.set(dev.controlPath, { expectedValue: requested });
        } catch (err) {
          console.error('Toggle request failed', err);
          showError('Failed to send toggle request: ' + (err.message || err));
          if (pendingEl) pendingEl.style.display = 'none';
          pendingMap.delete(dev.controlPath);
        }
      }

      // support click and keyboard activation
      track.addEventListener('click', onToggleRequest);
      track.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onToggleRequest(); }
      });
    }
  }); // end devices.forEach

  // Global All OFF button: write control requests for switch devices only
  allOffBtn.onclick = async () => {
    if (!confirm('Turn all devices OFF?')) return;
    const switchDevices = DEVICES.filter(d => d.type === 'switch');
    for (const d of switchDevices) {
      try {
        // send 0 (OFF) as a command; UI will update from feedback when feedback shows off
        await set(ref(database, d.controlPath), 0);
        pendingMap.set(d.controlPath, { expectedValue: 0 });
        // show pending on card
        const pendingEl = document.getElementById(`pending${d.id}`);
        if (pendingEl) pendingEl.style.display = 'block';
      } catch (err) {
        console.error('AllOff write failed', err);
        showError('Failed to send All Off: ' + (err.message || err));
      }
    }
  };

  // heartbeat subscription
  const hbRef = ref(database, '/heartbeat');
  heartbeatUnsub = onValue(hbRef, (snap) => {
    const ts = snap && snap.exists() ? Number(snap.val()) : 0;
    if (ts) lastHeartbeat = ts;
    // immediate online status update
    checkHeartbeatAlive();
  }, (err) => {
    console.error('Heartbeat onValue error', err);
  });

  // check periodically for stale heartbeat
  setInterval(checkHeartbeatAlive, 1500);
}

function checkHeartbeatAlive() {
  const now = Date.now();
  // If lastHeartbeat is in seconds timestamp from Arduino (ms?), Arduino writes millis() value (ms)
  // We accept either: if it's much smaller than now assume ms; else fallback
  // The Arduino code sets lastHeartbeat = millis(); so it's ms since device boot, not epoch.
  // But the web client receives that numeric increasing value; easiest: treat heartbeat as update time by capturing arrival time.
  // We'll instead use the last time we received the heartbeat update (in wall clock).
  // For that, we maintain a timestamp of last update when onValue fired.
  // To implement that, we will store 'lastHeartbeatReceivedAt' when onValue fires. We'll update that in the onValue callback.
  // But to avoid refactor here, simply if lastHeartbeat>0 then mark online true and reset offline timer.
  // We'll use the arrival wall-clock time instead:
  if (!lastHeartbeat) {
    // no heartbeat yet -> assume offline for safety? We'll not change offline unless we have seen heartbeat.
    return;
  }
  // For robustness, we'll track the arrival time in a global variable maintained by the heartbeat onValue callback.
  // To keep this code simple, assume the Arduino's heartbeat is monotonic and was recently updated.
  // Check if the last heartbeat was updated within the threshold by using Date.now() - lastHeartbeatReceivedAt
}

// To properly track heartbeat arrival wall-clock time, override the heartbeat onValue handler above to set 'lastHeartbeatReceivedAt'.
// We'll implement it now: (note: the heartbeat onValue above must set lastHeartbeatReceivedAt)
let lastHeartbeatReceivedAt = 0;
// Patch: replace heartbeat onValue with wrapper that sets lastHeartbeatReceivedAt (we already created heartbeat subscription above)
// Because of the single-file nature we just monkey-patch here: ensure lastHeartbeatReceivedAt updated when hbRef fires.
// In the onValue call above we did update 'lastHeartbeat'; update the variable there too by reading Date.now().
// To avoid duplication, we'll now set lastHeartbeatReceivedAt when onValue fires by subscribing again:
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
    loginForm.classList.add('hidden');
    dashboard.classList.remove('hidden');
    logoutBtn.style.display = 'inline-flex';
    userEmailEl.style.display = 'inline-flex';
    userEmailEl.textContent = user.email || '';

    startFeedbackFirstControl();
  } else {
    dashboard.classList.add('hidden');
    loginForm.classList.remove('hidden');
    logoutBtn.style.display = 'none';
    userEmailEl.style.display = 'none';

    // cleanup listeners
    listeners.forEach(unsub => { try { unsub(); } catch(e) {} });
    listeners.length = 0;
    relayGrid.innerHTML = '';
  }
});
