# dsh-pet-bridge

把 DeepSeek Harness 的 agent 活动状态（思考 / 干活 / 等待 / 完成 / 出错）
实时写进一个状态文件，供桌面宠物读取并切换表情与气泡。

配合 [DSH 桌宠（Live2D 版）](../DSH桌宠) 使用：鲸鱼娘会跟着 agent
的真实状态换表情，气泡里显示当前正在做什么。


## 它是怎么工作的

只监听 **一个** DSH 事件流：`session/event`。这个 feed 已经按顺序携带了
所有状态跃迁，比分散监听 `agent/status` + `tools/pre-execute` +
`agent/error` 可靠得多。

事件 → 状态映射：

| `event.type` | 条件 | 状态 |
|---|---|---|
| `turn/start` | — | `thinking` |
| `tool/call` | 工具是 `ask_user_question` | `waiting` |
| `tool/call` | 其他工具 | `working` |
| `tool/result` | — | `working` |
| `approval/asked` | — | `waiting` |
| `turn/end` | `reason.kind === 'completed'` | `done` |
| `turn/end` | `error` / `max-tokens` / `timeout` | `error` |
| `turn/end` | `blocked` | `waiting` |
| `turn/end` | 其他（aborted 等） | **清空回 `idle`** |

最后一行是关键：**回合被中断时必须清回空闲**，否则宠物会永远卡在
"工作中"。这是 `dsh-pet` 项目踩过的真实坑，这里沿用同样的处理。

写文件有两层节流（状态去重 + `minGapMs` 最小间隔），
工具连续调用不会把磁盘打爆。


## 状态文件格式

```json
{
  "title":    "DSH Agent",
  "bubble":   "正在执行 read …",
  "status":   "working",
  "progress": 0.6
}
```

`status` 取值：`idle` | `thinking` | `working` | `waiting` | `done` | `error`


## 安装

```bash
dsh plugin --profile web add file:F:\碧蓝航线blender\实验性天空\dsh-pet-bridge
```

然后**重启 `dsh web`** 使其生效。

验证是否挂上：

```bash
dsh --profile web --dump-config
```

输出末尾应该出现：

```yaml
# == dsh-pet-bridge
- id: pet-bridge
  name: dsh-pet-bridge
  config:
    statePath: '...'
```


## 配置

全部在 `cordis.patch.yml` 的 `config:` 下：

| 键 | 默认 | 说明 |
|---|---|---|
| `statePath` | （必填） | 状态文件绝对路径，桌宠读它 |
| `title` | `DSH Agent` | 气泡抬头 |
| `minGapMs` | `200` | 两次写文件的最小间隔（毫秒） |


## 依赖

- `inject: ['fs']` —— 硬依赖文件系统服务。用 `ctx.get('fs')` 可选访问
  会有静默失败的风险：插件可能在服务就绪前就被 apply，拿到 `undefined`，
  然后什么都不做且不报错。


## 许可

MIT。桌宠所用的 Live2D 模型版权另属其作者，与本插件无关。
