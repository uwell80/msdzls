// 临时诊断脚本：解析 server.log 里所有 CARD_UPGRADE request 的 plain 字段。
// 用法: node decode-upgrade-reqs.cjs
// 注意：server.log 里的 hex 可能被截断（含 "…"），截断的会标记 INCOMPLETE。
const fs = require("node:fs");

const log = fs.readFileSync("server.log", "utf8").split(/\r?\n/);
const re = /CARD_UPGRADE request: seq=(\d+) plain=(.*)$/;

for (let i = 0; i < log.length; i++) {
  const m = log[i].match(re);
  if (!m) continue;
  const seq = m[1];
  const raw = m[2].trim();
  const truncated = raw.includes("\u2026") || raw.includes("...");
  const hex = raw.replace(/[^0-9a-fA-F]/g, "");
  const b = Buffer.from(hex, "hex");
  let p = 4;
  try {
    const i16 = () => {
      const v = b.readInt16BE(p);
      p += 2;
      return v;
    };
    const i32 = () => {
      const v = b.readInt32BE(p);
      p += 4;
      return v;
    };
    const pair = () => ({ id: i32(), seq: i32() });
    i32(); // uin
    const src = pair();
    i32(); // position
    const nsub = i16();
    const subs = Array.from({ length: nsub }, pair);
    const nass = i16();
    const ass = Array.from({ length: nass }, pair);
    const ins = i16();
    console.log(
      `line ${i + 1} seq=${seq} ${truncated ? "TRUNCATED " : ""}` +
        `src=0x${src.id.toString(16)}/${src.seq} nSub=${nsub} nAss=${nass} ins=${ins} ` +
        `leftover=${b.length - p} bytes=${b.length}`,
    );
  } catch (e) {
    console.log(`line ${i + 1} seq=${seq} ${truncated ? "TRUNCATED " : ""}PARSE FAILED: ${e.message} (bytes=${b.length}, raw="${raw.slice(0, 40)}...")`);
  }
}
