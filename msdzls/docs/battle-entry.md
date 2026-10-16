# 进战斗链路（单机）

这份文档记录"从大厅进入一局战斗"的客户端流程与协议，作为把单机版推进到
**可开战**的依据。所有结论都标了反编译类/行号。

> 反编译范围：`TDCore`、`TDLoaderUI`（已全量）与本轮新增的 `TDTownUI`、
> `TDWorldMapUI`、`TDGameReadyUI`。用 `tools/decompile-swf.ps1` 可继续补其它 SWF。

## 一句话结论

客户端进战斗的核心报文是**逻辑服的 `SitDown`（msgID 8705）**：请求用 `a_2928`
编码，应答用 `a_2953` 解码。对电脑/新手模式允许直接 `roomID=tableID=-1`，由服务端
分配房间；回包成功后客户端才去加载战斗模块（`TDGameCoreUI`）。因此**只要把 8705
应答做对，就能把客户端从大厅推进到"加载战斗"**。

## 入口在哪

- 大厅控制器：`TDCore/scripts/com/aurora/ui/maogoutd/TDLobbyCoreUI.as`
- 新手/对电脑直开局（无房间）：
  `TDLobbyCoreUI.as:2752`
  `this.a_1206.a_2485(-1,-1,-1,0,"新手战斗","",[iGameMapID],a_1748.enmGameMode_vComputer);`
- 进入已有房间/桌：
  `TDLobbyCoreUI.as:5047`
  `this.a_1206.a_2485(serverID, roomID, tableID, -1, "", password, [mapID], gameMode, -1);`
- `a_1206` 是"游戏大厅控制器" `a_4767/a_2545.as`；`a_2485` 最终落到逻辑服协议
  `a_4770/b_177.as:192`，用 `a_2928` 编码，发 `b_154.a_148`（=8705）到逻辑连接。

## SitDown 请求（a_2928，msgID 8705）

字段顺序（`a_2928.encode` 的 property 数组）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| m_byACT | int8 | 动作标记，正常坐下为 0 |
| m_iRoomID | int32 | 房间号，-1 表示新开 |
| m_iTableID | int32 | 桌号，-1 表示新开 |
| m_bySeatID | int8 | 座位号 |
| m_byCanAdjust | int8 | 是否可调座 |
| m_iFcm | int8 | 防沉迷标记 |
| m_szTableKey | string(32) | 房间密码 |
| m_szTableName | string(32) | 桌名 |
| m_iGameMapID | int32 | 游戏地图 ID |
| m_byGameMod | int8 | 游戏模式（见下） |
| m_bLevel | int8 | 关卡难度 |
| m_byPlayerCount | int8 | 期望人数 |
| m_nMapListCount | int16 | 随机地图列表长度 |
| m_aryMapList | int32[] | 随机地图列表（`a_2928.a_868 = 6`，上限 6 个） |

游戏模式 `a_4720/a_1748`：`0=1v1(vs)`、`1=2v2`、`2=1vComputer`、`3=2vComputer`、
`4=Long`。新手/单人用 `2`。

> 注意：服务端把"整段解密数据"传给应答构造器，**前 4 字节是 sequence**，字段从偏移 4 开始。

## SitDown 应答（a_2953，msgID 8705）

`b_177.as:392`（`OnSitDown`）用 `a_2953` 解码。字段顺序：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| m_nResultID | int16 | 0=成功 |
| m_byACT | int8 | |
| m_iRoomID | int32 | 服务端分配的房间号 |
| m_iTableID | int32 | 桌号 |
| m_bySeatID | int8 | 座位号 |
| m_iSitdownSequence | int32 | 坐下序号 |
| **m_iCrossID** | int32 | **仅 decode 读取**（encode 端漏写，服务端必须补） |
| m_iMapID | int32 | 地图 ID（成功时） |
| m_byGameMode | int8 | 游戏模式 |
| m_bLevel | int8 | 难度 |
| m_nseatmask | int16 | 座位占用位掩码 |
| m_byPlayerCount | int8 | 玩家人数 |
| m_stPlayers[] | CPlayerDetail[] | 每名玩家（含本机） |

失败时（`m_nResultID != 0`）只跟一个 string(2048) 失败原因。

### CPlayerDetail（`com/aurora/protocol/game/CPlayerDetail.as`）

带 **2 字节长度前缀**（值 = 其后字段总字节数）。`iconType=0` 时不带 51/游戏头像字段
（`EnmFaceMask` 掩码 128/64）。字段顺序：uin(int32)、account(string32)、
playerName(string32)、flag(int16)、identity(int32)、birthDay(int32)、iconType(int8)、
zoneInfo(string40)、charming/achievement/happyBean/experiencePoint/51VIPScore/51Level/51VIPLevel
（各 int32）、playerID(int32)、tableID(int32)；若 tableID≥0 再跟 seat(int8)、status(int8)，
status 非 Free(0)/Observing(4) 时再跟 sitdownSequence(int32)；随后 point(uint64)、
win/lose/draw/escape/offline/money/flowerCount（各 int32）、extraUid(string32)、
goodId/gameVIPScore/gameVIPLevel（各 int32）。

> 单机实现里本机详情大小实测 **140 字节**（含前缀），与客户端 `encode()` 逐字节一致。

## 坐下成功之后

1. `b_177.OnSitDown`（`b_177.as:398-454`）：`setSitDown(response)`，把本机/他人详情
   以 `a_446/a_447` 内部流分发给"大厅适配器"，再派发 `EventType.a_576`（SitDownSuccess）。
2. `a_4767/a_2545.as:804`（`a_2538`）收到该事件：按 `serverID_roomID` 建/取 `gameLoader`，
   `a_829.a_2236` 取到加载器，取出 `b_152`（游戏大厅接口）与 `b_151`（游戏处理接口），
   再 `a_2237` 显示、`a_2240` 加载。
3. 战斗模块本体：`TDLoaderUI.as:478` 把 `LoadFilesList` 里的 `TDGameCoreUI`（本地
   `client-cache/TDGameCoreUI.swf`，**410 字节桩**) 交给 `TDLobbyCoreUI.a_3742`
   （要求 `length == 410`）→ `loadBytes`。
4. `a_4753/a_2179.as` 作为战斗资源加载器，再按需拉 `resource/<mapID>.swf`（战斗背景）、
   `resource/<cardID>.swf`（卡片）、`resource/avatar/*.swf`、`resource/props/*.swf`、
   `TDGame2V2BattleUI.swf`。这些走本地 HTTP 的"本地优先 + 回源镜像"即可补齐。

## 相关逻辑服报文（同一房间/对局体系）

| msgID | 常量 | 用途 | 请求/应答类 |
| --- | --- | --- | --- |
| 8449 | a_128 | 进入房间 | a_2913 → a_2938 |
| 8450 | a_129 | 离开房间 | a_2919 → a_2944 |
| 8452 | a_131 | 房间/桌视图翻页 | a_2936 → a_2919? |
| 8464 | a_135 | 取桌信息 | a_2917 → a_2919 |
| 8466 | a_137 | 取房间人数 | a_2916 → a_2941 |
| 8705 | a_148 | 坐下 | a_2928 → a_2953 |
| 8706 | a_149 | 站起 | a_2929 → a_2954 |
| 8725 | a_220 | 设置座位状态（准备） | a_2927 → ? |
| 8731 | a_143 | 对局数据上传 | a_2976 → ? |

### "正在登陆游戏服务器"提示什么时候消失

大厅/进房期间客户端会显示 `zh_CN.xml` 的 `0x00603c`（"正在登陆游戏服务器,请稍候"）。
它由两个地方弹出：`a_2545.a_2493`（角色登录游戏服）与 `TDLobbyCoreUI.a_2483`（进房间），
由 `TDLobbyCoreUI.a_3745()`（hideTip）关闭。真正的关闭时机是**进入房间的应答**：

```
EnterRoom(8449, a_2913) → 应答 a_2938
  → a_2610.a_2611 派发 EventType.a_574 { iServerID, iRoomID, iHeadTableID, iTailTableID }
  → TDLobbyCoreUI.a_3138(serverID, roomID, headTableID, tailTableID)
  → this.a_3745()   // 隐藏"登录游戏服务器"
```

所以只要客户端进房间（`8449`）收不到应答，这条提示就会一直挂着。前置的
`GET_ROOM_PLAYER_COUNT(8466)` 也必须是成功应答（空房间列表即可），否则房间列表不会渲染。

## 当前进度与后续

- **已实现**：逻辑服 `SitDown`(8705) 应答 `a_2953` + `CPlayerDetail` 编码，已在
  `verify-handlers.mjs` 端到端校验（17/17 通过，含"地图/模式/玩家结构字节对齐"）。
- **待做**：
  1. 坐下后的 `StandUp/设座位状态/取桌信息` 等应答，保证房间状态自洽；
  2. 开局下发：`匹配数据/游戏开始` 相关报文（配合 `a_2179` 的资源清单）；
  3. `resource/*` 战斗资源回源补齐（地图背景、卡牌、头像、道具）；
  4. 用真实 Flash 客户端复测"世界地图选关 → 开局"整链。
