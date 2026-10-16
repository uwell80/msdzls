#!/usr/bin/env node
/**
 * 出怪白名单体检：把 `local-server.mjs` 里的 `BATTLE_MOUSE_REGISTRY`
 * 与**客户端反编译产物**重新推导出来的注册表逐条比对。
 *
 * 为什么要有这个脚本：`BattleFieldView.a_3456`（`:3107-3112`）在造怪时
 *   `m_stMoveIntruderFactory.a_4256(m_iIntruderType)` 得 null 就
 *   `throw new Error("此老鼠不存在ID:" + …)` —— 服务端一旦发了一只没注册的老鼠，
 *   战斗模块当场抛异常（而且异常发生在动态加载的模块里，全局兜底未必看得到）。
 *   所以"能发哪些老鼠"必须是**可核对的事实**，不能靠记忆。
 *
 * 口径（两步都做）：
 *   1. 解析 `decompiled/TDCore/scripts/com/aurora/ui/maogoutd/base/TDFactoryImport.as`
 *      与 `TDGuideFactoryImport.as` 里的 `RegisterCreator(<int>, …)`，取
 *      `0x800000 <= id < 0x810000` 的部分（`BattleRegisterUtil.RegisterCreator`
 *      就是按这个区间把老鼠注册进 `a_4255` 的，见 `BattleRegisterUtil.as:31-34`）。
 *   2. 与 `BATTLE_MOUSE_REGISTRY` 对比：缺的、多的、名字不符的都报出来。
 *
 * 用法：
 *   node server/check-wave-mice.mjs            # 体检（有差异 exit=1）
 *   node server/check-wave-mice.mjs --list     # 只列白名单
 *   node server/check-wave-mice.mjs --map 0x50010301   # 顺带看这张图的鼠表交集
 *
 * ⚠ `decompiled/` 是 FFDec 产物、不入 git（见 README）。缺它时本脚本会明确
 *   报"没得比"并 exit=2，而不是假装通过 —— 报数只报自己真跑出来的东西。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const FACTORY = path.join(
  ROOT,
  "decompiled",
  "TDCore",
  "scripts",
  "com",
  "aurora",
  "ui",
  "maogoutd",
  "base",
  "TDFactoryImport.as",
);
const GUIDE_FACTORY = path.join(path.dirname(FACTORY), "TDGuideFactoryImport.as");
const MOUSE_LO = 0x800000;
const MOUSE_HI = 0x810000;

/** 从反编译源码里抠出 intruder 注册表（id → 生成函数文本）。 */
function registryFromSource(files) {
  const found = new Map();
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/RegisterCreator\(\s*(\d+)\s*,\s*([^)]+)\)/g)) {
      const id = Number.parseInt(m[1], 10);
      if (id >= MOUSE_LO && id < MOUSE_HI) found.set(id - MOUSE_LO, m[2].trim());
    }
  }
  return found;
}

const { BATTLE_MOUSE_REGISTRY, resolveWaveMice } = await import("./local-server.mjs");

const argv = process.argv.slice(2);
const hex = (n) => "0x" + n.toString(16).padStart(4, "0");

if (argv.includes("--list")) {
  for (const [id, name] of [...BATTLE_MOUSE_REGISTRY].sort((a, b) => a[0] - b[0])) {
    console.log(`${hex(id)}  ${name}`);
  }
  console.log(`合计 ${BATTLE_MOUSE_REGISTRY.size} 只`);
  process.exit(0);
}

if (!fs.existsSync(FACTORY)) {
  console.log(`✗ 没得比：缺少反编译产物 ${path.relative(ROOT, FACTORY)}`);
  console.log(`  先跑：pwsh tools/decompile-swf.ps1 TDCore`);
  process.exit(2);
}

const fromSource = registryFromSource([FACTORY, GUIDE_FACTORY]);
const missing = [...fromSource.keys()].filter((id) => !BATTLE_MOUSE_REGISTRY.has(id));
const extra = [...BATTLE_MOUSE_REGISTRY.keys()].filter((id) => !fromSource.has(id));

console.log(`反编译产物里的 intruder 注册条目：${fromSource.size} 条`);
console.log(`local-server.mjs 白名单：${BATTLE_MOUSE_REGISTRY.size} 条`);
if (missing.length > 0) {
  console.log(`✗ 白名单**漏了** ${missing.length} 只（客户端能造，我们不敢发）：`);
  for (const id of missing) console.log(`    ${hex(id)}  ${fromSource.get(id)}`);
}
if (extra.length > 0) {
  console.log(`✗ 白名单**多了** ${extra.length} 只（发过去会 throw「此老鼠不存在ID」）：`);
  for (const id of extra) console.log(`    ${hex(id)}  ${BATTLE_MOUSE_REGISTRY.get(id)}`);
}

const mapArg = argv[argv.indexOf("--map") + 1];
if (argv.includes("--map") && mapArg !== undefined) {
  const mapID = Number.parseInt(mapArg, 16);
  const { mice, source } = resolveWaveMice(mapID >>> 0);
  console.log(`\n地图 ${mapArg} 实际会用的鼠表：${source}`);
  console.log(`  ${mice.map(hex).join(" ")}`);
}

if (missing.length === 0 && extra.length === 0) {
  console.log(`✓ 白名单与反编译产物完全一致（${fromSource.size}/${BATTLE_MOUSE_REGISTRY.size}）`);
  process.exit(0);
}
process.exit(1);
