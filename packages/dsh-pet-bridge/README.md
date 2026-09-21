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

| `event.type` | 条件 | 状态 | 鲸鱼娘的反应 |
|---|---|---|---|
| `turn/start` | — | `thinking` | 呆呆眼 |
| `tool/call` | `ask_user_question` | `waiting` | 问号 |
| `tool/call` | `read` `glob` `grep` `read_image` 等 | `reading` | 呆呆眼 + **自动戴眼镜** |
| `tool/call` | `write` `edit` `blender_python` | `writing` | 调皮 + **自动贴贴纸** |
| `tool/call` | `pwsh` `blender_render` `blender_export` 等 | `running` | 流汗 + 吹泡泡 |
| `tool/call` | `web_search` `web_fetch` | `searching` | 星星眼 + **自动戴眼镜** |
| `tool/call` | `subagent` `workflow` `ralph` | `delegating` | 开心兴奋 + 快速自拍 |
| `tool/call` | `todo_write` | `planning` | 感叹号 + 开盖 |
| `tool/call` | 其他任何工具 | `working` | 流汗 + 吹泡泡 |
| `tool/result` | 同一工具连续失败 2 次 | `struggling` | 脸红 + 挤番茄酱 |
| `tool/result` | 连续 3 次无错 | `proud` | 爱心眼 + 自拍 |
| *(定时)* | 单轮持续超过 90 秒 | `longtask` | 闭眼口水 |
| `approval/asked` | — | `waiting` | 问号 |
| `turn/end` | `reason.kind === 'completed'` | `done` | 开心兴奋 + 自拍 |
| `turn/end` | `error` / `max-tokens` / `timeout` | `error` | 晕晕 + 喷水 |
| `turn/end` | `blocked` | `waiting` | 问号 |
| `turn/end` | `aborted` / `interrupted` / `cancelled` | `interrupted` | 吐魂 + 喷水 |
| `turn/end` | 其他 | **清空回 `idle`** | 素颜 |

两个关键点：

1. **`tool/result` 本身不改变状态**（只更新气泡细节）。否则一个回合里
   "写文件 → 跑命令 → 写文件" 会让状态反复跌回通用的 `working`，
   表情闪个不停。
2. **回合被中断时必须释放**，这里映射到 `interrupted` 而不是硬清空 ——
   既不会永远卡在"工作中"，又能让鲸鱼娘演一下"被打断了"。

旧版桌宠（只认 6 个状态）遇到这些新状态会退回默认表情，**不会报错**，
所以桥接和桌宠可以分开升级。

写文件有两层节流（状态去重 + `minGapMs` 最小间隔），
工具连续调用不会把磁盘打爆。


## 状态文件格式

```json
{
  "title":    "DSH Agent",
  "bubble":   "正在执行 read …",
  "status":   "reading",
  "progress": 0.6
}
```

`status` 取值（16 个）：

`idle` `thinking` `waiting` `working` `reading` `writing` `running`
`searching` `delegating` `planning` `proud` `struggling` `longtask`
`done` `error` `interrupted`


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
| `longTaskMs` | `90000` | 单轮持续多久后切到 `longtask`（毫秒） |


## 依赖

- `inject: ['fs']` —— 硬依赖文件系统服务。用 `ctx.get('fs')` 可选访问
  会有静默失败的风险：插件可能在服务就绪前就被 apply，拿到 `undefined`，
  然后什么都不做且不报错。


## 许可

MIT。桌宠所用的 Live2D 模型版权另属其作者，与本插件无关。
