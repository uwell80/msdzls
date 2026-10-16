/**
 * 自检：本地服务出的 `/config/map_mouse.xml` 是否**补上了合成地图条目**。
 * （战斗改道到合成地图后，`a_2037.m_dictMapMouse[0x50010301]` 必须存在，
 *   否则准备界面/战斗初始化会拿到 null，出现空名 404 之类怪现象。）
 *
 * 用法：node server/check-mapmouse-composite.cjs
 */
process.env.REA_HTTP_PORT = process.env.REA_HTTP_PORT ?? "18072";
process.env.REA_GAME_PORT = "28475";
process.env.REA_AUTH_PORT = "28476";
process.env.REA_HALL_PORT = "28477";
process.env.REA_LOGIC_PORT = "28478";

(async () => {
  const { startServer, L1_GAME_DATA_NOTIFY } = await import("./local-server.mjs");
  startServer();
  await new Promise((r) => setTimeout(r, 700));

  const res = await fetch(`http://127.0.0.1:${process.env.REA_HTTP_PORT}/config/map_mouse.xml`);
  const xml = await res.text();
  const want = 'MapID="0x50010301"';
  // world_roaming.xml 里出现的 map_id 必须**全部**出现在 map_mouse.xml 里，
  // 否则 WorldRoamingXML.a_2040 的 CheckMapID 会抛错、整份世界漫游数据半途而废。
  const fs = await import("node:fs");
  const path = await import("node:path");
  const roaming = fs.readFileSync(
    path.join(process.cwd(), "client-cache", "config-data", "world_roaming.xml"),
    "utf8",
  );
  const ids = [...roaming.matchAll(/map_id="(0x[0-9a-fA-F]+|[0-9]+)"/g)].map((m) => {
    const v = Number.parseInt(m[1], m[1].startsWith("0x") ? 16 : 10) >>> 0;
    return "0x" + v.toString(16).toUpperCase().padStart(8, "0");
  });
  const missing = [...new Set(ids)].filter((id) => !xml.includes(`MapID="${id}"`));
  const ok = xml.includes(want) && missing.length === 0;
  console.log(`map_mouse.xml ${xml.length} 字节，含合成地图条目(${want}): ${xml.includes(want) ? "✓" : "✗"}`);
  console.log(
    `world_roaming 引用 ${new Set(ids).size} 个 map_id，缺失 ${missing.length} 个` +
      (missing.length ? `：${missing.slice(0, 6).join(",")}…` : " ✓"),
  );
  // 服务端出的 world_roaming.xml 应已把缺失 id 改写掉 ⇒ 这里再验一遍
  const roamingServed = await (
    await fetch(`http://127.0.0.1:${process.env.REA_HTTP_PORT}/config/world_roaming.xml`)
  ).text();
  const servedIds = [...roamingServed.matchAll(/map_id="(0x[0-9a-fA-F]+|[0-9]+)"/g)].map((m) => {
    const v = Number.parseInt(m[1], m[1].startsWith("0x") ? 16 : 10) >>> 0;
    return "0x" + v.toString(16).toUpperCase().padStart(8, "0");
  });
  const stillMissing = [...new Set(servedIds)].filter((id) => !xml.includes(`MapID="${id}"`));
  console.log(
    `服务出的 world_roaming.xml：${servedIds.length} 个 map_id，仍缺失 ${stillMissing.length} 个` +
      (stillMissing.length ? `：${stillMissing.slice(0, 6).join(",")}` : " ✓"),
  );
  if (ok) {
    const i = xml.indexOf(want);
    console.log("  条目片段:", xml.slice(Math.max(0, i - 20), i + 220).replace(/\s+/g, " "));
  }
  console.log(`L1 游戏数据通知号 = ${L1_GAME_DATA_NOTIFY}（应为 8711）`);
  process.exit(ok && L1_GAME_DATA_NOTIFY === 8711 ? 0 : 1);
})();
