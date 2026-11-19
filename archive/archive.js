(function () {
    'use strict';

    var DATA_URL = '/archive/data.json';
    var IMG_BASE = '/archive/img/';

    var el = {
        stats: {
            total: document.getElementById('stat-total'),
            types: document.getElementById('stat-types'),
            values: document.getElementById('stat-values'),
            rarest: document.getElementById('stat-rarest'),
        },
        filterList: document.getElementById('filter-list'),
        search: document.getElementById('search'),
        sort: document.getElementById('sort'),
        pageSize: document.getElementById('page-size'),
        reset: document.getElementById('reset-filters'),
        activeFilters: document.getElementById('active-filters'),
        resultCount: document.getElementById('result-count'),
        grid: document.getElementById('grid'),
        pager: document.getElementById('pager'),
        modal: document.getElementById('modal'),
        modalImage: document.getElementById('modal-image'),
        modalTitle: document.getElementById('modal-title'),
        modalOf: document.getElementById('modal-of'),
        modalSymbol: document.getElementById('modal-symbol'),
        modalRarity: document.getElementById('modal-rarity'),
        modalRank: document.getElementById('modal-rank'),
        modalAttrs: document.getElementById('modal-attrs'),
        modalToken: document.getElementById('modal-token'),
        linkHathor: document.getElementById('link-hathor'),
        linkNileswap: document.getElementById('link-nileswap'),
        modalPrev: document.getElementById('modal-prev'),
        modalNext: document.getElementById('modal-next'),
        copyToken: document.getElementById('copy-token'),
        generatedAt: document.getElementById('generated-at'),
    };

    var state = {
        items: [],
        byNumber: new Map(),
        ranks: new Map(),
        scores: new Map(),
        types: [],
        filters: {},
        query: '',
        sort: 'id-asc',
        page: 1,
        size: 48,
        current: [],
        modalNumber: null,
        lastFocus: null,
    };

    function formatNumber(value) {
        return Number(value).toLocaleString('en-US');
    }

    function loadData() {
        return fetch(DATA_URL, { cache: 'no-cache' })
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (data) {
                state.items = data.items || [];
                if (!state.items.length) throw new Error('Archive data is empty');
                prepare();
                el.generatedAt.textContent = data.generated
                    ? new Date(data.generated).toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric',
                      })
                    : 'unknown';
                readUrl();
                bindEvents();
                renderAll();
                if (state.modalNumber) openModal(state.modalNumber);
            });
    }

    function prepare() {
        var typeMap = new Map();
        state.items.forEach(function (item) {
            state.byNumber.set(item.n, item);
            var score = 0;
            item.a.forEach(function (attribute) {
                score += 1 / Math.max(attribute[2], 0.01);
                if (!typeMap.has(attribute[0])) typeMap.set(attribute[0], new Map());
                var values = typeMap.get(attribute[0]);
                values.set(attribute[1], (values.get(attribute[1]) || 0) + 1);
            });
            state.scores.set(item.n, item.a.length ? score / item.a.length : 0);
        });

        var ranked = state.items.slice().sort(function (a, b) {
            return state.scores.get(b.n) - state.scores.get(a.n) || a.n - b.n;
        });
        ranked.forEach(function (item, index) {
            state.ranks.set(item.n, index + 1);
        });

        state.types = Array.from(typeMap.entries())
            .map(function (entry) {
                return {
                    name: entry[0],
                    values: Array.from(entry[1].entries())
                        .map(function (value) {
                            return { value: value[0], count: value[1] };
                        })
                        .sort(function (a, b) {
                            return b.count - a.count || a.value.localeCompare(b.value);
                        }),
                };
            })
            .sort(function (a, b) {
                return a.name.localeCompare(b.name);
            });

        el.stats.total.textContent = formatNumber(state.items.length);
        el.stats.types.textContent = String(state.types.length);
        el.stats.values.textContent = formatNumber(
            state.types.reduce(function (sum, type) {
                return sum + type.values.length;
            }, 0)
        );
        var rarest = ranked[0];
        if (rarest) {
            el.stats.rarest.textContent = '#' + formatNumber(rarest.n);
            el.stats.rarest.title = rarest.name;
        }
    }

    /* ---------- URL state ---------- */

    function encodeFilters() {
        var parts = [];
        Object.keys(state.filters).forEach(function (type) {
            state.filters[type].forEach(function (value) {
                parts.push(encodeURIComponent(type) + ':' + encodeURIComponent(value));
            });
        });
        return parts.join('|');
    }

    function readUrl() {
        var params = new URLSearchParams(window.location.search);
        state.query = params.get('q') || '';
        state.sort = params.get('sort') || 'id-asc';
        state.size = Number(params.get('size')) || 48;
        if ([24, 48, 96].indexOf(state.size) === -1) state.size = 48;
        state.page = Math.max(1, Number(params.get('page')) || 1);
        state.filters = {};

        var encoded = params.get('t');
        if (encoded) {
            encoded.split('|').forEach(function (pair) {
                var separator = pair.indexOf(':');
                if (separator < 0) return;
                var type = decodeURIComponent(pair.slice(0, separator));
                var value = decodeURIComponent(pair.slice(separator + 1));
                if (!type || !value) return;
                if (!state.filters[type]) state.filters[type] = new Set();
                state.filters[type].add(value);
            });
        }

        el.search.value = state.query;
        el.sort.value = state.sort;
        el.pageSize.value = String(state.size);

        var view = Number(params.get('view')) || 0;
        state.modalNumber = view && state.byNumber.has(view) ? view : null;
    }

    function writeUrl() {
        var params = new URLSearchParams();
        if (state.query) params.set('q', state.query);
        if (state.sort !== 'id-asc') params.set('sort', state.sort);
        if (state.page > 1) params.set('page', String(state.page));
        if (state.size !== 48) params.set('size', String(state.size));
        var filters = encodeFilters();
        if (filters) params.set('t', filters);
        if (state.modalNumber) params.set('view', String(state.modalNumber));
        var query = params.toString();
        var url = window.location.pathname + (query ? '?' + query : '');
        window.history.replaceState({}, '', url);
    }

    /* ---------- Filtering ---------- */

    function normalizeQuery(raw) {
        var query = raw.trim().toLowerCase();
        if (!query) return { text: '' };
        var numeric = query.match(/^#?(?:a)?0*(\d+)$/);
        if (numeric && (query.charAt(0) === '#' || query.charAt(0) === 'a' || /^\d+$/.test(query))) {
            return { text: query, number: Number(numeric[1]) };
        }
        return { text: query };
    }

    function applyFilters() {
        var query = normalizeQuery(state.query);
        var activeTypes = Object.keys(state.filters).filter(function (type) {
            return state.filters[type] && state.filters[type].size > 0;
        });

        var result = state.items.filter(function (item) {
            if (query.number !== undefined) {
                if (item.n !== query.number) return false;
            } else if (query.text) {
                var hit =
                    item.name.toLowerCase().indexOf(query.text) !== -1 ||
                    (item.symbol || '').toLowerCase().indexOf(query.text) !== -1 ||
                    item.a.some(function (attribute) {
                        return attribute[1].toLowerCase().indexOf(query.text) !== -1;
                    });
                if (!hit) return false;
            }

            for (var i = 0; i < activeTypes.length; i++) {
                var type = activeTypes[i];
                var matched = item.a.some(function (attribute) {
                    return attribute[0] === type && state.filters[type].has(attribute[1]);
                });
                if (!matched) return false;
            }
            return true;
        });

        var sorters = {
            'id-asc': function (a, b) {
                return a.n - b.n;
            },
            'id-desc': function (a, b) {
                return b.n - a.n;
            },
            'rank-asc': function (a, b) {
                return state.ranks.get(a.n) - state.ranks.get(b.n);
            },
            'rank-desc': function (a, b) {
                return state.ranks.get(b.n) - state.ranks.get(a.n);
            },
        };
        result.sort(sorters[state.sort] || sorters['id-asc']);
        state.current = result;
        return result;
    }

    /* ---------- Rendering ---------- */

    function renderAll() {
        renderFilters();
        render();
    }

    function renderFilters() {
        var html = state.types
            .map(function (type, index) {
                var selected = state.filters[type.name] || new Set();
                var values = type.values
                    .map(function (value) {
                        var on = selected.has(value.value);
                        return (
                            '<button type="button" class="trait' +
                            (on ? ' on' : '') +
                            '" data-type="' +
                            escapeAttr(type.name) +
                            '" data-value="' +
                            escapeAttr(value.value) +
                            '"><span>' +
                            escapeHtml(value.value) +
                            '</span><span class="n">' +
                            formatNumber(value.count) +
                            '</span></button>'
                        );
                    })
                    .join('');
                var open = index < 2 || selected.size > 0 ? ' open' : '';
                return (
                    '<details class="filter-group"' +
                    open +
                    '><summary><span>' +
                    escapeHtml(type.name) +
                    '</span><span class="count">' +
                    type.values.length +
                    '</span></summary><div class="filter-values">' +
                    values +
                    '</div></details>'
                );
            })
            .join('');
        el.filterList.innerHTML = html;
    }

    function render() {
        var result = applyFilters();
        var totalPages = Math.max(1, Math.ceil(result.length / state.size));
        if (state.page > totalPages) state.page = totalPages;

        var start = (state.page - 1) * state.size;
        var pageItems = result.slice(start, start + state.size);

        renderGrid(pageItems);
        renderCount(result.length, start, pageItems.length);
        renderPager(totalPages);
        renderActiveFilters();
        writeUrl();
    }

    function renderGrid(items) {
        if (!items.length) {
            el.grid.innerHTML =
                '<div class="empty"><strong>No Anubians match.</strong>Try another trait, or reset the filters.</div>';
            return;
        }
        el.grid.innerHTML = items
            .map(function (item, index) {
                var eager = index < 8 ? '' : ' loading="lazy"';
                var media = item.noimg
                    ? '<div class="media-missing"><span>No image</span></div>'
                    : '<img src="' +
                      IMG_BASE +
                      item.n +
                      '.png" alt="' +
                      escapeAttr(item.name) +
                      '" width="590" height="590"' +
                      eager +
                      ' decoding="async" onerror="this.parentNode.classList.add(\'is-missing\');this.remove()" />';
                return (
                    '<article class="card">' +
                    '<button type="button" class="card-media' +
                    (item.noimg ? ' is-missing' : '') +
                    '" data-n="' +
                    item.n +
                    '" aria-label="Open ' +
                    escapeAttr(item.name) +
                    '">' +
                    media +
                    '<span class="card-rank">#' +
                    formatNumber(state.ranks.get(item.n)) +
                    '</span>' +
                    '</button>' +
                    '<div class="card-body"><h3>' +
                    escapeHtml(item.name) +
                    '</h3><span class="card-symbol">' +
                    escapeHtml(item.symbol) +
                    '</span></div>' +
                    '</article>'
                );
            })
            .join('');
    }

    function renderCount(total, start, shown) {
        if (!total) {
            el.resultCount.innerHTML = 'No Anubians found.';
            return;
        }
        el.resultCount.innerHTML =
            'Showing <strong>' +
            formatNumber(start + 1) +
            '–' +
            formatNumber(start + shown) +
            '</strong> of <strong>' +
            formatNumber(total) +
            '</strong> Anubians';
    }

    function renderPager(totalPages) {
        if (totalPages <= 1) {
            el.pager.innerHTML = '';
            return;
        }
        var pages = pageList(state.page, totalPages);
        var html = '<button type="button" data-page="' + (state.page - 1) + '"' +
            (state.page === 1 ? ' disabled' : '') +
            ' aria-label="Previous page">←</button>';
        pages.forEach(function (page) {
            if (page === '…') {
                html += '<span class="gap">…</span>';
            } else {
                html +=
                    '<button type="button" data-page="' +
                    page +
                    '"' +
                    (page === state.page ? ' class="is-current" aria-current="page"' : '') +
                    '>' +
                    page +
                    '</button>';
            }
        });
        html += '<button type="button" data-page="' + (state.page + 1) + '"' +
            (state.page === totalPages ? ' disabled' : '') +
            ' aria-label="Next page">→</button>';
        el.pager.innerHTML = html;
    }

    function pageList(current, total) {
        if (total <= 7) {
            return Array.from({ length: total }, function (_, index) {
                return index + 1;
            });
        }
        var pages = [1];
        var start = Math.max(2, current - 1);
        var end = Math.min(total - 1, current + 1);
        if (start > 2) pages.push('…');
        for (var page = start; page <= end; page++) pages.push(page);
        if (end < total - 1) pages.push('…');
        pages.push(total);
        return pages;
    }

    function renderActiveFilters() {
        var chips = [];
        Object.keys(state.filters).forEach(function (type) {
            state.filters[type].forEach(function (value) {
                chips.push(
                    '<span class="chip"><em>' +
                    escapeHtml(type) +
                    ':</em> ' +
                    escapeHtml(value) +
                    '<button type="button" data-remove-type="' +
                    escapeAttr(type) +
                    '" data-remove-value="' +
                    escapeAttr(value) +
                    '" aria-label="Remove ' +
                    escapeAttr(type + ': ' + value) +
                    '">×</button></span>'
                );
            });
        });
        if (chips.length) {
            el.activeFilters.hidden = false;
            el.activeFilters.innerHTML = chips.join('');
        } else {
            el.activeFilters.hidden = true;
            el.activeFilters.innerHTML = '';
        }
    }

    /* ---------- Modal ---------- */

    function openModal(number) {
        var item = state.byNumber.get(number);
        if (!item) return;
        state.lastFocus = document.activeElement;
        state.modalNumber = number;
        var index = state.current.findIndex(function (entry) {
            return entry.n === number;
        });

        var media = el.modalImage.parentNode;
        media.classList.toggle('is-missing', !!item.noimg);
        el.modalImage.hidden = !!item.noimg;
        if (item.noimg) {
            el.modalImage.removeAttribute('src');
        } else {
            el.modalImage.src = IMG_BASE + item.n + '.png';
        }
        el.modalImage.alt = item.name;
        el.modalTitle.textContent = item.name;
        el.modalOf.textContent = 'Anubian ' + formatNumber(item.n) + ' of ' + formatNumber(state.items.length);
        el.modalSymbol.textContent = item.symbol;
        el.modalRarity.textContent = item.a.length + ' traits';
        el.modalRank.textContent = 'Rank #' + formatNumber(state.ranks.get(item.n));
        el.modalToken.textContent = item.token;

        el.modalAttrs.innerHTML = item.a
            .map(function (attribute) {
                var width = Math.min(100, Math.max(2, attribute[2]));
                return (
                    '<li><span class="attr-type">' +
                    escapeHtml(attribute[0]) +
                    '</span><span class="attr-value">' +
                    escapeHtml(attribute[1]) +
                    '</span><span class="attr-rarity">' +
                    attribute[2].toFixed(2) +
                    '%<i style="width:' +
                    width +
                    '%"></i></span></li>'
                );
            })
            .join('');

        el.linkHathor.href = 'https://explorer.hathor.network/token_detail/' + item.uid;
        el.linkNileswap.href = 'https://explorer.nileswap.com/token_detail/' + item.uid;

        el.modalPrev.disabled = index <= 0;
        el.modalNext.disabled = index < 0 || index >= state.current.length - 1;
        el.modalPrev.dataset.n = index > 0 ? state.current[index - 1].n : '';
        el.modalNext.dataset.n = index >= 0 && index < state.current.length - 1 ? state.current[index + 1].n : '';

        el.modal.hidden = false;
        document.body.classList.add('modal-open');
        el.modal.querySelector('.modal-close').focus();
        writeUrl();
    }

    function closeModal() {
        el.modal.hidden = true;
        document.body.classList.remove('modal-open');
        state.modalNumber = null;
        el.modalImage.removeAttribute('src');
        if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
        writeUrl();
    }

    function copyToken() {
        var text = el.modalToken.textContent;
        function done() {
            el.copyToken.textContent = 'Copied';
            el.copyToken.classList.add('copied');
            window.setTimeout(function () {
                el.copyToken.textContent = 'Copy';
                el.copyToken.classList.remove('copied');
            }, 1600);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, fallback);
        } else {
            fallback();
        }
        function fallback() {
            var area = document.createElement('textarea');
            area.value = text;
            area.setAttribute('readonly', '');
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            try {
                document.execCommand('copy');
                done();
            } catch (error) {
                /* ignore */
            }
            document.body.removeChild(area);
        }
    }

    /* ---------- Events ---------- */

    function bindEvents() {
        el.filterList.addEventListener('click', function (event) {
            var button = event.target.closest('.trait');
            if (!button) return;
            var type = button.dataset.type;
            var value = button.dataset.value;
            if (!state.filters[type]) state.filters[type] = new Set();
            if (state.filters[type].has(value)) {
                state.filters[type].delete(value);
                button.classList.remove('on');
                if (!state.filters[type].size) delete state.filters[type];
            } else {
                state.filters[type].add(value);
                button.classList.add('on');
            }
            state.page = 1;
            render();
        });

        el.activeFilters.addEventListener('click', function (event) {
            var button = event.target.closest('[data-remove-type]');
            if (!button) return;
            var type = button.dataset.removeType;
            var value = button.dataset.removeValue;
            if (state.filters[type]) {
                state.filters[type].delete(value);
                if (!state.filters[type].size) delete state.filters[type];
            }
            state.page = 1;
            renderFilters();
            render();
        });

        el.reset.addEventListener('click', function () {
            state.filters = {};
            state.query = '';
            state.sort = 'id-asc';
            state.page = 1;
            el.search.value = '';
            el.sort.value = 'id-asc';
            renderFilters();
            render();
        });

        var searchTimer;
        el.search.addEventListener('input', function () {
            window.clearTimeout(searchTimer);
            searchTimer = window.setTimeout(function () {
                state.query = el.search.value;
                state.page = 1;
                render();
            }, 160);
        });

        el.sort.addEventListener('change', function () {
            state.sort = el.sort.value;
            state.page = 1;
            render();
        });

        el.pageSize.addEventListener('change', function () {
            state.size = Number(el.pageSize.value) || 48;
            state.page = 1;
            render();
        });

        el.pager.addEventListener('click', function (event) {
            var button = event.target.closest('button[data-page]');
            if (!button || button.disabled) return;
            state.page = Math.max(1, Number(button.dataset.page));
            render();
            document.querySelector('.toolbar').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });

        el.grid.addEventListener('click', function (event) {
            var trigger = event.target.closest('[data-n]');
            if (!trigger) return;
            openModal(Number(trigger.dataset.n));
        });

        el.modal.addEventListener('click', function (event) {
            if (event.target.closest('[data-close]')) closeModal();
        });

        el.modalPrev.addEventListener('click', function () {
            if (this.dataset.n) openModal(Number(this.dataset.n));
        });

        el.modalNext.addEventListener('click', function () {
            if (this.dataset.n) openModal(Number(this.dataset.n));
        });

        el.copyToken.addEventListener('click', copyToken);

        document.addEventListener('keydown', function (event) {
            if (el.modal.hidden) return;
            if (event.key === 'Escape') {
                closeModal();
            } else if (event.key === 'ArrowLeft' && !el.modalPrev.disabled) {
                openModal(Number(el.modalPrev.dataset.n));
            } else if (event.key === 'ArrowRight' && !el.modalNext.disabled) {
                openModal(Number(el.modalNext.dataset.n));
            }
        });

        window.addEventListener('popstate', function () {
            readUrl();
            if (state.modalNumber) {
                openModal(state.modalNumber);
            } else if (!el.modal.hidden) {
                closeModal();
            }
            renderFilters();
            render();
        });
    }

    /* ---------- Helpers ---------- */

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeAttr(value) {
        return escapeHtml(value);
    }

    var siteNav = document.getElementById('siteNav');
    if (siteNav) {
        var shrinkNav = function () {
            siteNav.classList.toggle('is-shrunk', window.scrollY > 40);
        };
        shrinkNav();
        document.addEventListener('scroll', shrinkNav, { passive: true });
    }

    loadData().catch(function (error) {
        el.resultCount.textContent = 'Could not load the archive data.';
        el.grid.innerHTML =
            '<div class="empty"><strong>The archive could not be opened.</strong>' +
            escapeHtml(error.message) +
            '</div>';
    });

})();
