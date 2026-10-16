// 临时探针：把真实的 14689 应答按客户端 a_2943.decode 完整解一遍，
// 再模拟 a_2439.setTDCardsInfo 构造 a_806[0]（防御卡列表），看会不会为空。
process.env.REA_HTTP_PORT = "28082";
process.env.REA_GAME_PORT = "28473";
process.env.REA_AUTH_PORT = "28474";
process.env.REA_HALL_PORT = "28475";
process.env.REA_LOGIC_PORT = "28476";
process.env.REA_SAVE_FILE = new URL("./.probe-cards-save.json", import.meta.url).pathname.replace(/^\//, "");

const { HALL_RESPONSES } = await import("./local-server.mjs");

const req = Buffer.alloc(8);
req.writeInt32BE(1, 4);
const body = HALL_RESPONSES.get(14689).build(req);
console.log(`14689 应答体 ${body.length} 字节`);

let p = 0;
const u8 = () => body[p++];
const i8 = () => body.readInt8(p++);
const i16 = () => { const v = body.readInt16BE(p); p += 2; return v; };
const i32 = () => { const v = body.readInt32BE(p); p += 4; return v; };
const sub = (n) => { const b = body.subarray(p, p + n); p += n; return b; };

const resultID = i16();
console.log(`m_nResultID = ${resultID}`);
if (resultID !== 0) { console.log("非 0 ⇒ 客户端会直接返回，什么都不解析"); process.exit(1); }

const roomID = i32();
const uin = i32();
console.log(`m_iRoomID=${roomID} m_iUin=${uin}`);

// ---- a_2898 m_arrCardInfos（防御卡）----
const nCardCount = i16();
const cards = [];
for (let i = 0; i < nCardCount; i += 1) {
  const len = i16();
  const start = p;
  const cardID = i32();
  const seq = i32();
  const count = i16();
  const usedCount = i16();
  const position = i16();
  const expired = i32();
  const delta = i32();
  const usedTime = i32();
  const isBind = i8();
  const attrCount = i16();
  const attrs = [];
  for (let a = 0; a < attrCount; a += 1) {
    const alen = i16();
    attrs.push({ len: alen, type: i8(), add: i32(), used: i16(), expiredAttr: i32() });
  }
  const consumed = p - start;
  if (consumed !== len) {
    console.log(`  ✗ 第 ${i} 张卡：声明长度 ${len}，实际消费 ${consumed}（错位！）`);
    break;
  }
  cards.push({ cardID, seq, count, usedCount, position, expired, delta, usedTime, isBind, attrs });
}
console.log(`m_nCardCount = ${nCardCount}，成功解出 ${cards.length} 张防御卡`);
console.log(`  位置分布：-1 的有 ${cards.filter((c) => c.position === -1).length} 张；count==0 的有 ${cards.filter((c) => c.count === 0).length} 张`);
console.log(`  前 5 张：`, cards.slice(0, 5).map((c) => `0x${(c.cardID >>> 0).toString(16)}/seq=${c.seq}/pos=${c.position}/cnt=${c.count}/attr=${c.attrs.map((x) => `${x.type}:${x.add}`).join(",")}`).join(" | "));

// a_2439.setTDCardsInfo 的过滤：if(cardInfo.m_nCardCount != 0) 才 push 进 a_806[0]
const a806_0 = cards.filter((c) => c.count !== 0);
console.log(`  → a_806[0]（防御卡列表）长度 = ${a806_0.length}`);

// ---- a_2897 m_arrCardBuyInfos（道具）----
const nBuy = i16();
for (let i = 0; i < nBuy; i += 1) {
  const len = i16();
  p += len;
}
console.log(`m_nCardBuyCount = ${nBuy}`);

// ---- a_2897 m_arrCardComposeInfos ----
const nCompose = i16();
for (let i = 0; i < nCompose; i += 1) {
  const len = i16();
  p += len;
}
console.log(`m_nCardComposeCount = ${nCompose}`);

// ---- a_2900 m_arrCardStore（背包容量）----
const nStore = i16();
const storeSizes = {};
console.log(`m_nCardStoreCount = ${nStore}`);
for (let i = 0; i < nStore; i += 1) {
  const len = i16();
  const start = p;
  const type = i8();
  const num = i16();
  const opened = i16();
  const packCount = i16();
  p += len - (p - start);
  storeSizes[type] = { num, opened, packCount };
  console.log(`  类型=${type} 总格=${num} 已开=${opened} 扩格包=${packCount}  (声明长度 ${len}, 消费 ${p - start})`);
}

// ---- a_1748/a_1730 映射 ----
const TYPE = { 1: "fightingSize(出战槽)", 2: "defPackageSize(卡片包)", 3: "compse_props", 4: "propsPackageSize(道具包)", 5: "heroPackageSize(英雄道具包)" };
console.log("  → 映射：");
for (const [t, v] of Object.entries(storeSizes)) {
  console.log(`     类型 ${t} = ${TYPE[t] ?? "?"} → opened=${v.opened}`);
}
console.log(`     关键：defPackageSize = ${storeSizes[2]?.opened}，fightingSize = ${storeSizes[1]?.opened}`);

const nList = i16();
console.log(`m_nCardListCount = ${nList}`);
for (let i = 0; i < nList; i += 1) { const len = i16(); p += len; }
const nSkill = i16();
console.log(`m_nSkillCount = ${nSkill}`);

console.log(`\n总消费 ${p} / 总长 ${body.length}`);

/* ------------------------------------------------------------------ *
 * 断言：只要有一项不成立，准备界面「我的防御卡」就不可能有卡
 * ------------------------------------------------------------------ */
let pass = 0;
const fails = [];
const must = (cond, msg) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); } else { fails.push(msg); console.log(`  ✗ ${msg}`); }
};

console.log("\n===== 断言 =====");
must(resultID === 0, "m_nResultID == 0（否则客户端 decode 直接返回，什么都不解析）");
must(p === body.length, `长度自洽（消费 ${p} / 总长 ${body.length}）—— 不自洽说明某字段布局写错`);
must(cards.length === nCardCount, `m_arrCardInfos 解出 ${cards.length} 张 == 声明 ${nCardCount}`);
must(a806_0.length > 0, `a_806[0]（防御卡列表）非空 —— 实际 ${a806_0.length} 张`);
must(cards.filter((c) => c.position === -1).length === 0,
  "没有 CardPositionID == -1 的卡（dealDefCardPackage 会把它们挪进 arrInitCards，不进卡包）");
must(cards.filter((c) => c.count === 0).length === 0,
  "没有 m_nCardCount == 0 的卡（setTDCardsInfo 会 filter 掉）");
// a_1730：1 = card_slot_fighting / 2 = card_slot_package_game_card / 4 = game_props / 5 = hero_item
must((storeSizes[2]?.opened ?? 0) > 0, `defPackageSize（类型 2）> 0 —— 实际 ${storeSizes[2]?.opened}`);
must((storeSizes[1]?.opened ?? 0) > 0, `fightingSize（类型 1）> 0 —— 实际 ${storeSizes[1]?.opened}`);
must((storeSizes[2]?.opened ?? 0) >= a806_0.length,
  `defPackageSize(${storeSizes[2]?.opened}) >= 卡数(${a806_0.length})，否则客户端提示"背包已满"`);

console.log(`\n合计：${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) for (const f of fails) console.log(`  - ${f}`);
process.exit(fails.length > 0 ? 1 : 0);
