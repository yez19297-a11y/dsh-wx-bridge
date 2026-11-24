# dsh-wx-bridge

把你的**个人微信**接到 [DSH](https://github.com/deepseek-ai/deepseek-harness) 上。
微信里说的话进到家里那条会话；她在家里说的话（连闹钟把她叫起来时嘟囔的那句）抄一份回到微信。

这是**插件那一半**。另一半是中继本体（`wx-bridge`），负责跟微信的官方接口打交道：
扫码登录、收消息、发文字/图/文件。两个合起来才是一条完整的线。

## 装

在 DSH 的插件页贴这条地址，或者命令行：

```sh
dsh plugin --profile web add https://github.com/yez19297-a11y/dsh-wx-bridge/releases/latest/download/dsh-wx-bridge-latest.tgz
```

（桌面版把 `web` 换成 `desktop`。）

装完重启一次 DSH。

## 配

靠环境变量找中继，装之前先把中继跑起来（见下面「中继」）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WX_BRIDGE_URL` | `http://127.0.0.1:18123` | 中继在哪 |
| `WX_BRIDGE_DIR` | `~/.dsh/worlds/default/room/wx-bridge` | 中继的工作目录（里面有 `watchdog.mjs`） |
| `WX_HOME_SESSION` | 空 | **你和她聊天那条会话 id 里的一段**（`session-xxxxxxxx-…` 里那串）。不填就镜像不到 |
| `WX_WATCHDOG` | `<WX_BRIDGE_DIR>/watchdog.mjs` | 中继没在跑时拉它起来 |
| `WX_NAME` | `她` | 推到微信时带的名字 |

`WX_HOME_SESSION` 怎么找：在 DSH 里正常跟她聊两句，看会话 id，取中间那串十六进制。

## 它做了什么

1. **DSH 启动时**探一下中继：活着就不动；没活着就把看门狗放出去，由它把中继拉起来、一直看着。
2. **监听会话事件**：主会话里每出现一条助手消息，就把文字推到中继 → 微信。
   中继自己做去重（15 秒内同一句只发一次）。
3. 图片、文件、语音那些不走这里，由中继的 `/push` 直接收。

## 中继

```sh
git clone https://github.com/yez19297-a11y/dsh-wx-bridge
cd dsh-wx-bridge
node src/wx-bridge.mjs          # 起在 127.0.0.1:18123
```

第一次要扫码登录：

```sh
curl -X POST http://127.0.0.1:18123/login    # 拿二维码，图存到 <WX_BRIDGE_DIR>/qr/
curl "http://127.0.0.1:18123/login/status?wait=20000"   # 问扫上没有
```

手机微信 → 扫一扫 → 右上角相册 → 选那张图 → 确认。
**登录完要对方先给你发一句**：发消息要约对方发来的 `context_token`，第一次必须他先开口。

## 许可

MIT。
