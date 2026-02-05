# AI-Chat-Navigator

AI-Chat-Navigator 是一个 Chrome 扩展，为 ChatGPT / Gemini / Claude 等对话页面提供"目录导航 + 收藏管理 + 快捷操作"，帮助你在长对话中快速定位、检索、复用重要 Prompt。

---

## 预览

![Preview](images/preview.gif)

---

## 主要功能

### 📋 对话目录导航
- **自动提取对话中的 Prompt 列表**
- 点击即可快速跳转定位到对应位置（支持居中定位）
- 搜索过滤（快速查找某条 Prompt）
- **靶向滚动**：精准定位到选中的 Prompt，自动居中显示

### ⭐ 收藏管理
- **一键收藏/取消收藏**
- 支持批量收藏、批量删除
- 收藏支持 **文件夹/分类**（便于大量收藏的分组管理）
  - 新建/重命名/删除文件夹
  - 在文件夹之间移动 Prompt
  - 文件夹级别的批量操作（清空文件夹等）
- 支持收藏编辑（长内容编辑体验更好）
- **使用统计**：自动记录每条收藏的使用次数和最近使用时间
- **智能排序**：按使用频率或时间排序

### 🗂️ 本地文件同步（高级功能）
- **收藏数据持久化**：通过 Native Messaging 将收藏保存到本地 JSON 文件
- **跨标签页实时同步**：多个浏览器标签页之间自动同步收藏变化
- **自动备份**：定期自动备份收藏数据到 `*_bak.json` 文件
- **外部编辑支持**：手动编辑 JSON 文件后，插件会在 2 秒内自动检测并重新加载
- **冲突解决**：智能合并机制，避免多标签页并发操作时数据丢失

### 🎯 多选与快捷键
- **`Command + 单击`** (macOS) / **`Ctrl + 单击`** (Windows/Linux)：多选 Prompt
- **`Command + A`** / **`Ctrl + A`**：全选当前窗口的 Prompt
- **`Esc`**：取消选中（多选/全选后）
- 多选状态下自动隐藏每条 Prompt 右下角工具图标，避免误触
- **批量操作浮动栏**：多选后显示批量收藏/删除按钮

### 🔍 搜索与过滤
- **实时搜索**：输入关键字即时过滤结果
- **高亮显示**：搜索结果中的关键字会被高亮标记
- 支持在导航和收藏两个面板中分别搜索

### 🎨 主题切换
- **自动 / 浅色 / 深色** 三档主题
- 跟随系统主题或手动切换
- 完美适配各个 AI 对话平台的界面风格

### 🚀 页面滚动辅助
- 一键滚动到网页顶部 / 底部（适合长对话快速定位）
- 智能滚动：自动避开固定导航栏

### ⌨️ 完整键盘快捷键支持
- **`Ctrl+Shift+S`**：显示/隐藏侧边栏
- **`↑` / `↓`**：上下选择列表项
- **`Enter`**：填入选中的 Prompt
- **`Shift + Enter`**：填入并直接发送
- **`Ctrl/Cmd + K`**：快速聚焦搜索框

> 说明：不同站点/页面结构可能略有差异，扩展会尽量以稳定、兼容的方式工作。

---

## 安装方式

### 方式一：标准安装（推荐）

1. 打开 Chrome 扩展管理页：`chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本项目根目录（包含 `manifest.json` 的文件夹）

安装示意图：

![安装步骤](images/install.png)

### 方式二：带本地文件同步（高级用户）

如果你想使用本地 JSON 文件同步功能，需要额外配置 Native Messaging Host：

#### 必需文件
```
AI-Chat-Navigator/
├── content.js          (必需)
├── background.js       (必需)
├── manifest.json       (必需)
├── styles.css          (必需)
└── README.md           (说明文档)
```

#### 配置步骤

**1. 修改 manifest.json**

在 `manifest.json` 中配置你的本地文件路径：

```json
{
  "gnp_favorites_json_path": "/path/to/your/favorites.json",
  "gnp_native_host_name": "ai_chat_navigator_native",
  "gnp_backup_interval_min": 60
}
```

参数说明：
- `gnp_favorites_json_path`: 收藏数据保存的绝对路径
- `gnp_native_host_name`: Native Messaging Host 名称（默认不用改）
- `gnp_backup_interval_min`: 自动备份间隔（分钟），设为 0 则禁用

**2. 安装 Native Messaging Host**

创建一个简单的 Python 脚本 `native_host.py`：

```python
#!/usr/bin/env python3
import sys
import json
import struct
import os

def send_message(message):
    """发送消息到 Chrome"""
    msg = json.dumps(message).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('I', len(msg)))
    sys.stdout.buffer.write(msg)
    sys.stdout.buffer.flush()

def read_message():
    """从 Chrome 读取消息"""
    text_length_bytes = sys.stdin.buffer.read(4)
    if len(text_length_bytes) == 0:
        sys.exit(0)
    text_length = struct.unpack('i', text_length_bytes)[0]
    text = sys.stdin.buffer.read(text_length).decode('utf-8')
    return json.loads(text)

def main():
    while True:
        try:
            msg = read_message()
            op = msg.get('op')
            path = msg.get('path')
            
            if op == 'read':
                # 读取文件
                if os.path.exists(path):
                    with open(path, 'r', encoding='utf-8') as f:
                        data = f.read()
                    send_message({'ok': True, 'data': data})
                else:
                    send_message({'ok': False, 'error': 'File not found'})
                    
            elif op == 'write':
                # 写入文件
                data = msg.get('data', '')
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(data)
                send_message({'ok': True})
                
            else:
                send_message({'ok': False, 'error': 'Unknown operation'})
                
        except Exception as e:
            send_message({'ok': False, 'error': str(e)})
            break

if __name__ == '__main__':
    main()
```

**3. 配置 Native Messaging Host**

创建配置文件 `ai_chat_navigator_native.json`：

**macOS/Linux:**
```json
{
  "name": "ai_chat_navigator_native",
  "description": "AI Chat Navigator Native Host",
  "path": "/path/to/native_host.py",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://YOUR_EXTENSION_ID/"
  ]
}
```

将此文件放置在：
- **macOS**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/ai_chat_navigator_native.json`
- **Linux**: `~/.config/google-chrome/NativeMessagingHosts/ai_chat_navigator_native.json`

**Windows:**
```json
{
  "name": "ai_chat_navigator_native",
  "description": "AI Chat Navigator Native Host",
  "path": "C:\\path\\to\\native_host.py",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://YOUR_EXTENSION_ID/"
  ]
}
```

创建注册表项：
```
HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\ai_chat_navigator_native
```
默认值设为配置文件的完整路径。

**4. 获取扩展 ID**

在 `chrome://extensions` 页面，找到 AI Chat Navigator 的 ID（类似 `abcdefghijklmnopqrstuvwxyz123456`），替换配置文件中的 `YOUR_EXTENSION_ID`。

**5. 测试**

重新加载扩展，打开控制台（F12），如果看到类似信息说明成功：
```
[GNP] File sync enabled: /path/to/favorites.json
[GNP] Native host: ai_chat_navigator_native
```

---

## 使用说明

### 基础操作

- **打开侧边栏**：访问支持的对话页面（Gemini/ChatGPT/Claude）后，右侧会自动出现导航窗口
- **折叠/展开**：点击侧边栏顶部可以折叠或展开
- **切换面板**：点击顶部的"导航"或"收藏"标签切换面板

### 导航窗口

- **跳转定位**：点击某条 Prompt，页面会自动滚动到对应位置并居中显示
- **搜索过滤**：在搜索框输入关键字，实时过滤显示相关 Prompt
- **收藏操作**：点击 Prompt 右侧的 ☆ 图标即可收藏，★ 表示已收藏
- **多选操作**：
  - 按住 `Ctrl/Cmd` 键点击多个 Prompt
  - 或使用 `Ctrl/Cmd + A` 全选
  - 底部会显示批量操作栏，可批量收藏或删除

### 收藏窗口

- **文件夹筛选**：顶部下拉菜单选择要查看的文件夹（"全部"显示所有）
- **新建文件夹**：点击 📁+ 图标，输入名称创建新文件夹
- **重命名/删除文件夹**：点击文件夹下拉菜单右侧的 ✏️ 或 🗑️ 图标
- **移动 Prompt**：点击 Prompt 左侧的文件夹图标，可以将其移动到其他文件夹
- **编辑内容**：点击 ✏️ 图标可以编辑 Prompt 内容
- **填入/发送**：
  - 点击"填入"按钮：将 Prompt 填入输入框
  - 点击"发送"按钮：填入并直接发送
- **使用统计**：每条收藏会显示使用次数和最近使用时间

### 本地文件同步（需配置）

- **自动保存**：任何收藏变化都会实时保存到本地 JSON 文件
- **跨标签页同步**：在一个标签页的修改会自动同步到其他所有标签页
- **手动编辑**：可以直接编辑 `favorites.json` 文件，插件会在 2 秒内自动检测并重新加载
- **自动备份**：每小时（可配置）自动备份到 `favorites_bak.json`

---

## 快捷键

| 操作 | Windows/Linux | macOS |
|---|---|---|
| 显示/隐藏侧边栏 | `Ctrl+Shift+S` | `Ctrl+Shift+S` |
| 多选 Prompt | `Ctrl + Click` | `Cmd + Click` |
| 全选（导航/收藏） | `Ctrl + A` | `Cmd + A` |
| 聚焦搜索框 | `Ctrl + K` | `Cmd + K` |
| 上下选择 | `↑` / `↓` | `↑` / `↓` |
| 填入选中项 | `Enter` | `Enter` |
| 填入并发送 | `Shift + Enter` | `Shift + Enter` |
| 取消选中/关闭弹窗 | `Esc` | `Esc` |

---

## 支持的平台

- ✅ Google Gemini (`gemini.google.com`)
- ✅ ChatGPT (`chatgpt.com`, `chat.openai.com`)
- ✅ Claude (`claude.ai`)

> 注：不同平台的 DOM 结构可能变化，扩展会尽力适配最新版本。

---

## 隐私说明

- 扩展的收藏与设置**默认存储在本地**（Chrome Storage 或本地 JSON 文件）
- **不会主动上传你的对话内容到服务器**（除非你自行集成了第三方服务）
- 本地文件同步功能仅在你的电脑上运行，不涉及任何网络传输
- 所有数据完全由你掌控

---

## 开发与调试

### 修改代码后刷新

1. 修改源码后，在 `chrome://extensions` 页面点击扩展的"刷新"按钮
2. 回到对话页面刷新即可加载新代码

### 查看日志

建议使用 Chrome DevTools：
- 右键页面 → 检查
- 切换到 Console 标签
- 查看 `[GNP v8.0]` 开头的日志信息

### 调试技巧

**查看侧边栏元素：**
```javascript
document.getElementById('gemini-nav-sidebar')
```

**查看当前收藏数据：**
```javascript
// 在控制台执行
chrome.storage.local.get(['gnp_fav_file_bcast_v1'], console.log)
```

**强制重新加载文件：**
```javascript
// 如果配置了本地文件同步
// 手动触发重载（在页面控制台执行）
location.reload()
```

---

## 技术细节

### 架构
- **content.js** (6885 行)：主逻辑，负责 UI 渲染、用户交互、数据同步
- **background.js** (300 行)：Service Worker，负责键盘快捷键、本地文件轮询、自动备份
- **manifest.json**：扩展配置文件
- **styles.css**：样式文件（已内联到 content.js 中）

### 数据同步机制
1. **Chrome Storage**：标签页之间通过 `chrome.storage.onChanged` 事件同步
2. **本地文件轮询**：background.js 每 2 秒检测文件变化
3. **广播机制**：文件变化时通过 `storage.local` 广播给所有标签页
4. **冲突解决**：基于时间戳的三向合并策略，支持墓碑标记和复活机制

### 性能优化
- Debounce 防抖：避免频繁写入文件
- 增量更新：仅渲染变化的部分
- 虚拟滚动：大量收藏时保持流畅（正在开发中）

---

## 版本信息

- **当前版本**: 3.0.0
- **总代码行数**: 7185 行
  - content.js: 6885 行
  - background.js: 300 行
- **支持的浏览器**: Chrome 88+（需要 Manifest V3 支持）

---

## License

MIT License（详见 `LICENSE`）。

---

## 致谢

感谢所有使用和反馈的用户！如果你发现 Bug 或有功能建议，欢迎提 Issue。

**Enjoy!** 🎉
