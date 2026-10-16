#!/usr/bin/env node
/**
 * 用客户端硬编码的密钥解开 config.data，验证 XTEA 移植是否正确。
 *
 * 依据 TDLoaderUI/a_4781/CZipFile.as:
 *   PACKAGE_CONFIGS_ENCRYPT = true
 *   key = Base64Decode("usWwkmoL5fNyJEnqmEk5YJZxcqLyblyxUu4Mt2Ez3aGky5kAipMALkSHcbycaUOK6j73HnvspqHtDrAs5oQwqw==")
 *   plain = b_164.a_1775(cipher, key, -8)   // 即 XTEA 解密，8 轮逆序
 *   结果应当是 ZIP（PK\x03\x04）
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { xteaDecrypt } from "./capture.mjs";

const CONFIG_KEY_BASE64 =
  "usWwkmoL5fNyJEnqmEk5YJZxcqLyblyxUu4Mt2Ez3aGky5kAipMALkSHcbycaUOK6j73HnvspqHtDrAs5oQwqw==";

const cacheDir = path.join(import.meta.dirname, "..", "client-cache");
const cipher = fs.readFileSync(path.join(cacheDir, "config.data"));
const key = Buffer.from(CONFIG_KEY_BASE64, "base64");

console.log(`config.data : ${cipher.length} bytes`);
console.log(`key         : ${key.length} bytes (XTEA 只用前 16 字节) -> ${key.subarray(0, 16).toString("hex")}`);
console.log(`cipher head : ${cipher.subarray(0, 16).toString("hex")}`);
console.log(`cipher len % 8 = ${cipher.length % 8}`);

const result = xteaDecrypt(cipher, key.subarray(0, 16), -8);
if (!result.ok) {
  console.log(`\nDECRYPT FAILED: ${result.reason}`);
  process.exit(1);
}

const plain = result.data;
const magic = plain.subarray(0, 4).toString("latin1");
console.log(`\nDECRYPT OK: ${result.length} bytes, magic=${JSON.stringify(magic)}`);

if (magic === "PK\u0003\u0004") {
  console.log("*** 是合法 ZIP —— XTEA 移植已用真实密文验证通过 ***");
  const out = path.join(import.meta.dirname, "..", "client-cache", "config-data-decrypted.zip");
  fs.writeFileSync(out, plain);
  console.log(`已写出: ${out}`);

  // 列出 zip 成员
  let off = 0;
  const entries = [];
  while ((off = plain.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), off)) !== -1) {
    const nlen = plain.readUInt16LE(off + 28);
    const elen = plain.readUInt16LE(off + 30);
    const clen = plain.readUInt16LE(off + 32);
    const usize = plain.readUInt32LE(off + 24);
    const name = plain.slice(off + 46, off + 46 + nlen).toString("utf8");
    entries.push({ name, usize });
    off += 46 + nlen + elen + clen;
  }
  console.log(`\nzip entries: ${entries.length}`);
  for (const e of entries) console.log(`  ${String(e.usize).padStart(8)}  ${e.name}`);
} else {
  console.log("解密成功但不是 ZIP —— 移植可能仍有偏差，需要继续核对。");
  console.log(`前 32 字节: ${plain.subarray(0, 32).toString("hex")}`);
}
