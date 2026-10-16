#!/usr/bin/env node
/**
 * 端到端校验：把 local-server.mjs 当库启动在临时端口上，扮演客户端走一遍
 * 认证握手，再逐条发送第三批大厅报文，按各应答类 decode() 的字段顺序逐字节断言。
 *
 * 这样可以在没有 Flash 客户端的情况下，确认新增应答的布局与客户端一致
 * （字段类型、顺序、int8/int16/uint32 混排、字符串长度前缀都不会写错）。
 *
 * 用法：node verify-handlers.mjs
 */

import net from "node:net";
import { readFileSync } from "node:fs";

// 用独立端口，避免和正在运行的实例冲突（模块在 import 时读取这些环境变量）。
process.env.REA_HTTP_PORT = "18080";
process.env.REA_GAME_PORT = "28443";
process.env.REA_AUTH_PORT = "28444";
process.env.REA_HALL_PORT = "28445";
process.env.REA_LOGIC_PORT = "28446";

const { startServer, padPlaintext, xteaEncrypt, HALL_RESPONSES, NO_REPLY_MSGIDS } = await import(
  "./local-server.mjs"
);
const { xteaDecrypt } = await import("./capture.mjs");

const LOCAL_KEY = Buffer.from("Authentic@51.COM", "utf8");
const PLAYER_UIN = 100001;
const ROLE_UIN = 200001;
const ACCOUNT = "localplayer";
const USER_TYPE = 7;
const GAME_PORT = Number(process.env.REA_GAME_PORT);
const AUTH_PORT = Number(process.env.REA_AUTH_PORT);

startServer();
await new Promise((r) => setTimeout(r, 200)); // 等监听就绪

/* ------------------------------------------------------------------ *
 * 小工具：封包 / 收包 / 字节游标
 * ------------------------------------------------------------------ */

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
/** a_2664.encode_string：int16 字节长度 + UTF-8 字节（含结尾 NUL）。 */
const encodeString = (value, maxLength) => {
  let text = value ?? "";
  if (text.length >= maxLength) text = text.slice(0, maxLength - 1);
  const bytes = Buffer.from(`${text}\0`, "utf8");
  return Buffer.concat([int16(bytes.length), bytes]);
};

/** 客户端 → 服务端：header 前多一个 httpHead 字节（服务端 parseHeader(buffer,1)）。 */
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

/** 服务端 → 客户端：无 httpHead 前缀。 */
function parseServerPacket(packet) {
  const headerLen = packet.readInt16BE(12);
  return { msgID: packet.readInt16BE(14), body: packet.subarray(headerLen) };
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
  return { next: () => new Promise((res) => { waiters.push(res); pump(); }) };
}

function makeCursor(data) {
  let pos = 0;
  return {
    int8: () => data.readInt8(pos++),
    int16: () => {
      const v = data.readInt16BE(pos);
      pos += 2;
      return v;
    },
    int32: () => {
      const v = data.readInt32BE(pos);
      pos += 4;
      return v;
    },
    str: () => {
      const n = data.readInt16BE(pos);
      pos += 2;
      const s = data.subarray(pos, pos + n);
      pos += n;
      return s;
    },
    skip: (n) => {
      pos += n;
    },
    get pos() {
      return pos;
    },
  };
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => resolve({ socket, reader: makeReader(socket) }));
    socket.on("error", reject);
  });
}

/* ------------------------------------------------------------------ *
 * 认证握手：拿到会话密钥
 * ------------------------------------------------------------------ */

async function authenticate() {
  const { socket, reader } = await connect(AUTH_PORT);
  const accountBuf = Buffer.from(`${ACCOUNT}\0`, "utf8");
  const plain = Buffer.concat([
    int32(123), // sequence
    int16(accountBuf.length),
    accountBuf,
    int16(USER_TYPE),
  ]);
  const payload = xteaEncrypt(padPlaintext(plain), LOCAL_KEY, 32);
  socket.write(clientFrame({ messageId: 1, version: 1, uin: -1, playerId: -1, flag: 4, payload }));

  const packet = await reader.next();
  const { msgID, body } = parseServerPacket(packet);
  if (msgID !== 2) throw new Error(`auth: expected msgID 2, got ${msgID}`);
  const dec = xteaDecrypt(body, LOCAL_KEY, -32);
  if (!dec.ok) throw new Error(`auth: response decrypt failed: ${dec.reason}`);

  let pos = 4; // 跳过 sequence
  const resultID = dec.data.readInt16BE(pos);
  pos += 2;
  pos += 4; // uin
  const nameLen = dec.data.readInt16BE(pos);
  pos += 2 + nameLen; // account 字符串（含结尾 NUL）
  pos += 2; // userType
  const sessionKey = Buffer.from(dec.data.subarray(pos, pos + 16));
  socket.end();
  if (resultID !== 0) throw new Error(`auth: resultID=${resultID}`);
  return sessionKey;
}

/* ------------------------------------------------------------------ *
 * 第三批应答的期望布局（按各应答类 decode 的顺序）
 * 返回 { ok, detail } —— 解码失败或字段不符则 ok=false
 * ------------------------------------------------------------------ */

/** 断言辅助：条件不成立即抛错，由 expect 捕获为 FAIL（保证 PASS/FAIL 与字段断言绑定）。 */
const must = (cond, badMsg) => {
  if (!cond) throw new Error(badMsg);
};

function expect(body, fn) {
  const c = makeCursor(body);
  try {
    const detail = fn(c) ?? "";
    if (c.pos !== body.length) return { ok: false, detail: `${detail} | 残留 ${body.length - c.pos} 字节` };
    return { ok: true, detail };
  } catch (e) {
    return { ok: false, detail: `解码异常: ${e.message}` };
  }
}

const CHECKS = new Map([
  [14702, (b) => expect(b, (c) => {
    const r = c.int16(), u = c.int32();
    const five = [c.int32(), c.int32(), c.int32(), c.int32(), c.int32()];
    must(r === 0 && u === PLAYER_UIN && five.every((x) => x === 0), `result=${r} uin=${u} five=${five}`);
    return `result=0 uin=${u} 5×int32=0`;
  })],
  [14945, (b) => expect(b, (c) => {
    // CResponseChoujiangInfo：uin 在 result 之前
    const u = c.int32(), r = c.int16();
    const seven = Array.from({ length: 7 }, () => c.int32());
    must(u === PLAYER_UIN && r === 0 && seven.every((x) => x === 0), `uin=${u} result=${r} seven=${seven}`);
    return `uin 先于 result（uin=${u} result=0）7×int32=0`;
  })],
  [14981, (b) => expect(b, (c) => {
    const u = c.int32(), g = c.int32(), r = c.int32(), unread = c.int32();
    must(u === PLAYER_UIN && g === 0 && r === 0 && unread === 0, `u=${u} g=${g} r=${r} unread=${unread}`);
    return `uin/gid/result/unread=0`;
  })],
  [15360, (b) => expect(b, (c) => {
    const r = c.int16(), u = c.int32(), t = c.int32(), f = c.int32(), n = c.int32();
    must(r === 0 && u === PLAYER_UIN && t === 0 && f === 0 && n === 0, `r=${r} u=${u} t=${t} f=${f} n=${n}`);
    return `result=0 taskCount=0`;
  })],
  [15376, (b) => expect(b, (c) => {
    const r = c.int16(), u = c.int32(), n = c.int16();
    must(r === 0 && u === PLAYER_UIN && n === 0, `r=${r} u=${u} n=${n}`);
    return `result=0 count=0`;
  })],
  [15381, (b) => expect(b, (c) => {
    const r = c.int16(), u = c.int32();
    const three = [c.int32(), c.int32(), c.int32()];
    must(r === 0 && u === PLAYER_UIN && three.every((x) => x === 0), `r=${r} u=${u} three=${three}`);
    return `result=0 3×int32=0`;
  })],
  [15697, (b) => expect(b, (c) => {
    const r = c.int16(), u = c.int32();
    const five = Array.from({ length: 5 }, () => c.int32());
    must(r === 0 && u === PLAYER_UIN && five.every((x) => x === 0), `r=${r} u=${u} five=${five}`);
    return `result=0 5×int32=0`;
  })],
  [15714, (b) => expect(b, (c) => {
    const r = c.int16(), u = c.int32(), n = c.int16();
    must(r === 0 && u === PLAYER_UIN && n === 0, `r=${r} u=${u} n=${n}`);
    return `result=0 count=0`;
  })],
  [15749, (b) => expect(b, (c) => {
    const r = c.int16(), u = c.int32();
    const three = [c.int32(), c.int32(), c.int32()];
    must(r === 0 && u === PLAYER_UIN && three.every((x) => x === 0), `r=${r} u=${u} three=${three}`);
    return `result=0 3×int32=0`;
  })],
  [15760, (b) => expect(b, (c) => {
    // int16, int32, int8, int8, uint32, int16, int8, uint32, int8, int8, int32
    const r = c.int16(), u = c.int32();
    const a = c.int8(), b2 = c.int8(), tasks = c.int32();
    const cake = c.int16(), cakeFlag = c.int8(), awards = c.int32();
    const mailFlag = c.int8(), taskFlag = c.int8(), acc = c.int32();
    const ok = r === 0 && u === PLAYER_UIN && a === 0 && b2 === 0 && tasks === 0 &&
      cake === 0 && cakeFlag === 0 && awards === 0 && mailFlag === 0 && taskFlag === 0 && acc === 0;
    must(ok, `r=${r} u=${u} a=${a} b2=${b2} tasks=${tasks} cake=${cake} awards=${awards}`);
    return `result=0 任务/奖励计数=0（int8/int16/uint32 混排对齐）`;
  })],
  [14768, (b) => expect(b, (c) => {
    const r = c.int16(), reason = c.str();
    must(r === 1 && reason.length === 1 && reason[0] === 0, `r=${r} reason=${reason.toString("hex")}`);
    return `result=1 原因字符串空`;
  })],
  [8466, (b) => expect(b, (c) => {
    const r = c.int16(), serverID = c.int32(), roomCount = c.int16();
    must(r === 0 && serverID === 1 && roomCount === 0, `r=${r} serverID=${serverID} roomCount=${roomCount}`);
    return `result=0 serverID=${serverID} 房间数=0`;
  })],
  [15041, (b) => expect(b, (c) => {
    const r = c.int16(), u = c.int32(), dst = c.int32(), married = c.int8();
    const decl = c.str(), partner = c.int32(), pname = c.str(), buy = c.int8();
    must(r === 0 && u === PLAYER_UIN && dst === 0 && married === 0 && decl.length === 1 &&
      partner === 0 && pname.length === 1 && buy === 0, `r=${r} u=${u} dst=${dst} married=${married}`);
    return `result=0 uin=${u} 未婚`;
  })],
  [8464, (b) => expect(b, (c) => {
    const r = c.int16(), roomID = c.int32(), n = c.int16();
    must(r === 0 && roomID === 3 && n === 0, `r=${r} roomID=${roomID} n=${n}`);
    return `result=0 roomID=${roomID} 桌数=0`;
  })],
  [8452, (b) => expect(b, (c) => {
    const r = c.int16(), roomID = c.int32(), tables = c.int16(), players = c.int16();
    must(r === 0 && roomID === 3 && tables === 0 && players === 0, `r=${r} roomID=${roomID} t=${tables} p=${players}`);
    return `result=0 roomID=${roomID} 桌/人=0`;
  })],
  [8450, (b) => expect(b, (c) => {
    const r = c.int16(), roomID = c.int32();
    must(r === 0 && roomID === 3, `r=${r} roomID=${roomID}`);
    return `result=0 roomID=${roomID}`;
  })],
  [8709, (b) => expect(b, (c) => {
    const r = c.int16(), roomID = c.int32(), tableID = c.int32();
    must(r === 0 && roomID === 3 && tableID === 1, `r=${r} roomID=${roomID} tableID=${tableID}`);
    return `result=0 roomID=${roomID} tableID=${tableID}`;
  })],
]);

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function sendAndCheck(sessionKey, msgID, check, requestBody) {
  const { socket, reader } = await connect(GAME_PORT);
  const reqBody = requestBody ?? Buffer.concat([int32(msgID), Buffer.alloc(8)]);
  const plain = Buffer.concat([int32(msgID), reqBody]); // 请求体内容多数应答不使用
  const payload = xteaEncrypt(padPlaintext(plain), sessionKey, 32);
  socket.write(clientFrame({ messageId: msgID, version: 3, uin: PLAYER_UIN, playerId: PLAYER_UIN, flag: 4, payload }));
  const packet = await reader.next();
  socket.end();
  const { msgID: respID, body } = parseServerPacket(packet);
  const dec = xteaDecrypt(body, sessionKey, -32);
  if (!dec.ok) return { ok: false, detail: `应答解密失败: ${dec.reason}` };
  if (respID !== msgID) return { ok: false, detail: `msgID 不匹配: ${respID} != ${msgID}` };
  if (dec.data.readInt32BE(0) !== 0) return { ok: false, detail: `sequence 前缀不是 0` };
  return check(dec.data.subarray(4));
}

async function expectSilent(sessionKey, msgID) {
  const { socket, reader } = await connect(GAME_PORT);
  const payload = xteaEncrypt(padPlaintext(Buffer.concat([int32(0), Buffer.alloc(8)])), sessionKey, 32);
  socket.write(clientFrame({ messageId: msgID, version: 3, uin: PLAYER_UIN, playerId: PLAYER_UIN, flag: 4, payload }));
  const got = await Promise.race([
    reader.next().then(() => true),
    new Promise((r) => setTimeout(() => r(false), 300)),
  ]);
  socket.end();
  return got ? { ok: false, detail: "本应静默却收到了应答" } : { ok: true, detail: "无应答（符合预期）" };
}

const sessionKey = await authenticate();
console.log(`\n认证成功，会话密钥 ${sessionKey.toString("hex")}\n`);

let pass = 0;
let fail = 0;
const row = (id, name, r) => {
  const tag = r.ok ? "PASS" : "FAIL";
  if (r.ok) pass += 1;
  else fail += 1;
  console.log(`[${tag}] ${String(id).padStart(5)}  ${(name ?? "").padEnd(28)} ${r.detail}`);
};

const NEW_IDS = [
  14702, 14945, 14981, 15360, 15376, 15381, 15697, 15714, 15749, 15760, 14768, 8466, 15041,
  8464, 8452, 8450,
  8709,
];
// 少数报文需要"像样"的请求体（如 a_2916 的 serverID）
const REQ_OVERRIDES = new Map([
  [8466, int32(1)], // a_2916: m_iServerID = 1
  [8464, int32(3)], // a_2917: m_iRoomID = 3
  [8452, int32(3)], // a_2936: m_iRoomID = 3
  [8450, int32(3)], // a_2919: m_iRoomID = 3
  [8709, Buffer.concat([int32(3), int32(1), int16(0)])], // a_2926: roomID=3 tableID=1 dataLen=0
]);
for (const id of NEW_IDS) {
  const spec = HALL_RESPONSES.get(id);
  if (!spec) throw new Error(`HALL_RESPONSES 缺少 ${id}`);
  row(id, spec.name, await sendAndCheck(sessionKey, id, CHECKS.get(id), REQ_OVERRIDES.get(id)));
}

/* ---- 单机进战斗：SitDown(8705) → a_2953（含 CPlayerDetail） ---- */

/** CPlayerDetail.decode 的等价实现：返回消费字节数以便校验长度前缀。 */
function decodePlayerDetail(c) {
  const size = c.int16();
  const start = c.pos;
  const uin = c.int32();
  const account = c.str().toString("utf8").replace(/\0.*$/, "");
  const name = c.str().toString("utf8").replace(/\0.*$/, "");
  c.int16(); // flag
  c.int32(); // identity
  c.int32(); // birthday
  c.int8(); // iconType
  c.str(); // zoneInfo
  for (let i = 0; i < 7; i += 1) c.int32(); // charming..vipLevel
  const playerId = c.int32();
  const tableId = c.int32();
  let seat = -1;
  let status = -1;
  let seq = 0;
  if (tableId >= 0) {
    seat = c.int8();
    status = c.int8();
    if (status !== 0 && status !== 4) seq = c.int32();
  }
  c.skip(8); // point uint64
  for (let i = 0; i < 7; i += 1) c.int32(); // win..flower
  c.str(); // extraUid
  c.int32(); // goodId
  c.int32(); // gameVipScore
  c.int32(); // gameVipLevel
  return { size, consumed: c.pos - start, uin, account, name, playerId, tableId, seat, status, seq };
}

/** 读 `client-cache/config-data/composite_map.xml` 里的 map_id 集合（仅供断言用）。 */
function parseCompositeMapIdsForTest() {
  const set = new Set();
  try {
    const xml = readFileSync(
      new URL("../client-cache/config-data/composite_map.xml", import.meta.url),
      "utf8",
    );
    for (const m of xml.matchAll(/map_id="(0x[0-9a-fA-F]+|[0-9]+)"/g)) {
      const id = Number.parseInt(m[1], m[1].startsWith("0x") ? 16 : 10);
      if (Number.isFinite(id) && id !== 0) set.add(id >>> 0);
    }
  } catch {
    /* 断言里按空集处理 */
  }
  return set;
}

function checkSitDown(b) {
  return expect(b, (c) => {
    const result = c.int16();
    c.int8(); // m_byACT
    const roomID = c.int32();
    const tableID = c.int32();
    const seatID = c.int8();
    c.int32(); // m_iSitdownSequence
    c.int32(); // m_iCrossID（decode 多读的那个字段）
    const mapID = c.int32();
    const gameMode = c.int8();
    c.int8(); // level
    c.int16(); // seatmask
    const playerCount = c.int8();
    const players = [];
    for (let i = 0; i < playerCount; i += 1) players.push(decodePlayerDetail(c));
    const me = players[0];
    /**
     * ★ 2026-10-16：单机战斗会被**改道到合成地图**（见 local-server.mjs 的
     * `resolveBattleMapID`：普通地图的 SWF 是新版、客户端 `as BaseGameMap` 拿不到，
     * 会导致载入卡 96）。所以这里断言的是"要么回显请求的地图，要么是
     * composite_map.xml 里的合成地图"，而不是写死 1001。
     * `REA_FORCE_COMPOSITE_MAP=0` 时应严格回显 1001。
     */
    const composite = parseCompositeMapIdsForTest();
    const mapOk =
      process.env.REA_FORCE_COMPOSITE_MAP === "0"
        ? mapID === 1001
        : mapID === 1001 || composite.has(mapID >>> 0);
    const ok =
      result === 0 &&
      mapOk &&
      gameMode === 2 &&
      playerCount === 1 &&
      me !== undefined &&
      me.size === me.consumed &&
      me.account === "localplayer" &&
      me.tableId === tableID &&
      me.seat === seatID;
    must(ok, `result=${result} mapID=${mapID} mode=${gameMode} count=${playerCount} me=${JSON.stringify(me)}`);
    return `result=0 mapID=${mapID} mode=${gameMode}(1vComputer) room=${roomID} table=${tableID} seat=${seatID} player[${me.name},size=${me.size}]`;
  });
}

{
  // a_2928 请求：roomID/tableID = -1（对电脑模式），地图 1001，模式 2（1vComputer）
  const sitdownReq = Buffer.concat([
    Buffer.from([0]), // m_byACT
    int32(-1), // m_iRoomID
    int32(-1), // m_iTableID
    Buffer.from([0]), // m_bySeatID
    Buffer.from([0]), // m_byCanAdjust
    Buffer.from([0]), // m_iFcm
    encodeString("", 32), // m_szTableKey
    encodeString("新手战斗", 32), // m_szTableName
    int32(1001), // m_iGameMapID
    Buffer.from([2]), // m_byGameMod = 1vComputer
    Buffer.from([0]), // m_bLevel
    Buffer.from([0]), // m_byPlayerCount
    int16(0), // m_nMapListCount
  ]);
  row(8705, "SIT_DOWN → a_2953", await sendAndCheck(sessionKey, 8705, checkSitDown, sitdownReq));
}

/* ---- 坐下之后：桌列表(8464)应回显这张桌（"创建房间"关键） ---- */
{
  const check = (b) =>
    expect(b, (c) => {
      const result = c.int16();
      const roomID = c.int32();
      const n = c.int16();
      must(result === 0 && roomID === 1 && n === 1, `result=${result} roomID=${roomID} tableCount=${n}`);
      const tableID = c.int32();
      const status = c.int16();
      const name = c.str().toString("utf8").replace(/\0.*$/, "");
      const mm = c.int8();
      const seat = c.int8();
      const valid = c.int8();
      c.int32(); // mapID
      c.int8(); // gameMode
      c.int8(); // level
      must(tableID === 1 && status === 0 && seat === 1 && valid === 2, `tableID=${tableID} status=${status} seat=${seat} valid=${valid}`);
      return `result=0 roomID=${roomID} 桌数=1 桌[${name} id=${tableID} seat=${seat} valid=${valid}]`;
    });
  row(8464, "GET_TABLE_INFO(坐下后)", await sendAndCheck(sessionKey, 8464, check, int32(1)));
}

/* ---- 坐下之后：房间视图(8452)应回"这张桌 + 自己" ---- */
{
  const check = (b) =>
    expect(b, (c) => {
      const result = c.int16();
      const roomID = c.int32();
      const tables = c.int16();
      must(result === 0 && roomID === 1 && tables === 1, `result=${result} roomID=${roomID} tables=${tables}`);
      c.int8(); // a_2963 size
      const tableID = c.int32();
      c.int16(); // table status
      const players = c.int16();
      const uin = c.int32(); // a_2911
      const name = c.str().toString("utf8").replace(/\0.*$/, "");
      c.int16(); // flag
      c.int32(); // identity
      c.int32(); // playerID
      const ptid = c.int32();
      const seat = c.int8();
      const status = c.int8();
      c.int32(); // exp
      c.int32(); // achievement
      c.skip(8); // point u64
      c.int32(); c.int32(); c.int32(); c.int32(); c.int32(); c.int32(); // win..vipScore
      must(
        players === 1 && tableID === 1 && ptid === 1 && seat === 0 && status === 1 && uin === ROLE_UIN,
        `players=${players} tableID=${tableID} ptid=${ptid} seat=${seat} status=${status} uin=${uin}`,
      );
      return `result=0 roomID=${roomID} 桌=1 玩家=${players}[${name} seat=${seat} status=${status}]`;
    });
  row(8452, "UPDATE_VIEW_AREA(坐下后)", await sendAndCheck(sessionKey, 8452, check, int32(1)));
}

/* ---- 进房间：EnterRoom(8449) → a_2938（含 CPlayerDetail + CPlayerGameConfig） ---- */

function checkEnterRoom(b) {
  return expect(b, (c) => {
    const result = c.int16();
    c.int8(); // m_byACT
    const roomID = c.int32();
    const head = c.int32();
    const tail = c.int32();
    const me = decodePlayerDetail(c);
    const cfgSize = c.int16();
    const cfgStart = c.pos;
    c.int32(); // m_iMinPoint
    c.int32(); // m_iMaxPointGap
    c.int32(); // m_byMaxOfflineRate
    c.int8(); // m_byIPBit
    c.int8(); // m_uiBitMap
    const otherSize = c.int8();
    c.skip(otherSize);
    const cfgConsumed = c.pos - cfgStart;
    const flag = c.int32();
    must(
      result === 0 && roomID === 5 && me.size === me.consumed &&
        cfgSize === cfgConsumed && otherSize === 0 && flag === 0,
      `result=${result} roomID=${roomID} me=${me.size}/${me.consumed} cfg=${cfgSize}/${cfgConsumed} flag=${flag}`,
    );
    return `result=0 roomID=${roomID} 桌范围[${head},${tail}] player[${me.name}] cfgSize=${cfgSize}`;
  });
}

{
  // a_2913 请求：m_iACT(int8) + m_iRoomID(int32) = 5
  const enterRoomReq = Buffer.concat([Buffer.from([0]), int32(5)]);
  row(8449, "ENTER_ROOM → a_2938", await sendAndCheck(sessionKey, 8449, checkEnterRoom, enterRoomReq));
}

// 心跳 / 埋点 / 日志：确认服务端确实不回应答
for (const [id, name] of NO_REPLY_MSGIDS) {
  row(id, `(silent) ${name}`, await expectSilent(sessionKey, id));
}

/* ------------------------------------------------------------------ *
 * 8709 独立验证：a_2951 回显 roomID/tableID（不是写死的常量）
 *
 * 请求 a_2926 布局（com\aurora\protocol\logicserver\a_2926.as:34）：
 *   m_iRoomID(int32) m_iTableID(int32) m_nGameDataLength(int16) m_szGameData(memory)
 * 应答 a_2951 布局（...\a_2951.as:29）：
 *   m_nResultID(int16) m_iRoomID(int32) m_iTableID(int32)   → 2 + 4 + 4 = 10 字节
 *
 * 客户端在 a_2445.as:157-158 把 _pConnInfo 里的 roomID/tableID 填进请求，
 * 服务端应原样回显。这里用【两组不同的非默认值】各跑一遍：
 * 只测一组值时，"房间号被写死成常量" 这类 bug 依然会通过。
 * ------------------------------------------------------------------ */

function makeGameDataCheck(expectRoom, expectTable) {
  return (b) =>
    expect(b, (c) => {
      const lenOk = b.length === 2 + 4 + 4;
      const r = c.int16();
      const roomID = c.int32();
      const tableID = c.int32();
      must(
        lenOk && r === 0 && roomID === expectRoom && tableID === expectTable,
        `长度=${b.length}(应为 10) result=${r}(应为 0) ` +
          `roomID=${roomID}(应为 ${expectRoom}) tableID=${tableID}(应为 ${expectTable})`,
      );
      return `长度=10 result=0 回显 roomID=${roomID} tableID=${tableID}（请求值一致）`;
    });
}

/** a_2926 请求体：m_iRoomID + m_iTableID + m_nGameDataLength(0) + 空 memory。 */
const gameDataReq = (roomID, tableID) => Buffer.concat([int32(roomID), int32(tableID), int16(0)]);

for (const [roomID, tableID] of [[7, 3], [11, 5]]) {
  row(
    8709,
    `SEND_GAME_DATA 回显(${roomID},${tableID})`,
    await sendAndCheck(sessionKey, 8709, makeGameDataCheck(roomID, tableID), gameDataReq(roomID, tableID)),
  );
}

// 加密自检（与 local-server 里的自检一致，确保填充/加密未被破坏）
{
  const sample = Buffer.from("verify-handlers 美食大战老鼠 0123456789", "utf8");
  const rt = xteaDecrypt(xteaEncrypt(padPlaintext(sample), LOCAL_KEY, 32), LOCAL_KEY, -32);
  row("crypto", "crypto round-trip", {
    ok: rt.ok && rt.data.equals(sample),
    detail: rt.ok ? `${sample.length}B 还原一致` : rt.reason,
  });
}

console.log(`\n合计：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
