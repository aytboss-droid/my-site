#!/usr/bin/env node
/* =========================================================
   사진이 없는 장소에 진짜 사진 붙이기 → js/photos.js 만들기

   사용법 (PowerShell):
     node tools/build-photos.js            관광공사(키가 있으면) → 위키백과 순서로 찾기
     node tools/build-photos.js --wikiOnly 위키백과만 (인증키 없이)

   찾는 순서 (먼저 찾은 것을 씀):
     1) 한국관광공사 국문 관광정보(KorService2) 검색 결과의 대표 사진
        - 인증키: $env:TOUR_API_KEY (없으면 저장해 둔 응답만 씀)
        - tools/build-places.js 와 같은 cache 폴더·같은 저장 방식을 써서, 이미 받은 검색은 다시 부르지 않음
     2) 위키백과(한국어) 문서의 대표 사진 = 위키미디어 공용의 자유 이용 사진
     3) 위키데이터 항목의 대표 사진(별칭으로 검색, 위치 확인)
     4) 위키미디어 공용 위치 검색: 장소 400m 안에서 찍혔고 파일 이름에 장소 이름이 든 사진 (관광지만)
        - 작가·이용 조건(CC BY-SA 등)을 함께 저장해서 사이트에 출처로 표시함
     블로그·SNS 사진은 저작권 때문에 쓰지 않음.

   결과: tools/photos.json (기록), js/photos.js (사이트가 읽는 파일)
   - 사이트(app.js)는 사진이 없는 장소에만 이 사진을 붙임
   ========================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(__dirname, 'cache');
const STORE = path.join(__dirname, 'photos.json');
const OUT = path.join(ROOT, 'js', 'photos.js');
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const WIKI_ONLY = !!args.wikiOnly;
const KEY = WIKI_ONLY ? '' : (process.env.TOUR_API_KEY || '');
const KOR = 'https://apis.data.go.kr/B551011/KorService2/';
const COMMON = { MobileOS: 'WEB', MobileApp: 'TravelGuide', _type: 'json' };
const UA = 'TravelGuidePhotoTool/1.0 (personal non-commercial travel site)';

fs.mkdirSync(CACHE, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stats = { kto: 0, wiki: 0, wikidata: 0, commons: 0, none: 0, calls: 0, cached: 0, limitHit: false };

/* ---------- 장소 목록 읽기 (data.js + places.js) ---------- */
function loadPlaces() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8'), ctx);
  try { vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'places.js'), 'utf8'), ctx); } catch (e) {}
  const D = Object.values(ctx.window).find(v => v && Array.isArray(v.PLACES));
  return D.PLACES.concat(ctx.window.GUIDE_PLACES_EXTRA || []);
}
// 사이트(app.js)와 같은 열쇠: 이름(빈칸 없이)|지역
const keyOf = p => String(p.name).replace(/\s+/g, '') + '|' + p.region;
const norm = s => String(s || '').replace(/[\s()·\-_.,'"]/g, '').replace(/\[.*?\]/g, '').toLowerCase();
function distKm(a, b) {
  if (a.lat == null || b.lat == null) return null;
  return Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 88);
}

/* ---------- 관광공사 (build-places.js와 같은 저장 방식) ---------- */
class LimitError extends Error {}
async function kto(op, params) {
  const q = new URLSearchParams({ ...COMMON, ...params });
  const cacheKey = crypto.createHash('md5').update(KOR + op + '?' + q.toString()).digest('hex');
  const file = path.join(CACHE, op + '-' + cacheKey + '.json');
  if (fs.existsSync(file)) { stats.cached++; return JSON.parse(fs.readFileSync(file, 'utf8')); }
  if (!KEY || stats.limitHit) return null;
  const url = KOR + op + '?serviceKey=' + encodeURIComponent(KEY) + '&' + q.toString();
  let text = '';
  for (let i = 0; i < 3; i++) {
    try { stats.calls++; text = await (await fetch(url)).text(); break; } catch (e) { await sleep(800 * (i + 1)); }
  }
  if (!text.trim().startsWith('{') && /LIMITED_NUMBER_OF_SERVICE_REQUESTS|한도|exceeds/i.test(text)) { stats.limitHit = true; throw new LimitError(); }
  let json; try { json = JSON.parse(text); } catch (e) { return null; }
  const code = json && json.response && json.response.header && json.response.header.resultCode;
  if (code === '22') { stats.limitHit = true; throw new LimitError(); }
  if (code && code !== '0000' && code !== '00' && code !== '03') return null;
  fs.writeFileSync(file, JSON.stringify(json));
  await sleep(60);
  return json;
}
function items(json) {
  const it = json && json.response && json.response.body && json.response.body.items;
  if (!it || !it.item) return [];
  return Array.isArray(it.item) ? it.item : [it.item];
}
const SIDO_WORD = { '서울': '서울', '부산': '부산', '대구': '대구', '인천': '인천', '광주': '광주', '대전': '대전', '울산': '울산', '세종': '세종',
  '경기': '경기', '강원': '강원', '충청북': '충북', '충북': '충북', '충청남': '충남', '충남': '충남', '전북': '전북', '전라북': '전북',
  '전라남': '전남', '전남': '전남', '경상북': '경북', '경북': '경북', '경상남': '경남', '경남': '경남', '제주': '제주' };
function regionOfAddr(addr) {
  const a = String(addr || '');
  if (/통합특별시/.test(a)) return /^\S+\s+(동구|서구|남구|북구|광산구)/.test(a) ? '광주' : '전남';
  for (const k of Object.keys(SIDO_WORD)) if (a.indexOf(k) === 0) return SIDO_WORD[k];
  return '';
}
function keywordsOf(p) {
  const n = String(p.name).trim();
  const list = [n, n.split('/')[0].trim()];
  const parts = n.split(/\s+/);
  if (parts.length > 1) list.push(parts.slice(1).join(' '));        // '담양 죽녹원' → '죽녹원'
  list.push(n.replace(/\s*(본점|[가-힣A-Za-z]+점)$/, ''));             // '성심당 본점' → '성심당'
  return Array.from(new Set(list.filter(s => s && s.length >= 2)));
}
/* ---------- 관광공사 전국 목록(tools/build-more.js가 저장한 kto-list.json)에서 찾기 ---------- */
// 키워드 검색(searchKeyword2)보다 정확하고 호출이 필요 없음: 이름이 같거나 겹치고, 위치가 가까운 곳만
let LIST_ITEMS = null;
function getList() {
  if (LIST_ITEMS !== null) return LIST_ITEMS;
  const f = path.join(__dirname, 'kto-list.json');
  LIST_ITEMS = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).items.map(it => ({
    ...it, nn: norm(String(it.n).replace(/\s*[\[(][^\])]*[\])]\s*$/, '')), reg: regionOfAddr(it.a)
  })) : false;
  return LIST_ITEMS;
}
// 직접 지정한 사진 (tools/photo-overrides.json: '이름(빈칸 없이)|지역' → 관광공사 콘텐츠 번호). 이름 표기가 달라 자동으로 못 찾는 곳용
let OVERRIDES = null;
function getOverrides() {
  if (OVERRIDES === null) { const f = path.join(__dirname, 'photo-overrides.json'); OVERRIDES = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; }
  return OVERRIDES;
}
function fromList(p) {
  const L = getList();
  if (!L) return null;
  const ovId = getOverrides()[keyOf(p)];
  if (ovId) {
    const it = L.find(x => x.id === String(ovId));
    if (it && it.reg === p.region) return { images: [it.i], credit: '한국관광공사', source: 'kto', page: it.n, lat: it.y, lng: it.x };
    console.warn('  ⚠️ 지정한 사진을 못 썼어요(목록에 없거나 지역이 달라요): ' + keyOf(p) + ' → ' + ovId);
  }
  const full = norm(p.name), core = norm(String(p.name).split('/')[0]);
  const wantFood = p.type === '맛집' || p.type === '카페', wantLodge = p.type === '숙소';
  let best = null;
  for (const it of L) {
    if (p.lat != null) { if (Math.abs(it.y - p.lat) > 0.02 || Math.abs(it.x - p.lng) > 0.025) continue; }
    else if (it.reg !== p.region) continue;
    if ((it.t === 39) !== wantFood || (it.t === 32) !== wantLodge) continue;
    const exact = it.nn === full || it.nn === core ? 0 : (it.nn.length >= 3 && core.length >= 3 && (it.nn.includes(core) || core.includes(it.nn))) ? 1 : 2;
    if (exact === 2 || (p.lat == null && exact !== 0)) continue;
    // 지점·가게 이름(…점)이 장소 이름을 품고 있는 경우는 다른 곳 (예: '동성로' ↔ '호텔 더시그니처 동성로점')
    if (exact === 1 && /점$/.test(it.nn) && !/점$/.test(core)) continue;
    const d = p.lat != null ? distKm(p, { lat: it.y, lng: it.x }) : 0;
    if (d > (exact === 0 ? 1.5 : 0.6)) continue;
    if (!best || exact < best.exact || (exact === best.exact && d < best.d)) best = { it, exact, d };
  }
  return best ? { images: [best.it.i], credit: '한국관광공사', source: 'kto', page: best.it.n, weak: best.exact === 1, lat: best.it.y, lng: best.it.x } : null;
}

async function fromKto(p) {
  const fl = fromList(p);
  if (fl) return fl;
  if (getList() && !args.search) return null; // 전국 목록이 있으면 호출이 필요한 키워드 검색은 건너뜀 (--search로 강제)
  for (const kw of keywordsOf(p)) {
    const raw = items(await kto('searchKeyword2', { keyword: kw, numOfRows: 20, pageNo: 1, arrange: 'A' }));
    const target = norm(p.name), core = norm(kw);
    const cands = raw.map(it => {
      const t = norm(it.title);
      const exact = t === target || t === core ? 0 : (t.includes(core) || core.includes(t)) && t.length >= 2 ? 1 : 2;
      const d = p.lat != null && it.mapy ? distKm(p, { lat: +it.mapy, lng: +it.mapx }) : null;
      return { it, exact, d, region: regionOfAddr(it.addr1) };
    }).filter(x => x.exact < 2 && (x.d === null ? x.region === p.region : x.d < 5) && (x.it.firstimage || x.it.firstimage2))
      .sort((a, b) => a.exact - b.exact || (a.d || 0) - (b.d || 0));
    if (cands.length) {
      const img = String(cands[0].it.firstimage || cands[0].it.firstimage2).replace(/^http:\/\//, 'https://');
      return { images: [img], credit: '한국관광공사', source: 'kto', lat: +cands[0].it.mapy || null, lng: +cands[0].it.mapx || null };
    }
  }
  return null;
}

/* ---------- 위키백과·위키미디어 공용 ---------- */
async function wikiGet(host, params) {
  const q = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const url = 'https://' + host + '/w/api.php?' + q.toString();
  const file = path.join(CACHE, 'wiki-' + crypto.createHash('md5').update(url).digest('hex') + '.json');
  if (fs.existsSync(file)) { stats.cached++; return JSON.parse(fs.readFileSync(file, 'utf8')); }
  let json = null;
  // 위키데이터는 요청이 잦으면 "too many requests" 글자로 거절함 → 오래 쉬었다가 다시
  const slow = host.indexOf('wikidata') !== -1;
  for (let i = 0; i < 5; i++) {
    try {
      stats.calls++;
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      const text = await res.text();
      if (res.status === 429 || /too many requests/i.test(text.slice(0, 200))) {
        console.log('  (요청이 많다고 해서 ' + 15 * (i + 1) + '초 쉬어요)');
        await sleep(15000 * (i + 1)); continue;
      }
      json = JSON.parse(text);
      break;
    } catch (e) { await sleep(2000 * (i + 1)); }
  }
  if (json && !json.error) fs.writeFileSync(file, JSON.stringify(json));
  await sleep(slow ? 1100 : 300);
  return json;
}
const stripHtml = s => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
// 장소 사진이 아닌 파일 (지도·로고·우표·관공서·역 등)
const BAD_FILE = /\.svg$|\.png$|logo|로고|map|지도|위치|location|locator|emblem|symbol|문장|flag|seal|sign|diagram|plan\b|stamp|우표|기념우표|city_hall|시청|군청|구청|office|청사|station|역\.jpe?g|portrait|commanding|가이드맵|안내도|guide_?map/i;
// 이런 일반 낱말만으로는 장소를 정할 수 없음
const GENERIC = /^(호텔|리조트|베이커리|카페|전망대|료칸|공원|해수욕장|박물관|미술관|시장|역|마을|섬|산|사찰|한옥|펜션|본점|스테이)$/;
// 문서 제목이 역·행정구역·노래 등 다른 대상이면 버림
const OTHER_KIND = /역$|(특별|광역)?시$|군$|구$|\((가요|노래|영화|드라마|동음이의|[^)]*역|영국|미국|일본|중국)\)$/;

async function fromWiki(p) {
  // 맛집·카페·숙소는 자유 이용 사진이 드물고 이름이 겹치기 쉬워서, 문서 이름이 장소 이름과 똑같을 때만 씀
  const strict = p.type !== '관광지';
  const full = norm(p.name);
  for (const kw of keywordsOf(p)) {
    const core = norm(kw);
    if (core !== full && (core.length < 3 || GENERIC.test(kw.trim()))) continue;
    const j = await wikiGet('ko.wikipedia.org', {
      action: 'query', generator: 'search', gsrsearch: kw, gsrlimit: '5', gsrnamespace: '0',
      prop: 'pageimages|coordinates', piprop: 'name', redirects: '1'
    });
    const pages = (j && j.query && j.query.pages) || [];
    const pick = pages.map(pg => {
      const hasParen = /\(.*\)$/.test(pg.title);
      const t = norm(pg.title.replace(/\s*\(.*\)$/, ''));
      // 0: 장소 이름과 같음, 1: 지역 이름을 뺀 이름과 같음, 2: 장소 이름 안에 문서 제목이 들어 있음, 3: 안 맞음
      const exact = t === full ? 0 : (t === core && core !== full) ? 1 : (t.length >= 3 && full.includes(t) && !GENERIC.test(pg.title)) ? 2 : 3;
      const c = pg.coordinates && pg.coordinates[0];
      const d = c && p.lat != null ? distKm(p, { lat: c.lat, lng: c.lon }) : null;
      return { pg, exact, d, hasParen };
    }).filter(x => {
      if (!x.pg.pageimage || BAD_FILE.test(x.pg.pageimage) || OTHER_KIND.test(x.pg.title)) return false;
      if (x.exact === 3 || (strict && x.exact !== 0)) return false;
      // 둘 다 위치가 있으면 3km 안이어야 함
      if (x.d !== null) return x.d < 3;
      // 위치로 확인할 수 없을 때: 괄호로 구분된 문서(같은 이름의 다른 곳)는 버리고,
      // 장소 위치를 아는데 문서에 위치가 없으면 이름이 똑같고 4글자 이상일 때만
      if (x.hasParen) return false;
      if (p.lat != null) return x.exact === 0 && full.length >= 4;
      return x.exact <= 1;
    }).sort((a, b) => a.exact - b.exact || (a.d || 0) - (b.d || 0))[0];
    if (!pick) continue;
    const rec = await commonsImage(pick.pg.pageimage, pick.pg.title, 'wiki');
    if (rec) return rec;
  }
  return null;
}

// 위키미디어 공용 파일 하나 → 사진 기록 (자유 이용 사진만, 작가·이용 조건 함께)
async function commonsImage(file, page, source) {
  file = String(file).replace(/^File:/, '');
  if (BAD_FILE.test(file)) return null;
  const f = await wikiGet('commons.wikimedia.org', {
    action: 'query', titles: 'File:' + file, prop: 'imageinfo',
    iiprop: 'url|extmetadata', iiurlwidth: '800'
  });
  const pg = f && f.query && f.query.pages && f.query.pages[0];
  const info = pg && pg.imageinfo && pg.imageinfo[0];
  if (!info || !info.thumburl) return null;
  const meta = info.extmetadata || {};
  const license = stripHtml(meta.LicenseShortName && meta.LicenseShortName.value) || '';
  if (!license || /non-free|fair use/i.test(license) || (meta.NonFree && meta.NonFree.value)) return null;
  const artist = stripHtml(meta.Artist && meta.Artist.value).slice(0, 60) || '작가 미상';
  return {
    images: [info.thumburl], source: source, page: page,
    credit: '위키미디어 공용 · ' + artist + ' · ' + license,
    creditUrl: info.descriptionurl
  };
}

/* ---------- 위키데이터 (대표 사진 P18 + 위치 P625) ----------
   위키백과 문서 제목과 이름이 달라도(예: 남산서울타워 ↔ N서울타워) 별칭으로 찾을 수 있음.
   위치가 가까운 항목만 씀 (관광지 3km, 맛집·카페·숙소 0.5km) */
// 시도의 대략 가운데·반경(km): 좌표가 없는 장소는 위키데이터 위치가 그 시도 안쪽인지로만 확인
const REGION_AREA = {
  '서울': [37.56, 126.98, 25], '부산': [35.18, 129.07, 30], '대구': [35.87, 128.60, 30], '인천': [37.46, 126.50, 45],
  '광주': [35.16, 126.85, 20], '대전': [36.35, 127.38, 20], '울산': [35.54, 129.31, 30], '세종': [36.56, 127.26, 20],
  '경기': [37.40, 127.20, 90], '강원': [37.75, 128.30, 130], '충북': [36.75, 127.65, 80], '충남': [36.55, 126.85, 90],
  '전북': [35.72, 127.10, 80], '전남': [34.85, 126.90, 120], '경북': [36.35, 128.75, 130], '경남': [35.30, 128.25, 100],
  '제주': [33.40, 126.55, 50]
};
async function fromWikidata(p) {
  const area = REGION_AREA[p.region];
  // 좌표가 없으면 관광지만 (이름이 겹치는 가게가 많아서)
  if (p.lat == null && (p.type !== '관광지' || !area)) return null;
  const maxKm = p.lat == null ? area[2] : p.type === '관광지' ? 3 : 0.5;
  const at = p.lat == null ? { lat: area[0], lng: area[1] } : p;
  const full = norm(p.name);
  for (const kw of keywordsOf(p)) {
    const core = norm(kw);
    if (core !== full && (core.length < 3 || GENERIC.test(kw.trim()))) continue;
    const s = await wikiGet('www.wikidata.org', {
      action: 'wbsearchentities', search: kw, language: 'ko', uselang: 'ko', type: 'item', limit: '7'
    });
    const ids = ((s && s.search) || []).filter(r => {
      const t = norm((r.match && r.match.text) || r.label);
      return t === full || t === core;
    }).map(r => r.id);
    if (!ids.length) continue;
    const e = await wikiGet('www.wikidata.org', { action: 'wbgetentities', ids: ids.join('|'), props: 'claims|sitelinks' });
    const ents = (e && e.entities) || {};
    const cands = ids.map(id => {
      const c = (ents[id] && ents[id].claims) || {};
      const sl = (ents[id] && ents[id].sitelinks) || {};
      const img = c.P18 && c.P18[0] && c.P18[0].mainsnak.datavalue && c.P18[0].mainsnak.datavalue.value;
      const co = c.P625 && c.P625[0] && c.P625[0].mainsnak.datavalue && c.P625[0].mainsnak.datavalue.value;
      const d = co ? distKm(at, { lat: co.latitude, lng: co.longitude }) : null;
      const wiki = (sl.kowiki && ['ko.wikipedia.org', sl.kowiki.title]) || (sl.enwiki && ['en.wikipedia.org', sl.enwiki.title]) || null;
      return { id, img, d, wiki };
    }).filter(x => (x.img || x.wiki) && x.d !== null && x.d < maxKm).sort((a, b) => a.d - b.d);
    for (const c of cands) {
      let rec = c.img ? await commonsImage(c.img, 'wikidata:' + c.id, 'wikidata') : null;
      // 위키데이터에 대표 사진이 없으면 연결된 위키백과 문서의 대표 사진 (예: N서울타워)
      if (!rec && c.wiki) {
        const w = await wikiGet(c.wiki[0], { action: 'query', titles: c.wiki[1], prop: 'pageimages', piprop: 'name' });
        const pg = w && w.query && w.query.pages && w.query.pages[0];
        if (pg && pg.pageimage) rec = await commonsImage(pg.pageimage, 'wikidata:' + c.id + ' → ' + c.wiki[1], 'wikidata');
      }
      if (rec) return rec;
    }
  }
  return null;
}

/* ---------- 위키미디어 공용 위치 검색 (관광지만) ----------
   장소 좌표 400m 안에서 찍힌 사진 중, 파일 이름에 장소 이름이 들어 있는 것 */
async function fromCommonsGeo(p) {
  if (p.lat == null || p.type !== '관광지') return null;
  const names = keywordsOf(p).map(norm).filter(n => n.length >= 3 && !GENERIC.test(n));
  if (!names.length) return null;
  const j = await wikiGet('commons.wikimedia.org', {
    action: 'query', list: 'geosearch', gsnamespace: '6',
    gscoord: p.lat + '|' + p.lng, gsradius: '400', gslimit: '100'
  });
  const hits = ((j && j.query && j.query.geosearch) || [])
    .filter(g => /\.jpe?g$/i.test(g.title) && !BAD_FILE.test(g.title))
    .filter(g => { const t = norm(g.title); return names.some(n => t.includes(n)); })
    .sort((a, b) => a.dist - b.dist);
  for (const g of hits.slice(0, 3)) {
    const rec = await commonsImage(g.title, g.title, 'commons');
    if (rec) return rec;
  }
  return null;
}

/* ---------- 실행 ---------- */
(async () => {
  const places = loadPlaces();
  const store = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : {};
  const todo = places.filter(p => !(p.images && p.images.length));
  console.log('장소 ' + places.length + '곳 중 사진 없는 곳 ' + todo.length + '곳 확인 중' + (KEY ? '' : ' (인증키 없음: 관광공사는 저장본만)') + '…');
  let n = 0;
  for (const p of todo) {
    const k = keyOf(p);
    const prev = store[k];
    let found = prev && prev.source === 'kto' && !args.recheck ? prev : null;
    try {
      if (!found && !WIKI_ONLY) found = await fromKto(p);
      // 이름이 일부만 겹치는 약한 일치는, 위키미디어에 이름이 똑같은 문서가 있으면 그쪽을 먼저 씀
      if (found && found.weak) { const w = await fromWiki(p); if (w) found = w; }
    } catch (e) {
      if (!(e instanceof LimitError)) throw e;
    }
    if (!found) found = prev && prev.source !== 'kto' && !args.recheck ? prev : await fromWiki(p);
    if (!found) found = await fromWikidata(p);
    if (!found) found = await fromCommonsGeo(p);
    if (found) { store[k] = found; stats[found.source]++; } else { delete store[k]; stats.none++; }
    if (++n % 50 === 0) console.log('  ' + n + '/' + todo.length + ' (관광공사 ' + stats.kto + ', 위키 ' + stats.wiki + ')');
  }
  // 지금 장소 목록에 없는 기록은 지움
  const live = new Set(todo.map(keyOf));
  Object.keys(store).forEach(k => { if (!live.has(k)) delete store[k]; });
  fs.writeFileSync(STORE, JSON.stringify(store, null, 1));
  const out = {};
  Object.keys(store).sort().forEach(k => {
    const s = store[k];
    out[k] = { images: s.images, credit: s.credit };
    if (s.creditUrl) out[k].creditUrl = s.creditUrl;
  });
  fs.writeFileSync(OUT, '/* 사진이 없는 장소에 붙이는 사진 (tools/build-photos.js가 만듦, 직접 고치지 마세요)\n' +
    '   출처: 한국관광공사, 위키미디어 공용(자유 이용 사진, 작가·이용 조건 표시)\n' +
    '   만든 날: ' + new Date().toISOString().slice(0, 10) + ' / ' + Object.keys(out).length + '곳 */\n' +
    'window.GUIDE_PHOTOS = ' + JSON.stringify(out) + ';\n');
  console.log('\n사진 찾음: 관광공사 ' + stats.kto + '곳, 위키백과 ' + stats.wiki + '곳, 위키데이터 ' + stats.wikidata + '곳, 공용 위치검색 ' + stats.commons + '곳 / 못 찾음 ' + stats.none + '곳');
  const missing = todo.filter(p => !store[keyOf(p)]).map(p => p.name + '/' + p.region + '(' + p.type + ')');
  fs.writeFileSync(path.join(__dirname, 'photos-missing.txt'), missing.join('\n') + '\n');
  console.log('아직 사진 없는 곳 목록: tools/photos-missing.txt');
  console.log('호출: 새로 ' + stats.calls + '회, 저장본 ' + stats.cached + '회' + (stats.limitHit ? ' / ⚠️ 관광공사 하루 한도 도달 (내일 다시 실행하면 이어서 받아요)' : ''));
})();
