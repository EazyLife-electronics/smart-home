// js/ui.mjs
// UI utilities: theme handling, modal & settings DOM helpers, small components

const THEME_KEY = 'smart_home_theme'; // 'light' | 'dark' | 'system'

export function initThemeControls() {
  const themeButton = document.getElementById('themeToggleBtn');
  const themeIcon = document.getElementById('themeIcon');

  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  function apply(theme) {
    // theme: 'light'|'dark'|'system'
    if (theme === 'system') {
      // remove explicit attribute so CSS can follow prefers-color-scheme
      document.documentElement.removeAttribute('data-theme');
      setIcon(prefersDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
      setIcon(theme === 'light' ? 'light' : 'dark');
    }
    themeButton.setAttribute('aria-pressed', String(theme !== 'system' && theme === 'light'));
  }

  function setIcon(kind) {
    if (kind === 'light') {
      themeIcon.innerHTML = '<path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4M12 7a5 5 0 100 10 5 5 0 000-10z"></path>';
    } else {
      themeIcon.innerHTML = '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"></path>';
    }
  }

  // init
  const saved = (localStorage.getItem(THEME_KEY) || 'system');
  apply(saved);

  // button cycles System -> Dark -> Light
  themeButton.addEventListener('click', () => {
    const current = localStorage.getItem(THEME_KEY) || 'system';
    const next = current === 'system' ? 'dark' : (current === 'dark' ? 'light' : 'system');
    localStorage.setItem(THEME_KEY, next);
    apply(next);
  });

  // Expose apply for settings dialog
  return {
    applyThemeSetting: (value) => {
      localStorage.setItem(THEME_KEY, value || 'system');
      apply(value || 'system');
    },
    getThemeSetting: () => (localStorage.getItem(THEME_KEY) || 'system')
  };
}

export function initModal(modalId, openBtn, closeBtn) {
  const modal = document.getElementById(modalId);
  const openButton = document.getElementById(openBtn);
  const closeButton = document.getElementById(closeBtn);
  const backdrop = modal.querySelector('.modal-backdrop');

  function open() {
    modal.setAttribute('aria-hidden', 'false');
    // trap focus minimal: focus first focusable or close button
    (closeButton && document.getElementById(closeBtn).focus()) || modal.focus();
  }
  function close() {
    modal.setAttribute('aria-hidden', 'true');
  }
  // open handlers
  if (openButton) openButton.addEventListener('click', open);
  if (closeButton) closeButton.addEventListener('click', close);
  if (backdrop) backdrop.addEventListener('click', close);
  // allow Escape to close
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && modal.getAttribute('aria-hidden') === 'false') close();
  });

  return { open, close, modal };
}
