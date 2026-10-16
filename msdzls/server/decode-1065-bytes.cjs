/**
 * 独立字节解码器 —— 不 import 任何脚本内部的 Reader，自己按源码逐字段读。
 * 目的：证伪/证实 "失败应答回 1065 + 尾串位置正确"。
 *
 * 判据：按 SCResponseUpgrade.as:47-79 顺序解完后，消费字节数 == buffer 总长。
 *
 * 用法：node decode-1065-bytes.cjs <hexfile>
 *   或：node decode-1065-bytes.cjs --selftest   （用已知构造验证解码器本身）
 */
const fs = require("fs");

function makeReader(buf) {
  let p = 0;
  return {
    get p() { return p; },
    b: buf,
    i8() { return buf.readInt8(p++); },
    u8() { return buf[p++]; },
    i16() { const v = buf.readInt16BE(p); p += 2; return v; },
    i32() { const v = buf.readInt32BE(p); p += 4; return v; },
    // a_2664.decode_string: int32 长度 + UTF8 字节（长度含自身末尾 0 终止符的写法按实测）
    str() {
      const len = buf.readInt32BE(p); p += 4;
      const s = buf.slice(p, p + len).toString("utf8");
      p += len;
      return { len, s };
    },
  };
}

function decodeUpgrade(buf) {
  const r = makeReader(buf);
  const out = {};
  out.m_nResult = r.i16();
  out.m_cLevel = r.i8();
  out.m_iSrcUin = r.i32();
  // a_2738 m_stNewCardInfo
  out.cardID = r.i32();
  out.cardSeq = r.i32();
  out.m_iPosition = r.i32();
  out.m_nSubCount = r.i16();
  out.subs = [];
  for (let i = 0; i < out.m_nSubCount; i++) out.subs.push({ id: r.i32(), seq: r.i32() });
  out.m_nAssMaterialCount = r.i16();
  out.ass = [];
  for (let i = 0; i < out.m_nAssMaterialCount; i++) out.ass.push({ id: r.i32(), seq: r.i32() });
  out.m_nDisableConsortiaExtra = r.i16();
  // ★ SCResponseUpgrade.as:74 —— 仅当 m_nResult != 0 才读尾串
  out.readTailString = out.m_nResult !== 0;
  if (out.readTailString) {
    const t = r.str();
    out.reasonLen = t.len;
    out.reason = t.s;
  } else {
    out.reasonLen = null;
    out.reason = null;
  }
  out.consumed = r.p;
  out.total = buf.length;
  out.selfConsistent = r.p === buf.length;
  return out;
}

// ---------- selftest：先证明解码器本身可信 ----------
if (process.argv[2] === "--selftest") {
  function i16(v) { const b = Buffer.alloc(2); b.writeInt16BE(v); return b; }
  function i32(v) { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; }
  function i8(v) { return Buffer.from([v & 0xff]); }
  function s(v) { const body = Buffer.from(v, "utf8"); return Buffer.concat([i32(body.length), body]); }
  // 用与 local-server.mjs 失败分支同构的构造
  const built = Buffer.concat([
    i16(1065), i8(7), i32(200001), i32(0x11130050), i32(900002), i32(0),
    i16(1), i32(0x11130014), i32(7),
    i16(0),
    i16(0),
    s("强化失败，主卡已降级"),
  ]);
  const d = decodeUpgrade(built);
  const expect = {
    m_nResult: 1065, m_cLevel: 7, m_nSubCount: 1, m_nDisableConsortiaExtra: 0,
    reason: "强化失败，主卡已降级", selfConsistent: true,
  };
  let bad = 0;
  for (const [k, v] of Object.entries(expect)) {
    if (d[k] !== v) { console.log(`  ✗ selftest ${k}: 期望 ${v}，得到 ${d[k]}`); bad++; }
    else console.log(`  ✓ selftest ${k} = ${JSON.stringify(d[k])}`);
  }
  console.log(`\nSELFTEST ${bad === 0 ? "PASS" : "FAIL"}（${bad} 项不符）`);
  process.exit(bad === 0 ? 0 : 1);
}

const hex = fs.readFileSync(process.argv[2], "utf8").trim();
const buf = Buffer.from(hex.replace(/\s+/g, ""), "hex");
const d = decodeUpgrade(buf);
console.log(JSON.stringify(d, null, 2));
console.log(`\n消费字节数 = ${d.consumed} / 总长 ${d.total} ⇒ ${d.selfConsistent ? "✓ 自洽" : "✗ 不自洽"}`);
process.exit(d.selfConsistent ? 0 : 1);
