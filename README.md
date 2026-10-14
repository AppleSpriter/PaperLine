# 读线 · PaperLine

[English](README.en.md) · 简体中文

一个本地运行的轻量论文阅读应用。用**阅读线**安排下一步，用**思想卡**汇集来自多篇论文的同一想法，用关系图查看论文如何提出、使用、改进或质疑它。

## macOS 原生桌面版（0.2.1）

原生版使用 Tauri 2 与 macOS 自带 WebView，Python 后端随应用一起打包，通过标准输入输出通信，不启动本地 HTTP 端口。安装后不需要 Python、Node.js 或项目源码。重复打开会聚焦已有窗口，关闭窗口即退出后台进程。

在 macOS 13 或更新版本上，把 `dist/macos/0.2.1/PaperLine.app` 拖入“应用程序”后双击打开。项目根目录原有的 `PaperLine.app` 是旧版浏览器启动器；原生构建产物按版本保存在 `dist/macos/<version>/`，两者不要混淆。

原生数据目录为 `~/Library/Application Support/io.github.applespriter.paperline/`；升级、移动应用不会改变这个路径。首次使用可在“设置”导入旧版 `data/state.json` 或通过旧版导出的 JSON 备份。应用不会在启动时自动覆盖现有数据。备份、Obsidian 目录选择与确认操作使用系统对话框；论文网址与 Zotero 链接交给浏览器或 Zotero 打开。

构建需要 Apple Silicon Mac、Xcode Command Line Tools、Node.js/npm、Rust stable 与 Python 3.10+。仓库内 `.desktop-tools/cargo/bin`、`.desktop-tools/rustup`、`.desktop-tools/venv` 若已安装，会自动复用；否则使用 PATH 上的 Rust 与 Python，并在 `.desktop-tools/venv` 创建打包环境。

```bash
npm ci
npm run desktop:package
```

输出：`dist/macos/0.2.1/PaperLine.app` 与 `PaperLine_0.2.1_aarch64-apple-darwin.dmg`。DMG 通过 `hdiutil` 无界面生成，包含应用与“应用程序”快捷方式，不需要 Finder 或解锁桌面。构建不会覆盖 `dist/macos/PaperLine.app` 的预览版。`npm run desktop:dev` 启动开发版。构建只打包 `static/` 与独立后端，不包含 `data/`、WebDAV 凭据或本地日志。首次构建会下载 Cargo 依赖与 PyInstaller。打包前会检查 Python 可执行文件与动态库的最低 macOS 版本；若高于 13.0 会终止构建。可以通过 `PAPERLINE_PYTHON=/path/to/python3.13 npm run desktop:package` 指定兼容的 Python；已有构建环境使用其他解释器时，须先重建 `.desktop-tools/venv`。当前默认使用本机 ad-hoc 签名并保留 Hardened Runtime；由于打包的 Python 动态库没有 Team ID，应用仅添加 `disable-library-validation` 例外（Tauri 对主程序与侧车共用同一 entitlement 文件）。打包脚本会再次运行已签名应用内的后端，检查启动、API 与退出；对外分发前需要 Developer ID 签名与 Apple 公证。

## Windows 桌面版（0.2.1，CI 验证通过）

目标为 Windows 10/11 x64。安装器采用 NSIS，为当前用户安装，无需单独安装 Python 或 Node.js；可选择简体中文或英文。缺少 WebView2 时，安装器会下载微软官方 bootstrapper，因此首次安装可能需要联网。应用数据存放在 `%APPDATA%\io.github.applespriter.paperline\`，与安装目录分开。旧版 JSON 数据可以从“设置”导入。

在 Windows 本机安装 Python 3.13 x64、Node.js/npm、Rust stable MSVC，以及 Visual Studio Build Tools 的“使用 C++ 的桌面开发”和 Windows SDK，然后在项目目录的 PowerShell 执行：

```powershell
npm ci
npm run desktop:windows:package
```

需要指定解释器时，先设置 `$env:PAPERLINE_PYTHON = "C:\path\to\python.exe"`。打包脚本使用独立的 `.desktop-tools/venv-windows`，生成 `paperline-backend-x86_64-pc-windows-msvc.exe` 并通过标准输入输出测试；不会打包真实 `data/`、账户信息或日志。输出为 `dist/windows/0.2.1/PaperLine_0.2.1_x64-setup.exe` 与 `SHA256SUMS.txt`。`npm run desktop:windows:dev` 启动开发版。Windows 后端必须在 Windows 编译，不能用 macOS 的 PyInstaller 产物替代。

`.github/workflows/windows-desktop.yml` 提供 Windows CI：运行 Node、Python、Rust 测试，构建安装器，静默安装到临时目录，使用 `--smoke-test` 的空临时数据目录创建真实窗口、正常退出并检查本次启动的进程是否残留。测试模式不会读取默认用户数据，也不会使用真实 Zotero/WebDAV 凭据。通过后上传安装器和校验和作为 GitHub Actions artifact，不发布 Release。

[本次 Windows CI](https://github.com/AppleSpriter/PaperLine/actions/runs/38501863099) 已通过 Node、Python、Rust 测试、NSIS 打包、临时目录静默安装、独立数据 API、窗口启动、正常退出、子进程清理与卸载验证，并上传安装器 artifact。这些验证覆盖安装、窗口启动、协议与生命周期；Zotero、目录选择、备份保存及完整界面仍需 Windows 实机验收。现阶段没有 Windows 代码签名证书；未签名安装器可能触发 SmartScreen。设计依据：[Tauri 官方 Windows installer 文档](https://v2.tauri.app/distribute/windows-installer/)。

## 浏览器版运行

需要 Python 3.10 或更新版本，无需安装依赖。

**macOS：双击项目目录中的 `PaperLine.app`。** 启动器会在后台启动本地服务并打开浏览器；如果服务已在运行，则直接打开页面。通过 `.app` 启动后，双击 `stop.command` 可停止服务。请让 `PaperLine.app` 与 `app.py` 保持在同一项目目录中。

也可以双击 `start.command`，在终端前台运行；关闭该终端即可停止服务。其他系统在项目目录执行：

```bash
python3 app.py
```

应用会在浏览器打开 `http://127.0.0.1:8765`。

右上角的“帮助”随时打开完整使用说明，包含概念、上手步骤、Zotero 与 Obsidian 配置和快捷键。

## 首次使用

1. 创建一条阅读线，写下要研究的问题。
2. 在“搜索”里一个框同时搜阅读线、思想卡和论文，结果按类型用左侧色条和标签区分（思想卡绿色、阅读线蓝色、论文紫色），点一下直接跳到对应位置；选了状态筛选时只看思想卡。添加新卡时也会显示相近卡片。思想卡可以设置别名，并同时属于多条阅读线。
3. 在“论文库”搜索本机 Zotero，导入论文；也可以手动添加。选择论文后，可读取其文字批注并从批注建卡。
4. 把多篇论文关联到同一张卡，并为每条关系写下具体用法和原文位置。遇到新问题时点击“引申新卡”，新卡会自动连回来源思想。
5. 点击“开始读”，结束时用自己的话写两句，再留下一个下次要弄清的问题。下次打开这张卡时会先看到上次的记录。
6. 在“设置”填写 Obsidian 库目录，点击“导出到 Obsidian”。

可以在设置中切换界面语言（简体中文 / English），也可以指定每日提醒时间。应用页面保持打开时会弹出站内提醒；按需开启浏览器通知。Obsidian 笔记中自动生成的栏目标题会使用当前界面语言；已有笔记中手写的内容不会被改写。

卡片编辑会保留草稿，切换卡片或刷新页面后可以继续写。阅读时点击“稍后继续”会保留计时和感想，再次打开同一张卡即可继续，中间休息的时间不会计入阅读。草稿存于当前浏览器，点击“保存卡片”或“保存本次阅读”后才会写入应用数据并纳入备份与导出。

卡片的类型和状态是一排按钮，点一次立即保存，不需要再点“保存卡片”；正文仍按草稿处理。

在阅读线视图里用每行的 ↑ ↓ 调整学习顺序。每张卡会累计阅读时长，卡片详情显示总时长和次数，阅读线顶部显示整条线的累计时长。

同时开着两个页面时，切回页面会自动载入最新数据。如果一张卡在别处已经改过，保存时会提示并载入新版本，你写的内容保留为草稿，确认后再点一次保存即可覆盖。

论文地图的年份模式按年份分列，并用连线显示引用时间轴；也可切换为库内被引次数排序。选中论文后显示三栏：左侧是它引用的论文，中间是当前论文，右侧是引用它的论文；“返回全库”恢复之前的排序。桌面端详情固定在侧栏，窄屏端使用详情抽屉。推荐论文来自至少两篇库内论文的参考文献证据。旧版数据会直接用已保存的引用关系与参考文献重建推荐，无需再次同步 Zotero。

论文地图和思想图内可按住 macOS 的 Command 或 Windows 的 Ctrl 并滚动鼠标滚轮缩放（15%–200%）；普通滚轮仍用于滚动，缩放以鼠标位置为中心。

右上角“整页”按钮可调整整个界面至 70%–150%，点击百分比恢复 100%；比例在本机保存，与图谱独立缩放互不影响。

## 删除与快捷键

- 思想卡：右侧详情底部的“删除这张思想卡”。它的论文关系、思想关联和阅读记录会一并删除。
- 论文：右侧详情底部的“删除这篇论文”。只删除它与思想卡的关系，思想卡本身保留。
- 阅读线：在“编辑阅读线”弹窗里点“删除阅读线”。思想卡、论文和阅读记录都会保留。
- 删除后再次导出，会把之前由应用管理的对应 Obsidian 笔记移至库内 `.trash/PaperLine/`，可恢复整篇笔记和手写补充。其他手写笔记不会被清理。
- 快捷键（没有弹窗且焦点不在输入框时）：`1`–`4` 切换思想图 / 阅读线 / 搜索 / 论文库，`n` 新建思想卡，`p` 添加论文，`l` 新建阅读线，`s` 开始阅读当前卡，`/` 跳到搜索，`?` 打开使用说明。

Zotero 须保持开启，并在 **设置 → 高级**中启用“允许本机其他应用与 Zotero 通信”。应用只读取 Zotero 的本地接口，不修改 Zotero 资料。

## 数据与导出

- 浏览器版数据存放在 `data/state.json`；该目录已被 Git 忽略。
- 每次写入前会把上一份数据复制到 `data/state.backup.json`。主文件损坏时应用不会改动任何数据，并在错误提示里给出这份备份的位置。
- “设置 → 备份数据”可下载完整 JSON 备份；“从备份恢复”可以选一个备份文件替换当前数据。恢复前会检查文件格式和引用是否完整，并把当前数据另存为 `data/state.before-restore-时间.json`。Obsidian 路径、语言和提醒时间沿用本机设置，不从备份带过来。WebDAV 云端 `history/` 里的文件也可以直接拿来恢复。

## WebDAV 云同步

- 在“设置 → WebDAV 云同步”填写地址、用户名、密码和云端文件夹，勾选“自动上传到 WebDAV”，先点“测试连接”确认能写入。
- 开启后，有改动时每 5 分钟自动上传一次 `state.json` 到云端文件夹（从第一次改动算起，5 分钟内的改动合并成一次上传；没有改动就不上传），并在 `history/` 下每天保留一份 `state-YYYY-MM-DD.json`。上传失败会按 1、2、4…最长 15 分钟退避重试；应用启动时和正常退出前也会补传一次。
- 右上角显示“已同步 / 待同步 / 同步失败”，点它打开设置查看原因；“立即同步”可以手动上传。
- 坚果云地址是 `https://dav.jianguoyun.com/dav/`，密码要用它后台生成的“应用密码”。Nextcloud 一般是 `https://你的域名/remote.php/dav/files/用户名/`。
- 账号单独存放在 `data/webdav.json`（权限 600），不会写进 `state.json`、备份下载或浏览器。密码框留空表示沿用已保存的密码；换了地址或用户名就必须重新填写。
- 每次保存都会在数据里记下保存时间 `savedAt`。设置里会显示本机和云端各自的保存时间，以及哪边更新。
- 上传前先比较两边时间：云端比本机新（比如另一台电脑刚传过）时，自动上传会暂停，右上角显示“云端更新”，不会覆盖云端。
- 这时可以点“从云端恢复”，确认后用云端数据替换本机；本机当前数据先另存为 `data/state.before-cloud-restore-时间.json`。恢复后两边时间一致，自动上传照常继续。
- 也可以点“立即同步”，确认后用本机覆盖云端；被覆盖的云端那份会先存成 `history/state-overwritten-时间.json`。
- 如果本机比云端新，“从云端恢复”会多提醒一句会用较旧的数据替换。两边内容一致时不会恢复。Obsidian 路径、语言和提醒时间始终沿用本机设置。
- 旧版本上传、没有 `savedAt` 的云端文件，按服务器记录的修改时间比较。两台电脑的系统时钟差太多时，判断可能不准。
- 不会自动合并两边的改动：两台电脑都改过时，只能选一边保留，另一边在 `history/` 或 `data/` 里留有副本。建议使用 https 地址，http 会明文传输密码。
- Obsidian 导出位置是所选库的 `PaperLine/`，包含“阅读线”“思想卡”“论文”三个目录。
- 导出笔记不再包含隐藏 HTML 标记。生成内容的所有权保存在 `PaperLine/.paperline-export.json`；重复导出只替换上次生成的完整内容，保留前后的手写补充，旧标记笔记会自动迁移。如果生成内容被手工修改、出现重复或同名文件无法确认归属，整次导出会在写入前停止并指出冲突文件。请保留该隐藏记录文件。
- 内容没有变化的笔记会跳过、不重写文件，避免 Obsidian 同步整库刷新；导出后会提示本次写入多少篇、跳过多少篇。
- 笔记文件名在创建时按标题生成，之后改标题不会改文件名，以免 Obsidian 里已有的链接失效；笔记正文中的标题会随之更新。
- 论文笔记首次导出会带有你使用的“一句话、解决问题、核心机制、思考、技巧、局限”等栏目。

应用只绑定到 `127.0.0.1`，不需要账号或云服务。图谱和计时都在本机运行。

## 验证

```bash
python3 -m unittest discover -s tests -v
node --check static/app.js
node --check static/i18n.js
node --test tests/*.test.js
```
