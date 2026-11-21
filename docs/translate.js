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
  var ENDPOINT = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t';
  var MAX_PAYLOAD = 1800;
  var CACHE_VERSION = 2; // bump when the applied text changes shape
  var SKIP = 'script,style,noscript,code,pre,textarea,select,option,[data-no-translate]';

  // Native names, so the picker reads the same to everybody.
  var LANGS = [
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
    ['am', 'አማርኛ'], ['ar', 'العربية'], ['he', 'עברית'], ['fa', 'فارسی'],
    ['ur', 'اردو'], ['hi', 'हिन्दी'], ['bn', 'বাংলা'], ['pa', 'ਪੰਜਾਬੀ'],
    ['gu', 'ગુજરાતી'], ['mr', 'मराठी'], ['ta', 'தமிழ்'], ['te', 'తెలుగు'],
    ['kn', 'ಕನ್ನಡ'], ['ml', 'മലയാളം'], ['si', 'සිංහල'], ['ne', 'नेपाली'],
    ['th', 'ไทย'], ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'], ['ms', 'Bahasa Melayu'],
    ['tl', 'Filipino'], ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['ja', '日本語'],
    ['ko', '한국어'], ['mn', 'Монгол'], ['kk', 'Қазақша'], ['uz', "Oʻzbekcha"],
    ['az', 'Azərbaycan'], ['hy', 'Հայերեն'], ['ka', 'ქართული'], ['eo', 'Esperanto']
  ];

  var byCode = {};
  LANGS.forEach(function (pair) { byCode[pair[0].toLowerCase()] = pair[0]; });

  /* "de-AT", "pt-BR", "zh-Hant" ... -> a code the picker knows. */
  function canonical(tag) {
    var value = String(tag || '').toLowerCase().trim();
    if (!value) return '';
    if (value.indexOf('zh') === 0) return byCode[/hant|tw|hk|mo/.test(value) ? 'zh-tw' : 'zh-cn'] || '';
    return byCode[value] || byCode[value.split('-')[0]] || '';
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

  /* One request carries many segments, each tagged with [[n]] so the reply can
     be mapped back. Markers survive translation, which plain newlines do not. */
  function request(batch, target) {
    var payload = batch.map(function (item, i) {
      return '[[' + i + ']] ' + item.text.replace(/\s+/g, ' ');
    }).join('\n');
    var url = ENDPOINT + '&sl=' + SOURCE + '&tl=' + encodeURIComponent(target) +
      '&q=' + encodeURIComponent(payload);

    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('translate HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      var merged = (data[0] || []).map(function (part) { return part[0]; }).join('');
      var found = {};
      var marker = /\[\[(\d+)\]\]\s?([\s\S]*?)(?=\[\[\d+\]\]|$)/g;
      var match;
      while ((match = marker.exec(merged))) found[Number(match[1])] = match[2].trim();
      return batch.map(function (item, i) { return found[i] || ''; });
    });
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

  LANGS.forEach(function (pair) {
    var option = document.createElement('option');
    option.value = pair[0];
    option.textContent = pair[1];
    select.appendChild(option);
  });

  select.addEventListener('change', function () {
    var code = canonical(select.value) || SOURCE;
    try { localStorage.setItem(STORE, code); } catch (e) { /* ignore */ }
    translate(code);
  });

  var param = canonical(new URLSearchParams(location.search).get('lang'));
  var stored = '';
  try { stored = canonical(localStorage.getItem(STORE)); } catch (e) { /* ignore */ }

  var start = param || stored || canonical((navigator.languages && navigator.languages[0]) || navigator.language) || SOURCE;

  if (param) {
    try { localStorage.setItem(STORE, param); } catch (e) { /* ignore */ }
  }

  select.value = start;
  if (start !== SOURCE) translate(start);
})();
