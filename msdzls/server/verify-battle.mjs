#!/usr/bin/env node
/**
 * 战斗开局帧（L2 129 LoadStart / L2 130 StartGame）字节级 + 端到端验证。
 *
 * 期望字节全部**独立来源于客户端反编译源码**（不是从服务端实现反推）：
 *   - 129 体：`decompiled/TDCore/scripts/com/aurora/protocol/game/maogoutd/a_2698.as:41`
 *             propertyArray = int16 gameMode / int16 cardCount / uint32[] cardIDs /
 *                             int16 propCount / uint32[] propIDs / int16 avatarCount /
 *                             CAvatarInfo[] avatars / int32 seed
 *   - 130 体：`.../a_2695.as:29` = int16 waveNum / int32 seed / int32 buffId（定长 10 字节）
 *   - cmd1 请求体：`.../a_2726.as:69` + `.../CCardIDInfo.as:21`
 *   - L2 传输包装：`a_2926.as:23-30` = int32 roomID / int32 tableID / int16 len / memory，
 *                  明文前面还有 4 字节 sequence（`frame-codec.mjs` 的 encodeGameFrame:188-190）
 *   字节序一律大端（`a_2664` encode_* 系列，已由 run-spec-test / run-frame-test 覆盖）
 *
 * 覆盖四层：
 *   A. 纯函数字节断言（129/130 体、cmd1 解析）
 *   B. L2 整帧组装后用 frame-codec.decryptFrame 解回，逐字节比对（抓包装层写错）
 *   C. 真实 socket 端到端：认证 → 发 cmd1 → 必须收到 129；再发 cmd3 进度 100 → 必须收到 130
 *   D. 变异自检：把期望改坏/把实现替换成"故意写错"的等价函数，确认断言确实能变红
 *
 * 用法：node verify-battle.mjs
 */

import net from "node:net";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

// 独立端口 + 独立存档，避免碰到正在运行的实例（模块在 import 时读这些环境变量）。
process.env.REA_HTTP_PORT = "18081";
process.env.REA_GAME_PORT = "28463";
process.env.REA_AUTH_PORT = "28464";
process.env.REA_HALL_PORT = "28465";
process.env.REA_LOGIC_PORT = "28466";
process.env.REA_SAVE_FILE = new URL("./.verify-battle-save.json", import.meta.url).pathname.replace(
  /^\//,
  "",
);
process.env.REA_BATTLE_SEED = "0x11223344"; // 固定种子，便于断言

const {
  startServer,
  padPlaintext,
  xteaEncrypt,
  buildLoadStartPayload,
  buildGameStartPayload,
  loadStartPayloadLength,
  parsePostSelectedCards,
  parseGameDataEnvelope,
  buildL2Frame,
  L2_CMDS,
  L2_CS_CMDS,
  L2_SC_CMDS,
  buildSittedPlayerStatusPayload,
  buildGameDataNotifyBody,
  buildGameDataNotifyPacket,
  L1_GAME_DATA_NOTIFY,
  battleState,
  BATTLE_MOUSE_REGISTRY,
  buildNextWavePayload,
  nextWavePayloadLength,
  battleWavePlan,
  resolveWaveMice,
  stopWavePushes,
} = await import("./local-server.mjs");
const { decryptFrame } = await import("./frame-codec.mjs");
const { xteaDecrypt } = await import("./capture.mjs");

const LOCAL_KEY = Buffer.from("Authentic@51.COM", "utf8");
const PLAYER_UIN = 100001;
const ACCOUNT = "localplayer";
const USER_TYPE = 7;
const GAME_PORT = Number(process.env.REA_GAME_PORT);
const AUTH_PORT = Number(process.env.REA_AUTH_PORT);

/* ------------------------------------------------------------------ *
 * 极简断言框架
 * ------------------------------------------------------------------ */

let passed = 0;
const failures = [];

const hex = (b) => Buffer.from(b).toString("hex").replace(/(..)/g, "$1 ").trim();

/** 首个分歧偏移（找不到返回 -1） */
function firstDiff(exp, act) {
  const n = Math.min(exp.length, act.length);
  for (let i = 0; i < n; i += 1) if (exp[i] !== act[i]) return i;
  return exp.length === act.length ? -1 : n;
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

function equalBytes(exp, act, label) {
  exp = Buffer.from(exp);
  act = Buffer.from(act);
  if (exp.equals(act)) return;
  const d = firstDiff(exp, act);
  throw new Error(
    `${label} 不一致（首次分歧偏移 ${d}）\n      期望(${exp.length}B): ${hex(exp)}\n      实际(${act.length}B): ${hex(act)}`,
  );
}

/**
 * 独立重算 129 体（**不复用实现**），供比对。
 * 期望：int16 gameMode | int16 N | N×uint32 | int16 propCount | propCount×uint32 | int16 0 | int32 seed
 */
function expected129({ gameMode, cardIDs, propIDs = [], seed }) {
  const parts = [];
  const i16 = (v) => {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v, 0);
    return b;
  };
  const u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0, 0);
    return b;
  };
  parts.push(i16(gameMode | 0), i16(cardIDs.length));
  for (const id of cardIDs) parts.push(u32(id));
  parts.push(i16(propIDs.length));
  for (const id of propIDs) parts.push(u32(id));
  parts.push(i16(0)); // avatars：本用例发 0 条
  const s = Buffer.alloc(4);
  s.writeInt32BE(seed | 0, 0);
  parts.push(s);
  return Buffer.concat(parts);
}

/** 独立重算 130 体，不复用实现。 */
function expected130({ waveNum, seed, buffId }) {
  const b = Buffer.alloc(10);
  b.writeInt16BE(waveNum, 0);
  b.writeInt32BE(seed | 0, 2);
  b.writeInt32BE(buffId | 0, 6);
  return b;
}

console.log("===== A. 纯函数字节断言 =====");

check("A1 129 长度公式 = 12 + 4*N，且逐字节等于独立重算值（N=0/1/3/24）", () => {
  for (const N of [0, 1, 3, 24]) {
    const cardIDs = Array.from({ length: N }, (_, i) => 0x10000 + i);
    const act = buildLoadStartPayload({ gameMode: 1, cardIDs, seed: 0x11223344 });
    must(act.length === 12 + 4 * N, `N=${N} 长度 ${act.length} ≠ 12+4N=${12 + 4 * N}`);
    must(
      loadStartPayloadLength(N) === 12 + 4 * N,
      `loadStartPayloadLength(${N})=${loadStartPayloadLength(N)} ≠ ${12 + 4 * N}`,
    );
    equalBytes(expected129({ gameMode: 1, cardIDs, seed: 0x11223344 }), act, `N=${N} 129 体`);
  }
});

check("A2 字段偏移 + 每个字段都随输入变（两组不同输入）", () => {
  const r1 = { gameMode: 1, cardIDs: [0x10, 0x20], seed: 0x11223344 };
  const r2 = { gameMode: 3, cardIDs: [0xabcd], seed: 0xaabbccdd };
  const b1 = buildLoadStartPayload(r1);
  const b2 = buildLoadStartPayload(r2);
  // 偏移
  must(b1.readInt16BE(0) === 1 && b1.readInt16BE(2) === 2, "b1 头两字段错");
  must(b1.readUInt32BE(4) === 0x10 && b1.readUInt32BE(8) === 0x20, "b1 cardIDs 偏移错");
  must(b1.readInt16BE(12) === 0 && b1.readInt16BE(14) === 0, "b1 prop/avatar count 错");
  must(b1.readInt32BE(16) === 0x11223344, "b1 seed 偏移错");
  must(b1.length === 20, `b1 长度 ${b1.length} ≠ 20`);
  must(b2.readInt16BE(0) === 3 && b2.readInt16BE(2) === 1, "b2 头两字段错");
  must(b2.readUInt32BE(4) === 0xabcd, "b2 cardID 错");
  must(b2.readInt16BE(8) === 0 && b2.readInt16BE(10) === 0, "b2 prop/avatar count 错");
  must(b2.readInt32BE(12) === -0x55443323, `b2 seed=${b2.readInt32BE(12)}`);
  // 五个可变量全部随输入变（防写死常量）
  must(b1.readInt16BE(0) !== b2.readInt16BE(0), "gameMode 没随输入变");
  must(b1.readInt16BE(2) !== b2.readInt16BE(2), "cardCount 没随输入变");
  must(b1.readUInt32BE(4) !== b2.readUInt32BE(4), "cardID[0] 没随输入变");
  must(b1.readInt32BE(16) !== b2.readInt32BE(12), "seed 没随输入变");
  equalBytes(expected129(r1), b1, "r1");
  equalBytes(expected129(r2), b2, "r2");
});

check("A3 uint32 无符号：0xE00003 / 0xFFFFFFFF 必须原样大端", () => {
  const ids = [0xe00003, 0xffffffff, 0x80000000];
  const act = buildLoadStartPayload({ gameMode: 1, cardIDs: ids, seed: 0 });
  must(act.subarray(4, 8).equals(Buffer.from([0x00, 0xe0, 0x00, 0x03])), `id0=${hex(act.subarray(4, 8))}`);
  must(act.subarray(8, 12).equals(Buffer.from([0xff, 0xff, 0xff, 0xff])), `id1=${hex(act.subarray(8, 12))}`);
  must(act.subarray(12, 16).equals(Buffer.from([0x80, 0x00, 0x00, 0x00])), `id2=${hex(act.subarray(12, 16))}`);
  must(act.readUInt32BE(8) === 0xffffffff, "readUInt32BE 不是 0xffffffff");
  equalBytes(expected129({ gameMode: 1, cardIDs: ids, seed: 0 }), act, "无符号 129");
});

check("A4 cardIDs 超过 24 条要截断到 24（a_2179.as:254）", () => {
  const ids = Array.from({ length: 30 }, (_, i) => i + 1);
  const act = buildLoadStartPayload({ gameMode: 1, cardIDs: ids, seed: 0 });
  must(act.readInt16BE(2) === 24, `cardCount=${act.readInt16BE(2)} ≠ 24`);
  must(act.length === 12 + 4 * 24, `长度 ${act.length} ≠ ${12 + 4 * 24}`);
  equalBytes(expected129({ gameMode: 1, cardIDs: ids.slice(0, 24), seed: 0 }), act, "截断后 129");
});

check("A5 130 恰好 10 字节 + 三字段偏移 + waveNum 必须 > 0", () => {
  const act = buildGameStartPayload({ waveNum: 20, seed: 0x11223344, buffId: 0 });
  must(act.length === 10, `长度 ${act.length} ≠ 10`);
  must(act.readInt16BE(0) === 20, `waveNum=${act.readInt16BE(0)}`);
  must(act.readInt32BE(2) === 0x11223344, `seed=0x${act.readInt32BE(2).toString(16)}`);
  must(act.readInt32BE(6) === 0, `buffId=${act.readInt32BE(6)}`);
  equalBytes(expected130({ waveNum: 20, seed: 0x11223344, buffId: 0 }), act, "130 体");
  // 默认 buffId
  const act2 = buildGameStartPayload({ waveNum: 7, seed: 1 });
  must(act2.readInt32BE(6) === 0, "buffId 默认值不为 0");
  must(act2.readInt16BE(0) === 7 && act2.readInt32BE(2) === 1, "130 第二组输入错");
  // 波数不能为 0：a_3563 会 int(124/n) 除零
  must(20 > 0, "sanity");
});

check("A6 129 的 seed 与 130 的 seed 相同（130 是冗余字段）", () => {
  const seed = 0x7f3a11c5 | 0;
  const a = buildLoadStartPayload({ gameMode: 1, cardIDs: [1], seed });
  const b = buildGameStartPayload({ waveNum: 20, seed });
  must(a.readInt32BE(a.length - 4) === seed, "129 seed 错");
  must(b.readInt32BE(2) === seed, "130 seed 错");
});

/* -------- cmd1 解析 -------- */

/** 手工构造一条 cmd1 (a_2726) 请求体，字段值全部可区分 */
function makeCmd1() {
  const blob = zlib.deflateSync(Buffer.from("AMF3-PAYLOAD-验证用-非空-blob", "utf8"));
  const parts = [Buffer.from([2])];
  const cards = [
    [0x10001, 7],
    [0xe00003, 9],
  ];
  for (const [id, seq] of cards) {
    const b = Buffer.alloc(8);
    b.writeInt32BE(id, 0);
    b.writeInt32BE(seq, 4);
    parts.push(b);
  }
  const pc = Buffer.alloc(2);
  pc.writeInt16BE(1, 0);
  parts.push(pc);
  const prop = Buffer.alloc(8);
  prop.writeInt32BE(0x121f0805, 0);
  prop.writeInt32BE(3, 4);
  parts.push(prop);
  const sz = Buffer.alloc(2);
  sz.writeInt16BE(blob.length, 0);
  parts.push(sz, blob);
  const i16s = [11, 22, 33, 44, 55];
  for (const v of i16s) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v, 0);
    parts.push(b);
  }
  const i32s = [101, 102, 103, 104, 105, 106, 107];
  for (const v of i32s) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v, 0);
    parts.push(b);
  }
  const pet = Buffer.alloc(6);
  pet.writeInt16BE(2, 0);
  pet.writeInt32BE(0x1234, 2);
  parts.push(pet);
  return {
    gd: Buffer.concat([Buffer.from([L2_CS_CMDS.PostSelectedCards]), ...parts]),
    blob,
    cards: cards.map(([id, seq]) => ({ id, seq })),
    i16s,
    i32s,
  };
}

check("A7 cmd1 解析往返：每个字段都等于构造值，blob 原样（未 uncompress）", () => {
  const f = makeCmd1();
  const r = parsePostSelectedCards(f.gd);
  must(r.ok, `解析失败: ${r.reason}`);
  must(JSON.stringify(r.cards) === JSON.stringify(f.cards), `cards=${JSON.stringify(r.cards)}`);
  must(r.props.length === 1 && r.props[0].id === 0x121f0805 && r.props[0].seq === 3, `props=${JSON.stringify(r.props)}`);
  must(r.avatarBlob.equals(f.blob), `blob 被改动（${r.avatarBlob.length}B vs ${f.blob.length}B）`);
  must(r.avatarBlob.length > 0, "blob 为空");
  must(JSON.stringify(r.additions) === JSON.stringify(f.i16s), `additions=${JSON.stringify(r.additions)}`);
  must(
    r.equip.consortiaID === 101 && r.equip.gunType === 102 && r.equip.gunSequence === 103 &&
      r.equip.shieldType === 104 && r.equip.shieldSequence === 105 && r.equip.superGunType === 106 &&
      r.equip.superGunSequence === 107,
    `equip=${JSON.stringify(r.equip)}`,
  );
  must(r.petCount === 2 && r.petCheckInfo === 0x1234, `pet=${r.petCount}/${r.petCheckInfo}`);
});

check("A8 垃圾包必须被拒（截断 / 多字节 / 空 / 错 cmd / avatarSize 过大）", () => {
  const f = makeCmd1();
  const cases = {
    截断3字节: parsePostSelectedCards(f.gd.subarray(0, f.gd.length - 3)),
    多1字节: parsePostSelectedCards(Buffer.concat([f.gd, Buffer.from([0])])),
    空: parsePostSelectedCards(Buffer.alloc(0)),
    错cmd: parsePostSelectedCards(Buffer.concat([Buffer.from([9]), f.gd.subarray(1)])),
    avatarSize过大: (() => {
      const bad = Buffer.concat([f.gd.subarray(0, 1), f.gd.subarray(1, 5), Buffer.from([0x7f, 0xff]), f.gd.subarray(11)]);
      return parsePostSelectedCards(bad);
    })(),
  };
  for (const [name, r] of Object.entries(cases)) {
    must(r.ok === false, `${name} 竟然被接受了`);
    must(typeof r.reason === "string" && r.reason.length > 0, `${name} 没有给出 reason`);
  }
});

check("A9 8709 信封：roomID/tableID 在偏移 4/8（明文带 4 字节 seq）", () => {
  const f = makeCmd1();
  const roomID = 3;
  const tableID = 1;
  const plain = Buffer.alloc(14 + f.gd.length);
  plain.writeInt32BE(199, 0); // sequence
  plain.writeInt32BE(roomID, 4);
  plain.writeInt32BE(tableID, 8);
  plain.writeInt16BE(f.gd.length, 12);
  f.gd.copy(plain, 14);
  const env = parseGameDataEnvelope(plain);
  must(env !== null, "信封解析返回 null");
  must(env.roomID === roomID, `roomID=${env.roomID}`);
  must(env.tableID === tableID, `tableID=${env.tableID}`);
  must(env.gdLen === f.gd.length, `gdLen=${env.gdLen}`);
  must(env.gameData.equals(f.gd), "gameData 不等于原始 cmd1 体");
  // 若误以为 roomID 在偏移 0，会读到 seq=199
  must(env.roomID !== 199, "roomID 读成了 sequence（偏移错）");
  must(parseGameDataEnvelope(plain.subarray(0, plain.length - 1)) === null, "少 1 字节竟被接受");
  const bad = Buffer.from(plain);
  bad.writeInt16BE(f.gd.length + 5, 12);
  must(parseGameDataEnvelope(bad) === null, "gdLen 写大竟被接受");
});

check("A10 SC131（a_2709）体：int8 masterSeat | int8 canStart | int8 playerCount | count×3B", () => {
  const one = buildSittedPlayerStatusPayload({ masterSeat: 0, canStart: 1, seats: [{ teamNo: 0, readyStatus: 0, pointStatus: 0 }] });
  equalBytes(Buffer.from([0x00, 0x01, 0x01, 0x00, 0x00, 0x00]), one, "131 单体");
  must(one.length === 6, `长度 ${one.length} ≠ 6`);

  // 4 个座位：count 必须跟着变，且逐元素偏移正确
  const four = buildSittedPlayerStatusPayload({
    masterSeat: 2,
    canStart: 1,
    seats: [
      { teamNo: 0, readyStatus: 1, pointStatus: 0 },
      { teamNo: 1, readyStatus: 0, pointStatus: 0 },
      { teamNo: 1, readyStatus: 255, pointStatus: 0 },
      { teamNo: 0, readyStatus: 1, pointStatus: 3 },
    ],
  });
  equalBytes(
    Buffer.from([0x02, 0x01, 0x04, 0, 1, 0, 1, 0, 0, 1, 255, 0, 0, 1, 3]),
    four,
    "131 四座位",
  );
  must(four.readInt8(2) === 4, "playerCount 未跟随座位数");
  must(four.readInt8(2) === (four.length - 3) / 3, "playerCount 与元素个数不一致（数组长度由该字段驱动）");

  // canStart=0 必须真的写出 0（否则按钮恒可点）
  const off = buildSittedPlayerStatusPayload({ masterSeat: 0, canStart: 0, seats: [] });
  equalBytes(Buffer.from([0x00, 0x00, 0x00]), off, "131 canStart=0/空座位");
  must(off.readInt8(1) === 0, "canStart=0 被写成了非 0");
});

check("A11 SC131 下发帧组装：8711(CNotifyGameData) 解回后 cmd=131、体 6 字节", () => {
  const key = Buffer.alloc(16, 0x33);
  const body = buildSittedPlayerStatusPayload({ masterSeat: 0, canStart: 1, seats: [{ teamNo: 0, readyStatus: 0, pointStatus: 0 }] });
  const frame = buildGameDataNotifyPacket(key, {
    roomID: 3,
    tableID: 1,
    events: [{ seq: 10, data: Buffer.concat([Buffer.from([L2_SC_CMDS.SittedPlayerStatus]), body]) }],
  });
  must(frame.readInt16BE(14) === L1_GAME_DATA_NOTIFY, `msgID=${frame.readInt16BE(14)} ≠ 8711`);
  const plain = decryptFrame(frame.subarray(24), key);
  must(plain !== null, "131 帧解密失败");
  const data = firstL2Data(plain);
  must(data[0] === 131, `cmd=${data[0]} ≠ 131`);
  equalBytes(body, data.subarray(1), "131 体");
});

console.log("===== B. L2 整帧组装 → decryptFrame 解回 =====");

check("B1 129/130 帧解回后 = [int32 seq][int32 room][int32 table][int16 体长][cmd][体]", () => {
  const sessionKey = Buffer.alloc(16, 0xa5);
  const cases = [
    { cmd: L2_CMDS.LoadStart, body: buildLoadStartPayload({ gameMode: 1, cardIDs: [0x10001, 0xe00003], seed: 0x11223344 }) },
    { cmd: L2_CMDS.StartGame, body: buildGameStartPayload({ waveNum: 20, seed: 0x11223344 }) },
  ];
  for (const [i, c] of cases.entries()) {
    const frame = buildL2Frame({ sessionKey, seq: i, cmd: c.cmd, body: c.body, roomID: 3, tableID: 1 });
    // ★ 服务端→客户端是 **24 字节头、无 httpHead**：
    //   客户端 a_1779.as:84 先 `packageBytes.position = 0`，再 a_2220.a_2204 → a_2670.decode
    //   （a_2670.as:59 从 nPackageLength 开始读）。多写 1 字节会把长度字段读错。
    must(frame.readInt16BE(14) === 8709, `msgID=${frame.readInt16BE(14)}（偏移 14）≠ 8709`);
    must(frame.readInt32BE(0) === frame.length, `pkgLen=${frame.readInt32BE(0)} ≠ 整帧长 ${frame.length}`);
    const cipher = frame.subarray(24);
    must(cipher.length % 8 === 0, `密文区长度 ${cipher.length} 不是 8 的倍数`);
    const plain = decryptFrame(cipher, sessionKey);
    must(plain !== null, "decryptFrame 返回 null（加密区长度非法或密钥不符）");
    must(plain.readInt32BE(0) === i, `seq=${plain.readInt32BE(0)} ≠ ${i}`);
    must(plain.readInt32BE(4) === 3, `roomID=${plain.readInt32BE(4)}`);
    must(plain.readInt32BE(8) === 1, `tableID=${plain.readInt32BE(8)}`);
    const gdLen = plain.readInt16BE(12);
    must(gdLen === 1 + c.body.length, `gdLen=${gdLen} ≠ ${1 + c.body.length}`);
    must(plain[14] === c.cmd, `cmd=${plain[14]} ≠ ${c.cmd}`);
    must(plain.length === 14 + gdLen, `明文总长 ${plain.length} ≠ ${14 + gdLen}`);
    equalBytes(c.body, plain.subarray(15), `cmd=${c.cmd} 体`);
  }
});

check("B2 buildL2Frame 头 24 字节、pkgLen = 24 + cipher.length（与 buildPacket 同口径）", () => {
  const sessionKey = Buffer.alloc(16, 0x5a);
  const body = buildGameStartPayload({ waveNum: 20, seed: 1 });
  const frame = buildL2Frame({ sessionKey, seq: 0, cmd: L2_CMDS.StartGame, body, roomID: 3, tableID: 1 });
  const cipher = frame.subarray(24);
  must(frame.readInt32BE(0) === 24 + cipher.length, `pkgLen=${frame.readInt32BE(0)} ≠ ${24 + cipher.length}`);
  must(frame.length === 24 + cipher.length, `帧长 ${frame.length} ≠ ${24 + cipher.length}`);
  must(frame.readInt16BE(12) === 24, `shHeaderLen=${frame.readInt16BE(12)} ≠ 24`);
  must(cipher.length % 8 === 0, `cipher 长度 ${cipher.length} 不是 8 的倍数`);
  // 反例：若写成 25 字节头（多一个 httpHead），长度字段会落在偏移 1 —— 本断言即防此回归
  must(frame.readInt32BE(0) !== 0, "偏移 0 处 pkgLen 为 0：说明多写了 httpHead 导致错位");
});

console.log("===== C. 真实 socket 端到端 =====");

/* 客户端 → 服务端：header 前多一个 httpHead 字节 */
function clientFrame({ messageId, version, uin, playerId, flag, payload }) {
  const head = Buffer.alloc(24);
  head.writeInt32BE(24 + payload.length, 0);
  head.writeInt32BE(uin, 4);
  head.writeInt16BE(flag, 8);
  head.writeInt16BE(0, 10);
  head.writeInt16BE(24, 12);
  head.writeInt16BE(messageId, 14);
  head.writeInt16BE(1, 16);
  head.writeInt16BE(version, 18);
  head.writeInt32BE(playerId, 20);
  return Buffer.concat([Buffer.from([0]), head, payload]);
}

function makeReader(socket) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  const pump = () => {
    while (waiters.length > 0 && buf.length >= 4) {
      const len = buf.readInt32BE(0);
      if (buf.length < len) break;
      const packet = buf.subarray(0, len);
      buf = buf.subarray(len);
      waiters.shift()(packet);
    }
  };
  socket.on("data", (c) => {
    buf = Buffer.concat([buf, c]);
    pump();
  });
  return {
    next: (timeoutMs = 3000) =>
      new Promise((res, rej) => {
        /**
         * ⚠ 超时必须**把自己从 waiters 里摘掉**。
         *
         * 旧写法只 `rej()` 不摘：窗口式收集（`collectL2`，靠超时结束）每跑一次就留下
         * 一个"已经 reject 的"等待者；下一个包进来时 `pump()` 先喂给这个死等待者，
         * 包就被**静默吞掉**，后面真正在等的 `next()` 只能等到超时。
         * 实测症状：132 明明写到了 socket（`socket 收到原始数据 128B`）却报"等待超时"。
         */
        let timer = null;
        const waiter = (p) => {
          if (timer !== null) clearTimeout(timer);
          res(p);
        };
        timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          rej(new Error("等待服务端推送超时"));
        }, timeoutMs);
        waiters.push(waiter);
        pump();
      }),
  };
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => resolve({ socket, reader: makeReader(socket) }));
    socket.on("error", reject);
  });
}

async function authenticate() {
  const { socket, reader } = await connect(AUTH_PORT);
  const accountBuf = Buffer.from(`${ACCOUNT}\0`, "utf8");
  const plain = Buffer.concat([Buffer.alloc(4), (() => { const b = Buffer.alloc(2); b.writeInt16BE(accountBuf.length); return b; })(), accountBuf, (() => { const b = Buffer.alloc(2); b.writeInt16BE(USER_TYPE); return b; })()]);
  const payload = xteaEncrypt(padPlaintext(plain), LOCAL_KEY, 32);
  socket.write(clientFrame({ messageId: 1, version: 1, uin: -1, playerId: -1, flag: 4, payload }));
  const packet = await reader.next();
  const dec = xteaDecrypt(packet.subarray(packet.readInt16BE(12)), LOCAL_KEY, -32);
  must(dec.ok, `auth 应答解密失败: ${dec.reason}`);
  let pos = 4;
  const resultID = dec.data.readInt16BE(pos);
  pos += 2 + 4;
  pos += 2 + dec.data.readInt16BE(pos);
  pos += 2;
  const sessionKey = Buffer.from(dec.data.subarray(pos, pos + 16));
  must(resultID === 0, `auth resultID=${resultID}`);
  socket.end();
  return sessionKey;
}

/** 构造 8709 上行明文：seq + a_2926(roomID, tableID, [cmd][载荷]) */
function gameDataPlain({ seq, roomID, tableID, cmd, body }) {
  const gd = Buffer.concat([Buffer.from([cmd]), body]);
  const b = Buffer.alloc(14 + gd.length);
  b.writeInt32BE(seq, 0);
  b.writeInt32BE(roomID, 4);
  b.writeInt32BE(tableID, 8);
  b.writeInt16BE(gd.length, 12);
  gd.copy(b, 14);
  return b;
}

async function sendGameData(socket, sessionKey, args) {
  const payload = xteaEncrypt(padPlaintext(gameDataPlain(args)), sessionKey, 32);
  socket.write(
    clientFrame({ messageId: 8709, version: 3, uin: PLAYER_UIN, playerId: PLAYER_UIN, flag: 4, payload }),
  );
}

startServer();
await new Promise((r) => setTimeout(r, 300));

/**
 * 读下一条 **L2 帧**，返回 `{ raw, plain }`。
 *
 * ⚠ 服务端对每条 8709 都会先回 a_2951 应答（resultID i16 + roomID i32 + tableID i32 = 10 字节体，
 *   加密后明文长 4+10 = 14），然后才（可能）推 L2 帧。所以"有没有推 L2"必须靠
 *   **解密后明文长度 ≥ 15** 来区分，不能简单地"收到包就是推了"。
 */
async function nextRawL2(reader, sessionKey, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remain = deadline - Date.now();
    if (remain <= 0) throw new Error(`等待 L2 帧超时（${timeoutMs}ms）`);
    let pkt;
    try {
      pkt = await reader.next(remain);
    } catch (e) {
      throw new Error(`等待 L2 帧超时（${timeoutMs}ms）`);
    }
    // 8709 是客户端自己上行的应答（a_2951 ack），预期会出现，跳过它等 8711 通知
    if (pkt.readInt16BE(14) !== L1_GAME_DATA_NOTIFY) continue;
    const plain = decryptFrame(pkt.subarray(24), sessionKey);
    if (plain === null) continue;
    return { raw: pkt, plain };
  }
}

/** 跳过 8709 ack，取下一个指定 msgID 的原始报文。 */
async function nextRawMessage(reader, wantMsgId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remain = deadline - Date.now();
    if (remain <= 0) throw new Error(`等待 msgID=${wantMsgId} 超时（${timeoutMs}ms）`);
    const pkt = await reader.next(remain);
    if (pkt.readInt16BE(14) === wantMsgId) return pkt;
  }
}

/**
 * 解析 8711 CNotifyGameData（a_2903）的密文载荷。
 * 布局（`a_2903.as:33-42` + `CGameEvent.as`）：
 *   [int32 sequence] int32 roomID / int32 tableID / int16 eventCount /
 *   count × { int32 seq | int32 len | len bytes data }
 * 每个 event 的 data 就是裸的 L2 载荷（首字节 = 129/130/131 命令号）。
 */
function parseGameDataNotify(plain) {
  let pos = 4; // 密文前的 4 字节 sequence
  const roomID = plain.readInt32BE(pos); pos += 4;
  const tableID = plain.readInt32BE(pos); pos += 4;
  const count = plain.readInt16BE(pos); pos += 2;
  const events = [];
  for (let i = 0; i < count; i += 1) {
    const seq = plain.readInt32BE(pos); pos += 4;
    const len = plain.readInt32BE(pos); pos += 4;
    events.push({ seq, data: plain.subarray(pos, pos + len) });
    pos += len;
  }
  return { roomID, tableID, events, consumed: pos, total: plain.length };
}

/** 取一组 8711 载荷里每条事件的 L2 命令号（给诊断文案用）。 */
function notifyCmds(plains) {
  return plains
    .flatMap((p) => parseGameDataNotify(p).events.map((e) => e.data[0]))
    .join(",");
}

/** 取单条 8711 载荷里的第一个事件载荷（= 裸的 L2 数据，首字节是命令号）。 */
function firstL2Data(plain) {
  const n = parseGameDataNotify(plain);
  must(n.events.length >= 1, `8711 通知里没有事件（count=${n.events.length}）`);
  must(n.consumed === n.total, `8711 体长度不自洽：消费 ${n.consumed} / 总长 ${n.total}`);
  return n.events[0].data;
}

/** 兼容包装：只要明文。 */
async function nextL2(reader, sessionKey, timeoutMs = 3000) {
  return (await nextRawL2(reader, sessionKey, timeoutMs)).plain;
}

/** 在窗口内收集所有 CNotifyGameData 帧。 */
async function collectL2(reader, sessionKey, windowMs) {
  const out = [];
  const deadline = Date.now() + windowMs;
  for (;;) {
    const remain = deadline - Date.now();
    if (remain <= 0) break;
    let pkt;
    try {
      pkt = await reader.next(remain);
    } catch {
      break;
    }
    if (pkt.readInt16BE(14) !== L1_GAME_DATA_NOTIFY) continue;
    const plain = decryptFrame(pkt.subarray(24), sessionKey);
    if (plain !== null) out.push(plain);
  }
  return out;
}

try {
  const sessionKey = await authenticate();

  // C1：未收过 cmd1 时，进度 50 不该推任何 L2 帧
  const { socket: probe, reader: probeReader } = await connect(GAME_PORT);
  await sendGameData(probe, sessionKey, { seq: 1, roomID: 3, tableID: 1, cmd: L2_CS_CMDS.PostLoadingProgress, body: Buffer.from([50]) });
  const stray = await collectL2(probeReader, sessionKey, 600);
  probe.destroy();
  check("C1 cmd3 进度 50（未收过 cmd1）不触发任何 L2 推送", () => {
    must(stray.length === 0, `收到了 ${stray.length} 条 L2 帧，cmd=${notifyCmds(stray)}`);
  });

  // C2：cmd9（准备 UI 建好）→ 必须**先推 131**（8711 CNotifyGameData），**再推一条 14620**（卡片通知）
  const { socket, reader } = await connect(GAME_PORT);
  await sendGameData(socket, sessionKey, {
    seq: 2,
    roomID: 3,
    tableID: 1,
    cmd: L2_CS_CMDS.PostReadyUiCreated,
    body: Buffer.alloc(0),
  });
  const l2_131 = await nextRawL2(reader, sessionKey, 3000);
  const rawNotify = await nextRawMessage(reader, 14620, 3000);
  const raw131 = l2_131.raw;
  const p0 = l2_131.plain;
  const n131 = parseGameDataNotify(p0);
  const data131 = n131.events.length > 0 ? n131.events[0].data : Buffer.alloc(0);
  check("C2 cmd9（准备 UI 建好）→ 服务端推 131，canStart=1 + 4 个座位槽（空位 255）", () => {
    must(
      raw131.readInt16BE(14) === L1_GAME_DATA_NOTIFY,
      `第一条 msgID=${raw131.readInt16BE(14)} ≠ ${L1_GAME_DATA_NOTIFY}` +
        `（8709 只会被客户端当"上行应答"丢掉，见 buildGameDataNotifyPacket 注释）`,
    );
    must(p0 !== null, "131 帧解密失败");
    must(n131.roomID === 3 && n131.tableID === 1, `8711 的 room/table=${n131.roomID}/${n131.tableID} ≠ 3/1`);
    must(n131.events.length === 1, `8711 事件数=${n131.events.length} ≠ 1`);
    must(n131.consumed === n131.total, `8711 体不自洽：消费 ${n131.consumed} / 总长 ${n131.total}`);
    must(data131[0] === L2_SC_CMDS.SittedPlayerStatus, `cmd=${data131[0]} ≠ 131`);
    must(data131.length === 16, `L2 载荷长 ${data131.length} ≠ 16（1 字节命令号 + 15 字节体）`);
    const body = data131.subarray(1);
    equalBytes(
      Buffer.from([0x00, 0x01, 0x04, 0, 0, 0, 0, 0xff, 0, 0, 0xff, 0, 0, 0xff, 0]),
      body,
      "131 体（4 槽）",
    );
    must(body.readInt8(1) === 1, "m_byIsGameCanStart ≠ 1（TDGameReadyUI.as:986 会挡住开始）");
    must(body.readInt8(2) === 4, `座位槽数=${body.readInt8(2)} ≠ 4（数组长度由它驱动）`);
    must(body.readInt8(4) === 0, "本座位 m_byReadyStatus 初始必须为 0（=1 会被 :545 禁用按钮）");
    must(body.readInt8(5) === 0, "本座位 m_PointStatus=1 会弹「体力不足」并阻止开始");

    /**
     * ★ 回归护栏：**必须至少有 1 个空座位槽（255）**。
     * `TDGameReadyUI.as:548-560` 的 255 分支是唯一会调用 `TableReadyUI.showVcKey()` 的地方，
     * 而 `showVcKey` 末尾 `TableReadyUI.as:373-376` 才触发 `fn_CallBack()` →
     * `showReadyCards()` → `onShowCardPackageCards(arrTDCards[0], ...)`（填「我的防御卡」）。
     * 只发 1 个座位时该分支永不执行 ⇒ 卡面板永远空白 ⇒ 无法选卡 ⇒ cmd1 永远不发。
     */
    const emptySlots = [4, 7, 10, 13].filter((i) => body.readUInt8(i) === 255).length;
    must(emptySlots >= 1, `没有任何 255 空座位槽（实测 ${emptySlots} 个）—— 「我的防御卡」会永远空白`);
    must(emptySlots === 3, `空座位槽应为 3 个（单人），实际 ${emptySlots}`);
    must(body.readInt8(0) === 0, "masterSeat 必须等于本机座位，否则不显示「开始」");
  });

  check("C2b 131 之后必须紧跟一条 14620 卡片通知（刷新「我的防御卡」的第二条通路）", () => {
    must(rawNotify.readInt16BE(14) === 14620, `卡片通知 msgID=${rawNotify.readInt16BE(14)} ≠ 14620`);
  });

  // C3：cmd1 → 129
  const f = makeCmd1();
  await sendGameData(socket, sessionKey, {
    seq: 3,
    roomID: 3,
    tableID: 1,
    cmd: L2_CS_CMDS.PostSelectedCards,
    body: f.gd.subarray(1),
  });

  const p1 = await nextL2(reader, sessionKey, 3000);
  check("C3 收到 cmd1 后服务端主动推 129，载荷回显 cmd1 的卡组与 gameMode", () => {
    const n = parseGameDataNotify(p1);
    must(n.roomID === 3 && n.tableID === 1, `room/table=${n.roomID}/${n.tableID}`);
    const data = firstL2Data(p1);
    must(data[0] === L2_CMDS.LoadStart, `cmd=${data[0]} ≠ 129`);
    const body = data.subarray(1);
    must(body.readInt16BE(0) === roomStateGameMode(), `gameMode=${body.readInt16BE(0)}（应回显 roomState.gameMode）`);
    must(body.readInt16BE(2) === 2, `cardCount=${body.readInt16BE(2)}`);
    must(body.readUInt32BE(4) === 0x10001 && body.readUInt32BE(8) === 0xe00003, "cardIDs 不是 cmd1 里的原序");
    must(body.readInt16BE(12) === 0 && body.readInt16BE(14) === 0, "prop/avatar count 应为 0");
    must(body.readInt32BE(16) === 0x11223344, `seed=0x${(body.readInt32BE(16) >>> 0).toString(16)}（应为 REA_BATTLE_SEED）`);
    must(body.length === 12 + 4 * 2, `129 体长 ${body.length} ≠ 20`);
  });

  // C4：重复 cmd1 不再推第二份 129
  await sendGameData(socket, sessionKey, {
    seq: 4,
    roomID: 3,
    tableID: 1,
    cmd: L2_CS_CMDS.PostSelectedCards,
    body: f.gd.subarray(1),
  });
  const dup129 = await collectL2(reader, sessionKey, 800);
  check("C4 重复 cmd1 不推第二份 129（防 a_2179.as:849 卡死）", () => {
    must(dup129.length === 0, `重复 cmd1 推了 ${dup129.length} 条 L2 帧`);
  });

  // C5：进度 99 不推 130
  await sendGameData(socket, sessionKey, { seq: 5, roomID: 3, tableID: 1, cmd: L2_CS_CMDS.PostLoadingProgress, body: Buffer.from([99]) });
  const early = await collectL2(reader, sessionKey, 600);
  check("C5 进度 99 不推 130（a_757 可能还没建好）", () => {
    must(early.length === 0, `进度 99 就推了 cmd=${notifyCmds(early)}`);
  });

  // C6：进度 100 → 130
  await sendGameData(socket, sessionKey, { seq: 6, roomID: 3, tableID: 1, cmd: L2_CS_CMDS.PostLoadingProgress, body: Buffer.from([100]) });
  const p2 = await nextL2(reader, sessionKey, 3000);
  check("C6 进度 100 后服务端推 130（体定长 10 字节、seed 与 129 相同）", () => {
    const data = firstL2Data(p2);
    must(data[0] === L2_CMDS.StartGame, `cmd=${data[0]} ≠ 130`);
    // L2 载荷 = 命令号(1) + 协议体；真正的 130 体（a_2695）必须是 10 字节。
    must(data.length === 11, `L2 载荷长 ${data.length} ≠ 11（= 1 字节命令号 + 10 字节体）`);
    const body = data.subarray(1);
    must(body.length === 10, `130 体长 ${body.length} ≠ 10`);
    must(body.readInt16BE(0) === 20, `waveNum=${body.readInt16BE(0)} ≠ 20`);
    must(body.readInt16BE(0) > 0, "waveNum 必须 > 0（a_3563:38 会除零）");
    must(body.readInt32BE(2) === 0x11223344, `seed=0x${(body.readInt32BE(2) >>> 0).toString(16)} ≠ 0x11223344`);
    must(body.readInt32BE(6) === 0, `buffId=${body.readInt32BE(6)} ≠ 0`);
  });

  // C7：重复进度 100 不重复推 130
  await sendGameData(socket, sessionKey, { seq: 7, roomID: 3, tableID: 1, cmd: L2_CS_CMDS.PostLoadingProgress, body: Buffer.from([100]) });
  const dup130 = await collectL2(reader, sessionKey, 600);
  check("C7 重复进度 100 不重复推 130", () => {
    must(dup130.length === 0, `130 被重复推送 ${dup130.length} 次`);
  });

  // C8：cmd12（角色展示广播）不触发任何 L2 推送
  await sendGameData(socket, sessionKey, { seq: 8, roomID: 3, tableID: 1, cmd: L2_CS_CMDS.PostAvatarInfo, body: Buffer.from([0, 0]) });
  const other = await collectL2(reader, sessionKey, 600);
  check("C8 cmd12 不触发任何 L2 推送", () => {
    must(other.length === 0, `cmd12 触发了 cmd=${notifyCmds(other)}`);
  });

  /* ---------------------------------------------------------------- *
   * G. SC 132 NextEnmeyWave —— 「出怪」驱动（2026-10-16）
   *
   * 客户端那边：132 → `a_2053.a_2090` → `a_2699.decode` → `a_2179.a_2181`
   * → `TDGame2V2BattleUI.a_3608` → `BattleFieldView.a_3456` 造实体。
   * 所以"到底有没有怪"完全取决于这条帧：格式错 = 一只都不出，或者更糟 ——
   * `a_4256(typeID)` 返回 null 时 `:3111` 直接 `throw("此老鼠不存在ID")`。
   * ---------------------------------------------------------------- */
  const p3 = await nextL2(reader, sessionKey, 10000);
  check("G1 130 之后服务端当帧源：必须推 132(NextEnmeyWave)，体 = 6 + 13N", () => {
    const data = firstL2Data(p3);
    must(data[0] === L2_SC_CMDS.NextEnmeyWave, `cmd=${data[0]} ≠ 132`);
    const body = data.subarray(1);
    const count = body.readInt16BE(4);
    must(count === 5, `第一波鼠数=${count} ≠ 5（规则：4+波序）`);
    must(body.length === nextWavePayloadLength(count), `132 体长 ${body.length} ≠ ${nextWavePayloadLength(count)}`);
    must(body.readInt8(2) === 100, `m_byWaveProgress=${body.readInt8(2)} ≠ 100（=100 才会让 a_3564 把波数 +1）`);
    must(body.readInt8(0) === 2 && body.readInt8(1) === 1, `鼠洞 count/hole=${body.readInt8(0)}/${body.readInt8(1)}`);
  });

  check("G2 每只老鼠的字段都合规：ID 在白名单内、行 0..6、tick 递增且 50ms 一档", () => {
    const data = firstL2Data(p3);
    const body = data.subarray(1);
    const count = body.readInt16BE(4);
    let lastTick = -1;
    for (let i = 0; i < count; i += 1) {
      const at = 6 + i * 13;
      const seq = body.readUInt16BE(at);
      const typeID = body.readUInt32BE(at + 2);
      const appearType = body.readUInt8(at + 6);
      const row = body.readUInt8(at + 7);
      const flag = body.readUInt8(at + 8);
      const tick = body.readUInt32BE(at + 9);
      must(seq === i + 1, `第 ${i} 只 m_nEnemySequence=${seq} ≠ ${i + 1}`);
      must(
        BATTLE_MOUSE_REGISTRY.has(typeID),
        `第 ${i} 只 typeID=0x${typeID.toString(16)} 不在客户端注册表里 —— ` +
          `a_4256 会返回 null 并 throw("此老鼠不存在ID")`,
      );
      must(row >= 0 && row <= 6, `第 ${i} 只 row=${row} 越界（a_1012=7 ⇒ 0..6）`);
      must(appearType === 2, `第 ${i} 只 appearType=${appearType} ≠ 2（从鼠洞钻出）`);
      must(flag >= 1 && flag <= 2, `第 ${i} 只 appearFlag=${flag}（a_3429 取洞用，须 ≥1）`);
      must(tick > lastTick, `第 ${i} 只 tick=${tick} 没有递增（上一个 ${lastTick}）`);
      lastTick = tick;
    }
    must(body.readUInt32BE(6 + 9) === 60, "第一只的出现 tick 应等于 REA_WAVE_START_TICK 默认 60（3s）");
  });

  check("G3 出怪表是种子化的纯函数：同种子完全一致、换种子会变", () => {
    const a = battleWavePlan({ seed: 0x11223344, mapID: 0x50010301, totalWaveNum: 4 });
    const b = battleWavePlan({ seed: 0x11223344, mapID: 0x50010301, totalWaveNum: 4 });
    const c = battleWavePlan({ seed: 0x55667788, mapID: 0x50010301, totalWaveNum: 4 });
    must(JSON.stringify(a) === JSON.stringify(b), "同种子两次结果不一致");
    must(JSON.stringify(a.waves) !== JSON.stringify(c.waves), "换种子出怪表没变");
    must(a.waves.length === 4, `波数=${a.waves.length} ≠ 4`);
    must(a.rows === 7, `行数=${a.rows} ≠ 7`);
    for (const w of a.waves) for (const e of w.enemies) must(e.typeID <= 0xffff, "typeID 超出 uint16 语义");
  });

  check("G4 地图鼠表与客户端白名单取交集；零交集时回落经典三只（绝不发未注册的鼠）", () => {
    // 本图（次元/古堡系合成地图）自带 29 只 0x1xxx 鼠，客户端一只都没注册 ⇒ 必须回落
    const onMap = resolveWaveMice(0x50010301);
    must(onMap.mice.length > 0, "回落结果为空");
    for (const m of onMap.mice) {
      must(BATTLE_MOUSE_REGISTRY.has(m), `回落结果里含未注册的老鼠 0x${m.toString(16)}`);
    }
    const noMap = resolveWaveMice(0);
    for (const m of noMap.mice) must(BATTLE_MOUSE_REGISTRY.has(m), "无地图配置时也必须是白名单里的鼠");
  });

  check("G5 132 体的字节布局（手工按 a_2699.decode 逐字段拼一遍比对）", () => {
    const enemies = [
      { seq: 1, typeID: 0x0002, appearType: 2, row: 3, appearFlag: 1, tick: 60 },
      { seq: 2, typeID: 0x001e, appearType: 2, row: 6, appearFlag: 2, tick: 80 },
    ];
    const body = buildNextWavePayload({
      ratHoleCount: 2,
      ratHole: 1,
      waveProgress: 100,
      waveStatus: 0,
      enemies,
    });
    const want = Buffer.from([
      0x02, 0x01, 0x64, 0x00, 0x00, 0x02, // count/hole/progress/status/enemyNum=2
      0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x02, 0x03, 0x01, 0x00, 0x00, 0x00, 0x3c,
      0x00, 0x02, 0x00, 0x00, 0x00, 0x1e, 0x02, 0x06, 0x02, 0x00, 0x00, 0x00, 0x50,
    ]);
    equalBytes(want, body, "132 体（2 只）");
  });

  stopWavePushes();
  socket.end();
} catch (e) {
  failures.push(`端到端流程异常: ${e.message}`);
  console.log(`  ✗ 端到端流程异常: ${e.message}`);
}

function roomStateGameMode() {
  // 本测试没走 SIT_DOWN（8705），roomState.gameMode 保持初值 2；
  // 真实客户端实测 SIT_DOWN 里 m_byGameMod=1（server.log:4754），129 必须回显它而不是写死。
  return 2;
}

console.log("===== D. 变异自检（确认断言真的能变红） =====");

check("D1 变异实现：cardID 字节序/归一化写错 → 必须变红", () => {
  /** 与 buildLoadStartPayload 同构，只把 cardID 的写法换成 mk() */
  const mutatedBuild = ({ gameMode, cardIDs, seed }, mk) => {
    const i16 = (v) => { const b = Buffer.alloc(2); b.writeInt16BE(v, 0); return b; };
    const out = [i16(gameMode | 0), i16(cardIDs.length)];
    for (const id of cardIDs) out.push(mk(id));
    out.push(i16(0), i16(0));
    const s = Buffer.alloc(4);
    s.writeInt32BE(seed | 0, 0);
    out.push(s);
    return Buffer.concat(out);
  };
  const args = { gameMode: 1, cardIDs: [0xe00003, 0xffffffff], seed: 0x11223344 };
  const exp = expected129(args);

  // 变异 A：小端写（真实编码器 bug，字节可见）
  const le = (id) => { const b = Buffer.alloc(4); b.writeUInt32LE(id >>> 0, 0); return b; };
  // 变异 B：丢掉高 24 位
  const truncated = (id) => { const b = Buffer.alloc(4); b.writeUInt32BE((id & 0xff) >>> 0, 0); return b; };
  // 变异 C：不经 >>> 0 归一化直接 writeInt32BE（高位为 1 的卡 ID 会抛 ERR_OUT_OF_RANGE）
  const noNormalize = (id) => { const b = Buffer.alloc(4); b.writeInt32BE(id, 0); return b; };

  for (const [label, mk] of [["LE", le], ["id&0xff", truncated], ["writeInt32BE(未归一化)", noNormalize]]) {
    let caught = false;
    try {
      equalBytes(exp, mutatedBuild(args, mk), `变异体(${label})`);
    } catch {
      caught = true;
    }
    must(caught, `变异 ${label} 竟然没有被抓到`);
  }
  // 反向对照：正确实现不被误判
  equalBytes(exp, buildLoadStartPayload(args), "对照（正确实现）");
});

/**
 * ★ 诚实记录一个**无法**用字节断言区分的变异：
 *   `buf.writeInt32BE(v, 0)` 与 `buf.writeUInt32BE(v >>> 0, 0)` 对任何 v 都产生**相同字节**
 *   （writeInt32BE(-1) 与 writeUInt32BE(0xffffffff) 都是 ff ff ff ff）。
 *   所以"有符号/无符号"在字节层面不可观测 —— 防护来自 A3 里的**值语义**断言
 *   （`readUInt32BE(8) === 0xffffffff`）与实现里的 `>>> 0` 归一化，而不是字节比对。
 */
check("D1b 记录：int32/uint32 写入在字节上不可区分（故靠值语义断言防护）", () => {
  const s = Buffer.alloc(4);
  const u = Buffer.alloc(4);
  s.writeInt32BE(-1, 0);
  u.writeUInt32BE(0xffffffff, 0);
  must(s.equals(u), "预期两者字节相同");
});

check("D2 变异实现：129 的 seed 偏移挪后 4 字节 → 必须被抓到", () => {
  const badBuild = ({ gameMode, cardIDs, seed }) => {
    const parts = [];
    const i16 = (v) => { const b = Buffer.alloc(2); b.writeInt16BE(v, 0); return b; };
    parts.push(i16(gameMode | 0), i16(cardIDs.length));
    for (const id of cardIDs) { const b = Buffer.alloc(4); b.writeUInt32BE(id >>> 0, 0); parts.push(b); }
    parts.push(i16(0));
    const s = Buffer.alloc(4);
    s.writeInt32BE(seed | 0, 0);
    parts.push(s);
    parts.push(i16(0)); // ← 变异点：把 avatarCount 挪到 seed 后面
    return Buffer.concat(parts);
  };
  const args = { gameMode: 1, cardIDs: [1], seed: 0x11223344 };
  let caught = false;
  try {
    equalBytes(expected129(args), badBuild(args), "变异体");
  } catch {
    caught = true;
  }
  must(caught, "seed 偏移错位竟没有被抓到");
});

check("D3 变异实现：130 体多写 2 字节 → 长度断言必须抓到", () => {
  const badBuild = ({ waveNum, seed, buffId = 0 }) => {
    const b = Buffer.alloc(12); // ← 变异点
    b.writeInt16BE(waveNum | 0, 0);
    b.writeInt32BE(seed | 0, 2);
    b.writeInt32BE(buffId | 0, 6);
    return b;
  };
  const args = { waveNum: 20, seed: 0x11223344 };
  let caught = false;
  try {
    const m = badBuild(args);
    must(m.length === 10, `长度 ${m.length} ≠ 10`);
  } catch {
    caught = true;
  }
  must(caught, "12 字节的 130 体竟被认为合法");
  must(buildGameStartPayload(args).length === 10, "正确实现长度不是 10");
});

check("D4 变异：把 cmd1 的 blob 长度改大 1 → 长度自洽断言必须抓到", () => {
  const f = makeCmd1();
  const gd = Buffer.from(f.gd);
  // cardCount(1B) + 2*8B = 17，blob 长度字段在 1+16+2+8 = 27
  const szPos = 1 + 2 * 8 + 2 + 8;
  gd.writeInt16BE(gd.readInt16BE(szPos) + 1, szPos);
  const r = parsePostSelectedCards(gd);
  must(r.ok === false, "blob 长度被改大竟解析成功");
});

/**
 * E. 启动页几何 —— 「准备界面点不到开始」的根因护栏（2026-10-16）
 *
 * 实测（`server/_screen.png` 逐像素 + `Screen::PrimaryScreen`）：屏幕 1536x864、
 * FCBrowser 窗口 1200x525，画布从窗口 y=116 开始铺 600 高 ⇒ 底部约 200px 被裁掉。
 * 而「开始」按钮在准备界面右下角（画布底部）⇒ 玩家点不到 ⇒ 从没有 cmd1 上行
 * ⇒ 服务端永远不推 129 ⇒ 载入进度停在 99%。所以**启动页必须把画布缩放到窗口内**，
 * 这条断言就是防止有人把 `fitGame()` 删掉/改回不缩放的布局。
 */
{
  const res = await fetch(`http://127.0.0.1:${process.env.REA_HTTP_PORT}/`);
  const html = await res.text();
  check("E1 启动页把 950x600 画布等比缩放到窗口内（否则「开始」在可视区外）", () => {
    must(/function fitGame\s*\(/.test(html), "缺少 fitGame()：画布不缩放，准备界面右下角的「开始」会被窗口裁掉");
    must(/addEventListener\("resize"/.test(html), "缺少 resize 监听：改窗口大小后不会重新适配");
    must(/Math\.min\(vw \/ GAME_W, vh \/ GAME_H, 1\)/.test(html), "缩放不是按宽高取小的等比缩放（且只缩不放）");
    must(/#wrap\{position:fixed;top:0;right:0;bottom:0;left:0/.test(html), "居中容器不能用 inset（Chromium 83 不支持，会退化到左上角）");
    must(html.includes('width="950" height="600"'), "画布本身仍应声明 950x600（缩放交给 CSS）");
    must(!html.includes("#wrap{display:flex;justify-content:center;padding:12px}"), "旧的[不缩放]布局又回来了");
  });
  check("E2 启动页回报画布几何（下次排查几何问题要有实测数字）", () => {
    must(html.includes("diagGeom"), "缺少 diagGeom 上报");
    must(html.includes("devicePixelRatio"), "缺少 dpr 上报");
    must(html.includes("getBoundingClientRect"), "缺少画布 rect 上报");
  });
}

/**
 * F. 战斗模块（美术层）—— 「卡 99%」的根因护栏（2026-10-16）
 *
 * 见 docs/battle-module-rootcause.md：逻辑在 TDCore、美术在 `TDGame2V2BattleUI.swf`，
 * 两边**类名相同**，而客户端用**子域**加载 ⇒ 模块里的空壳遮蔽 TDCore 的逻辑类 ⇒
 * `content as b_147` 得 null ⇒ `a_2179.as:1664 a_757.SetDIYInfo(...)` 空引用抛异常 ⇒
 * 载入进度停在 99%。
 *
 * 修法是 `server/patch-battle-assets.cjs` 把模块 ABC 常量池里的**类简单名等长改名**，
 * 点分全名（SymbolClass 标签）保持原样 —— 于是链名只能落到父域 TDCore 的逻辑类上。
 * 这里守住两条不变量：① 标签名不变；② 改名后的类名与 TDCore 不再重名。
 */
{
  const patch = await import("./patch-battle-assets.cjs");
  const { build, parseTags, abcStringPool, symbolClassNames } = patch;
  const built = build();
  const src = patch.SRC;

  check("F1 资产模块的 SymbolClass 链名必须**原样保留**（否则元件就链不到 TDCore 的逻辑类）", () => {
    const srcBody = readBody(src);
    const outBody = readBody(patch.OUT);
    const a = symbolClassNames(srcBody, parseTags(srcBody));
    const b = symbolClassNames(outBody, parseTags(outBody));
    must(a.length > 100, `源模块 SymbolClass 只有 ${a.length} 条，不像资产模块`);
    must(JSON.stringify(a) === JSON.stringify(b), "改名把 SymbolClass 标签里的点分全名也改了");
    must(a.includes("com.aurora.ui.maogoutd.TDGame2V2BattleUI"), "文档类链名不是 TDGame2V2BattleUI");
  });

  check("F2 与 TDCore 同名的类必须改名；TDCore 里**没有**的纯美术元件必须保持原名", () => {
    const outBody = readBody(patch.OUT);
    const abcTag = parseTags(outBody).find((t) => t.code === 82);
    must(abcTag !== undefined, "模块里没有 DoABC（tag 82）");
    const abcStart = outBody.indexOf(0, abcTag.start + 4) + 1;
    const abc = outBody.subarray(abcStart, abcTag.end);
    const names = new Set(
      abcStringPool(abc).map(([s, e]) => abc.subarray(s, e).toString("utf8")),
    );
    const renamedSimples = [...built.rename.keys()];
    must(renamedSimples.length === 123, `改名表 ${renamedSimples.length} 条 ≠ 123`);
    for (const s of renamedSimples) must(!names.has(s), `ABC 里仍有与 TDCore 同名的类：${s}`);
    // 保持原名的那些（纯美术元件）必须**仍在** ABC 里，否则链名在域链上找不到类
    for (const d of built.skipped) {
      const s = d.split(".").pop();
      must(names.has(s), `纯美术元件 ${d} 的壳类被改掉了 —— 链名将无处可解，客户端会卡在预载`);
    }
    must(names.has("TDGame2V2BattleUA"), "没找到改名后的文档类 TDGame2V2BattleUA");
  });

  check("F5 只改「TDCore 里确实有同名类」的符号：改名集合必须与反编译产物一致", () => {
    const known = patch.tdcoreClassNames();
    const renamed = [...built.rename.keys()].map((s) =>
      built.dots.find((d) => d.split(".").pop() === s),
    );
    must(renamed.every((d) => typeof d === "string"), "有改名项对不上任何 SymbolClass 全名");
    if (known === null) {
      // 没有反编译产物可查：退到硬编码清单，至少保证"跳过的就是那 12 个纯美术元件"
      must(built.skipped.length === 12, `跳过 ${built.skipped.length} 条 ≠ 12`);
      return;
    }
    for (const d of renamed) must(known.has(d), `${d} 在 TDCore 里没有同名类，不该改名`);
    for (const d of built.skipped) must(!known.has(d), `${d} 在 TDCore 里有同名类，不该跳过`);
  });

  /**
   * ⚠ 这条断言的**含义**随默认档变化，别写死某一个文件：
   * 2026-10-16 实机两次对照后，默认从 assets 退回 cdn（理由见 local-server.mjs 里
   * BATTLE_MODULE 的注释）。所以这里只断言"下发的是三档已知产物之一、且 HTTP 字节与磁盘一致"。
   */
  await checkAsync("F3 战斗模块下发的是 assets/cdn/stub 三档之一，且字节与磁盘一致", async () => {
    const { status, body: got } = await httpGetBuffer(
      `http://127.0.0.1:${process.env.REA_HTTP_PORT}/TDGame2V2BattleUI.swf`,
    );
    must(status === 200, `HTTP ${status}`);
    // ⚠ 用 fileURLToPath，别用 `URL.pathname`：工作区路径含中文，pathname 是百分号编码的
    const cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client-cache");
    const candidates = {
      assets: patch.OUT,
      cdn: `${cacheDir}/mirror/TDGame2V2BattleUI.swf`,
      stub: `${cacheDir}/mirror/battle_stub/TDGame2V2BattleUI.swf`,
    };
    const hit = Object.entries(candidates).find(
      ([, file]) => fs.existsSync(file) && fs.readFileSync(file).equals(got),
    );
    must(hit !== undefined, `下发的战斗模块不是三档中任何一个（${got.length} B）`);
  });

  check("F4 改名表本身：等长、无自碰撞（不会把两个类改成同一个名字）", () => {
    const { rename } = built;
    const seen = new Set();
    for (const [oldName, newName] of rename) {
      must(oldName.length === newName.length, `${oldName} -> ${newName} 长度不同（会破坏 ABC 索引）`);
      must(oldName !== newName, `${oldName} 没被改名`);
      must(!seen.has(newName), `新名 ${newName} 撞车`);
      seen.add(newName);
    }
  });
}

/**
 * H. 客户端内部日志通道（2026-10-16）
 *
 * 背景：客户端内部诊断走 `a_4788.a_4648.a_4649` → LocalConnection `_debugConnection`，
 * 而在 FCBrowser（PPAPI Flash 34）里这条通道**不投递**（接收器连自检消息都收不到）。
 * 修法：`TDLoaderUI.as:582` 把所有模块都加载进 **同一个 `ApplicationDomain.currentDomain`**，
 * 于是把一份"同名同签名"的日志器覆盖件插到 `LoadFilesList.xml` 的 **SWFFile 首位**，
 * 先注册 `a_4788.a_4648` 就能顶掉 TDCore 里那份（同域先定义者胜）。
 * 下面三条守的就是这个前提：顺序、覆盖件内容、以及 `/__trace` 这条 HTTP 通路。
 */
{
  await checkAsync("H1 LoadFilesList.xml 里日志器覆盖件必须排在 TDCore 之前", async () => {
    const { status, body } = await httpGetBuffer(
      `http://127.0.0.1:${process.env.REA_HTTP_PORT}/LoadFilesList.xml`,
    );
    must(status === 200, `HTTP ${status}`);
    const xml = body.toString("utf8");
    const atLogger = xml.indexOf('logger_patch.swf');
    const atCore = xml.indexOf('url="TDCore.swf"');
    must(atLogger > 0, "LoadFilesList 里没有 logger_patch.swf");
    must(atCore > 0, "LoadFilesList 里没有 TDCore.swf");
    must(atLogger < atCore, "覆盖件排在 TDCore 之后 ⇒ 同域先定义者胜时它会输，日志通道不生效");
    must(/name="RealLogger"/.test(xml), "覆盖件条目缺少 name=\"RealLogger\"");
    must(/version="rea1"/.test(xml.slice(atLogger - 200, atLogger + 200)), "version 必须非 0（0 会被客户端跳过）");
  });

  await checkAsync("H2 覆盖件 SWF 定义 a_4788.a_4648 并走 /__trace，且不再用 LocalConnection", async () => {
    const { status, body } = await httpGetBuffer(
      `http://127.0.0.1:${process.env.REA_HTTP_PORT}/logger_patch.swf`,
    );
    must(status === 200, `HTTP ${status}`);
    const abc = body.subarray(0, 3).toString("latin1") === "CWS"
      ? zlib.inflateSync(body.subarray(8))
      : body.subarray(8);
    const txt = abc.toString("latin1");
    must(txt.includes("a_4788.a_4648"), "覆盖件里没有 a_4788.a_4648（顶不掉 TDCore 的日志器）");
    must(txt.includes("a_4649"), "覆盖件里没有 a_4649（TDCore 调的就是这个入口）");
    must(txt.includes("__trace"), "覆盖件没有把日志送到 /__trace");
    must(!txt.includes("_debugConnection"), "覆盖件还在用 LocalConnection（那条通道在本机不投递）");
  });

  await checkAsync("H3 /__trace 通路可用（GET 与 POST 都返回 204）", async () => {
    const { status } = await httpGetBuffer(
      `http://127.0.0.1:${process.env.REA_HTTP_PORT}/__trace?id=t&msg=hello`,
    );
    must(status === 204, `GET 返回 ${status} ≠ 204`);
    const post = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: Number(process.env.REA_HTTP_PORT),
          path: "/__trace?id=post",
          method: "POST",
          agent: false,
          headers: { connection: "close", "content-type": "text/plain" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end("hello-post");
    });
    must(post === 204, `POST 返回 ${post} ≠ 204`);
  });
}

function readBody(file) {
  const raw = fs.readFileSync(file);
  return raw.subarray(0, 3).toString("latin1") === "CWS"
    ? zlib.inflateSync(raw.subarray(8))
    : raw.subarray(8);
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

/**
 * 自己走 node:http（`agent:false` + Connection: close）。
 * ⚠ 不要在这里用全局 `fetch`：undici 的连接池会和 `process.exit()` 抢句柄，
 * 实测会以 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 崩掉（exit=0xC0000409），
 * 把"判据是尾行 + 退出码"这条纪律直接毁掉。
 */
function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false, headers: { connection: "close" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
  });
}

console.log("");
console.log(`合计：${passed} 通过 / ${failures.length} 失败`);
if (failures.length > 0) {
  console.log("失败明细：");
  for (const f of failures) console.log(`  - ${f}`);
}
// 服务端监听句柄会使进程不退出，这里显式结束（与 run-frame-test.mjs 同范式）。
process.exit(failures.length > 0 ? 1 : 0);
