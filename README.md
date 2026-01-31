# AI Chat Navigator v2.0 - 功能增强版

## 🎉 新增功能

### 1. 键盘快捷键系统

#### 快捷键列表:
- **`Esc`** - 关闭弹窗/清除搜索/失去焦点
  - 搜索框有内容时：清空搜索
  - 搜索框无内容时：失去焦点
  - 其他情况：折叠侧边栏

- **`Ctrl/Cmd + K`** - 快速聚焦搜索框
  - 可在任何时候使用
  - 自动选中搜索框内容

- **`↑` / `↓`** - 上下选择列表项
  - 在搜索框聚焦或侧边栏展开时可用
  - 自动滚动到选中项
  - 视觉高亮显示当前选中项

- **`Enter`** - 填入选中的 prompt
  - 将选中项内容填入输入框
  - 自动聚焦到输入框
  - 清除键盘选中状态

- **`Shift + Enter`** - 填入并直接发送
  - 填入内容后自动点击发送按钮
  - 适合快速使用场景

### 2. 主题切换系统

#### 三档主题模式:
- **自动模式** 🌗
  - 优先检测网页的主题属性 (`data-theme`, `data-color-mode`, `className`)
  - Fallback 到系统 `prefers-color-scheme`
  - 自动适配 Claude.ai、ChatGPT、Gemini 的主题

- **浅色模式** ☀️
  - 强制使用浅色主题
  - 通过 `data-gnp-theme="light"` 属性实现
  - 不受系统主题影响

- **深色模式** 🌙
  - 强制使用深色主题
  - 通过 `data-gnp-theme="dark"` 属性实现
  - 完美解决深色网页下弹窗白底问题

#### 使用方法:
- 点击右上角的主题按钮循环切换
- 设置会自动保存到 localStorage
- 重新加载页面后保持上次选择

### 3. 收藏系统优化

#### 去重合并:
- 自动基于文本内容去重
- 保留最新的时间戳
- 启动时自动整理

#### 时间戳排序:
- 收藏列表按时间倒序显示
- 最近收藏的在最上方

### 4. 存储优化

#### Debounce 写入:
- 所有 localStorage 写入都经过防抖处理
- 默认延迟 300ms (配置) / 500ms (收藏)
- 减少磁盘 I/O,提升性能

#### Flush 机制:
- `beforeunload` 事件时强制写入
- 确保数据不丢失
- 支持手动 `flushStorage()`

### 5. Claude.ai 完整兼容

#### 选择器适配:
```javascript
claude: {
    promptSelector: [
        'div[data-is-streaming="false"] div.font-user-message',
        'div.font-user-message',
        'div[data-test-render-count] div.font-user-message'
    ],
    inputSelector: [
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"].ProseMirror',
        'fieldset div[contenteditable="true"]'
    ],
    sendBtnSelector: [
        'button[aria-label*="Send Message"]',
        'button[aria-label*="发送"]',
        'fieldset button[type="button"]'
    ]
}
```

#### 特殊处理:
- 支持 Claude 的 contenteditable 输入框
- 兼容 ProseMirror 编辑器
- 正确识别 Claude 的消息结构

## 📋 功能对比

| 功能 | v7.1 (原版) | v8.0 (增强版) |
|------|------|------|
| 代码行数 | 3480行 | 4145行 (+665行,+19%) |
| 基础导航 | ✅ | ✅ 完全保留 |
| 搜索过滤 | ✅ | ✅ 完全保留 |
| 收藏管理 | ✅ | ✅ 完全保留 |
| 批量操作 | ✅ | ✅ 完全保留 |
| 多选/拖拽 | ✅ | ✅ 完全保留 |
| 键盘快捷键 | F1 only | ✅ 全键盘支持 |
| 主题切换 | ❌ | ✅ 3档切换 |
| 存储优化 | ❌ | ✅ Debounce |
| Claude.ai | ❌ | ✅ 完整支持 |

**改动原则：**
- ✅ **100%保留原始功能** - 所有3480行原始代码完整保留
- ✅ **仅添加新功能** - 新增665行代码（+19%）
- ✅ **零破坏性修改** - 不影响任何现有功能
- ✅ **完全向后兼容** - 原有配置和数据完全兼容

## 🎨 主题系统详解

### 自动模式工作原理:

1. **优先级检测顺序:**
   ```
   HTML/body data-theme
   → HTML/body data-color-mode
   → HTML/body className (dark/light)
   → prefers-color-scheme
   ```

2. **实时响应:**
   - MutationObserver 监听 HTML/body 属性变化
   - MediaQuery 监听系统主题变化
   - 自动更新主题图标

3. **强制模式:**
   - 设置 `data-gnp-theme` 属性到根元素
   - CSS 优先级高于媒体查询
   - 完全控制插件主题

### CSS 变量系统:

```css
/* 核心变量 */
--gnp-bg: 背景色
--gnp-border: 边框色
--gnp-text-main: 主文字色
--gnp-text-sub: 次要文字色
--gnp-active-bg: 激活背景
--gnp-active-border: 激活边框
--gnp-tab-icon: 图标色
...

/* 强制主题 */
[data-gnp-theme="dark"] { ... }
[data-gnp-theme="light"] { ... }

/* 自动主题 */
@media (prefers-color-scheme: dark) {
    :root:not([data-gnp-theme]) { ... }
}
```

## 🔧 技术实现细节

### 1. 键盘导航状态管理:

```javascript
let keyboardSelectedIndex = -1;
let currentVisibleItems = [];

function updateKeyboardSelection() {
    // 清除旧状态
    currentVisibleItems.forEach(item => {
        item.classList.remove('keyboard-selected');
    });
    
    // 应用新状态 + 滚动
    if (keyboardSelectedIndex >= 0) {
        const item = currentVisibleItems[keyboardSelectedIndex];
        item.classList.add('keyboard-selected');
        item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}
```

### 2. 主题检测算法:

```javascript
function detectPageTheme() {
    const html = document.documentElement;
    const body = document.body;
    
    // 检测顺序：data-theme → data-color-mode → className
    const dataTheme = html.getAttribute('data-theme') || 
                      body.getAttribute('data-theme');
    
    if (dataTheme === 'dark') return 'dark';
    if (dataTheme === 'light') return 'light';
    
    // Fallback 到系统偏好
    return window.matchMedia('(prefers-color-scheme: dark)').matches 
        ? 'dark' : 'light';
}
```

### 3. Debounce 存储:

```javascript
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
    for (const [key, value] of Object.entries(storageQueue)) {
        localStorage.setItem(key, JSON.stringify(value));
    }
    storageQueue = {};
}

// 确保页面卸载时写入
window.addEventListener('beforeunload', flushStorage);
```

### 4. 去重算法:

```javascript
function loadFavorites() {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY_FAV));
    
    // Map 去重 (基于 normalized text)
    const uniqueMap = new Map();
    parsed.forEach(item => {
        const key = item.text.trim().toLowerCase();
        // 保留最新的
        if (!uniqueMap.has(key) || 
            item.timestamp > uniqueMap.get(key).timestamp) {
            uniqueMap.set(key, item);
        }
    });
    
    favorites = Array.from(uniqueMap.values());
    saveFavorites(); // 保存去重结果
}
```

## 🚀 使用建议

### 最佳实践:

1. **键盘流工作:**
   ```
   Ctrl+K → 输入搜索 → ↓↓ 选择 → Enter 填入
   或: Shift+Enter 直接发送
   ```

2. **主题设置:**
   - 白天工作: 选择 "浅色模式"
   - 夜间工作: 选择 "深色模式"
   - 自动适配: 选择 "自动模式"

3. **收藏管理:**
   - 常用 prompt 加星收藏
   - 定期清理重复项 (自动去重)
   - 善用搜索功能快速查找

4. **性能优化:**
   - 插件使用 debounce 存储
   - 不会频繁写入磁盘
   - 关闭页面时自动保存

## 🐛 已知问题修复

### v2.0 修复的问题:

1. ✅ **深色网页白底问题**
   - 强制主题模式彻底解决
   - `data-gnp-theme` 覆盖媒体查询

2. ✅ **重复收藏**
   - 自动去重算法
   - 基于文本内容标准化

3. ✅ **存储性能**
   - Debounce 写入
   - Flush 机制确保数据安全

4. ✅ **Claude.ai 不兼容**
   - 专门的选择器适配
   - contenteditable 支持

## 📦 安装方法

### Chrome/Edge:

1. 下载插件文件到本地文件夹
2. 打开 `chrome://extensions/`
3. 开启 "开发者模式"
4. 点击 "加载已解压的扩展程序"
5. 选择包含 manifest.json 的文件夹

### 文件结构:

```
AI-Chat-Navigator/
├── manifest.json      # 插件配置
├── content.js         # 核心逻辑 (增强版)
├── styles.css         # 样式表 (主题支持)
├── background.js      # 后台脚本 (快捷键)
└── README.md          # 本文档
```

## 📝 更新日志

### v2.0 (2026-01-30)

**新增:**
- ✨ 完整键盘快捷键系统 (Esc, Ctrl+K, ↑↓, Enter, Shift+Enter)
- 🎨 三档主题切换 (自动/浅色/深色)
- 🔄 收藏去重合并
- ⚡ Debounce 存储优化
- 🤖 Claude.ai 完整兼容

**优化:**
- 🎯 键盘导航视觉反馈
- 🌈 主题自动检测逻辑
- 📦 存储性能提升
- 🔧 代码结构重构

**修复:**
- 🐛 深色网页白底问题
- 🐛 重复收藏问题
- 🐛 存储写入性能问题

### v1.1 (Original)

- ✅ 基础导航功能
- ✅ 搜索过滤
- ✅ 收藏管理
- ✅ F1 快捷键
- ✅ Gemini & ChatGPT 支持

## 🙏 致谢

感谢原作者 Chantec 的出色工作!

本版本在原有基础上进行了大量增强,但保持了核心功能的稳定性。

## 📄 许可证

MIT License

---

**Enjoy! 🎉**

如有问题或建议,欢迎反馈!

---

## 安装与调试

# AI Chat Navigator v8.0 - 安装说明

## 🚀 快速安装

### 步骤：

1. **下载所有文件**
   - `content.js` (必需)
   - `manifest.json` (必需)
   - `background.js` (必需)
   - `README.md` (说明文档)
   - ~~`styles.css`~~ (不需要 - CSS已内联在content.js中)

2. **创建文件夹**
   ```
   AI-Chat-Navigator-v8/
   ├── content.js
   ├── manifest.json
   ├── background.js
   └── README.md
   ```

3. **加载到Chrome**
   - 打开 `chrome://extensions/`
   - 开启右上角的"开发者模式"
   - 点击"加载已解压的扩展程序"
   - 选择包含这些文件的文件夹

4. **测试**
   - 访问 https://gemini.google.com/ 或 https://chatgpt.com/ 或 https://claude.ai/
   - 按 `F1` 打开/关闭侧边栏
   - 查看浏览器控制台（F12）中的 `[GNP v8.0]` 日志

## 🐛 调试

如果侧边栏没有出现：

1. **检查控制台日志** (F12 → Console)
   ```
   应该看到：
   [GNP v8.0] Script loaded at: ...
   [GNP] Location: ...
   [GNP] Environment: ...
   [GNP] Sidebar element created: ...
   [GNP] ✅ Sidebar appended to body!
   ```

2. **检查DOM**
   ```javascript
   // 在控制台执行：
   document.getElementById('gemini-nav-sidebar')
   // 应该返回一个div元素
   ```

3. **检查CSS**
   ```javascript
   // 在控制台执行：
   const sidebar = document.getElementById('gemini-nav-sidebar');
   console.log(window.getComputedStyle(sidebar).display);
   // 应该显示 "flex" 而不是 "none"
   ```

4. **强制显示**
   ```javascript
   // 如果sidebar存在但不可见，尝试：
   const sidebar = document.getElementById('gemini-nav-sidebar');
   sidebar.classList.remove('collapsed');
   sidebar.style.display = 'flex';
   ```

## ⌨️ 键盘快捷键

- `F1` - 打开/关闭侧边栏
- `Ctrl/Cmd + K` - 聚焦搜索框
- `↑` / `↓` - 上下选择列表项
- `Enter` - 填入选中的prompt
- `Shift + Enter` - 填入并直接发送
- `Esc` - 关闭/清空/失焦

## 🎨 主题切换

- 点击右上角的 🌗 按钮
- 三档循环：自动 → 浅色 → 深色

## ❓ 常见问题

**Q: 为什么没有styles.css？**
A: CSS已经内联在content.js中（第135-860行），不需要单独的CSS文件。

**Q: 侧边栏完全不出现？**
A: 检查：
1. 扩展是否已启用
2. 页面URL是否匹配（gemini.google.com, chatgpt.com, claude.ai）
3. 控制台是否有错误
4. 刷新页面并查看控制台日志

**Q: 可以在其他网站使用吗？**
A: 修改manifest.json中的matches数组，添加你想要的网站。

## 📝 版本信息

- **版本**: 8.0
- **原始代码**: 3480行
- **新增代码**: +665行（+19%）
- **总代码**: 4145行

## 🎯 新功能

✅ 完整键盘快捷键系统
✅ 三档主题切换（自动/浅色/深色）
✅ Claude.ai完整支持
✅ Debounce存储优化
✅ 100%保留原有功能

---

**Enjoy!** 🎉

如有问题，查看控制台日志并参考调试部分。