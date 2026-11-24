// dsh-wx-bridge · DSH 插件
//
// 两件事：
//   1. 把微信和家里接起来。微信进来的一句送进会话（走 dsh-world 的 bridge）；
//      家里说出去的每一句抄一份推到中继，由中继发到微信。
//   2. DSH 启动时顺手把中继带起来——不这么做，机器重启一次微信那头就静悄悄地断了。
//
// 中继本体在 src/wx-bridge.mjs（这个包的兄弟仓库），靠环境变量找：
//   WX_BRIDGE_URL      中继地址，默认 http://127.0.0.1:18123
//   WX_BRIDGE_DIR      中继工作目录，里面有 wx-bridge.mjs 和看到的登录态
//   WX_HOME_SESSION    你和她聊天那条会话 id 里的一段（不填就镜像不到）
//   WX_NAME            往微信推的时候带的名字，默认「她」

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-wx-bridge'
export const inject = []

const BRIDGE = process.env.WX_BRIDGE_URL || 'http://127.0.0.1:18123'
const WX_DIR = process.env.WX_BRIDGE_DIR || join(process.env.HOME || '/root', '.dsh/worlds/default/room/wx-bridge')
const HOME_SESSION = process.env.WX_HOME_SESSION || ''
const WX_NAME = process.env.WX_NAME || '她'

function short(e) {
  return String((e && e.message) || e || '').slice(0, 120)
}

async function bridgeAlive(timeout = 2500) {
  try {
    const r = await fetch(BRIDGE + '/health', { signal: AbortSignal.timeout(timeout) })
    return r.ok
  } catch {
    return false
  }
}

// DSH 一启动就把中继也带起来：没在跑就把看门狗放出去。
// 看门狗会一直看着它，杀了重拉，比在这里起一个裸进程稳。
async function ensureBridge(ctx) {
  if (await bridgeAlive()) {
    ctx.logger?.info?.('dsh-wx-bridge: 中继本来就在跑')
    return
  }
  const watchdog = process.env.WX_WATCHDOG || join(WX_DIR, 'watchdog.mjs')
  if (!existsSync(watchdog)) {
    ctx.logger?.warn?.(`dsh-wx-bridge: 中继没在跑，也没找到看门狗（${watchdog}）。` +
      '把 WX_BRIDGE_DIR 指到中继的目录，或者手动起一下 src/wx-bridge.mjs。')
    return
  }
  try {
    spawn(process.execPath, [watchdog], { detached: true, stdio: 'ignore' }).unref()
    ctx.logger?.info?.('dsh-wx-bridge: 中继没在跑，已经把看门狗放出去了')
  } catch (e) {
    ctx.logger?.warn?.('dsh-wx-bridge: 看门狗放不出去：' + short(e))
  }
}

/** 把一句话推到微信。中继会把推送排队，微信那边掉线也不丢。 */
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
  ctx.logger?.info?.('dsh-wx-bridge: 家里说的话会抄一份到微信')
  void ensureBridge(ctx)

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
      // 别把带图/文件的整轮再推一遍，那些走别的路
      void pushToWechat({ text, kind: 'reply', name: WX_NAME, from: 'app' }).catch((e) => {
        ctx.logger?.warn?.('dsh-wx-bridge: 推到微信失败：' + short(e))
      })
    } catch (e) {
      ctx.logger?.warn?.('dsh-wx-bridge: 镜像出错：' + short(e))
    }
  })
}
