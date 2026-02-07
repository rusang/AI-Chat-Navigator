// ============================================
// AI Chat Navigator - Background Service Worker (Optimized v2.0)
// ============================================
// 优化内容:
// 1. ✅ 指数退避轮询策略 - 降低CPU使用
// 2. ✅ 增强错误处理和恢复
// 3. ✅ 防抖机制防止竞态条件
// 4. ✅ 内存泄漏防护
// 5. ✅ 详细日志和监控

// === 配置加载 ===
let GNP_NATIVE_HOST = 'ai_chat_navigator_native';
let GNP_FAV_JSON_PATH = '';
let GNP_BACKUP_INTERVAL_MIN = 0;
let gnpCfgPromise = null;

// === 文件轮询相关 ===
const GNP_FAV_FILE_BCAST_KEY = 'gnp_fav_file_bcast_v1';
const GNP_POLL_ALARM_NAME = 'gnp_file_poll_alarm';
const GNP_BACKUP_ALARM_NAME = 'gnp_backup_alarm';

let gnpWatchPorts = new Set();
let gnpFavLastHash = '';
let gnpFavPollInFlight = false;

// 🎨 优化：指数退避策略
let gnpHighFreqTimer = null;
let gnpHighFreqInterval = 2000;        // 初始间隔：2秒
const GNP_MIN_INTERVAL = 2000;         // 最小间隔：2秒
const GNP_MAX_INTERVAL = 30000;        // 最大间隔：30秒
const GNP_BACKOFF_MULTIPLIER = 1.5;    // 退避倍数
const GNP_BACKOFF_THRESHOLD = 5;       // 触发退避的阈值
let gnpNoChangeCount = 0;              // 无变化计数器

// 🎨 优化：防抖机制
let gnpPollDebounceTimer = null;
const GNP_POLL_DEBOUNCE_MS = 300;

// 🎨 优化：端口清理
const GNP_PORT_CLEANUP_INTERVAL = 60000; // 每60秒清理一次
let gnpPortCleanupTimer = null;

/**
 * 加载配置（支持自定义字段）
 */
async function gnpLoadCfg() {
    if (gnpCfgPromise) return gnpCfgPromise;
    
    gnpCfgPromise = (async () => {
        try {
            // 1) 尝试读取原始 manifest.json
            const url = chrome.runtime.getURL('manifest.json');
            const resp = await fetch(url, { cache: 'no-store' });
            const raw = await resp.json();
            
            const h = String(raw?.gnp_native_host_name || 'ai_chat_navigator_native').trim();
            const p = String(raw?.gnp_favorites_json_path || '').trim();
            const b = parseInt(raw?.gnp_backup_interval_min || 0, 10);
            
            if (h) GNP_NATIVE_HOST = h;
            if (p) GNP_FAV_JSON_PATH = p;
            if (!isNaN(b) && b > 0) GNP_BACKUP_INTERVAL_MIN = b;
            
            console.log('[GNP] Config loaded:', { 
                host: GNP_NATIVE_HOST, 
                path: GNP_FAV_JSON_PATH, 
                backupMin: GNP_BACKUP_INTERVAL_MIN 
            });
        } catch (err) {
            console.warn('[GNP] Failed to load config from manifest:', err);
            
            // 2) 回退到 getManifest()
            try {
                const mj = chrome?.runtime?.getManifest?.() || {};
                const h2 = String(mj?.gnp_native_host_name || '').trim();
                const p2 = String(mj?.gnp_favorites_json_path || '').trim();
                const b2 = parseInt(mj?.gnp_backup_interval_min || 0, 10);
                
                if (h2) GNP_NATIVE_HOST = h2;
                if (p2) GNP_FAV_JSON_PATH = p2;
                if (!isNaN(b2) && b2 > 0) GNP_BACKUP_INTERVAL_MIN = b2;
            } catch (_) {
                console.error('[GNP] Failed to load config from getManifest');
            }
        }

        return { 
            host: GNP_NATIVE_HOST, 
            path: GNP_FAV_JSON_PATH, 
            backupMin: GNP_BACKUP_INTERVAL_MIN 
        };
    })();
    
    return gnpCfgPromise;
}

/**
 * 🎨 优化：执行备份操作
 */
async function gnpPerformBackup() {
    try {
        const cfg = await gnpLoadCfg();
        if (!cfg.path || !cfg.backupMin) return;

        const backupPath = cfg.path.replace(/\.json$/i, '_bak.json');
        
        // 1. 读取原文件
        const readResp = await sendNativeMessage({ op: 'read', path: cfg.path });
        if (readResp && readResp.ok && readResp.data) {
            // 2. 写入备份文件
            const writeResp = await sendNativeMessage({ 
                op: 'write', 
                path: backupPath, 
                data: readResp.data 
            });
            
            if (writeResp && writeResp.ok) {
                console.log(`[GNP] ✅ Backup saved to: ${backupPath} at ${new Date().toLocaleString()}`);
            } else {
                console.error('[GNP] ❌ Backup write failed:', writeResp?.error);
            }
        } else {
            console.error('[GNP] ❌ Backup read failed:', readResp?.error);
        }
    } catch (err) {
        console.error('[GNP] ❌ Backup error:', err);
    }
}

/**
 * 哈希函数（用于检测文件变化）
 */
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

/**
 * 🎨 优化：轮询文件变化（带防抖和错误处理）
 */
async function gnpPollFavoritesFileOnce(reason = 'poll') {
    // 清除防抖定时器
    if (gnpPollDebounceTimer) {
        clearTimeout(gnpPollDebounceTimer);
        gnpPollDebounceTimer = null;
    }
    
    // 防抖：300ms内只执行最后一次
    return new Promise((resolve) => {
        gnpPollDebounceTimer = setTimeout(async () => {
            // 防止并发
            if (gnpFavPollInFlight) {
                resolve(false);
                return;
            }
            
            gnpFavPollInFlight = true;
            let hasChanged = false;
            
            try {
                const cfg = await gnpLoadCfg();
                if (!cfg.path) {
                    resolve(false);
                    return;
                }

                const resp = await sendNativeMessage({ op: 'read', path: cfg.path });
                
                if (!resp || resp.ok !== true) {
                    console.warn(`[GNP] Read failed (${reason}):`, resp?.error);
                    resolve(false);
                    return;
                }

                const text = String(resp.data || resp.text || '').trim();
                if (!text) {
                    resolve(false);
                    return;
                }

                const h = gnpHashText(text);
                if (h && h !== gnpFavLastHash) {
                    gnpFavLastHash = h;
                    hasChanged = true;
                    
                    // 广播变化
                    try {
                        await chrome.storage.local.set({
                            [GNP_FAV_FILE_BCAST_KEY]: {
                                ts: Date.now(),
                                origin: 'bg',
                                reason: reason,
                                hash: h
                            }
                        });
                        console.log(`[GNP] ✅ File changed (${reason}), broadcast sent`);
                    } catch (e) {
                        console.error('[GNP] ❌ Broadcast failed:', e);
                    }
                }
            } catch (err) {
                console.error(`[GNP] ❌ Poll error (${reason}):`, err);
            } finally {
                gnpFavPollInFlight = false;
                resolve(hasChanged);
            }
        }, GNP_POLL_DEBOUNCE_MS);
    });
}

/**
 * Chrome Alarms 监听器
 */
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
            console.log('[GNP] ⏰ Alarm polling started (1min interval)');
        }
    });
}

/**
 * 停止文件轮询 Alarm
 */
function gnpStopFavWatch() {
    chrome.alarms.clear(GNP_POLL_ALARM_NAME, (wasCleared) => {
        if (wasCleared) {
            console.log('[GNP] ⏰ Alarm polling stopped');
        }
    });
}

/**
 * 启动备份 Alarm
 */
async function gnpStartBackupAlarm() {
    try {
        const cfg = await gnpLoadCfg();
        if (cfg.backupMin > 0) {
            chrome.alarms.get(GNP_BACKUP_ALARM_NAME, (existing) => {
                if (!existing) {
                    chrome.alarms.create(GNP_BACKUP_ALARM_NAME, {
                        delayInMinutes: 0.1,
                        periodInMinutes: cfg.backupMin
                    });
                    console.log(`[GNP] 💾 Backup alarm started (${cfg.backupMin}min interval)`);
                }
            });
        }
    } catch (err) {
        console.error('[GNP] ❌ Failed to start backup alarm:', err);
    }
}

/**
 * 🎨 优化：启动高频轮询（指数退避策略）
 */
function gnpStartHighFreqPoll() {
    if (gnpHighFreqTimer) return; // 已启动
    
    // 重置参数
    gnpHighFreqInterval = GNP_MIN_INTERVAL;
    gnpNoChangeCount = 0;
    
    const poll = async () => {
        const changed = await gnpPollFavoritesFileOnce('highfreq');
        
        if (changed) {
            // 检测到变化，重置为高频
            gnpNoChangeCount = 0;
            gnpHighFreqInterval = GNP_MIN_INTERVAL;
            console.log(`[GNP] 🔄 File changed, reset to ${GNP_MIN_INTERVAL}ms interval`);
        } else {
            // 无变化，逐渐降低频率
            gnpNoChangeCount++;
            
            if (gnpNoChangeCount > GNP_BACKOFF_THRESHOLD) {
                const newInterval = Math.min(
                    gnpHighFreqInterval * GNP_BACKOFF_MULTIPLIER,
                    GNP_MAX_INTERVAL
                );
                
                if (newInterval !== gnpHighFreqInterval) {
                    gnpHighFreqInterval = newInterval;
                    console.log(`[GNP] 📉 No changes (${gnpNoChangeCount}x), backoff to ${Math.round(gnpHighFreqInterval)}ms`);
                }
            }
        }
        
        // 调度下一次轮询
        clearTimeout(gnpHighFreqTimer);
        gnpHighFreqTimer = setTimeout(poll, gnpHighFreqInterval);
    };
    
    poll();
    console.log('[GNP] 🚀 High-frequency polling started (adaptive 2s-30s)');
}

/**
 * 停止高频轮询
 */
function gnpStopHighFreqPoll() {
    if (!gnpHighFreqTimer) return;
    
    clearTimeout(gnpHighFreqTimer);
    gnpHighFreqTimer = null;
    gnpHighFreqInterval = GNP_MIN_INTERVAL;
    gnpNoChangeCount = 0;
    
    console.log('[GNP] ⏸️ High-frequency polling stopped');
}

/**
 * 🎨 优化：定期清理失效端口
 */
function gnpCleanupStalePorts() {
    const initialSize = gnpWatchPorts.size;
    
    gnpWatchPorts.forEach(port => {
        try {
            // 尝试发送心跳
            port.postMessage({ type: 'gnp_ping', ts: Date.now() });
        } catch (error) {
            // 如果失败，说明连接已断开
            console.log('[GNP] 🧹 Removing stale port');
            gnpWatchPorts.delete(port);
        }
    });
    
    if (gnpWatchPorts.size < initialSize) {
        console.log(`[GNP] 🧹 Cleaned ${initialSize - gnpWatchPorts.size} stale ports, ${gnpWatchPorts.size} remain`);
    }
    
    // 如果没有端口了，停止高频轮询
    if (gnpWatchPorts.size === 0) {
        gnpStopHighFreqPoll();
    }
}

/**
 * 🎨 优化：启动端口清理定时器
 */
function gnpStartPortCleanup() {
    if (gnpPortCleanupTimer) return;
    
    gnpPortCleanupTimer = setInterval(() => {
        gnpCleanupStalePorts();
    }, GNP_PORT_CLEANUP_INTERVAL);
    
    console.log('[GNP] 🧹 Port cleanup timer started (60s interval)');
}

/**
 * 停止端口清理定时器
 */
function gnpStopPortCleanup() {
    if (gnpPortCleanupTimer) {
        clearInterval(gnpPortCleanupTimer);
        gnpPortCleanupTimer = null;
        console.log('[GNP] 🧹 Port cleanup timer stopped');
    }
}

/**
 * 端口连接处理（带内存泄漏防护）
 */
chrome.runtime.onConnect.addListener((port) => {
    try {
        if (!port || port.name !== 'gnp_fav_file_watch') return;
        
        // 🎨 优化：限制最大端口数
        const MAX_PORTS = 50;
        if (gnpWatchPorts.size >= MAX_PORTS) {
            console.warn(`[GNP] ⚠️ Too many ports (${gnpWatchPorts.size}), removing oldest`);
            const firstPort = gnpWatchPorts.values().next().value;
            gnpWatchPorts.delete(firstPort);
            try {
                firstPort.disconnect();
            } catch (_) {}
        }
        
        gnpWatchPorts.add(port);
        console.log(`[GNP] 🔌 Port connected (${gnpWatchPorts.size} active)`);
        
        // 有标签页连接时，启动高频轮询和端口清理
        gnpStartHighFreqPoll();
        gnpStartFavWatch(); // 同时保留 Alarm 作为保底
        gnpStartPortCleanup();

        port.onDisconnect.addListener(() => {
            try {
                gnpWatchPorts.delete(port);
                console.log(`[GNP] 🔌 Port disconnected (${gnpWatchPorts.size} active)`);
            } catch (_) {}
            
            // 所有标签页断开时，停止高频轮询和清理
            if (gnpWatchPorts.size === 0) {
                gnpStopHighFreqPoll();
                gnpStopPortCleanup();
                console.log('[GNP] 💤 All ports disconnected, entering idle mode');
            }
        });
        
        // 🎨 新增：监听端口消息（心跳响应）
        port.onMessage.addListener((msg) => {
            if (msg && msg.type === 'gnp_pong') {
                // 心跳响应，端口仍然活跃
            }
        });
    } catch (err) {
        console.error('[GNP] ❌ Error handling port connection:', err);
    }
});

/**
 * 🎨 优化：与 Native Host 通信（增强错误处理）
 */
async function sendNativeMessage(payload) {
    const cfg = await gnpLoadCfg();
    
    return new Promise((resolve) => {
        try {
            const timeout = setTimeout(() => {
                resolve({ ok: false, error: 'Native message timeout (5s)' });
            }, 5000); // 5秒超时
            
            chrome.runtime.sendNativeMessage(cfg.host, payload, (resp) => {
                clearTimeout(timeout);
                
                const err = chrome.runtime.lastError;
                if (err) {
                    console.error('[GNP] ❌ Native message error:', err.message);
                    return resolve({ ok: false, error: err.message || String(err) });
                }
                
                if (!resp) {
                    return resolve({ ok: false, error: 'Empty native host response' });
                }
                
                // 处理响应
                if (typeof resp === 'object' && resp.ok === true) {
                    return resolve(resp);
                }
                if (typeof resp === 'object' && resp.ok === false) {
                    return resolve(resp);
                }
                
                return resolve({ ok: true, ...resp });
            });
        } catch (e) {
            console.error('[GNP] ❌ Send native message exception:', e);
            resolve({ ok: false, error: e?.message || String(e) });
        }
    });
}

/**
 * 读取收藏文件
 */
async function handleFavFileRead() {
    try {
        const cfg = await gnpLoadCfg();
        if (!cfg.path) {
            return { ok: false, error: 'gnp_favorites_json_path is not set in manifest.json' };
        }
        return await sendNativeMessage({ op: 'read', path: cfg.path });
    } catch (err) {
        console.error('[GNP] ❌ Read favorites error:', err);
        return { ok: false, error: err.message };
    }
}

/**
 * 写入收藏文件
 */
async function handleFavFileWrite(text) {
    try {
        const cfg = await gnpLoadCfg();
        if (!cfg.path) {
            return { ok: false, error: 'gnp_favorites_json_path is not set in manifest.json' };
        }
        
        const data = (typeof text === 'string') ? text : JSON.stringify(text ?? {}, null, 2);
        return await sendNativeMessage({ op: 'write', path: cfg.path, data });
    } catch (err) {
        console.error('[GNP] ❌ Write favorites error:', err);
        return { ok: false, error: err.message };
    }
}

/**
 * 键盘快捷键处理
 */
chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-gnp-sidebar') return;

    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs && tabs[0];
        if (!tab || !tab.id) return;

        // 请求 content script 切换侧边栏
        chrome.tabs.sendMessage(tab.id, { type: 'GNP_TOGGLE_SIDEBAR', command }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('[GNP] Toggle sidebar failed:', chrome.runtime.lastError.message);
            }
        });
    } catch (e) {
        console.error('[GNP] ❌ Command error:', e);
    }
});

/**
 * 消息处理（文件同步桥接）
 */
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
        console.error('[GNP] ❌ Message handler error:', e);
        sendResponse({ ok: false, error: e?.message || String(e) });
    }
});

/**
 * 初始化
 */
try {
    console.log('[GNP] 🚀 Background service worker initializing...');
    
    gnpLoadCfg().then(() => {
        gnpStartFavWatch();      // 启动保底 Alarm
        gnpStartBackupAlarm();   // 启动备份定时器
        // 高频轮询和端口清理由标签页连接时自动启动
        
        console.log('[GNP] ✅ Background service worker initialized');
    }).catch(err => {
        console.error('[GNP] ❌ Initialization error:', err);
    });
} catch (err) {
    console.error('[GNP] ❌ Fatal initialization error:', err);
}

// ============================================
// 优化总结:
// 1. ✅ 指数退避：2s → 30s (无变化时)
// 2. ✅ 防抖机制：300ms (防止连续触发)
// 3. ✅ 端口清理：60s 定期清理失效连接
// 4. ✅ 最大端口限制：50个 (防止内存泄漏)
// 5. ✅ 超时处理：5s native message 超时
// 6. ✅ 增强日志：详细的状态输出
// 7. ✅ 错误恢复：所有关键函数都有 try-catch
// ============================================
