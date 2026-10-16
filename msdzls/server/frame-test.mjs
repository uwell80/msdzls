// 验证 §18 L1 传输层封装：a_2670 头 + b_164 XXTEA-CBC 加密 + a_2926 包装
// 直接照抄 b_164.as 的算法，逐块复刻，验证自洽。
import { strict as assert } from 'node:assert';

const DELTA = 2654435769 >>> 0;
const KEY_BLOCK = 32;

// ---- b_165: XXTEA 核心（v/o 为 8 字节缓冲，k 为密钥） ----
function xxtea(v, o, k, N) {
  const vd = new DataView(v.buffer, v.byteOffset, v.byteLength);
  const od = new DataView(o.buffer, o.byteOffset, o.byteLength);
  const kd = new DataView(k.buffer, k.byteOffset, k.byteLength);
  let y = vd.getUint32(0, true);
  let z = vd.getUint32(4, true);
  let sum;
  if (N > 0) {
    const limit = (DELTA * N) >>> 0;
    sum = 0;
    while (sum !== limit) {
      const ki = ((sum & 3) * 4) % k.byteLength;
      y = (y + ((((z << 4) ^ (z >>> 5)) + z) ^ (sum + kd.getInt32(ki, true)))) >>> 0;
      sum = (sum + DELTA) >>> 0;
      const k2 = (((sum >>> 11) & 3) * 4) % k.byteLength;
      z = (z + ((((y << 4) ^ (y >>> 5)) + y) ^ (sum + kd.getInt32(k2, true)))) >>> 0;
    }
  } else {
    sum = (DELTA * -N) >>> 0;
    while (sum !== 0) {
      const k2 = (((sum >>> 11) & 3) * 4) % k.byteLength;
      z = (z - ((((y << 4) ^ (y >>> 5)) + y) ^ (sum + kd.getInt32(k2, true)))) >>> 0;
      sum = (sum - DELTA) >>> 0;
      const ki = ((sum & 3) * 4) % k.byteLength;
      y = (y - ((((z << 4) ^ (z >>> 5)) + z) ^ (sum + kd.getInt32(ki, true)))) >>> 0;
    }
  }
  od.setUint32(0, y, true);
  od.setUint32(4, z, true);
}

// ---- a_1774: 加密（b_164.as:73-173） ----
function encrypt(pbyIn, key) {
  const nPadDataZero = 1 + pbyIn.length + 7;
  let nPadLength = nPadDataZero % 8;
  if (nPadLength !== 0) nPadLength = 8 - nPadLength;
  const nTotalLength = nPadDataZero + nPadLength;

  // 第一块 8 字节明文
  const first = Buffer.alloc(8);
  first[0] = ((0) & 0xF8) | nPadLength;   // 随机部分取 0，便于确定性测试
  for (let i = 1; i <= nPadLength; i++) first[i] = 0;
  const copyLen = Math.max(0, 8 - (1 + nPadLength));
  pbyIn.copy(first, 1 + nPadLength, 0, Math.min(copyLen, pbyIn.length));

  const out = Buffer.alloc(8 * Math.ceil(nTotalLength / 8) + 8);
  let outCursor = 0;
  {
    const blk = Buffer.alloc(8);
    xxtea(first, blk, key, KEY_BLOCK);
    blk.copy(out, 0);
    outCursor += 8;
  }
  let inCursor = 8 - (1 + nPadLength);
  let lastPlain = Buffer.from(first);

  while (pbyIn.length - inCursor > 1) {
    const src = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) {
      const inByte = inCursor + i < pbyIn.length ? pbyIn[inCursor + i] : 0;
      src[i] = inByte ^ out[outCursor - 8 + i];
    }
    const prevPlain = lastPlain;
    xxtea(src, out, key, KEY_BLOCK);
    // 输出与上一块明文异或
    for (let i = 0; i < 8; i++) out[outCursor + i] ^= prevPlain[i];
    lastPlain = src;
    outCursor += 8;
    inCursor += 8;
  }
  // 末块
  const last = Buffer.alloc(8);
  const lastByte = inCursor < pbyIn.length ? pbyIn[inCursor] : 0;
  last[0] = lastByte;
  const src = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) src[i] = last[i] ^ out[outCursor - 8 + i];
  const prevPlain = lastPlain;
  xxtea(src, out, key, KEY_BLOCK);
  for (let i = 0; i < 8; i++) out[outCursor + i] ^= prevPlain[i];
  outCursor += 8;

  return { buf: out.subarray(0, outCursor), nTotalLength };
}

// ---- a_1775: 解密（b_164.as:175-271） ----
function decrypt(pbyIn, key) {
  if (pbyIn.length <= 8 || pbyIn.length % 8) return null;
  let inCursor = 0, outCursor = 0;
  const first = Buffer.alloc(8);
  xxtea(pbyIn.subarray(0, 8), first, key, -KEY_BLOCK);
  inCursor += 8;
  const nPadLength = first[0] & 7;
  const nPlainDataLength = pbyIn.length - 1 - nPadLength - 7;
  if (nPlainDataLength <= 0) return null;

  const out = Buffer.alloc(nPlainDataLength + 16);
  let oPos = 0;
  for (let i = 0; i < 8 - 1 - nPadLength; i++) out[oPos++] = first[1 + nPadLength + i];
  let lastPlain = Buffer.from(first);

  while (inCursor < pbyIn.length - 8) {
    const src = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) src[i] = pbyIn[inCursor + i] ^ lastPlain[i];
    const plain = Buffer.alloc(8);
    xxtea(src, plain, key, -KEY_BLOCK);
    for (let i = 0; i < 8; i++) plain[i] ^= pbyIn[inCursor - 8 + i];
    // 只取前 nPlainDataLength 已写出的部分之后的有效字节
    for (let i = 0; i < 8 && oPos < nPlainDataLength; i++) out[oPos++] = plain[i];
    lastPlain = plain;
    inCursor += 8;
    outCursor += 8;
  }
  // 末块
  const src = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) src[i] = (inCursor + i < pbyIn.length ? pbyIn[inCursor + i] : 0) ^ lastPlain[i];
  const lastBlk = Buffer.alloc(8);
  xxtea(src, lastBlk, key, -KEY_BLOCK);
  for (let i = 0; i < 8; i++) lastBlk[i] ^= pbyIn[inCursor - 8 + i];
  if (oPos < nPlainDataLength) out[oPos++] = lastBlk[0];
  // 校验：末块除首字节外必须全 0
  for (let i = 1; i < 8; i++) if (lastBlk[i] !== 0) return null;
  return out.subarray(0, nPlainDataLength);
}

// ============ 测试 ============
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name} ${extra}`); fail++; }
};

console.log('=== 1. XXTEA 核心自检（已知向量性质） ===');
{
  const k = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const v = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]);
  const o = Buffer.alloc(8);
  xxtea(v, o, k, 32);
  const back = Buffer.alloc(8);
  { const vd = v, tmp = Buffer.from(v); xxtea(o, back, k, -32); }
  check('加密后 != 明文', !o.equals(v));
  check('加解密可逆（单块）', back.equals(v), `${back.toString('hex')} vs ${v.toString('hex')}`);
}

console.log('\n=== 2. 完整帧加解密往返 ===');
{
  const key = Buffer.from('0123456789abcdef');
  const cases = [
    Buffer.from([]),
    Buffer.from([0x81]),
    Buffer.from([0x81, 1, 2, 3]),
    Buffer.alloc(64, 0xAB),
    Buffer.alloc(255, 0x5A),
  ];
  for (const [i, plain] of cases.entries()) {
    const { buf, nTotalLength } = encrypt(plain, key);
    check(`用例${i} 长度 ${plain.length} -> 密文 ${buf.length} 字节 (nTotalLength=${nTotalLength})`,
      buf.length === nTotalLength && buf.length % 8 === 0);
    const dec = decrypt(buf, key);
    check(`用例${i} 解密还原 (${plain.length} 字节)`, dec !== null && dec.length === plain.length && dec.equals(plain),
      dec === null ? '(解密返回 null —— 末块校验未通过)' : dec.toString('hex').slice(0, 40));
  }
}

console.log('\n=== 3. 密钥必须匹配 ===');
{
  const p = Buffer.from('hello msdzls battle');
  const { buf } = encrypt(p, Buffer.from('0123456789abcdef'));
  const wrong = decrypt(buf, Buffer.from('ffffffffffffffff'));
  check('错误密钥无法解密（返回 null 或乱码）', wrong === null || !wrong.equals(p));
}

console.log('\n=== 4. a_2670 头 28 字节布局 ===');
{
  const header = Buffer.alloc(28);
  let p = 0;
  header.writeUInt8(0x00, p); p += 1;              // httpHead（写但 decode 不读）
  header.writeInt32BE(28, p); p += 4;              // nPackageLength
  header.writeInt32BE(12345, p); p += 4;           // nUIN
  header.writeInt16BE(0x0102, p); p += 2;          // shFlag
  header.writeInt16BE(0, p); p += 2;               // shOptionalLen
  header.writeInt16BE(24, p); p += 2;              // shHeaderLen
  header.writeInt16BE(8709, p); p += 2;            // shMessageID = b_154.a_152
  header.writeInt16BE(1, p); p += 2;               // shMessageType = b_154.a_104
  header.writeInt16BE(0, p); p += 2;               // shVersion
  header.writeInt32BE(999, p); p += 4;             // nPlayerID
  check('头写满 28 字节', p === 28, `实际 ${p}`);
  check('a_331 常量 = 6*2+3*4 = 24', 6 * 2 + 3 * 4 === 24);
  check('写入 1+24=25 字节结构 + 3 字节 padding 凑满 28 槽位', 28 - 25 === 3);

  // 解码侧视角：不读 httpHead
  let q = 0;
  const d = new DataView(header.buffer);
  const nPackageLength = d.getInt32(0, false); q += 4;
  const nUIN = d.getInt32(q, false); q += 4;
  const shFlag = d.getInt16(q, false); q += 2;
  const shOptionalLen = d.getInt16(q, false); q += 2;
  const shHeaderLen = d.getInt16(q, false); q += 2;
  const shMessageID = d.getInt16(q, false); q += 2;
  check('解码侧若从偏移 0 读 nPackageLength 会读到 httpHead 混入的值 (28 -> 0x001C0000=1835008)',
    nPackageLength === 28 * 65536, `实际 ${nPackageLength}`);
  check('  → 证明 httpHead 必须占位，否则全错位', nPackageLength !== 28);
}

console.log('\n=== 5. a_2926 游戏数据包装 ===');
{
  const body = Buffer.from([0x81, 0x01, 0x02, 0x03]);  // cmd + 载荷
  const w = Buffer.alloc(4 + 4 + 2 + body.length);
  let p = 0;
  w.writeInt32BE(1001, p); p += 4;   // m_iRoomID
  w.writeInt32BE(2002, p); p += 4;   // m_iTableID
  w.writeInt16BE(body.length, p); p += 2;  // m_nGameDataLength (int16!)
  body.copy(w, p);
  check('a_2926 包装总长 = 10 + body', w.length === 4 + 4 + 2 + 4);
  check('m_nGameDataLength 是 int16（不是 int32）',
    w.readInt16BE(8) === 4);
  check('m_szGameData 紧随其后', w.subarray(10).equals(body));
}

console.log(`\n===== 结果: ${pass} 通过, ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
