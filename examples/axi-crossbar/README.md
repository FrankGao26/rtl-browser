# AXI Crossbar 本地示例工程

这是一个自包含的 Verilog 示例工程，用于演示层次、参数覆盖、端口连接、Driver/Load 和源码浏览。

上游来源、固定提交和许可证见 `SOURCE.md` 与 `licenses/COPYING`。RTL 源码没有针对本工具做修改。

## 打开

在仓库根目录执行：

```bash
./tools/launchers/rtl-browser serve --workspace examples --port 0
```

打开启动器输出的 `open:` URL，然后：

1. 点击“打开工程目录”，通过“浏览…”或直接输入选择 `examples/axi-crossbar`；
2. 新目录没有配置时，填写：
   - Filelist：`design.f`
   - Top 模块：`axi_crossbar`
   - 高级选项保持默认；
3. 点击“编译并建立索引”。

不再需要填写工程名称、工程根、源根、工作目录或清单模式。工程状态会写入本目录的 `.rtlb/sessions/<sessionId>/`，正常退出即删除；如果目录不可写，WebUI 会报错并拒绝打开。

预期结果：

- 构建成功，`0 error`；
- 1 个上游 warning（`ShiftCountOverflow`），不影响发布；
- 顶栏显示 Top `axi_crossbar`；
- 可展开层次、查看完整源码、hover 参数/端口、右键 Driver/Load。

不同提取器版本下实例和符号计数可能略有变化，以 Compile 报告为准。

## 说明

- 这是公开的 AXI crossbar 示例，不是完整 SoC，也不是大规模性能基准。
- 运行时不会修改本目录中的 RTL 文件；只会在 `.rtlb/sessions/` 下写入本进程的会话状态。
- 同一服务进程内刷新页面会恢复当前会话；程序重启后从空白表单开始。修改 Filelist/Top 并重新构建会清除本会话旧快照。
- 构建后可导出 `.rtlbsnap` 单文件快照；拖到其他目录/机器时，用相同 extractor 版本的程序“从快照打开…”即可恢复界面。
