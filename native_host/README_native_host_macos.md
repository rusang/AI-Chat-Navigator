# Native Host 安装（macOS）

> 说明：Chrome 扩展无法直接按“绝对路径”写本地文件；需要 Native Messaging Host 作为桥接。  
> 你只需要做一次安装，之后收藏变化会自动回写到 manifest.json 指定的绝对路径 JSON 文件。

## 1) 放置 Host 脚本（可自行调整目录）
建议目录：
- `~/.ai-chat-navigator/ai_chat_navigator_native.py`

命令示例：
```bash
mkdir -p ~/.ai-chat-navigator
cp ai_chat_navigator_native.py ~/.ai-chat-navigator/
chmod +x ~/.ai-chat-navigator/ai_chat_navigator_native.py
```

## 2) 创建 Native Host Manifest
Chrome 读取位置：
- `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/ai_chat_navigator_native.json`

命令示例：
```bash
mkdir -p "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
cp ai_chat_navigator_native_host.json "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/ai_chat_navigator_native.json"
```

然后编辑 `ai_chat_navigator_native.json` 两处：
1. `path`：改成你的脚本绝对路径（如 `/Users/<你>/.../ai_chat_navigator_native.py`）
2. `allowed_origins`：把 `REPLACE_EXTENSION_ID` 替换为你的扩展 ID  
   扩展 ID 在 `chrome://extensions` 页面可看到（开启开发者模式）。

## 3) 在扩展 manifest.json 配置收藏 JSON 的绝对路径
扩展 `manifest.json` 新增/修改字段：
```json
"gnp_favorites_json_path": "/绝对路径/your_favorites.json",
"gnp_native_host_name": "ai_chat_navigator_native"
```

> `gnp_favorites_json_path` 必须是 **绝对路径**，并以 `.json` 结尾。

## 4) 验证
- 打开任意支持站点（Gemini/ChatGPT/Claude）
- 打开侧边栏 -> 收藏 -> 试着新增/编辑一条收藏
- 观察 `gnp_favorites_json_path` 对应的 JSON 文件是否自动更新

如果没更新：
- 打开页面控制台（Console）搜索 `[GNP] Fav JSON ...` 看错误原因
- 常见原因：Host manifest 未安装/allowed_origins 未填写正确扩展 ID
