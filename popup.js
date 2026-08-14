const runtimeAPI = typeof browser !== 'undefined' ? browser : chrome;
const SPICY_RE = /:\/\/spicychat\.ai\//;

// Translate raw/internal errors into plain English for the user; keep the
// technical detail in the console (see feedback_verbose_user_errors).
function friendlyError(err) {
  const msg = (err && err.message) || String(err || '');
  if (/auth|sign|token|401|403|consent|silent/i.test(msg))
    return 'Could not sign in to Google Drive — click Sync now again to authorize.';
  if (/network|fetch|timeout|connection|offline|ECONN/i.test(msg))
    return 'Network problem reaching Google Drive. Check your connection and retry.';
  if (/quota|storage full/i.test(msg))
    return 'Google Drive storage is full or unavailable.';
  return msg || 'Sync failed.';
}

// Resolve all open SpicyChat tabs. Prefer a URL-pattern query (we hold the host
// permission); fall back to scanning every tab if the browser rejects it.
async function getSpicyTabs() {
  try {
    const tabs = await runtimeAPI.tabs.query({ url: '*://spicychat.ai/*' });
    if (Array.isArray(tabs)) return tabs;
  } catch (_) { /* fall through */ }
  const all = await runtimeAPI.tabs.query({});
  return all.filter(t => t.url && SPICY_RE.test(t.url));
}

document.addEventListener('DOMContentLoaded', async () => {
  // ---- Version ----
  try {
    const { version } = runtimeAPI.runtime.getManifest();
    document.getElementById('version').textContent = 'v' + version;
  } catch (_) {}

  // ---- Tab awareness ----
  const tabStatus     = document.getElementById('tabStatus');
  const tabStatusText = document.getElementById('tabStatusText');
  const openSpicyBtn  = document.getElementById('openSpicyBtn');

  let onSpicyTab = false;
  try {
    const [activeTab] = await runtimeAPI.tabs.query({ active: true, currentWindow: true });
    onSpicyTab = !!(activeTab && activeTab.url && SPICY_RE.test(activeTab.url));
  } catch (_) {}

  if (onSpicyTab) {
    tabStatus.classList.add('active');
    tabStatusText.textContent = 'Active on this tab';
  } else {
    tabStatus.classList.add('inactive');
    tabStatusText.textContent = 'Not on SpicyChat';
    openSpicyBtn.hidden = false;
  }

  openSpicyBtn.addEventListener('click', async () => {
    const tabs = await getSpicyTabs();
    if (tabs.length) {
      await runtimeAPI.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId != null && runtimeAPI.windows) {
        try { await runtimeAPI.windows.update(tabs[0].windowId, { focused: true }); } catch (_) {}
      }
    } else {
      await runtimeAPI.tabs.create({ url: 'https://spicychat.ai/' });
    }
    window.close();
  });

  // ---- What's New ----
  // If a SpicyChat tab is open, ask its (already-alive) content script to show
  // the changelog history modal directly. Otherwise open a fresh tab and flag
  // it to show the modal once its content script finishes loading.
  const whatsNewBtn = document.getElementById('whatsNewBtn');
  whatsNewBtn.addEventListener('click', async () => {
    const tabs = await getSpicyTabs();
    if (tabs.length) {
      for (const t of tabs) {
        try { await runtimeAPI.tabs.sendMessage(t.id, { type: 'SAI_SHOW_CHANGELOG_HISTORY' }); } catch (_) {}
      }
      await runtimeAPI.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId != null && runtimeAPI.windows) {
        try { await runtimeAPI.windows.update(tabs[0].windowId, { focused: true }); } catch (_) {}
      }
    } else {
      await runtimeAPI.storage.local.set({ openChangelogHistoryOnLoad: true });
      await runtimeAPI.tabs.create({ url: 'https://spicychat.ai/' });
    }
    window.close();
  });

  // ---- Quick toggles ----
  // Each toggle writes the SAME storage key the in-page sidebar uses, so the two
  // stay in sync. These keys are read once at content-script init, so a toggle
  // takes effect the next time the SpicyChat page loads/refreshes.
  const toggles = Array.from(document.querySelectorAll('input[data-key]'));

  const keyDefaults = {};
  toggles.forEach(t => { keyDefaults[t.dataset.key] = false; });

  try {
    const stored = await runtimeAPI.storage.local.get(keyDefaults);
    toggles.forEach(t => { t.checked = !!stored[t.dataset.key]; });
  } catch (e) {
    console.error('[Popup] Failed to load toggle state:', e);
  }

  toggles.forEach(t => {
    t.addEventListener('change', async () => {
      const key = t.dataset.key;
      try {
        await runtimeAPI.storage.local.set({ [key]: t.checked });
      } catch (e) {
        console.error('[Popup] Failed to save toggle', key, e);
        t.checked = !t.checked; // revert UI on failure
      }
    });
  });

  // ---- Google Drive ----
  const syncBtn         = document.getElementById('syncBtn');
  const syncStatus      = document.getElementById('syncStatus');
  const autoSyncToggle  = document.getElementById('autoSyncToggle');
  const autoSyncRow     = document.getElementById('autoSyncIntervalRow');
  const autoSyncSelect  = document.getElementById('autoSyncInterval');

  const setSyncStatus = (text, isError) => {
    syncStatus.textContent = text;
    syncStatus.classList.toggle('error', !!isError);
  };

  // Last sync time + auto-sync prefs
  try {
    const prefs = await runtimeAPI.storage.local.get({
      driveLastSync: null,
      driveAutoSync: false,
      driveAutoSyncInterval: 10
    });
    if (prefs.driveLastSync) {
      setSyncStatus(`Last synced: ${new Date(prefs.driveLastSync).toLocaleString()}`);
    }
    autoSyncToggle.checked = !!prefs.driveAutoSync;
    autoSyncSelect.value = String(prefs.driveAutoSyncInterval || 10);
    autoSyncRow.hidden = !prefs.driveAutoSync;
  } catch (e) {
    console.error('[Popup] Failed to load Drive prefs:', e);
  }

  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing…';
    setSyncStatus('');

    try {
      const result = await runtimeAPI.runtime.sendMessage({ type: 'SAI_DRIVE_SYNC' });
      if (result && result.success) {
        const s = await runtimeAPI.storage.local.get('driveLastSync');
        setSyncStatus(`Synced at ${new Date(s.driveLastSync || Date.now()).toLocaleString()}`);
      } else if (result && result.error === 'auth_silent_fail') {
        setSyncStatus('Could not sign in silently — click Sync now again to authorize.', true);
      } else {
        console.error('[Popup] Sync failed:', result && result.error);
        setSyncStatus(friendlyError({ message: (result && result.error) || '' }), true);
      }
    } catch (e) {
      console.error('[Popup] Sync threw:', e);
      setSyncStatus(friendlyError(e), true);
    }

    syncBtn.disabled = false;
    syncBtn.textContent = 'Sync now';
  });

  const applyAutoSync = async () => {
    const enabled = autoSyncToggle.checked;
    const intervalMinutes = parseInt(autoSyncSelect.value, 10) || 10;
    autoSyncRow.hidden = !enabled;
    try {
      await runtimeAPI.storage.local.set({
        driveAutoSync: enabled,
        driveAutoSyncInterval: intervalMinutes
      });
      await runtimeAPI.runtime.sendMessage({
        type: 'SAI_DRIVE_SET_AUTO_SYNC',
        enabled,
        intervalMinutes
      });
    } catch (e) {
      console.error('[Popup] Failed to apply auto-sync:', e);
      setSyncStatus(friendlyError(e), true);
    }
  };

  autoSyncToggle.addEventListener('change', applyAutoSync);
  autoSyncSelect.addEventListener('change', applyAutoSync);
});
