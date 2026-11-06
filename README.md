# 魔兽插件管家 · WoW Addon Butler

> 文档语言：简体中文（zh-CN）。插件名称与介绍来自第三方来源，作者原文可能保留繁体字，应用不会改写来源内容。

Windows 便携版插件管理器。启动后直接进入「已安装」，支持本地插件扫描、启停、更新、卸载、本地 ZIP 安装，以及跨来源搜索和配置快照 / WTF 备份。

当前 Windows 版本：**2.2.4**，对应 macOS **2.1.10** 的界面与功能调整。

## 下载（固定链接，不会随版本变化）

```text
https://github.com/Jdante313/wow-addon-butler-win/releases/latest/download/WoWAddonButler-Windows-x64.zip
```

- [点此直接下载 Windows 版](https://github.com/Jdante313/wow-addon-butler-win/releases/latest/download/WoWAddonButler-Windows-x64.zip)
- [最新 Release 页面](https://github.com/Jdante313/wow-addon-butler-win/releases/latest)

> 发布约定：每个 Release 都必须上传固定文件名 `WoWAddonButler-Windows-x64.zip`。版本号只写在 Release 标题和更新记录里，**文件名不变**，所以上面的下载链接可以长期分享，不需要每次换。
>
> 不要使用带版本号的文件名（例如 `WoWAddonButler-2.2.4-Windows.zip`）作为分享链接；带版本号的文件只作为历史归档保留。

## 2.2.0 主要变化

- **页面更简洁**：去掉首页推荐和「发现」入口，启动直接进入已安装插件；侧栏只保留「已安装 / 搜索插件 / 备份与迁移 / 设置」。
- **搜索修复**：CurseForge 不再发送已失效的 `classId=6`，解决“API 测试正常但搜索 0 结果”。
- **搜索列表**：无关键词时直接展示来源插件列表；支持来源、版本、分类、排序筛选；精确匹配和相似结果分组；滚动到底部自动加载下一页；右下角「返回顶部」。
- **版本不硬过滤**：不再因为插件没有标注当前客户端版本而隐藏；明确支持时显示「支持 1.60 +N」标签，详情页列出完整兼容版本。
- **本地 ZIP 安装**：已安装页右上角「安装本地包」，选择 `.zip` / `.addon`，校验 TOC 后安装；后续可正常启停、备份、卸载、纳入快照。
- **配置快照 / WTF 备份**：备份与迁移页可保存插件清单、可选插件文件、WTF SavedVariables；支持导入、导出、预览和恢复。
- **修复停用插件卸载**：`XXX.disabled` 状态也能正确识别和卸载。
- **任务提示自动关闭**：安装、更新、检查任务完成后自动收起；成功 8 秒、部分完成 15 秒、失败 25 秒，仍可手动关闭。
- **界面缩放**：设置页支持 100% / 110% / 125% / 150% / 175%。

## 功能

- **已安装管理**：扫描 TOC 名称、版本、作者、依赖、Interface、语言；按 `## Group` 和安装包合并多文件夹插件；启用 / 停用（`.disabled`）、固定版本、卸载。
- **来源**：以 CurseForge 为主，另支持 Tukui、WoWInterface、GitHub。CurseForge 需要填写自己的 API Key；Tukui 免 Key，默认启用。
- **语言标注**：中文插件显示「中文」，未发现中文显示「无中文」，未安装且无法确认显示「待检测」。
- **版本筛选**：无限、正式服、泰坦重铸、经典旧世、探索赛季、熊猫人之谜、燃烧的远征、周年。筛选只影响搜索和列表，安装仍写入当前选中的客户端。
- **本地管理**：安装 / 更新前自动备份；保留数量可调；备份失败会取消安装，避免原插件丢失。
- **配置迁移**：快照 `.wowpack` 可包含插件清单、插件文件和 WTF 角色配置；恢复前会备份当前文件。
- **Windows 外壳**：Edge 应用窗口 + 内置 Node 运行时；启动器等待本地服务健康后再打开窗口，关闭窗口时停止服务。

## 启动

1. 把整个 `魔兽插件管家` 文件夹解压到有写入权限的位置，例如 `D:\Games\魔兽插件管家`，不要只复制 exe。
2. 双击 `魔兽插件管家.exe`。
3. 首次启动自动检测游戏目录；检测不到就到「设置 → 游戏与插件目录」手动选择。
4. 首次打开如出现 Windows 安全警告，确认来源可信后点「运行」；也可以右键 exe → 属性 → 解除锁定。

如果 Edge 显示「无法访问此页面」：

- 先在窗口里按 `Ctrl + R` 刷新。
- 仍然失败时关闭窗口，再双击一次 `魔兽插件管家.exe`。
- 启动器会等待本地服务健康后再打开窗口，并监控真正的浏览器应用进程。
- 启动器强制绕过系统代理访问 `127.0.0.1`，避免代理软件拦截本地页面。
- 查看 `data\logs\launcher.log` 最后几行。

## 数据目录

便携版数据保存在程序目录下的 `data`：

```text
data/
  settings.json     设置、来源开关、API Key
  managed.json      已安装插件与在线来源的关联
  backups/          安装 / 更新 / 卸载前的版本备份
  profiles/         配置快照（.wowpack）
  wtf-backups/      恢复 WTF 前的备份
  cache/            临时缓存
  logs/             启动日志
```

- 安装、更新、删除前请完全退出魔兽世界，避免文件被占用。
- 快照恢复会写入 WTF 的 `SavedVariables`；恢复前会先备份当前文件。
- 插件能否在游戏内正常工作取决于插件本身和客户端版本，管家只负责文件层管理。

## 来源与 CurseForge

主要使用 **CurseForge**：到 [CurseForge API Key 控制台](https://console.curseforge.com/?#/api-keys) 申请 Key，粘贴后保存并测试。Key 只保存在本机 `data/settings.json`。

- **CurseForge（主要来源）**：官方插件平台，插件数量和更新最完整。设置页会显示「Key 已保存」状态，更换前先点「清除并更换」。
  - 新生成的 Key 可能需要 **5–10 分钟**在 CurseForge 侧生效；测试失败时不要连续点「测试」，避免触发临时限流。
  - 搜索不再带失效的 `classId=6`；`gameId=1` 已足够限定 WoW。
  - 如果提示 Key 无效，点控制台 Key 右侧的复制按钮重新复制，或 Regenerate 后立即粘贴，等待几分钟再测。
- **Tukui**：ElvUI / Tukui 官方 API，免 Key，默认启用。
- **WoWInterface / GitHub**：实验性来源，默认关闭。

## 分享给朋友

只发送打包好的压缩包：

```text
release\魔兽插件管家-便携版.zip
```

不要直接发送已经运行过的整个文件夹。运行后会产生 `data\`，其中包含：

- CurseForge API Key
- 游戏安装路径
- 已安装插件来源关联
- 版本备份 / 配置快照
- 浏览器窗口配置

当前 zip 不包含 `data/`、`settings.json`、`managed.json`、`backups/` 等个人数据。

- 每个用户使用自己的 API Key，不要共用。
- 同一台电脑可以放多份，各自 `data` 独立；不要让两个管家同时操作同一个 `AddOns`。
- 便携版删除程序文件夹即卸载软件；已经装进游戏的插件不会自动删除。
- 程序没有代码签名，Windows SmartScreen 可能提示；确认可信后点「更多信息 → 仍要运行」。

## 开发与测试

```bat
node server\index.js
node test\run-tests.js
powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1
```

- 后端：Node.js 标准库 + `adm-zip`，JSON 持久化。
- 前端：原生 ES Modules + CSS，无构建步骤。
- 测试：18 项后端测试，覆盖 TOC、版本比较、分组、精确/模糊匹配、分类、ZIP 安装、本地 ZIP、启停、停用卸载、快照、WTF、导入导出。
- 打包：`scripts\build-portable.ps1`，输出 `release\魔兽插件管家` 和同名 zip。
- 代码以 MIT License 开源；插件内容、图标及第三方平台内容的版权归各自作者/平台所有。

## 已知限制

- 更新检查依赖来源版本格式；TOC 版本不规范时可能显示「版本未知」。
- 分类和来源过滤依赖平台返回的分类/关键词；冷门插件可能被归到“全部”之外。
- 本地包更新依赖按名称匹配在线来源；没有手动「关联在线来源」入口。
- 多文件夹整合包从本地包更新为在线包时，如果目录结构变化，旧模块可能残留。
- 只支持 Windows；`Interface/AddOns` 必须是标准结构。
- 个人使用工具，不提供自动更新器和代码签名。

---

愿你的背包永远不爆，团队框架永远不灰。
