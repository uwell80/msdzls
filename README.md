# 美食大战老鼠 · 单机复刻（逆向工程记录）

把 4399《美食大战老鼠》（Flash + Aurora 引擎，`TD*.swf` 系列）还原成一个**不依赖官方服务器**的本地单机版本：
本地 HTTP 站负责下发 SWF / 配置 / 美术资源，本地 TCP 网关负责认证、大厅、逻辑三类协议。

当前进度：协议分帧、XTEA 加解密与填充已用真实密文逐字节验证；认证 → 大厅 → 逻辑链路打通，
客户端可稳定登录并停在大厅；战斗链路（SitDown、129/130 帧同步、出怪波次）服务端侧已落地，**待实机验证**。

完整的逆向记录（协议字段、反编译类名、报文号、测试判据）见 [msdzls/README.md](msdzls/README.md)。

## 快速开始

需要 Node.js 20.11+（开发环境为 v24）。Flash 客户端需要一个支持 Flash 的浏览器或独立播放器，仓库本身不附带。

```powershell
node msdzls/server/local-server.mjs
```

然后打开 <http://127.0.0.1:8080/>。占用端口：HTTP `8080`；TCP 网关 `18443`–`18446`；Flash 策略端口 `843`。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| [msdzls/server/local-server.mjs](msdzls/server/local-server.mjs) | 主程序：本地 HTTP 站 + 认证/大厅/逻辑 TCP 网关 + 协议解密与应答 |
| [msdzls/server/capture.mjs](msdzls/server/capture.mjs) | 协议探针：XTEA 解密、消息头/分帧解析 |
| `msdzls/server/verify-*.mjs` | 端到端校验：加解密逐字节一致、握手后应答体的字节布局断言 |
| [msdzls/docs/](msdzls/docs) | 战斗链路分析：进入战斗、协议规格、帧同步复刻计划、出怪波次驱动 |
| `msdzls/patch/` | 客户端补丁（让原始 SWF 指向本地服务器所需的改动） |
| [msdzls/README.md](msdzls/README.md) | 完整逆向记录与测试判据 |

## 关于资源

仓库**不包含**游戏本体与反编译产物：`*.swf`、`*.dat`、抓取到的 `client-cache/`、
FFDec 反编译输出 `decompiled/`、以及工作区副本 `verify_patch*/`、`tmp/`、`tools/` 下的第三方二进制，
均由 `.gitignore` 排除。

服务端对图片/配置/模块采用「本地优先 + 回源镜像」：本地没有的资源会按原始路径从 CDN 抓取一次并落盘，
之后即可离线使用。因此首次运行需要联网。

## 免责声明

本项目仅用于逆向工程学习与技术研究。《美食大战老鼠》的游戏资源、客户端与商标版权归原权利人所有，
本仓库不分发这些资源。
