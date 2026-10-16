# 美食大战老鼠 — 战斗协议规格（Battle Protocol Spec）

> 逆向来源：`msdzls/decompiled/TDCore/scripts/`（AS3 反编译）
> 目标：为私有服务端实现提供**可直接编码的字节级规格**。
> 本文所有字节序均为 **Big-Endian**（AS3 `ByteArray.writeShort/writeInt` 默认网络字节序）。

---

## 0. 修正记录（重要）

早期 `docs/battle-entry.md` 把 **两层消息号**混为一谈。实际是两层独立体系：

| 层 | 载体 | 消息号空间 | 作用 |
|---|---|---|---|
| **L1 逻辑服报文** | `EnmProxyCmd` (`a_4717/EnmProxyCmd.as`) | 0 ~ 242 | 大厅/桌位/进房通知，UI 层 |
| **L2 游戏数据报文** | `b_102` (`a_4718/b_102.as`) | 13 ~ 160 | 战斗内所有同步，战场层 |

**服务端实现开局必须发 L2 的 `129 (LoadStart)`，只发 L1 的 `1 (SC_StartGame)` 只会切 UI、不会载入战场。**

---

## 1. 嵌套结构总览（三层）

服务端发出的一个 TCP 包，从外到内共三层封装：

```
┌─ 第3层 传输帧  a_2220.a_2201() ────────────────────────────┐
│  [httpHead 1B][a_2670 头 24B][XXTEA 加密区]                  │
│                              └─ 加密区内是 ↓                 │
│  ┌─ 第2层 游戏数据包装  a_2926 ────────────────────────┐   │
│  │  [int32 roomID][int32 tableID][int16 bodyLen][body] │   │
│  │                                     └─ body 是 ↓    │   │
│  │  ┌─ 第1层 游戏数据体 ─────────────────────────┐    │   │
│  │  │  [int8 b_102 命令号][协议体]                 │    │   │
│  │  │                 └─ 由 a_2053 查表分发        │    │   │
│  │  └──────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

**⚠️ 仅 `b_154.a_152 (=8709)` 走第 2 层包装。** 其余 L1 报文（如 SitDown 8705）只到第 3 层。

---

## 2. 调用链（已逐跳验证）

```
服务端 ──逻辑服报文──> TDLobbyCoreUI (EnmProxyCmd 消息号)
                          │  enmProxyCmd_SC_StartGame = 1
                          ▼
                       a_4763/a_2445.as:500 与 :574
                          │  this._pGameInstance.a_1842(protocalBuffer)
                          ▼
                       a_4753/a_2178.as:104  a_1842(pbyData) → a_759.a_2055(pbyData)
                          ▼
                       a_4753/a_2053.as:138  a_2055(protocolBuffer)
                          │  var iMessageID = int(a_2664.decode_uint8(protocolBuffer));
                          │  if (this.a_748[iMessageID]) this.a_748[iMessageID](protocolBuffer);
                          ▼
                       a_748 查表分发（注册于 a_2053 构造函数:79-112）
                          ▼
    129 → a_2087 → a_2179.a_2087(a_2698)   载入战场
    130 → a_2088 → a_2179.a_2088(a_2695)   开战
    128 → OnGameStepLock                     帧同步锁步
```

**关键点**：`a_2055` 先 `decode_uint8` 取一个字节作为命令号，所以 **L2 报文的第一个字节就是 `b_102` 命令号**。

---

## 2. L2 命令号全表（`a_4718/b_102.as`，140 行完整覆盖）

### 2.1 客户端 → 服务端（CS）

| 值 | 常量名 | 含义 | 编码函数 |
|---|---|---|---|
| 13 | `enmGameDataCmd_CS_PickupProps` | 拾取道具 | `a_2053.as:409` |
| 23 | `enmGameDataCmd_CS_RequestLaunchSkill` | 请求放技能 | `a_2053.as:532` |
| 24 | `enmGameDataCmd_CS_SecrityCode` | 反外挂校验码请求 | `a_2053.as:544` |
| 25 | `enmGameDataCmd_CS_ChangeSecrityCode` | 更换校验码 | `a_2053.as:552` |
| 27 | `enmGameDataCmd_CS_PostPlayerEnergyValue` | 上报能量值 | `a_2053.as:559, 571` |
| 28 | `enmGameDataCmd_CS_DamageValidate` | 伤害校验 | `a_2053.as:287` |
| 29 | `enmGameDataCmd_CS_InputSecrityCode` | 输入校验码应答 | `a_2053.as:544` |
| 30 | `enmGameDataCmd_CS_BOSSDamage` | BOSS 伤害 | `a_2053.as:252` |
| 32 | `enmGameDataCmd_CS_EntityStateChange` | 实体状态变更 | `a_2053.as:315` |

> 未命名常量 `b_103`~`b_124` = 0~22，`b_104`=1、`b_125` 起为 SC 段。这些是保留/未使用号段。

### 2.2 服务端 → 客户端（SC）

| 值 | 常量名 | 含义 | 处理函数 |
|---|---|---|---|
| **128** | `enmGameDataCmd_SC_StepSync` | **帧同步锁步** | `OnGameStepLock` (`a_2053.as:82`) |
| **129** | `b_125` | **LoadStart 载入战场** | `a_2087` (`a_2053.as:80`) |
| **130** | `b_126` | **GameStart 开战** | `a_2088` (`a_2053.as:81`) |
| 131–150 | `b_127`~`b_146` | 战场各类通知 | `a_2089`~`a_2108` |
| 151 | `enmGameDataCmd_SC_PlayerLaunchSkill` | 有人放技能 | `OnPlayerLaunchSkillNotify` |
| 152 | `enmGameDataCmd_SC_SecrityCode` | 下发校验码 | `OnSecrityCodeNotify` |
| 153 | `enmGameDataCmd_SC_SecrityCodeResult` | 校验码结果 | `OnSendSecrityCodeResultNotify` |
| 154 | `enmGameDataCmd_SC_AddGameEnergy` | 增加能量 | `OnAddGameEnergyNotify` |
| 155 | `enmGameDataCmd_SC_NotifyPlayerEnergyValue` | 玩家能量值 | `OnPlayerEnergyValueNotify` |
| 156 | `enmGameDataCmd_SC_GameMapLimit` | 地图限制 | `OnGameMapLimitNotify` |
| 157 | `enmGameDataCmd_SC_SendSecrityCode` | 要求上传校验码 | `OnSendSecrityCodeNotify` |
| 158 | `enmGameDataCmd_SC_ConsbenLimit` | 消耗限制 | `OnConsbenLimitNotify` |
| 159 | `enmGameDataCmd_SC_DIYNextEnmeyWave` | DIY 下一波敌潮 | `OnDIYNextEnmeyWaveNotify` |
| 160 | `enmGameDataCmd_SC_EntityStateChange` | 实体状态变更 | `OnEntityStateChange` |

> **注意 `b_102.as` 中 `enmGameDataCmd_SC_EntityStateChange = 160` 与 `:128` 行 `enmGameDataCmd_SC_ConsbenLimit=158`、`:122` 行 `SC_DIYNextEnmeyWave=159` 定义顺序与数值顺序不一致，以数值为准。**

---

## 3. L1 逻辑服命令表（`a_4717/EnmProxyCmd.as`，全文件仅 11 个常量）

| 值 | 常量名 | 含义 |
|---|---|---|
| 0 | `a_401` | 报文头标记（`a_2445.as:141, 631` 写入） |
| 1 | `enmProxyCmd_SC_StartGame` | 开始游戏（切 UI） |
| 2 | `enmProxyCmd_SC_EndGame` | 结束游戏 |
| 17 | `enmProxyCmd_SC_OtherPlayerSitdown` | 他人入座 |
| 18 | `enmProxyCmd_SC_OtherPlayerStandUp` | 他人离座 |
| 19 | `enmProxyCmd_SC_OtherReady` | 他人准备 |
| 33 | `enmProxyCmd_SC_UpdatePlayerDetail` | 更新玩家详情 |
| 49 | `enmProxyCmd_BothWay_Chat` | 聊天（双向） |
| 65 | `enmProxyCmd_BothWay_MagicShowMessage` | 魔法表情（双向） |
| 241 | `enmProxyCmd_BothWay_MessageLoopTest` | 回环测试 |
| 242 | `enmProxyCmd_BothWay_TestMessage` | 测试消息 |

`a_2445.as:470-493` 的分发 switch 确认：`StartGame`/`EndGame`/`OtherPlayerSitdown`/`OtherPlayerStandUp`/`OtherReady`/`UpdatePlayerDetail`/`MagicShowMessage`。

---

## 4. 编码原语语义（`com/aurora/protocol/a_2664.as`）

| 原语 | 字节数 | 说明 |
|---|---|---|
| `encode_int8` / `decode_int8` | 1 | `writeByte` / `readByte`（**有符号**） |
| `encode_uint8` / `decode_uint8` | 1 | `writeByte` / `readUnsignedByte` |
| `encode_int16` / `decode_int16` | 2 | `writeShort` / `readShort`（有符号 BE） |
| `encode_uint16` / `decode_uint16` | 2 | `writeShort` / `readUnsignedShort` |
| `encode_int32` / `decode_int32` | 4 | `writeInt` / `readInt`（有符号 BE） |
| `encode_uint64` / `decode_uint64` | 8 | 高 4 字节 + 低 4 字节，`high*2^32+low` |
| `encode_string` | 2+N | `writeUTF`：**前缀 2 字节 BE 长度（长度已含结尾 `\x00`）**，内容 UTF 字节 + `\x00` |
| `decode_string` | 2+N | 先 `readShort` 取长度，再 `readUTFBytes(length)`；`length<=0` 返回 `null` |

### 4.1 `encode_string` 精确行为（易踩坑）

```
若 src_str == null            → src_str = ""
否则若 src_str.length >= max  → 截断到 max-1 字符后追加 "\x00"，temp_len = max
否则                          → src_str 追加 "\x00"，temp_len = src_str.length+1
byte_array.writeUTF(src_str)  ← 写入 2 字节长度(含\0) + UTF 字节
```

**`max_length` 是字符数上限（含 `\0`），不是字节数。** `writeUTF` 的长度前缀由 AS3 自行计算。服务端实现时若手写字节，必须保证前缀 = 实际写入的 UTF 字节数（含 `\0`）。

### 4.2 `decode_string` 容错行为

`string_length <= 0` 时直接 `return null` 且**不消费后续字节**（但已读了 2 字节长度）。`string_length > max_length` 时按 `max_length` 读取。

---

## 5. SitDown 应答体 `a_2953`（msgID 8705 的应答）

**文件**：`com/aurora/protocol/logicserver/a_2953.as`（102 行）
**请求体**：`a_2928.as`（62 行）

### 5.1 字段表

| 偏移 | 字段 | 类型 | 条件 |
|---|---|---|---|
| +0 | `m_nResultID` | int16 | 恒有。`0` = 成功，非 0 = 失败 |
| +2 | `m_byACT` | int8 | 恒有 |
| +3 | `m_iRoomID` | int32 | 恒有 |
| +7 | `m_iTableID` | int32 | 恒有 |
| +11 | `m_bySeatID` | int8 | 恒有 |
| +12 | `m_iSitdownSequence` | int32 | 恒有 |
| — | **分支** | | |
| **成功分支** `m_nResultID == 0` | | | |
| +16 | `m_iMapID` | int32 | |
| +20 | `m_byGameMode` | int8 | |
| +21 | `m_bLevel` | int8 | |
| +22 | `m_nseatmask` | int16 | |
| +24 | `m_byPlayerCount` | int8 | |
| +25 | `m_stPlayers[]` | `CPlayerDetail × m_byPlayerCount` | 变长，见 §5.3 |
| **失败分支** `m_nResultID != 0` | | | |
| +16 | `m_szReasonMsg` | string(2048) | |

### 5.2 ⚠️ encode/decode 不对称（逆向发现的关键缺陷）

```as3
// encode() 第 46 行 — 只有 6 个字段
var propertyArray:Array = [["m_nResultID","int16"],["m_byACT","int8"],["m_iRoomID","int32"],
                           ["m_iTableID","int32"],["m_bySeatID","int8"],["m_iSitdownSequence","int32"]];
if(this.m_nResultID == 0) { ... } else { propertyArray.push(["m_szReasonMsg","string",2048]); }

// decode() 第 73 行 — 多读一个字段，且不在条件分支内
this.m_iSitdownSequence = a_2664.decode_int32(byte_array);
this.m_iCrossID = a_2664.decode_int32(byte_array);      // ← encode 从不写这个
if(this.m_nResultID == 0) { ... }
```

**结论**：`m_iCrossID` 是**只读字段**——客户端解码时无条件读取 4 字节，而客户端的 `encode()` 从不写出它。

**对服务端实现的影响（**已用实测验证**，见 §17）**：

实测：若应答体在 `m_iSitdownSequence` 后**不写** 4 字节 `m_iCrossID`，客户端**不会崩溃**，而是发生**静默错位**——比崩溃更危险：

| 字段 | 期望 | 实测（省略 m_iCrossID 后） |
|---|---|---|
| `m_iCrossID` | 0 | `14680065`（读到了 `m_iMapID` 的值） |
| `m_iMapID` | 14680065 | `65791`（被污染） |
| `m_byGameMode` | 0 | `1` |
| `m_byPlayerCount` | 2 | **`0`** ← 玩家全部丢失 |
| 消费字节 | 146 | **29 / 146** ← 报文被提前放弃 |

**结论：`m_iCrossID` 必须写 4 字节（私服填 `0`）。** 单机/跨服两种模式都填 0 即可，客户端只读不用。

### 5.3 `CPlayerDetail` 内嵌格式（`com/aurora/protocol/game/CPlayerDetail.as`，334 行）

**与 `a_2953` 不同：`CPlayerDetail` 自带 2 字节长度前缀。**

```
+0                    int16  playerDetailSize   ← 后续总长度（不含本 2 字节）
+2                    int32  m_iUin
+6                    string(32)  m_szAccount
+?                    string(32)  m_szPlayerName
+?                    int16  m_nFlag
+?                    int32  m_iIdentity
+?                    int32  m_iBirthDay
+?                    int8   m_byIconType
   ┌─ 条件：if ((m_byIconType & EnmFaceMask.enmFaceMask_51Picture)
   │            || (m_byIconType & EnmFaceMask.enmFaceMask_GamePicture))
+?   │                string(32)  m_szFaceVersion
+?   │                string(96)  m_szIconURL
   └─
+?                    string(40)  m_szZoneInfo
+?                    int32  m_iCharming
+?                    int32  m_iAchievement
+?                    int32  m_lHappyBean          ← encode_int32（注意：不是 uint64）
+?                    int32  m_iExperiencePoint
+?                    int32  m_i51VIPScore
+?                    int32  m_i51Level
+?                    int32  m_i51VIPLevel
+?                    int32  m_iPlayerID
+?                    int32  m_iTableID
   ┌─ 条件：if (m_iTableID >= 0)
+?   │                int8   m_bySeat
+?   │                int8   m_byStatus
+?   │   ┌─ 条件：if (m_byStatus != enmPlayerStatus_Free
+?   │   │            && m_byStatus != enmPlayerStatus_Observing)
+?   │   │            int32  m_iSitdownSequence
+?   │   └─
+?   └─
+?                    uint64 m_iPoint               ← 8 字节
+?                    int32  m_iWinRound
+?                    int32  m_iLoseRound
+?                    int32  m_iDrawRound
+?                    int32  m_iEscapeRound
+?                    int32  m_iOfflineRound
+?                    int32  m_iMoney
+?                    int32  m_iFlowerCount
   ┌─ 条件：同 m_byIconType 的 mask 判断
+?   │                string(96)  m_szFaceURL50
+?   │                string(96)  m_szFaceURL130
   └─
+?                    string(32)  m_szExtraUid
+?                    int32  m_iGoodId
+?                    int32  m_iGameVIPScore
+?                    int32  m_iGameVIPLevel
+?                    ← 结尾回填 int16 长度到 +0（第 191-194 行）
```

**解码结束校验（第 254-258 行）**：
```as3
if(byte_array.position - start > playerDetailSize) { return false; }
byte_array.position = start + playerDetailSize;   // ← 强制对齐，忽略多余尾部
```

> **这是对服务端友好的设计**：即使服务端多写了字段，只要 `playerDetailSize` 声明正确，客户端会跳到正确位置继续读下一个玩家。**但 `playerDetailSize` 必须等于实际写入字节数**，否则后面的 `m_stPlayers` 全部错位。

### 5.4 `m_iTableID < 0` 的陷阱（对电脑/新手模式）

`CPlayerDetail.decode` 第 228 行 `if(this.m_iTableID >= 0)` 才读 `m_bySeat`/`m_byStatus`。
而 `docs/battle-entry.md` 记录：**对电脑/新手模式允许 `roomID=tableID=-1` 由服务端分配**。

**若服务端在 `m_stPlayers[]` 里给玩家下发 `m_iTableID = -1`**，客户端会跳过 seat/status/sitdownSequence 三个字段的读取。

**实测结果（见 §17）**：**不会越界崩溃**（因为 `CPlayerDetail` 自带 `playerDetailSize` 长度前缀，末尾会强制对齐），但：

| 字段 | 实测 |
|---|---|
| `m_iTableID` | `-1` |
| `m_bySeat` | **`undefined`**（缺失） |
| `m_byStatus` | **`undefined`** ← 座位状态无法建立 |
| 后续字段（如 `m_iExperiencePoint`） | 仍正确（长度前缀救了它） |
| 字节对齐 | 144/144，无越界 |

**结论：仍需为 `m_stPlayers[]` 每个玩家填真实 `m_iTableID >= 0`**，否则该玩家的**座位号与状态全部丢失**，UI 无法落座——虽不崩溃，但战斗进不去。

---

## 6. 反外挂 `SecrityCode` 子系统（服务端必须实现）

| 方向 | 值 | 含义 |
|---|---|---|
| CS | 24 | `SecrityCode` 请求 |
| CS | 25 | `ChangeSecrityCode` 更换 |
| CS | 29 | `InputSecrityCode` 输入应答 |
| SC | 152 | `SecrityCode` 下发 |
| SC | 153 | `SecrityCodeResult` 结果 |
| SC | 157 | `SendSecrityCode` 要求上传 |

编码点：`a_2053.as:544`（CS 24/29 共用）、`:552`（CS 25）。
**若服务端不应答或应答错误，战斗中途会被踢出。**

---

## 7. 战场资源版本

```as3
// a_4753/a_2179.as:122
private const m_strVersion:String = "0000201601010101";
```

用于 `TDGameReadyUI.swf?v=` （`:1386`）与 `loadTask.url += "?v="`（`:1881`）。
**服务端下发的 version 字段必须与此一致，否则战场资源 404。**

---

## 8. 服务端实现最小开局序列（Checklist）

1. 客户端发 **L1 `SitDown`(msgID 8705)**，请求体按 `a_2928.as` 编码。
2. 服务端回 **L1 SitDown 应答**，应答体按 `a_2953` 编码，注意：
   - `m_nResultID = 0`
   - **必须插入 4 字节 `m_iCrossID`**（§5.2）
   - `m_iMapID` / `m_byGameMode` / `m_bLevel` / `m_nseatmask` / `m_byPlayerCount`
   - `m_stPlayers[]` 每人用 `CPlayerDetail` 编码，**`m_iTableID` 必须 >= 0**（§5.4），且 `playerDetailSize` 回填正确
3. 服务端发 **L1 `enmProxyCmd_SC_StartGame = 1`** 切 UI。
4. 服务端发 **L2 `129 (LoadStart)`**，报文体为 `a_2698`（`com/aurora/protocol/game/maogoutd/a_2698.as`），**第一个字节 = 129**。
5. 服务端发 **L2 `130 (GameStart)`**，报文体为 `a_2695`。
6. 之后按帧率发 **L2 `128 (StepSync)`**，报文体 `CNotifyGameStep`。
7. 处理 CS 24/25/29 反外挂握手（SC 152/153/157）。

---

## 9. 条件字段判定用的枚举常量（已确认）

全部位于 `a_4717/`。

### `EnmFaceMask.as`
| 值 | 常量名 |
|---|---|
| 64 (0x40) | `enmFaceMask_GamePicture` |
| 128 (0x80) | `enmFaceMask_51Picture` |

**判定表达式**（`CPlayerDetail.as:150, 182, 213, 245`）：
```as3
if ((m_byIconType & 64) || (m_byIconType & 128))
```
→ 决定是否写入/读取 `m_szFaceVersion` + `m_szIconURL`（共 2 处，一前一后 4 个字符串字段）。

> **私服最简路径：`m_byIconType = 0`**，两个条件均为假，直接跳过全部 4 个字符串字段，报文最短且无歧义。

### `EnmPlayerStatus.as`
| 值 | 常量名 | 含义 |
|---|---|---|
| 0 | `enmPlayerStatus_Free` | 自由（未入座） |
| 1 | `enmPlayerStatus_Seated` | 已入座 |
| 2 | `enmPlayerStatus_ReadyToPlay` | 已准备 |
| 3 | `enmPlayerStatus_Playing` | 游戏中 |
| 4 | `enmPlayerStatus_Observing` | 观战 |
| 5 | `enmPlayerStatus_Offline` | 掉线 |

**判定表达式**（`CPlayerDetail.as:169, 232`）：
```as3
if (m_byStatus != 0 && m_byStatus != 4)   // 非 Free 且非 Observing
```
→ 才写入/读取 `m_iSitdownSequence`。

> **私服开局应下发 `m_byStatus = 3 (Playing)`**，这样 `m_iSitdownSequence` 会被包含（与 `a_2953` 顶层也带 `m_iSitdownSequence` 保持一致）。

### `EnmPlayerDetailSection.as`
| 值 | 常量名 |
|---|---|
| 0 | `enmPlayerDetailSection_Finish` |
| 1 | `enmPlayerDetailSection_Base` |
| 2 | `enmPlayerDetailSection_Intrinsic` |
| 3 | `enmPlayerDetailSection_Statistics` |
| 4 | `enmPlayerDetailSection_Identity` |
| 8 | `enmPlayerDetailSection_Table` |
| 9 | `enmPlayerDetailSection_SitdownSequence` |
| 10 | `enmPlayerDetailSection_GameVipDetail` |
| 11 | `enmPlayerDetailSection_Profile` |

仅用于 `CPlayerDetail.a_2690()`（增量分段更新，第 267-331 行），**与 `a_2953` 的整包 `decode()` 路径无关**。私服若只实现整包路径可忽略。

`a_2690()` 的分段循环结构（供参考）：
```
循环：读 int8 section → 若 == Finish(0) 跳出
      读 int8 bySectionLength
      switch(section) 按上表读对应字段
      （section == Intrinsic 时先手工读 PlayerID + 32字节 Account + 32字节 Name + 长度前缀处理）
```

---

## 10. 战场报文帧格式（L2）

**所有 L2 报文 = `[int8 cmd][body]`**，`cmd` 取自 `b_102`。已由 `a_2053.as` 全部编码点验证，例如：

```as3
// a_2053.as:405-415  (CS 13 拾取道具)
var encodeBuffer:ByteArray = new ByteArray();
a_2664.encode_int8(encodeBuffer, b_102.enmGameDataCmd_CS_PickupProps);   // ← 先写 1 字节命令号
var req:a_2722 = new a_2722();
req.m_nPropStuffSequence = nPropOrStuffSequece;
req.encode(encodeBuffer, encodeLengh);                                   // ← 紧跟报文体
return this.m_stTDLobby.a_2240(encodeBuffer);
```

**对比 L1**：L1 报文走 `EnmProxyCmd`，`a_2445.as:141/631` 写的头标记是 `a_401 = 0`。

---

## 11. `a_2698` — LoadStart 报文体（L2 cmd=129）

**文件**：`com/aurora/protocol/game/maogoutd/a_2698.as`（51 行）
**encode/decode 完全对称**（同一个 `propertyArray` 字面量）。

| 顺序 | 字段 | 类型 | 说明 |
|---|---|---|---|
| 1 | `m_nGameMode` | int16 | 游戏模式 |
| 2 | `m_nSelectCardIDCount` | int16 | **驱动下一个数组的长度** |
| 3 | `m_arrSelectCardIDs` | `uint32[]` | 长度由 #2 决定，不足补 0 |
| 4 | `m_nSelectPropIDCount` | int16 | 驱动下一个数组 |
| 5 | `m_arrSelectPropIDs` | `uint32[]` | 长度由 #4 决定 |
| 6 | `m_nAvatarInfoCount` | int16 | 驱动下一个数组 |
| 7 | `m_arrAvatarInfoArray` | `CAvatarInfo[]`（**nosize**） | 长度由 #6 决定，无长度前缀 |
| 8 | `m_RandomSeed` | int32 | 随机种子 |

### 11.1 `a_2665/a_2666` 计数机制（关键）

标量字段在编码时会**把自身值存入 `preValue`**，供紧随其后的数组当元素个数：

```as3
// a_2664.as:325-329  —— 标量分支
else {
   a_2664["encode_" + item[1]](byte_array, obj[item[0]]);
   preValue = int(obj[item[0]]);      // ← 标量值成为下一个数组的长度
}
```

数组分支（`:279-290`）：
```as3
for each(inner in obj[item[0]]) { if(preValue-- <= 0) break; encode(...); }  // 按 preValue 截断
while(preValue-- > 0) { a_2664["encode_" + item[1][0]](byte_array, 0); }     // 不足则补 0
```

**服务端实现要点**：
- `Count` 字段与实际数组长度**不一致时不会报错** —— 多出的元素被丢弃，缺少的补 0。
- 但 **decode 侧（`:369`）完全按 `preValue` 循环**，所以**服务端必须让 Count 与实际元素数一致**，否则客户端会读越界或错位。
- `"nosize"` 标记的对象数组**不写 2 字节长度前缀**（对比 `CPlayerDetail` 的 `m_stPlayers` —— 那里走的是**非** nosize 路径，**有**前缀）。

### 11.2 `CAvatarInfo`（`maogoutd/CAvatarInfo.as`，60 行）

| 顺序 | 字段 | 类型 | 说明 |
|---|---|---|---|
| 1 | `m_bySeatID` | int8 | 座位号 |
| 2 | `m_nMemorySize` | uint16 | 下面 blob 的**压缩后**字节数 |
| 3 | `m_byarrPlayerAvatarInfoByteArray` | memory | **zlib 压缩的 AMF 对象** |
| 4 | `m_byCardsCount` | int8 | 驱动下一个数组 |
| 5 | `m_arrGameCardInfoArray` | `CGameCardInfo[]`（nosize） | 卡组 |
| 6 | `m_isAutoPickUpEnergy` | int8 | 自动拾取能量 |
| 7 | `m_isAutoPickUpProps` | int8 | 自动拾取道具 |
| 8 | `m_nWeaponSkillCount` | int16 | 驱动下一个数组 |
| 9 | `m_arrWeaponSkillInfo` | `CWeaponSkillInfo[]`（nosize） | 武器技能 |

**⚠️ blob 是 AS3 `ByteArray.compress()`**（`CAvatarInfo.as:39`），即 **zlib/deflate**，`decode` 侧 `uncompress()`（`:49`）。**服务端必须用 zlib 压缩**，且 `m_nMemorySize` = **压缩后**长度。

**⚠️⚠️ 压缩前的内容是 AMF3，不是 AMF0。** `readObject()`/`writeObject()` 走 `ByteArray.objectEncoding`，AS3 默认值为 **`ObjectEncoding.AMF3`**。实测（§17）用 AMF0 编码会导致 `AMF3 未知类型标记` 解码失败。

AMF3 标记速查（服务端手写时需要）：

| 标记 | 类型 | 编码 |
|---|---|---|
| `0x01` | null | — |
| `0x02` / `0x03` | false / true | — |
| `0x04` | integer | 后跟 U29 变长整数（≤29 位） |
| `0x05` | double | 后跟 8 字节 BE 双精度 |
| `0x06` | string | U29(长度<<1 \| 1) + UTF-8 字节 |
| `0x09` | dense array | U29(长度<<1 \| 1) + `0x01`(空关联表) + 元素 |
| `0x0A` | object | U29 头 + traits + 动态成员 |

AMF3 对象头 `U29O` 位布局：`低1位`=引用标志(内联写 1)、`次1位`=traits 引用标志(内联写 1)、`高3位`=sealed 成员数、`位0x08`=`dynamic` 标志。

```js
// 动态对象、N 个 sealed 成员：
U29( (N << 4) | 0x03 )        // 0x03 = 内联(1) + traits内联(2) + dynamic(0x08 置位)
```
> **私服最简路径**：把 blob 写成**全动态对象**（sealed 成员数 = 0，dynamic = 1），所有 21 个字段都当动态成员写，最后以空字符串 key + `0x01` 结束。

**AMF3 整数范围**：`-2^28 .. 2^28-1`（U29 有符号）。超出必须用 `0x05` double。**21 个 avat​ar 字段都是小整数，走 `0x04` U29 即可。**

`"memory"` 类型的长度计算（`a_2664.as:322`）：
```as3
size = (item[3]=="nosize" || preValue > item[2]) ? int(item[2]) : int(preValue);
```
此处 `item[2]` 未给出 → `int(undefined)`，`preValue` 已被 `m_nMemorySize` 设为压缩后长度 → **实际按 `preValue` 写**。

### 11.3 blob 反序列化后的字段（`a_2179.as:672-698`）

`decode` 后 `readObject()` 得到一个 AMF 对象，客户端读取以下字段：

```
m_iCoverallType        m_iGunType          m_iSuperGunType     m_iShieldType
m_iHatType             m_iEyeGlassesType   m_iFaceType         m_iFaceDecorationType
m_iEyeType             m_iHairType         m_iBodyType         m_iAureolaType
m_iWingType            m_iLandInsuranceType m_iWaterInsuranceType
m_numAttackForce       m_numDefenseForce   m_byShovelType
m_arrGenInfoArray      m_arrCardEffectAddArray   m_arrPetInfoArray
```

另有 4 个从 `CAvatarInfo` 直接取的字段（不在 blob 内）：
`m_isAutoPickUpEnergy`、`m_isAutoPickUpProps`、`m_arrCardInfoArray`（= `m_arrGameCardInfoArray`）、`m_bySeatID`。

> 反编译源码另见 `a_2698` 的对照常量 `b_115 = 14`（CS PostAvatarInfo，`a_2053.as:421`），`a_2713` 是上行对应体（`m_nMemorySize` int16 + memory）。

### 11.4 `CGameCardInfo` / `CWeaponSkillInfo`

```
CGameCardInfo      : m_iCardID int32 | m_byCardDegreeLevel int8 | m_byCardSkillLevel int8 | m_byCardGradeLevel int8   → 7 字节
CWeaponSkillInfo   : m_iWeaponSkillID int32 | m_iWeaponSkillLevel int32                                        → 8 字节
```

---

## 12. `a_2695` — GameStart 报文体（L2 cmd=130）

**文件**：`maogoutd/a_2695.as`（39 行）— encode/decode 对称。

| 顺序 | 字段 | 类型 | 说明 |
|---|---|---|---|
| 1 | `m_nTotalIntruderWaveNum` | int16 | 总波数（老鼠入侵波数） |
| 2 | `m_RandomSeed` | int32 | 随机种子 |
| 3 | `m_iBuffId` | int32 | BUFF ID |

**无数组字段，无计数机制**，纯定长 10 字节。

---

## 13. `CNotifyGameStep` — StepSync 报文体（L2 cmd=128）

**文件**：`maogoutd/CNotifyGameStep.as`（35 行）— **单字段**

| 类型 | 字段 |
|---|---|
| int32 | `m_GameStep` |

```as3
public function decode(byte_array:ByteArray, decode_length:int) : Boolean {
   this.m_GameStep = a_2664.decode_int32(byte_array);
   return true;
}
```

**锁步闸门（单机可省略）**：原版用于 PvP 防作弊，服务端按帧率广播 `[128][int32 帧号]`。

> **2026-10-14 更正**：此前这里写作「这是战斗推进的心跳」，**错误**。实测证据：
> - 客户端处理器是空桩 —— `TDGame2V2BattleUI.as:3576-3579` `public function OnGameStepLock(...):Boolean { return true; }`，什么都不做。
> - 前置门使 128 在 130 之前被静默丢弃 —— `a_2179.as:894-900` 有 `if(this.m_isGaming)`，而 `m_isGaming` 只在 `a_2088`（130 落地）`:889` 置 true。
> - 真正的推进是客户端本地 100Hz 时钟 —— `TDGame2V2BattleUI.as:3581 a_3416(Event)`，内含 `:3595-3599 while(iCheckTimes-- > 0) ++this.a_1010;`、`:3600 if(this.a_1010 % 3 == 0)`。
> - 运行日志佐证：整段战斗客户端本地帧计数 1→99 推进，服务端**一帧 128 都没发**（`server.log`）。
>
> ⇒ **单机复刻完全不发 128**（`local-server.mjs` 只发 129 + 130）。详见 `battle-replica-plan.md §4`。

---

## 14. `a_2928` — SitDown 请求体（服务端必须解析）

**文件**：`com/aurora/protocol/logicserver/a_2928.as`（62 行）
**注意 `decode()` 返回硬编码 `false`（第 53 行）—— 客户端只发不收。**

| 顺序 | 字段 | 类型 | 说明 |
|---|---|---|---|
| 1 | `m_byACT` | int8 | 动作类型 |
| 2 | `m_iRoomID` | int32 | 房间号（**对电脑/新手模式可为 -1**） |
| 3 | `m_iTableID` | int32 | 桌号（**可为 -1，由服务端分配**） |
| 4 | `m_bySeatID` | int8 | 请求座位 |
| 5 | `m_byCanAdjust` | int8 | 是否可调整 |
| 6 | `m_iFcm` | int8 | 防沉迷标志 |
| 7 | `m_szTableKey` | string(32) | 桌 KEY |
| 8 | `m_szTableName` | string(32) | 桌名 |
| 9 | `m_iGameMapID` | int32 | 请求地图 ID |
| 10 | `m_byGameMod` | int8 | 游戏模式 |
| 11 | `m_bLevel` | int8 | 关卡 |
| 12 | `m_byPlayerCount` | int8 | 玩家数 |
| 13 | `m_nMapListCount` | int16 | **驱动下一个数组** |
| 14 | `m_aryMapList` | `int32[]` | 可选地图列表，长度由 #13 决定 |

**`public static const a_868:int = 6;`**（第 10 行）—— 文件内唯一的静态常量，推测为**该报文的结构版本号或字段数**（14 个字段不符，故更可能是协议子版本）。服务端可忽略。

---

## 15. 服务端实现最小开局序列（定稿 Checklist）

**所有 L2 帧 = `[int8 cmd][body]`。所有多字节整数为 Big-Endian。**

### 第 1 步：接收 SitDown 请求
解析 `a_2928`（§14，14 字段）。注意 `m_iRoomID`/`m_iTableID` 可能为 `-1`。

### 第 2 步：回 SitDown 应答（`a_2953`）
```
int16   m_nResultID = 0                    ← 成功
int8    m_byACT
int32   m_iRoomID                          ← 必须填真实值（见下方警告）
int32   m_iTableID                         ← 必须填真实值
int8    m_bySeatID
int32   m_iSitdownSequence
int32   m_iCrossID   = 0                   ← ★ encode 不写、decode 必读，必须补（§5.2）
int32   m_iMapID
int8    m_byGameMode
int8    m_bLevel
int16   m_nseatmask
int8    m_byPlayerCount
CPlayerDetail × m_byPlayerCount            ← 每个自带 int16 长度前缀（§5.3）
    每人 m_iTableID 必须 >= 0              ← ★ 否则解码错位（§5.4）
    每人 m_byIconType = 0                  ← ★ 跳过 4 个 face 字符串（§9）
    每人 m_byStatus = 3 (Playing)          ← 保证含 m_iSitdownSequence
```

### 第 3 步：L1 切 UI
发 `[EnmProxyCmd.a_401 = 0][enmProxyCmd_SC_StartGame = 1]`（具体帧封装见 §16 待确认）。

### 第 4 步：L2 LoadStart（cmd=129）
```
int8    129
int16   m_nGameMode
int16   m_nSelectCardIDCount      ← 必须 == 下面数组实际长度
uint32  m_arrSelectCardIDs[]      ← 每元素 4 字节
int16   m_nSelectPropIDCount      ← 必须 == 下面数组实际长度
uint32  m_arrSelectPropIDs[]
int16   m_nAvatarInfoCount        ← 必须 == 下面数组实际长度
CAvatarInfo[]                     ← nosize，无外层长度前缀
int32   m_RandomSeed
```

每个 `CAvatarInfo`：
```
int8    m_bySeatID
uint16  m_nMemorySize             ← ★ zlib 压缩后 的字节数
bytes   <zlib(AMF对象)>           ← 长度 = m_nMemorySize
int8    m_byCardsCount            ← 必须 == 卡组实际长度
CGameCardInfo[] × n               ← nosize；每元素 7 字节（int32+3×int8）
int8    m_isAutoPickUpEnergy      ← 0/1
int8    m_isAutoPickUpProps       ← 0/1
int16   m_nWeaponSkillCount       ← 必须 == 下面数组实际长度
CWeaponSkillInfo[] × n            ← nosize；每元素 8 字节（2×int32）
```

AMF 对象字段（§11.3，共 21 个必需键 + 3 个数组）：
```
m_iCoverallType   m_iGunType      m_iSuperGunType    m_iShieldType
m_iHatType        m_iEyeGlassesType  m_iFaceType     m_iFaceDecorationType
m_iEyeType        m_iHairType     m_iBodyType        m_iAureolaType
m_iWingType       m_iLandInsuranceType  m_iWaterInsuranceType
m_numAttackForce  m_numDefenseForce  m_byShovelType
m_arrGenInfoArray  m_arrCardEffectAddArray  m_arrPetInfoArray
```

### 第 5 步：L2 GameStart（cmd=130）
```
int8    130
int16   m_nTotalIntruderWaveNum
int32   m_RandomSeed              ← 建议与 LoadStart 的 m_RandomSeed 一致
int32   m_iBuffId
```

### 第 6 步：帧同步循环
按帧率广播 `[int8 128][int32 m_GameStep]`，帧号递增。

### 第 7 步：反外挂握手
处理 CS 24/25/29，应答 SC 152/153/157（§6）。

### 第 8 步：战场资源版本
确认服务端下发的 version == `"0000201601010101"`（§7）。

---

## 16. 待办 / 未确认

- [x] ~~L1 报文外层封装~~ → **已解决，见 §18**
- [ ] `a_2698.m_arrSelectCardIDs` 的卡牌 ID 语义（查卡片配置表）
- [ ] `a_2179.m_strVersion` 与服务端下发 version 字段的对应关系
- [ ] CS 24/25/29 反外挂报文体（`SecrityCode` 子协议）
- [ ] `a_2713` / `a_2726`（上行 AvatarInfo 变体）字段表
- [ ] `m_GameStep` 的服务端推进策略（固定帧率 vs 事件驱动）

---

## 17. 验证：往返测试（Round-trip Verification）

本文档的字节级规格**不是纸面推导**，而是由可执行测试验证过的。

**测试文件**：
- `msdzls/server/encode-test.mjs` — 独立编码器（零依赖，只用 Node `Buffer`）
- `msdzls/server/decode-test.mjs` — 独立解码器（AMF3 + zlib + 自定义原语）
- `msdzls/server/run-spec-test.mjs` — 往返测试驱动

**运行**：
```powershell
cd C:\Users\XH\Documents\ChatGPT\逆向\msdzls
node server/run-spec-test.mjs
```

**结果：69 项断言全部通过（0 失败）**，覆盖 5 组用例：

| # | 用例 | 断言数 | 内容 |
|---|---|---|---|
| 1 | SitDown 应答 `a_2953` 往返 | 22 | 全部顶层字段 + `CPlayerDetail` ×2 + 两处 `\0` 尾坑 |
| 2 | LoadStart `a_2698` + `CAvatarInfo` 往返 | 19 | 卡组/技能数组 + **zlib blob** + **AMF3 21 字段** |
| 3 | GameStart `a_2695` 往返 | 4 | 报文体长度 + 3 字段 |
| 4 | StepSync `CNotifyGameStep` 往返 | 11 | 帧号 0/1/60/3600/2147483647 边界 |
| 5 | **负向用例：两个陷阱的真实失败模式** | 10 | 见 §5.2 / §5.4 |

### 17.1 测试带来的两处规格修正

**修正 1 — blob 是 AMF3 而非 AMF0。**
最初按 AMF0 实现解码器，在 LoadStart 用例上抛 `AMF3 未知类型标记 0x0a @0`。原因是 AS3 `ByteArray.objectEncoding` 默认为 `ObjectEncoding.AMF3`，`readObject()`/`writeObject()` 因此走 AMF3 分支。改用 AMF3 后用例 2 全通。§11.2 的标记表即由此得出。

**修正 2 — 两个"陷阱"不会崩溃，而是静默降级。**
初稿声称省略 `m_iCrossID` 会导致"解码失败/错位"、`m_iTableID = -1` 会导致"越界"。实测两者**都不抛错**：

- 省略 `m_iCrossID` → 4 字节错位，`m_byPlayerCount` 塌缩为 `0`，仅消费 29/146 字节后提前返回。**静默、无异常**。
- `m_iTableID = -1` → `CPlayerDetail` 的 `playerDetailSize` 长度前缀使其自动跳过并**重新对齐**，`m_bySeat`/`m_byStatus` 为 `undefined`，后续字段**不受污染**。

**这个修正很重要**：静默降级比崩溃更难排查——服务端看不到任何错误，客户端只是"进不去战斗"。因此这两条仍然是**必须遵守的硬约束**，但排查时的预期症状应改为"无报错但玩家列表为空/无法落座"，而非"崩溃"。

### 17.2 已知局限

- 测试验证的是**本仓库编码器 ↔ 本仓库解码器**的自洽性，**不等于**与真实官方客户端互通。真正的验收标准是用私服回包喂给官方 SWF。
- 用例 2 的 AMF3 只覆盖**全动态对象**路径；若官方客户端用 sealed traits 或引用表，需扩展解码器。
- `m_arrSelectCardIDs` 等字段用的是**合成测试值**，不代表真实配置表 ID。

---

## 18. L1 传输层封装（已解开，原 §16 阻塞项）

> 来源：`a_4757/a_2220.as:131-206`（发送）、`a_4727/b_164.as`（加密）、`com/aurora/protocol/common/a_2670.as`（头）、`com/aurora/protocol/logicserver/a_2926.as`（游戏数据包装）、`a_4716/b_154.as:518`（常量）。

### 18.1 三层嵌套总览

```
┌─ 第 3 层: 传输帧  a_2220.a_2201()  ──────────────────────┐
│  [a_2670 头 28B] [XXTEA-CBC 加密区]                       │
│                        └─ 明文 = [int32 seq][第2层]        │
├─ 第 2 层: 游戏数据包装  a_2926  (仅 L2 游戏数据报文)       │
│  [int32 m_iRoomID][int32 m_iTableID]                      │
│  [int16 m_nGameDataLength][m_szGameData 原始字节]          │
├─ 第 1 层: 游戏数据体                                      │
│  [int8 b_102 命令号][协议体]                               │
└──────────────────────────────────────────────────────────┘
```

**只有 `b_154.a_152 (=8709)` 这一个 messageID 才走第 2 层包装。** 其余 L1 报文（如 SitDown 8705）直接是 `[int8 a_401=0][命令体]`，不套 `a_2926`。

### 18.2 `a_2670` 头 —— 28 字节，含一个未写/未读的不对称

| 偏移 | 长度 | 字段 | 写入 | 读出 |
|---|---|---|---|---|
| **未出现在线上** | — | `httpHead` | `encode` 写 1 字节 `0x00` | **`decode` 从不读** |
| 0 | 4 | `nPackageLength` | int32 | int32 |
| 4 | 4 | `nUIN` | int32 | int32 |
| 8 | 2 | `shFlag` | int16 | int16 |
| 10 | 2 | `shOptionalLen` | int16 | int16 |
| 12 | N | `lpbyOptional` | memory | memory(`shOptionalLen`) |
| 12+N | 2 | `shHeaderLen` | int16 | int16 |
| 14+N | 2 | `shMessageID` | int16 | int16 |
| 16+N | 2 | `shMessageType` | int16 | int16 |
| 18+N | 2 | `shVersion` | int16 | int16 |
| 20+N | 4 | `nPlayerID` | int32 | int32 |

**⚠️ 实测不对称（方向决定性）**：`a_2670.as:45` 在 `encode` 里先写 1 字节 `httpHead`，但 `a_2670.as:59-73` 的 `decode` **完全没有对应的读取**。因此：

- **客户端 → 服务端**：线上头 = **1 + N + 24**（`a_331 = 6*2 + 3*4 = 24`，`b_154.as:518`），`nPackageLength = 24 + 密文`（**不含** httpHead）。实测原始字节：auth 请求 = 57B = 1 + 24 + 32，长度字段 = 56 = 24 + 32 ✓。服务端接收侧对应 `local-server.mjs:3168` / `parseHeader(buf, 1)`。
- **服务端 → 客户端**：必须 **不写** httpHead，头就是 **24 字节**，`nPackageLength = 24 + 密文`。
  证据链（2026-10-14 实证）：客户端收到数据后 `a_1779.as:84 packageBytes.position = 0;` → `a_2220.a_2204`（`a_2220.as:216-218`）→ `a_2670.decode`，**从偏移 0 直接读 `nPackageLength`**。若服务端多写 1 字节，客户端会把长度字段读成以 `0x00` 开头的错位值，整帧报废。

> **服务端实现口径（已落地）**：`server/frame-codec.mjs` 的 `encodeHeader` 参数 `httpHead` **默认 `false`**（服务端下行口径，24 字节）；要复刻客户端上行时显式传 `httpHead: true`（25 字节）。
>
> ❌ **旧文档的相反建议已作废**：此前写「服务端直接按『写 1 字节 0x00 + 24 字节』构造头」。那会让 129/130 完全无法被客户端解析 —— 这也是 `buildL2Frame` 产出 25 字节头这一真实 bug 的来源（该 bug 随本轮修复一并消除，见 `run-frame-test.mjs` §3 的固化断言）。

**首次连接 vs 后续连接**（`a_2220.as:159-166`）：

| 场景 | `m_szSessionKey` 状态 | 行为 |
|---|---|---|
| 首次 (`!tcpConn.connected`) | 为空 | 设为本连接 authenKey；`optionBuffer = signature` |
| 后续 | 已存在 | `optionBuffer` 保持调用方传入值（通常为空） |

`shFlag = b_155.b_157`、`shMessageType = b_154.a_104 (=1)`、`shVersion = getProtocolVersion()`。

### 18.3 加密：XXTEA（双向链式）+ 随机 IV

`b_164.a_1772` → `a_1774(..., nRound = a_543 = 32)` 加密；`b_164.a_1773` → `a_1775(..., nRound = a_544 = -32)` 解密。核心 `b_165` 是标准 **XXTEA**（`DELTA = 2654435769`，密钥取 4 个 int32，`k.position = (sum & 3) * 4`）。

**⚠️ 不是裸 XXTEA，也不是标准 CBC。** 实测反推（`server/derive-chain.mjs` 自验证）后确认的块链关系是：

```
cipher[1] = XXTEA_enc(firstBlock)

cipher[k] = XXTEA_enc( plain[k] ^ cipher[k-1] ) ^ plain[k-1]     (k >= 2)
plain[k]  = XXTEA_dec( cipher[k] ^ plain[k-1] ) ^ cipher[k-1]
```

**每块同时依赖「上一块明文」与「上一块密文」**——这是本项目加密实现最难的一处。若只按标准 CBC 那样携带单一链值，从第 3 块起必然解错。

第一块 8 字节布局：
```
[1 字节: (rand & 0xF8) | padLen] [padLen 个随机字节] [明文头部 8-1-padLen 字节]
```

**关键点**：
1. **序号在明文最前**（`a_2220.as:170` `encode_int32(decryptBuffer, getNextSequence())`）——它**被加密**，不是明文头字段。
2. 末块只承载 **1 个明文字节**，其余补 0。
3. 首块第 1 字节低 3 位 = `padLen`，高 5 位随机。
4. `padLen` 由 `nPadDataZero = 1 + len + 7` 决定：`nPadLength = nPadDataZero % 8`，**若为 0 则不调整**（AS3 的 `if` 不触发），否则 `= 8 - nPadLength`。
5. **块数**：恒为 `1（首块）+ 中间块 + 1（末块）`，中间块数 `= ceil((len - headCopy - 1) / 8)`（当 `len - headCopy > 1`）。`nTotalLength` 即此总块数 × 8。

> **简化建议**：服务端可令随机部分恒为 0（首字节 = `padLen`），链式仍成立、客户端仍可解，且便于确定性测试。

**实测验证**：`server/frame-codec.mjs` 实现了上述双向变换，`server/run-frame-test.mjs` **43 项断言全部通过**，覆盖 1/4/8/10/17/64/255/1000 字节明文往返、错误密钥必须失败、以及完整 L2 帧端到端组装解回。

### 18.4 会话密钥来源 —— 私服完全可控（决定性发现）

`a_2208.as:319`：

```actionscript
this.m_szSessionKey.writeBytes(authenResponse.m_szSessionKey, 0, authenResponse.m_szSessionKey.length);
```

**会话密钥来自登录服务器的 `authenResponse.m_szSessionKey`，不是客户端本地推导的。** 同时 `a_783`（signature）来自 `m_szPlayerSignature`（`:320`），`m_iRawUin` 来自 `m_iUIN`（`:326`）。

**这意味着私服可以在自己的登录应答里自由指定 session key**，只要后续用同一把 key 加密即可。无需复刻官方登录流程。

### 18.5 序号 `nSequence`

- 发送：`a_2208.as:163-166` `getNextSequence() { return this.a_780++; }` —— **从 0 开始，每次 +1**。
- 接收：`a_2220.a_2204` 会校验（`:208` 起）。
- **服务端对应**：维护自己的发送计数器（通常也从 0 起），并校验客户端序号单调递增。

### 18.6 完整发包示例（服务端 L2 游戏数据）

```text
body   = [0x81][a_2698 LoadStart 报文体]          # 0x81 = 129
wrapped= [int32 roomID][int32 tableID][int16 gdLen][body]   # a_2926；gdLen = 1 + 报文体长度
plain  = [int32 seq][wrapped]
cipher = encryptFrame(plain, sessionKey)            # 双向链式，8B 对齐
header = int32(24 + cipher.length)                  # nPackageLength（偏移 0，不含 httpHead）
       + int32(uin)
       + int16(shFlag = 4)
       + int16(0)                                   # shOptionalLen
       + int16(24)                                  # shHeaderLen = a_331（偏移 12）
       + int16(8709)                                # shMessageID = b_154.a_152（偏移 14）
       + int16(1)                                   # shMessageType = b_154.a_104
       + int16(protocolVersion)
       + int32(playerID)
frame  = header + cipher                            # 共 24 + cipher.length 字节
```

**服务端下行必须 24 字节头（无 httpHead）**；`a_2670.encode` 那份 25 字节写法只适用于客户端上行。
已由 `server/run-frame-test.mjs` §3/§5/§6 与 `server/verify-battle.mjs` B1/B2 固化（含"多写 1 字节就红"的反例断言）。

### 18.7 未解决 / 需实测校准

- [x] **`nPackageLength` / `shHeaderLen` 是否含 `httpHead`** —— **已定为「不含」**，且**下行根本不写该字节**。
  证据：`local-server.mjs` 的 `buildPacket()` 不写 `httpHead`、`pkgLen = 24 + payload`，
  该路径已实测完成 认证 → 大厅 → 逻辑登录；客户端接收侧 `a_1779.as:84` 从 `position = 0` 直接
  `a_2670.decode`（`a_2670.as:59`）。服务端上行侧对应 `parseHeader(buf, 1)`。
- [x] **L2 帧外层是否要写那 1 字节 `httpHead`** —— **已定：不写**（与 L1 同）。见 §18.2 的方向不对称。
  `frame-codec.mjs` `encodeHeader` 的 `httpHead` 参数默认 `false`；已由 `run-frame-test.mjs` §3 固化。
  该处此前是**真实 bug**（产出 25 字节头），已修复。
- [x] **`a_2698` (LoadStart) 报文体字段** —— **已定稿并落地**：`int16 gameMode | int16 卡数 |
  uint32×N 卡ID | int16 0（道具，客户端无读点）| int16 0（avatar，见 §15 第 4 步理由）| int32 seed`。
- [x] **`a_2695` (StartGame) 报文体字段** —— **已定稿并落地**：`int16 波数 | int32 seed(同129) | int32 buffId(0)`，定长 10 字节。
- [ ] **`m_nTotalIntruderWaveNum` 的正确取值** —— 目前默认 20（`REA_TOTAL_WAVE_NUM` 可覆盖）。
  它唯一驱动 `MoveIntruderWaveNumberIndicatorView.a_3563` 的显示，**不驱动出怪**，取值待实机校准。
- [ ] **129 的 `m_arrAvatarInfoArray` 是否需要为"其他座位"补数据** —— 单机只打本机座位，当前发 0 条。
  多人（2v2）时必须补，且需要写 AMF3 blob（`a_2179.as:669-698` 消费 17 个字段）。
- [ ] 接收方向 `a_2204` 的序号校验逻辑
- [ ] `b_155.b_157`（`shFlag`）的具体值 —— 暂用 `4`（与已验证的 L1 `buildPacket` 一致）
- [ ] `getProtocolVersion()` 返回值的具体数值 —— 暂用 `3`（与已验证的 L1 路径一致）
- [ ] 登录阶段 `authenResponse` 的完整报文体（私服需自行实现登录应答以注入 session key）
- [ ] 零长明文语义：实测会解出 8 个零字节而非空——**服务端不应发送零载荷帧**（L2 帧载荷非空，不受影响）


