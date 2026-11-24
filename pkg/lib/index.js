// dsh-wx-bridge · DSH 插件（宿主半）
//
// 三件事：
//   1. 把家里的话抄一份推到微信（中继的 /push）。
//   2. 中继自己也归它管：DSH 一启动就把它拉起来，之后每 30 秒探一次，挂了就重拉。
//   3. 给设置页开一条 /api/wx-bridge 路由：状态、配置读写、申请二维码。
//
// 中继源码就在本包的 relay/ 目录里，不用另装。
//
// 配置是三处合起来的（后面的盖前面的）：
//   环境变量 → DSH 设置页里的值 → <中继目录>/config.json（设置页改的就是这个）

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-wx-bridge'
export const inject = []

const HERE = dirname(fileURLToPath(import.meta.url))
const RELAY = join(HERE, '..', 'relay', 'wx-bridge.mjs')

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

// 运行时配置
const rt = {
  bridgeUrl: 'http://127.0.0.1:18123',
  wxDir: join(homedir(), '.dsh', 'wx-bridge'),
  homeSession: '',
  name: '她',
  keepaliveMs: 30000,
  autoStart: true,
}

const DEFAULTS = {
  homeSession: '',
  wxDir: '',
  bridgeUrl: '',
  bridgePort: 18123,
  name: '她',
  keepaliveMs: 30000,
  autoStart: true,
}

function configPath() {
  return join(rt.wxDir, 'config.json')
}

function readFileConfig() {
  try {
    const p = configPath()
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf8')) || {}
  } catch {
    return {}
  }
}

function writeFileConfig(patch) {
  mkdirSync(rt.wxDir, { recursive: true })
  const cur = readFileConfig()
  const next = { ...cur, ...patch }
  writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

function applyConfig(c, env) {
  const e = env || process.env
  rt.homeSession = String(c.homeSession || e.WX_HOME_SESSION || '').trim()
  rt.wxDir = String(c.wxDir || e.WX_BRIDGE_DIR || '').trim() || join(homedir(), '.dsh', 'wx-bridge')
  const port = Number(c.bridgePort || e.WX_BRIDGE_PORT || 18123)
  rt.bridgeUrl = String(c.bridgeUrl || e.WX_BRIDGE_URL || '').trim() || `http://127.0.0.1:${port}`
  rt.name = String(c.name || e.WX_NAME || '她')
  rt.keepaliveMs = Number(c.keepaliveMs || e.WX_KEEPALIVE_MS || 30000)
  rt.autoStart = c.autoStart !== false
}

function short(e) {
  return String((e && e.message) || e || '').slice(0, 120)
}

// ── 中继 ────────────────────────────────────────────────────
async function relayHealth(timeout = 2500) {
  try {
    const r = await fetch(rt.bridgeUrl + '/health', { signal: AbortSignal.timeout(timeout) })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

function startRelay(ctx) {
  if (!existsSync(RELAY)) {
    ctx.logger?.warn?.(`dsh-wx-bridge: 包里没找到中继（${RELAY}）`)
    return
  }
  try {
    const port = new URL(rt.bridgeUrl).port || '18123'
    const child = spawn(process.execPath, [RELAY], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true, // Windows 上别弹黑窗
      env: { ...process.env, WX_BRIDGE_DIR: rt.wxDir, WX_BRIDGE_PORT: String(port) },
    })
    child.unref()
    ctx.logger?.info?.(`dsh-wx-bridge: 中继没在跑，拉起来了（pid ${child.pid}），数据在 ${rt.wxDir}`)
  } catch (e) {
    ctx.logger?.warn?.('dsh-wx-bridge: 中继拉不起来：' + short(e))
  }
}

async function ensureRelay(ctx) {
  if (await relayHealth()) {
    ctx.logger?.info?.('dsh-wx-bridge: 中继本来就在跑')
    return
  }
  startRelay(ctx)
}

// ── 给设置页用的 HTTP 路由 ───────────────────────────────────
function registerRoute(ctx) {
  let web
  try {
    web = ctx.get ? ctx.get('webServer') : undefined
  } catch {}
  web = web || ctx.webServer
  if (!web || typeof web.register !== 'function') {
    ctx.logger?.warn?.('dsh-wx-bridge: 这个宿主没有 webServer，设置页那半开不了（镜像照常工作）')
    return
  }

  const json = (res, code, obj) => {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(obj))
  }

  const dispose = web.register({
    kind: 'prefix',
    path: '/api/wx-bridge',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1')
        const p = url.pathname

        if (req.method === 'GET' && p === '/api/wx-bridge/status') {
          const h = await relayHealth()
          return json(res, 200, {
            ok: true,
            relay: h ? { alive: true, port: h.port, home: h.home } : { alive: false },
            wechat: h ? h.wechat : null,
            config: { ...rt, configFile: configPath() },
          })
        }

        if (req.method === 'GET' && p === '/api/wx-bridge/config') {
          return json(res, 200, { ok: true, config: { ...rt }, defaults: DEFAULTS, configFile: configPath() })
        }

        if (req.method === 'POST' && p === '/api/wx-bridge/config') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const saved = writeFileConfig(body)
          applyConfig({ ...DEFAULTS, ...readFileConfig(), ...saved }, process.env)
          if (rt.autoStart) void ensureRelay(ctx)
          return json(res, 200, { ok: true, config: { ...rt } })
        }

        // 申请二维码：直接跟中继要，图转成 data URI 给浏览器画
        if (req.method === 'POST' && p === '/api/wx-bridge/login') {
          const r = await fetch(rt.bridgeUrl + '/login', { method: 'POST', signal: AbortSignal.timeout(25000) })
          const j = await r.json()
          if (!j.imagePath || !existsSync(j.imagePath)) {
            return json(res, 200, { ok: false, why: '二维码出来了，但图没存下来' })
          }
          const b64 = readFileSync(j.imagePath).toString('base64')
          return json(res, 200, { ok: true, qr: 'data:image/png;base64,' + b64 })
        }

        if (req.method === 'GET' && p === '/api/wx-bridge/login/status') {
          const wait = Number(url.searchParams.get('wait') || 3000)
          const r = await fetch(`${rt.bridgeUrl}/login/status?wait=${wait}`, { signal: AbortSignal.timeout(wait + 10000) })
          const j = await r.json()
          return json(res, 200, { ok: true, status: j.status, loggedIn: !!j.loggedIn })
        }

        return json(res, 404, { ok: false, why: 'no such path' })
      } catch (e) {
        return json(res, 500, { ok: false, why: short(e) })
      }
    },
  })

  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-wx-bridge: 设置页路由')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 1024 * 1024) {
        reject(new Error('body 太大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ── 插件本体 ────────────────────────────────────────────────
export function apply(ctx, config) {
  const fileCfg = { ...DEFAULTS, ...readFileConfig() }
  const loaderCfg = config || {}
  // 设置页的值只覆盖「config.json 里没写」的那几项
  const merged = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    if (loaderCfg[k] !== undefined && loaderCfg[k] !== '' && loaderCfg[k] !== null) merged[k] = loaderCfg[k]
    if (fileCfg[k] !== undefined && fileCfg[k] !== '' && fileCfg[k] !== null) merged[k] = fileCfg[k]
  }
  applyConfig(merged, process.env)

  ctx.logger?.info?.(`dsh-wx-bridge: 微信那条线归我管了（中继 ${rt.bridgeUrl}，数据 ${rt.wxDir}）`)

  if (rt.autoStart) void ensureRelay(ctx)

  registerRoute(ctx)

  const timer = setInterval(() => {
    void relayHealth().then((h) => {
      if (!h) startRelay(ctx)
    })
  }, rt.keepaliveMs)
  timer.unref?.()

  if (!rt.homeSession) {
    ctx.logger?.warn?.('dsh-wx-bridge: 还没设「你和她聊天的会话」，镜像不会生效。在设置里填会话 id 里的一段。')
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

export async function pushToWechat(payload) {
  const r = await fetch(rt.bridgeUrl + '/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  })
  return await r.json()
}
