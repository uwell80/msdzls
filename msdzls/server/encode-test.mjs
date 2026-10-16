// encode-test.mjs — 用 docs/battle-protocol.md 的规格手写 L2 报文，验证字节布局
// 目的：证明规格可编码，且能被「按文档独立实现」的解码器还原。
// 运行：node server/encode-test.mjs
import zlib from 'node:zlib';

// ---------- 原语（对应 a_2664.as）----------
class W {
  constructor() { this.b = []; }
  i8(v)  { this.b.push(v & 0xFF); return this; }
  u16(v) { this.b.push((v >>> 8) & 0xFF, v & 0xFF); return this; }          // writeShort
  i16(v) { return this.u16(v); }
  i32(v) { this.b.push((v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF); return this; }
  str(s, max) {                                                              // encode_string
    if (s == null) s = '';
    else if (s.length >= max) s = s.substr(0, max - 1);
    s = s + '\x00';
    const bytes = Buffer.from(s, 'utf8');
    this.u16(bytes.length);                                                  // writeUTF 的前缀 = UTF 字节数(含\0)
    for (const x of bytes) this.b.push(x);
    return this;
  }
  raw(buf) { for (const x of buf) this.b.push(x); return this; }
  out() { return Buffer.from(this.b); }
}

// ---------- CPlayerDetail（自带 int16 长度前缀，非 nosize）----------
function cPlayerDetail(p) {
  const w = new W();
  w.i32(p.m_iUin);
  w.str(p.m_szAccount, 32);
  w.str(p.m_szPlayerName, 32);
  w.i16(p.m_nFlag);
  w.i32(p.m_iIdentity);
  w.i32(p.m_iBirthDay);
  w.i8(p.m_byIconType);                       // = 0 → 跳过两组 face 字段
  w.str(p.m_szZoneInfo, 40);
  w.i32(p.m_iCharming);
  w.i32(p.m_iAchievement);
  w.i32(p.m_lHappyBean);
  w.i32(p.m_iExperiencePoint);
  w.i32(p.m_i51VIPScore);
  w.i32(p.m_i51Level);
  w.i32(p.m_i51VIPLevel);
  w.i32(p.m_iPlayerID);
  w.i32(p.m_iTableID);                        // 必须 >= 0
  if (p.m_iTableID >= 0) {
    w.i8(p.m_bySeat);
    w.i8(p.m_byStatus);                       // = 3 Playing
    if (p.m_byStatus !== 0 && p.m_byStatus !== 4) w.i32(p.m_iSitdownSequence);
  }
  w.i32(0); w.i32(p.m_iPoint);                // uint64 高低位
  w.i32(p.m_iWinRound); w.i32(p.m_iLoseRound); w.i32(p.m_iDrawRound);
  w.i32(p.m_iEscapeRound); w.i32(p.m_iOfflineRound);
  w.i32(p.m_iMoney); w.i32(p.m_iFlowerCount);
  w.str(p.m_szExtraUid, 32);
  w.i32(p.m_iGoodId); w.i32(p.m_iGameVIPScore); w.i32(p.m_iGameVIPLevel);

  const body = w.out();
  const out = new W();
  out.i16(body.length);                       // ← 回填 playerDetailSize
  out.raw(body);
  return out.out();
}

// ---------- a_2953 SitDown 应答 ----------
export function encodeSitDownResponse(players) {
  const w = new W();
  w.i16(0);                                   // m_nResultID = 0 成功
  w.i8(1);                                    // m_byACT
  w.i32(1001);                                // m_iRoomID  ← 真实值
  w.i32(2001);                                // m_iTableID ← 真实值
  w.i8(0);                                    // m_bySeatID
  w.i32(1);                                   // m_iSitdownSequence
  w.i32(0);                                   // ★ m_iCrossID：encode 不写、decode 必读
  w.i32(14680064 + 1);                        // m_iMapID
  w.i8(0);                                    // m_byGameMode
  w.i8(1);                                    // m_bLevel
  w.i16(0x00FF);                              // m_nseatmask
  w.i8(players.length);                       // m_byPlayerCount
  for (const p of players) w.raw(cPlayerDetail(p));
  return w.out();
}

// ---------- CAvatarInfo（nosize 数组）----------
export function encodeAvatarInfo(a, avatarObj, cards, skills) {
  const w = new W();

  // --- AMF0 对象（对应 AS3 readObject/writeObject 的对象子集）---
  const amf = encodeAmf0Object(avatarObj);
  const z = zlib.deflateSync(amf);            // AS3 ByteArray.compress() = zlib

  w.i8(a.m_bySeatID);
  w.u16(z.length);                            // m_nMemorySize = 压缩后长度
  w.raw(z);
  w.i8(cards.length);                         // m_byCardsCount
  for (const c of cards) {                    // CGameCardInfo: 7 字节
    w.i32(c.m_iCardID); w.i8(c.m_byCardDegreeLevel);
    w.i8(c.m_byCardSkillLevel); w.i8(c.m_byCardGradeLevel);
  }
  w.i8(a.m_isAutoPickUpEnergy ? 1 : 0);
  w.i8(a.m_isAutoPickUpProps ? 1 : 0);
  w.i16(skills.length);                       // m_nWeaponSkillCount
  for (const s of skills) {                   // CWeaponSkillInfo: 8 字节
    w.i32(s.m_iWeaponSkillID); w.i32(s.m_iWeaponSkillLevel);
  }
  return w.out();
}

// AMF3 编码器（AS3 ByteArray.objectEncoding 默认 = AMF3）
// 标记: undefined=0x00 null=0x01 false=0x02 true=0x03 integer=0x04 double=0x05
//       string=0x06 xmlDoc=0x07 date=0x08 array=0x09 object=0x0A
function amf3U29(n) {                       // U29 变长整数（1-4 字节）
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x4000) return Buffer.from([0x80 | (n >>> 7), n & 0x7F]);
  if (n < 0x200000) return Buffer.from([0x80 | (n >>> 14), 0x80 | ((n >>> 7) & 0x7F), n & 0x7F]);
  return Buffer.from([0x80 | (n >>> 22), 0x80 | ((n >>> 15) & 0x7F), 0x80 | ((n >>> 8) & 0x7F), n & 0xFF]);
}
function encodeAmf0Object(o) {              // 保留旧名以兼容调用点，实际输出 AMF3
  return encodeAmf3Object(o);
}
function encodeAmf3Object(o) {
  const head = Buffer.from([0x0A]);                                  // object-marker
  // U29O: 低 1 位 = 0(非引用), 次 1 位 = 0(非 trait), 高位 = 内联 traits 计数 | 0x01(动态)
  const keys = Object.keys(o);
  const u29o = amf3U29((keys.length << 4) | 0x03);                    // 动态 + sealed 计数
  const parts = [head, u29o];
  for (const k of keys) {
    const kb = Buffer.from(k, 'utf8');
    parts.push(amf3U29((kb.length << 1) | 0x01));                     // UTF-8-vr, 内联(低位=1)
    parts.push(kb);
    parts.push(encodeAmf3Value(o[k]));
  }
  parts.push(Buffer.from([0x01]));                                    // 动态成员结束: 空字符串
  return Buffer.concat(parts);
}
function encodeAmf3Value(v) {
  if (v === null) return Buffer.from([0x01]);
  if (typeof v === 'boolean') return Buffer.from([v ? 0x03 : 0x02]);
  if (typeof v === 'number') {
    // AMF3 integer 走 U29（29 位有符号区间）；超出则用 double
    if (Number.isInteger(v) && v >= -0x10000000 && v <= 0x0FFFFFFF) {
      const u = v < 0 ? (v + 0x20000000) : v;
      return Buffer.concat([Buffer.from([0x04]), amf3U29(u)]);
    }
    const b = Buffer.alloc(9); b[0] = 0x05; b.writeDoubleBE(v, 1); return b;
  }
  if (typeof v === 'string') {
    const sb = Buffer.from(v, 'utf8');
    return Buffer.concat([Buffer.from([0x06]), amf3U29((sb.length << 1) | 0x01), sb]);
  }
  if (Array.isArray(v)) {                                            // dense array
    const u29 = amf3U29((v.length << 1) | 0x01);
    // 关联部分为空 -> 立即 0x01 结束
    return Buffer.concat([Buffer.from([0x09]), u29, Buffer.from([0x01]), ...v.map(encodeAmf3Value)]);
  }
  if (typeof v === 'object') return encodeAmf3Object(v);
  throw new Error('unsupported AMF value: ' + typeof v);
}

// ---------- a_2698 LoadStart ----------
export function encodeLoadStart({ gameMode, cardIDs, propIDs, avatars, randomSeed }) {
  const w = new W();
  w.i8(129);                                  // ★ L2 命令号
  w.i16(gameMode);
  w.i16(cardIDs.length);                      // m_nSelectCardIDCount
  for (const id of cardIDs) w.i32(id);        // uint32[]
  w.i16(propIDs.length);                      // m_nSelectPropIDCount
  for (const id of propIDs) w.i32(id);
  w.i16(avatars.length);                      // m_nAvatarInfoCount
  for (const a of avatars) w.raw(a);          // nosize：不写长度前缀
  w.i32(randomSeed);                          // m_RandomSeed
  return w.out();
}

// ---------- a_2695 GameStart ----------
export function encodeGameStart({ waveNum, randomSeed, buffId }) {
  const w = new W();
  w.i8(130);
  w.i16(waveNum);
  w.i32(randomSeed);
  w.i32(buffId);
  return w.out();
}

// ---------- CNotifyGameStep ----------
export function encodeStepSync(step) {
  const w = new W();
  w.i8(128);
  w.i32(step);
  return w.out();
}
