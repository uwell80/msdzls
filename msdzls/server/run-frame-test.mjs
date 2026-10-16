import { encryptFrame, decryptFrame, encodeHeader, wrapGameData, encodeGameFrame, HEADER_BODY } from './frame-codec.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name} ${extra}`); fail++; }
};

const KEY = Buffer.from('0123456789abcdef');
const SESSION_KEY = Buffer.from('myserver-session');

console.log('=== 1. XXTEA-CBC 加解密往返 ===');
const cases = [
  ['1 字节', Buffer.from([0x81])],
  ['4 字节', Buffer.from([0x81, 1, 2, 3])],
  ['8 字节', Buffer.alloc(8, 0x77)],
  ['10 字节(仅头)', Buffer.alloc(10, 0x11)],
  ['17 字节(跨块)', Buffer.alloc(17, 0x22)],
  ['64 字节', Buffer.alloc(64, 0xAB)],
  ['255 字节', Buffer.alloc(255, 0x5A)],
  ['1000 字节', Buffer.alloc(1000, 0x33)],
];
for (const [name, plain] of cases) {
  const { out, nTotalLength, outCursor } = encryptFrame(plain, KEY);
  check(`${name}: 输出长度 == nTotalLength == 8 的倍数 (${out.length})`,
    out.length === nTotalLength && nTotalLength % 8 === 0 && outCursor === nTotalLength,
    `len=${out.length} nTotal=${nTotalLength} cursor=${outCursor}`);
  const dec = decryptFrame(out, KEY);
  check(`${name}: 解密还原`, dec !== null && dec.equals(plain),
    dec === null ? '(末块校验失败/返回 null)' : `得到 ${dec.length} 字节 ${dec.toString('hex').slice(0, 32)}`);
}

console.log('\n=== 1b. 边界：空明文的长度语义 ===');
{
  // nPadDataZero = 1 + 0 + 7 = 8；8 % 8 == 0 → AS3 的 if 不触发 → nPadLength 保持 0
  // 但首块与末块仍各写一块 → 实际输出 2 块 = 16 字节
  const { out, nTotalLength, padLen } = encryptFrame(Buffer.alloc(0), KEY);
  check('空明文 padLen = 0（8%8==0 使 if 不触发）', padLen === 0, `实际 ${padLen}`);
  check('空明文实际密文 16 字节（首块 + 末块）', out.length === 16, `实际 ${out.length}`);
  check('nTotalLength 与实际输出一致', nTotalLength === out.length, `${nTotalLength} vs ${out.length}`);
  // 解码侧 nPlainDataLength = 16 - 1 - 0 - 7 = 8 > 0，故能解出 8 字节
  const dec = decryptFrame(out, KEY);
  check('空明文可解出 8 字节（非零长度）', dec !== null && dec.length === 8,
    dec === null ? '(null)' : `${dec.length} 字节`);
  console.log('  ℹ 结论：零长明文会解出 8 个零字节，语义上不等于"空"——服务端不应发送零载荷帧');
}

console.log('\n=== 2. 错误密钥必须失败 ===');
{
  const plain = Buffer.from('battle loadstart payload');
  const { out } = encryptFrame(plain, KEY);
  const wrong = decryptFrame(out, Buffer.from('ffffffffffffffff'));
  check('错误密钥 → 返回 null 或不等', wrong === null || !wrong.equals(plain));
}

console.log('\n=== 3. a_2670 头布局：客户端上行 25B vs 服务端下行 24B（方向不对称）===');
{
  // 服务端→客户端口径（默认）：24 字节头，nPackageLength 在偏移 0
  const s = encodeHeader({ pkgLen: 100, uin: 12345, flag: 0x0102, optLen: 0,
    messageID: 8709, messageType: 1, version: 7, playerID: 999 });
  check('服务端下行头写入 24 字节 = a_331（不写 httpHead）', s.written === 24, `实际 ${s.written}`);
  check('a_331 = 6*2+3*4 = 24', HEADER_BODY === 24);
  check('下行 nPackageLength 在偏移 0', s.buf.readInt32BE(0) === 100, `实际 ${s.buf.readInt32BE(0)}`);
  check('下行 shMessageID 在偏移 14', s.buf.readInt16BE(14) === 8709, `实际 ${s.buf.readInt16BE(14)}`);
  check('下行 nPlayerID 在偏移 20', s.buf.readInt32BE(20) === 999, `实际 ${s.buf.readInt32BE(20)}`);
  check('下行 shHeaderLen(=24) 在偏移 12', s.buf.readInt16BE(12) === 24, `实际 ${s.buf.readInt16BE(12)}`);

  // 客户端→服务端口径（显式 httpHead: true）：25 字节头，包长字段被顶到偏移 1
  const c = encodeHeader({ pkgLen: 100, uin: 12345, flag: 0x0102, optLen: 0,
    messageID: 8709, messageType: 1, version: 7, playerID: 999, httpHead: true });
  check('客户端上行头写入 25 字节 = 1(httpHead) + 24(a_331)', c.written === 25, `实际 ${c.written}`);
  check('上行 httpHead=0x00 在偏移 0，nPackageLength 在偏移 1',
    c.buf[0] === 0x00 && c.buf.readInt32BE(1) === 100, `实际 ${c.buf.readInt32BE(1)}`);
  check('上行 shMessageID 在偏移 1+14 = 15', c.buf.readInt16BE(15) === 8709, `实际 ${c.buf.readInt16BE(15)}`);

  console.log('  ⚠ 结论：httpHead 只存在于**客户端上行**（a_2670.encode 写）；');
  console.log('     服务端下行必须 24 字节 —— 客户端 a_1779.as:84 `position = 0` 后直接 a_2670.decode，');
  console.log('     多写 1 字节会让 nPackageLength 被读成 0x00 开头的错位值，整帧报废。');
}

console.log('\n=== 4. a_2926 游戏数据包装 ===');
{
  const body = Buffer.from([0x81, 0xDE, 0xAD, 0xBE, 0xEF]);   // cmd=129 + 载荷
  const w = wrapGameData(1001, 2002, body);
  check('总长 = 4+4+2+body', w.length === 10 + body.length, `实际 ${w.length}`);
  check('m_iRoomID', w.readInt32BE(0) === 1001);
  check('m_iTableID', w.readInt32BE(4) === 2002);
  check('m_nGameDataLength 为 int16', w.readInt16BE(8) === body.length);
  check('m_szGameData 紧随其后', w.subarray(10).equals(body));
}

console.log('\n=== 5. 端到端：完整 L2 帧组装 + 解回 ===');
{
  const SESSION_KEY = Buffer.from('myserver-session');
  const SEQ = 0;
  const l2body = Buffer.from([0x81, 0x00, 0x0A, 0x00, 0x00, 0x00, 0x01]);  // cmd=129 + 假载荷
  const wrapped = wrapGameData(-1, -1, l2body);                            // 对电脑模式 roomID=tableID=-1
  const plain = Buffer.alloc(4 + wrapped.length);
  plain.writeInt32BE(SEQ, 0);
  wrapped.copy(plain, 4);

  const { out: cipher, nTotalLength } = encryptFrame(plain, SESSION_KEY);
  const pkgLen = HEADER_BODY + cipher.length;   // 服务端下行：24 + 密文
  const { buf: header } = encodeHeader({
    pkgLen, uin: 12345, flag: 0x0001, optLen: 0,
    messageID: 8709, messageType: 1, version: 0, playerID: 1,
  });
  const frame = Buffer.concat([header, cipher]);

  check('帧总长 = 24 + 密文长度（下行不写 httpHead）', frame.length === 24 + cipher.length, `实际 ${frame.length}`);
  check('nPackageLength 字段 = 24+密文（偏移 0）', frame.readInt32BE(0) === pkgLen, `实际 ${frame.readInt32BE(0)}`);
  check('shMessageID = 8709 (b_154.a_152) 在偏移 14', frame.readInt16BE(14) === 8709);

  // 服务端解的路径
  const rxPlain = decryptFrame(frame.subarray(24), SESSION_KEY);
  check('解出明文', rxPlain !== null && rxPlain.length === plain.length,
    rxPlain === null ? '(null)' : `${rxPlain.length} vs ${plain.length}`);
  if (rxPlain) {
    check('序号 == 0', rxPlain.readInt32BE(0) === 0, `实际 ${rxPlain.readInt32BE(0)}`);
    const rxWrapped = rxPlain.subarray(4);
    check('roomID == -1', rxWrapped.readInt32BE(0) === -1);
    check('tableID == -1', rxWrapped.readInt32BE(4) === -1);
    const gdLen = rxWrapped.readInt16BE(8);
    check('m_nGameDataLength == 7', gdLen === 7, `实际 ${gdLen}`);
    const gd = rxWrapped.subarray(10, 10 + gdLen);
    check('L2 命令号 == 129 (LoadStart)', gd[0] === 129, `实际 ${gd[0]}`);
    check('L2 载荷完整', gd.equals(l2body));
  }
}

console.log('\n=== 6. encodeGameFrame 一步到位（下行 24B 头 + 可选上行 25B）===');
{
  const l2body = Buffer.from([1, 2, 3, 0, 0x64, 0, 0, 0x0F]);
  const args = {
    seq: 7, roomID: -1, tableID: -1, cmd: 129, body: l2body,
    uin: 12345, flag: 0x0001, version: 0, playerID: 1, key: SESSION_KEY,
  };
  const fA = encodeGameFrame({ ...args });                        // 服务端下行（默认）
  const fB = encodeGameFrame({ ...args, httpHead: true });        // 复刻客户端上行口径

  check('下行帧总长 = 24 + 密文', fA.length === 24 + fA.subarray(24).length, `实际 ${fA.length}`);
  check('下行密文区从偏移 24 开始且长度 %8 == 0', fA.subarray(24).length % 8 === 0);
  check('下行 pkgLen = 24 + 密文', fA.readInt32BE(0) === 24 + fA.subarray(24).length,
    `${fA.readInt32BE(0)}`);
  check('上行帧总长比下行多 1（httpHead）', fB.length === fA.length + 1, `${fB.length} vs ${fA.length}`);
  check('上行/下行密文逐字节一致（仅头布局不同）', fA.subarray(24).equals(fB.subarray(25)));
  check('上行 pkgLen 与下行相同（a_2670.encode 的包长不含 httpHead）',
    fB.readInt32BE(1) === fA.readInt32BE(0), `${fB.readInt32BE(1)} vs ${fA.readInt32BE(0)}`);
  check('下行 httpHead 缺失：偏移 0 就是 pkgLen 高字节，不可能出现"多 1 字节"',
    fA.length - fA.subarray(24).length === 24);

  const p = decryptFrame(fA.subarray(24), SESSION_KEY);
  check('encodeGameFrame 端到端可解', p !== null && p.readInt32BE(0) === 7);
  check('命令号 == 129', p[14] === 129, `${p[14]}`);
  check('载荷完整', p.subarray(15, 15 + l2body.length).equals(l2body));
}

console.log(`\n===== 结果: ${pass} 通过, ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
