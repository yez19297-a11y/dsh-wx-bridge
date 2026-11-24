// dsh-wx-bridge · DSH 插件
//
// 两件事：
//   1. 把家里的话抄一份推到微信（中继的 /push）。
//   2. 中继自己也归它管：DSH 一启动就把它拉起来，之后每 30 秒探一次，
//      挂了就重拉——不这么做，机器重启一次微信那头就静悄悄地断了。
//
// 中继源码就在本包的 relay/ 目录里，不用另装。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-wx-bridge'
export const inject = []

const HERE = dirname(fileURLToPath(import.meta.url))
const RELAY = join(HERE, '..', 'relay', 'wx-bridge.mjs')

const BRIDGE = process.env.WX_BRIDGE_URL || 'http://127.0.0.1:18123'
// 中继的工作目录：登录态、队列、二维码、收到的图都在这儿。
// 默认放在 ~/.dsh/wx-bridge，不跟任何房间目录搅在一起。
const WX_DIR = process.env.WX_BRIDGE_DIR || join(homedir(), '.dsh', 'wx-bridge')
const HOME_SESSION = process.env.WX_HOME_SESSION || ''
const WX_NAME = process.env.WX_NAME || '她'
const KEEPALIVE_MS = Number(process.env.WX_KEEPALIVE_MS || 30000)

function short(e) {
  return String((e && e.message) || e || '').slice(0, 120)
}

async function relayAlive(timeout = 2500) {
  try {
    const r = await fetch(BRIDGE + '/health', { signal: AbortSignal.timeout(timeout) })
    return r.ok
  } catch {
    return false
  }
}

/** 中继没在跑就把拉起来（不覆盖用户自己起的那个）。 */
function startRelay(ctx) {
  if (!existsSync(RELAY)) {
    ctx.logger?.warn?.(`dsh-wx-bridge: 包里没找到中继（${RELAY}）`)
    return
  }
  try {
    const child = spawn(process.execPath, [RELAY], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, WX_BRIDGE_DIR: WX_DIR },
    })
    child.unref()
    ctx.logger?.info?.(`dsh-wx-bridge: 中继没在跑，拉起来了（pid ${child.pid}），数据在 ${WX_DIR}`)
  } catch (e) {
    ctx.logger?.warn?.('dsh-wx-bridge: 中继拉不起来：' + short(e))
  }
}

async function ensureRelay(ctx) {
  if (await relayAlive()) {
    ctx.logger?.info?.('dsh-wx-bridge: 中继本来就在跑')
    return
  }
  startRelay(ctx)
}

/** 把一句话推到微信。中继会把没发出去的排队，掉线也不丢。 */
export async function pushToWechat(payload) {
  const r = await fetch(BRIDGE + '/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  })
  return await r.json()
}

/** 要一张登录二维码，返回 { qrcode, link, imagePath }。 */
export async function wechatLoginQr() {
  const r = await fetch(BRIDGE + '/login', { method: 'POST', signal: AbortSignal.timeout(25000) })
  return await r.json()
}

/** 问扫上没有：wait / scanned / confirmed / expired。 */
export async function wechatLoginStatus(waitMs = 20000) {
  const r = await fetch(`${BRIDGE}/login/status?wait=${waitMs}`, { signal: AbortSignal.timeout(waitMs + 10000) })
  return await r.json()
}

export function apply(ctx) {
  ctx.logger?.info?.('dsh-wx-bridge: 微信那条线归我管了')
  void ensureRelay(ctx)

  // 保活：中继被系统收掉、或者自己崩了，30 秒内拉回来
  const timer = setInterval(() => {
    void relayAlive().then((ok) => {
      if (!ok) startRelay(ctx)
    })
  }, KEEPALIVE_MS)
  timer.unref?.()

  if (!HOME_SESSION) {
    ctx.logger?.warn?.('dsh-wx-bridge: 还没设 WX_HOME_SESSION，镜像不会生效。' +
      '把它设成你和她聊天那条会话 id 里的一段（session-xxxxxxxx-… 里那串）。')
  }

  ctx.on('session/event', (session, event) => {
    try {
      const homeId = String(session?.id || '')
      if (!HOME_SESSION || !homeId.includes(HOME_SESSION)) return
      if (event?.type !== 'assistant/message') return
      const content = event.data?.message?.content
      if (!Array.isArray(content)) return
      const text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
        .trim()
      if (!text) return
      void pushToWechat({ text, kind: 'reply', name: WX_NAME, from: 'app' }).catch((e) => {
        ctx.logger?.warn?.('dsh-wx-bridge: 推到微信失败：' + short(e))
      })
    } catch (e) {
      ctx.logger?.warn?.('dsh-wx-bridge: 镜像出错：' + short(e))
    }
  })
}
