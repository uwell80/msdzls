// 临时诊断脚本：把 server.log 里每次 CARD_UPGRADE 请求、其结果、以及紧随的 CARD_NOTIFY 配对。
// 目的：判断第 2669 行 `pendingCardNotify ?? [cards[0]]` 的回退分支是否真的被触发过。
// 用法: node analyze-notify.cjs
const fs = require("node:fs");

const log = fs.readFileSync("server.log", "utf8").split(/\r?\n/);
const reqRe = /CARD_UPGRADE request: seq=(\d+) plain=(.*)$/;

const reqs = [];
for (let i = 0; i < log.length; i++) {
  const m = log[i].match(reqRe);
  if (m) reqs.push({ idx: i, line: i + 1, seq: m[1], raw: m[2] });
}

console.log(`找到 ${reqs.length} 次 CARD_UPGRADE 请求\n`);

let fallbackSuspects = 0;
for (const r of reqs) {
  const b = Buffer.from(r.raw.replace(/[^0-9a-fA-F]/g, ""), "hex");
  const srcId = b.readInt32BE(4);
  const srcSeq = b.readInt32BE(8);
  const nSub = b.readInt16BE(16);

  let upLine = null;
  let upText = null;
  let notifyLine = null;
  let notifyText = null;
  for (let j = r.idx; j < Math.min(log.length, r.idx + 40); j++) {
    if (!upText && log[j].includes("[upgrade]") && log[j].includes("成功率")) {
      upLine = j + 1;
      upText = log[j].trim();
    }
    if (!notifyText && log[j].includes("CARD_NOTIFY pushed")) {
      notifyLine = j + 1;
      notifyText = log[j].trim();
      break;
    }
  }

  // 通知里是否出现"与本次请求无关"的卡（即回退分支的指纹）
  const mentionsSrc = notifyText ? notifyText.includes(srcId.toString(16)) : false;
  const isFallback = notifyText && !mentionsSrc;

  console.log(`req line ${r.line}  src=0x${srcId.toString(16)}/${srcSeq}  nSub=${nSub}`);
  console.log(`   outcome(${upLine}): ${upText}`);
  console.log(`   notify (${notifyLine}): ${notifyText}`);
  if (isFallback) {
    fallbackSuspects++;
    console.log(`   ⚠ 通知里没有本次主卡 ⇒ 疑似走了 ?? [cards[0]] 回退`);
  }
  console.log("");
}
console.log(`疑似回退次数: ${fallbackSuspects} / ${reqs.length}`);
