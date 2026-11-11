#!/usr/bin/env node
/* =========================================================
   한국관광공사 지역별 목록으로 장소를 크게 늘리기 → js/places-more.js 만들기

   사용법 (PowerShell):
     $env:TOUR_API_KEY = "공공데이터포털 일반 인증키(Decoding)"
     node tools/build-more.js

   옵션:
     --tour=6 --food=3 --cafe=2 --lodge=2   시·군·구마다 넣을 관광지·맛집·카페·숙소 수
     --calls=950                            이번 실행에서 쓸 관광공사 호출 수 (하루 한도 1,000회)
     --refresh                              전국 목록(tools/kto-list.json)을 다시 받기

   하는 일:
     1) 국문 관광정보(KorService2)의 지역별 목록(areaBasedList2)에서 관광지·문화시설·레포츠·숙박·음식점을
        종류별로 1,000건씩 받아, 사진이 있는 곳만 tools/kto-list.json에 저장 (약 40회 호출)
     2) 기초지자체 중심 관광지 순위(이미 받아 둔 tools/cache)와 맞는 곳을 먼저 고르고,
        시·군·구마다 위 개수까지 장소를 고름 (이미 사이트에 있는 장소는 뺌)
     3) 남은 호출 수 안에서 인기 순위가 높은 곳부터 소개글·운영 시간·요금(detailCommon2·detailIntro2)을 받음
        - 못 받은 곳은 "방문 전 확인"으로 두고, 다음 날 같은 명령을 다시 실행하면 이어서 받음
   결과: js/places-more.js (window.GUIDE_PLACES_MORE), tools/more-report.txt
   - 인증키는 화면이나 파일에 남기지 않습니다.
   ========================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const bp = require('./build-places.js');
const { api, items, stats, LimitError, clean, firstSentence, norm, regionOfItem, decideType, decideThemes, SKIP_NAME, pickHours, KOR, CACHE } = bp;

const ROOT = path.resolve(__dirname, '..');
const LIST = path.join(__dirname, 'kto-list.json');
const OUT = path.join(ROOT, 'js', 'places-more.js');
const REPORT = path.join(__dirname, 'more-report.txt');
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const QUOTA = { tour: Number(args.tour || 6), food: Number(args.food || 3), cafe: Number(args.cafe || 2), lodge: Number(args.lodge || 2) };
const CALL_LIMIT = Number(args.calls || 950);
const KEY = process.env.TOUR_API_KEY || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hav = (aLat, aLng, bLat, bLng) => Math.hypot((aLat - bLat) * 111, (aLng - bLng) * 88);

/* ---------- 1) 전국 목록 받기 (사진 있는 곳만 저장) ---------- */
async function listPage(type, page) {
  const q = new URLSearchParams({ MobileOS: 'WEB', MobileApp: 'TravelGuide', _type: 'json', numOfRows: '1000', pageNo: String(page), contentTypeId: String(type), arrange: 'A' });
  const url = KOR + 'areaBasedList2?serviceKey=' + encodeURIComponent(KEY) + '&' + q.toString();
  let text = '';
  for (let i = 0; i < 3; i++) {
    try { stats.calls++; text = await (await fetch(url)).text(); if (text.trim().startsWith('{')) break; } catch (e) { /* 다시 시도 */ }
    await sleep(1000 * (i + 1));
  }
  let json;
  try { json = JSON.parse(text); } catch (e) {
    // JSON이 아니라 오류 안내문(XML)이 온 경우에만 한도 문구를 찾음 (지명에 '한도'가 들어 있어도 오탐하지 않게)
    if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS/i.test(text)) { stats.limitHit = true; throw new LimitError('하루 호출 한도를 넘었어요.'); }
    throw new Error('목록 응답을 읽지 못했어요 (' + type + ' / ' + page + '쪽): ' + text.slice(0, 120));
  }
  const code = json.response && json.response.header && json.response.header.resultCode;
  if (code === '22') { stats.limitHit = true; throw new LimitError('하루 호출 한도를 넘었어요.'); }
  if (code && code !== '0000' && code !== '00') throw new Error('목록 호출 오류 ' + code + ' (' + type + ')');
  return { total: Number(json.response.body.totalCount) || 0, rows: items(json) };
}
async function fetchList() {
  if (!KEY) { console.error('인증키가 없어요. 먼저 $env:TOUR_API_KEY = "인증키" 를 실행하세요.'); process.exit(1); }
  const all = [];
  for (const type of [12, 14, 28, 32, 39]) {
    let page = 1, got = 0, total = Infinity, kept = 0;
    while (got < total) {
      const r = await listPage(type, page);
      total = r.total; got += r.rows.length; page++;
      r.rows.forEach(x => {
        const img = String(x.firstimage || x.firstimage2 || '').replace(/^http:\/\//, 'https://');
        if (!img || !x.title || !(+x.mapx) || !(+x.mapy)) return;
        all.push({
          id: String(x.contentid), t: +x.contenttypeid, n: String(x.title).replace(/\s+/g, ' ').trim(),
          a: String(x.addr1 || '').trim(), x: Math.round(+x.mapx * 1e5) / 1e5, y: Math.round(+x.mapy * 1e5) / 1e5,
          i: img, r: String(x.lDongRegnCd || ''), s: String(x.lDongSignguCd || ''), l: String(x.lclsSystm3 || ''),
          m: String(x.modifiedtime || '').slice(0, 8), c: String(x.cpyrhtDivCd || '')
        });
        kept++;
      });
      if (!r.rows.length) break;
      await sleep(150);
    }
    console.log('  종류 ' + type + ': ' + got + '건 중 사진·위치가 있는 ' + kept + '건 저장');
  }
  fs.writeFileSync(LIST, JSON.stringify({ fetchedAt: new Date().toISOString(), items: all }));
  return all;
}

/* ---------- 이미 있는 장소·인기 순위·시군구 이름 읽기 ---------- */
function loadExisting() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8'), ctx);
  try { vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'places.js'), 'utf8'), ctx); } catch (e) { /* 없어도 계속 */ }
  const D = Object.values(ctx.window).find(v => v && Array.isArray(v.PLACES));
  return D.PLACES.concat(ctx.window.GUIDE_PLACES_EXTRA || []);
}
function loadHub() {
  const best = {};
  fs.readdirSync(CACHE).filter(f => f.startsWith('areaBasedList1-')).forEach(f => {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')); } catch (e) { return; }
    items(j).forEach(h => {
      const rank = +h.hubRank, lat = +h.mapY, lng = +h.mapX;
      if (!h.hubTatsNm || !rank || !lat || !lng) return;
      const prev = best[h.hubTatsCd];
      if (!prev || rank < prev.rank) best[h.hubTatsCd] = { name: h.hubTatsNm, n: norm(h.hubTatsNm), rank, lat, lng, city: h.signguNm, cat: h.hubCtgryMclsNm || h.hubCtgryLclsNm || '' };
    });
  });
  return Object.values(best);
}
function loadSgg() {
  const map = {};
  fs.readdirSync(CACHE).filter(f => f.startsWith('ldongCode2-')).forEach(f => {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')); } catch (e) { return; }
    items(j).forEach(x => { if (x.lDongSignguCd) map[x.lDongRegnCd + '-' + x.lDongSignguCd] = x.lDongSignguNm; });
  });
  return map;
}

/* ---------- 2) 고르기 ---------- */
const EXTRA_SKIP = /상가|오피스텔|빌라|아파트|주택|단지$|도서관|복지관|주민센터|보건소|행정복지|사무소|군민회관|문화원|문예회관|경로당|어린이집|유치원|학교|캠퍼스|체육관|수련원|연수원|교육원|운동장|종합운동|실내체육|공영|환승|정류|차고|물류|공장|제조|농협|수협|신협|새마을/;
const LODGE_SKIP = /모텔|여관|고시원|하숙|기숙사|연수원|수련원|사원|숙직/;
const FOOD_SKIP = /편의점|마트|급식|구내식당|도시락|푸드트럭|포장마차$/;
function kindOf(it) {
  if (it.t === 32) return 'lodge';
  if (it.t === 39) return it.l.indexOf('FD05') === 0 ? 'cafe' : 'food';
  return 'tour';
}
function usable(it, kind) {
  if (it.n.length < 2 || SKIP_NAME.test(it.n)) return false;
  if (kind === 'tour') return !EXTRA_SKIP.test(it.n) && it.l.indexOf('SH') !== 0;
  if (kind === 'lodge') return !LODGE_SKIP.test(it.n) && !EXTRA_SKIP.test(it.n.replace(/연수원|수련원/g, ''));
  return !FOOD_SKIP.test(it.n);
}
// 순위 자료와 같은 곳인지 (가까우면서 이름이 겹침)
function attachHub(list, hubs) {
  const grid = {};
  const cell = (lat, lng) => Math.round(lat * 50) + ',' + Math.round(lng * 50);
  hubs.forEach(h => { const k = cell(h.lat, h.lng); (grid[k] = grid[k] || []).push(h); });
  list.forEach(it => {
    const cy = Math.round(it.y * 50), cx = Math.round(it.x * 50), n = norm(it.n);
    let best = null;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      (grid[(cy + dy) + ',' + (cx + dx)] || []).forEach(h => {
        if (hav(it.y, it.x, h.lat, h.lng) > 0.7) return;
        const ok = n === h.n || (h.n.length >= 3 && n.indexOf(h.n) !== -1) || (n.length >= 3 && h.n.indexOf(n) !== -1);
        if (ok && (!best || h.rank < best.rank)) best = h;
      });
    }
    if (best) it.hub = best;
  });
}

function makeDedupe(existing) {
  const byRegion = {};
  const add = p => { (byRegion[p.region] = byRegion[p.region] || []).push({ n: norm(p.name), lat: p.lat, lng: p.lng, type: p.type, id: p.id }); };
  existing.forEach(add);
  const isDup = p => {
    const n = norm(p.name);
    return (byRegion[p.region] || []).some(o => {
      if (o.id === p.id) return true;
      const close = o.lat != null && p.lat != null ? hav(o.lat, o.lng, p.lat, p.lng) : null;
      if (close !== null && o.type === p.type && close < 0.15) return true;
      if (!(o.n.includes(n) || n.includes(o.n))) return false;
      return close === null || close < 0.5;
    });
  };
  return { add, isDup };
}

// 이름 뒤 꼬리표 정리: '조계사(서울)' → '조계사', '호텔 더 디자이너스(Hotel the designers)' → '호텔 더 디자이너스', '반구대 [유네스코 세계유산]' → '반구대'
const REGION_WORD = '서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주|[가-힣]{1,4}(?:시|군|구|도)';
function cleanName(n) {
  let s = String(n).replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
  s = s.replace(new RegExp('\\s*\\((?:' + REGION_WORD + ')\\)\\s*$'), '').trim();
  const t = s.replace(/\s*\([A-Za-z0-9 &'.,!-]+\)\s*$/, '').trim();
  if (/[가-힣]/.test(t)) s = t;
  return s.length >= 2 ? s : String(n).trim();
}

const LCLS_HINT = { NA: '자연 풍경', HS: '역사 문화유산', EX: '체험', LS: '체험 레저', VE: '문화' };

/* ---------- 실행 ---------- */
(async () => {
  let list;
  if (!args.refresh && fs.existsSync(LIST)) {
    const j = JSON.parse(fs.readFileSync(LIST, 'utf8'));
    list = j.items;
    console.log('저장해 둔 전국 목록 ' + list.length + '곳을 씁니다 (' + String(j.fetchedAt).slice(0, 10) + ', 다시 받으려면 --refresh)');
  } else {
    console.log('전국 목록을 받는 중… (종류별로 1,000건씩)');
    list = await fetchList();
  }

  const existing = loadExisting();
  const hubs = loadHub();
  const sggName = loadSgg();
  list.forEach(it => { it.n = cleanName(it.n); });
  attachHub(list, hubs);
  console.log('기존 장소 ' + existing.length + '곳, 인기 순위 자료 ' + hubs.length + '곳, 순위와 맞는 목록 ' + list.filter(x => x.hub).length + '곳');

  // 시·군·구 + 종류별로 점수 높은 순서로 고름
  const groups = {};
  list.forEach(it => {
    const kind = kindOf(it);
    if (!usable(it, kind)) return;
    const region = regionOfItem({ lDongRegnCd: it.r, addr1: it.a });
    if (!region) return;
    it._kind = kind; it._region = region;
    const key = it.r + '-' + it.s + '|' + kind;
    (groups[key] = groups[key] || []).push(it);
  });
  const dedupe = makeDedupe(existing);
  const picked = [];
  const mk = (it) => {
    const kind = it._kind;
    const type = kind === 'cafe' ? '카페' : decideType(it.t, it.n, kind === 'tour' ? '관광지' : null);
    return { id: 'kto-' + it.id, name: it.n, type, region: it._region, lat: it.y, lng: it.x };
  };
  Object.keys(groups).sort().forEach(key => {
    const kind = key.split('|')[1];
    const cands = groups[key].slice().sort((a, b) =>
      (b.hub ? 5000 - b.hub.rank * 10 : 0) - (a.hub ? 5000 - a.hub.rank * 10 : 0) || b.m.localeCompare(a.m) || a.n.localeCompare(b.n, 'ko'));
    // 장소가 아주 많은 시·군·구(제주시 등)는 기본 개수의 최대 2배까지 고름
    const limit = Math.min(QUOTA[kind] * 2, QUOTA[kind] + Math.floor(cands.length / 100));
    let n = 0;
    for (const it of cands) {
      if (n >= limit) break;
      const p = mk(it);
      if (dedupe.isDup(p)) continue;
      dedupe.add(p);
      it._p = p; it._score = it.hub ? 5000 - it.hub.rank * 10 : 0;
      picked.push(it); n++;
    }
  });
  console.log('새로 고른 장소 ' + picked.length + '곳 (시·군·구마다 관광지 ' + QUOTA.tour + ' · 맛집 ' + QUOTA.food + ' · 카페 ' + QUOTA.cafe + ' · 숙소 ' + QUOTA.lodge + '곳까지)');

  // 3) 상세 정보: 순위 높은 곳 → 관광지 → 나머지 순서로, 남은 호출 수만큼
  const order = picked.slice().sort((a, b) => b._score - a._score || (a._kind === 'tour' ? 0 : 1) - (b._kind === 'tour' ? 0 : 1));
  let detailed = 0, limitMsg = '';
  try {
    for (const it of order) {
      if (stats.calls >= CALL_LIMIT) { limitMsg = '이번 실행의 호출 수(' + CALL_LIMIT + '회)를 다 썼어요.'; break; }
      const common = items(await api(KOR, 'detailCommon2', { contentId: it.id }))[0] || null;
      const intro = items(await api(KOR, 'detailIntro2', { contentId: it.id, contentTypeId: it.t }))[0] || null;
      if (common || intro) { it._common = common || {}; it._intro = intro; detailed++; }
      if (detailed % 100 === 0 && detailed) console.log('  상세 정보 ' + detailed + '곳');
    }
  } catch (e) {
    if (e instanceof LimitError) limitMsg = '관광공사 하루 호출 한도에 도달했어요.';
    else throw e;
  }

  // 장소 만들기
  const places = picked.map(it => {
    const p0 = it._p, common = it._common || {}, hub = it.hub;
    const sgg = sggName[it.r + '-' + it.s] || (hub && hub.city) || '';
    const overview = common.overview || '';
    const text = [overview, LCLS_HINT[it.l.slice(0, 2)] || '', hub ? hub.cat : ''].join(' ');
    const p = { id: p0.id, name: p0.name, type: p0.type, region: p0.region };
    if (hub) p.rank = hub.rank;
    p.lat = p0.lat; p.lng = p0.lng;
    const rankText = hub ? (sgg || p.region) + ' 인기 순위 ' + hub.rank + '위' : '';
    p.summary = firstSentence(overview, 60) || (rankText ? rankText + (hub.cat ? ' · ' + hub.cat : '') : (sgg ? sgg + '의 ' + p.type : p.region + '의 ' + p.type));
    p.description = clean(overview, 420) ||
      (rankText ? rankText + '에 오른 곳이에요. 한국관광공사가 티맵 내비게이션 기록으로 집계한, 이 지역에서 다른 관광지와 함께 가장 많이 찾는 곳이에요.'
        : (sgg || p.region) + '에 있는 ' + p.type + '이에요. 한국관광공사에 등록된 곳이에요. 자세한 소개는 방문 전에 공식 안내를 확인해 주세요.');
    p.address = clean(it.a, 80) || p.region;
    p.mapQuery = p.name;
    const h = pickHours(it._intro, it.t);
    p.hours = h.hours || '방문 전 확인';
    p.closed = h.closed || '방문 전 확인';
    p.price = h.price || '방문 전 확인';
    if (common.homepage) { const m = String(common.homepage).match(/href="([^"]+)"/); if (m) p.homepage = m[1]; }
    p.keywords = Array.from(new Set([sgg, hub && hub.cat].filter(Boolean)));
    p.images = [it.i];
    p.credit = '한국관광공사';
    p.source = '한국관광공사 관광정보';
    let themes = decideThemes(p, text);
    if (themes.length === 1 && themes[0] === '아이와 함께' && !/체험|어린이|아이|가족|동물원|아쿠아리움|과학관|박물관|놀이|키즈|테마파크|목장|농장/.test(p.name + ' ' + text)) {
      themes = it.l.indexOf('NA') === 0 ? ['산·숲'] : (p.type === '관광지' ? ['도심지'] : themes);
    }
    p.themes = themes;
    return p;
  });

  fs.writeFileSync(OUT,
    '/* 자동 생성 파일: tools/build-more.js 로 만듦. 직접 고치지 마세요.\n' +
    '   출처: 한국관광공사 TourAPI(국문 관광정보 지역별 목록, 기초지자체 중심 관광지 정보)\n' +
    '   만든 날: ' + new Date().toISOString().slice(0, 10) + ' / 장소 ' + places.length + '곳 */\n' +
    'window.GUIDE_PLACES_MORE = ' + JSON.stringify(places).replace(/},{/g, '},\n{') + ';\n');

  const byRegion = {}, byType = {};
  places.forEach(p => { byRegion[p.region] = (byRegion[p.region] || 0) + 1; byType[p.type] = (byType[p.type] || 0) + 1; });
  const withInfo = places.filter(p => p.hours !== '방문 전 확인').length;
  const report = [
    '만든 날: ' + new Date().toISOString(),
    '새 장소: ' + places.length + ' (사진 ' + places.filter(p => p.images.length).length + ', 순위 자료와 맞는 곳 ' + places.filter(p => p.rank).length + ', 운영 시간 확인된 곳 ' + withInfo + ', 소개글 받은 곳 ' + detailed + ')',
    '지역별: ' + JSON.stringify(byRegion),
    '종류별: ' + JSON.stringify(byType),
    'API 호출: 새로 ' + stats.calls + '회 / 저장본 사용 ' + stats.cached + '회' + (limitMsg ? ' / ⚠️ ' + limitMsg + ' 내일 다시 실행하면 이어서 받아요.' : '')
  ].join('\n');
  fs.writeFileSync(REPORT, report);
  console.log('\n' + report);
  console.log('\n→ ' + path.relative(ROOT, OUT) + ' 저장 완료');
})().catch(e => { console.error('오류: ' + e.message); process.exit(1); });
