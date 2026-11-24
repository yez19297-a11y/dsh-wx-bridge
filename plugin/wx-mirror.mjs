// 把我在 App 里说的话，顺手抄一份推到微信。
//
// dsh-world 的桥只管「从微信进来的那句话」的回复，App 里的对话它不管，
// 所以微信那头看不到我在这边说的话。这个小插件补上那一半：
// 家里这条会话每说完一句，就 POST 一份到 wx-bridge，由它发到微信。
//
// 重复的问题交给 wx-bridge 去重（15 秒内同一句话只发一次）。

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'wx-mirror'
export const inject = []

const WX_DIR = process.env.WX_BRIDGE_DIR || '/root/.dsh/worlds/default/room/wx-bridge'
const PUSH = (process.env.WX_BRIDGE_URL || 'http://127.0.0.1:18123') + '/push'
// 你和她聊天那个会话的 id 里的一段（session-xxxxxxxx-… 里那串）
const HOME_SESSION = process.env.WX_HOME_SESSION || '53d9ddc6'
const WATCHDOG = process.env.WX_WATCHDOG || join(WX_DIR, 'watchdog.mjs')
const DEBUG = process.env.WX_DEBUG_LOG || join(WX_DIR, 'mirror-debug.log')

// DSH 一启动就把微信那条线也带起来：中继没在跑就交给看门狗，
// 不然手机重启一次，微信那边就静悄悄地断了。
async function ensureBridge(ctx) {
  try {
    const r = await fetch((process.env.WX_BRIDGE_URL || 'http://127.0.0.1:18123') + '/health', { signal: AbortSignal.timeout(2500) })
    if (r.ok) {
      ctx.logger?.info?.('wx-mirror: 中继本来就在跑')
      return
    }
  } catch {}
  try {
    spawn(process.execPath, [WATCHDOG], { detached: true, stdio: 'ignore' }).unref()
    ctx.logger?.info?.('wx-mirror: 中继没在跑，已经把看门狗放出去了')
  } catch (e) {
    ctx.logger?.warn?.('wx-mirror: 看门狗放不出去：' + e.message)
  }
}

export function apply(ctx) {
  ctx.logger?.info?.('wx-mirror: 家里说的话会抄一份到微信')
  void ensureBridge(ctx)
  ctx.on('session/event', (session, event) => {
    try {
      const t = String(event?.type || '')
      if (t === 'assistant/message' || t === 'user/message' || t.startsWith('turn/')) {
        const kinds = Array.isArray(event?.data?.message?.content)
          ? event.data.message.content.map((b) => b?.type).join(',')
          : ''
        appendFileSync(DEBUG, `${new Date().toISOString()} ${t} sid=${String(session?.id)} blocks=${kinds}\n`)
      }
    } catch {}
    try {
      // 家会话的 id 长这样：session-53d9ddc6-4f7d-4cb7-9fab-1784cdea01c3
      // 以前写的是 startsWith('53d9ddc6')，可它前面还挂着 session- 和后面的尾号，
      // 于是一次都没命中过，App 里说的话从来没到过微信。改成包含匹配。
      const homeId = String(session?.id || '')
      if (!homeId.includes(HOME_SESSION)) return
      if (event?.type !== 'assistant/message') return
      const content = event.data?.message?.content
      if (!Array.isArray(content)) return
      const text = content
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (!text) return
      void fetch(PUSH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, kind: 'reply', name: process.env.WX_NAME || '溯', from: 'app' }),
        signal: AbortSignal.timeout(4000),
      }).catch(() => {})
    } catch {}
  })
}
