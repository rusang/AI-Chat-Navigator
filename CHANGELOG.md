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
