# omp-herdr-name-bridge

让 Herdr 2 的标签页名称与 OMP 会话名称保持同步的本地 OMP 扩展.

在 OMP 中使用 `/rename` 或产生自动会话标题后, 尚未手动命名的 Herdr 标签页会跟随更新. 一旦扩展观察到 Herdr 的 Rename Tab 改名, 该标签页就由用户控制, 不再接受 OMP 名称覆盖; 后续 Herdr 改名仍同步到 OMP. 扩展通过公开命名 API 和指定标签页改名命令工作, 不直接修改 OMP 会话文件, 不写入 Herdr 共享布局文档.

## 功能

- 未手动接管前, OMP 会话名变化同步到对应 Herdr 标签页.
- 首次绑定且没有手动接管记录时, 以 OMP 已有的非空名称为准, 没有名称时等待命名.
- 观察到非桥接写入的标签页改名后锁定该 tab, 包括清空名称; 同轮双方都改变时, 标签页优先.
- 同一标签页存在多个已注册的 OMP 实例时暂停同步, 恢复为一个实例后继续.
- 手动接管记录按 core ID 和 tab ID 保存, 切换会话和重启 OMP 不会解除; 临时断连保留比较基线.

## 环境要求

- macOS 本地运行的 Herdr 2 与 OMP. 不支持 Windows 或跨机器的远程终端.
- OMP 18.16.0 或更新版本. 当前实现依据 18.16.0 的公开扩展 API, 未保证所有后续版本的兼容性.
- 当前适配 Herdr app 0.1.13 的文档结构和 core protocol generation 1 的 `doc.get`.
- `hc` 与 `herdr-app` 在 OMP 继承的 `PATH` 中可用.
- OMP 使用的 Bun 运行时. 本项目没有额外运行时依赖.

Herdr 的目标窗口必须打开, 且包含运行 OMP 的本地标签页. 关闭该窗口会暂停同步, 不会停止 OMP 或 core.

## 安装

```sh
git clone https://github.com/raiscui/omp-herdr-name-bridge.git
cd omp-herdr-name-bridge
omp plugin link "$PWD"
```

这会链接到默认 OMP profile. 如果使用命名 profile, 请通过对应启动器分别链接, 例如:

```sh
omp1 plugin link /absolute/path/to/omp-herdr-name-bridge
omp4 plugin link /absolute/path/to/omp-herdr-name-bridge
```

请将示例绝对路径替换为实际克隆目录. 建议在每个交互使用的 profile 中启用扩展, 以便识别同一标签页里的多个 OMP 实例.

安装后, 在 Herdr 中启动新的 OMP 进程. 已运行的进程不会因链接操作自动加载扩展, 无需修改 Herdr 安装包或安装 app mod.

## 使用

1. 在 Herdr 标签页内启动已启用扩展的 OMP.
2. 在 OMP 中执行 `/rename 项目名称`, 或等待 OMP 产生会话标题.
3. 查看对应 Herdr 标签页名称. 在 Herdr 中使用 Rename Tab 后, 该 tab 不再跟随 OMP 改名; Herdr 中的后续非空名称仍会同步到 OMP.

扩展没有额外操作命令. 每次同步完成后约一秒开始下一轮检查; core 请求超时为两秒, app 命令超时为三秒, 因此这不是实时或事务式同步.

### 具体命名规则

| 场景 | 行为 |
| --- | --- |
| 首次绑定, 无手动接管记录且 OMP 已有名称 | 使用 OMP 名称更新标签页 |
| 首次绑定, 无手动接管记录且 OMP 没有名称 | 等待 OMP 命名, 不反向导入已有标签名 |
| 未手动接管, 只有 OMP 名称改变 | 更新对应标签页 |
| 观察到非桥接写入的标签页名称改变且非空 | 锁定该 tab, 更新 OMP 会话名 |
| 双方相对上轮都改变 | 手动标签页名称优先, 锁定该 tab |
| 已手动接管, OMP 名称改变 | 保留标签页名称, OMP 名称可独立变化 |
| 双方名称相同 | 不执行改名 |
| 清空标签页名称 | 锁定该 tab, 保留 OMP 名称, 后续 OMP 改名也不回填 |
| 同一标签页有多个已注册实例 | 暂停, 避免多个 OMP 相互覆盖 |

从 Herdr 导入的名称会通过 OMP API 作为用户命名写入. 按照 OMP 自身策略, 这会阻止后续自动标题替换该名称. 手动接管记录独立于 OMP 会话, 不因 `/new` 或重启 OMP 而解除.

## 窗口与终端定位

通常直接使用 Herdr 提供的运行环境即可, 不需要手动设置变量.

| 环境变量 | 用途 |
| --- | --- |
| `HC_TERMINAL_ID` | 标识当前本地终端, 未提供时扩展不启动 |
| `HC_SOCKET` | 指定本地 core 的 Unix socket; 未提供时使用 core 配置与 `HC_SESSION` 端点规则 |
| `HC_SESSION` | 在解析 core 端点时使用的会话标识 |
| `HERDR_APP_HOME` | 精确选择目标 app 窗口的 home, 默认 `~/.config/herdr-app`, 必须为绝对路径 |

使用不同 home 启动多个 Herdr 窗口时, 在启动 OMP 前提供对应的 `HERDR_APP_HOME`. 扩展不会搜索当前聚焦窗口, 也不会在目标不可用时回退到其他窗口.

## 安全与隐私

- 名称同步本身不调用模型 API, 不需要额外的 API Key 或 Token.
- 使用本机 Unix socket 和 Herdr 命令, 不提供云端同步服务.
- 本地状态目录为 `/tmp/omp-herdr-name-bridge-<uid>/<core-id>/`. `<runtime-id>.json` 保存随机 runtime ID, PID, 终端 ID, 会话 ID, epoch 和心跳时间; `<tab-id>.manual` 保存该 tab 已被手动接管的标记.
- 同步前检查终端归属, 会话身份和注册成员. 归属不明确, 注册过期但进程仍存活, 或文档结构不兼容时暂停改名.
- 正常退出时只删除自身注册记录, 保留 tab 接管标记供后续 OMP 实例读取. 标记随该 core 状态目录保留, 不跨 core ID 或系统临时目录清理. 对其他实例, 只有确认 PID 已退出才清理, 不能仅凭心跳过期判断进程已死.

注册信息不包含会话正文, 但会话 ID 等仍属于本地运行信息. 同步后的会话名称会显示在 Herdr 标签页上, 请避免在名称中放入凭据或其他敏感内容.

## 已知限制与排障

- **没有同步**: 确认 OMP 在 Herdr 本地终端中启动, 扩展已在当前 profile 加载, `hc` 和 `herdr-app` 可执行, 目标窗口仍打开, `HERDR_APP_HOME` 指向正确 home.
- **显示 `Herdr names paused`**: 根据状态原因检查多实例, 终端归属, core/app 连接或文档兼容性. 归属未确认时扩展不会强行写入.
- **多个实例未被识别**: 注册是协作式的. 没有加载扩展的 OMP 不可见, print/JSON host 和内部子代理也不注册. 顶层 TUI 与 RPC host 才参与, 不能把注册表视为所有 OS 进程的完整清单.
- **快速连续改名**: 轮询可能跳过两次检查之间的中间名称. 接管依据是观察到的名称变化, 不能识别首次绑定前的历史改名, 提交相同名称, 或两次轮询间改名又恢复. 桥自身写入的目标确认不会触发接管. 公开 API 没有条件版本写入, 最后一次预检之后仍存在并发变化窗口, 不承诺事务一致性.
- **Herdr 升级后暂停**: 原始标签名读取依赖当前 app 序列化结构, 不兼容时停止同步, 不通过直接写布局绕过检查. 重启 OMP 后仍读取同一 core/tab 的接管记录; 没有记录才采用初始 OMP 优先规则.

## 开发与验证

```sh
bun test
```

单元测试覆盖名称决策, 终端关联和实例成员关系.

在安装了 Herdr, `hc` 和 OMP 的 Mac 上, 可运行隔离集成验证:

```sh
bun run verify
```

验证脚本默认使用 `/Applications/Herdr.app/Contents/MacOS/Herdr`, 可通过 `HERDR_TEST_APP` 指定其他 app 可执行文件. 脚本在 `/tmp/onb-*` 下创建独立 home, core 端点, app 配置和 OMP 会话, 只关闭自己启动的 app/core 和 OMP 进程. 它使用测试扩展调用真实标题 setter, 不发起模型请求; 脚本中的 `OPENAI_API_KEY` 是不可用于认证的固定测试占位值.

集成验证覆盖初始命名优先级, 自动标题, `/rename`, 连续标签改名, 手动接管后 OMP 改名不覆盖, 同名防回写, 多实例暂停与恢复, 空名称, 会话切换, OMP 重启和退出清理. 脚本会输出保留的临时日志路径. 协议验证通过不等于 GUI 视觉验收, 渲染效果需要另外查看真实窗口.

### 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | OMP 生命周期事件与串行定时调度 |
| `src/names.ts` | 不涉及 I/O 的名称快照, 比较基线与同步决策 |
| `src/herdr.ts` | core/app 读取, 终端归属校验和指定标签页改名 |
| `src/registry.ts` | 本地运行时注册与成员判定 |
| `src/bridge.ts` | 绑定 epoch, 写入前复核与双向同步编排 |

## 卸载

在每个已链接的 profile 中执行:

```sh
omp plugin uninstall omp-herdr-name-bridge
```

命名 profile 使用对应启动器, 例如 `omp4 plugin uninstall omp-herdr-name-bridge`. 卸载不修改 Herdr 安装包, 不主动重启任何应用; 已加载扩展的 OMP 进程退出后停止运行.
