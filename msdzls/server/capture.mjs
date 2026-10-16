#!/usr/bin/env node
/**
 * Phase 3 探针：监听 4399 美食大战老鼠客户端的 TCP 连接，解析自研二进制协议，
 * 并用从 TDCore.swf 还原的 XTEA-CBC 解密消息体。
 *
 * 还原依据（反编译产物）：
 *   - 分帧/收包   a_4771/a_2650.as  (readInt 为包长)
 *   - 消息头      com/aurora/protocol/common/a_2670.as (24B + 可选段)
 *   - 编解码      com/aurora/protocol/a_2664.as
 *   - 加密        a_4727/b_164.as   (XTEA, DELTA=0x9E3779B9, 8 字节分组, CBC 链式)
 *   - 登录        a_4758/a_2208.as  (密钥硬编码 "Authentic@51.COM"，密码只发 MD5)
 */

import net from "node:net";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.REA_CAPTURE_PORT ?? 18443);
const LOCAL_KEY = Buffer.from("Authentic@51.COM", "utf8"); // 16 字节 = XTEA 128 位密钥

/* ------------------------------------------------------------------ *
 * XTEA 端口（b_164.b_165 / a_1775 / a_1774）
 * ------------------------------------------------------------------ */

const DELTA = 2654435769; // 0x9E3779B9
const BLOCK = 8;
const PAD_BASE = 7; // b_164.a_542

/** b_165：单个 8 字节分组的 TEA 变换（N>0 加密，N<0 解密），读/写均按小端。 */
export function teaBlock(v, vPos, o, oPos, key, N) {
  const k = [
    key.readInt32LE(0),
    key.readInt32LE(4),
    key.readInt32LE(8),
    key.readInt32LE(12),
  ];
  let y = v.readUInt32LE(vPos) >>> 0;
  let z = v.readUInt32LE(vPos + 4) >>> 0;

  if (N > 0) {
    let sum = 0;
    const limit = (DELTA * N) >>> 0;
    while (sum !== limit) {
      y = (y + ((((z << 4) ^ (z >>> 5)) + z) ^ ((sum + k[sum & 3]) >>> 0))) >>> 0;
      sum = (sum + DELTA) >>> 0;
      z = (z + ((((y << 4) ^ (y >>> 5)) + y) ^ ((sum + k[(sum >>> 11) & 3]) >>> 0))) >>> 0;
    }
  } else {
    let sum = (DELTA * -N) >>> 0;
    while (sum !== 0) {
      z = (z - ((((y << 4) ^ (y >>> 5)) + y) ^ ((sum + k[(sum >>> 11) & 3]) >>> 0))) >>> 0;
      sum = (sum - DELTA) >>> 0;
      y = (y - ((((z << 4) ^ (z >>> 5)) + z) ^ ((sum + k[sum & 3]) >>> 0))) >>> 0;
    }
  }
  o.writeUInt32LE(y >>> 0, oPos);
  o.writeUInt32LE(z >>> 0, oPos + 4);
  return oPos + 8;
}

/**
 * a_1775：解密。返回明文长度；<=0 表示失败（含"末 7 字节必须为 0"的完整性校验）。
 * 该完整性校验很强：用错密钥几乎必然返回 0，客户端据此回退到硬编码密钥。
 */
export function xteaDecrypt(input, key, N) {
  if (!input || input.length <= 0) return { ok: false, reason: "empty" };
  if (input.length <= 8 || input.length % BLOCK !== 0)
    return { ok: false, reason: `not a multiple of 8 (len=${input.length})` };

  const first8 = Buffer.alloc(BLOCK);
  teaBlock(input, 0, first8, 0, key, N);
  let inPos = BLOCK;

  const padLen = first8.readUInt8(0) & 7;
  const plainLen = input.length - 1 - padLen - PAD_BASE;
  if (plainLen <= 0) return { ok: false, reason: `bad plain length (${plainLen})` };

  const out = Buffer.alloc(plainLen + 16);
  let outPos = 0;
  first8.position = 1 + padLen;
  for (let i = 0; i < BLOCK - 1 - padLen; i += 1) out[outPos++] = first8[1 + padLen + i];

  let lastPlain = Buffer.from(first8); // pbyLast8BytesPlainData
  const src = Buffer.alloc(BLOCK);
  const tmp = Buffer.alloc(BLOCK);

  while (inPos < input.length - BLOCK) {
    for (let i = 0; i < BLOCK; i += 1) tmp[i] = input[inPos + i] ^ lastPlain[i];
    teaBlock(tmp, 0, src, 0, key, N); // src = 解密结果
    for (let i = 0; i < BLOCK; i += 1)
      src[i] = src[i] ^ input[inPos - BLOCK + i]; // 与上一段密文异或
    for (let i = 0; i < BLOCK; i += 1) out[outPos + i] = src[i];
    lastPlain = Buffer.from(src.subarray(0, BLOCK));
    inPos += BLOCK;
    outPos += BLOCK;
  }

  const last8 = Buffer.from(lastPlain);
  const finalSrc = Buffer.alloc(BLOCK);
  for (let i = 0; i < BLOCK; i += 1) finalSrc[i] = input[inPos + i] ^ lastPlain[i];
  teaBlock(finalSrc, 0, last8, 0, key, N);
  for (let i = 0; i < BLOCK; i += 1)
    last8[i] = last8[i] ^ input[inPos - BLOCK + i];

  for (let i = 1; i < BLOCK; i += 1)
    if (last8[i] !== 0) return { ok: false, reason: `integrity check failed at byte ${i}` };

  out[outPos] = last8[0];
  return { ok: true, length: plainLen, data: out.subarray(0, plainLen) };
}

/* ------------------------------------------------------------------ *
 * 消息头 / 分帧
 * ------------------------------------------------------------------ */

function parseHeader(buf, at) {
  if (buf.length < at + 24) return undefined;
  const nPackageLength = buf.readInt32BE(at);
  const nUIN = buf.readInt32BE(at + 4);
  const shFlag = buf.readInt16BE(at + 8);
  const shOptionalLen = buf.readInt16BE(at + 10);
  let p = at + 12;
  let optional = Buffer.alloc(0);
  if (shOptionalLen > 0 && p + shOptionalLen <= buf.length) {
    optional = buf.subarray(p, p + shOptionalLen);
    p += shOptionalLen;
  }
  const shHeaderLen = buf.readInt16BE(p);
  const shMessageID = buf.readInt16BE(p + 2);
  const shMessageType = buf.readInt16BE(p + 4);
  const shVersion = buf.readInt16BE(p + 6);
  const nPlayerID = buf.readInt32BE(p + 8);
  return {
    nPackageLength,
    nUIN,
    shFlag,
    shOptionalLen,
    optional,
    shHeaderLen,
    shMessageID,
    shMessageType,
    shVersion,
    nPlayerID,
    headerEnd: p + 12,
  };
}

/** 尝试两种布局：offset 0 直接是包长；offset 1 前面多一个 httpHead 字节。 */
function tryParsePackets(buf) {
  const candidates = [];
  for (const skip of [0, 1]) {
    const h = parseHeader(buf, skip);
    if (!h) continue;
    const plausible =
      h.nPackageLength > 24 &&
      h.nPackageLength <= buf.length + 8 &&
      h.shVersion >= 0 &&
      h.shVersion <= 5;
    candidates.push({ skip, header: h, plausible });
  }
  return candidates;
}

function hex(buf, max = 96) {
  const slice = buf.subarray(0, Math.min(max, buf.length));
  return slice.toString("hex").replace(/(..)/g, "$1 ").trim() + (buf.length > max ? " …" : "");
}

const MESSAGE_NAMES = {
  1: "AUTH_REQUEST (b_154.a_109)",
  6: "ACCOUNT_REGISTER (b_154.a_114)",
};

/* ------------------------------------------------------------------ *
 * 服务器
 * ------------------------------------------------------------------ */

let connectionSeq = 0;

const server = net.createServer((socket) => {
  const id = ++connectionSeq;
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  let buffer = Buffer.alloc(0);
  console.log(`\n=== [conn ${id}] connected from ${peer} ===`);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    console.log(`[conn ${id}] +${chunk.length}B  raw: ${hex(chunk)}`);

    // Flash socket 策略文件请求：必须应答，否则客户端不会继续发包
    const text = buffer.subarray(0, 64).toString("latin1");
    if (text.includes("policy-file-request")) {
      const policy =
        '<?xml version="1.0"?><cross-domain-policy>' +
        '<allow-access-from domain="*" to-ports="*"/></cross-domain-policy>\0';
      socket.write(policy);
      console.log(`[conn ${id}] -> served socket policy file`);
      buffer = Buffer.alloc(0);
      return;
    }

    for (const { skip, header, plausible } of tryParsePackets(buffer)) {
      console.log(
        `[conn ${id}] parse@${skip}${plausible ? "" : " (implausible)"}: ` +
          `len=${header.nPackageLength} uin=${header.nUIN} flag=${header.shFlag} ` +
          `msgID=${header.shMessageID}${MESSAGE_NAMES[header.shMessageID] ? " = " + MESSAGE_NAMES[header.shMessageID] : ""} ` +
          `type=${header.shMessageType} ver=${header.shVersion} playerID=${header.nPlayerID} ` +
          `optionalLen=${header.shOptionalLen}`,
      );
      const body = buffer.subarray(header.headerEnd);
      if (body.length === 0) {
        console.log(`[conn ${id}] (no body bytes yet)`);
        continue;
      }
      console.log(`[conn ${id}] body ${body.length}B: ${hex(body)}`);
      for (const rounds of [-32, -8]) {
        const r = xteaDecrypt(body, LOCAL_KEY, rounds);
        if (r.ok) {
          console.log(
            `[conn ${id}] *** DECRYPTED with "Authentic@51.COM" (rounds=${rounds}), ` +
              `${r.length}B: ${hex(r.data, 160)}`,
          );
          const seq = r.data.readInt32BE(0);
          console.log(`[conn ${id}]     sequence=${seq}  text=${JSON.stringify(r.data.subarray(4, 80).toString("latin1"))}`);
        } else {
          console.log(`[conn ${id}] decrypt rounds=${rounds} failed: ${r.reason}`);
        }
      }
    }
  });

  socket.on("close", () => console.log(`=== [conn ${id}] closed ===`));
  socket.on("error", (e) => console.log(`=== [conn ${id}] error: ${e.message} ===`));
});

/* 自检：加解密互逆 + 完整性校验确实会拒绝错误密钥 */
function selfTest() {
  const key = Buffer.from("0123456789abcdef", "utf8");
  const wrong = Buffer.from("fedcba9876543210", "utf8");
  // 直接构造一个"密文"，只验证解密路径的健壮性（真正校验要等真实报文）
  const junk = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const a = xteaDecrypt(junk, key, -32);
  const b = xteaDecrypt(junk, wrong, -32);
  console.log(
    `self-test: random ciphertext -> ${a.ok ? "ACCEPTED" : "rejected (" + a.reason + ")"}; ` +
      `wrong key -> ${b.ok ? "ACCEPTED" : "rejected (" + b.reason + ")"}`,
  );
}

// 作为库被 import 时不要起服务（probe 脚本会复用 xteaDecrypt）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  selfTest();
  server.listen(PORT, () => {
    console.log(`\ncapture listener on 0.0.0.0:${PORT}`);
    console.log(`local key = ${JSON.stringify(LOCAL_KEY.toString("utf8"))}`);
    console.log(`waiting for the game client to connect…\n`);
  });
}
