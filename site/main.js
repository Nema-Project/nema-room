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
// The words come from the page's own #demo-text block, so this script carries no language.
(() => {
  const list = document.getElementById('entries');
  const counts = document.getElementById('counts');
  const data = document.getElementById('demo-text');
  const toggles = [...document.querySelectorAll('[data-msg]')];
  if (!list || !counts || !data) return;

  const T = JSON.parse(data.textContent);
  const PROVENANCE = {
    said: ['chip-said', T.provenance.said],
    decided: ['chip-decided', T.provenance.decided],
    inferred: ['chip-inferred', T.provenance.inferred],
  };
  const KIND = T.kind;
  const FILED = T.filed;
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

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
          `<div class="entry-top"><span class="entry-kind${kind === 'Q' && !resolved ? ' is-q' : ''}">${esc(KIND[kind])} ${e.id}${resolved ? ' · ' + esc(T.answered) : ''}</span>` +
          `<span class="chip ${chipClass}">${esc(chipText)}</span></div>` +
          `<p class="entry-title">${esc(e.title)}</p><p class="entry-src">${esc(T.source)}${esc(e.src)}</p>`;
        list.append(li);
      }
    }
    if (!list.children.length) {
      const li = document.createElement('li');
      li.className = 'board-empty';
      li.textContent = T.empty;
      list.append(li);
    }
    counts.textContent = T.counts.replace('{R}', tally.R).replace('{D}', tally.D).replace('{Q}', tally.Q);
  }

  toggles.forEach((t) => t.addEventListener('change', () => render(t)));
  render();
})();
