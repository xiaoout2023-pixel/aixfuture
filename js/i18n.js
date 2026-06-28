/*!
 * AIX未来视野 - 多语言核心逻辑 (i18n)
 * 支持：中文（zh-CN）、英文（en）
 * 特性：
 *  1. 自动检测浏览器语言（首次访问）
 *  2. 用户偏好存 localStorage
 *  3. 顶部语言切换器
 *  4. data-i18n 属性自动翻译静态文本
 *  5. 暴露 window.t() / window.__() 给动态文本使用
 */
(function () {
  'use strict';

  var SUPPORTED_LANGS = ['zh-CN', 'en'];
  var DEFAULT_LANG = 'zh-CN';
  var STORAGE_KEY = 'aix_lang';

  var translations = {};
  var currentLang = DEFAULT_LANG;
  var loaded = false;

  function detectLanguage() {
    // 1. localStorage
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved && SUPPORTED_LANGS.indexOf(saved) !== -1) return saved;
    } catch (e) {}

    // 2. 浏览器语言
    var nav = (navigator.language || navigator.userLanguage || DEFAULT_LANG).toLowerCase();
    if (nav.indexOf('zh') === 0) return 'zh-CN';
    if (nav.indexOf('en') === 0) return 'en';

    // 3. 默认
    return DEFAULT_LANG;
  }

  function loadLang(lang, callback) {
    if (translations[lang]) {
      callback && callback();
      return;
    }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'locales/' + lang + '.json', true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status === 200) {
        try {
          translations[lang] = JSON.parse(xhr.responseText);
        } catch (e) {
          console.error('[i18n] Failed to parse', lang, e);
          translations[lang] = {};
        }
      } else {
        console.error('[i18n] Failed to load', lang, xhr.status);
        translations[lang] = {};
      }
      callback && callback();
    };
    xhr.send();
  }

  function get(key, fallback) {
    var parts = key.split('.');
    var cur = translations[currentLang];
    for (var i = 0; i < parts.length; i++) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, parts[i])) {
        cur = cur[parts[i]];
      } else {
        return fallback != null ? fallback : key;
      }
    }
    return cur;
  }

  function applyTranslations(root) {
    var scope = root || document;
    // 同时匹配三种属性：data-i18n（textContent）、data-i18n-html（innerHTML）、data-i18n-attr（属性翻译）
    var nodes = scope.querySelectorAll('[data-i18n], [data-i18n-html], [data-i18n-attr]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];

      // 1. 属性翻译：data-i18n-attr="placeholder:key,aria-label:key2"
      var attrTarget = node.getAttribute('data-i18n-attr');
      if (attrTarget) {
        var pairs = attrTarget.split(',');
        for (var j = 0; j < pairs.length; j++) {
          var p = pairs[j].split(':');
          if (p.length === 2) {
            var attrVal = get(p[1].trim(), null);
            if (attrVal != null) node.setAttribute(p[0].trim(), attrVal);
          }
        }
      }

      // 2. HTML 翻译：data-i18n-html="key"（保留内嵌 HTML 结构，如 <span class="text-gradient">）
      var htmlKey = node.getAttribute('data-i18n-html');
      if (htmlKey) {
        var htmlVal = get(htmlKey, null);
        if (htmlVal != null) node.innerHTML = htmlVal;
        continue;
      }

      // 3. 普通文本翻译：data-i18n="key"
      var key = node.getAttribute('data-i18n');
      if (key) {
        var val = get(key, null);
        if (val != null) node.textContent = val;
      }
    }

    // 更新 <html lang="...">
    document.documentElement.lang = currentLang === 'en' ? 'en' : 'zh-CN';

    // 移除 FOUC 隐藏类，让翻译后的内容可见
    document.documentElement.classList.remove('i18n-pending');

    // 更新语言切换器显示
    var langDisplay = document.querySelector('.lang-current-code');
    if (langDisplay) langDisplay.textContent = currentLang === 'en' ? 'EN' : '中';

    // 触发事件通知其他脚本
    document.dispatchEvent(new CustomEvent('languagechange', { detail: { lang: currentLang } }));
  }

  function setLanguage(lang) {
    if (SUPPORTED_LANGS.indexOf(lang) === -1) lang = DEFAULT_LANG;
    if (lang === currentLang && loaded) {
      applyTranslations();
      return;
    }
    currentLang = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {}
    loadLang(lang, function () {
      loaded = true;
      applyTranslations();
    });
  }

  function getCurrentLang() {
    return currentLang;
  }

  function init() {
    currentLang = detectLanguage();

    // 兜底：如果 3 秒后翻译还没应用，强制移除 FOUC 隐藏类
    // 防止 i18n.js 加载失败或 JSON 加载失败导致页面永远空白
    setTimeout(function () {
      document.documentElement.classList.remove('i18n-pending');
    }, 3000);

    loadLang(currentLang, function () {
      loaded = true;
      applyTranslations();
      // 预加载另一种语言
      var other = currentLang === 'zh-CN' ? 'en' : 'zh-CN';
      loadLang(other);
    });

    // 绑定切换器（点击展开/收起）
    bindSwitcher();

    // 监听动态插入的 DOM（例如 models.js 渲染的卡片）
    // 这里通过事件委托 + 手动调用 applyTranslations 实现
  }

  function bindSwitcher() {
    var switcher = document.querySelector('.lang-switcher');
    if (!switcher) return;

    var btn = switcher.querySelector('.lang-current');
    var menu = switcher.querySelector('.lang-menu');

    if (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        switcher.classList.toggle('open');
      });
    }

    if (menu) {
      var links = menu.querySelectorAll('.lang-option');
      for (var i = 0; i < links.length; i++) {
        links[i].addEventListener('click', function (e) {
          e.preventDefault();
          var lang = this.getAttribute('data-lang');
          setLanguage(lang);
          switcher.classList.remove('open');
        });
      }
    }

    // 点击外部关闭
    document.addEventListener('click', function (e) {
      if (!switcher.contains(e.target)) {
        switcher.classList.remove('open');
      }
    });
  }

  // 等待 DOM 就绪
  function domReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  domReady(function () {
    init();
  });

  // 暴露 API
  window.i18n = {
    t: get,
    setLanguage: setLanguage,
    getLanguage: getCurrentLang,
    apply: applyTranslations,
    ready: function () { return loaded; }
  };
  // 简短别名
  window.t = get;
  window.__ = get;
})();
