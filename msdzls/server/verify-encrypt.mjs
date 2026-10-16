#!/usr/bin/env node
/**
 * 验证 XTEA 加密实现：把真实密文（config.data）解成完整填充块，再用自己实现的
 * 加密还原，逐字节比对。通过即说明加密与客户端完全一致。
 */

import fs from "node:fs";
import { teaBlock } from "./capture.mjs";

const DELTA = 2654435769;
const BLOCK = 8;

/** a_1775 的等价实现，但返回"完整填充明文"（含填充头与末块零填充）。 */
function decryptBlocks(cipher, key, N) {
  const out = Buffer.alloc(cipher.length);
  let inPos = 0;
  let outPos = 0;
  const first8 = Buffer.alloc(BLOCK);
  teaBlock(cipher, 0, first8, 0, key, N);
  first8.copy(out, 0);
  inPos = BLOCK;
  outPos = BLOCK;
  let lastPlain = Buffer.from(first8);
  const src = Buffer.alloc(BLOCK);
  while (inPos < cipher.length - BLOCK) {
    for (let i = 0; i < BLOCK; i += 1) src[i] = cipher[inPos + i] ^ lastPlain[i];
    teaBlock(src, 0, out, outPos, key, N);
    for (let i = 0; i < BLOCK; i += 1)
      out[outPos + i] = out[outPos + i] ^ cipher[inPos - BLOCK + i];
    lastPlain = Buffer.from(out.subarray(outPos, outPos + BLOCK));
    inPos += BLOCK;
    outPos += BLOCK;
  }
  const final = Buffer.alloc(BLOCK);
  for (let i = 0; i < BLOCK; i += 1) src[i] = cipher[inPos + i] ^ lastPlain[i];
  teaBlock(src, 0, final, 0, key, N);
  for (let i = 0; i < BLOCK; i += 1) final[i] = final[i] ^ cipher[inPos - BLOCK + i];
  final.copy(out, outPos);
  return out;
}

/** a_1774 的等价实现：由完整填充明文产生密文。 */
function encryptBlocks(plain, key, N) {
  const out = Buffer.alloc(plain.length);
  const blocks = plain.length / BLOCK;
  // C0 = E(B0)
  teaBlock(plain, 0, out, 0, key, N);
  for (let b = 1; b < blocks; b += 1) {
    const src = Buffer.alloc(BLOCK);
    for (let i = 0; i < BLOCK; i += 1) {
      // 与上一段"明文"块异或，再用"上一段密文"掩盖
      src[i] = plain[b * BLOCK + i] ^ out[(b - 1) * BLOCK + i];
    }
    teaBlock(src, 0, out, b * BLOCK, key, N);
    for (let i = 0; i < BLOCK; i += 1) {
      out[b * BLOCK + i] = out[b * BLOCK + i] ^ plain[(b - 1) * BLOCK + i];
    }
  }
  return out;
}

const KEY = Buffer.from(
  Buffer.from(
    "usWwkmoL5fNyJEnqmEk5YJZxcqLyblyxUu4Mt2Ez3aGky5kAipMALkSHcbycaUOK6j73HnvspqHtDrAs5oQwqw==",
    "base64",
  ).subarray(0, 16),
);

const dir = "C:/Users/XH/Documents/ChatGPT/逆向/msdzls/client-cache/";
const cipher = fs.readFileSync(dir + "config.data");
console.log(`cipher ${cipher.length} bytes, key=${KEY.toString("hex")}`);

const padded = decryptBlocks(cipher, KEY, -8);
console.log(`padded plaintext ${padded.length} bytes`);

// config.data 这个包由 8 轮加密（客户端里写死 uint(-8) 解），
// 而协议报文用 32 轮 —— 两者是各自独立的一对。
const reencrypted = encryptBlocks(padded, KEY, 8);
console.log(`re-encrypted ${reencrypted.length} bytes`);

const same = reencrypted.length === cipher.length && reencrypted.equals(cipher);
console.log(same ? "*** 加密实现与客户端逐字节一致 ***" : "!!! 不一致 !!!");
if (!same) {
  for (let i = 0; i < Math.min(reencrypted.length, cipher.length); i += 1) {
    if (reencrypted[i] !== cipher[i]) {
      console.log(`first diff at byte ${i}: mine=${reencrypted[i]} real=${cipher[i]}`);
      break;
    }
  }
}
