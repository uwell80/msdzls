// §18 L1 传输层：a_2670 头 + b_164 XXTEA-CBC + a_2926 包装
//
// 块链关系（从 a_1775 解码器反推并自我验证，见 derive-chain.mjs）：
//   cipher[1] = XXTEA_enc(firstBlock)
//   cipher[k] = XXTEA_enc(plain[k] ^ cipher[k-1]) ^ plain[k-1]     (k >= 2)
//   plain[k]  = XXTEA_dec(cipher[k] ^ plain[k-1]) ^ cipher[k-1]
//
// 即每块同时依赖「上一块明文」与「上一块密文」。第一块无前驱，直接 XXTEA_enc。

const DELTA = 2654435769 >>> 0;
const KEY_ROUND = 32;

// b_165: XXTEA 核心。v/o 各 8 字节；k 为密钥字节数组
function b_165(v8, o8, key, N) {
  const kd = new DataView(key.buffer, key.byteOffset, key.byteLength);
  const kAt = (pos) => {
    let i = pos % key.byteLength;
    if (i + 4 > key.byteLength) i = 0;        // 密钥不足 4 字节时回绕
    return kd.getInt32(i, true);
  };
  let y = v8.readUInt32LE(0);
  let z = v8.readUInt32LE(4);
  let sum = 0;
  if (N > 0) {
    const limit = (DELTA * N) >>> 0;
    while (sum !== limit) {
      y = (y + ((((z << 4) ^ (z >>> 5)) + z) ^ ((sum + kAt((sum & 3) * 4)) >>> 0))) >>> 0;
      sum = (sum + DELTA) >>> 0;
      z = (z + ((((y << 4) ^ (y >>> 5)) + y) ^ ((sum + kAt(((sum >>> 11) & 3) * 4)) >>> 0))) >>> 0;
    }
  } else {
    sum = (DELTA * -N) >>> 0;
    while (sum !== 0) {
      z = (z - ((((y << 4) ^ (y >>> 5)) + y) ^ ((sum + kAt(((sum >>> 11) & 3) * 4)) >>> 0))) >>> 0;
      sum = (sum - DELTA) >>> 0;
      y = (y - ((((z << 4) ^ (z >>> 5)) + z) ^ ((sum + kAt((sum & 3) * 4)) >>> 0))) >>> 0;
    }
  }
  o8.writeUInt32LE(y, 0);
  o8.writeUInt32LE(z, 4);
}

const xor8 = (a, b) => { const o = Buffer.alloc(8); for (let i = 0; i < 8; i++) o[i] = a[i] ^ b[i]; return o; };

// a_1774: 加密。返回密文 Buffer（长度 = nTotalLength）。
// opt.padLen 强制填充长度；opt.headByte 强制首字节随机部分（默认 0，便于确定性测试）
export function encryptFrame(plain, key, opt = {}) {
  const nPadDataZero = 1 + plain.length + 7;
  let nPadLength = nPadDataZero % 8;
  if (nPadLength !== 0) nPadLength = 8 - nPadLength;
  if (opt.padLen !== undefined) nPadLength = opt.padLen;
  // AS3 的 nTotalLength 只是 writeByte 的自增长结果，等价于「首块 + 中间块 + 末块」的总块数。
  // 直接按实际块数计算，保证 out.length === nTotalLength。
  //   首块承载 headCopy 个明文字节；其后每 8 字节一块；末块承载剩余 1 字节。
  const headCopyLen = Math.max(0, 8 - (1 + nPadLength));
  const rest = Math.max(0, plain.length - headCopyLen);
  const middleBlocks = plain.length - headCopyLen > 1 ? Math.ceil((rest - 1) / 8) : 0;
  const nTotalLength = 8 * (1 + middleBlocks + 1);

  // 第一块 8 字节： [ (rand & 0xF8) | padLen ][ padLen 个随机字节 ][ 明文头部 ]
  const first = Buffer.alloc(8);
  first[0] = ((opt.rand7 ?? 0) & 0xF8) | nPadLength;
  for (let i = 1; i <= nPadLength && i < 8; i++) first[i] = (opt.padBytes?.[i - 1]) ?? 0;
  const headCopy = 8 - (1 + nPadLength);
  for (let i = 0; i < headCopy && i < plain.length; i++) first[1 + nPadLength + i] = plain[i];

  const blocks = [];
  const c1 = Buffer.alloc(8);
  b_165(first, c1, key, KEY_ROUND);
  blocks.push(c1);

  let prevPlain = Buffer.from(first);
  let prevCipher = Buffer.from(c1);
  let inCursor = headCopy;
  let lastPlainBlock = Buffer.from(first);

  // 中间块：条件同 AS3 b_164.as:120「bytesAvailable > 1」，position == pbyInCursor
  while (plain.length - inCursor > 1) {
    const blkLen = Math.min(8, plain.length - inCursor);
    const plainBlk = Buffer.alloc(8);
    plain.copy(plainBlk, 0, inCursor, inCursor + blkLen);
    const t = xor8(plainBlk, prevCipher);
    const e = Buffer.alloc(8);
    b_165(t, e, key, KEY_ROUND);
    const c = xor8(e, prevPlain);
    blocks.push(c);
    prevPlain = plainBlk;
    prevCipher = c;
    lastPlainBlock = plainBlk;
    inCursor += 8;
  }

  // 末块（b_164.as:146-168）：只取 1 个明文字节，其余补 0
  const lastByte = inCursor < plain.length ? plain[inCursor] : 0;
  const tailPlain = Buffer.alloc(8);
  tailPlain[0] = lastByte;
  {
    const t = xor8(tailPlain, prevCipher);
    const e = Buffer.alloc(8);
    b_165(t, e, key, KEY_ROUND);
    const c = xor8(e, prevPlain);
    blocks.push(c);
  }

  const out = Buffer.concat(blocks);
  return { out, nTotalLength, outCursor: out.length, padLen: nPadLength };
}

// a_1775: 解密。成功返回明文，失败返回 null。
export function decryptFrame(cipher, key) {
  if (cipher.length <= 8 || cipher.length % 8 !== 0) return null;

  const first = Buffer.alloc(8);
  b_165(cipher.subarray(0, 8), first, key, -KEY_ROUND);

  const nPadLength = first[0] & 7;
  const nPlainDataLength = cipher.length - 1 - nPadLength - 7;
  if (nPlainDataLength <= 0) return null;

  const out = Buffer.alloc(nPlainDataLength);
  let oPos = 0;
  for (let i = 0; i < 8 - 1 - nPadLength && oPos < nPlainDataLength; i++) {
    out[oPos++] = first[1 + nPadLength + i];
  }
  let prevPlain = Buffer.from(first);
  let prevCipher = Buffer.from(cipher.subarray(0, 8));
  let inCursor = 8;

  while (inCursor < cipher.length - 8) {
    const c = cipher.subarray(inCursor, inCursor + 8);
    const src = xor8(c, prevPlain);
    const t = Buffer.alloc(8);
    b_165(src, t, key, -KEY_ROUND);
    const p = xor8(t, prevCipher);
    for (let i = 0; i < 8 && oPos < nPlainDataLength; i++) out[oPos++] = p[i];
    prevPlain = p;
    prevCipher = Buffer.from(c);
    inCursor += 8;
  }

  // 末块
  {
    const c = Buffer.alloc(8);
    cipher.copy(c, 0, inCursor, Math.min(inCursor + 8, cipher.length));
    const src = xor8(c, prevPlain);
    const t = Buffer.alloc(8);
    b_165(src, t, key, -KEY_ROUND);
    const p = xor8(t, prevCipher);
    if (oPos < nPlainDataLength) out[oPos++] = p[0];
  }

  return out;
}

// ---- a_2670 头 ----
export const HEADER_BODY = 6 * 2 + 3 * 4;   // a_331 = 24
export const HTTP_HEAD_LEN = 1;             // a_2670.encode 写、decode 不读（**只用于客户端上行**）

/**
 * ⚠ 方向不对称（2026-10-14 实证，纠正此前实现）：
 *   - **客户端 → 服务端**：`a_2670.encode`（a_2670.as:43-57）先写 1 字节 httpHead，再写 24 字节头
 *     ⇒ 共 25 字节，`nPackageLength = a_331(24) + 体`（不含 httpHead）。
 *     实测原始字节：auth 请求 = 57B = 1 + 24 + 32，包长字段 = 56 = 24 + 32（local-server.mjs:3161 注释同）。
 *   - **服务端 → 客户端**：客户端收到数据后是 `a_1779.as:84 packageBytes.position = 0;` 然后
 *     `a_2220.a_2204` → `a_2670.decode`（a_2670.as:59-73）**从 nPackageLength 开始读，不读 httpHead**
 *     ⇒ 服务端必须只写 **24 字节头**，`nPackageLength = 24 + 密文`。
 *     与本仓库 `buildPacket`（local-server.mjs:2328-2341，24 字节头，pkgLen 在偏移 0）一致，
 *     该路径已实测可让客户端完成 认证→大厅→逻辑 全流程。
 *
 * ⇒ `httpHead` 默认为 **false**（服务端→客户端口径）。要复刻客户端上行时显式传 `httpHead: true`。
 */
export function encodeHeader({
  pkgLen, uin, flag, optLen, messageID, messageType, version, playerID,
  httpHead = false,
}) {
  const b = Buffer.alloc((httpHead ? HTTP_HEAD_LEN : 0) + HEADER_BODY);
  let p = 0;
  if (httpHead) { b.writeUInt8(0x00, p); p += 1; }   // 仅客户端上行才有的 httpHead
  b.writeInt32BE(pkgLen, p); p += 4;
  b.writeInt32BE(uin, p); p += 4;
  b.writeInt16BE(flag, p); p += 2;
  b.writeInt16BE(optLen, p); p += 2;
  b.writeInt16BE(HEADER_BODY, p); p += 2;      // shHeaderLen
  b.writeInt16BE(messageID, p); p += 2;
  b.writeInt16BE(messageType, p); p += 2;
  b.writeInt16BE(version, p); p += 2;
  b.writeInt32BE(playerID, p); p += 4;
  return { buf: b, written: p };
}

// ---- a_2201 第3层：完整 L2 传输帧组装 ----
// **服务端 → 客户端**结构：[a_2670 头 24B][XXTEA 加密区]（**不写 httpHead**，见 encodeHeader 注释）
// 加密区明文：[int32 seq][a_2926(roomID, tableID, [b_102 命令号][协议体])]
export function encodeGameFrame({
  seq, roomID = -1, tableID = -1, cmd, body = Buffer.alloc(0),
  uin, flag, version, playerID, key,
  lenIncludesHttpHead = false, httpHead = false, optLen = 0,
}) {
  const wrapped = wrapGameData(roomID, tableID, Buffer.concat([Buffer.from([cmd]), body]));
  const plain = Buffer.alloc(4 + wrapped.length);
  plain.writeInt32BE(seq, 0);
  wrapped.copy(plain, 4);

  const { out: cipher, nTotalLength } = encryptFrame(plain, key);
  // ⚠ pkgLen **始终不含** httpHead（a_2670.encode: `nPackageLength = a_331 + 体`），
  //   httpHead 只决定"要不要多写那 1 个字节"。
  //   lenIncludesHttpHead 保留为兼容开关，用于复刻那些把 httpHead 计入长度的实现；默认 false。
  const pkgLen = (lenIncludesHttpHead ? HTTP_HEAD_LEN : 0) + HEADER_BODY + cipher.length;
  const { buf: header } = encodeHeader({
    pkgLen, uin, flag, optLen, messageID: 8709, messageType: 1, version, playerID, httpHead,
  });
  return Buffer.concat([header, cipher]);
}

// ---- a_2926 游戏数据包装 ----
export function wrapGameData(roomID, tableID, body) {
  const b = Buffer.alloc(10 + body.length);
  b.writeInt32BE(roomID, 0);
  b.writeInt32BE(tableID, 4);
  b.writeInt16BE(body.length, 8);              // int16，不是 int32
  body.copy(b, 10);
  return b;
}
