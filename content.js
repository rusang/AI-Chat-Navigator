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
            --gnp-bg: rgba(255, 255, 255, 0.95);
            --gnp-border: rgba(255, 255, 255, 0.6);
            --gnp-shadow: 0 4px 24px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0,0,0,0.04);
            --gnp-text-main: #1d1d1f;
            --gnp-text-sub: #555;
            --gnp-hover-bg: rgba(0, 0, 0, 0.05);
            --gnp-active-bg: rgba(26, 115, 232, 0.12);
            --gnp-active-border: #1a73e8;
            --gnp-active-text: #1a73e8;
            --gnp-fav-color: #d97706; 
            --gnp-input-bg: rgba(0, 0, 0, 0.05);
            --gnp-input-text: #1d1d1f;
            --gnp-btn-bg: #fff;
            --gnp-btn-hover: #f5f5f7;
            --gnp-collapsed-bg: rgba(255, 235, 235, 0.95);
            --gnp-collapsed-icon: #5f6368;
            --gnp-collapsed-border: rgba(0, 0, 0, 0.18);
            --gnp-collapsed-shadow: 0 10px 26px rgba(0,0,0,0.22), 0 0 0 1px rgba(0,0,0,0.10);
            --gnp-collapsed-accent: rgba(220, 38, 38, 0.55);
            --gnp-scroll-thumb: rgba(0, 0, 0, 0.25);
            --gnp-scroll-thumb-hover: rgba(0, 0, 0, 0.45);
            --gnp-index-color: #1a73e8;
            --gnp-danger-text: #d93025;
            --gnp-progress-bg: #1a73e8;
            --gnp-autosend-color: #9333ea;
            --gnp-autosend-bg: rgba(147, 51, 234, 0.1);
            --gnp-modal-bg: rgba(255, 255, 255, 0.95);
            --gnp-modal-overlay: rgba(255, 255, 255, 0.6);
            
            /* 多选高亮色 */
            --gnp-multi-select-bg: rgba(26, 115, 232, 0.15);
            --gnp-multi-select-border: #1a73e8;
            --gnp-batch-bar-bg: #1d1d1f;
            --gnp-batch-bar-text: #fff;
        }

        @media (prefers-color-scheme: dark) {
            :root {
                /* 深色模式 */
                --gnp-bg: rgba(30, 30, 30, 0.90);
                --gnp-border: rgba(255, 255, 255, 0.15);
                --gnp-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
                --gnp-text-main: #f5f5f7;
                --gnp-text-sub: #a1a1a6;
                --gnp-hover-bg: rgba(255, 255, 255, 0.1);
                --gnp-active-bg: rgba(138, 180, 248, 0.2); 
                --gnp-active-border: #8ab4f8;
                --gnp-active-text: #8ab4f8;
                --gnp-fav-color: #fbbf24;
                --gnp-input-bg: rgba(255, 255, 255, 0.1);
                --gnp-input-text: #fff;
                --gnp-btn-bg: #3a3a3c;
                --gnp-btn-hover: #48484a;
                --gnp-collapsed-bg: rgba(58, 34, 34, 0.95);
                --gnp-collapsed-icon: #e3e3e3;
                --gnp-collapsed-border: rgba(255, 255, 255, 0.22);
                --gnp-collapsed-shadow: 0 12px 30px rgba(0,0,0,0.70), 0 0 0 1px rgba(255,255,255,0.10);
                --gnp-collapsed-accent: rgba(248, 113, 113, 0.60);
                --gnp-scroll-thumb: rgba(255, 255, 255, 0.25);
                --gnp-scroll-thumb-hover: rgba(255, 255, 255, 0.45);
                --gnp-index-color: #8ab4f8;
                --gnp-danger-text: #f28b82;
                --gnp-progress-bg: #8ab4f8;
                --gnp-autosend-color: #c084fc;
                --gnp-autosend-bg: rgba(192, 132, 252, 0.2);
                --gnp-modal-bg: rgba(40, 40, 40, 0.95);
                --gnp-modal-overlay: rgba(0, 0, 0, 0.6);
                
                --gnp-multi-select-bg: rgba(138, 180, 248, 0.25);
                --gnp-multi-select-border: #8ab4f8;
                --gnp-batch-bar-bg: #f5f5f7;
                --gnp-batch-bar-text: #1d1d1f;
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
            height: auto !important; 
            min-height: 100px;
            max-height: 90vh;        
            max-width: 98vw;
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
        #gemini-nav-sidebar.collapsed.snapped-left:hover { background: rgba(26, 115, 232, 0.8) !important; width: 8px !important; }
        
        .gemini-nav-item {
            position: relative; display: block;
            padding: 8px 12px;
            margin: 2px 6px;
            font-size: 13px; color: var(--gnp-text-main);
            cursor: default; 
            border-radius: 8px; 
            transition: background 0.15s;
            overflow: hidden;
            border-left: 3px solid transparent;
        }
        .gemini-nav-item:hover { background: var(--gnp-hover-bg); }
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
        .item-text { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; width: 100%; line-height: 1.5; }
        .item-text.density-compact { -webkit-line-clamp: 3; white-space: normal; }
        .item-text.density-medium { -webkit-line-clamp: 6; white-space: normal; }
        .item-text.density-spacious { -webkit-line-clamp: 12; white-space: normal; padding-bottom: 2px; }

        .bottom-toolbar {
            position: absolute; bottom: 2px; right: 4px; display: flex; gap: 4px; opacity: 0; transition: opacity 0.15s; background: transparent; z-index: 20; pointer-events: auto; 
        }
        .gemini-nav-item:hover .bottom-toolbar { opacity: 1; }

        /* 多选模式下隐藏右下角工具图标（防误触） */
        .gemini-nav-item.multi-selected .bottom-toolbar { display: none !important; }
        .gnp-multi-mode .bottom-toolbar { display: none !important; }


        /* 批量操作浮动栏 */
        #gemini-batch-bar {
            position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%) translateY(20px);
            background: var(--gnp-batch-bar-bg); color: var(--gnp-batch-bar-text);
            padding: 8px 16px; border-radius: 24px;
            display: flex; gap: 12px; align-items: center;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            z-index: 100; transition: 0.2s cubic-bezier(0.18, 0.89, 0.32, 1.28);
            opacity: 0; pointer-events: none;
            font-size: 12px; font-weight: 600; white-space: nowrap;
        }
        #gemini-batch-bar.visible { opacity: 1; pointer-events: auto; transform: translateX(-50%) translateY(0); }
        .batch-btn { cursor: pointer; padding: 4px 10px; border-radius: 12px; transition: 0.1s; }
        .batch-btn.action-save { background: #e8f0fe; color: #1a73e8; }
        .batch-btn.action-save:hover { background: #d2e3fc; }
        .batch-btn.action-delete { background: #fce8e6; color: #d93025; }
        .batch-btn.action-delete:hover { background: #fad2cf; }
        .batch-btn.action-cancel { color: var(--gnp-text-sub); font-weight: normal; }
        .batch-btn.action-cancel:hover { color: var(--gnp-text-main); }

        .mini-btn {
            width: 24px; height: 20px; display: flex; align-items: center; justify-content: center; border-radius: 4px; cursor: pointer; color: var(--gnp-text-sub); background: var(--gnp-bg); box-shadow: 0 1px 2px rgba(0,0,0,0.05); font-size: 11px; transition: all 0.1s;
        }
        .mini-btn:hover { background: var(--gnp-btn-hover); color: var(--gnp-text-main); transform: scale(1.1); z-index: 21; }
        .mini-btn.use-btn { font-weight: bold; }
        .mini-btn.use-btn:hover { color: #1a73e8; background: rgba(26, 115, 232, 0.1); }
        .mini-btn.use-btn.autosend-mode { color: var(--gnp-autosend-color); background: var(--gnp-autosend-bg); border: 1px solid var(--gnp-autosend-color); }
        .mini-btn.star-btn.is-fav { color: var(--gnp-fav-color); font-weight: bold; }
        .mini-btn.del-btn:hover { color: var(--gnp-danger-text); background: rgba(217, 48, 37, 0.1); }

        #gemini-nav-header { padding: 12px 14px 8px 14px; display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; cursor: move; }
        .header-row { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 8px; }
        #gemini-header-controls { display: flex; gap: 6px; align-items: center; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; flex: 1; min-width: 0; }
        #gemini-header-controls::-webkit-scrollbar{ display:none; }

        #gemini-fav-header { display:flex; justify-content:space-between; align-items:center; flex-wrap:nowrap; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; gap:8px; padding:8px 12px; margin-bottom:6px; border-bottom:1px solid var(--gnp-border); }
        #gemini-fav-header::-webkit-scrollbar{ display:none; }
        #gemini-fav-left { display:flex; align-items:center; gap:8px; flex-wrap:nowrap; min-width:0; flex:1 1 auto; }
        #gemini-fav-right { display:flex; align-items:center; gap:6px; flex-shrink:0; flex-wrap:nowrap; }
        #gemini-nav-tabs { display: flex; gap: 4px; background: rgba(0,0,0,0.03); padding: 2px; border-radius: 12px; }
        #gemini-nav-tabs { flex: 0 0 auto; }

        .header-circle-btn {
            width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
            cursor: pointer; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.05); transition: all 0.2s;
            color: var(--gnp-text-sub); 
        }
        .header-circle-btn:hover { transform: scale(1.1); background: rgba(0,0,0,0.1); color: var(--gnp-text-main); }
        #gemini-nav-lock.active { background: #34c759; color: #fff; box-shadow: 0 0 4px rgba(52, 199, 89, 0.4); }
        #gemini-nav-autosend.active { background: var(--gnp-autosend-color); color: #fff; box-shadow: 0 0 6px var(--gnp-autosend-color); }
        #gemini-nav-clear:hover { background: #ff3b30; color: #fff; }
        #gemini-nav-top:hover, #gemini-nav-bottom:hover, #gemini-nav-chat-bottom:hover { background: #1a73e8; color: #fff; }

        .nav-tab { 
            width: 24px; height: 24px; border-radius: 50%; 
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; color: var(--gnp-text-sub); transition: 0.2s; 
        }
        .nav-tab:hover { background: rgba(0,0,0,0.05); color: var(--gnp-text-main); }
        .nav-tab.active { background: var(--gnp-active-bg); color: var(--gnp-active-text); font-weight: bold; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
        .nav-tab .icon-svg { width: 14px; height: 14px; stroke-width: 2.5; }
        
        #gemini-progress-container { width: 100%; height: 3px; background: rgba(0,0,0,0.05); border-radius: 2px; overflow: hidden; margin-top: 4px; }
        #gemini-progress-bar { height: 100%; width: 0%; background: var(--gnp-progress-bg); transition: width 0.3s; }

        #gemini-nav-content-wrapper { flex-grow: 1; overflow-y: auto; padding: 4px 2px; position: relative; }
        #gemini-nav-content-wrapper::-webkit-scrollbar { width: 6px; } 
        #gemini-nav-content-wrapper::-webkit-scrollbar-thumb { background: var(--gnp-scroll-thumb); border-radius: 4px; transition: background 0.3s; }
        #gemini-nav-content-wrapper::-webkit-scrollbar-thumb:hover { background: var(--gnp-scroll-thumb-hover); }
        
        .content-panel { display: none; }
        .content-panel.active { display: block; }

        #gemini-nav-search-container { padding: 4px 14px 8px 14px; }
        #gemini-nav-search-input { width: 100%; box-sizing: border-box; padding: 8px 12px; background: var(--gnp-input-bg); border: 1px solid transparent; border-radius: 8px; font-size: 13px; outline: none; transition: all 0.2s; color: var(--gnp-input-text) !important; }
        #gemini-nav-search-input:focus { background: var(--gnp-tab-active-bg); box-shadow: 0 0 0 2px rgba(0, 122, 255, 0.3); }
        #gemini-nav-search-input::placeholder { color: var(--gnp-text-sub); }

        .resizer { position: absolute; width: 14px; height: 14px; z-index: 10001; }
        .resizer-tl { top: 0; left: 0; cursor: nw-resize; }
        .resizer-tr { top: 0; right: 0; cursor: ne-resize; }
        .resizer-bl { bottom: 0; left: 0; cursor: sw-resize; }
        .resizer-br { bottom: 0; right: 0; cursor: se-resize; }

        .icon-svg { width: 12px; height: 12px; }

        .gnp-confirm-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: var(--gnp-modal-overlay); z-index: 100; display: flex; flex-direction: column; align-items: center; justify-content: center; backdrop-filter: blur(4px); animation: fadeIn 0.2s ease; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .gnp-confirm-box { padding: 16px; background: var(--gnp-modal-bg); border: 1px solid var(--gnp-border); border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.2); max-width: 85%; text-align: center; }
        .gnp-confirm-title { font-size: 13px; font-weight: 600; color: var(--gnp-text-main); margin-bottom: 4px; }
        .gnp-confirm-desc { font-size: 12px; color: var(--gnp-text-sub); margin-bottom: 12px; }
        .gnp-btn-row { display: flex; gap: 8px; justify-content: center; }
        .gnp-btn-confirm { background: #d93025; color: #fff; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; border: none; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .gnp-btn-confirm:hover { background: #b02018; }
        .gnp-btn-cancel { background: transparent; color: var(--gnp-text-main); padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; border: 1px solid var(--gnp-border); }
        .gnp-btn-cancel:hover { background: var(--gnp-hover-bg); }

        
        /* 全屏居中编辑弹窗（用于收藏编辑） */
        .gnp-global-overlay { position: fixed; inset: 0; background: var(--gnp-modal-overlay); z-index: 2147483647; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px); animation: fadeIn 0.2s ease; }
        .gnp-global-box { width: min(760px, 86vw); max-height: 82vh; background: var(--gnp-modal-bg); border: 1px solid var(--gnp-border); border-radius: 14px; box-shadow: 0 18px 60px rgba(0,0,0,0.28); padding: 16px 16px 14px; display: flex; flex-direction: column; gap: 10px; }
        .gnp-global-title { font-size: 13px; font-weight: 600; color: var(--gnp-text-main); }
        .gnp-global-textarea { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--gnp-border); outline: none; font-size: 14px; line-height: 1.5; background: var(--gnp-input-bg); color: var(--gnp-input-text); caret-color: var(--gnp-input-text); min-height: 132px; max-height: 52vh; resize: vertical; overflow: auto; white-space: pre-wrap; }
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
        .gnp-folder-select:focus{ outline: none; }
        .gnp-prompt-input::placeholder{ color: var(--gnp-text-sub); }
`;

    injectStyles(styles);

    const SVGS = {
        clear: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`,
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

    const resizers = ['tl', 'tr', 'bl', 'br'].map(pos => {
        const el = document.createElement('div');
        el.className = `resizer resizer-${pos}`;
        el.dataset.pos = pos;
        return el;
    });

    setTimeout(() => {
        sidebar.append(collapsedIcon, header, searchContainer, contentWrapper, ...resizers);
        document.body.appendChild(sidebar);
    }, 1500);

    const STORAGE_KEY_CONFIG = 'gemini-nav-config-v7-0'; 
    const STORAGE_KEY_FAV = 'gemini-favorites';
    const STORAGE_KEY_HIDE = 'gemini-auto-hide';
    const STORAGE_KEY_AUTOSEND = 'gemini-auto-send-mode';

    const STORAGE_KEY_FOLDERS = 'gemini-nav-pro-panel-fav-folders';
    const STORAGE_KEY_FAV_FOLDER_FILTER = 'gemini-nav-pro-panel-fav-folder-filter';

    let folders = JSON.parse(localStorage.getItem(STORAGE_KEY_FOLDERS)) || ['默认'];
    folders = [...new Set(folders.map(f => String(f || '').trim()).filter(Boolean))];
    if (!folders.includes('默认')) folders.unshift('默认');
    const saveFolders = () => localStorage.setItem(STORAGE_KEY_FOLDERS, JSON.stringify(folders));

    // 收藏：兼容旧版本（string 数组）与新版本（对象数组）
    const rawFav = JSON.parse(localStorage.getItem(STORAGE_KEY_FAV)) || [];
    const seenFavText = new Set();
    let favorites = [];
    rawFav.forEach(it => {
        let t = '';
        let folder = '默认';
        if (typeof it === 'string') {
            t = it;
        } else if (it && typeof it === 'object') {
            t = it.text ?? it.t ?? '';
            folder = it.folder ?? it.f ?? folder;
        }
        t = String(t || '').trim();
        folder = String(folder || '默认').trim() || '默认';
        if (!t) return;
        if (seenFavText.has(t)) return;
        seenFavText.add(t);
        if (!folders.includes(folder)) folders.push(folder);
        favorites.push({ text: t, folder });
    });

    let favFolderFilter = localStorage.getItem(STORAGE_KEY_FAV_FOLDER_FILTER) || '全部';

    const saveFavorites = () => {
        const payload = favorites.map(f => ({ text: f.text, folder: f.folder }));
        localStorage.setItem(STORAGE_KEY_FAV, JSON.stringify(payload));
    };

    const getFavoriteIndex = (t) => favorites.findIndex(f => f.text === t);
    const hasFavorite = (t) => getFavoriteIndex(t) !== -1;

    const addFavorite = (t, folder = '默认') => {
        const text = String(t || '').trim();
        const f = String(folder || '默认').trim() || '默认';
        if (!text) return false;
        if (hasFavorite(text)) return false;
        if (!folders.includes(f)) { folders.push(f); saveFolders(); }
        favorites.unshift({ text, folder: f }); // 新收藏置顶：保持原行为
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
        const q = searchInput.value.toLowerCase();
        const activePanelId = document.querySelector('.nav-tab.active').dataset.target;
        const activePanel = document.getElementById(activePanelId);
        if (activePanel) {
            activePanel.querySelectorAll('.gemini-nav-item').forEach(item => {
                const text = item.querySelector('.item-text').textContent.toLowerCase();
                item.style.display = text.includes(q) ? 'block' : 'none';
            });
        }
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

        filteredFavorites.forEach((favObj) => {
            const favText = favObj.text;
            const itemIndex = favorites.indexOf(favObj);

            const item = document.createElement('div');
            item.className = 'gemini-nav-item';
            if (selectedItems.has(favText)) item.classList.add('multi-selected');
            item.dataset.prompt = favText;
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
            txt.textContent = favText;

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
                renderFavorites();
            };

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
            item.append(folderBadge, txt, toolbar);
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
            item.dataset.originalIndex = originalIndex; 
            
            if (originalIndex === currentActiveIndex) item.classList.add('active-current');
            if (isFav) item.classList.add('is-favorite');

            const txt = document.createElement('span');
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
            
            toolbar.append(useBtn, copyBtn, starBtn);
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

    sidebar.addEventListener('mouseenter', () => { 
        if (isAutoHideEnabled) { 
            clearTimeout(autoHideTimer); 
            sidebar.classList.remove('collapsed'); 
            scrollToActive();
        } 
    });
    
    sidebar.addEventListener('mouseleave', () => {
        scheduleAutoHide();
    });

    let isDragging = false, activeResizer = null, rafId = null;
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
    
    window.addEventListener('resize', applyMagneticSnapping);
})();