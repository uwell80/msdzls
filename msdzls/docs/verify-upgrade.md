# 卡片升星成功率 —— 独立验证报告

验证者：`verifier`（只读角色）
验证对象：客户端 `<Upgrade>` 成功率表语义 + 服务端 `local-server.mjs` 实现
数据来源：`msdzls/client-cache/config-data/compose.xml`（437295 字节）、反编译 AS、服务端 mjs
方法：不采信任何转述结论，用脚本对 `compose.xml` 全量数据独立重算，并与两处实现逐行对照。

**总判定：`@lv` 是「强化用卡自己的星级」，不是「目标星级」。** Lead 的核心判定成立，但有三处细节需要修正，另发现 1 处真实的客户端/服务端不一致。

---

## Q1. `GroupXML.Rate.(@lv == subLevel)` 里 `@lv` 代表什么

### 【结论】`@lv` = 强化用卡（材料卡）**自己的当前星级**，不是目标星级。**确认**。

外层 `Level[@lv=N]` = 主卡当前星级 `mainLevel`；内层 `Rate[@lv=M]` = 材料卡星级 `subLevel`。

### 【证据 file:line】

- `msdzls/decompiled/TDComposeUI/scripts/com/aurora/ui/maogoutd/compose/ComposeConfig.as:269-296`
  `getUpgradeRate(mainLevel, subID, subLevel)`：
  - `:275` `LevelXML = this.getUpgradeLevel(mainLevel)` → `:344` 按外层 `Upgrade.Level[@lv == level]` 取，即 `mainLevel` 选外层。
  - `:285` `GroupXML = LevelXML..Group.(@id == groupLevel.@id)` → 用材料卡的组。
  - `:290` `RateXML = GroupXML.Rate.(@lv == subLevel)` → **`subLevel` 是独立变量**，与外层无关。
  - `:295` `return RateXML[0].@value`
- 调用点 `.../compose/UpgradeCardPane.as:477`
  `rate = ComposeConfig.getInstance().getUpgradeRate(mainCardLevel, cardAttr.CardID, cardAttr.TypeValue);`
  - `:468` `mainCardLevel = cardAttr.TypeValue`（主卡星级）
  - `:476` `cardAttr = PackagesManager.getCardAttr(card)` —— **循环内被重新赋值为材料卡的 attr**
  - `:477` 第三参 `cardAttr.TypeValue` = **材料卡的 TypeValue（星级）**

> 关键点：`:468` 与 `:476` 复用同一个 `cardAttr` 变量。`mainCardLevel` 在 `:468` 已被拷贝进 `int`，所以 `:476` 的覆盖不会污染第一参。若看错这一点会误判成"两参同值"。

### 【实证数据】

以 `Level lv="2"` 的 `Group id="0"`（中级卡片）为例，原始数据：

```xml
<Level gold="298" lv="2" validtime="0" insurance="5" rate_factor="3.00">
  <Group id="0" desc="">
  <Rate lv="0" value="0.516"/>   <-- 本题指定行
  <Rate lv="1" value="0.720"/>
  <Rate lv="2" value="0.880"/>
  <Rate lv="3" value="1.000"/>
  ...
  <Rate lv="16" value="1.000"/>
```

**主卡 2 星 + 中级卡片材料 0 星** → `getUpgradeRate(2, 中级卡ID, 0)` → `RateXML[0].@value = 0.516`
→ 客户端显示 `int(0.516*100)` = **`51%`**（`UpgradeCardPane.as:580` 的 `int(rate * 100)` 是截断不是四舍五入）

同 `Level lv=2` 下按组区分（材料 0 星）：

| 材料组 | Group id | `Rate[@lv=0]` | 客户端显示 |
|---|---|---|---|
| 中级卡片 | 0 | 0.516 | **51%** |
| 低级卡片 | 1 | 0.484 | 48% |
| 高级卡片 | 2 | 0.608 | 60% |

（注意：Lead 只采样了 Group 0。**同一个"材料星级"在不同组里的成功率是不同的**，组才是强度分档。）

### 交叉验证（决定性）

对全部 16 个 `Level` × 3 个 `Group`（共 48 张表，每张 17 个 `Rate`）全量扫描，统计"第一个 `value > 0` 的 `Rate[@lv]`"：

```
mainLv  0 -> G0:0  G1:0  G2:0
mainLv  3 -> G0:1  G1:1  G2:1
mainLv  4 -> G0:2  G1:2  G2:2
mainLv  9 -> G0:7  G1:7  G2:7
mainLv 15 -> G0:13 G1:13 G2:13
```

"开始有非零成功率的材料星级"随主卡星级**同步平移**（`mainLv 3 → 1`，`mainLv 4 → 2`，`mainLv N → N-2`，`mainLv 9 → 7`）。
若 `@lv` 是"目标星级"，该阈值必须恒为常数（目标只可能是 `N+1` 这一档），不可能随 `N` 漂移。

另一条独立证据：全表 816 个 `Rate` 值对材料星级**单调不减**，违反次数 = **0**（脚本穷举）。"目标更高则成功率更低"的读法会产生大面积单调性反转。这两条联合排除了"目标星级"解释。

---

## Q2. `<Groups>` 真实结构 与 `Group id` / `Item id` 对应关系

### 【结论】**确认**，但有两个 Lead 未提及的结构细节。

`compose.xml` 中 `<Groups>` 段（char 338474 起）结构为：

```xml
<Groups default="0">
  <Group id="1" desc="低级卡片"> <Item id="0x11131034" desc="咖啡杯"/> ... </Group>   <!-- 63 items, 声明在最前 -->
  <Group id="2" desc="高级卡片"> <Item id="0x11130020" ... /> ... </Group>            <!-- 902 items -->
  <Group id="0" desc="中级卡片"> <Item id="0x11130050" ... /> ... </Group>            <!-- 102 items, 声明在最后 -->
</Groups>
```

### 【证据 file:line】

- `ComposeConfig.as:481-490` `getCardLevel(id)`：
  `xmlList = this.configData..Groups.Group.Item.(@id == toString16(id)); return xmlList[0].parent();`
  → 双向匹配：`Item.id == "0x" + id.toString(16)`，取**第一个匹配节点的父节点**（即其所属 `Group`）。
- `ComposeConfig.as:492-495` `toString16`：`"0x" + value.toString(16)` → **小写十六进制**。
  实测：`<Groups>` 内 1067 个 `Item` 条目中**含大写 A-F 的 = 0 个**，与 `toString(16)` 小写输出完全一致，映射无大小写陷阱。（**确认**）

### 结构细节（重要，影响 Q5）

1. **`Group id` 只有 0/1/2**（<Upgrade> 与 <Groups> 两处均为 {0,1,2}）。**确认**。
2. **`<Group>` 的声明顺序不是 0,1,2，而是 1, 2, 0**（`<Groups>` 内偏移 25 / 2596 / 39116）。**确认**。
3. **`Item id` 有重复**：1067 条目 / **1063 个 distinct id**，4 个 id 出现两次：
   - `0x1112244d`、`0x1112228f`、`0x11121070` → 两次都在 Group 2（组内重复，无歧义）
   - **`0x11190160`（9周年幸运草扇）→ 一次在 Group 2（offset 30438），一次在 Group 0（offset 40509）** ← 跨组冲突

`Groups` 根节点带 `default="0"`，暗示 Group 0 是默认/兜底档，但 `getCardLevel` 的实现**完全不读 `default` 属性**，只做 `xmlList[0]`。**确认**。

---

## Q3. 失败时主卡星级是否变化

### 【结论】失败时主卡星级**可能变化**，但**不由客户端决定** —— 服务端在 `m_cLevel` 里直接下发新星级，客户端无条件接受。**确认**。

### 【证据 file:line】

- `ComposeData.as:299-316` `updateDataByUpgradeCard(response)`：
  - `:301` `mainCardAttr = this.getCardAttr(this._defCardData, response.m_stNewCardInfo.m_iID, response.m_stNewCardInfo.m_iSequence)`
  - `:306` **`mainCardAttr.TypeValue = response.m_cLevel;`** ← 无任何条件判断，直接赋值
  - `:307-310` 若 `(response.m_iPosition & 0x0F00) == 256` 则 `IsBind = 1`
  - `:311-314` `if(response.m_nResult == 0 || response.m_nDisableConsortiaExtra != 1) this.delDefCardAttr(this._defCardData, response.m_arrSub);` ← 删不删强化用卡
  - `:315` `this.delPropsCardAttr(this._propsCardData, response.m_arrAssMaterial);` ← 辅材总是删

  客户端**没有任何** `level = mainLevel + 1` 或 `- 1` 的推导逻辑；星级完全来自 `m_cLevel`。

- `TDComposeUI.as:1393-1484` `a_2582(response)`：
  - `:1403` `if(response.m_nResult == 0 || response.m_nResult == 1065)`
  - `:1411-1415` `case PANE_TYPE_UPGRADE_CARD:` → `:1412` `ComposeData.getInstance().updateDataByUpgradeCard(response);`，`:1413` `tip = getString(65596)`（"强化成功"类文案），`:1414` `updateView = true` → 走 `:1436-1446` 刷新主卡视图
  - `:1458` `if(response.m_nResult != 0 && response.m_nDisableConsortiaExtra == 1)` → **失败但未禁用**时，把 `subCards[1..len)` 放回面板（材料还在）
  - `:1473-1476` `if(response.m_nResult == 1065) tip = response.m_szReasonMessage;`（用服务端文案覆盖）
  - `:1478-1481` `else { tip = response.m_szReasonMessage; }`（`m_nResult` 非 0/1065 时只弹文案，< 不对卡片数据做任何更新）

### 【推断】失败语义

- 失败是**一种正常的 `m_nResult == 0` 业务结果**（不是错误码）。服务端在失败时下发 `m_nResult = 1`（见下节）—— 等等，这里需要精确区分，见 Q4。客户端**存在** `m_nResult == 0` 之外的失败分支，但星级变化仍统一由 `m_cLevel` 承载。
- "失败是否掉星"这件事**客户端无法据代码判定**，必须看服务端 `m_cLevel` 下发了什么。客户端唯一能确定的：`m_cLevel` 是多少，主卡就是几星。**这是本报告与常见误读最大的分歧点**——不能从 `a_2582` 推出"失败掉一级"。

---

## Q4. `m_nResult` 取值语义表

### 【结论】在 TDComposeUI 与 ComposeData 中，`m_nResult` 只有 **3 个** 被比较的取值：`0`、`1065`、以及"其他"（含 1）。**确认**。

穷举 `TDComposeUI` 与 `ComposeData.as` 中全部 `m_nResult`（非 `m_nResultID`）比较点（正则 `m_nResult[^I]`，命中 10 处）：

| 取值 | 语义 | 证据 file:line |
|---|---|---|
| **`0`** | 业务成功（含升星成功；也覆盖"失败但服务端仍按成功流程下发"的情形） | `TDComposeUI.as:1323`、`TDComposeUI.as:1403`、`TDComposeUI.as:1505`、`TDComposeUI.as:1642`、`UpgradeGemPane.as:403`、`UpgradeWeaponPane.as:252`、`ComposeData.as:311` |
| **`1065`** | **"成功但带警告/降级提示"**：走完整成功流程，但额外用服务端 `m_szReasonMessage` 覆盖提示文案 | `TDComposeUI.as:1403`（与 0 同列进入成功分支）、`TDComposeUI.as:1473-1476`、`UpgradeGemPane.as:403` |
| **其他（含 `1`）** | 失败：`a_2582` 走 `:1478-1481` else 分支，**只弹 `m_szReasonMessage`，不更新任何卡片数据、不刷新视图** | `TDComposeUI.as:1403`（不满足即落入 else）、`TDComposeUI.as:1478-1481` |

**关于 1065 的定性（【推断】，证据较强）：**
1065 在**两个互不相关**的面板里都写作 `m_nResult == 0 || m_nResult == 1065`（卡片强化 `TDComposeUI.as:1403`、宝石强化 `UpgradeGemPane.as:403`），且 `TDComposeUI.as:1473` 单独为它挂 `m_szReasonMessage` 作为 tip。全仓库搜索字面量 `1065` 仅命中这 2 个文件（其余为 `BattleFieldView.as` 的无关属性名 `a_1065`）。
→ 1065 = "**操作已生效，但结果与预期不同，需要给玩家一句解释**"。最典型场景即 **升星失败降级**（数据确实变了、要刷新界面，但必须告诉玩家"强化失败"）。它与 `1` 的关键区别是：**1065 会执行 `updateDataByUpgradeCard` 并把 `m_cLevel` 写进主卡；`1` 什么都不做。**
【推断依据缺口】未找到服务端常量定义或 `GameStringManager` 文案 1065 的直接映射，故 1065 的**字面业务含义**属推断；但"它与 0 同走成功分支"这一**行为语义是确认的**（直接读代码可得）。

**`m_nResult` ≠ `m_nResultID`**：`m_nResultID` 是协议层通用应答码（`a_2751.as:66`、`a_2663.as:50` 等，`int16`）；`m_nResult` 是合成/强化业务的专用结果码。二者在 `TDComposeUI.as` 内混用但不同源，不可互推。

---

## Q5. 服务端 `upgradeRate` 是否与客户端一致

### 【结论】**矩阵查表部分一致；卡片→分组解析部分不一致，存在 1 张卡的实质性偏差。** `@lv` 语义服务端**没有理解反**。

### 5.1 一致的部分（【确认】）

`msdzls/server/local-server.mjs:950-989`：

- `:950-960` 解析 `Level[@lv]` → `Group[@id]` → `Rate[@lv] = value`，`out.levels: Map<mainLevel, Map<groupID, Map<rateLv, value>>>`
- `:961-969` 解析 `<Groups>` → `out.cardGroup: Map<cardID, groupID>`
- `:980-989` `upgradeRate(mainLevel, subCardID, subLevel)`：
  `groups = levels.get(mainLevel)` → `groupID = cardGroup.get(subCardID)` → `rates = groups.get(groupID)` → `return rates.get(subLevel) ?? 0`

三个参数的用法与客户端 `getUpgradeRate(mainLevel, subID, subLevel)` **逐参对应**，`@lv` 都用作 `subLevel`（材料星级）。
**`@lv` 语义理解反了会导致的现象**（本题要求回答）：若把 `@lv` 当作目标星级（恒传 `mainLevel+1`），则查表恒命中同一列 → 在 `mainLevel ≤ 2` 时恒为 `1.000`（成功率恒 100%，偏高），在 `mainLevel ≥ 3` 时恒为 `M=N+1` 列的值（`0.72/0.8/0.88`，与真实材料星级无关，导致低星材料成功率**偏高**、高星材料**偏低**）。**不会**出现"恒为 0"，因为 `Rate` 表 17 个 `lv` 槽位齐全（0..16），任何 `subLevel ∈ [0,16]` 都有值；只有 `subLevel > 16` 才返回 `?? 0`。
**当前服务端并未犯此错**（`:1034` 传 `card?.grade ?? 0`，`:988` 用 `subLevel` 查 `lv`）。**确认无误**。

### 5.2 不一致点 1：卡片→分组的重复 id 解析方向相反（**真实 bug**）

| 实现 | 代码 | 语义 |
|---|---|---|
| 客户端 | `ComposeConfig.as:484-487` `xmlList[0].parent()` | **第一个**匹配节点（文档序）→ Group **2** |
| 服务端 | `local-server.mjs:961-969` `out.cardGroup.set(...)` | **最后一次**写入覆盖 → Group **0** |

由于 `<Group>` 声明顺序是 **1, 2, 0**，对跨组重复的 `0x11190160`（9周年幸运草扇）：
- 客户端认为它在 **Group 2（高级卡片）**
- 服务端认为它在 **Group 0（中级卡片）**

实测偏差（材料星级 = 主卡星级）：

| 主卡星级 | 客户端(Group 2) | 服务端(Group 0) |
|---|---|---|
| 2 | 0.968 | 0.88 |
| 3 | 0.686 | 0.62 |
| 5 | 0.396 | 0.36 |
| 9 | 0.135 | 0.123 |
| 15 | 0.089 | 0.079 |

→ **服务端用这张卡当材料时成功率系统性偏低**（约低 10% 相对值，绝对差 1–9 个百分点）。
影响面：1063 张可强化卡中 **恰好 1 张**（脚本全量 diff 确认）。属真实但低频缺陷。
（另 3 个重复 id `0x1112244d`/`0x1112228f`/`0x11121070` 组内重复，两边结果相同，无影响。）

### 5.3 不一致点 2：失败时的 `m_nResult` 取值（**可能导致失败无法降星**）

服务端 `local-server.mjs:1116-1131` 失败分支下发 **`int16(1)`**。
客户端 `TDComposeUI.as:1403` 只认 `0` 或 `1065` 进入成功分支。

后果（【推断】，基于 5.2 同源的代码阅读）：
- `m_nResult = 1` → 走 `:1478-1481` else 分支 → **只弹 `m_szReasonMessage`（"强化失败"），不调用 `updateDataByUpgradeCard`** → `mainCardAttr.TypeValue` **不会被写入 `m_cLevel`**。
- 即：服务端 `:1079-1082` 明明已经把 `level` 降为 `mainLevel - 1` 并写进存档，**客户端界面上的主卡星级不会更新**（要等下一次全量刷新/重登才对齐）。
- 服务端 `:1128` 特意下发 `shielded ? 1 : 0` 并注释"客户端：失败时只有这一栏 != 1 才会真的删掉强化用卡"—— 该注释对应的客户端逻辑在 `ComposeData.as:311`，**只有 `updateDataByUpgradeCard` 被执行时才会生效**。因此 `m_nResult = 1` 时不仅不降星显示，**强化用卡也不会被删除**（服务端 `:1070-1074` 已在存档里删了，客户端仍显示存在，直到下次刷新）。
- 若改为与客户端契约一致的 **`1065`**，则 `:1403` 进入成功分支 → `:1472` 执行 `updateDataByUpgradeCard` → `:1460-1470` 按 `m_nDisableConsortiaExtra` 把材料放回 → `:1473-1476` 用 `m_szReasonMessage`（"强化失败"）作提示。这才是"失败：星级变了、材料按护佑符决定去留、并告知玩家"的正确路径。

> 这一条同时修正 Q4：**服务端目前把"失败"编码成了 `1`（客户端当作硬错误，什么都不更新），而不是客户端为失败准备好的 `1065`。** 这是客户端/服务端契约错配，比 5.2 的影响更大。

**为什么现有测试没发现（重要）**：`msdzls/server/verify-cards.mjs:549-560` 断言"强制失败 → result=1 且掉到 0 级"，并检查"序号真的换了"。但它校验的是
(a) **服务端应答字节**（`result !== 1 || newLevel !== 0`，`:551`）和
(b) **服务端存档文件**（`readFileSync(tmpSave)`，`:553`，`downgraded.grade !== 0`，`:559`），
**完全没有经过客户端 `a_2582` 的分发逻辑**。服务端 `:1084-1098` 的"换新序号 + 旧序号发 `count=0`"设计，其注释写着"否则客户端看不到星级变化"——但该机制只在客户端执行 `updateDataByUpgradeCard` 时才会被消费，而 `m_nResult == 1` 时该函数**根本不会被调用**。因此测试全绿，客户端行为仍与预期不符。**这是"服务端自测通过 ≠ 端到端正确"的典型案例。**

### 5.4 一致的部分（补充确认）

- `m_cLevel` 承载新星级：服务端 `:1135` 成功 `Buffer.from([level & 0xff])`，失败 `:1119` 同字段下发 `level`。与 `ComposeData.as:306` 的读取一致。
- 保险金 `upgradeInsurance(mainLevel)`（`:993-1010`）读 `Level@insurance`。实测 16 档 insurance = `0,2,5,10,25,50,200,400,1200,5000,15000,25000,35000,45000,55000,75000`。**该字段在 `getUpgradeRate` 中确实未被使用**（见下节）。
- 上限钳制 `if(rate > 1) rate = 1`（服务端 `:1048`）对应客户端 `UpgradeCardPane.as:508-511`。一致。
- 多材料取最大 + 其余各 `/3`（服务端 `:1039-1042`）对应客户端 `:489-497`（`rates.sort(Array.NUMERIC); rate = rates.pop(); rate += rates[i]/3`）。一致。
- 四叶草倍率（服务端 `:1043-1047`）对应客户端 `:498-507`。一致。

---

## 关于 `rate_factor`（Lead 点名核实）

### 【结论】`rate_factor` **不参与成功率计算**，**确认**。`insurance` 同样**不参与**，**确认**。

- `UpgradeCardPane.as:450-584` 全文（含 `getUpgradeRate` 与调用链）**未出现** `rate_factor`；`ComposeConfig.as` 内 `getUpgradeRate`（:269-296）亦未读取任何 `Level` 属性，只用 `Level.@lv` 做选择。
- 穷举验证：`rate_factor` 取值序列 `1.00,3.00,3.00,2.80,2.60,2.40,2.20,2.00,1.80,1.60,1.40,1.30,1.20,1.15,1.10,1.10`。若它参与，`diag(N)/diag(N-1)` 或 `diag(N)` 应与 `1/rate_factor` 或 `rate_factor` 相关。实测 `diag(N)/diag(N-1)` = `1.25,1.222,1.24,1.23,1.20,1.208,1.244,1.667,3.0,3.0,3.0,3.03,3.22,3.37,3.48`，与 `1/rate_factor` = `0.333,0.333,0.357,0.385,0.417,0.455,0.5,0.556,0.625,0.714,0.769,0.833,0.870,0.909,0.909` **差 0.74–2.57，无任何相关性**。`diag` 与 `rate_factor` 本身也非单调对应。
- 唯一可见的规律：`diag(N)/diag(N-1)` 在高档位（N≥9）稳定为 **3.0**，低档位为 **1.2–1.25**。这更像"每升一档难度提升 3 倍"的设计意图，且只在 N≥9 被严格执行。
- `rate_factor` 的**真实用途未在本次读到的代码中定位**（【未确认】）。合理推断：它是服务端/其他模块（如点券消耗倍率、`gold` 折算）使用的字段，但本报告中**没有证据**支持任何具体用途，故不下结论。`insurance` 已确认用于失败保险金扣费（`:1054`），与成功率无关。

---

## 关于 `M = N+1 → 0.800`（Lead 点名）

### 【结论】Lead 的说法**不成立**，需修正。**`M=N+1` 的值随 Group 变化，且在 N ≤ 2 时是 `1.000`。**

实测（全 48 张表，`M = N+1` 列的取值分布）：

| `M=N+1` 取值 | 出现次数 | 出现在 |
|---|---|---|
| `1.000` | 9 | `Level 0,1,2` × 3 组 |
| `0.800` | 13 | Group 0，`Level ≥ 3` |
| `0.720` | 13 | Group 1，`Level ≥ 3` |
| `0.880` | 13 | Group 2，`Level ≥ 3` |

即 `0.800 / 0.720 / 0.880` 是 **Group 0/1/2（中级/低级/高级卡片）各自的"高一星材料"基准值**，不是全局常数，也**与保险金无关**（保险金 `insurance` 在 `:1054` 只用于扣点券）。`0.800` 只是 Group 0 的那一支；Lead 恰好只看了 Group 0。

同理"对角线上（M==N）"的 `diag(N)` **同样分三组**，不是单一序列。例如 `Level lv=2`：Group 0 = 0.880，Group 1 = 0.800，Group 2 = 0.968。Lead 摘录的 `Level lv=9 : lv9:0.123` 是 Group 0；Group 1 为 0.111，Group 2 为 0.135。

**能成立的部分**：`@lv` = 材料星级（Q1 已独立证明）；"材料星级 ≥ 主卡星级 + 2 → 1.000"在 **N ≥ 3** 时对全部三组成立；"M < N 时衰减到 0"成立（阈值 `N-2`，见 Q1 交叉验证表）。

---

## 结论汇总

### 【确认】（直接读代码或全量数据可得）

1. `Rate/@lv` = 材料卡自身星级；`Level/@lv` = 主卡星级。`ComposeConfig.as:269-296` + `UpgradeCardPane.as:477`。
2. 主卡 2 星 + 中级卡 0 星 → `getUpgradeRate` 返回 `0.516`，客户端显示 **`51%`**（截断）。
3. `<Groups>` 有 3 个组 id {0,1,2}，声明顺序 **1, 2, 0**；共 1067 个 `Item` 条目 / 1063 个 distinct id；4 个 id 重复，其中 `0x11190160` **跨组重复**（Group 2 与 Group 0）。
4. 客户端 `getCardLevel` 取**第一个**匹配（`xmlList[0].parent()`，`ComposeConfig.as:487`）；服务端 `cardGroup.set` 取**最后一个**（`local-server.mjs:966`）。两者对 `0x11190160` 判定相反。
5. 失败时主卡星级变化**完全由服务端 `m_cLevel` 决定**，客户端 `ComposeData.as:306` 无条件写入，无任何 ±1 推导。
6. `m_nResult` 在 TDComposeUI/ComposeData 中只比较 `0`、`1065`、其他三者；`1065` 与 `0` **同走成功分支**并额外用 `m_szReasonMessage` 覆盖提示。
7. `rate_factor` 与 `insurance` **均不参与**成功率计算。`insurance` 用于失败扣费。
8. 多材料取最大 + 其余 `/3`、四叶草倍率、100% 钳制，客户端与服务端算法一致。

### 【推断】

1. `1065` 的业务含义 = "操作已生效但有异常，需向玩家解释"，最典型即**失败降级**。行为语义确认，字面定义未定位。
2. 服务端失败下发 `m_nResult = 1` 会导致**客户端界面不降星、不删材料**（与服务端存档脱节，直到下次刷新）。
3. `rate_factor` 属服务端/其他模块字段，具体用途未定位。

### 【与服务端实现的差异】

| # | 差异 | 客户端 | 服务端 | 影响 |
|---|---|---|---|---|
| 1 | 重复 `Item id` 的组归属 | 第一个匹配 → Group 2 | 最后一个写入 → Group 0 | `0x11190160` 成功率偏低 1–9 个百分点；1063 张卡中 1 张 |
| 2 | 失败时 `m_nResult` | 期望 `0`/`1065` 才更新卡片数据；`1065` 为"失败但已变更" | 下发 `1` | 界面不降星、不删材料，与存档脱节 || 3 | `m_nResult == 1` 时的 `m_nDisableConsortiaExtra` | `ComposeData.as:311` 用它决定删不删材料，但该分支不执行 | `:1128` 仍下发 `shielded ? 1 : 0` | 该字段在失败路径实际无效 |
| 4 | `@lv` 语义 | 材料星级 | 材料星级（`card?.grade ?? 0`） | **一致，无差异** |

**建议修复优先级**：差异 2（失败契约错配，影响所有失败操作）> 差异 1（单卡数值偏差）。
差异 2 的最小改动是把 `local-server.mjs:1118` 的 `int16(1)` 改为 `int16(1065)`，并确认 `:1128` 的 `m_nDisableConsortiaExtra` 取值在 `1065` 路径下语义正确（`1` = 保住材料，`0` = 删材料）。

---

## 附：验证方法与可复现性

- 环境：`node`（脚本已用完删除，方法记录于此）+ PowerShell 正则提取。
- 核心校验脚本逻辑：读取 `compose.xml` 全文 → 切出 `<Upgrade>...</Upgrade>` 与 `<Groups>...</Groups>` → 正则建 `levels: Map<mainLevel, Map<groupId, Map<rateLv, value>>>` → 分别用"首次匹配优先"与"末次覆盖优先"构建 `cardGroup` → 全量 diff → 复刻 `getUpgradeRate` 三参数语义调用。
- 关键数字均可由报告中给出的原始 XML 片段手工复算。
- 本报告未修改除本文件外的任何文件。
