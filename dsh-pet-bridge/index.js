/**
 * dsh-pet-bridge — Host half
 *
 * Bridges DeepSeek Harness agent activity into a Live2D desktop pet by writing
 * a small JSON state file that the pet polls.
 *
 * ---------------------------------------------------------------------------
 * DESIGN NOTES (each one is a real failure we already paid for)
 * ---------------------------------------------------------------------------
 * 1. Use `node:fs` directly. A real (profile-installed) plugin CAN import Node
 *    builtins — dsh-blender does exactly this. The earlier version tried to get
 *    a filesystem through `ctx.inject(['fs'], cb)`, and that callback was never
 *    invoked: the plugin loaded, sat there, and produced nothing, silently.
 *
 * 2. Do NOT use a top-level `export const inject = [...]`. It also results in
 *    the plugin registering but never reaching apply.
 *
 * 3. Listen to ONE stream, `session/event`. It already carries every state
 *    transition in order; do not scatter listeners across agent/status +
 *    tools/pre-execute + agent/error.
 *
 * 4. `turn/end` with a non-terminal reason (aborted / interrupted / ...) MUST
 *    clear back to idle, or an interrupted turn leaves the pet stuck on
 *    "working" forever. dsh-pet documents this as a real hang they hit.
 *
 * 5. State transitions publish immediately; only detail-only refreshes are
 *    throttled. An earlier "clever" throttle with pending+schedule raced itself
 *    and silently dropped 8 of 10 events.
 *
 * 6. Writes are best-effort and always swallowed: a broken path must never pass
 *    an exception into the agent loop.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'dsh-pet-bridge'

/** Event type -> pet state. `undefined` = not interesting, `null` = clear to idle. */
function reduceState(event) {
  const type = event && typeof event.type === 'string' ? event.type : ''
  const data = event && event.data && typeof event.data === 'object' ? event.data : {}

  switch (type) {
    case 'turn/start':
      return 'thinking'

    case 'tool/call': {
      const tool = typeof data.name === 'string' ? data.name : ''
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

function bubbleFor(state, detail) {
  switch (state) {
    case 'thinking': return '收到消息，正在思考…'
    case 'working':  return detail ? '正在执行 ' + detail + ' …' : '正在干活…'
    case 'waiting':  return '在等你回答 / 确认'
    case 'done':     return detail ? '完成了：' + detail : '这一轮完成了'
    case 'error':    return '这一步出错了'
    case 'idle':     return '待命中，随时叫我'
    default:         return '…'
  }
}

function detailOf(event) {
  const data = event && event.data && typeof event.data === 'object' ? event.data : {}

  if (event && event.type === 'tool/call') {
    const tool = typeof data.name === 'string' ? data.name : ''
    if (tool) {
      const args = data.arguments
      if (args && typeof args === 'object') {
        const p = args.file_path || args.path || args.command || args.description
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
  const statePath = (config && config.statePath) || ''
  const minGapMs = (config && config.minGapMs) || 200
  const title = (config && config.title) || 'DSH Agent'

  if (!statePath) {
    // nothing to publish to; stay quiet rather than throwing into the loader
    return
  }

  let lastState = null
  let lastDetail = ''
  let lastWriteAt = 0
  let ready = false

  try {
    const dir = dirname(statePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    ready = true
  } catch (e) {
    ready = false
  }

  function writeNow(state, detail) {
    if (!ready) return
    const payload = JSON.stringify({
      title: title,
      bubble: bubbleFor(state, detail),
      status: state,
      progress: PROGRESS[state] !== undefined ? PROGRESS[state] : 0
    })
    try {
      writeFileSync(statePath, payload, 'utf8')
    } catch (e) {
      // best effort: never let a bad path break the agent loop
    }
  }

  function setState(state, detail) {
    const stateChanged = state !== lastState
    const detailChanged = detail !== lastDetail
    if (!stateChanged && !detailChanged) return
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

  // publish idle on load so the pet never shows a stale state
  setState('idle', '')
}