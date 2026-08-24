// Shared behavior for all pages. Each block guards on the elements it
// needs, so this file works unmodified whether a page has publications,
// a research diagram, both, or neither.

(function darkMode() {
    const toggleButton = document.getElementById('darkModeToggle');
    if (!toggleButton) return;

    const body = document.body;

    if (localStorage.getItem('darkMode') === 'enabled') {
        body.classList.add('dark-mode');
        toggleButton.textContent = '☀️ Light Mode';
    }

    toggleButton.addEventListener('click', () => {
        body.classList.toggle('dark-mode');
        if (body.classList.contains('dark-mode')) {
            localStorage.setItem('darkMode', 'enabled');
            toggleButton.textContent = '☀️ Light Mode';
        } else {
            localStorage.setItem('darkMode', 'disabled');
            toggleButton.textContent = '🌙 Dark Mode';
        }
    });
})();

(function scrollReveal() {
    const targets = document.querySelectorAll('.reveal');
    if (!targets.length) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion || !('IntersectionObserver' in window)) {
        targets.forEach(el => el.classList.add('visible'));
        return;
    }

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    targets.forEach(el => observer.observe(el));
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

        if (noResults) {
            noResults.style.display = anyVisibleTotal ? 'none' : '';
        }
    }

    pillContainer.addEventListener('click', (event) => {
        const button = event.target.closest('.pill');
        if (!button) return;

        pillContainer.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
        button.classList.add('active');
        activeType = button.dataset.type;
        applyFilters();
    });

    if (searchInput) {
        searchInput.addEventListener('input', applyFilters);
    }
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
