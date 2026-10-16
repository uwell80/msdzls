/**
 * 诊断：客户端抛过 `Error: map_mouse.xml配置中不存在 地图id前缀为 0x0的地图`
 * （2026-10-16 通过 `/log` 异常上报口抓到）。
 *
 * 这里把本地各份 map_mouse*.xml 的 MapID 前缀分布打出来，看客户端"按前缀取地图列表"
 * 时是否真的缺 0x0 组（曲奇岛 0x0003 / 色拉岛 0x0001 都属于 0x0 前缀组）。
 *
 * 用法：node server/check-mapmouse-prefix.cjs
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILES = [
  "client-cache/config-data/map_mouse.xml",
  "client-cache/mirror/config/map_mouse2.xml",
  "client-cache/mirror/config/map_mouse4.xml",
];

for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.log(`${rel}  <缺失>`);
    continue;
  }
  const xml = fs.readFileSync(file, "utf8");
  const ids = [...xml.matchAll(/MapID="(0x[0-9a-fA-F]+)"/g)].map((m) => m[1].toLowerCase());
  const byPrefix = new Map();
  for (const id of ids) {
    const p = id.slice(0, 3); // "0x0" / "0x1" …
    byPrefix.set(p, (byPrefix.get(p) ?? 0) + 1);
  }
  const dist = [...byPrefix.entries()].sort().map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(`${rel}\n  items=${ids.length}  前缀分布: ${dist}`);
  if (!byPrefix.has("0x0")) console.log("  ⚠ 没有 0x0 前缀组（1..0x0ffff 段的地图）");
}
