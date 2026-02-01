// MV3 service worker for keyboard shortcuts (chrome.commands) + local JSON sync (native messaging)
//
// 配置读取：
// - 为避免 manifest 顶层自定义 key 导致的 Chrome Warnings，本项目将配置写在 description 里：
//   (GNP_JSON_PATH=/abs/path/favorites.json;GNP_NATIVE_HOST=ai_chat_navigator_native)
// - 同时兼容旧版的 gnp_* 自定义字段（若你仍保留它们）。
let GNP_NATIVE_HOST = 'ai_chat_navigator_native';
let GNP_FAV_JSON_PATH = '';
let gnpCfgPromise = null;

async function gnpLoadCfg() {
  if (gnpCfgPromise) return gnpCfgPromise;
  gnpCfgPromise = (async () => {
    const applyFromManifestObj = (mj) => {
      try {
        if (!mj || typeof mj !== 'object') return;
        // 1) description marker (preferred)
        const desc = String(mj.description || '');
        const mPath = desc.match(/\bGNP_JSON_PATH\s*=\s*([^;\)\n\r]+)/i);
        const mHost = desc.match(/\bGNP_NATIVE_HOST\s*=\s*([^;\)\n\r]+)/i);
        const pDesc = (mPath && mPath[1]) ? String(mPath[1]).trim() : '';
        const hDesc = (mHost && mHost[1]) ? String(mHost[1]).trim() : '';
        if (hDesc) GNP_NATIVE_HOST = hDesc;
        if (pDesc) GNP_FAV_JSON_PATH = pDesc;

        // 2) legacy custom keys (back-compat)
        const h = String(mj.gnp_native_host_name || '').trim();
        const p = String(mj.gnp_favorites_json_path || '').trim();
        if (h) GNP_NATIVE_HOST = h;
        if (p) GNP_FAV_JSON_PATH = p;
      } catch (_) {}
    };

    // 1) raw manifest
    try {
      const url = chrome.runtime.getURL('manifest.json');
      const resp = await fetch(url, { cache: 'no-store' });
      const raw = await resp.json();
      applyFromManifestObj(raw);
    } catch (_) {}

    // 2) fallback
    try {
      const mj = chrome?.runtime?.getManifest?.() || {};
      applyFromManifestObj(mj);
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
        // normalize: ensure ok is a *boolean* and never被覆盖
        try {
          if (resp && typeof resp === 'object') {
            if (resp.ok === true || resp.ok === false) return resolve(resp);
            if (typeof resp.success === 'boolean') return resolve({ ...resp, ok: resp.success });
            // IMPORTANT: ok 要放在最后，避免被 resp.ok: 'true' 覆盖
            return resolve({ ...resp, ok: true });
          }
          // 非对象响应（极少数 host 实现）：包一层
          return resolve({ ok: true, data: resp });
        } catch (_) {
          return resolve({ ok: true, data: resp });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) });
    }
  });
}

async function handleFavFileRead() {
  const cfg = await gnpLoadCfg();
  if (!cfg.path) return { ok: false, error: 'GNP_JSON_PATH is not set in manifest.json description' };
  return await sendNativeMessage({ op: 'read', path: cfg.path });
}

async function handleFavFileWrite(text) {
  const cfg = await gnpLoadCfg();
  if (!cfg.path) return { ok: false, error: 'GNP_JSON_PATH is not set in manifest.json description' };
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
