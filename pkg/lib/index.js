// dsh-wx-bridge · DSH 插件
//
// 两件事：
//   1. 把家里的话抄一份推到微信（中继的 /push）。
//   2. 中继自己也归它管：DSH 一启动就把它拉起来，之后每 30 秒探一次，
//      挂了就重拉——不这么做，机器重启一次微信那头就静悄悄地断了。
//
// 中继源码就在本包的 relay/ 目录里，不用另装。
//
// 设置项在 DSH 的「设置 → 插件 → 配置」里（这一版起才有）。
// 环境变量仍然认，但优先级低于设置页里填的值。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-wx-bridge'
export const inject = []

const HERE = dirname(fileURLToPath(import.meta.url))
const RELAY = join(HERE, '..', 'relay', 'wx-bridge.mjs')

// ── 设置项 ───────────────────────────────────────────────────
// 没装 schemastery 也能跑：这时 Config 是 undefined，插件只读环境变量。
let Schema = null
try {
  Schema = (await import('@deepseek-ai/schemastery')).default
} catch {
  Schema = null
}

export const Config = Schema
  ? Schema.object({
    homeSession: Schema.string()
      .default('')
      .description('你和她聊天那条会话 id 里的一段（session-xxxxxxxx-… 里那串）。不填，家里说的话就不会抄到微信。'),
    wxDir: Schema.string()
      .default('')
      .description('中继的工作目录：登录态、发不出去的队列、二维码、收到的图都在这儿。留空 = ~/.dsh/wx-bridge。'),
    bridgeUrl: Schema.string()
      .default('')
      .description('中继地址。留空 = http://127.0.0.1:18123。'),
    bridgePort: Schema.natural()
      .min(1).max(65535)
      .default(18123)
      .description('中继端口（只绑 127.0.0.1）。'),
    name: Schema.string()
      .default('她')
      .description('往微信推消息时带的名字。'),
    keepaliveMs: Schema.natural()
      .min(5000).max(600000)
      .default(30000)
      .description('多久探一次中继（毫秒）。挂了就重拉。'),
    autoStart: Schema.boolean()
      .default(true)
      .description('DSH 启动时自动把中继拉起来。关掉 = 你自己起。'),
  })
  : undefined

// 运行时配置：apply 时填，导出的那几个函数共用
const rt = {
  bridgeUrl: 'http://127.0.0.1:18123',
  wxDir: join(homedir(), '.dsh', 'wx-bridge'),
  homeSession: '',
  name: '她',
  keepaliveMs: 30000,
  autoStart: true,
}

function short(e) {
  return String((e && e.message) || e || '').slice(0, 120)
}

async function relayAlive(timeout = 2500) {
  try {
    const r = await fetch(rt.bridgeUrl + '/health', { signal: AbortSignal.timeout(timeout) })
    return r.ok
  } catch {
    return false
  }
}

/** 中继没在跑就拉起来（不覆盖用户自己起的那个）。 */
function startRelay(ctx) {
  if (!existsSync(RELAY)) {
    ctx.logger?.warn?.(`dsh-wx-bridge: 包里没找到中继（${RELAY}）`)
    return
  }
  try {
    const child = spawn(process.execPath, [RELAY], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        WX_BRIDGE_DIR: rt.wxDir,
        WX_BRIDGE_PORT: String(new URL(rt.bridgeUrl).port || 18123),
      },
    })
    child.unref()
    ctx.logger?.info?.(`dsh-wx-bridge: 中继没在跑，拉起来了（pid ${child.pid}），数据在 ${rt.wxDir}`)
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
  const r = await fetch(rt.bridgeUrl + '/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  })
  return await r.json()
}

/** 要一张登录二维码，返回 { qrcode, link, imagePath }。 */
export async function wechatLoginQr() {
  const r = await fetch(rt.bridgeUrl + '/login', { method: 'POST', signal: AbortSignal.timeout(25000) })
  return await r.json()
}

/** 问扫上没有：wait / scanned / confirmed / expired。 */
export async function wechatLoginStatus(waitMs = 20000) {
  const r = await fetch(`${rt.bridgeUrl}/login/status?wait=${waitMs}`, {
    signal: AbortSignal.timeout(waitMs + 10000),
  })
  return await r.json()
}

export function apply(ctx, config) {
  const c = config || {}
  const env = process.env

  rt.homeSession = String(c.homeSession || env.WX_HOME_SESSION || '').trim()
  rt.wxDir = String(c.wxDir || env.WX_BRIDGE_DIR || '').trim() || join(homedir(), '.dsh', 'wx-bridge')
  const port = Number(c.bridgePort || env.WX_BRIDGE_PORT || 18123)
  rt.bridgeUrl = String(c.bridgeUrl || env.WX_BRIDGE_URL || '').trim() || `http://127.0.0.1:${port}`
  rt.name = String(c.name || env.WX_NAME || '她')
  rt.keepaliveMs = Number(c.keepaliveMs || env.WX_KEEPALIVE_MS || 30000)
  rt.autoStart = c.autoStart !== false

  ctx.logger?.info?.(`dsh-wx-bridge: 微信那条线归我管了（中继 ${rt.bridgeUrl}，数据 ${rt.wxDir}）`)

  if (rt.autoStart) void ensureRelay(ctx)

  // 保活：中继被系统收掉、或者自己崩了，一会儿就拉回来
  const timer = setInterval(() => {
    void relayAlive().then((ok) => {
      if (!ok) startRelay(ctx)
    })
  }, rt.keepaliveMs)
  timer.unref?.()

  if (!rt.homeSession) {
    ctx.logger?.warn?.('dsh-wx-bridge: 还没设「你和她聊天的会话」，镜像不会生效。' +
      '在 设置 → 插件 → 配置 里填会话 id 里的一段（session-xxxxxxxx-… 里那串）。')
  }

  ctx.on('session/event', (session, event) => {
    try {
      const homeId = String(session?.id || '')
      if (!rt.homeSession || !homeId.includes(rt.homeSession)) return
      if (event?.type !== 'assistant/message') return
      const content = event.data?.message?.content
      if (!Array.isArray(content)) return
      const text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
        .trim()
      if (!text) return
      void pushToWechat({ text, kind: 'reply', name: rt.name, from: 'app' }).catch((e) => {
        ctx.logger?.warn?.('dsh-wx-bridge: 推到微信失败：' + short(e))
      })
    } catch (e) {
      ctx.logger?.warn?.('dsh-wx-bridge: 镜像出错：' + short(e))
    }
  })
}
