// Shared behavior for every page. Each block exits early if the elements
// it needs are absent, so this file runs unmodified on any page.

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// The theme follows the system unless the visitor picks one. The choice is
// applied before first paint by a one-line script in each page's <head>.
(function theme() {
    const toggle = document.getElementById('themeToggle');
    if (!toggle) return;

    const root = document.documentElement;
    const system = window.matchMedia('(prefers-color-scheme: dark)');

    const isDark = () => root.dataset.theme
        ? root.dataset.theme === 'dark'
        : system.matches;

    function label() {
        toggle.textContent = isDark() ? 'Light mode' : 'Dark mode';
    }

    toggle.addEventListener('click', () => {
        const next = isDark() ? 'light' : 'dark';
        root.dataset.theme = next;
        try { localStorage.setItem('theme', next); } catch (e) { /* private mode */ }
        label();
    });

    system.addEventListener('change', label);
    label();
})();

// ===== Background field =====
// A grid of points, slightly off-grid so it reads as scattered stations
// rather than graph paper. Points within reach of the pointer brighten and
// link to their neighbours. It only redraws while something is changing.
(function backgroundField() {
    const canvas = document.getElementById('fieldCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const SPACING = 46;
    const REACH = 170;

    let w = 0, h = 0, cols = 0, rows = 0;
    let points = [];
    let colors = { dot: '#526077', hot: '#1F4FD8' };
    let raf = null;
    const pointer = { x: -9999, y: -9999 };

    // Stable pseudo-random offset per grid cell, so a resize does not
    // reshuffle the field.
    function jitter(c, r, salt) {
        const n = Math.sin(c * 127.1 + r * 311.7 + salt * 74.7) * 43758.5453;
        return (n - Math.floor(n) - 0.5) * SPACING * 0.5;
    }

    function readColors() {
        const s = getComputedStyle(document.documentElement);
        colors = {
            dot: s.getPropertyValue('--text-muted').trim() || colors.dot,
            hot: s.getPropertyValue('--accent').trim() || colors.hot
        };
    }

    function build() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        w = window.innerWidth;
        h = window.innerHeight;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        cols = Math.ceil(w / SPACING) + 2;
        rows = Math.ceil(h / SPACING) + 2;
        const previous = points;
        points = [];
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const old = previous[r * cols + c];
                points.push({
                    x: (c - 0.5) * SPACING + jitter(c, r, 1),
                    y: (r - 0.5) * SPACING + jitter(c, r, 2),
                    heat: old ? old.heat : 0
                });
            }
        }
    }

    function link(a, b) {
        const strength = Math.min(a.heat, b.heat);
        if (strength < 0.04) return;
        ctx.globalAlpha = strength * 0.55;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
    }

    function draw() {
        raf = null;
        let active = false;

        // Ease each point toward how close the pointer is to it.
        points.forEach(p => {
            const d = Math.hypot(p.x - pointer.x, p.y - pointer.y);
            const target = d < REACH ? Math.pow(1 - d / REACH, 1.5) : 0;
            p.heat = REDUCED_MOTION ? target : p.heat + (target - p.heat) * 0.16;
            if (Math.abs(target - p.heat) > 0.004) active = true;
            else p.heat = target;
        });

        ctx.clearRect(0, 0, w, h);

        ctx.strokeStyle = colors.hot;
        ctx.lineWidth = 1;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const p = points[r * cols + c];
                if (p.heat < 0.04) continue;
                if (c + 1 < cols) link(p, points[r * cols + c + 1]);
                if (r + 1 < rows) link(p, points[(r + 1) * cols + c]);
                // One diagonal per cell, alternating, so the links read as
                // a graph and not as a square mesh.
                if (r + 1 < rows && (r + c) % 2 === 0 && c + 1 < cols) link(p, points[(r + 1) * cols + c + 1]);
                if (r + 1 < rows && (r + c) % 2 === 1 && c > 0) link(p, points[(r + 1) * cols + c - 1]);
            }
        }

        points.forEach(p => {
            ctx.globalAlpha = 0.22 + p.heat * 0.78;
            ctx.fillStyle = p.heat > 0.04 ? colors.hot : colors.dot;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 1.1 + p.heat * 2.2, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.globalAlpha = 1;

        if (active) schedule();
    }

    function schedule() {
        if (!raf) raf = requestAnimationFrame(draw);
    }

    window.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch') return;
        pointer.x = e.clientX;
        pointer.y = e.clientY;
        schedule();
    }, { passive: true });

    document.documentElement.addEventListener('pointerleave', () => {
        pointer.x = pointer.y = -9999;
        schedule();
    });

    window.addEventListener('resize', () => { build(); schedule(); });

    // Repaint in the new colours whenever the theme changes.
    const repaint = () => { readColors(); schedule(); };
    new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaint);

    readColors();
    build();
    schedule();
})();

(function footerYear() {
    const el = document.getElementById('year');
    if (el) el.textContent = String(new Date().getFullYear());
})();

// ===== Question-to-answer panel =====
// Illustrative examples of the pipeline the research builds: a question, the
// domain knowledge that pins down its terms, the Cypher it becomes, and what
// the query returns. The first example is also in the HTML, so the panel
// reads correctly without JavaScript.
(function askPanel() {
    const panel = document.getElementById('ask');
    if (!panel) return;

    const EXAMPLES = [
        {
            q: 'Which stations in Fukushima had the worst air last winter?',
            k: [
                ['Fukushima', "the canonical value prefecture = 'Fukushima'"],
                ['last winter', 'December to February'],
                ['worst air', 'highest mean PM2.5']
            ],
            c: "MATCH (s:Station)-[:RECORDED]->(o:Observation)\n" +
               "WHERE s.prefecture = 'Fukushima'\n" +
               "  AND o.month IN [12, 1, 2]\n" +
               "RETURN s.name, avg(o.pm25) AS mean\n" +
               "ORDER BY mean DESC LIMIT 5",
            r: 'Five stations ranked by winter mean, each traceable to the hourly observations behind it.'
        },
        {
            q: 'Where is it congested at 5 PM?',
            k: [
                ['5 PM', 'the hour value 17'],
                ['congested', 'the CONGESTED_AT relationship']
            ],
            c: "MATCH (s:Segment)-[:CONGESTED_AT]->(t:TimeSlot)\n" +
               "WHERE t.hour = 17\n" +
               "RETURN s.name, t.level",
            r: 'The road segments congested at 17:00 and their level, with the neighbouring segments that share the pattern.'
        },
        {
            q: 'How often did Tokyo read above the daily PM2.5 limit in 2023?',
            k: [
                ['Tokyo', "the canonical value prefecture = 'Tokyo'"],
                ['daily limit', "Japan's standard of 35 µg/m³"]
            ],
            c: "MATCH (s:Station)-[:RECORDED]->(o:Observation)\n" +
               "WHERE s.prefecture = 'Tokyo'\n" +
               "  AND o.year = 2023 AND o.pm25 > 35\n" +
               "RETURN s.name, count(o) AS exceedances\n" +
               "ORDER BY exceedances DESC",
            r: 'A count per station, so a high number can be checked against the readings that produced it.'
        }
    ];

    const tabs = Array.from(panel.querySelectorAll('.ask-tabs button'));
    const qEl = panel.querySelector('.ask-q');
    const kEl = panel.querySelector('.ask-k');
    const cEl = panel.querySelector('.ask-c');
    const rEl = panel.querySelector('.ask-r');
    if (!tabs.length || !qEl || !kEl || !cEl || !rEl) return;

    const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const highlight = s => escape(s).replace(
        /\b(MATCH|WHERE|RETURN|AND|ORDER BY|LIMIT|DESC|AS|IN)\b/g,
        '<span class="kw">$1</span>'
    );

    let current = 0;
    let typeTimer = null;
    let cycleTimer = null;

    function show(index, animate) {
        const ex = EXAMPLES[index];
        current = index;
        clearTimeout(typeTimer);

        tabs.forEach((tab, i) => tab.setAttribute('aria-selected', String(i === index)));

        kEl.innerHTML = ex.k
            .map(([term, meaning]) => `<li><code>${escape(term)}</code> means ${escape(meaning)}</li>`)
            .join('');
        cEl.innerHTML = highlight(ex.c);
        rEl.textContent = ex.r;

        if (!animate || REDUCED_MOTION) {
            panel.classList.remove('typing');
            qEl.textContent = ex.q;
            return;
        }

        // Type the question, then let the rest of the pipeline appear.
        panel.classList.add('typing');
        qEl.textContent = '';
        let n = 0;
        (function type() {
            qEl.textContent = ex.q.slice(0, ++n);
            if (n < ex.q.length) {
                typeTimer = setTimeout(type, 22);
            } else {
                typeTimer = setTimeout(() => panel.classList.remove('typing'), 250);
            }
        })();
    }

    function stopCycle() {
        clearInterval(cycleTimer);
        cycleTimer = null;
    }

    tabs.forEach((tab, i) => {
        tab.addEventListener('click', () => { stopCycle(); show(i, true); });
    });

    // Cycle on its own until the visitor touches the panel.
    panel.addEventListener('pointerenter', stopCycle);
    panel.addEventListener('focusin', stopCycle);

    if (!REDUCED_MOTION) {
        cycleTimer = setInterval(() => {
            if (document.hidden) return;
            show((current + 1) % EXAMPLES.length, true);
        }, 9000);
    }
})();

// ===== Publication counters =====
// Counts come from the rendered cards, so they stay correct after the
// weekly ORCID/Crossref regeneration without anyone updating a number.
(function publicationStats() {
    const container = document.getElementById('pubStats');
    if (!container) return;

    const cards = Array.from(document.querySelectorAll('.pub-card'));
    if (!cards.length) return;

    cards.forEach(card => {
        const title = card.querySelector('.pub-title');
        if (!title) return;

        // A card is first-authored when the bolded name opens the author list.
        const first = title.firstElementChild;
        const isFirst = first && first.tagName === 'STRONG' &&
            (title.firstChild === first || !title.firstChild.textContent.trim());

        // Show the paper title ahead of the authors.
        const paper = title.querySelector('em');
        if (paper) title.prepend(paper);

        if (!isFirst) return;

        card.dataset.first = 'true';
        const tag = document.createElement('span');
        tag.className = 'first-author';
        tag.textContent = 'First author';
        const type = card.querySelector('.pub-type');
        if (type) type.after(tag);
    });

    const typeOf = card => {
        const el = card.querySelector('.pub-type');
        return el ? el.textContent.trim() : '';
    };

    const totals = {
        total: cards.length,
        journal: cards.filter(c => typeOf(c) === 'Journal').length,
        first: cards.filter(c => c.dataset.first === 'true').length
    };

    container.querySelectorAll('.pub-stat .value').forEach(el => {
        const target = totals[el.dataset.stat];
        if (typeof target === 'number') el.textContent = String(target);
    });
})();

(function publicationFilters() {
    const searchInput = document.getElementById('pubSearch');
    const pillContainer = document.getElementById('pubFilterPills');
    const noResults = document.getElementById('pubNoResults');
    const yearGroups = document.querySelectorAll('.pub-year-group');
    if (!yearGroups.length || !pillContainer) return;

    let activeType = 'all';

    function applyFilters() {
        const query = (searchInput ? searchInput.value : '').trim().toLowerCase();
        let anyVisibleTotal = false;

        yearGroups.forEach(group => {
            let anyVisibleInGroup = false;

            group.querySelectorAll('.pub-card').forEach(card => {
                const typeEl = card.querySelector('.pub-type');
                const titleEl = card.querySelector('.pub-title');
                const type = typeEl ? typeEl.textContent.trim() : '';
                const text = titleEl ? titleEl.textContent.toLowerCase() : '';

                const typeMatch = activeType === 'all' ||
                    (activeType === 'first' ? card.dataset.first === 'true' : type === activeType);
                const searchMatch = !query || text.includes(query);
                const visible = typeMatch && searchMatch;

                card.style.display = visible ? '' : 'none';
                if (visible) anyVisibleInGroup = true;
            });

            group.style.display = anyVisibleInGroup ? '' : 'none';
            if (anyVisibleInGroup) anyVisibleTotal = true;
        });

        if (noResults) noResults.style.display = anyVisibleTotal ? 'none' : '';
    }

    pillContainer.addEventListener('click', (event) => {
        const button = event.target.closest('.pill');
        if (!button) return;

        pillContainer.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
        button.classList.add('active');
        activeType = button.dataset.type;
        applyFilters();
    });

    if (searchInput) searchInput.addEventListener('input', applyFilters);
})();

(function kgDiagram() {
    const hotspots = document.querySelectorAll('.kg-hotspot');
    const detail = document.getElementById('kgDetail');
    if (!hotspots.length || !detail) return;

    const defaultText = detail.textContent;

    function select(el) {
        hotspots.forEach(h => h.classList.remove('active'));
        el.classList.add('active');
        detail.textContent = el.dataset.detail || defaultText;
        detail.classList.add('filled');
    }

    hotspots.forEach(el => {
        el.addEventListener('click', () => select(el));
        el.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                select(el);
            }
        });
    });
})();
