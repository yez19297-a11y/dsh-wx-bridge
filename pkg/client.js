/**
 * dsh-wx-bridge —— 浏览器半端：设置里的「微信桥」一页。
 *
 * 一页里四件事：
 *   ① 中继活着没有、微信登着没有；
 *   ② 你和她聊天的会话 id（不填，家里说的话就到不了微信）；
 *   ③ 中继的工作目录、端口、推送名字；
 *   ④ 申请二维码：直接在这儿刷出来，手机相册里选一张就能扫。
 *
 * 后端只走宿主的 /api/wx-bridge（宿主半那边注册的），面板不碰任何登录态。
 */
const MODULE_LOADER =
  typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function'
    ? window.__ModuleLoader__
    : (() => {
        throw new Error(
          '[dsh-wx-bridge] 需要 DSH ≥ 0.2.0-rc.2：当前宿主没有 window.__ModuleLoader__，设置页注册不上。请升级 DSH 后重试。'
        )
      })()

MODULE_LOADER.load({
  id: 'dsh-wx-bridge',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/wx-bridge'
    const TIMEOUT = 10000

    async function request(path, init = {}) {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), init.timeout || TIMEOUT)
      try {
        const r = await fetch(API + path, {
          credentials: 'same-origin',
          signal: ctrl.signal,
          ...init,
        })
        const text = await r.text()
        let data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch {
          throw new Error('宿主回的看不懂（不是 JSON）')
        }
        if (!r.ok || !data || data.ok === false) {
          throw new Error((data && (data.why || data.error)) || `请求失败（${r.status}）`)
        }
        return data
      } catch (e) {
        const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')))
        throw new Error(aborted ? '宿主没回话（超时）' : String((e && e.message) || e))
      } finally {
        clearTimeout(t)
      }
    }

    const box = {
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18))',
      borderRadius: 10,
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      background: 'var(--dsw-alias-bg2, rgba(255,255,255,.03))',
    }
    const row = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }
    const label = { fontSize: 12, opacity: 0.7, minWidth: 120 }
    const input = {
      flex: '1 1 260px',
      padding: '6px 10px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))',
      background: 'transparent',
      color: 'inherit',
      fontSize: 13,
    }
    const btn = {
      padding: '6px 14px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))',
      background: 'transparent',
      color: 'inherit',
      fontSize: 13,
      cursor: 'pointer',
    }
    const btnPrimary = { ...btn, background: '#2563eb', borderColor: '#2563eb', color: '#fff', fontWeight: 600 }
    const dot = (color) => ({
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: color,
      marginRight: 6,
    })

    function Panel() {
      const [status, setStatus] = React.useState(null)
      const [cfg, setCfg] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [err, setErr] = React.useState('')
      const [qr, setQr] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const j = await request('/status')
          setStatus(j)
          setCfg((prev) => prev || j.config)
          setErr('')
        } catch (e) {
          setErr(String(e.message || e))
        }
      }, [])

      React.useEffect(() => {
        load()
        const t = setInterval(load, 8000)
        return () => clearInterval(t)
      }, [load])

      const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }))

      const save = async () => {
        setBusy('save')
        setMsg('')
        try {
          const body = {
            homeSession: cfg.homeSession || '',
            wxDir: cfg.wxDir || '',
            bridgePort: Number(cfg.bridgePort) || 18123,
            name: cfg.name || '她',
            keepaliveMs: Number(cfg.keepaliveMs) || 30000,
            autoStart: cfg.autoStart !== false,
          }
          const j = await request('/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          setCfg(j.config)
          setMsg('存好了，中继那边已经按新配置走')
          load()
        } catch (e) {
          setErr(String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      const getQr = async () => {
        setBusy('qr')
        setMsg('')
        try {
          const j = await request('/login', { method: 'POST', timeout: 30000 })
          setQr(j.qr)
          setMsg('二维码出来了，五分钟有效：手机微信 → 扫一扫 → 右上角相册 → 选这张 → 确认')
        } catch (e) {
          setErr(String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      const wx = status && status.wechat
      const relayOk = status && status.relay && status.relay.alive

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 } },
        h('h2', { style: { fontSize: 16, fontWeight: 600, margin: 0 } }, '微信桥'),

        // 状态
        h(
          'div',
          { style: box },
          h(
            'div',
            { style: row },
            h('span', null, h('span', { style: dot(relayOk ? '#22c55e' : '#ef4444') }), '中继'),
            h('span', { style: { fontSize: 13, opacity: 0.8 } }, relayOk ? `活着（127.0.0.1:${status.relay.port || ''}）` : '没在跑'),
          ),
          h(
            'div',
            { style: row },
            h('span', null, h('span', { style: dot(wx && wx.loggedIn ? '#22c55e' : '#f59e0b') }), '微信'),
            h(
              'span',
              { style: { fontSize: 13, opacity: 0.8 } },
              wx && wx.loggedIn ? (wx.online ? '登录着，在线' : '登录着，暂时掉线') : '还没登录，先扫个码'
            ),
          ),
          h(
            'div',
            { style: row },
            h('button', { style: btn, onClick: load, disabled: !!busy }, '刷新状态'),
            h('button', { style: btnPrimary, onClick: getQr, disabled: !!busy }, busy === 'qr' ? '在要…' : '申请二维码'),
          ),
          qr
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, h('img', {
                src: qr,
                alt: '微信登录二维码',
                style: { width: 220, height: 220, imageRendering: 'pixelated', background: '#fff', borderRadius: 8, padding: 8 },
              }))
            : null,
        ),

        // 配置
        cfg
          ? h(
              'div',
              { style: box },
              h('div', { style: { fontSize: 13, fontWeight: 600 } }, '设置'),
              h(
                'div',
                { style: row },
                h('span', { style: label }, '你和她聊天的会话'),
                h('input', {
                  style: input,
                  value: cfg.homeSession || '',
                  placeholder: '会话 id 里的一段，比如 53d9ddc6',
                  onChange: (e) => set('homeSession', e.target.value),
                }),
              ),
              h(
                'div',
                { style: row },
                h('span', { style: label }, '中继工作目录'),
                h('input', {
                  style: input,
                  value: cfg.wxDir || '',
                  placeholder: '留空 = ~/.dsh/wx-bridge',
                  onChange: (e) => set('wxDir', e.target.value),
                }),
              ),
              h(
                'div',
                { style: row },
                h('span', { style: label }, '中继端口'),
                h('input', {
                  style: input,
                  value: String(cfg.bridgePort || 18123),
                  onChange: (e) => set('bridgePort', e.target.value),
                }),
              ),
              h(
                'div',
                { style: row },
                h('span', { style: label }, '推送名字'),
                h('input', {
                  style: input,
                  value: cfg.name || '她',
                  onChange: (e) => set('name', e.target.value),
                }),
              ),
              h(
                'div',
                { style: row },
                h('button', { style: btnPrimary, onClick: save, disabled: !!busy }, busy === 'save' ? '存着…' : '保存'),
                h('span', { style: { fontSize: 12, opacity: 0.6 } }, status && status.config && status.config.configFile
                  ? `存在 ${status.config.configFile}`
                  : ''),
              ),
            )
          : null,

        msg ? h('div', { style: { fontSize: 13, color: '#16a34a' } }, msg) : null,
        err ? h('div', { style: { fontSize: 13, color: '#dc2626' } }, err) : null,
      )
    }

    return {
      name: 'dsh-wx-bridge-client',
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () =>
          slots.register({ name: 'settings.section', id: 'dsh-wx-bridge', order: 40, label: '微信桥' }, Panel)
        )
      },
    }
  },
})
