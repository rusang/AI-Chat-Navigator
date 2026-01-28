// ==UserScript==
// @name         AI Chat Navigator
// @namespace    http://tampermonkey.net/
// @version      7.1
// @description  支持Command/Ctrl多选 + 批量收藏/删除 + 靶向滚动 + 极致紧凑
// @author       Chantec
// @match        https://gemini.google.com/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=google.com
// @grant        GM_addStyle
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // --- 0. 环境检测 ---
    const IS_CHATGPT = location.hostname.includes('chatgpt.com') || location.hostname.includes('openai.com');
    
    const SITE_CONFIG = {
        gemini: {
            promptSelector: '.query-text', 
            inputSelector: 'div[role="textbox"], div[contenteditable="true"], textarea',
            sendBtnSelector: 'button[aria-label*="Send"], button.send-button'
        },
        chatgpt: {
            // ChatGPT 前端结构变化较快：这里使用“候选选择器列表”做容错
            promptSelector: [
                'article[data-testid^="conversation-turn"] div[data-message-author-role="user"]',
                'div[data-testid^="conversation-turn"] div[data-message-author-role="user"]',
                'li[data-message-author-role="user"]',
                'div[data-message-author-role="user"]'
            ],
            inputSelector: [
                '#prompt-textarea',
                'textarea[data-testid="prompt-textarea"]',
                'div[contenteditable="true"][data-testid="prompt-textarea"]',
                'div[contenteditable="true"][role="textbox"]',
                'textarea[placeholder*="Message"]',
                'textarea[placeholder*="Send"]'
            ],
            sendBtnSelector: [
                'button[data-testid="send-button"]',
                'button[data-testid="fruitjuice-send-button"]',
                'button[aria-label*="Send"]',
                'button[aria-label*="发送"]'
            ]
        }
    };
    
    const CURRENT_CONFIG = IS_CHATGPT ? SITE_CONFIG.chatgpt : SITE_CONFIG.gemini;

    // --- 0.1 选择器与注入工具函数（ChatGPT 兼容 & CSP 兼容） ---
    const toSelectorArray = (sel) => Array.isArray(sel) ? sel : [sel];

    const selectorListToString = (sel) => toSelectorArray(sel).filter(Boolean).join(', ');

    function qsAny(sel, root = document) {
        const list = toSelectorArray(sel);
        for (const s of list) {
            try {
                const el = root.querySelector(s);
                if (el) return el;
            } catch (_) { /* ignore invalid selector */ }
        }
        return null;
    }

    function qsaAll(sel, root = document) {
        const s = selectorListToString(sel);
        try {
            return root.querySelectorAll(s);
        } catch (_) {
            // 若组合选择器异常，逐个合并
            const out = [];
            const list = toSelectorArray(sel);
            for (const one of list) {
                try { out.push(...root.querySelectorAll(one)); } catch (_) {}
            }
            return out;
        }
    }

    function getChatRoot() {
        if (!IS_CHATGPT) return document;
        // ChatGPT 通常将对话内容放在 main 内；限定 root 可减少误匹配/提升性能
        return document.querySelector('main') || document;
    }

    function injectStyles(cssText) {
        try {
            // Tampermonkey/Violentmonkey 在严格 CSP 页面上更稳（避免 <style> 被 CSP 拦截）
            if (typeof GM_addStyle === 'function') { GM_addStyle(cssText); return; }
            if (typeof GM !== 'undefined' && GM && typeof GM.addStyle === 'function') { GM.addStyle(cssText); return; }
        } catch (_) {}
        const styleEl = document.createElement('style');
        styleEl.textContent = cssText;
        (document.head || document.documentElement).appendChild(styleEl);
    }

    function setPromptValue(inputEl, text) {
        if (!inputEl) return;
        const val = text ?? '';

        // textarea/input（React 受控）推荐走原生 setter
        if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
            setNativeValue(inputEl, val);
            return;
        }

        // contenteditable（部分 ChatGPT UI/未来版本可能使用）
        if (inputEl.isContentEditable) {
            inputEl.focus();
            try {
                document.execCommand('selectAll', false, null);
                document.execCommand('insertText', false, val);
            } catch (_) {
                inputEl.textContent = val;
            }
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }

        // fallback
        try {
            inputEl.value = val;
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (_) {}
    }


    // --- 1. 样式表 ---
    const styles = `
:root {
    /* 浅色模式 */
    --gnp-bg: rgba(255, 255, 255, 0.88);
    --gnp-border: rgba(15, 23, 42, 0.12);
    --gnp-shadow: 0 18px 50px rgba(15, 23, 42, 0.14), 0 2px 8px rgba(15, 23, 42, 0.06);
    --gnp-text-main: #0f172a;
    --gnp-text-sub: rgba(15, 23, 42, 0.68);
    --gnp-hover-bg: rgba(15, 23, 42, 0.04);
    --gnp-active-bg: rgba(37, 99, 235, 0.12);
    --gnp-active-border: #2563eb;
    --gnp-active-text: #1d4ed8;
    --gnp-fav-color: #d97706;
    --gnp-input-bg: rgba(15, 23, 42, 0.045);
    --gnp-input-text: #0f172a;
    --gnp-search-highlight: #dc2626;

    --gnp-mini-active-bg: rgba(37, 99, 235, 0.14);
    --gnp-mini-active-shadow: 0 10px 24px rgba(37, 99, 235, 0.16), 0 0 0 1px rgba(37, 99, 235, 0.22);

    --gnp-tab-active-bg: rgba(37, 99, 235, 0.14);
    --gnp-tab-active-shadow: 0 10px 24px rgba(37, 99, 235, 0.16), 0 0 0 1px rgba(37, 99, 235, 0.22);
    --gnp-tab-hover-bg: rgba(15, 23, 42, 0.06);

    --gnp-tab-icon: rgba(15, 23, 42, 0.55);
    --gnp-tab-icon-active: rgba(15, 23, 42, 0.94);

    --gnp-btn-bg: rgba(255, 255, 255, 0.70);
    --gnp-btn-hover: rgba(255, 255, 255, 0.92);

    --gnp-collapsed-bg: rgba(255, 255, 255, 0.92);
    --gnp-collapsed-icon: rgba(15, 23, 42, 0.72);
    --gnp-collapsed-border: rgba(15, 23, 42, 0.18);
    --gnp-collapsed-shadow: 0 16px 40px rgba(15, 23, 42, 0.18), 0 0 0 1px rgba(15, 23, 42, 0.08);
    --gnp-collapsed-accent: rgba(37, 99, 235, 0.78);

    --gnp-hover-preview-border: rgba(15, 23, 42, 0.16);
    --gnp-hover-preview-bg: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(248, 250, 252, 0.92));
    --gnp-hover-preview-toolbar-bg: rgba(255, 255, 255, 0.62);

    --gnp-scroll-thumb: rgba(15, 23, 42, 0.22);
    --gnp-scroll-thumb-hover: rgba(15, 23, 42, 0.34);

    --gnp-index-color: #2563eb;
    --gnp-index-nav: var(--gnp-index-color);
    --gnp-index-fav: var(--gnp-fav-color);
    --gnp-dot-nav: var(--gnp-index-color);
    --gnp-dot-fav: var(--gnp-fav-color);

    --gnp-danger-text: #dc2626;
    --gnp-progress-bg: #2563eb;

    --gnp-autosend-color: #7c3aed;
    --gnp-autosend-bg: rgba(124, 58, 237, 0.12);

    --gnp-modal-bg: rgba(255, 255, 255, 0.94);
    --gnp-modal-overlay: rgba(15, 23, 42, 0.48);

    --gnp-multi-select-bg: rgba(37, 99, 235, 0.12);
    --gnp-multi-select-border: #2563eb;

    --gnp-batch-bar-bg: rgba(255, 255, 255, 0.92);
    --gnp-batch-bar-text: #0f172a;
}
@media (prefers-color-scheme: dark) {
    :root {
        /* 深色模式 */
        --gnp-bg: rgba(17, 24, 39, 0.88);
        --gnp-border: rgba(148, 163, 184, 0.22);
        --gnp-shadow: 0 22px 70px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(148, 163, 184, 0.10);
        --gnp-text-main: rgba(248, 250, 252, 0.96);
        --gnp-text-sub: rgba(248, 250, 252, 0.70);
        --gnp-hover-bg: rgba(148, 163, 184, 0.14);
        --gnp-active-bg: rgba(96, 165, 250, 0.18);
        --gnp-active-border: #60a5fa;
        --gnp-active-text: #93c5fd;
        --gnp-fav-color: #fbbf24;
        --gnp-input-bg: rgba(148, 163, 184, 0.14);
        --gnp-input-text: rgba(248, 250, 252, 0.96);
        --gnp-search-highlight: #f87171;

        --gnp-mini-active-bg: rgba(96, 165, 250, 0.18);
        --gnp-mini-active-shadow: 0 18px 50px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(96, 165, 250, 0.26);

        --gnp-tab-active-bg: rgba(96, 165, 250, 0.18);
        --gnp-tab-active-shadow: 0 18px 50px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(96, 165, 250, 0.26);
        --gnp-tab-hover-bg: rgba(148, 163, 184, 0.16);

        --gnp-tab-icon: rgba(248, 250, 252, 0.62);
        --gnp-tab-icon-active: rgba(248, 250, 252, 0.96);

        --gnp-btn-bg: rgba(31, 41, 55, 0.82);
        --gnp-btn-hover: rgba(55, 65, 81, 0.90);

        --gnp-collapsed-bg: rgba(17, 24, 39, 0.94);
        --gnp-collapsed-icon: rgba(248, 250, 252, 0.92);
        --gnp-collapsed-border: rgba(148, 163, 184, 0.26);
        --gnp-collapsed-shadow: 0 22px 70px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(148, 163, 184, 0.10);
        --gnp-collapsed-accent: rgba(96, 165, 250, 0.78);

        --gnp-hover-preview-border: rgba(148, 163, 184, 0.24);
        --gnp-hover-preview-bg: linear-gradient(180deg, rgba(17, 24, 39, 0.92), rgba(15, 23, 42, 0.92));
        --gnp-hover-preview-toolbar-bg: rgba(0, 0, 0, 0.22);

        --gnp-scroll-thumb: rgba(148, 163, 184, 0.28);
        --gnp-scroll-thumb-hover: rgba(148, 163, 184, 0.44);

        --gnp-index-color: #93c5fd;
        --gnp-index-nav: var(--gnp-index-color);
        --gnp-index-fav: var(--gnp-fav-color);
        --gnp-dot-nav: var(--gnp-index-color);
        --gnp-dot-fav: var(--gnp-fav-color);

        --gnp-danger-text: #fca5a5;
        --gnp-progress-bg: #60a5fa;

        --gnp-autosend-color: #a78bfa;
        --gnp-autosend-bg: rgba(167, 139, 250, 0.20);

        --gnp-modal-bg: rgba(17, 24, 39, 0.94);
        --gnp-modal-overlay: rgba(0, 0, 0, 0.62);

        --gnp-multi-select-bg: rgba(96, 165, 250, 0.18);
        --gnp-multi-select-border: #60a5fa;

        --gnp-batch-bar-bg: rgba(31, 41, 55, 0.92);
        --gnp-batch-bar-text: rgba(248, 250, 252, 0.92);
    }
}


        #gemini-nav-sidebar {
            position: fixed; box-sizing: border-box;
            background: var(--gnp-bg) !important;
            backdrop-filter: blur(20px) saturate(180%);
            -webkit-backdrop-filter: blur(20px) saturate(180%);
            border: 1px solid var(--gnp-border);
            box-shadow: var(--gnp-shadow);
            border-radius: 16px;
            z-index: 2147483647; 
            display: flex; flex-direction: column;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            overflow: hidden;
            height: auto;
            min-height: 100px;
            transition: width 0.3s, left 0.3s, top 0.3s, border-radius 0.3s, opacity 0.3s;
        }

        #gemini-nav-sidebar.collapsed { 
            cursor: pointer; 
            background: var(--gnp-collapsed-bg) !important;
            border: 1px solid var(--gnp-collapsed-border) !important;
            border-left: 4px solid var(--gnp-collapsed-accent) !important;
            box-shadow: var(--gnp-collapsed-shadow) !important;
            height: 44px !important; min-height: 44px !important;
        }
        #gemini-nav-sidebar.collapsed > *:not(#gemini-collapsed-icon) { display: none !important; }
        #gemini-nav-sidebar.collapsed:not([class*="snapped-"]) { width: 44px !important; border-radius: 50% !important; }
        #gemini-collapsed-icon { display: none; flex-direction: column; align-items: center; justify-content: center; width: 100%; height: 100%; gap: 3px; }
        #gemini-nav-sidebar.collapsed:not([class*="snapped-"]) #gemini-collapsed-icon { display: flex; }
        .menu-line { width: 14px; height: 2px; background: var(--gnp-collapsed-icon); border-radius: 1px; }

        #gemini-nav-sidebar.collapsed.snapped-left { width: 6px !important; border-radius: 0 6px 6px 0 !important; left: 0 !important; border-left: none; background: var(--gnp-scroll-thumb) !important; box-shadow: 0 0 0 1px var(--gnp-collapsed-border); }
        #gemini-nav-sidebar.collapsed.snapped-left:hover { background: color-mix(in srgb, var(--gnp-active-border) 80%, transparent) !important; width: 8px !important; }
        
        .gemini-nav-item {
            position: relative; display: block;
            padding: 8px 12px;
            margin: 2px 6px;
            font-size: 14px; color: var(--gnp-text-main);
            cursor: default; 
            border-radius: 12px; 
            transition: background 0.12s ease, box-shadow 0.12s ease;
            overflow: hidden;
            border-left: 3px solid transparent;
        }
        .gemini-nav-item:hover { background: var(--gnp-hover-bg); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gnp-border) 60%, transparent); }
        .gemini-nav-item.dragging { opacity: 0.5; background: var(--gnp-hover-bg); border: 2px dashed var(--gnp-active-border); }
        .gemini-nav-item.drag-over { background: var(--gnp-active-bg); border-top: 2px solid var(--gnp-active-border); }
        .gemini-nav-item.active-current {
            background: var(--gnp-active-bg);
            border-left: 3px solid var(--gnp-active-border);
            color: var(--gnp-active-text);
            font-weight: 500;
        }
        
        /* 多选选中态 */
        .gemini-nav-item.multi-selected {
            background: var(--gnp-multi-select-bg) !important;
            border-left: 3px solid var(--gnp-multi-select-border);
        }

        .gemini-nav-item.active-current .item-text { color: var(--gnp-active-text); }
        .gemini-nav-item.is-favorite .item-text { color: var(--gnp-fav-color); font-weight: 600; }
        .gemini-nav-item.active-current.is-favorite .item-text { color: var(--gnp-fav-color); }
        .item-index { color: var(--gnp-index-color); font-weight: 700; margin-right: 4px; opacity: 0.9; }
        /* 面板区分：导航/收藏 使用不同序号颜色与前置色点 */
        #panel-nav .item-index { color: var(--gnp-index-nav); }
        #panel-fav .item-index { color: var(--gnp-index-fav); opacity: 1; }
        #panel-nav .item-index::before,
        #panel-fav .item-index::before {
            content: '';
            display: inline-block;
            width: 7px;
            height: 7px;
            border-radius: 999px;
            margin-right: 6px;
            transform: translateY(-1px);
        }
        #panel-nav .item-index::before { background: var(--gnp-dot-nav); }
        #panel-fav .item-index::before { background: var(--gnp-dot-fav); }

        .item-text { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; width: 100%; line-height: 1.5; font-size: 13px; -webkit-line-clamp: 10; white-space: normal; }
        .item-text.density-compact { -webkit-line-clamp: 3; white-space: normal; }
        .item-text.density-medium { -webkit-line-clamp: 6; white-space: normal; }
        .item-text.density-spacious { -webkit-line-clamp: 10; white-space: normal; padding-bottom: 2px; }

        .bottom-toolbar {
            position: absolute; bottom: 2px; right: 4px; display: flex; align-items: center; gap: 4px; opacity: 0; transition: opacity 0.12s ease; background: var(--gnp-btn-bg); border: 1px solid var(--gnp-border); border-radius: 12px; padding: 2px; z-index: 20; pointer-events: auto; backdrop-filter: blur(12px) saturate(160%); -webkit-backdrop-filter: blur(12px) saturate(160%); 
        }
        .gemini-nav-item:hover .bottom-toolbar { opacity: 1; }

        /* 导航：使用时间（放在右下角工具区，位于⚡左侧，不占正文列宽） */
        .gnp-nav-use-time{
            height: 20px;
            display: inline-flex;
            align-items: center;
            padding: 0 8px;
            border-radius: 999px;
            font-size: 11px;
            line-height: 1;
            color: var(--gnp-tab-icon);
            background: rgba(0,0,0,0.04);
            border: 1px solid var(--gnp-border);
            box-shadow: 0 1px 2px rgba(0,0,0,0.04);
            user-select: none;
            pointer-events: auto;
        }
        @media (prefers-color-scheme: dark){
            .gnp-nav-use-time{ background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.16); }
        }


        /* 多选模式下隐藏右下角工具图标（防误触） */
        .gemini-nav-item.multi-selected .bottom-toolbar { display: none !important; }
        .gnp-multi-mode .bottom-toolbar { display: none !important; }


        /* 批量操作浮动栏 */
        #gemini-batch-bar {
            position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%) translateY(20px);
            background: var(--gnp-batch-bar-bg); color: var(--gnp-batch-bar-text);
            padding: 8px 16px; border-radius: 24px;
            display: flex; gap: 12px; align-items: center;
            border: 1px solid var(--gnp-border); box-shadow: 0 18px 40px rgba(0,0,0,0.18);
            z-index: 100; transition: 0.2s cubic-bezier(0.18, 0.89, 0.32, 1.28);
            opacity: 0; pointer-events: none;
            font-size: 12px; font-weight: 600; white-space: nowrap;
        }
        #gemini-batch-bar.visible { opacity: 1; pointer-events: auto; transform: translateX(-50%) translateY(0); }
        .batch-btn { cursor: pointer; padding: 6px 10px; border-radius: 12px; transition: background 0.12s ease, transform 0.12s ease, color 0.12s ease, box-shadow 0.12s ease; }
        .batch-btn.action-save { background: color-mix(in srgb, var(--gnp-active-border) 12%, transparent); color: var(--gnp-active-text); }
        .batch-btn.action-save:hover { background: color-mix(in srgb, var(--gnp-active-border) 18%, transparent); }
        .batch-btn.action-delete { background: color-mix(in srgb, var(--gnp-danger-text) 12%, transparent); color: var(--gnp-danger-text); }
        .batch-btn.action-delete:hover { background: color-mix(in srgb, var(--gnp-danger-text) 18%, transparent); }
        .batch-btn.action-cancel { color: var(--gnp-text-sub); font-weight: normal; }
        .batch-btn.action-cancel:hover { color: var(--gnp-text-main); }

        .mini-btn {
            width: 24px; height: 20px; display: flex; align-items: center; justify-content: center; border-radius: 4px; cursor: pointer; color: var(--gnp-text-sub); background: var(--gnp-bg); box-shadow: 0 1px 2px rgba(0,0,0,0.05); font-size: 11px; transition: all 0.1s;
        }
        .mini-btn:hover { background: var(--gnp-btn-hover); color: var(--gnp-text-main); transform: scale(1.1); z-index: 21; }
        .mini-btn.active:hover, .mini-btn.is-active:hover, .mini-btn[aria-pressed="true"]:hover, .mini-btn.star-btn.is-fav:hover {
            background: var(--gnp-mini-active-bg);
            box-shadow: var(--gnp-mini-active-shadow);
            transform: scale(1.1);
        }
        .mini-btn.use-btn { font-weight: bold; }
        .mini-btn.use-btn:hover { color: #1a73e8; background: rgba(26, 115, 232, 0.1); }
        .mini-btn.use-btn.autosend-mode { color: var(--gnp-autosend-color); background: var(--gnp-autosend-bg); border: 1px solid var(--gnp-autosend-color); }
        .mini-btn.active, .mini-btn.is-active, .mini-btn[aria-pressed="true"] { background: var(--gnp-mini-active-bg); box-shadow: var(--gnp-mini-active-shadow); color: var(--gnp-active-text); border-color: color-mix(in srgb, var(--gnp-active-border) 26%, var(--gnp-border)); }
        .mini-btn.star-btn.is-fav { color: var(--gnp-fav-color); font-weight: 700; background: var(--gnp-mini-active-bg); box-shadow: var(--gnp-mini-active-shadow); border-color: color-mix(in srgb, var(--gnp-fav-color) 28%, var(--gnp-border)); }
        .mini-btn.del-btn:hover { color: var(--gnp-danger-text); background: color-mix(in srgb, var(--gnp-danger-text) 12%, transparent); border-color: color-mix(in srgb, var(--gnp-danger-text) 26%, var(--gnp-border)); }

        #gemini-nav-header { padding: 12px 14px 10px 14px; display: flex; flex-direction: column; gap: 10px; flex-shrink: 0; cursor: move; background: rgba(255,255,255,0.35); border-bottom: 1px solid var(--gnp-border); }
        .header-row { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 8px; }
        @media (prefers-color-scheme: dark){ #gemini-nav-header { background: rgba(0,0,0,0.18); } }
        #gemini-header-controls { display: flex; gap: 3px; align-items: center; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; flex: 1; min-width: 0; }
        #gemini-header-controls::-webkit-scrollbar{ display:none; }

        #gemini-fav-header { display:flex; justify-content:space-between; align-items:center; flex-wrap:nowrap; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; gap:8px; padding:8px 12px; margin-bottom:6px; border-bottom:1px solid var(--gnp-border); }
        #gemini-fav-header::-webkit-scrollbar{ display:none; }
        #gemini-fav-left { display:flex; align-items:center; gap:8px; flex-wrap:nowrap; min-width:0; flex:1 1 auto; }
        #gemini-fav-right { display:flex; align-items:center; gap:6px; flex-shrink:0; flex-wrap:nowrap; }
        #gemini-nav-tabs { display: flex; align-items: center; gap: 3px; background: rgba(15, 23, 42, 0.04); padding: 2px; border-radius: 12px; border: 1px solid var(--gnp-border); }
        #gemini-nav-tabs { flex: 0 0 auto; }

        .header-circle-btn {
            width: 22px;
            height: 22px;
            min-width: 22px;
            min-height: 22px;
            padding: 0;
            border-radius: 999px;
            box-sizing: border-box;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            border: 1px solid var(--gnp-border);
            background: var(--gnp-btn-bg);
            color: var(--gnp-text-sub);
            transition: transform 0.12s ease, background 0.12s ease, color 0.12s ease, box-shadow 0.12s ease;
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.55);
            line-height: 1;
            flex: 0 0 auto;
        }
        .header-circle-btn:hover { transform: translateY(-1px); background: var(--gnp-btn-hover); color: var(--gnp-text-main); box-shadow: inset 0 1px 0 rgba(255,255,255,0.65), 0 8px 20px rgba(15,23,42,0.10); }
        #gemini-nav-lock.active { background: #34c759; color: #fff; box-shadow: 0 0 4px rgba(52, 199, 89, 0.4); }
        #gemini-nav-autosend.active { background: var(--gnp-autosend-color); color: #fff; box-shadow: 0 0 6px var(--gnp-autosend-color); }
        #gemini-nav-clear:hover { background: rgba(220, 38, 38, 0.14); color: var(--gnp-danger-text); }
        #gemini-nav-top:hover, #gemini-nav-bottom:hover, #gemini-nav-chat-bottom:hover { background: rgba(37, 99, 235, 0.14); color: var(--gnp-active-text); }

        .nav-tab { 
            width: 22px;
            height: 22px;
            min-width: 22px;
            min-height: 22px;
            padding: 0;
            border-radius: 999px;
            box-sizing: border-box;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            color: var(--gnp-text-sub);
            transition: transform 0.12s ease, background 0.12s ease, color 0.12s ease, box-shadow 0.12s ease;
            line-height: 1;
            flex: 0 0 auto;
        }
        .nav-tab:hover { background: var(--gnp-tab-hover-bg); color: var(--gnp-tab-icon-active); }
        .nav-tab.active { background: var(--gnp-tab-active-bg); color: var(--gnp-tab-icon-active); font-weight: 700; box-shadow: var(--gnp-tab-active-shadow); }

        .nav-tab.active:hover { background: var(--gnp-tab-active-bg); box-shadow: var(--gnp-tab-active-shadow); }
        .nav-tab .icon-svg { width: 11px; height: 11px; stroke-width: 2.5; stroke: currentColor !important; fill: none !important; }
        .nav-tab.active .icon-svg { stroke: currentColor !important; fill: none !important; }
        .header-circle-btn .icon-svg { width: 11px; height: 11px; }
        
        #gemini-progress-container { width: 100%; height: 3px; background: rgba(0,0,0,0.05); border-radius: 2px; overflow: hidden; margin-top: 4px; }
        #gemini-progress-bar { height: 100%; width: 0%; background: var(--gnp-progress-bg); transition: width 0.3s; }

        #gemini-nav-content-wrapper { flex-grow: 1; overflow-y: auto; padding: 6px 2px 10px; position: relative; }
        #gemini-nav-content-wrapper::-webkit-scrollbar { width: 6px; } 
        #gemini-nav-content-wrapper::-webkit-scrollbar-thumb { background: var(--gnp-scroll-thumb); border-radius: 4px; transition: background 0.3s; }
        #gemini-nav-content-wrapper::-webkit-scrollbar-thumb:hover { background: var(--gnp-scroll-thumb-hover); }
        
        .content-panel { display: none; }
        .content-panel.active { display: block; }

        #gemini-nav-search-container { padding: 4px 14px 8px 14px; }
        #gemini-nav-search-input { width: 100%; box-sizing: border-box; padding: 9px 12px; background: var(--gnp-input-bg); border: 1px solid var(--gnp-border); border-radius: 12px; font-size: 14px; outline: none; transition: background 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease; color: var(--gnp-input-text) !important; }
        #gemini-nav-search-input:focus { background: var(--gnp-input-bg); border-color: color-mix(in srgb, var(--gnp-active-border) 36%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--gnp-active-border) 22%, transparent); }
        #gemini-nav-search-input::placeholder { color: var(--gnp-text-sub); }

        .resizer { position: absolute; z-index: 10001; background: transparent; }
        /* 边缘拉伸（更容易命中） */
        .resizer-t { top: -4px; left: 12px; right: 12px; height: 8px; cursor: ns-resize; }
        .resizer-b { bottom: -8px; left: 52px; right: 52px; height: 20px; cursor: ns-resize; }
        .resizer-l { left: -4px; top: 12px; bottom: 12px; width: 8px; cursor: ew-resize; }
        .resizer-r { right: -4px; top: 12px; bottom: 12px; width: 8px; cursor: ew-resize; }
        /* 四角拉伸（优先级更高） */
        .resizer-tl, .resizer-tr, .resizer-bl, .resizer-br { width: 26px; height: 26px; z-index: 10002; }
        .resizer-tl { top: -6px; left: -6px; cursor: nw-resize; }
        .resizer-tr { top: -6px; right: -6px; cursor: ne-resize; }
        .resizer-bl { bottom: -6px; left: -6px; cursor: sw-resize; }
        .resizer-br { bottom: -8px; right: -8px; cursor: se-resize; opacity: 0.55; background: repeating-linear-gradient(135deg, rgba(0,0,0,0.0) 0 6px, rgba(0,0,0,0.0) 6px 8px, rgba(0,0,0,0.20) 8px 10px); border-radius: 8px; }
html[data-theme="dark"] .resizer-br { background: repeating-linear-gradient(135deg, rgba(255,255,255,0.0) 0 6px, rgba(255,255,255,0.0) 6px 8px, rgba(255,255,255,0.22) 8px 10px); }
#gemini-nav-sidebar:hover .resizer-br { opacity: 0.9; }

        .icon-svg { width: 12px; height: 12px; }

        .gnp-search-highlight { color: var(--gnp-search-highlight) !important; font-weight: 700; }

        .gnp-confirm-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: var(--gnp-modal-overlay); z-index: 100; display: flex; flex-direction: column; align-items: center; justify-content: center; backdrop-filter: blur(4px); animation: fadeIn 0.2s ease; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .gnp-confirm-box { padding: 16px; background: var(--gnp-modal-bg); border: 1px solid var(--gnp-border); border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.2); max-width: 85%; text-align: center; }
        .gnp-confirm-title { font-size: 15px; font-weight: 600; color: var(--gnp-text-main); margin-bottom: 4px; }
        .gnp-confirm-desc { font-size: 12px; color: var(--gnp-text-sub); margin-bottom: 12px; }
        .gnp-btn-row { display: flex; gap: 8px; justify-content: center; }
        .gnp-btn-confirm { background: #d93025; color: #fff; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; border: none; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .gnp-btn-confirm:hover { background: #b02018; }
        .gnp-btn-cancel { background: transparent; color: var(--gnp-text-main); padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; border: 1px solid var(--gnp-border); }
        .gnp-btn-cancel:hover { background: var(--gnp-hover-bg); }

        
        /* 全屏居中编辑弹窗（用于收藏编辑） */
        .gnp-global-overlay { position: fixed; inset: 0; background: var(--gnp-modal-overlay); z-index: 2147483647; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px); animation: fadeIn 0.2s ease; }
        .gnp-global-box { width: min(760px, 86vw); max-height: 82vh; background: var(--gnp-modal-bg); border: 1px solid var(--gnp-border); border-radius: 14px; box-shadow: 0 22px 70px rgba(0,0,0,0.22); padding: 16px 16px 14px; display: flex; flex-direction: column; gap: 10px; }
        .gnp-global-title { font-size: 15px; font-weight: 600; color: var(--gnp-text-main); }
        .gnp-global-textarea { width: 100%; box-sizing: border-box; padding: 12px 12px 56px 12px; border-radius: 10px; border: 1px solid var(--gnp-border); outline: none; font-size: 14px; line-height: 1.5; background: var(--gnp-input-bg); color: var(--gnp-input-text); caret-color: var(--gnp-input-text); min-height: 132px; max-height: 52vh; resize: vertical; overflow: auto; white-space: pre-wrap; }
        .gnp-global-textarea::placeholder { color: var(--gnp-text-sub); }
        .gnp-global-error { margin-top: -6px; color: #d33; font-size: 12px; display: none; }
        .gnp-global-btnrow { display: flex; gap: 10px; justify-content: flex-end; }
/* 轻量提示条：用于批量收藏成功等状态提示（显示在导航窗口内） */
        .gnp-toast {
            position: absolute;
            left: 12px;
            right: 12px;
            bottom: 12px;
            padding: 8px 10px;
            border-radius: 10px;
            background: rgba(29, 29, 31, 0.92);
            color: #fff;
            font-size: 12px;
            text-align: center;
            z-index: 100000;
            pointer-events: none;
        }
    

        /* 收藏：顶部操作图标按钮（避免文字层叠） */
        .gnp-danger-btn { color: var(--gnp-danger-text) !important; background: rgba(217,48,37,0.08) !important; }
        .gnp-danger-btn:hover { background: rgba(217,48,37,0.18) !important; color: var(--gnp-danger-text) !important; }

        /* 收藏：文件夹徽标（点击可移动） */
        .gnp-folder-badge{
            display:inline-flex;
            align-items:center;
            font-size:10px;
            line-height:1;
            color: var(--gnp-text-sub);
            background: rgba(0,0,0,0.04);
            border: 1px solid var(--gnp-border);
            border-radius: 10px;
            padding: 2px 6px;
            margin-right: 6px;
            cursor: pointer;
            flex-shrink:0;
        }
        .gnp-folder-badge:hover{ background: var(--gnp-hover-bg); }

        /* 收藏：使用次数/最近使用 */
        .gnp-use-meta{
            display:inline-flex;
            align-items:center;
            font-size:10px;
            line-height:1;
            color: var(--gnp-text-sub);
            background: rgba(0,0,0,0.03);
            border: 1px solid var(--gnp-border);
            border-radius: 10px;
            padding: 2px 6px;
            margin-right: 6px;
            white-space: nowrap;
            flex-shrink:0;
            user-select: none;
        }
        @media (prefers-color-scheme: dark){
            .gnp-use-meta{ background: rgba(148,163,184,0.14); border-color: rgba(148,163,184,0.22); color: rgba(248,250,252,0.72); }
            #gemini-nav-tabs { background: rgba(148, 163, 184, 0.10); }
        }

        
        /* 导航：使用时间徽标（顶部右侧，不占行） */
        .gnp-nav-use-meta{
            position: absolute;
            top: 6px;
            right: 8px;
            z-index: 5;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 8px;
            border-radius: 999px;
            font-size: 10px;
            line-height: 1.2;
            color: var(--gnp-text-sub);
            background: rgba(26, 115, 232, 0.10);
            border: 1px solid rgba(26, 115, 232, 0.22);
            user-select: none;
            pointer-events: auto;
            -webkit-backdrop-filter: blur(6px) saturate(1.1);
            backdrop-filter: blur(6px) saturate(1.1);
        }
        html[data-theme="dark"] .gnp-nav-use-meta{
            color: rgba(248,250,252,0.80);
            background: rgba(96, 165, 250, 0.14);
            border: 1px solid rgba(96, 165, 250, 0.28);
        }
        /* 给右上角徽标留出空间，避免压住首行文字 */
        .gemini-nav-item[data-gnp-source="nav"] .item-text{
            padding-right: 0;
        }

.gnp-folder-select:focus{ outline: none; }
        .gnp-prompt-input::placeholder{ color: var(--gnp-text-sub); }

/* Hover preview (show full prompt) */
#gnp-hover-preview{
    position: fixed;
    left: 0; top: 0;
    z-index: 2147483647;
    display: none;
    flex-direction: column;
    max-width: min(720px, 78vw);
    max-height: min(420px, 55vh);
    padding: 12px;
    border-radius: 12px;
    background: var(--gnp-hover-preview-bg);
    -webkit-backdrop-filter: blur(10px) saturate(1.1);
    backdrop-filter: blur(10px) saturate(1.1);
    border: 1px solid var(--gnp-border);
    box-shadow: 0 22px 70px rgba(0,0,0,0.22);
    color: var(--gnp-text-main);
    font-size: 16px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
    pointer-events: auto; /* 允许滚动/选中文本 */
    overflow: hidden;      /* 保持圆角裁剪 */
}
#gnp-hover-preview.visible{ display:flex; }
#gnp-hover-preview .gnp-hover-preview-toolbar{
    /* footer row: keep actions + meta on their own line */
    position: relative;
    width: 100%;
    display:flex;
    align-items:center;
    justify-content:flex-end;
    gap:6px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--gnp-border);
    pointer-events: auto;
}
@media (prefers-color-scheme: dark){
    #gnp-hover-preview .gnp-hover-preview-toolbar{ border-top-color: rgba(255,255,255,0.14); }
}
html[data-theme="dark"] #gnp-hover-preview .gnp-hover-preview-toolbar{
    border-top-color: rgba(255,255,255,0.14);
}

#gnp-hover-preview .gnp-hover-use-meta{
    height: 20px;
    display: inline-flex;
    align-items: center;
    padding: 0 10px;
    border-radius: 999px;
    font-size: 12px;
    line-height: 1;
    color: var(--gnp-text-sub);
    background: rgba(0,0,0,0.06);
    border: 1px solid var(--gnp-border);
    box-shadow: 0 1px 2px rgba(0,0,0,0.06);
    user-select: none;
    pointer-events: auto;
    margin-right: 2px;
}
@media (prefers-color-scheme: dark){
    #gnp-hover-preview .gnp-hover-use-meta{ background: rgba(255,255,255,0.10); border-color: rgba(255,255,255,0.16); color: rgba(255,255,255,0.82); }
}
html[data-theme="dark"] #gnp-hover-preview .gnp-hover-use-meta{
    background: rgba(255,255,255,0.10);
    border-color: rgba(255,255,255,0.16);
    color: rgba(255,255,255,0.82);
}

#gnp-hover-preview .gnp-hover-preview-toolbar .mini-btn{
    border: 1px solid var(--gnp-border);
    background: transparent;
    width: 24px;
    height: 20px;
    font-size: 11px;
}
#gnp-hover-preview .gnp-hover-preview-text{
    white-space: pre-wrap;
    word-break: break-word;
}
#gnp-hover-preview .gnp-hover-editarea{
    width: 100%;
    flex: 1 1 auto;
    min-height: 280px;
    box-sizing: border-box;
    resize: none; /* 由弹窗本体提供 resize，避免双重拉伸手柄 */
    padding: 12px 12px;
    border-radius: 12px;
    border: 1px solid var(--gnp-border);
    background: rgba(255,255,255,0.60);
    color: var(--gnp-text-main);
    font-size: 15px;
    line-height: 1.5;
    outline: none;
    overflow: auto;
}
html[data-theme="dark"] #gnp-hover-preview .gnp-hover-editarea{
    background: rgba(0,0,0,0.35);
}


    /* Dark-mode heuristics (Gemini may use in-app dark theme even when OS is light) */
    html[data-theme*="dark"] #gnp-hover-preview,
    body[data-theme*="dark"] #gnp-hover-preview,
    html[data-color-mode="dark"] #gnp-hover-preview,
    body[data-color-mode="dark"] #gnp-hover-preview,
    html[data-color-scheme="dark"] #gnp-hover-preview,
    body[data-color-scheme="dark"] #gnp-hover-preview,
    html[theme="dark"] #gnp-hover-preview,
    body[theme="dark"] #gnp-hover-preview,
    html[dark] #gnp-hover-preview,
    body[dark] #gnp-hover-preview,
    html.dark #gnp-hover-preview,
    body.dark #gnp-hover-preview,
    html[class*="dark"] #gnp-hover-preview,
    body[class*="dark"] #gnp-hover-preview,
    html[style*="color-scheme: dark"] #gnp-hover-preview,
    body[style*="color-scheme: dark"] #gnp-hover-preview {
        --gnp-hover-preview-bg: linear-gradient(180deg, rgba(17, 24, 39, 0.92), rgba(15, 23, 42, 0.92));
        --gnp-border: rgba(148, 163, 184, 0.16);
        --gnp-text-main: rgba(248, 250, 252, 0.92);
        --gnp-text-sub: rgba(203, 213, 225, 0.72);
    }

    html[data-theme*="dark"] #gnp-hover-preview .gnp-hover-preview-toolbar,
    body[data-theme*="dark"] #gnp-hover-preview .gnp-hover-preview-toolbar,
    html[data-color-mode="dark"] #gnp-hover-preview .gnp-hover-preview-toolbar,
    body[data-color-mode="dark"] #gnp-hover-preview .gnp-hover-preview-toolbar,
    html[data-color-scheme="dark"] #gnp-hover-preview .gnp-hover-preview-toolbar,
    body[data-color-scheme="dark"] #gnp-hover-preview .gnp-hover-preview-toolbar,
    html[theme="dark"] #gnp-hover-preview .gnp-hover-preview-toolbar,
    body[theme="dark"] #gnp-hover-preview .gnp-hover-preview-toolbar,
    html[dark] #gnp-hover-preview .gnp-hover-preview-toolbar,
    body[dark] #gnp-hover-preview .gnp-hover-preview-toolbar,
    html.dark #gnp-hover-preview .gnp-hover-preview-toolbar,
    body.dark #gnp-hover-preview .gnp-hover-preview-toolbar,
    html[class*="dark"] #gnp-hover-preview .gnp-hover-preview-toolbar,
    body[class*="dark"] #gnp-hover-preview .gnp-hover-preview-toolbar,
    html[style*="color-scheme: dark"] #gnp-hover-preview .gnp-hover-preview-toolbar,
    body[style*="color-scheme: dark"] #gnp-hover-preview .gnp-hover-preview-toolbar {
        border-top-color: rgba(255,255,255,0.14);
    }

    html[data-theme*="dark"] #gnp-hover-preview .gnp-hover-use-meta,
    body[data-theme*="dark"] #gnp-hover-preview .gnp-hover-use-meta,
    html[data-color-mode="dark"] #gnp-hover-preview .gnp-hover-use-meta,
    body[data-color-mode="dark"] #gnp-hover-preview .gnp-hover-use-meta,
    html[data-color-scheme="dark"] #gnp-hover-preview .gnp-hover-use-meta,
    body[data-color-scheme="dark"] #gnp-hover-preview .gnp-hover-use-meta,
    html[theme="dark"] #gnp-hover-preview .gnp-hover-use-meta,
    body[theme="dark"] #gnp-hover-preview .gnp-hover-use-meta,
    html[dark] #gnp-hover-preview .gnp-hover-use-meta,
    body[dark] #gnp-hover-preview .gnp-hover-use-meta,
    html.dark #gnp-hover-preview .gnp-hover-use-meta,
    body.dark #gnp-hover-preview .gnp-hover-use-meta,
    html[class*="dark"] #gnp-hover-preview .gnp-hover-use-meta,
    body[class*="dark"] #gnp-hover-preview .gnp-hover-use-meta,
    html[style*="color-scheme: dark"] #gnp-hover-preview .gnp-hover-use-meta,
    body[style*="color-scheme: dark"] #gnp-hover-preview .gnp-hover-use-meta {
        background: rgba(255,255,255,0.10);
        border-color: rgba(255,255,255,0.16);
        color: rgba(255,255,255,0.82);
    }

    html[data-theme*="dark"] #gnp-hover-preview .gnp-hover-editarea,
    body[data-theme*="dark"] #gnp-hover-preview .gnp-hover-editarea,
    html[data-color-mode="dark"] #gnp-hover-preview .gnp-hover-editarea,
    body[data-color-mode="dark"] #gnp-hover-preview .gnp-hover-editarea,
    html[data-color-scheme="dark"] #gnp-hover-preview .gnp-hover-editarea,
    body[data-color-scheme="dark"] #gnp-hover-preview .gnp-hover-editarea,
    html[theme="dark"] #gnp-hover-preview .gnp-hover-editarea,
    body[theme="dark"] #gnp-hover-preview .gnp-hover-editarea,
    html[dark] #gnp-hover-preview .gnp-hover-editarea,
    body[dark] #gnp-hover-preview .gnp-hover-editarea,
    html.dark #gnp-hover-preview .gnp-hover-editarea,
    body.dark #gnp-hover-preview .gnp-hover-editarea,
    html[class*="dark"] #gnp-hover-preview .gnp-hover-editarea,
    body[class*="dark"] #gnp-hover-preview .gnp-hover-editarea,
    html[style*="color-scheme: dark"] #gnp-hover-preview .gnp-hover-editarea,
    body[style*="color-scheme: dark"] #gnp-hover-preview .gnp-hover-editarea {
        background: rgba(0,0,0,0.35);
        color: rgba(248,250,252,0.92);
        caret-color: rgba(248,250,252,0.92);
        border-color: rgba(148, 163, 184, 0.20);
    }

#gnp-hover-preview.editing{
    max-width: min(920px, 92vw);
    max-height: min(720px, 84vh);
    min-width: 420px;
    min-height: 360px;
    resize: both; /* 编辑模式可拉伸弹窗本体 */
}
#gnp-hover-preview.editing .gnp-hover-preview-inner{
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
#gnp-hover-preview .gnp-hover-edit-hint{
    margin-top: 8px;
    font-size: 12px;
    color: var(--gnp-text-sub);
    user-select: none;
}
#gnp-hover-preview .gnp-hover-preview-inner{
    flex: 1 1 auto;
    overflow: auto;
    padding-right: 2px;
}
#gnp-hover-preview .gnp-hover-preview-inner::-webkit-scrollbar-thumb { background: var(--gnp-scroll-thumb); border-radius: 4px; }
#gnp-hover-preview .gnp-hover-preview-inner::-webkit-scrollbar-thumb:hover { background: var(--gnp-scroll-thumb-hover); }


/* Focus ring (accessibility) */
#gemini-nav-search-input:focus-visible,
.header-circle-btn:focus-visible,
.nav-tab:focus-visible,
.mini-btn:focus-visible,
.batch-btn:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--gnp-active-border) 55%, transparent);
    outline-offset: 2px;
}
`;

    injectStyles(styles);

    const SVGS = {
        clear: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`,
        close: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
        edit: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`,
        copy: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
        pin: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg>`,
        folderPlus: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path><line x1="12" y1="12" x2="12" y2="18"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>`,
        folderX: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path><line x1="10" y1="13" x2="14" y2="17"></line><line x1="14" y1="13" x2="10" y2="17"></line></svg>`,
        top: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`,
        bottom: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>`,
        chatBottom: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M7 13l5 5 5-5M7 6l5 5 5-5"/></svg>`,
                locate: `<svg class=\"icon-svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"7\"/><line x1=\"12\" y1=\"2\" x2=\"12\" y2=\"5\"/><line x1=\"12\" y1=\"19\" x2=\"12\" y2=\"22\"/><line x1=\"2\" y1=\"12\" x2=\"5\" y2=\"12\"/><line x1=\"19\" y1=\"12\" x2=\"22\" y2=\"12\"/></svg>`,
chatTop: `<svg class=\"icon-svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M7 11l5-5 5 5M7 18l5-5 5 5\"/></svg>`,
        check: `✔`,
        star: `★`,
        lightning: `⚡`,
        
        nav: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"></polygon></svg>`,
        
        starTab: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`
    };

    const sidebar = document.createElement('div');
    sidebar.id = 'gemini-nav-sidebar';

// --- Hover preview: show full prompt content on hover ---
let gnpHoverPreviewEl = null;
let gnpHoverPreviewToolbarEl = null;
let gnpHoverPreviewInnerEl = null;
let gnpHoverPreviewTimer = null;
let gnpHoverPreviewHideTimer = null;
let gnpHoverPreviewAnchor = null;

let gnpHoverPreviewState = { source: '', text: '' };
let gnpHoverPreviewIsEditing = false;
let gnpHoverPreviewEditTextArea = null;

let gnpHoverPreviewDismissInstalled = false;

function onDocMouseDownForHoverPreview(e) {
    try {
        if (!gnpHoverPreviewEl || !gnpHoverPreviewEl.classList.contains('visible')) return;
        // 点击弹窗内部不关闭
        if (gnpHoverPreviewEl.contains(e.target)) return;
        hideHoverPreview();
    } catch (_) {}
}

function onKeyDownForHoverPreview(e) {
    try {
        if (e && (e.key === 'Escape' || e.key === 'Esc')) {
            if (gnpHoverPreviewEl && gnpHoverPreviewEl.classList.contains('visible')) hideHoverPreview();
        }
    } catch (_) {}
}

function installHoverPreviewDismissHandlers() {
    if (gnpHoverPreviewDismissInstalled) return;
    gnpHoverPreviewDismissInstalled = true;
    // capture: 优先于页面自身逻辑，确保“点击外部关闭”稳定
    document.addEventListener('mousedown', onDocMouseDownForHoverPreview, true);
    window.addEventListener('keydown', onKeyDownForHoverPreview, true);
}

function removeHoverPreviewDismissHandlers() {
    if (!gnpHoverPreviewDismissInstalled) return;
    gnpHoverPreviewDismissInstalled = false;
    document.removeEventListener('mousedown', onDocMouseDownForHoverPreview, true);
    window.removeEventListener('keydown', onKeyDownForHoverPreview, true);
}

function ensureHoverPreviewEl() {
    if (gnpHoverPreviewEl && document.body && document.body.contains(gnpHoverPreviewEl)) return gnpHoverPreviewEl;

    gnpHoverPreviewEl = document.createElement('div');
    gnpHoverPreviewEl.id = 'gnp-hover-preview';

    gnpHoverPreviewToolbarEl = document.createElement('div');
    gnpHoverPreviewToolbarEl.className = 'gnp-hover-preview-toolbar';

    gnpHoverPreviewInnerEl = document.createElement('div');
    gnpHoverPreviewInnerEl.className = 'gnp-hover-preview-inner';

    // inner first, toolbar as footer row (icons + meta on their own line)
    gnpHoverPreviewEl.append(gnpHoverPreviewInnerEl, gnpHoverPreviewToolbarEl);
    (document.body || document.documentElement).appendChild(gnpHoverPreviewEl);

    // 允许从条目移入弹窗而不闪退：进入弹窗取消隐藏，移出弹窗自动关闭
    gnpHoverPreviewEl.addEventListener('mouseenter', () => {
        if (gnpHoverPreviewHideTimer) { clearTimeout(gnpHoverPreviewHideTimer); gnpHoverPreviewHideTimer = null; }
    });
    gnpHoverPreviewEl.addEventListener('mouseleave', () => {
        if (gnpHoverPreviewIsEditing) return;
        scheduleHideHoverPreview(120);
    });

        

    return gnpHoverPreviewEl;
}


function gnpCssEscape(s) {
    try { return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/[^a-zA-Z0-9_\-]/g, (c) => '\\' + c); }
    catch (_) { return String(s).replace(/["\\]/g, '\\$&'); }
}

function clearHoverPreviewContent() {
    if (!gnpHoverPreviewToolbarEl || !gnpHoverPreviewInnerEl) return;
    gnpHoverPreviewToolbarEl.replaceChildren();
    gnpHoverPreviewInnerEl.replaceChildren();
}

function makeMiniBtn({ cls = '', title = '', html = '', text = '', onClick = null }) {
    const b = document.createElement('span');
    b.className = `mini-btn ${cls}`.trim();
    if (title) b.title = title;
    if (html) b.innerHTML = html;
    if (!html && text) b.textContent = text;
    if (onClick) b.onclick = (e) => { try { e.stopPropagation(); onClick(e); } catch (_) {} };
    // 防止触发多选/拖拽等
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    return b;
}

function exitHoverPreviewEditMode() {
    gnpHoverPreviewIsEditing = false;
    gnpHoverPreviewEditTextArea = null;
    if (gnpHoverPreviewEl) gnpHoverPreviewEl.classList.remove('editing');
}

function enterHoverPreviewEditMode(favText) {
    const originalText = String(favText || '').trim();
    if (!originalText) return;

    const el = ensureHoverPreviewEl();
    gnpHoverPreviewIsEditing = true;
    el.classList.add('editing');

    clearHoverPreviewContent();

    // 工具栏：取消/保存
    const cancelBtn = makeMiniBtn({ cls: '', title: '退出编辑 (Esc)', html: SVGS.close, onClick: () => {
        exitHoverPreviewEditMode();
        renderHoverPreviewContent(gnpHoverPreviewAnchor, originalText);
        repositionHoverPreview();
    }});

    const saveBtn = makeMiniBtn({ cls: '', title: '保存 (Ctrl/Cmd+Enter)', html: SVGS.check, onClick: () => doSave() });

    gnpHoverPreviewToolbarEl.append(cancelBtn, saveBtn);

    // 编辑区
    const ta = document.createElement('textarea');
    ta.className = 'gnp-hover-editarea';
    ta.value = originalText;
    gnpHoverPreviewEditTextArea = ta;

    const hint = document.createElement('div');
    hint.className = 'gnp-hover-edit-hint';
    hint.textContent = 'Ctrl/Cmd + Enter 保存，Esc 取消';

    gnpHoverPreviewInnerEl.append(ta, hint);

    const doSave = () => {
        const val = String(ta.value || '').trim();
        if (!val) { showSidebarToast('内容不能为空'); return; }

        const oldText = originalText;
        const newText = val;
        const dupIdx = getFavoriteIndex(newText);

        if (dupIdx === -1 || newText === oldText) {
            const idx = getFavoriteIndex(oldText);
            if (idx > -1) {
                // 更新选中集
                if (selectedItems && selectedItems.has(oldText)) {
                    selectedItems.delete(oldText);
                    selectedItems.add(newText);
                }
                favorites[idx].text = newText;
                saveFavorites();
            }
        } else {
            // 已存在：合并（删除当前条）
            const idx = getFavoriteIndex(oldText);
            if (idx > -1) favorites.splice(idx, 1);
            if (selectedItems && selectedItems.has(oldText)) selectedItems.delete(oldText);
            saveFavorites();
        }

        // 刷新列表
        if (panelFav && panelFav.classList.contains('active')) renderFavorites();
        if (panelNav && panelNav.classList.contains('active')) refreshNav(true);

        // 尝试重新锚定到新条目（若重复合并，则锚定到已存在的那条）
        const anchorText = newText;
        try {
            const newAnchor = panelFav ? panelFav.querySelector(`.gemini-nav-item[data-prompt="${gnpCssEscape(anchorText)}"]`) : null;
            if (newAnchor) gnpHoverPreviewAnchor = newAnchor;
        } catch (_) {}

        exitHoverPreviewEditMode();
        renderHoverPreviewContent(gnpHoverPreviewAnchor, anchorText);
        repositionHoverPreview();
        showSidebarToast('已保存');
    };

    ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); cancelBtn.click(); }
        else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); doSave(); }
    });

    setTimeout(() => { try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {} }, 0);
}

function renderHoverPreviewContent(anchorEl, text) {
    const t = String(text ?? '').trim();
    if (!gnpHoverPreviewToolbarEl || !gnpHoverPreviewInnerEl) ensureHoverPreviewEl();
    if (!gnpHoverPreviewToolbarEl || !gnpHoverPreviewInnerEl) return;

    exitHoverPreviewEditMode();
    clearHoverPreviewContent();

    const source = (anchorEl && anchorEl.dataset && anchorEl.dataset.gnpSource) ? anchorEl.dataset.gnpSource
        : (anchorEl && anchorEl.closest && anchorEl.closest('#panel-fav')) ? 'fav' : 'nav';

    gnpHoverPreviewState = { source, text: t };

    // 内容
    const content = document.createElement('div');
    content.className = 'gnp-hover-preview-text';
    content.textContent = t;
    gnpHoverPreviewInnerEl.appendChild(content);

    // 工具栏
    if (source === 'fav') {
        // 统计信息（使用次数 / 最近使用）
        try {
            const idx = getFavoriteIndex(t);
            const favObj = (idx > -1 && favorites && favorites[idx]) ? favorites[idx] : { useCount: 0, lastUsed: 0 };
            const uc = Number(favObj.useCount) || 0;
            const lu = Number(favObj.lastUsed) || 0;
            const meta = document.createElement('span');
            meta.className = 'gnp-hover-use-meta';
            meta.textContent = `${uc}次 · ${formatRelativeTimeNav(lu)}`;
            meta.title = lu ? `最近使用：${new Date(lu).toLocaleString()}` : '从未使用';
            meta.addEventListener('mousedown', (e) => e.stopPropagation());
            meta.addEventListener('click', (e) => e.stopPropagation());
            gnpHoverPreviewToolbarEl.appendChild(meta);
        } catch (_) {}

        // 填入
        gnpHoverPreviewToolbarEl.appendChild(makeMiniBtn({
            cls: 'use-btn',
            title: isAutoSendEnabled ? '自动发送' : '填入',
            text: '⚡',
            onClick: () => fillInput(t)
        }));

        // 复制
        const copyBtn = makeMiniBtn({ cls: '', title: '复制', html: SVGS.copy, onClick: () => {
            navigator.clipboard.writeText(t);
                recordPromptUse(t);
            copyBtn.innerHTML = SVGS.check;
            setTimeout(() => { try { copyBtn.innerHTML = SVGS.copy; } catch (_) {} }, 900);
        }});
        gnpHoverPreviewToolbarEl.appendChild(copyBtn);

        // 编辑（弹窗内）
        gnpHoverPreviewToolbarEl.appendChild(makeMiniBtn({
            cls: '',
            title: '编辑',
            html: SVGS.edit,
            onClick: () => enterHoverPreviewEditMode(t)
        }));

        // 置顶
        gnpHoverPreviewToolbarEl.appendChild(makeMiniBtn({
            cls: '',
            title: '置顶',
            html: SVGS.pin,
            onClick: () => {
                const idx = getFavoriteIndex(t);
                if (idx > 0) {
                    const obj = favorites[idx];
                    favorites.splice(idx, 1);
                    favorites.unshift(obj);
                    saveFavorites();
                    if (panelFav && panelFav.classList.contains('active')) renderFavorites();
                    // 重新锚定
                    try {
                        const newAnchor = panelFav ? panelFav.querySelector(`.gemini-nav-item[data-prompt="${gnpCssEscape(t)}"]`) : null;
                        if (newAnchor) gnpHoverPreviewAnchor = newAnchor;
                    } catch (_) {}
                    repositionHoverPreview();
                }
            }
        }));

        // 删除
        gnpHoverPreviewToolbarEl.appendChild(makeMiniBtn({
            cls: 'del-btn',
            title: '删除',
            html: SVGS.clear,
            onClick: () => {
                const idx = getFavoriteIndex(t);
                if (idx > -1) {
                    favorites.splice(idx, 1);
                    if (selectedItems && selectedItems.has(t)) selectedItems.delete(t);
                    saveFavorites();
                    if (panelFav && panelFav.classList.contains('active')) renderFavorites();
                    if (panelNav && panelNav.classList.contains('active')) refreshNav(true);
                    hideHoverPreview();
                    showSidebarToast('已删除');
                }
            }
        }));
    } else {
        // 统计信息（最近使用时间）
        try {
            const lu = Number(getPromptLastUsed(t)) || 0;
            const meta = document.createElement('span');
            meta.className = 'gnp-hover-use-meta';
            meta.textContent = formatRelativeTimeNav(lu);
            meta.title = lu ? `最近使用：${new Date(lu).toLocaleString()}` : '从未使用';
            meta.addEventListener('mousedown', (e) => e.stopPropagation());
            meta.addEventListener('click', (e) => e.stopPropagation());
            gnpHoverPreviewToolbarEl.appendChild(meta);
        } catch (_) {}

        // nav 弹窗：填入 / 复制 / 收藏切换
        gnpHoverPreviewToolbarEl.appendChild(makeMiniBtn({
            cls: 'use-btn',
            title: isAutoSendEnabled ? '自动发送' : '填入',
            text: '⚡',
            onClick: () => fillInput(t)
        }));

        const copyBtn = makeMiniBtn({ cls: '', title: '复制', html: SVGS.copy, onClick: () => {
            navigator.clipboard.writeText(t);
                recordPromptUse(t);
            copyBtn.innerHTML = SVGS.check;
            setTimeout(() => { try { copyBtn.innerHTML = SVGS.copy; } catch (_) {} }, 900);
        }});
        gnpHoverPreviewToolbarEl.appendChild(copyBtn);

        const starBtn = makeMiniBtn({ cls: `star-btn ${hasFavorite(t) ? 'is-fav' : ''}`, title: hasFavorite(t) ? '取消收藏' : '收藏', text: hasFavorite(t) ? '★' : '☆', onClick: () => {
            const isFav = hasFavorite(t);
            if (!isFav) {
                const targetFolder = (favFolderFilter && favFolderFilter !== '全部') ? favFolderFilter : '默认';
                addFavorite(t, targetFolder);
                saveFavorites();
                showSidebarToast('已收藏');
            } else {
                removeFavorite(t);
                saveFavorites();
                showSidebarToast('已取消收藏');
            }
            // 更新列表
            if (panelFav && panelFav.classList.contains('active')) renderFavorites();
            if (panelNav && panelNav.classList.contains('active')) refreshNav(true);

            // 更新按钮状态（不重建弹窗也能更新）
            const nowFav = hasFavorite(t);
            starBtn.textContent = nowFav ? '★' : '☆';
            starBtn.title = nowFav ? '取消收藏' : '收藏';
            starBtn.classList.toggle('is-fav', nowFav);
        }});
        gnpHoverPreviewToolbarEl.appendChild(starBtn);
    }
}

function clampNumber(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function clearHoverPreviewTimers() {
    if (gnpHoverPreviewTimer) { clearTimeout(gnpHoverPreviewTimer); gnpHoverPreviewTimer = null; }
    if (gnpHoverPreviewHideTimer) { clearTimeout(gnpHoverPreviewHideTimer); gnpHoverPreviewHideTimer = null; }
}

function hideHoverPreview() {
    gnpHoverPreviewAnchor = null;
    clearHoverPreviewTimers();
    removeHoverPreviewDismissHandlers();
    if (gnpHoverPreviewEl) gnpHoverPreviewEl.classList.remove('visible');
}

function scheduleHideHoverPreview(delay = 120) {
    if (gnpHoverPreviewHideTimer) { clearTimeout(gnpHoverPreviewHideTimer); gnpHoverPreviewHideTimer = null; }
    gnpHoverPreviewHideTimer = setTimeout(() => hideHoverPreview(), delay);
}

function showHoverPreview(anchorEl, text) {
    if (!anchorEl) return;
    const t = String(text ?? '').trim();
    if (!t) return;

    // 如果侧边栏折叠/隐藏，不显示
    try {
        const sb = document.getElementById('gemini-nav-sidebar');
        if (sb && sb.classList.contains('collapsed')) return;
    } catch (_) {}

    gnpHoverPreviewAnchor = anchorEl;
    if (gnpHoverPreviewHideTimer) { clearTimeout(gnpHoverPreviewHideTimer); gnpHoverPreviewHideTimer = null; }
    if (gnpHoverPreviewTimer) { clearTimeout(gnpHoverPreviewTimer); gnpHoverPreviewTimer = null; }

    // 轻微延迟，避免快速扫过时抖动
    gnpHoverPreviewTimer = setTimeout(() => {
        if (gnpHoverPreviewAnchor !== anchorEl) return;
        const el = ensureHoverPreviewEl();
        installHoverPreviewDismissHandlers();
        renderHoverPreviewContent(anchorEl, t);

        // 先显示以便测量尺寸
        el.classList.add('visible');
        el.style.left = '0px';
        el.style.top = '0px';

        const rect = anchorEl.getBoundingClientRect();
        const tooltipW = el.offsetWidth || 360;
        const tooltipH = el.offsetHeight || 180;

        // 默认：右半屏的条目 -> 弹窗向左；左半屏 -> 向右
        const preferLeft = rect.left > (window.innerWidth / 2);
        let x = preferLeft ? (rect.left - tooltipW - 12) : (rect.right + 12);
        x = clampNumber(x, 8, window.innerWidth - tooltipW - 8);

        let y = rect.top;
        y = clampNumber(y, 8, window.innerHeight - tooltipH - 8);

        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
    }, 120);
}


let gnpHoverMeasureEl = null;

function ensureHoverMeasureEl() {
    if (gnpHoverMeasureEl && document.body && document.body.contains(gnpHoverMeasureEl)) return gnpHoverMeasureEl;

    gnpHoverMeasureEl = document.createElement('div');
    gnpHoverMeasureEl.id = 'gnp-hover-measure';
    gnpHoverMeasureEl.setAttribute('aria-hidden', 'true');
    gnpHoverMeasureEl.style.cssText = 'position: fixed; left: -99999px; top: -99999px; visibility: hidden; pointer-events: none; z-index: -1; white-space: normal; word-break: break-word; overflow: visible; padding: 0; margin: 0; border: 0;';
    (document.body || document.documentElement).appendChild(gnpHoverMeasureEl);
    return gnpHoverMeasureEl;
}

// 仅当内容超过 10 行（即被省略）时，才显示 hover 预览弹窗
function isPromptOmittedOverTenLines(textEl, fullText) {
    try {
        if (!textEl) return false;
        const t = String(fullText ?? '').trim();
        if (!t) return false;

        const rect = textEl.getBoundingClientRect();
        const w = Math.max(0, rect.width);
        if (!w) return false;

        const cs = getComputedStyle(textEl);
        const meas = ensureHoverMeasureEl();
        meas.style.width = `${Math.ceil(w)}px`;
        meas.style.fontFamily = cs.fontFamily;
        meas.style.fontSize = cs.fontSize;
        meas.style.fontWeight = cs.fontWeight;
        meas.style.fontStyle = cs.fontStyle;
        meas.style.letterSpacing = cs.letterSpacing;
        meas.style.lineHeight = cs.lineHeight;
        meas.style.wordBreak = cs.wordBreak || 'break-word';
        meas.style.overflowWrap = cs.overflowWrap || 'anywhere';
        meas.textContent = t;

        const fullH = meas.scrollHeight;

        let lh = parseFloat(cs.lineHeight);
        if (!lh || Number.isNaN(lh)) {
            const fs = parseFloat(cs.fontSize) || 14;
            lh = fs * 1.5; // fallback（与 .item-text 默认 line-height: 1.5 对齐）
        }

        const maxH = lh * 10 + 1; // 10 行阈值 + 容差
        return fullH > maxH;
    } catch (_) {
        return false;
    }
}

function bindHoverPreviewToItem(itemEl) {
    if (!itemEl) return;

    itemEl.addEventListener('mouseenter', () => {
        if (!document.body.contains(itemEl)) return;
        if (gnpHoverPreviewHideTimer) { clearTimeout(gnpHoverPreviewHideTimer); gnpHoverPreviewHideTimer = null; }
        const full = (itemEl.dataset && itemEl.dataset.prompt) ? itemEl.dataset.prompt : '';
        const textEl = itemEl.querySelector('.item-text');
        showHoverPreview(itemEl, full);
    });

    itemEl.addEventListener('mouseleave', () => {
        // 离开条目后稍后关闭；若鼠标进入弹窗会取消关闭
        if (gnpHoverPreviewIsEditing) return;
        scheduleHideHoverPreview(240);
    });
}

function repositionHoverPreview() {
    try {
        if (!gnpHoverPreviewEl || !gnpHoverPreviewEl.classList.contains('visible') || !gnpHoverPreviewAnchor) return;
        const rect = gnpHoverPreviewAnchor.getBoundingClientRect();
        // 若锚点不可见（例如侧栏折叠后 display:none），保持当前位置
        if ((rect.width <= 1 && rect.height <= 1)) return;

        const el = gnpHoverPreviewEl;
        const tooltipW = el.offsetWidth || 360;
        const tooltipH = el.offsetHeight || 180;

        const preferLeft = rect.left > (window.innerWidth / 2);
        let x = preferLeft ? (rect.left - tooltipW - 12) : (rect.right + 12);
        x = clampNumber(x, 8, window.innerWidth - tooltipW - 8);

        let y = rect.top;
        y = clampNumber(y, 8, window.innerHeight - tooltipH - 8);

        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
    } catch (_) {}
}

// 页面滚动/缩放时仅重新定位（不自动隐藏）
window.addEventListener('scroll', repositionHoverPreview, true);
window.addEventListener('resize', repositionHoverPreview, true);


    const collapsedIcon = document.createElement('div');
    collapsedIcon.id = 'gemini-collapsed-icon';
    [1, 2, 3].forEach(() => {
        const line = document.createElement('span');
        line.className = 'menu-line';
        collapsedIcon.appendChild(line);
    });

    const header = document.createElement('div');
    header.id = 'gemini-nav-header';

    const headerRow = document.createElement('div');
    headerRow.className = 'header-row';

    const headerControls = document.createElement('div');
    headerControls.id = 'gemini-header-controls';

    const lockBtn = document.createElement('div');
    lockBtn.id = 'gemini-nav-lock';
    lockBtn.className = 'header-circle-btn';
    lockBtn.title = '锁定/自动隐藏';
    
    const topBtn = document.createElement('div');
    topBtn.id = 'gemini-nav-top';
    topBtn.className = 'header-circle-btn';
    topBtn.title = '回到列表顶部';
    topBtn.innerHTML = SVGS.top;

    const bottomBtn = document.createElement('div');
    bottomBtn.id = 'gemini-nav-bottom';
    bottomBtn.className = 'header-circle-btn';
    bottomBtn.title = '直达列表底部';
    bottomBtn.innerHTML = SVGS.bottom;
    
    
    const chatTopBtn = document.createElement('div');
    chatTopBtn.id = 'gemini-nav-chat-top';
    chatTopBtn.className = 'header-circle-btn';
    chatTopBtn.title = '网页内容直达顶部';
    chatTopBtn.innerHTML = SVGS.chatTop;

    const chatBottomBtn = document.createElement('div');
    chatBottomBtn.id = 'gemini-nav-chat-bottom';
    chatBottomBtn.className = 'header-circle-btn';
    chatBottomBtn.title = '网页内容直达底部';
    chatBottomBtn.innerHTML = SVGS.chatBottom;

    const locateBtn = document.createElement('div');
    locateBtn.id = 'gemini-nav-locate';
    locateBtn.className = 'header-circle-btn';
    locateBtn.title = '定位当前 Prompt（居中显示）';
    locateBtn.innerHTML = SVGS.locate;

    
    const autoSendBtn = document.createElement('div');
    autoSendBtn.id = 'gemini-nav-autosend';
    autoSendBtn.className = 'header-circle-btn';
    autoSendBtn.textContent = '⚡';
    autoSendBtn.title = '切换自动发送模式';

    const clearBtn = document.createElement('div');
    clearBtn.id = 'gemini-nav-clear';
    clearBtn.className = 'header-circle-btn';
    clearBtn.title = '清空输入框';
    clearBtn.innerHTML = SVGS.clear;

    headerControls.append(lockBtn, topBtn, bottomBtn, chatTopBtn, chatBottomBtn, autoSendBtn, clearBtn, locateBtn);

    const tabsContainer = document.createElement('div');
    tabsContainer.id = 'gemini-nav-tabs';
    
    const tabNav = document.createElement('div');
    tabNav.className = 'nav-tab active';
    tabNav.title = '目录';
    tabNav.innerHTML = SVGS.nav; 
    tabNav.dataset.target = 'panel-nav';
    
    const tabFav = document.createElement('div');
    tabFav.className = 'nav-tab';
    tabFav.title = '收藏';
    tabFav.innerHTML = SVGS.starTab; 
    tabFav.dataset.target = 'panel-fav';
    
    tabsContainer.append(tabNav, tabFav);
    
    headerRow.append(headerControls, tabsContainer);
    
    const progressContainer = document.createElement('div');
    progressContainer.id = 'gemini-progress-container';
    const progressBar = document.createElement('div');
    progressBar.id = 'gemini-progress-bar';
    progressContainer.append(progressBar);

    header.append(headerRow, progressContainer);

    const searchContainer = document.createElement('div');
    searchContainer.id = 'gemini-nav-search-container';
    const searchInput = document.createElement('input');
    searchInput.id = 'gemini-nav-search-input';
    searchInput.placeholder = '搜索...';
    searchContainer.append(searchInput);

    const contentWrapper = document.createElement('div');
    contentWrapper.id = 'gemini-nav-content-wrapper';
    const panelNav = document.createElement('div');
    panelNav.id = 'panel-nav';
    panelNav.className = 'content-panel active';
    const panelFav = document.createElement('div');
    panelFav.id = 'panel-fav';
    panelFav.className = 'content-panel';
    contentWrapper.append(panelNav, panelFav);

    // --- 批量操作浮动栏 ---
    const batchBar = document.createElement('div');
    batchBar.id = 'gemini-batch-bar';
    sidebar.append(batchBar); // 挂载到底部

    const resizers = ['t','r','b','l','tl','tr','bl','br'].map(pos => {
        const el = document.createElement('div');
        el.className = `resizer resizer-${pos}`;
        el.dataset.pos = pos;
        return el;
    });

    setTimeout(() => {
        sidebar.append(collapsedIcon, header, searchContainer, contentWrapper, ...resizers);
        document.body.appendChild(sidebar);

        // 修复：页面刷新后侧边栏初次注入不会自动触发 mouseleave，从而无法自动隐藏。
        // 注入完成后若鼠标不在侧边栏上，则主动触发一次自动隐藏计时。
        setTimeout(() => {
            try {
                if (!isAutoHideEnabled) return;
                if (!sidebar || sidebar.classList.contains('collapsed')) return;
                if (sidebar.matches(':hover')) return;
                scheduleAutoHide();
            } catch (_) {}
        }, 60);
    }, 1500);

    const STORAGE_KEY_CONFIG = 'gemini-nav-config-v7-0'; 
    const STORAGE_KEY_FAV = 'gemini-favorites';
    const STORAGE_KEY_HIDE = 'gemini-auto-hide';
    const STORAGE_KEY_AUTOSEND = 'gemini-auto-send-mode';
    const STORAGE_KEY_USAGE = 'gemini-nav-usage-stats-v1';

    const STORAGE_KEY_FOLDERS = 'gemini-nav-pro-panel-fav-folders';
    const STORAGE_KEY_FAV_FOLDER_FILTER = 'gemini-nav-pro-panel-fav-folder-filter';

    let folders = JSON.parse(localStorage.getItem(STORAGE_KEY_FOLDERS)) || ['默认'];
    folders = [...new Set(folders.map(f => String(f || '').trim()).filter(Boolean))];
    if (!folders.includes('默认')) folders.unshift('默认');
    const saveFolders = () => {
        localStorage.setItem(STORAGE_KEY_FOLDERS, JSON.stringify(folders));
        gnpPersistSharedState();
    };

    // 收藏：兼容旧版本（string 数组）与新版本（对象数组）
    const rawFav = JSON.parse(localStorage.getItem(STORAGE_KEY_FAV)) || [];
    const seenFavText = new Set();
    let favorites = [];
    rawFav.forEach(it => {
        let t = '';
        let folder = '默认';
        let useCount = 0;
        let lastUsed = 0;
        if (typeof it === 'string') {
            t = it;
        } else if (it && typeof it === 'object') {
            t = it.text ?? it.t ?? '';
            folder = it.folder ?? it.f ?? folder;
            useCount = parseInt(it.useCount ?? it.uc ?? it.count ?? it.c ?? 0, 10) || 0;
            lastUsed = Number(it.lastUsed ?? it.lu ?? it.last ?? it.u ?? 0) || 0;
        }
        t = String(t || '').trim();
        folder = String(folder || '默认').trim() || '默认';
        if (!t) return;
        if (seenFavText.has(t)) return;
        seenFavText.add(t);
        if (!folders.includes(folder)) folders.push(folder);
        favorites.push({ text: t, folder, useCount, lastUsed });
    });

    let favFolderFilter = localStorage.getItem(STORAGE_KEY_FAV_FOLDER_FILTER) || '全部';


    // 导航使用记录（用于在“目录”面板展示最近使用时间；key 为 prompt 的哈希，避免把长文本直接当作对象 key）
    let usageStats = {};
    try {
        usageStats = JSON.parse(localStorage.getItem(STORAGE_KEY_USAGE) || '{}') || {};
    } catch (_) { usageStats = {}; }
    if (!usageStats || typeof usageStats !== 'object' || Array.isArray(usageStats)) usageStats = {};

    // === Shared favorites across tabs / origins / Chrome instances (via chrome.storage) ===
    // 说明：
    // - 现有实现使用 localStorage（按站点域隔离），因此 Gemini/ChatGPT 等不同域名之间不会共享收藏。
    // - chrome.storage 属于扩展级存储：同一 Chrome Profile 下所有标签页/窗口/不同站点都共享；
    //   若使用 storage.sync，则在同账号的不同 Chrome/设备间也可同步（受配额限制，超限自动降级 local）。
    const GNP_SHARED_STATE_KEY = 'ai-chat-navigator-shared-state-v1';
    const gnpChrome = (typeof chrome !== 'undefined') ? chrome : null;
    const gnpStorageSync = gnpChrome && gnpChrome.storage && gnpChrome.storage.sync;
    const gnpStorageLocal = gnpChrome && gnpChrome.storage && gnpChrome.storage.local;

    // 默认优先使用 sync（跨“Chrome 实例/设备”），如果不可用或超限会自动降级 local（容量更大、同机稳定共享）
    let gnpStorageArea = gnpStorageSync || gnpStorageLocal || null;
    let gnpSharedUpdatedAt = 0;
    let gnpApplyingSharedState = false;

    function gnpBuildSharedState() {
        return {
            v: 1,
            updatedAt: Date.now(),
            favorites: favorites.map(f => ({
                text: f.text,
                folder: f.folder,
                useCount: Number(f.useCount) || 0,
                lastUsed: Number(f.lastUsed) || 0
            })),
            folders: Array.isArray(folders) ? folders.slice() : ['默认'],
            favFolderFilter: String(favFolderFilter || '全部'),
            usageStats: (usageStats && typeof usageStats === 'object' && !Array.isArray(usageStats)) ? usageStats : {}
        };
    }

    function gnpApplySharedState(state) {
        if (!state || typeof state !== 'object') return false;

        const raw = Array.isArray(state.favorites) ? state.favorites : [];
        const nextFav = [];
        const seen = new Set();
        raw.forEach(it => {
            if (!it) return;
            const t = String((it.text ?? it.t) || '').trim();
            if (!t || seen.has(t)) return;
            seen.add(t);
            const folder = String((it.folder ?? it.f) || '默认').trim() || '默认';
            const useCount = parseInt((it.useCount ?? it.uc) || 0, 10) || 0;
            const lastUsed = Number((it.lastUsed ?? it.lu) || 0) || 0;
            nextFav.push({ text: t, folder, useCount, lastUsed });
        });

        let nextFolders = Array.isArray(state.folders) ? state.folders : ['默认'];
        nextFolders = [...new Set(nextFolders.map(f => String(f || '').trim()).filter(Boolean))];
        if (!nextFolders.includes('默认')) nextFolders.unshift('默认');

        // 收藏里出现的新文件夹，自动补齐
        nextFav.forEach(f => { if (!nextFolders.includes(f.folder)) nextFolders.push(f.folder); });

        favorites = nextFav;
        folders = nextFolders;
        favFolderFilter = String(state.favFolderFilter || '全部');
        usageStats = (state.usageStats && typeof state.usageStats === 'object' && !Array.isArray(state.usageStats)) ? state.usageStats : {};

        // 同步回 localStorage（作为各站点的“本地缓存”），保证旧逻辑/兼容性
        try { localStorage.setItem(STORAGE_KEY_FAV, JSON.stringify(gnpBuildSharedState().favorites)); } catch (_) {}
        try { localStorage.setItem(STORAGE_KEY_FOLDERS, JSON.stringify(folders)); } catch (_) {}
        try { localStorage.setItem(STORAGE_KEY_FAV_FOLDER_FILTER, favFolderFilter); } catch (_) {}
        try { localStorage.setItem(STORAGE_KEY_USAGE, JSON.stringify(usageStats)); } catch (_) {}

        return true;
    }

    function gnpPersistSharedState() {
        if (!gnpStorageArea || gnpApplyingSharedState) return;
        const state = gnpBuildSharedState();
        gnpSharedUpdatedAt = state.updatedAt;

        try {
            gnpStorageArea.set({ [GNP_SHARED_STATE_KEY]: state }, () => {
                // 额外写入 local 作为持久化/大容量备份（即便主要使用 sync）
                if (gnpStorageArea === gnpStorageSync && gnpStorageLocal) {
                    try { gnpStorageLocal.set({ [GNP_SHARED_STATE_KEY]: state }); } catch (_) {}
                }
                const err = gnpChrome && gnpChrome.runtime && gnpChrome.runtime.lastError;
                // sync 额度不足时降级到 local，保证“共享”可用
                if (err && gnpStorageArea === gnpStorageSync && gnpStorageLocal) {
                    gnpStorageArea = gnpStorageLocal;
                    try { gnpStorageArea.set({ [GNP_SHARED_STATE_KEY]: state }); } catch (_) {}
                }
            });
        } catch (_) {}
    }

    function gnpBootstrapSharedState() {
        if (!gnpStorageArea) return;

        const getFromArea = (area, cb) => {
            try {
                area.get([GNP_SHARED_STATE_KEY], (res) => cb(res && res[GNP_SHARED_STATE_KEY]));
            } catch (_) { cb(null); }
        };

        // 优先 sync（跨设备/不同 Chrome 实例），其次 local（容量更大）
        if (gnpStorageSync) {
            getFromArea(gnpStorageSync, (stSync) => {
                if (stSync && stSync.favorites) {
                    gnpApplyingSharedState = true;
                    try { gnpApplySharedState(stSync); } finally { gnpApplyingSharedState = false; }
                    gnpSharedUpdatedAt = Number(stSync.updatedAt) || Date.now();
                    // 同步数据也写一份到 local（容量大，且保证重启后可用）
                    if (gnpStorageLocal) { try { gnpStorageLocal.set({ [GNP_SHARED_STATE_KEY]: stSync }); } catch (_) {} }
                } else if (gnpStorageLocal) {
                    getFromArea(gnpStorageLocal, (stLocal) => {
                        if (stLocal && stLocal.favorites) {
                            gnpApplyingSharedState = true;
                            try { gnpApplySharedState(stLocal); } finally { gnpApplyingSharedState = false; }
                            gnpSharedUpdatedAt = Number(stLocal.updatedAt) || Date.now();
                            // 回填 sync（若可用）
                            try { gnpStorageSync.set({ [GNP_SHARED_STATE_KEY]: stLocal }); } catch (_) {}
                        } else {
                            // 没有共享数据：用当前站点 localStorage 里的数据“初始化”共享区
                            gnpPersistSharedState();
                        }
                    });
                } else {
                    gnpPersistSharedState();
                }

                // UI 若已就绪，尽量刷新一次（函数声明可提前调用）
                try { renderFavorites(); } catch (_) {}
                try { refreshNav(true); } catch (_) {}
            });
        } else {
            getFromArea(gnpStorageArea, (st) => {
                if (st && st.favorites) {
                    gnpApplyingSharedState = true;
                    try { gnpApplySharedState(st); } finally { gnpApplyingSharedState = false; }
                    gnpSharedUpdatedAt = Number(st.updatedAt) || Date.now();
                    try { renderFavorites(); } catch (_) {}
                    try { refreshNav(true); } catch (_) {}
                } else {
                    gnpPersistSharedState();
                }
            });
        }
    }

    // 监听其他标签页/窗口（或 sync 同步）对共享收藏的修改，并实时刷新当前面板
    try {
        if (gnpChrome && gnpChrome.storage && gnpChrome.storage.onChanged) {
            gnpChrome.storage.onChanged.addListener((changes, areaName) => {
                if (!changes || !changes[GNP_SHARED_STATE_KEY]) return;
                if (areaName !== 'sync' && areaName !== 'local') return;

                const next = changes[GNP_SHARED_STATE_KEY].newValue;
                if (!next) return;

                const ts = Number(next.updatedAt) || 0;
                if (ts && ts <= gnpSharedUpdatedAt) return;

                gnpSharedUpdatedAt = ts || Date.now();
                gnpApplyingSharedState = true;
                try { gnpApplySharedState(next); } finally { gnpApplyingSharedState = false; }

                try { renderFavorites(); } catch (_) {}
                try { refreshNav(true); } catch (_) {}
            });
        }
    } catch (_) {}

    // 启动：异步拉取共享收藏
    gnpBootstrapSharedState();



    const saveFavorites = () => {
        const payload = favorites.map(f => ({ text: f.text, folder: f.folder, useCount: Number(f.useCount)||0, lastUsed: Number(f.lastUsed)||0 }));
        localStorage.setItem(STORAGE_KEY_FAV, JSON.stringify(payload));
        gnpPersistSharedState();
    };

    const getFavoriteIndex = (t) => favorites.findIndex(f => f.text === t);
    const hasFavorite = (t) => getFavoriteIndex(t) !== -1;

    const formatRelativeTime = (ts) => {
        const t = Number(ts) || 0;
        if (!t) return '未使用';
        const diff = Date.now() - t;
        if (diff < 60_000) return '刚刚';
        if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
        if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
        if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}天前`;
        const d = new Date(t);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    };

    const recordFavoriteUse = (t) => {
    const idx = getFavoriteIndex(t);
    if (idx === -1) return;
    const f = favorites[idx];
    f.useCount = (Number(f.useCount) || 0) + 1;
    f.lastUsed = Date.now();
    saveFavorites();

    // 若当前正在显示收藏面板，则就地更新该条的统计信息，避免整列表重渲染导致闪烁/滚动跳动
    try {
        if (panelFav && panelFav.classList.contains('active')) {
            const esc = (CSS && CSS.escape)
                    ? CSS.escape(String(t))
                    : String(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const row = panelFav.querySelector(`.gemini-nav-item[data-prompt="${esc}"]`);
            const meta = row ? row.querySelector('.gnp-use-meta') : null;
            if (meta) {
                const uc = Number(f.useCount) || 0;
                const luStr = formatRelativeTime(f.lastUsed);
                meta.textContent = `${uc}次 · ${luStr}`;
                meta.title = f.lastUsed ? `最近使用：${new Date(Number(f.lastUsed)).toLocaleString()}` : '从未使用';
            } else if (row) {
                renderFavorites();
            }
        }
    } catch (_) {}
};


    const hashPrompt = (s) => {
        const str = String(s || '');
        let h = 5381;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) + h) ^ str.charCodeAt(i);
        }
        return (h >>> 0).toString(36);
    };

    const saveUsageStats = () => {
        try { localStorage.setItem(STORAGE_KEY_USAGE, JSON.stringify(usageStats)); } catch (_) {}
        gnpPersistSharedState();
    };

    const getPromptLastUsed = (t) => {
        const text = String(t || '').trim();
        if (!text) return 0;
        const fIdx = getFavoriteIndex(text);
        if (fIdx !== -1) return Number(favorites[fIdx].lastUsed) || 0;
        const k = hashPrompt(text);
        return Number(usageStats[k]) || 0;
    };

    const formatRelativeTimeNav = (ts) => {
        const s = formatRelativeTime(ts);
        return (s === '未使用') ? '未用' : s;
    };

    const recordPromptUse = (t) => {
        const text = String(t || '').trim();
        if (!text) return;

        const now = Date.now();

        // 若是收藏项，继续维护“使用次数/最近使用”统计
        try { recordFavoriteUse(text); } catch (_) {}

        // 全量使用记录（用于导航面板展示）
        try {
            const k = hashPrompt(text);
            usageStats[k] = now;

            // 简单裁剪，避免 localStorage 过大
            const keys = Object.keys(usageStats);
            if (keys.length > 2000) {
                const entries = keys.map(k2 => [k2, Number(usageStats[k2]) || 0]).sort((a,b)=>b[1]-a[1]);
                usageStats = Object.fromEntries(entries.slice(0, 2000));
            }
            saveUsageStats();
        } catch (_) {}

        // 就地刷新“目录”面板的使用时间徽标（若存在）
        try {
            if (panelNav && panelNav.classList.contains('active')) {
                const row = panelNav.querySelector(`.gemini-nav-item[data-prompt="${gnpCssEscape(text)}"]`);
                const meta = row ? row.querySelector('.gnp-nav-use-time') : null;
                if (meta) {
                    meta.textContent = formatRelativeTimeNav(now);
                    meta.title = `最近使用：${new Date(now).toLocaleString()}`;
                }
            }
        } catch (_) {}
    };



    const addFavorite = (t, folder = '默认') => {
        const text = String(t || '').trim();
        const f = String(folder || '默认').trim() || '默认';
        if (!text) return false;
        if (hasFavorite(text)) return false;
        if (!folders.includes(f)) { folders.push(f); saveFolders(); }
        favorites.unshift({ text, folder: f, useCount: 0, lastUsed: 0 }); // 新收藏置顶：保持原行为
        return true;
    };

    const removeFavorite = (t) => {
        const idx = getFavoriteIndex(String(t || '').trim());
        if (idx > -1) favorites.splice(idx, 1);
    };

    const ensureFolderExists = (name) => {
        const f = String(name || '').trim();
        if (!f) return '默认';
        if (!folders.includes(f)) { folders.push(f); saveFolders(); }
        return f;
    };

    saveFolders();
    saveFavorites();
    
    let isAutoHideEnabled = JSON.parse(localStorage.getItem(STORAGE_KEY_HIDE)) ?? true;
    let isAutoSendEnabled = JSON.parse(localStorage.getItem(STORAGE_KEY_AUTOSEND)) ?? false;
    
    // --- 多选状态 ---
    let selectedItems = new Set(); 

    let autoHideTimer = null;
    let isSelectInteracting = false;
    let currentActiveIndex = -1;


    // --- 自动隐藏控制：编辑弹层在侧边栏内时，暂停自动隐藏 ---
    function keepSidebarExpanded() {
        if (!isAutoHideEnabled) return;
        clearTimeout(autoHideTimer);
        sidebar.classList.remove('collapsed');
    }

    function hasSidebarEditOverlay() {
        return !!(sidebar && sidebar.querySelector('.gnp-confirm-overlay'));
    }

    function scheduleAutoHide() {
        if (!isAutoHideEnabled) return;
        if (isDragging || activeResizer || isSelectInteracting) return;
        if (hasSidebarEditOverlay()) return;

        const ae = document.activeElement;
        if (ae && ae.classList && ae.classList.contains('gnp-folder-select')) return;

        clearTimeout(autoHideTimer);
        autoHideTimer = setTimeout(() => {
            if (!isAutoHideEnabled) return;
            if (isDragging || activeResizer || isSelectInteracting) return;
            if (hasSidebarEditOverlay()) return;

            const ae2 = document.activeElement;
            if (ae2 && ae2.classList && ae2.classList.contains('gnp-folder-select')) return;

            // 若鼠标已回到侧边栏，则不收起（mouseenter 也会清掉计时器，这里做兜底）
            if (sidebar && sidebar.matches(':hover')) return;

            sidebar.classList.add('collapsed');
            applyMagneticSnapping();
        }, 500);
    }

    function updateHeaderUI() { 
        lockBtn.classList.toggle('active', !isAutoHideEnabled);
        autoSendBtn.classList.toggle('active', isAutoSendEnabled);
    }
    updateHeaderUI();

    lockBtn.onclick = (e) => {
        e.stopPropagation();
        isAutoHideEnabled = !isAutoHideEnabled;
        localStorage.setItem(STORAGE_KEY_HIDE, isAutoHideEnabled);
        updateHeaderUI();
        if (!isAutoHideEnabled) { clearTimeout(autoHideTimer); sidebar.classList.remove('collapsed'); }
    };
    
    topBtn.onclick = (e) => {
        e.stopPropagation();
        contentWrapper.scrollTo({ top: 0, behavior: 'smooth' });
    };

    bottomBtn.onclick = (e) => {
        e.stopPropagation();
        contentWrapper.scrollTo({ top: contentWrapper.scrollHeight, behavior: 'smooth' });
    };
    // --- 网页内容：直达顶部 ---
    chatTopBtn.onclick = (e) => {
        e.stopPropagation();
        const selectors = [
            '.query-text', '.model-response-text',
            'div[data-message-author-role="user"]',
            'div[data-message-author-role="assistant"]'
        ];
        const combinedSelector = selectors.join(',');
        const nodes = document.querySelectorAll(combinedSelector);
        const firstMessage = nodes && nodes.length ? nodes[0] : null;

        if (firstMessage) {
            let parent = firstMessage.parentElement;
            let scrollableContainer = null;
            while (parent && parent !== document.body) {
                const style = window.getComputedStyle(parent);
                if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                    if (!sidebar.contains(parent) && parent !== sidebar) {
                        scrollableContainer = parent;
                        break;
                    }
                }
                parent = parent.parentElement;
            }
            if (scrollableContainer) {
                scrollableContainer.scrollTo({ top: 0, behavior: 'smooth' });
                return;
            }
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    // --- 核心修复：锚点逆向滚动逻辑 ---
    chatBottomBtn.onclick = (e) => {
        e.stopPropagation();
        const selectors = [
            '.query-text', '.model-response-text', 
            'div[data-message-author-role="user"]', 
            'div[data-message-author-role="assistant"]'
        ];
        
        let allMessages = [];
        for (const sel of selectors) {
            allMessages.push(...document.querySelectorAll(sel));
        }
        
        let lastMessage = null;
        if (allMessages.length > 0) {
            const combinedSelector = selectors.join(',');
            const nodes = document.querySelectorAll(combinedSelector);
            if (nodes.length > 0) {
                lastMessage = nodes[nodes.length - 1];
            }
        }

        if (lastMessage) {
            let parent = lastMessage.parentElement;
            let scrollableContainer = null;
            while (parent && parent !== document.body) {
                const style = window.getComputedStyle(parent);
                if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                    if (!sidebar.contains(parent) && parent !== sidebar) {
                        scrollableContainer = parent;
                        break;
                    }
                }
                parent = parent.parentElement;
            }
            if (scrollableContainer) {
                scrollableContainer.scrollTo({ top: scrollableContainer.scrollHeight, behavior: 'smooth' });
                return;
            }
        }
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    };

    autoSendBtn.onclick = (e) => {
        e.stopPropagation();
        isAutoSendEnabled = !isAutoSendEnabled;
        localStorage.setItem(STORAGE_KEY_AUTOSEND, isAutoSendEnabled);
        updateHeaderUI();
        if (panelNav.classList.contains('active')) refreshNav(true);
        if (panelFav.classList.contains('active')) renderFavorites();
    };

    function setNativeValue(element, value) {
        const valueSetter = Object.getOwnPropertyDescriptor(element, 'value').set;
        const prototype = Object.getPrototypeOf(element);
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value').set;

        if (valueSetter && valueSetter !== prototypeValueSetter) {
            prototypeValueSetter.call(element, value);
        } else {
            valueSetter.call(element, value);
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
    }

    
    locateBtn.onclick = (e) => {
        e.stopPropagation();
        // 若当前在收藏页，则切回目录页后再定位
        if (!tabNav.classList.contains('active')) {
            tabNav.click();
            setTimeout(() => scrollToActive(), 180);
        } else {
            scrollToActive();
        }
    };

clearBtn.onclick = (e) => {
        e.stopPropagation();
        const inputEl = qsAny(CURRENT_CONFIG.inputSelector);
        if (inputEl) {
            inputEl.focus();
            setPromptValue(inputEl, '');
            if (inputEl.isContentEditable) { inputEl.textContent = ''; }
            inputEl.dispatchEvent(new Event('input', { bubbles: true })); 
        }
    };

    searchInput.oninput = () => {
        const raw = (searchInput.value || '').trim();
        const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
        const regex = tokens.length ? new RegExp(tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi') : null;

        const activeTab = document.querySelector('.nav-tab.active');
        const activePanelId = activeTab ? activeTab.dataset.target : null;
        const activePanel = activePanelId ? document.getElementById(activePanelId) : null;
        if (!activePanel) return;

        const applyHighlight = (textEl, promptText) => {
            // 记录基础HTML（用于清空搜索时恢复）
            if (!textEl.dataset.gnpBaseHtml) textEl.dataset.gnpBaseHtml = textEl.innerHTML;

            // 记录编号（收藏/导航都兼容）
            if (!textEl.dataset.gnpIndexText) {
                const idxEl = textEl.querySelector('.item-index');
                if (idxEl) {
                    textEl.dataset.gnpIndexText = idxEl.textContent.trim();
                } else {
                    const mt = (textEl.textContent || '').match(/^\s*(\d+)\.\s*/);
                    if (mt) textEl.dataset.gnpIndexText = `${mt[1]}.`;
                }
            }

            // 先恢复基础状态，避免高亮叠加
            textEl.innerHTML = textEl.dataset.gnpBaseHtml;

            if (!regex || !promptText) return;

            // 重新渲染：编号 + 高亮后的正文（使用 textNode，避免HTML注入）
            const indexText = textEl.dataset.gnpIndexText || '';
            while (textEl.firstChild) textEl.removeChild(textEl.firstChild);

            if (indexText) {
                const idxSpan = document.createElement('span');
                idxSpan.className = 'item-index';
                idxSpan.textContent = indexText;
                textEl.appendChild(idxSpan);
                textEl.appendChild(document.createTextNode(' '));
            }

            let last = 0;
            let match;
            regex.lastIndex = 0;
            while ((match = regex.exec(promptText)) !== null) {
                const start = match.index;
                const end = start + match[0].length;
                if (start > last) textEl.appendChild(document.createTextNode(promptText.slice(last, start)));
                const hit = document.createElement('span');
                hit.className = 'gnp-search-highlight';
                hit.textContent = promptText.slice(start, end);
                textEl.appendChild(hit);
                last = end;
                // 防止空匹配死循环
                if (match[0].length === 0) regex.lastIndex++;
            }
            if (last < promptText.length) textEl.appendChild(document.createTextNode(promptText.slice(last)));
        };

        activePanel.querySelectorAll('.gemini-nav-item').forEach(item => {
            const promptText = (item.dataset.prompt || '').toString();
            const lower = promptText.toLowerCase();
            const show = tokens.length === 0 ? true : tokens.every(t => lower.includes(t));

            const textEl = item.querySelector('.item-text');
            if (textEl) {
                // 无论是否显示，都先恢复基础HTML，避免切换搜索时残留高亮
                if (!textEl.dataset.gnpBaseHtml) textEl.dataset.gnpBaseHtml = textEl.innerHTML;
                textEl.innerHTML = textEl.dataset.gnpBaseHtml;

                // 仅对显示项做高亮渲染
                if (show && regex) applyHighlight(textEl, promptText);
            }

            item.style.display = show ? 'block' : 'none';
        });
    };

    function fillInput(text) {
        const inputEl = qsAny(CURRENT_CONFIG.inputSelector);
        if (!inputEl) return;

        inputEl.focus();
        setPromptValue(inputEl, text);
        
        if (isAutoSendEnabled) {
            let checkCount = 0;
            const checkInterval = setInterval(() => {
                const sendBtn = qsAny(CURRENT_CONFIG.sendBtnSelector);
                checkCount++;
                if (sendBtn && !sendBtn.disabled) {
                    clearInterval(checkInterval);
                    sendBtn.click();
                    sidebar.style.boxShadow = "0 0 15px rgba(147, 51, 234, 0.5)";
                    setTimeout(() => sidebar.style.boxShadow = "", 300);
                } else if (checkCount > 15) {
                    clearInterval(checkInterval);
                }
            }, 100);
        }
        // 记录使用（仅当该条已在收藏中）
        recordPromptUse(text);

    }

    // --- 批量操作逻辑 ---
        // 统一的导航窗内确认框（复用现有 gnp-confirm-* 样式）
        function showConfirmInSidebar({ titleText, descText, confirmText, onConfirm }) {
            // 防止叠加多个弹层
            const existed = sidebar.querySelector('.gnp-confirm-overlay');
            if (existed) existed.remove();

            // 打开编辑/确认弹层时：保持侧边栏展开，且暂停自动隐藏
            keepSidebarExpanded();

            const overlay = document.createElement('div');
            overlay.className = 'gnp-confirm-overlay';

            const box = document.createElement('div');
            box.className = 'gnp-confirm-box';

            const title = document.createElement('div');
            title.className = 'gnp-confirm-title';
            title.textContent = titleText || '确认操作？';

            const desc = document.createElement('div');
            desc.className = 'gnp-confirm-desc';
            desc.textContent = descText || '';

            const btnRow = document.createElement('div');
            btnRow.className = 'gnp-btn-row';

            const btnCancel = document.createElement('button');
            btnCancel.className = 'gnp-btn-cancel';
            btnCancel.textContent = '取消';
            const closeOverlay = () => {
                overlay.remove();
                // 编辑结束后：若鼠标已离开侧边栏，则恢复自动隐藏逻辑
                if (isAutoHideEnabled && sidebar && !sidebar.matches(':hover')) scheduleAutoHide();
            };

            btnCancel.onclick = closeOverlay;

            const btnConfirm = document.createElement('button');
            btnConfirm.className = 'gnp-btn-confirm';
            btnConfirm.textContent = confirmText || '确认';
            btnConfirm.onclick = () => {
                // 锁定当前高度，避免弹层移除时布局抖动（与“清空全部”一致）
                const currentHeight = sidebar.offsetHeight;
                sidebar.style.height = `${currentHeight}px`;

                try { onConfirm && onConfirm(); }
                finally { closeOverlay(); }
            };

            btnRow.append(btnCancel, btnConfirm);
            box.append(title, desc, btnRow);
            overlay.append(box);

            // 挂载在导航窗口内
            sidebar.appendChild(overlay);
        }

function showPromptInSidebar({ titleText, placeholder, defaultValue, confirmText, onConfirm }) {
            // 复用确认框遮罩，避免与其他弹层叠加
            const existed = sidebar.querySelector('.gnp-confirm-overlay');
            if (existed) existed.remove();

            // 打开输入弹层时：保持侧边栏展开，且暂停自动隐藏
            keepSidebarExpanded();

            const overlay = document.createElement('div');
            overlay.className = 'gnp-confirm-overlay';

            const closeOverlay = () => {
                overlay.remove();
                // 编辑结束后：若鼠标已离开侧边栏，则恢复自动隐藏逻辑
                if (isAutoHideEnabled && sidebar && !sidebar.matches(':hover')) scheduleAutoHide();
            };

            const box = document.createElement('div');
            box.className = 'gnp-confirm-box';

            const title = document.createElement('div');
            title.className = 'gnp-confirm-title';
            title.textContent = titleText || '请输入：';

            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = placeholder || '';
            input.value = defaultValue || '';
            input.className = 'gnp-prompt-input';
            input.style.cssText = 'width:100%;box-sizing:border-box;margin-top:10px;padding:10px 12px;border-radius:10px;border:1px solid var(--gnp-border);outline:none;font-size:14px;background:var(--gnp-input-bg);color:var(--gnp-input-text);caret-color:var(--gnp-input-text);';

            const err = document.createElement('div');
            err.className = 'gnp-prompt-error';
            err.style.cssText = 'margin-top:8px;color:#d33;font-size:12px;display:none;';
            err.textContent = '请输入有效内容';

            const btnRow = document.createElement('div');
            btnRow.className = 'gnp-btn-row';

            const btnCancel = document.createElement('button');
            btnCancel.className = 'gnp-btn-cancel';
            btnCancel.textContent = '取消';
            btnCancel.onclick = closeOverlay;

            const btnConfirm = document.createElement('button');
            btnConfirm.className = 'gnp-btn-confirm';
            btnConfirm.textContent = confirmText || '确认';
            const doConfirm = () => {
                const val = (input.value || '').trim();
                if (!val) {
                    err.style.display = 'block';
                    input.focus();
                    return;
                }
                const currentHeight = sidebar.offsetHeight;
                sidebar.style.height = `${currentHeight}px`;
                try { onConfirm && onConfirm(val); }
                finally { closeOverlay(); }
            };
            btnConfirm.onclick = doConfirm;

            // 键盘交互：Enter 确认，Esc 取消
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); doConfirm(); }
                else if (ev.key === 'Escape') { ev.preventDefault(); closeOverlay(); }
            });

            // 防止事件冒泡到侧边栏拖拽/多选逻辑（使用冒泡阶段，避免拦截按钮/输入自身事件）
            overlay.addEventListener('mousedown', (ev) => { ev.stopPropagation(); });
            overlay.addEventListener('click', (ev) => {
                ev.stopPropagation();
                // 点击遮罩空白处关闭
                if (ev.target === overlay) closeOverlay();
            });

            btnRow.append(btnCancel, btnConfirm);
            box.append(title, input, err, btnRow);
            overlay.append(box);
            sidebar.appendChild(overlay);

            // 自动聚焦
            setTimeout(() => { try { input.focus(); input.select(); } catch (e) {} }, 0);
}



function showEditModalCenter({ titleText, placeholder, defaultValue, confirmText, onConfirm }) {
            // 移除已有全屏弹窗，避免叠加
            const existed = document.querySelector('.gnp-global-overlay');
            if (existed) existed.remove();

            const overlay = document.createElement('div');
            overlay.className = 'gnp-global-overlay';

            const box = document.createElement('div');
            box.className = 'gnp-global-box';

            const title = document.createElement('div');
            title.className = 'gnp-global-title';
            title.textContent = titleText || '编辑内容';

            const textarea = document.createElement('textarea');
            textarea.className = 'gnp-global-textarea';
            textarea.placeholder = placeholder || '';
            textarea.value = defaultValue || '';
            textarea.rows = 5;

            const err = document.createElement('div');
            err.className = 'gnp-global-error';
            err.textContent = '请输入有效内容';

            const btnRow = document.createElement('div');
            btnRow.className = 'gnp-global-btnrow';

            const btnCancel = document.createElement('button');
            btnCancel.className = 'gnp-btn-cancel';
            btnCancel.textContent = '取消';

            const btnConfirm = document.createElement('button');
            btnConfirm.className = 'gnp-btn-confirm';
            btnConfirm.textContent = confirmText || '保存';
            // 编辑属于安全操作：改为蓝色确认按钮（不影响其它确认框的危险红色）
            btnConfirm.style.background = '#0b57d0';
            btnConfirm.onmouseenter = () => { btnConfirm.style.background = '#0947a7'; };
            btnConfirm.onmouseleave = () => { btnConfirm.style.background = '#0b57d0'; };

            const close = () => overlay.remove();

            const doConfirm = () => {
                const val = (textarea.value || '').trim();
                if (!val) {
                    err.style.display = 'block';
                    textarea.focus();
                    return;
                }
                try { onConfirm && onConfirm(val); }
                finally { close(); }
            };

            btnCancel.onclick = close;
            btnConfirm.onclick = doConfirm;

            // 键盘：Esc 取消；Cmd/Ctrl+Enter 保存
            textarea.addEventListener('keydown', (ev) => {
                if (ev.key === 'Escape') { ev.preventDefault(); close(); }
                else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); doConfirm(); }
            });

            // 点击遮罩空白处关闭
            overlay.addEventListener('click', (ev) => {
                if (ev.target === overlay) close();
            });

            btnRow.append(btnCancel, btnConfirm);
            box.append(title, textarea, err, btnRow);
            overlay.append(box);
            document.body.appendChild(overlay);

            setTimeout(() => { try { textarea.focus(); textarea.setSelectionRange(0, textarea.value.length); } catch (e) {} }, 0);
}


    // 轻量提示：显示在侧边栏（导航窗口）内部
    function showSidebarToast(message, duration = 1200) {
        if (!sidebar) return;
        const existed = sidebar.querySelector('.gnp-toast');
        if (existed) existed.remove();

        const toast = document.createElement('div');
        toast.className = 'gnp-toast';
        toast.textContent = message || '';
        sidebar.appendChild(toast);

        setTimeout(() => { toast.remove(); }, duration);
    }


    function updateBatchBar() {
        batchBar.replaceChildren();
        // 多选模式（选中>=2条）时隐藏每条Prompt右下角工具图标，避免误触
        sidebar.classList.toggle('gnp-multi-mode', selectedItems.size >= 2);
        if (selectedItems.size === 0) {
            batchBar.classList.remove('visible');
            return;
        }
        
        batchBar.classList.add('visible');
        const countSpan = document.createElement('span');
        countSpan.textContent = `已选 ${selectedItems.size} 项`;
        
        const isFavTab = panelFav.classList.contains('active');
        
        const actionBtn = document.createElement('span');
        actionBtn.className = `batch-btn ${isFavTab ? 'action-delete' : 'action-save'}`;
        actionBtn.textContent = isFavTab ? '删除' : '收藏';
        
        actionBtn.onclick = (e) => {
            e.stopPropagation();
            const items = Array.from(selectedItems);
            
            if (isFavTab) {
                // 批量删除（使用导航窗口内确认框，避免浏览器原生 confirm 弹窗）
                showConfirmInSidebar({
                    titleText: `确定删除选中的 ${items.length} 个收藏吗？`,
                    descText: '此操作无法撤销。',
                    confirmText: '确认删除',
                    onConfirm: () => {
                        favorites = favorites.filter(f => !selectedItems.has(f.text));
                        saveFavorites();
                        selectedItems.clear();
                        renderFavorites();
                        updateBatchBar();
                    }
                });
            } else {
                // 批量收藏
                let addedCount = 0;
                const targetFolder = (favFolderFilter && favFolderFilter !== '全部') ? favFolderFilter : '默认';
                items.forEach(txt => {
                    if (addFavorite(txt, targetFolder)) {
                        addedCount++;
                    }
                });
                // 先清除多选状态（避免 refreshNav 期间把旧选择渲染回去）
                selectedItems.clear();
                panelNav.querySelectorAll('.gemini-nav-item.multi-selected')
                    .forEach(el => el.classList.remove('multi-selected'));

                if (addedCount > 0) {
                    saveFavorites();
                    // 刷新目录页状态（更新“已收藏”标记）
                    refreshNav(true);
                }

                updateBatchBar();
                // 收藏成功提示（显示在导航窗口内，避免批量栏消失后无反馈）
                showSidebarToast(addedCount > 0 ? `收藏成功（新增 ${addedCount} 项）` : '收藏成功');
            }
        };
        
        const cancelBtn = document.createElement('span');
        cancelBtn.className = 'batch-btn action-cancel';
        cancelBtn.textContent = '取消';
        cancelBtn.onclick = (e) => {
            e.stopPropagation();
            selectedItems.clear();
            const activePanel = isFavTab ? panelFav : panelNav;
            activePanel.querySelectorAll('.gemini-nav-item.multi-selected').forEach(el => el.classList.remove('multi-selected'));
            updateBatchBar();
        };
        
        batchBar.append(countSpan, actionBtn, cancelBtn);
    }

    // Command/Ctrl + A：在侧边栏的导航/收藏面板中全选 prompt
    function selectAllPromptsInPanel(panelEl) {
        if (!panelEl) return;
        const items = Array.from(panelEl.querySelectorAll('.gemini-nav-item'));
        if (items.length === 0) return;

        selectedItems.clear();
        items.forEach(el => {
            const prompt = el.dataset.prompt || '';
            if (!prompt) return;
            selectedItems.add(prompt);
            el.classList.add('multi-selected');
        });
        updateBatchBar();
    }

    function clearMultiSelection() {
        if (selectedItems.size === 0) return;
        selectedItems.clear();
        if (sidebar) {
            sidebar.querySelectorAll('.gemini-nav-item.multi-selected').forEach(el => el.classList.remove('multi-selected'));
        }
        updateBatchBar();
    }

    document.addEventListener('keydown', (e) => {
        const key = (e.key || '').toLowerCase();

        // Esc：取消多选
        if (key === 'escape') {
            if (!sidebar || sidebar.classList.contains('collapsed')) return;
            if (selectedItems.size === 0) return;
            const t = e.target;
            // 不干扰弹层/输入区域的 Esc
            if (t && t.closest && t.closest('.gnp-confirm-overlay, .gnp-global-overlay')) return;
            const tag = t && t.tagName ? t.tagName.toLowerCase() : '';
            if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;
            clearMultiSelection();
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        if (!(key === 'a' && (e.metaKey || e.ctrlKey))) return;

        // 不干扰输入框/可编辑区域的 Command+A
        const t = e.target;
        const tag = t && t.tagName ? t.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;

        // 仅在侧边栏处于展开状态且用户正在操作侧边栏时生效
        if (!sidebar || sidebar.classList.contains('collapsed')) return;
        if (!(selectedItems.size > 0 || sidebar.contains(document.activeElement) || sidebar.matches(':hover'))) return;

        const activePanel = panelFav.classList.contains('active') ? panelFav : panelNav;
        selectAllPromptsInPanel(activePanel);

        e.preventDefault();
        e.stopPropagation();
    }, true);

    // 取消多选：点击其他区域（含侧边栏空白处/页面任意位置）
    document.addEventListener('mousedown', (e) => {
        if (!sidebar || sidebar.classList.contains('collapsed')) return;
        if (selectedItems.size === 0) return;

        const t = e.target;
        if (!t) return;

        // 与下拉选择等控件交互时不取消（避免下拉菜单无法选择/自动消失）
        const ae = document.activeElement;
        if ((ae && ae.classList && ae.classList.contains('gnp-folder-select')) ||
            t.tagName === 'SELECT' || t.tagName === 'OPTION' ||
            (t.closest && t.closest('.gnp-folder-select'))) {
            return;
        }
        // 收藏头部区域交互（下拉/按钮等）不取消
        if (t.closest && t.closest('#gemini-fav-header')) return;
        // 点击 prompt 条目本身，交给条目 click 逻辑处理
        if (t.closest && t.closest('.gemini-nav-item')) return;
        // 点击批量操作条，避免误取消
        if (t.closest && t.closest('#gemini-batch-bar')) return;
        // 弹层内点击不取消
        if (t.closest && t.closest('.gnp-confirm-overlay, .gnp-global-overlay')) return;

        clearMultiSelection();
    }, true);


    // Tab 切换清除选择
    [tabNav, tabFav].forEach(tab => {
        tab.onclick = (e) => {
            e.stopPropagation();
            searchInput.value = '';
            [tabNav, tabFav].forEach(t => t.classList.remove('active')); tab.classList.add('active');
            [panelNav, panelFav].forEach(p => p.classList.remove('active'));
            document.getElementById(tab.dataset.target).classList.add('active');
            
            // 清除多选状态
            selectedItems.clear();
            updateBatchBar();
            
            if (tab.dataset.target === 'panel-fav') {
                renderFavorites();
            } else {
                refreshNav(true);
            }
        };
    });

    let dragSrcEl = null;

    function renderFavorites() {
        if (!panelFav.classList.contains('active')) return;
        panelFav.replaceChildren();

        const totalCount = favorites.length;

        // 过滤：文件夹
        const effectiveFilter = (folders.includes(favFolderFilter) || favFolderFilter === '全部') ? favFolderFilter : '全部';
        if (effectiveFilter !== favFolderFilter) {
            favFolderFilter = effectiveFilter;
            localStorage.setItem(STORAGE_KEY_FAV_FOLDER_FILTER, favFolderFilter);
            gnpPersistSharedState();
        }

        const filteredFavorites = (favFolderFilter === '全部')
            ? favorites
            : favorites.filter(f => f.folder === favFolderFilter);

        // Header（计数 + 文件夹筛选/管理 + 清空）
        const favHeader = document.createElement('div');
        favHeader.id = 'gemini-fav-header';

        const leftBox = document.createElement('div');
        leftBox.id = 'gemini-fav-left';

        const favCount = document.createElement('span');
        favCount.style.cssText = 'font-size:12px;color:var(--gnp-text-sub);font-weight:500;white-space:nowrap;';
        favCount.textContent = `${filteredFavorites.length}/${totalCount}`;

        const folderSelect = document.createElement('select');
        folderSelect.className = 'gnp-folder-select';
        folderSelect.title = '按文件夹筛选';
        folderSelect.style.cssText = 'font-size:12px;background:rgba(0,0,0,0.04);border:1px solid var(--gnp-border);border-radius:10px;padding:3px 8px;color:var(--gnp-text-main);max-width:140px;';

        // 下拉选择时暂停自动隐藏（原生下拉浮层会触发 sidebar mouseleave，导致菜单自动消失）
        folderSelect.addEventListener('focus', () => { 
            isSelectInteracting = true; 
            if (isAutoHideEnabled) { clearTimeout(autoHideTimer); sidebar.classList.remove('collapsed'); }
        });
        folderSelect.addEventListener('blur', () => { isSelectInteracting = false; });
        folderSelect.addEventListener('mousedown', () => { 
            isSelectInteracting = true; 
            if (isAutoHideEnabled) { clearTimeout(autoHideTimer); sidebar.classList.remove('collapsed'); }
        });

        // 防止侧边栏拖拽/多选取消逻辑干扰下拉框交互（不阻止默认行为）
        folderSelect.addEventListener('mousedown', (e) => e.stopPropagation());
        folderSelect.addEventListener('click', (e) => e.stopPropagation());
        // 捕获阶段也阻止冒泡，避免被全局多选取消逻辑抢走事件
        folderSelect.addEventListener('mousedown', (e) => { e.stopPropagation(); }, true);
        folderSelect.addEventListener('click', (e) => { e.stopPropagation(); }, true);

        const optAll = document.createElement('option');
        optAll.value = '全部';
        optAll.textContent = '全部';
        folderSelect.append(optAll);

        folders.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f;
            opt.textContent = f;
            folderSelect.append(opt);
        });

        folderSelect.value = favFolderFilter;
        folderSelect.onchange = () => {
            isSelectInteracting = false;
            favFolderFilter = folderSelect.value;
            localStorage.setItem(STORAGE_KEY_FAV_FOLDER_FILTER, favFolderFilter);
            gnpPersistSharedState();
            selectedItems.clear();
            updateBatchBar();
            renderFavorites();
        };

        leftBox.append(favCount, folderSelect);

        const rightBox = document.createElement('div');
        rightBox.id = 'gemini-fav-right';

                const newFolderBtn = document.createElement('div');
        newFolderBtn.className = 'header-circle-btn';
        newFolderBtn.title = '新建文件夹';
        newFolderBtn.innerHTML = SVGS.folderPlus;
        newFolderBtn.onclick = (e) => {
            e.stopPropagation();
            showPromptInSidebar({
                titleText: '新建文件夹',
                placeholder: '请输入文件夹名称',
                defaultValue: '',
                confirmText: '创建',
                onConfirm: (name) => {
                    const f = ensureFolderExists(name);
                    favFolderFilter = f;
                    localStorage.setItem(STORAGE_KEY_FAV_FOLDER_FILTER, favFolderFilter);
                    gnpPersistSharedState();
                    renderFavorites();
                }
            });
        };

        const renameFolderBtn = document.createElement('div');
        renameFolderBtn.className = 'header-circle-btn';
        renameFolderBtn.title = '重命名文件夹';
        renameFolderBtn.innerHTML = SVGS.edit;
        renameFolderBtn.onclick = (e) => {
            e.stopPropagation();
            if (favFolderFilter === '全部' || favFolderFilter === '默认') {
                showSidebarToast('仅可重命名自定义文件夹');
                return;
            }
            const oldName = favFolderFilter;
            showPromptInSidebar({
                titleText: '重命名文件夹',
                placeholder: '请输入新文件夹名称',
                defaultValue: oldName,
                confirmText: '重命名',
                onConfirm: (name) => {
                    const trimmed = String(name || '').trim();
                    if (!trimmed) return;
                    const finalName = ensureFolderExists(trimmed);

                    // 更新 folders 列表（去掉旧名）
                    folders = folders.filter(f => f !== oldName);
                    if (!folders.includes(finalName)) folders.push(finalName);
                    saveFolders();

                    // 更新收藏的 folder 字段
                    favorites.forEach(f => {
                        if (f.folder === oldName) f.folder = finalName;
                    });
                    saveFavorites();

                    favFolderFilter = finalName;
                    localStorage.setItem(STORAGE_KEY_FAV_FOLDER_FILTER, favFolderFilter);
                    gnpPersistSharedState();
                    renderFavorites();
                }
            });
        };

        const deleteFolderBtn = document.createElement('div');
        deleteFolderBtn.className = 'header-circle-btn gnp-danger-btn';
        deleteFolderBtn.title = '删除文件夹';
        deleteFolderBtn.innerHTML = SVGS.folderX;
        deleteFolderBtn.onclick = (e) => {
            e.stopPropagation();
            if (favFolderFilter === '全部' || favFolderFilter === '默认') {
                showSidebarToast('默认/全部不可删除');
                return;
            }
            const folderToDelete = favFolderFilter;
            showConfirmInSidebar({
                titleText: `删除文件夹「${folderToDelete}」？`,
                descText: '该文件夹内收藏将移动到「默认」。',
                confirmText: '确认删除',
                onConfirm: () => {
                    favorites.forEach(f => {
                        if (f.folder === folderToDelete) f.folder = '默认';
                    });
                    folders = folders.filter(f => f !== folderToDelete);
                    if (!folders.includes('默认')) folders.unshift('默认');
                    saveFolders();
                    saveFavorites();
                    favFolderFilter = '全部';
                    localStorage.setItem(STORAGE_KEY_FAV_FOLDER_FILTER, favFolderFilter);
                    gnpPersistSharedState();
                    selectedItems.clear();
                    updateBatchBar();
                    renderFavorites();
                }
            });
        };

        const clearAllBtn = document.createElement('div');
        clearAllBtn.className = 'header-circle-btn gnp-danger-btn clear-all-btn';
        clearAllBtn.title = '清空全部';
        clearAllBtn.innerHTML = SVGS.clear;
        clearAllBtn.onclick = (e) => {
            e.stopPropagation();
            const overlay = document.createElement('div');
            overlay.className = 'gnp-confirm-overlay';
            const box = document.createElement('div');
            box.className = 'gnp-confirm-box';
            const title = document.createElement('div');
            title.className = 'gnp-confirm-title';
            title.textContent = '确定清空所有收藏？';
            const desc = document.createElement('div');
            desc.className = 'gnp-confirm-desc';
            desc.textContent = '此操作无法撤销。';
            const btnRow = document.createElement('div');
            btnRow.className = 'gnp-btn-row';
            const btnConfirm = document.createElement('button');
            btnConfirm.className = 'gnp-btn-confirm';
            btnConfirm.textContent = '确认清空';
            btnConfirm.onclick = () => {
                const currentHeight = sidebar.offsetHeight;
                sidebar.style.height = `${currentHeight}px`;
                favorites = [];
                saveFavorites();
                selectedItems.clear();
                updateBatchBar();
                renderFavorites();
                overlay.remove();
            };
            const btnCancel = document.createElement('button');
            btnCancel.className = 'gnp-btn-cancel';
            btnCancel.textContent = '取消';
            btnCancel.onclick = () => overlay.remove();
            btnRow.append(btnCancel, btnConfirm);
            box.append(title, desc, btnRow);
            overlay.append(box);
            sidebar.appendChild(overlay);
        };

        rightBox.append(newFolderBtn, renameFolderBtn, deleteFolderBtn, clearAllBtn);
        favHeader.append(leftBox, rightBox);
        panelFav.append(favHeader);

        if (totalCount === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:var(--gnp-text-sub);text-align:center;margin-top:20px;font-size:12px;';
            empty.textContent = '暂无收藏 Prompt';
            panelFav.append(empty);
            return;
        }
        if (filteredFavorites.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:var(--gnp-text-sub);text-align:center;margin-top:20px;font-size:12px;';
            empty.textContent = '该文件夹暂无收藏';
            panelFav.append(empty);
            return;
        }

        filteredFavorites.forEach((favObj, idx) => {
            const favText = favObj.text;
            const itemIndex = favorites.indexOf(favObj);

            const item = document.createElement('div');
            item.className = 'gemini-nav-item';
            if (selectedItems.has(favText)) item.classList.add('multi-selected');
            item.dataset.prompt = favText;
            item.dataset.gnpSource = 'fav';
            bindHoverPreviewToItem(item);
            item.draggable = true;

            // --- 多选逻辑注入 ---
            item.onclick = (e) => {
                if (e.metaKey || e.ctrlKey) {
                    e.stopPropagation();
                    e.preventDefault();
                    if (selectedItems.has(favText)) {
                        selectedItems.delete(favText);
                        item.classList.remove('multi-selected');
                    } else {
                        selectedItems.add(favText);
                        item.classList.add('multi-selected');
                    }
                    updateBatchBar();
                    return;
                }
                e.stopPropagation();
                if (selectedItems.size > 0) { clearMultiSelection(); }
                fillInput(favText);
            };

            item.ondragstart = (e) => {
                e.dataTransfer.setData('text/plain', itemIndex.toString());
                item.classList.add('dragging');
            };
            item.ondragend = () => item.classList.remove('dragging');
            item.ondragover = (e) => { e.preventDefault(); item.classList.add('drag-over'); };
            item.ondragleave = () => item.classList.remove('drag-over');
            item.ondrop = (e) => {
                e.preventDefault();
                item.classList.remove('drag-over');
                const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
                const toIndex = itemIndex;
                if (isNaN(fromIndex) || fromIndex === toIndex) return;
                const [moved] = favorites.splice(fromIndex, 1);
                favorites.splice(toIndex, 0, moved);
                saveFavorites();
                renderFavorites();
            };

            const txt = document.createElement('div');
            txt.className = 'item-text';
            const idxSpan = document.createElement('span');
            idxSpan.className = 'item-index';
            idxSpan.textContent = `${idx + 1}.`;
            txt.appendChild(idxSpan);
            txt.appendChild(document.createTextNode(' ' + favText));

            const folderBadge = document.createElement('span');
            folderBadge.className = 'gnp-folder-badge';
            folderBadge.textContent = favObj.folder || '默认';
            folderBadge.title = '点击移动到其他文件夹';
            folderBadge.onclick = (e) => {
                e.stopPropagation();
                const newFolder = prompt('移动到文件夹：', favObj.folder || '默认');
                if (newFolder === null) return;
                const f = ensureFolderExists(newFolder);
                favObj.folder = f;
                saveFavorites();
                            };

            const useMeta = document.createElement('span');
            useMeta.className = 'gnp-use-meta';
            const uc = Number(favObj.useCount) || 0;
            const luStr = formatRelativeTime(favObj.lastUsed);
            useMeta.textContent = `${uc}次 · ${luStr}`;
            useMeta.title = favObj.lastUsed ? `最近使用：${new Date(Number(favObj.lastUsed)).toLocaleString()}` : '从未使用';
            useMeta.addEventListener('mousedown', (e) => e.stopPropagation());
            useMeta.addEventListener('click', (e) => e.stopPropagation());

            const toolbar = document.createElement('div');
            toolbar.className = 'bottom-toolbar';
            toolbar.addEventListener('mousedown', (e) => e.stopPropagation());

            const useBtn = document.createElement('span');
            useBtn.className = `mini-btn use-btn ${isAutoSendEnabled ? 'autosend-mode' : ''}`;
            useBtn.textContent = '⚡';
            useBtn.title = isAutoSendEnabled ? '自动发送' : '填入';
            useBtn.onclick = (e) => { e.stopPropagation(); fillInput(favText); };

            const copyBtn = document.createElement('span');
            copyBtn.className = 'mini-btn';
            copyBtn.innerHTML = SVGS.copy;
            copyBtn.title = '复制';
            copyBtn.onclick = (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(favText);
                recordPromptUse(favText);
                copyBtn.innerHTML = SVGS.check;
                setTimeout(() => copyBtn.innerHTML = SVGS.copy, 1000);
            };

            const editBtn = document.createElement('span');
            editBtn.className = 'mini-btn';
            editBtn.innerHTML = SVGS.edit;
            editBtn.title = '编辑';
            editBtn.onclick = (e) => {
                e.stopPropagation();
                showEditModalCenter({
                    titleText: '编辑 Prompt',
                    placeholder: '请输入新的 Prompt 内容',
                    defaultValue: favText,
                    confirmText: '保存',
                    onConfirm: (val) => {
                        const trimmedNew = String(val).trim();
                        const dupIdx = getFavoriteIndex(trimmedNew);
                        if (dupIdx === -1 || trimmedNew === favText) {
                            // 更新选中集
                            if (selectedItems.has(favText)) {
                                selectedItems.delete(favText);
                                selectedItems.add(trimmedNew);
                            }
                            favObj.text = trimmedNew;
                            saveFavorites();
                            renderFavorites();
                        } else {
                            // 已存在：合并（删除当前条）
                            favorites.splice(itemIndex, 1);
                            if (selectedItems.has(favText)) selectedItems.delete(favText);
                            saveFavorites();
                            renderFavorites();
                            showSidebarToast("已存在相同收藏内容，已合并。");
                        }
                    }
                });
            };

            const pinBtn = document.createElement('span');
            pinBtn.className = 'mini-btn';
            pinBtn.innerHTML = SVGS.pin;
            pinBtn.title = '置顶';
            pinBtn.onclick = (e) => {
                e.stopPropagation();
                if (itemIndex > 0) {
                    favorites.splice(itemIndex, 1);
                    favorites.unshift(favObj);
                    saveFavorites();
                    renderFavorites();
                }
            };

            const delBtn = document.createElement('span');
            delBtn.className = 'mini-btn del-btn';
            delBtn.innerHTML = SVGS.clear;
            delBtn.title = '删除';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                favorites.splice(itemIndex, 1);
                if (selectedItems.has(favText)) selectedItems.delete(favText);
                saveFavorites();
                renderFavorites();
            };

            toolbar.append(useBtn, copyBtn, editBtn, pinBtn, delBtn);
            item.append(folderBadge, useMeta, txt, toolbar);
            panelFav.append(item);
        });

        if (searchInput.value) searchInput.dispatchEvent(new Event('input'));
    }

    let lastCount = -1;
    let observer = null;

    function setupScrollObserver() {
        if (observer) observer.disconnect();
        observer = new IntersectionObserver((entries) => {
            const visibleEntry = entries.find(entry => entry.isIntersecting);
            if (visibleEntry) {
                const allBlocks = Array.from(qsaAll(CURRENT_CONFIG.promptSelector, getChatRoot()));
                const index = allBlocks.indexOf(visibleEntry.target);
                if (index !== -1 && index !== currentActiveIndex) {
                    currentActiveIndex = index;
                    highlightActiveItem();
                    updateProgressBar(index, allBlocks.length);
                }
            }
        }, { root: null, threshold: 0.1, rootMargin: "-10% 0px -50% 0px" });
        qsaAll(CURRENT_CONFIG.promptSelector, getChatRoot()).forEach(block => observer.observe(block));
    }

    function updateProgressBar(current, total) {
        if (total <= 1) {
            progressBar.style.width = '0%';
        } else {
            const percentage = (current / (total - 1)) * 100;
            progressBar.style.width = `${percentage}%`;
        }
    }

    function highlightActiveItem() {
        document.querySelectorAll('.gemini-nav-item').forEach(el => el.classList.remove('active-current'));
        if (currentActiveIndex === -1) return;
        const activeNav = document.querySelector(`.gemini-nav-item[data-original-index="${currentActiveIndex}"]`);
        if (activeNav) activeNav.classList.add('active-current');
    }
    
    function scrollToActive() {
        setTimeout(() => {
            const activeNav = document.querySelector('.gemini-nav-item.active-current');
            if (activeNav) {
                activeNav.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 100);
    }

    function refreshNav(force = false) {
        if (!panelNav.classList.contains('active')) return;
        const blocks = qsaAll(CURRENT_CONFIG.promptSelector, getChatRoot());
        
        if (!observer) setupScrollObserver();
        if (blocks.length === 0 && lastCount > 0) return;
        if (!force && blocks.length === lastCount) return;
        lastCount = blocks.length;
        setupScrollObserver();

        panelNav.replaceChildren();

        let densityClass = 'density-compact';
        if (blocks.length <= 5) {
            densityClass = 'density-spacious'; 
        } else if (blocks.length <= 15) {
            densityClass = 'density-medium'; 
        }

        const listData = Array.from(blocks).map((block, index) => ({
            block: block,
            originalIndex: index
        })).reverse();

        listData.forEach(({ block, originalIndex }, i) => {
            const content = block.innerText.replace(/\n+/g, ' ').trim();
            if (!content) return;

            const isFav = hasFavorite(content);

            const item = document.createElement('div');
            item.className = 'gemini-nav-item';
            if (selectedItems.has(content)) item.classList.add('multi-selected');
            item.dataset.prompt = content;
            item.dataset.gnpSource = 'nav';
            bindHoverPreviewToItem(item);
            item.dataset.originalIndex = originalIndex; 
            
            if (originalIndex === currentActiveIndex) item.classList.add('active-current');
            if (isFav) item.classList.add('is-favorite');

            const lastUsed = getPromptLastUsed(content);

            const txt = document.createElement('div');
            txt.className = `item-text ${densityClass}`;
            txt.innerHTML = `<span class="item-index">${i + 1}.</span> ${content}`;

            // --- 多选逻辑 ---
            item.onclick = (e) => {
                if (e.metaKey || e.ctrlKey) {
                    e.stopPropagation();
                    e.preventDefault();
                    if (selectedItems.has(content)) {
                        selectedItems.delete(content);
                        item.classList.remove('multi-selected');
                    } else {
                        selectedItems.add(content);
                        item.classList.add('multi-selected');
                    }
                    updateBatchBar();
                    return;
                }
                if (selectedItems.size > 0) { clearMultiSelection(); }
                // 原有点击逻辑
                const currentBlocks = qsaAll(CURRENT_CONFIG.promptSelector, getChatRoot());
                const targetBlock = currentBlocks[originalIndex];
                if (targetBlock) {
                    targetBlock.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    currentActiveIndex = originalIndex;
                    highlightActiveItem();
                    const originalTransition = targetBlock.style.transition;
                    targetBlock.style.transition = 'background 0.5s';
                    targetBlock.style.background = 'rgba(26, 115, 232, 0.15)';
                    setTimeout(() => {
                        targetBlock.style.background = '';
                        targetBlock.style.transition = originalTransition;
                    }, 800);
                }
            };

            const toolbar = document.createElement('div');
            toolbar.className = 'bottom-toolbar';
            toolbar.addEventListener('mousedown', (e) => e.stopPropagation()); 

            const useTime = document.createElement('span');
            useTime.className = 'gnp-nav-use-time';
            useTime.textContent = formatRelativeTimeNav(lastUsed);
            useTime.title = lastUsed ? `最近使用：${new Date(Number(lastUsed)).toLocaleString()}` : '从未使用';
            useTime.addEventListener('mousedown', (e) => e.stopPropagation());
            useTime.addEventListener('click', (e) => e.stopPropagation());

            const useBtn = document.createElement('span');
            useBtn.className = `mini-btn use-btn ${isAutoSendEnabled ? 'autosend-mode' : ''}`;
            useBtn.textContent = '⚡';
            useBtn.title = isAutoSendEnabled ? '自动发送' : '填入';
            useBtn.onclick = (e) => { e.stopPropagation(); fillInput(content); };

            const copyBtn = document.createElement('span');
            copyBtn.className = 'mini-btn';
            copyBtn.innerHTML = SVGS.copy;
            copyBtn.title = '复制';
            copyBtn.onclick = (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(content);
                recordPromptUse(content);
                copyBtn.innerHTML = SVGS.check;
                setTimeout(() => copyBtn.innerHTML = SVGS.copy, 1000);
            };

            const starBtn = document.createElement('span');
            starBtn.className = `mini-btn star-btn ${isFav ? 'is-fav' : ''}`;
            starBtn.textContent = isFav ? '★' : '☆';
            starBtn.title = isFav ? '取消收藏' : '收藏';
            
            starBtn.onclick = (e) => {
                e.stopPropagation();
                if (!hasFavorite(content)) {
                    const targetFolder = (favFolderFilter && favFolderFilter !== '全部') ? favFolderFilter : '默认';
                    addFavorite(content, targetFolder);
                    saveFavorites();
                    starBtn.textContent = '★';
                    starBtn.classList.add('is-fav');
                    item.classList.add('is-favorite');
                } else {
                    removeFavorite(content);
                    saveFavorites();
                    starBtn.textContent = '☆';
                    starBtn.classList.remove('is-fav');
                    item.classList.remove('is-favorite');
                }
            };
            
            toolbar.append(useTime, useBtn, copyBtn, starBtn);
            item.append(txt, toolbar); 
            panelNav.append(item);
        });
        
        if (searchInput.value) searchInput.dispatchEvent(new Event('input'));
    }

    function applyMagneticSnapping() {
        const threshold = 60;
        const rect = sidebar.getBoundingClientRect();
        sidebar.classList.remove('snapped-left', 'snapped-right');
        if (rect.left < threshold) {
            sidebar.style.left = '0px'; sidebar.classList.add('snapped-left');
        } 
        if (!sidebar.classList.contains('collapsed')) {
            localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify({
                left: sidebar.style.left, top: sidebar.style.top,
                width: sidebar.style.width, height: sidebar.style.height
            }));
        }
    }


    let gnpSidebarHovering = false;

    let gnpOpenedByShortcut = false;

    sidebar.addEventListener('mouseenter', () => { 
        gnpSidebarHovering = true;
        gnpOpenedByShortcut = false;
        if (isAutoHideEnabled) { 
            clearTimeout(autoHideTimer); 
            sidebar.classList.remove('collapsed'); 
            scrollToActive();
        } 
    });

    sidebar.addEventListener('mouseleave', () => {
        gnpSidebarHovering = false;
        scheduleAutoHide();
    });

    // Esc：当鼠标在侧边栏内时，快速折叠（隐藏）窗口
    window.addEventListener('keydown', (e) => {
        try {
            if (!e) return;
            const key = e.key;
            if (key !== 'Escape' && key !== 'Esc') return;
            if (!sidebar || !gnpSidebarHovering) return;
            // 若有侧边栏内编辑弹层，交给弹层自身处理
            if (hasSidebarEditOverlay && hasSidebarEditOverlay()) return;

            // 折叠侧边栏
            if (!sidebar.classList.contains('collapsed')) {
                sidebar.classList.add('collapsed');
                applyMagneticSnapping();
            }
            // 同时关闭悬浮预览
            if (gnpHoverPreviewEl && gnpHoverPreviewEl.classList.contains('visible')) hideHoverPreview();

            // 避免 Esc 影响页面其它组件（仅当焦点/鼠标在侧边栏时）
            e.preventDefault();
            e.stopPropagation();
        } catch (_) {}
    }, true);

    let isDragging = false, activeResizer = null, rafId = null;


    // Click outside to collapse (fix: when opened via shortcut but mouse never enters sidebar,
    // mouseleave won't fire; this ensures a single click on page collapses the sidebar).
    document.addEventListener('mousedown', (e) => {
        try {
            if (!sidebar) return;
            if (sidebar.classList.contains('collapsed')) return;

            // If user pinned the sidebar (auto-hide disabled), only collapse on outside click
            // when it was opened via the keyboard shortcut.
            if (!isAutoHideEnabled && !gnpOpenedByShortcut) return;

            if (isDragging || activeResizer || isSelectInteracting) return;
            if (typeof hasSidebarEditOverlay === 'function' && hasSidebarEditOverlay()) return;

            const ae = document.activeElement;
            if (ae && ae.classList && ae.classList.contains('gnp-folder-select')) return;

            const t = e && e.target;
            if (!t) return;

            // Ignore clicks inside any GNP UI (sidebar / hover preview / overlays)
            if (sidebar.contains(t)) return;
            if (gnpHoverPreviewEl && gnpHoverPreviewEl.contains(t)) return;

            const globalOverlay = document.querySelector('.gnp-global-overlay');
            if (globalOverlay && globalOverlay.contains(t)) return;

            const confirmOverlay = document.querySelector('.gnp-confirm-overlay');
            if (confirmOverlay && confirmOverlay.contains(t)) return;

            // Collapse now
            gnpOpenedByShortcut = false;
            clearTimeout(autoHideTimer);
            sidebar.classList.add('collapsed');
            if (typeof applyMagneticSnapping === 'function') applyMagneticSnapping();

            // Also close hover preview if open
            if (gnpHoverPreviewEl && gnpHoverPreviewEl.classList.contains('visible')) {
                if (typeof hideHoverPreview === 'function') hideHoverPreview();
            }
        } catch (_) {}
    }, true);

    let startX, startY, initialLeft, initialTop, initialWidth, initialHeight;

    sidebar.addEventListener('mousedown', (e) => {
        const target = e.target;
        if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'OPTION' || target.classList.contains('mini-btn') || target.closest('.gnp-folder-select') || target.closest('.header-circle-btn') || target.closest('.clear-all-btn')) return;
        startX = e.clientX; startY = e.clientY;
        initialLeft = sidebar.offsetLeft; initialTop = sidebar.offsetTop;
        initialWidth = sidebar.offsetWidth; initialHeight = sidebar.offsetHeight;
        if (target.classList.contains('resizer')) {
            activeResizer = target.dataset.pos; sidebar.classList.add('no-transition'); e.preventDefault();
        } else if (target.closest('#gemini-nav-header') || sidebar.classList.contains('collapsed')) {
            isDragging = true; sidebar.classList.add('no-transition'); e.preventDefault();
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging && !activeResizer) return;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
            const dx = e.clientX - startX; const dy = e.clientY - startY;
            if (isDragging) { sidebar.style.left = (initialLeft + dx) + 'px'; sidebar.style.top = (initialTop + dy) + 'px'; }
            else if (activeResizer) {
                let newW = initialWidth, newH = initialHeight, newL = initialLeft, newT = initialTop;
                const minSize = 150;
                if (activeResizer.includes('r')) newW = Math.max(minSize, initialWidth + dx);
                if (activeResizer.includes('b')) newH = Math.max(minSize, initialHeight + dy);
                if (activeResizer.includes('l')) { newW = Math.max(minSize, initialWidth - dx); if (newW > minSize) newL = initialLeft + dx; }
                if (activeResizer.includes('t')) { newH = Math.max(minSize, initialHeight - dy); if (newH > minSize) newT = initialTop + dy; }
                sidebar.style.width = newW + 'px'; sidebar.style.height = newH + 'px';
                sidebar.style.left = newL + 'px'; sidebar.style.top = newT + 'px';
            }
        });
    });

    window.addEventListener('mouseup', () => {
        if (isDragging || activeResizer) { 
            sidebar.classList.remove('no-transition'); 
            if (isDragging) applyMagneticSnapping(); 
            localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify({
                left: sidebar.style.left, top: sidebar.style.top,
                width: sidebar.style.width, height: sidebar.style.height
            }));
            isDragging = false; activeResizer = null; 
        }
    });

    [tabNav, tabFav].forEach(tab => {
        tab.onclick = (e) => {
            e.stopPropagation();
            searchInput.value = '';
            [tabNav, tabFav].forEach(t => t.classList.remove('active')); tab.classList.add('active');
            [panelNav, panelFav].forEach(p => p.classList.remove('active'));
            document.getElementById(tab.dataset.target).classList.add('active');
            
            if (tab.dataset.target === 'panel-fav') {
                renderFavorites();
            } else {
                refreshNav(true);
            }
        };
    });

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_CONFIG)) || {};
    if (!saved.left || saved.left === 'auto' || parseInt(saved.left) > window.innerWidth / 2) {
         sidebar.style.left = '24px';
    } else {
         sidebar.style.left = saved.left;
    }
    sidebar.style.right = 'auto'; 
    sidebar.style.top = saved.top || '70px'; 
    sidebar.style.width = saved.width || '300px'; 
    sidebar.style.height = saved.height || 'auto';

    const observerDom = new MutationObserver(() => {
        clearTimeout(window.geminiRefreshTimer);
        window.geminiRefreshTimer = setTimeout(() => { refreshNav(); renderFavorites(); }, 800);
    });
    observerDom.observe(document.body, { childList: true, subtree: true });

    // --- ChatGPT SPA 路由变更兼容：切换会话/新建会话时强制刷新 ---
    (function hookLocationChange() {
        const fire = () => window.dispatchEvent(new Event('gnp-locationchange'));
        const _push = history.pushState;
        const _replace = history.replaceState;
        history.pushState = function(...args) { const ret = _push.apply(this, args); fire(); return ret; };
        history.replaceState = function(...args) { const ret = _replace.apply(this, args); fire(); return ret; };
        window.addEventListener('popstate', fire);
    })();

    window.addEventListener('gnp-locationchange', () => {
        // 轻度延迟：等待页面内容完成切换/渲染
        setTimeout(() => {
            try { if (observer) observer.disconnect(); } catch (_) {}
            currentActiveIndex = 0;
            lastCount = 0;
            refreshNav(true);
            renderFavorites();
        }, 900);
    });


    setTimeout(applyMagneticSnapping, 500); setTimeout(() => refreshNav(true), 1500);

    // ===== Keyboard shortcut support (Chrome Commands / F1 fallback) =====
    // Triggered by background.js (chrome.commands) or by page keydown fallback.
    function gnpToggleSidebarFromShortcut() {
        try {
            if (!sidebar) return;

            // 如果侧边栏里有编辑/确认遮罩层，优先让遮罩层处理（避免误触）
            try {
                if (typeof hasSidebarEditOverlay === 'function' && hasSidebarEditOverlay()) return;
            } catch (_) {}

            const isCollapsed = sidebar.classList.contains('collapsed');

            if (isCollapsed) {
                // 展开
                try { clearTimeout(autoHideTimer); } catch (_) {}
                try { sidebar.classList.remove('collapsed'); } catch (_) {}
                try { gnpOpenedByShortcut = true; } catch (_) {}
                try { if (typeof scrollToActive === 'function') scrollToActive(); } catch (_) {}
            } else {
                // 折叠
                try { gnpOpenedByShortcut = false; } catch (_) {}
                try { sidebar.classList.add('collapsed'); } catch (_) {}
                try { if (typeof applyMagneticSnapping === 'function') applyMagneticSnapping(); } catch (_) {}
            }
        } catch (_) {}
    }

    // Listen for messages from MV3 background service worker (chrome.commands)
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
            chrome.runtime.onMessage.addListener((msg) => {
                if (!msg) return;
                if (msg.type === 'GNP_TOGGLE_SIDEBAR' || msg.command === 'toggle-gnp-sidebar') {
                    gnpToggleSidebarFromShortcut();
                }
            });
        }
    } catch (_) {}

    // F1 fallback (may be blocked by browser reserved shortcuts on some systems)
    window.addEventListener('keydown', (e) => {
        try {
            if (!e) return;
            if (e.key === 'F1') {
                e.preventDefault();
                e.stopPropagation();
                gnpToggleSidebarFromShortcut();
            }
        } catch (_) {}
    }, true);

    window.addEventListener('resize', applyMagneticSnapping);
})();
