# 战斗模块复刻方案（Battle Replica Plan）

> 逆向来源：`msdzls/decompiled/TDCore/scripts/`、`msdzls/decompiled/TDGameCoreUI/`、`msdzls/decompiled/TDGameReadyUI/`（AS3 反编译产物）
> 取证者：teammate `battle-scout`（task-4，revision 2）；**§5 与 §5.4 由 Lead 于 2026-10-14 重写并落地（task-5）**
> 上游依据：`msdzls/docs/battle-protocol.md`（字节级协议规格，本文不重复其内容）
> **本文所有结论标注 `[实测]`（有直接代码/日志证据）或 `[推断]`（由证据推理，未经运行时验证）。**
> 引用的 `file.as:行号` 均已抽查存在。未判定项集中在 §8。

---

## 0. 结论速览（TL;DR）

| # | 问题 | 判定 | 证据强度 |
|---|---|---|---|
| 1 | 客户端读 129 还是 130 的 `m_RandomSeed`？ | **只读 129 的**。130 的 `m_RandomSeed` 全树**零读点**，是冗余字段 | `[实测]` |
| 2 | StepSync(128) 对单机复刻是否可选？ | **可选，可完全不发** | `[实测]`（静态 + 运行日志双重） |
| 3 | 最小可玩服需要发几帧？ | **仅 2 帧：129 + 130**（128 零帧） | `[实测]` |
| 4 | 当前 `local-server.mjs` 的空载荷 129/130 能否进战场？ | **能进 UI，但战场逻辑必然残缺** | `[实测]`（已由 task-5 做实载荷 + 换触发点，见 §5） |
| 5 | CS 段上行是否必须应答？ | **大部分不需要**；只有少数影响客户端状态的需**推送**（非"应答"） | `[推断]`，见 §6 |
| 6 | **129/130 的正确触发点是什么？** | **129 = 收到 L2 `cmd1`(PostSelectedCards)；130 = 收到 L2 `cmd3`(载入进度) 且进度 = 100**。旧文档写的"SIT_DOWN 后推 129"是**错的** | `[实测]`，见 §5.4 |

**最重要的一句话**：`StepSync(128)` 不是战斗推进的心跳——`battle-protocol.md:566` 的旧表述（"这是战斗推进的心跳"）**应当修正**。客户端自带 100 Hz 本地时钟，完全自走。

---

## 1. 三帧语义表

命令号空间 `a_4718/b_102.as`（140 行）。三个命令号的常量定义位置 `[实测]`：
- `b_102.as:68` `enmGameDataCmd_SC_StepSync:uint = 128`
- `b_102.as:70` `b_125:uint = 129`
- `b_102.as:72` `b_126:uint = 130`

分发注册 `a_4753/a_2053.as:80-83` `[实测]`：
```actionscript
80: this.a_2054(b_102.b_125,this.a_2087);              // 129 → a_2087
81: this.a_2054(b_102.b_126,this.a_2088);              // 130 → a_2088
82: this.a_2054(b_102.enmGameDataCmd_SC_StepSync,this.OnGameStepLock);  // 128
```
解码落地 `a_2053.as:685-697`(129) / `:699-712`(130) / `:714-724`(128)，均各自 `new` 一个类 → `decode` → 转交 `this.a_749`（即 `a_2179` 单例）。

### 1.1 命令 129 — `LoadStart`（`a_2698`）

`[实测]` `com/aurora/protocol/game/maogoutd/a_2698.as:35`（encode）与 `:41`（decode）propertyArray 逐字相同：

| # | 字段 | 类型 | 含义 | 标注 |
|---|---|---|---|---|
| 1 | `m_nGameMode` | int16 | 游戏模式 | `[推断]`（`a_2179.as:664` 写入 `m_arrGameData["byGameMode"]`）`[实测]` |
| 2 | `m_nSelectCardIDCount` | int16 | 选中卡牌数 N1 | `[实测]`（计数机制见 §1.4） |
| 3 | `m_arrSelectCardIDs` | uint32 × N1 | 选中卡牌 ID 列表 | `[实测]` |
| 4 | `m_nSelectPropIDCount` | int16 | 选中道具数 N2 | `[实测]` |
| 5 | `m_arrSelectPropIDs` | uint32 × N2 | 选中道具 ID 列表 | `[实测]` |
| 6 | `m_nAvatarInfoCount` | int16 | 玩家数 N3 | `[实测]` |
| 7 | `m_arrAvatarInfoArray` | `CAvatarInfo` × N3（`nosize`） | 每玩家战场初始状态 | `[实测]`，见 §1.5 |
| 8 | **`m_RandomSeed`** | **int32** | **服务端权威随机种子** | `[实测]`，见 §3 |

### 1.2 命令 130 — `GameStart`（`a_2695`）

`[实测]` `a_2695.as:23`(encode) / `:29`(decode)：

| # | 字段 | 类型 | 含义 | 客户端消费点 |
|---|---|---|---|---|
| 1 | `m_nTotalIntruderWaveNum` | int16 | 总波数 | `[实测]` `TDGame2V2BattleUI.as:1124` |
| 2 | `m_RandomSeed` | int32 | 随机种子（**冗余**） | **无任何读点** `[实测]` |
| 3 | `m_iBuffId` | int32 | BUFF ID | `[实测]` `TDGame2V2BattleUI.as:903` |

定长 10 字节，无数组、无计数机制。

### 1.3 命令 128 — `StepSync`（`CNotifyGameStep`）

`[实测]` `CNotifyGameStep.as:10/19/25` — 单字段 `m_GameStep:int`（int32），仅 4 字节。

**语义修正**：它**不是**推进时钟，而是"锁步闸门"（原版 PvP 防作弊用途）。`battle-protocol.md:566` 称之为"战斗推进的心跳"是不准确的，建议改为"锁步闸门（单机复刻可省略）"。详见 §4。

### 1.4 计数机制（129 的 `nosize` 语义）

`[实测]` `com/aurora/protocol/a_2664.as:437`（decode 分支）：
```actionscript
size = undefined !== item[3] && "nosize" == item[3] || preValue > item[2] ? int(item[2]) : preValue;
```
⇒ 对 `memory` / 数组 / 嵌套 object 标 `nosize` 时，**长度取自紧邻前面的计数字段**，而非独立长度前缀。因此 N1/N2/N3 三个计数字段**必须准确**，否则整个 129 体解析错位。

### 1.5 `CAvatarInfo`（129 第 7 字段的元素类型）

`[实测]` `maogoutd/CAvatarInfo.as:41`(encode) / `:47`(decode) 九字段：

| # | 字段 | 类型 | 说明 |
|---|---|---|---|
| 1 | `m_bySeatID` | int8 | 座位号 |
| 2 | `m_nMemorySize` | uint16 | 后随 blob 长度 |
| 3 | `m_byarrPlayerAvatarInfoByteArray` | `memory` | **AMF 序列化 blob**（`readObject()`） |
| 4 | `m_byCardsCount` | int8 | 卡牌数 M |
| 5 | `m_arrGameCardInfoArray` | `CGameCardInfo` × M（`nosize`） | 卡槽状态 |
| 6 | `m_isAutoPickUpEnergy` | int8 | 自动拾取能量 |
| 7 | `m_isAutoPickUpProps` | int8 | 自动拾取道具 |
| 8 | `m_nWeaponSkillCount` | int16 | 武器技能数 K |
| 9 | `m_arrWeaponSkillInfo` | `CWeaponSkillInfo` × K（`nosize`） | 武器技能 |

**关键**：第 3 字段是 `memory` 类型（`a_2664.as:435-440`），长度由 `m_nMemorySize` 决定，内容是 AMF blob。`a_2179.as:672-673` 读它：
```actionscript
672: stAvatarInfo.m_byarrPlayerAvatarInfoByteArray.position = 0;
673: stReadObject = stAvatarInfo.m_byarrPlayerAvatarInfoByteArray.readObject();
```
其反序列化字段清单见 `battle-protocol.md:510`（§11.3），本文不重复。⇒ **服务端必须能构造合法 AMF blob**，这是 129 最大的实现难点。

---

## 2. `m_RandomSeed` 结论（关键结论 1 实锤）

### 2.1 种子唯一写入点：129

`[实测]` `a_4753/a_2179.as:665-666`（位于 `a_2087(stLoadStartNotify:a_2698)` = **129 的落地函数内**）：
```actionscript
665: var enterRoom:Object = a_2161.e.getEnterRoom();
666: enterRoom.m_RandomSeed = stLoadStartNotify.m_RandomSeed;
```

> **此前的死胡同已解释**：`a_2439.as` 里搜不到 `a_2698` 类型引用，是因为 `m_enterRoom` 是**动态 object**（`a_2439.as:121 this.m_enterRoom = {};`），字段由外部分发层动态挂上，**不存在 setter 调用点可找**。

### 2.2 130 的 `m_RandomSeed` 是冗余字段

`[实测]` 全 `decompiled` 树扫描 `m_RandomSeed`：`a_2695.as` 的该字段**只出现在自身声明（`:12`）与 encode/decode 的 propertyArray（`:23`/`:29`）**，**无任何读取点**。（`TDGameReadyUI` 下的同名副本同样如此。）

⇒ **复刻策略**：
- **129 的 `m_RandomSeed` 必须正确**——它决定所有战斗随机。
- **130 的 `m_RandomSeed` 填什么都行**。建议仍填同值以求整洁、便于日后对比排查，但**不要**以为它生效。

### 2.3 种子扇出：约 120 个读点，多条独立随机流

`[实测]` 所有读点形如 `setSeed(enterRoom.m_RandomSeed, <KEY>)`，**第二参数是"流标识键"**，不同键 = 不同随机流。抽样：

| KEY | 读点示例 | 性质 |
|---|---|---|
| `1000` | `TDGame2V2BattleUI.as:1046-1048`（三条：`m_stRandomSeed`/`m_stSpaceRandomSeed`/`m_stUpGradeRandomSeed`） | 主战斗 / 空间 / 升星流 |
| `m_iGlobalID` | `GoldProtectorCommonShot.as:116`、`VajraHorseBaseShot.as:83`、`YellowElementBaseShot.as:59` 等 | 每单位独立流 |
| `m_iDefenseGlobalID` | `CandyPotBombFirstAttackFighter.as:47` 等 | 每防御单位独立流 |
| `1000 + s_GlobalInitCount` | `IceAtomicBoomSecondAttackFighter.as:45`、`WuGuSnake*` 三处 | 全局初始化计数 |
| `1000` | 大量 gamemap / Intruder boss | 地图与 Boss 流 |
| `this.m_seed` | `BaseShotTrigger.as:33` | 触发器自定义 |

`TDGame2V2BattleUI.as:1045-1048` 逐字：
```actionscript
1045: var enterRoom:Object = a_2161.e.getEnterRoom();
1046: BattleFieldView.m_stRandomSeed.setSeed(enterRoom.m_RandomSeed,1000);
1047: BattleFieldView.m_stSpaceRandomSeed.setSeed(enterRoom.m_RandomSeed,1000);
1048: BattleFieldView.m_stUpGradeRandomSeed.setSeed(enterRoom.m_RandomSeed,1000);
```
⇒ **单机复现确定性的唯一要求：每局服务端生成一个种子，同时填进 129**（130 可同值）。

### 2.4 `setSeed` 两参数的精确语义（重要，纠正一处误读）

`[实测]` 实现位于 `com/adobe/utils/RandomSeed.as:40-45`，签名 `setSeed(high:uint, low:uint)`：
```actionscript
42: this.seedHigh = high & 0xFFFF ^ MULTIPLIER_HIGH;
43: this.seedMid  = low >> 16 & 0xFFFF ^ MULTIPLIER_MID;
44: this.seedLow  = low & 0xFFFF ^ MULTIPLIER_LOW;
```
⇒ **`high` 只贡献低 16 位，且与 `low` 完全独立**；`low` 贡献 `seedMid`/`seedLow`。两参数**都是种子材料**，不存在"第一参数是种子、第二参数是别的"这种签名歧义。

---

## 3. 附注：局部随机流的时序耦合点（`ms_iServerLockStep`）

### 3.1 定义与生命周期

`[实测]` `game/BattleFieldView.as:96` `public static var ms_iServerLockStepIntEx:int = 0;`
- `:434-442` 普通 setter/getter（`set` 写 `ms_iServerLockStepIntEx`，`get` 读回）；**除自增外无其他写入点**。
- **唯一重置点**：`BattleFieldView.as:1644` `BattleFieldView.ms_iServerLockStep = 0;`（每局开场归零）。

### 3.2 两个自增点——**都是本地逻辑步，与 128 无关**

| 位置 | 所在函数 | 语义 |
|---|---|---|
| `TDGame2V2BattleUI.as:1456` | `a_555(stPlaceDefender:a_2704)` **首行** | 每**放置一个防御塔** +1 |
| `resource/Intruder/a_4258.as:37` | `a_3608(pendingAddMoveIntruderVector)` | 每**调度一批老鼠入场** +1 |

`[实测]` `TDGame2V2BattleUI.as:1456` 上下文（`a_555` 函数体首行）：
```actionscript
1448: public function a_555(stPlaceDefender:a_2704) : Boolean
1456:    ++BattleFieldView.ms_iServerLockStep;
1457:    var stInitialFieldGrid:a_3491 = ...GetInitialFieldGrid(...);
```

⇒ 它是"每放一个塔 / 每调度一波老鼠就 +1"的**本地单调计数器**，由**玩家操作与波次推进**驱动。**名字里的 "Server" 是历史误称，它不依赖服务端推任何帧。**

### 3.3 四个读点：确实存在真实的时序耦合

`[实测]` 全部 4 个读点：

| 文件 | 行 | 调用 |
|---|---|---|
| `defender/RabbitYear/DarkMessenger/DarkMessengerFinalAttackFighter.as` | `:70` | `this.m_stRandomSeed.setSeed(enterRoom.m_RandomSeed, BattleFieldView.ms_iServerLockStep);` |
| `defender/SnakeYear/CrucibleSnake/CrucibleSnakeBaseAuxiliaryFighter.as` | `:32` | `m_iDefenseRandomSeed.setSeed(BattleFieldView.ms_iServerLockStep, m_iDefenseGlobalID);` |
| `defender/SnakeYear/CrucibleSnake/CrucibleSnakeFirstAuxiliaryFighter.as` | `:32` | 同上 |
| `defender/SnakeYear/CrucibleSnake/CrucibleSnakeSecondAuxiliaryFighter.as` | `:32` | 同上 |

**关于 `CrucibleSnake*` 三处的判定**（曾存疑，已按 §2.4 的 `setSeed` 实现实锤）：
- 对照写法 `CandyPotBombFirstAttackFighter.as:47` 为 `setSeed(enterRoom.m_RandomSeed, m_iDefenseGlobalID)`。
- `CrucibleSnake*` 把 `ms_iServerLockStep` 放在**第一参数（`high`）**位。
- 由 `RandomSeed.as:42-44` 可知 `high` **直接参与 `seedHigh`**，因此这三处**确实以锁步号为主要种子材料**，`m_iDefenseGlobalID` 只进 `seedMid`/`seedLow`。
- ⇒ **这是真实存在的怪写法，会造成随机分叉**（原 Lead 该判断成立；"可能是签名歧义"的怀疑已被 `RandomSeed.as:40` 排除）。

### 3.4 对复刻的意义（**不构成"必须收 128"的证据**）

- 它**不需要服务端推任何帧**就能自走，故**不能**用来论证 128 必需。
- 但它是一条**精度要求**：若复刻时提前/延后调用 `a_555`(放置塔) 或 `a_3608`(老鼠调度)——例如把一帧内多个放置批量合并、或跳过某些波次——`CrucibleSnake*` 与 `DarkMessengerFinalAttackFighter` 的随机行为会与原版分叉。
- **这种分叉不报错、不崩溃，只表现为"打得不一样"**，极难排查。⇒ 复刻时这两个函数的**调用时机与次数必须忠实**。

---

## 4. StepSync 必要性判定（关键结论 2，本任务核心）

### 判定：**可选，单机复刻可完全不发 128。** `[实测]`

三重独立证据，全部指向同一结论。

#### 证据 A：客户端处理器是空桩

`[实测]` `TDGame2V2BattleUI.as:3576-3579` 逐字：
```actionscript
3576: public function OnGameStepLock(stGameStartNotify:CNotifyGameStep) : Boolean
3577: {
3578:    return true;
3579: }
```
⇒ 收到 128 后，客户端**什么都不做**，直接返回 `true`。`m_GameStep` 在此被完全丢弃。

#### 证据 B：前置门使 128 在 130 之前被静默丢弃

`[实测]` `a_2179.as:887-900`：
```actionscript
887: public function a_2088(stGameStartNotify:a_2695) : void
888: {
889:    this.m_isGaming = true;
890:    TDGameCoreUI.a_921.a_4541();
891:    TDGameCoreUI.a_757.a_3435(stGameStartNotify);
892: }
...
894: public function OnGameStepLock(stGameStepNotify:CNotifyGameStep) : void
895: {
896:    if(this.m_isGaming)
897:    {
898:       TDGameCoreUI.a_757.OnGameStepLock(stGameStepNotify);
899:    }
900: }
```
`m_isGaming` 声明于 `:126`，**唯一置 `true` 点是 `:889`（即收到 130 时）**，唯一置 `false` 点是 `:1034`（`a_2098` GameEnd）。⇒ 130 之前的所有 128 被直接丢弃。

#### 证据 C：真实推进是本地 100 Hz 时钟，与 `m_GameStep` 完全无关

`[实测]` `TDGame2V2BattleUI.as:3581-3633`（`a_3416(a_4730:Event)`，即 `ENTER_FRAME`/定时器回调）。推进核心：
```actionscript
3595: var iCheckTimes:* = int(this.m_stBattleFieldFor4View.m_stMyBattleFieldView.iTimeIntervalNum - this.a_1010);
3596: while(iCheckTimes-- > 0)
3597: {
3598:    ++this.a_1010;
3599:    this.m_stBattleFieldFor4View.a_3416(a_4730);
3600:    if(this.a_1010 % 3 == 0) { ...金币掉落回调... }
3607:    this.m_stCardGrowPanelView.OnTimeInterval(this.a_1010);
3608:    this.m_stGameMapResource.OnTimeInterval(this.a_1010);
3614:    stWeaponSkill.OnTimeInterval(this.a_1010);
3623:    if(this.a_1010 % 10 == 0 && ...) { ...刷新 UI 文本... }
3633: }
```
- 循环次数**只**由 `iTimeIntervalNum - this.a_1010` 决定，`iTimeIntervalNum` 来自本地战场视图。
- 整个 `:3581-3641` 函数体内**没有任何一处引用 `m_GameStep`、`OnGameStepLock` 或其返回值**。`a_1010 % 3`、`a_1010 % 10` 周期性逻辑也全基于本地计数器。
- ⇒ **客户端自走本地时钟**；128 既非触发源，也非节拍源。

#### 证据 D（运行日志，独立于静态阅读）

`[实测]` `msdzls/server/server.log`（5440 行，424236 字节）：
- 出现 `StepSync|GameStep|StepLock` 的行数 = **0**。客户端**从未请求也从未抱怨** 128。
- `SEND_GAME_DATA`(msgID 8709) 上行 282 行记录，其中请求体 92 条可解析为：

  `plain = 00 00 00 03 | 00 00 00 01 | 00 02 | 03 <step>`
  （依次为 roomID(3) | tableID(1) | gdLen(2) | L2cmd(2) | body = `02 03 <step>`）

  末尾 `step` 字节从 `01` **单调递增到 `0x63`(=99)**，distinct 值 92 个（缺号为日志采样，非跳帧）。

⇒ **在服务端只发了 2 帧（空载荷 129+130）、一帧 128 都没发的情况下，客户端本地帧计数器自主推进到了 99。** 这是对"StepSync 可选"最直接的运行期证据。

> 注：`a_2179.as:1591 this.a_2087(this.a_771);` 经查**不是本地兜底触发 LoadStart**，而是版本数据就绪后的**重入**：`:650` 暂存 notify → `:651-654` 若 SWF 版本未知则**提前 return**（保留暂存）→ 版本就绪后 `:1591` 重放。`:655 this.a_771 = null;` 是正常路径下的清理。故此处**不能**作为"服务端不发 129 也能开战"的依据。

### 若将来要做 PvP 联机（不在本任务范围）

需要另立任务：服务端维护起始步号、广播频率（由 `iTimeIntervalNum` 反推，疑为 100 Hz，`[推断]`）、以及在 `TDGame2V2BattleUI.OnGameStepLock` 被替换为真实实现后重做判定。当前单机复刻**不需要**。

---

## 5. 最小可玩服实现清单（**2026-10-14 由 Lead 重写并落地，task-5**）

### 5.1 帧序列与触发点（**已实现**）

```text
[坐下 8705 应答成功]                ← 已实现（local-server.mjs）；注意它走 **generic** 网关
        ↓
[L1 切 UI: enmProxyCmd_SC_StartGame = 1]  ← 已实现
        ↓
  客户端进准备 UI：上报 cmd12(PostAvatarInfo) / cmd9 → 载入资源（cmd3 进度 1..99）
        ↓
  玩家点「开始」→ 客户端上报 **L2 cmd1 PostSelectedCards (a_2726)**
        ↓
[L2 129 LoadStart]                  ← **服务端此刻推**（本轮实现）
        ↓
  客户端 a_2087 置 a_767=true → 资源载完 → LoadEndAndStartGame → a_2195 初始化战场 UI
        ↓
  **客户端上报 cmd3 进度 = 100**
        ↓
[L2 130 GameStart]                  ← **服务端此刻推**（本轮实现）
        ↓
   战场可操作（客户端自走时钟，无需 128）
```

**❌ 旧文档 §5.1/§5.4 写的"SitDown 应答后推 129"是错的**，两重错误：

1. `local-server.mjs:2821` 的门是 `if (h.shMessageID === 8705 && tag === "logic")`，而实测
   `server.log:4753-4755` 是 `[generic#19] ... msgID=8705` —— **tag 永远不是 `logic`，那两帧从未发出过**。
2. 即使修 tag，**时机也错**：`a_2087`（129 落地）在 `a_2179.as:849` 需要 `a_768 === true`，
   而坐下那一刻客户端还在大厅，`a_768` 为 false ⇒ 129 会掉进 `:853-856` 的 else 分支被静默吃掉，
   且 `a_771` 已在 `:655` 置 null，**之后再无重试**。

### 5.2 涉及的真实字节布局（`[实测]`，全部来自客户端 decode 规格）

| 帧 | 体布局 | 长度 |
|---|---|---|
| 129 `a_2698` | `int16 gameMode` / `int16 卡数` / `uint32×N 卡ID` / `int16 道具数` / `uint32×N 道具ID` / `int16 avatar数` / `CAvatarInfo×N` / `int32 seed` | `12 + 4N`（avatars=0、props=0 时） |
| 130 `a_2695` | `int16 波数` / `int32 seed` / `int32 buffId` | **定长 10** |
| cmd1 `a_2726` 请求 | `uint8 卡数` / `CCardIDInfo×N`(8B) / `int16 道具数` / `CCardIDInfo×N` / `int16 blob长度` / `blob`(zlib) / 5×int16 / 7×int32 / `int16 宠物数` / `int32 校验` | 变长 |

客户端**读点全表**（grep 全量 decompiled 得到，决定"哪些字段必须做实"）：

| 129 字段 | 读点 | 结论 |
|---|---|---|
| `m_nGameMode` | `a_2179.as:664` `m_arrGameData["byGameMode"]` | **必须正确回显**（战斗大量分支依赖） |
| `m_arrSelectCardIDs` | `a_2179.as:801` 仅用于 `resource/0x<ID>.swf` 预加载 | **必须非空** —— 见 §5.4 的死路分析 |
| `m_arrSelectPropIDs` | **0 个读点** | 发 0 |
| `m_arrAvatarInfoArray` | `a_2179.as:669` | **单机发 0 条**，见下 |
| `m_RandomSeed` | `a_2179.as:665-666` | **权威种子**，每局新随机 |
| 130 `m_nTotalIntruderWaveNum` | `TDGame2V2BattleUI.as:1124` → `a_3563`（`:38 int(124/n)` 除零） | **必须 > 0**；仅驱动显示，不驱动出怪 |
| 130 `m_RandomSeed` | **0 个读点** | 填与 129 同值 |
| 130 `m_iBuffId` | `TDGame2V2BattleUI.as:903` `a_4206.m_iViewBuffId` | 发 0 |

**★ 为什么 129 的 avatar 数组发 0 条（关键设计决定）**：`a_2179.as:312-313` 在客户端本地路径里
**已经**把本机座位的 `AvatarDetailInfo` 填好（`m_arrPlayerAvatarDetailInfo[bySeat] = stAvatarDetailInfo`），
而发送 cmd1 是在 `:410`（即 `:313` 之后）⇒ **本机 avatar 数据客户端自己就有**。
若服务端再回 1 条，`a_2179.as:757-759` 会用服务端版本**覆盖**
`m_arrPlayerAvatarDetailInfo[seat].m_arrCardInfoArray` 与 `m_arrSelectedCards[0]`；
而 cmd1 的 `CCardIDInfo` **只有 CardID + CardSeq、没有星级/技能等级**（`CCardIDInfo.as:21`），
硬凑会把战斗卡牌等级写坏。单人只打自己座位 ⇒ 发 0 条最忠实、零风险，**且完全不需要写 AMF3**。
（多人 2v2 才必须补，见 §8。）

> **`m_nGameMode` 的正确取值是"回显客户端"而不是写死** —— 证据：把 `server.log:4754` 那条
> SIT_DOWN 明文（`a_2928` 布局，`battle-protocol.md §14`）逐字段解出来，**恰好消费满 56 字节**
> （base=0 自洽），得到 `m_byACT=0 / m_iRoomID=3 / m_iTableID=-1 / m_bySeatID=0 /
> m_szTableKey="\0" / m_szTableName="欢乐大冒险,Let's go!\0" / m_iGameMapID=3 /
> **m_byGameMod=1** / m_bLevel=3 / m_byPlayerCount=-1 / m_nMapListCount=1 / m_aryMapList=[3]`。
> 对照 `a_1748.as:16` `enmGameMode_vComputer = 1` ⇒ 真实客户端送的是 **1**，
> 而旧实现 `roomState.gameMode` 的兜底默认值是 `2`（`= enmGameMode_1vComputer`），
> 若 129 写死就会让 `a_2179.as:664` 的战斗分支走错家族。
> 注意 `a_1748` 里 `enmGameMode_2v2` 与 `enmGameMode_vComputer` **都等于 1**（别名重载），
> 单看数值无法区分语义，所以**必须回显**、不能推断。

### 5.3 已落地实现（`server/local-server.mjs`）

```js
// 129 体：int16 gameMode | int16 N | uint32×N | int16 0 | int16 0 | int32 seed
export function buildLoadStartPayload({ gameMode, cardIDs, seed }) {
  const ids = (cardIDs ?? []).slice(0, MAX_SELECT_CARDS);   // 24，见 a_2179.as:254
  const parts = [int16(gameMode | 0), int16(ids.length)];
  for (const id of ids) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(id >>> 0, 0);        // propertyArray 声明 uint32
    parts.push(b);
  }
  parts.push(int16(0));   // m_nSelectPropIDCount：客户端无读点
  parts.push(int16(0));   // m_nAvatarInfoCount：见 §5.2 ★
  parts.push(int32(seed | 0));
  return Buffer.concat(parts);
}

// 130 体：int16 波数 | int32 seed | int32 buffId（定长 10）
export function buildGameStartPayload({ waveNum, seed, buffId = 0 }) {
  const b = Buffer.alloc(10);
  b.writeInt16BE(waveNum | 0, 0);
  b.writeInt32BE(seed | 0, 2);
  b.writeInt32BE(buffId | 0, 6);
  return b;
}
```

触发逻辑（`handlePacket` 的 8709 分支）：
- `cmd === 1`：解析 `a_2726` → 存 `battleState.cardIDs` → 每局新 seed → **推 129**（50ms 延迟）。
  解析**必须长度自洽**（消费字节数 == gdLen-1），否则只打日志不推帧。
- `cmd === 3` 且 `progress >= 100`：若已发 129 且未发 130 → **推 130**。
- **128 不发**；L1 不动。
- **129 每局只发一次**：`a_2179.as:1681-1682` 会在 `LoadEndAndStartGame` 末尾把 `a_767/a_768`
  复位，第二份 129 走到 `:849` 会掉进最后的 else 分支，把整局卡死。
- 环境变量：`REA_BATTLE_SEED`（固定种子，测试用）、`REA_TOTAL_WAVE_NUM`（默认 20）。

**⚠️ 帧头口径（本轮修掉的真实 bug）**：服务端下行头必须 **24 字节、不写 httpHead**。
`a_1779.as:84 packageBytes.position = 0;` → `a_2220.a_2204` → `a_2670.decode`（从 `nPackageLength` 开始读）。
`frame-codec.mjs` 的 `encodeHeader` 此前照抄了 `a_2670.encode` 的**客户端上行**口径（多写 1 字节），
已改为 `httpHead = false` 默认；详见 `battle-protocol.md §18.2`。

### 5.4 为什么"129 早发/晚发"都能收敛（`a_2179.as` 的两段门）

> **⚠️ 2026-10-14 追加（实机截图定位）：还差一条 SC 131，而且必须发满 4 个座位槽。**
>
> 症状：「开始」按钮在右下角可见，但右侧「我的防御卡」面板**完全空白**，选不了卡。
>
> 因果链（全部有代码证据）：
> 1. 卡面板由 `CardReadyPanel.onShowCardPackageCards(arrTDCards[0], …)`（`CardReadyPanel.as:355`）填充；
>    它**唯一**的调用点是 `TableReadyUI.showReadyCards()`（`TableReadyUI.as:400-411`）。
> 2. `showReadyCards` 由 `TDGameReadyUI.as:206-216` 赋给 `stTableReadyUI.fn_CallBack`，
>    而 `fn_CallBack()` 只在 `TableReadyUI.showVcKey()` 末尾触发（`:373-376`）。
> 3. `showVcKey` 只有两个调用点：`TDGameReadyUI.as:383`（a_3721 路径）与
>    **`:559`——位于 `a_2089`（SC 131 的落地函数）的 `else if(status.m_byReadyStatus == 255)`
>    分支（`:548-560`），即"该座位是空的"分支**。
> 4. ⇒ 131 只带 1 个座位槽时，`:528` 的循环只跑 iGameSeatID=0（本座位不是 255），
>    255 分支永不执行 ⇒ `showReadyCards()` 不执行 ⇒ 面板空白 ⇒
>    `TableReadyUI.dealSubmitReadyGame()` 在 `:842-845` 因 `defCards.length == 0`
>    返回 `enmGameReady_SelectCardID1` ⇒ `onPostSelectedCards` 永不调用 ⇒
>    **cmd1 永不发送，129/130 全部不会触发**。
> 5. 所以 SC 131 必须发 **4 个座位槽**（下标即座位号，空位 `readyStatus = 255`），
>    见 `local-server.mjs` 的 `TABLE_SEAT_SLOTS`。`verify-battle.mjs` C2 已加回归护栏：
>    "空座位槽必须恰好 3 个"。
>
> 另一条同源的必需项：`TDGameReadyUI.as:87` 的 `a_1674` 初值 **-1**，唯一赋值点 `:525`
> `= sittedPlayerStatusNotify.m_byIsGameCanStart`；「开始」按钮分支 `:970-991` 最后一句是
> `:986 else if(this.a_1674 == 1) this.ready(...)` ⇒ **131 的 `canStart` 必须是 1**，
> 否则点「开始」是**静默空操作**（这正是前两轮"点了没反应"的直接原因）。
> 同时 `a_2179.as:1736-1740 a_2195()`（初始化战场 UI）要求 `m_stSittedPlayerStatusNotify != null`，
> 该字段也由同一份 131 写入。

| 行号 | 代码 | 作用 |
|---|---|---|
| `:650` | `this.a_771 = stLoadStartNotify;` | 版本数据未到时**暂存** 129 |
| `:651` | `if(GetVersionByKey("TDGame2V2BattleUI.swf") == null) return;` | 版本未就绪则先返回 |
| `:1591` | `this.a_2087(this.a_771);` | 版本就绪时（`a_2189`）**重放**暂存的 129 |
| `:663` | `this.a_767 = true;` | **129 已收到的唯一标志** |
| `:810` | `if(arrPendingLoadingRes.length > 0 \|\| arrPendingAvatarLoadingRes.length > 0)` | 有资源要加载 ⇒ `startLoad()`，完成时调 `a_2193(null)` |
| `:849` | `else if(this.a_768 && !a_3004.isLoading) this.a_2193(null);` | 无资源可加载时的兜底（要求 `a_768` 已 true） |
| `:853-856` | `else { trace("Game: AurLoader is Loading.."); }` | **死路**：什么都不做，`a_2193` 永不触发 |
| `:1663` | `TDGameCoreUI.a_757 = TDGameCoreUI.a_1668.content as b_147;` | 战场 UI 实例在此创建 |
| `:1669` | `this.a_768 = true;` | |
| `:1670` | `if(!this.a_767) { trace("...not recieve game load start..."); return; }` | **没收到 129 就直接返回** ⇒ `:1679 a_2195()`（真正初始化战场 UI）被跳过 |
| `:1679` | `this.a_2195();` | 初始化战场 UI（`a_3600/a_3603/a_3604/a_3605/a_3606/a_3607`） |
| `:1680` | `this.a_759.a_2058(100);` | **只有走到这里才上报进度 100** |
| `:1681-1682` | `this.a_767 = false; this.a_768 = false;` | 复位，为下一局准备 |

由此得到两条**推翻旧假设**的结论：

1. **"没有 129"的根因不是"没有战场 UI"，而是"进度永远不上报 100"**。
   `a_757` 在 `:1663` 照样被创建，但 `:1670` 的早退让 `a_2195()` 不执行，
   战场 UI 建好却从未被初始化 ⇒ 看起来"进了战场但打不了"。
2. **`m_arrSelectCardIDs` 非空是必需的**，它让 `:810` 分支成立、从而保证 `a_2193` 一定被调用；
   否则 129 一旦"晚到"（`a_768` 已被 `:1682` 复位为 false）就会掉进 `:853-856` 死路。
   同时它也是 130 的门：130 若在 `a_757` 为 null 时到达，`a_2088` 的
   `:891 TDGameCoreUI.a_757.a_3435(...)` 会直接抛异常。
   ⇒ **`cmd3 进度 = 100` 是"129 已被消化 + a_757 已建好 + a_2195 已执行"的可靠确认信号**，
   这正是 130 的正确门。

**实测佐证**：`server.log` 里全部 94 条 8709 上行按
`[int32 roomID][int32 tableID][int16 gdLen][uint8 cmd][载荷]` 逐字节解出的分布是
**cmd3×92 / cmd12×1 / cmd9×1 / cmd1×0** —— 那次会话玩家没点「开始」，所以服务端没收到 cmd1，
也就没有推 129，客户端的进度因此**停在上报 1..88 后不再上升**（`:1670` 早退导致 100 永远不来）。
这条日志本身就是"两段门"的行为学证据。

### 5.5 落地顺序（已完成）

1. ✅ 129/130 体做实（`buildLoadStartPayload` / `buildGameStartPayload`）。
2. ✅ 触发点换成 `cmd1` → 129、`cmd3(100)` → 130；删除 SitDown 触发。
3. ✅ 帧头口径修正（downlink 24 字节，无 httpHead）。
4. ⏳ 实机验证（需重启服务端 + 真人点「开始」）→ 见 §7。
5. ⏳ 多人 avatar 数组（AMF3 写入）→ 见 §8。

### 5.6 ★★ 2026-10-16 更正：服务端**下发**战斗数据走的是 8711，不是 8709

> **这是"129/130/131 从来没生效"的真正原因。** 第十二批把下行帧按 `8709`（`b_154.a_152`
> `SEND_GAME_DATA`）封进 `a_2926` 包装推下去 —— **客户端收到 8709 时根本不看载荷**。

**证据（反编译逐条）**：

| 位置 | 代码 | 含义 |
|---|---|---|
| `b_177.as:134` | `a_2247(b_154.a_152, this.a_2624)` | 客户端把 **8709** 绑定到 `a_2624` |
| `b_177.as:540-553` | `a_2624` 只 `new a_2951()` 解 `m_nResultID/roomID/tableID`，`if(0 == resultID) {}` **空体**，随后只有一行 `trace` | ⇒ **8709 是"客户端自己上行的应答"，载荷被丢弃** |
| `b_154.as:102` | `a_154 = 8711` | 真正的下发通道号 |
| `b_178.as:79-109`（`a_2639`，即 `8711` 的处理器） | `new a_2903()` → 按 `m_iRoomID` 找 `a_2445` → 对每个 event `lobbyHandler.a_2456(header{shMessageID=b_101.a_464}, ev.m_szGameData)` | ⇒ **8711 = `CNotifyGameData`**，每个 event 的 `m_szGameData` 是**裸的 L2 载荷** |
| `a_2903.as:33-42` | `int32 roomID / int32 tableID / int16 eventCount / count × CGameEvent` | 通知体布局 |
| `CGameEvent.as` | `int32 m_iGameEventSequence / int32 m_iGameDataLength / memory m_szGameData` | 事件布局 |
| `a_2445.as:465+`（`a_2464`）/ `a_2468` | 未命中 `EnmProxyCmd` 分支就 `this._pGameInstance.a_1842(buf)` → `a_2053.a_2055` | ⇒ 裸载荷首字节 = L2 命令号（129/130/131…），客户端据此分发 |

**另一个必须满足的条件**：`a_2639` 会用 `(serverID, roomID)` 去
`a_2445.getLobbyAdapterHandlerByConnInfo()` 找处理器，**找不到就 `trace("lobbyHandler … is null")` 丢弃**
（`b_178.as:95-100`）。所以通知里的 `m_iRoomID` **必须等于客户端当前坐下的房间号**
（也就是客户端自己 8709 上行信封里的 roomID）。

**服务端实现**（`server/local-server.mjs`）：

```js
// 8711 CNotifyGameData：int32 roomID | int32 tableID | int16 count |
//                       count × { int32 seq | int32 len | len bytes L2 载荷 }
export function buildGameDataNotifyBody({ roomID, tableID, events }) { … }
export function buildGameDataNotifyPacket(sessionKey, { roomID, tableID, events }) { … }  // messageId = 8711
```

`129/130/131` 三条推送已全部改走它（`buildBattleStartFrames()` 与 cmd9 的 131 分支），
日志前缀相应改为 `-> L1 8711(CNotifyGameData) …`。

**测试**：`verify-battle.mjs` 的 C 段整体重写为"解 8711 → 解 a_2903 → 取事件载荷 → 断言命令号与体"，
并新增 `parseGameDataNotify()/firstL2Data()/notifyCmds()` 三个解析器；
A11 也改成直接断言 8711 组装（原来断言的是 8709）。**29 通过 / 0 失败**。

> 复刻意义：这条更正同时解释了此前的两个"神秘现象"——
> ① `a_1674` 永远是 -1 ⇒「开始」是**静默空操作**（`TDGameReadyUI.as:986` 的 `else if` 不成立）；
> ② `TableReadyUI.showReadyCards()` 从未被调用 ⇒「我的防御卡」**连卡位格子都不建**、点卡无回调。
> 两者都是"131 没送达"的下游表现，而不是各自独立的 UI 缺陷。

---

## 6. 战斗内上行消息清单（CS 段）

`b_102.as` 常量 `[实测]`；编码点位于 `a_2053.as`（`encode_int8(encodeBuffer, b_102.<cmd>)` 形式）。

| cmd | 常量 | 名称 | 编码点 | 是否必须应答 |
|---|---|---|---|---|
| 13 | `enmGameDataCmd_CS_PickupProps` | 拾取道具 | `a_2053.as:409` | **否**。`[推断]` 结果以 SC 广播形式回来 |
| 14 | `b_115` | PostAvatarInfo | `:421`/`:434` | **否** `[推断]` |
| 21 | `b_121` | PostDataToOtherPlayers | — | **否**，PvP 转发用，单机忽略 `[推断]` |
| 23 | `enmGameDataCmd_CS_RequestLaunchSkill` | 请求释放技能 | `:532` | **否**；原版靠服务器校验后广播 |
| 24 | `enmGameDataCmd_CS_SecrityCode` | 反外挂校验 | **无编码点** | **不适用** `[实测]`（客户端不发） |
| 25 | `enmGameDataCmd_CS_ChangeSecrityCode` | 变更校验码 | `:552` | **不适用** `[实测]` |
| 27 | `enmGameDataCmd_CS_PostPlayerEnergyValue` | 上报能量 | `:559`/`:571` | **否** |
| 28 | `enmGameDataCmd_CS_DamageValidate` | 伤害校验 | `:287` | **否** `[推断]` |
| 29 | `enmGameDataCmd_CS_InputSecrityCode` | 输入校验码 | `:544` | **不适用** `[实测]` |
| 30 | `enmGameDataCmd_CS_BOSSDamage` | BOSS 伤害 | `:252` | **否** `[推断]` |
| 32 | `enmGameDataCmd_CS_EntityStateChange` | 实体状态变更 | `:315` | **否** `[推断]` |

**要点**：
- 这些上行**不是"请求-应答"模式**，客户端大多不等待回应；服务端**静默登记即可**（参照 `local-server.mjs:2046-2050` 的 `NO_REPLY_MSGIDS` 做法，避免刷"未处理报文"日志）。
- **24/25/29 三个 `SecrityCode` 命令在 `a_2053.as` 中无编码点** `[实测]`，说明客户端当前版本**不主动发**它们（`battle-protocol.md:302` 的"服务端必须实现"是针对 SC 侧 152/153/157 推送的，与 CS 侧不同——**建议核对**，这是 §8 的未判定项之一）。
- 单机复刻要"打得起怪"，真正关键的不是应答这些上行，而是**下发驱动怪物的 SC 帧**（`a_2075`/`a_2076`/波次相关 `b_127`~`b_146` 等，见 `b_102.as:74-104`）。该部分**尚未取证**，见 §8。

---

## 7. 待实测校准项

### 7.0 ★ 2026-10-16 实机定案：卡在 99% 的**真根因是启动页没把画布缩放到窗口内**

> 结论一句话：**玩家点不到「开始」——不是协议错，是「开始」按钮落在可视区之外。**

**症状**（`server/server.log.pre-pagefit-20261016-1010`，09:47 那次真机会话）：

- 走到准备界面一切正常：服务端按预期推了 `cmd=131`（4 个座位槽、`canStart=1`）与 `14620`（158 张卡）。
- 客户端把战斗模块预载到 **进度 99% 就停住**（`cmd3` 进度序列 `1..99`，共 93 条），
  之后只剩心跳 —— 即 `a_2179.as:1670 if(!this.a_767) return;` 的早期返回态（没收到 129）。
- 整个会话 **0 条 `cmd1`(PostSelectedCards)**，因此服务端**从未**推 129（129 的唯一触发点就是 cmd1）。
- 逐条排查过 `dealSubmitReadyGame()` 的所有门（`TableReadyUI.as:818-948`），**全部通过**：
  道具/英雄包未满、卡组非空（地图 0x0701 的 6 张默认卡玩家全有，
  见新工具 `node server/check-ready-deck.cjs 0x0701`）、`0x0100` 位地图的指定卡也满足（`0x11370015`）、
  `heroMapEnable/heroCountEnable/checkYiji/checkSeason` 全 true、`a_1674==1`（131 里给的）。
  ⇒ **协议与数据侧没有可指摘之处，问题只能在"点不到按钮"。**

**几何实测**（`server/_screen.png` 逐像素 + `Screen::PrimaryScreen`）：

| 量 | 实测值 |
|---|---|
| 屏幕 / DPI | 1536x864，`LogPixels=120`（125% 缩放） |
| FCBrowser 窗口 | `(13,58) 1200x525` |
| 浏览器 chrome 底边 | y=101（白） |
| 页面 `#111` 背景带 | y=102..114（即 `padding:12px`） |
| **画布起始 y** | **116** |
| 画布声明尺寸 | **950x600**（`INDEX_HTML` 的 `<object width="950" height="600">`） |
| 窗口客户区底边 | ≈517 |
| ⇒ 可见画布高度 | **≈400px / 600px = 67%**，**底部约 200px 被裁掉** |

准备界面右下角的「开始」按钮（`ReadyButton.startBtn`，位于画布底部）就在被裁掉的那 200px 里
⇒ 玩家**根本点不到** ⇒ 没有 cmd1 ⇒ 没有 129 ⇒ 卡在 99%。旧 CSS 是
`#wrap{display:flex;justify-content:center;padding:12px}` —— **不缩放**，所以窗口一矮就必然裁底部。

**修复**（`server/local-server.mjs` 的 `INDEX_HTML`）：

1. 新增 `fitGame()`：按 `min(vw/950, vh/600)` 等比设置画布 CSS 宽高（并挂 `resize` + 启动前 10s 内重试），
   保证**任意窗口尺寸下整个 950x600 界面都可见可点**；`#wrap` 改为 `position:fixed;inset:0` 居中的 flex 容器。
2. 顺带给启动页加了**几何自诊断**：`diagGeom()` 在 0.5s/4s 把
   `innerWidth×innerHeight / dpr / scale / 画布 rect / 滚动高度` 回报到 `/__diag`
   ⇒ 以后"按钮点不到"这类问题第一次就能拿到实测数字，不必再靠反推。
3. 服务端加了**特征信号告警**：整局收到 `cmd3` 进度 ≥99 却从未收到 `cmd1` 时，
   打一条 `⚠ 载入进度到 N% 但整局都没收到 cmd1…`，直接把上面两条检查项写进日志。

**回归护栏**：`verify-battle.mjs` 新增 E1/E2（抓 `fitGame`、`resize`、等比公式、几何上报，
并断言旧的"不缩放"布局不会复活）。合计从 27 → **29 通过 / 0 失败**。

**仍需实机确认的一步**：服务端已重启（`server.log` 已归档为 `server.log.pre-pagefit-20261016-1010`），
但**运行中的游戏实例仍是旧页面**——必须刷新页面（F5）让新版 `INDEX_HTML` 生效，
然后按 7 表第 0/1/2 项看日志是否出现 `PostSelectedCards → 推 L2 LoadStart(129)` 与
`-> L2 StartGame pushed: cmd=130`。

以下必须在**真实客户端**里验证，不能只靠静态阅读。**§5 已把服务器侧做到"可实测"的程度**，
下表按"下一步实机验证的顺序"重排（前 4 项是 task-5 之后的实机清单）：

| # | 待验证点 | 验证方法 | 风险 |
|---|---|---|---|
| 0 | **帧头口径（24B 无 httpHead）在真机上能否解出** | 重启服务端 → 进准备 UI → 点「开始」→ 看服务端日志出现 `PostSelectedCards: ... → 推 L2 LoadStart(129)`，且**客户端不卡在载入界面** | **已由静态证据定案**（`a_1779.as:84` → `a_2670.decode`），但真机首次验证仍是关键一步 |
| 1 | **`cmd1` 是否真会被发出** | 点「开始」后看日志是否出现 `PostSelectedCards: cards=N ...`。若没有，说明客户端走的是别的入口（`TDGameReadyUI.as:388` 的匹配模式分支 / `:949` 的空卡组分支） | **高** —— 这是 129 的唯一触发点 |
| 2 | **`cmd3 进度 = 100` 是否真的会到** | 点「开始」后等载入完成，看日志是否出现 `-> L2 StartGame pushed: cmd=130` | **高** —— 这是 130 的唯一触发点 |
| 3 | **129 的 `m_nGameMode` 回显是否正确** | 对照 `roomState.gameMode`（实测客户端坐下时 `m_byGameMod = 1`）；`a_2179.as:664` 会把它写进 `m_arrGameData["byGameMode"]`，错误会让战斗走错分支（`TDGame2V2BattleUI.as:487/523/576`） | **高** |
| 4 | `m_nTotalIntruderWaveNum` 的正确取值 | 目前默认 20；它是**纯显示**（`TDGame2V2BattleUI.as:1124`），进战场后看"剩余波数"指示条是否合理 | 低（不驱动出怪；只需 > 0 避免 `a_3563:38` 除零） |
| 5 | `m_arrAvatarInfoArray` 发 0 条是否够单人用 | 观察角色是否出现、能否放置塔。理由是 `a_2179.as:312-313` 本机 avatar 已本地建好 | 中 |
| 6 | 单机下是否需要 SC 波次帧 | 不发任何波次帧，观察是否自然出怪 | **高** |
| 7 | 客户端本地时钟实际频率 | 统计 8709 上行 `cmd3/cmd12` 速率 vs 实际墙钟 | 中 |
| 8 | `SecrityCode` 是否在特定路径下才发 | 检查 `a_2053.as:552/544` 调用方（当前未追） | 中 |
| 9 | AMF blob 的最小可用结构（**仅多人需要**） | 构造最小 blob 逐步加字段，观察 `a_2179.as:673 readObject()` 结果 | 高，但单机不需要 |

> **实机验证前置条件**：必须**重启服务端**（客户端不会重新认证，靠确定性会话密钥自愈），
> 并且**玩家要在准备界面点「开始」**—— 否则 `cmd1` 不会发出，129/130 都不会触发。

---

## 8. 未判定项清单（需补充证据，**不编造**）

| # | 未判定项 | 需要什么证据 |
|---|---|---|
| 1 | 驱动"出怪 / 波次推进"的 SC 帧集合与最小序列 | 通读 `a_2053.as:82-112` 的 `b_127`~`b_146` 各 handler（`a_2089`~`a_2108`）及其下游；结合 `a_2179.as:911 a_2181(stNextEnmeyWave:a_2699)`、`a_2179.as:1139 a_2182`、`a_4258.as:33 a_3608` 的调用链 |
| 2 | 130 的 `m_nTotalIntruderWaveNum` 与 SC 波次帧是否必须一致 | 运行 `TDGame2V2BattleUI.as:1124` 的 `a_3563()` 逻辑，看是否校验/断言（已读：`a_3563`/`a_3564` 只用它做显示换算，无校验） |
| 3 | `SecrityCode`（SC 152/153/157）单机是否需要握手 | 读 `battle-protocol.md:302` 所述子系统 + `a_2053.as:106-108` 三个 SC handler 的下游 |
| 4 | 客户端本地时钟精确频率（Hz） | 由 `iTimeIntervalNum` 的赋值点反推，或运行时埋点统计 |
| 5 | `PostDataToOtherPlayers`(21) 在单机是否被调用 | 追 `a_2053.as` 中该 cmd 的调用方 |
| 6 | ~~129 中 `m_nSelectCardIDs` / `m_nSelectPropIDs` 是否被消费~~ | **已判定**（全量 grep）：`m_arrSelectCardIDs` 唯一读点 `a_2179.as:801`（资源预加载）；`m_arrSelectPropIDs` **0 读点** |
| 7 | 129 的 AMF blob **最小**必需字段集（**仅多人需要**） | 见 §7 第 9 项；`a_2179.as:669-698` 会读 17 个字段 + `m_arrGenInfoArray`/`m_arrCardEffectAddArray`/`m_arrPetInfoArray` |
| 8 | `iTimeIntervalNum` 与服务器是否有任何隐性耦合 | 全树追其读写点（本次未做） |
| 9 | 多人（2v2）时其他座位的 `CAvatarInfo` 必须填什么 | 需要写 AMF3 blob（`readObject()` 侧共 17 个标量 + 3 个数组）；`CGameCardInfo` 的星级需从服务端卡表回填 |

---

## 9. 工作量估算

### 档位 A：最小可玩（能进战场、能放塔、能出怪）

| 工作项 | 规模 | 依据 |
|---|---|---|
| 129 `a_2698` 编码器（含 count `nosize` 机制） | 中 | §1.1 / §1.4 |
| `CAvatarInfo` + AMF blob 生成 | **大**（最大风险） | §1.5 / §7-4 |
| 130 `a_2695` 编码器 | **小**（10 字节定长） | §1.2 |
| SC 波次/出怪帧 | **大**（尚未取证） | §8-1 |
| 128 StepSync | **零**（不需要） | §4 |
| **合计** | 中~大 | — |

### 档位 B：忠实复刻（数值/随机与原版一致）

在档位 A 基础上追加：

| 工作项 | 规模 | 依据 |
|---|---|---|
| 种子管理（每局生成 + 129 注入） | 小 | §2.3 |
| 全部 SC 战斗帧实现 | 大 | §8-1 |
| `a_555`/`a_3608` 调用时序保真 | 中（**易被忽略**） | §3.4 |
| 反外挂子系统（若确需） | 中 | §8-3 |

> **相对初判的工作量修正**：**省下整个 128 步进状态机**（原估"起始步号 + 频率 + ACK 判定"三项工作量归零），因为 §4 已证实客户端自走时钟。这是本方案最大的简化。

---

## 10. 交付物与纪律声明

- 本文档为 task-4 的**唯一**交付物。
- 本次取证**未修改**任何代码文件：`msdzls/server/local-server.mjs`（fixer-server 独占）、`msdzls/server/verify-*.mjs`（verifier）均未触碰；未重启任何服务端进程。
- 本文引用的所有 `file.as:行号` 均经实际 `read`/`grep` 抽查（见各节标注）。
- 若本文与 `battle-protocol.md:566`（称 128 为"战斗推进的心跳"）冲突，**以本文 §4 的证据为准**，建议同步修正该文档。
