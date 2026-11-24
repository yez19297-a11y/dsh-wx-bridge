// 看门狗：盯着 wx-bridge，掉线、卡死、崩了就拉起来。
// 手机内存紧的时候 Node 会被系统收掉，靠它接上。

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const DIR = process.env.WX_BRIDGE_DIR || '/root/.dsh/worlds/default/room/wx-bridge'
const LOCK = `${DIR}/watchdog.pid`

// 只留一个看门狗，两个会互相当成故障来打架
function alreadyRunning() {
  try {
    const pid = Number(readFileSync(LOCK, 'utf8'))
    if (!pid) return false
    process.kill(pid, 0)
    return pid !== process.pid
  } catch {
    return false
  }
}
if (alreadyRunning()) {
  console.log('已经有一个看门狗在跑，我退下')
  process.exit(0)
}
writeFileSync(LOCK, String(process.pid))
const SCRIPT = `${DIR}/wx-bridge.mjs`
const HEALTH = 'http://127.0.0.1:18123/health'
const CHECK_MS = 30000
const TIMEOUT_MS = 8000

function log(...a) {
  console.log(new Date().toISOString(), ...a)
}

let child = null

function start() {
  try {
    child = spawn(process.execPath, [SCRIPT], { cwd: DIR, stdio: 'ignore' })
    log('拉起中继 pid', child.pid)
    child.on('exit', (code, signal) => {
      log('中继退出了', code, signal)
      child = null
    })
    child.on('error', (e) => log('拉起失败', e.message))
  } catch (e) {
    log('起不来', e.message)
  }
}

async function alive() {
  try {
    const r = await fetch(HEALTH, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!r.ok) return false
    const j = await r.json()
    return j.ok === true
  } catch {
    return false
  }
}

async function check() {
  if (await alive()) return
  log('中继没应答，重来一次')
  if (child) {
    try { child.kill('SIGKILL') } catch {}
    child = null
    await new Promise((r) => setTimeout(r, 600))
  }
  start()
  await new Promise((r) => setTimeout(r, 4000))
  log((await alive()) ? '救回来了' : '还是没起来，下轮再试')
}

// 中继没在跑就先起一个，再开始盯着
if (!(await alive())) start()
else log('中继本来就在跑')

setInterval(() => { void check() }, CHECK_MS)
log('看门狗上岗，每', CHECK_MS / 1000, '秒看一眼')
