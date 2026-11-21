/*
  Whole-page translation with nothing to maintain by hand.

  Every text node on the page is sent to Google's public translate endpoint and
  swapped in place, so new copy is translated automatically without a single
  string in the source. The picker in the nav always wins over the detected
  browser language, and the choice survives reloads.

  English stays the source: switching back restores the original nodes, and
  repeat visits reuse a cached translation instead of calling the API again.
*/
(function () {
  'use strict';

  var SOURCE = 'en';
  var STORE = 'fu-lang';
  var CACHE_PREFIX = 'fu-cache:';
  var ENDPOINT = 'https://translate.googleapis.com/translate_a/t?client=gtx';
  var MAX_PAYLOAD = 1800;
  var CACHE_VERSION = 3; // bump when the applied text changes shape
  var SKIP = 'script,style,noscript,code,pre,textarea,select,option,[data-no-translate]';

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

  /* Text worth translating: no code samples, no widget chrome, no whitespace. */
  function collect() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
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
      var core = raw.trim();
      var at = raw.indexOf(core);
      // Inline siblings are separated by their own whitespace, so keep the exact
      // runs around each core and re-attach them after translating.
      items.push({
        node: node,
        text: core,
        lead: raw.slice(0, at),
        tail: raw.slice(at + core.length),
        index: items.length
      });
    }
    return items;
  }

  /* Keep each request comfortably inside URL limits. */
  function chunk(items) {
    var batches = [];
    var batch = [];
    var size = 0;
    items.forEach(function (item) {
      var length = item.text.length + 12;
      if (batch.length && size + length > MAX_PAYLOAD) {
        batches.push(batch);
        batch = [];
        size = 0;
      }
      batch.push(item);
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
      batch.map(function (item) { return '&q=' + encodeURIComponent(item.text.replace(/\s+/g, ' ')); }).join('');

    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('translate HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      var list = Array.isArray(data) ? data : [data];
      if (list.length !== batch.length) {
        // Rather than shift translations onto the wrong nodes, ask one by one.
        return Promise.all(batch.map(function (item) { return requestOne(item.text, target); }));
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

  var snapshot = null;
  var run = 0;
  var select = document.getElementById('lang');

  function applyAll(items) {
    items.forEach(function (item) {
      if (item.text) item.node.nodeValue = item.lead + item.text + item.tail;
    });
  }

  function restore() {
    applyAll(snapshot);
  }

  function readCache(target) {
    try {
      var saved = JSON.parse(localStorage.getItem(CACHE_PREFIX + target) || 'null');
      if (!saved || saved.v !== CACHE_VERSION || !saved.src || saved.src.length !== snapshot.length) return null;
      for (var i = 0; i < snapshot.length; i++) {
        if (saved.src[i] !== snapshot[i].text.trim()) return null;
      }
      return snapshot.map(function (item, i) {
        return { node: item.node, text: saved.dst[i] || item.text, lead: item.lead, tail: item.tail };
      });
    } catch (e) {
      return null;
    }
  }

  function writeCache(target, items) {
    try {
      localStorage.setItem(CACHE_PREFIX + target, JSON.stringify({
        v: CACHE_VERSION,
        src: snapshot.map(function (item) { return item.text.trim(); }),
        dst: items.map(function (item) { return item.text; })
      }));
    } catch (e) { /* quota or private mode: just translate again next time */ }
  }

  function reveal() {
    document.documentElement.removeAttribute('data-i18n');
  }

  function translate(target) {
    var current = ++run;
    if (!snapshot) snapshot = collect();
    document.documentElement.lang = target;

    if (target === SOURCE) {
      restore();
      reveal();
      return Promise.resolve();
    }

    var cached = readCache(target);
    if (cached) {
      applyAll(cached);
      reveal();
      return Promise.resolve();
    }

    var results = new Array(snapshot.length);
    return chunk(snapshot).reduce(function (chain, batch) {
      return chain.then(function () {
        if (current !== run) return;
        return request(batch, target).then(function (texts) {
          texts.forEach(function (text, i) {
            if (text) results[batch[i].index] = text;
          });
        }).catch(function () {
          /* a failed batch keeps its English text rather than blanking out */
        });
      });
    }, Promise.resolve()).then(function () {
      if (current !== run) return;
      var out = snapshot.map(function (item, i) {
        return { node: item.node, text: results[i] || item.text, lead: item.lead, tail: item.tail };
      });
      applyAll(out);
      writeCache(target, out);
      reveal();
    });
  }

  if (!select) return;

  select.addEventListener('change', function () {
    var code = canonical(select.value) || SOURCE;
    try { localStorage.setItem(STORE, code); } catch (e) { /* ignore */ }
    translate(code);
  });

  var requested = new URLSearchParams(location.search).get('lang');
  var storedRaw = '';
  try { storedRaw = localStorage.getItem(STORE) || ''; } catch (e) { /* ignore */ }

  function boot(list) {
    index(list);
    select.innerHTML = '';
    list.forEach(function (pair) {
      var option = document.createElement('option');
      option.value = pair[0];
      option.textContent = pair[1];
      select.appendChild(option);
    });

    var fromUrl = canonical(requested);
    var start = fromUrl || canonical(storedRaw) ||
      canonical((navigator.languages && navigator.languages[0]) || navigator.language) || SOURCE;

    if (fromUrl) {
      try { localStorage.setItem(STORE, fromUrl); } catch (e) { /* ignore */ }
    }

    select.value = start;
    if (start !== SOURCE) translate(start);
  }

  // Don't leave a translated page waiting on the language list forever.
  var fallback = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 1400); });
  Promise.race([loadLanguages().catch(function () { return null; }), fallback]).then(function (list) {
    boot(list || NATIVE);
  });
})();
