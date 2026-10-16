import { encodeSitDownResponse } from "./encode-test.mjs";
import { decodeSitDownResponse } from "./decode-test.mjs";

const mk = (tid) => ({ m_iUin:1, m_szAccount:"a", m_szPlayerName:"p", m_nFlag:0,
  m_iIdentity:0, m_iBirthDay:0, m_byIconType:0, m_szZoneInfo:"",
  m_iCharming:0, m_iAchievement:0, m_lHappyBean:0, m_iExperiencePoint:0,
  m_i51VIPScore:0, m_i51Level:0, m_i51VIPLevel:0,
  m_iPlayerID:1, m_iTableID:tid, m_bySeat:0, m_byStatus:3, m_iSitdownSequence:1,
  m_iPoint:0, m_iWinRound:0, m_iLoseRound:0, m_iDrawRound:0, m_iEscapeRound:0,
  m_iOfflineRound:0, m_iMoney:0, m_iFlowerCount:0, m_szExtraUid:"",
  m_iGoodId:0, m_iGameVIPScore:0, m_iGameVIPLevel:0 });

console.log("=== 负例 A: 省略 m_iCrossID (删偏移16..19) ===");
const ok = encodeSitDownResponse([mk(2001)]);
const noCross = Buffer.concat([ok.subarray(0,16), ok.subarray(20)]);
try {
  const r = decodeSitDownResponse(noCross);
  console.log("  未抛错。解析结果:");
  console.log("    m_iCrossID      =", r.m_iCrossID, "  (期望 0)");
  console.log("    m_iMapID        =", r.m_iMapID);
  console.log("    m_byGameMode    =", r.m_byGameMode);
  console.log("    m_byPlayerCount =", r.m_byPlayerCount, "  <-- 若为垃圾值, 客户端会疯狂 new CPlayerDetail");
  console.log("    players.length  =", r.m_stPlayers.length);
  console.log("    消费字节        =", r._consumed, "/", noCross.length);
} catch (e) { console.log("  抛错:", e.message); }

console.log("\n=== 负例 B: m_iTableID = -1 ===");
try {
  const r = decodeSitDownResponse(encodeSitDownResponse([mk(-1)]));
  const p = r.m_stPlayers[0];
  console.log("  未抛错。解析结果:");
  console.log("    m_iTableID            =", p.m_iTableID);
  console.log("    m_bySeat (应缺失)      =", p.m_bySeat);
  console.log("    m_byStatus (应缺失)    =", p.m_byStatus);
  console.log("    m_byIconType          =", p.m_byIconType, " <-- 是否被错位污染?");
  console.log("    消费字节              =", r._consumed, "/", encodeSitDownResponse([mk(-1)]).length);
} catch (e) { console.log("  抛错:", e.message); }
