# 「载入进度永远停在 99%」的根因：战斗模块是**资产层**，且被客户端加载进了子域

> 2026-10-16 定案。本文只写**实测证据**，不写推测；文末给出尚未实机确认的一步与实验方法。

## 0. 结论（先看这段）

1. 战斗 UI 的**逻辑**在 `TDCore.swf` 里（`com.aurora.ui.maogoutd.TDGame2V2BattleUI`
   以及它引用的 `...game.MoveIntruderWaveNumberIndicatorView` 等），**美术一个都没有**；
   美术（135 个元件）在 CDN 的 `TDGame2V2BattleUI.swf` 里，**逻辑一行都没有**。
2. 两份文件里**类名完全相同**；客户端用**子域**加载模块
   （`a_2179.as:1446` → `new ApplicationDomain(ApplicationDomain.currentDomain)`），
   ⇒ 模块里的**空壳类遮蔽**了 TDCore 的逻辑类。
3. 于是 `a_2179.as:1663` 的 `TDGameCoreUI.a_757 = a_1668.content as b_147` 得 **null**，
   紧接着 `:1664 TDGameCoreUI.a_757.SetDIYInfo(...)` **空引用抛异常** ⇒
   `LoadEndAndStartGame()` 夭折 ⇒ 既不初始化战场（`a_2195`），也不上报进度 100
   ⇒ **永久停在 99%**。
4. 上一轮的 Haxe「空桩」（`tools/battle_stub/Main.hx`）确实能让 `as b_147` 通过，
   但桩里**一个 `m_st*` 元件都没有**：TDCore 那份逻辑类里有 **1141 处** `m_st*` 引用，
   而桩提供的绑定数是 0 ⇒ 过了转换也活不过第一帧（`a_1797` 第一句就是
   `this.m_stUserInfoPanel.x = 0`）。
5. 修法：**把模块 ABC 常量池里的类简单名做等长改名**（`server/patch-battle-assets.cjs`），
   **SymbolClass 标签里的点分全名保持原样**。链名在域链上找不到模块自己的定义了，
   只能落到父域 TDCore 的逻辑类上 —— 逻辑来自 TDCore、时间轴/元件来自模块，
   正是"资产 SWF + 代码在主 SWF"这种分包的正常形态。

## 1. 证据链

### 1.1 TDCore 里没有任何战斗美术（SymbolClass 只有两条）

```powershell
tools\jre\bin\java.exe -Djava.io.tmpdir=tmp -jar tools\ffdec\ffdec-cli.jar `
  -export symbolClass tmp\sym client-cache\TDCore.swf
```

产物 `tmp/sym/symbols.csv`：

```
1;"com.aurora.ui.maogoutd.component.ButtonClickSound"
0;"com.aurora.ui.maogoutd.TDCore"
```

而 TDCore 的反编译产物里 `TDGame2V2BattleUI.as` 有 **1141 处 `m_st*`**、
但 `this.m_stX = …` 形式的赋值只有 29 处 ⇒ 其余全部**期待来自时间轴**。

### 1.2 模块里没有逻辑（可以随便搜）

把 `client-cache/mirror/TDGame2V2BattleUI.swf` 解压成 ABC 后逐串统计：

| 串 | 出现次数 |
|---|---|
| `b_147` / `a_3600` / `a_3604` / `a_3607` / `a_3435` / `a_2058` | **0** |
| `SetDIYInfo` / `SetGameData` / `OnWaveStatusData` / `AddGameEnergy` | **0** |
| `m_stIntruderWaveIndicatorView` / `m_stBattleFieldFor4View` / `m_stUserInfoPanel` | 2 |

`ffdec -export script` 出来的文档类长这样（`tmp/decBattle3/scripts/com/aurora/ui/maogoutd/TDGame2V2BattleUI.as`）：

```as3
[SWF(width="950", height="600", backgroundColor="#454545", frameRate="30")]
public dynamic class TDGame2V2BattleUI extends MovieClip {
   public var m_stBattleFieldFor4View:BattleFieldFor4View;
   public var m_stIntruderWaveIndicatorView:MoveIntruderWaveNumberIndicatorView;
   ...
   public function TDGame2V2BattleUI() { super(); ... 只配 motion 动画 ... }
}
```

**没有任何 `this.m_stX = …`**，也没有方法体 —— 是纯壳。

### 1.3 模块的类也**只是壳**，而且是同名壳

`MoveIntruderWaveNumberIndicatorView`（模块里）：

```as3
[Embed(source="/_assets/assets.swf", symbol="symbol1543")]
public dynamic class MoveIntruderWaveNumberIndicatorView extends MovieClip {
   public var m_stIntruderProgress:MovieClip;
   public var m_stMouseHead:WaveIndicatorMouseHead;
   public function MoveIntruderWaveNumberIndicatorView() { super(); }
}
```

而 TDCore 里同名类**有逻辑**（`a_3563/a_3564`，波数指示条全靠它）。
SymbolClass 标签把它链到这个名字上 ⇒ 谁在域链上先被看到，谁就是元件实例的类。

### 1.4 客户端把它装进**子域**

`decompiled/TDCore/scripts/a_4753/a_2179.as`：

```as3
:659  if(null == this.a_769) this.a_769 = new ApplicationDomain(ApplicationDomain.currentDomain);
:1446 this.CreateLoadTask("TDGame2V2BattleUI","TDGame2V2BattleUI.swf",
                          TDGameCoreUI.a_1668, EnmLoaderType.a_502, false, this.a_769, false);
:1856 if(bIsUseGameAppDomain && null == stApplicationDomain)
:1858    stApplicationDomain = new ApplicationDomain(this.a_769);   // 还是子域（孙域）
```

`a_3004.as:164-166` 把它塞进 `LoaderContext.applicationDomain`。
⇒ 子域里的定义优先 ⇒ 壳遮蔽逻辑。

### 1.5 于是 99% 卡住的现场就对上了

`a_2179.as`：

```as3
:1663 TDGameCoreUI.a_757 = TDGameCoreUI.a_1668.content as b_147;   // ← 得 null
:1664 TDGameCoreUI.a_757.SetDIYInfo(this.m_iDIYInfo, this.m_arrGameData["iMapID"]);  // ← 空引用抛异常
:1669 this.a_768 = true;
:1670 if(!this.a_767) return;
:1679 this.a_2195();                 // 真正初始化战场（被跳过）
:1680 this.a_759.a_2058(100);        // 进度 100 的上报（被跳过）
```

`server.log` 里的现场与之吻合：`cmd3` 进度序列一路 `1..99`（93 条）后**再无 100**。

## 2. 修法与为什么不选别的路

| 方案 | 结果 |
|---|---|
| 直接用 CDN 原件 | 复现"卡 99%"（壳遮蔽逻辑，`as b_147` = null） |
| Haxe 空桩（上一轮） | `as b_147` 过了，但 0 个 `m_st*` 元件 ⇒ 过不了第一帧 |
| **改写模块 ABC 类名（本轮）** | 逻辑回到 TDCore、元件来自模块 —— 两边各司其职 |
| 重写整套战斗 UI（Haxe 里手搓 100+ 元件） | 工作量等于重做一个游戏，且与原版观感必然不同 |

`server/patch-battle-assets.cjs` 只做一件事：解析 SWF 标签链 → 找到 `DoABC2`(82)
→ 解析 ABC 常量池 → 把**恰好等于某个 SymbolClass 类简单名**的 cpool_string 换成
**同长度**的新名（`...View` → `...VieA`）。等长 ⇒ 长度前缀/索引/整个 ABC 结构都不动。

**SymbolClass 标签里的点分全名（`com.aurora.ui.maogoutd.*`）一个字都不改** ——
改名后它们在域链上只能落到父域 TDCore 的同名逻辑类上。

产物：`client-cache/mirror/battle_assets/TDGame2V2BattleUI.swf`（**123 改名 / 12 保持原名**），
服务端默认就发它（`REA_BATTLE_MODULE=assets`；`stub` / `cdn` 留给对照组）。
HTTP 路由是**每次请求现读文件**，所以换完产物**不用重启服务端**，刷新页面即可。

## 2.1 ★ 实机第一次反馈：改名范围必须收窄（2026-10-16 修）

第一版把 **135 个**符号类**全部**改名 ⇒ 实机表现：**能进到界面，但点不动**——
界面画出来了（`卡片1..卡片5`、地图、等待音乐都在），客户端却停在资源预载上，
`server.log` 里只剩 `cmd3 进度 1` 之后再无动静。

原因：135 个 SymbolClass 里有 **12 个类 TDCore 根本没定义**，它们是**纯美术**元件，
模块自己的壳类就是它们的最终实现：

```
com.aurora.ui.maogoutd.game.BigHonorView / HonorNumberMovie
com.aurora.ui.maogoutd.game.GameResultGradeNumberMovie / GameResultOppTeamBreadView
com.aurora.ui.maogoutd.game.GameResultMyTeamBreadView / PlayerGameResultView
com.aurora.ui.maogoutd.game.GameResultMaskBackCardMovie / GameResultGradeNumberView
com.aurora.ui.maogoutd.game.GameResultAlertView
_9级勋章升阶影片外发光 / _9级勋章升阶影片粒子        （中文名元件）
com.aurora.ui.maogoutd.resource.bitmap.RatEarthHoleBitmapdata   （鼠洞位图）
```

把它们也改名 ⇒ 链名在域链上**哪都找不到** ⇒ 装载/实例化报错 ⇒ **卡预载、界面点不动**。

**修法（现行口径）**：**只改「TDCore 里确实有同名类」的那些**（本轮 135 个里取 123 个）；
逐条核对方式是拿 `decompiled/TDCore/scripts/**` 的类清单求交集，另有硬编码兜底清单。
护栏 `verify-battle.mjs` 的 **F2/F5** 就守这条：改名的必须 TDCore 里有、跳过的必须 TDCore 里没有。

> 教训一句话：**"同名就改名"这个推理漏了"模块自己也可能是唯一实现"这一类**。
> 改名集合必须由"对方有没有这个类"决定，而不是由"名字是否相同"决定。

## 2.2 ★★ 实机第二次反馈：改名这条路**走不通**（默认已退回 `cdn`）

把 12 个纯美术元件排除后（123 改名 / 12 保留），实机**仍然卡在资源预载**：
界面画出来了（`卡片1..卡片5` + 地图美术 + 等待音乐），但点不动，
`server.log` 里 `cmd3 进度 1` 之后没有下文，紧接着就是 `GET /TDGame2V2BattleUI.swf` 之后断线。

对照实验（同一台机器、同一份 TDCore，只换模块）：

| 下发的模块 | 实机表现 |
|---|---|
| `cdn`（CDN 原件，**现在的默认**） | 预载**走完**、准备界面可操作、能点「开始」（11:2x 那次 `cmd1` 就是它） |
| `assets`（123 改名） | **卡在预载**（界面在、点不动），两次都一样 |
| `stub`（Haxe 空桩） | 能过 `as b_147`，但一个元件都没有 |

**为什么改名会让预载卡死**：`a_2195()`（真正初始化战场）会 `a_757 = a_1668.content as b_147`，
而改名后那个元件实例的类变成 **TDCore 的 `TDGame2V2BattleUI`**，于是 Flash 走的是
TDCore 的构造函数：

```as3
TDGame2V2BattleUI()            // TDGame2V2BattleUI.as:290
   super();
   ... m_stMaskSprite = new Sprite() ... a_1069 = new Timer(25) ...
   this.a_1797();             // :322  ← 里面第一句就是 this.m_stUserInfoPanel.x = 0
   this.m_stUserInfoPanel.m_stSwitchBattleButton.addEventListener(...)  // :324
```

**时间轴元件是在构造函数之后才绑到同名 public 变量上的**（旁证：模块里那些壳类的构造函数
只有一个 `super()`，没有任何绑定代码；而同项目里能正常工作的 `TDGameReadyUI` 把要用元件的
逻辑放在 `ADDED_TO_STAGE`，不是构造函数里）。所以 TDCore 的构造函数在时间轴元件还不存在时
就去读它们 ⇒ **空引用抛异常** ⇒ 元件实例化失败 ⇒ AurLoader 的那个任务永远不"完成"
⇒ 整条预载队列停住 ⇒ 界面可看不可点。

### 结论与两条真正的出路

- **改名（无论 135 还是 123）都不行**：只要元件的类变成 TDCore 的战斗 UI 类，构造函数就会炸。
- 出路 A：**找到版本匹配的老 `TDGame2V2BattleUI.swf`** ——
  它的文档类必须 *implement* `b_147`（这样 `as b_147` 成立）、且**不定义**同名类
  （不遮蔽 TDCore）。本机浏览器缓存、CDN 裸路径都没有这份文件。
- 出路 B：**改 TDCore 的构造函数**（字节码级，把构造期那次 `a_1797()` 挪到元件绑定之后，
  或让它容忍 null），再配合改名方案。属于下一轮独立任务，风险明确（要改 ABC 方法体）。

在此之前，服务端默认发 `cdn`：**保证"准备界面能操作"这一档不退化**
（`REA_BATTLE_MODULE=assets|cdn|stub` 可切换，产物换了不用重启 —— 路由每次请求现读文件）。

## 3. 还没做实机确认的一步（必须实测）

**"Flash 会自动把时间轴元件按实例名绑到同名 public 变量上"这一步没有实机验证过。**
支持它的证据：模块的壳类里**没有**任何绑定代码（方法体只有 `super()`），
但都声明了同名的 `m_st*` 变量 —— 除了播放器自动绑定，没有别的机制能填这些字段。
反证它的可能：绑定代码本来就在 SWF 的帧脚本里（FFDec 不一定导出成 `.as`）。

**一次实机就能定性**（改完模块后重启服务端 + 刷新页面 + 点「开始」）：

1. 若战场正常出现（能看到草地/上方的波数指示条）⇒ 自动绑定成立，修法成功。
2. 若还是卡 99%：
   - 看 `server.log` 有没有 `★★★ CLIENT_UNCAUGHT_ERROR ★★★`
     （`TDErrorCatch.UploadError()` 已被 `server/patch-upload-error.cjs` 改到本地）；
   - 堆栈若指向 `SetDIYInfo` ⇒ 说明模块没生效（检查是否跑过
     `node server/patch-battle-assets.cjs`）；
   - 堆栈若指向 `a_3600/a_3604/…` 里的 `m_st*` ⇒ 自动绑定不成立，
     退路是"桩 + 主动 graft"：在桩里把模块实例的元件按名字搬进自己
     （`this["m_stX"] = 元件`），再把桩里的嵌套视图换成 TDCore 的类。

## 4. 复现/自查命令

```powershell
node server/patch-battle-assets.cjs            # 生成改名后的资产模块
node server/patch-battle-assets.cjs --check    # 只看源/产物大小
node server/verify-battle.mjs                  # F1-F4 就是这条修复的护栏
```

护栏断言（`verify-battle.mjs`）：

- **F1** SymbolClass 链名**原样保留**（否则元件链不到 TDCore 的逻辑类）；
- **F2** 模块 ABC 里**不得**再出现与 TDCore 同名的类；
- **F3** 服务端默认发的就是改名后的资产模块（不是空桩、也不是 CDN 原件）；
- **F4** 改名等长、无自碰撞。
