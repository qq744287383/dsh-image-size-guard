# dsh-image-size-guard

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。在请求超出网关请求体上限之前，把历史里最旧的图片替换成占位文本——一次替换一批，把请求压到上限之下的低水位，让后面几轮不必再改写历史。

为 `agent2api` 网关而写：它的 16 MiB 请求体上限会在图片累积到一定程度后直接拒绝整个会话。一旦到了那一步，会话再也发不出任何请求，而 Harness 自身不会恢复——适配器自带的图片预算默认 20 MiB，永远触发不了；网关的 413 又被归类成不可重试的 `INVALID_REQUEST`，于是会话就卡死了。

## 它做什么

每次模型请求都携带整段历史，历史里的每张图片又会被重新编码进每一个请求体。所以对话越长请求越大，最终没有任何请求装得下。

当某个受保护供应商的请求会超预算时，本插件：

1. 测量请求体——用的是适配器自己缓存的请求版本，所以量到的是真正会发出去的图片字节；
2. 算出最旧的图片要拿掉几张：按最近每轮的增长量定一个低于上限的目标水位，一次拿够，同时保留最近几轮的图片；
3. 用一次终止失败结束本轮尝试，由 agent loop 重试；
4. 重试时从 session surface 重建请求，此时 surface 已带上省略标记——于是下一次测量的是真正变小了的请求体。

### 为什么是批量，而不是最小化

每省略一张图，都会改写一条历史消息；而供应商的前缀缓存按最长公共前缀命中——所以每省略一张，从那张图往后全部作废。一次只拿一张，就意味着下一轮又顶到上限、**每一轮都在重建缓存**：省下了图片，却付出了最贵的缓存代价。

改成一次拿一批，同样的删除总量，代价变成几轮才付一次。10 MiB 上限下，八轮各一张 1 MiB 截图，现在一次拿掉 6 张、落到约 2.7 MiB，换来约五轮安静；最小化策略只拿 1 张、停在 9.3 MiB，下一轮立刻再触发。

三个参数决定批量的大小：

- `targetTurns`（默认 `5`）——一次删除预计要买下多少轮的增长。
- `minFillPercent`（默认 `40`）——下限：无论增长估算多夸张，一批删除后都不会把请求压到这个预算比例之下。
- `protectedTurns`（默认 `2`）——最近几轮的图片保留；只有当请求不删就必然会超上限时，才会动它们。

本来就装得下的请求不会被修剪，哪怕它已经高于目标水位。

### 在对话里看见它

省略本身在会话记录里不留痕迹：会话仍然保存着原图，聊天界面照常渲染，只有模型收到的是路径。现在，凡是发生过省略的那一轮，末尾会多出一枚很轻的标签：

> ⤿ 图片体积守卫 · 本轮请求超出预算，3 张历史图片改为占位文本发送 · 23:41

这一行读自持久化的 `image/offload` 事件——它本来就在会话视图已加载的事件窗口里。时间取自决策发生的本地时间：当天显示 `HH:MM`，更早显示 `M-D HH:MM`，这样翻回历史的轮次不会看起来像是刚刚发生。提示挂在**触发省略的那一轮**，而不是丢掉图片的那条消息上：消息装饰位只拿得到消息的 `source`，而轮次尾部能拿到 `Turn` 和它的结束序号。最前面一段就是本插件的名字，别人拿到分享出去的会话记录时也能知道来源。涉及消息数在悬停提示里。若某一轮的事件已经不在已加载的窗口内，则不显示——往回滚动加载更多历史即可。

`node scripts/preview-turn-notice.mjs` 会生成 `preview/turn-notice.html`，用 bundle 里的真实 CSS 在明暗两套主题下展示这枚标签。

## 安装

```sh
dsh plugin --profile web add dsh-image-size-guard
```

目前还没发布到 npm，从仓库克隆安装：

```sh
git clone https://github.com/qq744287383/dsh-image-size-guard
dsh plugin --profile web add ./dsh-image-size-guard
```

安装后 bundle 会插入 Host 行和设置页。首次安装后重启一次 Harness，浏览器才能加载到新的客户端模块。

## 使用

打开 **设置 → 图片体积守卫**。页面按供应商列出限制行，支持添加、编辑、移除和启用/关闭。

| 字段 | 含义 |
| --- | --- |
| 供应商 | 供应商路由名，例如 `agent2api` |
| 请求上限（MiB） | 该供应商接受的请求体最大值，可填小数（如 `10.5`） |
| 预留空间（KiB） | 在上限之下留出的余量 |
| 占位大小（字节） | 一张图片被省略后，估算占用的字节数 |
| 启用 | 是否对该供应商生效 |

每行右侧有一个开关。翻转它只会改动 `enabled` 并保存，上限不必重填；关闭后该供应商立刻不再受保护，请求原样放行。整行也会变暗，关闭的供应商一眼可辨。这个开关是真正的 `role="switch"` 按钮，所以回车和空格都能操作，读屏软件也能读出状态。

每个数字都按字段名标注的单位填写，不需要自己换算：默认行显示为 `16` / `256` / `512`。存储的始终是精确字节数，面板在打开和保存时做换算。

页面还会列出 LLM 注册表里已声明、但还没有配置行的供应商，点一下就能带出名字，不用手打。

保存通过 `configEditor.edit` 写入 profile 补丁层，用本插件自己的 `Config` 校验并让 Loader 重新协调。因此守卫和面板读的是同一份数据，保存后无需重启 Harness 即可生效。允许移除最后一行——那表示不保护任何供应商。

面板请求 `POST /image-size-guard/limits`，Host 端每个请求都经 `connection.admit` 准入，因此享有与 API 其余部分相同的 Host/Origin 校验和浏览器会话。

## 配置

面板编辑的就是这一行；下面的 YAML 是它的文件形式。

```yaml
- insert:
    - id: image-size-guard
      name: 'dsh-image-size-guard'
      config:
        providers:
          - provider: agent2api
            maxRequestBytes: 16777216
            reserveBytes: 262144
            placeholderBytes: 512
            targetTurns: 5
            minFillPercent: 40
            protectedTurns: 2
            growthWindow: 8
            enabled: true
```

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `providers` | 一行 `agent2api` | 供应商限制行。省略该字段即取此默认值；显式空数组表示不保护任何供应商 |
| `providers[].provider` | — | 供应商路由名 |
| `providers[].maxRequestBytes` | `16777216`（16 MiB） | 网关的请求体上限 |
| `providers[].reserveBytes` | `262144`（256 KiB） | 在上限之下留出的余量 |
| `providers[].placeholderBytes` | `512` | 一个占位块估算占用的字节数 |
| `providers[].targetTurns` | `5` | 一次批量删除预计买下多少轮的增长；`0` 关闭批量，退回最小化策略 |
| `providers[].minFillPercent` | `40` | 一批删除后至少保留的预算比例（百分比） |
| `providers[].protectedTurns` | `2` | 最近几轮的图片不主动删除；`0` 表示不保护 |
| `providers[].growthWindow` | `8` | 用最近几轮估算每轮增长 |
| `providers[].enabled` | `true` | 是否对该供应商生效 |

判定用的预算是 `maxRequestBytes - reserveBytes`。之所以要预留，是因为估算建模的是 JSON 请求体，而供应商封装层和 HTTP 头在这个接缝上不可见。

## 两条执行路径

省略动作会写成持久的 `image/offload` 记录。实现它的代码可以有两份，插件在启动时二选一：

| 已挂载的执行器 | 谁写记录 | 本轮以什么信号结束 |
| --- | --- | --- |
| `@deepseek-ai/dsh-compaction-image-offload` | 官方执行器 | `IMAGE_OFFLOAD_REQUIRED` |
| 无 | 本插件 | `REQUEST_TOO_LARGE` |

官方执行器本来就在监听 `IMAGE_OFFLOAD_REQUIRED`，所以它在的时候插件只负责*请求*：yield 一个带该 code 和正数 `offloadImages` 的 finish 块，由执行器写记录并返回重试动作。这样选择逻辑和它的投影只有一份实现，官方格式变化时自动跟随。

执行器不在时，插件退回自己的记录写入器和自己的 `REQUEST_TOO_LARGE` 重试，因此没有那个 bundle 的 profile 依然能用。判断依据是已注册的 `image/offload` 投影——执行器挂载时会贡献它。

**信号是 yield 出去的，不是 throw 出去的。** 从 `llm/stream` 监听器抛出的异常会穿出 `llm.stream()`，agent loop 在 `agent/request-error` waterfall 运行之前就把它重新抛出，执行器根本收不到。带错误原因的 `finish` 块才能到达那个 waterfall；适配器自己也是把抛出的 `IMAGE_OFFLOAD_REQUIRED` 转成同样的块。

## 为什么省略是持久的

选择会记成 Session 自己的 `image/offload` 事件，因此能扛过 resume、fork 和 compaction，token 计量和 GUI 也看得到。模型看到的是适配器标准的“图片已省略”句柄，其中写明了附件身份和恢复路径。

只有当官方 bundle 尚未注册该投影时，插件才会贡献自己的 `image/offload` 投影；它的定义与该包逐字节兼容，所以两者可以共存，任一方写下的会话日志在双方都能恢复。

## 限制

- **纯文本**就超出预算的请求会原样发出，只记一条警告。此时已无图片可拿，阻断这一轮比让网关决定更糟。
- 估算覆盖 `system`、`messages` 和 `tools`。该集合之外的适配器专有字段由预留量兜底，不参与测量。
- 只拿图片。工具结果、推理块和文本永不改动。
- 守卫在请求离开进程之前生效。若网关因为估算看不到的东西（压缩后体积、头部限制）拒绝，那不在它能防的范围内。

## 卸载

```sh
dsh plugin --profile web remove dsh-image-size-guard
```

已经含有 `image/offload` 事件的会话日志仍能重放：该投影由官方 `@deepseek-ai/dsh-compaction-image-offload` bundle 持有，而没有该 bundle 的 profile 只有在插件安装期间才由本插件兜底。若你从一个两者都没有的 profile 中移除本插件，请先恢复官方 bundle 再恢复这些会话。

## 开发

无构建步骤、无依赖：Host 端是纯 ESM，Client 端是普通浏览器模块。

```sh
for test in test/*.test.mjs; do node "$test"; done
```

- `estimate` —— 请求体测量、按轮增长估算目标水位、以及批量省略的取舍逻辑。
- `config` —— 限制的 schema、默认值和全部拒绝分支。
- `offload` —— 持久的 `image/offload` 投影与选择顺序。
- `plugin` —— 守卫接线：放行、省略、重试、失败路径。
- `deference` —— 两条执行路径：交给官方执行器，或自己完成。
- `rpc` —— 面板端点：准入、方法、增删查、拒绝。
- `mount` —— 承载服务晚就绪时，端点依然会挂上。
- `save-path` —— 保存的行能通过 Loader 自身的校验。
- `client` —— 浏览器 bundle 的导出与 slot 注册。
- `client.render` —— 面板真实的元素树、文案和表单行为。
- `switch` —— 点击行内开关会向 Host 请求取反后的状态。
- `toggle` —— 该开关经 Host 往返并真正持久化。

目录结构：

```
lib/index.js      守卫：测量、发信号、重试接线
lib/estimate.js   请求体测量、按轮增长定水位与批量取舍
lib/config.js     限制 schema、默认值、预算运算
lib/offload.js    image/offload 投影与选择（兜底路径）
lib/rpc.js        设置面板端点
client/client.js  设置页
locale/{en,zh}.json
```

## 许可

MIT
