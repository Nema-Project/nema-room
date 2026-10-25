// Reveal each [data-reveal] once as it enters the viewport; never leaves content hidden.
(() => {
  const targets = document.querySelectorAll('[data-reveal]');
  if (!('IntersectionObserver' in window)) { targets.forEach((el) => el.classList.add('is-in')); return; }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });
  targets.forEach((el) => io.observe(el));
  window.addEventListener('load', () => setTimeout(() => {
    targets.forEach((el) => { const r = el.getBoundingClientRect(); if (r.top < innerHeight && r.bottom > 0) el.classList.add('is-in'); });
  }, 2500));
})();

// The demo: each message in the discussion files one or more entries, each traced to its source.
(() => {
  const list = document.getElementById('entries');
  const counts = document.getElementById('counts');
  const toggles = [...document.querySelectorAll('[data-msg]')];
  if (!list || !counts) return;

  const PROVENANCE = {
    said: ['chip-said', '用户陈述'],
    decided: ['chip-decided', '用户决定'],
    inferred: ['chip-inferred', 'Agent 推断'],
  };
  const KIND = { R: '需求', D: '决策', Q: '问题' };
  const FILED = {
    m1: [{ id: 'R-1', title: '账单页可按月导出 CSV', by: 'said', src: '林 · 10:02' }],
    m2: [{ id: 'D-1', title: '首版只做 CSV，不做 PDF', by: 'decided', src: '周 · 10:05' }],
    m3: [{ id: 'R-2', title: '金额保留两位小数，JPY 取整', by: 'said', src: '林 · 10:07' }],
    m4: [{ id: 'Q-1', title: 'CSV 是否带 UTF-8 BOM', by: 'inferred', src: 'Nema · 10:08' }],
    m5: [{ id: 'D-2', title: '导出文件带 UTF-8 BOM', by: 'decided', src: '周 · 10:12 · 回答了 Q-1' }],
    m6: [
      { id: 'R-3', title: '按东京时间划分账单月份', by: 'said', src: '林 · 10:15' },
      { id: 'Q-2', title: '旧账单是否按新时区重算', by: 'inferred', src: 'Nema · 10:15 · 由 R-3 引出' },
    ],
  };

  function render(changed) {
    const on = new Set(toggles.filter((t) => t.checked).map((t) => t.dataset.msg));
    const fresh = changed && changed.checked ? new Set(FILED[changed.dataset.msg].map((e) => e.id)) : new Set();
    const tally = { R: 0, D: 0, Q: 0 };
    list.replaceChildren();
    for (const msg of Object.keys(FILED)) {
      if (!on.has(msg)) continue;
      for (const e of FILED[msg]) {
        const kind = e.id[0];
        const resolved = e.id === 'Q-1' && on.has('m5');
        if (!(kind === 'Q' && resolved)) tally[kind] += 1;
        const [chipClass, chipText] = PROVENANCE[e.by];
        const li = document.createElement('li');
        li.className = 'entry' + (fresh.has(e.id) ? ' is-new' : '') + (resolved ? ' is-resolved' : '');
        li.innerHTML =
          `<div class="entry-top"><span class="entry-kind${kind === 'Q' && !resolved ? ' is-q' : ''}">${KIND[kind]} ${e.id}${resolved ? ' · 已回答' : ''}</span>` +
          `<span class="chip ${chipClass}">${chipText}</span></div>` +
          `<p class="entry-title">${e.title}</p><p class="entry-src">来源：${e.src}</p>`;
        list.append(li);
      }
    }
    if (!list.children.length) {
      const li = document.createElement('li');
      li.className = 'board-empty';
      li.textContent = '还没有条目。打开右侧任意一条消息。';
      list.append(li);
    }
    counts.textContent = `需求 ${tally.R} · 决策 ${tally.D} · 问题 ${tally.Q}`;
  }

  toggles.forEach((t) => t.addEventListener('change', () => render(t)));
  render();
})();
