# dsh-ops-mac

[![origin](https://img.shields.io/badge/origin-T--Auto%2Fdsh--ops-blue)](https://github.com/T-Auto/dsh-ops)

**macOS（Apple Silicon）移植版**的 [dsh-ops](https://github.com/T-Auto/dsh-ops) —— 一个 DSH（DeepSeek Harness）性能工具插件：用 Rust 重写文件检索与批处理工具，减少 AI 编码时的 token 消耗、报错循环和任务耗时。

> **改造来源声明**：本项目基于 [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops)（v0.3.0，commit `e6160ba`）移植到 macOS arm64。上游插件面向 Windows x64 设计；本移植版保留其核心（原生 Rust 文件工具 + PTC 批处理），移除了 Windows 专属部分。上游的 CHANGELOG 与载荷来源记录保留在 [CHANGELOG.md](CHANGELOG.md)、[PROVENANCE.md](PROVENANCE.md)。移植改动清单见下方「移植了什么」。

---

## 这是什么

DSH 标准模式下，插件发布 4 个高性能文件工具（schema 直接进模型上下文）；PTC（Persistent Tool Context）会话下，额外发布 2 个批处理/结果引用工具（通过 `run_code` 以代码方式调用，**不占用模型工具 schema**，批量任务零往返）。

| 工具 | 用途 | 模式 |
| --- | --- | --- |
| `ops_inspect_local_file` | 有界 UTF-8 文本 / hex 读取 | 标准 |
| `ops_grep` | Rust 正则搜索，多文件过滤，count/summary 模式 | 标准 |
| `ops_glob` | 多模式 glob 找路径，支持排除 | 标准 |
| `ops_replace` | 跨文件字面批量替换，`dryRun` 预检 + 原子写入 | 标准 |
| `ops_batch` | 预检并执行 copy/move/remove，带审计与恢复 | 仅 PTC |
| `ops_result` | 有界结果引用：写入、分页、释放 | 仅 PTC |

所有工具遵循 DSH 会话沙箱策略（read-only / workspace-write / danger-full-access），路径以会话 cwd 为基准，UTF-8 优先，不遍历符号链接 / `.git` / 隐藏文件。工具失败以值返回（`status: "error" | "rejected"` + `error.code`），不抛异常。

## 安装

前置条件：macOS（Apple Silicon）、Node.js `^22.19 || >=24`、已初始化的 DSH 桌面应用（0.2.0-rc.2）。

```console
# 1. 本目录放入任意位置（例如 ~/dsh-ops-mac）
# 2. 用桌面应用自带 CLI 以 link 方式装入 profile：
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add /path/to/dsh-ops-mac

# 3. 完全退出并重启 DSH 桌面应用，开新会话即可
```

验证：新会话里问模型「列出以 `ops_` 开头的工具」。标准会话应看到 4 个文件工具；PTC 会话里 `run_code` 的 `tools.*` 绑定中应有 6 个（`ops_batch`、`ops_result` 仅在此出现）。

卸载：

```console
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop remove dsh-ops
```

## 从源码重建 worker

`runtime/darwin-arm64/dsh-ops-worker` 是预编译产物（附 sha256 receipt，运行时校验，不匹配拒绝加载）。自己编译：

```console
# 需要 Rust 1.88+（rustup）
cd native && cargo build --release
# 产物在 native/target/release/dsh-ops-worker
# 复制到 runtime/darwin-arm64/，并同步更新 provenance.json 的 sha256 与 version
```

## 移植了什么（相对上游的改动）

上游是 Windows x64 专用（`os: win32, cpu: x64`，随包携带 MSYS bash 5.3.15、PowerShell 7.6.6、FastCtx 二进制，约 718 MB）。本移植版：

**保留并适配：**

- `dsh-ops/file` 组件 —— Rust 原生文件工具，worker 为 darwin-arm64 重新编译（纯 Rust、`unsafe_code = "forbid"`、零 C++ 依赖）
- `dsh-ops/ptc` 组件 —— 已在真实 DSH 桌面端（Seatbelt 沙箱）端到端验证

**移除（Windows 专属）：**

- `dsh-ops/shell` 组件 —— 随包 MSYS bash / PowerShell 7 及其 IPC 代理（`msys-2.0.dll` 补丁、命名管道）在 macOS 上无意义：DSH 的 macOS 会话本身就运行 bash，并有宿主自己的 Seatbelt 沙箱
- `dsh-ops/background` 组件 —— FastCtx 后台任务托管（未携带 darwin 二进制；且新版 DSH 宿主已内置后台任务工具）
- Windows 工作区 ACL 准备（`prepare-workspace.ps1`）—— 上游代码本身有 `win32` 门控，本移植版连同其组件一起裁掉
- `vendor/fastctx/` 上游源码树 —— 不随本仓库分发，见上游 [PROVENANCE.md](PROVENANCE.md)

**macOS 专属修复：**

- `/tmp → /private/tmp`、`/var → /private/var` 符号链接：Rust worker 逐组件 no-follow 打开路径，符号链接祖先会被 `POLICY_DENIED` 拒绝。移植版在 JS 桥（`lib/file/worker.js`、`lib/ptc/worker.js` 的 `darwinRealPath()`）把路径规范化到真实路径，不存在的尾部（新文件）也正确处理
- 平台门控放开：`lib/ptc/runtime.js` 的 `PLATFORMS`、`package.json` 的 `os/cpu`、`dsh-plugin.json` 的平台声明

**已知保留的上游行为**（与上游 0.3.0 一致，移植时未改动）：

- 读类工具（`ops_inspect_local_file` / `ops_grep` / `ops_glob`）不校验工作区边界，可读取 OS 可读的任意路径。上游维护者在 [issue #34](https://github.com/T-Auto/dsh-ops/issues/34) 将其定义为预期行为（「workspace-write 并非读范围围栏」）；**写入边界是完整的**。介意的话可在 `lib/file/worker.js` 的读路径补上 `inside()` 包含性检查（该文件里已有现成的辅助函数）。

## 与上游默认值的一个差异：PTC 默认开启

上游 0.3.0 的 `dsh-ops/ptc` 组件默认**关闭**（`disabled: true`），因为它是 Windows 上的新功能、验证未铺开。本移植版将其**默认开启**（[cordis.patch.yml](cordis.patch.yml) 中 `disabled: false`）：移植者已在 macOS 桌面端完成 PTC 全链路验证——`run_code` 内调用 `ops_batch` / `ops_result` / 文件工具均正常，Seatbelt 沙箱探测通过，批处理写入边界（工作区外拒绝）有效。

若你只想要文件工具、不需要批处理，把 `cordis.patch.yml` 里 `dsh-ops-ptc` 的 `disabled` 改回 `true` 即可。注意两点：

- `ops_batch` / `ops_result` **仅在 PTC-only 会话中发布**（DSH 的呈现机制，不是插件开关）；标准会话里它们自动隐藏
- PTC 会话里所有 `ops_` 工具（含文件工具）都通过 `run_code` 的 `tools.*` 绑定调用，模型看不到它们的 schema——这是省 token 的机制，不是故障

## 文档

上游的完整文档保留在 [docs/](docs/)（中文为主：使用指南、组件参考、配置参考、常见问题、PTC 设计），但其内容描述的是 Windows 全量组件（shell/background/pwsh 路由等），阅读时请以上方「移植了什么」为准，本移植版不维护差异副本。

## 许可证

与上游一致：**MIT AND Apache-2.0**（插件源码 MIT，见 [LICENSE](LICENSE)、[NOTICE](NOTICE)）。上游的 Rust 核心基于 [yc-duan/fastctx](https://github.com/yc-duan/fastctx)（Apache-2.0）改造，声明见上游 [PROVENANCE.md](PROVENANCE.md)。本移植版对上游代码的修改遵循相同许可证分发，不由上游作者背书。

## 致谢

- 上游项目与 Windows 实现：[T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops) 的作者与贡献者
- Rust 核心来源：[yc-duan/fastctx](https://github.com/yc-duan/fastctx)
- 宿主平台：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
