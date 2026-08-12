# YouTube 单句字幕翻译

这是一个仅在本机使用的 Chrome 扩展。观看 YouTube 时，点击视频右侧的“译”按钮，或按 `Alt+Shift+T`，扩展会先收集并拼接完整的当前句子，随后自动暂停视频并显示翻译。

浮窗会显示：

- 去重拼接后的完整字幕原文
- 自然的简体中文翻译
- 可点击的原文单词；点击后会弹出结合当前字幕语境的详细解释

扩展会在当前句收集完成后暂停视频，方便阅读和查询单词；它不会自动恢复播放或跳转视频，也不会保存翻译历史。它只使用 YouTube 已经显示过的字幕，不包含语音识别功能。

## 一、准备 DeepSeek API Key

1. 打开 [DeepSeek 开放平台](说一下页面中的所有功能)并创建一个 API Key。
2. 建议为这个工具单独创建密钥、限制可用权限，并设置合理的消费额度提醒。
3. 不要把密钥填进 Chrome 扩展或提交到 Git。密钥只应保存在本机的 `local_server/.env.local` 中。

使用本工具需要 DeepSeek API 账户中有可用余额。

## 二、首次启动本地服务

1. 双击项目根目录中的 `start-server.cmd`。
2. 首次运行会创建并打开 `local_server/.env.local`。
3. 在 `DEEPSEEK_API_KEY=` 后粘贴自己的密钥并保存，例如：

   ```text
   DEEPSEEK_API_KEY=你的密钥
   DEEPSEEK_MODEL=deepseek-v4-flash
   ```

4. 再次双击 `start-server.cmd`。
5. 看到“字幕翻译服务已启动”后，保持该窗口开启。

服务只监听本机地址 `127.0.0.1:8765`，不会把 API Key 发送给扩展或 YouTube。每次翻译时，当前字幕和最多两条前文会发送给 DeepSeek；点击单词时，所选单词及其所在字幕会发送给 DeepSeek 以生成详解。

默认使用低延迟的 `deepseek-v4-flash`，并关闭思考模式以缩短单句翻译等待时间。如果需要更高质量，可以把 `DEEPSEEK_MODEL` 改为 `deepseek-v4-pro`，然后重启服务。

## 三、安装 Chrome 扩展

1. 在 Chrome 地址栏打开 `chrome://extensions/`。
2. 打开右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目中的 `extension` 文件夹。
5. 打开一个 YouTube 视频并刷新页面。

此扩展也通常可以通过 Edge 的“加载解压缩的扩展”功能使用，但当前版本以 Chrome 为测试目标。

## 四、使用方法

1. 播放 YouTube 视频并通过播放器的 `CC` 按钮开启字幕。
2. 遇到看不懂的一句时，点击播放器右侧的“译”，或按 `Alt+Shift+T`。
3. 浮窗会显示“正在读取完整字幕…”。扩展会优先从 YouTube 的字幕时间轴直接定位当前完整句，不需要等待视频继续播放。
4. 个别视频无法读取时间轴时，会自动回退到画面字幕拼接。回退模式只会在检测到句末标点、字幕真正消失形成停顿，或等待达到 8 秒安全上限时暂停视频并开始翻译；画面字幕仅仅保持不变不会再被误判为完整句。
5. 如果画面同时显示多个句子（例如前一句残片、一个完整句和下一句开头），扩展会立即选择其中最新的完整句，不会翻译最后那段未完成的字幕。
6. 翻译完成后视频保持暂停；阅读完成后请手动继续播放。
7. 点击原文中的蓝色单词，可查看音标、当前语境中的含义和详细用法。
8. 可以拖动翻译浮窗标题栏改变位置，点击右上角 `×` 关闭。
9. 也可以点击 Chrome 工具栏中的扩展图标触发翻译。

若快捷键没有生效或与其他软件冲突，请打开 `chrome://extensions/shortcuts`，找到“YouTube 单句字幕翻译”并重新设置。

## 隐私与安全

- API Key 只由本地 Python 服务读取，不存在扩展代码中。
- 本地服务不记录字幕、翻译结果或 API Key。
- 翻译历史和最多 64 条翻译缓存只短暂存在当前页面内存中，切换视频、刷新或关闭标签页后消失。
- 本地接口限制为回环地址，并拒绝普通网页来源的翻译请求。
- 字幕文本会发送给 DeepSeek 以生成翻译，请勿翻译包含敏感信息的字幕。
- `local_server/.env.local` 已加入 `.gitignore`，不要手动删除这条忽略规则。

DeepSeek 接口格式和当前模型列表可查看 [DeepSeek API 官方文档](https://api-docs.deepseek.com/)。

## 常见问题

### 提示“无法连接本地翻译服务”

确认 `start-server.cmd` 对应的窗口仍然开启。如果已经开启，关闭后重新双击启动。

### 提示“Extension context invalidated”或要求刷新页面

这通常发生在 `chrome://extensions/` 中重新加载扩展后：已经打开的 YouTube 标签页仍在运行旧版脚本。点击浮窗中的“刷新页面”，或手动刷新当前视频页，即可载入新版扩展。此时继续点击“再试一次”无法恢复扩展连接。

### 提示“没有检测到当前字幕”

确认视频正在显示字幕。视频本身没有字幕时，当前版本无法通过音频生成字幕。

### 为什么少数视频点击后没有立即暂停

正常情况下扩展会从 YouTube 字幕时间轴直接取得当前完整句。若视频没有可读取的时间轴、轨道与画面字幕不匹配，扩展才会继续播放以拼接后续字幕。为避免再次把半句送去翻译，回退路径不再使用“字幕稳定时间”作为结束条件，最长等待 8 秒。若视频在点击前已经暂停，扩展不会自动播放它。当前页面已翻译过的相同句子会直接命中内存缓存；点击“再试一次”仍会强制重新请求 DeepSeek。

### 视频没有自动暂停

翻译仍会正常继续。请确认当前页面是 YouTube 视频播放页；若浮窗显示暂停失败提示，可以手动暂停视频后阅读翻译。

### 提示 API Key 无效或没有权限

检查 `local_server/.env.local` 中的密钥是否完整，且没有多余空格。修改后必须重启本地服务。

### 提示请求过多或额度不足

前往 DeepSeek 开放平台检查账户余额和速率限制。稍后再试也可能恢复。

### 提示模型不可用

在 `local_server/.env.local` 中确认 `DEEPSEEK_MODEL` 为当前可用模型，例如 `deepseek-v4-flash` 或 `deepseek-v4-pro`，然后重启服务。

### YouTube 页面更新后按钮消失

先刷新视频页面。若仍然没有按钮，在 `chrome://extensions/` 中点击该扩展的“重新加载”，再刷新 YouTube。

## 开发检查

项目不依赖 Node.js 或第三方 Python 包。运行服务端自动化测试：

```powershell
python -m unittest discover -s tests -v
```

检查 Python 语法和扩展清单：

```powershell
python -m py_compile local_server\server.py
python -c "import json; json.load(open(r'extension/manifest.json', encoding='utf-8'))"
```

字幕拼接器的零依赖测试位于 `tests/caption-assembler.test.html`，可直接用 Chrome 打开；页面应显示 `All tests passed`。时间轴字幕测试可用 Node.js 运行 `tests/timeline-caption.test.js`。

Chrome 相关交互仍需在真实 YouTube 播放页手动验证，包括普通、影院和全屏模式。
