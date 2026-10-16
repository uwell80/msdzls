// 从 a_1775 反推 a_1774 的精确链式关系。
// 解码(第 k>=2 块, k 从 1 计):
//   src  = cipher[k] ^ plain[k-1]
//   t    = XXTEA_dec(src)
//   plain[k] = t ^ cipher[k-1]
// 因此:  XXTEA_dec(src) = plain[k] ^ cipher[k-1]  =>  src = XXTEA_enc(plain[k] ^ cipher[k-1])
//        且 src = cipher[k] ^ plain[k-1]
//   =>   cipher[k] = XXTEA_enc(plain[k] ^ cipher[k-1]) ^ plain[k-1]
//
// 第一块(解码 a_1775:194): first = XXTEA_dec(cipher[1])  -> cipher[1] = XXTEA_enc(first)
// 注意第一块解码后就直接当明文用, 没有额外异或。
import { createRequire } from "module";
const DELTA = 2654435769 >>> 0;
function xxtea(v8, o8, k, N) {
  const kd = new DataView(k.buffer, k.byteOffset, k.byteLength);
  const kAt = (pos) => { let i = pos % k.byteLength; if (i + 4 > k.byteLength) i = k.byteLength - 4; return kd.getInt32(i, true); };
  let y = v8.readUInt32LE(0), z = v8.readUInt32LE(4), sum = 0;
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
  o8.writeUInt32LE(y, 0); o8.writeUInt32LE(z, 4);
}
const KEY = Buffer.from("0123456789abcdef");
// 验证推导出的加密式能否被标准解码式还原
function encBlock(plainBlk, prevPlain, prevCipher) {
  const t = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) t[i] = plainBlk[i] ^ prevCipher[i];
  const e = Buffer.alloc(8); xxtea(t, e, KEY, 32);
  const c = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) c[i] = e[i] ^ prevPlain[i];
  return c;
}
function decBlock(cipherBlk, prevPlain, prevCipher) {
  const src = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) src[i] = cipherBlk[i] ^ prevPlain[i];
  const t = Buffer.alloc(8); xxtea(src, t, KEY, -32);
  const p = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) p[i] = t[i] ^ prevCipher[i];
  return p;
}
let ok = true;
let prevP = Buffer.from("AAAABBBB"), prevC = Buffer.from("CCCCDDDD");
for (let n = 0; n < 5; n++) {
  const plain = Buffer.alloc(8); for (let i = 0; i < 8; i++) plain[i] = (n * 17 + i) & 0xFF;
  const c = encBlock(plain, prevP, prevC);
  const p2 = decBlock(c, prevP, prevC);
  const same = p2.equals(plain);
  console.log(`块${n}: 加密->解密 ${same ? "OK" : "FAIL"}  ${p2.toString("hex")} vs ${plain.toString("hex")}`);
  if (!same) ok = false;
  prevP = plain; prevC = c;
}
console.log(ok ? "\n推导式自洽 ✓" : "\n推导式不自洽 ✗");
