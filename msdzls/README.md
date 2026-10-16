# 美食大战老鼠 · 单机复刻（逆向工程记录）

把 4399《美食大战老鼠》（Flash + Aurora 引擎，`TD*.swf` 系列）还原成一个**不依赖官方
服务器**的本地单机版本：本地 HTTP 站负责提供 SWF/配置/美术资源，本地 TCP 网关负责
认证、大厅、逻辑三类协议。目前客户端可以完成登录并稳定停在大厅。

> 本文档同时是逆向过程的记录。协议细节都标了反编译类名，便于继续补齐时按图索骥。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `server/local-server.mjs` | 主程序：本地 HTTP 站 + 认证/大厅/逻辑 TCP 网关 + 协议解密与应答 |
| `server/capture.mjs` | 协议探针：XTEA 解密、消息头/分帧解析（也可作库被 import） |
| `server/probe-config.mjs` | 用客户端硬编码密钥解开 `config.data`，验证 XTEA 移植 |
| `server/verify-encrypt.mjs` | 用真实密文逐字节验证**加密**实现与客户端一致 |
| `server/verify-handlers.mjs` | 端到端校验：握手后逐条断言第三批应答的字节布局 |
| `server/read-screen.ps1` | 诊断：截图 SLBrowser 窗口 + Windows OCR，把游戏画面文字读成文本 |
| `server/*.log` | 运行日志（`server.log` 为当前，`server.log.*` 为历史） |
| `client-cache/` | 抓取到的客户端资源（SWF、配置、图片镜像、解密后的 config ZIP） |
| `decompiled/` | FFDec 反编译产物（`TDCore`、`TDLoaderUI` 已全量反编译） |
| `tools/` | 工具链：FFDec 26.3.0、便携 JRE 17、`decompile-swf.ps1`、Flash 独立播放器 |
| `docs/battle-entry.md` | 单机"进战斗"链路（SitDown 协议 + 战斗模块加载）分析 |

`.gitignore` 已排除 `client-cache/`、`decompiled/`、`tools/` 与所有 `*.swf/*.dat`，
这些是抓取/生成的第三方产物，不入库。

## 已还原的协议要点

**分帧**（`a_4771/a_2650`、`a_2670`）

- 客户端 → 服务端：`[1 字节 httpHead][int32 包长][24 字节头][报文体]`，包长含头不含 httpHead。
- 服务端 → 客户端：无 httpHead 前缀，仅 `[int32 包长][24 字节头][报文体]`。
- 24 字节头：`包长 / uin / flag(int16) / 可选段长(int16) / 头长(=24) / msgID / msgType / version / playerID`。
- 客户端连接时会先发 `GET / HTTP/1.1` 做伪装，服务端需先剥掉再进包循环。

**加密**（`a_4727/b_164`、`a_1775`、`a_1774`）

- XTEA：`DELTA = 0x9E3779B9`，8 字节分组，小端，外加一层 CBC 式链式异或。
- 填充：块 0 = `[头字节(低位=padLen)][padLen 随机字节][开头数据]`，末块 = `[最后一个数据字节][7 个 0]`；
  末块 7 个 0 是强完整性校验，用错密钥几乎必然解密失败（客户端据此回退到硬编码密钥）。
- 轮数：**协议报文用 32 轮**，`config.data` 用 **8 轮**（`uint(-8)`），二者各自独立。
- 密钥：登录用硬编码 `"Authentic@51.COM"`；`config.data` 用 Base64 密钥（见 `probe-config.mjs`）。

**登录流程**

1. `AUTH_REQUEST(1)` → `AUTH_RESPONSE(2)`：明文含账号/用户类型，应答含随机 **16 字节会话密钥**，整段用登录密钥加密。
2. 之后大厅/逻辑报文都用该会话密钥、按 **-32 轮** 解密，应答按 **+32 轮** 加密。
3. 客户端在同一网关端口上复用同一会话密钥：`HALL_LOGIN → GET_ROLE_LIST → GET_ROLE_INFO → ROLE_LOGIN`，
   随后 `LOGIC_LOGIN` 进入逻辑服；心跳为大厅 `14594`、逻辑 `8453`。

**配置**

- `LoadFilesList.xml` 原站为 gzip；`config.data` 是 XTEA(-8) 加密的 ZIP（见 `probe-config.mjs` 解密结果）。
- 服务器列表 XML（`Authenticate/HallServer/LogicServer`）被改写成指向本地端口。
- 图片/配置/模块走"本地优先 + 回源镜像"：本地没有的按原路径从 CDN 抓一次并落盘，之后离线可用。

## 报文号参照

消息号常量定义在 `TDCore/scripts/a_4716/b_154.as`；各响应体的字段顺序 = 对应
`com/aurora/protocol/**/CResponse*.as` 的 `decode()`（**从头顺序读，不依赖 resultID 分支的
要特别留意**）。已实现的大厅/角色应答集中在 `local-server.mjs` 的 `HALL_RESPONSES`。

> 经验：任务类应答一律回"失败"。若把领奖回成成功，客户端会真的发卡并继续检查下一个任务，
> 实测会无限循环；回失败则界面保持"任务未完成"，不刷屏。

## 运行

```powershell
node server/local-server.mjs
```

浏览器打开 <http://127.0.0.1:8080/>。端口：HTTP `8080`；TCP 网关
`18443`(通用/gateway)、`18444`(认证)、`18445`(大厅)、`18446`(逻辑)；Flash 策略 `843`。

## 验证

```powershell
node server/probe-config.mjs     # config.data 解密成功即 XTEA 移植正确
node server/verify-encrypt.mjs   # 加密实现与客户端逐字节一致
node server/verify-handlers.mjs  # 端到端：握手 + 逐条断言大厅/进房/坐下/房间视图应答布局（当前 25/25 通过）
```

`verify-handlers.mjs` 会在临时端口（18080/2844x）另起一个实例，不影响正在运行的服务端。

## 反编译工具链

FFDec 需要 Java 运行时。项目自带便携 JRE（`tools/jre`，Temurin 17，解压即用），
因此可离线反编译任意 `client-cache/*.swf`：

```powershell
pwsh tools/decompile-swf.ps1 TDTownUI TDWorldMapUI TDGameReadyUI
pwsh tools/decompile-swf.ps1 -AllMissing   # 反编译 server/missing-swfs.txt 里列出的
```

产物写到 `decompiled/<SWF名>/scripts/**`（ActionScript）与 `.../images`。

## 进度

- **Phase 1–2 已完成**：协议分帧、XTEA 加解密与填充已用真实密文逐字节验证。
- **Phase 3 已完成**：本地 HTTP 站提供 SWF/配置/美术；认证→大厅→逻辑链路打通，客户端稳定登录进大厅。
- **第三批**：补齐打开各界面时才触发的大厅子系统应答 —— 宠物账号 `14702`、
  抽奖信息 `14945`、邮件未读 `14981`、公会任务列表 `15360`、节日兑换 `15376`、月卡信息 `15381`、
  抽奖/海贼活动 `15697`、月卡商店 `15714`、每日充值 `15749`、特别活动 `15760`；公会加入 `14768`
  与房间人数 `8466` 回失败；心跳/埋点/日志 `8453/14612/14744` 记为静默（无需应答）。
- **第四批（本轮）**：打通工具链（便携 JRE + FFDec 反编译脚本），补反编译 `TDTownUI/TDWorldMapUI/TDGameReadyUI`，
  并从 TDCore 还原单机"进战斗"入口，实现逻辑服 **`SitDown`(8705) → `a_2953`**（含 `CPlayerDetail`）。
  详见 [docs/battle-entry.md](docs/battle-entry.md)。
- **第五批**：修复"卡在**正在登陆游戏服务器**"——根因是 `EnterRoom(8449) → a_2938` 没应答
  （提示只在进房应答后由 `TDLobbyCoreUI.a_3138 → a_3745` 关闭）；顺带把 `GET_ROOM_PLAYER_COUNT(8466)`
  从"失败"改为成功（空房间列表）、补上 `GET_CHARM_INFO(15041)`。另外把会话密钥改为**按账号确定性生成**，
  这样以后重启服务端客户端也不会掉会话（配合 `REA_SESSION_KEY` 兜底旧密钥）。
- **第六批**：补上房间/桌列表相关应答 `GET_TABLE_INFO(8464) → a_2942`、`UPDATE_VIEW_AREA(8452) → a_2961`、
  `LEAVE_ROOM(8450) → a_2944`；会话密钥进一步**落盘持久化**（`server/.session-key`）并纳入启动候选，
  重启服务端后客户端可自动恢复。客户端此时可正常进入关卡界面。
- **第七批**：为"进战斗"补齐房间视图与对局数据 —— `8464` 坐下后回显这张桌（`CTableInfo`），
  `8452` 回显"这张桌 + 自己"（`a_2963` 桌 + `a_2911` 玩家），`SEND_GAME_DATA(8709) → a_2951` 应答；
  新增 `server/read-screen.ps1`（截图 + Windows OCR，用于无视觉时"读"游戏画面）。
- **第八批**：解开 **L1 传输层封装**并落地为可复用模块。
  - 新增 `docs/battle-protocol.md`（18 章，字节级规格）：两层消息号体系、各报文体、
    AMF3 blob、以及 L1 传输层的完整封装。
  - 新增 `server/frame-codec.mjs`：`a_2670` 头 + `b_164` 链式加密 + `a_2926` 包装，
    并导出一站式的 `encodeGameFrame()`。
  - **关键发现**：加密**不是标准 CBC**。块链关系为
    `cipher[k] = XXTEA_enc(plain[k] ^ cipher[k-1]) ^ plain[k-1]`
    —— 每块**同时依赖上一块明文与上一块密文**，只按单一链值实现会从第 3 块起解错。
  - **关键发现**：会话密钥来自登录应答 `authenResponse.m_szSessionKey`，
    **私服完全可控**，无需复刻官方登录流程。
  - 新增两个测试套件：`server/run-spec-test.mjs`（69 项）、`server/run-frame-test.mjs`（50 项）。
  - `local-server.mjs` 接入：新增 `buildL2Frame()` 与 `buildBattleStartFrames()`，
    `SitDown(8705)` 应答后延迟 800ms 主动推 L2 的 `LoadStart(129)` / `StartGame(130)`。
    当前两个 L2 报文发**空载荷**，只为验证"帧能否被客户端解出并派发到 `a_2087`"；
    逐字段报文体待补。<br>**⚠️ 运行中的服务端（pid 10976，启动于 15:36）早于本批改动，
    需重启才能生效**：`server\start-server.cmd`。
  - **⚠️ 后续实机日志推翻了本批的一个假设**：客户端在**未收到任何服务端 L2 帧**的情况下
    就已经进入战场（`/images/map/battleScene/0xE00003/` 与 `TDGame2V2BattleUI.swf`
    被正常请求）。所以"必须由服务端主动推 `LoadStart(129)` 才算进战场"**不成立** ——
    进场由客户端本地驱动，服务端 L2 帧的作用是**同步**而非**进场开关**。
    `buildBattleStartFrames()` 保留，但其定位应改为"同步用的帧源"，不是进场前提。
  - `server/verify-cards.mjs` 补上**高星掉星**与**保险金对照**两条用例
    （`REA_HIGHSTAR=nosec|insured`，须分进程跑，见 `docs/verify-compose-fixes.md` §7）；
    修复了 `:16` `REA_FORCE_UPGRADE ??= "success"` 导致掉星用例结构性假绿的缺陷。
- **第九批**：修正**卡片升星/合成**逻辑使其匹配原版，并给 `8709` 补布局断言。
  - **成功率算法（原实现正确，未改）**：`ComposeConfig.as:269-296` 的
    `Upgrade.Level[@lv == 主卡星级].Group[材料所属组].Rate[@lv == **材料卡自身星级**]`。
    外层 `@lv` = 主卡星级、内层 `@lv` = 材料星级（**不是目标等级** —— 早期文档写错过）。
    数据呈对角结构，`M >= N+2` 必成、`M = N+1` 为 `0.800`。三组 `Group` 只是材料珍贵度分档。
  - **失败结果码改为 `0`（原回 `1`）**：关键门在**协议层**而非 UI 层 ——
    `ComposeServerDataProtocol.as:258` `if(response.m_nResult == 0)` 内**没有 1065 分支**。
    若回 `1065`（`TDComposeUI.as:1403` 能接受），则 `a_2439` **全局卡片表永不更新星级**，
    表现为"界面短暂变、切页就打回原形"。故必须回 `0`。
  - **失败掉星规则**：`!success && !insured && 主卡星级 > ProtectLevel(5) && rate < 0.2`
    时 `-1` 星。依据 `UpgradeCardPane.as:770-780 protectCheck()` 与
    `zh_CN.xml 0x01004b`「您的强化概率低于&variable&%,失败后主卡会被降级」。
  - **保险金与护佑符正交**：保险金**只保星级**（材料照吃）、护佑符**只保材料**
    （`m_arrSub` 回空表，星级照掉）。修复了原实现把 `m_nDisableConsortiaExtra` 当"保材料"用的错误。
  - **补回漏写的 `m_stNewCardInfo`**（8 字节），此前导致其后所有字段**整体前移**、
    客户端读到的 position/材料数全是错位数据、格子清不干净。
  - **序号语义（故意不对称）**：回包用**旧 seq**（`ComposeData.as:549` 要求 `CardID && CardSeq`
    同时匹配，否则 `:304` 抛「出错了，没有找到对应的主卡！」）；notify 用**新 seq**
    （`a_2439.as:844-864` 已存在卡分支**不碰** `TypeValue`，只有 `:865-894` 新条目分支才写）。
    **不要为了"看起来一致"而改成相同。**
  - `8709`/`a_2951` 布局经复核**本就正确、无需改动**，另加断言（含两组 roomID/tableID）
    防"房间号被写死成常量"。
  - 结论与失效记录见 [docs/verify-compose-fixes.md](docs/verify-compose-fixes.md)
    （含 §7.1 一次"报了全绿但实际两条红"的勘误，以及 `??=` 陷阱）。
  - ⚠ **实机验证尚未执行**：真实升星流程需重启服务端，而 pid 10976 被要求保持不动。
    上述结论均为**离线断言 + 源码实证**，未经真实客户端跑通。
- **第十批**：升星收口 —— 收官 `:1052` 兜底缺陷、`8709` 定案、并**首次重启服务端做实机验证**。
  - **服务端已重启**（pid 10976 → **pid 27616**，启动 19:24:20；旧进程启动于 15:36:30，
    比 `local-server.mjs` 的 mtime 早约 3.5 小时，故此前所有实机日志反映的**都是旧代码**）。
    重启前归档 `server.log.pre-restart-20261014-192406` / `save.json.pre-restart-20261014-192406`。
    ⚠ **教训：拿 `server.log` 判读"当前行为"前，必须先确认日志时间晚于代码 mtime。**
  - **实机已验证掉星**：新代码下真实客户端跑出
    `[upgrade] 11120680 seq=900080 成功率=16.0% → 失败 8 → 7 级`，
    三条掉星条件同时成立（8 > ProtectLevel 5、16% < 0.2、未勾保险金），且**客户端未崩** ——
    证明回包用旧 seq 能通过 `ComposeData.as:549` 的 `(CardID, CardSeq)` 双匹配。
  - **`8709`/`a_2951` 定案：原版契约正确、无需改动。** 请求体是
    `m_iRoomID(i32) m_iTableID(i32) m_nGameDataLength(i16) m_szGameData`，应答是
    `m_nResultID(i16) m_iRoomID(i32) m_iTableID(i32)`；roomID/tableID 由客户端在
    `a_2445.as:153-163` 自填，服务端**原样回显**即正确。
    ⚠ **坑位**：`spec.build()` 收到的不是纯 body，而是**含 4 字节 sequence 前缀**的完整明文
    （`local-server.mjs:2618` 传 `dec.data`），故 roomID/tableID 实际在 **offset 4 / 8**。
    已加断言并跑两组值 `(7,3)` 与 `(11,5)`，防"房间号被写死成常量"。
  - **修复 `:1052` 的 id-only 回退（真实缺陷）**：原实现在 `(id, seq)` 双匹配失败后
    退化为"只按 id 找一张"，会把**另一张同 id 卡**升级并回包它的 seq，
    而客户端 `ComposeData.as:301-305` 找不到 ⇒ `:304` 抛「出错了，没有找到对应的主卡！」，
    且 `:1132-1133` 已吃掉材料 ⇒ 表现为"材料没了、主卡没升、界面报错"。
    已改为**仅双匹配**，找不到则提前 return 并**回非 0 结果码**。
  - **拒绝路径的结果码必须非 0 且非 1065**（本条修正了第十批早期的一个错误结论）：
    `TDComposeUI.as:1403` 把 `0` 与 `1065` 归入**同一成功大分支**，
    `:1412` 无条件调 `updateDataByUpgradeCard` ⇒ 两者都会走到 `getCardAttr` 抛异常。
    只有**其它非 0 值**走 `:1478` else 分支（仅弹提示、不动卡片数据）。
    ⚠ 注意与"失败回 0"的区别：**失败回 0** 的前提是"主卡存在、需要把星级写回全局卡表"；
    **主卡找不到**时才回非 0。两者不矛盾。
  - **保险金兜底（`:1010-1040`）**：`upgradeInsurance` 读不到 `compose.xml` 时，
    原实现留空 Map 使每一档都返回 `0` ⇒ `:1115` 的 `if (cost > 0)` 为假 ⇒ **保险金免费生效**。
    已加 `INSURANCE_FALLBACK`（16 档真值表）兜底，并把"查不到"与"lv0 合法为 0"严格区分。
  - ⚠ **已删除一条假警报**：该兜底改动最初附带的
    `if (upgradeInsuranceCache.size === INSURANCE_FALLBACK.size)` 告警**在正常配置上恒为真**
    （兜底表已装全 16 档，XML 只是 `Map.set` **覆盖**同名 key，不增 `size`），
    实测每次读正常 `compose.xml` 都打印"未提供有效数据"——**真故障会被淹没在假警报里**。
    已删除并原地留注释说明"这里不要再加 size 判据"。
  - **已修 `verify-cards.mjs` 的三处自伤**：`:1026`/`:1092` 调纯编码器
    `buildCardNotifyBody()` **未传参**（`local-server.mjs:794` 读 `cards.length` ⇒ `TypeError`、
    整个套件 `exit=1`）；`14689` 条目布局写错（`nAttr` 前**还有 6 个字段** `i16,i16,i32,i32,i32,i8`）；
    notify 指纹解码器 `nAttr` 误写 `i8`（实为 `i16`）。
    **教训：不同消息的条目布局不通用，解服务端自有编码必须回源码逐字段抄。**
  - **`pendingCardNotify` 清理缺口（已确认、可利用性未证实）**：清理点住在**派发处**
    （`:2765`），而赋值点在 builder 内（`:519`/`:706`），故无法覆盖
    "builder 内已写盘、却在到达清理点前从别处 return"的情形 —— 内存会留下一笔"欠通知"，
    被下一笔任意 `14849/14850/14876/14877` 当作本次变化推出。
    **未构造出可复现泄漏，故本轮不改**（避免凭猜想动核心状态机）；默认仅报 `⚠`，
    `REA_STRICT_STATIC=1` 才计入失败。修法建议：函数入口先清、再按需赋非空。
    详见 [docs/verify-compose-fixes.md](docs/verify-compose-fixes.md) §10。
  - **仍未实机验证**：保险金保星级、护佑符保材料、合成 `14849` 不触发无限循环 ——
    实机只跑到 1 次强化（`SIT_DOWN`/`8709`/`14849` 计数均为 0），这三条仅有离线断言覆盖。
- **第十一批**：把 `verify-cards.mjs` 的两档（`REA_FORCE_UPGRADE` 成功/失败）从
  **单边门**改成**无条件双档都断言**之后，暴露了两个此前被门挡住的**结构性假红**
  （Lead 亲自定位并修，详见 [docs/verify-compose-fixes.md](docs/verify-compose-fixes.md) §7.8）：
  - **串联用例写死常量**：两个 14850 用例共用 `cardState` 单例，第二个用例读到的是
    第一个**改完之后**的星级；裸跑时第一个必然成功（1→2），第二个再写死"应升到 2 星"
    就恒红（实际 3）。修法：第一个用例把终态写进 `levelAfterFirst`，第二个期望值改为
    `levelAfterFirst` / `levelAfterFirst + 1`（`verify-cards.mjs:610-614`/`:804-812`）。
    同一处病也在 A4：无条件写死 `result !== 1065` 在成功档恒红，已按档分流 `0` / `1065`。
  - **尾串带结尾 NUL 却按纯文本比较**：`a_2664.encode_string`
    （`decompiled\TDCore\scripts\com\aurora\protocol\a_2664.as:122-141`）写的是
    `src_str.concat("\x00")`，长度前缀**含**该 NUL，客户端 `decode_string`（`:143-164`）
    原样读回 ⇒ 解出来必然是 `"强化失败\u0000"`。已改 `Reader.str()` 剥掉尾部 NUL
    （字节消费不变，长度自洽断言不受影响）后再做文案比较。
  - 裸跑计数 19 → **20**（A4 由恒红变真通过），fail 档仍 21；五命令 + 三套件全绿
    （严格模式 `20/1` 为刻意的已知缺口）。

- **第十二批：战斗开局帧（129/130）落地 —— 做实载荷 + 换触发点 + 修帧头口径**
  - **删掉一个"永不成立"的推送门**：`local-server.mjs` 原写
    `if (h.shMessageID === 8705 && tag === "logic")`，而实测 `server.log:4753` 是
    `[generic#19] ... msgID=8705` ⇒ **那两帧从未发出过**。但只把 tag 改掉**仍然是错的**
    （坐下时客户端还在大厅，见下一条）。
  - **129/130 的真实载荷按客户端 decode 规格做实**（`a_2698.as:41` / `a_2695.as:29`）：
    129 = `int16 gameMode | int16 卡数 | uint32×N 卡ID | int16 0 | int16 0 | int32 seed`
    （长度 `12 + 4N`）；130 = `int16 波数 | int32 seed | int32 buffId`（定长 10）。
    `gameMode` **回显** `roomState.gameMode`（实测客户端坐下送的是 **1**，不是写死的 2）。
  - **触发点换成客户端真实上行**（Lead 用脚本把 `server.log` 里 94 条 8709 全解了一遍：
    `cmd3`×92 / `cmd12`×1 / `cmd9`×1 / **`cmd1`×0**）：
    **`cmd1`(PostSelectedCards, `a_2726`) → 推 129**；
    **`cmd3`(载入进度) 且进度 = 100 → 推 130**。128 一帧不发。
  - **根因纠正**：`a_2179.as` 的战斗载入是"两段门"。`:1663` 照样创建战场 UI `a_757`，
    但 `:1670 if(!this.a_767) return;` —— **没收到 129 就直接早退**，`:1679 a_2195()`
    （真正初始化战场 UI）被跳过，`:1680` 的进度 100 也永远不会上报。
    ⇒ "进了战场却打不了"的真正原因是**进度停在 1..88 不再上升**（日志实测吻合）。
    而 `:810` 的分支要求 `m_arrSelectCardIDs` **非空**才能保证 `a_2193` 被触发、
    绕开 `:853-856` 的死路 —— 所以卡组必须原样回填。
  - **129 的 avatar 数组故意发 0 条**：`a_2179.as:312-313` 客户端本地路径**已经**把本机座位的
    `AvatarDetailInfo` 填好，而 cmd1 是在 `:410`（`:313` 之后）才发出；服务端再回 1 条会在
    `:757-759` **覆盖**本机卡组，而 cmd1 的 `CCardIDInfo` 只有 CardID+CardSeq、没有星级
    （`CCardIDInfo.as:21`），硬凑会写坏战斗卡牌等级。⇒ 单机发 0 条最忠实，且**完全不用写 AMF3**。
  - **★ 修掉一个会让 129/130 彻底无法解析的真实 bug —— 帧头多了 1 字节**：
    `frame-codec.mjs` 的 `encodeHeader` 照抄了 `a_2670.encode` 的**客户端上行**口径
    （先写 1 字节 `httpHead`，共 25 字节）。而客户端接收侧是
    `a_1779.as:84 packageBytes.position = 0;` → `a_2220.a_2204` → `a_2670.decode`
    （`a_2670.as:59` **从 `nPackageLength` 开始读、不读 httpHead**）⇒ **下行必须是 24 字节头**。
    已把 `encodeHeader` 的 `httpHead` 默认改为 `false`（`buildPacket` 一直是这个口径，
    也是唯一被实机验证过的下行路径）。
  - **测试**：新增 `server/verify-battle.mjs`（23 项：字节断言 + `decryptFrame` 端到端解回 +
    **真实 socket 端到端**（认证→发 cmd1→收 129→发进度 100→收 130）+ 变异自检）；
    `run-frame-test.mjs` 50 → **55** 项（新增"下行 24B / 上行 25B 不对称"与反例断言）。
  - **基线（全部实跑，exit=0）**：`run-spec-test` 69/0 · `run-frame-test` **55/0** ·
    `verify-handlers` 27/0 · `verify-battle` **23/0** · `verify-cards` 20/0（裸跑）与 21/0（fail 档）。
  - **仍未做实机验证**（需重启服务端 + 真人点「开始」）：见
    [docs/battle-replica-plan.md](docs/battle-replica-plan.md) §7 前 4 项。
  - 备份：`server/local-server.mjs.bak-20261014-210356`、`server/frame-codec.mjs.bak-20261014-2115`。

- **第十三批：定位并修复「准备界面（战斗等待界面）永远进不去战场」的真正根因 —— 启动页没把画布缩放到窗口内。**
  - **症状（09:47 那次真机会话，日志已归档 `server/server.log.pre-pagefit-20261016-1010`）**：
    131（4 座位槽 / `canStart=1`）与 14620（158 张卡）都按预期推出去了，客户端却把战斗模块预载到
    **进度 99% 就停住**（`cmd3` 序列 `1..99` 共 93 条）——即 `a_2179.as:1670 if(!this.a_767) return;`
    的早期返回态；整场 **0 条 `cmd1`**，所以服务端**从未**推 129（129 的唯一触发点就是 cmd1）。
  - **把 `dealSubmitReadyGame()`（`TableReadyUI.as:818-948`）的每一道门逐条核过，全部通过**：
    道具/英雄包未满、卡组非空、`0x0100` 位地图的指定卡也在（`0x11370015`）、
    `heroMapEnable/heroCountEnable/checkYiji/checkSeason` 全 true、`a_1674==1`。
    ⇒ 协议与数据侧无从指摘，问题在"**按钮点不到**"。
  - **几何实测**（`server/_screen.png` 逐像素 + `Screen::PrimaryScreen`）：屏幕 1536x864（DPI 120%），
    FCBrowser 窗口 `1200x525`，画布从 **y=116** 起铺 **600** 高 ⇒ 窗口客户区底边 ≈517
    ⇒ **可见画布只有 ≈400/600 = 67%，底部约 200px 被裁掉**，而准备界面右下角的「开始」正好在那 200px 里。
    旧 CSS `#wrap{display:flex;justify-content:center;padding:12px}` **完全不缩放**，窗口一矮就必然裁底部。
  - **修复**：`INDEX_HTML` 新增 `fitGame()`（按 `min(vw/950, vh/600)` 等比缩放画布 + `resize` 监听 +
    启动前 10s 重试），`#wrap` 改 `position:fixed;inset:0` 居中；新增 `diagGeom()` 把
    `inner×outer / dpr / scale / 画布 rect / 滚动高度` 回报到 `/__diag`（"按钮点不到"类问题以后第一次就有实测数字）；
    服务端新增**特征信号告警**：整局收到进度 ≥99 且从未收到 `cmd1` 时直接打印排查项。
  - **测试**：`verify-battle.mjs` 新增 E1/E2（抓 `fitGame`/`resize`/等比公式/几何上报，并断言旧的
    "不缩放"布局不会复活）⇒ 27 → **29 通过 / 0 失败**。完整分析与证据见
    [docs/battle-replica-plan.md](docs/battle-replica-plan.md) §7.0。
  - **服务端已重启**（pid 21808 → **22364**，启动 10:10:48；旧日志归档为
    `server.log.pre-pagefit-20261016-1010`）。⚠ **运行中的游戏实例仍是旧页面**：必须**刷新页面（F5）**
    才能生效，然后按 §7 表第 0/1/2 项看日志里是否出现 `PostSelectedCards → 推 L2 LoadStart(129)` 与
    `-> L2 StartGame pushed: cmd=130`。
  - 顺带新增三个"无视觉也能看画面"的诊断工具：`server/ocr-words.ps1`、`server/crop-ocr.ps1`、
    `server/tile-ocr.ps1`、`server/tile-ocr2.ps1`、`server/prep.py`、`server/ascii-view.ps1`，
    以及 `server/check-ready-deck.cjs`（校验"地图默认卡组 → 玩家真的有 → 开局硬门"这条链）。

- **第十四批（关键更正）：服务端**下发**战斗数据必须走 8711（CNotifyGameData），8709 是上行应答、载荷会被丢弃。**
  - 反编译实证：`b_177.as:134` 把 **8709 绑到 `a_2624`**，而 `a_2624`（`:540-553`）只解
    `a_2951` 的 `resultID/roomID/tableID`，**函数体是空的** ⇒ 我们此前封进 8709 的
    129/130/131 载荷**全被客户端当上行应答扔掉**。真正的下发号是 **8711**（`b_154.a_154`）
    → `b_178.a_2639` → `CNotifyGameData(a_2903)`：
    `int32 roomID | int32 tableID | int16 事件数 | 事件×(int32 seq|int32 len|裸 L2 载荷)`，
    每个事件的载荷首字节就是 L2 命令号，客户端交给 `a_2445.a_2456 → a_1842 → a_2053.a_2055` 分发。
  - 还有一条硬约束：`a_2639` 按 `(serverID, roomID)` 找 `a_2445` 处理器，
    **roomID 与客户端当前坐下房间不一致就丢弃**（`b_178.as:95-100`）。
  - **这解释了此前两个"修不好的"现象**：`a_1674` 一直是 -1 ⇒ 点「开始」是**静默空操作**
    （`TDGameReadyUI.as:986` 的 `else if` 不成立）；`TableReadyUI.showReadyCards()` 从未被调用
    ⇒「我的防御卡」连卡位格子都不建、点卡无回调。**都是"131 没送达"的下游表现。**
  - 实现：`local-server.mjs` 新增 `buildGameDataNotifyBody/Packet`（8711），
    129/130/131 三条推送全部改道；日志前缀改为 `-> L1 8711(CNotifyGameData) …`。
  - 测试：`verify-battle.mjs` C 段重写为"解 8711 → 解 a_2903 → 取事件载荷 → 断言命令号/体"，
    A11 直接断言 8711 组装，新增 `parseGameDataNotify/firstL2Data/notifyCmds` 解析器 ⇒ **29 通过 / 0 失败**。
  - 风险与边界：`TestError` 只做了一次 POST 自检；客户端**重进准备界面**（或 F5）才会重新收到 131。
    服务端已重启（pid 28684 → **31272**，启动 10:43:12；旧日志归档 `server.log.pre-8711-20261016-1045`）。

## 测试

- **第十五批：背包"老提示扩容"修复 + 战斗卡载入 96% 的根因（地图资源版本不匹配）→ 改道合成地图。**
  - **背包扩容提示**：储藏室应答 `CResponseGetStroeBoxInfo`（`12817`）的第一个 int16 是
    **容量**（`decode:45 → StroeBoxRes.iStoreCount`），第二个才是物品数（`:47 m_nCardCount`）。
    原实现两个都写 `zone.ids.length` ⇒ 客户端永远看到 N/N 满格 ⇒ 一动就提示扩容。
    现在容量按原版 `extraBag.xml` 给 **60**、物品 20（显示 20/60）。
  - **战斗卡 96% 根因**：`TDGame2V2BattleUI.a_3607:477-481` 对普通地图取
    `m_arrGameMapArray[szMapIDStr]` 后立刻 `a_4176()`；而该数组只在 `a_3604:746` 由
    `stContent.content as BaseGameMap` 赋值。实测我们今天从 CDN 镜像下来的地图 SWF
    （`resource/0xE00003.swf` 等，文档类 `DayWallpaperRatHoleGameMap`）**既不含 `BaseGameMap`
    也不含 `IResource`**（对比卡/老鼠资源 `0x11370080.swf` 等都有 `IResource×7`）
    ⇒ cast 得 null ⇒ 战场初始化抛异常（异常发生在动态加载的战斗模块里，客户端全局兜底看不到）
    ⇒ 进度永远停在 96、进不了战场。
  - **修法（本轮落地）**：让这一局走**合成地图**分支 —— `CompositeMapHandler.IsCompositeMap()`
    （`CompositeMapHandler.as:181`）是**纯配置判断**（mapID 在 `composite_map.xml` 里即可），
    命中后 `a_3607:467-476` 用 `GetCompositeMap()`、`a_2187` 用 `InitComposite()`，
    **完全不碰地图 SWF**；而 mapID 由服务端坐下应答（`a_2953.m_iMapID`）控制，
    客户端在 `b_177:409` 用 `SetCrossMapID` 灌给 `CompositeMapHandler`。
    新增 `resolveBattleMapID()`：地图不在 `composite_map.xml` 时改道到 `0x50010301`（古堡初探）。
    开关：`REA_FORCE_COMPOSITE_MAP=0` 关闭，`REA_COMPOSITE_MAP=0x…` 换图。
  - 测试：`verify-handlers` 的 SIT_DOWN 断言改为"回显请求地图 **或** composite_map.xml 里的图"，
    全量基线 **69/55/27/29/20/9 全绿**。
  - 服务端已重启（pid 9364 → 见日志 `server.log.pre-compositemap-20261016-1135`）。
    遗留：普通地图的**版本匹配 SWF** 仍未找到（本地镜像/用户缓存都没有），
    找到后可关掉改道、恢复原版地图与美术。

- **第十六批：接上客户端内部日志通道（Haxe 编的 LocalConnection 接收器）。**
  - 客户端所有模块的 `a_4648`（AS3Debugger）把内部日志广播到
    **LocalConnection `_debugConnection`**（`a_4648.as:56`），Flash 之外收不到 ——
    这就是"卡在 99 但看不到任何异常"的原因之一：`a_2179` 里那批
    `a_4648.a_4649("Game: …")` 诊断（`InitialzeGameBattleUI Start/End`、
    `arrPendingLoadingRes.length:…`、`PostLoadingProgress:N`）谁都拿不到。
  - 新增 `tools/trace_receiver/Main.hx`（Haxe，随项目携带 `tools/haxe`），
    编成 `client-cache/mirror/trace_receiver.swf`（≈4.9KB），
    连 `_debugConnection` 并把每条消息 GET 到服务端 `/__trace`
    （`local-server.mjs` 里只打日志、返回 204，形如 `[trace] TDCore :: Game: …`）。
  - 运行方式：`tools\flashplayer_32_sa_debug.exe http://127.0.0.1:8080/trace_receiver.swf`
    （同域 127.0.0.1 才收得到 LocalConnection；窗口可以最小化，别关）。
  - 另一个限制也记下来：客户端"全局未捕获异常"上报（`/log`）**一次性**（`TDCore.onUncaughtError`
    首次触发就自我注销），而每局开始前世界漫游 UI 都会先抛一条
    `map_mouse.xml配置中不存在 地图id前缀为 0x0的地图`（来自 `TDMeiShiUI/TDHuoShanUI/…`
    这批世界漫游模块），把名额占掉 ⇒ 战斗里的异常看不见。trace 通道不受此限。

- **第十七批：战斗模块「卡 99%」的**真根因**定案并修掉 + 出怪（SC 132）落地。**
  取证与规格见 [docs/battle-module-rootcause.md](docs/battle-module-rootcause.md)、
  [docs/battle-wave-driver.md](docs/battle-wave-driver.md)。
  - **根因（三层实测，不是推测）**：
    1. **逻辑在 TDCore、美术在模块**。TDCore 内联了整套战斗 UI 逻辑
       （`com.aurora.ui.maogoutd.TDGame2V2BattleUI` + 1141 处 `m_st*` 引用），
       但 `ffdec -export symbolClass TDCore.swf` **只有 2 条**（`TDCore`、`ButtonClickSound`）
       ⇒ TDCore 里一个战斗美术都没有；而 CDN 的 `TDGame2V2BattleUI.swf`
       135 条 SymbolClass 全是美术，`b_147/a_3600/a_3604/SetDIYInfo` 等逻辑串**出现 0 次**。
    2. **两边类名相同**，模块 ABC 里那些同名类都是空壳（`extends MovieClip`，方法体只有 `super()`）。
    3. 客户端用**子域**加载它（`a_2179.as:1446` → `ApplicationDomain(currentDomain)`）
       ⇒ 空壳遮蔽逻辑类 ⇒ `:1663 content as b_147` 得 **null** ⇒
       `:1664 a_757.SetDIYInfo(...)` 空引用抛异常 ⇒ `LoadEndAndStartGame()` 夭折
       ⇒ **既不初始化战场也不上报 100，永久停 99%**（与 `server.log` 里 `cmd3 1..99` 的现场吻合）。
  - **上一轮那个 Haxe 空桩为什么不行**：它只能让 `as b_147` 通过，
    而 TDCore 的逻辑类有 **1141 处 `m_st*`** 引用、桩里元件数是 **0** ——
    过得了转换，过不了第一帧（`a_1797` 第一句就是 `this.m_stUserInfoPanel.x = 0`）。
  - **修法**：`server/patch-battle-assets.cjs` 把模块 ABC 常量池里那 135 个**类简单名**
    做**等长改名**（`…View` → `…VieA`），**SymbolClass 标签里的点分全名一个字不改** ——
    链名在域链上只能落到父域 TDCore 的逻辑类 ⇒ 逻辑来自 TDCore、元件来自模块。
    服务端默认发改名后的产物（`REA_BATTLE_MODULE=assets`；`stub`/`cdn` 留作对照）。
  - **出怪（本轮新增）**：客户端**唯一**的怪物来源是 SC **132 `NextEnmeyWave`**
    （`a_2053.as:85 → a_2090 → a_2699 → a_2179.a_2181 → TDGame2V2BattleUI.a_3608
    → BattleFieldView.a_3456 → a_4255.a_4256(typeID)` 造实体）。
    体布局 `int8 洞数|int8 洞基号|int8 波进度|int8 波状态|int16 鼠数|
    ×N{uint16 序号,uint32 鼠ID,uint8 出现方式,uint8 行,uint8 洞口flag,uint32 出现tick}`，
    长度 `6+13N`；tick 单位 **50ms**，**tick 0 = 客户端处理 130 的那一刻**
    （`a_2179.as:891 a_3435(notify)` → `BattleFieldView.a_3435():1643-1648`）。
    服务端推完 130 就接上定时帧源（`startWavePushes`），按种子生成的波次表逐波推 132。
  - **鼠表硬约束**：`BattleFieldView.a_3456:3107-3112` 在工厂 `a_4255.a_4256(id)` 返回 null 时
    **直接 `throw("此老鼠不存在ID:…")`**。这份客户端启动时只注册 **45 只**
    （`TDCore.as:36 TDFactoryImport.ImportAll()`），而 `map_mouse.xml` 里古堡初探
    自带的 29 只 `0x1xxx` 鼠**一只都没注册** ⇒ 照抄地图配置会把战斗模块打抛。
    所以取「地图鼠表 ∩ 白名单」，零交集回落经典三只（`0x0001/0x0002/0x001e`）。
    新增 `server/check-wave-mice.mjs`：把白名单与**反编译产物**重新推导的结果逐条比对
    （`decompiled/` 缺失时明确报"没得比"并 `exit=2`，不假装通过）。
  - **顺手修掉测试脚本一个会吞包的缺陷**：`verify-battle.mjs` 的 `makeReader.next()` 超时后
    **不把自己从 waiters 摘掉**，窗口式收集每跑一次就留一个"已 reject 的"等待者；
    下一个包进来先喂给它 ⇒ **包被静默吞掉**，后面真正在等的 `next()` 只能等到超时
    （本轮实测症状：132 已写到 socket 却报"等待超时"）。
  - **基线（全部实跑，尾行 + 退出码）**：`run-spec-test` 69/0 · `run-frame-test` 55/0 ·
    `verify-handlers` 27/0 · `verify-battle` **39/0（F1-F5 module 护栏 + G1-G5 132 护栏）** ·
    `verify-cards` 20/0（裸跑）· `check-wave-mice` 45/45 一致。
  - **★ 实机第一次反馈（同日晚些）**：用户报「到战斗界面就操作不了」。
    现场（截图 OCR + `server.log`）：界面已画出（`卡片1..卡片5`、地图美术、等待音乐都在），
    但客户端停在资源预载（`cmd3 进度 1` 之后无动静）。
    根因是**改名范围过大**：135 个 SymbolClass 里有 **12 个类 TDCore 根本没定义**
    （游戏结果/荣誉界面 9 个 + 两个中文名元件 + `RatEarthHoleBitmapdata` 鼠洞位图），
    它们是**纯美术**元件、模块自己的壳就是唯一实现 —— 改了名 ⇒ 链名在域链上**无处可解** ⇒
    装载报错、卡预载、界面点不动。
    已把口径收窄为「**只改 TDCore 里确实有同名类的**」：本轮 **123 改名 / 12 保持原名**
    （判定依据是 `decompiled/TDCore/scripts/**` 的类清单，另有硬编码兜底），
    并新增 F2/F5 两条护栏（改名的必须 TDCore 里有、跳过的必须 TDCore 里没有）。
    产物换完**不用重启服务端**（HTTP 路由每次请求现读文件），刷新页面即可。
  - **★★ 实机第二次反馈（同日再晚）**：用户报「还是操作不了页面」。
    现场（截图 OCR + `server.log`）：界面画出来了（`卡片1..卡片5`、地图美术、等待音乐都在），
    但客户端**卡在资源预载**——`cmd3 进度 1` 之后没下文，紧接着请求完
    `GET /TDGame2V2BattleUI.swf` 就断线；OCR 里「我的防御卡」面板是一串 `0000…` 空槽。
    两条独立的坑，都已处理：
    1. **改名这条路走不通（默认已退回 `cdn`）**：改名后元件实例的类变成 TDCore 的
       `TDGame2V2BattleUI`，Flash 就会走它的构造函数 —— 而该构造函数 `:322` 调
       `a_1797()`，里面**第一句**就是 `this.m_stUserInfoPanel.x = 0`；**时间轴元件是构造之后
       才绑定**的（旁证：模块壳类构造函数只有一个 `super()`；能用的 `TDGameReadyUI` 把这类逻辑
       放在 `ADDED_TO_STAGE`）⇒ 空引用抛异常 ⇒ 元件实例化失败 ⇒ AurLoader 的任务永不完成
       ⇒ 整条预载停住 ⇒ **界面可看不可点**。对照：`cdn` 下预载能走完、准备界面可操作
       （11:2x 那次 `cmd1` 就是它）。所以默认发 `cdn`（`REA_BATTLE_MODULE=assets|cdn|stub` 可切）。
       真正进战场只剩两条路，已写进 `docs/battle-module-rootcause.md` §2.2：
       **A** 找到"文档类 implement `b_147` 且不遮蔽 TDCore"的版本匹配老模块；
       **B** 字节码级把 TDCore 构造函数里那次 `a_1797()` 挪到元件绑定之后（下一轮独立任务）。
    2. **默认卡组过不了「必须带指定卡」硬门**（`dealSubmitReadyGame:917`）：
       地图 0x50010301 原 `DefCardsID` = `0x11110014`（玩家有），但它带 `0x0100` 位，
       而玩家拥有的 15 张门卡**一张都不在**默认卡组里 ⇒ 自动填卡后点「开始」被挡。
       现在服务端在 `/config/map_mouse.xml` 里给这张图的默认卡组**补入门卡 `0x11370015`**
       （玩家真的有，且能过门）；探针 `node server/check-ready-deck.cjs 0x50010301`
       就是照这两个坑写的。开关：`REA_FIX_DEF_CARDS=0` 关、`REA_DEF_CARDS=0x…` 指定整副。
    顺带修掉两个**静默失效**的写法（都属于"改了但完全没生效"这一类）：
    `indexOf("/>", at)` 在 `map_mouse.xml` 里永远找不到（条目是 `<item …>` + `</item>`，
    不是自闭合）⇒ 静默 return；以及 `cardCatalog()` 返回的是 `{cards,…}` 而不是数组。
    另外把 `fixCompositeDefCards` 包进 try/catch —— 它一抛就会**打断
    `/config/map_mouse.xml` 这条路由**（客户端连接被重置、整个客户端起不来），
    默认卡组只是锦上添花，绝不能连累配置下发。
- **第十八批：修好"看不到客户端内部状态"这件事 —— 内部日志改走 HTTP。**
  - **根因**：客户端内部诊断（含 `a_2179` 那批 `Game: …`）走
    `a_4788.a_4648.a_4649` → LocalConnection `_debugConnection`；而在 FCBrowser
    （PPAPI Flash 34）里这条通道**根本不投递** —— 把 `trace_receiver.swf` 挂进同一页面、
    同一域，连它自己发的自检消息都收不到（`server.log` 里只有 `boot`/`connected` 两行）。
    也就是说"看不见客户端在想什么"的根因是**传输方式**，不是接收器写错了。
  - **修法**：`TDLoaderUI.as:582` 加载每个模块都用
    `new LoaderContext(false, ApplicationDomain.currentDomain)` ⇒ 所有模块进**同一个域**、
    **先定义者胜**。于是新增 `tools/logger_patch/LoggerBoot.hx`（Haxe → `logger_patch.swf`，
    15KB）定义一份**同名同签名**的 `a_4788.a_4648`（`identity`/`OmitTrace`/`a_4649(msg,id)`），
    改用 **HTTP GET `/__trace`** 上报；`loadFilesList()` 把它插到 `<SWFFile>` 的**第一条**，
    排在 TDCore 之前。全客户端（含 TDCore 自己的战斗诊断）的日志就都进服务端日志了。
  - **为什么不会更糟**：覆盖件与 TDCore 那份公开成员完全一致；万一加载顺序不如预期
    （覆盖失败），客户端行为与原来一模一样。开关 `REA_LOGGER_PATCH=0`。
  - `/__trace` 同时支持 GET 与 POST，日志形如 `[trace] <id>#<n> :: <msg>`。
  - 护栏：`verify-battle.mjs` 新增 H1-H3（覆盖件必须排在 TDCore 之前 / 定义的是
    `a_4788.a_4648` 且不再用 `_debugConnection` / 通路 204）。合计 **42 通过 / 0 失败**。
  - 服务端已重启；**需要刷新页面（F5）**让客户端重新拉 `LoadFilesList.xml` 才会生效。
  - ⚠ **仍未实机验证**：① 改名后的模块能否让战场真的起来（决定性一步是
    "Flash 会不会把时间轴元件按实例名自动绑到同名 public 变量上"，详见
    `battle-module-rootcause.md §3`）；② 132 推下去客户端是否真的落怪。
    两者都要**重启服务端 + 刷新页面 + 点「开始」**，看 `server.log` 里有没有
    `NextEnmeyWave pushed` 与 `★★★ CLIENT_UNCAUGHT_ERROR ★★★`。

```bash
node server/run-spec-test.mjs                             # 合计：69 通过 / 0 失败
node server/run-frame-test.mjs                            # 合计：55 通过 / 0 失败
node server/verify-handlers.mjs                           # 合计：27 通过 / 0 失败
node server/verify-battle.mjs                             # 合计：39 通过 / 0 失败（129/130/132 + 模块改名 + 启动页几何）
node server/check-wave-mice.mjs                           # 白名单 vs 反编译产物：45/45 一致（exit=0）
node server/verify-cards.mjs                              # 合计：20 通过 / 0 失败（裸跑 = 成功档）
REA_FORCE_UPGRADE=fail    node server/verify-cards.mjs    # 合计：21 通过 / 0 失败（失败档）
REA_HIGHSTAR=nosec        node server/verify-cards.mjs    # 合计：3 通过 / 0 失败（掉星 9 → 8）
REA_HIGHSTAR=insured      node server/verify-cards.mjs    # 合计：3 通过 / 0 失败（保险金保持 9 星）
REA_STRICT_STATIC=1       node server/verify-cards.mjs    # 合计：20 通过 / 1 失败（严格模式，见下）
```

`verify-battle.mjs` 自己会拉起一个临时端口的服务端实例（`18081` / `28463-28466`），
用固定种子 `REA_BATTLE_SEED=0x11223344` 跑，**不需要**用户先启动服务端，也**不会**碰用户实例。

计数由脚本自己打印，且 `verify-cards.mjs` 的退出码按失败数决定（`process.exit(fail === 0 ? 0 : 1)`），
故判据是**「合计行 + 退出码」双重**，不要引用其它来源的数字。

`REA_STRICT_STATIC=1` 会把 §10 的**已知缺口**计入失败（`20 通过 / 1 失败`、`exit=1`），
这是**刻意的**：该缺口可利用性未证实，若默认常红会把 20 条真通过一起埋掉。
**默认跑不计入它，要追账才显式索取。**

> **三条易踩的坑（务必记住）**
> 1. **高星用例必须分进程跑**：`local-server.mjs:132` 的 `cardState` 是模块级单例
>    （`:136` 一旦加载过就不再重读存档），所以两个高星场景**不能在同一进程里换存档**，
>    且存档必须在 `import local-server.mjs` **之前**落盘。
> 2. **`REA_FORCE_UPGRADE` 不要与 `REA_HIGHSTAR` 混用手设**：高星用例需要"失败真实发生"
>    （它覆盖的正是 `!success` 分支），脚本已按场景选默认值，并会拒绝
>    "高星 + 显式 success"这种静默假绿的组合（`verify-cards.mjs:33-37` 抛错）。
>    详见 [docs/verify-compose-fixes.md](docs/verify-compose-fixes.md) §7.1–7.3。
> 3. **判读退出码时不要接管道**：`node x.mjs | findstr ...` 与 `| more` 会把 `$LASTEXITCODE`
>    换成**管道末端程序**的码 —— 本轮 Lead 就这样把 `exit=1` 误读成 `exit=0`。
>    要拿真实退出码就**单独跑一次不重定向**（或重定向到文件后读 `$LASTEXITCODE`）。

> **本轮的系统性教训（三人都犯过同一类错）**
> 假绿不是"代码写错"，而是**证据采集环节没被验证**就被当成结论。本轮实例：
>
> | 报告者 | 报的数字 | 实测 | 错法 |
> |---|---|---|---|
> | verifier（前轮） | `verify-cards` 12/0 | 未在最终态跑过 | 报数时非最终文件态 |
> | fixer（前轮） | `verify-cards` 12/0 | 19:41 的窗口产物 | 亲眼看到 mtime 已变仍用现在时报旧数 |
> | fixer | 探针 `★ PASS` | 进程 `EADDRINUSE` 已崩 | 未先验证探针先决条件 |
> | **Lead** | `STRICT_STATIC` 19/0 | `19/1 exit=1` | 管道吞掉退出码 |
> | **Lead** | `FORCE_UPGRADE=fail` 18/1 | `21/0 exit=0` | 自写辅助函数有 bug 未先验证 |
> | **Lead** | 裸跑 19/1（"应升到 2 星，实际 3"） | 用例本来就是**串联**的 | 见下「串联用例与写死常量」 |
>
> **串联用例与写死常量（第 6 类假红，本轮新出）**：`verify-cards.mjs` 里两个 14850 用例共用
> 同一个 `cardState` 单例（`local-server.mjs:132/:136`），第二个用例读到的是第一个**改完之后**
> 的星级。裸跑时第一个用例成功（1→2），第二个再写死"应升到 2 星"就永远不可能成立 ——
> 这不是实现错，是**断言把运行时顺序写死了**。修法：第一个用例把终态写进 `levelAfterFirst`，
> 第二个用例期望值改成 `levelAfterFirst + 1`（现 `verify-cards.mjs:610-614` / `:804-812`）。
>
> **尾串比较要剥 NUL（同一类的另一处）**：`a_2664.encode_string`
> （`decompiled\TDCore\scripts\com\aurora\protocol\a_2664.as:122-141`）写的是
> `src_str.concat("\x00")` + `writeUTF`，长度前缀**含**结尾 NUL；客户端 `decode_string`
> （`:143-164`）也原样读回。所以解出来必然是 `"强化失败\u0000"`，直接做文案相等比较会假红。
> `Reader.str()`（`verify-cards.mjs:122-136`）已改为剥掉尾部 NUL 后再返回，字节消费不变。
>
> 对策：报数**只贴自己终端 + 最终文件态**的**尾行原文 + `exit=`**，并附文件 **mtime**。

## 后续里程碑（候选）

1. **战斗帧同步（当前主线）—— 服务器侧已落地，待实机验证**：
   入口、SitDown、L1 封装、**129/130 真实载荷与触发点**均已还原
   （见 [docs/battle-entry.md](docs/battle-entry.md)、[docs/battle-protocol.md](docs/battle-protocol.md)、
   [docs/battle-replica-plan.md](docs/battle-replica-plan.md) §5）。
   第十二批已把 `StepSync` 之外的闭环做完：`cmd1 → 129`、`cmd3(进度100) → 130`，帧头口径已修正。
   下一步（按优先级）：
   - **实机验证（当前第一优先）**：服务端已重启（pid 见 `server.log` 启动行），
     刷新页面（F5）→ 准备界面点「开始」→ 看日志是否出现
     `PostSelectedCards: ... → 推 L2 LoadStart(129)` 与 `-> L2 StartGame pushed: cmd=130`，
     接着是否出现 `-> L1 8711(CNotifyGameData) NextEnmeyWave pushed: 波 1/20 …`，
     以及客户端是否从"载入中"进入可操作战场（`battle-replica-plan.md` §7 第 0-3 项）。
     第十七批已把**卡 99% 的根因**（资产模块被加载进子域后遮蔽 TDCore 的逻辑类）
     与**出怪（SC 132）**都改掉了，但这两条都还差实机这一脚 ——
     决定性判据见 [docs/battle-module-rootcause.md](docs/battle-module-rootcause.md) §3；
   - 若进度 100 仍不来：先看 `server.log` 有没有 `★★★ CLIENT_UNCAUGHT_ERROR ★★★`，
     堆栈落在 `SetDIYInfo` 还是 `a_3600/a_3604` 决定走哪条退路（同上 §3）；
   - ~~**出怪/波次推进**~~：SC 132 `NextEnmeyWave` 已还原并落地，
     规格见 [docs/battle-wave-driver.md](docs/battle-wave-driver.md)；实机只需确认"怪真的出来"。
   - `resource/*` 战斗资源回源。
   > ⚠️ 早期文档里"客户端 8709 上行 `cmd=2` 后跟自增帧序号"的**读法已被推翻**：
   > 把 94 条上行逐字节解出来后，`cmd` 是**第一字节**，实测只有 `cmd3`(进度) / `cmd12`(角色信息) /
   > `cmd9`；那个"自增序号"其实是 **cmd3 的进度值 1..100**。见 `battle-replica-plan.md` §5.4。
2. **补齐缺失 SWF**：见 `server/missing-swfs.txt`（`TDTaskUI/TDRankUI/TDFriendUI/TDMailUI/...`），
   打开对应功能会 404。
3. **离线独立播放器**：`tools/` 下已有独立 Flash 播放器，目标是脱离浏览器直接运行。
4. **`pendingCardNotify` 无状态化（需先能复现才改）**：见上文第十批与该文档 §10。
   现状是"清理点住在派发处、赋值点在 builder 内"，构成一笔可能跨请求泄漏的"欠通知"。
   **改之前必须先构造出可复现的泄漏路径**；要动 3 个 builder 签名 + 4 个调用点，
   属独立改动，应单独开任务。
5. **实机补验（离线断言已覆盖、真机未跑）**：保险金保星级、护佑符保材料、合成 `14849`
   不触发无限循环、以及第十二批的 129/130 进战场。这几条都需在真实客户端上各跑一次。
