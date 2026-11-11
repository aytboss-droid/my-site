#!/usr/bin/env node
/* =========================================================
   관광공사 데이터 + 요즘 핫플 목록 → js/places.js 만들기

   사용법 (PowerShell):
     $env:TOUR_API_KEY = "공공데이터포털 일반 인증키(Decoding)"
     node tools/build-places.js

   옵션:
     --perArea=2   시·군·구마다 인기 순위 몇 위까지 넣을지 (기본 2)
     --max=900     최대 장소 수 (기본 900)
     --offline     인터넷 호출 없이 저장해 둔 응답(cache)으로만 다시 만들기

   사용하는 데이터 (공공데이터포털, 둘 다 같은 인증키):
     - 한국관광공사_기초지자체 중심 관광지 정보 (LocgoHubTarService1)
       → 티맵 내비게이션 기록 기반 시·군·구별 인기 관광지 순위
     - 한국관광공사_국문 관광정보 서비스_GW (KorService2)
       → 주소, 좌표, 소개글, 운영 시간, 요금, 대표 사진
   요즘 핫플 목록: tools/hot_places.json (기사·블로그에서 자주 소개되는 곳)

   - 받은 응답은 tools/cache/ 에 저장해서, 하루 호출 한도(서비스별 1,000회)를
     넘겨도 다음 날 다시 실행하면 이어서 받습니다.
   - 인증키는 화면이나 파일에 남기지 않습니다.
   ========================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(__dirname, 'cache');
const OUT = path.join(ROOT, 'js', 'places.js');
const HOT = path.join(__dirname, 'hot_places.json');
const REPORT = path.join(__dirname, 'build-report.txt');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const PER_AREA = Number(args.perArea || 2);
const MAX = Number(args.max || 900);
const OFFLINE = !!args.offline;
const IS_MAIN = require.main === module;
const KEY = process.env.TOUR_API_KEY || args.key || '';
if (!KEY && !OFFLINE && IS_MAIN) {
  console.error('인증키가 없어요. 먼저 $env:TOUR_API_KEY = "인증키" 를 실행하세요.');
  process.exit(1);
}

const KOR = 'https://apis.data.go.kr/B551011/KorService2/';
const HUB = 'https://apis.data.go.kr/B551011/LocgoHubTarService1/';
const COMMON = { MobileOS: 'WEB', MobileApp: 'TravelGuide', _type: 'json' };

fs.mkdirSync(CACHE, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stats = { calls: 0, cached: 0, failed: 0, limitHit: false };

class LimitError extends Error {}

/* ---------- API 호출 (저장해 둔 응답이 있으면 그것을 씀) ---------- */
async function api(base, op, params) {
  const q = new URLSearchParams({ ...COMMON, ...params });
  const cacheKey = crypto.createHash('md5').update(base + op + '?' + q.toString()).digest('hex');
  const file = path.join(CACHE, op + '-' + cacheKey + '.json');
  if (fs.existsSync(file)) { stats.cached++; return JSON.parse(fs.readFileSync(file, 'utf8')); }
  if (OFFLINE || stats.limitHit) return null;

  const url = base + op + '?serviceKey=' + encodeURIComponent(KEY) + '&' + q.toString();
  let text = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      stats.calls++;
      const res = await fetch(url);
      text = await res.text();
      break;
    } catch (e) {
      await sleep(800 * (attempt + 1));
    }
  }
  if (!text.trim().startsWith('{') && /LIMITED_NUMBER_OF_SERVICE_REQUESTS|한도|exceeds/i.test(text)) {
    stats.limitHit = true;
    throw new LimitError('하루 호출 한도를 넘었어요.');
  }
  if (/SERVICE_KEY_IS_NOT_REGISTERED|SERVICE ACCESS DENIED|등록되지 않은|Unauthorized/i.test(text)) {
    throw new Error('인증키가 등록되지 않았거나 이 서비스에 활용신청이 안 됐어요 (' + op + '). 신청 직후라면 1시간쯤 뒤에 다시 해 보세요.');
  }
  let json;
  try { json = JSON.parse(text); } catch (e) { stats.failed++; return null; }
  const code = json && json.response && json.response.header && json.response.header.resultCode;
  if (code && code !== '0000' && code !== '00') {
    if (code === '22') { stats.limitHit = true; throw new LimitError('하루 호출 한도를 넘었어요.'); }
    if (code === '03') { fs.writeFileSync(file, JSON.stringify(json)); return json; } // 데이터 없음도 저장
    stats.failed++;
    return null;
  }
  fs.writeFileSync(file, JSON.stringify(json));
  await sleep(60);
  return json;
}
function items(json) {
  const it = json && json.response && json.response.body && json.response.body.items;
  if (!it || !it.item) return [];
  return Array.isArray(it.item) ? it.item : [it.item];
}

/* ---------- 글 다듬기 ---------- */
function clean(s, max) {
  if (!s) return '';
  let t = String(s)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  if (max && t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf('다.'), cut.lastIndexOf('요.'), cut.lastIndexOf('. '));
    t = (end > max * 0.5 ? cut.slice(0, end + 2) : cut.replace(/\s+\S*$/, '') + '…').trim();
  }
  return t;
}
function firstSentence(s, max) {
  const t = clean(s).replace(/\n/g, ' ');
  const m = t.match(/^(.{8,}?(다|요)\.)/);
  let f = m ? m[1] : t;
  if (f.length > max) f = f.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return f;
}
const norm = s => String(s || '').replace(/[\s()·\-_.,'"]/g, '').replace(/\[.*?\]/g, '').toLowerCase();
function slug(s) { return crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 8); }

/* ---------- 지역 이름 ---------- */
function regionName(n) {
  n = String(n || '');
  const pairs = [['서울', '서울'], ['부산', '부산'], ['대구', '대구'], ['인천', '인천'], ['광주', '광주'], ['대전', '대전'],
    ['울산', '울산'], ['세종', '세종'], ['경기', '경기'], ['강원', '강원'], ['충청북', '충북'], ['충북', '충북'],
    ['충청남', '충남'], ['충남', '충남'], ['전북', '전북'], ['전라북', '전북'], ['전라남', '전남'], ['전남', '전남'],
    ['경상북', '경북'], ['경북', '경북'], ['경상남', '경남'], ['경남', '경남'], ['제주', '제주']];
  for (const [k, v] of pairs) if (n.indexOf(k) !== -1) return v;
  return '';
}
// 2026년 광주광역시와 전라남도가 '전남광주통합특별시'(코드 12)로 합쳐짐.
// 여행자가 알아보기 쉽게 사이트에서는 광주(옛 광주광역시 5개 구)와 전남으로 나눠 보여 줌
const GWANGJU_GU = ['동구', '서구', '남구', '북구', '광산구'];
const splitGJ = sgg => (GWANGJU_GU.indexOf(String(sgg || '').trim()) !== -1 ? '광주' : '전남');
function regionFromAddr(addr) {
  const m = String(addr || '').trim().match(/^(\S+)\s+(\S+)/);
  if (!m) return regionName(addr);
  if (/통합특별시/.test(m[1])) return splitGJ(m[2]);
  return regionName(m[1]);
}
function regionOfItem(it) {
  const code = String(it.lDongRegnCd || '');
  if (code === '12') return regionFromAddr(it.addr1) || '';
  return SIDO[code] || regionFromAddr(it.addr1);
}
// 법정동 시도 코드 (관광공사 법정동코드 기준)
const SIDO = { '11': '서울', '26': '부산', '27': '대구', '28': '인천', '29': '광주', '30': '대전', '31': '울산', '36': '세종',
  '41': '경기', '51': '강원', '42': '강원', '43': '충북', '44': '충남', '52': '전북', '45': '전북', '46': '전남',
  '47': '경북', '48': '경남', '50': '제주' };

/* ---------- 종류·테마·그림 정하기 ---------- */
function decideType(contentTypeId, title, hint) {
  const t = String(title || '');
  if (/카페|커피|coffee|cafe|베이커리|빵집|제과|브레드|찻집|다원|티하우스|디저트/i.test(t)) return '카페';
  if (String(contentTypeId) === '32' || /호텔|리조트|펜션|스테이|게스트하우스|한옥숙소|콘도/.test(t)) return '숙소';
  if (String(contentTypeId) === '39') return '맛집';
  if (hint) return hint;
  return '관광지';
}
const METRO = ['서울', '부산', '대구', '인천', '광주', '대전', '울산'];
function decideThemes(p, text) {
  const s = (p.name + ' ' + (text || '')).replace(/\s+/g, ' ');
  const th = new Set();
  // 바닷가: 이름과 소개 앞부분만 봄 (긴 소개 속 '바다'·'섬' 한 단어로 내륙 장소가 잘못 분류되지 않게)
  const head = (p.name + ' ' + String(text || '').slice(0, 120));
  if (/해수욕장|해변|해안|항구|포구|등대|갯벌|해상|오션|바닷가/.test(head) ||
      (/바다/.test(head) && !/강변|호수|저수지/.test(p.name)) ||
      /(^|\s)[가-힣]{1,4}도$|[가-힣]섬$/.test(p.name) && !/무섬|경천섬|하중도|남이섬|강/.test(p.name)) th.add('바닷가');
  if (/산|숲|수목원|휴양림|계곡|폭포|오름|정원|공원|둘레길|생태|습지|호수/.test(p.name) || /수목원|휴양림|계곡|등산|숲길|오름/.test(s)) th.add('산·숲');
  if (METRO.includes(p.region) && !th.has('산·숲') || /시장|거리|타워|광장|골목|도심|번화가|백화점/.test(p.name)) th.add('도심지');
  if (/체험|어린이|아이|가족|동물원|아쿠아리움|과학관|박물관|놀이|키즈|테마파크|목장|농장/.test(s)) th.add('아이와 함께');
  if (/야경|노을|데이트|연인|전망|카페|드라이브|산책로|해변|정원|포토|커플|낭만/.test(s) || p.type === '카페' || p.type === '숙소') th.add('연인과 함께');
  if (p.hot) th.add('요즘 핫플');
  if (!th.size) th.add('아이와 함께');
  return Array.from(th);
}
function decideEmojis(p) {
  const n = p.name + ' ' + (p.keywords || []).join(' ');
  const pick = [
    [/해수욕장|해변|바다/, ['🏖️', '🌊', '🐚']], [/섬|등대|항|포구/, ['🏝️', '⚓', '🌊']],
    [/궁|성곽|산성|왕릉|고분|읍성|향교|서원/, ['🏯', '🏛️', '🍂']], [/사$|사찰|암$|절/, ['🛕', '🌲', '🔔']],
    [/박물관|미술관|전시|기념관|과학관/, ['🏛️', '🖼️', '🎟️']], [/수목원|정원|꽃|식물원/, ['🌷', '🌳', '🌸']],
    [/산|오름|봉$|숲|휴양림|계곡/, ['⛰️', '🌲', '🥾']], [/폭포|호수|강|저수지|댐/, ['🏞️', '💧', '🌿']],
    [/시장/, ['🛍️', '🍢', '🏮']], [/마을|골목|거리|길$/, ['🏘️', '🚶', '📸']], [/타워|전망대|스카이/, ['🗼', '🌃', '🔭']],
    [/동물원|아쿠아|목장|농장/, ['🐠', '🦁', '🐑']], [/테마파크|랜드|월드|놀이/, ['🎢', '🎡', '🎠']],
    [/공원/, ['🌳', '🚲', '🌼']], [/케이블카|레일바이크|루지|짚라인/, ['🚡', '🛤️', '🎢']]
  ];
  if (p.type === '맛집') return ['🍽️', '🥢', '🍲'];
  if (p.type === '카페') return ['☕', '🍰', '🥐'];
  if (p.type === '숙소') return ['🏨', '🛏️', '🌙'];
  for (const [re, e] of pick) if (re.test(n)) return e;
  return ['📍', '🗺️', '📸'];
}
// 여행지로 보기 어려운 곳 (쇼핑몰·교통·관공서 등)은 인기 순위에 있어도 뺌
const SKIP_NAME = /휴게소|주차장|터미널|IC$|톨게이트|아울렛|이마트|홈플러스|코스트코|롯데마트|하나로마트|트레이더스|병원|주유소|역$|시청$|구청$|군청$|도청$|대학교$|초등학교|중학교|고등학교|아파트|산업단지|백화점|쇼핑몰|면세점|몰$|스타필드|모다|NC|뉴코아|현대시티|롯데월드몰|아이파크몰|타임스퀘어|웨딩|장례|추모공원|공원묘지|골프|CC$|컨트리클럽|교회$|성당$|시외버스|고속버스|공항$|항만|여객터미널|물류|청사$|CGV|롯데시네마|메가박스|시네마|영화관|씨네|컨벤션|웨딩홀|예식장/;
const SKIP_CAT = /쇼핑|교통|숙박시설기타/;

/* ---------- 관광공사 상세 정보 붙이기 ---------- */
function pickHours(intro, typeId) {
  if (!intro) return {};
  const g = k => clean(intro[k], 140);
  switch (String(typeId)) {
    case '12': return { hours: g('usetime'), closed: g('restdate'), price: '' };
    case '14': return { hours: g('usetimeculture'), closed: g('restdateculture'), price: g('usefee') };
    case '28': return { hours: g('usetimeleports'), closed: g('restdateleports'), price: g('usefeeleports') };
    case '32': return { hours: ['입실 ' + g('checkintime'), '퇴실 ' + g('checkouttime')].filter(x => x.length > 3).join(' / '), closed: '', price: '' };
    case '38': return { hours: g('opentime'), closed: g('restdateshopping'), price: '' };
    case '39': return { hours: g('opentimefood'), closed: g('restdatefood'), price: g('firstmenu') ? '대표 메뉴: ' + g('firstmenu') : '' };
    default: return {};
  }
}
async function enrich(base) {
  // base: { name, region, lat, lng, hint } → 관광공사 콘텐츠 찾기
  // 'A/B' 형태 이름(예: 롯데호텔/부산점)은 'A B'로, 그래도 없으면 앞부분만으로 다시 찾기
  const raw0 = base.rawName || base.name;
  const keywords = Array.from(new Set([raw0, raw0.split('/')[0], base.name].map(s => s.trim()).filter(Boolean)));
  let raw = [];
  for (const kw of keywords) {
    raw = items(await api(KOR, 'searchKeyword2', { keyword: kw, numOfRows: 20, pageNo: 1, arrange: 'A' }));
    if (raw.length) break;
  }
  let cands = raw.filter(it => !base.region || regionOfItem(it) === base.region);
  const target = norm(base.name);
  const dist = it => (base.lat && it.mapy) ? Math.hypot((+it.mapy - base.lat) * 111, (+it.mapx - base.lng) * 88) : 0;
  cands = cands
    .map(it => ({ it, exact: norm(it.title) === target ? 0 : (norm(it.title).includes(target) || target.includes(norm(it.title)) ? 1 : 2), d: dist(it) }))
    .filter(x => x.exact < 2 && x.d < 5)
    .sort((a, b) => a.exact - b.exact || a.d - b.d);
  if (!cands.length) return null;
  const it = cands[0].it;
  const common = items(await api(KOR, 'detailCommon2', { contentId: it.contentid }))[0] || {};
  const intro = items(await api(KOR, 'detailIntro2', { contentId: it.contentid, contentTypeId: it.contenttypeid }))[0] || null;
  return { it, common, intro };
}

/* ---------- 1) 시·군·구 목록 ---------- */
async function sigunguList() {
  let list = items(await api(KOR, 'ldongCode2', { numOfRows: 1000, pageNo: 1, lDongListYn: 'Y' }))
    .filter(x => x.lDongSignguCd)
    .map(x => ({ sido: String(x.lDongRegnCd), sidoNm: x.lDongRegnNm, sgg: String(x.lDongSignguCd), sggNm: x.lDongSignguNm }));
  if (!list.length) {
    for (const sido of Object.keys(SIDO)) {
      const r = items(await api(KOR, 'ldongCode2', { numOfRows: 100, pageNo: 1, lDongRegnCd: sido }));
      r.forEach(x => list.push({ sido, sidoNm: SIDO[sido], sgg: String(x.code || x.lDongSignguCd), sggNm: x.name || x.lDongSignguNm }));
    }
  }
  return list;
}

/* ---------- 2) 시·군·구별 인기 관광지 순위 ---------- */
// 처음 성공한 기준월·코드 형식을 기억해서 다음부터는 한 번만 호출 (하루 호출 한도 절약)
let hubMode = null;
async function hubTop(sgg, months) {
  const forms = [s => s.sido + s.sgg, s => s.sgg];
  if (hubMode) {
    const r = items(await api(HUB, 'areaBasedList1', { numOfRows: 30, pageNo: 1, baseYm: hubMode.ym, areaCd: sgg.sido, signguCd: forms[hubMode.form](sgg) }));
    return r;
  }
  for (const ym of months) {
    for (let f = 0; f < forms.length; f++) {
      const r = items(await api(HUB, 'areaBasedList1', { numOfRows: 30, pageNo: 1, baseYm: ym, areaCd: sgg.sido, signguCd: forms[f](sgg) }));
      if (r.length) { hubMode = { ym, form: f }; console.log('  기준월 ' + ym + ' 데이터를 사용해요.'); return r; }
    }
  }
  return [];
}
function recentMonths(n) {
  const out = []; const d = new Date();
  for (let i = 1; i <= n; i++) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(x.getFullYear() + String(x.getMonth() + 1).padStart(2, '0'));
  }
  return out;
}

/* ---------- 실행 ---------- */
async function main() {
  const places = [];
  const seen = new Set();
  const log = [];
  // data.js에 직접 쓴 장소 이름도 미리 등록 (같은 곳이 두 번 들어가지 않게)
  try {
    global.window = global.window || {};
    delete require.cache[require.resolve(path.join(ROOT, 'js', 'data.js'))];
    require(path.join(ROOT, 'js', 'data.js'));
    (global.window.GUIDE_DATA.PLACES || []).forEach(p => seen.add(norm(p.name) + '|' + p.region));
  } catch (e) { /* data.js를 못 읽어도 계속 */ }

  const add = p => {
    const key = norm(p.name) + '|' + p.region;
    if (seen.has(key) || places.length >= MAX) return false;
    // 500m 안에 이름이 겹치는 장소가 있으면 같은 곳으로 보고 뺌 (예: '양림동 펭귄마을'과 '펭귄마을')
    const n = norm(p.name);
    const dup = places.some(o => {
      if (o.region !== p.region) return false;
      // 이름이 달라도 같은 종류가 150m 안에 있으면 같은 곳 (예: '신라호텔 서울'과 '서울신라호텔')
      if (o.lat && p.lat && o.type === p.type && Math.hypot((o.lat - p.lat) * 111, (o.lng - p.lng) * 88) < 0.15) return true;
      const on = norm(o.name);
      if (!(on.includes(n) || n.includes(on))) return false;
      if (!(o.lat && p.lat)) return true;
      return Math.hypot((o.lat - p.lat) * 111, (o.lng - p.lng) * 88) < 0.5;
    });
    if (dup) return false;
    seen.add(key); places.push(p); return true;
  };
  function toPlace(base, found) {
    const it = found && found.it, common = (found && found.common) || {};
    const typeId = it && it.contenttypeid;
    const name = base.name;
    const p = {
      id: it ? 'kto-' + it.contentid : (base.hubCd ? 'hub-' + base.hubCd : 'hot-' + slug(name + base.region)),
      name,
      type: decideType(typeId, name, base.hint),
      region: base.region,
      hot: !!base.hot,
      rank: base.rank || undefined
    };
    const lat = it && +it.mapy ? +it.mapy : base.lat, lng = it && +it.mapx ? +it.mapx : base.lng;
    if (lat && lng) { p.lat = Math.round(lat * 1e5) / 1e5; p.lng = Math.round(lng * 1e5) / 1e5; }
    const overview = common.overview || '';
    const rankText = base.rank ? (base.city || base.region) + ' 인기 순위 ' + base.rank + '위' : '';
    p.summary = base.why || firstSentence(overview, 60) ||
      (rankText ? rankText + (base.cat ? ' · ' + base.cat : '') : (base.city ? base.city + '의 인기 ' + p.type : '인기 ' + p.type));
    p.description = [
      base.why && overview ? '요즘 인기: ' + base.why : '',
      clean(overview, 420),
      !overview && rankText ? rankText + '에 오른 곳이에요. 한국관광공사가 티맵 내비게이션 기록으로 집계한, 이 지역에서 다른 관광지와 함께 가장 많이 찾는 곳이에요.' : ''
    ].filter(Boolean).join('\n') || (base.why ? base.why : '여행자들이 많이 찾는 곳이에요.');
    p.address = clean((it && (it.addr1 + ' ' + (it.addr2 || ''))) || base.city || '', 80) || base.region;
    p.mapQuery = name;
    const h = pickHours(found && found.intro, typeId);
    p.hours = h.hours || '방문 전 확인';
    p.closed = h.closed || '방문 전 확인';
    p.price = h.price || '방문 전 확인';
    if (common.homepage) {
      const m = String(common.homepage).match(/href="([^"]+)"/);
      if (m) p.homepage = m[1];
    }
    p.keywords = Array.from(new Set([...(base.keywords || []), base.city, base.cat].filter(Boolean)));
    const img = (it && (it.firstimage || it.firstimage2)) || common.firstimage || '';
    p.images = img ? [img.replace(/^http:\/\//, 'https://')] : [];
    if (img) p.credit = '한국관광공사';
    p.source = it ? '한국관광공사 관광정보' : (base.hot ? '기사·블로그 인기 목록' : '한국관광공사 중심관광지');
    p.emojis = decideEmojis(p);
    p.themes = decideThemes(p, overview + ' ' + (base.why || '') + ' ' + (base.keywords || []).join(' '));
    return p;
  }

  try {
    // ① 요즘 핫플 (먼저 넣어서 우선 반영)
    const hot = fs.existsSync(HOT) ? JSON.parse(fs.readFileSync(HOT, 'utf8')) : [];
    console.log('요즘 핫플 목록 ' + hot.length + '곳 확인 중…');
    for (const h of hot) {
      const region = regionName(h.region);
      if (!region || !h.name) continue;
      const base = { name: h.name, region, city: h.city, why: h.why, keywords: h.keywords, hint: h.type, hot: true };
      const found = await enrich(base);
      add(toPlace(base, found));
      if (!found) log.push('핫플(관광공사 자료 없음): ' + h.name + ' / ' + region);
    }

    // ② 시·군·구별 인기 순위
    const sggs = await sigunguList();
    console.log('시·군·구 ' + sggs.length + '곳의 인기 관광지 순위 받는 중…');
    const months = recentMonths(4);
    const hubCands = [];
    for (const s of sggs) {
      const region = s.sido === '12' ? splitGJ(s.sggNm) : (SIDO[s.sido] || regionName(s.sidoNm));
      if (!region) continue;
      const top = (await hubTop(s, months))
        .filter(x => x.hubTatsNm && !SKIP_NAME.test(x.hubTatsNm) && !SKIP_CAT.test((x.hubCtgryMclsNm || '') + ' ' + (x.hubCtgryLclsNm || '')))
        .sort((a, b) => (+a.hubRank) - (+b.hubRank))
        .slice(0, PER_AREA);
      top.forEach(x => hubCands.push({
        name: x.hubTatsNm.trim().replace(/\s*\/\s*/g, ' '), rawName: x.hubTatsNm.trim(), region, city: s.sggNm, rank: +x.hubRank, hubCd: x.hubTatsCd,
        lat: +x.mapY || null, lng: +x.mapX || null, cat: x.hubCtgryMclsNm || x.hubCtgryLclsNm,
        hint: /음식/.test(x.hubCtgryLclsNm || '') ? '맛집' : /숙박/.test(x.hubCtgryLclsNm || '') ? '숙소' : '관광지'
      }));
    }
    // 순위 1위끼리 먼저, 그다음 2위… 순서로 넣어서 지역이 고르게 섞이도록
    hubCands.sort((a, b) => a.rank - b.rank);
    console.log('인기 관광지 후보 ' + hubCands.length + '곳 상세 정보 받는 중…');
    for (const c of hubCands) {
      if (places.length >= MAX) break;
      if (seen.has(norm(c.name) + '|' + c.region)) continue;
      const found = await enrich(c);
      add(toPlace(c, found));
    }
  } catch (e) {
    if (e instanceof LimitError) console.warn('⚠️ ' + e.message + ' 지금까지 받은 것으로 파일을 만들고, 내일 다시 실행하면 이어서 받아요.');
    else { console.error('오류: ' + e.message); if (!places.length) process.exit(1); }
  }

  // 결과 저장
  const header = '/* 자동 생성 파일: tools/build-places.js 로 만듦. 직접 고치지 말고 data.js에 장소를 추가하세요.\n' +
    '   출처: 한국관광공사 TourAPI(국문 관광정보, 기초지자체 중심 관광지 정보), 기사·블로그 인기 목록\n' +
    '   만든 날: ' + new Date().toISOString().slice(0, 10) + ' / 장소 ' + places.length + '곳 */\n';
  fs.writeFileSync(OUT, header + 'window.GUIDE_PLACES_EXTRA = ' + JSON.stringify(places, null, 0).replace(/},{/g, '},\n{') + ';\n');

  const byRegion = {}, byType = {};
  places.forEach(p => { byRegion[p.region] = (byRegion[p.region] || 0) + 1; byType[p.type] = (byType[p.type] || 0) + 1; });
  const report = [
    '만든 날: ' + new Date().toISOString(),
    '장소 수: ' + places.length + ' (사진 있는 곳 ' + places.filter(p => p.images.length).length + ', 좌표 있는 곳 ' + places.filter(p => p.lat).length + ', 요즘 핫플 ' + places.filter(p => p.hot).length + ')',
    '지역별: ' + JSON.stringify(byRegion),
    '종류별: ' + JSON.stringify(byType),
    'API 호출: 새로 ' + stats.calls + '회 / 저장본 사용 ' + stats.cached + '회 / 실패 ' + stats.failed + '회' + (stats.limitHit ? ' / ⚠️ 하루 한도 도달' : ''),
    '',
    ...log
  ].join('\n');
  fs.writeFileSync(REPORT, report);
  console.log('\n' + report.split('\n').slice(0, 6).join('\n'));
  console.log('\n→ ' + path.relative(ROOT, OUT) + ' 저장 완료');
}

if (IS_MAIN) main();
module.exports = { api, items, stats, LimitError, clean, firstSentence, norm, slug, regionName, regionFromAddr, regionOfItem, splitGJ, SIDO,
  decideType, decideThemes, decideEmojis, SKIP_NAME, SKIP_CAT, pickHours, KOR, CACHE };

