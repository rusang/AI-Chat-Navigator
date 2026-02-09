// ==UserScript==
// @name         AI Chat Navigator
// @namespace    http://tampermonkey.net/
// @version      8.0
// @description  支持Command/Ctrl多选 + 批量收藏/删除 + 靶向滚动 + 极致紧凑 + 键盘快捷键 + 主题切换 + Claude.ai兼容
// @author       Chantec
// @match        https://gemini.google.com/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=google.com
// @grant        GM_addStyle
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // --- 调试开关（生产环境应设为 false）---
    const DEBUG = false;
    const log = DEBUG ? console.log.bind(console, '[GNP]') : () => {};
    const logError = console.error.bind(console, '[GNP ERROR]');

    // 调试日志（生产环境可通过修改 DEBUG 开关控制）
    log('[GNP v8.0] Script loaded at:', new Date().toISOString());
    log('[GNP] Location:', location.href);
    log('[GNP] Document ready state:', document.readyState);

    // --- 0. 环境检测 ---
    const IS_CHATGPT = location.hostname.includes('chatgpt.com') || location.hostname.includes('openai.com');
    const IS_CLAUDE = location.hostname.includes('claude.ai');

    log('[GNP] Environment:', { IS_CHATGPT, IS_CLAUDE, hostname: location.hostname });

	const SITE_CONFIG = {
	gemini: {
		// Gemini 策略：优先寻找 query-text 类，其次寻找包含特定属性的容器
		promptSelector: [
			'.query-text',                            // 经典稳定类名
			'h2[data-test-id="user-query"]',          // 语义化测试ID
			'div[data-role="user-query"]',            // 语义化角色
			'div:has(> span[class*="query-text"])',   // 结构特征：父级包含类似类名
			'.user-query'                             // 备用类名
		],
		inputSelector: [
			'div[role="textbox"]',
			'div[contenteditable="true"]',
			'textarea',
			'rich-textarea > div'
		],
		sendBtnSelector: [
			'button[aria-label*="Send"]',
			'button[aria-label*="发送"]',
			'.send-button',
			'button:has(svg[icon="send"])' // 特征检测：包含发送图标的按钮
		]
	},
	chatgpt: {
		// ChatGPT 策略：data-message-author-role 是最稳的锚点
		promptSelector: [
			// 1. 黄金标准：属性选择器 (最稳)
			'div[data-message-author-role="user"]',

			// 2. 结构特征：通过父级 conversation-turn 锁定
			'article[data-testid*="conversation-turn"] div[data-message-author-role="user"]',

			// 3. 特征检测：利用 :has() 寻找包含"用户"相关特征的块
			// (注意：这会选中包含头像的行，需要确保后续 innerText 提取逻辑兼容)
			'div.group:has([data-message-author-role="user"])', 

			// 4. 备用：旧版选择器
			'li[data-message-author-role="user"]'
		],
		inputSelector: [
			'#prompt-textarea',
			'textarea[data-testid="prompt-textarea"]',
			'div[contenteditable="true"][data-testid="prompt-textarea"]',
			'div[contenteditable="true"][role="textbox"]'
		],
		sendBtnSelector: [
			'button[data-testid="send-button"]',
			'button[data-testid="fruitjuice-send-button"]',
			'button[aria-label*="Send"]',
			'button[aria-label*="发送"]',
			'button:has(svg[viewBox*="0 0 24 24"])' // 极其宽泛的兜底，慎用
		]
	},
	claude: {
		// Claude 策略：DOM 变动最频繁，需要多层兜底
		promptSelector: [
			// 1. 官方测试钩子 (最稳)
			'div[data-testid="user-message"]',
			'div[data-testid="user-human-turn"]',

			// 2. 字体特征类名 (较稳)
			'.font-user-message',

			// 3. 结构特征：通过 :has 寻找包含特定头像或图标的网格行
			// 寻找包含 "user" 样式头像的父容器对应的文本区域
			'div:has(> div > svg[aria-label="User"]) + div', 

			// 4. 模糊类名匹配 (防止 hash 变动)
			'div[class*="user-message"]',

			// 5. 备用层级结构
			'div[data-is-streaming="false"] .font-user-message'
		],
		inputSelector: [
			'div.ProseMirror[contenteditable="true"]',
			'div[contenteditable="true"][role="textbox"]',
			'fieldset div[contenteditable="true"]'
		],
		sendBtnSelector: [
			'button[data-testid="send-button"]',
			'button[aria-label*="Send"]',
			'button[aria-label*="发送"]',
			'button:has(svg)' // 最后的兜底
		]
	}};

    const CURRENT_CONFIG = IS_CLAUDE ? SITE_CONFIG.claude : (IS_CHATGPT ? SITE_CONFIG.chatgpt : SITE_CONFIG.gemini);

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
        if (IS_CLAUDE) {
            return document.querySelector('main') || document;
        }
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
    /* [修改] 加深背景，去除动画依赖 */
    --gnp-hover-bg: rgba(15, 23, 42, 0.08);
    /* [优化] 浅色模式变量 */
    --gnp-active-bg: rgba(37, 99, 235, 0.18);
    --gnp-active-border: #2563eb;
    --gnp-active-text: #1d4ed8;
    
    /* [新增] 当前项颜色：Teal (青色) */
    --gnp-current-bg: rgba(20, 184, 166, 0.14);
    --gnp-current-border: #14b8a6;
    --gnp-current-text: #0f766e;
    --gnp-fav-color: #d97706;
    --gnp-star-list: rgba(234, 179, 8, 0.45); /* [调整] 更淡的金色 (45%透明度)，不抢视觉 */
    --gnp-input-bg: rgba(15, 23, 42, 0.045);
    --gnp-input-text: #0f172a;
    --gnp-search-highlight: #dc2626;

    --gnp-mini-active-bg: rgba(37, 99, 235, 0.14);
    --gnp-mini-active-shadow: 0 10px 24px rgba(37, 99, 235, 0.16), 0 0 0 1px rgba(37, 99, 235, 0.22);

    /* [UI优化] 加深选中态背景颜色 */
    --gnp-tab-active-bg: rgba(79, 70, 229, 0.85);
    --gnp-tab-active-fg: #ffffff;
    --gnp-tab-active-shadow: 0 8px 20px rgba(79, 70, 229, 0.35), 0 0 0 2px rgba(79, 70, 229, 0.65), inset 0 1px 0 rgba(255, 255, 255, 0.3);
    --gnp-tab-hover-bg: rgba(15, 23, 42, 0.08);

    --gnp-tab-icon: rgba(15, 23, 42, 0.60);
    --gnp-tab-icon-active: #ffffff;

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
    --gnp-autosend-bg: rgba(124, 58, 237, 0.85);

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
        /* [修改] 加深背景 */
		--gnp-hover-bg: rgba(148, 163, 184, 0.20);
		/* [优化] 深色模式变量 */
		--gnp-active-bg: rgba(96, 165, 250, 0.25);
		--gnp-active-border: #60a5fa;
		--gnp-active-text: #93c5fd;

		/* [新增] 当前项颜色 (深色模式) */
		--gnp-current-bg: rgba(20, 184, 166, 0.25);
		--gnp-current-border: #2dd4bf;
		--gnp-current-text: #5eead4;
        --gnp-fav-color: #fbbf24;
        --gnp-star-list: rgba(253, 224, 71, 0.40); /* [调整] 深色模式下用更淡的黄色 */
        --gnp-input-bg: rgba(148, 163, 184, 0.14);
        --gnp-input-text: rgba(248, 250, 252, 0.96);
        --gnp-search-highlight: #f87171;

        --gnp-mini-active-bg: rgba(96, 165, 250, 0.18);
        --gnp-mini-active-shadow: 0 18px 50px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(96, 165, 250, 0.26);

        --gnp-tab-active-bg: rgba(99, 102, 241, 0.75);
        --gnp-tab-active-fg: #ffffff;
        --gnp-tab-active-shadow: 0 18px 50px rgba(0, 0, 0, 0.6), 0 0 0 2px rgba(99, 102, 241, 0.60), 0 10px 26px rgba(99, 102, 241, 0.25);
        --gnp-tab-hover-bg: rgba(148, 163, 184, 0.20);

        --gnp-tab-icon: rgba(248, 250, 252, 0.70);
        --gnp-tab-icon-active: #ffffff;

        --gnp-btn-bg: rgba(31, 41, 55, 0.82);
        --gnp-btn-hover: rgba(55, 65, 81, 0.90);

        --gnp-collapsed-bg: rgba(17, 24, 39, 0.94);
        --gnp-collapsed-icon: rgba(248, 250, 252, 0.92);
        --gnp-collapsed-border: rgba(148, 163, 184, 0.26);
        --gnp-collapsed-shadow: 0 22px 70px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(148, 163, 184, 0.10);
        --gnp-collapsed-accent: rgba(96, 165, 250, 0.78);

        --gnp-hover-preview-border: rgba(148, 163, 184, 0.24);
        --gnp-hover-preview-bg: linear-gradient(180deg, rgba(17, 24, 39, 0.92), rgba(15, 23, 42, 0.92));

/* ===== 强制主题模式 (v8.0新增) ===== */
[data-gnp-theme="dark"] {
    --gnp-bg: rgba(17, 24, 39, 0.88);
    --gnp-border: rgba(148, 163, 184, 0.22);
    --gnp-shadow: 0 22px 70px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(148, 163, 184, 0.10);
    --gnp-text-main: rgba(248, 250, 252, 0.96);
    --gnp-text-sub: rgba(248, 250, 252, 0.70);
    /* [修改] 加深背景 */
    --gnp-hover-bg: rgba(148, 163, 184, 0.20);
	/* [优化] 深色模式变量 */
    --gnp-active-bg: rgba(96, 165, 250, 0.25);
    --gnp-active-border: #60a5fa;
    --gnp-active-text: #93c5fd;

    /* [新增] 当前项颜色 (深色模式) */
    --gnp-current-bg: rgba(20, 184, 166, 0.25);
    --gnp-current-border: #2dd4bf;
    --gnp-current-text: #5eead4;
    --gnp-star-list: rgba(253, 224, 71, 0.65);
    --gnp-input-bg: rgba(148, 163, 184, 0.14);
    --gnp-input-text: rgba(248, 250, 252, 0.96);
    --gnp-btn-bg: rgba(31, 41, 55, 0.82);
    --gnp-btn-hover: rgba(55, 65, 81, 0.90);
    --gnp-tab-icon: rgba(248, 250, 252, 0.70);
    --gnp-tab-icon-active: #ffffff;
    --gnp-tab-active-bg: rgba(99, 102, 241, 0.75);
    --gnp-tab-active-shadow: 0 18px 50px rgba(0, 0, 0, 0.6), 0 0 0 2px rgba(99, 102, 241, 0.60), 0 10px 26px rgba(99, 102, 241, 0.25);
    --gnp-tab-hover-bg: rgba(148, 163, 184, 0.20);

    --gnp-tab-active-fg: #ffffff;
    
    --gnp-autosend-color: #a78bfa;
    --gnp-autosend-bg: rgba(167, 139, 250, 0.85);

[data-gnp-theme="light"] {
    --gnp-bg: rgba(255, 255, 255, 0.88);
    --gnp-border: rgba(15, 23, 42, 0.12);
    --gnp-shadow: 0 18px 50px rgba(15, 23, 42, 0.14), 0 2px 8px rgba(15, 23, 42, 0.06);
    --gnp-text-main: #0f172a;
    --gnp-text-sub: rgba(15, 23, 42, 0.68);
    /* [修改] 加深背景，去除动画依赖 */
    --gnp-hover-bg: rgba(15, 23, 42, 0.08);
    /* [优化] 浅色模式变量 */
    --gnp-active-bg: rgba(37, 99, 235, 0.18);
    --gnp-active-border: #2563eb;
    --gnp-active-text: #1d4ed8;
    
    /* [新增] 当前项颜色：Teal (青色) */
    --gnp-current-bg: rgba(20, 184, 166, 0.14);
    --gnp-current-border: #14b8a6;
    --gnp-current-text: #0f766e;
    --gnp-star-list: rgba(234, 179, 8, 0.65);
    --gnp-input-bg: rgba(15, 23, 42, 0.045);
    --gnp-input-text: #0f172a;
    --gnp-btn-bg: rgba(255, 255, 255, 0.70);
    --gnp-btn-hover: rgba(255, 255, 255, 0.92);
    --gnp-tab-icon: rgba(15, 23, 42, 0.60);
    --gnp-tab-icon-active: #ffffff;
    --gnp-tab-active-bg: rgba(79, 70, 229, 0.85);
    --gnp-tab-active-shadow: 0 8px 20px rgba(79, 70, 229, 0.35), 0 0 0 2px rgba(79, 70, 229, 0.65), inset 0 1px 0 rgba(255, 255, 255, 0.3);
    --gnp-tab-hover-bg: rgba(15, 23, 42, 0.08);

    --gnp-tab-active-fg: #ffffff;
    
    --gnp-autosend-color: #7c3aed;
    --gnp-autosend-bg: rgba(124, 58, 237, 0.85);

/* 键盘导航选中状态 (v8.0新增) */
.gemini-nav-item.keyboard-selected {
    background: var(--gnp-active-bg) !important;
    box-shadow: inset 0 0 0 2px var(--gnp-active-border) !important;
}
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
        --gnp-autosend-bg: rgba(167, 139, 250, 0.85);

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

        /* 键盘导航选中态（↑/↓） */
        .gemini-nav-item.keyboard-selected {
            background: color-mix(in srgb, var(--gnp-active-bg) 85%, var(--gnp-hover-bg));
            box-shadow: inset 0 0 0 2px var(--gnp-active-border);
            border-left: 3px solid var(--gnp-active-border);
        }
        .gemini-nav-item.keyboard-selected .item-text { color: var(--gnp-active-text); }
        .gemini-nav-item.keyboard-selected .item-index { color: var(--gnp-active-border); }

        .gemini-nav-item.dragging { opacity: 0.5; background: var(--gnp-hover-bg); border: 2px dashed var(--gnp-active-border); }
        .gemini-nav-item.drag-over { background: var(--gnp-active-bg); border-top: 2px solid var(--gnp-active-border); }
        .gemini-nav-item.active-current {
            /* [修改] 使用青色变量，与蓝色选中态区分 */
            background: var(--gnp-current-bg);
            border-left: 3px solid var(--gnp-current-border);
            color: var(--gnp-current-text);
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
        /* 填入/发送按钮 - 闪电效果 */
        .mini-btn.use-btn { font-weight: bold; background: rgba(0,0,0,0.04); border: 1px solid var(--gnp-border); color: var(--gnp-text-sub); }
        .mini-btn.use-btn:hover { color: #7c3aed; background: rgba(124, 58, 237, 0.12); box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.12), 0 2px 8px rgba(124, 58, 237, 0.12); }
        .mini-btn.use-btn.autosend-mode { color: #fff; background: var(--gnp-autosend-bg); border: 1px solid var(--gnp-autosend-color); }
        /* 复制按钮 - 蓝色 */
        .mini-btn:has(svg) { background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.20); }
        .mini-btn:has(svg):hover { background: rgba(59, 130, 246, 0.15); color: #3b82f6; box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.12), 0 2px 6px rgba(59, 130, 246, 0.12); }
        /* 编辑按钮 - 琥珀色 */
        .mini-btn:has(svg):nth-child(4) { background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.20); }
        .mini-btn:has(svg):nth-child(4):hover { background: rgba(245, 158, 11, 0.15); color: #f59e0b; box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.12), 0 2px 6px rgba(245, 158, 11, 0.12); }
        /* 文件夹移动按钮 - 绿色 */
        .mini-btn:has(path[d*="folder"]) { background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.20); }
        .mini-btn:has(path[d*="folder"]):hover { background: rgba(16, 185, 129, 0.15); color: #10b981; box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.12), 0 2px 6px rgba(16, 185, 129, 0.12); }
        .mini-btn.active, .mini-btn.is-active, .mini-btn[aria-pressed="true"] { background: var(--gnp-mini-active-bg); box-shadow: var(--gnp-mini-active-shadow); color: var(--gnp-active-text); border-color: color-mix(in srgb, var(--gnp-active-border) 26%, var(--gnp-border)); }
        .mini-btn.star-btn.is-fav { color: var(--gnp-fav-color); font-weight: 700; background: rgba(245, 158, 11, 0.12); box-shadow: 0 1px 3px rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.28); }
        .gnp-item-stars span { color: var(--gnp-fav-color); text-shadow: 0 1px 0 rgba(0,0,0,0.04); }
        .mini-btn.del-btn { background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.20); }
        .mini-btn.del-btn:hover { color: #ef4444; background: rgba(239, 68, 68, 0.15); box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.12), 0 2px 6px rgba(239, 68, 68, 0.12); border-color: rgba(239, 68, 68, 0.35); }

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
        #gemini-nav-autosend { background: rgba(124, 58, 237, 0.10); border-color: rgba(124, 58, 237, 0.25); color: var(--gnp-autosend-color); }
        #gemini-nav-autosend:hover { background: rgba(124, 58, 237, 0.18); color: #7c3aed; box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.15), inset 0 1px 0 rgba(255,255,255,0.65), 0 8px 20px rgba(124, 58, 237, 0.15); }
        #gemini-nav-autosend.active { background: var(--gnp-autosend-color); color: #fff; box-shadow: 0 0 8px var(--gnp-autosend-color), 0 0 0 2px rgba(124, 58, 237, 0.30); }
        #gemini-nav-clear:hover { background: rgba(220, 38, 38, 0.14); color: var(--gnp-danger-text); }
        #gemini-nav-top, #gemini-nav-bottom { background: rgba(37, 99, 235, 0.08); border-color: rgba(37, 99, 235, 0.20); }
        #gemini-nav-top:hover, #gemini-nav-bottom:hover { background: rgba(37, 99, 235, 0.18); color: #2563eb; box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.12), inset 0 1px 0 rgba(255,255,255,0.65), 0 8px 20px rgba(15,23,42,0.10); }
        #gemini-nav-chat-top, #gemini-nav-chat-bottom { background: rgba(16, 185, 129, 0.08); border-color: rgba(16, 185, 129, 0.20); }
        #gemini-nav-chat-top:hover, #gemini-nav-chat-bottom:hover { background: rgba(16, 185, 129, 0.18); color: #10b981; box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.12), inset 0 1px 0 rgba(255,255,255,0.65), 0 8px 20px rgba(15,23,42,0.10); }

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

.gnp-star-picker { display: flex; align-items: center; gap: 4px; margin: 8px 0; user-select: none; justify-content: center; }
.gnp-star-item { font-size: 20px; cursor: pointer; color: var(--gnp-text-sub); transition: transform 0.1s; line-height: 1; }
.gnp-star-item.active { color: var(--gnp-fav-color); }
.gnp-star-item:hover { transform: scale(1.2); }
/* [修复] 强制指定星星颜色，不使用变量，避免显示为黑色 */
.gnp-item-stars { 
    display: inline-flex; 
    align-items: center; 
    color: rgba(217, 119, 6, 0.5) !important; /* 浅色模式：淡琥珀色 (50%透明) */
    font-size: 11px; 
    margin-right: 6px; 
    line-height: 1; 
    user-select: none; 
    flex-shrink: 0; 
    letter-spacing: 0px; 
}

/* 深色模式适配：使用淡黄色 */
@media (prefers-color-scheme: dark) { 
    .gnp-item-stars { color: rgba(253, 224, 71, 0.5) !important; } 
}
[data-gnp-theme="dark"] .gnp-item-stars { 
    color: rgba(253, 224, 71, 0.5) !important; 
}

/* [修复] 侧边栏滚动条样式 (增强对比度，防止隐形) */
#gemini-nav-sidebar ::-webkit-scrollbar, 
.gnp-fav-prompt-preview ::-webkit-scrollbar {
    width: 6px;
    height: 6px;
    background: transparent; /* 轨道透明 */
}

/* 浅色模式默认：深灰色滑块 */
#gemini-nav-sidebar ::-webkit-scrollbar-thumb, 
.gnp-fav-prompt-preview ::-webkit-scrollbar-thumb {
    background-color: rgba(0, 0, 0, 0.25); 
    border-radius: 3px;
}
#gemini-nav-sidebar ::-webkit-scrollbar-thumb:hover, 
.gnp-fav-prompt-preview ::-webkit-scrollbar-thumb:hover {
    background-color: rgba(0, 0, 0, 0.45);
}

/* 深色模式适配：半透明白色滑块 */
@media (prefers-color-scheme: dark) {
    #gemini-nav-sidebar ::-webkit-scrollbar-thumb, 
    .gnp-fav-prompt-preview ::-webkit-scrollbar-thumb {
        background-color: rgba(255, 255, 255, 0.25);
    }
    #gemini-nav-sidebar ::-webkit-scrollbar-thumb:hover, 
    .gnp-fav-prompt-preview ::-webkit-scrollbar-thumb:hover {
        background-color: rgba(255, 255, 255, 0.4);
    }
}
/* 强制深色主题适配 */
[data-gnp-theme="dark"] #gemini-nav-sidebar ::-webkit-scrollbar-thumb, 
[data-gnp-theme="dark"] .gnp-fav-prompt-preview ::-webkit-scrollbar-thumb {
    background-color: rgba(255, 255, 255, 0.25);
}
[data-gnp-theme="dark"] #gemini-nav-sidebar ::-webkit-scrollbar-thumb:hover, 
[data-gnp-theme="dark"] .gnp-fav-prompt-preview ::-webkit-scrollbar-thumb:hover {
    background-color: rgba(255, 255, 255, 0.4);
}
`;

    const IS_EXTENSION = (typeof chrome !== "undefined" && chrome && chrome.runtime && chrome.runtime.id);
    injectStyles(styles);

    const SVGS = {
        clear: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`,
        close: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
        edit: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
        copy: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
        plus: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
        pin: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7h1V5H8v2h1v3.76z"/></svg>`,
        folderPlus: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>`,
        folderX: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="10" y1="12" x2="14" y2="16"/><line x1="14" y1="12" x2="10" y2="16"/></svg>`,
        folderMove: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M15 12l-3 3m0 0l-3-3m3 3v-5"/></svg>`,
        top: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`,
        bottom: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`,
        chatBottom: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="20" x2="19" y2="20"/><polyline points="7 6 12 11 17 6"/><polyline points="7 13 12 18 17 13"/></svg>`,
                locate: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg>`,
chatTop: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="4" x2="19" y2="4"/><polyline points="7 11 12 6 17 11"/><polyline points="7 18 12 13 17 18"/></svg>`,
        check: `✔`,
        star: `★`,
        lightning: `⚡`,

        nav: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,

        fileImport: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><path d="M12 18v-6"></path><polyline points="9 15 12 12 15 15"></polyline></svg>`,
        starTab: `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`
    };

    const sidebar = document.createElement('div');
    sidebar.id = 'gemini-nav-sidebar';
    try {
        const host = String(location.hostname || '');
        if ((/\bclaude\.ai\b/i).test(host)) {
            sidebar.classList.add('gnp-host-claude');
            // 强制隔离 Claude 的 stacking context / compositing，避免弹窗只剩遮罩
            try { sidebar.style.isolation = 'isolate'; } catch (_) {}
            try { sidebar.style.transform = 'translateZ(0)'; } catch (_) {}
        }
        if ((/\bchatgpt\.com\b|\bchat\.openai\.com\b/i).test(host)) sidebar.classList.add('gnp-host-chatgpt');
        if ((/\bgemini\.google\.com\b/i).test(host)) sidebar.classList.add('gnp-host-gemini');
    } catch (_) {}

    console.log('[GNP] Sidebar element created:', sidebar);

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
    // 确保悬浮预览/弹窗中的⚡按钮也能正确跟随“自动发送”开关变紫
    //（这些按钮可能不在 sidebar DOM 内，因此不能仅依赖 sidebar 范围的同步）
    try {
        if (b.classList.contains('use-btn')) {
            if (isAutoSendEnabled) b.classList.add('autosend-mode');
            else b.classList.remove('autosend-mode');
        }
    } catch (_) {}
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
                renameFavorite(oldText, newText);
                saveFavorites();
            }
        } else {
            // 已存在：合并（删除当前条）
            const idx = getFavoriteIndex(oldText);
            if (idx > -1) removeFavorite(oldText);
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
        const idx = getFavoriteIndex(t);
        const favObj = (idx > -1 && favorites && favorites[idx]) ? favorites[idx] : { useCount: 0, lastUsed: 0, rating: 1 };
        
        // [调整] 所属文件夹显示：移动到工具栏最下方（星级右侧），仅显示文件夹名
        const currentFolderName = String(favObj.folder || '默认');

        // [新增] 悬浮窗内的星级评分（置于工具栏最前）
        const ratingBox = document.createElement('div');
        ratingBox.className = 'gnp-hover-rating';
        const renderHoverStars = (currentR) => {
            ratingBox.innerHTML = '';
            for (let i = 1; i <= 5; i++) {
                const s = document.createElement('span');
                s.className = `gnp-hover-star ${i <= currentR ? 'active' : ''}`;
                s.textContent = i <= currentR ? '★' : '☆';
                s.title = `设置 ${i} 星`;
                s.onclick = (e) => {
                    e.stopPropagation();
                    if (idx > -1) {
                        favorites[idx].rating = i;
                        saveFavorites('fav_list');
                        renderHoverStars(i);
                        // 若侧边栏收藏面板可见，同步刷新以更新列表上的星星
                        if (panelFav && panelFav.classList.contains('active')) renderFavorites();
                    }
                };
                ratingBox.appendChild(s);
            }
        };
        renderHoverStars(Number(favObj.rating) || 1);
        gnpHoverPreviewToolbarEl.appendChild(ratingBox);

        // [新增] 文件夹名（星级右侧；不显示“所属文件夹”字样）
        const folderBadge = document.createElement('span');
        folderBadge.className = 'gnp-hover-folder-badge';
        folderBadge.textContent = gnpTruncateFolderName(currentFolderName);
        folderBadge.style.cssText = 'max-width: 200px; height: 20px; display: inline-flex; align-items: center; padding: 0 8px; border-radius: 999px; font-size: 11px; line-height: 1; color: var(--gnp-text-sub); background: rgba(16,185,129,0.12); border: 1px solid rgba(16,185,129,0.22); box-shadow: 0 1px 2px rgba(0,0,0,0.04); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: none; pointer-events: none;';
        gnpHoverPreviewToolbarEl.appendChild(folderBadge);

        // [新增] 更改所属文件夹按钮（放在使用次数左边）
        const moveFolderBtn = makeMiniBtn({
            cls: '',
            title: '更改所属文件夹',
            html: SVGS.folderMove,
            onClick: (e) => {
                if (e) e.stopPropagation();
                const currentFolder = favObj.folder || '默认';
                gnpMoveFavoriteToFolderFromHover(t, currentFolder);
            }
        });
        gnpHoverPreviewToolbarEl.appendChild(moveFolderBtn);

        // 统计信息（使用次数 / 最近使用）
        try {
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
        /* [修复] 复制不增加使用次数 */
        const copyBtn = makeMiniBtn({ cls: '', title: '复制', html: SVGS.copy, onClick: () => {
            navigator.clipboard.writeText(t);
            // recordPromptUse(t);  <-- 已移除
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
                    removeFavorite(t);
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
        // [新增] 检查是否已收藏，如果是，则显示星级
        const favIdx = getFavoriteIndex(t);
        const isFav = favIdx > -1;
        const favObj = isFav ? favorites[favIdx] : null;
        // [调整] 所属文件夹：移动到工具栏最下方（星级右侧），仅显示文件夹名
        const currentFolderName = (isFav && favObj) ? String(favObj.folder || '默认') : '';
        if (isFav && favObj) {
            // 复制星级渲染逻辑
            const ratingBox = document.createElement('div');
            ratingBox.className = 'gnp-hover-rating';
            const renderHoverStars = (currentR) => {
                ratingBox.innerHTML = '';
                for (let i = 1; i <= 5; i++) {
                    const s = document.createElement('span');
                    s.className = `gnp-hover-star ${i <= currentR ? 'active' : ''}`;
                    s.textContent = i <= currentR ? '★' : '☆';
                    s.title = `设置 ${i} 星`;
                    s.onclick = (e) => {
                        e.stopPropagation();
                        if (favIdx > -1) {
                            favorites[favIdx].rating = i;
                            saveFavorites('fav_list');
                            renderHoverStars(i);
                            // 若侧边栏收藏面板可见，同步刷新以更新列表上的星星
                            if (panelFav && panelFav.classList.contains('active')) renderFavorites();
                        }
                    };
                    ratingBox.appendChild(s);
                }
            };
            renderHoverStars(Number(favObj.rating) || 1);
            gnpHoverPreviewToolbarEl.appendChild(ratingBox);

            // [新增] 文件夹名（星级右侧；不显示“所属文件夹”字样）
            if (currentFolderName) {
                const folderBadge = document.createElement('span');
                folderBadge.className = 'gnp-hover-folder-badge';
                folderBadge.textContent = gnpTruncateFolderName(currentFolderName);
                folderBadge.style.cssText = 'max-width: 200px; height: 20px; display: inline-flex; align-items: center; padding: 0 8px; border-radius: 999px; font-size: 11px; line-height: 1; color: var(--gnp-text-sub); background: rgba(16,185,129,0.12); border: 1px solid rgba(16,185,129,0.22); box-shadow: 0 1px 2px rgba(0,0,0,0.04); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: none; pointer-events: none;';
                gnpHoverPreviewToolbarEl.appendChild(folderBadge);
            }



            // [新增] 如果已收藏，添加更改文件夹按钮（放在使用次数左边）
            const moveFolderBtn = makeMiniBtn({
                cls: '',
                title: '更改所属文件夹',
                html: SVGS.folderMove,
                onClick: (e) => {
                    if (e) e.stopPropagation();
                    const currentFolder = favObj.folder || '默认';
                    gnpMoveFavoriteToFolderFromHover(t, currentFolder);
                }
            });
            gnpHoverPreviewToolbarEl.appendChild(moveFolderBtn);
        }

        // 统计信息（最近使用时间）
        try {
            const lu = Number(getPromptLastUsed(t)) || 0;
            const meta = document.createElement('span');
            meta.className = 'gnp-hover-use-meta';
            
            // [优化] 如果是收藏项，额外显示使用次数，格式与收藏面板保持一致
            if (isFav && favObj) {
                 const uc = Number(favObj.useCount) || 0;
                 meta.textContent = `${uc}次 · ${formatRelativeTimeNav(lu)}`;
            } else {
                 meta.textContent = formatRelativeTimeNav(lu);
            }
            
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

        /* [修复] 复制不增加使用次数 */
        const copyBtn = makeMiniBtn({ cls: '', title: '复制', html: SVGS.copy, onClick: () => {
            navigator.clipboard.writeText(t);
            // recordPromptUse(t);  <-- 已移除
            copyBtn.innerHTML = SVGS.check;
            setTimeout(() => { try { copyBtn.innerHTML = SVGS.copy; } catch (_) {} }, 900);
        }});
        gnpHoverPreviewToolbarEl.appendChild(copyBtn);

        const starBtn = makeMiniBtn({ cls: `star-btn ${hasFavorite(t) ? 'is-fav' : ''}`, title: hasFavorite(t) ? '取消收藏' : '收藏', text: hasFavorite(t) ? '★' : '☆', onClick: () => {
            const isFav = hasFavorite(t);
            if (!isFav) {
                const targetFolderDefault = (favFolderFilter && favFolderFilter !== '全部') ? favFolderFilter : '默认';

                // 弹出“文件夹选择”弹层（全屏居中）
                showFavFolderPickerGlobal({
                    promptText: t,
                    defaultFolder: targetFolderDefault,
                    onConfirm: (folder, rating) => {
                        if (!addFavorite(t, folder, rating)) return;
                        saveFavorites();
                        showSidebarToast(`已收藏到「${folder}」`);

                        // 更新列表
                        if (panelFav && panelFav.classList.contains('active')) renderFavorites();
                        if (panelNav && panelNav.classList.contains('active')) refreshNav(true);

                        // 更新按钮状态（不重建弹窗也能更新）
                        const nowFav = hasFavorite(t);
                        starBtn.textContent = nowFav ? '★' : '☆';
                        starBtn.title = nowFav ? '取消收藏' : '收藏';
                        starBtn.classList.toggle('is-fav', nowFav);
                    }
                });
                return;
            }

            removeFavorite(t);
            saveFavorites();
            showSidebarToast('已取消收藏');

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
    locateBtn.style.cssText = 'background: rgba(139, 92, 246, 0.08); border-color: rgba(139, 92, 246, 0.20);';
    locateBtn.addEventListener('mouseenter', () => {
        locateBtn.style.background = 'rgba(139, 92, 246, 0.18)';
        locateBtn.style.color = '#8b5cf6';
        locateBtn.style.boxShadow = '0 0 0 2px rgba(139, 92, 246, 0.12), inset 0 1px 0 rgba(255,255,255,0.65), 0 8px 20px rgba(15,23,42,0.10)';
    });
    locateBtn.addEventListener('mouseleave', () => {
        locateBtn.style.background = 'rgba(139, 92, 246, 0.08)';
        locateBtn.style.color = '';
        locateBtn.style.boxShadow = '';
    });


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

    // v8.0新增：主题切换按钮
    const themeBtn = document.createElement('div');
    themeBtn.id = 'gemini-nav-theme';
    themeBtn.className = 'header-circle-btn theme-btn';
    themeBtn.textContent = '🌗';
    themeBtn.title = '主题切换 (自动/浅色/深色)';
    themeBtn.style.fontSize = '13px';

    headerControls.append(lockBtn, topBtn, bottomBtn, chatTopBtn, chatBottomBtn, autoSendBtn, clearBtn, themeBtn, locateBtn);

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
        console.log('[GNP] About to append sidebar to DOM...');
        console.log('[GNP] Sidebar children:', { collapsedIcon, header, searchContainer, contentWrapper, resizers: resizers.length });
        sidebar.append(collapsedIcon, header, searchContainer, contentWrapper, ...resizers);
        document.body.appendChild(sidebar);
        console.log('[GNP] ✅ Sidebar appended to body!');
        console.log('[GNP] Sidebar in DOM:', document.getElementById('gemini-nav-sidebar'));

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
    const STORAGE_KEY_THEME = 'gnp-theme-v8'; // v8.0新增：主题配置

    // ===== Debounce Storage机制 (v8.0新增) =====
    let storageQueue = {};
    let storageFlushTimer = null;

    function debouncedSetStorage(key, value, delay = 300) {
        storageQueue[key] = value;
        clearTimeout(storageFlushTimer);
        storageFlushTimer = setTimeout(() => {
            flushStorage();
        }, delay);
    }

    function flushStorage() {
        try {
            for (const [key, value] of Object.entries(storageQueue)) {
                localStorage.setItem(key, JSON.stringify(value));
            }
            storageQueue = {};
        } catch (e) {
            console.warn('[GNP] Storage flush failed:', e);
        }
    }

    // 确保页面卸载时写入
    window.addEventListener('beforeunload', flushStorage);


    const STORAGE_KEY_FOLDERS = 'gemini-nav-pro-panel-fav-folders';
    const STORAGE_KEY_FAV_FOLDER_FILTER = 'gemini-nav-pro-panel-fav-folder-filter';

// 收藏面板：文件夹筛选属于“标签页级别”的 UI 状态（每个标签页可独立切换）
// 注意：不得写入 localStorage 或 shared-state，否则会导致“一个标签页切换文件夹，所有标签页一起切换”
const STORAGE_KEY_FAV_FOLDER_FILTER_SESSION = 'gnp-fav-folder-filter-session-v1';

function gnpGetTabFavFolderFilter() {
    try {
        const v = sessionStorage.getItem(STORAGE_KEY_FAV_FOLDER_FILTER_SESSION);
        return String(v || '').trim();
    } catch (_) { return ''; }
}

function gnpSetTabFavFolderFilter(v) {
    try {
        const s = String(v || '').trim() || '全部';
        sessionStorage.setItem(STORAGE_KEY_FAV_FOLDER_FILTER_SESSION, s);
    } catch (_) {}
}


    let folders = JSON.parse(localStorage.getItem(STORAGE_KEY_FOLDERS)) || ['默认'];
    folders = [...new Set(folders.map(f => String(f || '').trim()).filter(Boolean))];
    if (!folders.includes('默认')) folders.unshift('默认');
    const saveFolders = () => {
        localStorage.setItem(STORAGE_KEY_FOLDERS, JSON.stringify(folders));
        gnpPersistSharedState('folders');
        try { gnpScheduleWriteFavoritesJsonFile("folders"); } catch (_) {}
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

    let favFolderFilter = gnpGetTabFavFolderFilter() || '';
    if (!favFolderFilter) {
        // [修改] 新标签页/无会话记录时，强制默认显示“全部”
        favFolderFilter = '全部';
        gnpSetTabFavFolderFilter(favFolderFilter);
    }


    // 导航使用记录（用于在“目录”面板展示最近使用时间；key 为 prompt 的哈希，避免把长文本直接当作对象 key）
    let usageStats = {};
    try {
        usageStats = JSON.parse(localStorage.getItem(STORAGE_KEY_USAGE) || '{}') || {};
    } catch (_) { usageStats = {}; }
    if (!usageStats || typeof usageStats !== 'object' || Array.isArray(usageStats)) usageStats = {};

    // === Shared favorites across tabs / origins / Chrome instances (via chrome.storage) ===
    // 目标：同一 Chrome Profile 下，多个标签页/窗口（甚至不同站点：Gemini/ChatGPT/Claude）收藏实时一致。
    // 修复点：旧实现用单个 updatedAt 判断，usageStats 等“无关字段写入”会让其它标签页忽略收藏更新，
    // 甚至用旧快照覆盖新收藏，导致“新增/删除不同步、删除被复活”。
    // v2 方案：
    // 1) 分区时间戳：favList / favMeta / folders / filter / usage 各自独立
    // 2) 写入采用“读-合并-写”(merge)，避免旧快照覆盖
    // 3) 删除 tombstone（deletedFavorites）保证删除不会被旧数据复活

    const GNP_SHARED_STATE_KEY = 'ai-chat-navigator-shared-state-v1';
    const GNP_SHARED_FOLDERS_KEY = 'ai-chat-navigator-shared-folders-v1'; // sync-lite: folders only

    // === Favorites JSON file sync (Local file via Native Messaging) ===
    // NOTE: These constants/state must exist BEFORE chrome.storage.onChanged listener
    // to avoid TDZ errors and missing a one-shot broadcast update during page bootstrap.
    const GNP_FAV_FILE_BCAST_KEY = 'gnp_fav_file_bcast_v1';
    const GNP_FAV_FILE_POLL_LEADER_KEY = 'gnp_fav_file_poll_leader_v1';

    // File-sync runtime state (declared early to avoid TDZ if a broadcast arrives during bootstrap)
    let gnpFavFileLastSeenHash = '';
    let gnpFavFileReloadTimer = null;
    let gnpApplyingFileSnapshot = false;
    // Last file broadcast payload (for deciding whether this reload was triggered by an external file edit)
    let gnpLastFavFileBcast = null;
    // If a user-triggered change happens while we are applying a file snapshot,
    // we defer the file write and flush it right after apply completes.
    let gnpFavFileWritePendingReason = null;

    // Per-tab instance id (used to de-duplicate self-triggered file broadcasts)
    const gnpInstanceId = (() => {
        try {
            const k = 'gnp_instance_id_v1';
            const v = sessionStorage.getItem(k);
            if (v) return v;
            const id = 'tab_' + Math.random().toString(16).slice(2) + '_' + Date.now().toString(16);
            sessionStorage.setItem(k, id);
            return id;
        } catch (_) {
            return 'tab_' + Math.random().toString(16).slice(2);
        }
    })();


    const gnpChrome = (typeof chrome !== 'undefined') ? chrome : null;
    const gnpStorageSync = gnpChrome && gnpChrome.storage && gnpChrome.storage.sync;
    const gnpStorageLocal = gnpChrome && gnpChrome.storage && gnpChrome.storage.local;

    // 默认优先使用 sync（跨设备/不同 Chrome 实例）；若不可用或超限则降级 local
    let gnpStorageArea = gnpStorageSync || gnpStorageLocal || null;

    // --- MV3 service worker keep-alive for favorites.json external-change polling ---
    // Background tabs throttle timers heavily. We keep the SW alive via a port so background.js can poll
    // favorites.json and broadcast updates reliably.
    let gnpKeepAlivePort = null;
    let gnpKeepAliveTimer = null;
    function gnpStartServiceWorkerKeepAlive() {
        try {
            if (!IS_EXTENSION || !gnpChrome || !gnpChrome.runtime || typeof gnpChrome.runtime.connect !== 'function') return;
            if (gnpKeepAlivePort) return;
            gnpKeepAlivePort = gnpChrome.runtime.connect({ name: 'gnp_fav_file_watch' });
            gnpKeepAliveTimer = setInterval(() => {
                try { gnpKeepAlivePort && gnpKeepAlivePort.postMessage({ type: 'ping', ts: Date.now() }); } catch (_) {}
            }, 25000);
            gnpKeepAlivePort.onDisconnect.addListener(() => {
                try { clearInterval(gnpKeepAliveTimer); } catch (_) {}
                gnpKeepAliveTimer = null;
                gnpKeepAlivePort = null;
                setTimeout(() => { try { gnpStartServiceWorkerKeepAlive(); } catch (_) {} }, 1500);
            });
        } catch (_) {}
    }

    try { gnpStartServiceWorkerKeepAlive(); } catch (_) {}

    let gnpApplyingSharedState = false;

    // If user actions happen while we are applying a shared-state update (gnpApplyingSharedState === true),
    // do NOT drop the persist. Queue it and flush shortly after apply finishes.
    let gnpPersistPendingMode = null;
    let gnpPersistPendingTimer = null;

    // If storage.onChanged fires while we are applying shared-state (gnpApplyingSharedState === true),
    // do NOT drop the incoming update. Queue the latest values and apply them right after.
    let gnpApplyPendingFull = null;
    let gnpApplyPendingFoldersLite = null;
    let gnpApplyPendingFavFileBcast = null;
    let gnpApplyPendingTimer = null;


    function gnpMergePersistMode(a, b) {
        const A = String(a || '').trim();
        const B = String(b || '').trim();
        if (!A) return B || 'all';
        if (!B) return A || 'all';
        // filter is per-tab only, never sync
        if (A === 'filter') return B;
        if (B === 'filter') return A;
        if (A === B) return A;
        if (A === 'all' || B === 'all') return 'all';

        // fav_list covers favorites + folders
        if (A === 'fav_list' || B === 'fav_list') {
            const other = (A === 'fav_list') ? B : A;
            // usage mixed with favorites -> safest to write all
            if (other === 'usage') return 'all';
            return 'fav_list';
        }

        // folders + favorites meta/list -> treat as list-level update
        const aIsFav = A.indexOf('fav_') === 0;
        const bIsFav = B.indexOf('fav_') === 0;
        if ((A === 'folders' && bIsFav) || (B === 'folders' && aIsFav)) return 'fav_list';

        // usage mixed with anything -> all
        if (A === 'usage' || B === 'usage') return 'all';

        // fallback: write all (safe)
        return 'all';
    }

    function gnpQueuePersistSharedState(mode) {
        try {
            if (String(mode || '') === 'filter') return; // never sync filter
            gnpPersistPendingMode = gnpMergePersistMode(gnpPersistPendingMode, mode);
            clearTimeout(gnpPersistPendingTimer);
            gnpPersistPendingTimer = setTimeout(() => {
                const m = gnpPersistPendingMode;
                gnpPersistPendingMode = null;
                gnpPersistPendingTimer = null;
                try { if (m) gnpPersistSharedState(m); } catch (_) {}
            }, 180);
        } catch (_) {}
    }


    // 分区更新时间戳（本标签页已应用到的最大值）
    let gnpSharedFavListAt = 0;
    let gnpSharedFavMetaAt = 0;
    let gnpSharedFoldersAt = 0;
    let gnpSharedFilterAt = 0;
    let gnpSharedUsageAt = 0;

    // 删除墓碑：text -> deletedAt（删除必须全局一致，且不得被旧快照复活）
    let deletedFavorites = {};

    // 复活标记：text -> restoredAt（用于覆盖 deletedFavorites，允许同一 Prompt 重新收藏）
    let restoredFavorites = {};

    // 删除墓碑：folderName -> deletedAt（删除文件夹必须全局一致，且不得被旧快照复活）
    let deletedFolders = {};


    // 复活标记：folderName -> restoredAt（用于覆盖 deletedFolders，允许同名文件夹重新创建）
    let restoredFolders = {};
    function gnpNow() { return Date.now(); }

    function gnpNormalizeSharedState(st) {
        const out = (st && typeof st === 'object') ? { ...st } : {};
        const v = Number(out.v || 1) || 1;
        const legacyTs = Number(out.updatedAt || 0) || 0;

        // v1 兼容：没有分区字段时，用 updatedAt 填充
        if (!('favListUpdatedAt' in out)) out.favListUpdatedAt = legacyTs;
        if (!('favMetaUpdatedAt' in out)) out.favMetaUpdatedAt = legacyTs;
        if (!('foldersUpdatedAt' in out)) out.foldersUpdatedAt = legacyTs;
        if (!('filterUpdatedAt' in out)) out.filterUpdatedAt = legacyTs;
        if (!('usageUpdatedAt' in out)) out.usageUpdatedAt = legacyTs;

        // 数据结构兜底
        if (!Array.isArray(out.favorites)) out.favorites = [];
        if (!Array.isArray(out.folders)) out.folders = ['默认'];
        if (typeof out.favFolderFilter !== 'string') out.favFolderFilter = '全部';
        if (!out.usageStats || typeof out.usageStats !== 'object' || Array.isArray(out.usageStats)) out.usageStats = {};
        if (!out.deletedFavorites || typeof out.deletedFavorites !== 'object' || Array.isArray(out.deletedFavorites)) out.deletedFavorites = {};
        if (!out.restoredFavorites || typeof out.restoredFavorites !== 'object' || Array.isArray(out.restoredFavorites)) out.restoredFavorites = {};

        if (!out.deletedFolders || typeof out.deletedFolders !== 'object' || Array.isArray(out.deletedFolders)) out.deletedFolders = {};
        if (!out.restoredFolders || typeof out.restoredFolders !== 'object' || Array.isArray(out.restoredFolders)) out.restoredFolders = {};


        // 计算总 updatedAt（用于调试/兼容）
        out.updatedAt = Math.max(
            Number(out.updatedAt || 0) || 0,
            Number(out.favListUpdatedAt || 0) || 0,
            Number(out.favMetaUpdatedAt || 0) || 0,
            Number(out.foldersUpdatedAt || 0) || 0,
            Number(out.filterUpdatedAt || 0) || 0,
            Number(out.usageUpdatedAt || 0) || 0,
        );

        out.v = (v >= 2) ? v : 2;
        return out;
    }

    function gnpPruneByTsMap(mapObj, maxItems = 3000) {
        try {
            const entries = Object.entries(mapObj || {}).map(([k, v]) => [k, Number(v) || 0]).filter(([,ts]) => ts > 0);
            if (entries.length <= maxItems) return Object.fromEntries(entries);
            entries.sort((a,b)=>b[1]-a[1]);
            return Object.fromEntries(entries.slice(0, maxItems));
        } catch (_) { return mapObj || {}; }
    }

    function gnpMergeTombstones(a, b) {
        const out = { ...(a && typeof a === 'object' ? a : {}) };
        if (b && typeof b === 'object') {
            for (const [k, v] of Object.entries(b)) {
                const t = String(k || '').trim();
                if (!t) continue;
                const ts = Number(v) || 0;
                if (!ts) continue;
                const prev = Number(out[t]) || 0;
                if (ts > prev) out[t] = ts;
            }
        }
        return out;
    }

    // Apply restores to tombstones: if restoredAt >= deletedAt, the tombstone is cleared.
    // This is required so a previously deleted Prompt can be re-favorited without being
    // immediately removed by older tombstones from another tab/instance.
    function gnpApplyRestoresToTombstones(tombstones, restores) {
        const tomb = (tombstones && typeof tombstones === 'object') ? { ...tombstones } : {};
        const rev = (restores && typeof restores === 'object') ? restores : {};
        try {
            for (const [k, v] of Object.entries(rev)) {
                const t = String(k || '').trim();
                if (!t) continue;
                const res = Number(v) || 0;
                if (!res) continue;
                const del = Number(tomb[t]) || 0;
                if (del > 0 && res >= del) delete tomb[t];
            }
        } catch (_) {}
        return tomb;
    }

    function gnpNormalizeFavItem(it) {
        if (!it) return null;
        const t = String((it.text ?? it.t) || '').trim();
        if (!t) return null;
        const folder = String((it.folder ?? it.f) || '默认').trim() || '默认';
        const useCount = parseInt((it.useCount ?? it.uc) || 0, 10) || 0;
        const lastUsed = Number((it.lastUsed ?? it.lu) || 0) || 0;
        let rating = parseInt((it.rating ?? it.r ?? 1), 10);
        if (isNaN(rating) || rating < 1) rating = 1;
        if (rating > 5) rating = 5;
        return { text: t, folder, useCount, lastUsed, rating };
    }

    function gnpMergeFavorites(baseArr, localArr, tombstones) {
        const base = Array.isArray(baseArr) ? baseArr : [];
        const local = Array.isArray(localArr) ? localArr : [];
        const tomb = (tombstones && typeof tombstones === 'object') ? tombstones : {};

        const map = new Map();
        const baseOrder = [];
        const localOrder = [];

        for (const it of base) {
            const obj = gnpNormalizeFavItem(it);
            if (!obj) continue;
            if (map.has(obj.text)) continue;
            map.set(obj.text, obj);
            baseOrder.push(obj.text);
        }

        for (const it of local) {
            const obj = gnpNormalizeFavItem(it);
            if (!obj) continue;
            localOrder.push(obj.text);
            if (!map.has(obj.text)) {
                map.set(obj.text, obj);
            } else {
                const prev = map.get(obj.text);
                // 冲突策略：folder 取 local；useCount/lastUsed 取最大
                prev.folder = obj.folder || prev.folder || '默认';
                prev.useCount = Math.max(Number(prev.useCount)||0, Number(obj.useCount)||0);
                prev.lastUsed = Math.max(Number(prev.lastUsed)||0, Number(obj.lastUsed)||0);
                prev.rating = obj.rating || prev.rating || 1;
                map.set(obj.text, prev);
            }
        }

        // 过滤 tombstone
        const alive = (t) => !(tomb && tomb[t] && Number(tomb[t]) > 0);

        const out = [];
        const added = new Set();
        for (const t of localOrder) {
            if (added.has(t)) continue;
            if (!alive(t)) continue;
            const obj = map.get(t);
            if (!obj) continue;
            out.push(obj);
            added.add(t);
        }
        for (const t of baseOrder) {
            if (added.has(t)) continue;
            if (!alive(t)) continue;
            const obj = map.get(t);
            if (!obj) continue;
            out.push(obj);
            added.add(t);
        }

        return out;
    }

    function gnpNormalizeFolders(list) {
        let arr = Array.isArray(list) ? list : ['默认'];
        arr = [...new Set(arr.map(f => String(f || '').trim()).filter(Boolean))];
        if (!arr.includes('默认')) arr.unshift('默认');
        return arr;
    }

    function gnpMergeFolders(baseFolders, localFolders, favArr, folderTombstones, folderRestores) {
        const tomb = (folderTombstones && typeof folderTombstones === 'object') ? folderTombstones : {};
        const rev = (folderRestores && typeof folderRestores === 'object') ? folderRestores : {};
        const out = [];
        const seen = new Set();
        const alive = (f) => {
            const s = String(f || '').trim();
            if (!s) return false;
            if (s === '默认') return true;
            const del = Number(tomb[s]) || 0;
            const res = Number(rev[s]) || 0;
            // 若复活时间晚于删除时间，则认为该文件夹仍有效
            if (res > del) return true;
            return del <= 0;
        };
        const push = (f) => {
            const s = String(f || '').trim();
            if (!s) return;
            if (!alive(s)) return;
            if (seen.has(s)) return;
            seen.add(s);
            out.push(s);
        };
        gnpNormalizeFolders(baseFolders).forEach(push);
        gnpNormalizeFolders(localFolders).forEach(push);
        (Array.isArray(favArr) ? favArr : []).forEach(it => {
            const obj = gnpNormalizeFavItem(it);
            if (obj) push(obj.folder || '默认');
        });
        if (!out.includes('默认')) out.unshift('默认');
        // 确保“默认”在首位
        const idx = out.indexOf('默认');
        if (idx > 0) { out.splice(idx,1); out.unshift('默认'); }
        return out;
    }

    function gnpMergeUsage(baseUsage, localUsage) {
        const out = { ...(baseUsage && typeof baseUsage === 'object' ? baseUsage : {}) };
        const src = (localUsage && typeof localUsage === 'object') ? localUsage : {};
        for (const [k, v] of Object.entries(src)) {
            const ts = Number(v) || 0;
            if (!ts) continue;
            const prev = Number(out[k]) || 0;
            if (ts > prev) out[k] = ts;
        }
        // 裁剪，避免爆表
        return gnpPruneByTsMap(out, 2000);
    }

    function gnpEnsureValidFavFolderFilter() {
        try { favFolderFilter = String(favFolderFilter || '').trim() || '全部'; } catch (_) { favFolderFilter = '全部'; }
        if (favFolderFilter === '全部' || favFolderFilter === '默认') return false;
        if (!Array.isArray(folders) || !folders.includes(favFolderFilter)) {
            favFolderFilter = '默认';
            gnpSetTabFavFolderFilter(favFolderFilter);
            return true;
        }
        return false;
    }

    function gnpApplySharedState(state, force = false) {
        const st = gnpNormalizeSharedState(state);
        let changed = false;

        // favorites（list/meta 任一更新都需要同步 favorites + tombstone）
        if (force || (Number(st.favListUpdatedAt)||0) > gnpSharedFavListAt || (Number(st.favMetaUpdatedAt)||0) > gnpSharedFavMetaAt) {

            // 合并 tombstones/restore：保留本标签页尚未写入 shared 的删除/复活记录，避免“清空/删除”被覆盖

            const localDelFav = (deletedFavorites && typeof deletedFavorites === 'object' && !Array.isArray(deletedFavorites)) ? deletedFavorites : {};

            const localResFav = (restoredFavorites && typeof restoredFavorites === 'object' && !Array.isArray(restoredFavorites)) ? restoredFavorites : {};

            const localDelFolders = (deletedFolders && typeof deletedFolders === 'object' && !Array.isArray(deletedFolders)) ? deletedFolders : {};

            const localResFolders = (restoredFolders && typeof restoredFolders === 'object' && !Array.isArray(restoredFolders)) ? restoredFolders : {};


            deletedFavorites = gnpPruneByTsMap(gnpMergeTombstones(st.deletedFavorites || {}, localDelFav), 5000);

            restoredFavorites = gnpPruneByTsMap(gnpMergeTombstones(st.restoredFavorites || {}, localResFav), 5000);

            deletedFavorites = gnpApplyRestoresToTombstones(deletedFavorites, restoredFavorites);

            deletedFolders = gnpPruneByTsMap(gnpMergeTombstones(st.deletedFolders || {}, localDelFolders), 2000);

            restoredFolders = gnpPruneByTsMap(gnpMergeTombstones(st.restoredFolders || {}, localResFolders), 2000);


            // favorites：从 shared-state 合并到本标签页本地列表，避免并发写入时“后写覆盖先写”导致丢收藏

            const localFav = Array.isArray(favorites) ? favorites : [];

            const remoteFav = gnpMergeFavorites(st.favorites || [], st.favorites || [], deletedFavorites);

			// 修改后：让 remoteFav (arg2) 覆盖 localFav (arg1) 的属性
			const mergedFav = gnpMergeFavorites(localFav, remoteFav, deletedFavorites);	

            favorites = mergedFav;


            // 若合并结果与远端不同（新增/删除/tombstone 差异），主动回写 shared-state，修复读-改-写竞态导致的丢数据

            try {

                const rset = new Set((remoteFav || []).map(x => x && x.text).filter(Boolean));

                const mset = new Set((mergedFav || []).map(x => x && x.text).filter(Boolean));

                let needHeal = (rset.size !== mset.size);

                if (!needHeal) { for (const t of mset) { if (!rset.has(t)) { needHeal = true; break; } } }

                if (!needHeal) {

                    const rd = gnpPruneByTsMap((st.deletedFavorites && typeof st.deletedFavorites === 'object' && !Array.isArray(st.deletedFavorites)) ? st.deletedFavorites : {}, 5000);

                    const rr = gnpPruneByTsMap((st.restoredFavorites && typeof st.restoredFavorites === 'object' && !Array.isArray(st.restoredFavorites)) ? st.restoredFavorites : {}, 5000);

                    if (!gnpEqualTsMap(rd, deletedFavorites || {}) || !gnpEqualTsMap(rr, restoredFavorites || {})) needHeal = true;

                }

                if (!force && needHeal) gnpQueuePersistSharedState('fav_list');

            } catch (_) {}

            // folders 可能由 fav 引入新 folder：先不改 foldersAt，这里只补齐
            let nextFolders = gnpNormalizeFolders(st.folders || ['默认']);
            mergedFav.forEach(f => { if (f && f.folder && !nextFolders.includes(f.folder)) nextFolders.push(f.folder); });
            // 过滤已删除文件夹（tombstone），并保证“默认”存在且在首位
            nextFolders = gnpMergeFolders([], nextFolders, mergedFav, deletedFolders, restoredFolders);
            folders = nextFolders;

            gnpSharedFavListAt = Math.max(gnpSharedFavListAt, Number(st.favListUpdatedAt)||0);
            gnpSharedFavMetaAt = Math.max(gnpSharedFavMetaAt, Number(st.favMetaUpdatedAt)||0);
            changed = true;

            // 回写 localStorage（站点缓存/兼容旧逻辑）
            try { localStorage.setItem(STORAGE_KEY_FAV, JSON.stringify(favorites.map(f => ({ text: f.text, folder: f.folder, useCount: Number(f.useCount)||0, lastUsed: Number(f.lastUsed)||0 })))); } catch (_) {}
            try { localStorage.setItem(STORAGE_KEY_FOLDERS, JSON.stringify(folders)); } catch (_) {}
            try { if (gnpEnsureValidFavFolderFilter()) changed = true; } catch (_) {}
        }

        // folders
        if (force || (Number(st.foldersUpdatedAt)||0) > gnpSharedFoldersAt) {
            deletedFolders = gnpPruneByTsMap(st.deletedFolders || {}, 2000);
            restoredFolders = gnpPruneByTsMap(st.restoredFolders || {}, 2000);
            let nextFolders = gnpNormalizeFolders(st.folders || ['默认']);
            favorites.forEach(f => { if (f && f.folder && !nextFolders.includes(f.folder)) nextFolders.push(f.folder); });
            // 过滤已删除文件夹（tombstone），并保证“默认”存在且在首位
            nextFolders = gnpMergeFolders([], nextFolders, favorites, deletedFolders, restoredFolders);
            folders = nextFolders;
            gnpSharedFoldersAt = Math.max(gnpSharedFoldersAt, Number(st.foldersUpdatedAt)||0);
            changed = true;
            try { localStorage.setItem(STORAGE_KEY_FOLDERS, JSON.stringify(folders)); } catch (_) {}
            try { if (gnpEnsureValidFavFolderFilter()) changed = true; } catch (_) {}
        }

        // filter（UI-only per-tab）：不从 shared-state 同步，避免“一个标签页切换文件夹导致所有标签页跟着切换”
        if (force || (Number(st.filterUpdatedAt)||0) > gnpSharedFilterAt) {
            gnpSharedFilterAt = Math.max(gnpSharedFilterAt, Number(st.filterUpdatedAt)||0);
            // keep local favFolderFilter unchanged
        }

        // usageStats
        if (force || (Number(st.usageUpdatedAt)||0) > gnpSharedUsageAt) {
            usageStats = (st.usageStats && typeof st.usageStats === 'object' && !Array.isArray(st.usageStats)) ? st.usageStats : {};
            gnpSharedUsageAt = Math.max(gnpSharedUsageAt, Number(st.usageUpdatedAt)||0);
            changed = true;
            try { localStorage.setItem(STORAGE_KEY_USAGE, JSON.stringify(usageStats)); } catch (_) {}
        }

        if (changed) {
            try { gnpScheduleWriteFavoritesJsonFile('shared'); } catch (_) {}
        }
        return changed;
    }

    function gnpApplyFoldersLite(liteState, force = false) {
        const st = (liteState && typeof liteState === 'object') ? liteState : null;
        if (!st || !Array.isArray(st.folders)) return false;

        const ts = Number(st.foldersUpdatedAt || st.updatedAt || 0) || 0;
        if (!force && ts <= gnpSharedFoldersAt) return false;

        // liteState 可能携带 folder 删除/复活信息（用于空文件夹 & 同名复活同步）
        try {
            if (st.deletedFolders && typeof st.deletedFolders === 'object' && !Array.isArray(st.deletedFolders)) {
                deletedFolders = gnpPruneByTsMap(gnpMergeTombstones(deletedFolders, st.deletedFolders), 2000);
            }
            if (st.restoredFolders && typeof st.restoredFolders === 'object' && !Array.isArray(st.restoredFolders)) {
                restoredFolders = gnpPruneByTsMap(gnpMergeTombstones(restoredFolders, st.restoredFolders), 2000);
            }
        } catch (_) {}

        let nextFolders = gnpNormalizeFolders(st.folders || ['默认']);
        favorites.forEach(f => { if (f && f.folder && !nextFolders.includes(f.folder)) nextFolders.push(f.folder); });
        nextFolders = gnpMergeFolders([], nextFolders, favorites, deletedFolders, restoredFolders);
        folders = nextFolders;

        gnpSharedFoldersAt = Math.max(gnpSharedFoldersAt, ts);
        try { localStorage.setItem(STORAGE_KEY_FOLDERS, JSON.stringify(folders)); } catch (_) {}
        try { gnpEnsureValidFavFolderFilter(); } catch (_) {}
        return true;
    }


    function gnpStorageGet(area) {
        return new Promise((resolve) => {
            if (!area) return resolve(null);
            try {
                area.get([GNP_SHARED_STATE_KEY], (res) => resolve(res && res[GNP_SHARED_STATE_KEY]));
            } catch (_) { resolve(null); }
        });
    }

    function gnpStorageSet(area, state) {
        return new Promise((resolve) => {
            if (!area) return resolve({ ok: false, error: 'no_storage' });
            try {
                area.set({ [GNP_SHARED_STATE_KEY]: state }, () => {
                    const err = gnpChrome && gnpChrome.runtime && gnpChrome.runtime.lastError;
                    if (err) return resolve({ ok: false, error: String(err && err.message || err) });
                    resolve({ ok: true });
                });
            } catch (e) {
                resolve({ ok: false, error: String(e && e.message || e) });
            }
        });
    }

    // --- sync-lite: folders only (avoid sync quota issues for full shared state) ---
    function gnpStorageGetKey(area, key) {
        return new Promise((resolve) => {
            if (!area || !key) return resolve(null);
            try {
                area.get([key], (res) => resolve(res && res[key]));
            } catch (_) { resolve(null); }
        });
    }

    function gnpStorageSetKey(area, key, value) {
        return new Promise((resolve) => {
            if (!area || !key) return resolve({ ok: false, error: 'no_storage' });
            try {
                area.set({ [key]: value }, () => {
                    const err = gnpChrome && gnpChrome.runtime && gnpChrome.runtime.lastError;
                    if (err) return resolve({ ok: false, error: String(err && err.message || err) });
                    resolve({ ok: true });
                });
            } catch (e) {
                resolve({ ok: false, error: String(e && e.message || e) });
            }
        });
    }

    async function gnpTryWriteFoldersLite(foldersArr, foldersAt, delMap, restoreMap) {
        const at = Number(foldersAt) || gnpNow();
        const payload = {
            v: 1,
            folders: gnpNormalizeFolders(foldersArr || ['默认']),
            foldersUpdatedAt: at,
            updatedAt: at,
            deletedFolders: gnpSortObjectKeys(gnpPruneByTsMap((delMap && typeof delMap === 'object' && !Array.isArray(delMap)) ? delMap : {}, 2000)),
            restoredFolders: gnpSortObjectKeys(gnpPruneByTsMap((restoreMap && typeof restoreMap === 'object' && !Array.isArray(restoreMap)) ? restoreMap : {}, 2000))
        };
        // best-effort: sync first for cross-window / cross-instance
        if (gnpStorageSync) { try { await gnpStorageSetKey(gnpStorageSync, GNP_SHARED_FOLDERS_KEY, payload); } catch (_) {} }
        // local as backup (large capacity, same-profile tabs)
        if (gnpStorageLocal) { try { await gnpStorageSetKey(gnpStorageLocal, GNP_SHARED_FOLDERS_KEY, payload); } catch (_) {} }
    }

    async function gnpReadFoldersLite() {
        let st = null;
        // prefer sync (cross-instance), fallback local
        if (gnpStorageSync) {
            st = await gnpStorageGetKey(gnpStorageSync, GNP_SHARED_FOLDERS_KEY);
            if (!st && gnpStorageLocal) st = await gnpStorageGetKey(gnpStorageLocal, GNP_SHARED_FOLDERS_KEY);
        } else if (gnpStorageLocal) {
            st = await gnpStorageGetKey(gnpStorageLocal, GNP_SHARED_FOLDERS_KEY);
        }
        return (st && typeof st === 'object') ? st : null;
    }


    async function gnpPersistSharedState(mode = 'all') {
        if (mode === 'filter') return; // UI-only per-tab: do not sync folder filter across tabs

        if (!gnpStorageArea) return;

        // If we are currently applying shared-state from another tab, queue this persist instead of dropping it.
        if (gnpApplyingSharedState) { gnpQueuePersistSharedState(mode); return; }

        // Ensure per-section timestamps are strictly monotonic even under cross-tab races.
        // If base already has a newer timestamp (e.g., another tab wrote between our now() and get()),
        // we bump it by +1 so other tabs won't ignore this update.
        const gnpBumpTs = (baseTs, candidateTs) => {
            const b = Number(baseTs) || 0;
            const c = Number(candidateTs) || 0;
            const m = Math.max(b, c);
            return (m <= b) ? (b + 1) : m;
        };

        // 设置标志，防止自己触发的storage.onChanged导致重新渲染
        gnpApplyingSharedState = true;
        try {

        // 读-改-写（RMW）在多标签页/多窗口下会有竞态：这里做“写前再读一次 + 最多重试”，避免后写覆盖先写。
        const MAX_ATTEMPTS = 4;
        let attempt = 0;

        const readShared = async () => {
            let st = null;
            if (gnpStorageSync) {
                st = await gnpStorageGet(gnpStorageSync);
                if (!st && gnpStorageLocal) st = await gnpStorageGet(gnpStorageLocal);
            } else {
                st = await gnpStorageGet(gnpStorageArea);
            }
            return gnpNormalizeSharedState(st);
        };

        while (attempt < MAX_ATTEMPTS) {
            const now = gnpNow();

            // 读：以 sync 优先
            const base = await readShared();

            // 合并 tombstones / restores（无论 mode，都要带上 base 的记录，避免复活/误删）
            const mergedTombsRaw = gnpPruneByTsMap(gnpMergeTombstones(base.deletedFavorites, deletedFavorites), 5000);
            const mergedRestores = gnpPruneByTsMap(gnpMergeTombstones(base.restoredFavorites, restoredFavorites), 5000);
            const mergedTombs = gnpApplyRestoresToTombstones(mergedTombsRaw, mergedRestores);

            const mergedFolderTombs = gnpPruneByTsMap(gnpMergeTombstones(base.deletedFolders, deletedFolders), 2000);
            const mergedFolderRestores = gnpPruneByTsMap(gnpMergeTombstones(base.restoredFolders, restoredFolders), 2000);

            const next = { ...base, v: 2, deletedFavorites: mergedTombs, restoredFavorites: mergedRestores, deletedFolders: mergedFolderTombs, restoredFolders: mergedFolderRestores };

            // 根据 mode 仅更新对应分区，其他分区使用 base 值，避免旧快照覆盖
            if (mode === 'usage') {
                next.usageStats = gnpMergeUsage(base.usageStats, usageStats);
                next.usageUpdatedAt = gnpBumpTs(base.usageUpdatedAt, now);
            } else if (mode === 'folders') {
                next.folders = gnpMergeFolders(base.folders, folders, base.favorites, mergedFolderTombs, mergedFolderRestores);
                next.foldersUpdatedAt = gnpBumpTs(base.foldersUpdatedAt, now);
            } else if (mode === 'filter') {
                next.favFolderFilter = String(favFolderFilter || '全部');
                next.filterUpdatedAt = now;
            } else if (mode === 'fav_meta') {
                // meta 更新：不改变列表结构，但会更新 useCount/lastUsed 等
                next.favorites = gnpMergeFavorites(base.favorites, favorites, mergedTombs);
                next.favMetaUpdatedAt = gnpBumpTs(base.favMetaUpdatedAt, now);
            } else if (mode === 'fav_list') {
                // list 更新：合并（避免丢失其它标签页新增） + tombstone 防复活
                next.favorites = gnpMergeFavorites(base.favorites, favorites, mergedTombs);
                next.favListUpdatedAt = gnpBumpTs(base.favListUpdatedAt, now);
                // folders 可能扩充
                next.folders = gnpMergeFolders(base.folders, folders, next.favorites, mergedFolderTombs, mergedFolderRestores);
                next.foldersUpdatedAt = gnpBumpTs(base.foldersUpdatedAt, now);
            } else {
                // all
                next.favorites = gnpMergeFavorites(base.favorites, favorites, mergedTombs);
                next.folders = gnpMergeFolders(base.folders, folders, next.favorites, mergedFolderTombs, mergedFolderRestores);
                next.favFolderFilter = String(favFolderFilter || '全部');
                next.usageStats = gnpMergeUsage(base.usageStats, usageStats);
                next.favListUpdatedAt = gnpBumpTs(base.favListUpdatedAt, now);
                next.favMetaUpdatedAt = gnpBumpTs(base.favMetaUpdatedAt, now);
                next.foldersUpdatedAt = gnpBumpTs(base.foldersUpdatedAt, now);
                next.filterUpdatedAt = gnpBumpTs(base.filterUpdatedAt, now);
                next.usageUpdatedAt = gnpBumpTs(base.usageUpdatedAt, now);
            }

            next.updatedAt = Math.max(
                Number(next.favListUpdatedAt||0),
                Number(next.favMetaUpdatedAt||0),
                Number(next.foldersUpdatedAt||0),
                Number(next.filterUpdatedAt||0),
                Number(next.usageUpdatedAt||0),
                now
            );

            // 写前再读一次：若 base 已过期（其它标签页刚写入），则基于最新 base 重算 next，避免覆盖
            try {
                const latest = await readShared();
                if ((Number(latest.updatedAt||0) > Number(base.updatedAt||0)) && attempt < MAX_ATTEMPTS - 1) {
                    attempt++;
                    continue;
                }
            } catch (_) {}

            // sync-lite: folders only (ensure folder create sync even if full state hits sync quota)
            try {
                if (mode === 'folders' || mode === 'all' || mode === 'fav_list') {
                    await gnpTryWriteFoldersLite(next.folders, next.foldersUpdatedAt, mergedFolderTombs, mergedFolderRestores);
                }
            } catch (_) {}

            // 写：优先 sync，并备份到 local；若 sync 失败则降级 local
            let ok = { ok: false };
            if (gnpStorageSync) {
                ok = await gnpStorageSet(gnpStorageSync, next);
                if (!ok.ok && gnpStorageLocal) {
                    gnpStorageArea = gnpStorageLocal;
                    ok = await gnpStorageSet(gnpStorageLocal, next);
                } else {
                    // 同步一份到 local 作为大容量备份
                    if (gnpStorageLocal) { try { await gnpStorageSet(gnpStorageLocal, next); } catch (_) {} }
                }
            } else {
                ok = await gnpStorageSet(gnpStorageArea, next);
            }

            // 更新本标签页已应用的时间戳（避免后续重复 apply）
            if (ok && ok.ok) {
                gnpSharedFavListAt = Math.max(gnpSharedFavListAt, Number(next.favListUpdatedAt)||0);
                gnpSharedFavMetaAt = Math.max(gnpSharedFavMetaAt, Number(next.favMetaUpdatedAt)||0);
                gnpSharedFoldersAt = Math.max(gnpSharedFoldersAt, Number(next.foldersUpdatedAt)||0);
                gnpSharedFilterAt = Math.max(gnpSharedFilterAt, Number(next.filterUpdatedAt)||0);
                gnpSharedUsageAt = Math.max(gnpSharedUsageAt, Number(next.usageUpdatedAt)||0);
            }

            break;
        }
} finally {
            // 延迟清除标志，确保storage.onChanged事件已经处理完
            setTimeout(() => { gnpApplyingSharedState = false; }, 100);
        }
    }

    function gnpBootstrapSharedState() {
        if (!gnpStorageArea) return;
        (async () => {
            let st = null;
            if (gnpStorageSync) {
                st = await gnpStorageGet(gnpStorageSync);
                if (!st && gnpStorageLocal) st = await gnpStorageGet(gnpStorageLocal);
            } else {
                st = await gnpStorageGet(gnpStorageArea);
            }

            if (st && st.favorites) {
                gnpApplyingSharedState = true;
                try { gnpApplySharedState(st, true); } finally { gnpApplyingSharedState = false; }
            } else {
                // 没有共享数据：用当前站点 localStorage 的数据初始化共享区
                await gnpPersistSharedState('all');
                try { gnpBootstrapFavoritesFromJsonFileOnce('shared-bootstrap'); } catch (_) {}
            }


            // sync-lite: folders only (if newer than full shared-state, apply it)
            try {
                const lite = await gnpReadFoldersLite();
                if (lite) {
                    gnpApplyingSharedState = true;
                    try {
                        const changedLite = gnpApplyFoldersLite(lite, true);
                        if (changedLite) {
                            try { renderFavorites(); } catch (_) {}
                            try { refreshNav(true); } catch (_) {}
                        }
                    } finally { gnpApplyingSharedState = false; }
                }
            } catch (_) {}

            try { renderFavorites(); } catch (_) {}
            try { refreshNav(true); } catch (_) {}
            try { gnpBootstrapFavoritesFromJsonFileOnce('shared-bootstrap'); } catch (_) {}
        })();
    }

    // 监听其他标签页/窗口对共享收藏的修改，并实时刷新当前面板
    try {
        if (gnpChrome && gnpChrome.storage && gnpChrome.storage.onChanged) {
            gnpChrome.storage.onChanged.addListener((changes, areaName) => {
                if (!changes) return;
                if (areaName !== 'sync' && areaName !== 'local') return;

                const nextFull = changes[GNP_SHARED_STATE_KEY] && changes[GNP_SHARED_STATE_KEY].newValue;
                const nextFoldersLite = changes[GNP_SHARED_FOLDERS_KEY] && changes[GNP_SHARED_FOLDERS_KEY].newValue;
                const nextFavFileBcast = changes[GNP_FAV_FILE_BCAST_KEY] && changes[GNP_FAV_FILE_BCAST_KEY].newValue;

                if (!nextFull && !nextFoldersLite && !nextFavFileBcast) return;

                const applyNow = (full, foldersLite, favFileBcast) => {
                    if (!full && !foldersLite && !favFileBcast) return;

                    gnpApplyingSharedState = true;
                    try {
                        let changed = false;

                        if (full) {
                            changed = gnpApplySharedState(full, false) || changed;
                        }
                        if (foldersLite) {
                            changed = gnpApplyFoldersLite(foldersLite, false) || changed;
                        }

                        if (changed) {
                            try { renderFavorites(); } catch (_) {}
                            try { refreshNav(true); } catch (_) {}
                        }

                        // 文件广播：任一页面写入本地 JSON 成功后，通知其它页面 reload（避免各页轮询）
                        if (favFileBcast && favFileBcast.ts) {
                            try {
                                const origin = String(favFileBcast.origin || '');
                                const bcastHash = String(favFileBcast.hash || '');
                                gnpLastFavFileBcast = favFileBcast;
                                if (origin && origin === gnpInstanceId) {
                                    // ignore self
                                } else {
                                    // 关键修复：如果广播的hash与本地hash不同，强制重载
                                    const trigger = (bcastHash && bcastHash !== gnpFavFileLastSeenHash) ? 'force' : 'bcast';
                                    gnpDebouncedReloadFavoritesFromJsonFile(trigger);
                                }
                            } catch (_) {}
                        }
                    } finally {
                        gnpApplyingSharedState = false;
                    }
                };

                // 若此刻正在 apply（例如刚刚处理了其它变更），不要丢弃本次变更：放入队列并稍后再 apply
                if (gnpApplyingSharedState) {
                    if (nextFull) gnpApplyPendingFull = nextFull;
                    if (nextFoldersLite) gnpApplyPendingFoldersLite = nextFoldersLite;
                    if (nextFavFileBcast) gnpApplyPendingFavFileBcast = nextFavFileBcast;

                    clearTimeout(gnpApplyPendingTimer);
                    gnpApplyPendingTimer = setTimeout(() => {
                        try {
                            if (gnpApplyingSharedState) return;

                            const pf = gnpApplyPendingFull;
                            const pl = gnpApplyPendingFoldersLite;
                            const pb = gnpApplyPendingFavFileBcast;

                            gnpApplyPendingFull = null;
                            gnpApplyPendingFoldersLite = null;
                            gnpApplyPendingFavFileBcast = null;
                            gnpApplyPendingTimer = null;

                            applyNow(pf, pl, pb);
                        } catch (_) {}
                    }, 180);
                    return;
                }

                applyNow(nextFull, nextFoldersLite, nextFavFileBcast);
            });
        }
    } catch (_) {}

    // 启动：异步拉取共享收藏
    gnpBootstrapSharedState();
// === Favorites JSON file sync (Local file via Native Messaging) ===
    // 重要说明：
    // - Chrome 扩展无法直接按“绝对路径”读写本地文件；这里采用 Native Messaging Host 作为桥接。
    // - manifest.json 顶层不允许自定义 key，因此 chrome.runtime.getManifest() 会“丢掉” gnp_* 字段。
    //   为了兼容你的“在 manifest.json 里写绝对路径”的需求，我们改为 fetch 读取原始 manifest.json。

    let GNP_FAV_JSON_PATH = '';
    let GNP_NATIVE_HOST_NAME = 'ai_chat_navigator_native';
    let gnpManifestCfgPromise = null;

    function gnpLoadManifestCfg() {
        try {
            if (!IS_EXTENSION || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
                return Promise.resolve({ path: GNP_FAV_JSON_PATH, host: GNP_NATIVE_HOST_NAME });
            }
            if (gnpManifestCfgPromise) return gnpManifestCfgPromise;

            gnpManifestCfgPromise = (async () => {
                // 1) 读取“原始 manifest.json”（包含自定义字段）
                try {
                    const url = chrome.runtime.getURL('manifest.json');
                    const resp = await fetch(url, { cache: 'no-store' });
                    const raw = await resp.json();
                    const p = String(raw?.gnp_favorites_json_path || '').trim();
                    const h = String(raw?.gnp_native_host_name || 'ai_chat_navigator_native').trim();
                    if (h) GNP_NATIVE_HOST_NAME = h;
                    if (p) GNP_FAV_JSON_PATH = p;
                } catch (_) {}

                // 2) fallback：若 fetch 失败，则尝试 getManifest（但多数情况下取不到自定义字段）
                try {
                    const mj = chrome.runtime.getManifest?.() || {};
                    const p2 = String(mj?.gnp_favorites_json_path || '').trim();
                    const h2 = String(mj?.gnp_native_host_name || '').trim();
                    if (h2) GNP_NATIVE_HOST_NAME = h2;
                    if (p2) GNP_FAV_JSON_PATH = p2;
                } catch (_) {}

                return { path: GNP_FAV_JSON_PATH, host: GNP_NATIVE_HOST_NAME };
            })();

            return gnpManifestCfgPromise;
        } catch (_) {
            return Promise.resolve({ path: GNP_FAV_JSON_PATH, host: GNP_NATIVE_HOST_NAME });
        }
    }

    function gnpGetFavJsonPath() { return String(GNP_FAV_JSON_PATH || '').trim(); }
    function gnpGetNativeHostName() { return String(GNP_NATIVE_HOST_NAME || 'ai_chat_navigator_native').trim(); }

    // 预热加载一次（不阻塞主逻辑）
    try { gnpLoadManifestCfg(); } catch (_) {}


    let gnpFileBootstrapDone = false;
    let gnpFileSyncWarned = false;
    let gnpFavFileWriteTimer = null;
    let gnpFavFileLastSnapshot = '';
let gnpFavFileLastAttemptSnapshot = '';
let gnpFavFileLastAttemptAt = 0;
let gnpFavFileWriteInFlight = false;
let gnpFavFilePollTimer = null;
let gnpFavFilePollLeaderTimer = null;

function gnpHashText(str) {
    // simple FNV-1a 32-bit
    try {
        let h = 0x811c9dc5;
        const s = String(str || '');
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return ('00000000' + h.toString(16)).slice(-8);
    } catch (_) { return ''; }
}

function gnpSortObjectKeys(obj) {
    try {
        const o = (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
        const keys = Object.keys(o).sort();
        const out = {};
        for (const k of keys) out[k] = o[k];
        return out;
    } catch (_) { return obj || {}; }
}


    function gnpToastSafe(msg) {
        try {
            if (typeof showSidebarToast === 'function') showSidebarToast(msg);
            else console.warn('[GNP] ' + msg);
        } catch (_) {}
    }

    function gnpSendMessagePromise(message) {
        return new Promise((resolve) => {
            try {
                if (!IS_EXTENSION || !chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
                    return resolve({ ok: false, error: 'Not in extension context' });
                }
                chrome.runtime.sendMessage(message, (resp) => {
                    const err = chrome.runtime.lastError;
                    if (err) return resolve({ ok: false, error: err.message || String(err) });
                    resolve(resp || { ok: false, error: 'Empty response' });
                });
            } catch (e) {
                resolve({ ok: false, error: e && e.message ? e.message : String(e) });
            }
        });
    }

    function gnpNormalizeFavoriteItem(it) {
        if (!it) return null;
        if (typeof it === 'string') {
            const t = String(it || '').trim();
            return t ? { text: t, folder: '默认', useCount: 0, lastUsed: 0 } : null;
        }
        if (typeof it !== 'object') return null;

        const t = String((it.text ?? it.t ?? it.prompt ?? it.p ?? it.content ?? it.c ?? '') || '').trim();
        if (!t) return null;
        const folder = String((it.folder ?? it.f ?? it.category ?? it.cat ?? '默认') || '默认').trim() || '默认';
        const useCount = parseInt((it.useCount ?? it.uc ?? it.count ?? it.cnt ?? 0) || 0, 10) || 0;
        const lastUsed = Number((it.lastUsed ?? it.lu ?? it.last ?? it.updatedAt ?? it.u ?? 0) || 0) || 0;
        let rating = parseInt((it.rating ?? it.r ?? 1), 10);
        if (isNaN(rating) || rating < 1) rating = 1;
        if (rating > 5) rating = 5;
        return { text: t, folder, useCount, lastUsed, rating };
    }

    function gnpExtractFavoritesFromAnyJson(obj) {
        // 允许以下输入：
        // 1) ["prompt1", "prompt2"]
        // 2) [{text, folder, useCount, lastUsed}, ...]
        // 3) { favorites:[...], folders:[...] }
        // 4) { prompts:[...]} / { items:[...]} 等
        let favArr = null;
        let folderArr = null;

        if (Array.isArray(obj)) {
            favArr = obj;
        } else if (obj && typeof obj === 'object') {
            favArr = obj.favorites || obj.prompts || obj.items || obj.data || obj.list || obj.favs || null;
            folderArr = obj.folders || obj.folderList || obj.cats || obj.categories || null;

            // 兼容：{ v, updatedAt, sharedState: {...} }
            if (!favArr && obj.sharedState && typeof obj.sharedState === 'object') {
                favArr = obj.sharedState.favorites || obj.sharedState.prompts || null;
                folderArr = folderArr || obj.sharedState.folders || null;
            }
        }

        const favoritesOut = [];
        const seen = new Set();
        if (Array.isArray(favArr)) {
            favArr.forEach((it) => {
                const f = gnpNormalizeFavoriteItem(it);
                if (!f) return;
                const key = f.text;
                if (seen.has(key)) return;
                seen.add(key);
                favoritesOut.push(f);
            });
        }

        const foldersOut = [];
        if (Array.isArray(folderArr)) {
            folderArr.forEach((x) => {
                const f = String(x || '').trim();
                if (f) foldersOut.push(f);
            });
        }

        return { favorites: favoritesOut, folders: foldersOut };
    }

    function gnpMergeFavoritesIntoCurrent(incoming) {
        const incFav = (incoming && Array.isArray(incoming.favorites)) ? incoming.favorites : [];
        const incFolders = (incoming && Array.isArray(incoming.folders)) ? incoming.folders : [];

        const existingMap = new Map();
        favorites.forEach((f) => existingMap.set(String(f.text || '').trim(), f));

        let added = 0;
        let updated = 0;

        // folders union
        const folderSet = new Set((folders || []).map((x) => String(x || '').trim()).filter(Boolean));
        incFolders.forEach((x) => { const v = String(x || '').trim(); if (v) folderSet.add(v); });
        incFav.forEach((f) => { const v = String(f.folder || '').trim(); if (v) folderSet.add(v); });

        if (!folderSet.has('默认')) folderSet.add('默认');
        const nextFolders = Array.from(folderSet);
        // 确保“默认”在最前
        nextFolders.sort((a,b)=> (a==='默认'?-1:(b==='默认'?1:0)));
        if (JSON.stringify(nextFolders) !== JSON.stringify(folders)) {
            folders = nextFolders;
        }

        // merge favorites with dedupe
        // 新导入的放到前面（保持导入列表顺序）
        for (let i = incFav.length - 1; i >= 0; i--) {
            const it = incFav[i];
            const t = String(it.text || '').trim();
            if (!t) continue;

            const folder = String(it.folder || '默认').trim() || '默认';
            const useCount = Number(it.useCount) || 0;
            const lastUsed = Number(it.lastUsed) || 0;
            let rating = Number(it.rating) || 1;

            const existing = existingMap.get(t);
            if (!existing) {
                favorites.unshift({ text: t, folder, useCount, lastUsed, rating });
                existingMap.set(t, favorites[0]);
                added++;
                continue;
            }

            // 元数据合并：不丢失更大的 useCount / 更近的 lastUsed
            const beforeFolder = existing.folder;
            const beforeUc = Number(existing.useCount) || 0;
            const beforeLu = Number(existing.lastUsed) || 0;

            // folder：若现有为默认且导入非默认，则采用导入；否则保留现有（避免覆盖用户本地整理）
            if ((beforeFolder === '默认' || !beforeFolder) && folder && folder !== '默认') {
                existing.folder = folder;
            }

            existing.useCount = Math.max(beforeUc, useCount);
            existing.lastUsed = Math.max(beforeLu, lastUsed);
            
            // rating：以本地为准，除非本地是默认(1)且导入的大于1
            if ((!existing.rating || existing.rating === 1) && rating > 1) {
                existing.rating = rating;
            }

            if (beforeFolder !== existing.folder || beforeUc !== existing.useCount || beforeLu !== existing.lastUsed) updated++;
        }

        // folders 中出现的新 folder，确保存在
        favorites.forEach((f) => {
            const ff = String(f.folder || '默认').trim() || '默认';
            if (!folders.includes(ff)) folders.push(ff);
        });

        const changed = (added > 0 || updated > 0);
        return { added, updated, changed };
    }

    function gnpBuildFavoritesFilePayload() {
    // 文件里存一份“可读性较好”的 JSON（方便手工编辑/备份）
    // 注意：包含删除墓碑（deletedFavorites），避免跨实例被旧快照复活。
    const favArr = favorites.map(f => ({
        text: String(f.text || '').trim(),
        folder: String(f.folder || '默认').trim() || '默认',
        useCount: Number(f.useCount) || 0,
        lastUsed: Number(f.lastUsed) || 0,
        rating: Number(f.rating) || 1
    })).filter(x => x.text);

    const folderArr = Array.isArray(folders) ? folders.slice() : ['默认'];

    const tombRaw = gnpPruneByTsMap((deletedFavorites && typeof deletedFavorites === 'object') ? deletedFavorites : {}, 5000);
    const favRestoreRaw = gnpPruneByTsMap((restoredFavorites && typeof restoredFavorites === 'object') ? restoredFavorites : {}, 5000);
    const tomb = gnpSortObjectKeys(gnpApplyRestoresToTombstones(tombRaw, favRestoreRaw));
    const favRestore = gnpSortObjectKeys(favRestoreRaw);
    const folderTomb = gnpSortObjectKeys(gnpPruneByTsMap((deletedFolders && typeof deletedFolders === 'object') ? deletedFolders : {}, 2000));
    const folderRestore = gnpSortObjectKeys(gnpPruneByTsMap((restoredFolders && typeof restoredFolders === 'object') ? restoredFolders : {}, 2000));

    return {
        v: 2,
        updatedAt: Date.now(),
        instance: gnpInstanceId,
        favorites: favArr,
        folders: folderArr,
        deletedFavorites: tomb,
        restoredFavorites: favRestore,
        deletedFolders: folderTomb,
        restoredFolders: folderRestore
    };
}


function gnpBuildFavoritesFilePayloadFromState(favArrIn, folderArrIn, tombIn, folderTombIn, folderRestoreIn, favRestoreIn = null) {
    // Like gnpBuildFavoritesFilePayload(), but for a provided merged state (avoid relying on possibly stale in-memory vars).
    const favArr = (Array.isArray(favArrIn) ? favArrIn : []).map(f => ({
        text: String((f && f.text) || '').trim(),
        folder: String((f && f.folder) || '默认').trim() || '默认',
        useCount: Number((f && f.useCount) || 0) || 0,
        lastUsed: Number((f && f.lastUsed) || 0) || 0,
        rating: Number((f && f.rating) || 1)
    })).filter(x => x.text);

    const folderArr = Array.isArray(folderArrIn) ? folderArrIn.slice() : ['默认'];

    const tombRaw = gnpPruneByTsMap((tombIn && typeof tombIn === 'object') ? tombIn : {}, 5000);
    const favRestoreRaw = gnpPruneByTsMap((favRestoreIn && typeof favRestoreIn === 'object') ? favRestoreIn : {}, 5000);
    const tomb = gnpSortObjectKeys(gnpApplyRestoresToTombstones(tombRaw, favRestoreRaw));
    const favRestore = gnpSortObjectKeys(favRestoreRaw);
    const folderTomb = gnpSortObjectKeys(gnpPruneByTsMap((folderTombIn && typeof folderTombIn === 'object') ? folderTombIn : {}, 2000));
    const folderRestore = gnpSortObjectKeys(gnpPruneByTsMap((folderRestoreIn && typeof folderRestoreIn === 'object') ? folderRestoreIn : {}, 2000));

    return {
        v: 2,
        updatedAt: Date.now(),
        instance: gnpInstanceId,
        favorites: favArr,
        folders: folderArr,
        deletedFavorites: tomb,
        restoredFavorites: favRestore,
        deletedFolders: folderTomb,
        restoredFolders: folderRestore
    };
}

async function gnpReadLatestSharedStateSafe() {
    // Read latest shared-state snapshot directly from chrome.storage (so a stale tab cannot overwrite a newer update on disk).
    try {
        if (!gnpChrome || !gnpChrome.storage) return null;
        const getFrom = (area) => new Promise((resolve) => {
            try {
                if (!area || !area.get) return resolve(null);
                area.get([GNP_SHARED_STATE_KEY], (res) => {
                    try { resolve(res && res[GNP_SHARED_STATE_KEY]); } catch (_) { resolve(null); }
                });
            } catch (_) { resolve(null); }
        });

        let st = null;
        // Prefer sync (cross-instance), fallback local
        if (gnpStorageSync) st = await getFrom(gnpStorageSync);
        if (!st && gnpStorageLocal) st = await getFrom(gnpStorageLocal);
        return st;
    } catch (_) { return null; }
}

function gnpBuildFileSnapshotFromObj(obj) {
    const o = (obj && typeof obj === 'object') ? obj : {};
    const inc = gnpExtractFavoritesFromAnyJson(o);
    const tomb = (o.deletedFavorites && typeof o.deletedFavorites === 'object' && !Array.isArray(o.deletedFavorites)) ? o.deletedFavorites : {};
    const favRestore = (o.restoredFavorites && typeof o.restoredFavorites === 'object' && !Array.isArray(o.restoredFavorites)) ? o.restoredFavorites : {};
    const folderTomb = (o.deletedFolders && typeof o.deletedFolders === 'object' && !Array.isArray(o.deletedFolders)) ? o.deletedFolders : {};
    const folderRestore = (o.restoredFolders && typeof o.restoredFolders === 'object' && !Array.isArray(o.restoredFolders)) ? o.restoredFolders : {};
    return {
        favorites: inc.favorites || [],
        folders: inc.folders || [],
        deletedFavorites: tomb,
        restoredFavorites: favRestore,
        deletedFolders: folderTomb,
        restoredFolders: folderRestore
    };
}

function gnpEqualFavArrays(a, b) {
	try {
		const aa = Array.isArray(a) ? a : [];
		const bb = Array.isArray(b) ? b : [];
		if (aa.length !== bb.length) return false;
		for (let i = 0; i < aa.length; i++) {
			const x = aa[i] || {};
			const y = bb[i] || {};
			if (String(x.text || '').trim() !== String(y.text || '').trim()) return false;
			if (String(x.folder || '默认').trim() !== String(y.folder || '默认').trim()) return false;
			if ((Number(x.useCount) || 0) !== (Number(y.useCount) || 0)) return false;
			if ((Number(x.lastUsed) || 0) !== (Number(y.lastUsed) || 0)) return false;
			// [修复] 增加 rating 比较，确保星级变化能触发文件写入
			if ((Number(x.rating) || 1) !== (Number(y.rating) || 1)) return false;
		}
		return true;
	} catch (_) { return false; }
}

function gnpEqualStringArrays(a, b) {
    try {
        const aa = Array.isArray(a) ? a : [];
        const bb = Array.isArray(b) ? b : [];
        return JSON.stringify(aa) === JSON.stringify(bb);
    } catch (_) { return false; }
}

function gnpEqualTsMap(a, b) {
    try {
        const aa = gnpSortObjectKeys((a && typeof a === 'object' && !Array.isArray(a)) ? a : {});
        const bb = gnpSortObjectKeys((b && typeof b === 'object' && !Array.isArray(b)) ? b : {});
        return JSON.stringify(aa) === JSON.stringify(bb);
    } catch (_) { return false; }
}

async function gnpReadFavFileObjSafe() {
    try {
        const resp = await gnpSendMessagePromise({ type: 'GNP_FAV_FILE_READ' });
        if (!resp || resp.ok !== true) return { ok: false, error: resp && resp.error, obj: null, text: '' };
        const text = String(resp.data || resp.text || '').trim();
        if (!text) return { ok: true, obj: null, text: '' };
        try { return { ok: true, obj: JSON.parse(text), text }; } catch (_) { return { ok: true, obj: null, text }; }
    } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e), obj: null, text: '' };
    }
}

function gnpBroadcastFavFileChanged(reason = '', extra = null) {
    try {
        if (!IS_EXTENSION || !gnpChrome || !gnpChrome.storage || !gnpChrome.storage.local) return;
        const payload = { ts: Date.now(), origin: gnpInstanceId, reason: String(reason || ''), extra: extra || null };
        gnpChrome.storage.local.set({ [GNP_FAV_FILE_BCAST_KEY]: payload });
    } catch (_) {}
}

async function gnpWriteFavFileMerged(reason = '') {
    try {
        if (!IS_EXTENSION) return;
        if (gnpApplyingFileSnapshot) { gnpFavFileWritePendingReason = String(reason || 'pending'); return; } // 避免 reload->save->write 循环
        try { gnpLoadManifestCfg(); } catch (_) {}
        if (!gnpGetFavJsonPath()) return;

        // 防止并发写入（同一标签页）
        if (gnpFavFileWriteInFlight) return;
        gnpFavFileWriteInFlight = true;

        try {
            // Build the local snapshot from the latest shared-state (plus our current in-memory state),
            // so even a stale tab cannot overwrite a newer update on disk (e.g., empty folder creation).
            const sharedRaw = await gnpReadLatestSharedStateSafe();
            const shared = sharedRaw ? gnpNormalizeSharedState(sharedRaw) : null;

            const mergedLocalRestores = gnpPruneByTsMap(gnpMergeTombstones((shared && shared.restoredFavorites) || {}, restoredFavorites), 5000);
            const mergedLocalTombsRaw = gnpPruneByTsMap(gnpMergeTombstones((shared && shared.deletedFavorites) || {}, deletedFavorites), 5000);
            const mergedLocalTombs = gnpApplyRestoresToTombstones(mergedLocalTombsRaw, mergedLocalRestores);
            const mergedLocalFolderTombs = gnpPruneByTsMap(gnpMergeTombstones((shared && shared.deletedFolders) || {}, deletedFolders), 2000);
            const mergedLocalFolderRestores = gnpPruneByTsMap(gnpMergeTombstones((shared && shared.restoredFolders) || {}, restoredFolders), 2000);

            const mergedLocalFav = gnpMergeFavorites((shared && shared.favorites) || [], favorites, mergedLocalTombs);
            const mergedLocalFolders = gnpMergeFolders((shared && shared.folders) || [], folders, mergedLocalFav, mergedLocalFolderTombs, mergedLocalFolderRestores);

            const localObj = gnpBuildFavoritesFilePayloadFromState(
                mergedLocalFav,
                mergedLocalFolders,
                mergedLocalTombs,
                mergedLocalFolderTombs,
                mergedLocalFolderRestores,
                mergedLocalRestores
            );
            const localSnap = gnpBuildFileSnapshotFromObj(localObj);

            // 读文件（跨 Chrome 实例同步的关键）
            const fr = await gnpReadFavFileObjSafe();
            const fileObj = fr.ok ? fr.obj : null;
            const fileSnap = gnpBuildFileSnapshotFromObj(fileObj || {});
            const fileTombsRaw = gnpPruneByTsMap((fileSnap.deletedFavorites && typeof fileSnap.deletedFavorites === 'object') ? fileSnap.deletedFavorites : {}, 5000);
            const fileRestores = gnpPruneByTsMap((fileSnap.restoredFavorites && typeof fileSnap.restoredFavorites === 'object') ? fileSnap.restoredFavorites : {}, 5000);
            const fileTombs = gnpApplyRestoresToTombstones(fileTombsRaw, fileRestores);
            const fileFolderTombs = gnpPruneByTsMap((fileSnap.deletedFolders && typeof fileSnap.deletedFolders === 'object') ? fileSnap.deletedFolders : {}, 2000);
            const fileFolderRestores = gnpPruneByTsMap((fileSnap.restoredFolders && typeof fileSnap.restoredFolders === 'object') ? fileSnap.restoredFolders : {}, 2000);

            // 合并 tombstone：取最大时间戳（删除优先，避免复活）
            const mergedRestores = gnpPruneByTsMap(gnpMergeTombstones(fileRestores, (localSnap.restoredFavorites || {})), 5000);
            const mergedTombsRaw = gnpPruneByTsMap(gnpMergeTombstones(fileTombs, (localSnap.deletedFavorites || {})), 5000);
            let mergedTombs = gnpApplyRestoresToTombstones(mergedTombsRaw, mergedRestores);

            // TTL 裁剪 deletedFavorites：只保留最近 30 天的 tombstone，避免无限膨胀与陈旧误判
            try {
                const ttlMs = 30 * 24 * 60 * 60 * 1000;
                const cutoff = Date.now() - ttlMs;
                const pruned = {};
                for (const k in mergedTombs) {
                    const ts = mergedTombs[k];
                    if (typeof ts !== 'number' || ts >= cutoff) pruned[k] = ts;
                }
                mergedTombs = pruned;
            } catch (_) {}

            const mergedFolderTombs = gnpPruneByTsMap(gnpMergeTombstones(fileFolderTombs, (localSnap.deletedFolders || {})), 2000);
            const mergedFolderRestores = gnpPruneByTsMap(gnpMergeTombstones(fileFolderRestores, (localSnap.restoredFolders || {})), 2000);


            // 合并 favorites：以本地顺序优先，补齐文件中的缺失项；并过滤 tombstone
            const mergedFav = gnpMergeFavorites(fileSnap.favorites || [], localSnap.favorites || [], mergedTombs);

            // 合并 folders：并集 + favorites 引用到的 folder
            const mergedFolders = gnpMergeFolders(fileSnap.folders || [], localSnap.folders || [], mergedFav, mergedFolderTombs, mergedFolderRestores);

            // 若文件已经等价（忽略 updatedAt/instance），则不写
            const fileFavNormalized = gnpMergeFavorites([], fileSnap.favorites || [], mergedTombs);
            const fileFoldersNormalized = gnpMergeFolders([], fileSnap.folders || [], fileFavNormalized, fileFolderTombs, fileFolderRestores);

            const sameFav = gnpEqualFavArrays(mergedFav, fileFavNormalized);
            const sameFolders = gnpEqualStringArrays(mergedFolders, fileFoldersNormalized);
            const sameTombs = gnpEqualTsMap(mergedTombs, fileTombs);
            const sameRestores = gnpEqualTsMap(mergedRestores, fileRestores);
            const sameFolderTombs = gnpEqualTsMap(mergedFolderTombs, fileFolderTombs);
            const sameFolderRestores = gnpEqualTsMap(mergedFolderRestores, fileFolderRestores);

            if (sameFav && sameFolders && sameTombs && sameRestores && sameFolderTombs && sameFolderRestores) {
                // 记录已见快照（避免后续重复写/重复 reload）
                const normalizedObj = {
                    v: 2,
                    updatedAt: Number((fileObj && (fileObj.updatedAt || fileObj.u)) || 0) || Date.now(),
                    instance: (fileObj && fileObj.instance) || gnpInstanceId,
                    favorites: mergedFav,
                    folders: mergedFolders,
                    deletedFavorites: gnpSortObjectKeys(mergedTombs),
                    restoredFavorites: gnpSortObjectKeys(mergedRestores),
                    deletedFolders: gnpSortObjectKeys(mergedFolderTombs),
                    restoredFolders: gnpSortObjectKeys(mergedFolderRestores)
                };
                const normalizedText = JSON.stringify(normalizedObj, null, 2);
                gnpFavFileLastSnapshot = normalizedText;
                gnpFavFileLastSeenHash = gnpHashText(normalizedText);
                return;
            }

            const nextObj = {
                v: 2,
                updatedAt: Date.now(),
                instance: gnpInstanceId,
                favorites: mergedFav,
                folders: mergedFolders,
                deletedFavorites: gnpSortObjectKeys(mergedTombs),
                restoredFavorites: gnpSortObjectKeys(mergedRestores),
                deletedFolders: gnpSortObjectKeys(mergedFolderTombs),
                restoredFolders: gnpSortObjectKeys(mergedFolderRestores)
            };
            const nextText = JSON.stringify(nextObj, null, 2);

            // 去重/限频：写失败时不应更新 lastSnapshot
            if (nextText === gnpFavFileLastSnapshot) return;
            const now = Date.now();
            if (nextText === gnpFavFileLastAttemptSnapshot && (now - gnpFavFileLastAttemptAt) < 1200) return;
            gnpFavFileLastAttemptSnapshot = nextText;
            gnpFavFileLastAttemptAt = now;

            const resp = await gnpSendMessagePromise({ type: 'GNP_FAV_FILE_WRITE', text: nextText });
            if (!resp || resp.ok !== true) {
                if (!gnpFileSyncWarned) {
                    gnpFileSyncWarned = true;
                    gnpToastSafe('本地JSON自动回写未启用：请安装 Native Host（控制台有说明）。');
                }
                try { console.warn('[GNP] Fav JSON write failed:', resp); } catch (_) {}
                return;
            }

            // 仅成功后更新快照
            gnpFavFileLastSnapshot = nextText;
            gnpFavFileLastSeenHash = gnpHashText(nextText);

            // 校验：若同时有其它实例写入导致我们被覆盖，触发一次再合并回写（靠 debounce 限制）
            try {
                setTimeout(async () => {
                    try {
                        const vr = await gnpReadFavFileObjSafe();
                        const vt = String((vr && vr.text) || '').trim();
                        const vh = gnpHashText(vt);
                        const wh = gnpHashText(nextText);
                        if (vh && wh && vh !== wh) {
                            try { gnpScheduleWriteFavoritesJsonFile('verify'); } catch (_) {}
                        }
                    } catch (_) {}
                }, 160);
            } catch (_) {}

            // 通知同一浏览器内的所有页面 reload（避免每页轮询）
            gnpBroadcastFavFileChanged(reason, { hash: gnpFavFileLastSeenHash });

        } finally {
            gnpFavFileWriteInFlight = false;
        }
    } catch (_) {
        try { gnpFavFileWriteInFlight = false; } catch (_) {}
    }
}

function gnpScheduleWriteFavoritesJsonFile(reason = '') {
    try {
        if (!IS_EXTENSION) return;
        if (gnpApplyingFileSnapshot) { gnpFavFileWritePendingReason = String(reason || 'pending'); return; }

        // 频繁使用 prompt 会触发 recordFavoriteUse -> saveFavorites；这里统一 debounce
        clearTimeout(gnpFavFileWriteTimer);
        gnpFavFileWriteTimer = setTimeout(async () => {
            try { await gnpLoadManifestCfg(); } catch (_) {}
            if (!gnpGetFavJsonPath()) return; // 未配置路径则不写

            try { await gnpWriteFavFileMerged(reason); } catch (e) {
                if (!gnpFileSyncWarned) {
                    gnpFileSyncWarned = true;
                    gnpToastSafe('本地JSON自动回写未启用：请安装 Native Host（控制台有说明）。');
                }
                try { console.warn('[GNP] Fav JSON write exception:', e); } catch (_) {}
            }
        }, 650);
    } catch (_) {}
}

    async function gnpBootstrapFavoritesFromJsonFileOnce(trigger = '') {
        if (!IS_EXTENSION) return;
        try { await gnpLoadManifestCfg(); } catch (_) {}
        if (gnpFileBootstrapDone) return;
        gnpFileBootstrapDone = true;

        if (!gnpGetFavJsonPath()) return; // 未配置路径则跳过（保持现有行为）

        const resp = await gnpSendMessagePromise({ type: 'GNP_FAV_FILE_READ' });
        if (!resp || resp.ok !== true) {
            // 读取失败/文件不存在：尝试把当前收藏写一份出去（首次使用）
            // 仅在 Host 可用但文件不存在时，Host 会返回 ok:false + code='ENOENT'
            // 我们这里直接尝试写一次，不阻塞主逻辑。
            try { gnpScheduleWriteFavoritesJsonFile('bootstrap-init'); } catch (_) {}
            if (resp && resp.error) {
                try { console.warn('[GNP] Fav JSON read failed:', resp); } catch (_) {}
            }
            return;
        }

        const text = String(resp.data || resp.text || '').trim();
        if (!text) return;

        try {
            const obj = JSON.parse(text);

			// ============================================================
            // [FIX START] 关键修复：从文件加载删除记录，并立即清理内存中的僵尸数据
            // ============================================================
            if (obj && typeof obj === 'object') {
                // 1. 读取并合并文件中的 Tombstones (删除记录)
                const fileDel = (obj.deletedFavorites && typeof obj.deletedFavorites === 'object' && !Array.isArray(obj.deletedFavorites)) ? obj.deletedFavorites : {};
                const fileRes = (obj.restoredFavorites && typeof obj.restoredFavorites === 'object' && !Array.isArray(obj.restoredFavorites)) ? obj.restoredFavorites : {};

                // 将文件的删除记录合并到当前内存变量中
                deletedFavorites = gnpMergeTombstones(fileDel, deletedFavorites);
                restoredFavorites = gnpMergeTombstones(fileRes, restoredFavorites);
                // 应用复活逻辑（防止误删刚恢复的）
                deletedFavorites = gnpApplyRestoresToTombstones(deletedFavorites, restoredFavorites);

                // 2. 立即过滤当前 favorites
                // (因为在读文件前，gnpBootstrapSharedState 可能已经把 Storage 里的旧数据加载进来了)
                if (Array.isArray(favorites) && favorites.length > 0) {
                    const countBefore = favorites.length;
                    favorites = favorites.filter(f => {
                        const t = String(f.text || '').trim();
                        // 如果在删除记录里且没有被复活，就从列表中剔除
                        return !(deletedFavorites[t] && Number(deletedFavorites[t]) > 0);
                    });

                    // 如果确实清理了僵尸数据，触发一次保存，把清洗后的结果同步回 Storage
                    if (favorites.length !== countBefore) {
                        saveFavorites('fav_list');
                    }
                }
            }
            // ================= [FIX END] =================
            const incoming = gnpExtractFavoritesFromAnyJson(obj);
            const merged = gnpMergeFavoritesIntoCurrent(incoming);

            if (merged.changed) {
                // 同步回 localStorage + sharedState
                try { saveFolders(); } catch (_) {}
                try { saveFavorites(); } catch (_) {}
                try { renderFavorites(); } catch (_) {}
                gnpToastSafe(`已从本地JSON加载收藏：新增 ${merged.added}，更新 ${merged.updated}`);
            }

            // 无论是否变化，都保证文件回写为“统一格式”
            try { gnpScheduleWriteFavoritesJsonFile('bootstrap-normalize'); } catch (_) {}
        } catch (e) {
            try { console.warn('[GNP] Fav JSON parse failed:', e); } catch (_) {}
            gnpToastSafe('本地JSON文件解析失败：请检查 JSON 格式。');
        }

    // 启动文件同步监听（跨实例：轮询文件；同一浏览器：storage 广播触发 reload）
    try { gnpStartFavFilePolling(); } catch (_) {}
}



function gnpDebouncedReloadFavoritesFromJsonFile(trigger = '') {
    try {
        clearTimeout(gnpFavFileReloadTimer);
        gnpFavFileReloadTimer = setTimeout(() => {
            try { gnpReloadFavoritesFromJsonFile(trigger); } catch (_) {}
        }, 220);
    } catch (_) {}
}

async function gnpReloadFavoritesFromJsonFile(trigger = '') {
    if (!IS_EXTENSION) return;
    try { await gnpLoadManifestCfg(); } catch (_) {}
    if (!gnpGetFavJsonPath()) return;

    const fr = await gnpReadFavFileObjSafe();
    if (!fr || fr.ok !== true) return;

    const text = String(fr.text || '').trim();
    if (!text) return;

    // hash compare: unchanged -> skip
    const h = gnpHashText(text);
    if (h && h === gnpFavFileLastSeenHash && trigger !== 'force') return;

    let obj = null;
    try { obj = fr.obj || JSON.parse(text); } catch (_) { obj = null; }
    if (!obj || typeof obj !== 'object') return;

    const snap = gnpBuildFileSnapshotFromObj(obj);
    const fileTombs = gnpPruneByTsMap((snap.deletedFavorites && typeof snap.deletedFavorites === 'object') ? snap.deletedFavorites : {}, 5000);
    const fileRestores = gnpPruneByTsMap((snap.restoredFavorites && typeof snap.restoredFavorites === 'object') ? snap.restoredFavorites : {}, 5000);
    const fileFolderTombs = gnpPruneByTsMap((snap.deletedFolders && typeof snap.deletedFolders === 'object') ? snap.deletedFolders : {}, 2000);
    const fileFolderRestores = gnpPruneByTsMap((snap.restoredFolders && typeof snap.restoredFolders === 'object') ? snap.restoredFolders : {}, 2000);
    const mergedRestores = gnpPruneByTsMap(gnpMergeTombstones(fileRestores, restoredFavorites), 5000);
    const mergedTombsRaw = gnpPruneByTsMap(gnpMergeTombstones(fileTombs, deletedFavorites), 5000);
    const mergedTombs = gnpApplyRestoresToTombstones(mergedTombsRaw, mergedRestores);
    const mergedFolderTombs = gnpPruneByTsMap(gnpMergeTombstones(fileFolderTombs, deletedFolders), 2000);
    const mergedFolderRestores = gnpPruneByTsMap(gnpMergeTombstones(fileFolderRestores, restoredFolders), 2000);


    // ==================== 修复：文件优先合并策略 ====================
    // 问题：gnpMergeFavorites使用text作为key，无法检测到手动修改text内容的情况
    // 解决：采用文件优先策略，只有文件中不存在时才使用本地数据
    // ==============================================================

    // 建立索引
    const fileMap = new Map();
    (snap.favorites || []).forEach(f => {
        const t = String(f.text || '').trim();
        if (t) fileMap.set(t, f);
    });

    const localMap = new Map();
    (favorites || []).forEach(f => {
        const t = String(f.text || '').trim();
        if (t) localMap.set(t, f);
    });

    // 合并：文件优先
    const mergedFavList = [];
    const processed = new Set();

    // 1. 先添加文件中的所有条目（保持文件顺序，text/folder以文件为准）
    // 重要：如果prompt在文件的favorites数组里，自动忽略墓碑记录（自动复活）
    (snap.favorites || []).forEach(fileItem => {
        const t = String(fileItem.text || '').trim();
        if (!t) return;
        if (processed.has(t)) return;

        // ===== 关键修改：文件中的favorites优先，自动复活 =====
        // 如果prompt在文件的favorites里，说明用户手动添加了，应该显示
        // 不再检查墓碑：if (mergedTombs[t] && Number(mergedTombs[t]) > 0) return;

        // 如果这个prompt在墓碑里，自动添加到复活记录
        if (mergedTombs[t] && Number(mergedTombs[t]) > 0) {
            const now = Date.now();
            restoredFavorites[t] = now; // 自动标记为已复活
            delete mergedTombs[t]; // 从合并后的墓碑中移除
            console.log('[GNP] Auto-restored from tombstone:', t);
        }
        // ====================================================

        const localItem = localMap.get(t);

        // text/folder以文件为准，metadata取最大值
        const merged = {
            text: t,
            folder: fileItem.folder || '默认',
            useCount: localItem ? Math.max(Number(fileItem.useCount)||0, Number(localItem.useCount)||0) : (Number(fileItem.useCount)||0),
            lastUsed: localItem ? Math.max(Number(fileItem.lastUsed)||0, Number(localItem.lastUsed)||0) : (Number(fileItem.lastUsed)||0),
            rating: Number(fileItem.rating) || (localItem ? (Number(localItem.rating)||1) : 1)
        };

        mergedFavList.push(merged);
        processed.add(t);
    });

    // 2. 添加本地有但文件中没有的（可能是刚添加还没写入）
    (favorites || []).forEach(localItem => {
        const t = String(localItem.text || '').trim();
        if (!t) return;
        if (processed.has(t)) return;
        if (mergedTombs[t] && Number(mergedTombs[t]) > 0) return;
        if (fileMap.has(t)) return; // 已在步骤1处理

        mergedFavList.push({
            text: t,
            folder: localItem.folder || '默认',
            useCount: Number(localItem.useCount)||0,
            lastUsed: Number(localItem.lastUsed)||0,
            rating: Number(localItem.rating)||1
        });
        processed.add(t);
    });

    const mergedFav = mergedFavList;
    // ==============================================================

    // 更新合并后的restoredFavorites（包含自动复活的记录）
    const mergedRestoresUpdated = gnpPruneByTsMap(restoredFavorites, 5000);

    const mergedFolders = gnpMergeFolders(snap.folders || [], folders || [], mergedFav, mergedFolderTombs, mergedFolderRestores);

    // 是否发生变化
    const changedFav = !gnpEqualFavArrays(mergedFav, favorites || []);
    const changedFolders = !gnpEqualStringArrays(mergedFolders, folders || []);
    const changedTombs = !gnpEqualTsMap(mergedTombs, deletedFavorites || {});
    const changedRestores = !gnpEqualTsMap(mergedRestoresUpdated, restoredFavorites || {});
    const changedFolderTombs = !gnpEqualTsMap(mergedFolderTombs, deletedFolders || {});
    const changedFolderRestores = !gnpEqualTsMap(mergedFolderRestores, restoredFolders || {});

    if (!changedFav && !changedFolders && !changedTombs && !changedRestores && !changedFolderTombs && !changedFolderRestores) {
        gnpFavFileLastSeenHash = h || gnpFavFileLastSeenHash;
        return;
    }

    gnpApplyingFileSnapshot = true;
    try {
        favorites = mergedFav;
        folders = mergedFolders;
        deletedFavorites = mergedTombs;
        restoredFavorites = mergedRestoresUpdated; // 使用更新后的（包含自动复活）
        deletedFolders = mergedFolderTombs;
        restoredFolders = mergedFolderRestores;

        // 写回到 localStorage + sharedState（让同一浏览器内其它页面也能同步）
        try { saveFolders(); } catch (_) {}
        try { saveFavorites('fav_list'); } catch (_) {}

        try { renderFavorites(); } catch (_) {}
        try { refreshNav(true); } catch (_) {}

        gnpFavFileLastSeenHash = h || gnpFavFileLastSeenHash;
        console.log('[GNP] File reloaded:', {trigger, hash: h, changedFav, changedFolders, favCount: favorites.length, folderCount: folders.length});
    } finally {
        setTimeout(() => {
        gnpApplyingFileSnapshot = false;
        // If a user action occurred while we were applying a file snapshot, flush the pending write now.
        if (gnpFavFileWritePendingReason) {
            const r = String(gnpFavFileWritePendingReason || 'pending');
            gnpFavFileWritePendingReason = null;
            try { gnpScheduleWriteFavoritesJsonFile(r); } catch (_) {}
        }

        // External file edit: after merging into storage/UI, write back a canonical (merged + normalized) JSON.
        // We only do this in a single leader tab to avoid multi-tab write storms.
        try {
            const bcastOrigin = String((gnpLastFavFileBcast && gnpLastFavFileBcast.origin) || '');
            const shouldNormalize = (trigger === 'poll' || trigger === 'force' || (trigger === 'bcast' && bcastOrigin === 'bg'));
            if (shouldNormalize) {
                (async () => {
                    try {
                        const isLeader = await gnpTryBecomeFavFilePollLeader();
                        if (!isLeader) return;
                        // This call is idempotent: if the file already matches the canonical format, it will no-op.
                        gnpScheduleWriteFavoritesJsonFile('file-merge-normalize');
                    } catch (_) {}
                })();
            }
        } catch (_) {}
    }, 80);
    }
}

async function gnpTryBecomeFavFilePollLeader() {
    try {
        if (!IS_EXTENSION || !gnpChrome || !gnpChrome.storage || !gnpChrome.storage.local) return false;

        const now = Date.now();
        const getRes = await new Promise((resolve) => {
            try { gnpChrome.storage.local.get([GNP_FAV_FILE_POLL_LEADER_KEY], resolve); } catch (_) { resolve({}); }
        });
        const cur = getRes && getRes[GNP_FAV_FILE_POLL_LEADER_KEY];
        const curId = cur && cur.id;
        const curTs = Number(cur && cur.ts) || 0;

        // 过期或空 -> 抢占
        if (!curId || (now - curTs) > 5500 || curId === gnpInstanceId) {
            await new Promise((resolve) => {
                try { gnpChrome.storage.local.set({ [GNP_FAV_FILE_POLL_LEADER_KEY]: { id: gnpInstanceId, ts: now } }, resolve); } catch (_) { resolve(); }
            });
            return true;
        }
        return false;
    } catch (_) { return false; }
}

function gnpStartFavFilePolling() {
    try {
        if (!IS_EXTENSION) return;
        if (gnpFavFilePollTimer) return;
        if (!gnpGetFavJsonPath()) return;

        // Leader heartbeat (cheap)
        gnpFavFilePollLeaderTimer = setInterval(async () => {
            try {
                const isLeader = await gnpTryBecomeFavFilePollLeader();
                if (!isLeader) return;

                // leader: poll file every 2s
                if (!gnpFavFilePollTimer) {
                    gnpFavFilePollTimer = setInterval(async () => {
                        try {
                            const leader = await gnpTryBecomeFavFilePollLeader();
                            if (!leader) return;

                            const fr = await gnpReadFavFileObjSafe();
                            if (!fr || fr.ok !== true) return;
                            const text = String(fr.text || '').trim();
                            if (!text) return;
                            const h = gnpHashText(text);
                            if (h && h !== gnpFavFileLastSeenHash) {
                                gnpFavFileLastSeenHash = h;
                                // leader 先自 reload，再广播给同浏览器其它页面
                                try { await gnpReloadFavoritesFromJsonFile('poll'); } catch (_) {}
                                try { gnpBroadcastFavFileChanged('poll', { hash: h }); } catch (_) {}
                            }
                        } catch (_) {}
                    }, 2000);
                }
            } catch (_) {}
        }, 1800);

    } catch (_) {}
}

function gnpPickAndImportFavoritesJsonFile() {
        try {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json,.json';
            input.style.display = 'none';
            document.body.appendChild(input);

            input.addEventListener('change', () => {
                const file = input.files && input.files[0];
                if (!file) { input.remove(); return; }
                const reader = new FileReader();
                reader.onload = async () => {
                    try {
                        const raw = String(reader.result || '').trim();
                        const obj = JSON.parse(raw);
			const incoming = gnpExtractFavoritesFromAnyJson(obj); 
			const merged = gnpMergeFavoritesIntoCurrent(incoming);

			if (merged.changed) {
				// [FIX] 导入时必须清理墓碑(deletedFavorites)并标记复活(restoredFavorites)
				// 否则 gnpWriteFavFileMerged 会因墓碑存在而过滤掉这些刚导入的 Prompt，导致无法回写到文件
				const now = Date.now();
				const importedList = (incoming.favorites || []);

				importedList.forEach(f => {
					const t = String(f.text || '').trim();
					if (!t) return;
					
					// 1. 清除删除标记
					if (deletedFavorites && deletedFavorites[t]) {
						delete deletedFavorites[t];
					}
					// 2. 添加复活标记 (覆盖其他端可能存在的旧 Tombstone)
					if (!restoredFavorites) restoredFavorites = {};
					restoredFavorites[t] = now;
				});

				try { saveFolders(); } catch (_) {}
				try { saveFavorites(); } catch (_) {}
				try { renderFavorites(); } catch (_) {}
				gnpToastSafe(`已导入JSON：新增 ${merged.added}，更新 ${merged.updated}`);
			} else {
				gnpToastSafe('导入完成：未发现新的 Prompt（已自动去重）。');
			}

			// 变更后立即回写到“manifest 指定的本地JSON”
			try { gnpScheduleWriteFavoritesJsonFile('import'); } catch (_) {}
                    } catch (e) {
                        try { console.warn('[GNP] Import JSON failed:', e); } catch (_) {}
                        gnpToastSafe('导入失败：JSON格式不正确。');
                    } finally {
                        input.remove();
                    }
                };
                reader.onerror = () => {
                    input.remove();
                    gnpToastSafe('导入失败：读取文件失败。');
                };
                reader.readAsText(file, 'utf-8');
            });

            input.click();
        } catch (e) {
            try { console.warn('[GNP] Pick import file failed:', e); } catch (_) {}
            gnpToastSafe('打开文件选择器失败。');
        }
    }


const saveFavorites = (mode = 'fav_list') => {
        const payload = favorites.map(f => ({ 
            text: f.text, 
            folder: f.folder, 
            useCount: Number(f.useCount)||0, 
            lastUsed: Number(f.lastUsed)||0,
            rating: Number(f.rating)||1 
        }));
        localStorage.setItem(STORAGE_KEY_FAV, JSON.stringify(payload));
        gnpPersistSharedState(mode);
        try { gnpScheduleWriteFavoritesJsonFile("favorites"); } catch (_) {}
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
    saveFavorites('fav_meta');

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
        gnpPersistSharedState('usage');
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



    const addFavorite = (t, folder = '默认', rating = 1) => {
        const text = String(t || '').trim();
        const f = String(folder || '默认').trim() || '默认';
        let r = parseInt(rating, 10);
        if (isNaN(r) || r < 1) r = 1;
        if (r > 5) r = 5;

        if (!text) return false;
        // 重新添加时：清除 tombstone + 写“复活标记”，避免被其它标签页/实例的旧 tombstone 立刻删除
        try { if (deletedFavorites && deletedFavorites[text]) delete deletedFavorites[text]; } catch (_) {}
        try {
            restoredFavorites = (restoredFavorites && typeof restoredFavorites === 'object') ? restoredFavorites : {};
            restoredFavorites[text] = Date.now();
        } catch (_) {}
        if (hasFavorite(text)) return false;
        if (!folders.includes(f)) { folders.push(f); saveFolders(); }
        favorites.unshift({ text, folder: f, useCount: 0, lastUsed: 0, rating: r }); // 新收藏置顶：保持原行为
        return true;
    };

    const removeFavorite = (t) => {
        const text = String(t || '').trim();
        if (!text) return;
        const idx = getFavoriteIndex(text);
        if (idx > -1) favorites.splice(idx, 1);
        // 写 tombstone，避免删除被旧快照复活
        try {
            deletedFavorites = (deletedFavorites && typeof deletedFavorites === 'object') ? deletedFavorites : {};
            deletedFavorites[text] = Date.now();
            // 删除后清理复活标记（以删除为准）
            if (restoredFavorites && restoredFavorites[text]) delete restoredFavorites[text];
        } catch (_) {}
    };


    const renameFavorite = (oldText, newText) => {
        const o = String(oldText || '').trim();
        const n = String(newText || '').trim();
        if (!o || !n) return false;
        if (o === n) return true;
        const idx = getFavoriteIndex(o);
        if (idx === -1) return false;
        // tombstone old name, clear tombstone for new name, mark new as restored
        try {
            deletedFavorites = (deletedFavorites && typeof deletedFavorites === 'object') ? deletedFavorites : {};
            deletedFavorites[o] = Date.now();
            if (deletedFavorites[n]) delete deletedFavorites[n];
            restoredFavorites = (restoredFavorites && typeof restoredFavorites === 'object') ? restoredFavorites : {};
            restoredFavorites[n] = Date.now();
            if (restoredFavorites[o]) delete restoredFavorites[o];
        } catch (_) {}
        favorites[idx].text = n;
        return true;
    };
    const ensureFolderExists = (name) => {
        const f = String(name || '').trim();
        if (!f) return '默认';
        // 若曾删除同名文件夹（tombstone），创建时应允许复活
        try { if (deletedFolders && deletedFolders[f]) delete deletedFolders[f]; } catch (_) {}
        try { restoredFolders = (restoredFolders && typeof restoredFolders === 'object') ? restoredFolders : {}; restoredFolders[f] = Date.now(); } catch (_) {}
        if (!folders.includes(f)) { folders.push(f); saveFolders(); }
        return f;
    };

    // 文件夹名显示优化：最多显示 6 个字符，超过用 ... 省略（避免按钮重叠）
    function gnpTruncateFolderName(name, maxLen = 999) {
        // 支持自定义截断长度
        // maxLen=999时显示完整名称（用于弹窗）
        // maxLen=6时截断为6个字符（用于列表badge）
        const str = String(name || '');
        if (maxLen >= 999) return str; // 完整显示
        const arr = Array.from(str);
        if (arr.length <= maxLen) return arr.join('');
        return arr.slice(0, maxLen).join('') + '...';
    }


    // 移动收藏到指定文件夹（弹窗在插件内，支持下拉+实时搜索；Esc 退出）
    const gnpMoveFavoriteToFolder = (promptText, currentFolder) => {
        const t = String(promptText || '').trim();
        if (!t) return;
        showFavFolderPickerInSidebar({
            promptText: t,
            defaultFolder: currentFolder || '默认',
            defaultRating: (function(){ const i=getFavoriteIndex(t); return (i>-1 && favorites[i] ? Number(favorites[i].rating)||1 : 1); })(),
            titleText: '移动到文件夹',
            descText: '将此收藏移动到哪个文件夹？',
            confirmText: '移动',
            showPreview: true,
            allowCreateFolder: true,
            onConfirm: (folder, rating) => {
                const f = ensureFolderExists(folder);
                const idx = getFavoriteIndex(t);
                if (idx === -1) return;

                const oldFolder = String((favorites[idx] && favorites[idx].folder) || '默认');
                const oldRating = Number((favorites[idx] && favorites[idx].rating) || 1) || 1;
                const newRating = Number(rating) || 1;

                // 允许“只改星级不改文件夹”也生效
                const folderChanged = (oldFolder !== f);
                const ratingChanged = (oldRating !== newRating);
                if (!folderChanged && !ratingChanged) return;

                favorites[idx].folder = f;
                favorites[idx].rating = newRating;

                saveFavorites('fav_list');
                // 若当前筛选目录不包含该条，重绘后会自动移除/出现
                try { renderFavorites(); } catch (_) {}
                try { if (panelNav && panelNav.classList.contains('active')) refreshNav(true); } catch (_) {}

                if (folderChanged) {
                    try { showSidebarToast(`已移动到「${f}」`); } catch (_) {}
                } else if (ratingChanged) {
                    try { showSidebarToast(`已更新星级：${newRating} 星`); } catch (_) {}
                }
            }
        });
    };

    // [新增] 从hover预览调用的移动文件夹功能（在全局弹窗中显示，保留当前星级）
    const gnpMoveFavoriteToFolderFromHover = (promptText, currentFolder) => {
        const t = String(promptText || '').trim();
        if (!t) return;
        
        // 获取当前收藏项信息
        const idx = getFavoriteIndex(t);
        if (idx === -1) return;
        const favObj = favorites[idx];
        const currentRating = Number(favObj.rating) || 1;
        
        // 使用全局弹窗而不是侧边栏内弹窗
        showFavFolderPickerGlobal({
            promptText: t,
            defaultFolder: currentFolder || '默认',
            defaultRating: currentRating,  // 传递当前星级
            titleText: '移动到文件夹',
            descText: '将此收藏移动到哪个文件夹？',
            confirmText: '移动',
            showPreview: true,
            allowCreateFolder: true,
            onConfirm: (folder, rating) => {
                const f = ensureFolderExists(folder);
                const old = String(favObj.folder || '默认');
                
                // 更新文件夹和星级
                favorites[idx].folder = f;
                favorites[idx].rating = rating;
                
                saveFavorites('fav_list');
                
                // 刷新界面
                try { renderFavorites(); } catch (_) {}
                try { if (panelNav && panelNav.classList.contains('active')) refreshNav(true); } catch (_) {}
                
                // 如果文件夹改变了，显示提示
                if (old !== f) {
                    try { showSidebarToast(`已移动到「${f}」`); } catch (_) {}
                }
            }
        });
    };
    saveFolders();
    saveFavorites();

    let isAutoHideEnabled = JSON.parse(localStorage.getItem(STORAGE_KEY_HIDE)) ?? true;
    let isAutoSendEnabled = JSON.parse(localStorage.getItem(STORAGE_KEY_AUTOSEND)) ?? false;

    // --- 多选状态 ---
    let selectedItems = new Set(); 
    let inMultiSelectMode = false; // 标记：是否已进入多选模式（显示批量栏）

	// --- 性能优化：定时器集中管理 ---
    let autoHideTimer = null;
    let searchDebounceTimer = null;
    let clickTimers = new Map(); // 双击检测：存储每个 item 的点击定时器

    let isSelectInteracting = false;
	// 当用户正在操作收藏页“文件夹筛选”下拉框时，避免 2s 级别的自动刷新重绘。
	// 否则重绘会销毁 <select> 并导致下拉菜单自动消失。
	let gnpPendingFavRerender = false;
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

    
    // 将“自动发送”开关状态同步到每条 Prompt 的⚡按钮（避免只改了顶部按钮）
    function syncAutosendButtonsUI(root = document) {
        try {
            const btns = root.querySelectorAll('.mini-btn.use-btn');
            btns.forEach(b => {
                if (isAutoSendEnabled) b.classList.add('autosend-mode');
                else b.classList.remove('autosend-mode');
            });
        } catch (_) {}
    }

function updateHeaderUI() { 
        lockBtn.classList.toggle('active', !isAutoHideEnabled);
        autoSendBtn.classList.toggle('active', isAutoSendEnabled);

        // 重要：⚡按钮不仅存在于侧边栏列表，也存在于悬浮预览/弹窗（通常挂在 document.body）。
        // 若只在 sidebar 内同步，会导致“弹窗里的⚡不变紫”。因此这里强制对 document 同步。
        syncAutosendButtonsUI(document);
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

	searchInput.oninput = (ev) => {
        const run = () => {
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
        
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(run, 300);
    };

// [新增] 全局监听发送事件 (Enter键 或 点击发送按钮)，实现精准计数
function setupGlobalSendListener() {
    let lastText = '';
    let lastTime = 0;

    const tryRecord = () => {
        try {
            const inputEl = qsAny(CURRENT_CONFIG.inputSelector);
            if (!inputEl) return;
            // 兼容 textarea 的 value 和 contenteditable 的 textContent
            const val = inputEl.value || inputEl.innerText || inputEl.textContent || '';
            const t = String(val).trim();
            if (!t) return;

            // 简单的防抖：相同文本在 2秒内只记一次 (避免 Enter 同时触发 click 的双重计数)
            const now = Date.now();
            if (t === lastText && (now - lastTime < 2000)) return;
            
            lastText = t;
            lastTime = now;
            
            recordPromptUse(t);
        } catch (e) {
            // console.error('[GNP] Send listener error:', e);
        }
    };

    // 1. 监听 Enter 键 (捕获阶段，确保在输入框被清空前获取文本)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            const inputEl = qsAny(CURRENT_CONFIG.inputSelector);
            // 只有当焦点在输入框内按下回车才算
            if (inputEl && (e.target === inputEl || inputEl.contains(e.target))) {
                tryRecord();
            }
        }
    }, true);

    // 2. 监听发送按钮点击 (捕获阶段)
    document.addEventListener('click', (e) => {
        const sendBtn = qsAny(CURRENT_CONFIG.sendBtnSelector);
        // 检查点击目标是否是发送按钮或其子元素
        if (sendBtn && (e.target === sendBtn || sendBtn.contains(e.target))) {
            // 排除 disabled 按钮
            if (!sendBtn.disabled && !sendBtn.hasAttribute('disabled')) {
                tryRecord();
            }
        }
    }, true);
}

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
        // recordPromptUse(text);

    }

    // --- 批量操作逻辑 ---
        // 统一的导航窗内确认框（复用现有 gnp-confirm-* 样式）
        function showConfirmInSidebar({ titleText, descText, confirmText, onConfirm }) {
            // 防止叠加多个弹层
            const existed = sidebar.querySelector('.gnp-confirm-overlay');
            if (existed) {
                try { if (typeof existed.__gnp_cleanup === 'function') existed.__gnp_cleanup(); } catch (_) {}
                existed.remove();
            }

            // 打开编辑/确认弹层时：保持侧边栏展开，且暂停自动隐藏
            keepSidebarExpanded();

            const overlay = document.createElement('div');
            overlay.className = 'gnp-confirm-overlay';

            let onDocKeyDown = null;
            overlay.__gnp_cleanup = () => {
                if (onDocKeyDown) {
                    try { document.removeEventListener('keydown', onDocKeyDown, true); } catch (_) {}
                    onDocKeyDown = null;
                }
            };

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
                try { overlay.__gnp_cleanup && overlay.__gnp_cleanup(); } catch (_) {}
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

            // 键盘：Esc 关闭弹层
            onDocKeyDown = (ev) => {
                try {
                    if (!ev) return;
                    if (ev.key === 'Escape' || ev.key === 'Esc') {
                        ev.preventDefault();
                        ev.stopPropagation();
                        closeOverlay();
                    }
                } catch (_) {}
            };
            try { document.addEventListener('keydown', onDocKeyDown, true); } catch (_) {}
        }

function showPromptInSidebar({ titleText, placeholder, defaultValue, confirmText, onConfirm }) {
            // 复用确认框遮罩，避免与其他弹层叠加
            const existed = sidebar.querySelector('.gnp-confirm-overlay');
            if (existed) {
                try { if (typeof existed.__gnp_cleanup === 'function') existed.__gnp_cleanup(); } catch (_) {}
                existed.remove();
            }

            // 打开输入弹层时：保持侧边栏展开，且暂停自动隐藏
            keepSidebarExpanded();

            const overlay = document.createElement('div');
            overlay.className = 'gnp-confirm-overlay';

            let onDocKeyDown = null;
            overlay.__gnp_cleanup = () => {
                if (onDocKeyDown) {
                    try { document.removeEventListener('keydown', onDocKeyDown, true); } catch (_) {}
                    onDocKeyDown = null;
                }
            };

            const closeOverlay = () => {
                try { overlay.__gnp_cleanup && overlay.__gnp_cleanup(); } catch (_) {}
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
            err.style.cssText = 'margin-top:8px;color:var(--gnp-danger-text);font-size:12px;display:none;';
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

            // 键盘：Esc 关闭弹层（避免被全局键盘导航逻辑抢走按键）
            onDocKeyDown = (ev) => {
                try {
                    if (!ev) return;
                    if (ev.key === 'Escape' || ev.key === 'Esc') {
                        ev.preventDefault();
                        ev.stopPropagation();
                        closeOverlay();
                    }
                } catch (_) {}
            };
            try { document.addEventListener('keydown', onDocKeyDown, true); } catch (_) {}

            // 自动聚焦
            setTimeout(() => { try { input.focus(); input.select(); } catch (e) {} }, 0);


}
function showFavFolderPickerInSidebar({ promptText, defaultFolder, defaultRating = 1, onConfirm, titleText, descText, confirmText, showPreview = true, allowCreateFolder = true }) {
    try {
        // 防止叠加多个弹层
        const existed = sidebar && sidebar.querySelector('.gnp-confirm-overlay');
        if (existed) existed.remove();
    } catch (_) {}

    // 打开选择弹层时：保持侧边栏展开，且暂停自动隐藏
    keepSidebarExpanded();
    // 默认文案（兼容“收藏/移动”两种场景）
    titleText = String(titleText || '').trim() || '选择收藏文件夹';
    descText = String(descText || '').trim() || '将此 Prompt 收藏到哪个文件夹？';
    confirmText = String(confirmText || '').trim() || '收藏';

    const overlay = document.createElement('div');
    overlay.className = 'gnp-confirm-overlay';

    let onDocKeyDown = null;

    const closeOverlay = () => {
        if (onDocKeyDown) { try { document.removeEventListener('keydown', onDocKeyDown, true); } catch (_) {} onDocKeyDown = null; }
        overlay.remove();
        if (isAutoHideEnabled && sidebar && !sidebar.matches(':hover')) scheduleAutoHide();
    };

    const box = document.createElement('div');
    box.className = 'gnp-confirm-box gnp-fav-folder-picker';

    const title = document.createElement('div');
    title.className = 'gnp-confirm-title';
    title.textContent = titleText;

    const desc = document.createElement('div');
    desc.className = 'gnp-confirm-desc';
    desc.textContent = descText;

    const preview = document.createElement('div');
    preview.className = 'gnp-fav-prompt-preview';
    // 预览尽量显示更多内容（容器可滚动）
    preview.textContent = String(promptText || '').trim().slice(0, 1200);
    if (!showPreview) {
        preview.style.display = 'none';
    }

    let currentRating = Number(defaultRating) || 1;
    const starPicker = document.createElement('div');
    starPicker.className = 'gnp-star-picker';
    const renderStars = () => {
        starPicker.innerHTML = '';
        for (let i = 1; i <= 5; i++) {
            const s = document.createElement('span');
            s.className = `gnp-star-item ${i <= currentRating ? 'active' : ''}`;
            s.textContent = i <= currentRating ? '★' : '☆';
            s.title = `${i} 星`;
            s.onclick = (e) => { e.stopPropagation(); currentRating = i; renderStars(); };
            starPicker.appendChild(s);
        }
    };
    renderStars();

    const row = document.createElement('div');
    row.className = 'gnp-fav-folder-picker-row';

    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'gnp-folder-search-input';
    search.placeholder = '搜索文件夹（支持关键字）...';

    // 新建文件夹：在“添加到收藏”时也允许直接创建目录
    const newFolderBtn = document.createElement('div');
    newFolderBtn.className = 'header-circle-btn';
    newFolderBtn.title = '新建文件夹';
    newFolderBtn.innerHTML = SVGS.folderPlus;
    newFolderBtn.onclick = (e) => {
        try { e && e.stopPropagation(); } catch (_) {}
        // 先关闭当前选择弹层，再弹出输入框；创建后重新打开选择弹层并默认选中新目录。
        try { closeOverlay(); } catch (_) {}
        showPromptInSidebar({
            titleText: '新建文件夹',
            placeholder: '请输入文件夹名称',
            defaultValue: '',
            confirmText: '创建',
            onConfirm: (name) => {
                const f = ensureFolderExists(name);
                // 重新打开文件夹选择器，并默认选中新创建的文件夹
                showFavFolderPickerInSidebar({
                    promptText,
                    defaultFolder: f,
                    defaultRating: currentRating,
                    onConfirm
                });
            }
        });
    };

    if (!allowCreateFolder) { try { newFolderBtn.style.display = 'none'; } catch (_) {} }

    const folderSel = document.createElement('select');
    folderSel.className = 'gnp-folder-select';
    folderSel.style.width = '100%';

    // 下拉应展示“所有已创建的文件夹”，包括空文件夹
    let folderOptions = (typeof gnpNormalizeFolders === 'function') ? gnpNormalizeFolders(folders) : ['默认'];
    // 兜底：若某些历史数据的 folder 未纳入 folders 列表，也补进去
    try {
        (Array.isArray(favorites) ? favorites : []).forEach(f => {
            const ff = String((f && f.folder) || '').trim();
            if (ff && !folderOptions.includes(ff)) folderOptions.push(ff);
        });
    } catch (_) {}
    folderOptions = (typeof gnpNormalizeFolders === 'function') ? gnpNormalizeFolders(folderOptions) : folderOptions;

    // 选择弹层不展示“全部”
    folderOptions = (folderOptions || []).filter(fn => fn && fn !== '全部');
    if (!folderOptions.includes('默认')) folderOptions.unshift('默认');

    const allFolders = folderOptions.slice();

    // 实时匹配结果：展示为“下拉列表”（无需点开原生 select）
    const suggestBox = document.createElement('div');
    suggestBox.className = 'gnp-folder-suggest-box';
    let suggestActiveIndex = -1;

    const renderSuggest = (list, keyword) => {
        try { suggestBox.innerHTML = ''; } catch (_) { suggestBox.textContent = ''; }
        const kw = String(keyword || '').trim();
        if (!kw) { suggestBox.style.display = 'none'; suggestActiveIndex = -1; return; }
        suggestBox.style.display = 'block';
        if (!list || !list.length) {
            const empty = document.createElement('div');
            empty.className = 'gnp-folder-suggest-empty';
            empty.textContent = '（无匹配）';
            suggestBox.appendChild(empty);
            suggestActiveIndex = -1;
            return;
        }
        list.forEach((fn, idx) => {
            const item = document.createElement('div');
            item.className = 'gnp-folder-suggest-item';
            if (fn === folderSel.value) item.classList.add('active');
            item.textContent = fn;
            item.addEventListener('mousedown', (ev) => {
                // 用 mousedown 避免输入框 blur 导致列表提前消失
                try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
                try { folderSel.value = fn; } catch (_) {}
                try { suggestActiveIndex = idx; } catch (_) {}
            }, true);
            item.addEventListener('click', (ev) => {
                try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
                try { folderSel.value = fn; } catch (_) {}
            }, true);
            suggestBox.appendChild(item);
        });
        // 默认高亮第一项
        if (suggestActiveIndex < 0) suggestActiveIndex = 0;
    };

    const rebuildOptions = (keyword) => {
        const kw = String(keyword || '').trim().toLowerCase();
        const prev = folderSel.value;
        folderSel.innerHTML = '';

        let list = allFolders;
        if (kw) list = allFolders.filter(fn => String(fn).toLowerCase().includes(kw));

        if (!list.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '（无匹配）';
            opt.disabled = true;
            folderSel.append(opt);
            folderSel.value = '';
            renderSuggest([], keyword);
            return;
        }

        list.forEach(fn => {
            const opt = document.createElement('option');
            opt.value = fn;
            opt.textContent = fn;
            folderSel.append(opt);
        });

        // 尽量保留原选择
        if (prev && list.includes(prev)) folderSel.value = prev;
        else folderSel.value = list[0];

        // 同步渲染实时匹配列表
        renderSuggest(list, keyword);
    };

    rebuildOptions('');

    const def = (defaultFolder && defaultFolder !== '全部') ? defaultFolder : '默认';
    if (allFolders.includes(def)) folderSel.value = def;

    search.addEventListener('input', () => rebuildOptions(search.value));
    // 键盘：上下选择匹配项，Enter 直接确认收藏
    search.addEventListener('keydown', (ev) => {
        try {
            if (ev.key === 'ArrowDown' || ev.key === 'Down') {
                const items = suggestBox.querySelectorAll('.gnp-folder-suggest-item');
                if (!items || !items.length) return;
                ev.preventDefault();
                suggestActiveIndex = (suggestActiveIndex < 0 ? 0 : ((suggestActiveIndex + 1) % items.length));
                const target = items[suggestActiveIndex];
                if (target) {
                    items.forEach(it => it.classList.remove('kbd'));
                    target.classList.add('kbd');
                    const val = target.textContent;
                    if (val) folderSel.value = val;
                    try { target.scrollIntoView({ block: 'nearest' }); } catch (_) {}
                }
            } else if (ev.key === 'ArrowUp' || ev.key === 'Up') {
                const items = suggestBox.querySelectorAll('.gnp-folder-suggest-item');
                if (!items || !items.length) return;
                ev.preventDefault();
                suggestActiveIndex = (suggestActiveIndex < 0 ? (items.length - 1) : ((suggestActiveIndex - 1 + items.length) % items.length));
                const target = items[suggestActiveIndex];
                if (target) {
                    items.forEach(it => it.classList.remove('kbd'));
                    target.classList.add('kbd');
                    const val = target.textContent;
                    if (val) folderSel.value = val;
                    try { target.scrollIntoView({ block: 'nearest' }); } catch (_) {}
                }
            }
        } catch (_) {}
    });

    const btnRow = document.createElement('div');
    btnRow.className = 'gnp-btn-row';

    const btnCancel = document.createElement('button');
    btnCancel.className = 'gnp-btn-cancel';
    btnCancel.textContent = '取消';
    btnCancel.onclick = closeOverlay;

    const btnConfirm = document.createElement('button');
    btnConfirm.className = 'gnp-btn-confirm';
    btnConfirm.textContent = confirmText;

    const doConfirm = () => {
        const folder = String(folderSel.value || '').trim() || '默认';

        // 锁定当前高度，避免弹层移除时布局抖动（与“清空全部”一致）
        const currentHeight = sidebar.offsetHeight;
        sidebar.style.height = `${currentHeight}px`;

        try { onConfirm && onConfirm(folder, currentRating); }
        finally { closeOverlay(); }
    };
    btnConfirm.onclick = doConfirm;

    // 允许在输入框/下拉框等任意位置按 Esc 关闭；Enter 确认（捕获阶段，避免被页面吞掉）
    onDocKeyDown = (ev) => {
        try {
            if (!overlay || !overlay.isConnected) return;
            if (!ev) return;
            const k = ev.key;
            if (k === 'Escape' || k === 'Esc') {
                ev.preventDefault();
                ev.stopPropagation();
                closeOverlay();
                return;
            }
            if (k === 'Enter') {
                ev.preventDefault();
                ev.stopPropagation();
                doConfirm();
            }
        } catch (_) {}
    };
    try { document.addEventListener('keydown', onDocKeyDown, true); } catch (_) {}

    // 防止事件冒泡到侧边栏拖拽/多选逻辑
    overlay.addEventListener('mousedown', (ev) => { ev.stopPropagation(); });
    overlay.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.target === overlay) closeOverlay();
    });

    // 搜索框 + 新建文件夹按钮同行显示（不新增 CSS，减少侵入）
    const searchRow = document.createElement('div');
    searchRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
    search.style.flex = '1 1 auto';
    searchRow.append(search, newFolderBtn);

    row.append(searchRow, suggestBox, folderSel);
    btnRow.append(btnCancel, btnConfirm);

    box.append(title, desc, starPicker, preview, row, btnRow);
    overlay.append(box);
    sidebar.appendChild(overlay);

    // 自动聚焦搜索框
    setTimeout(() => { try { search.focus(); search.select(); } catch (_) {} }, 0);
}

// [新增] 全局弹窗版本的文件夹选择器（用于hover预览调用，不会跳回插件窗口）
function showFavFolderPickerGlobal({ promptText, defaultFolder, defaultRating = 1, onConfirm, titleText, descText, confirmText, showPreview = false, allowCreateFolder = true }) {
    try {
        // 清理已有弹层，避免叠加
        const existedGlobal = document.querySelector('.gnp-global-overlay');
        if (existedGlobal) existedGlobal.remove();
        const existedSide = sidebar && sidebar.querySelector('.gnp-confirm-overlay');
        if (existedSide) existedSide.remove();
    } catch (_) {}

    // 打开选择弹层时：保持侧边栏展开，且暂停自动隐藏
    keepSidebarExpanded();
    
    // 默认文案
    titleText = String(titleText || '').trim() || '选择收藏文件夹';
    descText = String(descText || '').trim() || '将此 Prompt 收藏到哪个文件夹？';
    confirmText = String(confirmText || '').trim() || '收藏';

    const overlay = document.createElement('div');
    overlay.className = 'gnp-global-overlay';

    let onDocKeyDown = null;

    const closeOverlay = () => {
        if (onDocKeyDown) { try { document.removeEventListener('keydown', onDocKeyDown, true); } catch (_) {} onDocKeyDown = null; }
        overlay.remove();
        if (isAutoHideEnabled && sidebar && !sidebar.matches(':hover')) scheduleAutoHide();
    };

    const box = document.createElement('div');
    box.className = 'gnp-global-box';
    box.style.minWidth = '420px';
    box.style.maxWidth = '540px';

    const title = document.createElement('div');
    title.className = 'gnp-global-title';
    title.textContent = titleText;

    const desc = document.createElement('div');
    desc.className = 'gnp-confirm-desc';
    desc.textContent = descText;
    desc.style.marginBottom = '12px';

    const preview = document.createElement('div');
    preview.className = 'gnp-fav-prompt-preview';
    preview.textContent = String(promptText || '').trim().slice(0, 1200);
    preview.style.marginBottom = '12px';
    if (!showPreview) {
        preview.style.display = 'none';
    }

    // 星级评分（使用传入的defaultRating）
    let currentRating = Number(defaultRating) || 1;
    const starPicker = document.createElement('div');
    starPicker.className = 'gnp-star-picker';
    starPicker.style.marginBottom = '12px';
    const renderStars = () => {
        starPicker.innerHTML = '';
        for (let i = 1; i <= 5; i++) {
            const s = document.createElement('span');
            s.className = `gnp-star-item ${i <= currentRating ? 'active' : ''}`;
            s.textContent = i <= currentRating ? '★' : '☆';
            s.title = `${i} 星`;
            s.onclick = (e) => { e.stopPropagation(); currentRating = i; renderStars(); };
            starPicker.appendChild(s);
        }
    };
    renderStars();

    const row = document.createElement('div');
    row.className = 'gnp-fav-folder-picker-row';

    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'gnp-folder-search-input';
    search.placeholder = '搜索文件夹（支持关键字）...';

    // 新建文件夹按钮
    const newFolderBtn = document.createElement('div');
    newFolderBtn.className = 'header-circle-btn';
    newFolderBtn.title = '新建文件夹';
    newFolderBtn.innerHTML = SVGS.folderPlus;
    newFolderBtn.onclick = (e) => {
        try { e && e.stopPropagation(); } catch (_) {}
        closeOverlay();
        showPromptInSidebar({
            titleText: '新建文件夹',
            placeholder: '请输入文件夹名称',
            defaultValue: '',
            confirmText: '创建',
            onConfirm: (name) => {
                const f = ensureFolderExists(name);
                // 重新打开全局文件夹选择器
                showFavFolderPickerGlobal({
                    promptText,
                    defaultFolder: f,
                    defaultRating: currentRating,
                    titleText,
                    descText,
                    confirmText,
                    showPreview,
                    allowCreateFolder,
                    onConfirm
                });
            }
        });
    };

    if (!allowCreateFolder) { try { newFolderBtn.style.display = 'none'; } catch (_) {} }

    const folderSel = document.createElement('select');
    folderSel.className = 'gnp-folder-select';
    folderSel.style.width = '100%';

    // 准备文件夹列表
    let folderOptions = (typeof gnpNormalizeFolders === 'function') ? gnpNormalizeFolders(folders) : ['默认'];
    try {
        (Array.isArray(favorites) ? favorites : []).forEach(f => {
            const ff = String((f && f.folder) || '').trim();
            if (ff && !folderOptions.includes(ff)) folderOptions.push(ff);
        });
    } catch (_) {}
    folderOptions = (typeof gnpNormalizeFolders === 'function') ? gnpNormalizeFolders(folderOptions) : folderOptions;
    folderOptions = (folderOptions || []).filter(fn => fn && fn !== '全部');
    if (!folderOptions.includes('默认')) folderOptions.unshift('默认');

    const allFolders = folderOptions.slice();

    // 搜索建议框
    const suggestBox = document.createElement('div');
    suggestBox.className = 'gnp-folder-suggest-box';
    let suggestActiveIndex = -1;

    const renderSuggest = (list, keyword) => {
        try { suggestBox.innerHTML = ''; } catch (_) { suggestBox.textContent = ''; }
        const kw = String(keyword || '').trim();
        if (!kw) { suggestBox.style.display = 'none'; suggestActiveIndex = -1; return; }
        suggestBox.style.display = 'block';
        if (!list || !list.length) {
            const empty = document.createElement('div');
            empty.className = 'gnp-folder-suggest-empty';
            empty.textContent = '（无匹配）';
            suggestBox.appendChild(empty);
            suggestActiveIndex = -1;
            return;
        }
        list.forEach((fn, idx) => {
            const item = document.createElement('div');
            item.className = 'gnp-folder-suggest-item';
            if (fn === folderSel.value) item.classList.add('active');
            item.textContent = fn;
            item.addEventListener('mousedown', (ev) => {
                try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
                try { folderSel.value = fn; suggestActiveIndex = idx; } catch (_) {}
            }, true);
            item.addEventListener('click', (ev) => {
                try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
                try { folderSel.value = fn; } catch (_) {}
            }, true);
            suggestBox.appendChild(item);
        });
        if (suggestActiveIndex < 0) suggestActiveIndex = 0;
    };

    const rebuildOptions = (keyword) => {
        const kw = String(keyword || '').trim().toLowerCase();
        const prev = folderSel.value;
        folderSel.innerHTML = '';

        let list = allFolders;
        if (kw) list = allFolders.filter(fn => String(fn).toLowerCase().includes(kw));

        if (!list.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '（无匹配）';
            opt.disabled = true;
            folderSel.append(opt);
            folderSel.value = '';
            renderSuggest([], keyword);
            return;
        }

        list.forEach(fn => {
            const opt = document.createElement('option');
            opt.value = fn;
            opt.textContent = fn;
            folderSel.append(opt);
        });

        if (prev && list.includes(prev)) folderSel.value = prev;
        else folderSel.value = list[0];

        renderSuggest(list, keyword);
    };

    rebuildOptions('');

    const def = (defaultFolder && defaultFolder !== '全部') ? defaultFolder : '默认';
    if (allFolders.includes(def)) folderSel.value = def;

    search.addEventListener('input', () => rebuildOptions(search.value));
    search.addEventListener('keydown', (ev) => {
        try {
            if (ev.key === 'ArrowDown' || ev.key === 'Down') {
                const items = suggestBox.querySelectorAll('.gnp-folder-suggest-item');
                if (!items || !items.length) return;
                ev.preventDefault();
                suggestActiveIndex = (suggestActiveIndex < 0 ? 0 : ((suggestActiveIndex + 1) % items.length));
                const target = items[suggestActiveIndex];
                if (target) {
                    items.forEach(it => it.classList.remove('kbd'));
                    target.classList.add('kbd');
                    const val = target.textContent;
                    if (val) folderSel.value = val;
                    try { target.scrollIntoView({ block: 'nearest' }); } catch (_) {}
                }
            } else if (ev.key === 'ArrowUp' || ev.key === 'Up') {
                const items = suggestBox.querySelectorAll('.gnp-folder-suggest-item');
                if (!items || !items.length) return;
                ev.preventDefault();
                suggestActiveIndex = (suggestActiveIndex < 0 ? (items.length - 1) : ((suggestActiveIndex - 1 + items.length) % items.length));
                const target = items[suggestActiveIndex];
                if (target) {
                    items.forEach(it => it.classList.remove('kbd'));
                    target.classList.add('kbd');
                    const val = target.textContent;
                    if (val) folderSel.value = val;
                    try { target.scrollIntoView({ block: 'nearest' }); } catch (_) {}
                }
            }
        } catch (_) {}
    });

    const btnRow = document.createElement('div');
    btnRow.className = 'gnp-btn-row';

    const btnCancel = document.createElement('button');
    btnCancel.className = 'gnp-btn-cancel';
    btnCancel.textContent = '取消';
    btnCancel.onclick = closeOverlay;

    const btnConfirm = document.createElement('button');
    btnConfirm.className = 'gnp-btn-confirm';
    btnConfirm.textContent = confirmText;

    const doConfirm = () => {
        const folder = String(folderSel.value || '').trim() || '默认';
        try { onConfirm && onConfirm(folder, currentRating); }
        finally { closeOverlay(); }
    };
    btnConfirm.onclick = doConfirm;

    // Esc关闭，Enter确认
    onDocKeyDown = (ev) => {
        try {
            if (!overlay || !overlay.isConnected) return;
            if (!ev) return;
            const k = ev.key;
            if (k === 'Escape' || k === 'Esc') {
                ev.preventDefault();
                ev.stopPropagation();
                closeOverlay();
                return;
            }
            if (k === 'Enter') {
                ev.preventDefault();
                ev.stopPropagation();
                doConfirm();
            }
        } catch (_) {}
    };
    try { document.addEventListener('keydown', onDocKeyDown, true); } catch (_) {}

    // 防止事件冒泡
    overlay.addEventListener('mousedown', (ev) => { ev.stopPropagation(); });
    overlay.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.target === overlay) closeOverlay();
    });

    // 搜索框 + 新建文件夹按钮同行显示
    const searchRow = document.createElement('div');
    searchRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
    search.style.flex = '1 1 auto';
    searchRow.append(search, newFolderBtn);

    row.append(searchRow, suggestBox, folderSel);
    btnRow.append(btnCancel, btnConfirm);

    box.append(title, desc, starPicker, preview, row, btnRow);
    overlay.append(box);
    document.body.appendChild(overlay);

    // 自动聚焦搜索框
    setTimeout(() => { try { search.focus(); search.select(); } catch (_) {} }, 0);
}


function showAddFavoritePromptInSidebar(defaultFolder) {
    try {
        // 清理已有弹层，避免叠加
        try {
            const existedGlobal = document.querySelector('.gnp-global-overlay');
            if (existedGlobal) {
                try {
                    const cancel = existedGlobal.querySelector('.gnp-btn-cancel');
                    if (cancel) cancel.click();
                    else existedGlobal.remove();
                } catch (_) { existedGlobal.remove(); }
            }
        } catch (_) {}
        try {
            const existedSide = sidebar && sidebar.querySelector('.gnp-confirm-overlay');
            if (existedSide) existedSide.remove();
        } catch (_) {}

        // 打开输入弹层时：保持侧边栏展开，且暂停自动隐藏
        keepSidebarExpanded();

        const overlay = document.createElement('div');
        overlay.className = 'gnp-global-overlay';

        const closeOverlay = () => {

            // Esc 关闭弹窗（全局捕获），关闭时移除监听
            if (onDocKeyDown) { try { document.removeEventListener('keydown', onDocKeyDown, true); } catch (_) {} onDocKeyDown = null; }
            overlay.remove();
            if (isAutoHideEnabled && sidebar && !sidebar.matches(':hover')) scheduleAutoHide();
        };

        // 允许在下拉框/按钮等任意位置按 Esc 关闭（捕获阶段，避免被页面吞掉）
        let onDocKeyDown = (ev) => {
            try {
                if (!overlay || !overlay.isConnected) return;
                if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    closeOverlay();
                }
            } catch (_) {}
        };
        try { document.addEventListener('keydown', onDocKeyDown, true); } catch (_) {}


        const box = document.createElement('div');
        box.className = 'gnp-global-box';

        const title = document.createElement('div');
        title.className = 'gnp-global-title';
        title.textContent = '手动添加 Prompt';

        const textarea = document.createElement('textarea');
        textarea.className = 'gnp-global-textarea';
        textarea.placeholder = '在此粘贴/输入 Prompt（支持多行）...';
        textarea.rows = 6;

        let currentRating = 1;
        const starPicker = document.createElement('div');
        starPicker.className = 'gnp-star-picker';
        const renderStars = () => {
            starPicker.innerHTML = '';
            for (let i = 1; i <= 5; i++) {
                const s = document.createElement('span');
                s.className = `gnp-star-item ${i <= currentRating ? 'active' : ''}`;
                s.textContent = i <= currentRating ? '★' : '☆';
                s.title = `${i} 星`;
                s.onclick = (e) => { e.stopPropagation(); currentRating = i; renderStars(); };
                starPicker.appendChild(s);
            }
        };
        renderStars();

        const folderRow = document.createElement('div');
        folderRow.style.cssText = 'display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:space-between;';

        const folderLeft = document.createElement('div');
        folderLeft.style.cssText = 'display:flex; align-items:center; gap:8px;';

        const folderLabel = document.createElement('div');
        folderLabel.style.cssText = 'font-size:12px; color: var(--gnp-text-sub);';
        folderLabel.textContent = '文件夹';

        const folderSel = document.createElement('select');
        folderSel.className = 'gnp-folder-select';
        folderSel.style.minWidth = '160px';

        // 下拉应展示“所有已创建的文件夹”，包括空文件夹（否则只能看到已有 prompt 的文件夹）
        let folderOptions = (typeof gnpNormalizeFolders === 'function') ? gnpNormalizeFolders(folders) : ['默认'];
        // 兜底：若某些历史数据的 folder 未纳入 folders 列表，也补进去（不影响已有逻辑）
        try {
            (Array.isArray(favorites) ? favorites : []).forEach(f => {
                const ff = String((f && f.folder) || '').trim();
                if (ff && !folderOptions.includes(ff)) folderOptions.push(ff);
            });
        } catch (_) {}
        folderOptions = (typeof gnpNormalizeFolders === 'function') ? gnpNormalizeFolders(folderOptions) : folderOptions;

        folderOptions.forEach(fn => {
            const opt = document.createElement('option');
            opt.value = fn;
            opt.textContent = fn;
            folderSel.append(opt);
        });

        const def = (defaultFolder && defaultFolder !== '全部') ? defaultFolder : '默认';
        folderSel.value = folderOptions.includes(def) ? def : '默认';

        // 新建文件夹按钮
        const newFolderBtn = document.createElement('div');
        newFolderBtn.className = 'header-circle-btn';
        newFolderBtn.title = '新建文件夹';
        newFolderBtn.innerHTML = SVGS.folderPlus;
        newFolderBtn.style.cssText = 'width:24px;height:24px;min-width:24px;min-height:24px;';
        newFolderBtn.onclick = (e) => {
            e.stopPropagation();
            // 创建一个临时弹窗用于输入文件夹名（挂载在 body 上，z-index 高于当前弹窗）
            const tempOverlay = document.createElement('div');
            tempOverlay.className = 'gnp-confirm-overlay';
            tempOverlay.style.zIndex = '2147483649'; // 高于 gnp-global-overlay

            const box = document.createElement('div');
            box.className = 'gnp-confirm-box';
            box.style.minWidth = '320px';

            const title = document.createElement('div');
            title.className = 'gnp-confirm-title';
            title.textContent = '新建文件夹';

            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = '请输入文件夹名称';
            input.className = 'gnp-prompt-input';
            input.style.cssText = 'width:100%;box-sizing:border-box;margin-top:10px;padding:10px 12px;border-radius:10px;border:1px solid var(--gnp-border);outline:none;font-size:14px;background:var(--gnp-input-bg);color:var(--gnp-input-text);';

            const btnRow = document.createElement('div');
            btnRow.className = 'gnp-btn-row';
            btnRow.style.marginTop = '16px';

            const closeTemp = () => tempOverlay.remove();

            const btnCancel = document.createElement('button');
            btnCancel.className = 'gnp-btn-cancel';
            btnCancel.textContent = '取消';
            btnCancel.onclick = closeTemp;

            const btnConfirm = document.createElement('button');
            btnConfirm.className = 'gnp-btn-confirm';
            btnConfirm.textContent = '创建';
            const doCreate = () => {
                const name = (input.value || '').trim();
                if (name) {
                    const f = ensureFolderExists(name);
                    
                    // [修复] 检查下拉框中是否已存在该文件夹，避免重复添加选项
                    let exists = false;
                    for (let i = 0; i < folderSel.options.length; i++) {
                        if (folderSel.options[i].value === f) {
                            exists = true;
                            break;
                        }
                    }

                    if (!exists) {
                        const opt = document.createElement('option');
                        opt.value = f;
                        opt.textContent = f;
                        folderSel.appendChild(opt);
                        showSidebarToast(`已创建文件夹「${f}」`);
                    } else {
                        // 若已存在，则不重复添加option，仅提示用户
                        // showSidebarToast(`已切换到文件夹「${f}」`);
                    }
                    
                    // 选中该文件夹
                    folderSel.value = f;
                }
                closeTemp();
            };
            btnConfirm.onclick = doCreate;

            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); doCreate(); }
                if (ev.key === 'Escape') { ev.preventDefault(); closeTemp(); }
            });

            // 点击遮罩关闭
            tempOverlay.addEventListener('mousedown', (ev) => ev.stopPropagation());
            tempOverlay.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (ev.target === tempOverlay) closeTemp();
            });

            btnRow.append(btnCancel, btnConfirm);
            box.append(title, input, btnRow);
            tempOverlay.append(box);
            document.body.appendChild(tempOverlay);
            setTimeout(() => input.focus(), 50);
        };

        folderLeft.append(folderLabel, folderSel, newFolderBtn);
        
        const folderRight = document.createElement('div');
        folderRight.append(starPicker);
        folderRow.append(folderLeft, folderRight);

        const err = document.createElement('div');
        err.className = 'gnp-global-error';
        err.textContent = '请输入有效内容';

        const showErr = (msg) => {
            err.textContent = msg || '请输入有效内容';
            err.style.display = 'block';
        };

        const btnRow = document.createElement('div');
        btnRow.className = 'gnp-global-btnrow';

        const btnCancel = document.createElement('button');
        btnCancel.className = 'gnp-btn-cancel';
        btnCancel.textContent = '取消';
        btnCancel.onclick = closeOverlay;

        const btnAdd = document.createElement('button');
        btnAdd.className = 'gnp-btn-confirm';
        btnAdd.textContent = '添加';

const doAdd = () => {
            const text = (textarea.value || '').trim();
            if (!text) return showErr('请输入 Prompt 内容');

            const folder = (folderSel.value || '默认').trim() || '默认';
            if (!addFavorite(text, folder, currentRating)) return showErr('该 Prompt 已在收藏中');

            saveFavorites('fav_list');

            // ============================================================
            // [FIX] 自动切换视图逻辑
            // 如果当前筛选不是“全部”，且保存的目标文件夹与当前视图不一致，
            // 则强制切换到目标文件夹，确保用户能立即看到刚刚添加的 Prompt。
            // ============================================================
            if (favFolderFilter !== '全部' && favFolderFilter !== folder) {
                favFolderFilter = folder;
                gnpSetTabFavFolderFilter(folder); // 同步保存到 SessionStorage
            }

            keyboardSelectedPrompt = text;
            renderFavorites();
            showSidebarToast('已添加到收藏');
            closeOverlay();
        };
        btnAdd.onclick = doAdd;

        // 键盘交互：Esc 取消；Cmd/Ctrl + Enter 快速添加
        textarea.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') { ev.preventDefault(); closeOverlay(); }
            if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); doAdd(); }
        });

        // 遮罩交互：点击空白处关闭
        overlay.addEventListener('mousedown', (ev) => { ev.stopPropagation(); });
        overlay.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (ev.target === overlay) closeOverlay();
        });

        btnRow.append(btnCancel, btnAdd);
        box.append(title, textarea, folderRow, err, btnRow);
        overlay.append(box);

        // 挂载到页面，居中显示（不在侧边栏内部）
        document.body.appendChild(overlay);

        setTimeout(() => { try { textarea.focus(); } catch (_) {} }, 0);
    }
    catch (err) {
        try { console.error('[GNP] showAddFavoritePromptInSidebar error:', err); } catch (_) {}
        try { showSidebarToast('手动添加 Prompt 打开失败（请查看控制台）'); } catch (_) {}
    }
}

function showEditModalCenter({ titleText, placeholder, defaultValue, confirmText, onConfirm }) {
            // 移除已有全屏弹窗，避免叠加
            const existed = document.querySelector('.gnp-global-overlay');
            if (existed) {
                try {
                    const cancel = existed.querySelector('.gnp-btn-cancel');
                    if (cancel) cancel.click();
                    else existed.remove();
                } catch (_) { existed.remove(); }
            }

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

            let onDocKeyDown = null;

            const close = () => {
                try { if (onDocKeyDown) document.removeEventListener('keydown', onDocKeyDown, true); } catch (_) {}
                onDocKeyDown = null;
                overlay.remove();
            };

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

            // 允许在任意位置按 Esc 关闭（捕获阶段，避免被页面吞掉）
            onDocKeyDown = (ev) => {
                try {
                    if (!overlay || !overlay.isConnected) return;
                    if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        close();
                    }
                } catch (_) {}
            };
            try { document.addEventListener('keydown', onDocKeyDown, true); } catch (_) {}


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

        // 关键修改：只有在 inMultiSelectMode 为 true 时才显示批量栏
        if (!inMultiSelectMode || selectedItems.size === 0) {
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
                        // [FIX] 批量删除时必须写入墓碑 (deletedFavorites)，否则文件同步时会被旧数据复活
                        const now = Date.now();
                        try {
                            if (!deletedFavorites) deletedFavorites = {};
                            if (!restoredFavorites) restoredFavorites = {};

                            selectedItems.forEach(text => {
                                deletedFavorites[text] = now;
                                // 同时清理复活标记（以本次删除为准）
                                if (restoredFavorites[text]) delete restoredFavorites[text];
                            });
                        } catch (_) {}

                        favorites = favorites.filter(f => !selectedItems.has(f.text));
                        saveFavorites();
                        selectedItems.clear();
                        renderFavorites();
                        updateBatchBar();
                    }
                });
            } else {
                // 批量收藏 - 修改为弹窗选择文件夹
                const targetFolderDefault = (favFolderFilter && favFolderFilter !== '全部') ? favFolderFilter : '默认';

                // 构造预览文本：显示第一条 + 剩余数量提示
                const firstItem = items[0] || '';
                const previewTxt = items.length > 1 
                    ? `${firstItem.slice(0, 150)}${firstItem.length > 150 ? '...' : ''}\n\n... (以及其他 ${items.length - 1} 项)`
                    : firstItem;

                showFavFolderPickerInSidebar({
                    promptText: previewTxt,
                    defaultFolder: targetFolderDefault,
                    titleText: '批量收藏',
                    descText: `将选中的 ${items.length} 个 Prompt 收藏到哪个文件夹？并评级：`,
                    confirmText: '收藏全部',
                    onConfirm: (folder, rating) => {
                        let addedCount = 0;
                        items.forEach(txt => {
                            if (addFavorite(txt, folder, rating)) {
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
                        showSidebarToast(addedCount > 0 ? `已收藏到「${folder}」（新增 ${addedCount} 项）` : '收藏成功');
                    }
                });
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

        // 批量移动按钮（仅在收藏面板显示）
        if (isFavTab) {
            const moveBtn = document.createElement('span');
            moveBtn.className = 'batch-btn action-move';
            moveBtn.textContent = '移动到';
            moveBtn.title = '将选中的收藏移动到其他文件夹';
            moveBtn.onclick = (e) => {
                e.stopPropagation();
                const items = Array.from(selectedItems);

                // 弹出文件夹选择器
                showFavFolderPickerInSidebar({
                    promptText: `已选中 ${items.length} 个收藏`,
                    defaultFolder: '默认',
                    titleText: '批量移动',
                    descText: `将选中的 ${items.length} 个收藏移动到哪个文件夹？`,
                    confirmText: '移动',
                    onConfirm: (targetFolder) => {
                        let movedCount = 0;

                        // 更新每个收藏的文件夹
                        favorites.forEach(fav => {
                            if (selectedItems.has(fav.text)) {
                                fav.folder = targetFolder;
                                movedCount++;
                            }
                        });

                        // 保存并刷新
                        if (movedCount > 0) {
                            saveFavorites();
                            selectedItems.clear();
                            renderFavorites();
                            updateBatchBar();
                            showSidebarToast(`已将 ${movedCount} 项移动到「${targetFolder}」`);
                        }
                    }
                });
            };

            // 按钮顺序：计数 | 移动到 | 删除 | 取消
            batchBar.append(countSpan, moveBtn, actionBtn, cancelBtn);
        } else {
            // 导航面板：计数 | 收藏 | 取消
        batchBar.append(countSpan, actionBtn, cancelBtn);
    }
    }

    // Command/Ctrl + A：在侧边栏的导航/收藏面板中全选 prompt
    function selectAllPromptsInPanel(panelEl) {
        if (!panelEl) return;
        const items = Array.from(panelEl.querySelectorAll('.gemini-nav-item'));
        if (items.length === 0) return;

        inMultiSelectMode = true; // 全选时进入多选模式
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
        inMultiSelectMode = false; // 清除多选时退出多选模式
        selectedItems.clear();
        if (sidebar) {
            sidebar.querySelectorAll('.gemini-nav-item.multi-selected').forEach(el => el.classList.remove('multi-selected'));
        }
        updateBatchBar();
    }

    document.addEventListener('keydown', (e) => {
        const key = (e.key || '').toLowerCase();

        // [修改] Esc：取消多选
        // 原有的此处逻辑已移除，统一合并到下方的 window.addEventListener('keydown') 中处理
        // 以避免多处监听导致的冲突和优先级问题。

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
        // 文件夹搜索建议列表交互时不取消（否则点击会被全局逻辑清掉）
        if (t.closest && t.closest('#gnp-folder-filter-suggest')) return;
        if (t.closest && t.closest('.gnp-folder-filter-suggest')) return;
        if (t.closest && t.closest('.gnp-folder-filter-search-input')) return;
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

            // 清除多选状态（修复：添加 inMultiSelectMode 重置）
            inMultiSelectMode = false;
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

    // 收藏：文件夹筛选 - 搜索建议列表（避免文件夹很多时原生下拉难选）
    let gnpFolderFilterSuggestEl = null;
    let gnpFolderFilterSuggestOnDocDown = null;
    let gnpFolderFilterSuggestValues = [];
    let gnpFolderFilterSuggestActiveIndex = -1;

    // 收藏：文件夹筛选 - 临时弹出搜索框（仅在需要切换目录时出现，避免与工具栏/图表重叠）
    let gnpFolderFilterPopupInputEl = null;
    let gnpFolderFilterPopupOnDocDown = null;

    function gnpCloseFolderFilterSuggest() {
        try {
            if (gnpFolderFilterSuggestOnDocDown) {
                document.removeEventListener('mousedown', gnpFolderFilterSuggestOnDocDown, true);
                gnpFolderFilterSuggestOnDocDown = null;
            }
        } catch (_) {}
        try { if (gnpFolderFilterSuggestEl) gnpFolderFilterSuggestEl.remove(); } catch (_) {}
        gnpFolderFilterSuggestEl = null;
        gnpFolderFilterSuggestValues = [];
        gnpFolderFilterSuggestActiveIndex = -1;
    }

    function gnpCloseFolderFilterPopup() {
        try {
            if (gnpFolderFilterPopupOnDocDown) {
                document.removeEventListener('mousedown', gnpFolderFilterPopupOnDocDown, true);
                gnpFolderFilterPopupOnDocDown = null;
            }
        } catch (_) {}
        try { if (gnpFolderFilterPopupInputEl) gnpFolderFilterPopupInputEl.remove(); } catch (_) {}
        gnpFolderFilterPopupInputEl = null;
        try { gnpCloseFolderFilterSuggest(); } catch (_) {}
        // 弹层关闭后允许恢复自动隐藏/重绘
        try { isSelectInteracting = false; } catch (_) {}
        // 若交互期间有刷新请求被抑制，则在关闭弹层后补一次重绘
        try {
            if (typeof gnpPendingFavRerender !== 'undefined' && gnpPendingFavRerender) {
                gnpPendingFavRerender = false;
                renderFavorites();
            }
        } catch (_) {}
    }

    function gnpOpenFolderFilterSuggest(anchorEl, keyword, allItems, currentValue, onPick) {
        try { gnpCloseFolderFilterSuggest(); } catch (_) {}
        if (!sidebar || !anchorEl) return;

        const kw = String(keyword || '').trim().toLowerCase();
        let items = Array.isArray(allItems) ? allItems.slice() : [];
        if (kw) items = items.filter(x => String(x).toLowerCase().includes(kw));

        // 若无匹配，也显示一个“无匹配”占位
        gnpFolderFilterSuggestValues = items;
        gnpFolderFilterSuggestActiveIndex = 0;

        const suggest = document.createElement('div');
        suggest.id = 'gnp-folder-filter-suggest';
        suggest.className = 'gnp-folder-filter-suggest';

        // 定位：锚点输入框下方
        try {
            const a = anchorEl.getBoundingClientRect();
            const s = sidebar.getBoundingClientRect();
            const left = Math.max(12, Math.min(s.width - 12, (a.left - s.left)));
            const top = Math.max(12, (a.bottom - s.top) + 2);
            const minW = Math.max(180, Math.floor(a.width));
            const maxW = Math.max(220, Math.floor(s.width - 24));
            suggest.style.left = `${Math.min(left, s.width - 12)}px`;
            suggest.style.top = `${top}px`;
            suggest.style.minWidth = `${Math.min(minW, maxW)}px`;
            suggest.style.maxWidth = `${maxW}px`;
        } catch (_) {}

        const render = () => {
            suggest.innerHTML = '';
            if (!gnpFolderFilterSuggestValues.length) {
                const empty = document.createElement('div');
                empty.className = 'gnp-folder-filter-empty';
                empty.textContent = '（无匹配）';
                suggest.appendChild(empty);
                return;
            }
            gnpFolderFilterSuggestValues.forEach((val, idx) => {
                const item = document.createElement('div');
                item.className = 'gnp-folder-filter-item';
                if (val === currentValue) item.classList.add('active');
                if (idx === gnpFolderFilterSuggestActiveIndex) item.classList.add('kbd');

                const label = document.createElement('div');
                label.className = 'gnp-folder-filter-label';
                label.textContent = val;
                item.appendChild(label);

                const isCustomFolder = (val !== '全部' && val !== '默认');

                // 在目录右侧提供“重命名/删除”入口（select option 无法内嵌按钮，这里放在弹出的目录列表中）
                if (val !== '全部') {
                    const actions = document.createElement('div');
                    actions.className = 'gnp-folder-filter-actions';

                    const btnRename = document.createElement('button');
                    btnRename.type = 'button';
                    btnRename.className = 'gnp-folder-filter-action-btn';
                    btnRename.title = isCustomFolder ? '重命名文件夹' : '默认不可重命名';
                    btnRename.innerHTML = SVGS.edit;
                    if (!isCustomFolder) btnRename.disabled = true;

                    const btnDelete = document.createElement('button');
                    btnDelete.type = 'button';
                    btnDelete.className = 'gnp-folder-filter-action-btn gnp-danger';
                    btnDelete.title = isCustomFolder ? '删除文件夹' : '默认不可删除';
                    btnDelete.innerHTML = SVGS.folderX;
                    if (!isCustomFolder) btnDelete.disabled = true;

                    const stop = (ev) => { try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {} };

                    // 防止触发目录项自身的选择逻辑
                    btnRename.addEventListener('mousedown', stop, true);
                    btnDelete.addEventListener('mousedown', stop, true);

                    btnRename.addEventListener('click', (ev) => {
                        stop(ev);
                        if (!isCustomFolder) { try { showSidebarToast('仅可重命名自定义文件夹'); } catch (_) {} return; }
                        try { gnpCloseFolderFilterPopup(); } catch (_) {}
                        const oldName = String(val || '').trim();
                        showPromptInSidebar({
                            titleText: '重命名文件夹',
                            placeholder: '请输入新文件夹名称',
                            defaultValue: oldName,
                            confirmText: '重命名',
                            onConfirm: (name) => {
                                const trimmed = String(name || '').trim();
                                if (!trimmed) return;
                                const finalName = ensureFolderExists(trimmed);

                    // ✅ Rename must create a tombstone for old folder to prevent sync "revive"
                    try {
                        const now = gnpNow();
                        const oldKey = String(oldName || '').trim();
                        const newKey = String(finalName || '').trim();
                        if (oldKey && newKey && oldKey !== newKey) {
                            deletedFolders = (deletedFolders && typeof deletedFolders === 'object') ? deletedFolders : {};
                            deletedFolders[oldKey] = now;
                            try { if (restoredFolders && restoredFolders[oldKey]) delete restoredFolders[oldKey]; } catch (_) {}
                        }
                    } catch (_) {}

                                // 更新 folders 列表（去掉旧名）
                    try {
                        const oldKey = String(oldName || '').trim();
                        const newKey = String(finalName || '').trim();
                        folders = (Array.isArray(folders) ? folders : [])
                            .map(x => String(x || '').trim())
                            .filter(Boolean)
                            .filter(x => x !== oldKey);
                        if (newKey && !folders.includes(newKey)) folders.push(newKey);
                    } catch (_) {}
                    saveFolders();

                                // 更新收藏的 folder 字段（用 trim 归一化比较，避免不可见差异导致迁移不完整）
                    try {
                        const oldKey = String(oldName || '').trim();
                        const newKey = String(finalName || '').trim();
                        favorites.forEach(f => {
                            const fk = String((f && f.folder) || '').trim();
                            if (fk === oldKey) f.folder = newKey || '默认';
                        });
                    } catch (_) {}
                    saveFavorites();

                                // 若当前正在浏览被重命名的目录，则同步更新筛选值
                                if (favFolderFilter === oldName) {
                                    favFolderFilter = finalName;
                                    gnpSetTabFavFolderFilter(favFolderFilter);
                                }

                                renderFavorites();
                            }
                        });
                    }, true);

                    btnDelete.addEventListener('click', (ev) => {
                        stop(ev);
                        if (!isCustomFolder) { try { showSidebarToast('默认/全部不可删除'); } catch (_) {} return; }
                        try { gnpCloseFolderFilterPopup(); } catch (_) {}
                        const folderToDelete = String(val || '').trim();
                        showConfirmInSidebar({
                            titleText: `删除文件夹「${folderToDelete}」？`,
                            descText: '该文件夹及其内全部收藏将被删除（不可撤销）。',
                            confirmText: '确认删除',
                            onConfirm: () => {
                                const now = Date.now();
                                // 删除该文件夹下所有收藏，并写 tombstone，避免被旧快照复活
                                try { deletedFavorites = (deletedFavorites && typeof deletedFavorites === 'object') ? deletedFavorites : {}; } catch (_) {}
                                const toDel = [];
                                favorites.forEach(f => {
                                    if (f && f.folder === folderToDelete) {
                                        const t = String(f.text || '').trim();
                                        if (t) toDel.push(t);
                                    }
                                });
                                favorites = favorites.filter(f => !(f && f.folder === folderToDelete));
                                toDel.forEach(t => { deletedFavorites[t] = now; });
                                // 文件夹删除 tombstone，避免其它标签页/旧快照把文件夹复活
                                try { deletedFolders = (deletedFolders && typeof deletedFolders === 'object') ? deletedFolders : {}; deletedFolders[folderToDelete] = now; } catch (_) {}
                                try { if (restoredFolders && restoredFolders[folderToDelete]) delete restoredFolders[folderToDelete]; } catch (_) {}

                                folders = folders.filter(f => f !== folderToDelete);
                                if (!folders.includes('默认')) folders.unshift('默认');
                                saveFolders();
                                saveFavorites();

                                if (favFolderFilter === folderToDelete) {
                                    favFolderFilter = '全部';
                                    gnpSetTabFavFolderFilter(favFolderFilter);
                                }

                                // 若当前视图可能包含被删除的项，清理多选状态，避免残留
                                try {
                                    const shouldClearSelection = (favFolderFilter === '全部' || favFolderFilter === folderToDelete);
                                    if (shouldClearSelection) { selectedItems.clear(); updateBatchBar(); }
                                } catch (_) {}

                                renderFavorites();
                            }
                        });
                    }, true);

                    actions.append(btnRename, btnDelete);
                    item.appendChild(actions);
                }

                item.addEventListener('mousedown', (ev) => {
                    // 修复：目录项自身用 capture mousedown 选中，但不能抢掉右侧“编辑/删除”按钮的事件
                    try {
                        const t = ev && ev.target;
                        if (t && t.closest && t.closest('.gnp-folder-filter-actions')) return;
                    } catch (_) {}
                    try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
                    try { onPick && onPick(val); } catch (_) {}
                }, true);
                suggest.appendChild(item);
            });
        };

        render();

        // 点击外部关闭
        gnpFolderFilterSuggestOnDocDown = (ev) => {
            try {
                const t = ev && ev.target;
                if (!t) return;
                if (t === anchorEl || (anchorEl.contains && anchorEl.contains(t))) return;
                if (suggest.contains && suggest.contains(t)) return;
                gnpCloseFolderFilterSuggest();
            } catch (_) { gnpCloseFolderFilterSuggest(); }
        };
        try { document.addEventListener('mousedown', gnpFolderFilterSuggestOnDocDown, true); } catch (_) {}

        gnpFolderFilterSuggestEl = suggest;
        sidebar.appendChild(suggest);
    }

    // 仅在“需要切换目录”时弹出搜索框：点击文件夹下拉即可出现（避免常驻输入框与工具栏/图表重叠）
    function gnpOpenFolderFilterPopup(anchorEl, currentValue, allItems, onPick) {
        try { gnpCloseFolderFilterPopup(); } catch (_) {}
        if (!sidebar || !anchorEl) return;

        // 打开时保持侧边栏展开，暂停自动隐藏
        try { keepSidebarExpanded(); } catch (_) {}
        try { isSelectInteracting = true; } catch (_) {}

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'gnp-folder-filter-search-input gnp-folder-filter-search-popup';
        input.placeholder = '搜索文件夹...';
        input.title = '搜索文件夹（实时匹配）';
        input.autocomplete = 'off';
        input.spellcheck = false;

        // 定位在 anchor 下方（侧边栏内部）
        try {
            const a = anchorEl.getBoundingClientRect();
            const s = sidebar.getBoundingClientRect();
            const left = Math.max(12, Math.min(s.width - 12, (a.left - s.left)));
            const top = Math.max(12, (a.bottom - s.top) + 2);
            const minW = Math.max(200, Math.floor(a.width));
            const maxW = Math.max(220, Math.floor(s.width - 24));
            input.style.left = `${Math.min(left, s.width - 12)}px`;
            input.style.top = `${top}px`;
            input.style.minWidth = `${Math.min(minW, maxW)}px`;
            input.style.maxWidth = `${maxW}px`;
        } catch (_) {}

        // 阻止被多选取消/拖拽等逻辑抢事件
        input.addEventListener('mousedown', (e) => { try { e.stopPropagation(); } catch (_) {} }, true);
        input.addEventListener('click', (e) => { try { e.stopPropagation(); } catch (_) {} }, true);

        const openSuggest = () => {
            const kw = String(input.value || '');
            // kw 为空也展示全量列表，便于直接点选
            gnpOpenFolderFilterSuggest(input, kw, allItems, currentValue, (val) => {
                try { onPick && onPick(val); } catch (_) {}
                try { gnpCloseFolderFilterPopup(); } catch (_) {}
            });
        };

        input.addEventListener('input', openSuggest);
        input.addEventListener('keydown', (ev) => {
            try {
                if (!ev) return;
                if (ev.key === 'Escape' || ev.key === 'Esc') {
                    ev.preventDefault();
                    ev.stopPropagation();
                    gnpCloseFolderFilterPopup();
                    return;
                }
                if (!gnpFolderFilterSuggestEl || !gnpFolderFilterSuggestEl.isConnected) return;
                const items = gnpFolderFilterSuggestEl.querySelectorAll('.gnp-folder-filter-item');
                if (!items || !items.length) return;
                if (ev.key === 'ArrowDown' || ev.key === 'Down') {
                    ev.preventDefault();
                    const n = items.length;
                    if (n <= 0) return;
                    if (gnpFolderFilterSuggestActiveIndex < 0) gnpFolderFilterSuggestActiveIndex = 0;
                    else gnpFolderFilterSuggestActiveIndex = (gnpFolderFilterSuggestActiveIndex + 1) % n;
                } else if (ev.key === 'ArrowUp' || ev.key === 'Up') {
                    ev.preventDefault();
                    const n = items.length;
                    if (n <= 0) return;
                    if (gnpFolderFilterSuggestActiveIndex < 0) gnpFolderFilterSuggestActiveIndex = n - 1;
                    else gnpFolderFilterSuggestActiveIndex = (gnpFolderFilterSuggestActiveIndex - 1 + n) % n;
                } else if (ev.key === 'Enter') {
                    ev.preventDefault();
                    const v = gnpFolderFilterSuggestValues[gnpFolderFilterSuggestActiveIndex];
                    if (v) {
                        try { onPick && onPick(v); } catch (_) {}
                        try { gnpCloseFolderFilterPopup(); } catch (_) {}
                    }
                    return;
                } else {
                    return;
                }
                items.forEach((it, idx) => it.classList.toggle('kbd', idx === gnpFolderFilterSuggestActiveIndex));
                try {
                    const target = items[gnpFolderFilterSuggestActiveIndex];
                    if (target) target.scrollIntoView({ block: 'nearest' });
                } catch (_) {}
            } catch (_) {}
        });

        input.addEventListener('blur', () => {
            // 点击建议项时由 mousedown 处理，这里延迟关闭。
            // 注意：在某些浏览器/站点组合下，点击 select 会把焦点抢回给 select，
            // 如果此时立刻关闭，会表现为“搜索框/下拉闪退”。因此当焦点回到 anchorEl 时不自动关闭。
            setTimeout(() => {
                try {
                    const ae = document.activeElement;
                    if (ae && (ae === input || (gnpFolderFilterSuggestEl && gnpFolderFilterSuggestEl.contains && gnpFolderFilterSuggestEl.contains(ae)))) return;
                    if (ae && (ae === anchorEl || (anchorEl.contains && anchorEl.contains(ae)))) return;
                } catch (_) {}
                gnpCloseFolderFilterPopup();
            }, 160);
        });

        // 点击外部关闭（但点击 anchor/select 不关闭，便于再次打开）
        gnpFolderFilterPopupOnDocDown = (ev) => {
            try {
                const t = ev && ev.target;
                if (!t) return;
                if (t === anchorEl || (anchorEl.contains && anchorEl.contains(t))) return;
                if (t === input || (input.contains && input.contains(t))) return;
                if (gnpFolderFilterSuggestEl && gnpFolderFilterSuggestEl.contains && gnpFolderFilterSuggestEl.contains(t)) return;
                gnpCloseFolderFilterPopup();
            } catch (_) { gnpCloseFolderFilterPopup(); }
        };
        try { document.addEventListener('mousedown', gnpFolderFilterPopupOnDocDown, true); } catch (_) {}

        gnpFolderFilterPopupInputEl = input;
        sidebar.appendChild(input);

        // 默认展示全量列表
        openSuggest();
        // 尽量在当前事件周期内抢到焦点，避免被 select 的默认聚焦行为抢回导致“闪退”
        try { input.focus(); } catch (_) {}
        try { anchorEl.blur(); } catch (_) {}
        setTimeout(() => { try { input.focus(); input.select(); } catch (_) {} }, 0);
    }

    function renderFavorites() {
        if (!panelFav.classList.contains('active')) return;
		// 下拉菜单交互中暂停重绘，避免被 MutationObserver 的 2s 刷新销毁并自动关闭
		if (isSelectInteracting) { gnpPendingFavRerender = true; return; }
		gnpPendingFavRerender = false;
        panelFav.replaceChildren();
        // 每次重绘前清理文件夹搜索建议列表（避免残留在侧边栏中）
        try { gnpCloseFolderFilterSuggest(); } catch (_) {}
        try { gnpCloseFolderFilterPopup(); } catch (_) {}

        const totalCount = favorites.length;

        // 过滤：文件夹
        const effectiveFilter = (folders.includes(favFolderFilter) || favFolderFilter === '全部') ? favFolderFilter : '全部';
        if (effectiveFilter !== favFolderFilter) {
            favFolderFilter = effectiveFilter;
            gnpSetTabFavFolderFilter(favFolderFilter);
        }

        const filteredFavorites = (favFolderFilter === '全部')
            ? favorites
            : favorites.filter(f => f.folder === favFolderFilter);

        // 排序：按星级倒序 > 最近使用时间倒序
        filteredFavorites.sort((a, b) => {
            const rA = Number(a.rating) || 1;
            const rB = Number(b.rating) || 1;
            if (rA !== rB) return rB - rA; // 星级高的排前面
            return (Number(b.lastUsed) || 0) - (Number(a.lastUsed) || 0);
        });

        // 当前网页 prompt：若该 prompt 已在收藏中，则在收藏列表也用“当前 prompt”的高亮样式
        let gnpCurrentPromptText = '';
        /*try {
            const blocks = qsaAll(CURRENT_CONFIG.promptSelector, getChatRoot());
            const b = blocks && blocks[currentActiveIndex];
            if (b) gnpCurrentPromptText = String(b.innerText || '').replace(/\n+/g, ' ').trim();
        } catch (_) {}*/

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
        // 目录名过长会把右侧工具图标“挤”到一起：在这里限制显示宽度，并配合 option 文案截断（最多 6 个字符 + ...）
        folderSelect.style.cssText = 'font-size:12px;background:rgba(0,0,0,0.04);border:1px solid var(--gnp-border);border-radius:10px;padding:3px 8px;color:var(--gnp-text-main);max-width:140px;width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

        // 下拉选择时暂停自动隐藏（原生下拉浮层会触发 sidebar mouseleave，导致菜单自动消失）
        folderSelect.addEventListener('focus', () => { 
            isSelectInteracting = true; 
            if (isAutoHideEnabled) { clearTimeout(autoHideTimer); sidebar.classList.remove('collapsed'); }
        });
		folderSelect.addEventListener('blur', () => {
			// 若已弹出“搜索切换目录”的浮层，焦点会从 select 转移到浮层 input，
			// 这里不能立刻结束交互状态，否则会触发重绘把浮层销毁，表现为“闪退”。
			try {
				if (gnpFolderFilterPopupInputEl && gnpFolderFilterPopupInputEl.isConnected) return;
			} catch (_) {}
			isSelectInteracting = false;
			// 若交互期间有刷新请求被抑制，则在关闭下拉后补一次重绘
			if (gnpPendingFavRerender) { gnpPendingFavRerender = false; renderFavorites(); }
		});
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

        const __folderFilterItems = (() => {
            const fs = Array.isArray(folders) ? folders.slice() : [];
            const hasDefault = fs.includes('默认');
            const others = fs.filter(x => x && x !== '默认');
            const seen = new Set();
            const uniq = [];
            others.forEach(x => {
                const s = String(x);
                if (!s) return;
                if (seen.has(s)) return;
                seen.add(s);
                uniq.push(s);
            });
            uniq.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }));
            const ordered = ['全部'];
            if (hasDefault) ordered.push('默认');
            ordered.push(...uniq);
            return ordered;
        })();

        // 仅用于“切换目录”选择框的显示：最多显示 6 个字符，多余部分用 ...
        const gnpTruncFolderNameForSelect = (name, maxChars = 6) => {
            const s = String(name ?? '');
            if (!s) return s;
            return s.length > maxChars ? (s.slice(0, maxChars) + '...') : s;
        };

        __folderFilterItems.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f;
            opt.textContent = gnpTruncFolderNameForSelect(f, 6);
            // 鼠标悬停可看到全名（即使显示被截断）
            opt.title = String(f);
            folderSelect.append(opt);
        });

        folderSelect.value = favFolderFilter;
        const applyFolderFilterSelection = (val) => {
            isSelectInteracting = false;
            favFolderFilter = String(val || '全部');
            gnpSetTabFavFolderFilter(favFolderFilter);
            selectedItems.clear();
            updateBatchBar();
            renderFavorites();
        };
        folderSelect.onchange = () => applyFolderFilterSelection(folderSelect.value);

        // 仅在需要切换目录时显示搜索框：点击“切换目录”下拉框时弹出可搜索列表
        const openFolderFilterPopup = (ev) => {
            try {
                if (ev) {
                    ev.preventDefault();
                    // 阻止同一事件链路的其它监听器（避免 mousedown/click/key 连续触发导致反复开关）
                    if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
                    ev.stopPropagation();
                }
            } catch (_) {}

            // 若已打开浮层，重复触发只需把焦点拉回即可，避免“闪一下又重建”
            try {
                if (gnpFolderFilterPopupInputEl && gnpFolderFilterPopupInputEl.isConnected) {
                    gnpFolderFilterPopupInputEl.focus();
                    return;
                }
            } catch (_) {}
            const allItems = __folderFilterItems;
            gnpOpenFolderFilterPopup(folderSelect, folderSelect.value, allItems, (val) => {
                applyFolderFilterSelection(val);
            });
        };
        // 捕获阶段拦截，避免原生 select 打开导致遮挡/冲突
        // pointerdown 比 mousedown 更早，能更稳地阻止原生 select 下拉闪现
        folderSelect.addEventListener('pointerdown', openFolderFilterPopup, true);
        folderSelect.addEventListener('mousedown', openFolderFilterPopup, true);
        folderSelect.addEventListener('click', openFolderFilterPopup, true);
        folderSelect.addEventListener('keydown', (ev) => {
            try {
                if (!ev) return;
                // 弹层打开时由弹层 input 处理键盘
                try {
                    if (gnpFolderFilterPopupInputEl && gnpFolderFilterPopupInputEl.isConnected) return;
                } catch (_) {}
                const k = ev.key;
                // ↑/↓：在目录选项间循环选择（最后一项再按 ↓ 回到第一项；第一项按 ↑ 回到最后一项）
                if (k === 'ArrowDown' || k === 'Down' || k === 'ArrowUp' || k === 'Up') {
                    ev.preventDefault();
                    ev.stopPropagation();
                    const n = (folderSelect && folderSelect.options) ? folderSelect.options.length : 0;
                    if (!n) return;
                    let idx = folderSelect.selectedIndex;
                    if (idx < 0) idx = 0;
                    if (k === 'ArrowDown' || k === 'Down') idx = (idx + 1) % n;
                    else idx = (idx - 1 + n) % n;
                    folderSelect.selectedIndex = idx;
                    applyFolderFilterSelection(folderSelect.value);
                    return;
                }
                if (k === 'Enter' || k === ' ') openFolderFilterPopup(ev);
            } catch (_) {}
        }, true);

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
                    gnpSetTabFavFolderFilter(favFolderFilter);
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

                    // ✅ Rename must create a tombstone for old folder to prevent sync "revive"
                    try {
                        const now = gnpNow();
                        const oldKey = String(oldName || '').trim();
                        const newKey = String(finalName || '').trim();
                        if (oldKey && newKey && oldKey !== newKey) {
                            deletedFolders = (deletedFolders && typeof deletedFolders === 'object') ? deletedFolders : {};
                            deletedFolders[oldKey] = now;
                            try { if (restoredFolders && restoredFolders[oldKey]) delete restoredFolders[oldKey]; } catch (_) {}
                        }
                    } catch (_) {}

                    // 更新 folders 列表（去掉旧名）
                    try {
                        const oldKey = String(oldName || '').trim();
                        const newKey = String(finalName || '').trim();
                        folders = (Array.isArray(folders) ? folders : [])
                            .map(x => String(x || '').trim())
                            .filter(Boolean)
                            .filter(x => x !== oldKey);
                        if (newKey && !folders.includes(newKey)) folders.push(newKey);
                    } catch (_) {}
                    saveFolders();

                    // 更新收藏的 folder 字段（用 trim 归一化比较，避免不可见差异导致迁移不完整）
                    try {
                        const oldKey = String(oldName || '').trim();
                        const newKey = String(finalName || '').trim();
                        favorites.forEach(f => {
                            const fk = String((f && f.folder) || '').trim();
                            if (fk === oldKey) f.folder = newKey || '默认';
                        });
                    } catch (_) {}
                    saveFavorites();

                    favFolderFilter = finalName;
                    gnpSetTabFavFolderFilter(favFolderFilter);
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
                descText: '该文件夹及其内全部收藏将被删除（不可撤销）。',
                confirmText: '确认删除',
                onConfirm: () => {
                    const now = Date.now();
                    // 删除该文件夹下所有收藏，并写 tombstone，避免被旧快照复活
                    try { deletedFavorites = (deletedFavorites && typeof deletedFavorites === 'object') ? deletedFavorites : {}; } catch (_) {}
                    const toDel = [];
                    favorites.forEach(f => {
                        if (f && f.folder === folderToDelete) {
                            const t = String(f.text || '').trim();
                            if (t) toDel.push(t);
                        }
                    });
                    favorites = favorites.filter(f => !(f && f.folder === folderToDelete));
                    toDel.forEach(t => { deletedFavorites[t] = now; });
                    // 文件夹删除 tombstone，避免其它标签页/旧快照把文件夹复活
                    try { deletedFolders = (deletedFolders && typeof deletedFolders === 'object') ? deletedFolders : {}; deletedFolders[folderToDelete] = now; } catch (_) {}
                    try { if (restoredFolders && restoredFolders[folderToDelete]) delete restoredFolders[folderToDelete]; } catch (_) {}

                    folders = folders.filter(f => f !== folderToDelete);
                    if (!folders.includes('默认')) folders.unshift('默认');
                    saveFolders();
                    saveFavorites();
                    favFolderFilter = '全部';
                    gnpSetTabFavFolderFilter(favFolderFilter);
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
                // 关键修复：清空全部也必须写 tombstone，避免被旧快照/JSON 合并复活
                const now = Date.now();
                try {
                    deletedFavorites = (deletedFavorites && typeof deletedFavorites === 'object') ? deletedFavorites : {};
                    favorites.forEach(f => {
                        const t = String((f && f.text) || '').trim();
                        if (!t) return;
                        deletedFavorites[t] = now;
                        if (restoredFavorites && restoredFavorites[t]) delete restoredFavorites[t];
                    });
                } catch (_) {}
                favorites = [];
                saveFavorites('fav_list');
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



        const importJsonBtn = document.createElement('div');
        importJsonBtn.className = 'header-circle-btn gnp-import-json-btn';
        importJsonBtn.title = '从JSON导入收藏（自动去重并回写到本地JSON）';
        importJsonBtn.setAttribute('role', 'button');
        importJsonBtn.setAttribute('tabindex', '0');
        importJsonBtn.setAttribute('aria-label', '从JSON导入收藏');
        importJsonBtn.innerHTML = SVGS.fileImport;

        const openImportJson = (e) => {
            try {
                if (e) { e.preventDefault(); e.stopPropagation(); }
                gnpPickAndImportFavoritesJsonFile();
            } catch (err) {
                try { console.error('[GNP] openImportJson failed:', err); } catch (_) {}
                try { showSidebarToast('打开“导入JSON”失败（请查看控制台）'); } catch (_) {}
            }
        };
        importJsonBtn.addEventListener('mousedown', openImportJson, true);
        importJsonBtn.addEventListener('click', (e) => { try { e.preventDefault(); e.stopPropagation(); } catch (_) {} }, true);
        importJsonBtn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') openImportJson(e);
        });

        const addPromptBtn = document.createElement('div');
        addPromptBtn.className = 'header-circle-btn gnp-add-prompt-btn';
        addPromptBtn.title = '手动添加 Prompt';
        addPromptBtn.setAttribute('role', 'button');
        addPromptBtn.setAttribute('tabindex', '0');
        addPromptBtn.setAttribute('aria-label', '手动添加 Prompt');
        addPromptBtn.innerHTML = SVGS.plus;

        const openAddPrompt = (e) => {
            try {
                if (e) { e.preventDefault(); e.stopPropagation(); }
                showAddFavoritePromptInSidebar(favFolderFilter);
            } catch (err) {
                try { console.error('[GNP] openAddPrompt failed:', err); } catch (_) {}
                try { showSidebarToast('打开“手动添加 Prompt”失败（请查看控制台）'); } catch (_) {}
            }
        };

        // 用 mousedown 捕获阶段打开，避免某些站点/拖拽逻辑吃掉 click
        addPromptBtn.addEventListener('mousedown', openAddPrompt, true);
        addPromptBtn.addEventListener('click', (e) => { try { e.preventDefault(); e.stopPropagation(); } catch (_) {} }, true);
        addPromptBtn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') openAddPrompt(e);
        });

rightBox.append(importJsonBtn, addPromptBtn, newFolderBtn, renameFolderBtn, deleteFolderBtn, clearAllBtn);
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

        // 批量插入：使用 DocumentFragment 减少多次 append 触发的重排
        const __gnpFavFrag = document.createDocumentFragment();
        filteredFavorites.forEach((favObj, idx) => {
            const favText = favObj.text;
            const itemIndex = favorites.indexOf(favObj);

            const item = document.createElement('div');
            item.className = 'gemini-nav-item';
            if (selectedItems.has(favText)) item.classList.add('multi-selected');
            item.dataset.prompt = favText;
            item.dataset.gnpSource = 'fav';
            bindHoverPreviewToItem(item);
            // 若该收藏条目就是网页当前 prompt，则在收藏列表也标记为“当前”
            try {
                const nt = String(favText || '').replace(/\n+/g, ' ').trim();
                if (gnpCurrentPromptText && nt && nt === gnpCurrentPromptText) item.classList.add('active-current');
            } catch (_) {}
            item.draggable = true;

// --- 多选逻辑注入 ---
            item.onclick = (e) => {
                e.stopPropagation();

                const isMulti = e.metaKey || e.ctrlKey;

                // 1. 数据层更新
                if (isMulti) {
                    // Command/Ctrl + 单击：进入多选模式
                    inMultiSelectMode = true; // 进入多选模式

                    if (selectedItems.has(favText)) {
                        selectedItems.delete(favText);
                    } else {
                        selectedItems.add(favText);
                    }
                } else {
                    // 普通单击：加入 selectedItems（为后续 Cmd+单击做准备），但不进入多选模式
                    inMultiSelectMode = false; // 不进入多选模式
                    selectedItems.clear();
                    selectedItems.add(favText);
                }

                // 2. 视觉层同步
                const panel = item.closest('.content-panel');
                if (panel) {
                    // 清除所有高亮
                    panel.querySelectorAll('.gemini-nav-item.multi-selected').forEach(el => {
                        el.classList.remove('multi-selected');
                    });

                    // 仅在多选模式下显示高亮
                    if (inMultiSelectMode) {
                        panel.querySelectorAll('.gemini-nav-item').forEach(el => {
                            const promptText = el.dataset.prompt;
                            if (selectedItems.has(promptText)) {
                                el.classList.add('multi-selected');
                            }
                        });
                    }
                }

                updateBatchBar(); // 根据 inMultiSelectMode 决定是否显示批量栏

                // 同步键盘选择（用于上下键导航）
                if (!isMulti) {
                    syncKeyboardSelectionToClickedItem(item);
                }
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
            folderBadge.textContent = gnpTruncateFolderName(favObj.folder || '默认', 6);
            folderBadge.title = '点击移动到其他文件夹';
            folderBadge.onclick = (e) => { e.stopPropagation(); gnpMoveFavoriteToFolder(favText, favObj.folder || '默认'); };

            const starDisplay = document.createElement('span');
            starDisplay.className = 'gnp-item-stars';
            
            // [修改] 动态评级：渲染5颗星，支持点击调整
            const updateStarUI = (currentR) => {
                starDisplay.innerHTML = '';
                for (let i = 1; i <= 5; i++) {
                    const s = document.createElement('span');
                    s.textContent = i <= currentR ? '★' : '☆';
                    s.style.cursor = 'pointer';
                    s.style.padding = '0 0.5px'; 
                    s.title = `设置 ${i} 星`;
                    s.onclick = (e) => {
                        e.stopPropagation();
                        favObj.rating = i;
                        updateStarUI(i); // 立即刷新显示
                        saveFavorites('fav_list'); // 保存并回写文件
                    };
                    starDisplay.appendChild(s);
                }
                starDisplay.title = `当前 ${currentR} 星 (点击调整)`;
            };
            updateStarUI(Number(favObj.rating) || 1);

            starDisplay.addEventListener('mousedown', (e) => e.stopPropagation());

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

            const moveFolderBtn = document.createElement('span');
            moveFolderBtn.className = 'mini-btn';
            moveFolderBtn.innerHTML = SVGS.folderMove;
            moveFolderBtn.title = '更改所属文件夹';
            moveFolderBtn.onclick = (e) => { e.stopPropagation(); gnpMoveFavoriteToFolder(favText, favObj.folder || '默认'); };

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
                // recordPromptUse(favText); <-- 已移除
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
                            renameFavorite(favText, trimmedNew);
                            saveFavorites();
                            renderFavorites();
                        } else {
                            // 已存在：合并（删除当前条）
                            removeFavorite(favText);
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
                    const obj = favorites[itemIndex];
                    favorites.splice(itemIndex, 1);
                    favorites.unshift(obj);
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
                removeFavorite(favText);
                if (selectedItems.has(favText)) selectedItems.delete(favText);
                saveFavorites();
                renderFavorites();
            };

            toolbar.append(moveFolderBtn, useBtn, copyBtn, editBtn, pinBtn, delBtn);
            item.append(folderBadge, useMeta, starDisplay, txt, toolbar);
            __gnpFavFrag.append(item);
        });
        panelFav.append(__gnpFavFrag);

        if (searchInput.value) searchInput.dispatchEvent(new Event('input'));
        restoreKeyboardSelection(panelFav);
    
        // 让每条 Prompt 的⚡按钮跟随顶部“自动发送”开关变色
        syncAutosendButtonsUI(panelFav || sidebar || document);
}

	let lastPageSignature = ''; // [Fix v2] 更稳健的页面指纹（长度+首+尾）
    let observer = null;

    // [Fix v2] 生成轻量级页面指纹，避免遍历所有节点导致性能问题
    function generatePageSignature(blocks) {
        if (!blocks || blocks.length === 0) return 'empty';
        const len = blocks.length;
        // 获取首尾文本摘要（只取前50字符，避免内存浪费）
        const firstTxt = (blocks[0].innerText || '').slice(0, 50).trim();
        const lastTxt = (blocks[len - 1].innerText || '').slice(0, 50).trim();
        // 组合成唯一指纹：数量|首|尾
        return `${len}|${firstTxt}|${lastTxt}`;
    }

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

        // [Fix v2] 生成当前页面指纹
        const currentSig = generatePageSignature(blocks);

        // 如果指纹未变且非强制刷新，直接跳过
        if (!force && currentSig === lastPageSignature) return;

        // 更新指纹记录
        lastPageSignature = currentSig;
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

        // 批量插入：使用 DocumentFragment 减少多次 append 触发的重排
        const __gnpNavFrag = document.createDocumentFragment();
        listData.forEach(({ block, originalIndex }, i) => {
            const content = block.innerText.replace(/\n+/g, ' ').trim();
            if (!content) return;

            // 收藏判断：同时拿到所属文件夹（用于导航面板展示“收藏到哪个文件夹”）
            const favIdx = getFavoriteIndex(content);
            const isFav = favIdx !== -1;
            const favFolderName = isFav ? String((favorites[favIdx] && favorites[favIdx].folder) || '').trim() : '';

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
                e.stopPropagation();

                const isMulti = e.metaKey || e.ctrlKey;

                // 1. 数据层更新
                if (isMulti) {
                    // Command/Ctrl + 单击：进入多选模式
                    inMultiSelectMode = true; // 进入多选模式

                    if (selectedItems.has(content)) {
                        selectedItems.delete(content);
                    } else {
                        selectedItems.add(content);
                    }
                } else {
                    // 普通单击：加入 selectedItems（为后续 Cmd+单击做准备），但不进入多选模式
                    inMultiSelectMode = false; // 不进入多选模式
                    selectedItems.clear();
                    selectedItems.add(content);
                }

                // 2. 视觉层同步
                const panel = item.closest('.content-panel');
                if (panel) {
                    // 清除所有高亮
                    panel.querySelectorAll('.gemini-nav-item.multi-selected').forEach(el => {
                        el.classList.remove('multi-selected');
                    });

                    // 仅在多选模式下显示高亮
                    if (inMultiSelectMode) {
                        panel.querySelectorAll('.gemini-nav-item').forEach(el => {
                            const promptText = el.dataset.prompt;
                            if (selectedItems.has(promptText)) {
                                el.classList.add('multi-selected');
                            }
                        });
                    }
                }

                updateBatchBar(); // 根据 inMultiSelectMode 决定是否显示批量栏

                // 同步键盘选择（用于上下键导航）
                if (!isMulti) {
                    syncKeyboardSelectionToClickedItem(item);
                }
            };

            // 双击：定位到对话中的原始位置（保留原功能）
            item.ondblclick = (e) => {
                try {
                    if (e) e.stopPropagation();
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
                } catch (_) {}
            };

            const toolbar = document.createElement('div');
            toolbar.className = 'bottom-toolbar';
            toolbar.addEventListener('mousedown', (e) => e.stopPropagation()); 

            // 已收藏：显示所属文件夹名称（放在“使用时间”左侧）
            const folderBadge = document.createElement('span');
            folderBadge.className = 'gnp-nav-folder-badge';
            folderBadge.addEventListener('mousedown', (e) => e.stopPropagation());
            folderBadge.addEventListener('click', (e) => e.stopPropagation());

            const setFolderBadge = (folderName) => {
                try {
                    const full = String(folderName || '').trim();
                    if (!full) {
                        folderBadge.style.display = 'none';
                        folderBadge.textContent = '';
                        folderBadge.title = '';
                        return;
                    }
                    // [修正] 目录名称（文件夹名）最多显示 6 个字符
                    const short = (full.length > 6) ? (full.slice(0, 6) + '…') : full;
                    folderBadge.textContent = short;
                    folderBadge.title = full;
                    folderBadge.style.display = 'inline-flex';
                } catch (_) {}
            };

            setFolderBadge(favFolderName);

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
                // recordPromptUse(content); <-- 已移除
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
                    const targetFolderDefault = (favFolderFilter && favFolderFilter !== '全部') ? favFolderFilter : '默认';

                    // 弹出“文件夹选择”弹层（在插件窗口内）
                    showFavFolderPickerInSidebar({
                        promptText: content,
                        defaultFolder: targetFolderDefault,
                        onConfirm: (folder, rating) => {
                            if (!addFavorite(content, folder, rating)) return;
                            saveFavorites();
                            showSidebarToast(`已收藏到「${folder}」`);
                            setFolderBadge(folder);
                            starBtn.textContent = '★';
                            starBtn.classList.add('is-fav');
                            item.classList.add('is-favorite');

                            // 若收藏窗正在显示，同步刷新
                            if (panelFav && panelFav.classList.contains('active')) renderFavorites();
                        }
                    });
                } else {
                    removeFavorite(content);
                    saveFavorites();
                    showSidebarToast('已取消收藏');
                    setFolderBadge('');
                    starBtn.textContent = '☆';
                    starBtn.classList.remove('is-fav');
                    item.classList.remove('is-favorite');

                    if (panelFav && panelFav.classList.contains('active')) renderFavorites();
                }
            };

            toolbar.append(folderBadge, useTime, useBtn, copyBtn, starBtn);
            item.append(txt, toolbar); 
            __gnpNavFrag.append(item);
        });
        panelNav.append(__gnpNavFrag);

        if (searchInput.value) searchInput.dispatchEvent(new Event('input'));
        restoreKeyboardSelection(panelNav);

        // 让每条 Prompt 的⚡按钮跟随顶部“自动发送”开关变色
        syncAutosendButtonsUI(panelNav || sidebar || document);
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

        // ✅ 修复：即使处于“锁定/不自动隐藏”模式，只要当前是折叠态（例如按 F1 折叠），
        // 鼠标移入悬浮框也应该立即展开。
        clearTimeout(autoHideTimer);
        if (sidebar.classList.contains('collapsed')) {
            sidebar.classList.remove('collapsed');
            scrollToActive();
            return;
        }

        // 自动隐藏模式下：移入即展开并取消计时
        if (isAutoHideEnabled) {
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

            // [新增] Esc 优先取消多选 (全局生效，无需鼠标悬停侧边栏)
            // 逻辑：只要有选中项(selectedItems > 0)，Esc 就专用于取消选择
            if (typeof selectedItems !== 'undefined' && selectedItems.size > 0) {
                // 1. 关键检查：如果当前有“确认弹窗”或“编辑弹窗”打开，Esc 应该优先关闭弹窗
                // 此时不要取消底层的多选状态，直接 return 让弹窗自己的监听器去处理 Esc
                if (document.querySelector('.gnp-confirm-overlay, .gnp-global-overlay')) {
                    return; 
                }

                // 2. 执行取消多选
                e.preventDefault();
                e.stopPropagation();

                if (typeof clearMultiSelection === 'function') {
                    clearMultiSelection();
                } else {
                    // 兜底逻辑
                    selectedItems.clear();
                    // 兼容可能使用的不同类名
                    document.querySelectorAll('.gemini-nav-item.multi-selected, .gnp-selected').forEach(el => {
                        el.classList.remove('multi-selected', 'gnp-selected');
                    });
                    if (typeof updateBatchBar === 'function') updateBatchBar();
                }
                return; // 阻止后续逻辑（如折叠侧边栏）
            }

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
        // 增加延迟到2秒，减少刷新频率，降低资源占用
        window.geminiRefreshTimer = setTimeout(() => { refreshNav(); renderFavorites(); }, 2000);
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
            lastPageSignature = ''; // [Fix v2] URL 变更时重置指纹
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


    // ===== Theme Management System (v8.0新增) =====
    let currentThemeMode = 'auto'; // 'auto' | 'light' | 'dark'

    function detectPageTheme() {
        const html = document.documentElement;
        const body = document.body;

        const dataTheme = html.getAttribute('data-theme') || body.getAttribute('data-theme');
        const dataColorMode = html.getAttribute('data-color-mode') || body.getAttribute('data-color-mode');
        const htmlClass = (html.className || '').toLowerCase();
        const bodyClass = (body.className || '').toLowerCase();

        if (dataTheme === 'dark' || dataColorMode === 'dark' || 
            htmlClass.includes('dark') || bodyClass.includes('dark')) {
            return 'dark';
        }

        if (dataTheme === 'light' || dataColorMode === 'light' ||
            htmlClass.includes('light') || bodyClass.includes('light')) {
            return 'light';
        }

        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            return 'dark';
        }

        return 'light';
    }

    function applyTheme(mode) {
        if (!sidebar) return;

        if (mode === 'auto') {
            sidebar.removeAttribute('data-gnp-theme');
            document.documentElement.removeAttribute('data-gnp-theme');
        } else {
            sidebar.setAttribute('data-gnp-theme', mode);
            document.documentElement.setAttribute('data-gnp-theme', mode);
        }

        currentThemeMode = mode;
        try {
            localStorage.setItem(STORAGE_KEY_THEME, JSON.stringify(mode));
        } catch (_) {}
        updateThemeIcon();
    }

    function cycleTheme() {
        const modes = ['auto', 'light', 'dark'];
        const currentIndex = modes.indexOf(currentThemeMode);
        const nextMode = modes[(currentIndex + 1) % modes.length];
        applyTheme(nextMode);
    }

    function updateThemeIcon() {
        const themeBtnEl = document.getElementById('gemini-nav-theme');
        if (!themeBtnEl) return;

        const icons = {
            'auto': '🌗',
            'light': '☀️',
            'dark': '🌙'
        };

        themeBtnEl.textContent = icons[currentThemeMode] || '🌗';
        themeBtnEl.title = `主题: ${currentThemeMode} (点击切换)`;
    }

    function watchPageTheme() {
        try {
            const observer = new MutationObserver(() => {
                if (currentThemeMode === 'auto') {
                    detectPageTheme();
                }
            });

            observer.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ['data-theme', 'data-color-mode', 'class']
            });

            observer.observe(document.body, {
                attributes: true,
                attributeFilter: ['data-theme', 'data-color-mode', 'class']
            });

            if (window.matchMedia) {
                window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
                    if (currentThemeMode === 'auto') {
                        updateThemeIcon();
                    }
                });
            }
        } catch (_) {}
    }

    // ===== Keyboard Navigation System (v8.0新增) =====
    let keyboardSelectedIndex = -1;
    let currentVisibleItems = [];
    let keyboardSelectedPrompt = '';


    function syncKeyboardSelectionToClickedItem(itemEl) {
        try {
            if (!itemEl || !sidebar) return;
            const activePanel = sidebar.querySelector('.content-panel.active');
            if (!activePanel) return;
            currentVisibleItems = Array.from(activePanel.querySelectorAll('.gemini-nav-item')).filter(it => it.offsetParent !== null);
            const idx = currentVisibleItems.indexOf(itemEl);
            if (idx < 0) return;
            keyboardSelectedIndex = idx;
            keyboardSelectedPrompt = itemEl.dataset && itemEl.dataset.prompt ? itemEl.dataset.prompt : '';
            updateKeyboardSelection();
        } catch (_) {}
    }

    function updateKeyboardSelection() {
        try {
            currentVisibleItems.forEach(item => {
                item.classList.remove('keyboard-selected');
            });

            if (keyboardSelectedIndex >= 0 && keyboardSelectedIndex < currentVisibleItems.length) {
                const selectedItem = currentVisibleItems[keyboardSelectedIndex];
                selectedItem.classList.add('keyboard-selected');
                // 记录选中项，用于在收藏/导航重渲染后恢复高亮
                keyboardSelectedPrompt = selectedItem.dataset && selectedItem.dataset.prompt ? selectedItem.dataset.prompt : (keyboardSelectedPrompt || '');
                selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        } catch (_) {}
    }


    function restoreKeyboardSelection(panelEl) {
        try {
            if (!panelEl || !keyboardSelectedPrompt) return;

            const items = Array.from(panelEl.querySelectorAll('.gemini-nav-item')).filter(item => item.offsetParent !== null);
            const idx = items.findIndex(it => (it.dataset && it.dataset.prompt) === keyboardSelectedPrompt);
            if (idx < 0) return;

            keyboardSelectedIndex = idx;
            currentVisibleItems = items;
            updateKeyboardSelection();
        } catch (_) {}
    }

function handleKeyboardNavigation(e) {
        try {
            if (!sidebar || !e) return;

            const activePanel = sidebar.querySelector('.content-panel.active');
            if (!activePanel) return;

            // 弹层打开时（新建/重命名/删除文件夹等）：不要让全局键盘导航逻辑抢走按键
            const __t0 = e.target;
            if ((__t0 && __t0.closest && __t0.closest('.gnp-confirm-overlay, .gnp-global-overlay')) ||
                (document.activeElement && document.activeElement.closest && document.activeElement.closest('.gnp-confirm-overlay, .gnp-global-overlay')) ||
                (sidebar && sidebar.querySelector && sidebar.querySelector('.gnp-confirm-overlay, .gnp-global-overlay')))
            {
                return;
            }

            const __ae = document.activeElement;
            const __folderSwitchActive = (
                (!!gnpFolderFilterPopupInputEl && gnpFolderFilterPopupInputEl.isConnected) ||
                (!!gnpFolderFilterSuggestEl && gnpFolderFilterSuggestEl.isConnected) ||
                (__ae && __ae.classList && (__ae.classList.contains('gnp-folder-select') || __ae.classList.contains('gnp-folder-filter-search-input'))) ||
                (__ae && __ae.tagName === 'SELECT' && __ae.closest && __ae.closest('#panel-fav')) ||
                (__ae && __ae.closest && __ae.closest('.gnp-folder-filter-suggest'))
            );
            if (__folderSwitchActive) {
                // 切换目录/选择文件夹交互中：方向键/回车/ESC 交给下拉/搜索浮层处理，避免误选中 prompt
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape' || e.key === 'Esc') {
                    return;
                }
            }

            const isSearchFocused = document.activeElement === searchInput;

            // Esc - 关闭弹窗/清除搜索/失去焦点
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();

                if (isSearchFocused && searchInput && searchInput.value) {
                    searchInput.value = '';
                    searchInput.dispatchEvent(new Event('input'));
                    keyboardSelectedIndex = -1;
                    updateKeyboardSelection();
                } else if (isSearchFocused && searchInput) {
                    searchInput.blur();
                    keyboardSelectedIndex = -1;
                    updateKeyboardSelection();
                } else if (!sidebar.classList.contains('collapsed')) {
                    sidebar.classList.add('collapsed');
                    try { gnpOpenedByShortcut = false; } catch (_) {}
                }
                return;
            }

            // Ctrl/Cmd + K - 聚焦搜索
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                e.stopPropagation();
                if (searchInput) {
                    searchInput.focus();
                    searchInput.select();
                }
                keyboardSelectedIndex = -1;
                updateKeyboardSelection();
                return;
            }

            if (!isSearchFocused && sidebar.classList.contains('collapsed')) {
                return;
            }

            // 上下键导航
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();

                currentVisibleItems = Array.from(activePanel.querySelectorAll('.gemini-nav-item')).filter(item => {
                    return item.offsetParent !== null;
                });

                if (currentVisibleItems.length === 0) return;

                if (e.key === 'ArrowDown') {
                    keyboardSelectedIndex = Math.min(keyboardSelectedIndex + 1, currentVisibleItems.length - 1);
                } else {
                    keyboardSelectedIndex = Math.max(keyboardSelectedIndex - 1, 0);
                }

                updateKeyboardSelection();

                if (isSearchFocused && searchInput) {
                    searchInput.focus();
                }
                return;
            }

            // Enter - 填入选中项
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();

                if (keyboardSelectedIndex >= 0 && keyboardSelectedIndex < currentVisibleItems.length) {
                    const selectedItem = currentVisibleItems[keyboardSelectedIndex];
                    const textEl = selectedItem.querySelector('.item-text');
                    let text = (selectedItem.dataset && selectedItem.dataset.prompt) ? selectedItem.dataset.prompt : (textEl ? textEl.textContent : '');
                    try { text = (text || '').replace(/^\s*\d+\.\s*/, '').trim(); } catch (_) {}

                    if (text) {
                        const inputEl = qsAny(CURRENT_CONFIG.inputSelector);
                        if (inputEl) {
                            setPromptValue(inputEl, text);
                            if (searchInput) searchInput.blur();
                            setTimeout(() => {
                                inputEl.focus();
                            }, 100);
                        }
                    }
                }
                return;
            }

            // Shift + Enter - 直接发送
            if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();

                if (keyboardSelectedIndex >= 0 && keyboardSelectedIndex < currentVisibleItems.length) {
                    const selectedItem = currentVisibleItems[keyboardSelectedIndex];
                    const textEl = selectedItem.querySelector('.item-text');
                    let text = (selectedItem.dataset && selectedItem.dataset.prompt) ? selectedItem.dataset.prompt : (textEl ? textEl.textContent : '');
                    try { text = (text || '').replace(/^\s*\d+\.\s*/, '').trim(); } catch (_) {}

                    if (text) {
                        const inputEl = qsAny(CURRENT_CONFIG.inputSelector);
                        const sendBtn = qsAny(CURRENT_CONFIG.sendBtnSelector);

                        if (inputEl && sendBtn) {
                            setPromptValue(inputEl, text);

                            setTimeout(() => {
                                sendBtn.click();
                                if (searchInput) searchInput.blur();
                            }, 100);
                        }
                    }
                }
                return;
            }
        } catch (_) {}
    }

    // 监听全局键盘事件（防止重复绑定）
    if (!window.__GNP_KEYBOARD_NAV_BOUND) {
        window.__GNP_KEYBOARD_NAV_BOUND = true;

        document.addEventListener('keydown', handleKeyboardNavigation, true);

        // 搜索框真实输入时重置键盘选中（程序触发 input 用于重建高亮/过滤，不应清空选中态）
        if (searchInput) {
            searchInput.addEventListener('input', (ev) => {
                if (ev && ev.isTrusted === false) return;
                keyboardSelectedIndex = -1;
                keyboardSelectedPrompt = '';
                updateKeyboardSelection();
            });
        }
    }
// ===== Theme Button Event Handler =====
    // NOTE: sidebar DOM is appended after 1500ms (see createSidebar), so bind after that.
    setTimeout(() => {
        const themeBtnElement = document.getElementById('gemini-nav-theme');
        if (themeBtnElement && !themeBtnElement.dataset.gnpThemeBound) {
            themeBtnElement.dataset.gnpThemeBound = '1';
            themeBtnElement.addEventListener('click', (e) => {
                e.stopPropagation();
                cycleTheme();
            });
        }
        // applyTheme() may have run before DOM append; refresh icon once button is in DOM.
        try { updateThemeIcon(); } catch (_) {}
    }, 1700);
// ===== Initialize Theme on Load =====
    setTimeout(() => {
        try {
            const savedTheme = JSON.parse(localStorage.getItem(STORAGE_KEY_THEME));
            if (savedTheme && ['auto', 'light', 'dark'].includes(savedTheme)) {
                applyTheme(savedTheme);
            } else {
                applyTheme('auto');
            }
        } catch (_) {
            applyTheme('auto');
        }
        watchPageTheme();
        setupGlobalSendListener(); // [新增] 启动全局发送监听
    }, 800);


    window.addEventListener('resize', applyMagneticSnapping);

})();
