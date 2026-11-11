/* =========================================================
   장소 상세 화면의 "✨ AI 여행 팁" (Gemini, /api/travel_tip)
   - 로그인한 사람만 받을 수 있음 (로그인은 '내 여행' 화면 아래 칸에서)
   - 한 번 받은 팁은 이 기기에 저장해 두고 다시 부르지 않음 (사용량 절약)
   ========================================================= */
(function () {
  'use strict';

  var CACHE_KEY = 'guide.aiTips';
  var MAX_CACHE = 60;

  function findPlace(id) { return window.GUIDE_FIND_PLACE ? window.GUIDE_FIND_PLACE(id) : null; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch (e) { return {}; } }
  function writeCache(id, tip) {
    var c = readCache();
    c[id] = { tip: tip, at: Date.now() };
    var ids = Object.keys(c).sort(function (a, b) { return c[b].at - c[a].at; });
    ids.slice(MAX_CACHE).forEach(function (k) { delete c[k]; });
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) {}
  }

  function tipHTML(tip) {
    return '<div class="ai-tip-text">' + esc(tip).replace(/\n+/g, '<br>') + '</div>' +
      '<p class="ai-tip-note">AI가 만든 참고용 팁이에요. 운영 시간·가격은 방문 전 꼭 확인해 주세요.</p>';
  }

  function currentId() {
    var m = (location.hash || '').match(/^#\/place\/(.+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // 장소 상세 화면이 그려진 뒤 칸 넣기
  function mount() {
    var id = currentId();
    if (!id) return;
    var view = document.getElementById('view-place');
    var info = view && view.querySelector('.info');
    if (!info || view.querySelector('.ai-tip')) return;
    var p = findPlace(id);
    if (!p) return;

    var box = document.createElement('section');
    box.className = 'ai-tip';
    box.setAttribute('aria-label', 'AI 여행 팁');
    var cached = readCache()[id];
    box.innerHTML = '<h2 class="ai-tip-title">✨ AI 여행 팁</h2>' +
      (cached ? tipHTML(cached.tip)
        : '<p class="ai-tip-desc">가기 좋은 때, 꼭 둘러볼 것, 미리 알아 둘 점을 AI가 짧게 알려 드려요.</p>' +
          '<button type="button" class="btn btn-small" data-ai-tip>✨ AI 여행 팁 받기</button>');
    info.insertAdjacentElement('afterend', box);
  }

  function ask(btn) {
    var id = currentId(), p = id && findPlace(id);
    var box = btn.closest('.ai-tip');
    if (!p || !box) return;
    var sb = window.GUIDE_SB;
    if (!sb) { show(box, '지금은 로그인 기능을 불러오지 못했어요. 새로고침해 주세요'); return; }
    btn.disabled = true;
    btn.textContent = 'AI가 쓰는 중…';
    sb.auth.getSession().then(function (res) {
      var session = res && res.data && res.data.session;
      if (!session) {
        show(box, '로그인한 사람만 받을 수 있어요. <a href="#/saved">내 여행</a> 화면 아래에서 로그인해 주세요.', true);
        return;
      }
      return fetch('/api/travel_tip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
        body: JSON.stringify({ name: p.name, region: p.region, type: p.type, address: p.address || '', summary: p.summary || '' })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || !j.tip) throw new Error(j.error || 'AI가 지금 답하지 못했어요');
          writeCache(id, j.tip);
          if (currentId() === id) box.innerHTML = '<h2 class="ai-tip-title">✨ AI 여행 팁</h2>' + tipHTML(j.tip);
        });
      });
    }).catch(function (e) {
      show(box, esc(e && e.message ? e.message : 'AI가 지금 답하지 못했어요'));
    });
  }

  function show(box, msgHTML, keepBtnHidden) {
    var btn = box.querySelector('[data-ai-tip]');
    var msg = box.querySelector('.ai-tip-msg');
    if (!msg) { msg = document.createElement('p'); msg.className = 'ai-tip-msg'; box.appendChild(msg); }
    msg.innerHTML = msgHTML;
    if (btn) { btn.disabled = false; btn.textContent = '✨ AI 여행 팁 받기'; btn.hidden = !!keepBtnHidden; }
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-ai-tip]');
    if (b && !b.disabled) ask(b);
  });
  // app.js가 장소 화면을 새로 그릴 때마다(찜 누르기 등 포함) 칸을 다시 넣음
  var view = document.getElementById('view-place');
  if (view && window.MutationObserver) new MutationObserver(mount).observe(view, { childList: true });
  window.addEventListener('hashchange', function () { setTimeout(mount, 0); });
  mount();
})();
