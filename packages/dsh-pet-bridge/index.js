/**
 * dsh-pet-bridge — Host half
 *
 * Publishes DeepSeek Harness agent activity into a small JSON file that a
 * desktop pet polls, so the pet can show what the agent is doing right now.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE STATE FILE LIVES
 * ---------------------------------------------------------------------------
 * The bridge and the pet agree on one location, so neither needs configuring:
 *
 *     $DSH_HOME/pet_state.json          (default)
 *     ~/.dsh/pet_state.json             (when DSH_HOME is unset)
 *
 * Override order: config.statePath  ->  $DSH_PET_STATE  ->  the default above.
 * The bundled Electron pet resolves the same path the same way.
 *
 * ---------------------------------------------------------------------------
 * DESIGN NOTES (each one is a real failure already paid for)
 * ---------------------------------------------------------------------------
 * 1. Use `node:fs` directly. A profile-installed plugin CAN import Node
 *    builtins (dsh-blender does). An earlier version tried to obtain a
 *    filesystem via `ctx.inject(['fs'], cb)` and that callback was never
 *    invoked: the plugin loaded, sat there, and produced nothing, silently.
 *
 * 2. Do NOT use a top-level `export const inject = [...]` — the plugin
 *    registers but never reaches apply.
 *
 * 3. Listen to ONE stream, `session/event`. It carries every state transition
 *    in order; do not scatter listeners across agent/status +
 *    tools/pre-execute + agent/error.
 *
 * 4. `turn/end` with a non-terminal reason (aborted / interrupted / ...) MUST
 *    clear back to idle, or an interrupted turn leaves the pet stuck on
 *    "working" forever. dsh-pet documents this as a real hang they hit.
 *
 * 5. State transitions publish immediately; only detail-only refreshes are
 *    throttled. An earlier "clever" throttle with pending+schedule raced
 *    itself and silently dropped 8 of 10 events.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-pet-bridge'

/** Where the pet reads its state from, when nothing overrides it. */
export function defaultStatePath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'pet_state.json')
}

function resolveStatePath(config) {
  const fromConfig = config && typeof config.statePath === 'string' ? config.statePath.trim() : ''
  if (fromConfig) return fromConfig
  const fromEnv = process.env.DSH_PET_STATE && process.env.DSH_PET_STATE.trim()
  if (fromEnv) return fromEnv.trim()
  return defaultStatePath()
}

/**
 * Which state does a given tool put the pet in?
 *
 * The pet maps every one of these to its own face + animation, so the mascot
 * acts out what the agent is actually doing instead of wearing one generic
 * "working" face for the whole turn. Unknown tools fall back to 'working',
 * which is exactly the pre-v1.1 behaviour, so an older pet keeps working.
 */
const TOOL_STATE = {
  // reading / inspecting
  read: 'reading', glob: 'reading', grep: 'reading', read_image: 'reading',
  blender_object_info: 'reading', blender_scene_info: 'reading',
  blender_helper_catalog: 'reading',
  // writing / editing
  write: 'writing', edit: 'writing', blender_python: 'writing',
  // running a command / rendering / exporting
  pwsh: 'running', bash: 'running', blender_render: 'running',
  blender_render_frames: 'running', blender_export: 'running',
  blender_import: 'running', blender_preview: 'running',
  blender_validate_scene: 'running',
  // looking things up online
  web_search: 'searching', web_fetch: 'searching',
  // handing work to other agents
  subagent: 'delegating', subagent_fork: 'delegating',
  workflow: 'delegating', ralph: 'delegating',
  // planning
  todo_write: 'planning',
}

/** Tools that mean "the model is waiting on the human", not "working". */
const HUMAN_TOOLS = { ask_user_question: 1, ask_user: 1 }

function stateFromTool(tool) {
  if (!tool) return 'working'
  if (HUMAN_TOOLS[tool]) return 'waiting'
  return TOOL_STATE[tool] || 'working'
}

/** Event type -> pet state. `undefined` = not interesting, `null` = clear to idle. */
function reduceState(event) {
  const type = event && typeof event.type === 'string' ? event.type : ''
  const data = event && event.data && typeof event.data === 'object' ? event.data : {}

  switch (type) {
    case 'turn/start':
      return 'thinking'

    case 'tool/call':
      return stateFromTool(typeof data.name === 'string' ? data.name : '')

    case 'tool/result':
      // Deliberately NOT a state change: the pet should keep showing "writing"
      // while a turn writes file after file. Returning undefined leaves the
      // last state in place instead of flapping back to generic 'working'.
      return undefined

    case 'approval/asked':
      return 'waiting'

    case 'turn/end': {
      const kind = data.reason && typeof data.reason.kind === 'string' ? data.reason.kind : ''
      if (kind === 'completed') return 'done'
      if (kind === 'error' || kind === 'max-tokens' || kind === 'timeout') return 'error'
      if (kind === 'blocked') return 'waiting'
      // an abort/interrupt must release the pet, or it sits on 'working' forever
      if (kind === 'aborted' || kind === 'interrupted' || kind === 'cancelled') return 'interrupted'
      return null
    }

    default:
      return undefined
  }
}

const BUBBLE = {
  idle: '待命中，随时叫我',
  thinking: '收到消息，正在思考…',
  waiting: '在等你回答 / 确认',
  working: '正在干活…',
  done: '这一轮完成了',
  error: '这一步出错了',
  interrupted: '被打断了',
  reading: '正在看代码 / 资料…',
  writing: '正在改文件…',
  running: '正在跑命令 / 渲染…',
  searching: '正在联网查资料…',
  delegating: '正在派子代理…',
  planning: '正在列计划…',
}

function bubbleFor(state, detail) {
  if (detail) {
    if (state === 'done') return '完成了：' + detail
    if (state === 'error') return '出错了：' + detail
    if (state === 'working' || state === 'reading' || state === 'writing' ||
        state === 'running' || state === 'searching' || state === 'delegating' ||
        state === 'planning') {
      return '正在执行 ' + detail + ' …'
    }
  }
  return BUBBLE[state] || '…'
}

/** Pull a short human-readable detail out of the event, when one exists. */
function detailOf(event) {
  const data = event && event.data && typeof event.data === 'object' ? event.data : {}

  if (event && event.type === 'tool/call') {
    const tool = typeof data.name === 'string' ? data.name : ''
    if (tool) {
      const args = data.arguments
      if (args && typeof args === 'object') {
        const p = args.file_path || args.path || args.description || args.command
        if (typeof p === 'string' && p.length > 0) {
          const short = p.length > 44 ? p.slice(0, 41) + '…' : p
          return tool + ' ' + short
        }
      }
      return tool
    }
  }

  if (event && event.type === 'todo/write' && Array.isArray(data.todos)) {
    const current = data.todos.find(function (t) { return t && t.status === 'in_progress' })
      || data.todos.find(function (t) { return t && t.status === 'pending' })
    if (current && typeof current.content === 'string' && current.content.trim()) {
      return current.content.trim()
    }
  }

  return ''
}

const PROGRESS = {
  idle: 0, thinking: 0.15, waiting: 0.5, working: 0.6, done: 1, error: 0.9,
  reading: 0.6, writing: 0.6, running: 0.6, searching: 0.6, delegating: 0.6,
  planning: 0.6, interrupted: 0.3,
}

export function apply(ctx, config) {
  const statePath = resolveStatePath(config)
  const minGapMs = (config && config.minGapMs) || 200
  const title = (config && config.title) || 'DSH Agent'

  let ready = false
  try {
    const dir = dirname(statePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    ready = true
  } catch (e) {
    ready = false
  }

  let lastState = null
  let lastDetail = ''
  let lastWriteAt = 0
  let busySince = 0       // when the current stretch of tool work began
  let longTaskFired = false
  let okStreak = 0        // clean tool results in a row
  let failStreak = 0      // consecutive failures on the same tool
  let lastToolName = ''
  let celebrated = false  // don't re-fire "proud" until the streak resets

  function writeNow(state, detail) {
    if (!ready) return
    const payload = JSON.stringify({
      title: title,
      bubble: bubbleFor(state, detail),
      status: state,
      progress: PROGRESS[state] !== undefined ? PROGRESS[state] : 0,
    })
    try {
      writeFileSync(statePath, payload, 'utf8')
    } catch (e) {
      // best effort: a bad path must never break the agent loop
    }
  }

  function setState(state, detail) {
    const stateChanged = state !== lastState
    const detailChanged = detail !== lastDetail
    if (!stateChanged && !detailChanged) return
    // state transitions always publish; only detail refreshes are throttled
    if (!stateChanged && (Date.now() - lastWriteAt) < minGapMs) return

    lastState = state
    lastDetail = detail
    lastWriteAt = Date.now()
    writeNow(state, detail)
  }

  // A single turn can grind for minutes. The pet shows a sleepy face for that,
  // which is friendlier than an endless "working" stare. Poll at 1s so the
  // switch lands close to the threshold instead of up to a poll-interval late.
  const LONG_TASK_MS = (config && config.longTaskMs) || 90000
  const longTaskTimer = setInterval(function () {
    if (longTaskFired || !busySince) return
    if (Date.now() - busySince < LONG_TASK_MS) return
    longTaskFired = true
    setState('longtask', '')
  }, 1000)
  // never hold the host process open just for this
  if (longTaskTimer && typeof longTaskTimer.unref === 'function') longTaskTimer.unref()

  ctx.on('session/event', function (session, event) {
    const type = event && typeof event.type === 'string' ? event.type : ''
    const data = event && event.data && typeof event.data === 'object' ? event.data : {}

    // ---- streaks that need memory across events ----
    if (type === 'tool/call') {
      const tool = typeof data.name === 'string' ? data.name : ''
      if (tool !== lastToolName) { failStreak = 0; lastToolName = tool }
      if (!busySince) { busySince = Date.now(); longTaskFired = false }
    }

    if (type === 'tool/result') {
      const failed = data.isError === true || data.error != null || data.ok === false
      if (failed) {
        failStreak++
        okStreak = 0
        celebrated = false
        if (failStreak >= 2) {
          // same tool keeps failing -> the pet wipes its brow
          setState('struggling', lastDetail)
          return
        }
      } else {
        failStreak = 0
        okStreak++
        if (okStreak >= 3 && !celebrated && lastState !== 'done' && lastState !== 'error') {
          celebrated = true
          setState('proud', lastDetail)
          return
        }
      }
    }

    if (type === 'turn/end') {
      busySince = 0
      longTaskFired = false
      okStreak = 0
      failStreak = 0
      celebrated = false
    }

    const next = reduceState(event)
    if (next === undefined) {
      const d = detailOf(event)
      if (d && lastState) setState(lastState, d)
      return
    }
    if (next === null) { setState('idle', ''); return }
    setState(next, detailOf(event))
  })

  // publish idle on load so the pet never shows a stale state from last run
  setState('idle', '')
}