/* =========================================================
   여행 가이드 - 기능
   골라 보기 / 검색 / 찜하기 / 공유하기 / 디자인 바꾸기
   (장소 내용은 js/data.js 에서 고칩니다)
   ========================================================= */
(function () {
  'use strict';

  var D = window.GUIDE_DATA;
  var ALL = '전체';
  var PAGE_SIZE = 24; // 목록에 한 번에 보여 줄 카드 수

  /* ---------- 장소 합치기 ----------
     data.js에 직접 쓴 장소 + js/places.js(관광공사 데이터·요즘 핫플로 만든 장소)를 합침.
     이름이 같으면 직접 쓴 장소를 우선함 */
  (function mergePlaces() {
    // places.js(인기 순위·요즘 핫플) 다음에 places-more.js(지역별로 더 넓게 고른 장소)를 이어 붙임
    var extra = (window.GUIDE_PLACES_EXTRA || []).concat(window.GUIDE_PLACES_MORE || []);
    var norm = function (s) { return String(s || '').replace(/[\s()·\-]/g, '').toLowerCase(); };
    var seenName = {}, seenId = {};
    D.PLACES.forEach(function (p) { seenName[norm(p.name) + '|' + p.region] = 1; seenId[p.id] = 1; p.curated = true; });
    extra.forEach(function (p) {
      var key = norm(p.name) + '|' + p.region;
      if (seenName[key] || seenId[p.id]) return;
      seenName[key] = 1; seenId[p.id] = 1;
      D.PLACES.push(p);
    });
    // 사진이 없는 장소에 js/photos.js의 사진 붙이기 (관광공사·위키미디어 공용, tools/build-photos.js가 만듦)
    var photos = window.GUIDE_PHOTOS || {};
    D.PLACES.forEach(function (p) {
      if (p.images && p.images.length) return;
      var ph = photos[String(p.name).replace(/\s+/g, '') + '|' + p.region];
      if (!ph || !ph.images || !ph.images.length) return;
      p.images = ph.images.slice();
      p.credit = ph.credit;
      if (ph.creditUrl) p.creditUrl = ph.creditUrl;
    });
    // 기본 순서: 직접 고른 곳 → 요즘 핫플 → 인기 순위 높은 곳
    D.PLACES.forEach(function (p, i) { p._order = i; });
    D.PLACES.sort(function (a, b) {
      // 사진이 있는 곳을 먼저 (사진이 아직 없는 곳은 그림으로 보이니 뒤로)
      var hasImg = function (p) { return p.images && p.images.length ? 0 : 3; };
      var sa = (a.curated ? 0 : a.hot ? 1 : 2) + hasImg(a), sb = (b.curated ? 0 : b.hot ? 1 : 2) + hasImg(b);
      if (sa !== sb) return sa - sb;
      return (a.rank || 999) - (b.rank || 999) || a._order - b._order;
    });
  })();
  var PLACE_BY_ID = {};
  D.PLACES.forEach(function (p) { PLACE_BY_ID[p.id] = p; });
  var shownCount = PAGE_SIZE;
  var sortMode = 'rec';  // rec: 추천순, near: 가까운 순, name: 이름순
  var userPos = null;    // 가까운 순일 때 내 위치 { lat, lng }
  // themes는 여러 개를 함께 고를 수 있어서 목록(배열)으로 보관. 비어 있으면 "전체"
  var state = { region: ALL, themes: [], type: ALL, q: '' };
  var homeScrollY = 0;
  var navigatedInApp = false;

  /* ---------- 저장 (브라우저에 보관, 실패해도 사이트는 동작) ---------- */
  var store = {
    get: function (key, fallback) {
      try {
        var v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    }
  };
  var favs = store.get('guide.favs', []);
  if (!Array.isArray(favs)) favs = [];
  // 다녀온 뒤 점검 기록: { 장소 id: { visited: true/false/null, info: 'ok'/'wrong'/null, wrong: ['hours',...], memo, date, trip, at } }
  var checks = store.get('guide.checks', {});
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) checks = {};

  /* ---------- 도우미 ---------- */
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function findPlace(id) {
    return PLACE_BY_ID[id] || null;
  }
  function typeInfo(name) {
    for (var i = 0; i < D.TYPES.length; i++) if (D.TYPES[i].name === name) return { idx: i, icon: D.TYPES[i].icon };
    return { idx: 0, icon: '📍' };
  }
  function themeInfo(name) {
    for (var i = 0; i < D.THEMES.length; i++) if (D.THEMES[i].name === name) return D.THEMES[i];
    return { name: name, icon: '', bg: '', text: '' };
  }
  function isFav(id) { return favs.indexOf(id) !== -1; }

  var toastTimer;
  // action: { label: '일정 보기', onClick: function } 을 주면 알림 안에 버튼이 생김
  function toast(msg, action) {
    var el = $('#toast');
    el.textContent = msg;
    if (action) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-action';
      b.textContent = action.label;
      b.addEventListener('click', function () { el.classList.remove('show'); action.onClick(); });
      el.appendChild(b);
    }
    el.classList.toggle('has-action', !!action);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, action ? 4000 : 2000);
  }

  /* ---------- 공통 조각 ---------- */
  function photoHTML(p, i) {
    var t = typeInfo(p.type);
    var src = p.images && p.images[i];
    var emojis = p.emojis && p.emojis.length ? p.emojis : [t.icon];
    if (src) {
      // 사진을 임시 그림 위에 겹쳐 둠. 인터넷이 없거나 사진을 못 불러오면 사진이 빠지고 그림이 보임
      return '<div class="photo has-img ph-' + (t.idx % 4) + '">' +
        '<span class="ph-emoji" aria-hidden="true">' + esc(emojis[i % emojis.length]) + '</span>' +
        '<img src="' + esc(src) + '" alt="' + esc(p.name) + ' 사진 ' + (i + 1) + '" loading="lazy" decoding="async" ' +
        'referrerpolicy="no-referrer" onerror="this.remove()"></div>';
    }
    return '<div class="photo ph-' + (t.idx % 4) + '" role="img" aria-label="' + esc(p.name) + ' 임시 사진">' +
      '<span class="ph-emoji" aria-hidden="true">' + esc(emojis[i % emojis.length]) + '</span></div>';
  }

  function themeTagsHTML(themes) {
    return (themes || []).map(function (name) {
      var th = themeInfo(name);
      var style = th.bg ? ' style="--tag-bg:' + esc(th.bg) + ';--tag-text:' + esc(th.text) + '"' : '';
      return '<span class="tag"' + style + '>' + esc(th.icon) + ' ' + esc(name) + '</span>';
    }).join('');
  }

  function favBtnHTML(p) {
    var on = isFav(p.id);
    return '<button class="fav-btn" type="button" data-fav="' + esc(p.id) + '" aria-pressed="' + on + '" ' +
      'aria-label="' + esc(p.name) + ' 찜하기">' + (on ? '♥' : '♡') + '</button>';
  }

  function cardHTML(p) {
    var t = typeInfo(p.type);
    var dist = (sortMode === 'near' && userPos) ? distKm(userPos, p) : null;
    return '<article class="card">' +
      (dist !== null ? '<span class="dist-badge">' + fmtKm(dist) + '</span>' : '') +
      '<a class="card-link" href="#/place/' + encodeURIComponent(p.id) + '">' +
        photoHTML(p, 0) +
        '<div class="card-body">' +
          '<div class="card-meta"><span class="type-badge">' + esc(t.icon) + ' ' + esc(p.type) + '</span>' +
          (p.hot ? '<span class="hot-badge">🔥 핫플</span>' : '') +
          '<span>' + esc(p.region) + '</span></div>' +
          '<h3 class="card-title">' + esc(p.name) + '</h3>' +
          '<p class="card-summary">' + esc(p.summary) + '</p>' +
          '<div class="tags">' + themeTagsHTML(p.themes) + '</div>' +
        '</div>' +
      '</a>' +
      favBtnHTML(p) +
    '</article>';
  }

  /* ---------- ① 홈: 골라 보기 + 검색 ---------- */
  // 이 버튼이 지금 눌려 있는지
  function chipOn(key, value) {
    if (key === 'themes') return value === ALL ? state.themes.length === 0 : state.themes.indexOf(value) !== -1;
    return state[key] === value;
  }

  function chipBtn(key, value, text) {
    return '<button class="chip" type="button" data-key="' + key + '" data-value="' + esc(value) + '" ' +
      'aria-pressed="' + chipOn(key, value) + '">' + esc(text) +
      (key === 'region' ? ' <span class="chip-count">0</span>' : '') + '</button>';
  }

  // 권역 묶음 (data.js의 REGION_GROUPS, 빠진 지역은 '기타')
  function regionGroups() {
    var groups = (D.REGION_GROUPS || []).map(function (g) {
      return { name: g.name, regions: g.regions.filter(function (r) { return D.REGIONS.indexOf(r) !== -1; }) };
    }).filter(function (g) { return g.regions.length; });
    var used = [];
    groups.forEach(function (g) { used = used.concat(g.regions); });
    var others = D.REGIONS.filter(function (r) { return used.indexOf(r) === -1; });
    if (others.length) groups.push({ name: groups.length ? '기타' : '', regions: others });
    return groups;
  }

  function renderFilters() {
    var region =
      '<div class="filter-sec" role="group" aria-label="지역 고르기">' +
        '<h3 class="filter-title">지역</h3>' +
        '<div class="chips">' + chipBtn('region', ALL, '전체 지역') + '</div>' +
        '<div class="region-groups">' +
        regionGroups().map(function (g) {
          return '<div class="region-group"><span class="region-group-name">' + esc(g.name) + '</span>' +
            '<div class="region-chips">' + g.regions.map(function (r) { return chipBtn('region', r, r); }).join('') + '</div></div>';
        }).join('') +
        '</div></div>';
    var themes =
      '<div class="filter-sec" role="group" aria-label="테마 고르기 (여러 개 선택 가능)">' +
        '<h3 class="filter-title">테마 <small>여러 개 선택 가능</small></h3>' +
        '<div class="chips">' + chipBtn('themes', ALL, ALL) +
        D.THEMES.map(function (t) { return chipBtn('themes', t.name, t.icon + ' ' + t.name); }).join('') + '</div></div>';
    var types =
      '<div class="filter-sec" role="group" aria-label="종류 고르기">' +
        '<h3 class="filter-title">종류</h3>' +
        '<div class="chips">' + chipBtn('type', ALL, ALL) +
        D.TYPES.map(function (t) { return chipBtn('type', t.name, t.icon + ' ' + t.name); }).join('') + '</div></div>';
    $('#filters').innerHTML = region + themes + types;
  }

  // 고른 조건 요약(✕로 지우는 작은 표시), 필터 버튼 숫자, 결과 보기 버튼 글자
  function renderActiveFilters(count) {
    var pills = [];
    if (state.region !== ALL) pills.push({ clear: 'region', text: '📍 ' + state.region });
    state.themes.forEach(function (t) { pills.push({ clear: 'themes:' + t, text: themeInfo(t).icon + ' ' + t }); });
    if (state.type !== ALL) pills.push({ clear: 'type', text: typeInfo(state.type).icon + ' ' + state.type });
    var box = $('#active-filters');
    box.innerHTML = pills.map(function (p) {
      return '<button class="pill" type="button" data-clear="' + esc(p.clear) + '" aria-label="' + esc(p.text) + ' 조건 지우기">' +
        esc(p.text) + '<span aria-hidden="true">✕</span></button>';
    }).join('');
    box.hidden = pills.length === 0;
    var badge = $('#filter-badge');
    badge.textContent = pills.length;
    badge.hidden = pills.length === 0;
    $('#filter-apply').textContent = count + '곳 보기';
  }

  function clearFilter(what) {
    if (what === 'region') state.region = ALL;
    else if (what === 'type') state.type = ALL;
    else if (what.indexOf('themes:') === 0) {
      var i = state.themes.indexOf(what.slice(7));
      if (i !== -1) state.themes.splice(i, 1);
    }
    syncChips();
    renderGrid();
  }

  // 필터 창 열기/닫기 (휴대폰)
  var filterOpener = null;
  function openFilters() {
    filterOpener = document.activeElement;
    $('#filter-panel').classList.add('open');
    $('#filter-panel').setAttribute('role', 'dialog');
    $('#filter-panel').setAttribute('aria-modal', 'true');
    $('#filter-backdrop').hidden = false;
    $('#filter-toggle').setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    setTimeout(function () { var b = $('#filter-panel [data-close-filters]'); if (b) b.focus(); }, 50);
  }
  function closeFilters() {
    if (!$('#filter-panel').classList.contains('open')) return;
    $('#filter-panel').classList.remove('open');
    $('#filter-panel').removeAttribute('role');
    $('#filter-panel').removeAttribute('aria-modal');
    $('#filter-backdrop').hidden = true;
    $('#filter-toggle').setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    if (filterOpener && filterOpener.focus) filterOpener.focus();
  }

  function syncChips() {
    $all('.chip[data-key]').forEach(function (c) {
      c.setAttribute('aria-pressed', String(chipOn(c.dataset.key, c.dataset.value)));
    });
  }

  function selectChip(key, value) {
    if (key === 'themes') {
      if (value === ALL) state.themes = [];
      else {
        var i = state.themes.indexOf(value);
        if (i === -1) state.themes.push(value); else state.themes.splice(i, 1);
      }
    } else {
      state[key] = value;
    }
  }

  // skipRegion: 지역 조건만 빼고 검사 (지역 버튼의 개수를 셀 때 사용)
  function matches(p, skipRegion) {
    if (!skipRegion && state.region !== ALL && p.region !== state.region) return false;
    // 고른 테마를 모두 가진 장소만 (예: 연인과 함께 + 바닷가 → 둘 다 해당하는 곳)
    for (var t = 0; t < state.themes.length; t++) {
      if ((p.themes || []).indexOf(state.themes[t]) === -1) return false;
    }
    if (state.type !== ALL && p.type !== state.type) return false;
    var q = state.q.trim().toLowerCase();
    if (q) {
      var hay = [p.name, p.summary, p.description, p.region, p.type, p.address]
        .concat(p.themes || [], p.keywords || []).join(' ').toLowerCase();
      var words = q.split(/\s+/);
      for (var i = 0; i < words.length; i++) if (hay.indexOf(words[i]) === -1) return false;
    }
    return true;
  }

  function isFiltered() {
    return state.region !== ALL || state.themes.length > 0 || state.type !== ALL || state.q.trim() !== '';
  }

  // 지역 버튼 옆 숫자: 지금 고른 테마·종류·검색어 기준으로 그 지역에 몇 곳이 있는지
  function updateRegionCounts() {
    var base = D.PLACES.filter(function (p) { return matches(p, true); });
    $all('.chip[data-key="region"]').forEach(function (c) {
      var v = c.dataset.value;
      var n = v === ALL ? base.length : base.filter(function (p) { return p.region === v; }).length;
      c.querySelector('.chip-count').textContent = n;
      c.classList.toggle('is-empty', n === 0);
    });
  }

  // 정렬: 추천순(기본 순서) / 가까운 순(내 위치 기준, 좌표 없는 곳은 뒤로) / 이름순
  function sortPlaces(list) {
    if (sortMode === 'name') return list.slice().sort(function (a, b) { return a.name.localeCompare(b.name, 'ko'); });
    if (sortMode === 'near' && userPos) {
      return list.map(function (p) { var d = distKm(userPos, p); return { p: p, d: d === null ? 1e9 : d }; })
        .sort(function (a, b) { return a.d - b.d; }).map(function (x) { return x.p; });
    }
    return list;
  }

  function setSort(mode) {
    var sel = $('#sort-select');
    if (mode !== 'near') { sortMode = mode; renderGrid(); return; }
    if (!navigator.geolocation) { toast('이 브라우저에서는 위치를 쓸 수 없어요'); sel.value = sortMode; return; }
    toast('내 위치를 확인하는 중이에요…');
    navigator.geolocation.getCurrentPosition(function (pos) {
      userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      sortMode = 'near';
      sel.value = 'near';
      renderGrid();
      toast('가까운 순으로 보여 드려요');
    }, function () {
      sel.value = sortMode;
      toast('위치를 확인하지 못했어요. 위치 권한을 허용해 주세요');
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }

  /* ---------- 홈: 요즘 뜨는 곳 ----------
     - 날마다 다른 12곳 (날짜로 섞어서, 같은 날에는 같은 12곳). [↻ 다른 곳]을 누르면 새로 섞음
     - 사진 있는 곳을 앞쪽에 둠
     - 7초마다 한 화면씩(휴대폰 3개, 태블릿 4개, PC 5개) 자동으로 넘김. 만지거나 마우스를 올리면 멈추고, 8초 뒤 다시 시작 */
  var HOT_COUNT = 15;     // 휴대폰 3개씩 5화면, PC 5개씩 3화면
  var HOT_INTERVAL = 7000; // 한 화면씩 넘기는 간격 (7초)
  var today = new Date();
  var hotSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate(); // 오늘 날짜 (자정에 바뀜)
  var hotBuiltSeed = null;

  // 같은 seed면 항상 같은 순서가 나오는 섞기
  function seededShuffle(arr, seed) {
    var a = arr.slice(), s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    for (var i = a.length - 1; i > 0; i--) {
      s = (s * 16807) % 2147483647;
      var j = s % (i + 1);
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function renderHotRow(force) {
    var row = $('#hot-row');
    var hot = D.PLACES.filter(function (p) { return p.hot; });
    if (isFiltered() || hot.length < 4) { row.hidden = true; return; }
    row.hidden = false;
    if (!force && hotBuiltSeed === hotSeed) return; // 이미 만든 목록은 그대로 (보던 위치 유지)
    var withImg = seededShuffle(hot.filter(function (p) { return p.images && p.images.length; }), hotSeed);
    var noImg = seededShuffle(hot.filter(function (p) { return !(p.images && p.images.length); }), hotSeed + 7);
    var pick = withImg.slice(0, Math.max(8, HOT_COUNT - noImg.length)).concat(noImg).slice(0, HOT_COUNT);
    pick = seededShuffle(pick, hotSeed + 13);
    var box = $('#hot-scroll');
    box.innerHTML = pick.map(cardHTML).join('');
    box.scrollLeft = 0;
    hotBuiltSeed = hotSeed;
    renderHotDots();
  }

  // 한 화면에 몇 개 보이는지, 한 화면의 폭, 지금 몇 번째 화면인지
  function hotGeom() {
    var box = $('#hot-scroll'), card = box.querySelector('.card');
    if (!card) return null;
    var gap = parseFloat(getComputedStyle(box).columnGap) || 10;
    var cw = card.getBoundingClientRect().width;
    var per = Math.max(1, Math.round((box.clientWidth + gap) / (cw + gap)));
    var pages = Math.ceil(box.querySelectorAll('.card').length / per);
    var pageW = box.clientWidth + gap;
    var maxLeft = box.scrollWidth - box.clientWidth;
    var cur = box.scrollLeft >= maxLeft - 4 ? pages - 1 : Math.round(box.scrollLeft / pageW);
    return { box: box, per: per, pages: pages, pageW: pageW, cur: cur };
  }
  function renderHotDots() {
    var g = hotGeom(), dots = $('#hot-dots');
    if (!g || g.pages < 2) { dots.innerHTML = ''; return; }
    var html = '';
    for (var i = 0; i < g.pages; i++) {
      html += '<button type="button" data-hot-page="' + i + '" aria-label="' + (i + 1) + '번째 화면"' +
        (i === g.cur ? ' aria-current="true"' : '') + '></button>';
    }
    dots.innerHTML = html;
  }
  function updateHotDots() {
    var g = hotGeom();
    if (!g) return;
    var btns = $all('#hot-dots button');
    if (btns.length !== g.pages) { renderHotDots(); return; }
    btns.forEach(function (b, i) { if (i === g.cur) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
  }
  function goHotPage(i) {
    var g = hotGeom();
    if (!g) return;
    g.box.scrollTo({ left: Math.min(i, g.pages - 1) * g.pageW, behavior: 'smooth' });
  }

  function shuffleHot() {
    var box = $('#hot-scroll');
    hotSeed = Math.floor(Math.random() * 1e9) + 1;
    box.classList.add('is-swapping');
    setTimeout(function () {
      renderHotRow(true);
      box.classList.remove('is-swapping');
    }, 200);
    pauseHot(8000);
  }

  // 자동으로 넘기기
  var hotPausedUntil = 0;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function pauseHot(ms) { hotPausedUntil = Date.now() + (ms || 8000); }
  function hotTick() {
    var box = $('#hot-scroll'), row = $('#hot-row');
    if (reduceMotion || document.hidden || row.hidden || $('#view-home').hidden) return;
    if (Date.now() < hotPausedUntil) return;
    if ($('#filter-panel').classList.contains('open')) return;
    var r = box.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return; // 화면에 안 보이면 넘기지 않음
    // 한 화면씩 (휴대폰 3개, 태블릿 4개, PC 5개) 넘기고, 마지막 화면 다음에는 처음으로
    var g = hotGeom();
    if (!g || g.pages < 2) return;
    goHotPage(g.cur + 1 >= g.pages ? 0 : g.cur + 1);
  }
  function initHotAuto() {
    var box = $('#hot-scroll');
    ['pointerdown', 'touchstart', 'wheel', 'focusin'].forEach(function (ev) {
      box.addEventListener(ev, function () { pauseHot(8000); }, { passive: true });
    });
    box.addEventListener('mouseenter', function () { pauseHot(1e9); });
    box.addEventListener('mouseleave', function () { pauseHot(3000); });
    box.addEventListener('touchend', function () { pauseHot(8000); }, { passive: true });
    // 넘길 때마다 점 표시 갱신, 화면 크기가 바뀌면 점 개수 다시 계산
    var raf = 0;
    box.addEventListener('scroll', function () {
      if (raf) return;
      raf = requestAnimationFrame(function () { raf = 0; updateHotDots(); });
    }, { passive: true });
    window.addEventListener('resize', function () { renderHotDots(); });
    setInterval(hotTick, HOT_INTERVAL);
  }

  // keepCount: true면 지금까지 펼친 개수를 유지 (찜 표시만 바뀌었을 때 등)
  function renderGrid(keepCount) {
    if (!keepCount) shownCount = PAGE_SIZE;
    updateRegionCounts();
    var list = sortPlaces(D.PLACES.filter(function (p) { return matches(p); }));
    renderHotRow();
    $('#grid').innerHTML = list.slice(0, shownCount).map(cardHTML).join('');
    var rest = list.length - Math.min(shownCount, list.length);
    var more = $('#more-btn');
    more.hidden = rest <= 0;
    more.textContent = '더 보기 (' + rest + '곳 남음)';
    $('#empty').hidden = list.length > 0;
    $('#result-count').innerHTML = isFiltered()
      ? '조건에 맞는 장소 <strong>' + list.length + '곳</strong>'
      : '전체 장소 <strong>' + list.length + '곳</strong>';
    $('#reset-btn').hidden = !isFiltered();
    renderActiveFilters(list.length);
  }

  function resetFilters() {
    state.region = state.type = ALL;
    state.themes = [];
    state.q = '';
    $('#search-input').value = '';
    syncChips();
    renderGrid();
  }

  /* ---------- ③ 내 여행: 찜 / 일정 나눔 탭 ---------- */
  function planCount() {
    return plan ? plan.days.reduce(function (s, d) { return s + d.items.length; }, 0) : 0;
  }
  function tripTabsHTML(active) {
    var n = favs.filter(findPlace).length, m = planCount(), k = checkIds().length;
    return '<h1 class="page-title">내 여행</h1>' +
      '<nav class="seg" aria-label="내 여행 나누기">' +
        '<a href="#/saved"' + (active === 'saved' ? ' aria-current="page"' : '') + '>♥ 찜 <span class="seg-count">' + n + '</span></a>' +
        '<a href="#/plan"' + (active === 'plan' ? ' aria-current="page"' : '') + '>🗺️ 일정 <span class="seg-count">' + (m ? m + '곳' : '') + '</span></a>' +
        '<a href="#/checks"' + (active === 'checks' ? ' aria-current="page"' : '') + '>🧾 점검 <span class="seg-count">' + (k || '') + '</span></a>' +
      '</nav>';
  }

  function renderSaved() {
    $('#saved-tabs').innerHTML = tripTabsHTML('saved');
    var list = favs.map(findPlace).filter(Boolean);
    $('#saved-grid').innerHTML = list.map(cardHTML).join('');
    $('#saved-empty').hidden = list.length > 0;
    $('#saved-plan-btn').hidden = list.length === 0;
  }

  function updateFavCount() {
    var n = favs.filter(findPlace).length;
    $all('[data-fav-count]').forEach(function (b) {
      b.textContent = n;
      b.hidden = n === 0;
    });
  }

  function toggleFav(id, btn) {
    var p = findPlace(id);
    if (!p) return;
    var i = favs.indexOf(id);
    if (i === -1) favs.push(id); else favs.splice(i, 1);
    store.set('guide.favs', favs);
    var on = isFav(id);

    // 같은 장소의 하트를 모두 갱신 (목록·상세)
    $all('[data-fav="' + id + '"]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(on));
      if (b.classList.contains('fav-btn')) b.textContent = on ? '♥' : '♡';
      else b.innerHTML = (on ? '♥ 찜했어요' : '♡ 찜하기');
    });
    if (btn) { btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop'); }
    updateFavCount();
    if (!$('#view-saved').hidden) renderSaved();
    toast(on ? '찜 목록에 담았어요' : '찜을 해제했어요');
  }

  /* ---------- ② 장소 상세 ---------- */
  function mapLinks(p) {
    var q = encodeURIComponent(p.mapQuery || p.address || p.name);
    return '<div class="map-links">' +
      '<a href="https://map.naver.com/p/search/' + q + '" target="_blank" rel="noopener">네이버 지도</a>' +
      '<a href="https://map.kakao.com/link/search/' + q + '" target="_blank" rel="noopener">카카오맵</a>' +
    '</div>';
  }

  function nearbyPlaces(p) {
    // 가까운 순서(좌표가 없으면 같은 지역)로, 다른 종류를 먼저 (숙소면 관광지·맛집·카페가 먼저 나옴)
    var list = D.PLACES
      .filter(function (o) { return o.id !== p.id; })
      .map(function (o) {
        var d = distKm(p, o);
        return { o: o, d: d === null ? (o.region === p.region ? 50 : 9999) : d };
      })
      .filter(function (x) { return x.d <= 30 || (x.d === 50 && x.o.region === p.region); })
      .sort(function (a, b) { return a.d - b.d; });
    var other = list.filter(function (x) { return x.o.type !== p.type; });
    var same = list.filter(function (x) { return x.o.type === p.type; });
    return other.concat(same).slice(0, 6).sort(function (a, b) { return a.d - b.d; })
      .slice(0, 4).map(function (x) { return x.o; });
  }

  function renderPlace(id) {
    var view = $('#view-place');
    var p = findPlace(id);
    if (!p) {
      view.innerHTML = '<div class="empty"><p class="empty-icon" aria-hidden="true">🧭</p>' +
        '<p>장소를 찾을 수 없어요</p><a class="btn" href="#/">홈으로</a></div>';
      return;
    }
    var t = typeInfo(p.type);
    var count = Math.max(1, Math.min(3, (p.images && p.images.length) || (p.emojis && p.emojis.length) || 1));
    var slides = '', dots = '';
    for (var i = 0; i < count; i++) {
      slides += '<div class="slide">' + photoHTML(p, i) + '</div>';
      dots += '<button class="dot" type="button" data-slide="' + i + '" aria-label="사진 ' + (i + 1) + '"' +
        (i === 0 ? ' aria-current="true"' : '') + '></button>';
    }
    var on = isFav(p.id);
    var near = nearbyPlaces(p);
    var added = inPlan(p.id);
    var actionBtns =
      '<button class="btn btn-outline" type="button" data-fav="' + esc(p.id) + '" aria-pressed="' + on + '">' +
        (on ? '♥ 찜했어요' : '♡ 찜하기') + '</button>' +
      '<button class="btn btn-outline' + (added ? ' is-added' : '') + '" type="button" data-add-plan="' + esc(p.id) + '">' +
        (added ? '✓ 일정에 있음' : '＋ 일정 담기') + '</button>' +
      '<button class="btn" type="button" data-share="' + esc(p.id) + '">↗ 공유</button>';

    view.innerHTML =
      '<article class="detail">' +
        '<button class="back-btn" type="button" data-back>← 목록으로</button>' +
        '<div class="gallery"><div class="slides">' + slides + '</div>' +
          (count > 1 ? '<div class="dots">' + dots + '</div>' : '') + '</div>' +
        (p.credit && p.images && p.images.length
          ? '<p class="photo-credit">사진 · ' +
            (p.creditUrl && /^https:\/\//.test(p.creditUrl)
              ? '<a href="' + esc(p.creditUrl) + '" target="_blank" rel="noopener">' + esc(p.credit) + ' ↗</a>'
              : esc(p.credit)) + '</p>'
          : '') +
        '<header class="detail-head">' +
          '<span class="type-badge">' + esc(t.icon) + ' ' + esc(p.type) + '</span>' +
          '<h1>' + esc(p.name) + '</h1>' +
          '<div class="tags"><span class="tag tag-region">📍 ' + esc(p.region) + '</span>' + themeTagsHTML(p.themes) + '</div>' +
        '</header>' +
        '<div class="actions">' + actionBtns + '</div>' +
        '<p class="lead">' + esc(p.summary) + '</p>' +
        // 긴 설명은 5줄까지만 보이고 [더 보기]로 펼침
        (String(p.description || '').length > 200
          ? '<p class="desc is-clamped" id="place-desc">' + esc(p.description) + '</p>' +
            '<button class="link-btn desc-more" type="button" data-desc-more aria-controls="place-desc" aria-expanded="false">설명 더 보기</button>'
          : '<p class="desc">' + esc(p.description) + '</p>') +
        '<dl class="info">' +
          '<div class="info-row"><dt>주소</dt><dd>' + esc(p.address) + mapLinks(p) + '</dd></div>' +
          '<div class="info-row"><dt>운영 시간</dt><dd>' + esc(p.hours) + '</dd></div>' +
          '<div class="info-row"><dt>쉬는 날</dt><dd>' + esc(p.closed) + '</dd></div>' +
          '<div class="info-row"><dt>가격대</dt><dd>' + esc(p.price) + '</dd></div>' +
          (p.homepage && /^https?:\/\//.test(p.homepage)
            ? '<div class="info-row"><dt>홈페이지</dt><dd><a class="ext-link" href="' + esc(p.homepage) + '" target="_blank" rel="noopener">공식 홈페이지 열기 ↗</a></dd></div>'
            : '') +
        '</dl>' +
        checkNoteHTML(p) +
        (D.site.infoNote ? '<p class="info-note">ⓘ ' + esc(D.site.infoNote) + (p.source ? ' (정보 출처: ' + esc(p.source) + ')' : '') + '</p>' : '') +
        (near.length ? '<section class="nearby"><h2 class="section-title">근처 추천 장소</h2>' +
          '<div class="grid">' + near.map(cardHTML).join('') + '</div></section>' : '') +
      '</article>' +
      // 휴대폰: 스크롤해도 화면 아래에 계속 보이는 버튼줄 (PC에서는 숨김)
      '<div class="detail-bar" role="toolbar" aria-label="' + esc(p.name) + ' 바로가기 버튼">' + actionBtns + '</div>';

    // 사진 넘길 때 아래 점 표시 갱신
    var track = view.querySelector('.slides');
    if (track && count > 1) {
      track.addEventListener('scroll', function () {
        var idx = Math.round(track.scrollLeft / track.clientWidth);
        view.querySelectorAll('.dot').forEach(function (d, k) {
          if (k === idx) d.setAttribute('aria-current', 'true'); else d.removeAttribute('aria-current');
        });
      }, { passive: true });
    }
    document.title = p.name + ' · ' + D.site.name;
  }

  /* ---------- ④ 이달의 추천 ---------- */
  var SEASONS = {
    spring: { name: '봄', icon: '🌸' },
    summer: { name: '여름', icon: '☀️' },
    autumn: { name: '가을', icon: '🍁' },
    winter: { name: '겨울', icon: '❄️' }
  };
  function seasonOf(m) {
    if (m >= 3 && m <= 5) return 'spring';
    if (m >= 6 && m <= 8) return 'summer';
    if (m >= 9 && m <= 11) return 'autumn';
    return 'winter';
  }
  function currentMonth() { return new Date().getMonth() + 1; }

  function renderSeason(month) {
    var view = $('#view-season');
    var monthly = D.MONTHLY || [];
    var rec = null;
    for (var i = 0; i < monthly.length; i++) if (monthly[i].month === month) rec = monthly[i];
    var s = SEASONS[seasonOf(month)];

    var chips = '';
    for (var m = 1; m <= 12; m++) {
      chips += '<a class="chip" href="#/season/' + m + '"' + (m === month ? ' aria-current="true"' : '') + '>' +
        SEASONS[seasonOf(m)].icon + ' ' + m + '월' + (m === currentMonth() ? ' · 이번 달' : '') + '</a>';
    }

    var body;
    if (!rec) {
      body = '<div class="empty"><p class="empty-icon" aria-hidden="true">🗓️</p><p>' + month + '월 추천은 준비 중이에요</p></div>';
    } else {
      var regions = (rec.regions || []).map(function (r) {
        var n = D.PLACES.filter(function (p) { return p.region === r.name; }).length;
        return '<div class="region-card"><div><strong>📍 ' + esc(r.name) + '</strong><p>' + esc(r.reason) + '</p></div>' +
          '<button class="btn btn-small" type="button" data-goto-region="' + esc(r.name) + '"' + (n ? '' : ' disabled') + '>' +
          (n ? '장소 보기 ' + n + '곳' : '준비 중') + '</button></div>';
      }).join('');
      var places = (rec.places || []).map(findPlace).filter(Boolean);
      body =
        '<section class="season-hero s-' + seasonOf(month) + '">' +
          '<p class="season-label">' + month + '월 · ' + s.name + ' ' + s.icon + '</p>' +
          '<h2>' + esc(rec.title) + '</h2>' +
          '<p>' + esc(rec.desc) + '</p>' +
        '</section>' +
        (regions ? '<h2 class="section-title">추천 지역</h2><div class="region-cards">' + regions + '</div>' : '') +
        (places.length ? '<h2 class="section-title">추천 장소</h2><div class="grid">' + places.map(cardHTML).join('') + '</div>' : '');
    }

    view.innerHTML =
      '<h1 class="page-title">이달의 추천</h1>' +
      '<div class="chips month-chips" role="group" aria-label="월 고르기">' + chips + '</div>' +
      body;

    // 고른 달 버튼이 보이도록 버튼 줄을 옆으로 이동
    var row = view.querySelector('.month-chips');
    var cur = row.querySelector('[aria-current="true"]');
    if (cur) row.scrollLeft = cur.offsetLeft - row.offsetLeft - (row.clientWidth - cur.offsetWidth) / 2;
    document.title = month + '월 추천 · ' + D.site.name;
  }

  // 홈 위쪽 배너: 이번 달 추천 제목을 보여 주고 누르면 이달의 추천으로
  function renderSeasonBanner() {
    var month = currentMonth(), rec = null;
    (D.MONTHLY || []).forEach(function (x) { if (x.month === month) rec = x; });
    var el = $('#season-banner');
    if (!rec) { el.hidden = true; return; }
    var key = seasonOf(month), s = SEASONS[key];
    el.className = 'season-banner s-' + key;
    el.href = '#/season/' + month;
    el.innerHTML =
      '<span class="season-banner-icon" aria-hidden="true">' + s.icon + '</span>' +
      '<span class="season-banner-text"><small>' + month + '월 · ' + s.name + ' 추천</small><strong>' + esc(rec.title) + '</strong></span>' +
      '<span class="season-banner-go" aria-hidden="true">보러 가기 →</span>';
    el.setAttribute('aria-label', month + '월 추천: ' + rec.title + ' 보러 가기');
    el.hidden = false;
  }

  // 추천 지역의 [장소 보기] → 홈에서 그 지역만 골라 보여 줌
  function gotoRegion(name) {
    resetFilters();
    state.region = name;
    syncChips();
    renderGrid();
    homeScrollY = 0;
    location.hash = '#/';
  }

  /* ---------- ⑤ 내 일정: 동선 정리 + 시간표 ---------- */
  // 일정 모양: { source: 'favs'|'course'|'shared', title, days: [{ start: '09:00', items: [{ id, stay }] }] }
  var plan = loadPlan();
  var planEdit = false; // 일정표 편집 모드 (켜면 시간 고르기·순서 버튼이 보임)
  var planCheck = false; // 다녀온 뒤 점검 모드 (켜면 장소마다 점검 버튼이 보임)

  // 일정 모양에 여행 날짜 추가: startDate, endDate ('YYYY-MM-DD'). 날짜가 있으면 장소가 없는 빈 날도 남겨 둠
  function loadPlan() { return normalizePlan(store.get('guide.plan', null)); }
  // 저장해 둔 일정 모양 정리 (지금 일정·보관한 일정 모두 씀). 없어진 장소는 빼고, 쓸 수 없으면 null
  function normalizePlan(p) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.days)) return null;
    var hasDates = isDate(p.startDate) && isDate(p.endDate);
    if (!hasDates) { delete p.startDate; delete p.endDate; }
    p.days = p.days.map(function (d) {
      return {
        start: /^\d{2}:\d{2}$/.test(d.start) ? d.start : '09:00',
        items: (d.items || []).filter(function (it) { return it && findPlace(it.id); })
          .map(function (it) { return { id: it.id, stay: Number(it.stay) || 0 }; })
      };
    }).filter(function (d) { return hasDates || d.items.length; });
    return p.days.length ? p : null;
  }
  function savePlan() { store.set('guide.plan', plan); }

  /* ---------- 여행 날짜 ---------- */
  var WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || ''); }
  function parseDate(s) { var a = s.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]); }
  function toISO(dt) { return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate()); }
  function addDays(s, n) { var d = parseDate(s); d.setDate(d.getDate() + n); return toISO(d); }
  function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
  function fmtDate(s) { var d = parseDate(s); return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + WEEK[d.getDay()] + ')'; }
  function dayDate(d) { return plan && plan.startDate ? addDays(plan.startDate, d) : null; }
  function tripLength() { return plan.startDate ? daysBetween(plan.startDate, plan.endDate) + 1 : plan.days.length; }
  function nightsText(n) { return n <= 1 ? '당일' : (n - 1) + '박 ' + n + '일'; }
  function ddayText() {
    var today = toISO(new Date());
    var a = daysBetween(today, plan.startDate), b = daysBetween(today, plan.endDate);
    if (a > 0) return 'D-' + a;
    if (a === 0) return 'D-Day';
    if (b >= 0) return '여행 중 · ' + (1 - a) + '일차';
    return '지난 여행';
  }

  // 그날이 쉬는 날일 수 있는지 (예: '매주 화요일', '매월 첫째 월요일')
  var NTH = { '첫째': 1, '둘째': 2, '셋째': 3, '넷째': 4, '다섯째': 5 };
  function closedWarning(p, iso) {
    var t = String(p.closed || '');
    if (!t || /연중무휴|^없음|방문 전/.test(t)) return '';
    var d = parseDate(iso), wd = WEEK[d.getDay()], nth = Math.ceil(d.getDate() / 7);
    var re = /(첫째|둘째|셋째|넷째|다섯째)?\s*(?:주\s*)?([월화수목금토일])요일/g, m;
    while ((m = re.exec(t))) {
      if (m[2] !== wd) continue;
      if (m[1] && NTH[m[1]] !== nth) continue;
      return wd + '요일 휴무일 수 있어요';
    }
    return '';
  }

  // 날짜 정하기: 기간에 맞게 빈 날을 늘리거나 줄임 (장소가 있는 날은 지우지 않음)
  function setTripDates(start, end) {
    if (!isDate(start)) return;
    if (!isDate(end) || daysBetween(start, end) < 0) end = addDays(start, Math.max(plan.days.length, 1) - 1);
    var len = daysBetween(start, end) + 1;
    if (len > 30) { toast('여행 기간은 30일까지 정할 수 있어요'); len = 30; end = addDays(start, 29); }
    while (plan.days.length > len && !plan.days[plan.days.length - 1].items.length) plan.days.pop();
    if (plan.days.length > len) {
      len = plan.days.length;
      end = addDays(start, len - 1);
      toast('장소가 담긴 날이 ' + len + '일이라 기간을 ' + nightsText(len) + '로 맞췄어요');
    }
    while (plan.days.length < len) plan.days.push({ start: '09:00', items: [] });
    plan.startDate = start;
    plan.endDate = end;
    savePlan();
    renderPlan();
  }
  function clearTripDates() {
    delete plan.startDate;
    delete plan.endDate;
    plan.days = plan.days.filter(function (d) { return d.items.length; });
    if (!plan.days.length) plan = null;
    savePlan();
    renderPlan();
  }

  /* ---------- 맞춤 코스 만들기 (날짜 + 지역 여러 곳 + 테마) ---------- */
  var builder = { open: false, start: null, end: null, regions: [], themes: [] };

  function nextSaturday() {
    var d0 = new Date();
    d0.setDate(d0.getDate() + ((6 - d0.getDay() + 7) % 7 || 7));
    return toISO(d0);
  }

  // 장소 점수: 그달의 추천 > 직접 고른 명소 > 요즘 핫플 > 사진 > 인기 순위
  function tripScore(p, recIds, recRegions) {
    return (recIds.indexOf(p.id) !== -1 ? 5 : 0) + (p.curated ? 4 : 0) + (p.hot ? 3 : 0) +
      (p.images && p.images.length ? 1 : 0) + (recRegions.indexOf(p.region) !== -1 ? 1 : 0) +
      (p.rank ? Math.max(0, 1.5 - p.rank * 0.5) : 0);
  }

  function generateTrip(start, end, regions, themes) {
    var n = Math.min(30, daysBetween(start, end) + 1);
    var month = parseDate(start).getMonth() + 1;
    var rec = (D.MONTHLY || []).filter(function (m) { return m.month === month; })[0];
    var recIds = rec ? rec.places : [], recRegions = rec ? rec.regions.map(function (r) { return r.name; }) : [];
    var score = function (p) { return tripScore(p, recIds, recRegions); };

    // 후보: 좌표가 있는 곳, 고른 지역, 고른 테마(하나라도 맞으면). 숙소는 테마와 관계없이 후보
    var allPool = D.PLACES.filter(function (p) { return p.lat != null && (!regions.length || regions.indexOf(p.region) !== -1); });
    var pool = allPool;
    if (themes.length) {
      pool = allPool.filter(function (p) {
        return isLodging(p) || themes.some(function (t) { return (p.themes || []).indexOf(t) !== -1; });
      });
    }
    var sightsOf = function (r) { return pool.filter(function (p) { return p.region === r && !isLodging(p); }); };

    // 어느 지역을 갈지: 고른 지역 / [전체]면 그달의 추천 지역 → 점수 높은 지역 (이틀에 한 지역 정도)
    var totals = {};
    pool.forEach(function (p) { if (!isLodging(p)) totals[p.region] = (totals[p.region] || 0) + score(p); });
    var regionList = (regions.length ? regions.slice() : Object.keys(totals))
      .filter(function (r) { return totals[r] > 0; })
      .sort(function (a, b) {
        // 테마를 골랐으면 테마에 맞는 장소가 많은 지역을 먼저, 아니면 그달의 추천 지역을 먼저
        if (themes.length) return totals[b] - totals[a];
        return (recRegions.indexOf(b) !== -1) - (recRegions.indexOf(a) !== -1) || totals[b] - totals[a];
      });
    if (!regions.length) regionList = regionList.slice(0, Math.max(1, Math.ceil(n / 2)));
    if (regionList.length > n) regionList = regionList.slice(0, n);
    if (!regionList.length) return null;

    // 날짜를 지역에 나누기: 지역마다 최소 하루, 남는 날은 볼거리가 많은 지역에
    var assigned = {};
    regionList.forEach(function (r) { assigned[r] = 1; });
    for (var k = regionList.length; k < n; k++) {
      var best = regionList[0];
      regionList.forEach(function (r) {
        if (sightsOf(r).length / (assigned[r] + 1) > sightsOf(best).length / (assigned[best] + 1)) best = r;
      });
      assigned[best]++;
    }
    // 이동이 적도록 북쪽 → 남쪽 순서로
    var avgLat = function (r) { var s = sightsOf(r); return s.reduce(function (a, p) { return a + p.lat; }, 0) / (s.length || 1); };
    regionList.sort(function (a, b) { return avgLat(b) - avgLat(a); });
    var dayRegion = [];
    regionList.forEach(function (r) { for (var i = 0; i < assigned[r]; i++) dayRegion.push(r); });

    var used = {};
    var days = dayRegion.map(function (region, d) {
      var date = addDays(start, d), last = d === n - 1;
      var okToday = function (p) { return p.region === region && !used[p.id] && !isLodging(p) && !closedWarning(p, date); };
      var avail = pool.filter(okToday);
      // 테마에 맞는 곳이 모자라면 같은 지역의 다른 인기 장소로 채움 (테마 맞는 곳이 앞쪽에 오도록 점수 가산)
      var sc = score;
      if (themes.length && avail.length < 4) {
        var themed = avail.slice();
        avail = themed.concat(allPool.filter(function (p) { return okToday(p) && themed.indexOf(p) === -1; }));
        sc = function (p) { return score(p) + (themed.indexOf(p) !== -1 ? 10 : 0); };
      }
      var bySc = function (a, b) { return sc(b) - sc(a); };
      var sights = avail.filter(function (p) { return p.type === '관광지'; }).sort(bySc);
      var anchor = sights[0] || avail.slice().sort(bySc)[0];
      if (!anchor) return { start: '09:00', items: [] };
      var near = function (p, km) { var x = distKm(anchor, p); return x !== null && x <= km; };
      var pick = [anchor];
      sights.filter(function (p) { return p !== anchor && near(p, 30); }).slice(0, 2).forEach(function (p) { pick.push(p); });
      var food = avail.filter(function (p) { return isFood(p) && near(p, 30); }).sort(bySc)[0];
      if (food) pick.push(food);
      var cafe = avail.filter(function (p) { return p.type === '카페' && near(p, 30); }).sort(bySc)[0];
      if (cafe) pick.push(cafe);
      if (pick.length < 4) {
        sights.filter(function (p) { return pick.indexOf(p) === -1 && near(p, 50); })
          .slice(0, 4 - pick.length).forEach(function (p) { pick.push(p); });
      }
      pick.forEach(function (p) { used[p.id] = 1; });
      // 마지막 날이 아니면 그날 동선 가까이의 숙소 (같은 지역에 계속 머물면 같은 숙소를 다시 쓸 수 있음)
      if (!last) {
        var lodge = pool.filter(function (p) { return isLodging(p) && p.region === region; })
          .sort(function (a, b) { return (distKm(anchor, a) || 999) - (distKm(anchor, b) || 999); })[0];
        if (lodge) pick.push(lodge);
      }
      return { start: '09:00', items: autoOrder(pick.map(function (p) { return makeItem(p.id); }), '09:00') };
    });

    var names = regions.length ? regions : regionList;
    return {
      source: 'auto',
      title: names.join('·') + ' ' + nightsText(n) + ' 맞춤 코스' + (themes.length ? ' (' + themes.join(', ') + ')' : ''),
      startDate: start, endDate: addDays(start, n - 1), days: days
    };
  }

  function builderHTML(withDates) {
    if (!builder.start) { builder.start = nextSaturday(); builder.end = addDays(builder.start, 1); }
    var today = toISO(new Date());
    var counts = {};
    D.PLACES.forEach(function (p) { if (p.lat != null && !isLodging(p)) counts[p.region] = (counts[p.region] || 0) + 1; });
    var chip = function (key, value, text, on, count) {
      return '<button class="chip" type="button" data-b-key="' + key + '" data-b-value="' + esc(value) + '" aria-pressed="' + on + '">' +
        esc(text) + (count != null ? ' <span class="chip-count">' + count + '</span>' : '') + '</button>';
    };
    var regionChips = chip('regions', ALL, '전체 지역', !builder.regions.length) +
      D.REGIONS.filter(function (r) { return counts[r]; }).map(function (r) {
        return chip('regions', r, r, builder.regions.indexOf(r) !== -1, counts[r]);
      }).join('');
    var themeChips = chip('themes', ALL, '상관없음', !builder.themes.length) +
      D.THEMES.map(function (t) { return chip('themes', t.name, t.icon + ' ' + t.name, builder.themes.indexOf(t.name) !== -1); }).join('');
    var start = withDates ? builder.start : plan.startDate, end = withDates ? builder.end : plan.endDate;
    var len = daysBetween(start, end) + 1;
    return '<section class="builder" id="builder" aria-label="맞춤 코스 만들기">' +
      '<h3>✨ 맞춤 코스 만들기</h3>' +
      '<p class="builder-desc">날짜와 지역을 고르면 그 기간에 맞춰 하루 4~6곳씩 동선을 짜 드려요. 그날 쉬는 곳은 빼고, 그달의 추천 장소를 먼저 넣어요.</p>' +
      (withDates
        ? '<div class="date-fields">' +
            '<label>가는 날<input type="date" class="date-input" data-b-start value="' + builder.start + '" min="' + today + '"></label>' +
            '<label>오는 날<input type="date" class="date-input" data-b-end value="' + builder.end + '" min="' + builder.start + '"></label>' +
          '</div>'
        : '') +
      '<p class="builder-range">📅 ' + fmtDate(start) + ' ~ ' + fmtDate(end) + ' · ' + nightsText(len) + '</p>' +
      '<div class="b-label">지역 <small>여러 곳 선택 가능 · 숫자는 장소 수</small></div>' +
      '<div class="chips b-chips">' + regionChips + '</div>' +
      '<div class="b-label">테마 <small>선택 · 하나라도 맞으면 포함</small></div>' +
      '<div class="chips b-chips">' + themeChips + '</div>' +
      '<button class="btn builder-make" type="button" data-b-make>✨ ' + nightsText(len) + ' 코스 만들기</button>' +
    '</section>';
  }

  function rerenderBuilder() {
    var el = $('#builder');
    if (!el) return;
    var withDates = !plan || !plan.startDate;
    el.outerHTML = builderHTML(withDates);
  }

  function makeTripFromBuilder() {
    var useBuilderDates = !plan || !plan.startDate;
    var start = useBuilderDates ? builder.start : plan.startDate;
    var end = useBuilderDates ? builder.end : plan.endDate;
    if (!isDate(start) || !isDate(end) || daysBetween(start, end) < 0) { toast('날짜를 다시 확인해 주세요'); return; }
    var p = generateTrip(start, end, builder.regions, builder.themes);
    if (!p || !p.days.some(function (d) { return d.items.length; })) {
      toast('조건에 맞는 장소가 부족해요. 지역이나 테마를 넓혀 보세요');
      return;
    }
    // 처음 만든 장소 목록을 남겨 두고, 나중에 점검할 때 "맞춤 코스를 얼마나 그대로 썼는지"(BRD S2)를 셈
    p.origIds = planIds(p);
    var go = function () {
      plan = p; planEdit = false; planCheck = false; builder.open = false;
      savePlan();
      goPlan();
      var emptyDays = p.days.filter(function (d) { return !d.items.length; }).length;
      toast(emptyDays ? '코스를 만들었어요. 장소가 부족한 날이 ' + emptyDays + '일 있어요' : '맞춤 코스를 만들었어요');
    };
    // 날짜만 정한 빈 일정이면 묻지 않고 바로 바꿈
    if (plan && planCount()) confirmReplace('지금 일정을 맞춤 코스로 바꿀까요?', go); else go();
  }

  function datesCardHTML() {
    var has = !!plan.startDate, today = toISO(new Date());
    var month = has ? parseDate(plan.startDate).getMonth() + 1 : 0;
    return '<section class="trip-dates" aria-label="여행 날짜">' +
      '<div class="trip-dates-head"><h3>🗓️ 여행 날짜</h3>' + (has ? '<span class="dday">' + ddayText() + '</span>' : '') + '</div>' +
      (has
        ? '<p class="trip-range"><strong>' + fmtDate(plan.startDate) + ' ~ ' + fmtDate(plan.endDate) + '</strong> · ' + nightsText(tripLength()) + '</p>'
        : '<p class="trip-range is-muted">날짜를 정하면 날짜별 일정과 쉬는 날을 알려 드려요.</p>') +
      '<div class="date-fields">' +
        '<label>가는 날<input type="date" class="date-input" data-trip-start value="' + (plan.startDate || '') + '" min="' + today + '"></label>' +
        '<label>오는 날<input type="date" class="date-input" data-trip-end value="' + (plan.endDate || '') + '" min="' + (plan.startDate || today) + '"></label>' +
      '</div>' +
      (has
        ? '<div class="trip-links"><a class="link-btn" href="#/season/' + month + '">' + month + '월 추천 보기 →</a>' +
          '<button class="link-btn" type="button" data-trip-clear>날짜 지우기</button></div>' +
          '<button class="btn btn-small builder-open" type="button" data-b-open aria-expanded="' + builder.open + '">' +
            (builder.open ? '맞춤 코스 닫기' : '✨ 이 기간에 맞춘 코스 추천받기') + '</button>'
        : '') +
    '</section>' +
    (has && builder.open ? builderHTML(false) : '');
  }

  function isLodging(p) { return p.type === '숙소'; }
  function isFood(p) { return p.type === '맛집'; }
  function defaultStay(p) {
    if (p.stay != null) return p.stay;
    for (var i = 0; i < D.TYPES.length; i++) if (D.TYPES[i].name === p.type && D.TYPES[i].stay != null) return D.TYPES[i].stay;
    return 60;
  }
  function makeItem(id) { return { id: id, stay: defaultStay(findPlace(id)) }; }

  // 시간 표시
  function toMin(hhmm) { var a = hhmm.split(':'); return Number(a[0]) * 60 + Number(a[1]); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(min) {
    var next = min >= 1440 ? '다음날 ' : '';
    min = min % 1440;
    return next + pad2(Math.floor(min / 60)) + ':' + pad2(min % 60);
  }
  function fmtDur(min) {
    var h = Math.floor(min / 60), m = min % 60;
    var s = (h ? h + '시간' : '') + (h && m ? ' ' : '') + (m ? m + '분' : '');
    return s || '0분';
  }
  function fmtKm(km) {
    if (km < 1) return Math.max(100, Math.round(km * 10) * 100) + 'm';
    return (km < 10 ? km.toFixed(1) : Math.round(km)) + 'km';
  }

  // 두 장소 사이 직선거리(km)
  function distKm(a, b) {
    if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
    var R = 6371, r = Math.PI / 180;
    var dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    var s = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.pow(Math.sin(dLng / 2), 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function round5(x) { return Math.max(5, Math.round(x / 5) * 5); }
  // 예상 이동: 도로는 직선보다 돌아가므로 1.3배, 1.5km 미만은 걸어서(시속 4km), 그 이상은 차로(평균 시속 40km + 주차 5분)
  function travel(a, b) {
    var km = distKm(a, b);
    if (km === null) return { km: null, min: 30, mode: '' };
    km *= 1.3;
    if (km < 1.5) return { km: km, min: round5(km / 4 * 60), mode: '걸어서' };
    return { km: km, min: round5(km / 40 * 60 + 5), mode: '차로' };
  }

  // 하루 시간표 계산
  function computeDay(day) {
    var t = toMin(day.start), rows = [], totalKm = 0;
    day.items.forEach(function (it, i) {
      var p = findPlace(it.id);
      var row = { it: it, p: p, arrive: t };
      t += isLodging(p) ? 0 : it.stay;
      row.leave = t;
      var next = day.items[i + 1];
      if (next) {
        row.leg = travel(p, findPlace(next.id));
        if (row.leg.km) totalKm += row.leg.km;
        t += row.leg.min;
      }
      rows.push(row);
    });
    return { rows: rows, end: rows.length ? rows[rows.length - 1].leave : t, totalKm: totalKm };
  }

  // 가장 짧게 이어지는 순서 (출발점을 하나씩 바꿔 가며 가까운 곳으로 이동, 숙소가 있으면 숙소 가까이에서 끝나게)
  function shortestPath(items, endPlace) {
    if (items.length < 2) return items.slice();
    var best = null, bestLen = Infinity;
    for (var s = 0; s < items.length; s++) {
      var left = items.slice(), path = left.splice(s, 1), len = 0;
      while (left.length) {
        var last = findPlace(path[path.length - 1].id), bi = 0, bd = Infinity;
        for (var i = 0; i < left.length; i++) {
          var d = distKm(last, findPlace(left[i].id));
          if (d === null) d = 10;
          if (d < bd) { bd = d; bi = i; }
        }
        len += bd;
        path.push(left.splice(bi, 1)[0]);
      }
      if (endPlace) {
        var e = distKm(findPlace(path[path.length - 1].id), endPlace);
        len += e === null ? 10 : e;
      }
      if (len < bestLen) { bestLen = len; best = path; }
    }
    return best;
  }

  // 자동 동선 정리: 관광지·카페는 가까운 순서로, 맛집은 점심(12시)·저녁(18시)에 가깝게, 숙소는 마지막
  function autoOrder(items, start) {
    var P = function (it) { return findPlace(it.id); };
    var lodging = items.filter(function (it) { return isLodging(P(it)); });
    var food = items.filter(function (it) { return isFood(P(it)); });
    var rest = items.filter(function (it) { return !isLodging(P(it)) && !isFood(P(it)); });
    var route = shortestPath(rest, lodging.length ? P(lodging[0]) : null);
    var targets = [12 * 60, 18 * 60];
    food.forEach(function (f, k) {
      if (k >= targets.length) { route.push(f); return; }
      var best = route.length, bestScore = Infinity;
      for (var pos = 0; pos <= route.length; pos++) {
        var trial = route.slice(0, pos).concat([f], route.slice(pos));
        var arrive = computeDay({ start: start, items: trial }).rows[pos].arrive;
        var score = Math.abs(arrive - targets[k]);
        if (score < bestScore) { bestScore = score; best = pos; }
      }
      route.splice(best, 0, f);
    });
    return route.concat(lodging);
  }

  // 찜 목록 → 지역별로 하루씩 나눠 일정 만들기
  function buildFromFavs() {
    var groups = {}, order = [];
    favs.forEach(function (id) {
      var p = findPlace(id);
      if (!p) return;
      if (!groups[p.region]) { groups[p.region] = []; order.push(p.region); }
      groups[p.region].push(makeItem(id));
    });
    var days = order.map(function (r) { return { start: '09:00', items: autoOrder(groups[r], '09:00') }; });
    return days.length ? { source: 'favs', title: '찜한 장소로 만든 일정', days: days } : null;
  }

  // 추천 코스 → 코스에 적힌 순서 그대로 일정 만들기
  function buildFromCourse(id) {
    var c = null;
    (D.COURSES || []).forEach(function (x) { if (x.id === id) c = x; });
    if (!c) return null;
    var days = c.days.map(function (d) {
      return { start: d.start || '09:00', items: d.places.filter(findPlace).map(makeItem) };
    }).filter(function (d) { return d.items.length; });
    return days.length ? { source: 'course', title: c.title, days: days } : null;
  }

  // 일정 바꾸기. 지금 일정이 보관되지 않았으면 먼저 "보관할까요?"를 묻고, 바꾼 뒤 done()을 부름
  function setPlan(p, question, done) {
    if (!p) return false;
    confirmReplace(question || '지금 만들어 둔 일정을 새 일정으로 바꿀까요?', function () {
      plan = p;
      planEdit = false;
      planCheck = false;
      savePlan();
      if (done) done();
    });
    return true;
  }
  function goPlan() {
    if (location.hash === '#/plan') { renderPlan(); window.scrollTo(0, 0); }
    else location.hash = '#/plan';
  }

  /* ---------- 일정 보관함: 여러 일정을 이름 붙여 저장 (같은 날짜로 여러 코스 비교) ---------- */
  var SAVED_MAX = 50;
  var savedPlans = (function () {
    var list = store.get('guide.saved', []);
    if (!Array.isArray(list)) return [];
    return list.map(function (e) {
      var p = e && normalizePlan(e.plan);
      return p && e.sid ? { sid: String(e.sid), savedAt: Number(e.savedAt) || 0, plan: p } : null;
    }).filter(Boolean);
  })();
  var pendingReplace = null; // "보관할까요?" 창에서 고른 뒤 이어서 할 일

  function saveSavedPlans() { store.set('guide.saved', savedPlans); }
  function savedEntry(sid) {
    for (var i = 0; i < savedPlans.length; i++) if (savedPlans[i].sid === sid) return savedPlans[i];
    return null;
  }
  // 보관용 복사본 (보관함 연결 표시 savedId는 빼고)
  function clonePlan(p) {
    var c = JSON.parse(JSON.stringify(p));
    delete c.savedId;
    return c;
  }
  // 내용이 같은지 비교할 때 쓰는 글자 (이름·날짜·일차별 출발 시간·장소·머무는 시간)
  function planKey(p) {
    return JSON.stringify([p.title, p.startDate || '', p.endDate || '', p.days.map(function (d) {
      return [d.start, d.items.map(function (it) { return it.id + '.' + it.stay; })];
    })]);
  }
  // 지금 일정이 보관함에 그대로 있는지
  function isPlanSaved() {
    var e = plan && plan.savedId ? savedEntry(plan.savedId) : null;
    return !!e && planKey(e.plan) === planKey(plan);
  }
  // 지금 일정을 보관 (mode: 'over' 연결된 보관본에 덮어쓰기, 'new' 새로 저장). 성공하면 true
  function saveCurrentPlan(name, mode) {
    if (!plan) return false;
    name = String(name || '').trim().slice(0, 40) || plan.title || '내 여행 일정';
    var entry = mode === 'over' && plan.savedId ? savedEntry(plan.savedId) : null;
    if (!entry && savedPlans.length >= SAVED_MAX) {
      toast('보관함은 ' + SAVED_MAX + '개까지예요. 안 쓰는 일정을 지워 주세요');
      return false;
    }
    plan.title = name;
    var copy = clonePlan(plan);
    if (entry) {
      entry.plan = copy;
      entry.savedAt = Date.now();
    } else {
      var sid = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      savedPlans.unshift({ sid: sid, savedAt: Date.now(), plan: copy });
      plan.savedId = sid;
    }
    saveSavedPlans();
    savePlan();
    return true;
  }
  // 일정을 바꾸기 전에: 보관함에 그대로 있으면 바로, 장소가 없으면 한 번만 묻고, 보관 안 한 일정이면 "보관할까요?" 창
  function confirmReplace(question, proceed) {
    if (!plan || isPlanSaved()) { proceed(); return; }
    if (!planCount()) { if (window.confirm(question)) proceed(); return; }
    pendingReplace = proceed;
    var linked = plan.savedId && savedEntry(plan.savedId);
    openSheet('지금 일정을 보관할까요?',
      '<p class="sheet-text"><strong>' + esc(plan.title) + '</strong> ' +
        (linked ? '일정은 보관한 뒤에 바뀐 내용이 있어요.' : '일정은 아직 보관함에 없어요.') +
        ' 보관하지 않으면 지금 일정은 사라져요.</p>' +
      '<div class="sheet-btns">' +
        '<button class="btn" type="button" data-replace="save">💾 ' + (linked ? '보관한 일정에 덮어쓰고 계속' : '보관하고 계속') + '</button>' +
        '<button class="btn btn-outline" type="button" data-replace="skip">보관하지 않고 계속</button>' +
        '<button class="btn btn-outline" type="button" data-close-dialog>취소</button>' +
      '</div>');
  }
  // [💾 보관하기] 창: 이름 정하기, 보관한 일정이면 덮어쓰기/새로 저장
  function openSaveSheet() {
    var linked = plan.savedId && savedEntry(plan.savedId);
    var same = isPlanSaved();
    openSheet('일정 보관하기',
      '<label class="sheet-label" for="save-name">일정 이름</label>' +
      '<input class="sheet-input" id="save-name" type="text" maxlength="40" value="' + esc(plan.title) + '" autocomplete="off" enterkeyhint="done">' +
      '<p class="sheet-text is-muted">' +
        (linked
          ? (same ? '보관함에 이미 있는 일정이에요. 이 일정을 바탕으로 다른 코스를 만들려면 [새로 저장]을 누르세요.'
                  : '보관한 뒤에 바뀐 내용이 있어요. 보관한 일정을 바꾸거나, 다른 코스로 따로 저장할 수 있어요.')
          : '같은 날짜로 여러 코스를 보관해 두고, 나중에 불러와 비교할 수 있어요. (이 기기에 저장)') + '</p>' +
      '<div class="sheet-btns">' +
        // 바뀐 게 없으면 "새로 저장"이 주 버튼 (덮어쓰기는 이름만 바꾸는 셈)
        (linked && same
          ? '<button class="btn" type="button" data-save-mode="new">새로 저장</button>' +
            '<button class="btn btn-outline" type="button" data-save-mode="over">이름만 바꾸기</button>'
          : linked
          ? '<button class="btn" type="button" data-save-mode="over">덮어쓰기</button>' +
            '<button class="btn btn-outline" type="button" data-save-mode="new">새로 저장</button>'
          : '<button class="btn" type="button" data-save-mode="new">💾 보관하기</button>') +
      '</div>', '#save-name');
  }

  // 보관 상태 표시 (일정 제목 아래)
  function savedStatusHTML() {
    if (!plan.savedId || !savedEntry(plan.savedId)) return '';
    return isPlanSaved()
      ? ' · <span class="sp-status">💾 보관함에 있음</span>'
      : ' · <span class="sp-status is-changed">💾 보관 후 바뀜</span>';
  }
  function regionsOf(p) {
    var r = [];
    p.days.forEach(function (d) { dayRegions(d).forEach(function (x) { if (r.indexOf(x) === -1) r.push(x); }); });
    return r;
  }
  // 보관한 일정 목록: 같은 날짜끼리 묶고, 날짜가 빠른 순 → 날짜 없는 일정
  function savedListHTML() {
    if (!savedPlans.length) return '';
    var groups = {}, order = [];
    savedPlans.forEach(function (e) {
      var k = e.plan.startDate ? e.plan.startDate + '~' + e.plan.endDate : '';
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(e);
    });
    order.sort(function (a, b) { return !a ? 1 : !b ? -1 : a < b ? -1 : a > b ? 1 : 0; });
    var cur = plan && plan.savedId;
    return '<section class="saved-plans" id="saved-plans" aria-labelledby="saved-plans-title">' +
      '<h2 class="section-title" id="saved-plans-title">📦 보관한 일정 <span class="seg-count">' + savedPlans.length + '</span></h2>' +
      '<p class="ck-hint">같은 날짜로 여러 코스를 보관해 두고 불러와 비교해 보세요.</p>' +
      order.map(function (k) {
        var list = groups[k].slice().sort(function (a, b) { return b.savedAt - a.savedAt; });
        var head = k
          ? '🗓️ ' + fmtDate(list[0].plan.startDate) + ' ~ ' + fmtDate(list[0].plan.endDate) + ' · ' +
            nightsText(daysBetween(list[0].plan.startDate, list[0].plan.endDate) + 1)
          : '📝 날짜를 정하지 않은 일정';
        return '<div class="sp-group"><h3 class="sp-date">' + head + (list.length > 1 ? ' <span class="sp-many">코스 ' + list.length + '개</span>' : '') + '</h3>' +
          '<ul class="sp-list">' + list.map(function (e) {
            var n = e.plan.days.reduce(function (s, d) { return s + d.items.length; }, 0);
            var saved = new Date(e.savedAt);
            var isCur = e.sid === cur;
            return '<li class="sp-card' + (isCur ? ' is-current' : '') + '">' +
              '<div class="sp-body">' +
                '<p class="sp-title">' + esc(e.plan.title) + (isCur ? ' <span class="sp-now">지금 보는 일정</span>' : '') + '</p>' +
                '<p class="sp-meta">장소 ' + n + '곳' + (regionsOf(e.plan).length ? ' · ' + esc(regionsOf(e.plan).join('·')) : '') +
                  ' · 보관 ' + (saved.getMonth() + 1) + '/' + saved.getDate() + ' ' + pad2(saved.getHours()) + ':' + pad2(saved.getMinutes()) + '</p>' +
              '</div>' +
              '<div class="sp-btns">' +
                '<button class="btn btn-small' + (isCur ? ' btn-outline' : '') + '" type="button" data-sp-load="' + e.sid + '">' + (isCur ? '다시 불러오기' : '불러오기') + '</button>' +
                '<button class="btn btn-small btn-outline" type="button" data-sp-rename="' + e.sid + '" aria-label="' + esc(e.plan.title) + ' 이름 바꾸기">이름</button>' +
                '<button class="icon-btn" type="button" data-sp-del="' + e.sid + '" aria-label="' + esc(e.plan.title) + ' 보관함에서 지우기">✕</button>' +
              '</div>' +
            '</li>';
          }).join('') + '</ul></div>';
      }).join('') +
    '</section>';
  }
  function loadSaved(sid) {
    var e = savedEntry(sid);
    if (!e) return;
    if (plan && plan.savedId === sid && isPlanSaved()) { goPlan(); toast('지금 보고 있는 일정이에요'); return; }
    var q = plan && plan.savedId === sid
      ? '바뀐 내용을 버리고 보관한 일정으로 되돌릴까요?'
      : '「' + e.plan.title + '」 일정을 불러올까요?';
    var go = function () {
      var np = normalizePlan(clonePlan(e.plan));
      if (!np) { toast('이 일정의 장소를 찾을 수 없어요'); return; }
      plan = np;
      plan.savedId = sid;
      planEdit = false; planCheck = false; builder.open = false;
      savePlan();
      goPlan();
      toast('「' + plan.title + '」 일정을 불러왔어요');
    };
    // 같은 일정을 되돌릴 때는 "보관할까요?" 대신 한 번만 물음
    if (plan && plan.savedId === sid) { if (window.confirm(q)) go(); }
    else confirmReplace(q, go);
  }

  // 공유 링크용으로 일정을 짧은 글자로 바꾸기: 0900~id.90,id.60|1000~id.0
  // 날짜가 있으면 앞에 D20261115-20261116! 를 붙임
  function encodePlan(p) {
    var head = p.startDate ? 'D' + p.startDate.replace(/-/g, '') + '-' + p.endDate.replace(/-/g, '') + '!' : '';
    return head + p.days.map(function (d) {
      return d.start.replace(':', '') + '~' + d.items.map(function (it) { return it.id + '.' + it.stay; }).join(',');
    }).join('|');
  }
  function decodePlan(str, title) {
    var dm = str.match(/^D(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})!/), dates = null;
    if (dm) {
      dates = { startDate: dm[1] + '-' + dm[2] + '-' + dm[3], endDate: dm[4] + '-' + dm[5] + '-' + dm[6] };
      str = str.slice(dm[0].length);
    }
    var days = str.split('|').map(function (part) {
      var sp = part.split('~');
      if (sp.length !== 2 || !/^\d{4}$/.test(sp[0])) return null;
      var items = sp[1].split(',').map(function (x) {
        var a = x.split('.');
        return findPlace(a[0]) ? { id: a[0], stay: Number(a[1]) || 0 } : null;
      }).filter(Boolean);
      return { start: sp[0].slice(0, 2) + ':' + sp[0].slice(2), items: items };
    }).filter(function (d) { return d && (d.items.length || dates); });
    if (!days.length) return null;
    var p = { source: 'shared', title: title || '공유받은 일정', days: days };
    if (dates && isDate(dates.startDate) && isDate(dates.endDate)) { p.startDate = dates.startDate; p.endDate = dates.endDate; }
    return p;
  }

  // 그림으로 보는 동선 (좌표를 상자 안에 맞춰 점과 점선으로 표시)
  function routeMapSVG(rows, d) {
    var pts = [];
    rows.forEach(function (r, i) { if (r.p.lat != null && r.p.lng != null) pts.push({ p: r.p, n: i + 1 }); });
    if (pts.length < 2) return '';
    var W = 320, H = 150, PAD = 22;
    var lats = pts.map(function (x) { return x.p.lat; }), lngs = pts.map(function (x) { return x.p.lng; });
    var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
    var minLng = Math.min.apply(null, lngs), maxLng = Math.max.apply(null, lngs);
    var kx = Math.cos((minLat + maxLat) / 2 * Math.PI / 180);
    var spanX = Math.max((maxLng - minLng) * kx, 1e-6), spanY = Math.max(maxLat - minLat, 1e-6);
    var scale = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanY);
    var offX = (W - spanX * scale) / 2, offY = (H - spanY * scale) / 2;
    var xy = pts.map(function (x) {
      return [offX + (x.p.lng - minLng) * kx * scale, H - (offY + (x.p.lat - minLat) * scale)];
    });
    // 아주 가까운 장소끼리 점이 겹치면 살짝 떨어뜨려 번호가 보이게
    function clash(pt, upto) {
      for (var j = 0; j < upto; j++) {
        var dx = pt[0] - xy[j][0], dy = pt[1] - xy[j][1];
        if (dx * dx + dy * dy < 24 * 24) return xy[j];
      }
      return null;
    }
    for (var i = 1; i < xy.length; i++) {
      var hit = clash(xy[i], i);
      // 겹치면 둘레 8방향 중 비어 있는 자리로 옮김
      for (var k = 0; hit && k < 8; k++) {
        var ang = k * Math.PI / 4 - Math.PI / 4;
        var cand = [
          Math.min(W - 12, Math.max(12, hit[0] + Math.cos(ang) * 26)),
          Math.min(H - 12, Math.max(12, hit[1] + Math.sin(ang) * 26))
        ];
        if (!clash(cand, i)) { xy[i] = cand; hit = null; }
      }
    }
    var line = xy.map(function (c) { return c[0].toFixed(1) + ',' + c[1].toFixed(1); }).join(' ');
    var dots = xy.map(function (c, i) {
      return '<circle class="route-dot" cx="' + c[0].toFixed(1) + '" cy="' + c[1].toFixed(1) + '" r="11"></circle>' +
        '<text class="route-num" x="' + c[0].toFixed(1) + '" y="' + c[1].toFixed(1) + '">' + pts[i].n + '</text>';
    }).join('');
    return '<svg class="route-map" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img" ' +
      'aria-label="' + (d + 1) + '일차 동선 그림">' +
      '<polyline class="route-line" points="' + line + '"></polyline>' + dots + '</svg>';
  }

  function directionsURL(a, b) {
    if (a.lat == null || b.lat == null) return 'https://map.kakao.com/link/search/' + encodeURIComponent(b.mapQuery || b.address || b.name);
    return 'https://map.kakao.com/link/from/' + encodeURIComponent(a.name) + ',' + a.lat + ',' + a.lng +
      '/to/' + encodeURIComponent(b.name) + ',' + b.lat + ',' + b.lng;
  }

  var START_OPTS = [];
  for (var so = 6 * 60; so <= 14 * 60; so += 30) START_OPTS.push(so);
  var STAY_OPTS = [30, 60, 90, 120, 150, 180, 240, 300];

  function selectHTML(attr, options, current, label, aria) {
    if (options.indexOf(current) === -1) options = options.concat([current]).sort(function (a, b) { return a - b; });
    return '<select class="plan-select" ' + attr + ' aria-label="' + esc(aria) + '">' +
      options.map(function (v) {
        return '<option value="' + v + '"' + (v === current ? ' selected' : '') + '>' + label(v) + '</option>';
      }).join('') + '</select>';
  }

  function dayHTML(day, d) {
    var date = dayDate(d);
    var dateLine = date ? '<p class="day-date">' + fmtDate(date) + '</p>' : '';
    // 날짜만 정하고 아직 장소가 없는 날
    if (!day.items.length) {
      return '<section class="day-card is-empty">' +
        '<div class="day-head"><div><h3>📅 ' + (d + 1) + '일차</h3>' + dateLine + '</div></div>' +
        '<p class="empty-day">아직 담은 장소가 없어요. 장소 상세 화면의 <strong>[＋ 일정 담기]</strong>로 이 날에 장소를 담아 보세요.</p>' +
        '<a class="btn btn-small btn-outline" href="#/">장소 둘러보기</a>' +
      '</section>';
    }
    var c = computeDay(day);
    var regions = [];
    c.rows.forEach(function (r) { if (regions.indexOf(r.p.region) === -1) regions.push(r.p.region); });

    var stops = c.rows.map(function (r, i) {
      var p = r.p, t = typeInfo(p.type), last = i === c.rows.length - 1;
      // 편집 모드에서만 머무는 시간 고르기·순서 버튼을 보여 줌
      var meta = isLodging(p)
        ? '<span>' + esc(t.icon) + ' 숙소 · ' + esc(p.hours) + '</span>'
        : '<span>' + esc(t.icon) + ' ' + esc(p.type) + '</span><span aria-hidden="true">·</span>' +
          (planEdit
            ? selectHTML('data-stay="' + d + ',' + i + '"', STAY_OPTS, r.it.stay, function (v) { return fmtDur(v) + ' 머무름'; }, p.name + ' 머무는 시간')
            : '<span>' + fmtDur(r.it.stay) + ' 머무름</span>');
      var warn = date ? closedWarning(p, date) : '';
      if (warn) meta += '<span class="closed-warn">⚠️ ' + warn + '</span>';
      var ctrl = planEdit
        ? '<div class="stop-ctrl">' +
            '<button class="icon-btn" type="button" data-move="' + d + ',' + i + ',-1" aria-label="' + esc(p.name) + ' 앞으로"' + (i === 0 ? ' disabled' : '') + '>▲</button>' +
            '<button class="icon-btn" type="button" data-move="' + d + ',' + i + ',1" aria-label="' + esc(p.name) + ' 뒤로"' + (last ? ' disabled' : '') + '>▼</button>' +
            '<button class="icon-btn" type="button" data-remove="' + d + ',' + i + '" aria-label="' + esc(p.name) + ' 일정에서 빼기">✕</button>' +
          '</div>'
        : '';
      var html = '<li class="stop">' +
        '<div class="stop-time">' + fmtTime(r.arrive) + '</div>' +
        '<div class="stop-body">' +
          '<div class="stop-name"><span class="stop-num">' + (i + 1) + '</span>' +
          '<a href="#/place/' + encodeURIComponent(p.id) + '">' + esc(p.name) + '</a></div>' +
          '<div class="stop-meta">' + meta + '</div>' +
          (planCheck ? checkPanelHTML(p) : checkBadgeHTML(p)) +
        '</div>' + ctrl + '</li>';
      if (r.leg) {
        var next = c.rows[i + 1].p;
        html += '<li class="leg"><span>↓ ' +
          (r.leg.km !== null ? '약 ' + fmtKm(r.leg.km) + ' · ' + r.leg.mode + ' 약 ' + fmtDur(r.leg.min) : '위치 정보 없음 · 30분으로 계산') +
          '</span><a href="' + directionsURL(p, next) + '" target="_blank" rel="noopener">길찾기 ↗</a></li>';
      }
      return html;
    }).join('');

    return '<section class="day-card">' +
      '<div class="day-head"><div><h3>📅 ' + (d + 1) + '일차 · ' + esc(regions.join(' → ')) + '</h3>' + dateLine + '</div>' +
        (planEdit
          ? '<label>출발 ' + selectHTML('data-day-start="' + d + '"', START_OPTS, toMin(day.start), fmtTime, (d + 1) + '일차 출발 시간') + '</label>'
          : '<span class="start-text">출발 <strong>' + esc(day.start) + '</strong></span>') + '</div>' +
      routeMapSVG(c.rows, d) +
      '<ol class="stops">' + stops + '</ol>' +
      '<div class="day-foot"><span>일정 끝 약 <strong>' + fmtTime(c.end) + '</strong>' +
        (c.totalKm ? ' · 총 이동 약 ' + fmtKm(c.totalKm) : '') + '</span>' +
        (planEdit && day.items.length > 1 ? '<button class="link-btn" type="button" data-reorder="' + d + '">↻ 동선 다시 정리</button>' : '') +
      '</div></section>';
  }

  function choiceHTML() {
    var n = favs.filter(findPlace).length;
    var courses = (D.COURSES || []).map(function (c) {
      var count = c.days.reduce(function (s, d) { return s + d.places.length; }, 0);
      return '<article class="course-card">' +
        '<div class="course-emoji" aria-hidden="true">' + esc(c.emoji || '🧭') + '</div>' +
        '<div class="course-body"><h3>' + esc(c.title) + '</h3><p>' + esc(c.desc) + '</p>' +
        '<p class="course-meta">' + (c.days.length > 1 ? c.days.length + '일' : '하루') + ' · 장소 ' + count + '곳</p>' +
        '<button class="btn btn-small" type="button" data-build-course="' + esc(c.id) + '">이 코스로 일정 만들기</button></div>' +
      '</article>';
    }).join('');
    return tripTabsHTML('plan') +
      '<p class="plan-intro">날짜·지역에 맞춘 코스, 찜한 장소, 추천 코스로 동선과 시간표를 자동으로 만들어 드려요.</p>' +
      savedListHTML() +
      builderHTML(true) +
      '<section class="choice-card"><h2>🗓️ 날짜부터 정하기</h2>' +
        '<p>가는 날과 오는 날을 먼저 정하고, 마음에 드는 장소를 날짜별로 하나씩 담아요.</p>' +
        '<button class="btn btn-outline" type="button" data-build-dates>날짜 정하고 빈 일정 만들기</button>' +
      '</section>' +
      '<section class="choice-card"><h2>♥ 찜 목록으로 만들기</h2>' +
        '<p>' + (n ? '찜한 장소 ' + n + '곳을 지역별로 하루씩 나누고, 가까운 순서로 이어서 시간표를 만들어요.'
                   : '아직 찜한 장소가 없어요. 마음에 드는 장소에 ♥를 먼저 눌러 주세요.') + '</p>' +
        (n ? '<button class="btn" type="button" data-build-favs>🗺️ 찜한 장소로 일정 만들기</button>'
           : '<a class="btn btn-outline" href="#/">장소 둘러보기</a>') +
      '</section>' +
      (courses ? '<h2 class="section-title">추천 코스로 만들기</h2><div class="course-list">' + courses + '</div>' : '');
  }

  function renderPlan() {
    var view = $('#view-plan');
    document.title = '일정 · 내 여행 · ' + D.site.name;
    if (!plan) { view.innerHTML = choiceHTML(); return; }
    var count = plan.days.reduce(function (s, d) { return s + d.items.length; }, 0);
    var source = plan.source === 'course' ? '🧭 추천 코스로 만든 일정'
      : plan.source === 'shared' ? '🔗 공유받은 일정'
      : plan.source === 'custom' ? '✍️ 직접 담은 일정'
      : plan.source === 'auto' ? '✨ 날짜·지역 맞춤 코스' : '♥ 찜 목록으로 만든 일정';
    view.innerHTML =
      tripTabsHTML('plan') +
      '<div class="plan-top"><div>' +
        '<p class="plan-source">' + source + '</p>' +
        '<h2>' + esc(plan.title) + '</h2>' +
        '<p class="plan-sub">' + (plan.startDate ? nightsText(tripLength()) : (plan.days.length > 1 ? plan.days.length + '일 일정' : '하루 일정')) + ' · 장소 ' + count + '곳' + savedStatusHTML() + '</p>' +
      '</div><div class="plan-actions">' +
        '<button class="btn btn-small' + (planEdit ? '' : ' btn-outline') + '" type="button" data-plan-edit aria-pressed="' + planEdit + '">' +
          (planEdit ? '✓ 편집 완료' : '✏️ 편집') + '</button>' +
        '<button class="btn btn-small' + (planCheck ? '' : ' btn-outline') + '" type="button" data-plan-check aria-pressed="' + planCheck + '">' +
          (planCheck ? '✓ 점검 완료' : '🧾 점검') + '</button>' +
        '<button class="btn btn-small" type="button" data-plan-save>💾 보관하기</button>' +
        '<button class="btn btn-small btn-outline" type="button" data-plan-share>↗ 공유하기</button>' +
        '<button class="btn btn-small btn-outline" type="button" data-plan-print>🖨️ 인쇄하기</button>' +
        '<button class="btn btn-small btn-outline" type="button" data-plan-new>새로 만들기</button>' +
      '</div></div>' +
      (planEdit
        ? '<p class="plan-note is-edit">✏️ 편집 중: 출발·머무는 시간을 바꾸고, ▲▼로 순서를 바꾸거나 ✕로 뺄 수 있어요.</p>'
        : planCheck ? ''
        : '<p class="plan-note">이동 거리와 시간은 직선거리로 계산한 예상치예요. 정확한 경로와 시간은 [길찾기]에서 확인하세요.</p>') +
      (planCheck ? checkSummaryHTML() : checkPromptHTML()) +
      datesCardHTML() +
      plan.days.map(dayHTML).join('') +
      savedListHTML();
  }

  // 일정 화면의 버튼 처리. 처리했으면 true
  function handlePlanClick(target) {
    var el;
    if (target.closest('[data-build-favs]')) {
      var fp = buildFromFavs();
      if (!fp) { toast('먼저 마음에 드는 장소에 ♥를 눌러 주세요'); return true; }
      setPlan(fp, null, function () { goPlan(); toast('찜한 장소로 일정을 만들었어요'); });
      return true;
    }
    if ((el = target.closest('[data-build-course]'))) {
      setPlan(buildFromCourse(el.dataset.buildCourse), null, function () { goPlan(); toast('추천 코스로 일정을 만들었어요'); });
      return true;
    }
    // 맞춤 코스: 지역·테마 고르기 (전체/상관없음을 누르면 선택 해제, 나머지는 여러 개 선택)
    if ((el = target.closest('[data-b-key]'))) {
      var key = el.dataset.bKey, val = el.dataset.bValue, list = builder[key];
      if (val === ALL) builder[key] = [];
      else {
        var at = list.indexOf(val);
        if (at === -1) list.push(val); else list.splice(at, 1);
      }
      rerenderBuilder();
      var again = $('#builder [data-b-key="' + key + '"][data-b-value="' + val + '"]');
      if (again) again.focus();
      return true;
    }
    if (target.closest('[data-b-make]')) { makeTripFromBuilder(); return true; }
    if (target.closest('[data-b-open]')) {
      builder.open = !builder.open;
      renderPlan();
      var b = $('#builder');
      if (b) window.scrollTo({ top: b.getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
      return true;
    }
    if (target.closest('[data-build-dates]')) {
      // 날짜부터 정하기: 다음 주 토요일부터 1박 2일짜리 빈 일정 (날짜는 바로 바꿀 수 있음)
      var d0 = new Date(); d0.setDate(d0.getDate() + ((6 - d0.getDay() + 7) % 7 || 7));
      var s0 = toISO(d0);
      setPlan({ source: 'custom', title: '내 여행 일정', startDate: s0, endDate: addDays(s0, 1), days: [{ start: '09:00', items: [] }, { start: '09:00', items: [] }] }, null, function () {
        goPlan();
        toast('가는 날과 오는 날을 골라 주세요');
        setTimeout(function () { var i = $('#view-plan [data-trip-start]'); if (i) i.focus(); }, 300);
      });
      return true;
    }
    // 일정 보관함
    if ((el = target.closest('[data-replace]'))) {
      var next = pendingReplace;
      pendingReplace = null;
      if (el.dataset.replace === 'save' && !saveCurrentPlan(plan.title, 'over')) return true;
      closeSheet();
      if (el.dataset.replace === 'save') toast('「' + plan.title + '」 일정을 보관했어요');
      if (next) next();
      return true;
    }
    if ((el = target.closest('[data-save-mode]'))) {
      var nameEl = $('#save-name');
      if (!saveCurrentPlan(nameEl ? nameEl.value : '', el.dataset.saveMode)) return true;
      closeSheet();
      renderPlan();
      toast(el.dataset.saveMode === 'over' ? '보관한 일정에 반영했어요' : '「' + plan.title + '」 일정을 보관했어요',
        { label: '목록 보기', onClick: function () { var sp = $('#saved-plans'); if (sp) sp.scrollIntoView({ behavior: 'smooth' }); } });
      return true;
    }
    if ((el = target.closest('[data-sp-load]'))) { loadSaved(el.dataset.spLoad); return true; }
    if ((el = target.closest('[data-sp-rename]'))) {
      var re = savedEntry(el.dataset.spRename);
      if (!re) return true;
      var nn = window.prompt('새 이름을 적어 주세요', re.plan.title);
      nn = nn == null ? '' : nn.trim().slice(0, 40);
      if (!nn || nn === re.plan.title) return true;
      // 지금 보는 일정과 같은 것이면 제목도 함께 바꿈 (보관 상태 유지)
      if (plan && plan.savedId === re.sid && isPlanSaved()) { plan.title = nn; savePlan(); }
      re.plan.title = nn;
      saveSavedPlans();
      renderPlan();
      toast('이름을 바꿨어요');
      return true;
    }
    if ((el = target.closest('[data-sp-del]'))) {
      var de = savedEntry(el.dataset.spDel);
      if (!de || !window.confirm('「' + de.plan.title + '」 일정을 보관함에서 지울까요? 되돌릴 수 없어요.')) return true;
      savedPlans = savedPlans.filter(function (x) { return x !== de; });
      if (plan && plan.savedId === de.sid) { delete plan.savedId; savePlan(); }
      saveSavedPlans();
      renderPlan();
      toast('보관함에서 지웠어요');
      return true;
    }
    if (target.closest('[data-plan-save]')) { if (plan) openSaveSheet(); return true; }
    // 점검 기록 화면의 버튼
    if ((el = target.closest('[data-ck-del]'))) {
      var dp = findPlace(el.dataset.ckDel);
      if (window.confirm((dp ? dp.name : '이 장소') + '의 점검 기록을 지울까요?')) {
        delete checks[el.dataset.ckDel];
        saveChecks(); renderChecks();
        toast('점검 기록을 지웠어요');
      }
      return true;
    }
    if (target.closest('[data-ck-copy]')) {
      copyText(checksText()).then(function (ok) {
        toast(ok ? '점검 기록을 복사했어요. 메모장이나 카톡에 붙여 넣으세요' : '복사하지 못했어요');
      });
      return true;
    }
    if (target.closest('[data-ck-clear]')) {
      if (window.confirm('점검 기록을 모두 지울까요? 지우면 되돌릴 수 없어요.')) {
        checks = {}; saveChecks(); renderChecks();
        toast('점검 기록을 모두 지웠어요');
      }
      return true;
    }
    if (!plan) return false;
    if (target.closest('[data-trip-clear]')) {
      if (window.confirm('여행 날짜를 지울까요? 장소가 없는 빈 날도 함께 사라져요.')) clearTripDates();
      return true;
    }
    if ((el = target.closest('[data-move]'))) {
      var m = el.dataset.move.split(',').map(Number), items = plan.days[m[0]].items, j = m[1] + m[2];
      if (j < 0 || j >= items.length) return true;
      var tmp = items[m[1]]; items[m[1]] = items[j]; items[j] = tmp;
      savePlan(); renderPlan();
      var moved = $('#view-plan').querySelector('[data-move="' + m[0] + ',' + j + ',' + m[2] + '"]');
      if (moved && !moved.disabled) moved.focus();
      return true;
    }
    if ((el = target.closest('[data-remove]'))) {
      var r = el.dataset.remove.split(',').map(Number);
      plan.days[r[0]].items.splice(r[1], 1);
      // 날짜를 정한 일정은 빈 날도 남겨 둠 (그 날짜에 다시 담을 수 있게)
      if (!plan.startDate) {
        plan.days = plan.days.filter(function (d) { return d.items.length; });
        if (!plan.days.length) plan = null;
      }
      savePlan(); renderPlan();
      toast('일정에서 뺐어요');
      return true;
    }
    if ((el = target.closest('[data-reorder]'))) {
      var day = plan.days[Number(el.dataset.reorder)];
      day.items = autoOrder(day.items, day.start);
      savePlan(); renderPlan();
      toast('가까운 순서로 다시 정리했어요');
      return true;
    }
    if (target.closest('[data-plan-share]')) {
      shareLink({
        title: plan.title,
        text: plan.title + (plan.startDate
          ? ' (' + fmtDate(plan.startDate) + ' ~ ' + fmtDate(plan.endDate) + ', ' + nightsText(tripLength()) + ')'
          : ' (' + plan.days.length + '일 일정)'),
        url: location.href.split('#')[0] + '#/plan/s/' + encodeURIComponent(encodePlan(plan)) + '/' + encodeURIComponent(plan.title)
      });
      return true;
    }
    if (target.closest('[data-plan-check]')) {
      planCheck = !planCheck;
      planEdit = false;
      renderPlan();
      var cb = $('#view-plan [data-plan-check]');
      if (cb) cb.focus();
      if (!planCheck) toast('점검 기록을 저장했어요', { label: '모아 보기', onClick: function () { location.hash = '#/checks'; } });
      return true;
    }
    if ((el = target.closest('[data-ck]'))) {
      setCheck(el.dataset.ck, el.dataset.ckField, el.dataset.ckVal);
      renderPlan();
      var sel = '[data-ck="' + el.dataset.ck + '"][data-ck-field="' + el.dataset.ckField + '"][data-ck-val="' + el.dataset.ckVal + '"]';
      var again2 = $('#view-plan').querySelector(sel);
      if (again2) again2.focus();
      return true;
    }
    if (target.closest('[data-plan-edit]')) {
      planEdit = !planEdit;
      planCheck = false;
      renderPlan();
      var eb = $('#view-plan [data-plan-edit]');
      if (eb) eb.focus();
      return true;
    }
    if (target.closest('[data-plan-print]')) { window.print(); return true; }
    if (target.closest('[data-plan-new]')) {
      confirmReplace('지금 일정을 지우고 새로 만들까요? (점검 기록은 남아 있어요)', function () { plan = null; planCheck = false; savePlan(); renderPlan(); window.scrollTo(0, 0); });
      return true;
    }
    return false;
  }

  function handlePlanChange(el) {
    // 맞춤 코스 날짜 (일정이 없거나 날짜가 없을 때)
    if (el.matches('[data-b-start]')) {
      if (!el.value) return;
      var blen = daysBetween(builder.start, builder.end);
      builder.start = el.value;
      builder.end = addDays(el.value, Math.max(0, blen));
      rerenderBuilder();
      return;
    }
    if (el.matches('[data-b-end]')) {
      if (!el.value) return;
      if (daysBetween(builder.start, el.value) < 0) { toast('오는 날은 가는 날보다 뒤여야 해요'); rerenderBuilder(); return; }
      if (daysBetween(builder.start, el.value) > 29) { toast('여행 기간은 30일까지 정할 수 있어요'); rerenderBuilder(); return; }
      builder.end = el.value;
      rerenderBuilder();
      return;
    }
    if (!plan) return;
    if (el.matches('[data-trip-start]')) {
      if (!el.value) return;
      // 가는 날을 바꾸면 기간(며칠짜리)은 그대로 두고 오는 날을 함께 옮김
      var len = plan.startDate ? tripLength() : Math.max(plan.days.length, 1);
      setTripDates(el.value, addDays(el.value, len - 1));
      return;
    }
    if (el.matches('[data-trip-end]')) {
      if (!el.value) return;
      if (!plan.startDate) { setTripDates(el.value, el.value); return; }
      if (daysBetween(plan.startDate, el.value) < 0) { toast('오는 날은 가는 날보다 뒤여야 해요'); renderPlan(); return; }
      setTripDates(plan.startDate, el.value);
      return;
    }
    if (el.matches('[data-ck-memo]')) {
      // 메모는 화면을 다시 그리지 않고 저장만 (입력 중인 칸에서 초점이 빠지지 않게)
      setCheck(el.dataset.ckMemo, 'memo', el.value);
      var sum = $('#check-summary');
      if (sum) sum.outerHTML = checkSummaryHTML();
      return;
    }
    if (el.matches('[data-day-start]')) {
      plan.days[Number(el.dataset.dayStart)].start = fmtTime(Number(el.value));
    } else if (el.matches('[data-stay]')) {
      var s = el.dataset.stay.split(',').map(Number);
      plan.days[s[0]].items[s[1]].stay = Number(el.value);
    } else return;
    savePlan(); renderPlan();
  }

  /* ---------- 다녀온 뒤 점검 (BRD 성공 기준 S1 실제 활용 · S2 취향 · S3 정보 정확도 기록) ---------- */
  var WRONG_KEYS = [['hours', '운영 시간'], ['closed', '쉬는 날'], ['location', '위치'], ['price', '가격']];

  function planIds(p) {
    var ids = [];
    (p ? p.days : []).forEach(function (d) { d.items.forEach(function (it) { if (ids.indexOf(it.id) === -1) ids.push(it.id); }); });
    return ids;
  }
  function checkIds() { return Object.keys(checks).filter(function (id) { return findPlace(id); }); }
  function saveChecks() { store.set('guide.checks', checks); }
  function getCheck(id) { return checks[id] || null; }
  // 그 장소가 담긴 날의 날짜 (날짜를 정하지 않은 일정이면 오늘)
  function planDateOf(id) {
    if (plan && plan.startDate) {
      for (var d = 0; d < plan.days.length; d++) {
        if (plan.days[d].items.some(function (it) { return it.id === id; })) return dayDate(d);
      }
    }
    return toISO(new Date());
  }
  // field: visited(yes/no) · info(ok/wrong) · wrong(hours/closed/location/price) · memo. 같은 버튼을 다시 누르면 취소
  function setCheck(id, field, val) {
    if (!findPlace(id)) return;
    var c = checks[id] || { visited: null, info: null, wrong: [], memo: '' };
    if (field === 'visited') {
      var v = val === 'yes';
      c.visited = c.visited === v ? null : v;
    } else if (field === 'info') {
      c.info = c.info === val ? null : val;
      if (c.info !== 'wrong') c.wrong = [];
    } else if (field === 'wrong') {
      var at = c.wrong.indexOf(val);
      if (at === -1) c.wrong.push(val); else c.wrong.splice(at, 1);
    } else if (field === 'memo') {
      c.memo = String(val || '').trim().slice(0, 200);
    }
    if (c.visited === null && c.info === null && !c.memo) { delete checks[id]; saveChecks(); return; }
    c.date = planDateOf(id);
    c.trip = plan ? plan.title : (c.trip || '');
    c.at = Date.now();
    checks[id] = c;
    saveChecks();
  }
  function wrongText(c) {
    return WRONG_KEYS.filter(function (k) { return (c.wrong || []).indexOf(k[0]) !== -1; })
      .map(function (k) { return k[1]; }).join('·');
  }
  function shortDate(iso) {
    if (!isDate(iso)) return '';
    var d = parseDate(iso);
    return (d.getMonth() + 1) + '/' + d.getDate() + '(' + WEEK[d.getDay()] + ')';
  }

  // 일정의 장소마다 붙는 점검 버튼 (점검 모드에서만)
  function checkPanelHTML(p) {
    var c = getCheck(p.id) || {}, id = esc(p.id);
    var b = function (field, val, text, on) {
      return '<button class="chip ck-chip" type="button" data-ck="' + id + '" data-ck-field="' + field + '" data-ck-val="' + val + '" aria-pressed="' + !!on + '">' + text + '</button>';
    };
    return '<div class="ck" role="group" aria-label="' + esc(p.name) + ' 점검">' +
      '<div class="ck-row"><span class="ck-label">다녀왔나요?</span>' +
        b('visited', 'yes', '✓ 다녀왔어요', c.visited === true) + b('visited', 'no', '✕ 못 갔어요', c.visited === false) + '</div>' +
      '<div class="ck-row"><span class="ck-label">정보는?</span>' +
        b('info', 'ok', '👍 맞았어요', c.info === 'ok') + b('info', 'wrong', '👎 달랐어요', c.info === 'wrong') + '</div>' +
      (c.info === 'wrong'
        ? '<div class="ck-row"><span class="ck-label">무엇이?</span>' +
            WRONG_KEYS.map(function (k) { return b('wrong', k[0], k[1], (c.wrong || []).indexOf(k[0]) !== -1); }).join('') + '</div>'
        : '') +
      '<input class="ck-memo" type="text" maxlength="200" data-ck-memo="' + id + '" value="' + esc(c.memo || '') + '" ' +
        'placeholder="메모 (예: 월요일도 휴무, 주차 어려움)" aria-label="' + esc(p.name) + ' 메모">' +
    '</div>';
  }
  // 점검 모드가 아닐 때: 남긴 기록을 작은 표시로
  function checkBadgeHTML(p) {
    var c = getCheck(p.id);
    if (!c) return '';
    var parts = [];
    if (c.visited === true) parts.push('✓ 다녀옴');
    if (c.visited === false) parts.push('✕ 못 감');
    if (c.info === 'ok') parts.push('👍 정보 맞음');
    if (c.info === 'wrong') parts.push('⚠️ ' + (wrongText(c) || '정보') + ' 달랐음');
    if (!parts.length) parts.push('📝 메모');
    return '<div class="ck-badge' + (c.info === 'wrong' ? ' is-wrong' : '') + '">' + esc(parts.join(' · ')) + '</div>';
  }

  // 일정의 점검 요약: 다녀온 곳(S1), 맞춤 코스를 그대로 쓴 정도(S2), 정보가 맞은 곳(S3)
  function checkSummaryHTML() {
    var ids = planIds(plan), s = { yes: 0, no: 0, ok: 0, wrong: 0, todo: 0 };
    ids.forEach(function (id) {
      var c = getCheck(id);
      if (!c) { s.todo++; return; }
      if (c.visited === true) s.yes++;
      if (c.visited === false) s.no++;
      if (c.info === 'ok') s.ok++;
      if (c.info === 'wrong') s.wrong++;
    });
    var stat = function (num, text, cls) { return '<li' + (cls ? ' class="' + cls + '"' : '') + '><strong>' + num + '</strong><span>' + text + '</span></li>'; };
    var s2 = '';
    if (plan.source === 'auto' && Array.isArray(plan.origIds) && plan.origIds.length) {
      var kept = plan.origIds.filter(function (id) { return ids.indexOf(id) !== -1; }).length;
      var added = ids.filter(function (id) { return plan.origIds.indexOf(id) === -1; }).length;
      s2 = '<p class="ck-s2">✨ 맞춤 코스에서 그대로 쓴 곳 <strong>' + kept + '/' + plan.origIds.length + '</strong>' +
        ' · 뺀 곳 ' + (plan.origIds.length - kept) + ' · 더한 곳 ' + added + '</p>';
    }
    return '<section class="check-sum" id="check-summary" aria-label="점검 요약">' +
      '<h3>🧾 다녀온 뒤 점검</h3>' +
      '<p class="check-desc">장소마다 다녀왔는지, 운영 시간·쉬는 날·위치·가격이 실제와 맞았는지 남겨 주세요. 이 기기에 저장되고, 틀린 정보는 고칠 목록으로 모아 볼 수 있어요.</p>' +
      '<ul class="ck-stats">' +
        stat(s.yes + '/' + ids.length, '다녀옴') +
        stat(s.ok, '정보 맞음') +
        stat(s.wrong, '정보 다름', s.wrong ? 'is-wrong' : '') +
        stat(s.todo, '아직 안 남김') +
      '</ul>' + s2 +
      '<a class="link-btn ck-more" href="#/checks">점검 기록 모아 보기 →</a>' +
    '</section>';
  }
  // 여행이 시작됐거나 끝난 일정이면 점검을 권함
  function checkPromptHTML() {
    if (!plan.startDate || daysBetween(toISO(new Date()), plan.startDate) > 0) return '';
    var ids = planIds(plan), todo = ids.filter(function (id) { return !getCheck(id); }).length;
    if (!todo) return '';
    return '<div class="check-prompt"><p><strong>여행은 어떠셨어요?</strong> 다녀온 곳과 정보가 맞았는지 남겨 두면 다음 일정이 더 정확해져요. (남은 곳 ' + todo + ')</p>' +
      '<button class="btn btn-small" type="button" data-plan-check aria-pressed="false">🧾 점검하기</button></div>';
  }
  // 장소 상세: 내가 남긴 점검 기록
  function checkNoteHTML(p) {
    var c = getCheck(p.id);
    if (!c) return '';
    var when = shortDate(c.date);
    var text = c.info === 'wrong' ? '실제와 달랐어요: ' + (wrongText(c) || '정보')
      : c.info === 'ok' ? '정보가 실제와 맞았어요'
      : c.visited === true ? '다녀왔어요' : c.visited === false ? '못 갔어요' : '메모를 남겼어요';
    return '<p class="ck-note' + (c.info === 'wrong' ? ' is-wrong' : '') + '">' +
      (c.info === 'wrong' ? '⚠️' : '🧾') + ' <strong>내 점검 기록' + (when ? ' · ' + when : '') + '</strong> ' + esc(text) +
      (c.memo ? '<br><span class="ck-note-memo">“' + esc(c.memo) + '”</span>' : '') + '</p>';
  }

  // 점검 기록 정렬: 정보가 달랐던 곳 → 맞았던 곳 → 나머지, 같은 묶음은 최근 순
  function checkGroups() {
    var list = checkIds().map(function (id) { return { p: findPlace(id), c: checks[id] }; })
      .sort(function (a, b) { return (b.c.at || 0) - (a.c.at || 0); });
    return [
      { key: 'wrong', title: '⚠️ 정보가 달랐던 곳', hint: '사이트 정보를 고쳐야 할 곳이에요', items: list.filter(function (x) { return x.c.info === 'wrong'; }) },
      { key: 'ok', title: '👍 정보가 맞았던 곳', items: list.filter(function (x) { return x.c.info === 'ok'; }) },
      { key: 'rest', title: '📝 그 밖의 기록', items: list.filter(function (x) { return !x.c.info; }) }
    ].filter(function (g) { return g.items.length; });
  }
  function renderChecks() {
    var view = $('#view-checks');
    document.title = '점검 기록 · 내 여행 · ' + D.site.name;
    var groups = checkGroups(), all = checkIds().map(function (id) { return checks[id]; });
    if (!all.length) {
      view.innerHTML = tripTabsHTML('checks') +
        '<div class="empty"><p class="empty-icon" aria-hidden="true">🧾</p>' +
        '<p>아직 점검 기록이 없어요.<br>여행을 다녀온 뒤 일정 화면의 <strong>[🧾 점검]</strong>으로 장소마다 남겨 보세요.</p>' +
        '<a class="btn" href="#/plan">일정 보기</a></div>';
      return;
    }
    var cnt = function (f) { return all.filter(f).length; };
    view.innerHTML = tripTabsHTML('checks') +
      '<p class="plan-intro">여행 뒤 남긴 기록이에요. 정보가 달랐던 곳은 사이트 정보를 고칠 때 참고하세요.</p>' +
      '<ul class="ck-stats ck-stats-all">' +
        '<li><strong>' + all.length + '</strong><span>기록한 곳</span></li>' +
        '<li><strong>' + cnt(function (c) { return c.visited === true; }) + '</strong><span>다녀옴</span></li>' +
        '<li><strong>' + cnt(function (c) { return c.info === 'ok'; }) + '</strong><span>정보 맞음</span></li>' +
        '<li' + (cnt(function (c) { return c.info === 'wrong'; }) ? ' class="is-wrong"' : '') + '><strong>' +
          cnt(function (c) { return c.info === 'wrong'; }) + '</strong><span>정보 다름</span></li>' +
      '</ul>' +
      '<div class="ck-tools">' +
        '<button class="btn btn-small" type="button" data-ck-copy>📋 기록 복사하기</button>' +
        '<button class="btn btn-small btn-outline" type="button" data-ck-clear>모두 지우기</button>' +
      '</div>' +
      groups.map(function (g) {
        return '<section class="ck-group"><h2 class="section-title">' + g.title + ' <span class="seg-count">' + g.items.length + '</span></h2>' +
          (g.hint ? '<p class="ck-hint">' + g.hint + '</p>' : '') +
          '<ul class="ck-list">' + g.items.map(function (x) {
            var c = x.c, p = x.p, tags = [];
            if (c.visited === true) tags.push('✓ 다녀옴');
            if (c.visited === false) tags.push('✕ 못 감');
            if (c.info === 'wrong') tags.push((wrongText(c) || '정보') + ' 다름');
            return '<li class="ck-item' + (c.info === 'wrong' ? ' is-wrong' : '') + '">' +
              '<div class="ck-item-body">' +
                '<a class="ck-item-name" href="#/place/' + encodeURIComponent(p.id) + '">' + esc(typeInfo(p.type).icon) + ' ' + esc(p.name) + '</a>' +
                '<p class="ck-item-meta">' + esc(p.region) + (c.date ? ' · ' + esc(shortDate(c.date)) : '') + (c.trip ? ' · ' + esc(c.trip) : '') + '</p>' +
                (tags.length ? '<p class="ck-item-tags">' + esc(tags.join(' · ')) + '</p>' : '') +
                (c.memo ? '<p class="ck-item-memo">“' + esc(c.memo) + '”</p>' : '') +
              '</div>' +
              '<button class="icon-btn" type="button" data-ck-del="' + esc(p.id) + '" aria-label="' + esc(p.name) + ' 점검 기록 지우기">✕</button>' +
            '</li>';
          }).join('') + '</ul></section>';
      }).join('');
  }
  // 복사용 글: 메모장·카톡에 붙여 넣거나 data.js를 고칠 때 씀 (장소 id 포함)
  function checksText() {
    var lines = ['[' + D.site.name + ' 점검 기록] ' + toISO(new Date())];
    checkGroups().forEach(function (g) {
      lines.push('', '■ ' + g.title.replace(/^\S+\s/, '') + ' (' + g.items.length + ')');
      g.items.forEach(function (x) {
        var c = x.c, bits = [x.p.region, shortDate(c.date)];
        if (c.visited === true) bits.push('다녀옴');
        if (c.visited === false) bits.push('못 감');
        if (c.info === 'wrong') bits.push((wrongText(c) || '정보') + ' 다름');
        if (c.memo) bits.push('메모: ' + c.memo);
        lines.push('- ' + x.p.name + ' [' + x.p.id + '] ' + bits.filter(Boolean).join(' · '));
      });
    });
    return lines.join('\n');
  }

  /* ---------- 공유하기 ---------- */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }

  function share(id) {
    var p = findPlace(id);
    if (!p) return;
    shareLink({
      title: p.name,
      text: p.name + ' - ' + p.summary,
      url: location.href.split('#')[0] + '#/place/' + encodeURIComponent(p.id)
    });
  }

  function shareLink(data) {
    var isMobile = window.matchMedia('(pointer: coarse)').matches;

    function fallback() {
      copyText(data.url).then(function (ok) {
        toast(ok ? '링크가 복사되었습니다' : '링크를 복사하지 못했어요');
      });
    }
    // 휴대폰: 카카오톡·문자 등 공유 창 / PC: 링크 복사
    if (isMobile && navigator.share) {
      navigator.share(data).catch(function (e) { if (!e || e.name !== 'AbortError') fallback(); });
    } else {
      fallback();
    }
  }

  /* ---------- ② 장소 상세: 일정에 담기 ---------- */
  function inPlan(id) {
    if (!plan) return false;
    return plan.days.some(function (d) { return d.items.some(function (it) { return it.id === id; }); });
  }
  function dayRegions(day) {
    var r = [];
    day.items.forEach(function (it) { var p = findPlace(it.id); if (p && r.indexOf(p.region) === -1) r.push(p.region); });
    return r;
  }

  // 지금 순서는 그대로 두고, 이동 거리가 가장 적게 늘어나는 자리에 끼워 넣기 (숙소는 맨 뒤)
  function insertItem(day, id) {
    var p = findPlace(id), item = makeItem(id);
    function dd(a, b) { var d = distKm(a, b); return d === null ? 10 : d; }
    if (isLodging(p)) { day.items.push(item); return; }
    var end = day.items.length;
    while (end > 0 && isLodging(findPlace(day.items[end - 1].id))) end--;
    var best = end, bestCost = Infinity;
    for (var pos = 0; pos <= end; pos++) {
      var prev = pos > 0 ? findPlace(day.items[pos - 1].id) : null;
      var next = pos < day.items.length ? findPlace(day.items[pos].id) : null;
      var cost = (prev ? dd(prev, p) : 0) + (next ? dd(p, next) : 0) - (prev && next ? dd(prev, next) : 0);
      if (cost < bestCost) { bestCost = cost; best = pos; }
    }
    day.items.splice(best, 0, item);
  }

  function afterAdded(dayIdx) {
    savePlan();
    refreshPlanButtons();
    var dd = dayDate(dayIdx);
    toast((dayIdx + 1) + '일차' + (dd ? ' · ' + fmtDate(dd) : '') + ' 일정에 담았어요', { label: '일정 보기', onClick: function () { location.hash = '#/plan'; } });
  }

  function refreshPlanButtons() {
    $all('[data-add-plan]').forEach(function (b) {
      var on = inPlan(b.dataset.addPlan);
      b.classList.toggle('is-added', on);
      b.textContent = on ? '✓ 일정에 있음' : '＋ 일정 담기';
    });
  }

  var pendingAddId = null;
  function addToPlan(id) {
    var p = findPlace(id);
    if (!p) return;
    if (inPlan(id)) { location.hash = '#/plan'; return; }
    if (!plan) {
      plan = { source: 'custom', title: '내 여행 일정', days: [{ start: '09:00', items: [makeItem(id)] }] };
      afterAdded(0);
      return;
    }
    // 하루짜리 일정이고 (비어 있거나) 같은 지역이면 바로 담기
    if (plan.days.length === 1 && (!plan.days[0].items.length || dayRegions(plan.days[0]).indexOf(p.region) !== -1)) {
      insertItem(plan.days[0], id);
      afterAdded(0);
      return;
    }
    // 그 밖에는 몇 일차에 담을지 물어보기
    pendingAddId = id;
    var opts = plan.days.map(function (d, i) {
      var regions = dayRegions(d);
      var rec = regions.indexOf(p.region) !== -1;
      var date = dayDate(i);
      var warn = date ? closedWarning(p, date) : '';
      return '<button class="day-option" type="button" data-add-day="' + i + '">' +
        '<span>' + (i + 1) + '일차' + (date ? ' · ' + fmtDate(date) : '') + (regions.length ? ' · ' + esc(regions.join(' → ')) : '') +
        '<small>' + (d.items.length ? '장소 ' + d.items.length + '곳' : '아직 비어 있어요') + (warn ? ' · ⚠️ ' + warn : '') + '</small></span>' +
        (rec && !warn ? '<span class="rec">같은 지역 추천</span>' : '') + '</button>';
    }).join('');
    openSheet('몇 일차에 담을까요?',
      '<p class="plan-intro" style="margin:0 0 12px">' + esc(p.name) + ' (' + esc(p.region) + ')</p>' +
      '<div class="day-options">' + opts +
      '<button class="day-option new" type="button" data-add-day="new">＋ ' + (plan.days.length + 1) + '일차' +
        (plan.startDate ? ' · ' + fmtDate(addDays(plan.startDate, plan.days.length)) : '') + ' 새로 만들어 담기</button></div>');
  }

  // 아래에서 올라오는 창 (일차 고르기·일정 보관하기 등에 같이 씀)
  function openSheet(title, html, focusSel) {
    $('#day-dialog-title').textContent = title;
    $('#day-dialog-body').innerHTML = html;
    var dlg = $('#day-dialog');
    if (!dlg.open) { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); }
    if (focusSel) setTimeout(function () { var f = dlg.querySelector(focusSel); if (f) { f.focus(); if (f.select) f.select(); } }, 50);
  }
  function closeSheet() {
    var dlg = $('#day-dialog');
    if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
  }

  function addToDay(which) {
    closeSheet();
    if (!pendingAddId || !plan) return;
    var idx;
    if (which === 'new') {
      plan.days.push({ start: '09:00', items: [makeItem(pendingAddId)] });
      idx = plan.days.length - 1;
      if (plan.startDate) plan.endDate = addDays(plan.startDate, plan.days.length - 1); // 하루 늘어난 만큼 오는 날도 늦춤
    } else {
      idx = Number(which);
      insertItem(plan.days[idx], pendingAddId);
    }
    pendingAddId = null;
    afterAdded(idx);
  }

  /* ---------- 계절 색 테마 ---------- */
  var THEME_KEYS = ['spring', 'summer', 'autumn', 'winter'];
  var THEME_SWATCH = { spring: '#ec8fa9', summer: '#2fb0c6', autumn: '#e07a5f', winter: '#33508a' };
  var THEME_BG = { spring: '#fdf7f8', summer: '#f5fafc', autumn: '#fbf6ef', winter: '#f3f5f9' };

  function themePref() {
    var t = store.get('guide.theme', 'auto');
    if (t === 'warm') t = 'autumn';
    if (t === 'fresh') t = 'summer';
    return THEME_KEYS.indexOf(t) !== -1 ? t : 'auto';
  }
  function applyTheme(pref) {
    var t = pref === 'auto' ? seasonOf(currentMonth()) : pref;
    document.documentElement.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_BG[t]); // 휴대폰 상단 상태 표시줄 색
    $('#theme-btn-text').textContent = SEASONS[t].icon + ' ' + SEASONS[t].name;
    $('#theme-btn').setAttribute('aria-label', '사이트 색: ' + SEASONS[t].name + (pref === 'auto' ? ' (자동)' : '') + '. 바꾸기');
    renderThemeMenu(pref);
  }
  function renderThemeMenu(pref) {
    var now = SEASONS[seasonOf(currentMonth())];
    $('#theme-menu').innerHTML = '<p>사이트 색</p>' +
      '<button type="button" role="menuitemradio" data-theme-pick="auto" aria-checked="' + (pref === 'auto') + '">' +
        '<span aria-hidden="true">🗓️</span> 자동 (이번 달 · ' + now.name + ')</button>' +
      THEME_KEYS.map(function (k) {
        return '<button type="button" role="menuitemradio" data-theme-pick="' + k + '" aria-checked="' + (pref === k) + '">' +
          '<span class="theme-swatch" style="background:' + THEME_SWATCH[k] + '"></span>' +
          SEASONS[k].icon + ' ' + SEASONS[k].name + '</button>';
      }).join('');
    $('#theme-menu').setAttribute('role', 'menu');
  }
  function toggleThemeMenu(open) {
    var menu = $('#theme-menu');
    var show = open === undefined ? menu.hidden : open;
    menu.hidden = !show;
    $('#theme-btn').setAttribute('aria-expanded', String(show));
    if (show) { var cur = menu.querySelector('[aria-checked="true"]'); if (cur) cur.focus(); }
  }

  /* ---------- 화면 이동 (주소 # 뒤로 화면 결정) ---------- */
  function route() {
    var hash = location.hash || '#/';

    // '내 여행'은 일정이 있으면 일정, 없으면 찜 화면으로
    if (hash === '#/trip') {
      hash = plan ? '#/plan' : '#/saved';
      history.replaceState(null, '', location.href.split('#')[0] + hash);
    }

    var m = hash.match(/^#\/place\/(.+)$/);
    var sm = hash.match(/^#\/season(?:\/(\d{1,2}))?$/);
    var pm = hash.match(/^#\/plan(?:\/s\/([^/]+)(?:\/([^/]*))?)?$/);
    var name = m ? 'place' : sm ? 'season' : pm ? 'plan' : hash === '#/saved' ? 'saved' : hash === '#/checks' ? 'checks' : 'home';

    var wasHome = !$('#view-home').hidden;
    var wasSeason = !$('#view-season').hidden;
    var wasTrip = !$('#view-plan').hidden || !$('#view-saved').hidden || !$('#view-checks').hidden;
    if (wasHome && name !== 'home') homeScrollY = window.scrollY;
    closeFilters();

    // 공유받은 일정 링크 열기
    if (pm && pm[1]) {
      var shared = null;
      try { shared = decodePlan(decodeURIComponent(pm[1]), pm[2] ? decodeURIComponent(pm[2]) : ''); } catch (e) {}
      if (!shared) toast('일정 링크를 읽지 못했어요');
      else setPlan(shared, '공유받은 일정을 불러올까요? 지금 일정은 바뀝니다.', function () {
        // 바로 바뀌면 아래에서 화면을 그리고, "보관할까요?" 창을 거쳐 나중에 바뀌면 여기서 다시 그림
        if (location.hash === '#/plan') renderPlan();
        toast('공유받은 일정을 불러왔어요');
      });
      history.replaceState(null, '', location.href.split('#')[0] + '#/plan');
    }

    $('#view-home').hidden = name !== 'home';
    $('#view-season').hidden = name !== 'season';
    $('#view-plan').hidden = name !== 'plan';
    $('#view-saved').hidden = name !== 'saved';
    $('#view-checks').hidden = name !== 'checks';
    $('#view-place').hidden = name !== 'place';

    var navName = (name === 'plan' || name === 'saved' || name === 'checks') ? 'trip' : name;
    $all('[data-nav]').forEach(function (a) {
      if (a.dataset.nav === navName) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });

    if (name === 'place') {
      renderPlace(decodeURIComponent(m[1]));
      window.scrollTo(0, 0);
    } else if (name === 'season') {
      var month = sm[1] ? parseInt(sm[1], 10) : currentMonth();
      if (!(month >= 1 && month <= 12)) month = currentMonth();
      renderSeason(month);
      // 달만 바꿀 때는 화면 위치 유지, 다른 화면에서 들어올 때만 맨 위로
      if (!wasSeason) window.scrollTo(0, 0);
    } else if (name === 'plan') {
      renderPlan();
      if (!wasTrip) window.scrollTo(0, 0);
    } else if (name === 'checks') {
      renderChecks();
      if (!wasTrip) window.scrollTo(0, 0);
    } else if (name === 'saved') {
      renderSaved();
      document.title = '찜 · 내 여행 · ' + D.site.name;
      if (!wasTrip) window.scrollTo(0, 0);
    } else {
      renderGrid(true); // 찜 상태가 바뀌었을 수 있으니 다시 그림 (펼친 개수는 유지)
      document.title = D.site.name;
      window.scrollTo(0, wasHome ? window.scrollY : homeScrollY);
    }
  }

  /* ---------- 시작 ---------- */
  function init() {
    // 사이트 이름·소개 문구
    $('#site-name').textContent = D.site.name;
    $all('[data-site-name]').forEach(function (el) { el.textContent = D.site.name; });
    $('#site-tagline').textContent = D.site.tagline;
    var notice = $('.notice');
    if (D.site.notice) notice.textContent = D.site.notice; else notice.hidden = true;

    applyTheme(themePref());
    renderSeasonBanner();
    renderFilters();
    updateFavCount();

    // 검색
    $('#search-input').addEventListener('input', function (e) {
      state.q = e.target.value;
      renderGrid();
    });

    // 클릭 처리 (한 곳에서)
    document.addEventListener('click', function (e) {
      var el;
      // 계절 메뉴 바깥을 누르면 닫기
      if (!e.target.closest('.theme-wrap')) toggleThemeMenu(false);

      if (handlePlanClick(e.target)) {
        return;
      } else if ((el = e.target.closest('.chip[data-key]'))) {
        selectChip(el.dataset.key, el.dataset.value);
        syncChips();
        renderGrid();
      } else if ((el = e.target.closest('[data-desc-more]'))) {
        var desc = $('#place-desc');
        var open = desc.classList.toggle('is-clamped') === false;
        el.textContent = open ? '설명 접기' : '설명 더 보기';
        el.setAttribute('aria-expanded', String(open));
      } else if ((el = e.target.closest('[data-hot-page]'))) {
        goHotPage(Number(el.dataset.hotPage));
        pauseHot(10000);
      } else if (e.target.closest('[data-hot-shuffle]')) {
        shuffleHot();
      } else if (e.target.closest('[data-hot-all]')) {
        state.themes = ['요즘 핫플'];
        syncChips();
        renderGrid();
        var bar = $('.result-bar');
        if (bar) window.scrollTo({ top: bar.getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
      } else if (e.target.closest('#more-btn')) {
        shownCount += PAGE_SIZE;
        renderGrid(true);
      } else if ((el = e.target.closest('[data-clear]'))) {
        clearFilter(el.dataset.clear);
      } else if (e.target.closest('#filter-toggle')) {
        openFilters();
      } else if (e.target.closest('[data-close-filters], #filter-backdrop')) {
        closeFilters();
      } else if ((el = e.target.closest('[data-add-plan]'))) {
        addToPlan(el.dataset.addPlan);
      } else if ((el = e.target.closest('[data-add-day]'))) {
        addToDay(el.dataset.addDay);
      } else if (e.target.closest('[data-close-dialog]') || e.target === $('#day-dialog')) {
        $('#day-dialog').close();
      } else if ((el = e.target.closest('[data-fav]'))) {
        e.preventDefault();
        toggleFav(el.dataset.fav, el.classList.contains('fav-btn') ? el : null);
      } else if ((el = e.target.closest('[data-goto-region]'))) {
        gotoRegion(el.dataset.gotoRegion);
      } else if ((el = e.target.closest('[data-share]'))) {
        share(el.dataset.share);
      } else if (e.target.closest('#reset-btn, [data-reset]')) {
        resetFilters();
      } else if (e.target.closest('[data-back]')) {
        if (navigatedInApp) history.back(); else location.hash = '#/';
      } else if ((el = e.target.closest('[data-slide]'))) {
        var track = $('#view-place .slides');
        track.scrollTo({ left: track.clientWidth * Number(el.dataset.slide), behavior: 'smooth' });
      } else if ((el = e.target.closest('[data-theme-pick]'))) {
        var pick = el.dataset.themePick;
        store.set('guide.theme', pick);
        applyTheme(pick);
        toggleThemeMenu(false);
        $('#theme-btn').focus();
        var t = pick === 'auto' ? seasonOf(currentMonth()) : pick;
        toast(SEASONS[t].icon + ' ' + SEASONS[t].name + ' 색으로 바꿨어요' + (pick === 'auto' ? ' (자동)' : ''));
      } else if (e.target.closest('#theme-btn')) {
        toggleThemeMenu();
      }
    });

    // Esc: 열린 창 닫기
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.id === 'save-name' && !e.isComposing) {
        e.preventDefault();
        var primary = $('#day-dialog [data-save-mode]');
        if (primary) primary.click();
        return;
      }
      if (e.key !== 'Escape') return;
      if (!$('#theme-menu').hidden) { toggleThemeMenu(false); $('#theme-btn').focus(); }
      closeFilters();
    });

    initHotAuto();

    // 목록 끝에 가까워지면 자동으로 더 불러오기 (휴대폰에서 버튼을 누르지 않아도 됨)
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting && !$('#more-btn').hidden && !$('#view-home').hidden) {
          shownCount += PAGE_SIZE;
          renderGrid(true);
        }
      }, { rootMargin: '400px 0px' }).observe($('.more-wrap'));
    }

    // 일정의 출발 시간·머무는 시간 바꾸기
    document.addEventListener('change', function (e) {
      if (e.target.id === 'sort-select') { setSort(e.target.value); return; }
      handlePlanChange(e.target);
    });

    window.addEventListener('hashchange', function () { navigatedInApp = true; route(); });
    route();
  }

  init();
})();
