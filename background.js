// MV3 service worker for keyboard shortcuts (chrome.commands) + local JSON sync (native messaging)

// manifest.json 顶层不允许自定义 key，因此 getManifest() 会丢掉 gnp_* 字段。
// 这里用 fetch 读取原始 manifest.json，确保能取到你配置的绝对路径与 Host 名称。
let GNP_NATIVE_HOST = 'ai_chat_navigator_native';
let GNP_FAV_JSON_PATH = '';
let GNP_BACKUP_INTERVAL_MIN = 0;
let gnpCfgPromise = null;

// --- Favorites JSON external-change watcher (MV3 SW) ---
const GNP_FAV_FILE_BCAST_KEY = 'gnp_fav_file_bcast_v1';
const GNP_POLL_ALARM_NAME = 'gnp_file_poll_alarm';
const GNP_BACKUP_ALARM_NAME = 'gnp_backup_alarm';

let gnpWatchPorts = new Set();
let gnpFavLastHash = '';
let gnpFavPollInFlight = false;
let gnpHighFreqTimer = null;  // 新增：高频轮询定时器

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
      const b = parseInt(raw?.gnp_backup_interval_min || 0, 10);
      if (h) GNP_NATIVE_HOST = h;
      if (p) GNP_FAV_JSON_PATH = p;
      if (!isNaN(b) && b > 0) GNP_BACKUP_INTERVAL_MIN = b;
    } catch (_) {}

    // 2) fallback (for cases where fetch manifest fails)
    try {
      const mj = chrome?.runtime?.getManifest?.() || {};
      const h2 = String(mj?.gnp_native_host_name || '').trim();
      const p2 = String(mj?.gnp_favorites_json_path || '').trim();
      const b2 = parseInt(mj?.gnp_backup_interval_min || 0, 10);
      if (h2) GNP_NATIVE_HOST = h2;
      if (p2) GNP_FAV_JSON_PATH = p2;
      if (!isNaN(b2) && b2 > 0) GNP_BACKUP_INTERVAL_MIN = b2;
    } catch (_) {}

    return { host: GNP_NATIVE_HOST, path: GNP_FAV_JSON_PATH, backupMin: GNP_BACKUP_INTERVAL_MIN };
  })();
  return gnpCfgPromise;
}

/**
 * 执行备份操作：读取原文件并写入 _bak.json
 */
async function gnpPerformBackup() {
  const cfg = await gnpLoadCfg();
  if (!cfg.path || !cfg.backupMin) return;

  const backupPath = cfg.path.replace(/\.json$/i, '_bak.json');
  
  // 1. 读取原文件
  const readResp = await sendNativeMessage({ op: 'read', path: cfg.path });
  if (readResp && readResp.ok && readResp.data) {
    // 2. 写入备份文件
    await sendNativeMessage({ op: 'write', path: backupPath, data: readResp.data });
    console.log(`[GNP] Backup auto-saved to: ${backupPath} at ${new Date().toLocaleString()}`);
  }
}

function gnpHashText(text) {
  try {
    const s = String(text || '');
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
  } catch (_) {
    return '';
  }
}

async function gnpPollFavoritesFileOnce(reason = 'poll') {
  if (gnpFavPollInFlight) return;
  gnpFavPollInFlight = true;
  try {
    const cfg = await gnpLoadCfg();
    if (!cfg.path) return;

    const resp = await sendNativeMessage({ op: 'read', path: cfg.path });
    if (!resp || resp.ok !== true) return;

    const text = String(resp.data || resp.text || '').trim();
    if (!text) return;

    const h = gnpHashText(text);
    if (h && h !== gnpFavLastHash) {
      gnpFavLastHash = h;
      // Broadcast change via storage.local
      try {
        await chrome.storage.local.set({
          [GNP_FAV_FILE_BCAST_KEY]: {
            ts: Date.now(),
            origin: 'bg',
            reason: reason,
            hash: h
          }
        });
      } catch (e) {}
    }
  } catch (err) {
    // console.error('[GNP BG] poll fail:', err);
  } finally {
    gnpFavPollInFlight = false;
  }
}

// --- chrome.alarms 用于保底唤醒（1分钟间隔） ---
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === GNP_POLL_ALARM_NAME) {
    gnpPollFavoritesFileOnce('alarm');
  } else if (alarm.name === GNP_BACKUP_ALARM_NAME) {
    gnpPerformBackup();
  }
});

/**
 * 启动文件轮询 Alarm（保底机制）
 */
function gnpStartFavWatch() {
  chrome.alarms.get(GNP_POLL_ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(GNP_POLL_ALARM_NAME, {
        delayInMinutes: 0.1,
        periodInMinutes: 1
      });
      gnpPollFavoritesFileOnce('init');
    }
  });
}

/**
 * 停止文件轮询 Alarm
 */
function gnpStopFavWatch() {
  chrome.alarms.clear(GNP_POLL_ALARM_NAME);
}

/**
 * 启动备份 Alarm
 */
async function gnpStartBackupAlarm() {
  const cfg = await gnpLoadCfg();
  if (cfg.backupMin > 0) {
    chrome.alarms.get(GNP_BACKUP_ALARM_NAME, (existing) => {
      if (!existing) {
        chrome.alarms.create(GNP_BACKUP_ALARM_NAME, {
          delayInMinutes: 0.1,
          periodInMinutes: cfg.backupMin
        });
      }
    });
  }
}

/**
 * 启动高频轮询（2秒间隔，仅当有标签页连接时）
 */
function gnpStartHighFreqPoll() {
  if (gnpHighFreqTimer) return; // 已启动
  gnpHighFreqTimer = setInterval(() => {
    gnpPollFavoritesFileOnce('highfreq');
  }, 2000); // 2秒间隔
  console.log('[GNP BG] High-frequency polling started (2s interval)');
}

/**
 * 停止高频轮询
 */
function gnpStopHighFreqPoll() {
  if (!gnpHighFreqTimer) return;
  clearInterval(gnpHighFreqTimer);
  gnpHighFreqTimer = null;
  console.log('[GNP BG] High-frequency polling stopped');
}

// Keep Service Worker alive while any content script is connected
try {
  chrome.runtime.onConnect.addListener((port) => {
    try {
      if (!port || port.name !== 'gnp_fav_file_watch') return;
      gnpWatchPorts.add(port);
      
      // 有标签页连接时，启动高频轮询
      gnpStartHighFreqPoll();
      gnpStartFavWatch(); // 同时保留 Alarm 作为保底

      port.onDisconnect.addListener(() => {
        try {
          gnpWatchPorts.delete(port);
        } catch (_) {}
        
        // 所有标签页断开时，停止高频轮询
        if (gnpWatchPorts.size === 0) {
          gnpStopHighFreqPoll();
        }
      });
    } catch (_) {}
  });
} catch (_) {}

/**
 * Helper to communicate with the Python/Node native messaging host
 */
async function sendNativeMessage(payload) {
  const cfg = await gnpLoadCfg();
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(cfg.host, payload, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          return resolve({ ok: false, error: err.message || String(err) });
        }
        if (!resp) {
          return resolve({ ok: false, error: 'Empty native host response' });
        }
        // Handle both {ok:true/false} and raw responses
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

// Keyboard shortcut toggle
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-gnp-sidebar') return;

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) return;

    // Ask the content script to toggle the sidebar
    chrome.tabs.sendMessage(tab.id, { type: 'GNP_TOGGLE_SIDEBAR', command });
  } catch (e) {
    // Ignore errors
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
        sendResponse({ ok: true, path: cfg.path, host: cfg.host });
      });
      return true;
    }
  } catch (e) {
    sendResponse({ ok: false, error: e?.message || String(e) });
  }
});

// 初始化：启动配置预热、文件轮询和备份定时器
try { 
  gnpLoadCfg().then(() => {
    gnpStartFavWatch();      // 启动保底 Alarm
    gnpStartBackupAlarm();   // 启动备份定时器
    // 高频轮询由标签页连接时自动启动
  }); 
} catch (_) {}
