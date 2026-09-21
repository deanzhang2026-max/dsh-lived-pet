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

/** Event type -> pet state. `undefined` = not interesting, `null` = clear to idle. */
function reduceState(event) {
  const type = event && typeof event.type === 'string' ? event.type : ''
  const data = event && event.data && typeof event.data === 'object' ? event.data : {}

  switch (type) {
    case 'turn/start':
      return 'thinking'

    case 'tool/call': {
      const tool = typeof data.name === 'string' ? data.name : ''
      // the model is waiting on the human, not working
      if (tool === 'ask_user_question' || tool === 'ask_user') return 'waiting'
      return 'working'
    }

    case 'tool/result':
      return 'working'

    case 'approval/asked':
      return 'waiting'

    case 'turn/end': {
      const kind = data.reason && typeof data.reason.kind === 'string' ? data.reason.kind : ''
      if (kind === 'completed') return 'done'
      if (kind === 'error' || kind === 'max-tokens' || kind === 'timeout') return 'error'
      if (kind === 'blocked') return 'waiting'
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
  done: '这一轮完成了',
  error: '这一步出错了',
}

function bubbleFor(state, detail) {
  if (state === 'working') {
    return detail ? '正在执行 ' + detail + ' …' : '正在干活…'
  }
  if (state === 'done' && detail) return '完成了：' + detail
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

const PROGRESS = { idle: 0, thinking: 0.15, working: 0.6, waiting: 0.5, done: 1, error: 0.9 }

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

  ctx.on('session/event', function (session, event) {
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