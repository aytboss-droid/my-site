/* =========================================================
   내 여행 클라우드 저장·불러오기 (Supabase)
   - 저장: 이 기기의 찜·일정·보관한 일정·점검 기록을 Supabase에 올리고 "저장 코드"를 받음
   - 불러오기: 저장 코드를 넣으면 다른 기기·브라우저에서도 그대로 가져옴
   - 저장한 내용은 고치거나 지울 수 없음 (다시 저장하면 새 코드가 생김)
   ========================================================= */
(function () {
  'use strict';

  var CFG = window.GUIDE_SUPABASE;
  var KEYS = ['guide.favs', 'guide.plan', 'guide.saved', 'guide.checks'];
  var LAST_KEY = 'guide.cloudCode';
  // 헷갈리는 글자(0·O, 1·I·L)는 뺀 32글자 → 10자리 코드
  var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var CODE_RE = /^[A-HJ-NP-Z2-9]{10}$/;

  var box = document.getElementById('cloud-box');
  if (!box || !CFG || !CFG.url || !CFG.publishableKey) return;

  /* ---------- 작은 도우미 ---------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('has-action');
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { el.classList.remove('show'); }, 2500);
  }

  function newCode() {
    var a = new Uint8Array(10), s = '';
    crypto.getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += ALPHABET[a[i] % ALPHABET.length];
    return s;
  }
  function cleanCode(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  function api(path, body, prefer) {
    var headers = {
      'apikey': CFG.publishableKey,
      'Authorization': 'Bearer ' + CFG.publishableKey,
      'Content-Type': 'application/json'
    };
    if (prefer) headers.Prefer = prefer;
    return fetch(CFG.url + path, { method: 'POST', headers: headers, body: JSON.stringify(body) });
  }

  /* ---------- 저장 ---------- */
  function collect() {
    var items = {}, any = false;
    KEYS.forEach(function (k) {
      var raw = lsGet(k);
      if (raw === null) return;
      try {
        var v = JSON.parse(raw);
        items[k] = v;
        if (v && (Array.isArray(v) ? v.length : typeof v === 'object' ? Object.keys(v).length : true)) any = true;
      } catch (e) {}
    });
    return any ? { v: 1, savedAt: new Date().toISOString(), items: items } : null;
  }

  function save(btn) {
    var data = collect();
    if (!data) { toast('저장할 찜·일정이 아직 없어요'); return; }
    btn.disabled = true;
    btn.textContent = '저장 중…';
    var tries = 0;
    (function attempt() {
      var code = newCode();
      api('/rest/v1/trip_backups', { code: code, data: data }, 'return=minimal')
        .then(function (r) {
          if (r.status === 409 && ++tries < 3) return attempt(); // 코드가 겹치면 다시
          if (!r.ok) throw new Error('HTTP ' + r.status);
          lsSet(LAST_KEY, JSON.stringify({ code: code, at: data.savedAt }));
          render();
          toast('저장했어요. 코드를 적어 두세요: ' + code);
        })
        .catch(function () { toast('저장하지 못했어요. 인터넷 연결을 확인해 주세요'); })
        .then(function () { btn.disabled = false; btn.textContent = '☁️ 지금 저장하기'; });
    })();
  }

  /* ---------- 불러오기 ---------- */
  function load(input, btn) {
    var code = cleanCode(input.value);
    if (!CODE_RE.test(code)) { toast('저장 코드 10자리를 확인해 주세요'); input.focus(); return; }
    btn.disabled = true;
    api('/rest/v1/rpc/get_trip_backup', { p_code: code })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.items) { toast('그 코드로 저장된 내용이 없어요'); return; }
        if (!confirm('저장한 내 여행을 불러올까요?\n이 기기의 찜·일정·보관함·점검 기록이 저장한 내용으로 바뀝니다.')) return;
        KEYS.forEach(function (k) {
          if (Object.prototype.hasOwnProperty.call(data.items, k)) lsSet(k, JSON.stringify(data.items[k]));
          else lsDel(k);
        });
        lsSet(LAST_KEY, JSON.stringify({ code: code, at: data.savedAt }));
        // 앱이 처음부터 새 내용으로 그리도록 다시 엶
        location.reload();
      })
      .catch(function () { toast('불러오지 못했어요. 인터넷 연결을 확인해 주세요'); })
      .then(function () { btn.disabled = false; });
  }

  /* ---------- 화면 ---------- */
  function lastSaved() {
    try { return JSON.parse(lsGet(LAST_KEY)); } catch (e) { return null; }
  }
  function fmt(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function render() {
    var last = lastSaved();
    box.innerHTML =
      '<h2 class="cloud-title">☁️ 다른 기기에서도 보기</h2>' +
      '<p class="cloud-desc">찜·일정·보관한 일정·점검 기록을 인터넷에 저장하고, 저장 코드로 다른 휴대폰·PC에서 불러올 수 있어요.</p>' +
      (last && last.code
        ? '<p class="cloud-last">마지막 저장 코드 <strong class="cloud-code">' + last.code + '</strong>' +
          (last.at ? ' <span class="cloud-at">(' + fmt(last.at) + ')</span>' : '') +
          ' <button type="button" class="link-btn" data-cloud-copy>복사</button></p>'
        : '') +
      '<div class="cloud-row">' +
        '<button type="button" class="btn btn-small" data-cloud-save>☁️ 지금 저장하기</button>' +
      '</div>' +
      '<form class="cloud-row" data-cloud-load>' +
        '<label class="sr-only" for="cloud-code-input">저장 코드</label>' +
        '<input id="cloud-code-input" class="cloud-input" type="text" inputmode="text" autocomplete="off" ' +
          'autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="저장 코드 10자리">' +
        '<button type="submit" class="btn btn-small btn-outline">불러오기</button>' +
      '</form>' +
      '<p class="cloud-note">저장한 내용은 고치거나 지울 수 없어요. 바뀐 내용은 다시 저장하면 새 코드가 생겨요. 코드를 아는 사람은 누구나 불러올 수 있으니 남에게 알려 주지 마세요.</p>';
  }

  box.addEventListener('click', function (e) {
    var b = e.target.closest('[data-cloud-save]');
    if (b) { save(b); return; }
    if (e.target.closest('[data-cloud-copy]')) {
      var last = lastSaved();
      if (last && navigator.clipboard) {
        navigator.clipboard.writeText(last.code).then(function () { toast('코드를 복사했어요'); }, function () {});
      }
    }
  });
  box.addEventListener('submit', function (e) {
    e.preventDefault();
    load(document.getElementById('cloud-code-input'), e.target.querySelector('button'));
  });

  // '내 여행'(찜·일정·점검) 화면에서만 보임
  function sync() {
    var h = location.hash || '#/';
    box.hidden = !/^#\/(trip|saved|plan|checks)(\/|$)/.test(h);
  }
  window.addEventListener('hashchange', sync);

  render();
  sync();
})();
