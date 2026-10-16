/**
 * 把客户端 `TDErrorCatch.UploadError()` 的上报地址改到本地服务器。
 *
 * 背景（`decompiled/TDCore/scripts/com/aurora/ui/maogoutd/base/TDErrorCatch.as:35-45`）：
 *   客户端有自己的全局异常兜底 —— `TDCore.onUncaughtError` → `TDErrorCatch.onUncaughtError`
 *   → `UploadError()` **把 err.name / message / getStackTrace() POST 到
 *   `http://10.80.0.2:8080/log`**（开发机内网地址，我们这边永远连不上，异常就这么被扔掉了）。
 *
 * 另外 `TDCore.as:102-106` 只在 `parameters.sitetype == "joyyou"` 时才注册这个监听，
 * 所以启动页的 flashvars 也必须用 `sitetype=joyyou`（登录分支和 4399 走同一条，
 * 见 `TDCore.as:156-161`，把 sig_user 当账号，不影响本地登录）。
 *
 * 两个地址长度**恰好相同**（都是 24 字节），所以可以在 SWF 的 ABC 常量池里做**等长字节替换**：
 * 不动长度前缀、不动索引，压缩后仍是一个合法 SWF。
 *
 * 用法：node server/patch-upload-error.cjs [--revert]
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SWF = path.join(__dirname, "..", "client-cache", "TDCore.swf");
const BAK = path.join(__dirname, "..", "client-cache", "TDCore.swf.bak-prelogpatch");
const OLD = Buffer.from("http://10.80.0.2:8080/log", "ascii");
const NEW = Buffer.from("http://127.0.0.1:8080/log", "ascii");

function readSwf(file) {
  const data = fs.readFileSync(file);
  if (data.subarray(0, 3).toString("latin1") !== "CWS") {
    throw new Error(`${file} 不是 CWS（zlib 压缩）SWF`);
  }
  return { head: data.subarray(0, 8), body: zlib.inflateSync(data.subarray(8)) };
}

function writeSwf(file, head, body) {
  const packed = zlib.deflateSync(body, { level: 9 });
  const out = Buffer.alloc(8 + packed.length);
  head.copy(out, 0);
  packed.copy(out, 8);
  // ⚠ CWS 头里的 FileLength 是**未压缩**总长度（= 8 + 未压缩 body），
  //   不是压缩后的文件大小 —— 实测原文件 18696780 vs 磁盘 5434854 可证。
  out.writeUInt32LE(8 + body.length, 4);
  fs.writeFileSync(file, out);
  return out.length;
}

function main() {
  if (process.argv.includes("--revert")) {
    if (!fs.existsSync(BAK)) throw new Error(`没有备份可回滚：${BAK}`);
    fs.copyFileSync(BAK, SWF);
    console.log(`已回滚 ${SWF}`);
    return;
  }
  if (!fs.existsSync(BAK)) {
    fs.copyFileSync(SWF, BAK);
    console.log(`已备份原文件 → ${path.basename(BAK)}`);
  }
  const { head, body } = readSwf(SWF);
  const before = body.filter === undefined ? 0 : 0;
  let count = 0;
  let idx = -1;
  const needle = OLD;
  while ((idx = body.indexOf(needle, idx + 1)) !== -1) count += 1;
  if (count === 0) {
    const already = body.indexOf(NEW) !== -1;
    console.log(already ? "已经是本地地址，无需打补丁" : "✗ 没找到 10.80.0.2 上报地址");
    if (!already) process.exit(1);
    return;
  }
  const patched = Buffer.from(body);
  let pos = -1;
  let n = 0;
  while ((pos = patched.indexOf(needle, pos + 1)) !== -1) {
    NEW.copy(patched, pos);
    n += 1;
  }
  const size = writeSwf(SWF, head, patched);
  console.log(`已替换 ${n} 处（等长 ${OLD.length} 字节）→ ${SWF} 新大小 ${size}`);
}

main();
