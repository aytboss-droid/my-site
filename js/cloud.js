/* =========================================================
   내 여행 클라우드 저장·불러오기 + 회원가입·로그인 (Supabase)
   - 회원가입·로그인: 이메일 + 비밀번호
   - 저장: 로그인한 사람만. 이 기기의 찜·일정·보관한 일정·점검 기록을 올리고 "저장 코드"를 받음
   - 내 저장 목록: 본인 것만 보이고, 본인 것만 덮어쓰기·삭제 가능 (Supabase RLS가 막음)
   - 코드로 불러오기: 로그인하지 않아도 코드만 알면 가능
   ========================================================= */
(function () {
  'use strict';

  var CFG = window.GUIDE_SUPABASE;
  var KEYS = ['guide.favs', 'guide.plan', 'guide.saved', 'guide.checks'];
  var LAST_KEY = 'guide.cloudCode';
  // 헷갈리는 글자(0·O, 1·I·L)는 뺀 글자로 10자리 코드
  var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var CODE_RE = /^[A-HJ-NP-Z2-9]{10}$/;

  var box = document.getElementById('cloud-box');
  if (!box || !CFG || !CFG.url || !CFG.publishableKey) return;

  if (!window.supabase || !window.supabase.createClient) {
    box.innerHTML = '<h2 class="cloud-title">☁️ 다른 기기에서도 보기</h2>' +
      '<p class="cloud-desc">지금은 저장 기능을 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.</p>';
    sync();
    window.addEventListener('hashchange', sync);
    return;
  }

  var sb = window.supabase.createClient(CFG.url, CFG.publishableKey, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'guide.auth' }
  });

  window.GUIDE_SB = sb; // AI 여행 팁(js/ai-tip.js)이 로그인 토큰을 쓰려고 같이 씀

  var user = null;      // 로그인한 사람 (없으면 null)
  var myList = [];      // 내 저장 목록
  var busy = false;

  /* ---------- 작은 도우미 ---------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('has-action');
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { el.classList.remove('show'); }, 3000);
  }

  // Supabase 오류를 알아듣기 쉬운 말로
  function errMsg(err, fallback) {
    var m = (err && (err.message || err.error_description)) || '';
    if (/Invalid login credentials/i.test(m)) return '이메일 또는 비밀번호가 맞지 않아요';
    if (/Email not confirmed/i.test(m)) return '가입 확인 메일의 링크를 먼저 눌러 주세요';
    if (/already registered|already been registered/i.test(m)) return '이미 가입한 이메일이에요. 로그인해 주세요';
    if (/Password should be at least/i.test(m)) return '비밀번호는 6자 이상으로 정해 주세요';
    if (/valid email|invalid format/i.test(m)) return '이메일 주소를 확인해 주세요';
    if (/rate limit|too many/i.test(m)) return '요청이 많아요. 잠시 뒤에 다시 해 주세요';
    if (/JWT|not authenticated|permission denied|row-level security/i.test(m)) return '로그인이 풀렸어요. 다시 로그인해 주세요';
    return fallback || '처리하지 못했어요. 인터넷 연결을 확인해 주세요';
  }

  function newCode() {
    var a = new Uint8Array(10), s = '';
    crypto.getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += ALPHABET[a[i] % ALPHABET.length];
    return s;
  }
  function cleanCode(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  function fmt(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /* ---------- 이 기기의 내 여행 모으기·바꾸기 ---------- */
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
  function apply(data, code) {
    if (!confirm('저장한 내 여행을 불러올까요?\n이 기기의 찜·일정·보관함·점검 기록이 저장한 내용으로 바뀝니다.')) return;
    KEYS.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(data.items, k)) lsSet(k, JSON.stringify(data.items[k]));
      else lsDel(k);
    });
    lsSet(LAST_KEY, JSON.stringify({ code: code, at: data.savedAt }));
    location.reload(); // 앱이 새 내용으로 처음부터 그리도록
  }

  /* ---------- 회원가입·로그인·로그아웃 ---------- */
  function readAuthForm() {
    var email = (document.getElementById('cloud-email') || {}).value || '';
    var pw = (document.getElementById('cloud-pw') || {}).value || '';
    email = email.trim();
    if (!email || !pw) { toast('이메일과 비밀번호를 넣어 주세요'); return null; }
    return { email: email, password: pw };
  }

  function signIn() {
    var f = readAuthForm(); if (!f) return;
    run(sb.auth.signInWithPassword(f).then(function (res) {
      if (res.error) throw res.error;
      toast('로그인했어요');
    }), '로그인하지 못했어요');
  }

  function signUp() {
    var f = readAuthForm(); if (!f) return;
    if (f.password.length < 6) { toast('비밀번호는 6자 이상으로 정해 주세요'); return; }
    run(sb.auth.signUp({
      email: f.email, password: f.password,
      options: { emailRedirectTo: location.origin + location.pathname }
    }).then(function (res) {
      if (res.error) throw res.error;
      // 이미 가입한 이메일이면 Supabase가 빈 identities로 돌려줌
      if (res.data.user && res.data.user.identities && res.data.user.identities.length === 0) {
        throw new Error('already registered');
      }
      if (res.data.session) toast('가입하고 로그인했어요');
      else toast('확인 메일을 보냈어요. 메일의 링크를 누르면 가입이 끝나요');
    }), '가입하지 못했어요');
  }

  function signOut() {
    run(sb.auth.signOut().then(function (res) {
      if (res.error) throw res.error;
      toast('로그아웃했어요');
    }), '로그아웃하지 못했어요');
  }

  /* ---------- 저장·목록·덮어쓰기·삭제 (로그인한 사람만) ---------- */
  function refreshList() {
    if (!user) { myList = []; render(); return Promise.resolve(); }
    return sb.from('trip_backups')
      .select('code, updated_at, created_at')
      .order('updated_at', { ascending: false })
      .then(function (res) {
        if (res.error) throw res.error;
        myList = res.data || [];
        render();
      })
      .catch(function (e) { toast(errMsg(e, '내 저장 목록을 불러오지 못했어요')); });
  }

  function saveNew() {
    var data = collect();
    if (!data) { toast('저장할 찜·일정이 아직 없어요'); return; }
    var tries = 0;
    function attempt() {
      var code = newCode();
      return sb.from('trip_backups').insert({ code: code, data: data }).then(function (res) {
        if (res.error && res.error.code === '23505' && ++tries < 3) return attempt(); // 코드가 겹치면 다시
        if (res.error) throw res.error;
        lsSet(LAST_KEY, JSON.stringify({ code: code, at: data.savedAt }));
        toast('저장했어요. 저장 코드: ' + code);
        return refreshList();
      });
    }
    run(attempt(), '저장하지 못했어요');
  }

  function overwrite(code) {
    var data = collect();
    if (!data) { toast('저장할 찜·일정이 아직 없어요'); return; }
    if (!confirm('저장 코드 ' + code + '에 지금 이 기기의 내 여행을 덮어쓸까요?')) return;
    run(sb.from('trip_backups').update({ data: data }).eq('code', code).select('code').then(function (res) {
      if (res.error) throw res.error;
      if (!res.data || !res.data.length) throw new Error('permission denied');
      lsSet(LAST_KEY, JSON.stringify({ code: code, at: data.savedAt }));
      toast('덮어썼어요');
      return refreshList();
    }), '덮어쓰지 못했어요');
  }

  function remove(code) {
    if (!confirm('저장 코드 ' + code + '를 지울까요?\n지우면 이 코드로 다시 불러올 수 없어요.')) return;
    run(sb.from('trip_backups').delete().eq('code', code).select('code').then(function (res) {
      if (res.error) throw res.error;
      if (!res.data || !res.data.length) throw new Error('permission denied');
      var last = lastSaved();
      if (last && last.code === code) lsDel(LAST_KEY);
      toast('지웠어요');
      return refreshList();
    }), '지우지 못했어요');
  }

  function loadMine(code) {
    run(sb.from('trip_backups').select('data').eq('code', code).maybeSingle().then(function (res) {
      if (res.error) throw res.error;
      if (!res.data) { toast('그 저장을 찾지 못했어요'); return; }
      apply(res.data.data, code);
    }), '불러오지 못했어요');
  }

  /* ---------- 코드로 불러오기 (누구나) ---------- */
  function loadByCode(input) {
    var code = cleanCode(input.value);
    if (!CODE_RE.test(code)) { toast('저장 코드 10자리를 확인해 주세요'); input.focus(); return; }
    run(sb.rpc('get_trip_backup', { p_code: code }).then(function (res) {
      if (res.error) throw res.error;
      if (!res.data || !res.data.items) { toast('그 코드로 저장된 내용이 없어요'); return; }
      apply(res.data, code);
    }), '불러오지 못했어요');
  }

  // 버튼을 잠깐 막아 두고 실행, 실패하면 알림
  function run(promise, fallback) {
    busy = true; render();
    return Promise.resolve(promise)
      .catch(function (e) { toast(errMsg(e, fallback)); })
      .then(function () { busy = false; render(); });
  }

  /* ---------- 화면 ---------- */
  function lastSaved() {
    try { return JSON.parse(lsGet(LAST_KEY)); } catch (e) { return null; }
  }

  function render() {
    var dis = busy ? ' disabled' : '';
    var html = '<h2 class="cloud-title">☁️ 다른 기기에서도 보기</h2>';

    if (!user) {
      html +=
        '<p class="cloud-desc">로그인하면 찜·일정·보관한 일정·점검 기록을 인터넷에 저장하고, 다른 휴대폰·PC에서 이어 볼 수 있어요.</p>' +
        '<form class="cloud-auth" data-cloud-auth>' +
          '<label class="cloud-label" for="cloud-email">이메일</label>' +
          '<input id="cloud-email" class="cloud-input cloud-input-plain" type="email" autocomplete="email" inputmode="email" required>' +
          '<label class="cloud-label" for="cloud-pw">비밀번호 <span class="cloud-hint">(6자 이상)</span></label>' +
          '<input id="cloud-pw" class="cloud-input cloud-input-plain" type="password" autocomplete="current-password" minlength="6" required>' +
          '<div class="cloud-row">' +
            '<button type="submit" class="btn btn-small"' + dis + '>로그인</button>' +
            '<button type="button" class="btn btn-small btn-outline" data-cloud-signup' + dis + '>회원가입</button>' +
          '</div>' +
        '</form>';
    } else {
      html +=
        '<p class="cloud-user"><span>👤 <strong>' + esc(user.email) + '</strong> 로그인 중</span>' +
          ' <button type="button" class="link-btn" data-cloud-logout' + dis + '>로그아웃</button></p>' +
        '<div class="cloud-row">' +
          '<button type="button" class="btn btn-small" data-cloud-save' + dis + '>☁️ 지금 새로 저장하기</button>' +
        '</div>' +
        (myList.length
          ? '<h3 class="cloud-sub">내 저장 목록</h3><ul class="cloud-list">' +
            myList.map(function (it) {
              return '<li class="cloud-item">' +
                '<span class="cloud-item-info"><strong class="cloud-code">' + esc(it.code) + '</strong>' +
                  '<span class="cloud-at">' + fmt(it.updated_at) + '</span></span>' +
                '<span class="cloud-item-btns">' +
                  '<button type="button" class="link-btn" data-cloud-load="' + esc(it.code) + '"' + dis + '>불러오기</button>' +
                  '<button type="button" class="link-btn" data-cloud-over="' + esc(it.code) + '"' + dis + '>덮어쓰기</button>' +
                  '<button type="button" class="link-btn cloud-del" data-cloud-del="' + esc(it.code) + '"' + dis + '>삭제</button>' +
                '</span></li>';
            }).join('') + '</ul>'
          : '<p class="cloud-desc cloud-empty">아직 저장한 내 여행이 없어요.</p>');
    }

    html +=
      '<form class="cloud-row cloud-code-form" data-cloud-load-code>' +
        '<label class="sr-only" for="cloud-code-input">저장 코드</label>' +
        '<input id="cloud-code-input" class="cloud-input" type="text" autocomplete="off" ' +
          'autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="저장 코드로 불러오기 (10자리)">' +
        '<button type="submit" class="btn btn-small btn-outline"' + dis + '>불러오기</button>' +
      '</form>' +
      '<p class="cloud-note">저장 코드를 아는 사람은 로그인하지 않아도 그 내용을 불러올 수 있어요. 덮어쓰기·삭제는 저장한 본인만 할 수 있어요.</p>';

    // 입력하던 값은 다시 그려도 남김
    var keep = {};
    ['cloud-email', 'cloud-pw', 'cloud-code-input'].forEach(function (id) {
      var el = document.getElementById(id); if (el) keep[id] = el.value;
    });
    box.innerHTML = html;
    Object.keys(keep).forEach(function (id) {
      var el = document.getElementById(id); if (el) el.value = keep[id];
    });
  }

  box.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.hasAttribute('data-cloud-signup')) signUp();
    else if (t.hasAttribute('data-cloud-logout')) signOut();
    else if (t.hasAttribute('data-cloud-save')) saveNew();
    else if (t.dataset.cloudLoad) loadMine(t.dataset.cloudLoad);
    else if (t.dataset.cloudOver) overwrite(t.dataset.cloudOver);
    else if (t.dataset.cloudDel) remove(t.dataset.cloudDel);
  });
  box.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    if (e.target.hasAttribute('data-cloud-auth')) signIn();
    else if (e.target.hasAttribute('data-cloud-load-code')) loadByCode(document.getElementById('cloud-code-input'));
  });

  // 로그인 상태가 바뀌면 화면·목록 새로
  sb.auth.onAuthStateChange(function (event, session) {
    var next = session ? session.user : null;
    var changed = (next && next.id) !== (user && user.id);
    user = next;
    // 가입 확인 메일 링크로 돌아오면 주소의 ?code=... 를 지움
    if (event === 'SIGNED_IN' && /[?&]code=/.test(location.search)) {
      history.replaceState(null, '', location.pathname + location.hash);
      toast('가입 확인이 끝났어요. 로그인했어요');
    }
    if (changed) setTimeout(refreshList, 0); else render();
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
