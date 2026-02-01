// MV3 service worker for keyboard shortcuts (chrome.commands) + local JSON sync (native messaging)

// manifest.json 顶层不允许自定义 key，因此 getManifest() 会丢掉 gnp_* 字段。
// 这里用 fetch 读取原始 manifest.json，确保能取到你配置的绝对路径与 Host 名称。
let GNP_NATIVE_HOST = 'ai_chat_navigator_native';
let GNP_FAV_JSON_PATH = '';
let gnpCfgPromise = null;

async function gnpLoadCfg() {
  if (gnpCfgPromise) return gnpCfgPromise;
  gnpCfgPromise = (async () => {
    // 1) raw manifest
    try {
      const url = chrome.runtime.getURL('manifest.json');
      const resp = await fetch(url, { cache: 'no-store' });
      const raw = await resp.json();
      const h = String(raw?.gnp_native_host_name || 'ai_chat_navigator_native').trim();
      const p = String(raw?.gnp_favorites_json_path || '').trim();
      if (h) GNP_NATIVE_HOST = h;
      if (p) GNP_FAV_JSON_PATH = p;
    } catch (_) {}

    // 2) fallback
    try {
      const mj = chrome?.runtime?.getManifest?.() || {};
      const h2 = String(mj?.gnp_native_host_name || '').trim();
      const p2 = String(mj?.gnp_favorites_json_path || '').trim();
      if (h2) GNP_NATIVE_HOST = h2;
      if (p2) GNP_FAV_JSON_PATH = p2;
    } catch (_) {}

    return { host: GNP_NATIVE_HOST, path: GNP_FAV_JSON_PATH };
  })();
  return gnpCfgPromise;
}

// 预热（不阻塞）
try { gnpLoadCfg(); } catch (_) {}


async function sendNativeMessage(payload) {
  const cfg = await gnpLoadCfg();
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(cfg.host, payload, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) return resolve({ ok: false, error: err.message || String(err) });
        if (!resp) return resolve({ ok: false, error: 'Empty native host response' });
        // normalize
        if (typeof resp === 'object' && resp.ok === true) return resolve(resp);
        if (typeof resp === 'object' && resp.ok === false) return resolve(resp);
        return resolve({ ok: true, ...resp });
      });
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) });
    }
  });
}

async function handleFavFileRead() {
  const cfg = await gnpLoadCfg();
  if (!cfg.path) return { ok: false, error: 'gnp_favorites_json_path is not set in manifest.json' };
  return await sendNativeMessage({ op: 'read', path: cfg.path });
}

async function handleFavFileWrite(text) {
  const cfg = await gnpLoadCfg();
  if (!cfg.path) return { ok: false, error: 'gnp_favorites_json_path is not set in manifest.json' };
  const data = (typeof text === 'string') ? text : JSON.stringify(text ?? {}, null, 2);
  return await sendNativeMessage({ op: 'write', path: cfg.path, data });
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-gnp-sidebar') return;

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) return;

    // Ask the content script to toggle the sidebar
    chrome.tabs.sendMessage(tab.id, { type: 'GNP_TOGGLE_SIDEBAR', command });
  } catch (e) {
    // Ignore errors (e.g., no active tab, content script not injected on this page)
  }
});

// File sync bridge: content script -> native messaging host
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (!msg || !msg.type) return;

    if (msg.type === 'GNP_FAV_FILE_READ') {
      handleFavFileRead().then(sendResponse);
      return true; // async
    }

    if (msg.type === 'GNP_FAV_FILE_WRITE') {
      handleFavFileWrite(msg.text).then(sendResponse);
      return true; // async
    }

    if (msg.type === 'GNP_FAV_FILE_INFO') {
      gnpLoadCfg().then((cfg) => {
        try { sendResponse({ ok: true, path: cfg.path, host: cfg.host }); } catch (_) {}
      });
      return true;
    }
  } catch (e) {
    try { sendResponse({ ok: false, error: e?.message || String(e) }); } catch (_) {}
  }
});
