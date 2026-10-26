# pulp-platform AXI 4×4 crossbar 示例

这是一个可直接在 RTL Browser 中打开、构建和浏览的中型工程，RTL 来自公开仓库
[`pulp-platform/axi`](https://github.com/pulp-platform/axi/tree/master)，固定提交
`70b8e54fd460e3308e58be596ceb3566a6e3576e`（`0.39.11`）。

示例顶层 `pulp_axi_xbar_top` 是一个 4×4 AXI4+ATOP crossbar：

- 地址/数据宽度 64 bit，slave ID 宽度 4 bit；
- 所有 slave/master 端口全连接；
- 包含 `axi_xbar`、`axi_demux`、`axi_mux`、ATOP filter、burst splitter、
  ID remap、寄存器切片、`common_cells` 等完整实现；
- 顶层端口使用 SystemVerilog struct array，展示复杂参数化类型和 generate
  展开的层次结构。

`rtl/example/pulp_axi_xbar_top.sv` 是本示例编写的固定参数 wrapper；`rtl/axi/`、
`deps/common_cells/`、`deps/tech_cells_generic/` 和 `tb/axi_synth_bench.sv`
是上游文件的未修改副本。上游 `axi` 仓库自带的 `axi_synth_bench` 也随示例编译，
但默认 Top 是上面的 4×4 wrapper。

## 在 WebUI 中启动和编译

在 RTL Browser 仓库根目录启动服务：

```bash
./tools/launchers/rtl-browser serve --workspace examples --port 0
```

终端会输出一次性的 `open:` URL，用本地浏览器打开。然后在页面中：

1. 点击“打开工程目录”；
2. 选择本目录 `examples/pulp-axi`（工程目录就是工程根，不需要填写工程名称、源根或工作目录）；
3. 输入方式选择 **Filelist**；
4. Filelist 填写 `design.f`；
5. Top module 填写 `pulp_axi_xbar_top`；
6. 其他高级选项保持默认，点击“编译并建立索引”。

构建成功后，顶栏显示 Top `pulp_axi_xbar_top`，左侧层次树从
`pulp_axi_xbar_top` → `i_xbar`（`axi_xbar`）→ `i_xbar_unmuxed` 等节点展开。
源码、hover、Driver/Load、参数覆盖和右键“转到定义位置”均可正常使用。

工程状态写入 `examples/pulp-axi/.rtlb/sessions/<sessionId>/`，源文件不会被修改。
配置变化后重新构建会自动清除本会话旧快照；相同输入可复用快照。构建后可导出 `.rtlbsnap` 单文件快照，并在其他目录用相同程序版本导入。

## 预期诊断

当前上游版本的 `axi_demux_simple.sv` 在默认参数下会产生一条
`sequence can never be matched` warning，这是上游 assertion 在特定参数组合下的
静态诊断，不影响 `COMPLETE` 快照。构建结果应为 0 error、1 warning。

## 依赖与来源

详见 [SOURCE.md](SOURCE.md)。许可证副本位于 `licenses/`：

- `AXI-LICENSE`：Solderpad Hardware License 0.51；
- `COMMON_CELLS-LICENSE`：Solderpad Hardware License 0.51；
- `TECH_CELLS_GENERIC-LICENSE`：Solderpad Hardware License 0.51。
