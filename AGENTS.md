# Repository Guidelines

## Project Overview

`omp-herdr-name-bridge` 是本地 OMP 扩展, 将 OMP 会话名称同步到所在 Herdr 2 tab. 用户通过 Herdr Rename Tab 改名后, 该 tab 由用户接管, 不再接受 OMP 名称覆盖; Herdr 后续非空改名仍同步到 OMP. 不调用模型, 不直接修改会话文件或 Herdr 布局文档. 完整产品规则与安装说明见 `README.md`.

## Architecture & Data Flow

- `src/index.ts` 接收 OMP 生命周期事件, 为主 TUI/RPC host 注入 `NamingHost`, 每轮同步完成后再安排约 1 秒的下一轮.
- `NameBridge` 读取 core 快照, 发布注册, 确认 terminal 归属及 tab 单实例, 校验目标 app 窗口, 再调用纯函数 `nameDecision` 产生同步决策.
- 写入前重新读取快照并复核 session epoch, core, tab, 两端名称和成员唯一性. tab 写入走 `herdr-app do tab.rename`, OMP 写入走公开 `pi.setSessionName` API.
- 名称基线按 `core/tab/epoch` 保存在内存. 手动接管按 `core/tab` 保存到私有注册目录的 `<tab-id>.manual`, 跨会话切换和 OMP 重启保留; 退出只移除自身 `<runtime-id>.json` 注册.

关键不变量: 首次无接管记录时非空 OMP 名称优先; 非桥接写入的 tab 变化触发接管, 同轮冲突以 tab 为准, 清空也接管但不清空 OMP. 桥自身 pending 写入的目标确认不能误判为用户操作. 多实例或归属不明时暂停, 不绕过检查强写.

## Key Directories

- `src/`: 扩展入口, 名称状态机, 同步编排和 Herdr/注册表适配.
- `tests/`: Bun 单元测试, 包括真实临时注册文件与纯内存 core 快照.
- `scripts/`: 启动隔离真实组件的集成验证及 OMP 命名 fixture, 不属于生产扩展入口.

## Development Commands

```sh
bun test                         # 全部单元测试
bun test tests/names.test.ts     # 名称状态机回归
bun run verify                   # 隔离的真实 core/app/OMP 集成验证
omp plugin link "$PWD"           # 链接当前 checkout, 然后启动新的 OMP
```

没有独立 build, lint, format 或 typecheck 脚本. 宿主直接加载 TypeScript, 不要虚构构建步骤. 命名 profile 使用对应启动器执行 link, 例如 `omp4 plugin link "$PWD"`.

## Code Conventions & Common Patterns

- TypeScript ESM, tab 缩进, 双引号, 分号, camelCase 函数/变量, PascalCase 类型/类, 使用 `import type` 和项目现有相对导入风格.
- `names.ts` 保持无 I/O 的纯决策函数, 显式传入时间以测试 pending 边界. `NameDecision.kind` 是判别联合, 不将业务规则散落到定时器或 RPC 层.
- `NamingHost` 是 OMP API 的注入边界. `NameBridge.synchronize()` 共享 in-flight Promise, `current(epoch)` 防止旧会话异步结果写入新会话; 保留这些串行与生命周期约束. 事件驱动的 Promise 使用 `Promise.withResolvers<T>()`, 与 RPC 和验证客户端一致.
- 外部 JSON, 标识符和名称在 `herdr.ts` / `names.ts` 边界校验. 未知协议/归属或 I/O 错误向上传播, 由入口转换为 paused 状态; 文件清理只忽略 `ENOENT`, PID 探测只把 `ESRCH` 当作退出.
- 注册记录采用私有目录和临时文件加 rename 发布. 活 PID 的过期心跳意味着暂停, 不是删除依据. 接管标记与 runtime 注册生命周期不同, 不随 `Registry.remove()` 删除.

## Important Files

- `package.json`: `omp.extensions` 指向 `src/index.ts`, 定义脚本和宿主 peer dependency.
- `src/bridge.ts` / `src/names.ts`: 会话绑定, 写前复核, pending 确认及手动命名所有权. 修改同步行为时一起检查.
- `src/herdr.ts` / `src/registry.ts`: newline JSON-RPC, app CLI, terminal 父链与布局成员核对, 本机实例协调及接管存储.
- `scripts/verify.ts` / `scripts/naming-fixture.ts`: 真实组件 QA 与无模型调用的标题 setter. `README.md` 保存用户可见规则, 行为变化时同步更新.

## Runtime/Tooling Preferences

使用 Bun, 不替换为 Node 测试运行器: 实现依赖 `Bun.TOML`, 验证依赖 `Bun.spawn` 和 `Bun.sleep`. 无额外运行时依赖, peer 为 `@oh-my-pi/pi-coding-agent >=18.16.0`.

目标是本地 macOS Herdr 2 + OMP. 当前协议适配基于 Herdr app 0.1.13 和 core generation 1; Windows, 远程机器和非 main TUI/RPC host 不属于支持路径. `hc`, `herdr-app`, 验证所需的 `omp` 必须在 `PATH` 中.

`HC_TERMINAL_ID` 定位终端, `HC_SOCKET` / `HC_SESSION` 定位 core, `HERDR_APP_HOME` 精确选择 app 窗口. 不通过当前焦点猜目标, 不因目标不可用切到其他窗口. 详细默认路径见 `README.md` 和 `coreEndpoint()`.

## Testing & QA

- 使用 `bun:test`, 没有配置覆盖率门槛. 名称变更重点验证状态转换: pending 等待/确认/超时, 手动接管后不覆盖, 空名, 同轮冲突及未接管 tab 正常同步.
- 注册测试使用随机 core/runtime ID, `finally` 清理自己创建的目录. 保留跨 runtime 接管与不同 core/tab 隔离的行为断言.
- 修改编排或生命周期后运行 `bun run verify`. 它在 `/tmp/onb-*` 创建独立 home, core socket, app 和 OMP RPC 会话, 用真实 setter 与 app 命令验证, 断言不调用模型; 日志与 `names.json` 保留供核查. 可用 `HERDR_TEST_APP` 指定 app 可执行文件.
- 验证只关闭自建进程与对应注册目录. macOS 启动器退出不代表实际 Herdr 已退出, 以隔离 app 控制 socket 关闭为清理证据. 不终止日常 Herdr/core 或其他 OMP 会话.
- 协议验证不等于 GUI 验收. 当前手动接管依据轮询到的名称差异, 无法识别首次绑定前的历史改名, 相同名称提交或轮询间改名后恢复; 也不提供原子条件改名保证. 不把这些未观测事件宣称为已覆盖.
