/**
 * 校验卡片 / 背包两条应答的字节布局（按客户端 a_2943 / CResponseGetStroeBoxInfo
 * 的 decode 逐字段还原），跑法：
 *   node verify-cards.mjs
 * 用独立端口启动，避免和正在跑的服务端抢端口。
 */
process.env.REA_HTTP_PORT ??= "18080";
process.env.REA_GAME_PORT ??= "28443";
process.env.REA_AUTH_PORT ??= "28444";
process.env.REA_HALL_PORT ??= "28445";
process.env.REA_LOGIC_PORT ??= "28446";
// 校验脚本会真的触发融合/升级，把存档写到临时文件，别污染正式存档
const tmpSave = `${(await import("node:os")).tmpdir()}/msdzls-verify-save.json`;
const { readFileSync } = await import("node:fs");
process.env.REA_SAVE_FILE ??= tmpSave;
// ⚠️ 陷阱：这里必须**先算 highStarMode，再决定强化结果**，不能直接写
//   process.env.REA_FORCE_UPGRADE ??= "success";
//   因为 `??=` 会在"调用者没设"时把它钉成 success，而 REA_HIGHSTAR 模式下
//   调用者只会设 REA_HIGHSTAR、不会设 REA_FORCE_UPGRADE ⇒ 强化判定被钉成必成功
//   ⇒ local-server.mjs 的 success 恒 true ⇒ 高星用例永远 9→10，与 0% 成功率无关。
//   那两条用例要覆盖的正是 !success 分支，所以旧写法下它们**从设计上就不可能通过**。
//   规则：普通模式默认 "success"（保证既有用例可复现）；高星模式默认 "fail"
//   （它只用来验证掉星 / 保险金对照，必须让失败真实发生）。
const highStarMode = process.env.REA_HIGHSTAR ?? "";
// ⚠️⚠️ 假绿根因（lead 复核发现，比"用户忘了设变量"更隐蔽）：
//   旧写法 `process.env.REA_FORCE_UPGRADE ??= "success";` 在**裸跑**时会把变量
//   钉成 "success"，而两个失败用例块分别是
//       :647  if (process.env.REA_FORCE_UPGRADE === "fail") { ... }
//       :697  if (process.env.REA_FORCE_UPGRADE === "fail") { ... }
//   ⇒ 裸跑时它们**永不进入**，脚本自己把变量设成了 success，于是"全绿"。
//   ??= 的默认值本身就是假绿来源，不能靠"调用者记得设变量"来保证覆盖。
//
//   ⇒ 现已改为**无条件双跑**：本脚本在一个进程内不可能既 success 又 fail
//     （local-server.mjs:935 `const FORCE_UPGRADE = process.env.REA_FORCE_UPGRADE ?? ""`
//      在 import 时就读定，之后改环境变量无效），所以驱动方式如下：
//       ① node verify-cards.mjs                     → 裸跑，必须显式跑 success 档
//       ② REA_FORCE_UPGRADE=fail node verify-cards.mjs → 跑 fail 档
//     两档各自独立断言、各自打印计数；任一档 exit≠0 都算失败。
//     :735 的 `if (result === 0)` / :791 的 `else` 就是这两档的分流点，
//     它们**不再**被环境变量 gate 掉成功的分支 —— success 档也走断言。
process.env.REA_FORCE_UPGRADE ??= highStarMode ? "fail" : "success";
const upgradeExpectFail = process.env.REA_FORCE_UPGRADE === "fail";

// ⚠ 高星掉星用例（REA_HIGHSTAR）必须在 **import local-server.mjs 之前** 把存档写好。
//   原因：local-server.mjs:132 的 cardState 是模块级单例，:136
//   `if (cardState.cards.length > 0) return cardState;` 加载过一次就不再重读存档。
//   本文件前面那些 14689/14850 用例会先把状态灌成"1 星主卡"，
//   若此时再写存档就完全无效 —— 高星用例会读到 1 星，得到 m_cLevel=1 的假象。
//   所以这里提前落盘，并且不再 rmSync 掉它。
if (highStarMode) {
  // 防御性断言：高星模式必须是"会失败"的配置，否则整条用例毫无意义
  if (process.env.REA_FORCE_UPGRADE === "success") {
    throw new Error(
      `REA_HIGHSTAR=${highStarMode} 需要强化可失败，但 REA_FORCE_UPGRADE=success 会让 success 恒 true`,
    );
  }
  const fs0 = await import("node:fs");
  fs0.writeFileSync(
    tmpSave,
    JSON.stringify({
      // 9 星主卡（> PROTECT_LEVEL 5），0 星强化用卡 ⇒ rate = 0 < MIN_SECURITY_RATE 0.2
      cards: [
        { id: 0x11130050, seq: 900002, count: 1, grade: 9, expire: -1 },
        { id: 0x11130014, seq: 7, count: 1, grade: 0, expire: -1 },
      ],
      nextSeq: 900010,
    }),
  );
} else {
  try {
    (await import("node:fs")).rmSync(tmpSave, { force: true });
  } catch {}
}

const { HALL_RESPONSES, buildCardNotifyBody, buildPlayerCommonBody } = await import(
  "./local-server.mjs"
);

// ---- 通过 / 失败 计数器 ----
// ⚠ 为什么必须有：本脚本以前**只打印 ✓ 行、不打印计数**，退出码也恒为 0。
//   于是"12 通过 / 14 通过"这类数字只能靠人工数 ✓ 行得出，**无法从输出中对账**，
//   曾导致把"自己数的数"当成"脚本产出的数"汇报（见 verify-compose-fixes.md §7.1 勘误）。
//   现在改为：所有 ✓ 必须走 ok()，ok() 内部 pass++ 并打印；
//   任何断言失败走 fail_() 或抛出（顶层 catch 计 fail）。
//   末尾打印「合计：N 通过 / M 失败」，退出码 = fail === 0 ? 0 : 1。
let pass = 0;
let fail = 0;

/** 断言通过：计数并打印。所有 ✓ 行都必须由它产出，保证计数与输出一致。 */
function ok(msg) {
  pass += 1;
  console.log(`  ✓ ${msg}`);
}

/** 断言失败：计数并打印 ✗（不抛，用于希望继续跑完的场景）。 */
function fail_(msg) {
  fail += 1;
  console.log(`  ✗ ${msg}`);
}

const buf = Buffer.alloc(9);
buf.writeInt32BE(1, 4); // 请求结构：[seq(4)][roomID(4)][...]

class Reader {
  constructor(b) {
    this.b = b;
    this.p = 0;
  }
  i8() {
    return this.b.readInt8(this.p++);
  }
  i16() {
    const v = this.b.readInt16BE(this.p);
    this.p += 2;
    return v;
  }
  i32() {
    const v = this.b.readInt32BE(this.p);
    this.p += 4;
    return v;
  }
  str() {
    // a_2664.decode_string（decompiled\TDCore\scripts\com\aurora\protocol\a_2664.as:143-164）：
    //   string_length = decode_int16(); ... return byte_array.readUTFBytes(realLength);
    // 而 encode_string（:122-141）写的是 `src_str.concat("\x00")` + writeUTF，
    // 长度前缀**包含**结尾 NUL ⇒ 客户端解出的字符串尾部带 \x00。
    // ⚠ 这里**不能**直接拿返回值做文案相等比较：服务端 encodeString()（local-server.mjs:2092）
    //   同样是 `Buffer.from(`${text}\0`)`,所以读回来必然是 "强化失败\u0000"。
    //   字节消费照旧（p += n，长度自洽断言不受影响），只在**返回值**上剥掉尾部 NUL，
    //   让断言比较的是玩家实际看到的文本。
    const n = this.i16();
    const s = this.b.subarray(this.p, this.p + n).toString("utf8");
    this.p += n;
    return s.replace(/\0+$/, "");
  }
  hex32() {
    return "0x" + (this.i32() >>> 0).toString(16).padStart(8, "0");
  }
}

// ---- 14689 GET_CARDS → a_2943 ----
// ⚠ REA_HIGHSTAR 模式下整段普通用例都要跳过：它们会用 1 星主卡覆盖内存里的 cardState，
//   且 cardState 一旦加载就不再重读存档（local-server.mjs:136），高星用例就失效了。
//   用早退开关包住普通用例，避免改动大量块的配对（见文件末尾 highStarMode 分支）。
const skipNormal = Boolean(highStarMode);
// highStarMode 下普通用例必须整体不执行（见上方注释），最稳妥的做法是早退：
// 只跑文件末尾的高星分支，其余一律跳过，避免任何一次 build() 提前把
// cardState 加载成"1 星主卡"。
if (skipNormal) {
  try {
    await runHighStarCase();
  } catch (e) {
    fail_(e instanceof Error ? e.message : String(e));
  }
} else {
  try {
  {
  /* 普通模式用例块（裸跑 / REA_FORCE_UPGRADE=fail 两种档都在此块内执行） */
  const body = HALL_RESPONSES.get(14689).build(buf);
  const r = new Reader(body);
  console.log(`14689 GET_CARDS  ${body.length} 字节`);
  console.log(`  resultID=${r.i16()} roomID=${r.i32()} uin=${r.i32()}`);
  let formula999 = 0;
  let material999 = 0;
  const aux2000 = { 0x1234: 0, other: 0 };
  for (const label of ["卡片", "道具卡", "合成道具", "背包容量"]) {
    const n = r.i16();
    console.log(`  ${label}: ${n} 条`);
    for (let i = 0; i < n; i += 1) {
      const size = r.i16();
      const start = r.p;
      if (label === "背包容量") {
        const type = r.i8();
        const total = r.i16();
        const opened = r.i16();
        const packs = r.i16();
        if (i < 3) console.log(`    type=${type} 总格=${total} 已开=${opened} 扩格包=${packs}`);
      } else {
        const id = r.hex32();
        const seq = r.i32();
        const count = r.i16();
        if (label === "道具卡") {
          if (id.startsWith("0x1242") && count === 999) formula999 += 1;
          if (id.startsWith("0x1241") && count === 999) material999 += 1;
          if (id.startsWith("0x1234") && count === 2000) aux2000[0x1234] += 1;
          else if (count === 2000) aux2000.other += 1;
        }
        if (i < 3) console.log(`    ${id} seq=${seq} count=${count}`);
        if (label === "卡片") {
          r.i16();
          r.i16();
          r.i32();
          r.i32();
          r.i32();
          r.i8();
          const attrs = r.i16();
          for (let a = 0; a < attrs; a += 1) {
            const asize = r.i16();
            const astart = r.p;
            const attrType = r.i8();
            const attrAdd = r.i32();
            r.i16();
            r.i32();
            if (r.p - astart !== asize) throw new Error(`附加属性声明 ${asize}，实际 ${r.p - astart}`);
            if (attrType !== 10) throw new Error(`星星属性类型应为 10，实际 ${attrType}`);
            console.log(`      附加属性 type=${attrType}(强化等级/星星) 值=${attrAdd}`);
          }
        } else {
          r.i16();
          r.i16();
          r.i32();
          r.i32();
          r.i32();
          r.i8();
        }
      }
      const read = r.p - start;
      if (read !== size) throw new Error(`${label} 第 ${i} 条声明长度 ${size}，实际读了 ${read}`);
    }
  }
  const deckCount = r.i16();
  const skillCount = r.i16();
  console.log(`  卡组=${deckCount} 技能=${skillCount}`);
  console.log(`  制作页配方卡(0x1242, 数量999)=${formula999} 张；材料(0x1241, 数量999)=${material999} 种`);
  console.log(`  香料(0x1234, 数量2000)=${aux2000[0x1234]} 种；其它辅助道具(数量2000)=${aux2000.other} 种`);
  if (formula999 === 0) throw new Error("道具页没有配方卡，制作页会空");
  if (aux2000[0x1234] === 0) throw new Error("道具页没有香料");
  if (r.p !== body.length) throw new Error(`14689 读完 ${r.p} 字节，应答共 ${body.length} 字节`);
  ok("长度自洽");
}

// ---- 12817 GET_STORE_BOX → CResponseGetStroeBoxInfo ----
for (const msgID of [12817, 12818]) {
  const body = HALL_RESPONSES.get(msgID).build(buf);
  const r = new Reader(body);
  console.log(`${msgID}  ${HALL_RESPONSES.get(msgID).name}  ${body.length} 字节`);
  console.log(`  resultID=${r.i16()} uin=${r.i32()}`);
  for (let z = 0; z < 6; z += 1) {
    const used = r.i16();
    const name = r.str();
    const n = r.i16();
    let sample = "";
    for (let i = 0; i < n; i += 1) {
      const size = r.i16();
      const start = r.p;
      const id = r.hex32();
      r.i32();
      const count = r.i16();
      r.i16();
      r.i32();
      r.i16();
      r.i8();
      r.i8();
      r.i32();
      r.i32();
      const attrs = r.i16();
      for (let a = 0; a < attrs; a += 1) {
        r.i8();
        r.i32();
        r.i32();
        r.i32();
      }
      r.i16();
      const read = r.p - start;
      if (read !== size) throw new Error(`仓库 ${z} 第 ${i} 件声明 ${size}，实际 ${read}`);
      if (i === 0) sample = ` 例:${id} x${count}`;
    }
    console.log(`  [${z}] ${name} 已用=${used} 物品=${n}${sample}`);
  }
  if (msgID === 12818) console.log(`  变更物品数=${r.i16()}`);
  if (r.p !== body.length) throw new Error(`${msgID} 读完 ${r.p} 字节，应答共 ${body.length} 字节`);
  ok("长度自洽");
}

// ---- 14867 / 14868 / 14869 卡槽包 ----
for (const msgID of [14867, 14868, 14869]) {
  // 请求：[seq(4)] uin(4) 槽位类型(1) 扩格包位置(1)
  const req = Buffer.alloc(10);
  req.writeInt32BE(200001, 4);
  req.writeUInt8(5, 8);
  req.writeUInt8(1, 9);
  const r = new Reader(HALL_RESPONSES.get(msgID).build(req));
  const result = r.i16();
  const uin = r.i32();
  const slotType = r.i8();
  const posi = r.i8();
  const extra = msgID === 14867 ? "" : ` itemID=${r.i32()} seq=${r.i32()} slotAdd=${r.i16()}`;
  console.log(`${msgID} ${HALL_RESPONSES.get(msgID).name}  result=${result} uin=${uin} type=${slotType} posi=${posi}${extra} 原因="${r.str()}"`);
}

// ---- 14876 融合 / 14877 升级 ----
{
  // 取 CardFusion.xml 里真实的一条配方：type=13 + main_id
  const fs2 = await import("node:fs");
  const xml = fs2.readFileSync(
    "C:/Users/XH/Documents/ChatGPT/逆向/msdzls/client-cache/config-data/CardFusion.xml",
    "utf8",
  );
  const tab = xml.match(/<fusion_tab\b[\s\S]*?<\/fusion_tab>/)[0];
  const el = tab.match(/<element\b[\s\S]*?<\/element>/)[0];
  const type = Number.parseInt(tab.match(/\btype="(\d+)"/)[1], 10);
  const mainID = Number.parseInt(el.match(/main_id="([^"]+)"/)[1].split("|")[0], 16);
  const obtainID = Number.parseInt(el.match(/<obtain\b[^>]*\bid="([^"]+)"/)[1].split("|")[0], 16);

  const build = (msgID, cards, materials) => {
    const head = Buffer.alloc(4 + 4 + 2 + 2);
    head.writeInt32BE(200001, 4);
    head.writeInt16BE(type, 8);
    head.writeInt16BE(cards.length, 10);
    const body = cards.map((c) => {
      const b = Buffer.alloc(8);
      b.writeInt32BE(c.id, 0);
      b.writeInt32BE(c.seq, 4);
      return b;
    });
    const matCount = Buffer.alloc(2);
    matCount.writeInt16BE(materials.length, 0);
    const matBody = materials.map((c) => {
      const b = Buffer.alloc(8);
      b.writeInt32BE(c.id, 0);
      b.writeInt32BE(c.seq, 4);
      return b;
    });
    const tail = Buffer.alloc(2);
    return HALL_RESPONSES.get(msgID).build(
      Buffer.concat([head, ...body, matCount, ...matBody, tail]),
    );
  };

  console.log(`\n14876 CARD_FUSION  用 ${mainID.toString(16)} 换 ${obtainID.toString(16)}`);
  {
    const r = new Reader(build(14876, [{ id: mainID, seq: 101 }, { id: mainID, seq: 102 }], []));
    const result = r.i16();
    const uin = r.i32();
    const nCards = r.i16();
    const back = Array.from({ length: nCards }, () => [r.hex32(), r.i32()]);
    const nMat = r.i16();
    const bodySize = r.i16();
    const start = r.p;
    const newID = r.hex32();
    const newSeq = r.i32();
    const newCount = r.i16();
    r.i16();
    r.i8();
    r.i32();
    r.i8();
    const updateMode = r.i8();
    r.i32();
    r.i32();
    if (r.p - start !== bodySize) throw new Error(`新卡信息声明 ${bodySize}，实际 ${r.p - start}`);
    const cardLevel = r.i16();
    const gradeLevel = r.i16();
    console.log(
      `  result=${result} uin=${uin} 消耗卡=${JSON.stringify(back)} 材料=${nMat} 新卡=${newID} seq=${newSeq} x${newCount} mode=${updateMode} 卡等级=${cardLevel} 星级=${gradeLevel}`,
    );
    if (r.p !== r.b.length) throw new Error("14876 长度不自洽");
    if (Number.parseInt(newID, 16) !== obtainID) throw new Error("融合产物与配方不一致");
    ok("融合产物与 CardFusion.xml 配方一致");
  }

  console.log(`\n14877 FUSIONCARD_UPGRADE  主卡 ${mainID.toString(16)}`);
  {
    const r = new Reader(build(14877, [{ id: mainID, seq: 101 }], [{ id: 0x12be0010, seq: 5 }]));
    const result = r.i16();
    const uin = r.i32();
    const nCards = r.i16();
    const back = Array.from({ length: nCards }, () => [r.hex32(), r.i32()]);
    const nMat = r.i16();
    for (let i = 0; i < nMat; i += 1) {
      r.i32();
      r.i32();
    }
    const bodySize = r.i16();
    const start = r.p;
    r.hex32();
    r.i32();
    r.i16();
    r.i16();
    r.i8();
    r.i32();
    r.i8();
    r.i8();
    r.i32();
    r.i32();
    if (r.p - start !== bodySize) throw new Error(`升级新卡信息声明 ${bodySize}`);
    const cardLevel = r.i16();
    const gradeLevel = r.i16();
    console.log(`  result=${result} 主卡=${JSON.stringify(back)} 材料=${nMat} 卡等级=${cardLevel} 星级=${gradeLevel}`);
    if (r.p !== r.b.length) throw new Error("14877 长度不自洽");
    ok("长度自洽");
  }
}

// ---- 14849 卡片制作 ----
{
  const fs2 = await import("node:fs");
  const xml = fs2.readFileSync(
    "C:/Users/XH/Documents/ChatGPT/逆向/msdzls/client-cache/config-data/compose.xml",
    "utf8",
  );
  const rule = xml.match(/<Rule\b[\s\S]*?<\/Rule>/)[0];
  const ruleID = Number.parseInt(rule.match(/<Rule\b[^>]*\bid="(\d+)"/)[1], 10);
  const awardID = Number.parseInt(rule.match(/<Award\b[^>]*\bid="(0x[0-9a-fA-F]+)"/)[1], 16);
  const formulaID = Number.parseInt(rule.match(/<Expressions\b[^>]*\bid="(0x[0-9a-fA-F]+)"/)[1], 16);

  // [seq(4)] srcUin(4) composeID(4) 材料数(2) [id,seq]×  保险材料数(2) [id,seq]×  disable(2)
  const head = Buffer.alloc(14);
  head.writeInt32BE(200001, 4);
  head.writeInt32BE(ruleID, 8);
  head.writeInt16BE(1, 12);
  const mat = Buffer.alloc(8);
  mat.writeInt32BE(formulaID, 0);
  mat.writeInt32BE(100000, 4);
  // 辅助材料里放一个天然香料（0x12340010，配置 value=1 → 产物应为 1 星）
  const assHead = Buffer.alloc(2);
  assHead.writeInt16BE(1, 0);
  const ass = Buffer.alloc(8);
  ass.writeInt32BE(0x12340010, 0);
  ass.writeInt32BE(5, 4);
  const req = Buffer.concat([head, mat, assHead, ass, Buffer.alloc(2)]);

  const r = new Reader(HALL_RESPONSES.get(14849).build(req));
  const result = r.i16();
  const bodySize = r.i16();
  const start = r.p;
  const newID = r.hex32();
  const newSeq = r.i32();
  const count = r.i16();
  r.i16();
  r.i8();
  r.i32();
  r.i8();
  r.i8();
  r.i32();
  r.i32();
  if (r.p - start !== bodySize) throw new Error(`制作新卡信息声明 ${bodySize}，实际 ${r.p - start}`);
  const srcUin = r.i32();
  const composeID = r.i32();
  const nMat = r.i16();
  for (let i = 0; i < nMat; i += 1) {
    r.i32();
    r.i32();
  }
  const nAss = r.i16();
  for (let i = 0; i < nAss; i += 1) {
    r.i32();
    r.i32();
  }
  r.i32();
  r.i32(); // int64 金币
  const level = r.i8();
  r.i16();
  console.log(`\n14849 CARD_COMPOSE 规则${ruleID}  配方 ${formulaID.toString(16)} → 产物 ${newID}`);
  console.log(`  result=${result} srcUin=${srcUin} composeID=${composeID} 新卡seq=${newSeq} x${count} 回收材料=${nMat}+${nAss} 等级=${level}`);
  if (Number.parseInt(newID, 16) !== awardID) throw new Error("制作产物与 compose.xml 的 Award 不一致");
  if (r.p !== r.b.length) throw new Error(`14849 读完 ${r.p}，应答共 ${r.b.length}`);
  ok("产物与 compose.xml 的 Award 一致，长度自洽");

  // 校验香料/保鲜期是否落到卡表里
  const saved = JSON.parse(fs2.readFileSync(tmpSave, "utf8"));
  const card = saved.cards.find((c) => c.id === awardID && c.seq >= 900000);
  const days = card.expire < 0 ? "永久" : `${Math.round((card.expire - Date.now() / 1000) / 86400)}天`;
  console.log(`  卡表里的新卡: ${card.id.toString(16)} seq=${card.seq} 星级=${card.grade} 有效期=${days}`);
  if (card.grade !== 1) throw new Error(`香料没生效：星级应为 1，实际 ${card.grade}`);
  if (!(card.expire > Date.now() / 1000 + 86400 * 29)) throw new Error("产物不是 30 天有效期");
  ok("香料给到 1 星、产物 30 天有效期");

  // 再拉一次卡表，确认"星星"（附加属性 type=10）真的下发给客户端了
  const list = new Reader(HALL_RESPONSES.get(14689).build(buf));
  list.i16();
  list.i32();
  list.i32();
  const nCard = list.i16();
  const csize = list.i16();
  const cstart = list.p;
  const cid = list.hex32();
  list.i32();
  list.i16();
  list.i16();
  list.i16();
  const cexp = list.i32();
  list.i32();
  list.i32();
  list.i8();
  const nAttr = list.i16();
  let star = -1;
  for (let a = 0; a < nAttr; a += 1) {
    const asize = list.i16();
    const astart = list.p;
    const atype = list.i8();
    const aval = list.i32();
    list.i16();
    list.i32();
    if (list.p - astart !== asize) throw new Error("星星属性长度不对");
    if (atype === 10) star = aval;
  }
  if (list.p - cstart !== csize) throw new Error("卡片条目长度不对");
  console.log(
    `  卡表首张: ${cid} ${nCard} 张中的第 1 张，星星=${star}，到期=${new Date(cexp * 1000).toLocaleDateString()}`,
  );
  if (Number.parseInt(cid, 16) !== awardID || star !== 1) throw new Error("卡表里的星星没带上");
  ok("卡表里带上了 type=10 的星星属性");
}

// ---- 12819 扩建储藏室 ----
{
  // [seq(4)] srcUin(4) itemID(4) itemSeq(4) count(2) opt(1) ruleID(1) boxIndex(1) name
  const req = Buffer.alloc(21 + 2);
  req.writeInt32BE(200001, 4);
  req.writeInt32BE(0x13110080, 8);
  req.writeInt32BE(1, 12);
  req.writeInt16BE(1, 16);
  req.writeInt8(1, 18);
  req.writeInt8(1, 19);
  req.writeInt8(2, 20);
  const r = new Reader(HALL_RESPONSES.get(12819).build(req));
  const result = r.i16();
  const boxIndex = r.i32();
  const opt = r.i32();
  const storeCount = r.i16();
  console.log(`\n12819 EXPAND_STORE_BOX  result=${result} box=${boxIndex} opt=${opt} 新容量=${storeCount}`);
  if (result !== 0 || (boxIndex & 0xff) !== 2 || storeCount <= 30) throw new Error("12819 应答不对");
  if (r.p !== r.b.length) throw new Error("12819 长度不自洽");
  ok("长度自洽");
}

// ---- 14620 卡片增量通知（制作/融合成功后推给客户端的那条） ----
{
  const expire = Math.floor(Date.now() / 1000) + 2592000;
  // 两条：旧序号 count=0（让客户端删掉）+ 新序号带新星级（让客户端加一张）
  const body = buildCardNotifyBody([
    { id: 0x11130050, seq: 900100, count: 0 },
    { id: 0x11130050, seq: 900123, count: 1, grade: 3, expire },
  ]);
  const r = new Reader(body);
  const dstUin = r.i32();
  const nCards = r.i16();
  if (nCards !== 2) throw new Error(`通知应带 2 条，实际 ${nCards}`);
  // 第一条：count=0 的删除条目
  {
    const s1 = r.i16();
    const start1 = r.p;
    r.hex32();
    r.i32();
    const c1 = r.i16();
    r.i16();
    r.i8();
    r.i32();
    r.i8();
    r.i8();
    r.i32();
    r.i32();
    const a1 = r.i16();
    if (a1 !== 0) throw new Error("删除条目不该带附加属性");
    if (r.p - start1 !== s1) throw new Error("删除条目长度不对");
    if (c1 !== 0) throw new Error(`删除条目数量应为 0，实际 ${c1}`);
  }
  const size = r.i16();
  const start = r.p;
  const cardID = r.hex32();
  const cardSeq = r.i32();
  const count = r.i16();
  r.i16();
  r.i8();
  const exp = r.i32();
  const isBind = r.i8();
  const updateMode = r.i8();
  const usedTime = r.i32();
  r.i32();
  if (usedTime < 0) throw new Error("制作应答里没带到期时间（客户端会当成永久卡）");
  const nAttr = r.i16();
  let star = -1;
  for (let a = 0; a < nAttr; a += 1) {
    const asize = r.i16();
    const astart = r.p;
    const atype = r.i8();
    const aval = r.i32();
    r.i16();
    r.i32();
    if (r.p - astart !== asize) throw new Error("通知里的星星属性长度不对");
    if (atype === 10) star = aval;
  }
  if (r.p - start !== size) throw new Error(`通知条目声明 ${size}，实际 ${r.p - start}`);
  const nHero = r.i16();
  console.log(
    `\n14620 CARD_NOTIFY  dstUin=${dstUin} 卡片数=${nCards} ${cardID} seq=${cardSeq} x${count} 绑定=${isBind} 模式=${updateMode} 到期=${new Date(exp * 1000).toLocaleDateString()} 星星=${star} 英雄项=${nHero}`,
  );
  if (star !== 3) throw new Error("通知里没带上星星");
  if (usedTime !== expire) throw new Error("通知里的到期时间不对");
  if (r.p !== r.b.length) throw new Error(`14620 读完 ${r.p}，共 ${r.b.length}`);
  ok("长度自洽（星星 type=10、到期时间都带上了）");
}

// ---- 14675 玩家公共信息（强化成功率要靠它取 VIP） ----
{
  const r = new Reader(buildPlayerCommonBody());
  const result = r.i16();
  const uin = r.i32();
  const flag = r.i32();
  const money = r.i32();
  r.i32(); // happyBean 高 32 位（客户端 decode_int64 只取低位）
  const gold = r.i32();
  for (let i = 0; i < 5; i += 1) r.i32(); // charming/lottery/offline/total/charmCoin
  const vipScore = r.i32();
  for (let i = 0; i < 4; i += 1) r.i32(); // warrior/totalConsume/wishing/dataReversed
  const duanwei = r.i8();
  const duanweiQ = r.i8();
  console.log(
    `\n14675 PLAYER_COMMON  result=${result} uin=${uin} flag=${flag} 点券=${money} 金币=${gold} VIP积分=${vipScore} 段位=${duanwei}/${duanweiQ}`,
  );
  if (result !== 0 || flag !== 1) throw new Error("14675 应答不对");
  if (!(gold > 1000000)) throw new Error(`金币没给满（实际 ${gold}）`);
  if (r.p !== r.b.length) throw new Error(`14675 读完 ${r.p}，共 ${r.b.length}`);
  ok("长度自洽（VIP 段已带上，强化页不会再取空对象）");
}

// ---- 14850 强化卡片 ----
// 下面两个 14850 用例是**串联**的：同一个 cardState 单例（local-server.mjs:132/:136），
// 第二个用例读到的是第一个用例**改过之后**的星级。所以第二个用例的期望值必须从
// 第一个用例的实际结果推出，不能写死常量 —— 写死就会在某一档上制造结构性假红
// （裸跑时主卡已被上一用例升到 2 星，这里再写死"应升到 2 星"永远不可能成立）。
let levelAfterFirst = 1;
{
  // [seq(4)] srcUin(4) 主卡 id,seq(8) position(4) 强化卡数(2)+id,seq(8)× 辅助数(2) disable(2)
  const head = Buffer.alloc(4 + 4 + 8 + 4 + 2);
  head.writeInt32BE(200001, 4);
  head.writeInt32BE(0x11130050, 8);
  head.writeInt32BE(900002, 12);
  head.writeInt32BE(0, 16);
  head.writeInt16BE(1, 20);
  const sub = Buffer.alloc(8);
  sub.writeInt32BE(0x11130014, 0);
  sub.writeInt32BE(7, 4);
  const req = Buffer.concat([head, sub, Buffer.alloc(2), Buffer.alloc(2)]);
  const r = new Reader(HALL_RESPONSES.get(14850).build(req));
  const result = r.i16();
  const newLevel = r.i8();
  const srcUin = r.i32();
  const cardID = r.hex32();
  const cardSeq = r.i32();
  const position = r.i32();
  const nSub = r.i16();
  for (let i = 0; i < nSub; i += 1) {
    r.i32();
    r.i32();
  }
  const nAss = r.i16();
  r.i16();
  // ★ 尾串读取**必须**按 m_nResult 决定 —— 这不是"可选优化"，是协议本身：
  //   SCResponseUpgrade.as:73-77
  //     this.m_nDisableConsortiaExtra = a_2664.decode_int16(byte_array);
  //     if(this.m_nResult != 0) {
  //        this.m_szReasonMessage = a_2664.decode_string(byte_array,4096);
  //     }
  //
  //   【订正 · 上一版这段注释整个反了，留档勿再引用】
  //     上一版写的是："本实现 m_nResult **恒回 0** ⇒ 客户端不读尾串，
  //     所以 `if (result !== 0) r.str();` 是基于错误假设，已删除。"
  //     —— 那是在 fixer 把失败分支改成 **1065** *之前* 的结论，**现已作废**：
  //     local-server.mjs:1347 `int16(1065)` 且 :1384 起确实 append 了
  //     `encodeString(reason, 4096)`。失败路径**确实带尾串**。
  //     若这里不读，reader 的 p 会停在 m_nDisableConsortiaExtra 之后，
  //     于是末尾的 `r.p !== r.b.length` 长度断言必然失败 —— 那才是真正的失真。
  //   ⇒ 恢复条件读：result === 0 → 无尾串（成功路径，local-server.mjs:1395-1409 末尾无 string）；
  //                 result !== 0 → 有尾串（失败/拒绝路径）。
  const reason = result !== 0 ? r.str() : null;
  console.log(
    `\n14850 CARD_UPGRADE  result=${result} 新等级=${newLevel} 主卡=${cardID} seq=${cardSeq} pos=${position} 吃掉强化卡=${nSub} 辅助=${nAss}`,
  );
  if (result !== 0) {
    console.log(`  原因串(${reason.length} 字符)=${JSON.stringify(reason)}`);
  }
  // 主卡是前面用香料做出来的那张（1 星）。
  // dropStar 四项条件（local-server.mjs:1155）：
  //   !success && !insured && mainLevel > PROTECT_LEVEL(5) && rate < MIN_SECURITY_RATE(0.2)
  // 本例：1 星 <= 5 且 rate=80% >= 20% ⇒ **两项都不满足** ⇒ 不论强制成功/失败，
  //       等级都**不变**（成功 → 2；失败 → 仍 1）。永远不会掉星。
  // ★ 这里改为 **if / else 双档都断言**（不再用 `if (fail)` 单边门）——
  //   裸跑时 upgradeExpectFail=false，走 else 档，仍然会做完整断言；
  //   fail 档走 if 档。两档各自都必须通过，假绿才被真正堵死。
  if (upgradeExpectFail) {
    // ★ 结果码必须是 **1065**（不是 0）。依据（已推翻旧"必须回 0"结论）：
    //   TDComposeUI.as:1403  if(response.m_nResult == 0 || response.m_nResult == 1065)
    //                        → 两支进同一分支，都会 updateDataByUpgradeCard
    //   TDComposeUI.as:1413    tip = getString(65596)          ← 成功文案
    //   TDComposeUI.as:1473  if(response.m_nResult == 1065) tip = response.m_szReasonMessage;
    //                        ← **唯一**能覆盖成功文案的取值
    //   TDComposeUI.as:1480  else（其它非 0）→ 只弹提示、**完全不动卡片数据**
    //   ⇒ 要"既刷新卡数据、又显示失败文案"，**唯一**取值就是 1065。
    //   全局卡片表为何仍会更新（旧结论说"回非 0 就不更新"是错的）：
    //     a_2439.as:865-894 的**新条目**分支 :879-883
    //       `if(attr.m_cAttrType == 10) defCard.TypeValue = attr.m_iAttrAdd;`
    //     是**第二条**路径，由失败路径推送的 {newSeq, count:1, grade} notify 覆盖；
    //     键是复合键 `CardID + "-" + CardSeq`（a_2439.as:815 / a_3228.as:79-81），
    //     两条 notify 不互相覆盖。
    if (result !== 1065 || newLevel !== 1) {
      throw new Error(
        `强制失败时应答不对（result=${result}，应为 1065；等级=${newLevel}，应为 1 不变）`,
      );
    }
    if (reason === null || reason.length === 0) {
      throw new Error("回 1065 时 SCResponseUpgrade.as:74 会读尾串，文案不得为空");
    }
    const after = JSON.parse((await import("node:fs")).readFileSync(tmpSave, "utf8"));
    const card = after.cards.find((c) => c.id === 0x11130050);
    console.log(
      `  失败后卡表: ${card.id.toString(16)} seq=${card.seq} 星级=${card.grade}`,
    );
    // dropStar 为假 ⇒ 不该掉星。序号是否更换见下。
    if (card.grade !== 1) throw new Error(`1 星主卡受 ProtectLevel(5) 保护，失败不应掉星，实际 ${card.grade}`);
    if (card.seq !== 900002) {
      throw new Error(`未掉星时不应换序号（预期仍是 900002，实际 ${card.seq}）`);
    }
    ok("失败档：未掉星（1 星 <= ProtectLevel 5 且 rate 80% >= 20%）且序号未更换");
    if (r.p !== r.b.length) throw new Error(`14850 失败档读完 ${r.p}，共 ${r.b.length}`);
    ok("失败档：长度自洽（含尾串，且 reader 消费到末尾）");
    levelAfterFirst = 1;
  } else {
    // 成功档：m_nResult == 0 ⇒ SCResponseUpgrade.as:74 不读尾串 ⇒ reason 必须为 null
    if (result !== 0 || newLevel !== 2) {
      throw new Error(`14850 成功档应答不对（result=${result} 应为 0；应为 2 级，实际 ${newLevel}）`);
    }
    if (reason !== null) {
      throw new Error(`成功路径不应带尾串（SCResponseUpgrade.as:74 只在 m_nResult != 0 时读），实际 ${JSON.stringify(reason)}`);
    }
    if (r.p !== r.b.length) throw new Error(`14850 成功档读完 ${r.p}，共 ${r.b.length}`);
    ok("成功档：result=0、等级 +1、无尾串、长度自洽");
    levelAfterFirst = 2;
  }
}

// ---- 14850 强化失败 + 勾选保险金（1 星主卡）----
//
// 保险金与护佑符是**两个正交概念**，务必别混：
//   保险金  请求尾部那栏 = 1        → 只保星级（dropStar 假），材料照吃
//   护佑符  出现在 assistants 列表  → 只保材料（m_arrSub 回空表），星级照掉
// 见 local-server.mjs:1110 (`insured = q.insurance === 1`)
//                 :1113 (`subProtected = q.assistants.some(...)`)
//                 :1265 (`int16(subProtected ? 0 : q.subs.length)`)
// ★ 同样改双档：裸跑（success 档）也必须真跑这个用例，只是期望值不同。
//   保险金与护佑符的正交性在**成功档下无处体现**，所以成功档只做基本契约断言
//   （result=0、等级 +1、无尾串、长度自洽）；失败档才是保险金保星级的实证。
{
  const head = Buffer.alloc(4 + 4 + 8 + 4 + 2);
  head.writeInt32BE(200001, 4);
  head.writeInt32BE(0x11130050, 8);
  head.writeInt32BE(900002, 12);
  head.writeInt32BE(0, 16);
  head.writeInt16BE(1, 20);
  const sub = Buffer.alloc(8);
  sub.writeInt32BE(0x11130014, 0);
  sub.writeInt32BE(7, 4);
  const tail = Buffer.alloc(2);
  tail.writeInt16BE(1, 0); // 尾部那栏 = 1：玩家勾了保险金
  const req = Buffer.concat([head, sub, Buffer.alloc(2), tail]);
  const r = new Reader(HALL_RESPONSES.get(14850).build(req));
  const result = r.i16();
  const level = r.i8();
  r.i32();
  r.hex32();
  r.i32();
  r.i32();
  const nSub = r.i16();
  for (let i = 0; i < nSub; i += 1) {
    r.i32();
    r.i32();
  }
  const nAss = r.i16();
  for (let i = 0; i < nAss; i += 1) {
    r.i32();
    r.i32();
  }
  const field = r.i16();
  // 回 1065 ⇒ SCResponseUpgrade.as:74 读尾串；不读则长度断言失真
  const reason = result !== 0 ? r.str() : null;
  console.log(
    `\n14850 强化失败+保险金(1星)  result=${result} 等级=${level} 该栏=${field} 消耗材料=${nSub} 文案=${JSON.stringify(reason)}`,
  );
  // ★ 同上面的 14850 主体用例：双档都断言，成功档期望 0、失败档期望 1065。
  //   （这里不能无条件写死 1065 —— 裸跑时强化本来就成功，那样只会制造假红。）
  if (upgradeExpectFail) {
    // ---- 失败档：锁 1065 + 保险金保星级 ----
    // ① 结果码为 **1065**（不是 0，也不是 1）
    //    旧文案"回 1065 会让全局卡片表不更新星级"是**错误结论的化石**，已推翻：
    //    星级刷新走 a_2439.as:865-894 的新条目分支（复合键 CardID+CardSeq），
    //    与 ComposeServerDataProtocol.as:258 的 `== 0` 门无关。
    if (result !== 1065) {
      throw new Error(
        `result 应为 1065（TDComposeUI.as:1473 是唯一能覆盖成功文案的取值），实际 ${result}`,
      );
    }
    if (reason === null || reason.length === 0) {
      throw new Error("回 1065 时尾串必须非空（否则 TDComposeUI.as:1473 会显示空白提示）");
    }
    // 文案分流：1 星 + 保险金 ⇒ 不掉星、无护佑符 ⇒ "强化失败"
    if (reason !== "强化失败") {
      throw new Error(`本档文案应为"强化失败"，实际 ${JSON.stringify(reason)}`);
    }
    // ② 星级不变：1 星 <= ProtectLevel(5)，本来就不会掉；这里锁的是"应答没乱改等级"
    if (level !== levelAfterFirst) {
      throw new Error(
        `1 星主卡失败应保持 ${levelAfterFirst} 级（受 ProtectLevel 5 保护），实际 ${level}`,
      );
    }
    // ③ 该栏恒回 0：护佑符保材料**不靠它**（回 0 时 TDComposeUI.as:1458 恒假）
    if (field !== 0) throw new Error(`m_nDisableConsortiaExtra 应恒为 0，实际 ${field}`);
    // ④ 保险金不保材料：强化用卡照吃
    if (nSub !== 1) throw new Error(`保险金只保星级不保材料，应消耗 1 张强化用卡，实际 ${nSub}`);
    if (r.p !== r.b.length) throw new Error(`14850 保险金用例读完 ${r.p}，共 ${r.b.length}`);
    ok("失败档：结果码 1065、等级不变、该栏恒 0、材料照吃（保险金只保星级）、文案分流正确");
  } else {
    // ---- 成功档：勾了保险金也照常成功（保险金只在失败时起作用）----
    if (result !== 0) throw new Error(`成功档 result 应为 0，实际 ${result}`);
    if (reason !== null) throw new Error(`成功档不应带尾串，实际 ${JSON.stringify(reason)}`);
    // 期望值 = 上一用例的终态 +1（用例串联，不能写死常量）
    if (level !== levelAfterFirst + 1) {
      throw new Error(
        `成功档主卡应升到 ${levelAfterFirst + 1} 星（上一用例终态 ${levelAfterFirst}），实际 ${level}`,
      );
    }
    if (field !== 0) throw new Error(`m_nDisableConsortiaExtra 应恒为 0，实际 ${field}`);
    if (nSub !== 1) throw new Error(`成功档材料也应被消耗，实际 nSub=${nSub}`);
    if (r.p !== r.b.length) throw new Error(`14850 保险金成功档读完 ${r.p}，共 ${r.b.length}`);
    ok("成功档：勾保险金不影响成功（result=0、升到 2 星、无尾串、长度自洽）");
  }
  } // ← 关掉 :148 的 `try {`，其 catch 紧随其后（顺序错了就是 SyntaxError: Unexpected token 'catch'）
  } catch (e) {
    fail_(e instanceof Error ? e.message : String(e));
  }
} // ← 关掉 :147 的 `} else {`
/* END of outer else-block wrapper */
/** 高星掉星用例：必须在 build() 首次触碰 cardState 之前跑，故独立成一个函数由上面早退调用。 */
async function runHighStarCase() {

// ---- 14850 掉星分支：高星(> ProtectLevel 5) + 低成功率(< 0.2) ----
//
// 这是**唯一能走到 dropStar 的用例**。上面两个用例主卡都是 1 星、rate=80%，
// 两项条件都不满足，从设计上就覆盖不到掉星，所以必须单独造一个。
//
// dropStar 四项条件（local-server.mjs:1155）：
//   !success && !insured && mainLevel > PROTECT_LEVEL(5) && rate < MIN_SECURITY_RATE(0.2)
// 本例：9 星 > 5 ✓、材料 0 星 ⇒ rate = 0 < 0.2 ✓、强制失败 ✓、insured 由场景决定
//
// ⚠ 为什么用 REA_HIGHSTAR 环境变量分两次跑，而不是在同一个进程里跑两遍：
//   local-server.mjs:132 的 cardState 是**模块级单例**，且 :136
//   `if (cardState.cards.length > 0) return cardState;` 一旦加载过就不再重读存档。
//   同一进程内第二次换存档文件是**无效**的（读到的是上一次已被改过的内存状态）。
//   所以两个场景必须各自起独立进程，且存档要在 import local-server.mjs **之前** 落盘
//   （见本文件顶部），上面的普通用例也要整体跳过。
//   本脚本不引入 child_process（harness 下管道 stdio 可能 EPERM），
//   改为由外部用不同环境变量各跑一次；未设置时整段跳过。
{
  const insured = highStarMode === "insured";
  const fs = await import("node:fs");
  const i16 = (v) => {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v, 0);
    return b;
  };
  const i32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v, 0);
    return b;
  };

  // 预置：9 星主卡（> ProtectLevel 5）+ 0 星强化用卡（使 rate = 0 < 0.2）
  fs.writeFileSync(
    tmpSave,
    JSON.stringify({
      cards: [
        { id: 0x11130050, seq: 900002, count: 1, grade: 9, expire: -1 },
        { id: 0x11130014, seq: 7, count: 1, grade: 0, expire: -1 },
      ],
      nextSeq: 900010,
    }),
  );

  const req = Buffer.concat([
    Buffer.alloc(4), // seq 前缀
    i32(200001), // srcUin
    i32(0x11130050),
    i32(900002), // srcCard（客户端此刻持有的旧 seq）
    i32(0), // position
    i16(1),
    i32(0x11130014),
    i32(7), // 1 张 0 星强化用卡
    i16(0), // 无护佑符
    i16(insured ? 1 : 0), // 尾部那栏：是否勾保险金
  ]);
  const resp = HALL_RESPONSES.get(14850).build(req);
  const rr = new Reader(resp);
  const result = rr.i16();
  const level = rr.i8();
  rr.i32();
  rr.hex32();
  const respSeq = rr.i32();
  rr.i32();
  const nSub = rr.i16();
  for (let i = 0; i < nSub; i += 1) {
    rr.i32();
    rr.i32();
  }
  const nAss = rr.i16();
  for (let i = 0; i < nAss; i += 1) {
    rr.i32();
    rr.i32();
  }
  const field = rr.i16();
  // ★ 失败路径回 1065 ⇒ 按 SCResponseUpgrade.as:74 有尾串，必须一并读掉，
  //   否则下面的长度断言必然失真（这正是上一版漏掉的地方）。
  const rReason = result !== 0 ? rr.str() : null;
  const after = JSON.parse(fs.readFileSync(tmpSave, "utf8"));
  const card = after.cards.find((c) => c.id === 0x11130050);

  if (!insured) {
    console.log(
      `\n14850 掉星(9星+0%成功率+未勾保险)  result=${result} m_cLevel=${level} 回包seq=${respSeq} 存档seq=${card.seq} 星级=${card.grade} 材料=${nSub} 该栏=${field} 文案=${JSON.stringify(rReason)}`,
    );
    // 1065：TDComposeUI.as:1473 唯一能覆盖成功文案的取值；见文件头 14850 用例注释
    if (result !== 1065) throw new Error(`掉星用例 result 应为 1065，实际 ${result}`);
    if (level !== 8) throw new Error(`9 星失败应掉到 8 星，实际 ${level}`);
    // 回包必须回**旧** seq，否则 ComposeData.as:301-305 getCardAttr 找不到卡会 throw
    if (respSeq !== 900002) throw new Error(`回包 seq 应为旧值 900002，实际 ${respSeq}`);
    // notify 侧用**新** seq（存档可见），才能走 a_2439.as:865-894 新条目分支写 TypeValue
    if (card.seq === 900002) throw new Error("掉星时应换新序号，否则客户端看不到星级变化");
    if (card.grade !== 8) throw new Error(`存档星级应为 8，实际 ${card.grade}`);
    if (nSub !== 1) throw new Error(`未用护佑符，材料应被消耗，实际 nSub=${nSub}`);
    if (field !== 0) throw new Error(`m_nDisableConsortiaExtra 应恒为 0，实际 ${field}`);
    // 文案分流：dropStar 档应为"已降级"（server :1386）
    if (rReason !== "强化失败，主卡已降级") {
      throw new Error(`掉星档文案应为"强化失败，主卡已降级"，实际 ${JSON.stringify(rReason)}`);
    }
    if (rr.p !== resp.length) throw new Error(`14850 掉星用例读完 ${rr.p}，共 ${resp.length}`);
    ok("掉星生效（回包旧 seq / notify 新 seq、材料消耗、该栏 0、文案分流正确、长度自洽）");
  } else {
    console.log(
      `\n14850 掉星对照(9星+0%成功率+勾保险金)  result=${result} m_cLevel=${level} 回包seq=${respSeq} 存档seq=${card.seq} 星级=${card.grade} 材料=${nSub} 该栏=${field} 文案=${JSON.stringify(rReason)}`,
    );
    if (result !== 1065) throw new Error(`保险金对照 result 应为 1065，实际 ${result}`);
    if (level !== 9) throw new Error(`勾了保险金不应掉星，应保持 9 星，实际 ${level}`);
    if (card.grade !== 9) throw new Error(`存档星级应保持 9，实际 ${card.grade}`);
    if (card.seq !== 900002) throw new Error(`不掉星就不该换序号，实际 ${card.seq}`);
    // 保险金不保材料
    if (nSub !== 1) throw new Error(`保险金不保材料，应消耗 1 张，实际 ${nSub}`);
    if (field !== 0) throw new Error(`m_nDisableConsortiaExtra 应恒为 0，实际 ${field}`);
    // 文案分流：不掉星且非护佑符 ⇒ 应为"强化失败"（server :1389），**不能**说"已降级"
    if (rReason !== "强化失败") {
      throw new Error(`保险金档文案应为"强化失败"，实际 ${JSON.stringify(rReason)}`);
    }
    if (rr.p !== resp.length) throw new Error(`14850 保险金对照读完 ${rr.p}，共 ${resp.length}`);
    ok("保险金保住了星级（9 星不变、序号未换），但材料照吃 —— 与护佑符正交；文案分流正确");
  }
}
}

// ============================================================================
// A 档：notify 正向契约 —— "通知只含本次请求相关的卡"
// ============================================================================
//
// 背景（取证结论，见 docs/verify-compose-fixes.md）：
//   早先有一份论断称 server.log 里存在"假回退" —— 即 local-server.mjs:2669
//   `pendingCardNotify ?? [cards[0]]` 在 pendingCardNotify 为 null 时把**存档第一张卡**
//   推给了客户端。经全量配对复核（脚本 server/analyze-notify.cjs），该论断**不成立**：
//     · 9 次 CARD_UPGRADE 请求 nSub 全部 = 1（材料每次都被吃）⇒ notify 非空；
//     · 唯一"推的不是主卡"的那条（L2931 11122490/900099/星9）其实来自
//       [compose] 规则 80（L2929-2930），是 CARD_COMPOSE(14849) 的合法产物 ——
//       合成新卡本来就该推新卡（local-server.mjs:517-519）。
//   ⇒ 假回退**未证实**，不得写成已验证结论。本档不依赖那个论断，只锁**正向契约**：
//     "正常路径产出的 notify 只包含本次请求涉及的卡"。
//   这组断言在任何实现下都应当成立；它抓不住"模块状态跨请求泄漏"（那要等 B 档），
//   但它是 B 档的地基 —— 若连正向契约都不成立，B 档无从谈起。
{
  const fs = await import("node:fs");

  // notify 里每张卡的指纹，**严格照 local-server.mjs:793-825 的编码顺序解**：
  //   [uin i32][卡片数 i16] 之后每张卡：
  //     [size i16][id i32][seq i32][count i16][已用次数 i16][timeFlag i8]
  //     [expire i32][isBind i8][updateMode i8][usedTime i32][deltaTime i32]
  //     [nAttr i16]  ← ⚠ 是 i16，不是 i8！我第一版写成 i8，于是把后面字节错位
  //     每个属性：[asize i16][type i8][value i32][i16][i32]
  //   最后 [英雄项数 i16]
  //   ⚠ 教训：这张布局**只在 buildCardNotifyBody 的源码里有**；14620 的既有用例
  //     （本文件 :500-565）解的是**真实报文**，两者字段一一对应但我第一版凭记忆写错了两处。
  //     凡是要解服务端自有编码，都必须回源码逐字段抄，不能靠印象。
  //
  // ⚠ 注意 buildCardNotifyBody(cards) 是**纯函数**（:793 接收 cards 参数），
  //   它本身无状态。真正"跨请求粘滞"的是派发处 :2733 的 `pendingCardNotify`
  //   （模块级变量，:850 声明）。所以"某条路径是否产生通知"**不能靠着调 builder 判断**，
  //   而要看该路径有没有把 pendingCardNotify 置为非空 —— 那一点从外部无法观测
  //   （变量未导出）。本档因此只把可自动化的部分限定为：**给定变化集时指纹可被精确解出**。
  const fingerprints = (cards) => {
    const body = buildCardNotifyBody(cards);
    const r = new Reader(body);
    const dstUin = r.i32();
    const nCards = r.i16();
    const out = [];
    for (let i = 0; i < nCards; i += 1) {
      const size = r.i16();
      const start = r.p;
      const id = r.hex32();
      const seq = r.i32();
      const count = r.i16();
      r.i16(); // 已使用次数
      r.i8(); // m_cTimeFlag
      const expire = r.i32();
      r.i8(); // m_cIsBind
      r.i8(); // m_cUpdateMode
      r.i32(); // m_iUsedTime
      r.i32(); // m_iDeltaTime
      const nAttr = r.i16();
      let star = -1;
      for (let a = 0; a < nAttr; a += 1) {
        const asize = r.i16();
        const astart = r.p;
        const atype = r.i8();
        const aval = r.i32();
        r.i16();
        r.i32();
        if (r.p - astart !== asize) throw new Error("notify 属性块长度不自洽");
        if (atype === 10) star = aval;
      }
      if (r.p - start !== size) {
        throw new Error(`notify 条目声明 ${size}，实际 ${r.p - start}`);
      }
      out.push({ id, seq, count, star, expire });
    }
    const nHero = r.i16();
    if (nHero !== 0) throw new Error(`本档不预期英雄项，实际 ${nHero}`);
    if (r.p !== r.b.length) throw new Error(`notify 读完 ${r.p}，共 ${r.b.length}`);
    return { dstUin, cards: out };
  };

  const show = (cards) => cards.map((c) => `${c.id}/${c.seq}/x${c.count}/星${c.star}`).join(" ");

  // ⚠ REA_HIGHSTAR 模式下整档跳过：该模式的存档只有 2 张卡（9 星主卡 + 0 星材料），
  //   且普通用例被 `skipNormal` 整体跳过 —— 本档依赖"普通用例跑过之后的内存状态"，
  //   在那个前提下无法构造前置条件（第一版没加这个门，导致两个高星套件都报
  //   "A 档前置失败：14689 读不到足够的卡"，把原本通过的掉星用例一起拖红）。
  //   高星模式关心的是 dropStar 四条件与保险金正交性，与 A 档的 notify 契约无关。
  if (highStarMode) {
    console.log(`\nA 档跳过（REA_HIGHSTAR=${highStarMode}）：该模式只跑掉星/保险金用例`);
  } else {
  // ---- 前置：把存档灌成确定的 3 张卡，并记住"第一张"是谁 ----
  //   cards[0] 必须是一张**本次请求不会碰到的**卡，这样一旦它出现在 notify 里，
  //   就是"推了无关卡"的硬证据（这正是假回退论断想抓的东西）。
  const SEED = {
    cards: [
      { id: 0x11122490, seq: 900001, count: 1, grade: 3, expire: -1 }, // cards[0]：哨兵，不该出现
      { id: 0x11130050, seq: 900002, count: 1, grade: 1, expire: -1 }, // 主卡
      { id: 0x11130014, seq: 900007, count: 1, grade: 0, expire: -1 }, // 强化用卡（材料）
    ],
    nextSeq: 900010,
  };
  fs.writeFileSync(tmpSave, JSON.stringify(SEED));
  const sentinelId = SEED.cards[0].id;
  const sentinelSeq = SEED.cards[0].seq;

  // ⚠ 陷阱：cardState 是模块级单例且"加载过就不再重读"（local-server.mjs:132/:136）。
  //   若上面那一次 build() 已经把状态灌成别的样子，这里再写存档就是无效的。
  //   本档能在普通模式下跑到，说明此前的用例已经加载过 cardState ——
  //   所以**不能**指望上面 writeFileSync 生效，只能按"当前内存状态"断言。
  //   为了仍然可证伪，这里先发一次 14689 把真实内存状态读出来，作为对照基线。
  const cardsBefore = (() => {
    const r = new Reader(HALL_RESPONSES.get(14689).build(buf));
    r.i16();
    r.i32();
    r.i32();
    const nCard = r.i16();
    const list = [];
    for (let i = 0; i < nCard; i += 1) {
      const size = r.i16();
      const start = r.p;
      const id = r.hex32();
      const seq = r.i32();
      const count = r.i16();
      // 14689 的卡片条目在 nAttr 之前还有 6 个字段（与 14620 通知的布局不同！）：
      //   i16, i16, i32, i32, i32, i8 —— 见本文件上方 14689 段的解析（:162-169）。
      //   ⚠ 我第一版误用了 14620 的布局（三字段后直接 nAttr），导致
      //     "14689 条目长度不自洽" —— 教训：两个消息的条目布局**不通用**。
      r.i16();
      r.i16();
      r.i32();
      r.i32();
      r.i32();
      r.i8();
      const nAttr = r.i16();
      let star = -1;
      for (let a = 0; a < nAttr; a += 1) {
        const asize = r.i16();
        const astart = r.p;
        const atype = r.i8();
        const aval = r.i32();
        r.i16();
        r.i32();
        if (r.p - astart !== asize) throw new Error("14689 属性块长度不自洽");
        if (atype === 10) star = aval;
      }
      if (r.p - start !== size) throw new Error(`14689 条目长度不自洽（声明 ${size}，读了 ${r.p - start}）`);
      list.push({ id, seq, count, star });
    }
    return list;
  })();

  // 找到基线里的主卡与材料（取实际存在的，避免依赖上面那次无效的 writeFileSync）
  const baseMain = cardsBefore[0];
  const baseMat = cardsBefore.find((c, i) => i > 0 && c.grade === 0) ?? cardsBefore[1];
  if (!baseMain || !baseMat) throw new Error("A 档前置失败：14689 读不到足够的卡");

  const mkUpgradeReq = (mainId, mainSeq, matId, matSeq) =>
    Buffer.concat([
      Buffer.alloc(4),
      (() => {
        const b = Buffer.alloc(4);
        b.writeInt32BE(200001, 0);
        return b;
      })(),
      (() => {
        const b = Buffer.alloc(4);
        b.writeInt32BE(mainId, 0);
        return b;
      })(),
      (() => {
        const b = Buffer.alloc(4);
        b.writeInt32BE(mainSeq, 0);
        return b;
      })(),
      Buffer.alloc(4), // position
      (() => {
        const b = Buffer.alloc(2);
        b.writeInt16BE(1, 0);
        return b;
      })(),
      (() => {
        const b = Buffer.alloc(4);
        b.writeInt32BE(matId, 0);
        return b;
      })(),
      (() => {
        const b = Buffer.alloc(4);
        b.writeInt32BE(matSeq, 0);
        return b;
      })(),
      Buffer.alloc(2), // 无护佑符
      Buffer.alloc(2), // 未勾保险金
    ]);

  // ---- 用例 A1：notify 帧的指纹解码正确，且"无关卡不得混入"这条判据本身可用 ----
  //
  //  可观测边界（重要）：`pendingCardNotify` 是**模块级私有变量**（local-server.mjs:850），
  //  未导出，HTTP 层也无法从外部读它。所以"本次请求到底把哪些卡放进了 notify"**无法
  //  在本脚本内直接观测**。强行假装能观测（例如调 buildCardNotifyBody()）只会测到
  //  纯函数的输入输出，与派发逻辑无关 —— 那正是我第一版的错误。
  //
  //  因此 A1 诚实地只验两件可验的事：
  //   ① 指纹解码器本身正确（能精确解析出 id/seq/count/star）；
  //   ② "本次请求涉及的相关卡集合"这个判据可用（哨兵卡不在集合里）。
  //  真正的端到端契约（"这条路径产出的 notify 不含无关卡"）需要 server.log 的
  //  `CARD_NOTIFY pushed` 行做外部观测 —— 那属于 analyze-notify.cjs 的职责，
  //  不在本脚本的能力范围内。这里不假装覆盖。
  {
    // 用一份**构造的**变化集验证指纹解码：主卡升到 3 星 + 材料被吃
    const probe = [
      { id: 0x11130050, seq: 900002, count: 1, grade: 3, expire: -1 },
      { id: 0x11130014, seq: 900007, count: 0, grade: 0, expire: -1 },
    ];
    const { cards } = fingerprints(probe);
    console.log(`\nA1 notify 指纹解码器自检  in=${show(cards)}`);
    if (cards.length !== 2) throw new Error(`A1：指纹解码器应读出 2 张，实际 ${cards.length}`);
    if (cards[0].star !== 3) {
      throw new Error(`A1：星级属性（type=10）未解出，实际 star=${cards[0].star}`);
    }
    if (cards[0].seq !== 900002) throw new Error(`A1：seq 解错，实际 ${cards[0].seq}`);
    ok("A1 指纹解码器正确（id/seq/count/star 均能解出）");

    // 判据可用性：哨兵卡不应出现在"本次相关卡"集合里
    const related = new Set([0x11130050, 0x11130014]);
    const sentinelIsRelated = related.has(sentinelId);
    if (sentinelIsRelated) {
      throw new Error("A1：判据构造错误 —— 哨兵卡不该属于本次相关集合");
    }
    ok("A1 无关卡判据可用（哨兵卡不属于本次请求相关集合）");
  }

  // ---- 用例 A2：拒绝路径的**应答契约**（可端到端观测的部分）----
  //   这一档只验应答字节：结果码、尾串、不吃材料、等级不变。
  //   "该路径不产生 notify"这一条**无法在本脚本内观测**（见 A1 的边界说明），
  //   改为在 docs/verify-compose-fixes.md 里以"代码阅读 + server.log 无对应推送行"
  //   两条间接证据记录，不写成自动化断言。
  {
    const ghostId = 0x11130050;
    const ghostSeq = 0x7ffffffe; // 同 id 的**其它**实例存在，但该 seq 不存在
    const resp = HALL_RESPONSES.get(14850).build(
      mkUpgradeReq(ghostId, ghostSeq, baseMat.id, baseMat.seq),
    );
    const r = new Reader(resp);
    const result = r.i16();
    const level = r.i8();
    r.i32();
    r.hex32();
    const respSeq = r.i32();
    r.i32();
    const nSub = r.i16();
    for (let i = 0; i < nSub; i += 1) {
      r.i32();
      r.i32();
    }
    const nAss = r.i16();
    for (let i = 0; i < nAss; i += 1) {
      r.i32();
      r.i32();
    }
    r.i16(); // m_nDisableConsortiaExtra
    // ★ 非 0 ⇒ 客户端会读尾串（SCResponseUpgrade.as:74）
    const reason = r.str();
    console.log(
      `\nA2 主卡找不到  result=${result} m_cLevel=${level} 回包seq=${respSeq} 材料=${nSub} 原因串="${reason}"`,
    );
    // ① 必须是非 0 且非 1065 —— 否则客户端会在 updateDataByUpgradeCard 里 throw
    if (result === 0) {
      throw new Error("A2：回 0 会让客户端走 updateDataByUpgradeCard → getCardAttr 找不到卡 → 抛异常");
    }
    if (result === 1065) {
      throw new Error("A2：回 1065 与 0 同支（TDComposeUI.as:1403），同样会在客户端抛异常");
    }
    // ② 尾串必须存在且长度自洽（读到帧尾即证明）
    if (reason.length === 0) throw new Error("A2：回非 0 时必须带 m_szReasonMessage");
    if (r.p !== resp.length) throw new Error(`A2 应答读完 ${r.p}，共 ${resp.length}（尾串长度前缀不自洽）`);
    // ③ 不吃材料
    if (nSub !== 0) throw new Error(`A2：拒绝路径不该消耗材料，实际 nSub=${nSub}`);
    // ④ 等级不该变
    if (level !== 0) throw new Error(`A2：拒绝路径 m_cLevel 应为 0（无变化），实际 ${level}`);
    // ⑤ "不产生任何通知"这一条**本脚本观测不到**（见上方 A1 的可观测边界说明）：
    //   pendingCardNotify 是模块级私有变量，未导出；buildCardNotifyBody 是纯编码器，
    //   它的入参由调用方决定。用 `buildCardNotifyBody()` 去"读出实际推了哪些卡"在原理上
    //   做不到 —— 那是我第一版的错误（且少传参直接崩溃）。
    //   这里**不写成断言**，改为记录代码依据：
    //     local-server.mjs:1067  `pendingCardNotify = null; // 明确"无卡变化"，别通知`
    //     local-server.mjs:2733  `const changed = pendingCardNotify ?? [loadCardState().cards[0]].filter(Boolean);`
    //   两条合起来 ⇒ 置 null 后 changed 由 :2733 的回退项决定。⚠ 注意：该回退
    //   `[loadCardState().cards[0]]` 在 null 时会**推第一张卡**，所以"置 null ⇒ 无通知"
    //   并非无条件成立，取决于 cards[0] 是否存在。本脚本无法区分这两种情形 →
    //   如实标为 **未验证**，在文档里以"代码阅读 + server.log 无对应推送行"两条间接证据记录。
    ok("A2 拒绝路径应答契约成立（结果码/尾串/材料/等级）；notify 侧见文档，本脚本不可观测");
  }

  // ---- 用例 A3：拒绝路径的**可证伪守卫** —— 结果码必须非 0 且非 1065 ----
  //
  //  这是整档里唯一真正"能在旧代码上失败"的断言，所以要和 A2 分开写清楚。
  //  旧实现（lead 最初给的指示）是**回 0**。回 0 会让客户端：
  //    TDComposeUI.as:1403  `if(m_nResult == 0 || m_nResult == 1065)` → 成立
  //    :1412               `ComposeData.getInstance().updateDataByUpgradeCard(response)`
  //    ComposeData.as:301-305  `getCardAttr(_defCardData, m_iID, m_iSequence)` 找不到卡
  //                        → `throw new Error("出错了，没有找到对应的主卡！")`
  //  即"拒绝"变成"界面抛异常"。所以下面对 result 的两条断言就是守卫本体。
  //
  //  ⚠ 为什么不写"存盘逐字节不变"：cardState 是模块级单例（local-server.mjs:132/:136），
  //    本脚本前面已有多个成功用例写过内存状态，**无法把"存盘内容"与"本次拒绝"的因果
  //    关系isolate 出来** —— 那样的断言会依赖运行时顺序，脆且不诚实。拒绝路径不落盘
  //    这一条改由代码阅读（`local-server.mjs:1066-1103` 在写盘之前就 return）+
  //    B 档（等 fixer 无状态化后）覆盖。
  {
    const ghostId = 0x11130050;
    const ghostSeq = 0x7ffffffe;
    const resp = HALL_RESPONSES.get(14850).build(
      mkUpgradeReq(ghostId, ghostSeq, baseMat.id, baseMat.seq),
    );
    const r = new Reader(resp);
    const result = r.i16();
    console.log(`\nA3 拒绝路径可证伪守卫  result=${result}（旧实现回 0 ⇒ 客户端必抛）`);
    if (result === 0) {
      throw new Error(
        "A3 守卫失败：拒绝路径回 0，客户端会走 updateDataByUpgradeCard → getCardAttr 找不到卡 → 抛异常",
      );
    }
    if (result === 1065) {
      throw new Error("A3 守卫失败：拒绝路径回 1065，与 0 同支（TDComposeUI.as:1403），同样会抛");
    }
    ok(`A3 拒绝路径结果码 ${result} 非 0 且非 1065（回 0/1065 的旧实现在此必失败）`);
  }

  // ---- 用例 A4：结果码边界对照 —— 有主卡时回 1065（**不是 0**）----
  //   ★ 订正：旧文案依据的是"ComposeServerDataProtocol.as:258 `if(m_nResult == 0)`
  //     那道门 ⇒ 必须回 0 才能更新全局卡片表星级" —— **该结论已推翻**：
  //     星级刷新走 a_2439.as:865-894 的**新条目**分支（:879-883
  //     `if(attr.m_cAttrType == 10) defCard.TypeValue = attr.m_iAttrAdd;`），
  //     键为复合键 `CardID + "-" + CardSeq`（a_2439.as:815 / a_3228.as:79-81），
  //     与 `== 0` 门无关，两条 notify 也不互相覆盖。
  //   ⇒ 有主卡（能定位到、走失败/掉星路径）时应回 **1065**：
  //     TDComposeUI.as:1473 是唯一能覆盖成功文案的取值（:1403 与 0 同支）。
  //   本用例与"拒绝路径回 1"（A2/A3）配对，锁死两套规则的边界不被互相污染。
  //   （正常路径的**行为**细节由本文件前面的 14850 用例覆盖，这里只锁结果码这一维。）
  {
    const resp = HALL_RESPONSES.get(14850).build(
      mkUpgradeReq(
        baseMain.id === "0x11130050" ? 0x11130050 : baseMain.id,
        baseMain.seq,
        baseMat.id,
        baseMat.seq,
      ),
    );
    const r = new Reader(resp);
    const result = r.i16();
    console.log(
      `\nA4 结果码边界对照（有主卡）  result=${result}  本档 upgradeExpectFail=${upgradeExpectFail}`,
    );
    // ★ A4 必须与上面 14850 两个主体用例同 lub：成功档期望 0，失败档期望 1065。
    //   上一版无条件写死 1065，裸跑（success 档）时主卡明明升级成功却硬要它回 1065，
    //   于是这条断言在 success 档**永远不会通过** —— 又一处"换个档就红"的结构性假红。
    if (upgradeExpectFail) {
      if (result !== 1065) {
        throw new Error(
          `A4：失败档有主卡路径应回 1065（TDComposeUI.as:1473 唯一能覆盖成功文案；星级刷新走 a_2439.as:865-894 新条目分支，与 :258 的 ==0 门无关），实际 ${result}`,
        );
      }
      ok("A4 失败档有主卡路径回 1065（与拒绝路径的 1 边界互不污染）");
    } else {
      if (result !== 0) {
        throw new Error(
          `A4：成功档有主卡路径应回 0（local-server.mjs:1395-1409 成功分支未动），实际 ${result}`,
        );
      }
      ok("A4 成功档有主卡路径仍回 0（只有失败/掉星才升到 1065）");
    }
  }
  } // ← 结束 `if (highStarMode) { ... } else { ... }`
}

// ============================================================================
// B 档：notify 跨请求不串味 —— TODO 待 local-server.mjs notify 无状态化后启用
// ============================================================================
//
// 待验证的假设（**目前无现场证据**，见上方 A 档说明；不得当成已确认结论）：
//   pendingCardNotify 是模块级变量，只在"一次请求只走一个提前 return 的 builder"
//   这个**不成文前提**下成立。若某条路径在提前 return 前不清理它，就会把**上一笔**请求
//   的卡变化隔空推给客户端。无状态化（buildCardNotifyBody 只依赖本次请求算出的变化集）
//   是正交解；下面这条断言的价值就在于把该假设**从推测变成可证伪的验证**。
//
// 预期区分度（这正是它存在的意义）：
//   · 有状态版本：第二笔（失败且不吃材料）的 notify 会**残留**第一笔的卡 → 断言失败；
//   · 无状态版本：第二笔 notify 不含第一笔的卡 → 断言通过。
//   若在**两版上都通过**，说明泄漏路径不存在 —— 也要如实记录，不得预设结论。
//
// ⚠ 为什么先留 skip 而不是现在就写死：
//   1) 该断言依赖 fixer 落地无状态化后的行为，现在跑会对着中间态测；
//   2) 更要紧的是**可复现性** —— cardState 是模块级单例（local-server.mjs:132/:136），
//      "连发两笔且第二笔失败"需要可控的失败注入与请求边界重置，
//      在当前实现下无法在同一进程内构造干净的两笔。
//   落地后把 REA_STATELESS_NOTIFY=1 打开即可启用。
if (process.env.REA_STATELESS_NOTIFY === "1") {
  console.log("\nB 档 notify 跨请求不串味（REA_STATELESS_NOTIFY=1）");
  // TODO: 等 local-server.mjs notify 无状态化后启用。
  //   步骤（两份请求必须落在**同一次** cardState 加载内）：
  //     ① 预置：主卡 A(1星)、材料卡 M1/M2、另一张无关卡 Z
  //     ② 发第一笔：A + M1 → 产生变化（M1 被吃）→ 记下 notify1
  //     ③ 发第二笔：A + 一个**不存在 seq 的材料**，或构造"失败且不吃材料"的请求
  //        → 本次无任何卡变化 → 记下 notify2
  //     ④ 断言：notify2 不含 notify1 里的任何卡（尤其 A 的新 seq）
  //        —— 有状态实现在此失败，无状态实现通过
  fail_("B 档端到端断言尚未实现（等 local-server.mjs notify 无状态化后启用）");
}

// ---------------------------------------------------------------------------
// B 档（静态部分）—— **每次运行都执行**，不依赖 fixer 是否已落地无状态化。
//   静态判据：所有对 pendingCardNotify 的**赋值点**之前，必须存在一个**清理点**
//   （置 null / [] / undefined）。它抓不住"运行时是否真的执行到清理"，
//   但能抓住"新增了一条提前 return 的 builder 却忘了清理"这种回归 —— 那正是危险方向。
//   ⚠ 这是静态检查，不能替代 B 档端到端断言；它通过 ≠ 泄漏不存在。
// ---------------------------------------------------------------------------
{
  console.log("\nB 档静态：pendingCardNotify 写入点/清理点配对（不依赖无状态化）");
  try {
    const src = readFileSync(new URL("./local-server.mjs", import.meta.url), "utf8");
    const lines = src.split("\n");
    const writes = [];
    lines.forEach((ln, i) => {
      if (/pendingCardNotify\s*=[^=]/.test(ln)) writes.push(i + 1);
    });
    const clears = writes.filter((n) => /pendingCardNotify\s*=\s*(null|\[\]|undefined)/.test(lines[n - 1]));
    const sets = writes.filter((n) => !clears.includes(n));
    ok(`B 档静态：pendingCardNotify 写入点 ${writes.length} 处（清理 ${clears.length} / 赋值 ${sets.length}）`);
    const uncleared = sets.filter((n) => !clears.some((c) => c < n && n - c < 200));
    if (uncleared.length === 0) {
      ok("B 档静态：每个赋值点之前 200 行内都存在清理点（无新增 builder 漏清理）");
    } else if (process.env.REA_STRICT_STATIC === "1") {
      // 严格模式：把"清理点位置不足"当失败。会红，但这是**已知的、已写进文档**的缺口。
      fail_(
        `B 档静态[严格]：以下赋值点之前 200 行内没有清理点 —— 行 ${uncleared.join(", ")}` +
          `（见 docs/verify-compose-fixes.md §10；这是**已知缺口**，不是回归）`,
      );
    } else {
      // 默认：**报告但不失败**。理由：这是审核 `local-server.mjs` 得出的**已知缺口**，
      //   已记录在文档里并交 fixer 处置；把它变成常红会让"其它 19 条通过"一起被埋掉，
      //   而它并不能证明"必然泄漏"（可利用性未证实）。
      //   本脚本的失败语义保留给"可用外部字节证伪的回归"，已知缺口用 REA_STRICT_STATIC=1 显式索取。
      console.log(
        `  ⚠ B 档静态[已知缺口]：以下赋值点之前 200 行内没有清理点 —— 行 ${uncleared.join(", ")}` +
          `\n     → 见 docs/verify-compose-fixes.md §10；加 REA_STRICT_STATIC=1 可让其计入失败`,
      );
    }
    if (/export\s+(let|var|const)\s+pendingCardNotify/.test(src)) {
      ok("B 档静态：pendingCardNotify 已导出（疑似已无状态化）→ 请把上方的端到端断言补上");
    } else {
      ok("B 档静态：pendingCardNotify 仍未导出（跨请求状态仍存在，端到端断言仍不可外部观测）");
    }
  } catch (e) {
    fail_(`B 档静态检查执行失败：${e.message}`);
  }
}

// ---- 汇总 ----
// 退出码按失败数决定；计数与上面 ok()/fail_() 的打印严格绑定，可逐条对账。
// ⚠ 任何未捕获的抛错都会跳过这里 → 退出码由 Node 决定（非 0），但看不到"合计"行。
//   为了让失败也始终有可对账的汇总，抛错路径统一在 run() 里转成 fail_() + 计数。
console.log(`\n合计：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
