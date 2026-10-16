#!/usr/bin/env node
/**
 * 单机版 Phase 3：本地 HTTP 站 + 本地游戏服务端。
 *
 *   HTTP : http://127.0.0.1:8080/          —— 启动页 + SWF + 配置（服务器列表改写为本地）
 *   TCP  : 127.0.0.1:18443                 —— 游戏网关（策略文件应答 + 协议抓取/解密）
 *
 * 目录结构依据 LoadFilesList.xml：
 *   ConfigFile baseurl="config/"   SWFFile baseurl=""   Map baseurl="images/map/"
 *   PreviewMouse baseurl="resource/mouse/"
 */

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { teaBlock, xteaDecrypt } from "./capture.mjs";
import { encodeGameFrame, HTTP_HEAD_LEN, HEADER_BODY } from "./frame-codec.mjs";

const HTTP_PORT = Number(process.env.REA_HTTP_PORT ?? 8080);
const GAME_PORT = Number(process.env.REA_GAME_PORT ?? 18443);
const AUTH_PORT = Number(process.env.REA_AUTH_PORT ?? 18444);
const HALL_PORT = Number(process.env.REA_HALL_PORT ?? 18445);
const LOGIC_PORT = Number(process.env.REA_LOGIC_PORT ?? 18446);
const CACHE = path.join(import.meta.dirname, "..", "client-cache");

const LOCAL_KEY = Buffer.from("Authentic@51.COM", "utf8");
const PLAYER_UIN = 100001;
const HALL_SERVER_VERSION = 10000;
const ROLE_UIN = 200001;
const ROLE_NAME = "单机玩家";
const PLAYER_ACCOUNT = "localplayer"; // 与 FLASHVARS.sig_user 一致

/** 角色列表应答 a_2838：注意客户端 decode 比 encode 多读一个 int32 groupID。 */
function buildRoleListBody() {
  const roleBody = Buffer.concat([
    int32(ROLE_UIN),
    encodeString(ROLE_NAME, 32),
    Buffer.from([0]), // m_cState int8
    int32(1), // m_iLogicServerID
    int32(0), // m_iRoomID
    int32(Math.floor(Date.now() / 1000)), // m_iLastLoginTime
  ]);
  return Buffer.concat([
    int16(0),
    int32(PLAYER_UIN),
    int32(1), // m_iGroupID（decode 会读）
    Buffer.from([1]), // m_cRoleCount int8
    int16(roleBody.length),
    roleBody,
  ]);
}

// —— 大厅子系统：以"空数据"应答为主，字段顺序严格按各应答类的 decode ——
const emptyResult = () => int16(0); // a_2835
const taskInfoEmpty = () => Buffer.concat([int16(0), int32(ROLE_UIN), int16(0)]); // a_2995
const friendListEmpty = () => Buffer.concat([int16(0), int32(PLAYER_UIN), int16(0)]); // a_2687
const achievementsEmpty = () =>
  Buffer.concat([int16(0), int32(ROLE_UIN), int16(0), int16(0)]); // a_2833
const recipesEmpty = () =>
  Buffer.concat([int16(0), int32(PLAYER_UIN), int32(0), int16(0)]); // SCResponseRecipesGetInfo
/* ------------------------------------------------------------------ *
 * 卡片 / 道具 / 背包（储藏室）
 *
 * 客户端拿到服务端下发的 id 之后，要去 config-data/card_desc.xml 的图鉴表
 * （a_2027.m_dictDesc）里查名字，图标再按 id 的高位拼成
 * images/<id>>>28>/<卡类>/0x<id>.png，所以只能用图鉴表里真实存在的 id，
 * 否则卡片是一格空图、没名字。
 *
 * 图鉴表里 index>0 的条目正好是经典卡表（1 小笼包、2 小火炉、3 土司面包…），
 * 其余的按 type 归类成道具 / 材料 / 宝石 / 结晶。
 * ------------------------------------------------------------------ */

let cardCatalogCache = null;

function cardCatalog() {
  if (cardCatalogCache !== null) return cardCatalogCache;
  const out = { cards: [], props: [], materials: [], gems: [], crystals: [] };
  const seenItem = new Set();
  const cardSet = new Set();
  const addCard = (id) => {
    if (cardSet.has(id)) return;
    cardSet.add(id);
    out.cards.push(id);
  };
  try {
    const xml = fs.readFileSync(path.join(CONFIG_DATA_DIR, "card_desc.xml"), "utf8");
    for (const tag of xml.match(/<item\b[^>]*>/g) ?? []) {
      const id = Number.parseInt((tag.match(/id="(0x[0-9a-fA-F]+)"/) ?? [])[1] ?? "", 16);
      if (!Number.isFinite(id) || id === 0 || seenItem.has(id)) continue;
      seenItem.add(id);
      const type = (tag.match(/type="([^"]*)"/) ?? [])[1] ?? "";
      const index = Number.parseInt((tag.match(/index="(\d+)"/) ?? [])[1] ?? "0", 10);
      if (type === "材料道具") out.materials.push(id);
      else if (type === "功能道具") out.props.push(id);
      else if (type === "宝石" || type === "海神宝石") out.gems.push(id);
      else if (type === "结晶") out.crystals.push(id);
      // index>0 且带"…型"的才是能上场的卡（攻击型/辅助型/生产型/防守型…），
      // 结晶虽然也带 index，但属于镶嵌系统，不算卡。
      if (index > 0 && type.endsWith("型")) addCard(id);
    }
    // 融合配方里的主卡（main_id）必须也在卡表里，否则合成屋选不出材料。
    const fus = fs.readFileSync(path.join(CONFIG_DATA_DIR, "CardFusion.xml"), "utf8");
    for (const m of fus.matchAll(/main_id="([^"]+)"/g)) {
      for (const one of m[1].split("|")) {
        const id = Number.parseInt(one, 16);
        if (Number.isFinite(id) && id !== 0) addCard(id);
      }
    }
  } catch (e) {
    console.log(`[cards] 读取 card_desc.xml 失败：${e.message}`);
  }
  // 储藏室解锁/扩建要用的四种扩建包，保证背包界面能解锁和扩容。
  for (const pack of [0x13110080, 0x131100a0, 0x131100b0, 0x131100c0]) {
    if (!out.props.includes(pack)) out.props.unshift(pack);
  }
  console.log(
    `[cards] 图鉴：卡片 ${out.cards.length} / 功能道具 ${out.props.length} / 材料 ${out.materials.length} / 宝石 ${out.gems.length} / 结晶 ${out.crystals.length}`,
  );
  cardCatalogCache = out;
  return out;
}

/**
 * 存档：合成屋的结果（新卡、融合卡等级）要能跨重启保留。
 * 存在服务端目录下的 save.json，就是一张"当前卡表"，删掉即恢复初始状态。
 */
const SAVE_FILE = process.env.REA_SAVE_FILE ?? path.join(import.meta.dirname, "save.json");
const cardState = { cards: [], nextSeq: 900000 };

/** 卡表 = 图鉴初始卡 + 存档增量。 */
function loadCardState() {
  if (cardState.cards.length > 0) return cardState;
  cardCatalog().cards.forEach((id, i) => {
    cardState.cards.push({ id, seq: i + 1, count: 1, grade: 0, expire: -1 });
  });
  try {
    const saved = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    if (Array.isArray(saved?.cards) && saved.cards.length > 0) {
      cardState.cards = saved.cards
        .filter((c) => c !== null && typeof c === "object" && Number.isFinite(c.id))
        .map((c) => ({
          id: c.id >>> 0,
          seq: c.seq | 0,
          count: c.count | 0 || 1,
          grade: c.grade | 0,
          expire: Number.isFinite(c.expire) ? c.expire : -1,
        }));
      cardState.nextSeq = Number.isFinite(saved.nextSeq) ? saved.nextSeq : 900000;
      console.log(`[save] 读取存档：${cardState.cards.length} 张卡（含合成屋产出）`);
    }
  } catch {
    // 没有存档或存档损坏都按初始卡表走
  }
  return cardState;
}

function saveCardState() {
  try {
    fs.writeFileSync(
      SAVE_FILE,
      JSON.stringify({ nextSeq: cardState.nextSeq, cards: cardState.cards }),
    );
  } catch (e) {
    console.log(`[save] 写存档失败：${e.message}`);
  }
}

/**
 * a_2898 卡片条目（外层 int16 = 本条长度）。
 * grade>0 时补一条 **type=10** 的附加属性 —— 客户端 setTDCardsInfo 里
 * `attr.m_cAttrType == 10` 才会写进 a_3228.TypeValue，而 DefCard 的星星
 * （DefCard.DefStar = cardAttr.TypeValue）就是按 TypeValue 画的。
 * （type=7 是"品阶"DefCardGradeLevel，另一个图标，别混。）
 * expireAt = 到期时间戳（秒）；-1 = 永久 —— 原版按菜谱 <Award validtime> 给，
 * 制作出来的卡默认是 30 天，塞了保鲜袋才变永久。
 */
function cardEntry(cardID, seq, position, count = 1, grade = 0, expireAt = -1) {
  const attr = Buffer.concat([
    int16(11), // CCardExtraAttr 长度
    Buffer.from([10]), // m_cAttrType：10 = 强化等级（客户端拿它当 TypeValue → 星星）
    int32(grade), // m_iAttrAdd
    int16(0), // m_nAttrUsedCount
    int32(-1), // m_iExpiredTime
  ]);
  const body = Buffer.concat([
    int32(cardID),
    int32(seq),
    int16(count), // m_nCardCount，客户端按"非 0 才显示"过滤
    int16(0), // 已使用数量
    int16(position), // 背包格位
    int32(expireAt), // m_iExpiredTime
    int32(0), // 剩余时间
    int32(expireAt), // m_iUsedTime：客户端拿它当 ExpiredTime 用
    Buffer.from([2]), // 绑定标记（客户端默认 2）
    int16(grade > 0 ? 1 : 0), // 附加属性条数
    grade > 0 ? attr : Buffer.alloc(0),
  ]);
  return Buffer.concat([int16(body.length), body]);
}

/** a_2897 购卡/合成类道具条目。 */
function propCardEntry(cardID, seq, position, count = 1) {
  const body = Buffer.concat([
    int32(cardID),
    int32(seq),
    int16(count),
    int16(0),
    int16(position),
    int32(-1), // 过期时间
    int32(-1), // 客户端当 ExpiredTime 用
    int32(0), // 剩余时间
    Buffer.from([2]), // 绑定标记
  ]);
  return Buffer.concat([int16(body.length), body]);
}

/** a_2900 背包容量：类型见 a_1730（1 出战槽 / 2 卡片包 / 4 道具包 / 5 英雄道具包）。 */
function storeSizeEntry(type, opened) {
  const body = Buffer.concat([
    Buffer.from([type & 0xff]),
    int16(opened), // 总格数
    int16(opened), // 已开启格数 —— updatePackageSize 用的就是这个
    int16(0), // 额外扩格包数量
  ]);
  return Buffer.concat([int16(body.length), body]);
}

/** CHeroItem：储藏室里的物品（外层 int16 长度由调用方补）。 */
function heroItemBody(itemID, seq, position, count = 1) {
  return Buffer.concat([
    int32(itemID),
    int32(seq),
    int16(count),
    int16(0), // 已使用次数
    int32(-1), // 过期时间
    int16(position), // 格位
    Buffer.from([2]), // 绑定标记
    Buffer.from([0]), // 品质颜色
    int32(-1), // 客户端当 ExpiredTime 用：-1 = 永久
    int32(0), // 剩余时间
    int16(0), // 附加属性条数
    int16(0), // 槽位数
  ]);
}

/** GET_CARDS(14689) → a_2943：经典卡表 + 两页道具 + 背包容量。 */
function buildCardsBody(request) {
  const roomID = request.length >= 8 ? request.readInt32BE(4) : 1;
  const cat = cardCatalog();
  const state = loadCardState();
  const parts = [int16(0), int32(roomID), int32(ROLE_UIN)];

  // 过期卡不再下发（客户端本来也会把它们折起来，服务端顺手清掉更干净）
  const nowSec = Math.floor(Date.now() / 1000);
  const alive = state.cards.filter((c) => !(c.expire > 0 && c.expire < nowSec));
  parts.push(int16(alive.length));
  alive.forEach((c, i) => parts.push(cardEntry(c.id, c.seq, i, c.count, c.grade, c.expire ?? -1)));

  // 制作/强化页要用的道具：
  //   0x1242 配方、0x1241 材料      → 999
  //   0x1231 保鲜袋 / 0x1232 四叶草 / 0x1233 护佑符 / 0x1234 香料
  //   0x1235 降解剂 / 0x1236 钻 / 0x1237 拆卸改锥 → 2000
  const compose = composeRules();
  const { star } = composeAssistants();
  const auxPrefixes = ["1231", "1232", "1233", "1234", "1235", "1236", "1237"];
  const auxIds = cat.props.filter((id) =>
    auxPrefixes.some((p) => (id >>> 0).toString(16).padStart(8, "0").startsWith(p)),
  );
  const props = [
    ...compose.formulas.map((id) => ({ id, count: 999 })),
    ...compose.materials.map((id) => ({ id, count: 999 })),
    // 香料的 CardSeq 用配置里的 count（5）：客户端 delPropsCardAttr 拿 m_iSequence
    // 当消耗数量，这样每次制作正好扣 5 个香料，和原版一致。
    ...auxIds.map((id) => ({ id, count: 2000, seq: star.get(id)?.count ?? 1 })),
    ...cat.props
      .filter((id) => !auxIds.includes(id))
      .slice(0, 40)
      .map((id) => ({ id, count: 1 })),
  ];
  parts.push(int16(props.length));
  // seq 必须给"小数字"：客户端 delPropsCardAttr 是拿 m_iSequence 当数量从总数里扣的
  // （MakeCardPane.getComposeItems 把卡片的 CardSeq 原样塞进请求），
  // 之前用 100000+i 当 seq，制作一次就把数量扣成负数、整条被删掉。
  props.forEach((p, i) => parts.push(propCardEntry(p.id, p.seq ?? 1, i, p.count)));

  const mats = cat.materials.slice(0, 60);
  parts.push(int16(mats.length));
  mats.forEach((id, i) => parts.push(propCardEntry(id, 1, i)));

  // 背包容量给足：道具页现在发 392 项，容量小于它就会提示"背包已满"
  const sizes = [
    storeSizeEntry(1, 60), // 出战卡槽
    storeSizeEntry(2, 2000), // 卡片背包
    storeSizeEntry(4, 2000), // 道具背包
    storeSizeEntry(5, 2000), // 英雄道具背包
  ];
  parts.push(int16(sizes.length), ...sizes);
  parts.push(int16(0)); // 卡组
  parts.push(int16(0)); // 技能
  return Buffer.concat(parts);
}

/** 6 个储藏室：名称跟 config-data/extraBag.xml 对齐。 */
const STORE_BOX_CAPACITY = 60; // 原版 extraBag.xml 的每室容量（扩建后客户端会自己收到 240）

function storeBoxZones() {
  const cat = cardCatalog();
  return [
    // 每个储藏室别塞太满：客户端显示"60/60"满格时扩建/移动都要走服务器，
    // 留出空位可以避免一堆边界流程。
    { name: "No0储藏室", ids: cat.props.slice(0, 20) },
    { name: "No1储藏室", ids: cat.materials.slice(0, 20) },
    { name: "No2储藏室", ids: cat.gems.slice(0, 20) },
    { name: "No3储藏室", ids: cat.crystals.slice(0, 20) },
    { name: "No4储藏室", ids: [] },
    { name: "No5储藏室", ids: [] },
  ];
}

/**
 * 扩建/解锁储藏室(12819) → CResponseExpandStoreBox。
 *
 * 请求：[seq][srcUin][itemID][itemSeq][count int16][opt int8][ruleID int8][boxIndex int8][name]
 * 应答：resultID + m_iID(储藏室下标) + m_iSeq(opt) + m_nStoreCount(新容量)
 * 客户端 OnCResponseExpandStoreBox 用 m_nStoreCount 直接覆盖该储藏室容量；
 * 这条不理的话"扩建"窗口会一直等服务器，整个背包界面被它挡住关不掉。
 */
function buildExpandStoreBoxBody(request) {
  const count = request.length >= 18 ? request.readInt16BE(16) : 0;
  const opt = request.length >= 19 ? request.readInt8(18) : 1;
  const boxIndex = request.length >= 21 ? request.readInt8(20) : 0;
  const newCount = 240; // 储藏室扩建后的容量（原来客户端配置是 60）
  console.log(
    `[storebox] 扩建 box=${boxIndex} opt=${opt} count=${count} → 新容量 ${newCount}`,
  );
  return Buffer.concat([
    int16(0),
    int32(boxIndex & 0xff),
    int32(opt),
    int16(newCount),
  ]);
}

/**
 * GET_STORE_BOX(12817) → CResponseGetStroeBoxInfo，
 * UPDATE_STORE_BOX(12818) → CResponseUpdateStoreBox（比 12817 多一个"本次变更物品"计数）。
 */
function buildStoreBoxBody(request, withUpdateInfo = false) {
  const parts = [int16(0), int32(ROLE_UIN)];
  storeBoxZones().forEach((zone, z) => {
    /**
     * ⚠ 2026-10-16 修：这里第一个 int16 是**储藏室容量**（`CResponseGetStroeBoxInfo.decode:45`
     * → `StroeBoxRes.iStoreCount`），第二个才是**物品数**（`:47 m_nCardCount`）。
     * 原实现两个都写 `zone.ids.length` ⇒ 客户端看到的永远是"N/N 满格" ⇒
     * 背包里动不动就提示"请扩容"（`StorageRoom/ExpandCapacityUI`）。容量按原版配置给 60。
     */
    parts.push(int16(STORE_BOX_CAPACITY), encodeString(zone.name, 32), int16(zone.ids.length));
    zone.ids.forEach((id, i) => {
      const body = heroItemBody(id, z * 1000 + i + 1, i);
      parts.push(int16(body.length), body);
    });
  });
  if (withUpdateInfo) parts.push(int16(0));
  return Buffer.concat(parts);
}

const buildStoreBoxUpdateBody = (request) => buildStoreBoxBody(request, true);

/* ------------------------------------------------------------------ *
 * 卡片制作（合成屋 · 制作页）
 *
 * 制作流程：把"配方"卡（0x1242xxxx）和材料（0x1241xxxx）拖进制作格 →
 * 客户端发 14849，其中 iComposeID = ComposeConfig.getAward(配方id).parent().@id，
 * 也就是 compose.xml 里 <Rule id="N"> 的 N；服务端据此回 <Award id="…"> 那张卡。
 *
 * 配方/材料必须出现在卡表的"道具页"（a_806[1] → ComposeData._propsCardData），
 * 否则制作页一个配方都列不出来（PackagesManager.getCardType 按 id 前缀把
 * 0x1242xxxx 判成 CARD_TYPE_FORMULA、0x1241xxxx 判成 CARD_TYPE_MATERIAL）。
 * ------------------------------------------------------------------ */
let composeRuleCache = null;

function composeRules() {
  if (composeRuleCache !== null) return composeRuleCache;
  const out = { byRule: new Map(), formulas: [], materials: [] };
  try {
    const xml = fs.readFileSync(path.join(CONFIG_DATA_DIR, "compose.xml"), "utf8");
    for (const rule of xml.match(/<Rule\b[\s\S]*?<\/Rule>/g) ?? []) {
      const ruleID = Number.parseInt((rule.match(/<Rule\b[^>]*\bid="(\d+)"/) ?? [])[1] ?? "0", 10);
      const award = Number.parseInt((rule.match(/<Award\b[^>]*\bid="(0x[0-9a-fA-F]+)"/) ?? [])[1] ?? "", 16);
      if (ruleID === 0 || !Number.isFinite(award)) continue;
      const formula = Number.parseInt((rule.match(/<Expressions\b[^>]*\bid="(0x[0-9a-fA-F]+)"/) ?? [])[1] ?? "", 16);
      // <Award validtime="2592000">：产物有效期（秒），-1 = 永久
      const validtime = Number.parseInt((rule.match(/<Award\b[^>]*\bvalidtime="(-?\d+)"/) ?? [])[1] ?? "-1", 10);
      const materials = [];
      for (const m of rule.matchAll(/<Item\b[^>]*\bid="(0x[0-9a-fA-F]+)"/g)) {
        materials.push(Number.parseInt(m[1], 16));
      }
      out.byRule.set(ruleID, { award, formula, materials, validtime });
      if (Number.isFinite(formula)) out.formulas.push(formula);
      out.materials.push(...materials);
    }
  } catch (e) {
    console.log(`[compose] 读取 compose.xml 失败：${e.message}`);
  }
  out.formulas = [...new Set(out.formulas)];
  out.materials = [...new Set(out.materials)];
  console.log(
    `[compose] 配方 ${out.byRule.size} 条 / 配方卡 ${out.formulas.length} 张 / 材料 ${out.materials.length} 种`,
  );
  composeRuleCache = out;
  return out;
}

/**
 * compose.xml 的 <Assistant> 段 —— 制作页右侧辅助格用的道具：
 *   <Star>         香料：value = 产物星级(1..9)，count = 每次消耗个数
 *   <ValidateTime> 保鲜袋(value=-1，把产物改成永久) / 降解剂(value=2592000)
 *   <Rate>         四叶草：value = 成功率倍数（强化/升级页用）
 *   <Protect>      护佑符：失败保护
 */
let composeAssistantCache = null;

function composeAssistants() {
  if (composeAssistantCache !== null) return composeAssistantCache;
  const out = { star: new Map(), validateTime: new Map(), rate: new Map(), protect: new Map() };
  const parse = (seg, map, withCount) => {
    for (const tag of seg.match(/<Item\b[^>]*>/g) ?? []) {
      const id = Number.parseInt((tag.match(/id="(0x[0-9a-fA-F]+)"/) ?? [])[1] ?? "", 16);
      if (!Number.isFinite(id)) continue;
      const value = Number.parseFloat((tag.match(/value="([^"]*)"/) ?? [])[1] ?? "0");
      const entry = { value: Number.isFinite(value) ? value : 0 };
      if (withCount) {
        const count = Number.parseInt((tag.match(/count="(\d+)"/) ?? [])[1] ?? "1", 10);
        entry.count = Number.isFinite(count) && count > 0 ? count : 1;
        const gold = Number.parseInt((tag.match(/gold="(\d+)"/) ?? [])[1] ?? "0", 10);
        entry.gold = Number.isFinite(gold) ? gold : 0;
      }
      map.set(id, entry);
    }
  };
  try {
    const xml = fs.readFileSync(path.join(CONFIG_DATA_DIR, "compose.xml"), "utf8");
    const all = xml.slice(xml.indexOf("<Assistant>"), xml.indexOf("</Assistant>"));
    const section = (name) => {
      const from = all.indexOf(`<${name}>`);
      const to = all.indexOf(`</${name}>`);
      return from >= 0 && to > from ? all.slice(from, to) : "";
    };
    parse(section("Star"), out.star, true);
    parse(section("ValidateTime"), out.validateTime, false);
    parse(section("Rate"), out.rate, false);
    parse(section("Protect"), out.protect, false);
  } catch (e) {
    console.log(`[compose] 读取辅助道具配置失败：${e.message}`);
  }
  console.log(
    `[compose] 香料 ${out.star.size} 种 / 保鲜期道具 ${out.validateTime.size} 种 / 四叶草 ${out.rate.size} 种 / 护佑符 ${out.protect.size} 种`,
  );
  composeAssistantCache = out;
  return out;
}

/** 解析 14849 制作请求（a_2858）。 */
function parseComposeRequest(request) {
  let pos = 4; // 跳过 sequence
  const i16 = () => {
    const v = request.readInt16BE(pos);
    pos += 2;
    return v;
  };
  const i32 = () => {
    const v = request.readInt32BE(pos);
    pos += 4;
    return v;
  };
  const pair = () => ({ id: i32(), seq: i32() });
  const srcUin = i32();
  const composeID = i32();
  const materials = Array.from({ length: i16() }, pair);
  const assMaterials = Array.from({ length: i16() }, pair);
  const disableConsortiaExtra = i16();
  return { srcUin, composeID, materials, assMaterials, disableConsortiaExtra };
}

/**
 * 原版逻辑：每次制作/融合都产生**一张新的卡**（独立 seq），不合并数量。
 * grade = 星级（由香料决定），expireAt = 到期时间戳（-1 = 永久）。
 */
function newCardEntry(cardID, grade = 0, expireAt = -1) {
  const state = loadCardState();
  state.nextSeq += 1;
  const card = { id: cardID, seq: state.nextSeq, count: 1, grade, expire: expireAt };
  state.cards.unshift(card);
  return card;
}

/** SCResponseCompose：resultID + 新卡信息 + 消耗清单 + 金币/等级。 */
function buildComposeBody(request) {
  const q = parseComposeRequest(request);
  const rule = composeRules().byRule.get(q.composeID);
  if (rule === undefined) return composeFailure(q, "没有找到这个配方");

  // 原版辅助道具的效果（都在右侧那两个格子里）：
  //   香料   → 产物星级（天然=1 星 … 圣灵=9 星），每个菜谱固定消耗 count 个
  //   保鲜袋 → 把产物改成永久；否则按菜谱 <Award validtime>（一般 30 天）
  const { star, validateTime } = composeAssistants();
  let grade = 0;
  let expireOverride = null;
  let spiceName = "";
  for (const ass of q.assMaterials) {
    const spice = star.get(ass.id);
    if (spice !== undefined && spice.value > grade) {
      grade = spice.value;
      spiceName = ass.id.toString(16);
    }
    const fresh = validateTime.get(ass.id);
    if (fresh !== undefined) expireOverride = fresh.value;
  }
  const validtime = expireOverride === null ? rule.validtime : expireOverride;
  const expireAt = validtime < 0 ? -1 : Math.floor(Date.now() / 1000) + validtime;
  const produced = newCardEntry(rule.award, grade, expireAt);
  saveCardState();
  pendingCardNotify = [produced]; // 新卡 → 通知客户端补进主卡表
  const life = expireAt < 0 ? "永久" : `${Math.round(validtime / 86400)}天`;
  console.log(
    `[compose] 规则 ${q.composeID} → ${rule.award.toString(16)} seq=${produced.seq} ` +
      `${grade > 0 ? `${grade}星(香料${spiceName})` : "0星"} ${life}（材料 ${q.materials.length} + 辅助 ${q.assMaterials.length}）`,
  );
  return Buffer.concat([
    int16(0),
    int16(27),
    cardUpdateInfo({
      cardID: produced.id,
      cardSeq: produced.seq,
      count: 1,
      isBind: 2,
      updateMode: 1,
      usedTime: produced.expire ?? -1, // ← 客户端拿它当 ExpiredTime，不传就是永久
    }),
    int32(q.srcUin),
    int32(q.composeID),
    int16(q.materials.length),
    ...pairBytes(q.materials),
    int16(q.assMaterials.length),
    ...pairBytes(q.assMaterials),
    Buffer.alloc(8), // m_i64coin
    // m_cLevel：客户端 ComposeData.updateDataByMakeCard 会把它写成
    // newCardInfo.m_iTypeValue → DefCard 的星星就按这个画，所以这里给香料星级。
    Buffer.from([grade & 0xff]),
    // 注意 SCResponseCompose 里最后一栏是 m_nDisableConsortiaExtra（没有 m_cGradeLevel），
    // 星级由这里 + 随后的卡表重推（附加属性 type=10）共同带给客户端。
    int16(q.disableConsortiaExtra),
  ]);
}

function composeFailure(q, reason) {
  console.log(`[compose] 失败：${reason}（composeID=${q.composeID}）`);
  return Buffer.concat([
    int16(1),
    int16(27),
    cardUpdateInfo({ cardID: 0, cardSeq: 0, count: 0, isBind: 2, updateMode: 0 }),
    int32(q.srcUin),
    int32(q.composeID),
    int16(0),
    int16(0),
    Buffer.alloc(8),
    Buffer.from([0]),
    int16(q.disableConsortiaExtra),
    encodeString(reason, 4096),
  ]);
}

/* ------------------------------------------------------------------ *
 * 卡槽包（背包格子）
 *
 * 客户端点中"未开启的格子"会发 14867 / 14868 / 14869 请求开格或使用扩格包。
 * 这几条以前完全没有应答，界面就一直停在"等待服务器"状态 —— 表现就是
 * 背包打开后关不掉。这里统一按"没有可用扩格包"回失败，界面拿到应答即可解锁。
 * ------------------------------------------------------------------ */

const cardSlotPackBody = (request, withItem = false) => {
  const srcUin = request.length >= 8 ? request.readInt32BE(4) : ROLE_UIN;
  const slotType = request.length >= 9 ? request.readUInt8(8) : 0;
  const packPosi = request.length >= 10 ? request.readUInt8(9) : 0;
  const head = Buffer.concat([
    int16(1), // resultID != 0 → 失败
    int32(srcUin),
    Buffer.from([slotType & 0xff]),
    Buffer.from([packPosi & 0xff]),
  ]);
  const tail = withItem
    ? Buffer.concat([int32(0), int32(0), int16(0)]) // itemID / itemSeq / slotAdd
    : Buffer.alloc(0);
  return Buffer.concat([head, tail, encodeString("没有可用的扩建包", 4096)]);
};

/** 14867：开启卡槽包 → a_2867 */
const openCardSlotPack = (request) => cardSlotPackBody(request, false);
/** 14868 / 14869：使用卡槽包 → a_2870 */
const useCardSlotPack = (request) => cardSlotPackBody(request, true);

/* ------------------------------------------------------------------ *
 * 合成屋（卡片融合 / 融合卡升级）
 *
 * 配方来自 config-data/CardFusion.xml：
 *   <fusion_tab type="13">…<element main_id="0x1113008f"><obtain id="0x11700000"/>
 * 即"用 main_id 这张卡（若干张）融合出 obtain"。
 * 客户端 ComposeData.updateDataByFusionCard 会用应答里的 m_stNewCardInfo 把新卡
 * 加进卡表，并按 m_arrFusionCard / m_arrMaterial 扣掉消耗的卡和材料，
 * 所以这三个字段必须原样回显请求里的内容。
 * ------------------------------------------------------------------ */

let fusionRecipeCache = null;

function fusionRecipes() {
  if (fusionRecipeCache !== null) return fusionRecipeCache;
  const map = new Map();
  try {
    const xml = fs.readFileSync(path.join(CONFIG_DATA_DIR, "CardFusion.xml"), "utf8");
    for (const tab of xml.match(/<fusion_tab\b[\s\S]*?<\/fusion_tab>/g) ?? []) {
      const type = Number.parseInt((tab.match(/\btype="(\d+)"/) ?? [])[1] ?? "0", 10);
      for (const el of tab.match(/<element\b[\s\S]*?<\/element>/g) ?? []) {
        const main = (el.match(/main_id="([^"]+)"/) ?? [])[1] ?? "";
        const obtain = (el.match(/<obtain\b[^>]*\bid="([^"]+)"/) ?? [])[1] ?? "";
        if (!main || !obtain) continue;
        const first = Number.parseInt(main.split("|")[0], 16);
        map.set(`${type}_${first}`, Number.parseInt(obtain.split("|")[0], 16));
      }
    }
  } catch (e) {
    console.log(`[fusion] 读取 CardFusion.xml 失败：${e.message}`);
  }
  console.log(`[fusion] 融合配方 ${map.size} 条`);
  fusionRecipeCache = map;
  return map;
}

/** CCardUpdateInfoRes：27 字节，调用方补 int16 长度前缀。 */
function cardUpdateInfo({ cardID, cardSeq, count, isBind, updateMode, usedTime }) {
  return Buffer.concat([
    int32(cardID),
    int32(cardSeq),
    int16(count),
    int16(0), // 已使用数量
    Buffer.from([0]), // m_cTimeFlag
    int32(-1), // m_iExpiredTime
    Buffer.from([isBind & 0xff]),
    Buffer.from([updateMode & 0xff]),
    int32(usedTime ?? -1), // 客户端当 ExpiredTime 用
    int32(0), // m_iDeltaTime
  ]);
}

/** 解析 14876 / 14877 请求（CRequestFusionCard）。 */
function parseFusionRequest(request) {
  let pos = 4; // 跳过 sequence
  const i16 = () => {
    const v = request.readInt16BE(pos);
    pos += 2;
    return v;
  };
  const i32 = () => {
    const v = request.readInt32BE(pos);
    pos += 4;
    return v;
  };
  const pair = () => ({ id: i32(), seq: i32() });
  const srcUin = i32();
  const itype = i16();
  const cards = Array.from({ length: i16() }, pair);
  const materials = Array.from({ length: i16() }, pair);
  const insurance = i16();
  return { srcUin, itype, cards, materials, insurance };
}

const pairBytes = (list) => list.map((x) => Buffer.concat([int32(x.id), int32(x.seq)]));

/**
 * 融合(14876) / 融合卡升级(14877) → SCResponseFusionCard。
 * 升级时主卡不变、只把等级 +1；融合时按配方换成产物卡。
 */
function buildFusionBody(request, isUpgrade) {
  const q = parseFusionRequest(request);
  const mainCard = q.cards[0];
  const state = loadCardState();
  let produced; // 应答里的"新卡信息"：{ id, seq, count }
  let gradeLevel = 0;

  if (isUpgrade) {
    if (!mainCard) return fusionFailure(q, "没有选择主卡");
    // 找主卡：优先按 (id, seq) 精确匹配，找不到就按 id 找第一张
    let target = state.cards.find((c) => c.id === mainCard.id && c.seq === mainCard.seq);
    if (target === undefined) target = state.cards.find((c) => c.id === mainCard.id);
    if (target === undefined) {
      target = { id: mainCard.id, seq: mainCard.seq, count: 1, grade: 0 };
      state.cards.push(target);
    }
    target.grade += 1;
    gradeLevel = target.grade;
    produced = target;
  } else {
    if (!mainCard) return fusionFailure(q, "没有选择卡片");
    const award = fusionRecipes().get(`${q.itype}_${mainCard.id}`) ?? 0;
    if (award === 0) return fusionFailure(q, "这几张卡不能融合");
    // 先扣掉被吃掉的卡，再把产物并进卡表（已有同款则数量 +1）
    const consumed = new Set(q.cards.map((c) => `${c.id}:${c.seq}`));
    const before = state.cards.length;
    state.cards = state.cards.filter((c) => !consumed.has(`${c.id}:${c.seq}`));
    produced = newCardEntry(award); // 原版：融合产物是独立的一张新卡
    pendingCardNotify = [produced];
    console.log(
      `[fusion] ${mainCard.id.toString(16)} → ${award.toString(16)}，卡表 ${before} → ${state.cards.length}，新卡 seq=${produced.seq}`,
    );
  }

  saveCardState();
  return Buffer.concat([
    int16(0),
    int32(q.srcUin),
    int16(q.cards.length),
    ...pairBytes(q.cards),
    int16(q.materials.length),
    ...pairBytes(q.materials),
    int16(27),
    cardUpdateInfo({
      cardID: produced.id,
      cardSeq: produced.seq,
      count: isUpgrade ? 1 : produced.count,
      isBind: 2,
      updateMode: 1,
      usedTime: produced.expire ?? -1,
    }),
    int16(produced.grade), // m_iCardLevel：客户端当作 TypeValue（星星）
    int16(gradeLevel), // m_cGradeLevel
  ]);
}

/** 失败也是同一个结构，客户端 decode 会一路读完。 */
function fusionFailure(q, reason) {
  console.log(`[fusion] 失败：${reason}`);
  return Buffer.concat([
    int16(1),
    int32(q.srcUin),
    int16(0),
    int16(0),
    int16(27),
    cardUpdateInfo({ cardID: 0, cardSeq: 0, count: 0, isBind: 2, updateMode: 0 }),
    int16(0),
    int16(0),
    encodeString(reason, 4096),
  ]);
}

const buildFusionCardBody = (request) => buildFusionBody(request, false);
const buildFusionUpgradeBody = (request) => buildFusionBody(request, true);

/* ------------------------------------------------------------------ *
 * 菜单解锁：服务端主动推送引导数据（14928 MSG_HALL_GET_GUIDE_DATA）
 *
 * 大厅右侧菜单 TDMenuUI.initMenu() 默认只显示 背包/任务/商城/充值/跳转，
 * 合成屋、技能、公会等按钮要靠 TDLobbyCoreUI.onLobbyGuide() → updateOpenMenu()
 * → IMenuOpen.setOpenMenu() 才会 showBtn()。而 onLobbyGuide 只由
 * a_2439.updateGuideData() 触发，后者唯一的来源是这条 14928 ——
 * 客户端只注册了接收处理、从来不主动请求（全工程搜不到发送点），
 * 所以必须由服务端推。
 *
 * 数据留空（extDataSize=0）时客户端会走"老玩家首次登录"分支：
 *   setIslandOpen(getGameLevel(gamePoint))  → 按等级放开岛屿
 *   setAllMenuOpen()                        → 菜单全部打开
 * 正是单机版要的效果。onLobbyGuide 自身幂等（m_oGuideData 非空即返回），
 * 所以可以重复推。
 * ------------------------------------------------------------------ */
function buildGuidePushPacket(sessionKey) {
  return buildPacket({
    messageId: 14928,
    version: 3,
    uin: PLAYER_UIN,
    playerId: PLAYER_UIN,
    flag: 4,
    payload: xteaEncrypt(
      padPlaintext(Buffer.concat([int32(0), int16(0), int32(PLAYER_UIN), int16(0)])),
      sessionKey,
      32,
    ),
  });
}

/**
 * 卡片增量通知（14620 a_262 → a_2757）。
 *
 * 制作/融合出来的新卡只落在合成屋自己那份 clone 里，主卡表 a_806 是另一份。
 * 原版靠这条通知把新卡补进主卡表（a_2439.updateNotifyCards 按 (CardID,CardSeq)
 * 做 upsert，再 a_1825.onNotifyDefCardsChange 通知背包刷新），
 * **不会切场景** —— 之前我图省事重推 14689，而客户端收到 14689 的处理是
 * `a_3745(); a_3747(-1,-1)`（隐藏提示 + 切回城镇），所以一做卡片就被弹出合成屋。
 */
export function buildCardNotifyBody(cards) {
  const parts = [int32(ROLE_UIN), int16(cards.length)];
  for (const c of cards) {
    const attr =
      c.grade > 0
        ? Buffer.concat([
            int16(11),
            Buffer.from([10]), // type=10 → TypeValue → 星星
            int32(c.grade),
            int16(0),
            int32(-1),
          ])
        : Buffer.alloc(0);
    const expire = c.expire ?? -1;
    const body = Buffer.concat([
      int32(c.id),
      int32(c.seq),
      int16(c.count ?? 1),
      int16(0), // 已使用次数
      Buffer.from([0]), // m_cTimeFlag
      int32(expire), // m_iExpiredTime
      Buffer.from([2]), // m_cIsBind
      Buffer.from([1]), // m_cUpdateMode
      int32(expire), // m_iUsedTime：客户端拿它当 ExpiredTime
      int32(0), // m_iDeltaTime
      int16(c.grade > 0 ? 1 : 0),
      attr,
    ]);
    parts.push(int16(body.length), body);
  }
  parts.push(int16(0)); // m_nHeroItemDataCount
  return Buffer.concat(parts);
}

function buildCardNotifyPacket(sessionKey, cards) {
  return buildPacket({
    messageId: 14620,
    version: 3,
    uin: PLAYER_UIN,
    playerId: PLAYER_UIN,
    flag: 4,
    payload: xteaEncrypt(
      padPlaintext(Buffer.concat([int32(0), buildCardNotifyBody(cards)])),
      sessionKey,
      32,
    ),
  });
}

/**
 * 构建应答时记下"这次要通知客户端哪几张卡"。
 *
 * 客户端 updateNotifyCards 对**已存在**的卡只更新数量/到期时间，不更新附加属性
 * （星级 type=10 只在"新条目"分支里读），所以改星级的唯一办法是：
 * 给这张卡换一个新序号发一次新条目，再把旧序号那条以 count=0 发下去让客户端删掉
 * （updateNotifyCards 里 `if(defCard.CardCount == 0) arrDefCards.splice(...)`）。
 */
let pendingCardNotify = null;

/* ------------------------------------------------------------------ *
 * 玩家公共信息（14675 a_292 → a_2751），服务端主动推
 *
 * 客户端从来不请求这条（搜遍反编译找不到发送点），它由服务器推送，
 * 收到后 a_2439.PlayerCommon = 该对象。合成屋"强化卡片"页要用
 * `GetPlayerCommon().m_stVIP.getVipLevel()` 算 VIP 加成，
 * m_stVIP 为空时那里会抛异常 → 整段成功率计算中断 → 界面永远显示 0%。
 * ------------------------------------------------------------------ */
const RICH_MONEY = 999_999_999;

export function buildPlayerCommonBody() {
  return Buffer.concat([
    int16(0), // m_nResultID
    int32(ROLE_UIN), // m_iUin
    int32(1), // m_iFlag = a_1731.a_338 → 只带货币那一段
    int32(Math.max(0, Math.floor(getWallet().points))), // m_iMoney = 点券（enmDianJuan）
    // m_lHappyBean = 金币（enmJinBi）：合成屋顶部那栏、强化/制作费用检查都读它
    encodeUint64(Math.max(0, Math.floor(getWallet().gold))),
    int32(0), // m_iCharming
    int32(0), // m_iLottery
    int32(0), // m_iLastOfflineCharming
    int32(0), // m_iTotalCharm
    int32(0), // m_iCharmCoin
    int32(0), // m_stVIP.m_iGameVIPScore（0 → VIP 0 级，VIPRate lv=0 = 1.0）
    int32(0), // m_iWarriorProgress
    int32(0), // m_iTotalMoneyConsume
    int32(0), // m_iWishingTalisman
    int32(0), // m_iDataReversed
    Buffer.from([0]), // m_iDuanweiLevel
    Buffer.from([0]), // m_iDuanweiQualityLevel
  ]);
}

function buildPlayerCommonPacket(sessionKey) {
  return buildPacket({
    messageId: 14675,
    version: 3,
    uin: PLAYER_UIN,
    playerId: PLAYER_UIN,
    flag: 4,
    payload: xteaEncrypt(
      padPlaintext(Buffer.concat([int32(0), buildPlayerCommonBody()])),
      sessionKey,
      32,
    ),
  });
}

/* ------------------------------------------------------------------ *
 * 强化卡片（14850 a_324 → SCResponseUpgrade）
 *
 * 请求 a_2862：[seq][srcUin][主卡 id,seq][position][强化用卡数 + id,seq×]
 *              [辅助材料数 + id,seq×][disableConsortiaExtra]
 * 应答：result + 新等级(int8) + srcUin + 主卡(id,seq) + position +
 *       被消耗的强化卡 + 辅助材料 + disable
 * 客户端把 m_cLevel 写进主卡 TypeValue（也就是卡面上的星级/等级）。
 * ------------------------------------------------------------------ */
function parseUpgradeRequest(request) {
  let pos = 4;
  const i16 = () => {
    const v = request.readInt16BE(pos);
    pos += 2;
    return v;
  };
  const i32 = () => {
    const v = request.readInt32BE(pos);
    pos += 4;
    return v;
  };
  const pair = () => ({ id: i32(), seq: i32() });
  const srcUin = i32();
  const srcCard = pair();
  const position = i32();
  const subs = Array.from({ length: i16() }, pair);
  const assistants = Array.from({ length: i16() }, pair);
  // 这一栏名字叫 disableConsortiaExtra，实际装的是"是否勾选保险金"
  // （客户端 a_2393(..., insuranse) 第五个参数原样塞进来）
  const insurance = i16();
  return { srcUin, srcCard, position, subs, assistants, insurance };
}

const UPGRADE_MAX_LEVEL = 15; // compose.xml <Upgrade><Level lv="0..15">
/** 调试用：REA_FORCE_UPGRADE=success|fail 可跳过随机判定（自测脚本用它保证可复现）。 */
const FORCE_UPGRADE = process.env.REA_FORCE_UPGRADE ?? "";

/* ------------------------------------------------------------------ *
 * 强化成功率表（compose.xml）
 *   <Upgrade><Level lv="主卡等级"><Group id="分组"><Rate lv="材料等级" value="成功率"/>
 *   <Groups><Group id="分组"><Item id="卡ID"/>…
 * 与客户端 UpgradeCardPane.getUpgradeRate / ComposeConfig 的查表方式一致。
 * ------------------------------------------------------------------ */
let upgradeRateCache = null;

function upgradeRateTables() {
  if (upgradeRateCache !== null) return upgradeRateCache;
  const out = { levels: new Map(), cardGroup: new Map() };
  try {
    const xml = fs.readFileSync(path.join(CONFIG_DATA_DIR, "compose.xml"), "utf8");
    for (const m of xml.matchAll(/<Level\b[^>]*\blv="(\d+)"[^>]*>([\s\S]*?)<\/Level>/g)) {
      const groups = new Map();
      for (const g of m[2].matchAll(/<Group\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/Group>/g)) {
        const rates = new Map();
        for (const r of g[2].matchAll(/<Rate\b[^>]*\blv="(\d+)"[^>]*\bvalue="([^"]+)"/g)) {
          rates.set(Number(r[1]), Number.parseFloat(r[2]));
        }
        groups.set(Number(g[1]), rates);
      }
      out.levels.set(Number(m[1]), groups);
    }
    const gi = xml.indexOf("<Groups");
    const ge = xml.indexOf("</Groups>");
    if (gi >= 0 && ge > gi) {
      for (const g of xml.slice(gi, ge).matchAll(/<Group\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/Group>/g)) {
        for (const it of g[2].matchAll(/<Item\b[^>]*\bid="(0x[0-9a-fA-F]+)"/g)) {
          const id = Number.parseInt(it[1], 16);
          // 首匹配优先，不能末次覆盖：0x11190160 在 <Groups> 里出现两次
          //（offset 30438→Group 2，offset 40509→Group 0，而 Group 声明顺序是 1,2,0）。
          // 客户端 ComposeConfig.as:481-490 getCardLevel() 走 xmlList[0].parent()
          // = 首匹配 = Group 2；服务端若末次覆盖会拿到 Group 0，把该卡的成功率算低
          //（N=2: 88.0% vs 96.8%，N=15: 7.9% vs 8.9%）。
          if (!out.cardGroup.has(id)) out.cardGroup.set(id, Number(g[1]));
        }
      }
    }
  } catch (e) {
    console.log(`[upgrade] 读取成功率表失败：${e.message}`);
  }
  console.log(
    `[upgrade] 成功率表：Level ${out.levels.size} 档 / 可强化卡 ${out.cardGroup.size} 张`,
  );
  upgradeRateCache = out;
  return out;
}

function upgradeRate(mainLevel, subCardID, subLevel) {
  const tables = upgradeRateTables();
  const groups = tables.levels.get(mainLevel);
  if (groups === undefined) return 0;
  const groupID = tables.cardGroup.get(subCardID);
  if (groupID === undefined) return 0;
  const rates = groups.get(groupID);
  if (rates === undefined) return 0;
  return rates.get(subLevel) ?? 0;
}

/**
 * <Level ... insurance="N">：该等级强化失败时的保险金（点券）。
 *
 * ⚠ "查不到" ≠ "不需要保险金"。返回 0 会让 :1115 的 `if (cost > 0)` 为假 ⇒
 *   保险金**免费生效**，属"静默给出与事实相反的结果"。所以读不到配置时
 *   **不能**留个空 Map，必须用与原版数据一致的内置真值表兜底
 *   （范式同下面的 upgradeProtectLevel：读不到就用原版那个值）。
 *
 * 注意区分两种 0：
 *   - lv0 的 insurance **本来就是 0**，是合法的"该档不收费"；
 *   - 星级越界（既不在 XML 也不在兜底表里）才是真的"不该收费"。
 *   只有后者可以用最后一层 `?? 0`。
 */
const INSURANCE_FALLBACK = new Map(
  [0, 2, 5, 10, 25, 50, 200, 400, 1200, 5000, 15000, 25000, 35000, 45000, 55000, 75000].map(
    (v, lv) => [lv, v],
  ),
);
let upgradeInsuranceCache = null;
function upgradeInsurance(mainLevel) {
  if (upgradeInsuranceCache === null) {
    upgradeInsuranceCache = new Map(INSURANCE_FALLBACK);
    try {
      const xml = fs.readFileSync(path.join(CONFIG_DATA_DIR, "compose.xml"), "utf8");
      for (const m of xml.matchAll(/<Level\b[^>]*\blv="(\d+)"[^>]*\binsurance="(-?\d+)"/g)) {
        upgradeInsuranceCache.set(Number(m[1]), Number(m[2]));
      }
      // 也有 insurance 写在 lv 前面的写法，补一轮
      for (const m of xml.matchAll(/<Level\b[^>]*\binsurance="(-?\d+)"[^>]*\blv="(\d+)"/g)) {
        upgradeInsuranceCache.set(Number(m[2]), Number(m[1]));
      }
      // 注意：这里**不要**再用 size 判据做"XML 是否提供有效数据"的告警。
      // 兜底表在 :1018 已把 16 档全部装进 cache，XML 只是覆盖同名 key（Map.set 不增 size），
      // 所以 `cache.size === INSURANCE_FALLBACK.size` 在正常 XML 上恒为真 → 每次启动都误报。
      // 真正的"读不到配置"由下面 catch 分支负责告警，那里的判据才有区分力。
    } catch (e) {
      console.log(
        `[upgrade] 读取保险金失败：${e.message} —— **已启用内置兜底表**（${INSURANCE_FALLBACK.size} 档），` +
          `避免保险金被误判为免费`,
      );
    }
  }
  return upgradeInsuranceCache.get(mainLevel) ?? INSURANCE_FALLBACK.get(mainLevel) ?? 0;
}

/**
 * compose.xml char 322942: <ProtectLevel value="5" />
 * ComposeConfig.as:53-60 getProtectLevel() → configData..ProtectLevel[0].@value
 * 主卡星级 ≤ 该值时强化失败不掉星。
 */
let upgradeProtectLevelCache = null;
function upgradeProtectLevel() {
  if (upgradeProtectLevelCache === null) {
    upgradeProtectLevelCache = 5; // 原版数据即 5，读不到时用同一默认值
    try {
      const xml = fs.readFileSync(path.join(CONFIG_DATA_DIR, "compose.xml"), "utf8");
      const m = xml.match(/<ProtectLevel\b[^>]*\bvalue="(-?\d+)"/);
      if (m) upgradeProtectLevelCache = Number(m[1]);
    } catch (e) {
      console.log(`[upgrade] 读取 ProtectLevel 失败，用默认 5：${e.message}`);
    }
  }
  return upgradeProtectLevelCache;
}

/**
 * 内存钱包：点券付保险金会真的扣（下一次推送玩家信息时界面就能看到）。
 * 用惰性初始化，避免和 RICH_MONEY 的 const 初始化顺序打架。
 */
let wallet = null;
function getWallet() {
  if (wallet === null) wallet = { points: RICH_MONEY, gold: RICH_MONEY };
  return wallet;
}

function buildUpgradeBody(request) {
  const q = parseUpgradeRequest(request);
  const state = loadCardState();
  // ★ 只按 (id, seq) 双匹配找主卡，**不允许 id-only 回退**。
  //   原先这里有一行 `if (target === undefined) target = state.cards.find((c) => c.id === q.srcCard.id);`
  //   是错的：客户端发来过期的 seq（卡片表不同步时会发生）时，它会命中**另一张
  //   同 id 的实例**，把那张卡升了级、回包里带着**那张卡的 seq**；客户端拿这个 seq
  //   去 _defCardData 里找 → 找不到 → 直接抛未捕获异常：
  //     ComposeData.as:301-305 getCardAttr(_defCardData, m_iID, m_iSequence)
  //       找不到 → throw new Error("出错了，没有找到对应的主卡！")
  //     ComposeData.as:549     要求 CardID == CardID && CardSeq == CardSeq 双匹配
  //   后果是"材料被吃掉、主卡没升、界面报错"。找不到就老实走失败路径。
  const target = state.cards.find((c) => c.id === q.srcCard.id && c.seq === q.srcCard.seq);
  const mainLevel = target?.grade ?? 0;

  // 找不到主卡 → 直接短路返回失败，**不碰任何卡、不吃材料**。
  // 必须放在下面材料消耗(:1131)之前。结果码回**非 0**（不是 0）：因为客户端
  // 回 0/1065 都会去查主卡表并 throw，详见返回处那段注释。
  if (target === undefined) {
    pendingCardNotify = null; // 明确"无卡变化"，别通知
    console.log(
      `[upgrade] 找不到主卡：请求 id=${q.srcCard.id.toString(16)} seq=${q.srcCard.seq} ` +
        `（卡片表 ${state.cards.length} 张，同 id 的有 ` +
        `${state.cards.filter((c) => c.id === q.srcCard.id).length} 张）→ 拒绝，未消耗材料`,
    );
    return Buffer.concat([
      // ★ m_nResult 必须**非 0**（用 1），这条拒绝路径和成功/失败路径的规则不同：
      //   TDComposeUI.as:1403 `if(m_nResult == 0 || m_nResult == 1065)` 两支都会在
      //   :1412 调 ComposeData.updateDataByUpgradeCard(response)，而那里
      //   ComposeData.as:301-305 拿 m_stNewCardInfo 的 (m_iID, m_iSequence) 去
      //   _defCardData 里找卡，找不到就 `throw new Error("出错了，没有找到对应的主卡！")`。
      //   本路径**恰恰就是"客户端给的 seq 在服务端表里不存在"**，所以只要回了 0/1065，
      //   客户端必定走到那个 throw —— 等于把"升错卡"换成"界面抛异常"，没修好。
      //   回非 0 ⇒ 走 :1478 的 else 分支 ⇒ 只 `tip = response.m_szReasonMessage`，
      //   **完全不碰卡片数据**，这才是安全的拒绝。
      //
      //   注意与既有定案的边界：**成功路径**仍回 0（:1388 的 int16(0) 不动）；
      //   **失败(掉星)路径**已改为回 1065 —— 依据是 TDComposeUI.as:1473 只有 1065 才用
      //   m_szReasonMessage 覆盖成功文案，而全局卡片表的星级**并非只靠**
      //   ComposeServerDataProtocol.as:258 那条路：a_2439.as:865-894 的新条目分支在
      //   `m_cAttrType == 10` 时同样写 TypeValue，失败路径推送的
      //   {newSeq,count:1,grade} notify 已覆盖它。详见 buildUpgradeBody 失败分支处的长注释。
      //   （此处曾写着"成功/失败(掉星)路径仍必须回 0"，那是**已被推翻的旧结论**，勿改回去。）
      //   两条规则不冲突 —— 前者有主卡，本路径没有主卡。
      int16(1), // m_nResult != 0/1065 → 客户端只显示提示、不动数据
      Buffer.from([0]), // m_cLevel：无变化
      int32(q.srcUin),
      int32(q.srcCard.id),
      // 这个 seq 原样回显。回什么其实都无所谓了 —— 回非 0 后客户端不会拿它去查表
      // （见 :1478 else 分支），但保持回显比编造一个值更诚实、也便于抓包比对。
      int32(q.srcCard.seq),
      int32(q.position),
      int16(0), // m_nSubCount：空表 ⇒ 客户端不删任何卡
      int16(0), // m_nAssMaterialCount
      int16(0), // m_nDisableConsortiaExtra
      // ★ 回非 0 ⇒ SCResponseUpgrade.as:74 `if(this.m_nResult != 0)` 成立 ⇒ 客户端**会**
      //   读尾串，且 TDComposeUI.as:1480 会把它当 tip 显示。所以这里**必须**追加
      //   encode_string，否则客户端读到的是空/错位数据。
      //   （成功路径恒回 0，故**不能**带尾串；失败路径回 1065，**必须**带尾串。
      //     三者的判据都是 SCResponseUpgrade.as:74 的 `m_nResult != 0`。）
      encodeString("没有找到要强化的主卡，请重新打开合成界面", 4096),
    ]);
  }

  // 成功率：与客户端 UpgradeCardPane.getUpgradeRate 同一套算法
  //   取最高的那张强化用卡为主，其余按 1/3 累加；四叶草做倍数；上限 100%
  const rates = [];
  for (const sub of q.subs) {
    const card = state.cards.find((c) => c.id === sub.id && c.seq === sub.seq);
    const r = upgradeRate(mainLevel, sub.id, card?.grade ?? 0);
    if (r > 0) rates.push(r);
  }
  let rate = 0;
  if (rates.length > 0) {
    rates.sort((a, b) => a - b);
    rate = rates.pop();
    for (const r of rates) rate += r / 3;
  }
  const { rate: clovers, protect } = composeAssistants();
  for (const ass of q.assistants) {
    const clover = clovers.get(ass.id);
    if (clover !== undefined) rate *= clover.value;
  }
  if (rate > 1) rate = 1;

  // ── 保险金 / 护佑符 语义（全部有源码证据，勿凭字段名想当然） ──
  //
  // 极性：勾选保险金 ⇒ 请求里 m_nDisableConsortiaExtra = 1。
  //   UpgradeCardPane.as:848  useBaoXianJin = (mcBaoXianJin.currentFrame - 1) % 2
  //   UpgradeCardPane.as:62   初始 gotoAndStop("unselected")；:71 点击切 "selected"
  //   UpgradeCardPane.as:775  protectCheck 用 currentFrame == 1 判"未勾选"
  //     ⇒ 帧1=未勾选(useBao=0)、帧2=已勾选(useBao=1)
  //   UpgradeCardPane.as:897  只有"已勾选"才校验保险金够不够付 → 与上面一致
  //   UpgradeCardPane.as:865  以 "insuranse" 键下发 → ComposeServerDataProtocol.as:83-105
  //                           第 5 参 iDisableConsortiaExtra 原样写进请求
  // 所以：insured = (q.insurance === 1)，即"玩家勾了保险金"。
  //
  // 效果：
  //   * 保险金花点券（UpgradeCardPane.as:887-889 取 UpgradeLevel@insurance 并按折扣算）。
  //   * 失败时是否退还强化用卡，看的是**服务端回包**里的 m_nDisableConsortiaExtra：
  //       TDComposeUI.as:1458   m_nResult != 0 && m_nDisableConsortiaExtra == 1 → 把卡放回格子
  //       ComposeData.as:311    m_nResult == 0 || m_nDisableConsortiaExtra != 1 → delDefCardAttr 删卡
  //     两个条件互补，共同表示"回 1 = 材料退还，回 0 = 材料真消耗"。
  //     因此失败回包必须回 0（材料消耗）；只有护佑符这一类"保材料"道具才回 1。
  //     ⚠ 注意：请求里的 1（勾了保险）与回包里的 1（材料退还）不是同一件事，
  //       绝不能把请求值直接回显到回包里。
  //
  //   * 掉星：由 ProtectLevel 决定，与保险金是否勾选是**两件独立的事**。
  //       compose.xml char 322942: <ProtectLevel value="5" />
  //       ComposeConfig.as:53-60   getProtectLevel() 读的就是这个 5
  //       UpgradeCardPane.as:770-780 protectCheck()：
  //         mainCardLevel > protectedLevel && rate < Min_Security_Rate(0.2) && 未勾选保险
  //         → 强制提示"请买保险金"（string 65611）
  //     "保护等级 5" 这个概念只在一个会掉星的系统里才有意义 ⇒ 原版失败会掉星，
  //     但主卡 ≤ ProtectLevel(5) 星时受保护、不掉星。
  //
  //   历史教训：本文件此前的实现把 "shielded" 同时用于"保材料"和"保星级"，
  //   又把请求里的 insurance 回显进回包，导致失败时不发材料消耗、且永不掉星，
  //   与客户端全部三处判据都不一致。
  const insured = q.insurance === 1; // 玩家勾选了保险金
  // 护佑符/神佑符：只保"强化用卡不被消耗"，与星级无关
  // （protectCheck 只看 mcBaoXianJin，完全没碰护佑符）。
  const subProtected = q.assistants.some((ass) => protect.has(ass.id));
  if (insured) {
    const cost = upgradeInsurance(mainLevel);
    if (cost > 0) {
      const w = getWallet();
      w.points = Math.max(0, w.points - cost);
      console.log(`[upgrade] 保险金 -${cost} 点券（剩 ${w.points}）`);
    }
  }
  const success =
    FORCE_UPGRADE === "success"
      ? true
      : FORCE_UPGRADE === "fail"
        ? false
        : rate > 0 && (rate >= 1 || Math.random() < rate);

  // 强化用卡被吃掉（护佑符生效时保住；保险金不保材料）
  const consumedSubs = [];
  if (!subProtected) {
    const consumed = new Set(q.subs.map((c) => `${c.id}:${c.seq}`));
    state.cards = state.cards.filter((c) => !consumed.has(`${c.id}:${c.seq}`));
    for (const c of q.subs) consumedSubs.push({ id: c.id, seq: c.seq, count: 0 });
  }

  // ── 失败掉星 ──
  // 星级完全由服务端 m_cLevel 决定，客户端没有任何本地降级逻辑：
  //   ComposeData.as:306  mainCardAttr.TypeValue = response.m_cLevel;
  // 所以"掉不掉星"必须在这里决定。
  //
  // 【确认】掉星确实存在，且有直接文案证据（不是靠机制反推）：
  //   UpgradeCardPane.as:770-780 protectCheck() 在
  //     mainCardLevel > ProtectLevel(5) && rate < Min_Security_Rate(0.2) && 未勾选保险金
  //   时返回 gsManager.getString(65611)。
  //   zh_CN.xml offset 15208: <content id="0x01004b">您的强化概率低于&variable&%,失败后主卡会被降级</content>
  //   65611 == 0x1004b，文案明确写着"失败后主卡会被降级"。
  //   同一判据在 UpgradeGemPane.as:788-799 也有（宝石版），只是没有保险金条件。
  const PROTECT_LEVEL = upgradeProtectLevel(); // compose.xml char 3: <ProtectLevel value="5"/>
  const MIN_SECURITY_RATE = 0.2; // UpgradeCardPane.as:47 private const Min_Security_Rate:Number = 0.2
  // 【推断】触发门槛与 protectCheck 完全一致 —— protectCheck 是用来"预告后果"的，
  // 它报警的条件必然就是真正会掉星的条件，否则提示就成了误导。
  // 唯一不确定处：文案把 rate 说成"低于20%"，protectCheck 用的是 >=，即 rate==0.2
  // 不报警也不掉星；此处沿用同一比较，保持一致。
  const dropStar = !success && !insured && mainLevel > PROTECT_LEVEL && rate < MIN_SECURITY_RATE;
  const level = success
    ? Math.min(UPGRADE_MAX_LEVEL, mainLevel + 1)
    : dropStar
      ? Math.max(0, mainLevel - 1)
      : mainLevel;
  const notify = [...consumedSubs];
  if (target !== undefined) {
    const oldSeq = target.seq;
    target.grade = level;
    if (dropStar) {
      // 掉星：必须换新序号 + 删旧条目。
      // 依据 a_2439.as:844-864（已存在的卡只更新 CardCount/CardSeq 等，
      // **不碰 TypeValue**）与 :865-894（只有"新条目"分支才读
      // `if(attr.m_cAttrType == 10) defCard.TypeValue = attr.m_iAttrAdd;`）。
      // 所以想改星级的唯一办法就是换 seq 发新条目。
      //
      // 而回包里的 m_stNewCardInfo.m_iSequence 必须回客户端**此刻持有的旧 seq**，
      // 否则 ComposeData.as:301-305 的 getCardAttr 找不到卡会 throw
      // "出错了，没有找到对应的主卡！"（:549 要求 CardID && CardSeq 同时匹配）。
      // 见 buildUpgradeBody 里写的 int32(q.srcCard.seq)。
      state.nextSeq += 1;
      target.seq = state.nextSeq;
      notify.push({ id: target.id, seq: oldSeq, count: 0 });
      notify.push({
        id: target.id,
        seq: target.seq,
        count: 1,
        grade: level,
        expire: target.expire ?? -1,
      });
    } else if (success) {
      notify.push({
        id: target.id,
        seq: target.seq,
        count: 1,
        grade: level,
        expire: target.expire ?? -1,
      });
    }
  }
  pendingCardNotify = notify.length > 0 ? notify : null;
  saveCardState();
  console.log(
    `[upgrade] ${q.srcCard.id.toString(16)} seq=${q.srcCard.seq} 成功率=${(rate * 100).toFixed(1)}% ` +
      `→ ${success ? "成功" : "失败"}${insured ? "（保险金生效，不掉星）" : ""}${
        subProtected ? "（护佑符，材料保住）" : ""
      } ${mainLevel} → ${level} 级`,
  );

  if (!success) {
    // SCResponseUpgrade.decode (SCResponseUpgrade.as:47-79) 的字段是**固定布局**，
    // 无论成功失败都必须逐字段写完，顺序为：
    //   m_nResult(i16) m_cLevel(i8) m_iSrcUin(i32) m_stNewCardInfo{id,seq}(i32,i32)
    //   m_iPosition(i32) m_nSubCount(i16)+m_arrSub m_nAssMaterialCount(i16)+m_arrAssMaterial
    //
    //   m_szReasonMessage 是**条件字段**：SCResponseUpgrade.as:73-77 先解
    //   m_nDisableConsortiaExtra，再 `if(this.m_nResult != 0) m_szReasonMessage =
    //   a_2664.decode_string(byte_array, 4096);`。
    //   ★ 本实现回 1065（非 0），所以**必须**在末尾 append 这个字符串（见下方）。
    //
    //   ★★★ m_nResult 必须回 1065。以下是**推翻旧结论**的订正，请勿改回 0。★★★
    //
    //   【旧结论（已作废，错误）】这里曾写着："回 1065 → ComposeServerDataProtocol.as:258
    //   的 `if(m_nResult == 0)` 门失守 → a_2439 的全局卡片表永远不更新星级，所以只能回 0"。
    //   该断言把 ComposeServerDataProtocol.as:263（`cardAttr.TypeValue = response.m_cLevel`）
    //   当成了刷新全局表星级的**唯一**路径。**这是错的** —— 全局表还有第二条路径，
    //   而且失败路径本来就一直在用它：
    //
    //     a_4763\a_2439.as updateNotifyCards（14620 notify 的处理端）：
    //       :815  ID = CardID + "-" + CardSeq;        ← **复合键**
    //             （a_3228.as:79-81 `get ID()` 同为 CardID + "-" + CardSeq）
    //             故下面推的两条 notify 各占一个键，**不互相覆盖**
    //       :846  notifyDef = dictDefNotify[defCard.ID];
    //       :856-860  if(defCard.CardCount == 0) { splice 删除 }
    //       :861  delete dictDefNotify[defCard.ID];
    //       :865-894  **新条目分支**（旧 seq 已删、新 seq 匹配不到已存在卡 ⇒ 走这里）
    //       :879-883  if(attr.m_cAttrType == 10) { defCard.Type = attr.m_cAttrType;
    //                                              defCard.TypeValue = attr.m_iAttrAdd; }
    //                 ← ★ **这里写星级**
    //       :895  a_1825.e.onNotifyDefCardsChange(arrDefCards);
    //
    //   而下面的 pendingCardNotify 正是按这个契约推两条：`{oldSeq, count:0}`（删旧条目）
    //   + `{newSeq, count:1, grade:level}`（新条目带新星）。
    //   ⇒ **全局卡片表的星级由 14620 notify 刷新，与 ComposeServerDataProtocol.as:258
    //     的 `== 0` 门无关。回 1065 不会让全局卡片表失守。**
    //
    //   【为什么必须回 1065】用户报"升星失败它提示成功"，根因全在客户端 UI 层：
    //     TDComposeUI.as:1403  `if(response.m_nResult == 0 || response.m_nResult == 1065)`
    //                          → 两者进**同一**分支
    //     TDComposeUI.as:1412  updateDataByUpgradeCard(response)   ← 数据确实会刷新
    //     TDComposeUI.as:1413  tip = getString(65596)             ← **成功文案**
    //     TDComposeUI.as:1473  `if(response.m_nResult == 1065) tip = response.m_szReasonMessage;`
    //                          ← **唯一**覆盖处
    //     TDComposeUI.as:1480  else 分支（其它非 0 值）：tip = m_szReasonMessage，
    //                          但**完全不动卡片数据**（不调 updateDataByUpgradeCard）
    //   ⇒ 要既刷新数据又显示失败文案，**唯一**取值就是 1065。回 0 必弹成功文案；
    //     回其它非 0 值则不刷新数据。1065 是唯一交集。
    //
    //   m_nDisableConsortiaExtra：恒回 0。
    //   ⚠ 回 1065 后 TDComposeUI.as:1458 `if(m_nResult != 0 && m_nDisableConsortiaExtra == 1)`
    //   的左半**已经成立**，所以这个字段一旦回 1，客户端就会把强化用卡放回格子。
    //   因此"护佑符保住材料"**不能**靠这个字段，必须靠 m_arrSub 回**空表**：
    //   ComposeData.as:311 `if(m_nResult == 0 || m_nDisableConsortiaExtra != 1)`
    //   → 回 0 时成立 / **回 1065 时因后半 `m_nDisableConsortiaExtra != 1`（即 0 != 1）也为真**
    //   → :313 `delDefCardAttr(_defCardData, m_arrSub)`；空表 → 一张都不删 → 材料保住。
    //   ⇒ 回 1065 **不会**误保材料：材料照删，语义与回 0 时完全一致。
    //   见下面 subProtected 分支的 int16(0)。
    return Buffer.concat([
      // ★ m_nResult = 1065（**不是 0**）。理由见上方"推翻旧结论"段：
      //   1065 是客户端唯一会显示失败文案的取值，且不会让全局卡片表失守。
      int16(1065),
      Buffer.from([level & 0xff]), // m_cLevel：由上面的掉星规则决定，可能升/平/降
      int32(q.srcUin),
      int32(q.srcCard.id), // m_stNewCardInfo.m_iID
      // ★ 这里必须是**客户端此刻持有的旧 seq**（q.srcCard.seq 就是 target.seq 换序号
      //   之前的那个值），不能填掉星后新生成的 target.seq。
      //   ComposeData.as:301-305 用 (m_iID, m_iSequence) 调 getCardAttr 定位主卡，
      //   而 :549 要求 `CardID && CardSeq` 同时匹配，找不到就 :304 throw
      //   "出错了，没有找到对应的主卡！"。客户端手里那张卡的 seq 还是旧的，
      //   所以回包必须回旧 seq 才不崩。
      //   ⚠ 这与下面 pendingCardNotify 里用的**新 seq** 故意不一致，各服务于一个目的：
      //     回包用旧 seq → 定位 pane 上的卡不抛异常；
      //     notify 用新 seq → a_2439.updateNotifyCards 只有"新条目"分支
      //                      (:865-894) 才读 m_cAttrType==10 写 TypeValue，从而刷新星级。
      //   下一个人很容易"顺手改成一致"从而踩崩，勿动。
      int32(q.srcCard.seq),
      int32(q.position),
      // 这里以前漏掉了 m_stNewCardInfo，导致后面所有字段整体前移 8 字节 ——
      // 客户端读到的 position / 材料数全是错位数据，格子清不干净。现已补齐。
      // 护佑符生效 → 回空表，客户端据此不删任何强化用卡；否则回真实 sub 表。
      int16(subProtected ? 0 : q.subs.length),
      ...(subProtected ? [] : pairBytes(q.subs)),
      int16(q.assistants.length),
      ...pairBytes(q.assistants),
      // 恒回 0：材料已真消耗。
      //
      // ⚠ "护佑符保住材料"**不是**靠这个字段，而是靠上面 m_arrSub 回空表：
      //   ComposeData.as:311 `if(m_nResult == 0 || m_nDisableConsortiaExtra != 1)`
      //   → :313 `delDefCardAttr(_defCardData, m_arrSub)`；空表 → 一张都不删 → 材料保住。
      //   ⚠ 回 1065 后 TDComposeUI.as:1458 `if(m_nResult != 0 && m_nDisableConsortiaExtra == 1)`
      //   的左半**已经成立**，所以本字段必须保持 0，否则客户端会把强化用卡放回格子。
      int16(0),
      // ★ m_szReasonMessage：SCResponseUpgrade.as:74 `if(this.m_nResult != 0)` 才读，
      //   所以回 1065 时必须带上。它经 TDComposeUI.as:1473
      //   `if(response.m_nResult == 1065) tip = response.m_szReasonMessage;`
      //   覆盖 :1413 的 getString(65596) 成功文案 —— 即用户报的"升星失败提示成功"修复点。
      //   措辞区分三种情形，且**必须非空**（空串会让客户端提示为空白）。
      encodeString(
        dropStar
          ? "强化失败，主卡已降级"
          : subProtected
            ? "强化失败（护佑符生效，材料已保住）"
            : "强化失败",
        4096,
      ),
    ]);
  }

  return Buffer.concat([
    int16(0), // m_nResult：成功
    Buffer.from([level & 0xff]), // m_cLevel：新等级 → 客户端写进 TypeValue
    int32(q.srcUin),
    int32(q.srcCard.id), // m_stNewCardInfo.m_iID
    int32(q.srcCard.seq), // m_stNewCardInfo.m_iSequence
    int32(q.position),
    int16(q.subs.length),
    ...pairBytes(q.subs),
    int16(q.assistants.length),
    ...pairBytes(q.assistants),
    // m_nDisableConsortiaExtra 必须回 0，表示"材料已被消耗"。
    // 回 1 会让 ComposeData.as:311 跳过 delDefCardAttr，强化用卡不会从背包消失。
    int16(0),
  ]);
}
/** 充值活动：uin + 8 个 int32 + 单笔领取数量 */
const rechargeActivityEmpty = () =>
  Buffer.concat([int16(0), int32(PLAYER_UIN), ...Array.from({ length: 8 }, () => int32(0))]);
/** 婚姻信息：uin + 7 个 int32 + 伴侣名 */
const marriageEmpty = () =>
  Buffer.concat([int16(0), int32(PLAYER_UIN), ...Array.from({ length: 7 }, () => int32(0)), encodeString("", 2048)]);
/** 通用：resultID + uin + 一个计数(0)，覆盖大量"取列表"类应答 */
const listEmpty = () => Buffer.concat([int16(0), int32(ROLE_UIN), int16(0)]);

// —— 第二批：大厅其余子系统 ——
/** a_2945：逻辑服登录 resultID + playerID + 版本 + 房间会话数 */
const logicLoginEmpty = () =>
  Buffer.concat([int16(0), int32(ROLE_UIN), int16(0), int16(0)]);
/** a_3000 + a_3001：存档任务（长度 + 5 个 int32 全 0） */
const saveTaskEmpty = () =>
  Buffer.concat([
    int16(0),
    int32(PLAYER_UIN),
    int16(20),
    ...Array.from({ length: 5 }, () => int32(0)),
  ]);
/** CResponseGetCrystoneSlot：resultID + uin + int8 条目数(0) */
const crystoneSlotEmpty = () =>
  Buffer.concat([int16(0), int32(PLAYER_UIN), Buffer.from([0])]);
/** CResponseGetProtectorInfo：resultID + uin + 3 个 int32 */
const protectorEmpty = () =>
  Buffer.concat([int16(0), int32(PLAYER_UIN), int32(0), int32(0), int32(0)]);
/** CResponseHasSecpwd：resultID + uin + int32(0) */
const hasSecpwdEmpty = () =>
  Buffer.concat([int16(0), int32(PLAYER_UIN), int32(0)]);
/** CResponseOngoingWeddingCount：resultID + uin + int8 场次(0) */
const weddingCountEmpty = () =>
  Buffer.concat([int16(0), int32(PLAYER_UIN), Buffer.from([0])]);
/** CResponseCheckNewServerTask：resultID + uin + 检查时间 + 加成 + int8 状态 */
const checkNewSvrTaskEmpty = () =>
  Buffer.concat([int16(0), int32(PLAYER_UIN), int32(0), int32(0), Buffer.from([0])]);
/** CResponseNewSvrGiftLogin：resultID + uin + 登录次数 + 领取标记 */
const newSvrGiftLoginEmpty = () =>
  Buffer.concat([int16(0), int32(PLAYER_UIN), int32(0), int32(0)]);
/**
 * 任务类应答一律回"失败"。
 *
 * 原因：本地服务端没有任务状态，若把"领奖"(14723) 回成成功，客户端会真的发一张
 * 卡并弹"获得新的卡片"，随后继续检查下一个任务 —— 实测会无限循环。
 * 回失败则客户端中止该任务流程，界面保持"任务未完成"，不会刷屏。
 */
const taskFailure = (request) => {
  const taskId = request.length >= 12 ? request.readInt32BE(8) : 0;
  return Buffer.concat([
    int16(1), // resultID != 0 -> 失败
    int32(PLAYER_UIN),
    int32(taskId),
    encodeString("", 2048), // 失败原因
  ]);
};
/** a_2998 多一个 int8 类型字段 */
const taskFailureWithType = (request) => {
  const taskId = request.length >= 12 ? request.readInt32BE(8) : 0;
  return Buffer.concat([
    int16(1),
    int32(PLAYER_UIN),
    int32(taskId),
    Buffer.from([0]),
    encodeString("", 2048),
  ]);
};

/**
 * 14882 TASK_ACCOMPLISH → a_2997：resultID + uin + taskID。
 *
 * 必须回"成功"，而且必须回显请求里的 taskID。
 * 客户端 AchievementsHandel.a_4486() 会遍历所有"条件已满足"的成就逐个上报，
 * 上报完把成就标记成已完成；我们要是回失败，本地状态不变，下个 tick 又重发
 * 同一个 —— 实测死循环（一次会话刷了 60+ 条），界面直接卡在登录/加载界面。
 * 注意 dec.data 前面还有 4 字节 sequence：uin 在 4，taskID 在 8。
 */
const taskAccomplished = (request) => {
  const uin = request.length >= 8 ? request.readInt32BE(4) : PLAYER_UIN;
  const taskId = request.length >= 12 ? request.readInt32BE(8) : 0;
  return Buffer.concat([int16(0), int32(uin), int32(taskId)]);
};

// —— 第三批：活动 / 商店 / 邮件 / 公会等子系统 ——
// 这些报文只在玩家打开对应界面时才发出，字段顺序严格按各应答类的 decode()
// （decode 从"去掉前置 sequence"之后开始读，与 handlePacket 的封包方式对应）。
/** CReponseGetPetAccount：resultID + uin + 槽位数/免费挑战/购买数/已挑战/当前高度（5 个 int32）。 */
const petAccountEmpty = () =>
  Buffer.concat([int16(0), int32(PLAYER_UIN), ...Array.from({ length: 5 }, () => int32(0))]);
/** CResponseChoujiangInfo：注意 decode 顺序为 uin → result，随后 7 个 int32。 */
const choujiangInfoEmpty = () =>
  Buffer.concat([int32(PLAYER_UIN), int16(0), ...Array.from({ length: 7 }, () => int32(0))]);
/** CResponseUpdatePlayerMailList：uin + groupID + resultID + 未读数。 */
const mailListUpdateEmpty = () =>
  Buffer.concat([int32(PLAYER_UIN), int32(0), int32(0), int32(0)]);
/** CResponseGetNewConsortiaTaskList：resultID + uin + type + flag + int32 任务数(0)。 */
const consortiaTaskListEmpty = () =>
  Buffer.concat([int16(0), int32(PLAYER_UIN), int32(0), int32(0), int32(0)]);
/** CResponseGetHolidayExchangeInfo：resultID + uin + int16 条目数(0)。 */
const holidayExchangeInfoEmpty = () =>
  Buffer.concat([int16(0), int32(PLAYER_UIN), int16(0)]);
/** CResponseGetMonthCardInfo：resultID + uin + 3 个 int32。 */
const monthCardInfoEmpty = () =>
  Buffer.concat([int16(0), int32(PLAYER_UIN), int32(0), int32(0), int32(0)]);
/** CResponseOnePieceInfo（抽奖信息）：resultID + uin + 5 个 int32。 */
const onepieceInfoEmpty = () =>
  Buffer.concat([int16(0), int32(PLAYER_UIN), ...Array.from({ length: 5 }, () => int32(0))]);
/** CResponseMonthCardShopInfo：resultID + uin + int16 条目数(0)。 */
const monthCardShopInfoEmpty = () =>
  Buffer.concat([int16(0), int32(PLAYER_UIN), int16(0)]);
/** CResponseDailyPayInfo：resultID + uin + 3 个 int32。 */
const dailyPayInfoEmpty = () =>
  Buffer.concat([int16(0), int32(PLAYER_UIN), int32(0), int32(0), int32(0)]);
/** CResponseGetSpecialActivityInfo：空活动 —— 各计数为 0，无任务/奖励/票券条目。 */
const specialActivityInfoEmpty = () =>
  Buffer.concat([
    int16(0), // resultID
    int32(PLAYER_UIN),
    Buffer.from([0]), // m_cCheckInCount int8
    Buffer.from([0]), // m_cHasCheckIn int8
    int32(0), // m_iTaskCount uint32，0 -> 无 SimpleTask
    int16(0), // m_nCakeTicket
    Buffer.from([0]), // m_cCakeFlag int8
    int32(0), // m_iAwardCount uint32，0 -> 无奖励
    Buffer.from([0]), // m_cMailFlag int8
    Buffer.from([0]), // m_cTaskAwardFlag int8
    int32(0), // m_iAccCharge
  ]);
/**
 * 公会加入信息（a_2798）与房间人数（a_2941）都带嵌套结构，构造"成功但空"风险较高，
 * 统一回 resultID != 0 + 空原因字符串：客户端会走失败分支直接中止，不会误解析。
 */
const consortiaJoinInfoFail = () => Buffer.concat([int16(1), encodeString("", 4096)]);
/**
 * a_2941（取房间人数）成功应答：resultID + serverID + int16 房间数。
 * 注意 a_2666 的数组长度取"上一个标量"，房间数=0 时后面的对象数组就是空的，
 * 所以不需要写任何数组字节。之前回"失败"会让房间/桌列表渲染不出来。
 */
const roomPlayerCountInfo = (request) =>
  Buffer.concat([
    int16(0),
    int32(request.length >= 8 ? request.readInt32BE(4) : 0), // m_iServerID
    int16(0), // m_nRoomCount = 0（无房间）
  ]);
/** CCSResponseGetCharmInfo：resultID + uin + dstUin + int8 已婚 + 宣言串 + 伴侣 + int8。 */
const charmInfoEmpty = () =>
  Buffer.concat([
    int16(0),
    int32(PLAYER_UIN),
    int32(0), // m_iDstUin
    Buffer.from([0]), // m_iMarried
    encodeString("", 256), // m_szDeclaration
    int32(0), // m_iPartnerUin
    encodeString("", 32), // m_szPartnerName
    Buffer.from([0]), // m_cConsortiaBuy
  ]);

/* ------------------------------------------------------------------ *
 * 逻辑服：单机进战斗 —— SitDown(8705) → a_2953
 * 依据 b_177.a_2485（请求 a_2928）与 b_177 里 OnSitDown 的应答处理（应答 a_2953）。
 * "新手战斗/对电脑"模式会直接发 SitDown(roomID=-1)，由服务端分配房间；回 a_2953
 * 成功后客户端就会去加载战斗模块（TDGameCoreUI）。
 * ------------------------------------------------------------------ */

/** a_2664.encode_uint64：高 32 位在前，各按无符号大端。 */
function encodeUint64(value) {
  const n = Math.max(0, Math.floor(value));
  const b = Buffer.alloc(8);
  b.writeUInt32BE(Math.floor(n / 2 ** 32) >>> 0, 0);
  b.writeUInt32BE((n % 2 ** 32) >>> 0, 4);
  return b;
}

const STATUS_SEATED = 1;

/**
 * 最小房间状态：单机只有一名玩家。客户端"创建房间"实际是 SitDown(tableID=-1)，
 * 之后会重新拉桌列表(8464)；如果桌列表仍为空，界面看起来就是"创建不了房间"。
 * 这里记住坐下产生的这张桌，供 8464/8452 回显。
 */
const roomState = {
  seated: false,
  roomID: 0,
  tableID: 1,
  seat: 0,
  mapID: 0,
  gameMode: 2,
  level: 0,
  name: "",
};

/**
 * CPlayerDetail 的等价实现（含 2 字节长度前缀）。iconType=0 时不带 51/游戏头像相关
 * 字段（EnmFaceMask 掩码为 128/64），与客户端 encode() 完全对齐。
 */
function buildPlayerDetail(overrides = {}) {
  const p = {
    uin: ROLE_UIN,
    account: PLAYER_ACCOUNT,
    name: ROLE_NAME,
    flag: 0,
    identity: 0,
    birthday: 0,
    iconType: 0,
    zone: "",
    charming: 0,
    achievement: 0,
    happyBean: 0,
    exp: 0,
    vipScore: 0,
    lv: 0,
    vipLevel: 0,
    playerId: ROLE_UIN,
    tableId: 0,
    seat: 0,
    status: STATUS_SEATED,
    sitdownSeq: 1,
    point: 0,
    win: 0,
    lose: 0,
    draw: 0,
    escape: 0,
    offline: 0,
    money: 0,
    flower: 0,
    extraUid: "",
    goodId: 0,
    gameVipScore: 0,
    gameVipLevel: 0,
    ...overrides,
  };
  const parts = [
    int32(p.uin),
    encodeString(p.account, 32),
    encodeString(p.name, 32),
    int16(p.flag),
    int32(p.identity),
    int32(p.birthday),
    Buffer.from([p.iconType & 0xff]),
    encodeString(p.zone, 40),
    int32(p.charming),
    int32(p.achievement),
    int32(p.happyBean),
    int32(p.exp),
    int32(p.vipScore),
    int32(p.lv),
    int32(p.vipLevel),
    int32(p.playerId),
    int32(p.tableId),
  ];
  if (p.tableId >= 0) {
    parts.push(Buffer.from([p.seat & 0xff, p.status & 0xff]));
    if (p.status !== 0 && p.status !== 4) parts.push(int32(p.sitdownSeq));
  }
  parts.push(
    encodeUint64(p.point),
    int32(p.win),
    int32(p.lose),
    int32(p.draw),
    int32(p.escape),
    int32(p.offline),
    int32(p.money),
    int32(p.flower),
    encodeString(p.extraUid, 32),
    int32(p.goodId),
    int32(p.gameVipScore),
    int32(p.gameVipLevel),
  );
  const body = Buffer.concat(parts);
  return Buffer.concat([int16(body.length), body]);
}

/** 按 a_2928.encode 的字段顺序解析 SitDown 请求。 */
function parseSitDownRequest(req) {
  // 注意：handlePacket 传进来的是"整段解密数据"，前 4 字节是 sequence，字段从偏移 4 开始。
  let pos = 4;
  const i8 = () => req.readInt8(pos++);
  const i16 = () => {
    const v = req.readInt16BE(pos);
    pos += 2;
    return v;
  };
  const i32 = () => {
    const v = req.readInt32BE(pos);
    pos += 4;
    return v;
  };
  const str = () => {
    const n = req.readInt16BE(pos);
    pos += 2;
    const s = req.subarray(pos, pos + n);
    pos += n;
    return s.toString("utf8");
  };
  try {
    i8(); // m_byACT
    const roomID = i32(); // m_iRoomID
    const tableID = i32(); // m_iTableID
    const seatID = i8(); // m_bySeatID
    i8(); // m_byCanAdjust
    i8(); // m_iFcm
    str(); // m_szTableKey
    const tableName = str(); // m_szTableName
    const mapID = i32(); // m_iGameMapID
    const gameMode = i8(); // m_byGameMod
    const level = i8(); // m_bLevel
    i8(); // m_byPlayerCount
    const listCount = i16(); // m_nMapListCount
    const mapList = [];
    for (let i = 0; i < listCount; i += 1) mapList.push(i32());
    return { roomID, tableID, seatID, mapID, gameMode, level, mapList, tableName };
  } catch (e) {
    return { roomID: -1, tableID: -1, seatID: 0, mapID: 0, gameMode: 0, level: 0, mapList: [], tableName: "" };
  }
}

/**
 * a_2953 坐下成功应答。注意客户端 decode 比 encode 多读一个 m_iCrossID
 * （编码端漏写），服务端必须按 decode 布局补上，否则其后的地图/玩家字段全部错位。
 */
/**
 * ★★ 2026-10-16：把单机战斗"改道"到**合成地图**（`composite_map.xml` 里的 `0x50xxxxxx` 图）。
 *
 * 背景（本轮实测定位）：普通地图这条路在客户端是坏的 ——
 *   `TDGame2V2BattleUI.a_3607:477-481` 走 `m_stGameMapResource = m_arrGameMapArray[szMapIDStr]`
 *   之后立刻 `m_stGameMapResource.a_4176()`；而 `m_arrGameMapArray` 只在
 *   `a_3604:746` 由 `stContent.content as BaseGameMap` 赋值。
 *   现在 CDN 给的地图 SWF（`resource/0xE00003.swf` 等）是**新版**资源：文档类
 *   `DayWallpaperRatHoleGameMap`，ABC 里既没有 `BaseGameMap` 也没有 `IResource`
 *   （对比：卡/老鼠资源 `0x11370080.swf` 等都有 `IResource×7`，是版本匹配的）
 *   ⇒ cast 得到 null ⇒ 战场初始化抛异常（且异常发生在**动态加载的战斗模块**里，
 *   客户端全局兜底看不到）⇒ 载入进度永远停在 96、进不了战场。
 *
 * 合成地图这条路**完全不碰地图 SWF**：
 *   `CompositeMapHandler.IsCompositeMap()`（`CompositeMapHandler.as:181-188`）=
 *   `CompositeMapXML.Get().GetMapData(m_iMapID) != null && (mapID & 0xFF000000) != 0x51000000`
 *   —— **纯配置判断**，只要 mapID 在 `composite_map.xml` 里就成立；
 *   命中后 `a_3607:467-476` 取 `CompositeMapHandler.GetCompositeMap()`，
 *   `a_2187` 走 `InitComposite()`（无参安全版）；地图美术/音效走 `images/map/composite/*`
 *   （版本无关的图片/音频，镜像会从 CDN 抓）。
 *
 * 客户端把坐下应答原样存进 `GetSitDown()`，再在 `b_177.as:449-454` 本地喂给战斗模块，
 * 所以**只要服务端在应答里换掉 `m_iMapID`**，整条路就会走合成地图。
 * 开关：`REA_FORCE_COMPOSITE_MAP=0` 关闭；`REA_COMPOSITE_MAP=0x50010301` 指定别的图。
 */
const FORCE_COMPOSITE_MAP = process.env.REA_FORCE_COMPOSITE_MAP ?? "1";
const COMPOSITE_MAP_ID = Number.parseInt(process.env.REA_COMPOSITE_MAP ?? "0x50010301", 0) || 0x50010301;

let compositeMapIdSet = null;

/** 解析 `composite_map.xml` 里所有 `map_id="0x…"`（缓存）。 */
function compositeMapIds() {
  if (compositeMapIdSet !== null) return compositeMapIdSet;
  const set = new Set();
  try {
    const xml = fs.readFileSync(path.join(CONFIG_DATA_DIR, "composite_map.xml"), "utf8");
    for (const m of xml.matchAll(/map_id="(0x[0-9a-fA-F]+|[0-9]+)"/g)) {
      const id = Number.parseInt(m[1], m[1].startsWith("0x") ? 16 : 10);
      if (Number.isFinite(id) && id !== 0) set.add(id >>> 0);
    }
  } catch (e) {
    console.log(`[compositemap] 读取 composite_map.xml 失败：${e.message}`);
  }
  compositeMapIdSet = set;
  return set;
}

/** 决定这一局战斗发给客户端的 `m_iMapID`。 */
function resolveBattleMapID(chosenMapID) {
  const chosen = chosenMapID >>> 0;
  if (FORCE_COMPOSITE_MAP === "0") return chosenMapID;
  if (compositeMapIds().has(chosen)) return chosenMapID; // 本来就是合成地图，不动
  console.log(
    `[sitdown] 地图 0x${chosen.toString(16).toUpperCase()} 不在 composite_map.xml ⇒ ` +
      `改道合成地图 0x${(COMPOSITE_MAP_ID >>> 0).toString(16).toUpperCase()}` +
      `（绕开新版地图 SWF 与老客户端 BaseGameMap 不兼容：进度卡 96 的根因）`,
  );
  return COMPOSITE_MAP_ID;
}

function buildSitDownResponse(request) {
  const q = parseSitDownRequest(request);
  const chosenMapID = q.mapID >= 0 ? q.mapID : q.mapList[0] ?? 0;
  const mapID = resolveBattleMapID(chosenMapID);
  const roomID = q.roomID >= 0 ? q.roomID : 1;
  const tableID = q.tableID >= 0 ? q.tableID : 1;
  const seatID = q.seatID >= 0 ? q.seatID : 0;
  // 记住这张桌（供 8464/8452 回显）
  roomState.seated = true;
  roomState.roomID = roomID;
  roomState.tableID = tableID;
  roomState.seat = seatID;
  roomState.mapID = mapID;
  roomState.gameMode = q.gameMode >= 0 ? q.gameMode : 2;
  roomState.level = q.level >= 0 ? q.level : 0;
  roomState.name = q.tableName || "";
  /**
   * ★ 2026-10-16：**每次坐下都重置这一局的战斗状态**。
   *
   * 之前的 8709 分支里，`cmd1` 的第二道门是 `loadStartSent && !gameStartSent ⇒ 忽略`，
   * 本意是"同一局重复点开始不要重发 129"。但一局如果**没能走完**
   * （129 发了、130 永远没发 —— 正是这次卡 99 的情形），这两个旗标就永久卡在
   * (true,false) ⇒ 之后**每一次**点「开始」都被当成"重复上报"丢掉
   * ⇒ 客户端再也拿不到 129 ⇒ 表现就是"开不了"（用户实测）。
   * 坐下 = 新一局的天然边界，所以在这里复位。
   */
  battleState.loadStartSent = false;
  battleState.gameStartSent = false;
  battleState.stuckWarned = false;
  battleState.cardIDs = [];
  stopWavePushes(); // 新一局：旧的出怪定时器必须停掉，否则会往旧连接继续写
  return Buffer.concat([
    int16(0), // m_nResultID
    Buffer.from([0]), // m_byACT
    int32(roomID), // m_iRoomID
    int32(tableID), // m_iTableID
    Buffer.from([seatID & 0xff]), // m_bySeatID
    int32(1), // m_iSitdownSequence
    int32(0), // m_iCrossID（decode 需要）
    int32(mapID), // m_iMapID
    Buffer.from([q.gameMode & 0xff]), // m_byGameMode
    Buffer.from([q.level & 0xff]), // m_bLevel
    int16(1 << seatID), // m_nseatmask
    Buffer.from([1]), // m_byPlayerCount
    buildPlayerDetail({ tableId: tableID, seat: seatID }), // 本机玩家
  ]);
}

/**
 * EnterRoom(8449, 请求 a_2913) → a_2938。
 * 这是"登录游戏服务器"提示对应的请求：客户端进房间后才派发 a_574，
 * 进而调到 TDLobbyCoreUI.a_3138(...) 隐藏提示并显示房间/桌列表。
 */
function parseEnterRoomRequest(req) {
  // seq(4) + m_iACT(int8) + m_iRoomID(int32)
  try {
    return { act: req.readInt8(4), roomID: req.readInt32BE(5) };
  } catch (e) {
    return { act: 0, roomID: 0 };
  }
}

/** CPlayerGameConfig：2 字节长度前缀 + 3 个 int32 + 3 个 int8（无其它项）。 */
function buildPlayerGameConfig() {
  const body = Buffer.concat([
    int32(0), // m_iMinPoint
    int32(0), // m_iMaxPointGap
    int32(0), // m_byMaxOfflineRate
    Buffer.from([0]), // m_byIPBit
    Buffer.from([0]), // m_uiBitMap
    Buffer.from([0]), // m_byOtherSize = 0
  ]);
  return Buffer.concat([int16(body.length), body]);
}

function buildEnterRoomResponse(request) {
  const q = parseEnterRoomRequest(request);
  const roomID = q.roomID >= 0 ? q.roomID : 0;
  return Buffer.concat([
    int16(0), // m_nResultID
    Buffer.from([0]), // m_byACT
    int32(roomID), // m_iRoomID
    int32(0), // m_iHeadTableID
    int32(0), // m_iTailTableID
    buildPlayerDetail({ tableId: -1, seat: -1 }), // 进房间但尚未坐下
    buildPlayerGameConfig(),
    int32(0), // m_iFlag
  ]);
}

/** CTableInfo：tableID + status(idle=0) + 桌名 + mm/seat/valid 计数 + 地图 + 模式 + 难度。 */
function buildTableInfo() {
  const valid = roomState.gameMode === 2 || roomState.gameMode === 3 ? 2 : 4;
  return Buffer.concat([
    int32(roomState.tableID),
    int16(0), // m_nTableStatus = table_status_idle
    encodeString(roomState.name, 32),
    Buffer.from([1]), // m_byMMCount
    Buffer.from([1]), // m_bySeatCount
    Buffer.from([valid]), // m_byValidCount
    int32(roomState.mapID),
    Buffer.from([roomState.gameMode & 0xff]),
    Buffer.from([roomState.level & 0xff]),
  ]);
}

/** 取桌信息(8464, 请求 a_2917) → a_2942：resultID + roomID + int16 桌数 + 桌表。 */
const tableInfoResponse = (request) => {
  const roomID = request.length >= 8 ? request.readInt32BE(4) : 0;
  const hasTable = roomState.seated && roomID === roomState.roomID;
  return Buffer.concat([
    int16(0),
    int32(roomID),
    int16(hasTable ? 1 : 0),
    hasTable ? buildTableInfo() : Buffer.alloc(0),
  ]);
};

/** a_2963：桌状态条目（int8 尺寸 + 桌号 + 状态）。 */
const buildViewTable = () =>
  Buffer.concat([
    Buffer.from([0]), // m_iSize
    int32(roomState.tableID),
    int16(0), // m_nTableStatus = idle
  ]);

/** a_2911：房间内玩家信息。 */
const buildLobbyPlayerInfo = () =>
  Buffer.concat([
    int32(ROLE_UIN), // m_iUin
    encodeString(ROLE_NAME, 32),
    int16(0), // m_nFlag
    int32(0), // m_iIdentity
    int32(ROLE_UIN), // m_iPlayerID
    int32(roomState.tableID), // m_iTableID
    Buffer.from([roomState.seat & 0xff]), // m_bySeat
    Buffer.from([STATUS_SEATED]), // m_byStatus
    int32(0), // m_iExperiencePoint
    int32(0), // m_iAchievement
    encodeUint64(0), // m_iPoint
    int32(0), // m_iWinRound
    int32(0), // m_iLoseRound
    int32(0), // m_iDrawRound
    int32(0), // m_iConsortiaID
    int32(0), // m_aryServiceTime
    int32(0), // m_iVipScore
  ]);

/**
 * 房间视图(8452, 请求 a_2936) → a_2961：resultID + roomID + 桌表 + 玩家表。
 * 坐下后要把"这张桌 + 自己"回进去，否则客户端认为房间里没有玩家，进不了战斗。
 */
const viewAreaResponse = (request) => {
  const roomID = request.length >= 8 ? request.readInt32BE(4) : 0;
  const has = roomState.seated && roomID === roomState.roomID;
  return Buffer.concat([
    int16(0),
    int32(roomID),
    int16(has ? 1 : 0),
    has ? buildViewTable() : Buffer.alloc(0),
    int16(has ? 1 : 0),
    has ? buildLobbyPlayerInfo() : Buffer.alloc(0),
  ]);
};

/** 离开房间(8450, 请求 a_2919) → a_2944：resultID + roomID。 */
const leaveRoomResponse = (request) => {
  roomState.seated = false; // 离开房间后桌列表不再显示这张桌
  return Buffer.concat([
    int16(0),
    int32(request.length >= 8 ? request.readInt32BE(4) : 0), // m_iRoomID
  ]);
};

/** 对局数据上传(8709, 请求 a_2926) → a_2951：resultID + roomID + tableID。 */
const sendGameDataAck = (request) =>
  Buffer.concat([
    int16(0),
    int32(request.length >= 12 ? request.readInt32BE(4) : 0), // m_iRoomID
    int32(request.length >= 12 ? request.readInt32BE(8) : 0), // m_iTableID
  ]);

/** 角色数据应答 a_2837：注意客户端 decode 读的是 uint64 gamePoint。 */
function buildRoleInfoBody() {
  // 单机版：直接给足货币与积分。客户端把 m_iGamePoint / m_iGameScore / m_iRoleScore
  // 原样存进角色对象（见 a_2439.as: role.m_iGamePoint = roleInfoResponse.m_iGamePoint），
  // 因此这里给大数值就等于"钱管够"，无需实现任何充值流程。
  const richCurrency = 999_999_999;
  return Buffer.concat([
    int16(0), // resultID
    int32(ROLE_UIN), // m_iRoleUin
    Buffer.from([1]), // m_iUserSex int8
    encodeString(ROLE_NAME, 32), // m_szRoleName
    int32(richCurrency), // m_iRoleScore
    encodeString("", 1024), // m_szHeroItemString
    int32(0), // m_iRoleAttack
    int32(0), // m_iRoleDefense
    Buffer.from([0]), // m_byShowCard int8
    int16(0), // m_nHeroItemCount（设为 0，跳过 CHeroItem 数组）
    int32(richCurrency), // m_iGameScore
    int32(0), // m_iGamePoint 高 32 位
    int32(richCurrency), // m_iGamePoint 低 32 位
    int32(richCurrency), // m_iVsExp
    int32(richCurrency), // m_iVsScore
  ]);
}

/** 大厅/角色相关报文 → 应答体构造器。 */
export const HALL_RESPONSES = new Map([
  [
    14592, // LOGIN_HALL_SERVER → a_2842
    {
      name: "HALL_LOGIN",
      build: () =>
        Buffer.concat([
          int16(0),
          int32(PLAYER_UIN),
          int32(Math.floor(Date.now() / 1000)),
          int32(HALL_SERVER_VERSION),
        ]),
    },
  ],
  [12803, { name: "GET_ROLE_LIST", build: buildRoleListBody }], // → a_2838
  [12806, { name: "GET_ROLE_INFO", build: buildRoleInfoBody }], // → a_2837
  [14673, { name: "GET_PLAYER_COMMON_INFO", build: emptyResult }], // → a_2835
  [14720, { name: "GET_TASK_INFO", build: taskInfoEmpty }], // → a_2995
  [14880, { name: "GET_TASK_INFO2", build: taskInfoEmpty }], // → a_2995
  [14595, { name: "GET_FRIEND_LIST", build: friendListEmpty }], // → a_2687
  [14864, { name: "GET_ACHIEVEMENTS", build: achievementsEmpty }], // → a_2833
  [14934, { name: "COOKERY_INFO", build: recipesEmpty }], // → SCResponseRecipesGetInfo
  [14689, { name: "GET_CARDS", build: buildCardsBody }], // → a_2943
  [12817, { name: "GET_STORE_BOX", build: buildStoreBoxBody }], // → CResponseGetStroeBoxInfo
  [12818, { name: "UPDATE_STORE_BOX", build: buildStoreBoxUpdateBody }], // → CResponseUpdateStoreBox
  [12819, { name: "EXPAND_STORE_BOX", build: buildExpandStoreBoxBody }], // → CResponseExpandStoreBox
  [14867, { name: "OPEN_CARD_SLOT_PACK", build: openCardSlotPack }], // → a_2867
  [14868, { name: "USE_CARD_SLOT_PACK", build: useCardSlotPack }], // → a_2870
  [14869, { name: "USE_CARD_SLOT_PACK2", build: useCardSlotPack }], // → a_2870
  [14876, { name: "CARD_FUSION", build: buildFusionCardBody }], // → SCResponseFusionCard
  [14877, { name: "FUSIONCARD_UPGRADE", build: buildFusionUpgradeBody }], // → SCResponseFusionCard
  [14849, { name: "CARD_COMPOSE", build: buildComposeBody }], // → SCResponseCompose
  [14850, { name: "CARD_UPGRADE", build: buildUpgradeBody }], // → SCResponseUpgrade
  [15008, { name: "RECHARGE_ACTIVITY_INFO", build: rechargeActivityEmpty }],
  [15017, { name: "PLAYER_MARRIAGE_INFO", build: marriageEmpty }],
  [8193, { name: "LOGIC_LOGIN", build: logicLoginEmpty }], // → a_2945
  [14881, { name: "SAVE_TASK_SLOT", build: saveTaskEmpty }], // → a_3000
  [15060, { name: "CRYSTONE_SLOT_GET", build: crystoneSlotEmpty }],
  [15367, { name: "LOVE_BUFF_INFO", build: protectorEmpty }],
  [15720, { name: "HAS_SECPWD", build: hasSecpwdEmpty }],
  [15034, { name: "ONGOING_WEDDING_COUNT", build: weddingCountEmpty }],
  [15728, { name: "CHECK_NEW_SVR_TASK", build: checkNewSvrTaskEmpty }],
  [15733, { name: "NEW_SVR_GIFT_LOGIN", build: newSvrGiftLoginEmpty }],
  [14721, { name: "TASK_ACCEPT", build: taskFailure }],
  [14722, { name: "TASK_CHECK", build: taskFailureWithType }],
  [14723, { name: "TASK_REWARD", build: taskFailure }],
  [14882, { name: "TASK_ACCOMPLISH", build: taskAccomplished }], // → a_2997
  [
    14594, // 大厅心跳 → a_2840
    {
      name: "HALL_HEARTBEAT",
      build: () =>
        Buffer.concat([int16(0), int32(Math.floor(Date.now() / 1000))]),
    },
  ],
  [
    14688, // ROLE_LOGIN_HALL → a_2843
    {
      name: "ROLE_LOGIN",
      build: () =>
        Buffer.concat([
          int16(0),
          int32(ROLE_UIN),
          int32(Math.floor(Date.now() / 1000)),
        ]),
    },
  ],
  // —— 第三批：活动 / 商店 / 邮件 / 公会（仅打开对应界面时请求）——
  [14702, { name: "GET_PET_ACCOUNT", build: petAccountEmpty }], // → CReponseGetPetAccount
  [14945, { name: "GET_CHOUJIANG_INFO", build: choujiangInfoEmpty }], // → CResponseChoujiangInfo
  [14981, { name: "UPDATE_MAIL_LIST", build: mailListUpdateEmpty }],
  [15360, { name: "GET_NEW_CONSORTIA_TASK_LIST", build: consortiaTaskListEmpty }],
  [15376, { name: "GET_HOLIDAY_EXCHANGE_INFO", build: holidayExchangeInfoEmpty }],
  [15381, { name: "GET_MONTH_CARD_INFO", build: monthCardInfoEmpty }],
  [15697, { name: "ONEPIECE_PRIZE_DRAW_INFO", build: onepieceInfoEmpty }],
  [15714, { name: "MONTH_CARD_SHOP_INFO", build: monthCardShopInfoEmpty }],
  [15749, { name: "DAILY_PAY_INFO", build: dailyPayInfoEmpty }],
  [15760, { name: "GET_SPECIAL_ACTIVITY_INFO", build: specialActivityInfoEmpty }],
  [14768, { name: "GET_JOIN_CONSORTIA_INFO", build: consortiaJoinInfoFail }], // → a_2798
  [8466, { name: "GET_ROOM_PLAYER_COUNT", build: roomPlayerCountInfo }], // → a_2941
  [15041, { name: "GET_CHARM_INFO", build: charmInfoEmpty }], // → CCSResponseGetCharmInfo
  // —— 逻辑服：单机进战斗（对电脑模式直接发 SitDown 即分配房间）——
  [8705, { name: "SIT_DOWN", build: buildSitDownResponse }], // → a_2953
  [8449, { name: "ENTER_ROOM", build: buildEnterRoomResponse }], // → a_2938
  [8464, { name: "GET_TABLE_INFO", build: tableInfoResponse }], // → a_2942
  [8452, { name: "UPDATE_VIEW_AREA", build: viewAreaResponse }], // → a_2961
  [8450, { name: "LEAVE_ROOM", build: leaveRoomResponse }], // → a_2944
  [8709, { name: "SEND_GAME_DATA", build: sendGameDataAck }], // → a_2951
]);

/**
 * 进战斗需要补发的 L2 报文（b_102 命令号空间，见 docs/battle-protocol.md）。
 * 这些不是对某个请求的应答，而是在 L1 切 UI 之后由服务端主动推的。
 */
export const L2_CMDS = {
  LoadStart: 129, // a_2698 载入战场
  StartGame: 130, // a_2695 开战
  StepLock: 128, // 帧同步锁步
};

/**
 * `b_102` 中客户端**真正会发**的 CS 命令号（`decompiled\TDCore\scripts\a_4718\b_102.as`）。
 *
 * 实测依据：`server.log` 里全部 94 条 8709 上行按 `[int32 roomID][int32 tableID][int16 gdLen][uint8 cmd][载荷]`
 * 逐字节解出来的分布是 cmd3×92 / cmd12×1 / cmd9×1，**cmd1×0**（那次会话玩家没点"开始"）。
 * cmd1（PostSelectedCards）才是卡组上报，也是 129 的正确触发点 —— 见 buildLoadStartPayload 上方注释。
 */
export const L2_CS_CMDS = {
  PostSelectedCards: 1, // b_104 → a_2726：卡组/道具/avatar 上报，a_2053.as:157，由 TDGameReadyUI.as:1161 点击触发
  PostLoadingProgress: 3, // b_106 → a_2058(int8 进度)，a_2053.as:226
  PostReadyUiCreated: 9, // b_112 → a_2064（无载荷），a_2053.as:371，由 a_2179.as:1705 a_2194() 在**准备 UI 建好后**发出
  PostAvatarInfo: 12, // b_115 → a_2713：角色展示信息广播，a_2053.as:417（**不是**卡组）
};

/**
 * `b_102` 中服务端**必须主动推**的 SC 命令号。
 *
 * ★ 131 是本轮定位到的关键缺口（2026-10-14）：`TDGameReadyUI.as:87` 的 `a_1674` 默认 **-1**，
 *   只在 `:525 a_2089(sittedPlayerStatusNotify)` 里被赋成 `a_2709.m_byIsGameCanStart`；
 *   而「开始」按钮的点击分支 `:970-991` 最后一句是 **`:986 else if(this.a_1674 == 1) this.ready(...)`**
 *   ⇒ **服务端不发 131，点「开始」就是静默空操作**，`onPostSelectedCards` 不会被调用，
 *   于是 cmd1 永远不发、129 永远不推 —— 实测 `server.log` 里 94/94 条上行都没有 cmd1，正是此症状。
 *   131 还有第二个必需性：`a_2179.as:902-909 a_2089()` 会把通知存进 `m_stSittedPlayerStatusNotify`，
 *   而 `a_2179.as:1736-1740 a_2195()`（真正初始化战场 UI）在该字段为 null 时**直接 return false**。
 */
export const L2_SC_CMDS = {
  SittedPlayerStatus: 131, // b_127 → a_2709，a_2053.as:83 注册 → a_2179.as:902 a_2089
  /**
   * ★★ 2026-10-16：「出怪」的**唯一**驱动。
   *
   * `a_2053.as:85` 把 132 绑到 `a_2090` → `a_2699.decode` → `a_2179.a_2181`：
   * 后者把 `m_arrEnmeyInfo` 逐条翻成 `a_4269`（pending intruder），再交给
   * `TDGame2V2BattleUI.a_3608(...)` —— 那才是**真正把老鼠排进战场**的地方
   * （`BattleFieldView.a_3456` → `a_4255.a_4256(typeID)` 造实体）。
   * ⇒ 服务端不发 132，客户端就**永远不出怪**（"能放塔但不出怪"的根因）。
   *   波次进度 / 鼠洞数量也都在这一条帧里（体布局见 `buildNextWavePayload`）。
   */
  NextEnmeyWave: 132, // b_128 → a_2699（a_2053.as:85），由 a_2179.a_2181 落怪
  SecrityCode: 152, // enmGameDataCmd_SC_SecrityCode → CNotifySecrityCode
  SecrityCodeResult: 153, // enmGameDataCmd_SC_SecrityCodeResult
};

/**
 * 编码 SC 131 体（`a_2709`，布局实测自 a_2709.as:33）。
 *
 * ```
 * int8  m_byTableMasterSitID
 * int8  m_byIsGameCanStart        ← 必须 1，否则「开始」按钮点了没反应
 * int8  m_byPlayerCount           ← ★ 同时充当下一字段的数组长度
 * × m_byPlayerCount  CTDPlayerStatusInfo{ uint8 m_byTeamNo; uint8 m_byReadyStatus; uint8 m_PointStatus }
 * ```
 *
 * ⚠ **数组长度由「前一个标量字段」驱动**：`a_2664.a_2666` 里 `preValue` 在标量分支被赋成刚读到的值
 * （`:437`），数组分支 `:369 while(preValue-- > 0)` 就消费这个值；`"nosize"` 只表示元素**不自带长度前缀**。
 * 所以 `m_byPlayerCount` 必须**等于**元素个数，写错就会错位。
 *
 * 元素取值语义（`TDGameReadyUI.as:518-546`）：
 *   - `m_byReadyStatus == 255` → 该座位视为空座（`:548` 删除并 hideSeat）
 *   - `m_byReadyStatus == 1`   → 已准备（`:545 showBtnEanbled(false)` **会把按钮禁用**）
 *   - `m_PointStatus == 1`     → `:960/:982` 弹出「体力不足」对话框并**阻止开始**
 */
export function buildSittedPlayerStatusPayload({ masterSeat, canStart, seats }) {
  const parts = [
    Buffer.from([masterSeat & 0xff, canStart ? 1 : 0, seats.length & 0xff]),
  ];
  for (const s of seats) {
    parts.push(Buffer.from([s.teamNo & 0xff, s.readyStatus & 0xff, s.pointStatus & 0xff]));
  }
  return Buffer.concat(parts);
}

/**
 * 桌面座位槽数。客户端 UI 固定 4 个座位
 * （`a_2179.as` 的 `m_arrPlayerAvatarDetailInfo[stAvatarInfo.m_bySeatID]`、
 *  `TableReadyUI.m_vTabSeat[0..3]`、`TDGameReadyUI.as:219-224 while(iGameSeatID < 4)`），
 * 且 131 的 `m_arrPlayerStatusInfo` 是按**下标即座位号**消费的，
 * 所以必须补满 4 个槽（空位 readyStatus=255），否则 `TDGameReadyUI.as:559 showVcKey`
 * 不会被调用，「我的防御卡」永远空。
 */
export const TABLE_SEAT_SLOTS = 4;

/**
 * 拆 L2 传输层包装：明文 = `[int32 seq][int32 roomID][int32 tableID][int16 gdLen][gdLen bytes]`。
 *
 * ⚠ 与 a_2926 的对应关系：a_2926.encode（a_2926.as:23-30）写的是
 * `int32 roomID / int32 tableID / int16 数据长度 / memory`，而 handlePacket 拿到的 `dec.data`
 * **前面还有 4 字节 sequence**（`spec.build(dec.data)` 传的是完整明文），
 * 所以 roomID 在偏移 4 而不是 0。这一点与 verify-handlers.mjs 里 a_2951 的断言同源。
 */
export function parseGameDataEnvelope(plain) {
  if (!Buffer.isBuffer(plain) || plain.length < 14) return null;
  const roomID = plain.readInt32BE(4);
  const tableID = plain.readInt32BE(8);
  const gdLen = plain.readInt16BE(12);
  const start = 14;
  if (gdLen < 0 || start + gdLen > plain.length) return null;
  return { roomID, tableID, gdLen, gameData: plain.subarray(start, start + gdLen) };
}

/**
 * 解析 cmd1 PostSelectedCards（`a_2726`，布局实测自 a_2726.as:69 的 decode propertyArray）。
 *
 * ⚠ 这里**故意不做 uncompress**：a_2726.decode 会 `uncompress()`，但服务端只是转发/统计，
 * 线上 `m_stAvatarInfoByteArray` 是 zlib 压缩的 AMF3 blob，保持原样才能原样回填 CAvatarInfo。
 *
 * 解析必须**长度自洽**（消费掉的字节恰好等于整段长度），否则返回 `{ok:false}` —— 防垃圾包。
 */
export function parsePostSelectedCards(gameData) {
  if (!Buffer.isBuffer(gameData) || gameData.length < 1) return { ok: false, reason: "empty" };
  if (gameData[0] !== L2_CS_CMDS.PostSelectedCards)
    return { ok: false, reason: `cmd ${gameData[0]} is not PostSelectedCards` };
  let pos = 1;
  const need = (n) => {
    if (n < 0 || pos + n > gameData.length) throw new RangeError(`truncated at ${pos} (need ${n})`);
  };
  const u8 = () => {
    need(1);
    return gameData[pos++];
  };
  const i16 = () => {
    need(2);
    const v = gameData.readInt16BE(pos);
    pos += 2;
    return v;
  };
  const i32 = () => {
    need(4);
    const v = gameData.readInt32BE(pos);
    pos += 4;
    return v;
  };
  try {
    const cardCount = u8();
    const cards = [];
    for (let i = 0; i < cardCount; i += 1) cards.push({ id: i32(), seq: i32() });
    const propCount = i16();
    const props = [];
    for (let i = 0; i < propCount; i += 1) props.push({ id: i32(), seq: i32() });
    const avatarSize = i16();
    need(avatarSize);
    const avatarBlob = gameData.subarray(pos, pos + avatarSize);
    pos += avatarSize;
    const additions = [i16(), i16(), i16(), i16(), i16()];
    const equip = {
      consortiaID: i32(),
      gunType: i32(),
      gunSequence: i32(),
      shieldType: i32(),
      shieldSequence: i32(),
      superGunType: i32(),
      superGunSequence: i32(),
    };
    const petCount = i16();
    const petCheckInfo = i32();
    if (pos !== gameData.length)
      return { ok: false, reason: `length mismatch: consumed ${pos} of ${gameData.length}` };
    return { ok: true, cards, props, avatarBlob, additions, equip, petCount, petCheckInfo };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** 客户端 a_2179.as:254 的硬上限：`if(arrSelectCards[0].length > 24) return false;` */
export const MAX_SELECT_CARDS = 24;

/**
 * 编码 129 LoadStart 体（`a_2698`，布局实测自 a_2698.as:41）。
 *
 * 实测的客户端读点全表：
 *   - `m_nGameMode`          → a_2179.as:664  `m_arrGameData["byGameMode"] = ...`（战斗分支依赖）
 *   - `m_arrSelectCardIDs`   → a_2179.as:801  仅用于资源预加载 `resource/0x<ID>.swf`
 *   - `m_arrSelectPropIDs`   → **0 个读点**（故发 0 条）
 *   - `m_arrAvatarInfoArray` → a_2179.as:669
 *   - `m_RandomSeed`         → a_2179.as:665-666（**唯一权威随机种子**）
 *
 * ★ avatars 故意发 0 条（关键设计决定）：
 *   a_2179.as:312-313 在客户端本地路径里**已经**把本机座位的 AvatarDetailInfo 填好
 *   （`m_arrPlayerAvatarDetailInfo[bySeat] = stAvatarDetailInfo`），而发送 cmd1 是在 :410、
 *   即 :313 之后 —— 本机 avatar 数据客户端自己就有。若服务端再回 1 条，a_2179.as:757-759 会用
 *   服务端版本**覆盖** `m_arrPlayerAvatarDetailInfo[seat].m_arrCardInfoArray` 与 `m_arrSelectedCards[0]`；
 *   而 cmd1 的 CCardIDInfo 只有 CardID+CardSeq（CCardIDInfo.as:21），**没有星级/技能等级**，
 *   硬凑会把战斗卡牌等级写坏。单人只打自己座位 ⇒ 发 0 条最忠实、零风险，且完全不需要写 AMF3。
 *
 * ★ cardIDs 必须非空：a_2179.as:810 的分支
 *   `if(arrPendingLoadingRes.length > 0 || arrPendingAvatarLoadingRes.length > 0)`
 *   会 `startLoad()` 并在完成时调 `a_2193(null)` → `LoadEndAndStartGame()`；而 :849 的
 *   `else if(this.a_768 && !a_3004.isLoading)` 在 129 晚到（a_768 已被 :1682 复位为 false）时
 *   会掉进最后的 else，**什么都不做 ⇒ 卡死**。非空 cardIDs 正是绕开该死路的关键。
 */
export function buildLoadStartPayload({ gameMode, cardIDs, seed }) {
  const ids = (cardIDs ?? []).slice(0, MAX_SELECT_CARDS);
  const parts = [int16(gameMode | 0), int16(ids.length)];
  for (const id of ids) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(id >>> 0, 0); // propertyArray 声明 uint32 ⇒ 必须无符号写
    parts.push(b);
  }
  parts.push(int16(0)); // m_nSelectPropIDCount：客户端无读点
  parts.push(int16(0)); // m_nAvatarInfoCount：见上方 ★
  parts.push(int32(seed | 0)); // m_RandomSeed（权威）
  return Buffer.concat(parts);
}

/** 129 体的字节长度公式，供断言/日志复用：`12 + 4*N`。 */
export const loadStartPayloadLength = (cardCount) => 12 + 4 * cardCount;

/** 130 StartGame 的波数上限保护：a_3563 会做 `int(124 / n)`，n=0 会除零。 */
const TOTAL_INTRUDER_WAVE_NUM = (() => {
  const v = Number.parseInt(process.env.REA_TOTAL_WAVE_NUM ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 20;
})();

const BATTLE_SEED_OVERRIDE = (() => {
  const v = Number.parseInt(process.env.REA_BATTLE_SEED ?? "", 0);
  return Number.isFinite(v) ? v | 0 : null;
})();

function newBattleSeed() {
  if (BATTLE_SEED_OVERRIDE !== null) return BATTLE_SEED_OVERRIDE;
  return Math.floor(Math.random() * 0x100000000) | 0;
}

/**
 * 编码 130 GameStart 体（`a_2695`，布局实测自 a_2695.as:29）—— **定长 10 字节**。
 *
 * 读点：
 *   - `m_nTotalIntruderWaveNum` → TDGame2V2BattleUI.as:1124 →
 *     MoveIntruderWaveNumberIndicatorView.a_3563()；该函数 :38 `int(124/n)`、:72 `n % a_1119`
 *     ⇒ **必须为正**。它只驱动"剩余波数"指示条显示，**不驱动出怪逻辑**，取值待实机校准。
 *   - `m_RandomSeed` → **0 个读点**（冗余字段），填与 129 同值以免将来出现分歧。
 *   - `m_iBuffId` → TDGame2V2BattleUI.as:903 `a_4206.m_iViewBuffId = ...` ⇒ 发 0。
 */
export function buildGameStartPayload({ waveNum, seed, buffId = 0 }) {
  const b = Buffer.alloc(10);
  b.writeInt16BE(waveNum | 0, 0);
  b.writeInt32BE(seed | 0, 2);
  b.writeInt32BE(buffId | 0, 6);
  return b;
}

/** 单机只有一名玩家：整局状态放模块级即可（客户端只在一条连接上发 8709）。 */
export const battleState = {
  loadStartSent: false,
  gameStartSent: false,
  sittedStatusSent: false,
  // 只打一次的诊断旗标：进度 ≥99 却始终没收到 cmd1（= 点不到「开始」）时告警用
  stuckWarned: false,
  seed: 0,
  cardIDs: [],
  roomID: -1,
  tableID: -1,
};

function buildBattleStartFrames(sessionKey) {
  let seq = 0;
  const mk = (cmd, body) => ({
    cmd,
    packet: buildGameDataNotifyPacket(sessionKey, {
      roomID: battleState.roomID,
      tableID: battleState.tableID,
      events: [{ seq: seq++, data: Buffer.concat([Buffer.from([cmd]), body]) }],
    }),
  });
  return [
    mk(
      L2_CMDS.LoadStart,
      buildLoadStartPayload({
        gameMode: roomState.gameMode,
        cardIDs: battleState.cardIDs,
        seed: battleState.seed,
      }),
    ),
    mk(
      L2_CMDS.StartGame,
      buildGameStartPayload({
        waveNum: TOTAL_INTRUDER_WAVE_NUM,
        seed: battleState.seed,
      }),
    ),
  ];
}

/* ------------------------------------------------------------------ *
 * SC 132 NextEnmeyWave —— 「出怪 / 波次推进」驱动（2026-10-16）
 * ------------------------------------------------------------------ */

/**
 * 客户端**真的能实例化**的老鼠 ID 白名单。
 *
 * 来源：`decompiled/TDCore/scripts/com/aurora/ui/maogoutd/base/TDFactoryImport.as`
 * 里 `RegisterCreator(<0x800000+id>, …)` 的全部条目（经
 * `server/check-wave-mice.mjs` 从反编译产物重新推导并逐条比对）。
 *
 * ⚠ 为什么必须有白名单：`BattleFieldView.a_3456` 在造怪时会
 *   `stBaseMoveIntruder = m_stMoveIntruderFactory.a_4256(m_iIntruderType)`，
 *   **得 null 就直接 `throw new Error("此老鼠不存在ID:" + …)`**（`:3111`）。
 *   而客户端启动时只注册了这 45 个（`TDCore.as:36 TDFactoryImport.ImportAll()`），
 *   `map_mouse.xml` 里那些 0x1xxx 的老鼠（本图 29 只，全是次元/新章鼠）**一个都没注册** ——
 *   照抄地图配置发过去只会把战斗模块抛异常。详见 docs/battle-wave-driver.md。
 */
export const BATTLE_MOUSE_REGISTRY = new Map([
  [0x0001, "CommonMouseMoveIntruder（小老鼠）"],
  [0x0002, "BallFansMouseMoveIntruder（气球扇鼠）"],
  [0x001e, "CommonMouseMoveIntruder.GetFreeInstance1"],
  [0x0026, "FlyBossMouseMoveIntruder"],
  [0x002c, "a_4231.GetFreeInstance1"],
  [0x002e, "a_4246.GetFreeInstance2"],
  [0x002f, "a_4246.GetFreeInstance1"],
  [0x0035, "a_4246.GetFreeInstance3"],
  [0x0036, "a_4246.GetFreeInstance4"],
  [0x0059, "FlyBossMouseStrengthenMoveIntruder"],
  [0x0089, "ThiefMouseSecondTransMoveIntruder"],
  [0x0097, "GlidingMouseMoveIntruder"],
  [0x01f7, "PigBalloonMouseMoveIntruder"],
  [0x0219, "HaMaKnightMouseIntruder"],
  [0x0411, "WBLavaStickyMouseMoveIntruder"],
  [0x0412, "WBPaparazziMouseMoveIntruder"],
  [0x045c, "WBDesireKingP1BossMoveIntruder"],
  [0x045d, "WBDesireKingP2BossMoveIntruder"],
  [0x045e, "WBDesireKingP3BossMoveIntruder"],
  [0x0601, "IsLandCommonMouseMoveIntruder"],
  [0x0602, "IsLandDragonQueenMouseMoveIntruder"],
  [0x0603, "IsLandGoblinMouseMoveIntruder"],
  [0x0604, "IsLandWolfTeethClubMouseMoveIntruder"],
  [0x0605, "IsLandEastWindMouseMoveIntruder"],
  [0x0606, "IsLandPathfinderMouseMoveIntruder"],
  [0x0607, "IsLandPathfinderMouseMoveIntruder.GetFreeInstance2"],
  [0x0608, "IsLandObsessionMouseMoveIntruder"],
  [0x0609, "IsLandObsessionMouseMoveIntruder.GetFreeInstance2"],
  [0x060a, "IsLandFuzhouMouseSoulMoveIntruder"],
  [0x060b, "LoomMouseMoveIntruder"],
  [0x060c, "StiltMouseMoveIntruder"],
  [0x060d, "MedicinePotMouseMoveIntruder"],
  [0x060e, "SpiderMouseMoveIntruder"],
  [0x0620, "IsLandWanderingDeitBoss"],
  [0x0621, "OxHeadBossMoveIntruder"],
  [0x0622, "IsLandListeningMouseBossMoveIntruder"],
  [0x0623, "HenHaBoss.OxHeadBossMoveIntruder"],
  [0x0624, "WuChangMouseBossMoveIntruder"],
  [0x0625, "MengPoBossMoveIntruder"],
  [0x0805, "a_4276.GetFreePVPInstance"],
  [0x0807, "a_4228.GetFreePVPInstance"],
  [0x0808, "a_4231.GetFreePVPInstance"],
  [0x080d, "a_4279.GetFreePVPInstance"],
  [0x080e, "a_4303.GetFreePVPInstance"],
  [0x1040, "kfcarbon.FlyBossMouseMoveIntruder"],
]);

/** 万一地图鼠表与白名单**零交集**时的兜底（经典三只，全部在册）。 */
const CLASSIC_WAVE_MICE = [0x0001, 0x0002, 0x001e];

const WAVE_START_TICK = Number(process.env.REA_WAVE_START_TICK ?? 60); // 第一波第一只：60 tick × 50ms = 3s
const WAVE_GAP_TICKS = Number(process.env.REA_WAVE_GAP_TICKS ?? 300); // 波间隔 15s
const WAVE_SPAWN_GAP = Number(process.env.REA_WAVE_SPAWN_GAP ?? 20); // 波内每只间隔 1s
const WAVE_APPEAR_TYPE = Number(process.env.REA_WAVE_APPEAR ?? 2); // 2 = 从鼠洞钻出（原版观感）
const WAVE_HOLE_COUNT = Number(process.env.REA_WAVE_HOLES ?? 2); // 每波开几个鼠洞

/**
 * 解析 `map_mouse.xml` 里这张图的鼠表（`MouseID="0x…,0x…"`）。
 *
 * 客户端**自己的**鼠表也来自这里（`a_2439.as:210-217` 用坐下应答的 mapID 去
 * `a_2037` 的 `m_dictMapMouse` 查），所以我们按同一个 entry 算交集，口径一致。
 */
function mapMouseEntry(mapID) {
  try {
    const xml = fs.readFileSync(path.join(CONFIG_DATA_DIR, "map_mouse.xml"), "utf8");
    const key = `MapID="0x${(mapID >>> 0).toString(16).toUpperCase().padStart(2, "0")}"`;
    const alt = `MapID="0x${(mapID >>> 0).toString(16).toLowerCase()}"`;
    let at = xml.indexOf(key);
    if (at < 0) at = xml.indexOf(alt);
    if (at < 0) return null;
    const end = xml.indexOf("</item>", at);
    const seg = xml.slice(at, end < 0 ? at + 4000 : end);
    const mice = (seg.match(/MouseID="([^"]*)"/)?.[1] ?? "")
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 16))
      .filter((n) => Number.isFinite(n) && n > 0);
    const count = Number.parseInt(seg.match(/Count="(\d+)"/)?.[1] ?? "0", 10);
    const name = seg.match(/MapName="([^"]*)"/)?.[1] ?? "";
    return { name, count, mice };
  } catch (e) {
    console.log(`[wave] 读 map_mouse.xml 失败：${e.message}`);
    return null;
  }
}

/** 这一局实际用的鼠表：`REA_WAVE_MICE` > 地图鼠表∩白名单 > 经典三只。 */
export function resolveWaveMice(mapID) {
  const override = process.env.REA_WAVE_MICE;
  if (override) {
    const list = override
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 16))
      .filter((n) => Number.isFinite(n) && n > 0);
    const bad = list.filter((n) => !BATTLE_MOUSE_REGISTRY.has(n));
    if (bad.length > 0) {
      console.log(
        `[wave] ⚠ REA_WAVE_MICE 里有未注册的老鼠：` +
          bad.map((n) => "0x" + n.toString(16)).join(",") +
          ` —— 客户端 a_4256 会返回 null 并 throw（此老鼠不存在ID）`,
      );
    }
    const ok = list.filter((n) => BATTLE_MOUSE_REGISTRY.has(n));
    if (ok.length > 0) return { mice: ok, source: "REA_WAVE_MICE" };
  }
  const entry = mapMouseEntry(mapID);
  if (entry !== null && entry.mice.length > 0) {
    const ok = entry.mice.filter((n) => BATTLE_MOUSE_REGISTRY.has(n));
    if (ok.length > 0) return { mice: ok, source: `map_mouse ${entry.name}` };
    console.log(
      `[wave] 地图 0x${(mapID >>> 0).toString(16).toUpperCase()} 的 ${entry.mice.length} 只鼠` +
        `（${entry.name}）在客户端注册表里**一只都没有**` +
        ` ⇒ 回落经典三只 ${CLASSIC_WAVE_MICE.map((n) => "0x" + n.toString(16)).join(",")}` +
        `（原因见 docs/battle-wave-driver.md §2）`,
    );
  }
  return { mice: CLASSIC_WAVE_MICE, source: "经典三只（兜底）" };
}

/** 战场行数：`BattleFieldView.a_1012`（TDGame2V2BattleUI.as:504-508/546-550）。 */
function battleRowCount(mapID) {
  const rows = Number(process.env.REA_WAVE_ROWS ?? 0);
  if (Number.isFinite(rows) && rows > 0) return rows;
  return mapID === 3 ? 6 : 7;
}

/** 种子化 xorshift32：同一 seed ⇒ 同一份出怪表（要能复现才谈得上"对着原项目"）。 */
function seededRandom(seed) {
  let s = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/**
 * 编码 SC 132 体（`a_2699`，布局实测自 `a_2699.as:36-56` 的 decode）：
 *
 * ```
 * int8  m_byAppearRatHoleCount     ← a_3608 里 "开几个鼠洞"（a_3463(...) 调几次）
 * int8  m_byAppearRatHole          ← 洞的基号，客户端 a_3463(byAppearHole*(i+1))
 * int8  m_byWaveProgress           ← 0..100，a_3564()；**=100 时把波数 +1**（a_3564:75-80）
 * int8  m_byWaveStatus             ← 0 普通 / 1、2 大波来袭提示 / 3 BOSS 阶段
 * int16 m_nEnemyNum
 * × m_nEnemyNum  CPendingEnemy{
 *     uint16 m_nEnemySequence      ← 全局唯一序号
 *     uint32 m_uiEnemyTypeID       ← 老鼠 ID（客户端再加 0x800000 变成 IntruderType）
 *     uint8  m_byAppearType        ← 2 = 从既有鼠洞钻出；0 = 从场地边缘走入
 *     uint8  m_byRow               ← 行走行号 0..a_1012-1
 *     uint8  m_byAppearFlag        ← >0 才走 a_3463/a_3429 的"洞口"分支
 *     uint32 m_uiTimeTickCount     ← 出现时刻，**50ms 一 tick**，基准是 a_3435() 归零的那次
 *   }
 * ```
 *
 * 时间基准的实锤：`a_3435(stGameStartNotify)` 是 **130 的处理函数**
 * （`a_2179.as:891`），它在 `TDGame2V2BattleUI.as:1035-1036` 对两个战场都调
 * `BattleFieldView.a_3435()`，而那个函数 `:1643-1648` 正是
 * `a_1066 = 0; … a_1064 = getTimer()` —— 即 **tick 0 = 客户端处理 130 的那一刻**。
 * 而 `iTimeIntervalNum` = `int((getTimer() - a_1064) / 50)`（`:2078`）⇒ 50ms 一 tick，
 * 服务端用"推 130 的墙钟"当 t0 即可（误差 ≤ 几毫秒，而第一波在 3s 之后）。
 */
export function buildNextWavePayload({
  ratHoleCount = 0,
  ratHole = 1,
  waveProgress = 100,
  waveStatus = 0,
  enemies = [],
}) {
  const head = Buffer.alloc(6);
  head.writeInt8(ratHoleCount | 0, 0);
  head.writeInt8(ratHole | 0, 1);
  head.writeInt8(waveProgress | 0, 2);
  head.writeInt8(waveStatus | 0, 3);
  head.writeInt16BE(enemies.length, 4);
  const parts = [head];
  for (const e of enemies) {
    const b = Buffer.alloc(13);
    b.writeUInt16BE(e.seq & 0xffff, 0);
    b.writeUInt32BE(e.typeID >>> 0, 2);
    b.writeUInt8(e.appearType & 0xff, 6);
    b.writeUInt8(e.row & 0xff, 7);
    b.writeUInt8(e.appearFlag & 0xff, 8);
    b.writeUInt32BE(e.tick >>> 0, 9);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

/** 132 体长度公式：6 + 13N（供断言/日志复用）。 */
export const nextWavePayloadLength = (enemyCount) => 6 + 13 * enemyCount;

/**
 * 生成整局的出怪表（纯函数、种子决定）。
 *
 * 波数用 130 同一个 `TOTAL_INTRUDER_WAVE_NUM`（显示与出怪一致，省得再对两份数）。
 * 每波数量 4+波序（第一波 5 只，往后递增），行号在 `0..行数-1` 里随机，
 * `m_byAppearFlag` 给 1..鼠洞数（客户端 `a_3429(flag % a_3425())` 取洞）。
 */
export function battleWavePlan({
  seed = battleState.seed,
  mapID = roomState.mapID,
  totalWaveNum = TOTAL_INTRUDER_WAVE_NUM,
} = {}) {
  const { mice, source } = resolveWaveMice(mapID);
  const rows = battleRowCount(mapID);
  const rand = seededRandom(seed);
  const waves = [];
  let seq = 1;
  for (let w = 1; w <= totalWaveNum; w += 1) {
    const startTick = WAVE_START_TICK + (w - 1) * WAVE_GAP_TICKS;
    const count = 4 + w;
    const enemies = [];
    for (let j = 0; j < count; j += 1) {
      enemies.push({
        seq: seq++,
        typeID: mice[Math.floor(rand() * mice.length) % mice.length],
        appearType: WAVE_APPEAR_TYPE,
        row: Math.floor(rand() * rows) % rows,
        appearFlag: 1 + (Math.floor(rand() * WAVE_HOLE_COUNT) % WAVE_HOLE_COUNT),
        tick: startTick + j * WAVE_SPAWN_GAP,
      });
    }
    waves.push({
      wave: w,
      total: totalWaveNum,
      startTick,
      ratHoleCount: WAVE_HOLE_COUNT,
      ratHole: 1,
      enemies,
    });
  }
  return { waves, mice, mouseSource: source, rows };
}

let waveTimer = null;

/** 停掉本局的出怪定时器（换局/离开房间时必须调，否则旧连接会被继续写）。 */
export function stopWavePushes() {
  if (waveTimer !== null) {
    clearInterval(waveTimer);
    waveTimer = null;
  }
}

/**
 * 130 推出去之后接着当"帧源"：按 tick 表把 132 逐波推给客户端。
 *
 * ⚠ 必须在 130 **之后**（`TDGame2V2BattleUI.a_3435` 才会把 `a_1118/a_1119` 设好，
 * 先发 132 会让 `a_3564` 里 `m_iWaveNum % a_1119` 变成 `% 0` ⇒ NaN 指示条）。
 */
export function startWavePushes(socket, sessionKey, log = () => {}) {
  stopWavePushes();
  const plan = battleWavePlan();
  const t0 = Date.now();
  let next = 0;
  let notifySeq = 2; // 0/1 已被 129/130 占用
  log(
    `出怪表：${plan.waves.length} 波 / 鼠表 ${plan.mouseSource} ` +
      `[${plan.mice.map((m) => "0x" + m.toString(16).padStart(4, "0")).join(",")}] / 行 0..${plan.rows - 1} ` +
      `(conn remotePort=${socket.remotePort ?? "-"})`,
  );
  waveTimer = setInterval(() => {
    if (!socket.writable) {
      stopWavePushes();
      return;
    }
    const elapsedTicks = (Date.now() - t0) / 50;
    while (next < plan.waves.length && plan.waves[next].startTick <= elapsedTicks) {
      const w = plan.waves[next];
      next += 1;
      const body = buildNextWavePayload({
        ratHoleCount: w.ratHoleCount,
        ratHole: w.ratHole,
        waveProgress: 100, // 每波推满 ⇒ a_3564 把波数 +1（指示条按波前进）
        waveStatus: 0,
        enemies: w.enemies,
      });
      socket.write(
        buildGameDataNotifyPacket(sessionKey, {
          roomID: battleState.roomID,
          tableID: battleState.tableID,
          events: [{ seq: notifySeq++, data: Buffer.concat([Buffer.from([132]), body]) }],
        }),
      );
      log(
        `-> L1 8711(CNotifyGameData) NextEnmeyWave pushed: 波 ${w.wave}/${w.total} ` +
          `${w.enemies.length} 只 tick=${w.startTick}..${w.enemies[w.enemies.length - 1].tick} 体=${body.length}B`,
      );
    }
    if (next >= plan.waves.length) stopWavePushes();
  }, 100);
  waveTimer.unref?.();
}

/**
 * 客户端只发不问的心跳 / 埋点 / 日志上报：服务端无需（也不应）应答，
 * 登记在这里即可避免被当成"未处理报文"持续刷日志。
 */
export const NO_REPLY_MSGIDS = new Map([
  [8453, "LOGIC_HEARTBEAT"], // CRequestClientLogicHearbeat，逻辑服 30s 一次
  [14612, "REPORT_GAME_STAT"], // a_2676 客户端状态上报（a_2377）
  [14744, "TRANSFER_CLIENT_LOG"], // a_2824 客户端日志上报（RequestTransferClientLog）
]);

const BLOCK_BYTES = 8;

/**
 * a_1774 的填充规则：块 0 = [头字节(低位=padLen)][padLen 随机字节][开头数据]，
 * 中间块为数据，末块 = [最后一个数据字节][7 个 0]。解码端据此还原长度。
 */
export function padPlaintext(data) {
  const length = data.length;
  const padLength = (BLOCK_BYTES - (length % BLOCK_BYTES)) % BLOCK_BYTES;
  const firstDataBytes = BLOCK_BYTES - 1 - padLength;
  const middleBytes = length - firstDataBytes - 1;
  const padded = Buffer.alloc(BLOCK_BYTES * (2 + middleBytes / BLOCK_BYTES));
  padded[0] = Math.floor(Math.random() * 256) & 0xf8 | padLength;
  for (let i = 0; i < padLength; i += 1)
    padded[1 + i] = Math.floor(Math.random() * 256);
  data.copy(padded, 1 + padLength, 0, firstDataBytes);
  data.copy(padded, BLOCK_BYTES, firstDataBytes, firstDataBytes + middleBytes);
  padded[padded.length - BLOCK_BYTES] = data[length - 1];
  return padded;
}

/** a_1774 的等价实现（已用 1.6 MB 真实密文逐字节验证）。 */
export function xteaEncrypt(plain, key, N) {
  if (plain.length % BLOCK_BYTES !== 0)
    throw new RangeError(`xteaEncrypt requires a padded input (got ${plain.length} bytes)`);
  const out = Buffer.alloc(plain.length);
  const blocks = plain.length / BLOCK_BYTES;
  teaBlock(plain, 0, out, 0, key, N);
  for (let b = 1; b < blocks; b += 1) {
    const src = Buffer.alloc(BLOCK_BYTES);
    for (let i = 0; i < BLOCK_BYTES; i += 1)
      src[i] = plain[b * BLOCK_BYTES + i] ^ out[(b - 1) * BLOCK_BYTES + i];
    teaBlock(src, 0, out, b * BLOCK_BYTES, key, N);
    for (let i = 0; i < BLOCK_BYTES; i += 1)
      out[b * BLOCK_BYTES + i] ^= plain[(b - 1) * BLOCK_BYTES + i];
  }
  return out;
}

/** a_2664.encode_string：写 UTF（int16 字节长度 + UTF-8 字节，含结尾 NUL）。 */
function encodeString(value, maxLength) {
  let text = value ?? "";
  if (text.length >= maxLength) text = text.slice(0, maxLength - 1);
  const bytes = Buffer.from(`${text}\0`, "utf8");
  const head = Buffer.alloc(2);
  head.writeInt16BE(bytes.length, 0);
  return Buffer.concat([head, bytes]);
}

const int16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(v, 0);
  return b;
};
const int32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v, 0);
  return b;
};

/**
 * a_2663 成功应答：resultID=0 → UIN / account / userType / 16 字节会话密钥 /
 * 签名长度 + 签名。随后整段（前置 sequence）用登录密钥加密。
 */
function buildAuthResponse({ account, userType, sequence, sessionKey, signature }) {
  const body = Buffer.concat([
    int16(0),
    int32(PLAYER_UIN),
    encodeString(account, 64),
    int16(userType),
    sessionKey,
    int16(signature.length),
    signature,
  ]);
  return xteaEncrypt(
    padPlaintext(Buffer.concat([int32(sequence), body])),
    LOCAL_KEY,
    32,
  );
}

/** 服务端 → 客户端不分帧 httpHead；shFlag=4 让客户端走解密分支（-32 轮）。 */
export function buildPacket({ messageId, version, uin, playerId, flag, payload }) {
  const headerLength = 24;
  const head = Buffer.alloc(headerLength);
  head.writeInt32BE(headerLength + payload.length, 0);
  head.writeInt32BE(uin, 4);
  head.writeInt16BE(flag, 8);
  head.writeInt16BE(0, 10);
  head.writeInt16BE(headerLength, 12);
  head.writeInt16BE(messageId, 14);
  head.writeInt16BE(1, 16);
  head.writeInt16BE(version, 18);
  head.writeInt32BE(playerId, 20);
  return Buffer.concat([head, payload]);
}
/**
 * 实测证据（用于校准 docs/battle-protocol.md §18.7 的 pkgLen 口径）：
 * 本函数不写 httpHead，且 pkgLen = 24 + payload。此路径已实测可让客户端完成
 * 认证→大厅→逻辑登录，说明 **服务端下行报文的真实口径是「不含 httpHead、24 字节头」**。
 *
 * ★ 2026-10-14 更正：`frame-codec.mjs` 的 `encodeHeader` **此前默认多写了 1 字节 httpHead**
 *   （它照抄的是客户端上行 a_2670.encode 的口径），使 encodeGameFrame 产出 25 字节头。
 *   这会让客户端把 nPackageLength 读错 —— 证据：客户端收到数据后
 *   `a_1779.as:84 packageBytes.position = 0;` → `a_2220.a_2204` → `a_2670.decode`
 *   （`a_2670.as:59-73` 从 nPackageLength 开始读，**不读 httpHead**）。
 *   现已把 encodeHeader 的 httpHead 默认改为 false（服务端下行口径），
 *   上行口径需显式 `httpHead: true`；run-frame-test.mjs §3 固化该不对称。
 */

/**
 * 构造并推送 L2 战斗开局报文（b_102 命令号空间）。
 *
 * 与 L1 报文的关键差异（见 docs/battle-protocol.md §18.6）：
 *   - 外层是 `[httpHead 1B][a_2670 头 24B]`，比 buildPacket 多那 1 字节；
 *   - 头部 shMessageID 恒为 8709（b_154.a_152，游戏数据通道），不是 L1 命令号；
 *   - 加密区内还要套 a_2926 包装。
 */
export function buildL2Frame({ sessionKey, seq, cmd, body, roomID, tableID }) {
  return encodeGameFrame({
    seq,
    roomID: roomID ?? roomState.roomID ?? -1,
    tableID: tableID ?? roomState.tableID ?? -1,
    cmd,
    body: body ?? Buffer.alloc(0),
    uin: PLAYER_UIN,
    flag: 4, // 与 buildPacket 一致：让客户端走 -32 轮解密
    version: 3,
    playerID: PLAYER_UIN,
    key: sessionKey,
    lenIncludesHttpHead: false, // 见上方实测证据
  });
}

/**
 * ★★ 2026-10-16 关键更正：**服务端主动下发的"游戏数据"根本不是走 8709**。
 *
 * 反编译实证（这是"129/130/131 从未生效"的真正原因）：
 *   - 客户端收到 **8709**（`b_154.a_152`）时走的是 `b_177.a_2624`：
 *     它只 `new a_2951()` 解出 `m_nResultID / roomID / tableID`，
 *     **函数体是空的 —— L2 载荷被直接丢弃**（那是客户端自己 `SEND_GAME_DATA` 上行的应答）。
 *     ⇒ 我们此前把 129/130/131 塞进 8709 推下去，客户端全当"上行应答"扔了。
 *   - 真正的下发通道是 **8711**（`b_154.a_154`）→ `b_178.a_2639` → `CNotifyGameData(a_2903)`：
 *     `int32 m_iRoomID | int32 m_iTableID | int16 m_nEventCount |
 *      m_nEventCount × CGameEvent{ int32 m_iGameEventSequence | int32 m_iGameDataLength | bytes }`
 *     其中每个 event 的 `m_szGameData` 就是**裸的 L2 载荷**（首字节 = 命令号，
 *     如 129/130/131，后面跟随该命令的协议体），客户端把它交给
 *     `a_2445.a_2456 → a_2464 → a_2187.a_1842 → a_2053.a_2055` 做命令分发。
 *   - 注意 `a_2639` 会按 `(serverID, roomID)` 找 `a_2445` 实例，**roomID 必须与客户端
 *     当前坐下房间一致**（`a_2445.getLobbyAdapterHandlerByConnInfo` ），否则打
 *     "lobbyHandler is null" 丢弃。
 *
 * 顺带印证：客户端自己往战斗模块注入数据时（`b_177.as:449-454`）也是走同一个内部例程 id
 * （`b_101.a_487` → `a_2468` → `a_1842`），只是数据来自本地而非网络。
 */
export function buildGameDataNotifyBody({ roomID, tableID, events }) {
  const parts = [int32(roomID), int32(tableID), int16(events.length)];
  for (const ev of events) {
    const data = ev.data ?? Buffer.alloc(0);
    parts.push(int32(ev.seq ?? 0), int32(data.length), data);
  }
  return Buffer.concat(parts);
}

/** 8711 CNotifyGameData：把 L2 载荷包成一条"游戏数据通知"推给客户端。 */
export function buildGameDataNotifyPacket(sessionKey, { roomID, tableID, events }) {
  return buildPacket({
    messageId: 8711, // b_154.a_154 = CNotifyGameData
    version: 3,
    uin: PLAYER_UIN,
    playerId: PLAYER_UIN,
    flag: 4,
    // 与已验证可用的 PLAYER_COMMON 推送同口径：密文前的 4 字节 sequence 0
    payload: xteaEncrypt(
      padPlaintext(Buffer.concat([int32(0), buildGameDataNotifyBody({ roomID, tableID, events })])),
      sessionKey,
      32,
    ),
  });
}

export const L1_GAME_DATA_NOTIFY = 8711;
const POLICY =
  '<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" to-ports="*"/>' +
  "</cross-domain-policy>\0";

/* ------------------------------------------------------------------ *
 * 服务器列表：把地址改成本地
 * ------------------------------------------------------------------ */

const localServerList = (port = GAME_PORT, extra = "") =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Servers xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="ServerList.xsd">\n` +
  `  <Server ID="1" IP="127.0.0.1" Port="${port}"${extra} />\n</Servers>\n`;

const CONFIG_DATA_DIR = path.join(CACHE, "config-data");

/**
 * LoadFilesList.xml 原文是 gzip 的。除了原样返回，还把所有 config.data 内的
 * 数据文件补成 ConfigFile 项：loaderDataInit 会把它们按 HTTP 加载结果写进字典，
 * 从而绕开压缩包解出为空的问题（zip 里 64 个 XML 全部补上）。
 */
function loadFilesList() {
  const raw = fs.readFileSync(path.join(CACHE, "LoadFilesList.xml"));
  const text = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
  let xml = text.toString("utf8");

  /**
   * ★★ 2026-10-16：把**日志器覆盖件**插到 `<SWFFile>` 的**第一条**，让它在 TDCore 之前注册。
   *
   * 依据：`TDLoaderUI.as:582` 加载每个模块都用 `new LoaderContext(false,
   * ApplicationDomain.currentDomain)` —— 全部进**同一个 ApplicationDomain**。
   * 同一个域里**先定义者胜**，所以只要我们先注册 `a_4788.a_4648`（客户端内部日志器），
   * TDCore 里同名的那份就会被忽略，全客户端（含 TDCore 自己那些 `Game: …` 诊断）
   * 的日志都改走我们这份（HTTP `/__trace`，而不是那条在 PPAPI Flash 里不投递的
   * LocalConnection `_debugConnection`）。详见 tools/logger_patch/LoggerBoot.hx。
   *
   * 兜底思路：即使顺序没按预期（或"后定义者胜"），本覆盖件的公开成员与 TDCore 那份
   * **同名同签名**，客户端行为与原来一致，不会更糟 —— 开关 `REA_LOGGER_PATCH=0`。
   */
  if (process.env.REA_LOGGER_PATCH !== "0" && !xml.includes('name="RealLogger"')) {
    xml = xml.replace(
      /(<SWFFile[^>]*>)/,
      `$1\n    <Item id="0x0F01" name="RealLogger" url="logger_patch.swf" version="rea1" descript="客户端内部日志转 HTTP" />`,
    );
    console.log("[fileslist] 已把日志器覆盖件 RealLogger(logger_patch.swf) 插到 SWFFile 首位");
  }

  const existing = new Set();
  const configSection = xml.slice(0, xml.indexOf("</ConfigFile>"));
  for (const m of configSection.matchAll(/name="([^"]+)"/g)) existing.add(m[1]);

  if (fs.existsSync(CONFIG_DATA_DIR)) {
    /**
     * ⚠ 注入条目的 `version` 必须**非 0**：实测 `version="0"` 的条目会被客户端当成
     * "未变更"跳过，连请求都不发 —— `world_roaming.xml` 就是这样被跳过的
     * （证据：整个 server.log 里客户端从未 GET 过 `/config/world_roaming.xml`），
     * 于是 `WorldRoamingXML.m_vWorldRoamingData` 永远为空 ⇒ `GetMapIDByType` 返回 0
     * ⇒ 世界漫游 UI 抛 "map_mouse.xml配置中不存在 地图id前缀为 0x0的地图"，
     * 而该异常会占用客户端"全局未捕获异常"的一次性名额，把战斗里真正的异常挡在后面。
     */
    const INJECT_VERSION = "rea1";
    const extra = fs
      .readdirSync(CONFIG_DATA_DIR)
      .filter((name) => !existing.has(name))
      .map(
        (name, i) =>
          `    <Item id="0x9${String(i).padStart(3, "0")}" name="${name}" url="${name}" version="${INJECT_VERSION}" />`,
      );
    // 原始列表里已有、但客户端字典里取不到的条目，再注入一次（重复项后写覆盖）
    for (const forced of ["dog_card.xml", "diy.xml", "map_mouse4.xml"]) {
      extra.push(
        `    <Item id="0xA${String(extra.length).padStart(3, "0")}" name="${forced}" url="${forced}" version="${INJECT_VERSION}" />`,
      );
    }
    if (extra.length > 0) {
      xml = xml.replace(
        "</ConfigFile>",
        `${extra.join("\n")}\n  </ConfigFile>`,
      );
      console.log(`[fileslist] injected ${extra.length} extra config items`);
    }
  }
  return Buffer.from(xml, "utf8");
}

/* ------------------------------------------------------------------ *
 * 启动页
 * ------------------------------------------------------------------ */

const FLASHVARS = {
  base_url: "", // 全部资源都在站点根，相对路径即可
  v: "1",
  /**
   * ⚠ 2026-10-16 回退说明：曾把这里改成 `joyyou`，为的是让 `TDCore.a_2234` 注册
   * 全局未捕获异常监听（`TDCore.as:102-106` 的注册被 `sitetype == "joyyou"` 门控，
   * 该监听会把 `err.getStackTrace()` POST 到 `TDErrorCatch.UploadError` 的地址，
   * 已由 `server/patch-upload-error.cjs` 改指本机 `/log`）。
   * **但实测在 joyyou 平台下合成屋 / 背包出现异常**，而 4399 一直是可用的，
   * 因此默认回到 4399；要看客户端异常时再临时 `REA_SITETYPE=joyyou node server/local-server.mjs`
   * （用下面这行读取环境变量，不必改代码）。
   */
  /**
   * ⚠ 2026-10-16 二次结论：之前把合成屋/背包的异常归到 joyyou 平台上是**误判** ——
   * 那次真正的原因是"一局没加载完的战斗"残留状态，F5 后就恢复了（用户实测）。
   * 所以这里恢复默认 `joyyou`：它会让客户端注册全局未捕获异常监听，
   * 把 `err.message/getStackTrace()` POST 到本机 `/log`（见 TDErrorCatch + patch-upload-error.cjs），
   * 这是排查"界面空白/卡进度"这类只在客户端复现的问题的关键通道。
   * 要回 4399 平台就 `REA_SITETYPE=4399`。
   */
  sitetype: process.env.REA_SITETYPE ?? "joyyou",
  sig_user: "localplayer",
  sig_session_key: "local-session-key",
  myopenkey: "",
  group_id: "1",
  gateway_ip: "127.0.0.1",
  gateway_port: String(GAME_PORT),
  current_time: String(Math.floor(Date.now() / 1000)),
  ext_sign: "",
  TotalVersion: "1",
  first_time: "1",
  is_vip: "0",
  is_year_vip: "0",
  vip_level: "0",
  pfkey: "",
  pf: "",
  fm: "0",
  fcm: "0",
  prove_gift: "",
};

const flashvarsQuery = new URLSearchParams(FLASHVARS).toString();

/**
 * 启动页。
 *
 * ⚠ 2026-10-16：**必须把 950x600 的画布按窗口自适应缩放**，否则「准备界面」右下角的
 *   「开始」按钮落在可视区之外 —— 实测窗口 1200x525、画布从 y=116 开始，600 高的画布
 *   底部约 200px 被窗口下沿裁掉（`_screen.png` 逐像素量过），玩家根本点不到「开始」，
 *   于是从来没有 cmd1(PostSelectedCards) 上行 ⇒ 服务端永远不推 129 ⇒ 客户端载入进度
 *   停在 99%（`a_2179.as:1670` 的早期返回）。见 docs/battle-replica-plan.md §7.0。
 *   这条 CSS 原先写的是 `#wrap{display:flex;justify-content:center;padding:12px}`（不缩放），
 *   在 1536x864 屏幕 + 1200x525 游戏窗口下必然裁掉画布底部。
 */
const GAME_VIEW_W = 950;
const GAME_VIEW_H = 600;

const INDEX_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>美食大战老鼠 — 本地单机</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#111;color:#ccc;font:13px/1.6 monospace}
/* ⚠ 不要用 inset:0 简写：FCBrowser 是 Chromium 83（UA: Chrome/83.0.4103.97），
   inset 是 Chrome 87 才有的 —— 用了它这里会退化成"盒子按内容尺寸贴在左上角"，
   画布就不居中了。老实用 top/right/bottom/left。 */
#wrap{position:fixed;top:0;right:0;bottom:0;left:0;display:flex;align-items:center;justify-content:center}
#game,#gameEmbed{display:block}
#log{position:fixed;left:0;top:0;max-width:46vw;max-height:30vh;overflow:auto;white-space:pre-wrap;
     padding:2px 6px;background:rgba(0,0,0,.55);color:#9cf;font-size:11px;pointer-events:none}</style></head>
<body>
<div id="wrap">
  <object id="game" type="application/x-shockwave-flash" width="${GAME_VIEW_W}" height="${GAME_VIEW_H}"
          data="/TDLoaderUI.swf?${flashvarsQuery}">
    <param name="movie" value="/TDLoaderUI.swf?${flashvarsQuery}" />
    <param name="allowScriptAccess" value="always" />
    <param name="allowNetworking" value="all" />
    <param name="wmode" value="window" />
    <embed id="gameEmbed" type="application/x-shockwave-flash" width="${GAME_VIEW_W}" height="${GAME_VIEW_H}"
           src="/TDLoaderUI.swf?${flashvarsQuery}"
           allowScriptAccess="always" allowNetworking="all" wmode="window" />
  </object>
</div>
<div id="log">waiting for the SWF…</div>
<!-- 客户端内部日志接收器（同域才收得到 LocalConnection）；1x1 隐藏，不影响游戏 -->
<div id="trace" style="position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden">
  <object type="application/x-shockwave-flash" width="1" height="1" data="/trace_receiver.swf">
    <param name="movie" value="/trace_receiver.swf" />
    <param name="allowScriptAccess" value="always" />
    <param name="allowNetworking" value="all" />
  </object>
</div>
<script>
// —— 画布自适应：把 950x600 的舞台等比缩放到窗口内，保证右下角按钮（如「开始」）永远可点 ——
var GAME_W = ${GAME_VIEW_W}, GAME_H = ${GAME_VIEW_H};
function fitGame() {
  var el = document.getElementById("game") || document.getElementById("gameEmbed");
  if (!el) return null;
  // 逃生开关：URL 里带 fit=0 时不做任何缩放（用于 A/B 排查"缩放是否影响拖拽/点击"）
  if (location.search.indexOf("fit=0") !== -1) {
    el.style.width = GAME_W + "px";
    el.style.height = GAME_H + "px";
    return { vw: window.innerWidth, vh: window.innerHeight, s: 1 };
  }
  var vw = window.innerWidth || document.documentElement.clientWidth;
  var vh = window.innerHeight || document.documentElement.clientHeight;
  var s = Math.min(vw / GAME_W, vh / GAME_H, 1); // 只缩不放，避免大屏上被拉糊
  if (!isFinite(s) || s <= 0) return null;
  el.style.width = Math.floor(GAME_W * s) + "px";
  el.style.height = Math.floor(GAME_H * s) + "px";
  return { vw: vw, vh: vh, s: Math.round(s * 1000) / 1000 };
}
window.addEventListener("resize", function () { fitGame(); });
fitGame();
for (var fi = 1; fi <= 20; fi++) setTimeout(fitGame, fi * 500);
</script>
<script>
// —— 自诊断：把浏览器内部状态回报给本地服务器，便于无界面排查 ——
function diag(k, v) {
  try { new Image().src = "/__diag?" + encodeURIComponent(k) + "=" + encodeURIComponent(String(v)) + "&t=" + Date.now(); } catch (e) {}
}
// 画布几何：以后排查"按钮点不到"这类问题，先看这行数字
function diagGeom(tag) {
  var g = fitGame();
  var el = document.getElementById("game") || document.getElementById("gameEmbed");
  var r = null;
  try { r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null; } catch (e) {}
  diag("geom", tag + " inner=" + window.innerWidth + "x" + window.innerHeight +
    " dpr=" + (window.devicePixelRatio || 1) +
    " scale=" + (g ? g.s : "?") +
    " rect=" + (r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(",") : "none") +
    " scroll=" + (document.scrollingElement ? document.scrollingElement.scrollHeight + "/" + document.scrollingElement.clientHeight : "?"));
}
setTimeout(function () { diagGeom("t=0.5s"); }, 500);
setTimeout(function () { diagGeom("t=4s"); }, 4000);
// 画布起来之后把左上角的诊断条收掉，别挡画面（内容本身已经回报到服务端日志里）
setTimeout(function () {
  var l = document.getElementById("log");
  if (l) l.style.display = "none";
}, 6000);
window.addEventListener("error", e => diag("jserror", e.message));
diag("page-load", "ua=" + navigator.userAgent + " flashMime=" + !!(navigator.mimeTypes && navigator.mimeTypes["application/x-shockwave-flash"]));
function pluginInfo() {
  const names = [];
  for (let i = 0; i < navigator.plugins.length; i++) {
    const p = navigator.plugins[i];
    names.push(p.name + " (" + p.filename + ")");
  }
  const flashMime = !!(navigator.mimeTypes && navigator.mimeTypes["application/x-shockwave-flash"]);
  return "plugins=[" + names.join(" | ") + "] flashMime=" + flashMime + " ua=" + navigator.userAgent;
}
function swfState(label) {
  const el = document.getElementById("game") || document.getElementById("gameEmbed");
  let s = label + " el=" + (el ? el.tagName : "none");
  try { s += " PercentLoaded=" + el.PercentLoaded(); } catch (e) { s += " PercentLoaded=err:" + e.message; }
  try { s += " version=" + el.GetVariable("$version"); } catch (e) { s += " version=err:" + e.message; }
  // openBlueDiamondBack 由大厅 UI 在初始化成功后才注册，可当作进度探针
  s += " lobbyCallback=" + (typeof el.openBlueDiamondBack === "function");
  diag("swf", s);
}
setTimeout(() => { diag("plugins", pluginInfo()); swfState("t=3s"); }, 3000);
setTimeout(() => swfState("t=8s"), 8000);
setTimeout(() => swfState("t=16s"), 16000);

// 官方宿主页面在加载完成后会调用 SWF 的 a_2234(parameters) 触发登录
// （sitetype=4399 时账号与密码都用 sig_user）。我们要扮演这个宿主。
function findSwf() {
  return document.getElementById("gameEmbed") || document.getElementById("game");
}
function tryLogin(attempt) {
  const el = findSwf();
  if (el && typeof el.a_2234 === "function") {
    try {
      el.a_2234({
        sitetype: "4399",
        sig_user: "localplayer",
        sig_session_key: "local-session-key",
        myopenkey: "",
        pf: "",
        platform_id: "4399",
        fm: "0",
        fcm: "0",
      });
      diag("login", "a_2234 invoked at attempt " + attempt);
    } catch (e) {
      diag("login-error", e.message);
    }
    return;
  }
  if (attempt === 1 || attempt % 10 === 0) diag("login-wait", "attempt=" + attempt + " hasSwf=" + !!el);
  if (attempt < 60) setTimeout(() => tryLogin(attempt + 1), 500);
  else diag("login-failed", "a_2234 never became callable");
}
setTimeout(() => tryLogin(1), 2500);
</script>
</body></html>
`;

/* ------------------------------------------------------------------ *
 * HTTP 服务
 * ------------------------------------------------------------------ */

/** 生成文件优先，其次回落到 client-cache 的真实文件。 */
/**
 * ★ 2026-10-16：给 `map_mouse.xml` **补一条合成地图的条目**。
 *
 * 我们把单机战斗改道到合成地图（`resolveBattleMapID`，绕开新版地图 SWF 与老客户端
 * `BaseGameMap` 不兼容），但客户端不少地方仍按 `a_2037.m_dictMapMouse[mapID]` 取地图信息
 * （准备界面的钥匙/老鼠/缩略图等）。合成地图不在 `map_mouse.xml` 里 ⇒ 取到 null ⇒
 * 实测就会出现 `/images/head/otherKey/.png`（空名 404）这种怪现象，
 * 也可能让战场初始化半途而废。
 *
 * 这里在原始 map_mouse.xml 末尾**追加克隆条目**：克隆一张结构自洽的普通地图
 * （`replaceRule()` 会校验 MouseID/MousePoint/MouseGamePoint 三者数量一致，克隆可保证），
 * 只改 `MapID` 与 `MapName`。两类目标：
 *   1) 战斗改道用的合成地图（`0x50010301`）；
 *   2) **`world_roaming.xml` 里出现的每一个 `map_id`** —— 这条更关键：
 *      `WorldRoamingXML.a_2040()`（`decompiled/TDHuoShanUI/.../WorldRoamingXML.as:104-141`）
 *      逐个 `CheckMapID()`，**只要有一个 map_id 不在 map_mouse.xml 里就抛
 *      "map_mouse.xml 没有该地图ID：0x…"，整份解析半途而废**（`m_vWorldRoamingData` 只填一半）。
 *      接着 `GetMapIDByType(0x42000000)` 返回 0，世界漫游 UI
 *      （`TDHuoShanUI.as:139-152`）就抛用户实测看到的那条
 *      "map_mouse.xml配置中不存在 地图id前缀为 0x0的地图"；
 *      而该异常发生在**大厅初始化链**里，还是客户端"全局未捕获异常"上报的**一次性名额**，
 *      会把战斗里真正的异常挡在后面 ⇒ 必须先在数据层消灭它。
 */
let mapMouseCompositeCache = null;

/** 收集 `world_roaming.xml` 里所有 `map_id="0x…"`。 */
/**
 * ★ 2026-10-16：**改写 `world_roaming.xml` 的 `map_id`**，让每个 id 都能在
 * `map_mouse.xml` 里找到 —— 这是"干掉世界漫游报错"的安全做法。
 *
 * 为什么这么绕：`WorldRoamingXML.a_2040()` 会对每个 `map_id` 调 `CheckMapID()`，
 * 只要有一个不存在就抛异常、**整份解析中断**（`m_vWorldRoamingData` 只填一半）；
 * 之后 `GetMapIDByType(0x42000000)` 返回 0，`TDHuoShanUI.as:139-152` 又抛
 * "map_mouse.xml配置中不存在 地图id前缀为 0x0的地图"。
 * 该异常发生在**大厅初始化链**里，并且会占用客户端"全局未捕获异常"的**一次性名额**
 * ⇒ 战斗里真正的异常永远报不出来（这正是我们看不到卡 99 原因的直接障碍）。
 *
 * ⚠ 上一次我试的是"往 map_mouse.xml **加**条目"，结果客户端**启动的配置解析**直接中止
 * （页面/SWF 都加载、lobbyCallback=false、一条 TCP 登录都没有）。所以改成：
 * **只改 world_roaming.xml 的 map_id**（数量不变、结构不变），缺失的指向一张已验证存在的地图。
 */
let worldRoamingPatchedCache = null;

function worldRoamingXmlPatched() {
  if (worldRoamingPatchedCache !== null) return worldRoamingPatchedCache;
  const file = path.join(CONFIG_DATA_DIR, "world_roaming.xml");
  let xml = fs.readFileSync(file, "utf8");
  const mouse = fs.readFileSync(path.join(CONFIG_DATA_DIR, "map_mouse.xml"), "utf8");
  // 用**规范化字符串**比较（8 位大写十六进制），和自检脚本同一口径，避免数值/大小写口径打架
  const norm = (v) => {
    const n = Number.parseInt(v, v.toLowerCase().startsWith("0x") ? 16 : 10);
    return Number.isFinite(n) ? "0X" + (n >>> 0).toString(16).toUpperCase() : null;
  };
  const have = new Set();
  for (const m of mouse.matchAll(/MapID="(0x[0-9a-fA-F]+|[0-9]+)"/g)) {
    const k = norm(m[1]);
    if (k !== null) have.add(k);
  }
  const fallbackKey = have.has("0X3") ? "0X3" : [...have][0] ?? "0X3";
  let changed = 0;
  xml = xml.replace(/map_id="(0x[0-9a-fA-F]+|[0-9]+)"/g, (whole, v) => {
    const k = norm(v);
    if (k !== null && have.has(k)) return whole;
    changed += 1;
    return `map_id="${fallbackKey.toLowerCase().replace(/^0x/i, "0x")}"`;
  });
  console.log(
    `[worldroaming] 改写了 ${changed} 个 map_mouse 里不存在的 map_id → ` +
      `${fallbackKey.replace(/^0X/i, "0x")}（让 CheckMapID 不再中断解析）`,
  );
  worldRoamingPatchedCache = Buffer.from(xml, "utf8");
  return worldRoamingPatchedCache;
}

function worldRoamingMapIds() {
  const set = new Set();
  try {
    const xml = fs.readFileSync(path.join(CONFIG_DATA_DIR, "world_roaming.xml"), "utf8");
    for (const m of xml.matchAll(/map_id="(0x[0-9a-fA-F]+|[0-9]+)"/g)) {
      const id = Number.parseInt(m[1], m[1].startsWith("0x") ? 16 : 10);
      if (Number.isFinite(id) && id !== 0) set.add(id >>> 0);
    }
  } catch (e) {
    console.log(`[mapmouse] 读取 world_roaming.xml 失败：${e.message}`);
  }
  return set;
}

function mapMouseXmlWithComposite() {
  if (mapMouseCompositeCache !== null) return mapMouseCompositeCache;
  const file = path.join(CONFIG_DATA_DIR, "map_mouse.xml");
  let xml = fs.readFileSync(file, "utf8");
  const template = xml.match(/<item\b[^>]*MapID="0x0*1"[^>]*>/);
  if (template === null) {
    console.log("[mapmouse] ⚠ 找不到可克隆的 0x0001 条目，无法补条目");
    mapMouseCompositeCache = Buffer.from(xml, "utf8");
    return mapMouseCompositeCache;
  }
  const hex = (id) => "0x" + (id >>> 0).toString(16).toUpperCase().padStart(8, "0");
  /**
   * ⚠ 2026-10-16 实测教训：**往 map_mouse.xml 里"补条目"这条路会直接把客户端打挂** ——
   * 加了 world_roaming 那 34 个 map_id 后，客户端在启动的配置解析阶段就中止
   * （现象：页面/SWF 都加载、`lobbyCallback=false`、**一条 TCP 登录都没有**）。
   * 所以默认只补**合成地图那一条**（这条验证过不影响启动）。
   * 世界漫游那条要走"改 world_roaming.xml 的 map_id 指到已存在的地图"（见下），
   * 用 `REA_PATCH_MAPMOUSE_ROAMING=1` 才启用补条目（仅供复现/实验）。
   */
  const targets = [{ id: COMPOSITE_MAP_ID >>> 0, name: "古堡初探" }];
  if (process.env.REA_PATCH_MAPMOUSE_ROAMING === "1") {
    for (const id of worldRoamingMapIds()) targets.push({ id, name: "世界漫游" });
  }
  for (const t of targets) {
    const key = `MapID="${hex(t.id)}"`;
    if (xml.includes(key)) continue;
    const clone = template[0]
      .replace(/MapID="0x0*1"/, key)
      .replace(/MapName="[^"]*"/, `MapName="${t.name}"`);
    xml = xml.replace(/(\s*)<\/MapMouse>/, `\n\t${clone}\n$1</MapMouse>`);
  }
  console.log(
    `[mapmouse] 已补齐 ${targets.length} 条目标地图条目（合成地图 + world_roaming 全部 map_id）`,
  );
  /**
   * ⚠ 这里必须兜异常：`fixCompositeDefCards` 里会读 card_desc/CardFusion 算"玩家有哪些卡"，
   * 任何一步抛出去都会把 `/config/map_mouse.xml` 这条路由打断（客户端直接连接被重置、
   * 表现为**整个客户端起不来**）。默认卡组只是"锦上添花"，绝不能连累配置下发。
   */
  try {
    xml = fixCompositeDefCards(xml);
  } catch (e) {
    console.log(`[defcards] ⚠ 默认卡组修正失败（已忽略，配置照旧下发）：${e.message}`);
  }
  mapMouseCompositeCache = Buffer.from(xml, "utf8");
  return mapMouseCompositeCache;
}

/**
 * ★★ 2026-10-16：把这一局所用地图的**默认卡组**改成"玩家真的有、而且能过硬门"的那几张。
 *
 * 两个坑（`server/check-ready-deck.cjs` 就是为这两条写的探针）：
 *   1. `CardReadyPanel.setDefaultSelectedCards → getCardById` **只认卡包里真实存在的卡**：
 *      默认卡组里只要有玩家没有的卡，那一格就空着（全没有 ⇒ 空卡组 ⇒ 点「开始」只飘字）。
 *   2. `TableReadyUI.dealSubmitReadyGame():917` 对**带 0x0100 位**的地图有个硬门：
 *      卡组里必须含 15 张指定卡之一，否则返回 `enmGameReady_SelectCardID3`，
 *      点确定才会发 cmd1。
 *
 * 实测：地图 0x50010301「古堡初探」原默认卡组 = `0x11110014`（玩家有），但它带 0x0100 位，
 * 而玩家拥有的 15 张门卡一张都不在默认卡组里 ⇒ **点「开始」被硬门挡住**
 * （表现就是"界面在、点开始没反应"）。做法：从门卡里挑一张**玩家真的有**的补进默认卡组。
 * 开关：`REA_FIX_DEF_CARDS=0` 关闭；`REA_DEF_CARDS=0x…,0x…` 直接指定整副卡组。
 */
const WATER_GATE_CARDS = [
  288817173, 288817182, 288817183, 288817220, 288817230, 288817231, 288817232, 288817246,
  288817247, 288817264, 288817278, 288817279, 292552848, 292552862, 292552863,
];

function fixCompositeDefCards(xml) {
  if (process.env.REA_FIX_DEF_CARDS === "0") return xml;
  const mapID = COMPOSITE_MAP_ID >>> 0;
  const key = `MapID="0x${mapID.toString(16).toUpperCase().padStart(8, "0")}"`;
  const at = xml.indexOf(key);
  if (at < 0) {
    console.log(`[defcards] ⚠ map_mouse.xml 里没有 ${key}，跳过默认卡组修正`);
    return xml;
  }
  /**
   * ⚠ `map_mouse.xml` 的条目是 `<item …attrs…>` + `</item>`，**不是自闭合**，
   * 文件里几乎没有 `/>`；第一版写成 `indexOf("/>", at)` ⇒ 找不到就**静默 return**，
   * 表现是"改了但完全没生效、也没有任何日志"（实测踩过）。这里改成找标签的 `>`，
   * 并且把每条静默退路都补上日志 —— **静默 no-op 比报错更难查**。
   */
  const end = xml.indexOf(">", at);
  if (end < 0) {
    console.log(`[defcards] ⚠ ${key} 的标签没有结束符，跳过`);
    return xml;
  }
  const seg = xml.slice(at, end);
  const cur = (seg.match(/DefCardsID="([^"]*)"/)?.[1] ?? "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 16))
    .filter((n) => Number.isFinite(n));
  // ⚠ `cardCatalog()` 返回的是 `{cards, props, materials, gems, crystals}`，
  //    `cards` 才是卡 ID 数组（早期写成 `cardCatalog().map(...)` ⇒ 直接抛
  //    "cardCatalog(...).map is not a function"，把配置路由打断）。
  const owned = new Set(cardCatalog().cards.map((id) => id >>> 0));
  const override = process.env.REA_DEF_CARDS;
  let deck;
  if (override) {
    deck = override
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 16))
      .filter((n) => Number.isFinite(n));
  } else {
    deck = [...cur];
    const needsGate = (mapID & 0x0100) === 0x0100;
    const gateInDeck = deck.some((id) => WATER_GATE_CARDS.includes(id >>> 0));
    if (needsGate && !gateInDeck) {
      const pick = WATER_GATE_CARDS.filter((id) => owned.has(id >>> 0))[0];
      if (pick === undefined) {
        console.log(
          `[defcards] ⚠ 地图 0x${mapID.toString(16).toUpperCase()} 带 0x0100 位，` +
            `但玩家一张门卡都没有 ⇒ dealSubmitReadyGame:917 硬门必挡；` +
            `请在 cardCatalog() 里补一张门卡，或用 REA_FIX_DEF_CARDS=0 关掉本条`,
        );
      } else {
        deck.unshift(pick >>> 0); // 门卡放最前，视觉上最容易看到
        console.log(
          `[defcards] 地图 0x${mapID.toString(16).toUpperCase()} 默认卡组补入门卡 ` +
            `0x${(pick >>> 0).toString(16).toUpperCase()}（玩家有，且过 dealSubmitReadyGame:917 硬门）`,
        );
      }
    }
    const dropped = deck.filter((id) => !owned.has(id >>> 0));
    if (dropped.length > 0) {
      console.log(
        `[defcards] ⚠ 默认卡组里有玩家没有的卡（自动填卡会留空格）：` +
          dropped.map((n) => "0x" + (n >>> 0).toString(16).toUpperCase()).join(","),
      );
    }
  }
  const patched = seg.replace(
    /DefCardsID="[^"]*"/,
    `DefCardsID="${deck.map((n) => "0x" + (n >>> 0).toString(16).toUpperCase()).join(",")}"`,
  );
  return xml.slice(0, at) + patched + xml.slice(end);
}

/** 战斗模块的三种发法，见下方 overrideRoutes 里 `/TDGame2V2BattleUI.swf` 的说明。 */
/**
 * ⚠ 2026-10-16 实机第二次反馈后的**默认值**：`cdn`（原版资产模块）。
 *
 * 实测对照（同一台机器、同一份 TDCore）：
 *   · `cdn`    —— 预载**能走完**，准备界面可操作、能点「开始」（11:2x 那次 cmd1 就是它）；
 *                 代价是进战场时 `content as b_147` 得 null ⇒ 卡在 99%（见
 *                 docs/battle-module-rootcause.md）。
 *   · `assets` —— 把模块里 123 个同名类改名，让元件链到 TDCore 的逻辑类：
 *                 两次实机都**卡在预载**（界面在、点不动）。
 *   · `stub`   —— 上一轮的 Haxe 空桩（能过 `as b_147`，但一个元件都没有）。
 * 结论：**"改名让元件链到 TDCore 类"这条路走不通** —— TDCore 的战斗 UI 构造函数
 * （`TDGame2V2BattleUI()` → `a_1797()`）在构造期就要用时间轴元件，而元件是构造**之后**
 * 才绑定的（见文档 §2.2）。所以默认先退回 `cdn`，保证"界面能用"这一档不再退化；
 * 要真正进战场，只剩两条路：找到版本匹配的老模块，或改 TDCore 的构造函数。
 */
const BATTLE_MODULE = process.env.REA_BATTLE_MODULE ?? "cdn";
const BATTLE_MODULE_FILES = {
  assets: path.join(CACHE, "mirror", "battle_assets", "TDGame2V2BattleUI.swf"),
  stub: path.join(CACHE, "mirror", "battle_stub", "TDGame2V2BattleUI.swf"),
  cdn: path.join(CACHE, "mirror", "TDGame2V2BattleUI.swf"),
};

const overrideRoutes = new Map([
  ["/LoadFilesList.xml", () => loadFilesList()],
  ["/config/Authenticate.xml", () => Buffer.from(localServerList(AUTH_PORT))],
  ["/config/HallServer.xml", () => Buffer.from(localServerList(HALL_PORT))],
  ["/config/LogicServer.xml", () => Buffer.from(localServerList(LOGIC_PORT))],
  ["/config/map_mouse.xml", () => mapMouseXmlWithComposite()],
  ["/config/world_roaming.xml", () => worldRoamingXmlPatched()],
  /**
   * ★★ 2026-10-16 定案：战斗模块发 **改名后的资产模块**（`REA_BATTLE_MODULE=assets`，默认）。
   * 完整证据链见 [docs/battle-module-rootcause.md]。
   *
   * 三层事实（全部实测，不是推断）：
   *   1. **逻辑在 TDCore、美术在模块**：TDCore 里内联了整套战斗 UI 的逻辑
   *      （`com.aurora.ui.maogoutd.TDGame2V2BattleUI implements b_147` 以及它引用的
   *      `...game.MoveIntruderWaveNumberIndicatorView` 等），但 TDCore 的 SymbolClass
   *      只有两条（`TDCore`、`ButtonClickSound`）⇒ **TDCore 里一个战斗美术都没有**。
   *      CDN 的 `TDGame2V2BattleUI.swf` 正好相反：135 条 SymbolClass 全是美术，
   *      ABC 里 700+ 个逻辑符号（a_3600/a_3604/SetDIYInfo/…）**一次都不出现**。
   *   2. **两边类名一样** ⇒ 谁在域链上先被看到谁赢。模块 ABC 里那些同名类都是**空壳**
   *      （`extends MovieClip`，方法体只有 `super()`）。
   *   3. 客户端用**子域**加载它（`a_2179.as:1446 new ApplicationDomain(currentDomain)`）
   *      ⇒ 空壳遮蔽 TDCore 的逻辑类 ⇒ `content as b_147` 得 **null** ⇒
   *      `a_2179.as:1664 TDGameCoreUI.a_757.SetDIYInfo(...)` 空引用抛异常 ⇒
   *      `LoadEndAndStartGame()` 夭折 ⇒ **载入进度停在 99%**（就是用户看到的现象）。
   *
   * 修法：`server/patch-battle-assets.cjs` 把模块 ABC 常量池里那 135 个**类简单名**
   * 做**等长改名**（`...View` → `...VieA`），**SymbolClass 标签里的点分全名保持原样**。
   * 于是链名在域链上找不到模块自己的定义了，只能落到**父域 TDCore 的逻辑类**上 ——
   * 这正是"资产 SWF + 代码在主 SWF"这种分包的正常形态：逻辑来自 TDCore，时间轴/元件来自模块。
   *
   * 三个可选值：
   *   - `assets`（默认）：改名后的资产模块，`client-cache/mirror/battle_assets/TDGame2V2BattleUI.swf`
   *   - `stub`  ：上一轮的 Haxe 空桩（`tools/battle_stub/Main.hx`；能过 `as b_147` 但**一个元件都没有**）
   *   - `cdn`   ：CDN 原件（会复现"卡 99%"，留给对照组/取证用）
   */
  [
    "/TDGame2V2BattleUI.swf",
    () => {
      const file = BATTLE_MODULE_FILES[BATTLE_MODULE] ?? BATTLE_MODULE_FILES.assets;
      if (!fs.existsSync(file)) {
        console.log(
          `[battle-module] ⚠ 缺少 ${path.basename(path.dirname(file))}/${path.basename(file)}；` +
            `assets 需先跑 node server/patch-battle-assets.cjs ⇒ 本次回落 CDN 原件`,
        );
        return fs.readFileSync(BATTLE_MODULE_FILES.cdn);
      }
      return fs.readFileSync(file);
    },
  ],
]);

/**
 * TDLoaderUI.parseConfigFile 的路径规则：
 *   HallServer / LogicServer / tagger / open_mode  ->  config/<group_id>/<file>
 *   其它（Authenticate.xml 特例、task、diy.xml、map_mouse4.xml …） ->  config/<file>
 * 前两个必须指向本地服务器；其余从缓存副本取。
 */
const GROUPED_CONFIGS = /^\/config\/\d+\/(HallServer|LogicServer|tagger|open_mode)\.xml$/;
const FLATCACHE_DIR = path.join(CACHE, "flatcache");

/** URL 路径 -> client-cache 中的真实文件。 */
const staticRoutes = new Map([
  ["/config/PackagConfig.xml", "PackagConfig.xml"],
  ["/config/config.data", "config.data"],
  ["/config/task.dat", "task.dat"],
  // 客户端新版 ParseLotteryXML 会同时读 <choujiang> 与 <Instance>，
  // 缓存的 dog_card.xml 只有前者：这里提供二者合并后的版本。
  ["/config/dog_card.xml", "dog_card.merged.xml"],
  ["/images/loadingbg.jpg", "loadingbg.jpg"],
  ["/images/map/MapPackage.dat", "MapPackage.dat"],
]);

const MIME = {
  ".swf": "application/x-shockwave-flash",
  ".xml": "text/xml; charset=utf-8",
  ".dat": "application/octet-stream",
  ".data": "application/octet-stream",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".html": "text/html; charset=utf-8",
};

/**
 * 原站资源镜像。
 *
 * 客户端里图片/配置/模块都是相对路径（"images/1/2/0x….png"、"config/…"），
 * 原本解析到原站 CDN 根目录；现在 SWF 由本地提供，同样的相对路径就落到
 * 我们这台 8080 上。本地没有的文件按原路径回源抓一次并落盘，
 * 之后即使断网也能直接提供 —— 这就是把"三分之二的物品图标打不开"补齐的办法。
 */
const CDN_BASE = process.env.REA_CDN_BASE ?? "https://q.ms.huanlecdn.com/4399/cdn.123u.com";
const MIRROR_DIR = path.join(CACHE, "mirror");
const MIRRORABLE = /\.(swf|png|jpe?g|gif|xml|dat|data|json|js|css|htm|html|mp3|txt)$/i;
const mirrorPending = new Map();
const mirrorMissing = new Set();
let mirrorDownUntil = 0;

async function serveMirrored(p, res, noStore) {
  if (!MIRRORABLE.test(p) || p.includes("..")) return false;
  if (mirrorMissing.has(p)) return false;
  const local = path.join(MIRROR_DIR, p);
  let body;
  if (fs.existsSync(local)) {
    body = fs.readFileSync(local);
  } else {
    // 回源有失败退避：原站不可达时不要每条请求都干等超时。
    if (Date.now() < mirrorDownUntil) return false;
    let inflight = mirrorPending.get(p);
    if (inflight === undefined) {
      inflight = (async () => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 15000);
        try {
          const r = await fetch(CDN_BASE + p, { signal: ac.signal });
          if (!r.ok) {
            // 原站可达但确实没有这个文件：记下来，别再重复问。
            mirrorMissing.add(p);
            console.log(`[mirror] - ${p} HTTP ${r.status}`);
            return null;
          }
          const buf = Buffer.from(await r.arrayBuffer());
          fs.mkdirSync(path.dirname(local), { recursive: true });
          fs.writeFileSync(local, buf);
          console.log(`[mirror] + ${p} (${buf.length}B)`);
          return buf;
        } catch (e) {
          // 只有网络层失败才算"原站不可达"，退避 60 秒避免反复干等。
          mirrorDownUntil = Date.now() + 60000;
          console.log(`[mirror] ! ${p} ${e.message}`);
          return null;
        } finally {
          clearTimeout(timer);
          mirrorPending.delete(p);
        }
      })();
      mirrorPending.set(p, inflight);
    }
    body = await inflight;
    if (body === null || body === undefined) return false;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(p)] ?? "application/octet-stream",
    "content-length": body.length,
    ...noStore,
  });
  res.end(body);
  return true;
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = decodeURIComponent(url.pathname);
  console.log(`[http] ${req.method} ${p}`);

  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(INDEX_HTML);
    return;
  }

  const noStore = { "cache-control": "no-store, no-cache, must-revalidate", pragma: "no-cache" };

  // 页面自诊断通道（1x1 图片探针）
  if (p === "/__diag") {
    console.log(`[diag] ${decodeURIComponent(url.search.replace(/^\?/, ""))}`);
    res.writeHead(204);
    res.end();
    return;
  }

  /**
   * ★ 客户端异常上报口（2026-10-16）。
   *
   * 客户端自带的全局兜底 `TDErrorCatch.UploadError()`（`TDErrorCatch.as:35-45`）会把
   * `err.name / message / getStackTrace()` POST 到 `http://<dev>:8080/log` ——
   * 那是开发机内网地址，在我们这边永远失败，异常等于被丢掉。
   * `server/patch-upload-error.cjs` 已把那个地址等长改成 `127.0.0.1:8080`，
   * 另外启动页 flashvars 用 `sitetype=joyyou` 才会注册这个监听
   * （`TDCore.as:102-106`；登录分支与 4399 相同，见 `TDCore.as:156-161`）。
   *
   * ⇒ 客户端里**任何未捕获异常**，现在都会带着堆栈出现在这份日志里。这是排查
   * "界面空白/点了没反应"这类只能在客户端复现的问题最直接的证据来源。
   */
  if (p === "/log") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed = raw;
      try {
        parsed = decodeURIComponent(raw.replace(/\+/g, " "));
      } catch {
        /* 保持原文 */
      }
      console.log("★★★ CLIENT_UNCAUGHT_ERROR ★★★");
      for (const line of parsed.split(/\r?\n/)) console.log(`    ${line}`);
      console.log("★★★ (以上为客户端未捕获异常，含 getStackTrace) ★★★");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    return;
  }

  /**
   * ★ 客户端内部日志转接口（2026-10-16）。
   *
   * 客户端把内部日志通过 **LocalConnection** 广播出去（`a_4648.a_4649` →
   * `conn.send("_debugConnection","transMsg",msg,id)`），Flash 之外收不到。
   * `tools/` 里那个用 Haxe 编的 `trace_receiver.swf`（源码 `tools/trace_receiver/Main.hx`）
   * 负责连上 `_debugConnection`，把每条消息 GET 到这个路径 ⇒ 客户端的内部日志
   * 就能直接出现在本文件里（含 `a_2179` 那些 `trace("Game: …")` 诊断）。
   */
  if (p === "/__trace") {
    const q = new URLSearchParams(url.search);
    const line = (payload) =>
      console.log(
        `[trace] ${q.get("id") ?? "-"}${q.get("n") ? "#" + q.get("n") : ""} :: ` +
          `${payload}`.slice(0, 4000),
      );
    if (req.method === "POST") {
      // 覆盖件走 GET（消息可能很长，还留一条 POST 通路给以后用）
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        line(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(204, noStore);
        res.end();
      });
      return;
    }
    line(q.get("msg") ?? q.get("obj") ?? "");
    res.writeHead(204, noStore);
    res.end();
    return;
  }

  const override = overrideRoutes.get(p);
  if (override !== undefined) {
    const body = override();
    res.writeHead(200, { "content-type": "text/xml; charset=utf-8", ...noStore });
    res.end(body);
    return;
  }

  // config/<group_id>/HallServer.xml 等：服务器列表一律指向本地
  const grouped = GROUPED_CONFIGS.exec(p);
  if (grouped !== null) {
    if (grouped[1] === "HallServer" || grouped[1] === "LogicServer") {
      const body = Buffer.from(
        localServerList(grouped[1] === "HallServer" ? HALL_PORT : LOGIC_PORT),
      );
      res.writeHead(200, { "content-type": "text/xml; charset=utf-8", ...noStore });
      res.end(body);
      return;
    }
  }

  // 静态：/TD*.swf 与映射表中的路径
  let fileName = staticRoutes.get(p);
  if (fileName === undefined && /^\/TD[A-Za-z0-9_]*\.swf$/.test(p)) fileName = p.slice(1);
  // config.data 里的数据 XML：/config/<name>
  if (fileName === undefined && p.startsWith("/config/")) {
    const candidate = path.join(CONFIG_DATA_DIR, p.slice("/config/".length));
    if (fs.existsSync(candidate)) {
      const body = fs.readFileSync(candidate);
      res.writeHead(200, {
        "content-type": "text/xml; charset=utf-8",
        "content-length": body.length,
        ...noStore,
      });
      res.end(body);
      return;
    }
  }
  if (fileName !== undefined) {
    const full = path.join(CACHE, fileName);
    if (fs.existsSync(full)) {
      const body = fs.readFileSync(full);
      res.writeHead(200, {
        "content-type": MIME[path.extname(fileName)] ?? "application/octet-stream",
        "content-length": body.length,
        ...noStore,
      });
      res.end(body);
      return;
    }
  }

  // 本地没有 → 按原路径回源一次（图片、模块、配置都走这里），抓到的会落盘。
  if (await serveMirrored(p, res, noStore)) return;

  // 兜底：按文件名回落。WinINet 缓存只保留 basename（如 slice_0[1].png 对应
  // /images/head/otherKey/slice_0.png），客户端请求的原始路径已不可知。
  const flat = path.join(FLATCACHE_DIR, path.basename(p));
  if (fs.existsSync(flat)) {
    const body = fs.readFileSync(flat);
    res.writeHead(200, {
      "content-type": MIME[path.extname(flat)] ?? "application/octet-stream",
      "content-length": body.length,
      ...noStore,
    });
    res.end(body);
    return;
  }

  console.log(`[http] 404 ${p}`);
  // 客户端会请求一些我们没有的配置（例如新版加的 cookery.xml）。
  // 返回一个空根节点比 404 更友好：不会触发重试风暴，也不阻塞流程。
  if (/^\/config\/[^/]+\.xml$/.test(p)) {
    const body = Buffer.from("<root></root>", "utf8");
    res.writeHead(200, {
      "content-type": "text/xml; charset=utf-8",
      "content-length": body.length,
      ...noStore,
    });
    res.end(body);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

/* ------------------------------------------------------------------ *
 * 游戏网关（TCP）：策略文件 + 协议抓取
 * ------------------------------------------------------------------ */

let connSeq = 0;
const hex = (b, max = 96) =>
  b.subarray(0, Math.min(max, b.length)).toString("hex").replace(/(..)/g, "$1 ").trim() +
  (b.length > max ? " …" : "");

function parseHeader(buf, at) {
  if (buf.length < at + 24) return undefined;
  const nPackageLength = buf.readInt32BE(at);
  const nUIN = buf.readInt32BE(at + 4);
  const shFlag = buf.readInt16BE(at + 8);
  const shOptionalLen = buf.readInt16BE(at + 10);
  let q = at + 12;
  let optional = Buffer.alloc(0);
  if (shOptionalLen > 0 && q + shOptionalLen <= buf.length) {
    optional = buf.subarray(q, q + shOptionalLen);
    q += shOptionalLen;
  }
  return {
    nPackageLength,
    nUIN,
    shFlag,
    shOptionalLen,
    optional,
    shHeaderLen: buf.readInt16BE(q),
    shMessageID: buf.readInt16BE(q + 2),
    shMessageType: buf.readInt16BE(q + 4),
    shVersion: buf.readInt16BE(q + 6),
    nPlayerID: buf.readInt32BE(q + 8),
    headerEnd: q + 12,
  };
}

const MESSAGE_NAMES = { 1: "AUTH_REQUEST", 6: "ACCOUNT_REGISTER" };

/** 已登录连接的会话密钥（登录应答后会填入） */
const sessions = new Map();
/** 单机只有一名玩家：登录后把会话密钥记为全局，供大厅/逻辑连接解密。 */
let playerSessionKey;
/**
 * 兼容用的"额外会话密钥"（16 进制，逗号分隔），来自环境变量 REA_SESSION_KEY。
 * 客户端重连时不会重新认证，而是拿旧密钥继续发报文；服务端此时可以在这里补上旧密钥，
 * 让它免刷新恢复（正常情况下确定性密钥已经能覆盖重启场景，这里是兜底）。
 */
const SESSION_KEY_FILE = path.join(import.meta.dirname, ".session-key");
/** 按账号确定性派生会话密钥：客户端不会重新认证，重启后必须还能认出这把密钥。 */
function deriveSessionKey(account) {
  return crypto
    .createHash("sha256")
    .update(`msdzls-local-session-v1:${account}`)
    .digest()
    .subarray(0, 16);
}
function readPersistedSessionKey() {
  try {
    const hex = fs.readFileSync(SESSION_KEY_FILE, "utf8").trim();
    return /^[0-9a-fA-F]{32}$/.test(hex) ? [Buffer.from(hex, "hex")] : [];
  } catch {
    return [];
  }
}
function persistSessionKey(key) {
  try {
    fs.writeFileSync(SESSION_KEY_FILE, key.toString("hex"));
  } catch {
    /* 落盘失败不影响运行 */
  }
}
const EXTRA_SESSION_KEYS = (process.env.REA_SESSION_KEY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => /^[0-9a-fA-F]{32}$/.test(s))
  .map((s) => Buffer.from(s, "hex"))
  .concat(readPersistedSessionKey())
  .concat([deriveSessionKey(PLAYER_ACCOUNT)]);

function handlePacket(tag, id, socket, state, h, body) {
  console.log(
    `[${tag}#${id}] packet: len=${h.nPackageLength} uin=${h.nUIN} flag=${h.shFlag} ` +
      `msgID=${h.shMessageID}${MESSAGE_NAMES[h.shMessageID] ? " = " + MESSAGE_NAMES[h.shMessageID] : ""} ` +
      `ver=${h.shVersion} playerID=${h.nPlayerID} optLen=${h.shOptionalLen}`,
  );

  // 登录：AUTH_REQUEST(1) → AUTH_RESPONSE(2)，用硬编码密钥
  if (h.shMessageID === 1 && !state.responded) {
    const dec = xteaDecrypt(body, LOCAL_KEY, -32);
    if (!dec.ok) {
      console.log(`[${tag}#${id}] auth decrypt failed: ${dec.reason}`);
      return;
    }
    const sequence = dec.data.readInt32BE(0);
    const accountLength = dec.data.readInt16BE(4);
    const account = dec.data
      .subarray(6, 6 + accountLength - 1)
      .toString("utf8");
    const userType = dec.data.readInt16BE(6 + accountLength);
    // 会话密钥按账号确定性生成：客户端重连时不会重新认证，而是拿旧密钥继续发
    // HALL_LOGIN/心跳（见日志 "no session key yet"）。用随机密钥的话，服务端一重启
    // 就再也解不开，客户端会永久卡在"登录游戏服务器"。改成确定性密钥后，重启不再掉线。
    const sessionKey = deriveSessionKey(account);
    const signature = crypto
      .createHash("sha256")
      .update(`msdzls-local-signature-v1:${account}`)
      .digest()
      .subarray(0, 16);
    sessions.set(id, sessionKey);
    playerSessionKey = sessionKey;
    persistSessionKey(sessionKey);
    socket.write(
      buildPacket({
        messageId: 2,
        version: 1,
        uin: -1,
        playerId: -1,
        flag: 4,
        payload: buildAuthResponse({
          account,
          userType,
          sequence,
          sessionKey,
          signature,
        }),
      }),
    );
    state.responded = true;
    console.log(
      `[${tag}#${id}] -> AUTH_RESPONSE sent: uin=${PLAYER_UIN} account=${JSON.stringify(account)} ` +
        `userType=${userType} sessionKey=${sessionKey.toString("hex")}`,
    );
    return;
  }

  // 大厅/角色报文：用会话密钥解密后按表应答
  const spec = HALL_RESPONSES.get(h.shMessageID);
  if (spec !== undefined) {
    const candidates = [];
    if (playerSessionKey !== undefined) candidates.push(playerSessionKey);
    for (const k of EXTRA_SESSION_KEYS) if (!candidates.some((c) => c.equals(k))) candidates.push(k);
    let sessionKey = null;
    let dec = null;
    for (const k of candidates) {
      const r = xteaDecrypt(body, k, -32);
      if (r.ok) {
        sessionKey = k;
        dec = r;
        break;
      }
    }
    if (dec === null) {
      console.log(
        `[${tag}#${id}] ${spec.name}: 无可用会话密钥（客户端未重新认证）——请刷新游戏页面重新登录；` +
          `body=${hex(body, 160)}`,
      );
      return;
    }
    playerSessionKey = sessionKey; // 自愈：记住这次成功的密钥
    persistSessionKey(sessionKey);
    console.log(
      `[${tag}#${id}]     ${spec.name} request: seq=${dec.data.readInt32BE(0)} ` +
        `plain=${hex(dec.data.subarray(4), 120)}`,
    );
    const responsePacket = buildPacket({
      messageId: h.shMessageID,
      version: 3,
      uin: PLAYER_UIN,
      playerId: PLAYER_UIN,
      flag: 4,
      payload: xteaEncrypt(
        padPlaintext(Buffer.concat([int32(0), spec.build(dec.data)])),
        sessionKey,
        32,
      ),
    });
    socket.write(responsePacket);
    /**
     * GET_CARDS(14689) 的应答会被客户端用来关闭"正在登陆游戏服务器"提示
     * （a_2352 派发 a_587 → a_2557 → a_3745）。这个提示没有关闭按钮、点遮罩也无效，
     * 只能在客户端自己隐藏；若应答到达时大厅 UI 尚未就绪，隐藏会失败并永久卡住。
     * 这里延迟补发一次同包，晚一点再触发一次隐藏，规避该时序竞争。
     */
    if (h.shMessageID === 14689 && !state.resentCards) {
      state.resentCards = true;
      const timer = setTimeout(() => {
        if (socket.writable) socket.write(responsePacket);
      }, 1500);
      timer.unref?.();
    }
    // 菜单解锁：见 buildGuidePushPacket 注释。登录流程走完（角色登录/取卡表）
    // 时推一次，再延迟补一次，避免大厅 UI 还没就绪时把这次推送丢掉。
    if (h.shMessageID === 14688 || h.shMessageID === 14689) {
      const guidePacket = buildGuidePushPacket(sessionKey);
      socket.write(guidePacket);
      const timer = setTimeout(() => {
        if (socket.writable) socket.write(guidePacket);
      }, 2000);
      timer.unref?.();
      console.log(`[${tag}#${id}] -> GUIDE_DATA pushed (msgID=14928)`);
    }
    // 玩家公共信息（含 VIP 段）：客户端算强化成功率时要读 m_stVIP，
    // 这条同样是服务端主动推的（客户端只发 14673 请求、并不等数据）。
    if (h.shMessageID === 14673 || h.shMessageID === 14688) {
      const commonPacket = buildPlayerCommonPacket(sessionKey);
      socket.write(commonPacket);
      const timer = setTimeout(() => {
        if (socket.writable) socket.write(commonPacket);
      }, 2000);
      timer.unref?.();
      console.log(`[${tag}#${id}] -> PLAYER_COMMON pushed (msgID=14675)`);
    }
    // 制作/融合成功后推"卡片增量通知"（14620），把新卡补进主卡表并刷新背包。
    // 注意不能用 14689：客户端收到 14689 会切回城镇（见 buildCardNotifyPacket 注释），
    // 那样一做完卡就被弹出合成屋。
    // 14850（强化）也要通知：升/降星、被吃掉的强化用卡都得让客户端刷新
    if (
      h.shMessageID === 14849 ||
      h.shMessageID === 14850 ||
      h.shMessageID === 14876 ||
      h.shMessageID === 14877
    ) {
      // pendingCardNotify 是**模块级**状态，跨请求粘滞。它的取值语义：
      //   null  = 本次没有卡变化，别通知（见 :1247 强化失败未掉星且无材料被吃）
      //   [...] = 有卡变化，要通知
      //
      // ⚠ 修正一条**曾经写进本文件的错误结论**（勿再引用）：
      //   曾经据 server.log 的一行 `CARD_NOTIFY pushed 11122490/900099/x1/星9`
      //   断言这里有"回退到 cards[0]"的假回退，并据此改成 `?? []`。**该结论是错的**：
      //   那行是**合成(14849)的合法通知**——`[compose] 规则 80 → 11122490 seq=900099 9星`
      //   就在它上一行，而 cards[0] 恰好就是这张刚合成出来的卡，属子串匹配的假阳性。
      //   经全量配对（每条 NOTIFY ↔ 其前最近的 [upgrade]/[compose] 行），10 条 NOTIFY
      //   全部能归到本次操作，回退分支**一次都没被触发过**。
      //   因此这里**恢复**成原来的写法：无证据表明它有害，而 `?? []` 会把"推错卡"
      //   换成"什么都不推"—— 客户端依赖这条通知刷新卡表，后者更难排查。
      const changed = pendingCardNotify ?? [loadCardState().cards[0]].filter(Boolean);
      // ★ 但"进入分支先无条件清空"这条**保留**，它是独立成立的真实风险：
      //   本分支覆盖的 4 个 msgID 里，composeFailure(:552) / fusionFailure(:735) 是
      //   纯 builder、提前 return 且**不写** pendingCardNotify。若不清空，上一笔操作
      //   留下的非空值会被本笔失败的响应"隔空"当成自己的变化推出去 —— 推的是**上一笔
      //   的真实变化**，比假回退更隐蔽。必须在下面判定之前清。
      pendingCardNotify = null;
      if (changed.length > 0) {
        const notifyPacket = buildCardNotifyPacket(sessionKey, changed);
        const timer = setTimeout(() => {
          if (socket.writable) socket.write(notifyPacket);
        }, 300);
        timer.unref?.();
        console.log(
          `[${tag}#${id}] -> CARD_NOTIFY pushed (msgID=14620) ` +
            changed.map((c) => `${c.id.toString(16)}/${c.seq}/x${c.count}/星${c.grade ?? 0}`).join(" "),
        );
      }
    }
    console.log(`[${tag}#${id}] -> ${spec.name} response sent (msgID=${h.shMessageID})`);

    /**
     * ================= 单机进战斗：129 / 130 的触发点 =================
     *
     * ⚠ 旧实现在这里写的是 `if (h.shMessageID === 8705 && tag === "logic")`，
     *   **该条件永不成立**：实测 server.log:4753-4755，SIT_DOWN(8705) 走的是 `generic` 网关
     *   （`[generic#19] ... msgID=8705`），所以那两帧**从未真正发出过**。
     *   而且"SIT_DOWN 之后推 129"这个**时机本身就是错的**：
     *   a_2087(129 落地) 在 :849 需要 `a_768 === true`，而那时客户端还在大厅，
     *   a_768 为 false ⇒ 129 被 :849 的 else 分支静默吃掉（a_2179.as:849-855），之后再无重试。
     *
     * 正确触发点（逐条实证）：
     *   1) cmd1 PostSelectedCards：客户端在准备 UI 点"开始"后上报卡组，这是 129 的天然触发点。
     *      a_2068/a_2056 的本地路径已经先把本机 AvatarDetailInfo 填好（a_2179.as:312-313），
     *      随后 a_2179.as:410 才把 cmd1 发出去。
     *   2) cmd3 PostLoadingProgress 且进度 >= 100：a_2179.as:1663 先创建 TDGameCoreUI.a_757、
     *      :1679 调 a_2195() 初始化战场 UI、:1680 才 a_2058(100) 上报进度 100。
     *      而 a_2088(130 落地) :891 直接 `TDGameCoreUI.a_757.a_3435(...)` —— a_757 为 null 会抛异常。
     *      ⇒ **130 必须等进度 100 之后才发**。
     *      另：进度 100 只会在 a_767 === true（即 129 已收到）时才会发出（:1670-1674 早退），
     *      所以它同时也是"129 已被客户端消化"的确认。
     *
     * 128 StepSync 不发：客户端推进是本地 100Hz 时钟，OnGameStepLock 是空桩
     * （TDGame2V2BattleUI.as:3576-3579），见 docs/battle-replica-plan.md §4。
     */
    if (h.shMessageID === 8709) {
      const env = parseGameDataEnvelope(dec.data);
      const cmd = env && env.gameData.length > 0 ? env.gameData[0] : -1;
      if (env !== null) {
        battleState.roomID = env.roomID >= 0 ? env.roomID : (roomState.roomID ?? -1);
        battleState.tableID = env.tableID >= 0 ? env.tableID : (roomState.tableID ?? -1);

        if (cmd === L2_CS_CMDS.PostReadyUiCreated) {
          /**
           * ★ 关键：客户端报告"准备 UI 已建好"（a_2179.as:1705 a_2194 → a_2064 → b_112=9）。
           * 此刻 TDGameCoreUI.a_1666 一定已存在（a_2179.as:1618 赋值 → :1624 才调 a_2194），
           * 所以这是推 131 的唯一可靠时机：早推会因 a_1666 为 null 而只存进 a_2179、不转发给准备 UI。
           */
          const seat = roomState.seat ?? 0;
          /**
           * ★★ 必须把**全部 4 个座位槽**都发出来（空位用 readyStatus=255），不能只发自己那一个。
           *
           * 原因（2026-10-14 用截图 + 代码双重定位）：准备界面右侧「我的防御卡」的卡片列表
           * 由 `CardReadyPanel.onShowCardPackageCards(arrTDCards[0], ...)` 填充，而它**唯一**的
           * 调用链是：
           *   `TableReadyUI.showReadyCards()`（`TableReadyUI.as:400`，内含 :405 onShowDefGrids /
           *   :406 showAddDefCard / :407 onShowCardPackageCards / :408 showFavouriteCards）
           *   ← `TDGameReadyUI.as:206-216` 赋给 `stTableReadyUI.fn_CallBack`
           *   ← `TableReadyUI.showVcKey()` 最后一句 `:373-376 if(m_iGameMapID != 0 && fn_CallBack != null) fn_CallBack()`
           *
           * 而 `showVcKey` 只在两处被调用：`TDGameReadyUI.as:383`（a_3721 路径）与
           * **`TDGameReadyUI.as:559`——它在 `a_2089` 的 `else if(status.m_byReadyStatus == 255)`
           * 分支里（`:548-560`），即"这个座位是空的"分支**。
           *
           * ⇒ 只发 1 个座位时，`:528` 的循环只跑 iGameSeatID=0（自己是 0 不是 255），
           *   255 分支永不执行 ⇒ `showVcKey` 不被调用 ⇒ `fn_CallBack` 不触发 ⇒
           *   `showReadyCards()` 不执行 ⇒ **「我的防御卡」永远是空的**，玩家无从选卡 ⇒
           *   `TableReadyUI.dealSubmitReadyGame()` 的 `defCards.length == 0`（`:842-845`）
           *   返回 `enmGameReady_SelectCardID1` ⇒ 永远走不到 `onPostSelectedCards` ⇒
           *   **cmd1 永不发送，129/130 自然也不会触发**。截图证据：面板标题「我的防御卡」右侧全空。
           *
           * 另外 `:528` 的循环上界是 `arrPlayerReadeyStatus.length`，而座位是按**下标即座位号**
           * 使用的（`this.m_vTabSeat[iGameSeatID]`），所以必须补齐到 4 个槽。
           */
          const seats = [];
          for (let i = 0; i < TABLE_SEAT_SLOTS; i += 1) {
            seats.push(
              i === seat
                ? {
                    teamNo: 0,
                    // 已点过「开始」(cmd1) 就报"已准备"；否则必须报 0，否则 :545 会把按钮禁用
                    readyStatus: battleState.loadStartSent ? 1 : 0,
                    pointStatus: 0, // 1 会弹「体力不足」并阻止开始
                  }
                : { teamNo: 0, readyStatus: 255, pointStatus: 0 }, // 255 = 空座位
            );
          }
          const payload = buildSittedPlayerStatusPayload({
            masterSeat: seat, // 单机：自己就是桌主 ⇒ ReadyButton.showButton(isMaster=true, ...) 会显示「开始」
            canStart: 1, // a_1674 = 1 ⇒ TDGameReadyUI.as:986 才会走 this.ready(...)
            seats,
          });
          battleState.sittedStatusSent = true;
          const packet = buildGameDataNotifyPacket(sessionKey, {
            roomID: battleState.roomID,
            tableID: battleState.tableID,
            events: [{ seq: 10, data: Buffer.concat([Buffer.from([L2_SC_CMDS.SittedPlayerStatus]), payload]) }],
          });
          socket.write(packet);
          console.log(
            `[${tag}#${id}] -> L1 8711(CNotifyGameData) SittedPlayerStatus pushed: cmd=131(${packet.length}B) ` +
              `masterSeat=${seat} canStart=1 slots=${TABLE_SEAT_SLOTS} ` +
              `本座位 readyStatus=${battleState.loadStartSent ? 1 : 0} 其余=255 ` +
              `体=${payload.length}B hex=${hex(payload, 24)}`,
          );

          /**
           * ★★ 再补一条 14620 卡片通知 —— 这是填「我的防御卡」的**第二条（也是更可靠的一条）**通路。
           *
           * `TDGameReadyUI.as:206-216` 把 `showReadyCards()` 挂进 `TableReadyUI.fn_CallBack`，
           * 而 `fn_CallBack` 一旦被消费就置 null（`TableReadyUI.as:373-376`），**只触发一次**。
           * 若那一次早于准备界面拿到卡表，面板就永久空白，且没有任何重试。
           *
           * 但 `TableReadyUI.onNotifyDefCardsChange(arrDefCards)`（`:772-785`）会**再调一次**
           * `this.cardReadyPanel.onShowCardPackageCards(arrDefCards, m_iGameMapID, m_iGameMode)`
           * —— 正是填卡面板的那个函数。它的上游是
           *   `a_2439.updateNotifyCards` → `a_1825.e.onNotifyDefCardsChange(arrDefCards)`（a_2439.as:895）
           * 即 **14620 卡片通知**（本文件 buildCardNotifyPacket）。
           *
           * ⇒ 把当前卡表整份作为"更新"推一次即可刷新面板；`updateNotifyCards` 对已存在的卡
           *   走 `:849-855` 的"既有条目"分支（只更新数量/到期，不新增重复条目），所以整份推送是幂等的。
           */
          const allCards = loadCardState().cards;
          if (allCards.length > 0) {
            const notifyPacket = buildCardNotifyPacket(sessionKey, allCards);
            socket.write(notifyPacket);
            console.log(
              `[${tag}#${id}] -> CARD_NOTIFY pushed (msgID=14620, 准备界面刷新用) ${allCards.length} 张 ` +
                `→ 触发 TableReadyUI.onNotifyDefCardsChange → onShowCardPackageCards`,
            );
          } else {
            console.log(`[${tag}#${id}]     ⚠ 卡表为空，无法用 14620 刷新「我的防御卡」面板`);
          }
        } else if (cmd === L2_CS_CMDS.PostSelectedCards) {
          const sel = parsePostSelectedCards(env.gameData);
          if (!sel.ok) {
            console.log(
              `[${tag}#${id}]     PostSelectedCards 解析失败（${sel.reason}），不推 129。` +
                ` body=${hex(env.gameData, 160)}`,
            );
          } else if (battleState.loadStartSent && !battleState.gameStartSent) {
            // 同一局里重复上报：**不能**再发第二份 129。
            // a_2179.as:1681-1682 会在 LoadEndAndStartGame 末尾把 a_767/a_768 复位，
            // 第二份 129 走到 :849 会掉进最后的 else 分支，把整局卡死。
            console.log(`[${tag}#${id}]     PostSelectedCards 重复上报（本局 129 已发），忽略。`);
          } else {
            if (battleState.gameStartSent) {
              console.log(`[${tag}#${id}]     检测到上一局已结束，按新一局重置战斗状态。`);
            }
            battleState.loadStartSent = true;
            battleState.gameStartSent = false;
            battleState.stuckWarned = false; // 新一局：允许再告警一次
            battleState.seed = newBattleSeed();
            battleState.cardIDs = sel.cards.map((c) => c.id);
            const loadStart = buildBattleStartFrames(sessionKey)[0];
            const expectLen = loadStartPayloadLength(battleState.cardIDs.length);
            console.log(
              `[${tag}#${id}]     PostSelectedCards: cards=${sel.cards.length} props=${sel.props.length} ` +
                `avatarBlob=${sel.avatarBlob.length}B → 推 L2 LoadStart(129) ` +
                `seed=0x${(battleState.seed >>> 0).toString(16)} ` +
                `cardIDs=[${battleState.cardIDs.map((c) => "0x" + (c >>> 0).toString(16)).join(",")}] ` +
                `体=${expectLen}B`,
            );
            if (battleState.cardIDs.length === 0) {
              // 没有卡 ⇒ a_2179.as:801 的 arrPendingLoadingRes 为空，:810 分支不会触发，
              // 129 晚到时有卡死在 :849 的风险。这里只告警，不伪造卡（伪造会污染战斗卡组）。
              console.log(
                `[${tag}#${id}]     ⚠ 卡组为空：129 的 m_arrSelectCardIDs 为空，` +
                  `客户端可能卡在 a_2179.as:849（需 a_768 已为 true）。`,
              );
            }
            const timer = setTimeout(() => {
              if (!socket.writable) return;
              socket.write(loadStart.packet);
              console.log(
                `[${tag}#${id}] -> L1 8711(CNotifyGameData) LoadStart pushed: cmd=${loadStart.cmd}(${loadStart.packet.length}B)`,
              );
            }, 50);
            timer.unref?.();
          }
        } else if (cmd === L2_CS_CMDS.PostLoadingProgress) {
          const progress = env.gameData.length >= 2 ? env.gameData.readInt8(1) : -1;
          if (progress >= 100 && battleState.loadStartSent && !battleState.gameStartSent) {
            battleState.gameStartSent = true;
            const startGame = buildBattleStartFrames(sessionKey)[1];
            socket.write(startGame.packet);
            console.log(
              `[${tag}#${id}] -> L1 8711(CNotifyGameData) StartGame pushed: cmd=${startGame.cmd}(${startGame.packet.length}B) ` +
                `波数=${TOTAL_INTRUDER_WAVE_NUM} seed=0x${(battleState.seed >>> 0).toString(16)}`,
            );
            /**
             * ★ 2026-10-16：130 之后立刻接管"帧源"，按 tick 表把 132 逐波推出去。
             * tick 0 = 客户端处理 130 的那一刻（`a_3435()` 里 a_1064 = getTimer()），
             * 所以用"刚推 130 的墙钟"当基准，误差只有几毫秒。
             */
            startWavePushes(socket, sessionKey, (msg) => console.log(`[${tag}#${id}]     ${msg}`));
          } else if (progress >= 99 && !battleState.loadStartSent && !battleState.stuckWarned) {
            /**
             * ★ 2026-10-16：这是"准备界面卡死"的**特征信号**，务必一眼能看懂。
             *
             * 进度 99 是 `a_2179.as:1670 if(!this.a_767) return;` 的早期返回态：
             * 客户端把战斗模块载完了，但**没收到 129**，于是不初始化战场、也不上报 100。
             * 而 129 的唯一触发点是客户端点「开始」后的 `cmd1`(PostSelectedCards)，等价地说是
             * `TDGameReadyUI.ready() → dealSubmitReadyGame() == enmGame_DefaultID → onPostSelectedCards`。
             *
             * 所以看到这条日志时，**不要**去查协议 —— 要查"玩家到底能不能点到「开始」"：
             *   1. 页面是否把 950x600 画布按窗口缩放（`INDEX_HTML` 的 fitGame；不缩放时
             *      准备界面右下角的「开始」会落在可视区外 —— 见 docs/battle-replica-plan.md §7.0）；
             *   2. 「我的防御卡」面板里有没有卡（没卡 → dealSubmitReadyGame 返回 SelectCardID1，
             *      只会飘一行提示）。
             */
            battleState.stuckWarned = true;
            console.log(
              `[${tag}#${id}]     ⚠ 载入进度到 ${progress}% 但整局都没收到 cmd1(PostSelectedCards)：` +
                `客户端「开始」没能完成 ⇒ 129 从未下发 ⇒ 永远进不了战场。` +
                `请检查：① 启动页是否把画布缩放到窗口内（否则「开始」在可视区外）；` +
                `② 「我的防御卡」面板里是否已有卡（空面板点「开始」只会飘字提示）。`,
            );
          }
        }
      }
    }
    return;
  }

  // 只发不问的报文：记录一次后直接返回，不产生应答。
  const silent = NO_REPLY_MSGIDS.get(h.shMessageID);
  if (silent !== undefined) {
    console.log(`[${tag}#${id}]     ${silent} received (no response expected)`);
    /**
     * 14744 = TRANSFER_CLIENT_LOG（a_2824）：**客户端把自己的日志上报上来**。
     * 之前只记一行、不解内容，等于把最有用的排障信息扔了。这里直接解密打印。
     * 布局：`[int32 seq][int32 类型?][客户端文本...]`（未逐字节确认，先全量打印）。
     */
    if (h.shMessageID === 14744) {
      for (const [label, key] of [["playerSession", playerSessionKey], ["localKey", LOCAL_KEY]]) {
        if (!key) continue;
        const r = xteaDecrypt(body, key, -32);
        if (!r.ok) continue;
        console.log(
          `[${tag}#${id}]     ★ CLIENT_LOG (${label}) ${r.length}B: ` +
            JSON.stringify(r.data.subarray(4).toString("utf8")),
        );
        break;
      }
    }
    return;
  }

  // 尚未实现的报文：把能解出来的明文打出来，便于继续补齐
  for (const [label, key] of [
    ["localKey", LOCAL_KEY],
    ["playerSession", playerSessionKey],
  ]) {
    if (!key) continue;
    for (const rounds of [-32, -8]) {
      const r = xteaDecrypt(body, key, rounds);
      if (r.ok) {
        console.log(
          `[${tag}#${id}] *** UNHANDLED msgID=${h.shMessageID} DECRYPTED (${label}, rounds=${rounds}) ` +
            `${r.length}B: ${hex(r.data, 200)}`,
        );
        console.log(
          `[${tag}#${id}]     seq=${r.data.readInt32BE(0)} text=${JSON.stringify(r.data.subarray(4, 120).toString("latin1"))}`,
        );
      }
    }
  }
}

/** 认证 / 大厅 / 逻辑 各占一个端口，日志前缀直接标明是谁连上来的。 */
const createGateway = (tag) => net.createServer((socket) => {
  const id = ++connSeq;
  let buffer = Buffer.alloc(0);
  const state = { responded: false, hallLoggedIn: false, resentCards: false };
  sessions.set(id, undefined);
  console.log(`\n=== [${tag}#${id}] client connected from ${socket.remoteAddress}:${socket.remotePort} ===`);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    console.log(`[${tag}#${id}] +${chunk.length}B raw: ${hex(chunk, 64)}`);

    if (buffer.subarray(0, 64).toString("latin1").includes("policy-file-request")) {
      // Flash 要求：回应策略后立即关闭该连接，随后客户端会重新连一次送真实数据。
      socket.end(POLICY);
      console.log(`[${tag}#${id}] -> served socket policy then closed (same-port fallback)`);
      buffer = Buffer.alloc(0);
      return;
    }

    // 客户端连接时会先发 "GET / HTTP/1.1\r\nHost: <DesIP>:<DesPort>"（伪装成 HTTP）
    const asText = buffer.subarray(0, 96).toString("latin1");
    const getEnd = asText.indexOf("\r\n\r\n");
    if (asText.startsWith("GET ") && getEnd !== -1) {
      console.log(`[${tag}#${id}] <- HTTP 伪装前缀: ${JSON.stringify(asText.slice(0, getEnd))}`);
      buffer = buffer.subarray(getEnd + 4);
      if (buffer.length === 0) return;
    }

    // 逐包处理并消费：[1 字节 httpHead][int32 包长][头][体]，包长不含 httpHead
    for (;;) {
      const h = parseHeader(buffer, 1);
      if (h === undefined || h.nPackageLength < 24) break;
      const packetEnd = h.nPackageLength + 1;
      if (buffer.length < packetEnd) break;
      handlePacket(tag, id, socket, state, h, buffer.subarray(h.headerEnd, packetEnd));
      buffer = buffer.subarray(packetEnd);
    }
  });

  socket.on("close", () => {
    sessions.delete(id);
    console.log(`=== [${tag}#${id}] closed ===`);
  });
  socket.on("error", (e) => console.log(`=== [${tag}#${id}] error: ${e.message} ===`));
});

/** 启动 HTTP 站与各 TCP 网关。（作为库被 import 时不会自动启动，见文件末尾） */
export function startServer() {
  httpServer.listen(HTTP_PORT, () => console.log(`http  : http://127.0.0.1:${HTTP_PORT}/`));

  // 加密/填充自检：填充→加密(32轮)→解密(-32轮) 必须还原原文
  const sample = Buffer.from(
    "roundtrip check: 美食大战老鼠 auth response payload 0123456789",
    "utf8",
  );
  const encrypted = xteaEncrypt(padPlaintext(sample), LOCAL_KEY, 32);
  const decrypted = xteaDecrypt(encrypted, LOCAL_KEY, -32);
  console.log(
    decrypted.ok && decrypted.data.equals(sample)
      ? `crypto self-test: OK (${sample.length}B -> ${encrypted.length}B -> ${decrypted.length}B)`
      : `crypto self-test: FAILED (${decrypted.ok ? "mismatch" : decrypted.reason})`,
  );

  for (const [tag, port] of [
    ["generic", GAME_PORT],
    ["auth", AUTH_PORT],
    ["hall", HALL_PORT],
    ["logic", LOGIC_PORT],
  ]) {
    createGateway(tag).listen(port, "0.0.0.0", () =>
      console.log(`${tag.padEnd(7)}: tcp 0.0.0.0:${port}`),
    );
  }

  // Flash 的 socket 策略默认先问 843 端口。非管理员可能绑不上，失败不影响
  // 同端口回落逻辑。
  const policyServer = net.createServer((socket) => {
    console.log("[policy:843] connection");
    socket.end(POLICY);
  });
  policyServer.on("error", (e) => console.log(`[policy:843] unavailable: ${e.code ?? e.message}`));
  policyServer.listen(843, "0.0.0.0", () => console.log("policy: tcp 0.0.0.0:843"));
}

// 只有直接运行 `node local-server.mjs` 才启动服务；
// 被其它脚本 import 时保持安静，方便复用其中的编解码/应答表。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
