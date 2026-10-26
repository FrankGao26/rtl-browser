# RTL Browser

![web-browser](./docs/rtl-browser.png)

RTL Browser 是一个本地运行的 WebUI RTL 浏览器。选择一个工程目录，使用 slang 编译并建立只读语义快照，然后浏览层次结构、源码、悬停信息、Driver、Load、实例端口/参数和编译报告。

- 运行在本机 `127.0.0.1`，不上传工程、不访问 CDN、不修改源 RTL。
- 服务端使用 Node.js，原生索引器使用 C++20 + slang 12，快照存储在项目内的 `.rtlb`。
- 当前项目是可运行的垂直切片，不是完整商业产品。

## 功能

- **层次结构**：模块实例、generate scope、端口和参数。
- **源码浏览**：完整文件、可折叠的层次视图、源码搜索和行内匹配高亮。
- **语义导航**：信号/参数/类型/package/宏 hover 与跳转，Driver/Load Trace，端口 actual 和参数覆盖追踪。
- **作用域灰显**：同文件其他模块、未生效的 generate 分支，以及当前宏配置下未选中的 `ifdef`/`ifndef`/`elsif`/`else` 分支（支持多层嵌套）。
- **Inspector**：端口方向、位宽、参数默认值/实际值、结构体成员值。
- **快照**：导出为单个 `.rtlbsnap` 文件，可在另一台机器导入并浏览，无需原 RTL 目录存在。
- **报告与诊断**：Compile 诊断、warning/broken 设计处理、主题与字号设置。

## 平台支持

| 平台           | 状态                                                        |
| -------------- | ----------------------------------------------------------- |
| Linux x86_64   | 支持，已在 Ubuntu 24.04 WSL2 验证                           |
| Windows x86_64 | 构建脚本与原生 worker 已适配，需在 Windows 主机执行构建验收 |
| macOS ARM64    | 后续阶段                                                    |

当前只支持 64 位平台。Windows 构建需要较新的 MSVC/Clang：slang 12 要求 MSVC 14.50+/VS 2026 或 Clang 17+，不支持 MinGW。

## 环境要求

### Linux

- Node.js 24（或由项目 bootstrap 下载固定版本）
- CMake >= 3.28
- Ninja
- GCC 11+ 或 Clang 17+
- Python 3
- Git、curl、unzip、`sha256sum`
- 浏览器：Chrome / Firefox / Edge

### Windows

- Node.js 24
- CMake >= 3.28
- Ninja
- Python 3
- Git
- Visual Studio 2026 Build Tools（x64 C++ 工作负载）或 LLVM clang-cl 17+ + Visual Studio Windows SDK/STL
- 浏览器：Edge / Chrome / Firefox

第三方库版本和 SHA-256 统一记录在 `tools/deps/versions.json`，首次 bootstrap 需要网络；完成后可离线构建。第三方源码、Node 运行时和 `node_modules` 不提交到仓库，bootstrap 会下载到被忽略的 `.sandbox/deps`。

## 快速开始

### Linux

```bash
git clone <repository-url> rtl-browser
cd rtl-browser

./tools/deps/bootstrap.sh   # 下载并校验固定版本的 Node、slang、SQLite、nlohmann/json
./tools/build.sh            # 构建 C++ worker、TypeScript server 和 WebUI
./tools/launchers/rtl-browser serve     # 启动服务并打印 URL
```

打开终端输出的 `open:` URL。`tools/build.sh` 会优先使用 `.sandbox/deps` 中的固定 Node；不要求宿主 Node 与项目锁定版本完全一致，但必须是 Node 24。

开发时也可以使用项目 bwrap 沙箱（Linux 可选）：

```bash
./tools/sandbox/verify-isolation.sh --network online
./tools/sandbox/rtl-bwrap --profile bootstrap --network online -- ./tools/deps/bootstrap.sh
./tools/sandbox/rtl-bwrap --profile build --network offline -- ./tools/build.sh
./tools/sandbox/rtl-bwrap --profile test --network offline -- ./tools/test.sh
```

### Windows x64

在 PowerShell 中：

```powershell
git clone <repository-url> rtl-browser
cd rtl-browser

.\tools\deps\bootstrap.ps1
.\tools\build.ps1
.\tools\launchers\rtl-browser.cmd serve
```

`bootstrap.ps1` 会检查 CMake、Ninja、Python、Git 和 Visual Studio，并通过 `vswhere`/`VsDevShell` 初始化 `cl.exe`、Windows SDK 和 Ninja 环境。如果使用 LLVM clang-cl：

```powershell
$env:RTL_CC = "clang-cl"
$env:RTL_CXX = "clang-cl"
.\tools\deps\bootstrap.ps1
.\tools\build.ps1
```

clang-cl 必须使用 Visual Studio 的 Windows SDK 和 STL；slang 不支持 MinGW。Windows 上 64 位构建产物为：

```text
build\index-worker\index-worker.exe
dist\server\apps\server\src\main.js
dist\web\index.html
```

Windows 构建需要较新的 Visual Studio；若本机 MSVC 版本过旧，bootstrap 会直接报错并提示安装新版 Build Tools 或改用 clang-cl。工程路径建议使用本地 NTFS 磁盘，并在包含空格、中文或较长路径的目录上单独验收。

## 第一次使用

1. 启动服务后打开终端打印的 URL。
2. 点击“打开工程目录”，选择包含 RTL 的目录。可以先用 `examples/axi-crossbar` 试用。
3. 填写 Filelist 和 Top 模块，点击“编译并建立索引”。
4. 编译完成后进入 Hierarchy、Source、Inspector 和 Compile 视图。
5. 顶栏可以导出/导入 `.rtlbsnap` 快照；快照导入不要求原 RTL 目录存在。

工程目录就是工程根，不需要额外填写工程名称、源根或工作目录。每个服务进程管理一个工程；需要并行处理不同设计时启动多个服务进程。

工程目录和项目配置的具体填写步骤见 [使用说明](docs/usage.md)。

## 项目配置

- Filelist 支持绝对/相对路径、嵌套 filelist、`$VAR`/`${VAR}`/`%VAR%`、`~/`、`+incdir+`、`-I`、`-y`、`-v`、`-D` 和 `+define+`。
- 相对路径以工程目录为基准；工程目录外的绝对路径只读使用。
- 支持显式 Top 模块、宏定义、include 路径、library 和参数覆盖。
- 语言模式可选 SystemVerilog 版本；未选择时使用 slang 默认值。

## 测试

Linux：

```bash
./tools/test.sh
# 或跳过需要 Chromium 的 UI 流程
RTL_TEST_SKIP_UI=1 ./tools/test.sh
```

Windows：

```powershell
.\tools\test.ps1
```

测试会创建临时工程和 `.rtlb` 会话目录。Linux 的 `tools/test.sh` 包含类型检查、契约、集成、安全、UI E2E 和公开 RTL smoke；设置 `RTL_TEST_SKIP_UI=1` 可跳过需要 Chromium 的 UI 阶段。Windows 的 `tools/test.ps1` 当前覆盖类型检查、契约和跨平台集成测试；POSIX 权限/symlink 安全用例只在 Linux 执行。

## 项目结构

```text
apps/server/            HTTP/SSE、会话、静态资源
apps/web/               React WebUI
packages/               contracts、core、storage、UI、client
native/index-worker/    C++20 + slang 索引 worker
contracts/              SQL schema 与 JSON 契约
tests/                  集成、安全、UI、公开 RTL smoke
tools/                  依赖、构建、测试、Linux 沙箱和启动器
examples/               公开示例工程
docs/                   项目配置使用说明
```

## 使用说明

工程目录选择和项目配置填写见 [docs/usage.md](docs/usage.md)。

## 许可证

项目源码采用 [Apache License 2.0](LICENSE)。第三方组件和公开示例的许可证、来源与固定提交见 `third_party/README.md`、`third_party/licenses/` 以及各示例目录的 `SOURCE.md`。
