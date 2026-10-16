# 出怪 / 波次推进：SC 132 `NextEnmeyWave` 规格与落地

> 2026-10-16。服务端 `server/local-server.mjs` 的 `buildNextWavePayload` /
> `battleWavePlan` / `startWavePushes` 就是照这份规格写的；
> 护栏是 `server/verify-battle.mjs` 的 G1–G5。

## 1. 为什么"能放塔但不出怪"

客户端里，怪物的**唯一**来源是服务端下发的 **132**：

```
a_2053.as:85   this.a_2054(b_102.b_128, this.a_2090)          // 132 → a_2090
a_2053.as:738  a_2090 → new a_2699().decode(buf) → this.a_749.a_2181(...)
a_2179.as:911  a_2181 把 m_arrEnmeyInfo 逐条翻成 a_4269（pending intruder）
a_2179.as:934  TDGameCoreUI.a_757.a_3608(vector, waveProgress, waveStatus, holeCount, hole)
TDGame2V2BattleUI.as:1359  m_stMoveIntruderManage.a_3608(vector)     // 只是排队
BattleFieldView.as:1825/2141 每 tick 取一只 → a_3456(一只)
BattleFieldView.as:3107  a_4255.a_4256(typeID) 造实体 ⇒ 怪真的出现
```

所以：**服务端不发 132 ⇒ 客户端一只怪都不会有**。131（座位状态）与 129（载入）
都跟出怪无关。

## 2. 鼠表：只能发"客户端注册过"的 ID

`BattleFieldView.as:3107-3112`：

```as3
stBaseMoveIntruder = this.m_stMoveIntruderFactory.a_4256(stAddedMoveIntruder.m_iIntruderType);
if(null == stBaseMoveIntruder) {
   trace("IntruderFactory.GetMoveIntruder failed for IntruderType:" + …);
   throw new Error("此老鼠不存在ID:" + stAddedMoveIntruder.m_iIntruderType.toString(16));
}
```

工厂 `a_4255`（= `MoveIntruderFactory`）的注册**只**发生在客户端启动：
`TDCore.as:36 TDFactoryImport.ImportAll()` → `BattleRegisterUtil.RegisterCreator`
→ 落在 `0x800000 ≤ id < 0x810000` 的全部条目（`BattleRegisterUtil.as:31-34`）。

**实测：这份客户端只注册了 45 只**（`node server/check-wave-mice.mjs --list`）。

⚠ 关键坑：`map_mouse.xml` 里那张图（古堡初探 `0x50010301`）自带的 29 只全是
`0x1xxx` 次元/新章鼠，**一只都没注册**。照抄地图配置发过去，客户端当场
`throw("此老鼠不存在ID:…")`——而且异常发生在动态加载的战斗模块里。

所以 `resolveWaveMice()` 的口径是：

```
REA_WAVE_MICE（显式指定，逐只校验白名单）
  > 地图鼠表 ∩ 白名单
  > 经典三只 [0x0001 小老鼠, 0x0002 气球扇鼠, 0x001e 小老鼠·变体]（兜底，全在册）
```

客户端**自己的**鼠表也是从同一个 `map_mouse.xml` entry 读的
（`a_2439.as:210-217`：用坐下应答的 mapID 去查 `m_dictMapMouse`），
只是它读来是拿去**预载美术**（`resource/0x80xxxx.swf`），与"能不能造"无关。

## 3. SC 132 字节规格（`a_2699`）

`com/aurora/protocol/game/maogoutd/a_2699.as:36-56` 的 `decode()` 逐字段：

```
int8  m_byAppearRatHoleCount     ← 本波开几个鼠洞（a_3608 里 a_3463(...) 调几次）
int8  m_byAppearRatHole          ← 洞的基号：客户端 a_3463(byAppearHole*(i+1))
int8  m_byWaveProgress           ← 0..100，喂 a_3564()；**=100 时把波数 +1**（a_3564:75-80）
int8  m_byWaveStatus             ← 0 普通 / 1、2 大波来袭提示 / 3 BOSS 阶段
int16 m_nEnemyNum                ← 下面 CPendingEnemy 的条数
× m_nEnemyNum  CPendingEnemy (13 字节):
    uint16 m_nEnemySequence      ← 全局唯一序号
    uint32 m_uiEnemyTypeID       ← 老鼠 ID（客户端统一 +0x800000 变成 IntruderType）
    uint8  m_byAppearType        ← 2 = 从**已有鼠洞**钻出；0 = 从场地边缘走入
    uint8  m_byRow               ← 行走行号，合法范围 0..a_1012-1
    uint8  m_byAppearFlag        ← >0 才走"洞口"分支（a_3438/a_3429 取洞）
    uint32 m_uiTimeTickCount     ← 出现时刻，**50ms 一 tick**
```

体长 = `6 + 13N`（服务端 `nextWavePayloadLength`）。
`a_2179.a_2181` 的字段映射（一行都别漏）：

```as3
m_iAppearTime        = m_uiTimeTickCount;
m_iIntruderGlobalNo  = m_nEnemySequence;
m_iIntruderType      = 8388608 + m_uiEnemyTypeID;     // ★ 客户端自己加 0x800000
m_iIntruderXGridNo   = TDGameCoreUI.a_757.a_3602() - 1;  // 最右列，服务端不用给
m_iIntruderYGridNo   = m_byRow;
m_iApearFlag         = m_byAppearFlag;
m_byAppearType       = m_byAppearType;
```

## 4. 时间基准：tick 0 = 客户端处理 **130** 的那一刻

```
a_2179.as:891   TDGameCoreUI.a_757.a_3435(stGameStartNotify);        // 130 的处理函数
TDGame2V2BattleUI.as:1035/1036  两个战场各调一次 BattleFieldView.a_3435()
BattleFieldView.as:1643-1648
      this.a_1066 = 0;                 // 当前 tick 归零
      this.a_1064 = getTimer();        // 起算点
BattleFieldView.as:2078   iGetTimerTimeIntervalNum = int((getTimer() - a_1064) / 50);
BattleFieldView.as:1350   iPlayMouseIntruduceSoundDelay = (iFirstAppearTime - iTimeIntervalNum - 20) * 50;
```

⇒ tick 单位 **50ms**，`m_uiTimeTickCount` 就是"距 130 处理时刻多少个 50ms"。
服务端用**推送 130 的墙钟**当 t0 即可（差几毫秒，而第一波在 3 秒之后）。

## 5. 服务端落地与可调项

`startWavePushes()` 在推完 130 之后启动，每 100ms 检查一次 tick 表，
到期就把该波整包（这一波所有怪 + 出现时刻）推出去。

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `REA_WAVE_START_TICK` | `60` | 第一波第一只的 tick（60×50ms = 3s） |
| `REA_WAVE_GAP_TICKS` | `300` | 波间隔（15s） |
| `REA_WAVE_SPAWN_GAP` | `20` | 波内每只间隔（1s） |
| `REA_WAVE_APPEAR` | `2` | `m_byAppearType`（2 = 从鼠洞钻出） |
| `REA_WAVE_HOLES` | `2` | 每波 `m_byAppearRatHoleCount` |
| `REA_WAVE_MICE` | 空 | 逗号分隔的鼠 ID（`0x0001,0x0002`），逐只校验白名单 |
| `REA_WAVE_ROWS` | `0`（自动） | 强制行数；自动 = `a_1012`（本图 7，mapID==3 时 6） |
| `REA_TOTAL_WAVE_NUM` | `20` | 波数；**130 的波数与出怪表共用同一个值** |

### 两个刻意的取舍

1. **每波只发一帧 132，`m_byWaveProgress` 直接给 100。**
   `a_3608` 里 `iFirstAppearTime` 为 0（空怪列表）时会**立刻**播"老鼠出现"音效；
   若每波再补一帧"进度帧"，就会每波多响一次。给 100 既让 `a_3564` 把波数 +1
   （指示条按波前进），又不产生额外帧。
2. **`m_byWaveStatus` 一律 0。**
   取值 1/2 会 `addChild(m_stMouseIntruderWaveAlert)`、3 会切 BOSS 阶段 UI
   （隐藏指示条、显示 BOSS 血条、换地图美术）—— 这些 UI 属于"另一件事"，
   等基础出怪实机跑通再谈。

## 6. 护栏（`server/verify-battle.mjs` G1–G5）

| # | 断言 |
|---|---|
| G1 | 130 之后必须推 132；体长 = `6+13N`；`waveProgress=100`、`holeCount=2`、第一波 5 只 |
| G2 | 每只：ID ∈ 白名单、行 0..6、`appearType=2`、`flag ∈ [1,2]`、tick 严格递增、首只 tick=60 |
| G3 | 出怪表是种子化纯函数（同种子一致、换种子会变） |
| G4 | 地图鼠表∩白名单；零交集必须回落经典三只（绝不发未注册的鼠） |
| G5 | 132 体逐字节手工拼装比对（照 `a_2699.decode` 抄） |

外加 `node server/check-wave-mice.mjs`：把白名单与**反编译产物**
（`TDFactoryImport.as` / `TDGuideFactoryImport.as`）重新推导的结果逐条比对，
缺的/多的/名字不符都会报，`exit=1`。`decompiled/` 不存在时它报"没得比"并 `exit=2`，
**不会假装通过**。
