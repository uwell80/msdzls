/**
 * 把 CDN 那份 **纯资产** 战斗模块 `TDGame2V2BattleUI.swf` 里"与 TDCore 重名的壳类"改名。
 *
 * 背景（本轮取证，详见 docs/battle-module-rootcause.md）：
 *   - TDCore 里**内联**了整套战斗 UI 的**逻辑**（`com.aurora.ui.maogoutd.TDGame2V2BattleUI`
 *     以及它引用的 `...game.MoveIntruderWaveNumberIndicatorView` 等），**但不含任何美术**：
 *     `ffdec -export symbolClass TDCore.swf` 只有两条 —— `TDCore` 与 `ButtonClickSound`。
 *   - CDN 的 `TDGame2V2BattleUI.swf` 反过来：**零逻辑、全是美术**。
 *     它的 SymbolClass 表 135 条，把每个元件链到 `com.aurora.ui.maogoutd.*` 这些**同名**类上；
 *     这些类在模块自己的 ABC 里也被定义成了**空壳**（`extends MovieClip`，方法体只有 `super()`）。
 *   - 客户端 `a_2179.as:1446` 用 `new ApplicationDomain(ApplicationDomain.currentDomain)`（**子域**）
 *     加载它 ⇒ 子域里的空壳**遮蔽**父域（TDCore）的逻辑类 ⇒
 *       · `a_1668.content as b_147` 得 **null**（模块的文档类不是 b_147 的实现）
 *       · `a_2179.as:1664 TDGameCoreUI.a_757.SetDIYInfo(...)` 空引用抛异常
 *       · `LoadEndAndStartGame()` 中途夭折 ⇒ **载入进度永远停在 99%**
 *
 * 修法：让模块**不再定义**那些同名类 —— 于是 SymbolClass 里的名字在域链上只能落到
 * **TDCore 的逻辑类**上（这正是"资产 SWF + 主 SWF 里的代码"这种分包的正常形态）。
 * 做的是 **ABC 常量池 string 逐条等长替换**（只改常量池里"恰好等于某个类名"的表项，
 * 长度不变 ⇒ 索引、长度前缀、整个 ABC 结构都不动）：
 *   · SymbolClass **标签**里的点分全名（`com.aurora.ui.maogoutd.game.XxxView`）**保持不动**；
 *   · ABC 常量池里的**简单名**（`XxxView` / `TDGame2V2BattleUI`）改成同长度的新名字。
 *
 * 用法：
 *   node server/patch-battle-assets.cjs            # 生成并校验
 *   node server/patch-battle-assets.cjs --check    # 只看结果状态（不写文件）
 *
 * 产物：client-cache/mirror/battle_assets/TDGame2V2BattleUI.swf
 * 服务端 `/TDGame2V2BattleUI.swf` 默认就发这个文件（`REA_BATTLE_MODULE=assets`），
 * 老桩走 `REA_BATTLE_MODULE=stub`，CDN 原件走 `REA_BATTLE_MODULE=cdn`。
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "client-cache", "mirror", "TDGame2V2BattleUI.swf");
const OUT_DIR = path.join(ROOT, "client-cache", "mirror", "battle_assets");
const OUT = path.join(OUT_DIR, "TDGame2V2BattleUI.swf");

const HEADER = 8; // Signature(3) + Version(1) + FileLength(4)

/**
 * ★★ 只改"TDCore 里**确实有**同名类"的那些符号类。
 *
 * 2026-10-16 实机教训（第一版把 135 个全改了，结果客户端卡在预载里、界面点不动）：
 * 135 个 SymbolClass 里有 **12 个类 TDCore 根本没有** —— 它们是**纯美术**元件，
 * 模块自己的壳类就是它们的最终实现：
 *
 *   com.aurora.ui.maogoutd.game.BigHonorView
 *   com.aurora.ui.maogoutd.game.HonorNumberMovie
 *   com.aurora.ui.maogoutd.game.GameResultGradeNumberMovie
 *   com.aurora.ui.maogoutd.game.GameResultOppTeamBreadView
 *   com.aurora.ui.maogoutd.game.GameResultMyTeamBreadView
 *   com.aurora.ui.maogoutd.game.PlayerGameResultView
 *   com.aurora.ui.maogoutd.game.GameResultMaskBackCardMovie
 *   com.aurora.ui.maogoutd.game.GameResultGradeNumberView
 *   com.aurora.ui.maogoutd.game.GameResultAlertView
 *   _9级勋章升阶影片外发光           （中文名元件，本来就只有壳）
 *   _9级勋章升阶影片粒子             （同上）
 *   com.aurora.ui.maogoutd.resource.bitmap.RatEarthHoleBitmapdata（鼠洞位图）
 *
 * 把这 12 个也改名 ⇒ 链名在域链上**哪都找不到** ⇒ 模块装载/实例化报错 ⇒
 * 客户端卡在资源预载、准备界面点不动。所以它们必须**保持原名**。
 *
 * 判定口径：`decompiled/TDCore` 有就用它现算（`assertRenamableAgainstTdcore`），
 * 没有就退到这份硬编码清单 —— 两种口径在本轮都得到同一组 123 个可改名的类。
 */
const KEEP_ORIGINAL = new Set([
  "com.aurora.ui.maogoutd.game.BigHonorView",
  "com.aurora.ui.maogoutd.game.HonorNumberMovie",
  "com.aurora.ui.maogoutd.game.GameResultGradeNumberMovie",
  "com.aurora.ui.maogoutd.game.GameResultOppTeamBreadView",
  "com.aurora.ui.maogoutd.game.GameResultMyTeamBreadView",
  "com.aurora.ui.maogoutd.game.PlayerGameResultView",
  "com.aurora.ui.maogoutd.game.GameResultMaskBackCardMovie",
  "com.aurora.ui.maogoutd.game.GameResultGradeNumberView",
  "com.aurora.ui.maogoutd.game.GameResultAlertView",
  "_9级勋章升阶影片外发光",
  "_9级勋章升阶影片粒子",
  "com.aurora.ui.maogoutd.resource.bitmap.RatEarthHoleBitmapdata",
]);

/** 若本地有 `decompiled/TDCore`，就顺手核对一遍"要改名的类在 TDCore 里都存在"。 */
function tdcoreClassNames() {
  const root = path.join(ROOT, "decompiled", "TDCore", "scripts");
  if (!fs.existsSync(root)) return null;
  const out = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".as")) {
        out.add(p.slice(root.length + 1, -3).split(path.sep).join("."));
      }
    }
  };
  walk(root);
  return out;
}

/* ------------------------------------------------------------------ *
 * SWF 容器：读标签、定位 DoABC
 * ------------------------------------------------------------------ */

function readSwf(file) {
  const raw = fs.readFileSync(file);
  const sig = raw.subarray(0, 3).toString("latin1");
  if (sig !== "CWS" && sig !== "FWS") throw new Error(`${file} 不是 SWF`);
  const declared = raw.readUInt32LE(4);
  const body =
    sig === "CWS" ? zlib.inflateSync(raw.subarray(HEADER)) : raw.subarray(HEADER);
  return { raw, sig, declared, body };
}

/** 依次读出标签链（返回 null 表示这条链不成立）。 */
function walkTags(body, p) {
  const tags = [];
  while (p + 2 <= body.length) {
    const codeAndLen = body.readUInt16LE(p);
    const code = codeAndLen >> 6;
    let len = codeAndLen & 0x3f;
    let head = 2;
    if (len === 0x3f) {
      len = body.readInt32LE(p + 2);
      head = 6;
    }
    if (len < 0 || p + head + len > body.length) return null;
    tags.push({ code, start: p + head, end: p + head + len });
    p += head + len;
    if (code === 0) return { tags, end: p };
  }
  return null;
}

/**
 * 标签是 10 位 code + 6 位 length；长标签(63)再跟一个 SI32。
 *
 * 起始偏移 = ceil((5 + 4*nbits) / 8)   // RECT：5 位 nbits + 4 个 nbits 字段
 *            + 2 (frameRate: 1 字节小数 + 1 字节整数)
 *            + 2 (frameCount)
 * ⚠ 早期版本把 RECT 写成 `1 + ceil(...)`，多算 1 字节 ⇒ 整条标签链错位、
 *   读不到 SymbolClass/DoABC。这里改成**先算再验**：候选偏移若能让标签链
 *   正好在文件末尾以 End(0) 收尾，才算对（实测本文件命中 13）。
 */
function parseTags(body) {
  const nbits = body[0] >> 3;
  const guess = Math.ceil((5 + nbits * 4) / 8) + 4;
  const candidates = [guess];
  for (let d = -2; d <= 2; d += 1) if (d !== 0) candidates.push(guess + d);
  for (const p of candidates) {
    const r = walkTags(body, p);
    if (r !== null && r.end === body.length) return r.tags;
  }
  throw new Error(`标签链解析失败：候选起始偏移 ${candidates.join(",")} 都走不到文件末尾`);
}

/* ------------------------------------------------------------------ *
 * ABC：只为了定位常量池 string 表项
 * ------------------------------------------------------------------ */

function readU30(buf, p) {
  let v = 0;
  let shift = 0;
  for (let i = 0; i < 5; i += 1) {
    const b = buf[p + i];
    v |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) return { value: v >>> 0, next: p + i + 1 };
  }
  throw new Error("bad u30");
}

/**
 * 返回 ABC 里 string 常量池每一项的 [start,end)（内容字节，不含长度前缀）。
 *
 * cpool 是**交错**的：`int_count, int[...], uint_count, uint[...], double_count,
 * double[...], string_count, string[...]`。⚠ 早期版本把 4 个 count 连着读 ⇒ 读到的是
 * 池里的**值**而不是 count，通篇错位（表现为 `bad u30` 或"一笔都没命中"）。
 */
function abcStringPool(abc) {
  let p = 4; // u16 minor + u16 major
  const countAt = () => {
    const r = readU30(abc, p);
    p = r.next;
    return r.value;
  };
  const intCount = countAt();
  for (let i = 1; i < intCount; i += 1) p = readU30(abc, p).next; // s32 也是 u30 变长
  const uintCount = countAt();
  for (let i = 1; i < uintCount; i += 1) p = readU30(abc, p).next;
  const doubleCount = countAt();
  p += (doubleCount - 1) * 8;
  const stringCount = countAt();
  const entries = [];
  for (let i = 1; i < stringCount; i += 1) {
    const len = readU30(abc, p);
    p = len.next;
    entries.push([p, p + len.value]);
    p += len.value;
  }
  return entries;
}

/** DoABC2（tag 82）：u32 flags + NUL 结尾的 name + ABCData。 */
function abcDataOf(body, tag) {
  const buf = body.subarray(tag.start, tag.end);
  const nul = buf.indexOf(0, 4);
  if (nul < 0) return null;
  return { abc: buf.subarray(nul + 1), offsetInBody: tag.start + nul + 1 };
}

/* ------------------------------------------------------------------ *
 * SymbolClass（tag 76）：拿到"链到哪个类"的点分全名
 * ------------------------------------------------------------------ */

function symbolClassNames(body, tags) {
  const names = [];
  for (const t of tags) {
    if (t.code !== 76) continue;
    const buf = body.subarray(t.start, t.end);
    const count = buf.readUInt16LE(0);
    let p = 2;
    for (let i = 0; i < count; i += 1) {
      p += 2; // CharacterId
      const end = buf.indexOf(0, p);
      if (end < 0) break;
      names.push(buf.subarray(p, end).toString("utf8"));
      p = end + 1;
    }
  }
  return names;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function newName(old, taken) {
  for (const c of ALPHABET) {
    const cand = old.slice(0, -1) + c;
    if (cand !== old && !taken.has(cand)) {
      taken.add(cand);
      return cand;
    }
  }
  throw new Error(`无法为 ${old} 生成同长度新名`);
}

function build() {
  const { sig, declared, body } = readSwf(SRC);
  const tags = parseTags(body);
  const dots = symbolClassNames(body, tags);
  if (dots.length === 0) throw new Error("没读到 SymbolClass（tag 76）");

  /**
   * 决定"改哪些"：只改 TDCore 里有同名类的（= 逻辑在 TDCore、模块只出元件）。
   * 其余保持原名，让它们继续用自己的壳（纯美术元件的唯一实现）。
   */
  const known = tdcoreClassNames();
  const renaming = dots.filter((d) => {
    if (KEEP_ORIGINAL.has(d)) return false;
    if (known === null) return true; // 没有反编译产物可查时按硬编码清单走
    if (!known.has(d)) {
      console.log(`  ⚠ TDCore 里没有 ${d} ⇒ 保持原名（纯美术元件，壳即实现）`);
      return false;
    }
    return true;
  });
  const skipped = dots.filter((d) => !renaming.includes(d));

  // 点分全名 → 简单名（ABC 常量池里存的是简单名）
  const simples = [...new Set(renaming.map((d) => d.split(".").pop()))];
  const taken = new Set(simples);
  const rename = new Map();
  for (const s of simples) rename.set(s, newName(s, taken));

  // 只改 DoABC（tag 82）里的常量池 string；SymbolClass 标签在别的标签里，天然不受影响。
  const abcTags = tags.filter((t) => t.code === 82);
  const patched = Buffer.from(body);
  let hits = 0;
  const hitDetail = [];
  for (const t of abcTags) {
    const info = abcDataOf(patched, t);
    if (info === null) continue;
    const { abc, offsetInBody } = info;
    for (const [s, e] of abcStringPool(abc)) {
      const name = abc.subarray(s, e).toString("utf8");
      const rep = rename.get(name);
      if (rep === undefined) continue;
      Buffer.from(rep, "utf8").copy(patched, offsetInBody + s);
      hits += 1;
      hitDetail.push(`${name} -> ${rep}`);
    }
  }
  if (hits === 0) throw new Error("ABC 常量池里没找到任何待改名的类名（结构假设有误）");

  const packed = zlib.deflateSync(patched, { level: 9 });
  const out = Buffer.alloc(HEADER + packed.length);
  Buffer.from(sig, "latin1").copy(out, 0);
  out[3] = 6; // version
  out.writeUInt32LE(HEADER + patched.length, 4); // 未压缩总长
  packed.copy(out, HEADER);
  return { out, hits, hitDetail, dots, rename, declared, patched, skipped };
}

function main() {
  const check = process.argv.includes("--check");
  if (check) {
    console.log(`源文件：${SRC} (${fs.statSync(SRC).size} B)`);
    console.log(`产物：${OUT} ${fs.existsSync(OUT) ? fs.statSync(OUT).size + " B" : "（不存在）"}`);
    return;
  }
  const { out, hits, hitDetail, dots, rename, skipped } = build();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, out);
  console.log(`SymbolClass 链到的类：${dots.length} 个`);
  console.log(`改名表：${rename.size} 条（等长）；保持原名：${skipped.length} 条`);
  if (skipped.length > 0) {
    console.log(`  · 保持原名的是"TDCore 里没有同名类"的纯美术元件，`);
    console.log(`    改成新名会让链名在域链上找不到类（实机表现：卡在预载、界面点不动）`);
  }
  console.log(`ABC 常量池替换：${hits} 处`);
  for (const d of hitDetail.slice(0, 5)) console.log(`  · ${d}`);
  if (hitDetail.length > 5) console.log(`  · … 其余 ${hitDetail.length - 5} 条同类`);
  console.log(`写出：${OUT} (${out.length} B)`);
  console.log("自检：node server/patch-battle-assets.cjs --check");
}

if (require.main === module) main();

module.exports = {
  build,
  parseTags,
  abcStringPool,
  symbolClassNames,
  tdcoreClassNames,
  SRC,
  OUT,
};
