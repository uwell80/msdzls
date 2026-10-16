// run-spec-test.mjs — 往返测试：按文档编码 → 按文档解码 → 逐字段比对
// 运行：node server/run-spec-test.mjs
import {
  encodeSitDownResponse, encodeAvatarInfo, encodeLoadStart,
  encodeGameStart, encodeStepSync,
} from './encode-test.mjs';
import {
  decodeSitDownResponse, decodeLoadStart, decodeGameStart, decodeStepSync,
} from './decode-test.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name} ${extra}`); fail++; }
}
function eq(name, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  check(name, ok, ok ? '' : `\n      期望 ${JSON.stringify(b)}\n      实际 ${JSON.stringify(a)}`);
}

console.log('=== 1. SitDown 应答 (a_2953) 往返 ===');
const players = [
  { m_iUin: 10001, m_szAccount: 'u10001', m_szPlayerName: 'Alice', m_nFlag: 3,
    m_iIdentity: 1, m_iBirthDay: 0, m_byIconType: 0, m_szZoneInfo: '',
    m_iCharming: 10, m_iAchievement: 5, m_lHappyBean: 100, m_iExperiencePoint: 999,
    m_i51VIPScore: 0, m_i51Level: 7, m_i51VIPLevel: 0,
    m_iPlayerID: 5001, m_iTableID: 2001, m_bySeat: 0, m_byStatus: 3, m_iSitdownSequence: 1,
    m_iPoint: 0, m_iWinRound: 1, m_iLoseRound: 2, m_iDrawRound: 0,
    m_iEscapeRound: 0, m_iOfflineRound: 0, m_iMoney: 500, m_iFlowerCount: 0,
    m_szExtraUid: '', m_iGoodId: 0, m_iGameVIPScore: 0, m_iGameVIPLevel: 0 },
  { m_iUin: 10002, m_szAccount: 'u10002', m_szPlayerName: 'Bob', m_nFlag: 3,
    m_iIdentity: 1, m_iBirthDay: 0, m_byIconType: 0, m_szZoneInfo: '',
    m_iCharming: 0, m_iAchievement: 0, m_lHappyBean: 0, m_iExperiencePoint: 0,
    m_i51VIPScore: 0, m_i51Level: 1, m_i51VIPLevel: 0,
    m_iPlayerID: 5002, m_iTableID: 2001, m_bySeat: 1, m_byStatus: 3, m_iSitdownSequence: 2,
    m_iPoint: 0, m_iWinRound: 0, m_iLoseRound: 0, m_iDrawRound: 0,
    m_iEscapeRound: 0, m_iOfflineRound: 0, m_iMoney: 0, m_iFlowerCount: 0,
    m_szExtraUid: '', m_iGoodId: 0, m_iGameVIPScore: 0, m_iGameVIPLevel: 0 },
];

const sitBuf = encodeSitDownResponse(players);
const sit = decodeSitDownResponse(sitBuf);
console.log(`  报文长度 ${sitBuf.length} 字节, 消费 ${sit._consumed}`);
eq('m_nResultID', sit.m_nResultID, 0);
eq('m_byACT', sit.m_byACT, 1);
eq('m_iRoomID', sit.m_iRoomID, 1001);
eq('m_iTableID', sit.m_iTableID, 2001);
eq('m_bySeatID', sit.m_bySeatID, 0);
eq('m_iSitdownSequence', sit.m_iSitdownSequence, 1);
eq('★ m_iCrossID (encode未写/decode必读)', sit.m_iCrossID, 0);
eq('m_iMapID', sit.m_iMapID, 14680065);
eq('m_byGameMode', sit.m_byGameMode, 0);
eq('m_bLevel', sit.m_bLevel, 1);
eq('m_nseatmask', sit.m_nseatmask, 255);
eq('m_byPlayerCount', sit.m_byPlayerCount, 2);
eq('玩家数', sit.m_stPlayers.length, 2);
// 注意：encode_string 会追加 "\x00"，而 decode_string 用 readUTFBytes(length) 读回，
// length 是「含 \0」的字节数 → 解码结果带尾部 \0。这是客户端真实行为（a_2664.as:122-163）。
const NUL = '\u0000';
eq('玩家0 姓名（含 encode_string 的尾部 \\0）', sit.m_stPlayers[0].m_szPlayerName, 'Alice' + NUL);
eq('玩家0 身份证', sit.m_stPlayers[0].m_szAccount, 'u10001' + NUL);
eq('顶层 m_szZoneInfo 同理会带 \\0', sit.m_stPlayers[0].m_szZoneInfo, NUL);
eq('玩家0 m_iTableID', sit.m_stPlayers[0].m_iTableID, 2001);
eq('玩家0 m_byStatus', sit.m_stPlayers[0].m_byStatus, 3);
eq('玩家0 m_iSitdownSequence', sit.m_stPlayers[0].m_iSitdownSequence, 1);
eq('玩家0 m_iExperiencePoint', sit.m_stPlayers[0].m_iExperiencePoint, 999);
eq('玩家1 姓名', sit.m_stPlayers[1].m_szPlayerName, 'Bob' + NUL);
eq('玩家1 m_bySeat', sit.m_stPlayers[1].m_bySeat, 1);
eq('全部字节消费完毕', sit._consumed, sitBuf.length);

console.log('\n=== 2. LoadStart (a_2698 + CAvatarInfo) 往返 ===');
const avatarObj = {
  m_iCoverallType: 1, m_iGunType: 2, m_iSuperGunType: 0, m_iShieldType: 3,
  m_iHatType: 0, m_iEyeGlassesType: 0, m_iFaceType: 0, m_iFaceDecorationType: 0,
  m_iEyeType: 0, m_iHairType: 4, m_iBodyType: 1, m_iAureolaType: 0,
  m_iWingType: 0, m_iLandInsuranceType: 0, m_iWaterInsuranceType: 0,
  m_numAttackForce: 100, m_numDefenseForce: 50, m_byShovelType: 1,
  m_arrGenInfoArray: [1, 2, 3],
  m_arrCardEffectAddArray: [],
  m_arrPetInfoArray: [],
};
const cards = [
  { m_iCardID: 1001, m_byCardDegreeLevel: 1, m_byCardSkillLevel: 2, m_byCardGradeLevel: 0 },
  { m_iCardID: 1002, m_byCardDegreeLevel: 0, m_byCardSkillLevel: 0, m_byCardGradeLevel: 1 },
  { m_iCardID: 1003, m_byCardDegreeLevel: 3, m_byCardSkillLevel: 1, m_byCardGradeLevel: 2 },
];
const skills = [{ m_iWeaponSkillID: 9001, m_iWeaponSkillLevel: 5 }];

const av0 = encodeAvatarInfo({ m_bySeatID: 0, m_isAutoPickUpEnergy: true, m_isAutoPickUpProps: false }, avatarObj, cards, skills);
const loadBuf = encodeLoadStart({
  gameMode: 1, cardIDs: [1001, 1002, 1003], propIDs: [2001, 2002],
  avatars: [av0], randomSeed: 123456,
});
const load = decodeLoadStart(loadBuf);
console.log(`  报文长度 ${loadBuf.length} 字节, 消费 ${load._consumed}`);
eq('m_nGameMode', load.m_nGameMode, 1);
eq('m_arrSelectCardIDs', load.m_arrSelectCardIDs, [1001, 1002, 1003]);
eq('m_arrSelectPropIDs', load.m_arrSelectPropIDs, [2001, 2002]);
eq('m_arrAvatarInfoArray 长度', load.m_arrAvatarInfoArray.length, 1);
eq('m_RandomSeed', load.m_RandomSeed, 123456);
const av = load.m_arrAvatarInfoArray[0];
eq('m_bySeatID', av.m_bySeatID, 0);
eq('m_isAutoPickUpEnergy', av.m_isAutoPickUpEnergy, 1);
eq('m_isAutoPickUpProps', av.m_isAutoPickUpProps, 0);
eq('卡组长度', av.m_arrGameCardInfoArray.length, 3);
eq('卡0', av.m_arrGameCardInfoArray[0], cards[0]);
eq('卡2', av.m_arrGameCardInfoArray[2], cards[2]);
eq('技能长度', av.m_arrWeaponSkillInfo.length, 1);
eq('技能0', av.m_arrWeaponSkillInfo[0], skills[0]);
check('blob 经 zlib 往返成功', !!av._amf);
eq('AMF m_iCoverallType', av._amf.m_iCoverallType, 1);
eq('AMF m_iGunType', av._amf.m_iGunType, 2);
eq('AMF m_iHairType', av._amf.m_iHairType, 4);
eq('AMF m_numAttackForce', av._amf.m_numAttackForce, 100);
eq('AMF m_arrGenInfoArray', av._amf.m_arrGenInfoArray, [1, 2, 3]);
eq('AMF m_arrPetInfoArray', av._amf.m_arrPetInfoArray, []);
eq('全部字节消费完毕', load._consumed, loadBuf.length);

console.log('\n=== 3. GameStart (a_2695) 往返 ===');
const gsBuf = encodeGameStart({ waveNum: 20, randomSeed: 123456, buffId: 0 });
const gs = decodeGameStart(gsBuf);
eq('长度 = 1(cmd)+2+4+4', gsBuf.length, 11);
eq('m_nTotalIntruderWaveNum', gs.m_nTotalIntruderWaveNum, 20);
eq('m_RandomSeed', gs.m_RandomSeed, 123456);
eq('m_iBuffId', gs.m_iBuffId, 0);
eq('全部字节消费完毕', gs._consumed, gsBuf.length);

console.log('\n=== 4. StepSync (CNotifyGameStep) 往返 ===');
for (const step of [0, 1, 60, 3600, 2147483647]) {
  const ssBuf = encodeStepSync(step);
  const ss = decodeStepSync(ssBuf);
  eq(`帧号 ${step}`, ss.m_GameStep, step);
  eq(`帧号 ${step} 长度 = 5`, ssBuf.length, 5);
}

console.log('\n=== 5. 负向用例：验证两个「陷阱」的真实失败模式 ===');
// 5a. 故意不写 m_iCrossID —— 实测：不崩溃，而是「静默错位」
function encodeSitDownNoCross(players) {
  const b = encodeSitDownResponse(players);
  return Buffer.concat([b.subarray(0, 16), b.subarray(20)]);   // 删掉偏移 16..19 的 4 字节
}
const noCross = encodeSitDownNoCross(players);
let r5a = null, err5a = null;
try { r5a = decodeSitDownResponse(noCross); } catch (e) { err5a = e.message; }
check('省略 m_iCrossID 不抛错（静默错位，比崩溃更危险）', err5a === null && r5a !== null);
if (r5a) {
  check('  → m_iCrossID 读到 m_iMapID 的值（错位证据）', r5a.m_iCrossID === 14680065, `实际 ${r5a.m_iCrossID}`);
  check('  → m_iMapID 被污染', r5a.m_iMapID === 65791, `实际 ${r5a.m_iMapID}`);
  check('  → m_byPlayerCount 塌缩为 0（玩家全部丢失）', r5a.m_byPlayerCount === 0, `实际 ${r5a.m_byPlayerCount}`);
  check('  → 只消费了 29/146 字节，报文被提前放弃', r5a._consumed === 29, `实际 ${r5a._consumed}`);
}

// 5b. 故意让 m_iTableID = -1 —— 实测：不越界，但 seat/status 整体缺失
const badPlayers = JSON.parse(JSON.stringify(players));
badPlayers.forEach(p => { p.m_iTableID = -1; });
const badBuf = encodeSitDownResponse(badPlayers);
let r5b = null, err5b = null;
try { r5b = decodeSitDownResponse(badBuf); } catch (e) { err5b = e.message; }
check('m_iTableID = -1 不抛错（长度前缀救了它）', err5b === null && r5b !== null);
if (r5b) {
  const p0 = r5b.m_stPlayers[0];
  check('  → m_bySeat 缺失', p0.m_bySeat === undefined);
  check('  → m_byStatus 缺失（座位状态无法建立）', p0.m_byStatus === undefined);
  check('  → 字节仍对齐（无越界）', r5b._consumed === badBuf.length, `实际 ${r5b._consumed}/${badBuf.length}`);
  check('  → 但后续字段未被污染（m_iExperiencePoint 仍正确）', p0.m_iExperiencePoint === 999, `实际 ${p0.m_iExperiencePoint}`);
}

console.log(`\n===== 结果: ${pass} 通过, ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
