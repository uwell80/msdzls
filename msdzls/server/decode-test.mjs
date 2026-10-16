// decode-test.mjs — 严格按 AS3 decode 侧（a_2953 / CPlayerDetail / a_2664）独立实现，
// 用来验证 encode-test.mjs 产出的字节流能否被「照文档实现」的解码器完美还原。
// 若规格有误（尤其 m_iCrossID / m_iTableID / nosize 前缀），这里会立刻暴露。
import zlib from 'node:zlib';

class R {
  constructor(buf) { this.b = buf; this.p = 0; }
  get avail() { return this.b.length - this.p; }
  i8()  { const v = this.b.readInt8(this.p); this.p += 1; return v; }
  // ★ 命令号必须按无符号读：a_2053.as:145 用的是 decode_uint8
  //    129 (0x81) 若按有符号读会得到 -127
  u8()  { const v = this.b.readUInt8(this.p); this.p += 1; return v; }
  u16() { const v = this.b.readUInt16BE(this.p); this.p += 2; return v; }
  i16() { const v = this.b.readInt16BE(this.p); this.p += 2; return v; }
  i32() { const v = this.b.readInt32BE(this.p); this.p += 4; return v; }
  u64() { const hi = this.b.readUInt32BE(this.p); const lo = this.b.readUInt32BE(this.p + 4); this.p += 8; return hi * 2 ** 32 + lo; }
  str(max) {                                     // decode_string
    const len = this.i16();
    if (len <= 0) return null;                   // 注意：不消费后续字节
    const n = len > max ? max : len;
    const s = this.b.toString('utf8', this.p, this.p + n); this.p += n;
    return s;
  }
  raw(n) { const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
}

// ---------- CPlayerDetail.decode ----------
export function decodePlayerDetail(r) {
  const size = r.i16();
  const start = r.p;
  if (r.avail < size) throw new Error('CPlayerDetail: bytesAvailable < playerDetailSize');

  const p = {};
  p.m_iUin = r.i32();
  p.m_szAccount = r.str(32);
  p.m_szPlayerName = r.str(32);
  p.m_nFlag = r.i16();
  p.m_iIdentity = r.i32();
  p.m_iBirthDay = r.i32();
  p.m_byIconType = r.i8();
  if ((p.m_byIconType & 64) || (p.m_byIconType & 128)) {     // EnmFaceMask
    p.m_szFaceVersion = r.str(32);
    p.m_szIconURL = r.str(96);
  }
  p.m_szZoneInfo = r.str(40);
  p.m_iCharming = r.i32();
  p.m_iAchievement = r.i32();
  p.m_lHappyBean = r.i32();
  p.m_iExperiencePoint = r.i32();
  p.m_i51VIPScore = r.i32();
  p.m_i51Level = r.i32();
  p.m_i51VIPLevel = r.i32();
  p.m_iPlayerID = r.i32();
  p.m_iTableID = r.i32();
  if (p.m_iTableID >= 0) {
    p.m_bySeat = r.i8();
    p.m_byStatus = r.i8();
    if (p.m_byStatus !== 0 && p.m_byStatus !== 4) p.m_iSitdownSequence = r.i32();
  }
  p.m_iPoint = r.u64();
  p.m_iWinRound = r.i32(); p.m_iLoseRound = r.i32(); p.m_iDrawRound = r.i32();
  p.m_iEscapeRound = r.i32(); p.m_iOfflineRound = r.i32();
  p.m_iMoney = r.i32(); p.m_iFlowerCount = r.i32();
  if ((p.m_byIconType & 64) || (p.m_byIconType & 128)) {
    p.m_szFaceURL50 = r.str(96);
    p.m_szFaceURL130 = r.str(96);
  }
  p.m_szExtraUid = r.str(32);
  p.m_iGoodId = r.i32(); p.m_iGameVIPScore = r.i32(); p.m_iGameVIPLevel = r.i32();

  if (r.p - start > size) throw new Error(`CPlayerDetail 越界: 读了 ${r.p - start}, 声明 ${size}`);
  r.p = start + size;                                        // 强制对齐
  return p;
}

// ---------- a_2953.decode ----------
export function decodeSitDownResponse(buf) {
  const r = new R(buf);
  const o = {};
  o.m_nResultID = r.i16();
  o.m_byACT = r.i8();
  o.m_iRoomID = r.i32();
  o.m_iTableID = r.i32();
  o.m_bySeatID = r.i8();
  o.m_iSitdownSequence = r.i32();
  o.m_iCrossID = r.i32();                                    // ★ 无条件读取
  if (o.m_nResultID === 0) {
    o.m_iMapID = r.i32();
    o.m_byGameMode = r.i8();
    o.m_bLevel = r.i8();
    o.m_nseatmask = r.i16();
    o.m_byPlayerCount = r.i8();
    o.m_stPlayers = [];
    for (let i = 0; i < o.m_byPlayerCount; i++) o.m_stPlayers.push(decodePlayerDetail(r));
  } else {
    o.m_szReasonMsg = r.str(2048);
  }
  o._consumed = r.p;
  return o;
}

// ---------- a_2698.decode ----------
export function decodeLoadStart(buf) {
  const r = new R(buf);
  const o = {};
  const cmd = r.u8();
  if (cmd !== 129) throw new Error(`LoadStart: 期望 cmd=129, 实际 ${cmd}`);
  o.m_nGameMode = r.i16();
  const cardCount = r.i16(); o.m_arrSelectCardIDs = [];
  for (let i = 0; i < cardCount; i++) o.m_arrSelectCardIDs.push(r.i32());       // uint32
  const propCount = r.i16(); o.m_arrSelectPropIDs = [];
  for (let i = 0; i < propCount; i++) o.m_arrSelectPropIDs.push(r.i32());
  const avatarCount = r.i16(); o.m_arrAvatarInfoArray = [];
  for (let i = 0; i < avatarCount; i++) o.m_arrAvatarInfoArray.push(decodeAvatarInfo(r));  // nosize
  o.m_RandomSeed = r.i32();
  o._consumed = r.p;
  return o;
}

// ---------- CAvatarInfo.decode ----------
export function decodeAvatarInfo(r) {
  const a = {};
  a.m_bySeatID = r.i8();
  a.m_nMemorySize = r.u16();
  const z = r.raw(a.m_nMemorySize);
  a._amf = decodeAmf0(zlib.inflateSync(z));
  const cardsCount = r.i8(); a.m_arrGameCardInfoArray = [];
  for (let i = 0; i < cardsCount; i++) {
    a.m_arrGameCardInfoArray.push({
      m_iCardID: r.i32(), m_byCardDegreeLevel: r.i8(),
      m_byCardSkillLevel: r.i8(), m_byCardGradeLevel: r.i8(),
    });
  }
  a.m_isAutoPickUpEnergy = r.i8();
  a.m_isAutoPickUpProps = r.i8();
  const skillCount = r.i16(); a.m_arrWeaponSkillInfo = [];
  for (let i = 0; i < skillCount; i++) {
    a.m_arrWeaponSkillInfo.push({ m_iWeaponSkillID: r.i32(), m_iWeaponSkillLevel: r.i32() });
  }
  return a;
}

// AMF3 解码器（AS3 ByteArray.objectEncoding 默认 = AMF3）
function decodeAmf0(buf) {                  // 保留旧名，实际解 AMF3
  let p = 0;
  function u29() {
    let n = 0;
    for (let i = 0; i < 3; i++) {
      const b = buf[p++];
      if ((b & 0x80) === 0) { n = (n << 7) | b; return n; }
      n = (n << 7) | (b & 0x7F);
    }
    const b = buf[p++];                     // 第 4 字节全 8 位
    return ((n << 8) | b) >>> 0;
  }
  function utf8vr() {
    const h = u29();
    if ((h & 1) === 0) throw new Error('AMF3 字符串引用未支持');
    const n = h >>> 1;
    const s = buf.toString('utf8', p, p + n); p += n;
    return s;
  }
  function val() {
    const t = buf[p++];
    switch (t) {
      case 0x00: return undefined;
      case 0x01: return null;
      case 0x02: return false;
      case 0x03: return true;
      case 0x04: { const u = u29(); return u > 0x0FFFFFFF ? u - 0x20000000 : u; }
      case 0x05: { const d = buf.readDoubleBE(p); p += 8; return d; }
      case 0x06: return utf8vr();
      case 0x09: {                                             // dense array
        const h = u29();
        if ((h & 1) === 0) throw new Error('AMF3 数组引用未支持');
        const n = h >>> 1;
        const k = utf8vr();                                    // 关联部分应以空 key 结束
        if (k !== '') throw new Error('AMF3 关联数组未支持: ' + k);
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(val());
        return arr;
      }
      case 0x0A: {                                             // object
        const h = u29();
        if ((h & 1) === 0) throw new Error('AMF3 对象引用未支持');
        if ((h & 2) === 0) throw new Error('AMF3 trait 引用未支持');
        const sealedCount = h >>> 4;
        const dynamic = (h & 0x08) !== 0;
        const o = {};
        for (let i = 0; i < sealedCount; i++) { const k = utf8vr(); o[k] = val(); }
        if (dynamic) {
          for (;;) { const k = utf8vr(); if (k === '') break; o[k] = val(); }
        }
        return o;
      }
      default: throw new Error(`AMF3 未知类型标记 0x${t === undefined ? 'EOF' : t.toString(16)} @${p - 1}`);
    }
  }
  return val();
}

// ---------- a_2695 ----------
export function decodeGameStart(buf) {
  const r = new R(buf);
  const cmd = r.u8();
  if (cmd !== 130) throw new Error(`GameStart: 期望 cmd=130, 实际 ${cmd}`);
  return { m_nTotalIntruderWaveNum: r.i16(), m_RandomSeed: r.i32(), m_iBuffId: r.i32(), _consumed: r.p };
}

// ---------- CNotifyGameStep ----------
export function decodeStepSync(buf) {
  const r = new R(buf);
  const cmd = r.u8();
  if (cmd !== 128) throw new Error(`StepSync: 期望 cmd=128, 实际 ${cmd}`);
  return { m_GameStep: r.i32(), _consumed: r.p };
}
