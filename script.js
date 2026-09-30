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

// ===== Hero graph =====
// A small live knowledge graph behind the hero. The hubs are the entity
// types the example queries use; the small nodes are instances of them.
// It drifts on its own, makes room for the pointer, lets a node be dragged,
// and lights up the path the query in the panel is walking.
(function heroGraph() {
    const canvas = document.getElementById('heroCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const host = canvas.parentElement;

    // name, anchor (fraction of the band), number of instance nodes
    const HUBS = [
        ['Prefecture',  0.17, 0.09, 4],
        ['Station',     0.045, 0.46, 6],
        ['Observation', 0.13, 0.92, 7],
        ['PM2.5',       0.36, 0.93, 3],
        ['TimeSlot',    0.60, 0.92, 4],
        ['Segment',     0.955, 0.60, 6],
        ['Road',        0.95, 0.14, 3],
        ['Congestion',  0.62, 0.07, 3]
    ];

    const RELATIONS = [
        ['Station', 'Prefecture', 'LOCATED_IN'],
        ['Station', 'Observation', 'RECORDED'],
        ['Observation', 'PM2.5', 'MEASURES'],
        ['Observation', 'TimeSlot', 'AT'],
        ['Segment', 'TimeSlot', 'CONGESTED_AT'],
        ['Segment', 'Road', 'PART_OF'],
        ['Segment', 'Congestion', 'HAS_LEVEL'],
        ['Prefecture', 'Congestion', '']
    ];

    const COLORS = { node: '#8FB0FF', hub: '#E8EDF4', edge: '#8FB0FF', hot: '#F2B54A', label: '#9FB0C8' };
    const REACH = 170;

    // Deterministic pseudo-random, so the layout is the same on every load.
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

    const nodes = [];
    const edges = [];
    const byName = {};

    HUBS.forEach(([name, fx, fy, count]) => {
        const hub = { name, fx, fy, ox: 0, oy: 0, hub: true, r: 6.5, phase: rand() * 6.28 };
        byName[name] = hub;
        nodes.push(hub);
        for (let i = 0; i < count; i++) {
            const angle = (i / count) * 6.28 + rand() * 0.9;
            const dist = 40 + rand() * 36;
            const sat = {
                fx, fy, ox: Math.cos(angle) * dist, oy: Math.sin(angle) * dist,
                hub: false, r: 2.2 + rand() * 1.6, phase: rand() * 6.28
            };
            nodes.push(sat);
            edges.push({ a: hub, b: sat, rest: dist, label: '', key: '' });
        }
    });

    RELATIONS.forEach(([from, to, label]) => {
        edges.push({ a: byName[from], b: byName[to], rest: 0, label, key: from + '>' + to });
    });

    let w = 0, h = 0, scale = 1;
    let raf = null, running = false, last = 0, clock = 0;
    let hotHubs = new Set(), hotEdges = new Set();
    let pulses = [];
    let dragging = null;
    const pointer = { x: -9999, y: -9999 };

    function anchor(n) {
        return { x: n.fx * w + n.ox * scale, y: n.fy * h + n.oy * scale };
    }

    function resize() {
        const rect = host.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        w = rect.width;
        h = rect.height;
        scale = Math.max(0.6, Math.min(1, w / 1000));
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        nodes.forEach(n => {
            const p = anchor(n);
            if (n.x === undefined) { n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0; }
        });
    }

    function setPath(path) {
        hotHubs = new Set(path);
        hotEdges = new Set();
        edges.forEach(e => {
            if (e.key && hotHubs.has(e.a.name) && hotHubs.has(e.b.name)) hotEdges.add(e);
        });
        pulses = pulses.filter(p => !p.hot);
        if (!running) draw();
    }

    function step(dt) {
        clock += dt;

        nodes.forEach(n => {
            if (n === dragging) return;
            const p = anchor(n);
            // The anchor itself wanders, which is what keeps the graph alive.
            const tx = p.x + Math.sin(clock / 2300 + n.phase) * 14;
            const ty = p.y + Math.cos(clock / 2900 + n.phase * 1.7) * 14;
            n.vx += (tx - n.x) * 0.012;
            n.vy += (ty - n.y) * 0.012;

            // Make room for the pointer.
            const dx = n.x - pointer.x, dy = n.y - pointer.y;
            const d = Math.hypot(dx, dy);
            if (d < REACH && d > 1) {
                const push = Math.pow(1 - d / REACH, 2) * 2.4;
                n.vx += (dx / d) * push;
                n.vy += (dy / d) * push;
            }
        });

        // Instance nodes stay tethered to their hub, so dragging a hub
        // pulls its cluster along.
        edges.forEach(e => {
            if (!e.rest) return;
            const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
            const d = Math.hypot(dx, dy) || 1;
            const pull = (d - e.rest * scale) * 0.02;
            if (e.b !== dragging) { e.b.vx -= (dx / d) * pull; e.b.vy -= (dy / d) * pull; }
        });

        nodes.forEach(n => {
            if (n === dragging) return;
            n.vx *= 0.86;
            n.vy *= 0.86;
            n.x += n.vx;
            n.y += n.vy;
        });

        // Pulses: a few wandering ones, and a steady stream along the
        // path the current query walks.
        if (rand() < 0.035 && pulses.length < 14) {
            pulses.push({ e: edges[Math.floor(rand() * edges.length)], t: 0, speed: 0.0007 + rand() * 0.0006, hot: false });
        }
        hotEdges.forEach(e => {
            if (rand() < 0.03) pulses.push({ e, t: 0, speed: 0.0011, hot: true });
        });
        pulses.forEach(p => { p.t += p.speed * dt; });
        pulses = pulses.filter(p => p.t < 1);
    }

    function draw() {
        ctx.clearRect(0, 0, w, h);

        edges.forEach(e => {
            const hot = hotEdges.has(e);
            ctx.beginPath();
            ctx.moveTo(e.a.x, e.a.y);
            ctx.lineTo(e.b.x, e.b.y);
            ctx.strokeStyle = hot ? COLORS.hot : COLORS.edge;
            ctx.globalAlpha = hot ? 0.85 : (e.key ? 0.3 : 0.18);
            ctx.lineWidth = hot ? 1.8 : 1;
            ctx.stroke();

            if (hot && e.label && w > 700) {
                ctx.globalAlpha = 0.95;
                ctx.fillStyle = COLORS.hot;
                ctx.font = "500 10.5px 'IBM Plex Mono', monospace";
                ctx.textAlign = 'center';
                ctx.fillText(e.label, (e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2 - 7);
            }
        });

        // The pointer acts as a node of its own and links to what is near.
        nodes.forEach(n => {
            const d = Math.hypot(n.x - pointer.x, n.y - pointer.y);
            if (d > REACH) return;
            ctx.beginPath();
            ctx.moveTo(pointer.x, pointer.y);
            ctx.lineTo(n.x, n.y);
            ctx.strokeStyle = COLORS.hub;
            ctx.globalAlpha = (1 - d / REACH) * 0.5;
            ctx.lineWidth = 1;
            ctx.stroke();
        });

        pulses.forEach(p => {
            const x = p.e.a.x + (p.e.b.x - p.e.a.x) * p.t;
            const y = p.e.a.y + (p.e.b.y - p.e.a.y) * p.t;
            ctx.globalAlpha = Math.sin(p.t * Math.PI);
            ctx.fillStyle = p.hot ? COLORS.hot : COLORS.hub;
            ctx.beginPath();
            ctx.arc(x, y, p.hot ? 3 : 1.8, 0, 6.29);
            ctx.fill();
        });

        nodes.forEach(n => {
            const hot = n.hub && hotHubs.has(n.name);
            const near = Math.hypot(n.x - pointer.x, n.y - pointer.y) < REACH;

            if (n.hub) {
                ctx.beginPath();
                ctx.arc(n.x, n.y, n.r + 7 + (hot ? Math.sin(clock / 380) * 2 : 0), 0, 6.29);
                ctx.strokeStyle = hot ? COLORS.hot : COLORS.edge;
                ctx.globalAlpha = hot ? 0.7 : 0.3;
                ctx.lineWidth = 1;
                ctx.stroke();
            }

            ctx.beginPath();
            ctx.arc(n.x, n.y, n.r, 0, 6.29);
            ctx.fillStyle = hot ? COLORS.hot : (n.hub || near ? COLORS.hub : COLORS.node);
            ctx.globalAlpha = n.hub ? 1 : (near ? 0.95 : 0.6);
            ctx.fill();

            if (n.hub && w > 700) {
                ctx.globalAlpha = hot ? 1 : 0.75;
                ctx.fillStyle = hot ? COLORS.hot : COLORS.label;
                ctx.font = "500 12px 'IBM Plex Sans', sans-serif";
                ctx.textAlign = 'center';
                ctx.fillText(n.name, n.x, n.y + n.r + 22);
            }
        });

        ctx.globalAlpha = 1;
    }

    function frame(now) {
        if (!running) return;
        const dt = Math.min(now - (last || now), 40);
        last = now;
        step(dt);
        draw();
        raf = requestAnimationFrame(frame);
    }

    function start() {
        if (running || REDUCED_MOTION) return;
        running = true;
        last = 0;
        raf = requestAnimationFrame(frame);
    }

    function stop() {
        running = false;
        if (raf) cancelAnimationFrame(raf);
    }

    function local(e) {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function nodeAt(p, reach) {
        let best = null, bestD = reach;
        nodes.forEach(n => {
            const d = Math.hypot(n.x - p.x, n.y - p.y);
            if (d < bestD) { best = n; bestD = d; }
        });
        return best;
    }

    host.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch') return;
        const p = local(e);
        pointer.x = p.x;
        pointer.y = p.y;
        if (dragging) { dragging.x = p.x; dragging.y = p.y; dragging.vx = dragging.vy = 0; }
        const onContent = e.target.closest('a, button, .ask');
        host.style.cursor = dragging ? 'grabbing' : (!onContent && nodeAt(p, 22) ? 'grab' : '');
        if (REDUCED_MOTION) draw();
    });

    host.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch' || e.target.closest('a, button, .ask')) return;
        const hit = nodeAt(local(e), 22);
        if (!hit) return;
        dragging = hit;
        e.preventDefault();
    });

    window.addEventListener('pointerup', () => { dragging = null; });

    host.addEventListener('pointerleave', () => {
        pointer.x = pointer.y = -9999;
        if (REDUCED_MOTION) draw();
    });

    window.addEventListener('resize', () => { resize(); if (!running) draw(); });
    window.addEventListener('askchange', (e) => setPath(e.detail || []));

    // Stay idle while the hero is off screen or the tab is hidden.
    if ('IntersectionObserver' in window) {
        new IntersectionObserver(entries => {
            entries.forEach(entry => (entry.isIntersecting ? start() : stop()));
        }).observe(host);
    } else {
        start();
    }
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

    resize();
    setPath(['Prefecture', 'Station', 'Observation']);
    draw();
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
            path: ['Prefecture', 'Station', 'Observation'],
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
            path: ['Segment', 'TimeSlot'],
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
            path: ['Prefecture', 'Station', 'Observation', 'PM2.5'],
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
        window.dispatchEvent(new CustomEvent('askchange', { detail: ex.path }));

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
