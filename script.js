// Shared behavior for every page. Each block exits early if the elements
// it needs are absent, so this file runs unmodified on any page.

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

(function theme() {
    const toggle = document.getElementById('darkModeToggle');
    if (!toggle) return;

    const body = document.body;

    // Dark is the default. Light is opt-in and remembered.
    function paint(isLight) {
        body.classList.toggle('light-mode', isLight);
        toggle.textContent = isLight ? '◐' : '◑';
        toggle.setAttribute('aria-label', isLight ? 'Switch to dark theme' : 'Switch to light theme');
    }

    paint(localStorage.getItem('theme') === 'light');

    toggle.addEventListener('click', () => {
        const nowLight = !body.classList.contains('light-mode');
        localStorage.setItem('theme', nowLight ? 'light' : 'dark');
        paint(nowLight);
        window.dispatchEvent(new Event('themechange'));
    });
})();

(function scrollReveal() {
    const targets = document.querySelectorAll('.reveal');
    if (!targets.length) return;

    if (REDUCED_MOTION || !('IntersectionObserver' in window)) {
        targets.forEach(el => el.classList.add('visible'));
        return;
    }

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
        });
    }, { threshold: 0.1, rootMargin: '0px 0px -60px 0px' });

    targets.forEach(el => observer.observe(el));
})();

// ===== Masthead research graph =====
// The nodes are real: research areas and the projects that sit under them,
// wired by the relationships that actually connect them. Positions are
// normalized to the canvas so the layout survives any viewport.
(function researchGraph() {
    const canvas = document.getElementById('graphCanvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const NODES = [
        { x: 0.17, y: 0.26, r: 7,   label: 'Pattern Mining',   tier: 'area'    },
        { x: 0.46, y: 0.15, r: 7,   label: 'Knowledge Graphs', tier: 'area'    },
        { x: 0.74, y: 0.30, r: 7,   label: 'LLMs',             tier: 'area'    },
        { x: 0.31, y: 0.52, r: 5.5, label: 'Domain Rules',     tier: 'project' },
        { x: 0.62, y: 0.55, r: 5.5, label: 'Traffic KG',       tier: 'project' },
        { x: 0.12, y: 0.62, r: 4.5, label: 'RIS',              tier: 'project' },
        { x: 0.86, y: 0.62, r: 4.5, label: 'Cypher',           tier: 'project' },
        { x: 0.44, y: 0.80, r: 4.5, label: 'PM2.5 Graph',    tier: 'project' },
        { x: 0.75, y: 0.84, r: 3.5, label: '',                 tier: 'minor'   },
        { x: 0.06, y: 0.40, r: 3.5, label: '',                 tier: 'minor'   },
        { x: 0.93, y: 0.44, r: 3.5, label: '',                 tier: 'minor'   },
        { x: 0.24, y: 0.88, r: 3.5, label: '',                 tier: 'minor'   }
    ];

    // [from, to, strong?] -- strong edges are the claims worth noticing.
    const EDGES = [
        [0, 1, true], [1, 2, true], [0, 3, true], [2, 3, true],
        [1, 4, true], [2, 4, true], [4, 6, false], [0, 5, false],
        [0, 7, false], [5, 9, false], [6, 10, false], [4, 8, false],
        [7, 11, false], [3, 5, false], [1, 3, false]
    ];

    const pointer = { x: -999, y: -999, active: false };
    let w = 0, h = 0, raf = null, start = null;

    function palette() {
        const s = getComputedStyle(document.body);
        return {
            edge: s.getPropertyValue('--accent').trim() || '#9B8CFA',
            node: s.getPropertyValue('--accent').trim() || '#9B8CFA',
            hot: s.getPropertyValue('--marigold').trim() || '#F2A93B',
            text: s.getPropertyValue('--text-muted').trim() || '#A9A0C9'
        };
    }

    let colors = palette();

    function resize() {
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        w = rect.width;
        h = rect.height;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Resolve a node to pixels, including its drift and any pointer push.
    function resolve(node, i, t) {
        const driftX = REDUCED_MOTION ? 0 : Math.sin(t / 2600 + i * 1.7) * 9;
        const driftY = REDUCED_MOTION ? 0 : Math.cos(t / 3100 + i * 2.3) * 9;

        let px = node.x * w + driftX;
        let py = node.y * h + driftY;

        if (pointer.active) {
            const dx = px - pointer.x;
            const dy = py - pointer.y;
            const dist = Math.hypot(dx, dy);
            const reach = 150;
            if (dist < reach && dist > 0.5) {
                const push = (1 - dist / reach) * 26;
                px += (dx / dist) * push;
                py += (dy / dist) * push;
            }
        }

        return { px, py, near: pointer.active && Math.hypot(px - pointer.x, py - pointer.y) < 110 };
    }

    // The graph should live in the negative space around the content, never
    // behind it. Rather than hand-placing nodes per breakpoint, erase the
    // canvas wherever real content sits -- so any layout stays legible.
    const shieldSelector = '.masthead-inner > div';

    function clearBehindContent() {
        const rect = canvas.getBoundingClientRect();

        ctx.globalCompositeOperation = 'destination-out';

        document.querySelectorAll(shieldSelector).forEach(el => {
            const b = el.getBoundingClientRect();
            if (!b.width || !b.height) return;

            const cx = b.left - rect.left + b.width / 2;
            const cy = b.top - rect.top + b.height / 2;
            const rx = b.width / 2 + 30;
            const ry = b.height / 2 + 24;

            // Work in a circle, then squash it to the element's proportions,
            // so a wide text column does not erase a tall circle of graph.
            ctx.save();
            ctx.translate(cx, cy);
            ctx.scale(1, ry / rx);

            const g = ctx.createRadialGradient(0, 0, rx * 0.72, 0, 0, rx);
            g.addColorStop(0, 'rgba(0,0,0,1)');
            g.addColorStop(1, 'rgba(0,0,0,0)');

            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(0, 0, rx, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        });

        ctx.globalCompositeOperation = 'source-over';
    }

    function draw(now) {
        if (start === null) start = now;
        const t = now - start;

        ctx.clearRect(0, 0, w, h);

        const pts = NODES.map((n, i) => resolve(n, i, t));

        // Edges first so nodes sit on top of them.
        EDGES.forEach(([a, b, strong]) => {
            const p = pts[a], q = pts[b];
            const lively = p.near || q.near;

            ctx.beginPath();
            ctx.moveTo(p.px, p.py);
            ctx.lineTo(q.px, q.py);
            ctx.strokeStyle = lively ? colors.hot : colors.edge;
            ctx.globalAlpha = lively ? 0.55 : (strong ? 0.30 : 0.15);
            ctx.lineWidth = strong ? 1.3 : 0.9;
            if (!strong) ctx.setLineDash([4, 5]);
            ctx.stroke();
            ctx.setLineDash([]);
        });

        // Nodes and their labels.
        NODES.forEach((n, i) => {
            const p = pts[i];
            const hot = p.near;

            if (n.tier === 'area') {
                ctx.beginPath();
                ctx.arc(p.px, p.py, n.r + 7, 0, Math.PI * 2);
                ctx.strokeStyle = hot ? colors.hot : colors.edge;
                ctx.globalAlpha = hot ? 0.5 : 0.22;
                ctx.lineWidth = 1;
                ctx.stroke();
            }

            ctx.beginPath();
            ctx.arc(p.px, p.py, n.r, 0, Math.PI * 2);
            ctx.fillStyle = hot ? colors.hot : colors.node;
            ctx.globalAlpha = n.tier === 'minor' ? 0.4 : 0.85;
            ctx.fill();

            if (n.label && w > 900) {
                ctx.globalAlpha = hot ? 0.95 : 0.5;
                ctx.fillStyle = hot ? colors.hot : colors.text;
                ctx.font = (n.tier === 'area' ? '600 12px ' : '400 11px ') +
                    "Archivo, system-ui, sans-serif";
                ctx.textAlign = 'center';
                ctx.fillText(n.label, p.px, p.py + n.r + 16);
            }
        });

        ctx.globalAlpha = 1;

        clearBehindContent();

        if (!REDUCED_MOTION) raf = requestAnimationFrame(draw);
    }

    function startLoop() {
        if (raf) cancelAnimationFrame(raf);
        if (REDUCED_MOTION) {
            requestAnimationFrame((n) => { start = n; draw(n); });
        } else {
            raf = requestAnimationFrame(draw);
        }
    }

    const host = canvas.parentElement;

    host.addEventListener('pointermove', (e) => {
        const rect = canvas.getBoundingClientRect();
        pointer.x = e.clientX - rect.left;
        pointer.y = e.clientY - rect.top;
        pointer.active = true;
        if (REDUCED_MOTION) startLoop();
    });

    host.addEventListener('pointerleave', () => {
        pointer.active = false;
        if (REDUCED_MOTION) startLoop();
    });

    window.addEventListener('resize', () => { resize(); if (REDUCED_MOTION) startLoop(); });
    window.addEventListener('themechange', () => { colors = palette(); if (REDUCED_MOTION) startLoop(); });

    // Pause offscreen so the tab stays cheap while reading further down.
    if ('IntersectionObserver' in window && !REDUCED_MOTION) {
        new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    startLoop();
                } else if (raf) {
                    cancelAnimationFrame(raf);
                    raf = null;
                }
            });
        }, { threshold: 0 }).observe(canvas);
    }

    resize();
    startLoop();
})();

// ===== Publication counters =====
// Counts come from the rendered cards, so they stay correct after the
// weekly ORCID/Crossref regeneration without anyone updating a number.
(function publicationStats() {
    const container = document.getElementById('pubStats');
    if (!container) return;

    const cards = Array.from(document.querySelectorAll('.pub-card'));
    if (!cards.length) return;

    const typeOf = card => {
        const el = card.querySelector('.pub-type');
        return el ? el.textContent.trim() : '';
    };

    const years = new Set(
        Array.from(document.querySelectorAll('.pub-year-group h3'))
            .map(h => h.textContent.trim())
            .filter(y => /^\d{4}$/.test(y))
    );

    const totals = {
        total: cards.length,
        journal: cards.filter(c => typeOf(c) === 'Journal').length,
        venues: years.size
    };

    container.querySelectorAll('.pub-stat .value').forEach(el => {
        const target = totals[el.dataset.stat];
        if (typeof target !== 'number') return;

        if (REDUCED_MOTION) { el.textContent = String(target); return; }

        const duration = 900;
        let began = null;

        function step(now) {
            if (began === null) began = now;
            const progress = Math.min((now - began) / duration, 1);
            // Ease out so the number settles rather than stopping dead.
            const eased = 1 - Math.pow(1 - progress, 3);
            el.textContent = String(Math.round(target * eased));
            if (progress < 1) requestAnimationFrame(step);
        }

        requestAnimationFrame(step);
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

                const typeMatch = activeType === 'all' || type === activeType;
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
