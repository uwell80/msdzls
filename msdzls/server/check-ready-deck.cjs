/**
 * 诊断：准备界面「我的防御卡 → 收藏卡组」能不能被自动填满、能不能过「开局门」。
 *
 * 复刻 `local-server.mjs` 的 `cardCatalog()` 卡片集合（card_desc.xml 里 index>0 且 type 以"型"结尾），
 * 然后检查两件事：
 *   1. `map_mouse.xml` 里该地图的 `DefCardsID`（默认卡组）有几张是玩家**真的有**的
 *      —— `CardReadyPanel.setDefaultSelectedCards → dealNoGudingCard → getCardById` 只认"卡包里真实存在的卡"。
 *   2. `TableReadyUI.dealSubmitReadyGame():917` 的「0x0100 位地图」硬门：卡组里必须含某张指定卡，
 *      否则返回 enmGameReady_SelectCardID3（弹"确定"对话框），点确定才会发 cmd1。
 *
 * 用法：node server/check-ready-deck.cjs [地图ID(十进制或0x..)]   默认 0x0701
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CONFIG = path.join(ROOT, "client-cache", "config-data");

/** 与 local-server.mjs 的 cardCatalog() 保持一致的"玩家拥有的卡"集合。 */
function ownedCards() {
  const out = new Set();
  const xml = fs.readFileSync(path.join(CONFIG, "card_desc.xml"), "utf8");
  for (const tag of xml.match(/<item\b[^>]*>/g) ?? []) {
    const idStr = (tag.match(/id="(0x[0-9a-fA-F]+)"/) ?? [])[1];
    if (!idStr) continue;
    const id = Number.parseInt(idStr, 16);
    const type = (tag.match(/type="([^"]*)"/) ?? [])[1] ?? "";
    const index = Number.parseInt((tag.match(/index="(\d+)"/) ?? [])[1] ?? "0", 10);
    if (index > 0 && type.endsWith("型")) out.add(id >>> 0);
  }
  for (const m of fs.readFileSync(path.join(CONFIG, "CardFusion.xml"), "utf8").matchAll(/main_id="([^"]+)"/g)) {
    for (const one of m[1].split("|")) {
      const id = Number.parseInt(one, 16);
      if (Number.isFinite(id) && id !== 0) out.add(id >>> 0);
    }
  }
  return out;
}

/** 从 map_mouse.xml 取该地图条目的 DefCardsID / PopPropsID。 */
function mapEntry(mapId) {
  const xml = fs.readFileSync(path.join(CONFIG, "map_mouse.xml"), "utf8");
  const items = xml.match(/<item\b[^>]*>/g) ?? [];
  for (const tag of items) {
    const raw = (tag.match(/MapID="(0x[0-9a-fA-F]+|[0-9]+)"/) ?? [])[1];
    if (!raw) continue;
    if (Number(raw) !== mapId && Number.parseInt(raw, 16) !== mapId) continue;
    const ids = (tag.match(/DefCardsID="([^"]*)"/) ?? [])[1] ?? "";
    const name = (tag.match(/MapName="([^"]*)"/) ?? [])[1] ?? "";
    return {
      mapIdRaw: raw,
      name,
      defCards: ids.split(",").filter((s) => s.trim() !== "").map((s) => Number.parseInt(s, 16) >>> 0),
    };
  }
  return null;
}

// TableReadyUI.dealSubmitReadyGame():917 的硬门（0x0100 位地图必须带的卡）
const WATER_GATE = [
  288817173, 288817182, 288817183, 288817220, 288817230, 288817231, 288817232,
  288817246, 288817247, 288817264, 288817278, 288817279, 292552848, 292552862, 292552863,
];

const hex = (n) => "0x" + (n >>> 0).toString(16).toUpperCase();

function main() {
  const arg = process.argv[2] ?? "0x0701";
  const mapId = /^0x/i.test(arg) ? Number.parseInt(arg.slice(2), 16) : Number.parseInt(arg, 10);
  const own = ownedCards();
  console.log(`玩家拥有的卡（cardCatalog 口径）：${own.size} 张`);
  const e = mapEntry(mapId);
  if (!e) {
    console.log(`✗ map_mouse.xml 里没有地图 ${hex(mapId)}：准备界面拿不到 dictMapMouse[${mapId}]`);
    console.log("  ⇒ setDefaultSelectedCards 会因 cardSData == null 直接 return，收藏卡组只能靠手动点卡。");
    return;
  }
  console.log(`地图 ${e.mapIdRaw} = ${hex(mapId)} 「${e.name}」  DefCardsID: ${e.defCards.map(hex).join(" ")}`);
  const owned = e.defCards.filter((id) => own.has(id));
  console.log(`  默认卡组里有 ${owned.length}/${e.defCards.length} 张是玩家真的有的：${owned.map(hex).join(" ") || "（无）"}`);
  if (owned.length === 0) {
    console.log("  ⇒ 自动填卡会得到**空卡组**：getAllFavouriteCards() 为空 ⇒ dealSubmitReadyGame 返回 SelectCardID1（飘字提示），不会发 cmd1。");
  }
  if ((mapId & 0x0100) === 0x0100) {
    const gateOwned = WATER_GATE.filter((id) => own.has(id));
    const gateInDeck = WATER_GATE.filter((id) => e.defCards.includes(id));
    console.log(`  该地图带 0x0100 位 ⇒ dealSubmitReadyGame:917 硬门启用`);
    console.log(`    硬门要求卡组含这 15 张之一；玩家拥有其中 ${gateOwned.length} 张：${gateOwned.map(hex).join(" ") || "（无）"}`);
    console.log(`    默认卡组里含其中 ${gateInDeck.length} 张：${gateInDeck.map(hex).join(" ") || "（无）"}`);
  } else {
    console.log("  该地图不带 0x0100 位 ⇒ 没有[必须带指定卡]硬门");
  }
}

main();
