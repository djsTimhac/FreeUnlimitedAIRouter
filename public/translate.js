/*
  Whole-page translation with nothing to maintain by hand.

  Every text node on the page is sent to Google's public translate endpoint and
  swapped in place, so new copy is translated automatically without a single
  string in the source. The picker in the nav always wins over the detected
  browser language, and the choice survives reloads.

  English stays the source: switching back restores the original nodes, and
  repeat visits reuse cached strings instead of calling the API again. A
  MutationObserver picks up text that arrives later, so a dashboard that
  re-renders its tables is translated too.
*/
(function () {
  'use strict';

  var SOURCE = 'en';
  var STORE = 'fu-lang';
  var CACHE_PREFIX = 'fu-cache:';
  var LANG_CACHE = 'fu-langs';
  var LANG_TTL = 30 * 24 * 3600 * 1000;
  var LANG_REFRESH = 24 * 3600 * 1000;
  var ENDPOINT = 'https://translate.googleapis.com/translate_a/t?client=gtx';
  var MAX_QUERY = 6000; // measured: a ~5k URL still answers, with headroom
  var CACHE_VERSION = 4; // 4 stores a string map instead of a page snapshot
  var MAX_ENTRIES = 900;
  var LIVE_DELAY = 300;
  var SKIP = 'script,style,noscript,code,pre,textarea,input,select,option,[data-no-translate]';

  // Autonyms for the languages people pick most; the full set of what Google
  // supports is fetched at runtime, so this is a head start, not the limit.
  var NATIVE = [
    ['en', 'English'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'],
    ['it', 'Italiano'], ['pt', 'Português'], ['nl', 'Nederlands'], ['pl', 'Polski'],
    ['ru', 'Русский'], ['uk', 'Українська'], ['cs', 'Čeština'], ['sk', 'Slovenčina'],
    ['hu', 'Magyar'], ['ro', 'Română'], ['bg', 'Български'], ['hr', 'Hrvatski'],
    ['sr', 'Српски'], ['sl', 'Slovenščina'], ['el', 'Ελληνικά'], ['tr', 'Türkçe'],
    ['sv', 'Svenska'], ['no', 'Norsk'], ['da', 'Dansk'], ['fi', 'Suomi'],
    ['et', 'Eesti'], ['lv', 'Latviešu'], ['lt', 'Lietuvių'], ['be', 'Беларуская'],
    ['ca', 'Català'], ['gl', 'Galego'], ['eu', 'Euskara'], ['cy', 'Cymraeg'],
    ['ga', 'Gaeilge'], ['is', 'Íslenska'], ['sq', 'Shqip'], ['mk', 'Македонски'],
    ['bs', 'Bosanski'], ['mt', 'Malti'], ['af', 'Afrikaans'], ['sw', 'Kiswahili'],
    ['am', 'አማርኛ'], ['ar', 'العربية'], ['iw', 'עברית'], ['fa', 'فارسی'],
    ['ur', 'اردو'], ['hi', 'हिन्दी'], ['bn', 'বাংলা'], ['pa', 'ਪੰਜਾਬੀ'],
    ['gu', 'ગુજરાતી'], ['mr', 'मराठी'], ['ta', 'தமிழ்'], ['te', 'తెలుగు'],
    ['kn', 'ಕನ್ನಡ'], ['ml', 'മലയാളം'], ['si', 'සිංහල'], ['ne', 'नेपाली'],
    ['th', 'ไทย'], ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'], ['ms', 'Bahasa Melayu'],
    ['tl', 'Filipino'], ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['ja', '日本語'],
    ['ko', '한국어'], ['mn', 'Монгол'], ['kk', 'Қазақша'], ['uz', "Oʻzbekcha"],
    ['az', 'Azərbaycan'], ['hy', 'Հայերեն'], ['ka', 'ქართული'], ['eo', 'Esperanto']
  ];

  // Google still lists some languages under their old codes.
  var ALIASES = { he: 'iw', fil: 'tl', nb: 'no', jv: 'jw', mo: 'ro' };

  var nativeByCode = {};
  NATIVE.forEach(function (pair) { nativeByCode[pair[0].toLowerCase()] = pair[1]; });

  var byCode = {};
  function index(list) {
    byCode = {};
    list.forEach(function (pair) { byCode[pair[0].toLowerCase()] = pair[0]; });
  }
  index(NATIVE);

  /* Every language the translate endpoint accepts, autonyms where we have
     them. Resolves to null if the list cannot be fetched. */
  function loadLanguages() {
    return fetch('https://translate.googleapis.com/translate_a/l?client=gtx&alpha=true&hl=en')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        var remote = data && data.tl;
        if (!remote) return null;
        var seen = {};
        var list = Object.keys(remote).map(function (code) {
          seen[code.toLowerCase()] = true;
          return [code, nativeByCode[code.toLowerCase()] || remote[code]];
        });
        NATIVE.forEach(function (pair) {
          if (!seen[pair[0].toLowerCase()]) list.push(pair);
        });
        list.sort(function (a, b) {
          if (a[0] === SOURCE) return -1;
          if (b[0] === SOURCE) return 1;
          return a[1].localeCompare(b[1], 'en');
        });
        return list;
      });
  }

  /* "de-AT", "pt-BR", "zh-Hant", "he" ... -> a code the picker knows. */
  function canonical(tag) {
    var value = String(tag || '').toLowerCase().trim();
    if (!value) return '';
    if (value.indexOf('zh') === 0) return byCode[/hant|tw|hk|mo/.test(value) ? 'zh-tw' : 'zh-cn'] || '';
    var base = value.split('-')[0];
    return byCode[value] || byCode[base] || byCode[ALIASES[base]] || byCode[ALIASES[value]] || '';
  }

  /* node -> {src, dst, lead, tail}: the English text, what is shown now, and
     the exact whitespace around it. Source is always English, whatever the
     node currently says, so a second language switch starts from the source. */
  var texts = new WeakMap();
  var maps = Object.create(null); // language -> {english: translated}
  var active = SOURCE;
  var run = 0;
  var busy = false;
  var applying = false;
  var timer = 0;
  var renderedAt = 0;
  var select = document.getElementById('lang');

  function dict(target) {
    if (maps[target]) return maps[target];
    var map = Object.create(null);
    try {
      var saved = JSON.parse(localStorage.getItem(CACHE_PREFIX + target) || 'null');
      if (saved && saved.v === CACHE_VERSION && saved.map) {
        Object.keys(saved.map).forEach(function (key) { map[key] = saved.map[key]; });
      }
    } catch (e) { /* private mode or old cache: start clean */ }
    maps[target] = map;
    return map;
  }

  function saveDict(target, additions) {
    var map = dict(target);
    var keys = Object.keys(additions);
    if (!keys.length) return;
    keys.forEach(function (key) { map[key] = additions[key]; });
    var all = Object.keys(map);
    if (all.length > MAX_ENTRIES) {
      all.slice(0, all.length - MAX_ENTRIES).forEach(function (key) { delete map[key]; });
    }
    try {
      localStorage.setItem(CACHE_PREFIX + target, JSON.stringify({ v: CACHE_VERSION, map: map }));
    } catch (e) { /* quota or private mode: translate again next time */ }
  }

  /* Text worth translating: no code samples, no widget chrome, no whitespace,
     and nothing that carries no letters at all (counts, times, separators). */
  function collect(root) {
    var scope = root && root.nodeType === 1 ? root : document.body;
    var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var value = node.nodeValue;
        if (!value || value.trim().length < 2) return NodeFilter.FILTER_REJECT;
        var parent = node.parentElement;
        if (!parent || parent.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var items = [];
    while (walker.nextNode()) {
      var node = walker.currentNode;
      var raw = node.nodeValue;
      var record = texts.get(node);
      var core;
      var lead;
      var tail;

      if (record && raw === record.lead + record.dst + record.tail) {
        // Already ours: reuse the English source for the next language.
        core = record.src;
        lead = record.lead;
        tail = record.tail;
      } else {
        core = raw.trim();
        if (!/\p{L}/u.test(core)) continue;
        var at = raw.indexOf(core);
        lead = raw.slice(0, at);
        tail = raw.slice(at + core.length);
        if (record) texts.delete(node);
      }
      items.push({ node: node, text: core, lead: lead, tail: tail });
    }
    return items;
  }

  /* Pack as much text as the URL allows into one request: every batch is a
     full round trip, so the whole page usually leaves in a single call. */
  function chunk(texts) {
    var batches = [];
    var batch = [];
    var size = 0;
    texts.forEach(function (text) {
      var length = encodeURIComponent(text).length + 3; // "&q=" plus the value
      if (batch.length && size + length > MAX_QUERY) {
        batches.push(batch);
        batch = [];
        size = 0;
      }
      batch.push(text);
      size += length;
    });
    if (batch.length) batches.push(batch);
    return batches;
  }

  /* One request carries many segments: this endpoint answers with exactly one
     entry per q, in order. An earlier version embedded [[n]] markers in a
     single payload, but Google drops a bracket in some languages, the marker
     goes missing and those lines silently stay English. */
  function request(batch, target) {
    var url = ENDPOINT + '&sl=' + SOURCE + '&tl=' + encodeURIComponent(target) +
      batch.map(function (text) { return '&q=' + encodeURIComponent(text.replace(/\s+/g, ' ')); }).join('');

    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('translate HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      var list = Array.isArray(data) ? data : [data];
      if (list.length !== batch.length) {
        // Rather than shift translations onto the wrong nodes, ask one by one.
        return Promise.all(batch.map(function (text) { return requestOne(text, target); }));
      }
      return list.map(function (entry) {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && typeof entry.t === 'string') return entry.t;
        return '';
      });
    });
  }

  function requestOne(text, target) {
    var url = ENDPOINT + '&sl=' + SOURCE + '&tl=' + encodeURIComponent(target) +
      '&q=' + encodeURIComponent(text.replace(/\s+/g, ' '));
    return fetch(url).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (data) {
      var list = Array.isArray(data) ? data : [data];
      return typeof list[0] === 'string' ? list[0] : '';
    }).catch(function () { return ''; });
  }

  function write(node, lead, value, tail) {
    var next = lead + value + tail;
    if (node.nodeValue !== next) node.nodeValue = next;
  }

  /* Pause the observer for the microtask it takes to settle these writes. */
  function settle() {
    applying = true;
    setTimeout(function () { applying = false; }, 0);
  }

  function applySource(items) {
    if (!items.length) return;
    items.forEach(function (item) {
      write(item.node, item.lead, item.text, item.tail);
      texts.delete(item.node);
    });
    settle();
  }

  function applyTarget(items, map) {
    var changed = false;
    items.forEach(function (item) {
      var dst = map[item.text];
      if (!dst) return;
      write(item.node, item.lead, dst, item.tail);
      texts.set(item.node, { src: item.text, dst: dst, lead: item.lead, tail: item.tail });
      changed = true;
    });
    if (changed) settle();
  }

  function reveal() {
    document.documentElement.removeAttribute('data-i18n');
  }

  function translate(target) {
    var current = ++run;
    busy = true;
    active = target;
    document.documentElement.lang = target;

    var items = collect();
    if (!items.length) {
      busy = false;
      reveal();
      return Promise.resolve();
    }

    if (target === SOURCE) {
      applySource(items);
      busy = false;
      reveal();
      return Promise.resolve();
    }

    var map = dict(target);
    var missing = [];
    var seen = Object.create(null);
    items.forEach(function (item) {
      if (!map[item.text] && !seen[item.text]) {
        seen[item.text] = true;
        missing.push(item.text);
      }
    });

    // Cached strings land immediately; only the rest waits for the network.
    applyTarget(items, map);
    if (!missing.length) {
      busy = false;
      reveal();
      return Promise.resolve();
    }

    var added = Object.create(null);
    return chunk(missing).reduce(function (chain, batch) {
      return chain.then(function () {
        if (current !== run) return;
        return request(batch, target).then(function (translated) {
          translated.forEach(function (text, i) {
            if (!text) return;
            added[batch[i]] = text;
            map[batch[i]] = text;
          });
        }).catch(function () {
          /* a failed batch keeps its English text rather than blanking out */
        });
      });
    }, Promise.resolve()).then(function () {
      if (current !== run) return;
      busy = false;
      saveDict(target, added);
      applyTarget(items, map);
      reveal();
      // The page may have rendered while the request was in flight; those
      // nodes were not in the batch, so give them the dictionary too.
      applyKnown(document.body);
    });
  }

  /* Text the page renders after load (live tables, status lines) is picked up
     here, translated in one batch, and remembered for the next render. */
  function schedule() {
    if (applying || active === SOURCE) return;
    clearTimeout(timer);
    timer = setTimeout(function () {
      // A translation that is already running will pick these nodes up itself;
      // asking twice for the same strings only burns a request.
      if (busy) { schedule(); return; }
      translate(active);
    }, LIVE_DELAY);
  }

  /* Called by the page right after it renders: strings the dictionary already
     knows are swapped before the browser paints, so a polling table never
     flashes English. Only unknown strings wait for the next request. */
  function applyKnown(root) {
    if (active === SOURCE || !root) return;
    var items = collect(root);
    if (!items.length) return;
    var map = dict(active);
    applyTarget(items, map);
    for (var i = 0; i < items.length; i++) {
      if (!map[items[i].text]) { schedule(); return; }
    }
  }

  window.fuApply = applyKnown;

  if (window.MutationObserver) {
    new MutationObserver(function (records) {
      if (applying || active === SOURCE) return;
      for (var i = 0; i < records.length; i++) {
        var node = records[i].target;
        var element = node.nodeType === 1 ? node : node.parentElement;
        if (element && !element.closest(SKIP)) { schedule(); return; }
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  select.addEventListener('change', function () {
    var code = canonical(select.value) || SOURCE;
    // Rebuilding the picker can move the selection on a focused select; that
    // is not a choice, so it must never start a translation on its own.
    if (Date.now() - renderedAt < 250 || code === active) return;
    try { localStorage.setItem(STORE, code); } catch (e) { /* ignore */ }
    translate(code);
  });

  /* The picker needs every language, the page needs one. The full list is
     cached, and the built-in names are enough to start translating, so the
     first string is on its way before the list request has answered. */
  function readLangCache() {
    try {
      var saved = JSON.parse(localStorage.getItem(LANG_CACHE) || 'null');
      if (!saved || !Array.isArray(saved.list) || saved.list.length < 50) return null;
      var age = Date.now() - (saved.at || 0);
      if (age > LANG_TTL) return null;
      return { list: saved.list, stale: age > LANG_REFRESH };
    } catch (e) {
      return null;
    }
  }

  function writeLangCache(list) {
    try {
      localStorage.setItem(LANG_CACHE, JSON.stringify({ at: Date.now(), list: list }));
    } catch (e) { /* quota or private mode: just fetch it next time */ }
  }

  function renderOptions(list) {
    index(list);
    select.innerHTML = '';
    list.forEach(function (pair) {
      var option = document.createElement('option');
      option.value = pair[0];
      option.textContent = pair[1];
      select.appendChild(option);
    });
    renderedAt = Date.now();
  }

  /* Fill the picker with everything Google accepts without blocking the page. */
  function refreshLanguages() {
    loadLanguages().then(function (list) {
      if (!list) return;
      writeLangCache(list);
      renderOptions(list);
      select.value = active;
    }).catch(function () { /* the built-in list stays */ });
  }

  var requested = new URLSearchParams(location.search).get('lang');
  var storedRaw = '';
  try { storedRaw = localStorage.getItem(STORE) || ''; } catch (e) { /* ignore */ }
  var browserTags = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language])
    .map(function (tag) { return String(tag || ''); });

  function browserCode() {
    for (var i = 0; i < browserTags.length; i++) {
      var code = canonical(browserTags[i]);
      if (code) return code;
    }
    return '';
  }

  var englishBrowser = browserTags.some(function (tag) { return /^en(-|$)/i.test(tag); });
  var unknownBrowser = browserTags.some(function (tag) {
    return tag && !/^en(-|$)/i.test(tag) && !canonical(tag);
  });

  function boot(list, code) {
    renderOptions(list);
    var fromUrl = canonical(requested);
    var target = code || fromUrl || canonical(storedRaw) || browserCode() || SOURCE;

    if (fromUrl) {
      try { localStorage.setItem(STORE, fromUrl); } catch (e) { /* ignore */ }
    }

    select.value = target;
    if (target !== SOURCE) translate(target);
    else reveal();
  }

  var cachedLangs = readLangCache();
  if (cachedLangs) {
    boot(cachedLangs.list);
    if (cachedLangs.stale) refreshLanguages();
  } else {
    var explicitRaw = requested || storedRaw;
    var explicitCode = canonical(requested) || canonical(storedRaw);
    // An explicit choice decides on its own: an unknown stored language must
    // wait for the full list instead of silently falling back to the browser.
    var immediate = explicitRaw ? explicitCode : (browserCode() || (englishBrowser ? SOURCE : ''));

    /* A stored choice or browser language the built-in shortlist cannot place
       yet has to wait for the full list, or the page would start out in the
       wrong language. Everything else starts right away. */
    if (!immediate && (explicitRaw || unknownBrowser)) {
      var fallback = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 1400); });
      Promise.race([loadLanguages().catch(function () { return null; }), fallback]).then(function (list) {
        if (list) writeLangCache(list);
        boot(list || NATIVE);
      });
    } else {
      boot(NATIVE, immediate);
      refreshLanguages();
    }
  }
})();
