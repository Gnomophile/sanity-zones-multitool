// ==UserScript==
// @name         Sanity — мультитул по зонам (Mass Update)
// @namespace    starterapp-delivery-zones
// @version      7.10
// @description  Единая модалка «Управление зонами» (кнопка в левом меню Studio, рядом с баннерами): вкладки «Условия» (точечный выбор полей + поиск блюда каталога для платных цен), «Копирование зон» (между любыми ресторанами) и «Способы оплаты» (точечное вкл/выкл одного способа без замены всего списка), JSON-бэкап перед изменением, массовые операции с доп. подтверждением "Точно?" и риск-баннером при выборе нескольких ресторанов, умное отслеживание "своих" черновиков, предполётная проверка валидации Studio
// @match        https://my.starterapp.ru/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/Gnomophile/sanity-multitool/main/sanity-multitool.user.js
// @downloadURL  https://raw.githubusercontent.com/Gnomophile/sanity-multitool/main/sanity-multitool.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Определение Project ID.
  // ---------------------------------------------------------------------
  let cachedProjectId = null;
  let cachedWorkspace = null;

  const PROJECT_ID_LOG_RE = /SANITY PROJECT ID[\s>:=-]*([a-z0-9]{6,})/i;
  const origConsoleWarn = console.warn.bind(console);

  function currentWorkspace() {
    return window.location.pathname.split('/').filter(Boolean)[0] || null;
  }

  function setCachedProjectId(id) {
    cachedProjectId = id;
    cachedWorkspace  = currentWorkspace();
  }

  function tryCaptureFromArgs(args) {
    const combined = args
      .filter(a => typeof a === 'string' || typeof a === 'number')
      .join(' ');
    if (!combined.includes('SANITY PROJECT ID')) return;
    const m = combined.match(PROJECT_ID_LOG_RE);
    if (m) {
      setCachedProjectId(m[1]);
    } else {
      origConsoleWarn('[SZ] Нашёл "SANITY PROJECT ID" в логе, но не смог извлечь id из:', combined);
    }
  }

  for (const method of ['log', 'info', 'warn', 'debug']) {
    const orig = console[method].bind(console);
    console[method] = function (...args) {
      tryCaptureFromArgs(args);
      return orig(...args);
    };
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const m = url && url.match(/^https?:\/\/([a-z0-9]+)\.api\.sanity\.io/);
    if (m) setCachedProjectId(m[1]);
    return origFetch.call(this, input, init);
  };

  function getProjectId() {
    const ws = currentWorkspace();
    if (cachedProjectId && cachedWorkspace === ws) return cachedProjectId;
    if (cachedProjectId && cachedWorkspace !== ws) return null;
    const entries = performance.getEntriesByType('resource').map(e => e.name);
    const entry = entries.find(n => n.includes('.api.sanity.io'));
    const fromPerf = entry?.match(/^https?:\/\/([a-z0-9]+)\.api\.sanity\.io/)?.[1] || null;
    if (fromPerf) setCachedProjectId(fromPerf);
    return cachedProjectId;
  }

  function newKey() {
    const arr = new Uint8Array(6);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function deepClone(zone) {
    const c = JSON.parse(JSON.stringify(zone));
    c._key = newKey();
    if (Array.isArray(c.deliveryTypePrices)) {
      c.deliveryTypePrices = c.deliveryTypePrices.map(d => {
        const dc = { ...d, _key: newKey() };
        if (Array.isArray(dc.deliveryPrice)) dc.deliveryPrice = dc.deliveryPrice.map(p => ({ ...p, _key: newKey() }));
        return dc;
      });
    }
    return c;
  }

  function getShopId() {
    return window.location.href.match(/shops-item;shops;([a-f0-9-]{36})/)?.[1] || null;
  }

  function getAuthHeaders(projectId) {
    const tokenData = JSON.parse(localStorage.getItem(`__studio_auth_token_${projectId}`) || 'null');
    if (tokenData?.token) return { 'Authorization': `Bearer ${tokenData.token}` };
    return {};
  }

  async function apiFetch(projectId, path, options = {}) {
    const base = `https://${projectId}.api.sanity.io/v2024-05-28`;
    const headers = { ...getAuthHeaders(projectId), ...(options.headers || {}) };
    return fetch(`${base}${path}`, { ...options, headers, credentials: 'include' });
  }

  async function getDoc(projectId, id) {
    const r = await apiFetch(projectId, `/data/doc/production/drafts.${id},${id}`);
    const { documents } = await r.json();
    return documents.find(d => d._id === `drafts.${id}`) || documents.find(d => d._id === id) || null;
  }

  // Запрос списка всех актуальных ресторанов текущего workspace (исключая архив),
  // вместе с их зонами доставки (_key + name), нужен для двухуровневого каталога
  // в массовом применении условий. У каждой зоны также подтягиваются её способы
  // получения (deliveryTypePrices, _key + название через дереференс ->) — нужны
  // для третьего уровня пикера на вкладке «Способы оплаты» (у каждого способа
  // получения свой список paymentTypes, поэтому переключать нужно уметь и
  // зону целиком, и конкретный способ получения внутри неё). Дереференс сразу
  // в этом же запросе, без отдельного resolveDeliveryTypeNames — GROQ отдаёт
  // имя одним походом за счёт deliveryType->name.ru.
  async function fetchAllShops(projectId) {
    const query = encodeURIComponent(
      `*[_type == "shop" && !(_id in path("drafts.**")) && isArchived != true] | order(name.ru asc) {
        _id, name, address,
        "zones": deliveryZones[]{
          _key, name,
          "types": deliveryTypePrices[]{_key, "name": deliveryType->name.ru}
        }
      }`
    );
    const r = await apiFetch(projectId, `/data/query/production?query=${query}`);
    if (!r.ok) throw new Error("Не удалось загрузить список ресторанов");
    const { result } = await r.json();
    return result;
  }

  async function resolveDeliveryTypeNames(projectId, refs) {
    if (!refs.length) return {};
    const r = await apiFetch(projectId, `/data/doc/production/${refs.join(',')}`);
    const { documents } = await r.json();
    const map = {};
    for (const d of documents) map[d._id] = d.name?.ru || d.title?.ru || d._id;
    return map;
  }

  // Резолвит названия блюд каталога (тип "meal") по их id — для отображения
  // человекочитаемого названия у уже выбранной "Позиции для доставки из POS-системы".
  async function resolveMealNames(projectId, refs) {
    if (!refs.length) return {};
    const r = await apiFetch(projectId, `/data/doc/production/${refs.join(',')}`);
    const { documents } = await r.json();
    const map = {};
    for (const d of documents) map[d._id] = d.name?.ru || d.iikoName || d._id;
    return map;
  }

  // Поиск блюд каталога по названию — используется в поиске "Позиции для доставки
  // из POS-системы" в модалке условий. Ищет и по обычному названию, и по названию
  // из POS (iikoName), так как у доставочных позиций часто заполнено только оно.
  async function searchMeals(projectId, term) {
    const raw = (term || '').trim();
    if (!raw) return [];
    const safe = raw.replace(/["\\]/g, '').slice(0, 60);
    if (!safe) return [];
    const query = encodeURIComponent(
      `*[_type == "meal" && (name.ru match "*${safe}*" || iikoName match "*${safe}*")] | order(name.ru asc) [0...25]{
        _id, "title": coalesce(name.ru, iikoName, _id), "code": code.current, status
      }`
    );
    const r = await apiFetch(projectId, `/data/query/production?query=${query}`);
    if (!r.ok) throw new Error('запрос к каталогу не удался');
    const { result } = await r.json();
    return result || [];
  }

  // Публикует черновик заведения: копирует содержимое drafts.{id} в опубликованный
  // документ {id} и удаляет черновик — то же самое, что кнопка «Опубликовать» в интерфейсе.
  // Если черновика нет (значит уже опубликовано/нет несохранённых правок) — просто выходим.
  // ---------------------------------------------------------------------
  // Отслеживание "своих" черновиков: после каждого успешного патча запоминаем
  // ревизию (_rev), которую сам оставил скрипт. Если при следующем запуске
  // ревизия черновика совпадает с сохранённой — значит, с момента нашего
  // последнего касания никто больше документ не трогал, и накопленные
  // изменения безопасно публиковать. Если ревизия другая (или записи нет) —
  // считаем черновик потенциально содержащим посторонние правки.
  // ---------------------------------------------------------------------
  function ownedDraftKey(projectId, shopId) {
    return `sz-owned-draft:${projectId}:${shopId}`;
  }
  function getOwnedDraftRev(projectId, shopId) {
    try {
      const raw = localStorage.getItem(ownedDraftKey(projectId, shopId));
      return raw ? (JSON.parse(raw)?.rev || null) : null;
    } catch (e) { return null; }
  }
  function setOwnedDraftRev(projectId, shopId, rev) {
    if (!rev) return;
    try { localStorage.setItem(ownedDraftKey(projectId, shopId), JSON.stringify({ rev, ts: Date.now() })); }
    catch (e) { /* localStorage недоступен/переполнен — не критично */ }
  }
  function clearOwnedDraftRev(projectId, shopId) {
    try { localStorage.removeItem(ownedDraftKey(projectId, shopId)); } catch (e) { /* ignore */ }
  }

  // Резервная узкая проверка перед публикацией — только для МАССОВОГО применения,
  // где нет доступа к отрисованной странице других ресторанов и, соответственно,
  // к результату валидации самой Studio. Ловит только то, что подтверждено на
  // практике (отсутствие города) — НЕ полноценная валидация и заведомо не покрывает
  // прочие кастомные правила схемы. Для одиночного применения используется
  // hasStudioValidationError() — она гораздо надёжнее, так как читает уже готовый
  // результат валидации, посчитанный самой Studio.
  function getKnownValidationBlockers(doc) {
    const blockers = [];
    if (!doc?.address?.cityRef?._ref) blockers.push('не выбран город (Адрес → Город)');
    return blockers;
  }

  // Проверяет, показывает ли САМА Studio ошибку валидации для документа,
  // который сейчас открыт на странице (кнопка "Валидация" в шапке документа
  // существует в DOM только когда есть хотя бы одна ошибка валидации любого
  // рода — какие бы кастомные правила ни были в схеме, achievable без
  // необходимости знать их заранее). Работает только для текущего открытого
  // документа — у других документов (не отрисованных на странице) этой
  // информации получить нельзя.
  function hasStudioValidationError() {
    const btn = document.querySelector('button[aria-label="Валидация"]');
    return !!btn?.querySelector('[data-sanity-icon="error-outline"]');
  }

  // Переключает Studio на документ ресторана через её собственный SPA-роутер
  // (pushState + popstate), НЕ перезагружая страницу — скрипт и все его переменные
  // остаются живы. Ждёт, пока URL и панель валидации реально обновятся.
  async function navigateToShopSpa(workspace, shopId, timeoutMs = 6000) {
    const targetPath = `/${workspace}/structure/shops-item;shops;${shopId}`;
    history.pushState({}, '', targetPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 250));
      if (location.pathname.includes(shopId)) break;
    }
    // доп. пауза, чтобы Studio успела пересчитать и отрисовать валидацию для нового документа
    await new Promise(r => setTimeout(r, 700));
  }

  // Предполётная проверка перед массовой публикацией: по очереди открывает каждый
  // выбранный ресторан через SPA-навигацию и читает у Studio реальный результат
  // валидации (какие бы кастомные правила ни были в схеме). В конце возвращает
  // Studio туда, откуда начали. Возвращает список ресторанов, не прошедших валидацию.
  async function checkShopsValidationBeforePublish(workspace, shopIds, originalPath, showProgress) {
    const invalidShops = [];
    for (let i = 0; i < shopIds.length; i++) {
      const shopId = shopIds[i];
      if (showProgress) showToast(`Проверка валидации: ${i + 1} из ${shopIds.length}...`, 'info', 2000);
      await navigateToShopSpa(workspace, shopId);
      if (hasStudioValidationError()) {
        const shopName = document.querySelector('h1')?.textContent?.trim() || shopId;
        invalidShops.push({ shopId, shopName });
      }
    }
    await navigateToShopSpa(workspace, originalPath.match(/shops;([a-f0-9-]{36})/)?.[1] || '');
    return invalidShops;
  }

  async function publishDoc(projectId, shopId) {
    const draftId = 'drafts.' + shopId;
    const { documents } = await (await apiFetch(projectId, `/data/doc/production/${draftId}`)).json();
    const draftDoc = documents?.[0];
    if (!draftDoc) return false;

    const blockers = getKnownValidationBlockers(draftDoc);
    if (blockers.length > 0) {
      throw new Error('не пройдена валидация — ' + blockers.join('; ') + '. Исправьте вручную в интерфейсе и опубликуйте оттуда.');
    }

    const publishedDoc = { ...draftDoc, _id: shopId };
    delete publishedDoc._rev;
    const mutations = [
      { createOrReplace: publishedDoc },
      { delete: { id: draftId } }
    ];
    const r = await apiFetch(projectId, `/data/mutate/production`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mutations })
    });
    if (!r.ok) {
      const result = await r.json();
      throw new Error('публикация не удалась: ' + JSON.stringify(result?.error || result));
    }
    return true;
  }

  function getAddress(doc) {
    const street = doc.address?.street?.ru || '';
    const house  = doc.address?.house?.ru  || '';
    if (street && house) return `${street}, ${house}`;
    return street || doc.name?.ru || doc._id;
  }

  // Формирует имя файла бэкапа с меткой времени: prefix_2026-08-11_14-32-07.json
  function backupFilename(prefix) {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const safePrefix = String(prefix).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    return `${safePrefix}_${stamp}.json`;
  }

  // Скачивает объект как .json файл через скрытую ссылку — без сервера, чисто в браузере
  function downloadJson(filename, data) {
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (e) {
      showToast('Не удалось сохранить бэкап: ' + e.message, 'error');
    }
  }

  // ---------------------------------------------------------------------
  // Стили модалки (палитра из modal-style-guide) + переключатель темы.
  // Тема хранится в localStorage и применяется классом .smt-dark на корневой
  // элемент каждого всплывающего окна (оверлей/тост/confirm) — они не вложены
  // друг в друга, поэтому переменные темы нельзя унаследовать через один общий
  // корень, каждый корень получает класс отдельно при создании.
  // ---------------------------------------------------------------------
  const SZ_MODAL_STYLE_ID = 'sz-modal-styles';
  const SZ_THEME_KEY = 'sz-modal-theme';

  function ensureModalStyles() {
    if (document.getElementById(SZ_MODAL_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = SZ_MODAL_STYLE_ID;
    style.textContent = `
      :root {
        --smt-accent: #bd5b34;
        --smt-accent-hover: #9c4a29;
        --smt-accent-shadow: rgba(189, 91, 52, .35);
        --smt-accent-soft-bg: #f3e3da;
        --smt-accent-soft-border: #e0b89e;
        --smt-accent-soft-text: #7a3c1e;
        --smt-bg-page: #fbf9f5;
        --smt-bg-panel: #fffdfa;
        --smt-bg-subtle: #f2ede2;
        --smt-border: #e6dfd0;
        --smt-border-soft: #ece6d9;
        --smt-text-primary: #2b2620;
        --smt-text-secondary: #857e6f;
        --smt-text-tertiary: #a89f8c;
        --smt-warning-bg: #fff3cd;
        --smt-warning-border: #ffe08a;
        --smt-warning-text: #6b5416;
      }
      .smt-dark {
        --smt-accent: #d97a4f;
        --smt-accent-hover: #e8956d;
        --smt-accent-shadow: rgba(217, 122, 79, .4);
        --smt-accent-soft-bg: #4a2f22;
        --smt-accent-soft-border: #6b4530;
        --smt-accent-soft-text: #edb08a;
        --smt-bg-page: #211d17;
        --smt-bg-panel: #2b251d;
        --smt-bg-subtle: #332c22;
        --smt-border: #443b2d;
        --smt-border-soft: #3a3327;
        --smt-text-primary: #f1ece1;
        --smt-text-secondary: #b8ae9c;
        --smt-text-tertiary: #8f8672;
        --smt-warning-bg: #4a3c14;
        --smt-warning-border: #6b5a24;
        --smt-warning-text: #e8d9a8;
      }
      .sz-modal-ui button { margin: 0; padding: 0; font: inherit; }
      .sz-modal-ui, .sz-modal-ui * {
        transition: background-color .2s ease, border-color .2s ease, color .2s ease;
      }
      .sz-flat-btn {
        border: 1px solid var(--smt-border); background: var(--smt-bg-panel); border-radius: 8px;
        color: var(--smt-text-secondary); cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
      }
      .sz-flat-btn:hover { border-color: var(--smt-accent); }
      .smt-theme-switch {
        position: relative; display: inline-flex; align-items: center; cursor: pointer;
        -webkit-tap-highlight-color: transparent; user-select: none; flex-shrink: 0;
      }
      .smt-theme-switch .switch__input {
        margin: 0; width: 66px; height: 34px; background-color: var(--smt-bg-page);
        border: 1px solid var(--smt-border); border-radius: 8px;
        outline: none; box-shadow: none; -webkit-tap-highlight-color: transparent;
        -webkit-appearance: none; appearance: none; cursor: pointer;
        transition: background-color .2s ease, border-color .2s ease;
      }
      .smt-theme-switch .switch__input:checked { background-color: var(--smt-bg-subtle); }
      .smt-theme-switch .switch__input:focus-visible { box-shadow: 0 0 0 2px var(--smt-accent-shadow); }
      .smt-theme-switch .switch__icon {
        position: absolute; top: 50%; width: 12px; height: 12px; transform: translateY(-50%) rotate(0deg);
        pointer-events: none; z-index: 2; color: var(--smt-text-tertiary);
        transition: color .2s ease, transform .3s ease;
      }
      .smt-theme-switch .switch__icon--sun { left: 11px; }
      .smt-theme-switch .switch__icon--moon { right: 11px; }
      .smt-theme-switch .switch__input:not(:checked) ~ .switch__icon--sun {
        color: #fff; transform: translateY(-50%) rotate(360deg);
      }
      .smt-theme-switch .switch__input:checked ~ .switch__icon--moon {
        color: #fff; transform: translateY(-50%) rotate(360deg);
      }
      .smt-theme-switch .switch__knob {
        position: absolute; top: 3px; left: 3px; width: 28px; height: 28px; border-radius: 6px;
        background: var(--smt-accent); pointer-events: none; z-index: 1;
        transition: transform .25s cubic-bezier(0.65,0,0.35,1), background-color .2s ease;
      }
      .smt-theme-switch .switch__input:checked ~ .switch__knob { transform: translateX(32px); }
      .smt-theme-switch .switch__sr { overflow: hidden; position: absolute; width: 1px; height: 1px; }

      /* Сегментированный переключатель (N позиций, radio) — вкладки модалки и
         вкл/выкл способа оплаты. Заливка едет вертикально translateY, поэтому
         позиций может быть любое число без пересчёта геометрии. */
      .smt-tri {
        position: relative; display: inline-flex; height: 42px; border: 1px solid var(--smt-border);
        border-radius: 8px; overflow: hidden; flex-shrink: 0; box-sizing: border-box;
      }
      .smt-tri input { position: absolute; width: 0; height: 0; opacity: 0; }
      .smt-tri-opt {
        position: relative; overflow: hidden; height: 100%; box-sizing: border-box;
        display: inline-flex; align-items: center; justify-content: center;
        padding: 0 14px; font-size: 13px; font-weight: 600;
        cursor: pointer; color: var(--smt-text-secondary); white-space: nowrap; background: var(--smt-bg-panel);
      }
      .smt-tri-opt + .smt-tri-opt { border-left: 1px solid var(--smt-border); }
      .smt-tri-opt:hover .smt-tri-text { color: var(--smt-text-primary); }
      .smt-tri-fill {
        position: absolute; inset: 0; background: var(--smt-accent);
        transform: translateY(-100%);
        transition: transform .5s cubic-bezier(0.22, 1, 0.36, 1);
        z-index: 1;
      }
      .smt-tri-text { position: relative; z-index: 2; transition: color .15s ease; }
      .smt-tri input:checked + label .smt-tri-fill { transform: translateY(0); }
      .smt-tri input:checked + label .smt-tri-text { color: #fff; }

      /* Дерево ресторан→зоны, общее для всех вкладок-пикеров целей/источника. */
      .smt-shop-tree { max-height: 300px; overflow-y: auto; border: 1px solid var(--smt-border-soft); border-radius: 6px; padding: 10px; }
      .smt-shop-block { border: 1px solid var(--smt-border-soft); border-radius: 6px; margin-bottom: 6px; padding: 6px 10px; }
      .smt-shop-block summary { display: flex; align-items: center; gap: 8px; cursor: pointer; list-style: none; color: var(--smt-text-primary); }
      .smt-shop-block summary::-webkit-details-marker { display: none; }

      /* Кнопка вызова хаба в левом меню Studio — живёт вне .sz-modal-ui,
         поэтому сбрасывает свои UA-отступы сама (см. pitfalls.md, пункт 1). */
      #sz-nav-btn {
        margin: 0; box-sizing: border-box;
        display: inline-flex; align-items: center; gap: 6px; margin-left: 4px;
        background: var(--smt-accent); color: #fff; border: none; border-radius: 6px;
        padding: 0 14px; height: 33px; font-size: 13px; font-weight: 600; cursor: pointer;
        font-family: inherit; white-space: nowrap;
      }
      #sz-nav-btn:hover { background: var(--smt-accent-hover); }
      #sz-fab {
        margin: 0; box-sizing: border-box;
        position: fixed; bottom: 22px; right: 22px; z-index: 999998;
        display: inline-flex; align-items: center; gap: 8px;
        background: var(--smt-accent); color: #fff; border: none; border-radius: 24px;
        padding: 11px 18px; font-size: 13px; font-weight: 600; cursor: pointer;
        font-family: inherit; white-space: nowrap;
        box-shadow: 0 6px 18px var(--smt-accent-shadow);
      }
      #sz-fab:hover { background: var(--smt-accent-hover); }
    `;
    document.head.appendChild(style);
  }

  function getStoredTheme() {
    try { return localStorage.getItem(SZ_THEME_KEY) === 'dark' ? 'dark' : 'light'; }
    catch (e) { return 'light'; }
  }
  function setStoredTheme(theme) {
    try { localStorage.setItem(SZ_THEME_KEY, theme); } catch (e) { /* localStorage недоступен — просто не запомним выбор */ }
  }
  function applyStoredTheme(el) {
    ensureModalStyles();
    el.classList.add('sz-modal-ui');
    el.classList.toggle('smt-dark', getStoredTheme() === 'dark');
  }

  // Свитч темы для шапки модалки. Иконки и шайба — прямые соседи input
  // (без оборачивающего <span>), иначе CSS ~-селекторы перестают матчить.
  function buildThemeSwitch(onToggle) {
    const label = document.createElement('label');
    label.className = 'smt-theme-switch';
    label.title = 'Переключить тему';
    label.innerHTML = `
      <span class="switch__sr">Тёмная тема</span>
      <input type="checkbox" class="switch__input" data-sz-theme-toggle>
      <svg class="switch__icon switch__icon--sun" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/><path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>
      <svg class="switch__icon switch__icon--moon" viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>
      <span class="switch__knob"></span>
    `;
    const input = label.querySelector('[data-sz-theme-toggle]');
    input.checked = getStoredTheme() === 'dark';
    input.addEventListener('change', () => {
      const next = input.checked ? 'dark' : 'light';
      setStoredTheme(next);
      if (onToggle) onToggle(next);
    });
    return label;
  }

  // Доп. подтверждение перед массовым применением — легко ошибиться, задев сразу
  // много ресторанов, а откат из бэкапа небыстрый. "Нет" просто закрывает окно
  // подтверждения и возвращает к прежним настройкам в модалке — ничего не сбрасывается.
  function showMassApplyConfirm(shopsCount, onConfirm) {
    const confirmOverlay = document.createElement('div');
    applyStoredTheme(confirmOverlay);
    confirmOverlay.style.cssText = `
      position:fixed;inset:0;z-index:9999999;
      background:rgba(23,20,14,.55);
      display:flex;align-items:center;justify-content:center;
      font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    `;
    const box = document.createElement('div');
    box.style.cssText = `
      background:var(--smt-bg-panel);color:var(--smt-text-primary);border-radius:12px;padding:28px;
      width:420px;max-width:90vw;
      box-shadow:0 10px 40px rgba(0,0,0,0.35);
      text-align:center;
    `;
    const shopsLabel = shopsCount != null ? `${shopsCount} ${shopsCount === 1 ? 'ресторан' : 'ресторанов'}` : 'несколько ресторанов';
    box.innerHTML = `
      <div style="font-size:38px;margin-bottom:8px;">⚠️</div>
      <div style="font-size:19px;font-weight:700;color:var(--smt-text-primary);margin-bottom:10px;">Точно?</div>
      <div style="font-size:14px;color:var(--smt-text-secondary);margin-bottom:24px;line-height:1.55;">
        Изменения применятся сразу к ${shopsLabel}. Это действие нельзя откатить одним кликом —
        восстановление из бэкапа придётся делать вручную. Проверьте ещё раз список
        ресторанов и зон перед тем, как продолжить.
      </div>
      <div style="display:flex; gap:12px;">
        <button id="sz-confirm-no" style="flex:1;padding:12px;border:1px solid var(--smt-border);background:var(--smt-bg-panel);color:var(--smt-text-primary);border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;">Нет, вернуться</button>
        <button id="sz-confirm-yes" style="flex:1;padding:12px;border:none;background:#d64236;color:#fff;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;">Да, применить</button>
      </div>
    `;
    confirmOverlay.appendChild(box);
    document.body.appendChild(confirmOverlay);

    box.querySelector('#sz-confirm-no').addEventListener('click', () => confirmOverlay.remove());
    box.querySelector('#sz-confirm-yes').addEventListener('click', () => {
      confirmOverlay.remove();
      onConfirm();
    });
    confirmOverlay.addEventListener('click', e => { if (e.target === confirmOverlay) confirmOverlay.remove(); });
  }

  function showToast(message, type = 'info', duration = 5000) {
    const existing = document.getElementById('sz-toast');
    if (existing) existing.remove();
    const palette = {
      info:    { bg: '#eaf2fd', border: '#2f6fd1', text: '#173963' },
      success: { bg: '#eafaf1', border: '#1f9d55', text: '#0f4a28' },
      error:   { bg: '#fdecea', border: '#d64236', text: '#7a201a' },
      warning: { bg: '#fff6e0', border: '#e0900a', text: '#6b4600' }
    };
    const c = palette[type] || palette.info;
    const toast = document.createElement('div');
    toast.id = 'sz-toast';
    applyStoredTheme(toast);
    toast.style.cssText = `
      position:fixed; bottom:24px; right:24px; z-index:999999;
      background:${c.bg}; color:${c.text};
      border-left:5px solid ${c.border};
      padding:14px 20px; border-radius:8px; font-size:14px; font-weight:500;
      box-shadow:0 6px 20px rgba(0,0,0,0.18); max-width:440px; max-height:70vh; overflow-y:auto;
      line-height:1.6; white-space:pre-line; transition:opacity 0.3s;
      font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, duration);
  }

  // Копирует набор зон (уже загруженных у ресторана-источника) в несколько
  // ресторанов-целей сразу — раньше это было двухшаговым действием через
  // глобальный clipboard (открыть источник → «Копировать», открыть цель →
  // «Вставить»); теперь источник и цели выбираются явно в одной модалке,
  // поэтому шаг сведён к одному проходу по списку целей.
  async function copyZonesToShops(projectId, sourceZones, sourceAddress, targetShopIds, opts) {
    opts = opts || {};
    const addedByShop = {};
    const skippedMsgs = [];
    const errors = [];
    for (const shopId of targetShopIds) {
      try {
        const targetDoc = await getDoc(projectId, shopId);
        if (!targetDoc) { errors.push(`${shopId}: заведение не найдено`); continue; }
        const targetZones = targetDoc.deliveryZones || [];
        const draftId  = 'drafts.' + shopId;
        const hasDraft = targetDoc._id.startsWith('drafts.');
        const zonesToAdd = [];
        const skippedHere = [];
        for (const zone of sourceZones) {
          const newName = `${zone.name} с ${sourceAddress}`;
          if (targetZones.find(z => z.name === newName)) { skippedHere.push(newName); continue; }
          const clone = deepClone(zone);
          clone.name = newName;
          zonesToAdd.push(clone);
        }
        if (skippedHere.length) skippedMsgs.push(`${targetDoc.name?.ru || shopId}: ${skippedHere.join(', ')} (уже есть)`);
        if (zonesToAdd.length === 0) continue;

        const mutations = [];
        if (!hasDraft) {
          const { documents } = await (await apiFetch(projectId, `/data/doc/production/${shopId}`)).json();
          mutations.push({ createIfNotExists: { ...documents[0], _id: draftId } });
        }
        mutations.push({
          patch: {
            id: draftId,
            setIfMissing: { deliveryZones: [] },
            insert: { after: 'deliveryZones[-1]', items: zonesToAdd }
          }
        });
        const r = await apiFetch(projectId, `/data/mutate/production?returnIds=true&returnDocuments=true`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mutations })
        });
        if (!r.ok) {
          const result = await r.json();
          errors.push(`${targetDoc.name?.ru || shopId}: ошибка Sanity — ${JSON.stringify(result?.error || result)}`);
          continue;
        }
        const result = await r.json();
        const draftResult = result.results?.find(x => x.id === draftId);
        const ownedRev = hasDraft ? getOwnedDraftRev(projectId, shopId) : null;
        const isKnownOwned = !hasDraft || (ownedRev !== null && ownedRev === targetDoc._rev);
        const isForeignDraft = hasDraft && !isKnownOwned;
        if (isKnownOwned) setOwnedDraftRev(projectId, shopId, draftResult?.document?._rev || null);

        addedByShop[shopId] = { shopName: targetDoc.name?.ru || shopId, zoneNames: zonesToAdd.map(z => z.name), isForeignDraft };

        if (opts.autoPublish) {
          if (isForeignDraft && !opts.forcePublish) {
            addedByShop[shopId].publishSkipped = 'foreign';
          } else {
            try {
              await publishDoc(projectId, shopId);
              clearOwnedDraftRev(projectId, shopId);
              addedByShop[shopId].published = true;
            } catch (e) {
              addedByShop[shopId].publishError = e.message;
            }
          }
        }
      } catch (e) {
        errors.push(`${shopId}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return { addedByShop, skippedMsgs, errors };
  }

  const PAYMENT_TYPES = [
    { value: 'card',          label: 'Банковская карта' },
    { value: 'cash',          label: 'Наличные' },
    { value: 'cardToCourier', label: 'Картой курьеру' },
    { value: 'cashToCourier', label: 'Наличными курьеру' },
    { value: 'sbp',           label: 'СБП' },
    { value: 'sberpay',       label: 'SberPay' },
    { value: 'bonus',         label: 'Бонусный счёт' },
    { value: 'apple',         label: 'Apple Pay' },
    { value: 'applePayWeb',   label: 'Apple Pay на странице оплаты' },
    { value: 'google',        label: 'Google Pay' }
  ];

  function buildPaymentTypesEditor(currentValues) {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-sz-payment-types', '1');
    wrap.style.cssText = 'margin-top:14px;';
    const title = document.createElement('label');
    title.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;color:var(--smt-text-secondary);margin-bottom:8px;cursor:pointer;';
    title.innerHTML = '<input type="checkbox" data-sz-include-payment style="width:15px;height:15px;cursor:pointer;accent-color:var(--smt-accent);"> Типы оплаты';
    wrap.appendChild(title);

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;';
    const known = new Set(currentValues || []);
    for (const pt of PAYMENT_TYPES) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;color:var(--smt-text-primary);cursor:pointer;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.setAttribute('data-sz-payment-value', pt.value);
      cb.checked = known.has(pt.value);
      cb.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:var(--smt-accent);';
      const span = document.createElement('span');
      span.textContent = pt.label;
      label.appendChild(cb);
      label.appendChild(span);
      grid.appendChild(label);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  function readPaymentTypes(container) {
    const wrap = container.querySelector('[data-sz-payment-types]');
    if (!wrap) return null;
    const checked = Array.from(wrap.querySelectorAll('input[data-sz-payment-value]'))
      .filter(cb => cb.checked)
      .map(cb => cb.getAttribute('data-sz-payment-value'));
    return checked;
  }

  // Виджет выбора "Позиции для доставки из POS-системы" — обязательного блюда из
  // каталога, которое Sanity требует указывать, когда доставка платная (цена по
  // умолчанию или ступень градации != 0). Хранит выбор в data-атрибутах на самом
  // wrap-элементе (productRef/productTitle), чтобы его было легко прочитать при
  // сборе изменений и при проверке "не забыли ли выбрать блюдо".
  function buildProductPicker(projectId, opts) {
    opts = opts || {};
    const wrap = document.createElement('div');
    wrap.setAttribute('data-sz-product-picker', '1');
    wrap.dataset.productRef = opts.currentRef || '';
    wrap.dataset.productTitle = opts.currentTitle || '';
    wrap.style.cssText = 'margin-top:6px;';

    const label = document.createElement('div');
    label.textContent = 'Позиция для доставки из POS-системы';
    label.style.cssText = 'font-size:12px;color:var(--smt-text-tertiary);margin-bottom:4px;';
    wrap.appendChild(label);

    const chipRow = document.createElement('div');
    chipRow.style.cssText = 'display:flex;align-items:center;gap:6px;';

    const chip = document.createElement('div');
    chip.style.cssText = 'flex:1;min-width:0;padding:7px 10px;border:1px solid var(--smt-border);border-radius:6px;font-size:13px;background:var(--smt-bg-panel);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

    const searchBtn = document.createElement('button');
    searchBtn.type = 'button';
    searchBtn.textContent = '🔍';
    searchBtn.title = 'Найти блюдо в каталоге Sanity';
    searchBtn.style.cssText = 'padding:7px 10px;border:1px solid var(--smt-accent);background:var(--smt-bg-panel);color:var(--smt-accent);border-radius:6px;cursor:pointer;font-size:13px;flex-shrink:0;';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = '✕';
    clearBtn.title = 'Убрать выбранное блюдо';
    clearBtn.style.cssText = 'padding:7px 9px;border:1px solid #e74c3c;background:var(--smt-bg-panel);color:#e74c3c;border-radius:6px;cursor:pointer;font-size:13px;flex-shrink:0;';

    chipRow.appendChild(chip);
    chipRow.appendChild(searchBtn);
    chipRow.appendChild(clearBtn);
    wrap.appendChild(chipRow);

    const searchPanel = document.createElement('div');
    searchPanel.style.cssText = 'display:none;margin-top:6px;border:1px solid var(--smt-border);border-radius:6px;padding:8px;background:var(--smt-bg-subtle);';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Поиск блюда по названию...';
    searchInput.style.cssText = 'width:100%;padding:7px 9px;border:1px solid var(--smt-border);border-radius:6px;font-size:13px;box-sizing:border-box;font-family:inherit;background:var(--smt-bg-panel);color:var(--smt-text-primary);';
    const resultsList = document.createElement('div');
    resultsList.style.cssText = 'max-height:220px;overflow-y:auto;margin-top:6px;';
    searchPanel.appendChild(searchInput);
    searchPanel.appendChild(resultsList);
    wrap.appendChild(searchPanel);

    function render() {
      const ref = wrap.dataset.productRef;
      const title = wrap.dataset.productTitle;
      if (ref) {
        chip.textContent = title || ref;
        chip.style.color = 'var(--smt-text-primary)';
        clearBtn.style.display = '';
      } else {
        chip.textContent = 'Блюдо не выбрано';
        chip.style.color = 'var(--smt-text-tertiary)';
        clearBtn.style.display = 'none';
      }
    }
    render();

    function setSelection(id, title) {
      wrap.dataset.productRef = id || '';
      wrap.dataset.productTitle = title || '';
      render();
    }

    searchBtn.addEventListener('click', () => {
      const opening = searchPanel.style.display !== 'block';
      searchPanel.style.display = opening ? 'block' : 'none';
      if (opening) { searchInput.value = ''; resultsList.innerHTML = ''; searchInput.focus(); }
    });
    clearBtn.addEventListener('click', () => setSelection('', ''));

    let debTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(debTimer);
      const term = searchInput.value.trim();
      if (!term) { resultsList.innerHTML = ''; return; }
      debTimer = setTimeout(async () => {
        resultsList.innerHTML = '<div style="padding:6px;color:var(--smt-text-tertiary);font-size:12px;">Ищем...</div>';
        try {
          const items = await searchMeals(projectId, term);
          resultsList.innerHTML = '';
          if (!items.length) {
            resultsList.innerHTML = '<div style="padding:6px;color:var(--smt-text-tertiary);font-size:12px;">Ничего не найдено</div>';
            return;
          }
          items.forEach(m => {
            const row = document.createElement('div');
            row.style.cssText = 'padding:6px 8px;cursor:pointer;border-radius:4px;font-size:13px;color:var(--smt-text-primary);';
            let text = m.title + (m.status === false ? ' (отключено)' : '');
            if (m.code) text += ' — ' + m.code;
            row.textContent = text;
            row.addEventListener('mouseenter', () => { row.style.background = 'var(--smt-accent-soft-bg)'; });
            row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
            row.addEventListener('click', () => {
              setSelection(m._id, m.title);
              searchPanel.style.display = 'none';
            });
            resultsList.appendChild(row);
          });
        } catch (e) {
          resultsList.innerHTML = '<div style="padding:6px;color:#e74c3c;font-size:12px;">Ошибка поиска: ' + e.message + '</div>';
        }
      }, 300);
    });

    return wrap;
  }

  function buildGradationEditor(rows, dynamicCalc, defaultCompType, projectId, mealNameMap) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:6px;';
    const table = document.createElement('div');
    table.setAttribute('data-sz-grad-table', '1');
    table.style.cssText = 'display:flex; flex-direction:column; gap:8px;';

    function renderCompTypeSelect(rawValue) {
      const known = [
        { key: '0', raw: 'percent', label: 'В процентах' },
        { key: '1', raw: 'currency', label: 'В валюте' }
      ];
      const rawMap = { '': null };
      let optionsHtml = '<option value="">- тип -</option>';
      let matchedKey = '';
      for (const opt of known) {
        rawMap[opt.key] = opt.raw;
        const isMatch = rawValue !== undefined && rawValue !== null && String(rawValue) === String(opt.raw);
        if (isMatch) matchedKey = opt.key;
        optionsHtml += '<option value="' + opt.key + '"' + (isMatch ? ' selected' : '') + '>' + opt.label + '</option>';
      }
      if (rawValue !== undefined && rawValue !== null && !matchedKey) {
        rawMap['unknown'] = rawValue;
        optionsHtml += '<option value="unknown" selected>⚠ текущее значение (' + JSON.stringify(rawValue) + ')</option>';
        matchedKey = 'unknown';
      }
      const encodedMap = JSON.stringify(rawMap).replace(/"/g, '&quot;');
      return '<select style="padding:8px 10px;border:1px solid var(--smt-border);border-radius:6px;font-size:16px;font-family:inherit;background:var(--smt-bg-panel);color:var(--smt-text-primary);" ' +
        'data-sz-grad-comp-type data-sz-raw-map="' + encodedMap + '">' + optionsHtml + '</select>';
    }

    function addRow(basketPriceTo, price, compType, compValue, productRef, productTitle) {
      basketPriceTo = basketPriceTo ?? '';
      price = price ?? '';
      compValue = compValue ?? '';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; flex-direction:column; gap:8px; padding:8px; border:1px solid var(--smt-border-soft); border-radius:8px; background:var(--smt-bg-panel);';
      const topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex; gap:10px; align-items:center; flex-wrap:wrap;';
      const inputStyle = 'padding:8px 10px;border:1px solid var(--smt-border);border-radius:6px;font-size:16px;font-family:inherit;background:var(--smt-bg-panel);color:var(--smt-text-primary);';
      if (dynamicCalc) {
        topRow.innerHTML =
          '<span style="font-size:14px;color:var(--smt-text-tertiary);white-space:nowrap;">до &#8381;</span>' +
          '<input type="number" placeholder="сумма корзины" value="' + basketPriceTo + '" ' +
            'style="width:130px;' + inputStyle + '" data-sz-grad-to>' +
          '<span style="font-size:14px;color:var(--smt-text-tertiary);">&rarr;</span>' +
          renderCompTypeSelect(compType) +
          '<input type="number" placeholder="значение" value="' + compValue + '" ' +
            'style="width:110px;' + inputStyle + '" data-sz-grad-comp-value>' +
          '<button type="button" style="padding:6px 12px;border:none;background:#e74c3c;color:#fff;border-radius:6px;cursor:pointer;font-size:15px;" data-sz-grad-del>&#10005;</button>';
      } else {
        topRow.innerHTML =
          '<span style="font-size:14px;color:var(--smt-text-tertiary);white-space:nowrap;">до &#8381;</span>' +
          '<input type="number" placeholder="сумма корзины" value="' + basketPriceTo + '" ' +
            'style="width:130px;' + inputStyle + '" data-sz-grad-to>' +
          '<span style="font-size:14px;color:var(--smt-text-tertiary);">&rarr; &#8381;</span>' +
          '<input type="number" placeholder="цена" value="' + price + '" ' +
            'style="width:110px;' + inputStyle + '" data-sz-grad-price>' +
          '<button type="button" style="padding:6px 12px;border:none;background:#e74c3c;color:#fff;border-radius:6px;cursor:pointer;font-size:15px;" data-sz-grad-del>&#10005;</button>';
      }
      topRow.querySelector('[data-sz-grad-del]').addEventListener('click', () => row.remove());
      row.appendChild(topRow);

      const productPicker = buildProductPicker(projectId, { currentRef: productRef, currentTitle: productTitle });
      productPicker.setAttribute('data-sz-grad-product-picker', '1');
      row.appendChild(productPicker);

      table.appendChild(row);
    }

    for (const r of rows) {
      const rowCompType = (r.compensation?.compensationType ?? defaultCompType);
      const productRef = r.deliveryProduct?._ref || '';
      const productTitle = productRef ? (mealNameMap?.[productRef] || productRef) : '';
      addRow(r.basketPriceTo, r.price, rowCompType, r.compensation?.compensationValue, productRef, productTitle);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = '+ Добавить ступень';
    addBtn.style.cssText = 'margin-top:8px;padding:8px 14px;border:1px dashed var(--smt-accent);background:transparent;color:var(--smt-accent);border-radius:6px;cursor:pointer;font-size:14px;';
    addBtn.addEventListener('click', () => addRow(undefined, undefined, defaultCompType, undefined, '', ''));

    wrap.appendChild(table);
    wrap.appendChild(addBtn);
    return wrap;
  }

  function readGradation(container, dynamicCalc) {
    const rows = container.querySelectorAll('[data-sz-grad-table] > div');
    const result = [];
    for (const row of rows) {
      const to = parseFloat(row.querySelector('[data-sz-grad-to]')?.value);
      if (isNaN(to)) continue;
      const productRef = row.querySelector('[data-sz-grad-product-picker]')?.dataset.productRef || '';
      const deliveryProduct = productRef ? { _type: 'reference', _weak: true, _ref: productRef } : undefined;
      if (dynamicCalc) {
        const typeEl  = row.querySelector('[data-sz-grad-comp-type]');
        const valueEl = row.querySelector('[data-sz-grad-comp-value]');
        const selectedKey = typeEl ? typeEl.value : '';
        const value = parseFloat(valueEl?.value);
        if (selectedKey === '' || isNaN(value)) continue;
        let rawMap = {};
        try { rawMap = JSON.parse(typeEl.getAttribute('data-sz-raw-map') || '{}'); } catch (e) { /* ignore */ }
        const compensationType = rawMap[selectedKey];
        const item = {
          _key: newKey(),
          _type: 'deliveryPrice',
          basketPriceTo: to,
          compensation: { _type: 'compensation', compensationType, compensationValue: value }
        };
        if (deliveryProduct) item.deliveryProduct = deliveryProduct;
        result.push(item);
      } else {
        const price = parseFloat(row.querySelector('[data-sz-grad-price]')?.value);
        if (!isNaN(price)) {
          const item = { _key: newKey(), _type: 'deliveryPrice', basketPriceTo: to, price };
          if (deliveryProduct) item.deliveryProduct = deliveryProduct;
          result.push(item);
        }
      }
    }
    return result;
  }

  // Проверяет перед применением, что для каждой платной (!= 0) цены — что цены по
  // умолчанию, что ступени градации — выбрано блюдо из каталога ("Позиция для
  // доставки из POS-системы"). Sanity требует это для платной доставки, поэтому
  // блокируем применение целиком, если что-то пропущено, вместо того чтобы уйти
  // в Studio с ошибкой валидации уже после отправки.
  function collectMissingProductWarnings(modal, allTypeNames) {
    const missing = [];
    for (const typeName of allTypeNames) {
      const section = modal.querySelector(`[data-sz-section="${typeName}"]`);
      if (!section) continue;
      const dynamicCalc    = section.getAttribute('data-sz-dynamic-calc') === '1';
      const priceFieldName = section.getAttribute('data-sz-price-field') || 'defaultDeliveryPrice';

      const priceIncludeCb = section.querySelector(`[data-sz-include="${priceFieldName}"]`);
      if (priceIncludeCb?.checked) {
        const val = parseFloat(section.querySelector(`[data-sz-field="${priceFieldName}"]`)?.value);
        const ref = section.querySelector('[data-sz-default-product-picker]')?.dataset.productRef || '';
        if (!isNaN(val) && val > 0 && !ref) {
          missing.push(`${typeName} — «Цена по умолчанию» ${val}₽: не выбрано блюдо из каталога`);
        }
      }

      const includeGrad = section.querySelector('[data-sz-include-grad]')?.checked === true;
      if (includeGrad) {
        const rows = section.querySelectorAll('[data-sz-grad-table] > div');
        for (const row of rows) {
          const to = parseFloat(row.querySelector('[data-sz-grad-to]')?.value);
          if (isNaN(to)) continue;
          const val = dynamicCalc
            ? parseFloat(row.querySelector('[data-sz-grad-comp-value]')?.value)
            : parseFloat(row.querySelector('[data-sz-grad-price]')?.value);
          const ref = row.querySelector('[data-sz-grad-product-picker]')?.dataset.productRef || '';
          if (!isNaN(val) && val > 0 && !ref) {
            missing.push(`${typeName} — ступень до ${to}₽ (значение ${val}): не выбрано блюдо из каталога`);
          }
        }
      }
    }
    return missing;
  }

  // Переиспользуемое дерево «ресторан → зоны» с поиском, разворачиванием и
  // чекбоксами — общий пикер целей/источника для всех вкладок хаба. Раньше
  // этот код жил только внутри массового применения условий; теперь на нём
  // держится выбор ресторана(ов) вообще везде, так как модалка больше не
  // привязана к уже открытой странице ресторана.
  // opts:
  //   preselected: { shopId: [zoneKey, ...] } — что отметить и раскрыть сразу после загрузки
  //   allowSelectAllGlobal: показывать ли опасный чекбокс «применить ко всем зонам во всех ресторанах»
  //   shopLevelOnly: без уровня зон вообще — просто список ресторанов с чекбоксами;
  //     getSelection() тогда возвращает { shopId: true } (для операций, которые не
  //     затрагивают существующие зоны выборочно, например копирование — оно всегда
  //     добавляет новые зоны в ресторан целиком, выбор конкретных зон там бессмыслен)
  //   showDeliveryTypes: рисовать под зоной (если способов получения больше одного)
  //     чекбоксы по каждому способу получения; getSelection() тогда возвращает
  //     { shopId: { zoneKey: null | [dtpKey, ...] } } вместо плоского { shopId: [zoneKey, ...] }
  //   singleSelect: зоны — радиокнопки с общим именем на всё дерево (сразу
  //     во всех ресторанах), можно отметить не больше одной зоны за раз, без
  //     чекбокса «выбрать все зоны ресторана» (для источника значений в
  //     «Условиях» — там из нескольких отмеченных зон реально читалась бы
  //     только первая, что вводило в заблуждение; см. обсуждение)
  //   onChange: вызывается при любом изменении выбора
  function buildShopZoneTree(projectId, opts) {
    opts = opts || {};
    const wrap = document.createElement('div');
    wrap.setAttribute('data-sz-shop-tree', '1');
    const radioGroupName = 'sz-tree-radio-' + Math.random().toString(36).slice(2);

    let selectAllGlobalCb = null;
    if (opts.allowSelectAllGlobal) {
      const globalWrap = document.createElement('label');
      globalWrap.style.cssText = 'display:flex;align-items:center;gap:10px;font-size:14px;color:var(--smt-warning-text);cursor:pointer;font-weight:600;background:var(--smt-warning-bg);border:1px solid var(--smt-warning-border);border-radius:6px;padding:8px 12px;margin-bottom:12px;';
      globalWrap.innerHTML = '<input type="checkbox" data-sz-select-all-global style="width:17px;height:17px;accent-color:#e67e22;cursor:pointer;"> 🌍 Применить ко всем зонам во всех ресторанах (кроме архивных)';
      wrap.appendChild(globalWrap);
      selectAllGlobalCb = globalWrap.querySelector('[data-sz-select-all-global]');
    }

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'sz-flat-btn';
    loadBtn.textContent = '🔄 Загрузить список ресторанов и зон';
    loadBtn.style.cssText = 'padding:10px 14px;width:auto;height:auto;font-size:13px;font-weight:600;border-color:var(--smt-accent);color:var(--smt-accent);';
    wrap.appendChild(loadBtn);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:13px;color:var(--smt-text-tertiary);margin-top:8px;';
    hint.textContent = opts.hint || 'У каждого ресторана могут быть зоны с разными названиями — раскройте ресторан (клик по стрелке ▸) и отметьте галочками нужные зоны. Рестораны без зон показаны в конце списка.';
    wrap.appendChild(hint);

    const container = document.createElement('div');
    container.style.cssText = 'display:none; margin-top:12px;';
    wrap.appendChild(container);

    let lastLoadedShops = null;

    function renderTree(shops) {
      container.innerHTML = '';
      if (shops.length === 0) {
        container.innerHTML = '<div style="color:var(--smt-text-tertiary);">Рестораны не найдены</div>';
        return;
      }
      const searchBox = document.createElement('input');
      searchBox.type = 'text';
      searchBox.placeholder = 'Поиск по названию ресторана...';
      searchBox.style.cssText = 'width:100%; padding:8px; margin-bottom:10px; border:1px solid var(--smt-border); border-radius:6px; box-sizing:border-box; font-family:inherit; background:var(--smt-bg-panel); color:var(--smt-text-primary);';
      container.appendChild(searchBox);

      // Без уровня зон разворачивать нечего — ссылки в этом режиме были бы
      // рабочими, но бессмысленными (нечего показывать), поэтому не рисуем.
      let globalActions = null;
      if (!opts.shopLevelOnly) {
        globalActions = document.createElement('div');
        globalActions.style.cssText = 'display:flex; gap:14px; margin-bottom:8px; font-size:13px;';
        globalActions.innerHTML = `
          <a href="#" data-sz-expand-all style="color:var(--smt-accent); text-decoration:none;">Развернуть все</a>
          <a href="#" data-sz-collapse-all style="color:var(--smt-accent); text-decoration:none;">Свернуть все</a>
        `;
        container.appendChild(globalActions);
      }

      const shopsList = document.createElement('div');
      shopsList.className = 'smt-shop-tree';

      for (const shop of shops) {
        const zones = shop.zones || [];
        const preselectedKeys = (opts.preselected && opts.preselected[shop._id]) || [];
        const shopDetails = document.createElement('details');
        shopDetails.className = 'smt-shop-block';
        shopDetails.setAttribute('data-sz-shop-block', shop._id);
        shopDetails.dataset.shopName = (shop.name?.ru || '').toLowerCase();
        if (preselectedKeys.length > 0 || shop._id === opts.autoExpandShopId) shopDetails.open = true;

        const summary = document.createElement('summary');

        const isExpandable = !opts.shopLevelOnly && zones.length > 0;
        const chevron = document.createElement('span');
        chevron.textContent = isExpandable ? '▸' : '';
        chevron.title = isExpandable ? 'Развернуть/свернуть зоны' : '';
        chevron.style.cssText = 'display:inline-flex; align-items:center; justify-content:center; width:18px; flex-shrink:0; color:var(--smt-text-secondary); font-size:18px; font-weight:700; transition:transform 0.15s ease;' + (shopDetails.open ? ' transform:rotate(90deg);' : '');

        // При singleSelect чекбокса «выбрать все зоны ресторана» нет вообще —
        // он бы позволял отметить сразу несколько зон одного ресторана, а
        // singleSelect как раз про то, что во всём дереве может быть отмечена
        // только одна зона (см. комментарий у opts выше).
        let shopAllCb = null;
        if (!opts.singleSelect) {
          shopAllCb = document.createElement('input');
          shopAllCb.type = 'checkbox';
          shopAllCb.setAttribute('data-sz-shop-all', shop._id);
          shopAllCb.style.cssText = 'width:16px;height:16px;cursor:pointer;flex-shrink:0;accent-color:var(--smt-accent);';
          if (opts.shopLevelOnly) {
            // Нет уровня зон вообще — выбор всегда «ресторан целиком» (копирование
            // добавляет новые зоны, а не трогает существующие, поэтому неважно,
            // сколько зон уже есть — хоть ноль).
            shopAllCb.setAttribute('data-sz-shop-select', shop._id);
            shopAllCb.disabled = false;
            shopAllCb.addEventListener('change', () => { if (opts.onChange) opts.onChange(); });
          } else {
            shopAllCb.disabled = zones.length === 0;
          }
          shopAllCb.addEventListener('click', e => e.stopPropagation());
        }

        const labelSpan = document.createElement('span');
        const addressStr = `${shop.address?.street?.ru || ''} ${shop.address?.house?.ru || ''}`.trim();
        labelSpan.textContent = `${shop.name?.ru || shop._id}${addressStr ? ' (' + addressStr + ')' : ''} — ${zones.length} ${zones.length === 1 ? 'зона' : 'зон'}`;
        labelSpan.style.cssText = (zones.length === 0 && !opts.shopLevelOnly) ? 'color:var(--smt-text-tertiary);' : '';

        summary.appendChild(chevron);
        if (shopAllCb) summary.appendChild(shopAllCb);
        summary.appendChild(labelSpan);
        shopDetails.appendChild(summary);

        if (isExpandable) {
          shopDetails.addEventListener('toggle', () => {
            chevron.style.transform = shopDetails.open ? 'rotate(90deg)' : 'rotate(0deg)';
          });
          const zonesWrap = document.createElement('div');
          zonesWrap.style.cssText = 'margin-top:8px; padding-left:26px; display:flex; flex-direction:column; gap:5px;';

          for (const zone of zones) {
            // Третий уровень — способы получения внутри зоны (у каждого свой
            // paymentTypes, поэтому «Способы оплаты» должна уметь целиться не
            // только в зону целиком, но и в конкретный способ получения).
            // Нужен только там, где явно запрошен (opts.showDeliveryTypes).
            // Показываем список всегда, если он не пуст (даже один способ) —
            // иначе непонятно, есть там вообще способы получения или нет —
            // но сворачиваем в <details>, чтобы не раздувать список зон,
            // когда способ всего один и сужать выбор обычно незачем.
            const types = zone.types || [];
            const zoneIsPreselected = preselectedKeys.includes(zone._key);

            if (opts.showDeliveryTypes && types.length > 0) {
              const zoneDetails = document.createElement('details');
              zoneDetails.style.cssText = 'margin-bottom:2px;';
              zoneDetails.open = zoneIsPreselected;

              const zSummary = document.createElement('summary');
              zSummary.style.cssText = 'display:flex; align-items:center; gap:6px; cursor:pointer; list-style:none;';

              const zChevron = document.createElement('span');
              zChevron.textContent = '▸';
              zChevron.title = 'Показать способы получения в этой зоне';
              zChevron.style.cssText = 'display:inline-flex; align-items:center; justify-content:center; width:14px; flex-shrink:0; color:var(--smt-text-tertiary); font-size:14px; font-weight:700; transition:transform 0.15s ease;' + (zoneDetails.open ? ' transform:rotate(90deg);' : '');

              const zCb = document.createElement('input');
              zCb.type = 'checkbox';
              zCb.setAttribute('data-sz-shop-id', shop._id);
              zCb.setAttribute('data-sz-zone-key', zone._key);
              zCb.checked = zoneIsPreselected;
              zCb.style.cssText = 'width:15px;height:15px;cursor:pointer;flex-shrink:0;accent-color:var(--smt-accent);';
              zCb.addEventListener('click', e => e.stopPropagation());

              const zSpan = document.createElement('span');
              zSpan.style.cssText = 'font-size:14px; color:var(--smt-text-primary);';
              zSpan.textContent = zone.name || '(без названия)';

              zSummary.appendChild(zChevron);
              zSummary.appendChild(zCb);
              zSummary.appendChild(zSpan);
              zoneDetails.appendChild(zSummary);
              zoneDetails.addEventListener('toggle', () => {
                zChevron.style.transform = zoneDetails.open ? 'rotate(90deg)' : 'rotate(0deg)';
              });

              const typesWrap = document.createElement('div');
              typesWrap.style.cssText = 'margin-top:4px; margin-bottom:4px; padding-left:22px; display:flex; flex-direction:column; gap:3px;';
              for (const t of types) {
                const tLabel = document.createElement('label');
                tLabel.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:13px; color:var(--smt-text-secondary); cursor:pointer;';
                const tCb = document.createElement('input');
                tCb.type = 'checkbox';
                tCb.checked = zCb.checked;
                tCb.setAttribute('data-sz-shop-id', shop._id);
                tCb.setAttribute('data-sz-for-zone-key', zone._key);
                tCb.setAttribute('data-sz-type-key', t._key);
                tCb.style.cssText = 'width:13px;height:13px;cursor:pointer;flex-shrink:0;accent-color:var(--smt-accent);';
                const tSpan = document.createElement('span');
                tSpan.textContent = t.name || '(без названия)';
                tLabel.appendChild(tCb);
                tLabel.appendChild(tSpan);
                typesWrap.appendChild(tLabel);
              }
              zoneDetails.appendChild(typesWrap);
              zonesWrap.appendChild(zoneDetails);

              // Каскад зона ↔ её способы получения — тот же паттерн, что
              // ресторан ↔ зоны выше, на один уровень глубже.
              zCb.addEventListener('change', () => {
                typesWrap.querySelectorAll('input[data-sz-type-key]').forEach(cb => { cb.checked = zCb.checked; });
              });
              typesWrap.addEventListener('change', () => {
                const allTypes     = typesWrap.querySelectorAll('input[data-sz-type-key]');
                const checkedTypes = typesWrap.querySelectorAll('input[data-sz-type-key]:checked');
                zCb.checked       = checkedTypes.length > 0;
                zCb.indeterminate = checkedTypes.length > 0 && checkedTypes.length < allTypes.length;
              });
            } else {
              const zLabel = document.createElement('label');
              zLabel.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:14px; color:var(--smt-text-primary); cursor:pointer;';
              const zCb = document.createElement('input');
              zCb.type = opts.singleSelect ? 'radio' : 'checkbox';
              if (opts.singleSelect) zCb.name = radioGroupName;
              zCb.setAttribute('data-sz-shop-id', shop._id);
              zCb.setAttribute('data-sz-zone-key', zone._key);
              zCb.checked = zoneIsPreselected;
              zCb.style.cssText = 'width:15px;height:15px;cursor:pointer;flex-shrink:0;accent-color:var(--smt-accent);';
              if (opts.singleSelect) zCb.addEventListener('change', () => { if (opts.onChange) opts.onChange(); });
              const zSpan = document.createElement('span');
              zSpan.textContent = zone.name || '(без названия)';
              zLabel.appendChild(zCb);
              zLabel.appendChild(zSpan);
              zonesWrap.appendChild(zLabel);
            }
          }

          if (shopAllCb) {
            shopAllCb.addEventListener('change', () => {
              // Прямое присваивание .checked не триггерит 'change' у самих зон,
              // поэтому каскад зона→способы получения (см. выше) сам не сработает —
              // синхронизируем оба уровня явно здесь же.
              zonesWrap.querySelectorAll('input[data-sz-zone-key]').forEach(cb => { cb.checked = shopAllCb.checked; cb.indeterminate = false; });
              zonesWrap.querySelectorAll('input[data-sz-type-key]').forEach(cb => { cb.checked = shopAllCb.checked; });
              if (opts.onChange) opts.onChange();
            });
            zonesWrap.addEventListener('change', () => {
              const all     = zonesWrap.querySelectorAll('input[data-sz-zone-key]');
              const checked = zonesWrap.querySelectorAll('input[data-sz-zone-key]:checked');
              shopAllCb.checked       = all.length > 0 && checked.length === all.length;
              shopAllCb.indeterminate = checked.length > 0 && checked.length < all.length;
              if (opts.onChange) opts.onChange();
            });
            zonesWrap.dispatchEvent(new Event('change'));
          }

          shopDetails.appendChild(zonesWrap);
        }

        shopsList.appendChild(shopDetails);
      }

      container.appendChild(shopsList);

      searchBox.addEventListener('input', () => {
        const term = searchBox.value.toLowerCase();
        shopsList.querySelectorAll('details[data-sz-shop-block]').forEach(d => {
          d.style.display = (d.dataset.shopName || '').includes(term) ? '' : 'none';
        });
      });
      if (globalActions) {
        globalActions.querySelector('[data-sz-expand-all]').addEventListener('click', e => {
          e.preventDefault();
          shopsList.querySelectorAll('details[data-sz-shop-block]').forEach(d => { d.open = true; });
        });
        globalActions.querySelector('[data-sz-collapse-all]').addEventListener('click', e => {
          e.preventDefault();
          shopsList.querySelectorAll('details[data-sz-shop-block]').forEach(d => { d.open = false; });
        });
      }
    }

    async function load() {
      loadBtn.textContent = '⏳ Загрузка...';
      loadBtn.disabled = true;
      try {
        const shops = await fetchAllShops(projectId);
        shops.sort((a, b) => {
          const aEmpty = (a.zones || []).length === 0;
          const bEmpty = (b.zones || []).length === 0;
          if (aEmpty === bEmpty) return 0;
          return aEmpty ? 1 : -1;
        });
        lastLoadedShops = shops;
        renderTree(shops);
        container.style.display = 'block';
        if (selectAllGlobalCb?.checked) {
          container.style.opacity = '0.4';
          container.style.pointerEvents = 'none';
        }
      } catch (e) {
        showToast('Ошибка загрузки списка: ' + e.message, 'error');
      } finally {
        loadBtn.textContent = '🔄 Обновить список ресторанов и зон';
        loadBtn.disabled = false;
      }
    }

    if (selectAllGlobalCb) {
      selectAllGlobalCb.addEventListener('change', () => {
        if (selectAllGlobalCb.checked) {
          if (!lastLoadedShops) load();
          container.style.opacity = '0.4';
          container.style.pointerEvents = 'none';
        } else {
          container.style.opacity = '1';
          container.style.pointerEvents = 'auto';
        }
        if (opts.onChange) opts.onChange();
      });
    }

    // Без opts.showDeliveryTypes возвращает { shopId: [zoneKey, ...] } — как
    // раньше, для вкладок «Условия» и «Копирование зон», которым способы
    // получения ни к чему. С opts.showDeliveryTypes (вкладка «Способы оплаты»)
    // возвращает { shopId: { zoneKey: null | [dtpKey, ...] } }, где null —
    // «вся зона целиком» (способы получения не сужены, либо их там всего
    // один, либо это выбор-всё через глобальный чекбокс), а массив —
    // «только эти способы получения внутри зоны».
    function getSelection() {
      if (selectAllGlobalCb?.checked) {
        const map = {};
        for (const shop of (lastLoadedShops || [])) {
          const zones = shop.zones || [];
          if (zones.length === 0) continue;
          if (opts.showDeliveryTypes) {
            map[shop._id] = {};
            for (const z of zones) map[shop._id][z._key] = null;
          } else {
            map[shop._id] = zones.map(z => z._key);
          }
        }
        return map;
      }

      if (opts.shopLevelOnly) {
        const map = {};
        container.querySelectorAll('input[data-sz-shop-select]:checked').forEach(cb => {
          map[cb.getAttribute('data-sz-shop-select')] = true;
        });
        return map;
      }

      if (!opts.showDeliveryTypes) {
        const map = {};
        container.querySelectorAll('input[data-sz-zone-key]:checked').forEach(cb => {
          const shopId  = cb.getAttribute('data-sz-shop-id');
          const zoneKey = cb.getAttribute('data-sz-zone-key');
          (map[shopId] ||= []).push(zoneKey);
        });
        return map;
      }

      const map = {};
      container.querySelectorAll('input[data-sz-zone-key]:checked').forEach(cb => {
        const shopId  = cb.getAttribute('data-sz-shop-id');
        const zoneKey = cb.getAttribute('data-sz-zone-key');
        const typeCbs = container.querySelectorAll(
          `input[data-sz-for-zone-key="${CSS.escape(zoneKey)}"][data-sz-shop-id="${CSS.escape(shopId)}"]`
        );
        let typeSelection = null;
        if (typeCbs.length > 0) {
          const checkedTypes = Array.from(typeCbs).filter(t => t.checked).map(t => t.getAttribute('data-sz-type-key'));
          typeSelection = checkedTypes.length < typeCbs.length ? checkedTypes : null;
        }
        (map[shopId] ||= {})[zoneKey] = typeSelection;
      });
      return map;
    }

    loadBtn.addEventListener('click', load);

    return { el: wrap, load, getSelection, getShopsData: () => lastLoadedShops || [] };
  }

  function buildDeliveryTypeSection(label, dtpData, isCollapsed, projectId, mealNameMap) {
    const section = document.createElement('div');
    section.style.cssText = 'margin-top:10px;';
    const dynamicCalc  = dtpData?.dynamicCalc === true;
    const timeFieldName = dynamicCalc ? 'dynamicDeliveryTime' : 'deliveryTime';
    const priceFieldName = dynamicCalc ? 'defaultDynamicDeliveryPrice' : 'defaultDeliveryPrice';
    const existingTime = dtpData?.[timeFieldName]  ?? '';
    const existingMin  = dtpData?.minBasketPrice ?? '';
    const existingDef  = dtpData?.[priceFieldName] ?? '';
    const existingGrad = dtpData?.deliveryPrice || [];

    const content = document.createElement('div');
    content.setAttribute('data-sz-section', label);
    content.setAttribute('data-sz-dynamic-calc', dynamicCalc ? '1' : '0');
    content.setAttribute('data-sz-price-field', priceFieldName);
    content.style.cssText = 'padding:16px;background:var(--smt-bg-subtle);border-radius:8px;border:1px solid var(--smt-border);';
    content.innerHTML = `
      <label style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:var(--smt-accent-soft-text);cursor:pointer;background:var(--smt-accent-soft-bg);border:1px solid var(--smt-accent-soft-border);border-radius:6px;padding:8px 12px;margin-bottom:14px;">
        <input type="checkbox" data-sz-select-all-fields style="width:16px;height:16px;cursor:pointer;accent-color:var(--smt-accent);">
        <span>Выбрать все условия этого типа доставки</span>
      </label>
      <div style="font-size:13px;color:var(--smt-text-tertiary);margin-bottom:10px;">
        Отметьте галочкой только те условия, которые нужно скопировать/применить. Невыбранные условия останутся в каждой зоне как есть.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:14px;">
        <label style="font-size:14px;color:var(--smt-text-secondary);">
          <span style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">
            <input type="checkbox" data-sz-include="${timeFieldName}" style="width:15px;height:15px;cursor:pointer;accent-color:var(--smt-accent);">
            ${dynamicCalc ? 'Время динамической доставки (мин)' : 'Время доставки (мин)'}
          </span>
          <input type="number" placeholder="значение" value="${existingTime}"
            style="display:block;width:100%;padding:9px 10px;border:1px solid var(--smt-border);border-radius:6px;font-size:16px;box-sizing:border-box;font-family:inherit;background:var(--smt-bg-panel);color:var(--smt-text-primary);"
            data-sz-field="${timeFieldName}">
        </label>
        <label style="font-size:14px;color:var(--smt-text-secondary);">
          <span style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">
            <input type="checkbox" data-sz-include="minBasketPrice" style="width:15px;height:15px;cursor:pointer;accent-color:var(--smt-accent);">
            Мин. сумма корзины
          </span>
          <input type="number" placeholder="значение" value="${existingMin}"
            style="display:block;width:100%;padding:9px 10px;border:1px solid var(--smt-border);border-radius:6px;font-size:16px;box-sizing:border-box;font-family:inherit;background:var(--smt-bg-panel);color:var(--smt-text-primary);"
            data-sz-field="minBasketPrice">
        </label>
        <label style="font-size:14px;color:var(--smt-text-secondary);">
          <span style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">
            <input type="checkbox" data-sz-include="${priceFieldName}" style="width:15px;height:15px;cursor:pointer;accent-color:var(--smt-accent);">
            ${dynamicCalc ? 'Цена динамической доставки по умолчанию' : 'Цена по умолчанию'}
          </span>
          <input type="number" placeholder="значение" value="${existingDef}"
            style="display:block;width:100%;padding:9px 10px;border:1px solid var(--smt-border);border-radius:6px;font-size:16px;box-sizing:border-box;font-family:inherit;background:var(--smt-bg-panel);color:var(--smt-text-primary);"
            data-sz-field="${priceFieldName}">
        </label>
      </div>
      ${dynamicCalc ? `
      <div style="font-size:13px;color:#8e44ad;background:#f4ecfb;border:1px solid #e3d3f5;border-radius:6px;padding:8px 12px;margin-bottom:12px;">
        ⚡ Активирован динамический расчёт — ступени градации задаются компенсацией (тип и значение), а не фиксированной ценой.
      </div>` : ''}
      <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--smt-text-secondary);margin-bottom:8px;cursor:pointer;">
        <input type="checkbox" data-sz-include-grad style="width:15px;height:15px;cursor:pointer;accent-color:var(--smt-accent);">
        <span>Градация цен <span style="color:var(--smt-text-tertiary);">(пустая таблица при включённой галочке = очистить градацию)</span></span>
      </label>
    `;

    const priceInputEl = content.querySelector(`[data-sz-field="${priceFieldName}"]`);
    const priceLabelEl = priceInputEl?.closest('label');
    if (priceLabelEl) {
      const defaultProductRef   = dtpData?.deliveryProduct?._ref || '';
      const defaultProductTitle = defaultProductRef ? (mealNameMap?.[defaultProductRef] || defaultProductRef) : '';
      const defaultProductPicker = buildProductPicker(projectId, { currentRef: defaultProductRef, currentTitle: defaultProductTitle });
      defaultProductPicker.setAttribute('data-sz-default-product-picker', '1');
      priceLabelEl.appendChild(defaultProductPicker);
    }

    const gradWrap = document.createElement('div');
    gradWrap.setAttribute('data-sz-grad-wrap', '1');
    gradWrap.appendChild(buildGradationEditor(existingGrad, dynamicCalc, dtpData?.compensation?.compensationType, projectId, mealNameMap));
    content.appendChild(gradWrap);

    content.appendChild(buildPaymentTypesEditor(dtpData?.paymentTypes));

    const selectAllFieldsCb = content.querySelector('[data-sz-select-all-fields]');
    selectAllFieldsCb.addEventListener('change', () => {
      content.querySelectorAll('[data-sz-include], [data-sz-include-grad], [data-sz-include-payment]').forEach(cb => {
        cb.checked = selectAllFieldsCb.checked;
      });
    });

    if (isCollapsed) {
      const details = document.createElement('details');
      details.style.cssText = 'margin-top:14px;';
      const summary = document.createElement('summary');
      summary.style.cssText = 'cursor:pointer;font-size:16px;font-weight:600;color:var(--smt-text-secondary);user-select:none;padding:4px 0;';
      summary.textContent = label;
      details.appendChild(summary);
      details.appendChild(content);
      section.appendChild(details);
    } else {
      const titleEl = document.createElement('div');
      titleEl.style.cssText = 'font-size:16px;font-weight:700;color:var(--smt-text-primary);margin-bottom:8px;';
      titleEl.textContent = label;
      section.appendChild(titleEl);
      section.appendChild(content);
    }
    return section;
  }

  // Собирает { changes, typeMeta } из отрисованных секций buildDeliveryTypeSection
  // внутри container — то же самое, что раньше делалось инлайново в начале
  // applyConditions, вынесено отдельно, чтобы использовать и до открытия
  // подтверждения (для проверки "нет изменений"), и в самом применении.
  function collectConditionChanges(container, allTypeNames) {
    const changes  = {};
    const typeMeta = {};
    for (const typeName of allTypeNames) {
      const section = container.querySelector(`[data-sz-section="${typeName}"]`);
      if (!section) continue;
      const dynamicCalc    = section.getAttribute('data-sz-dynamic-calc') === '1';
      const priceFieldName = section.getAttribute('data-sz-price-field') || 'defaultDeliveryPrice';
      typeMeta[typeName] = { dynamicCalc, priceFieldName };

      const entry = {};
      section.querySelectorAll('[data-sz-field]').forEach(input => {
        const fieldName = input.getAttribute('data-sz-field');
        const includeCb = section.querySelector(`[data-sz-include="${fieldName}"]`);
        if (!includeCb?.checked) return;
        const val = input.value.trim();
        entry[fieldName] = val === '' ? undefined : parseFloat(val);
      });
      for (const key of Object.keys(entry)) {
        if (entry[key] === undefined || isNaN(entry[key])) delete entry[key];
      }

      const priceIncludeCb = section.querySelector(`[data-sz-include="${priceFieldName}"]`);
      if (priceIncludeCb?.checked) {
        const productRef = section.querySelector('[data-sz-default-product-picker]')?.dataset.productRef || '';
        entry.deliveryProduct = productRef ? { _type: 'reference', _weak: true, _ref: productRef } : null;
      }

      const includeGrad = section.querySelector('[data-sz-include-grad]')?.checked === true;
      if (includeGrad) {
        const gradWrap = section.querySelector('[data-sz-grad-wrap]');
        if (gradWrap) entry.deliveryPrice = readGradation(gradWrap, dynamicCalc);
      }

      const includePayment = section.querySelector('[data-sz-include-payment]')?.checked === true;
      if (includePayment) {
        const paymentTypes = readPaymentTypes(section);
        if (paymentTypes) entry.paymentTypes = paymentTypes;
      }

      if (Object.keys(entry).length > 0) changes[typeName] = entry;
    }
    return { changes, typeMeta };
  }

  // Общий низ модалки для всех трёх вкладок хаба: бэкап/публикация/предполётная
  // проверка + баннер риска, который сам показывается, когда выбрано больше
  // одного ресторана (opts.getShopCount) — раньше это был отдельный чекбокс
  // «применить к нескольким ресторанам», теперь риск считается по факту выбора
  // в дереве, а не по галочке, которую легко забыть поставить/снять.
  function buildApplyOptionsFooter(opts) {
    const wrap = document.createElement('div');

    const dangerBanner = document.createElement('div');
    dangerBanner.style.cssText = 'margin-top:14px; padding:12px 16px; background:#fef2f2; border:2px solid #f3b6b6; border-radius:8px; font-size:13px; color:#a13a34; display:none;';
    dangerBanner.innerHTML = '⚠️ <b>Выбрано несколько ресторанов — будь внимателен!</b><br>Эту операцию не откатить одним кликом — восстановление из бэкапа придётся делать вручную. Дважды проверьте выбор перед тем, как жать «Применить».';
    wrap.appendChild(dangerBanner);

    const backupWrap = document.createElement('label');
    backupWrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;color:var(--smt-text-secondary);margin-top:14px;cursor:pointer;';
    backupWrap.innerHTML = `
      <input type="checkbox" checked style="width:16px;height:16px;cursor:pointer;accent-color:var(--smt-accent);" data-sz-backup-before>
      <span>Скачать бэкап зон в JSON перед применением <span style="color:var(--smt-text-tertiary);">(снимок состояния затронутых зон до изменений — пригодится для отката вручную)</span></span>
    `;
    wrap.appendChild(backupWrap);

    const publishWrap = document.createElement('label');
    publishWrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;color:var(--smt-text-secondary);margin-top:14px;cursor:pointer;';
    publishWrap.innerHTML = `
      <input type="checkbox" style="width:16px;height:16px;cursor:pointer;accent-color:var(--smt-accent);" data-sz-auto-publish>
      <span>Опубликовать сразу после применения <span style="color:var(--smt-text-tertiary);">(иначе изменения останутся черновиком. Скрипт запоминает свои же правки — если черновик с прошлого раза никто, кроме скрипта, не трогал, публикация пройдёт автоматически; если в нём есть посторонние изменения — она пропускается)</span></span>
    `;
    wrap.appendChild(publishWrap);

    const forcePublishWrap = document.createElement('label');
    forcePublishWrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;color:#a15c00;margin-top:8px;margin-left:26px;cursor:pointer;';
    forcePublishWrap.innerHTML = `
      <input type="checkbox" style="width:15px;height:15px;cursor:pointer;" data-sz-force-publish>
      <span>🔓 Разрешить публикацию, даже если в ресторане есть посторонние неопубликованные изменения <span style="color:#c98a3a;">(они тоже уйдут в публикацию вместе с вашими — используйте, только если уверены, что ничего чужого не потеряется)</span></span>
    `;
    wrap.appendChild(forcePublishWrap);

    const preflightWrap = document.createElement('label');
    preflightWrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;color:var(--smt-text-secondary);margin-top:8px;margin-left:26px;cursor:pointer;';
    preflightWrap.innerHTML = `
      <input type="checkbox" checked style="width:15px;height:15px;cursor:pointer;accent-color:var(--smt-accent);" data-sz-preflight-validation>
      <span>🛡️ Перед публикацией проверить валидацию во всех выбранных ресторанах <span style="color:var(--smt-text-tertiary);">(медленнее — скрипт по очереди открывает каждый ресторан, ~1–2 сек на ресторан. Если хотя бы у одного не заполнены обязательные поля — публикация блокируется целиком)</span></span>
    `;
    wrap.appendChild(preflightWrap);

    const reloadWrap = document.createElement('label');
    reloadWrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;color:var(--smt-text-secondary);margin-top:14px;cursor:pointer;';
    reloadWrap.innerHTML = `
      <input type="checkbox" style="width:16px;height:16px;cursor:pointer;accent-color:var(--smt-accent);" data-sz-reload-after>
      <span>Обновить страницу после применения <span style="color:var(--smt-text-tertiary);">(список «Все заведения» иногда не пересчитывает порядок сам)</span></span>
    `;
    wrap.appendChild(reloadWrap);

    const applyBtn = document.createElement('button');
    applyBtn.textContent = opts.applyLabel || '✅ Применить';
    applyBtn.style.cssText = `
      margin-top:14px;width:100%;padding:15px;
      background:var(--smt-accent);color:#fff;border:none;border-radius:8px;
      font-size:16px;font-weight:700;cursor:pointer;
    `;
    applyBtn.addEventListener('mouseenter', () => { applyBtn.style.background = 'var(--smt-accent-hover)'; });
    applyBtn.addEventListener('mouseleave', () => { applyBtn.style.background = 'var(--smt-accent)'; });
    wrap.appendChild(applyBtn);

    const backupBeforeCb        = backupWrap.querySelector('[data-sz-backup-before]');
    const autoPublishCb         = publishWrap.querySelector('[data-sz-auto-publish]');
    const forcePublishCb        = forcePublishWrap.querySelector('[data-sz-force-publish]');
    const preflightValidationCb = preflightWrap.querySelector('[data-sz-preflight-validation]');
    const reloadAfterCb         = reloadWrap.querySelector('[data-sz-reload-after]');

    function syncDangerBanner() {
      const count = opts.getShopCount ? opts.getShopCount() : 0;
      dangerBanner.style.display = count > 1 ? 'block' : 'none';
    }

    applyBtn.addEventListener('click', () => {
      const shopCount = opts.getShopCount ? opts.getShopCount() : 0;
      if (shopCount === 0) {
        showToast('Ничего не выбрано — отметьте хотя бы одну зону в списке', 'warning');
        return;
      }
      if (opts.beforeApply && opts.beforeApply() === false) return;
      const state = {
        autoPublish: autoPublishCb.checked,
        forcePublish: forcePublishCb.checked,
        reloadAfter: reloadAfterCb.checked,
        backupBefore: backupBeforeCb.checked,
        preflightValidation: preflightValidationCb.checked
      };
      const proceed = () => opts.onApply(state);
      if (shopCount > 1) {
        showMassApplyConfirm(shopCount, proceed);
      } else {
        proceed();
      }
    });

    return { el: wrap, syncDangerBanner };
  }

  // Вкладка «Условия»: подставить текущие значения полей из зоны(зон)
  // ресторана-источника, отредактировать, применить к выбранным зонам —
  // в одном ресторане или сразу в нескольких (риск-баннер сам появляется,
  // когда выбрано больше одного).
  function buildConditionsTab(projectId, initialShopId, overlay) {
    const el = document.createElement('div');

    const sourceHeading = document.createElement('div');
    sourceHeading.style.cssText = 'font-size:14px;font-weight:600;color:var(--smt-text-primary);margin-bottom:6px;';
    sourceHeading.textContent = 'Ресторан-источник (откуда взять текущие условия)';
    el.appendChild(sourceHeading);

    const sourceTree = buildShopZoneTree(projectId, {
      singleSelect: true,
      hint: 'Отметьте одну зону — её текущие условия подставятся в поля ниже (радиокнопка, а не чекбокс: у разных зон могут быть разные условия, поэтому источник всегда ровно один).',
      autoExpandShopId: initialShopId || undefined
    });
    el.appendChild(sourceTree.el);
    if (initialShopId) sourceTree.load();

    const loadSourceBtn = document.createElement('button');
    loadSourceBtn.type = 'button';
    loadSourceBtn.textContent = '⬇️ Подставить условия из отмеченной зоны';
    loadSourceBtn.style.cssText = 'margin-top:10px; padding:9px 14px; border:1px solid var(--smt-accent); background:var(--smt-accent); color:#fff; border-radius:6px; cursor:pointer; font-weight:600; font-size:13px;';
    el.appendChild(loadSourceBtn);

    const sectionsWrap = document.createElement('div');
    sectionsWrap.style.cssText = 'margin-top:20px;';
    sectionsWrap.innerHTML = '<div style="padding:16px;text-align:center;color:var(--smt-text-tertiary);font-size:14px;">Выберите зону-источник выше и нажмите «Подставить условия», чтобы увидеть поля для редактирования.</div>';
    el.appendChild(sectionsWrap);

    const targetHeading = document.createElement('div');
    targetHeading.style.cssText = 'font-size:14px;font-weight:600;color:var(--smt-text-primary);margin-top:22px;margin-bottom:6px;display:none;';
    targetHeading.textContent = 'Куда применить';
    el.appendChild(targetHeading);

    const targetTreeOpts = { allowSelectAllGlobal: true, onChange: () => footer.syncDangerBanner() };
    const targetTree = buildShopZoneTree(projectId, targetTreeOpts);
    targetTree.el.style.display = 'none';
    el.appendChild(targetTree.el);

    let currentSourceState = null; // { allTypeNames }

    loadSourceBtn.addEventListener('click', async () => {
      const selection = sourceTree.getSelection();
      const shopIds = Object.keys(selection);
      if (shopIds.length === 0) { showToast('Сначала отметьте зону-источник в дереве выше', 'warning'); return; }
      const sourceShopId = shopIds[0];
      const zoneKeys = selection[sourceShopId];
      loadSourceBtn.textContent = '⏳ Загрузка...';
      loadSourceBtn.disabled = true;
      try {
        const doc = await getDoc(projectId, sourceShopId);
        if (!doc) { showToast('Заведение-источник не найдено', 'error'); return; }
        const allRefs = new Set();
        for (const zone of (doc.deliveryZones || []))
          for (const dtp of (zone.deliveryTypePrices || []))
            if (dtp.deliveryType?._ref) allRefs.add(dtp.deliveryType._ref);
        const typeNameMap = await resolveDeliveryTypeNames(projectId, [...allRefs]);

        const sourceZones = (doc.deliveryZones || []).filter(z => zoneKeys.includes(z._key));
        if (sourceZones.length === 0) { showToast('Отмеченные зоны не найдены', 'error'); return; }

        const firstZone = sourceZones[0];
        const dtpByName = {};
        for (const dtp of (firstZone.deliveryTypePrices || [])) {
          const name = typeNameMap[dtp.deliveryType?._ref];
          if (name) dtpByName[name] = dtp;
        }

        const mealRefs = new Set();
        for (const dtp of Object.values(dtpByName)) {
          if (dtp.deliveryProduct?._ref) mealRefs.add(dtp.deliveryProduct._ref);
          for (const gradation of (dtp.deliveryPrice || [])) {
            if (gradation.deliveryProduct?._ref) mealRefs.add(gradation.deliveryProduct._ref);
          }
        }
        let mealNameMap = {};
        try { mealNameMap = await resolveMealNames(projectId, [...mealRefs]); }
        catch (e) { /* не критично — просто покажем id вместо названия блюда */ }

        const allTypeNames = [...new Set(Object.values(typeNameMap))].sort((a, b) => {
          if (a === 'Доставка') return -1;
          if (b === 'Доставка') return 1;
          return a.localeCompare(b, 'ru');
        });

        sectionsWrap.innerHTML = '';
        for (const typeName of allTypeNames) {
          sectionsWrap.appendChild(buildDeliveryTypeSection(typeName, dtpByName[typeName] || null, typeName !== 'Доставка', projectId, mealNameMap));
        }
        currentSourceState = { allTypeNames };

        targetHeading.style.display = 'block';
        targetTree.el.style.display = 'block';
        footer.el.style.display = 'block';
        // Цель по умолчанию = тот же ресторан и те же зоны, что источник — но
        // только при первой подстановке, чтобы не сбрасывать выбор пользователя,
        // если он уже донабрал другие рестораны в дереве целей вручную.
        if (targetTree.getShopsData().length === 0) {
          targetTreeOpts.preselected = { [sourceShopId]: zoneKeys };
          targetTree.load().then(() => footer.syncDangerBanner());
        }
        showToast(`Условия подставлены из «${doc.name?.ru || sourceShopId}», зоны: ${sourceZones.map(z => z.name).join(', ')}`, 'success', 4000);
      } catch (e) {
        showToast('Ошибка загрузки: ' + e.message, 'error');
      } finally {
        loadSourceBtn.textContent = '⬇️ Подставить условия из отмеченной зоны';
        loadSourceBtn.disabled = false;
      }
    });

    const footer = buildApplyOptionsFooter({
      applyLabel: '✅ Применить условия',
      getShopCount: () => Object.keys(targetTree.getSelection()).length,
      beforeApply: () => {
        if (!currentSourceState) { showToast('Сначала подставьте условия из ресторана-источника', 'warning'); return false; }
        const missingProducts = collectMissingProductWarnings(sectionsWrap, currentSourceState.allTypeNames);
        if (missingProducts.length > 0) {
          showToast(
            '⛔ Нельзя применить — для платной доставки обязательно нужно указать блюдо из каталога:\n' +
            missingProducts.map(w => `• ${w}`).join('\n') +
            '\n\nОткройте 🔍 у соответствующего поля и выберите блюдо.',
            'error', 15000
          );
          return false;
        }
        return true;
      },
      onApply: (state) => {
        const { changes, typeMeta } = collectConditionChanges(sectionsWrap, currentSourceState.allTypeNames);
        if (Object.keys(changes).length === 0) { showToast('Нет изменений для применения', 'warning'); return; }
        const selectedShopZones = targetTree.getSelection();
        overlay.remove();
        applyConditionsToTargets(projectId, selectedShopZones, changes, typeMeta, state);
      }
    });
    footer.el.style.display = 'none';
    el.appendChild(footer.el);

    return { el };
  }

  // Вкладка «Копирование зон»: то же, что раньше «Копировать/Вставить» через
  // глобальный clipboard, но источник и цели выбираются явно в одной форме.
  function buildCopyZonesTab(projectId, initialShopId, overlay) {
    const el = document.createElement('div');

    const sourceHeading = document.createElement('div');
    sourceHeading.style.cssText = 'font-size:14px;font-weight:600;color:var(--smt-text-primary);margin-bottom:6px;';
    sourceHeading.textContent = 'Откуда копировать';
    el.appendChild(sourceHeading);

    const sourceTree = buildShopZoneTree(projectId, {
      hint: 'Отметьте зону(ы) для копирования РОВНО в одном ресторане-источнике.',
      autoExpandShopId: initialShopId || undefined
    });
    el.appendChild(sourceTree.el);
    if (initialShopId) sourceTree.load();

    const targetHeading = document.createElement('div');
    targetHeading.style.cssText = 'font-size:14px;font-weight:600;color:var(--smt-text-primary);margin-top:22px;margin-bottom:6px;';
    targetHeading.textContent = 'Куда скопировать';
    el.appendChild(targetHeading);

    const targetTree = buildShopZoneTree(projectId, {
      shopLevelOnly: true,
      hint: 'Копирование добавляет зоны из источника к уже существующим в ресторане — ничего не удаляется и не переписывается, поэтому выбор здесь только на уровне ресторана.',
      onChange: () => footer.syncDangerBanner()
    });
    el.appendChild(targetTree.el);

    const footer = buildApplyOptionsFooter({
      applyLabel: '📋 Скопировать зоны',
      getShopCount: () => Object.keys(targetTree.getSelection()).length,
      onApply: async (state) => {
        const sourceSelection = sourceTree.getSelection();
        const sourceShopIds = Object.keys(sourceSelection);
        if (sourceShopIds.length === 0) { showToast('Отметьте зону(ы)-источник', 'warning'); return; }
        if (sourceShopIds.length > 1) showToast('Источник должен быть только в одном ресторане — взят первый из отмеченных', 'warning');
        const sourceShopId = sourceShopIds[0];
        const sourceZoneKeys = sourceSelection[sourceShopId];

        const targetShopIds = Object.keys(targetTree.getSelection()).filter(id => id !== sourceShopId);
        if (targetShopIds.length === 0) { showToast('Отметьте хотя бы один ресторан-цель (не совпадающий с источником)', 'warning'); return; }

        overlay.remove();
        showToast('Загружаем зоны источника...', 'info');
        try {
          const sourceDoc = await getDoc(projectId, sourceShopId);
          if (!sourceDoc) { showToast('Ресторан-источник не найден', 'error'); return; }
          const sourceZones = (sourceDoc.deliveryZones || []).filter(z => sourceZoneKeys.includes(z._key));
          if (sourceZones.length === 0) { showToast('Отмеченные зоны источника не найдены', 'error'); return; }
          const sourceAddress = getAddress(sourceDoc);

          if (state.backupBefore) {
            downloadJson(backupFilename(`sanity-backup_copy-zones_${sourceDoc.name?.ru || sourceShopId}`), {
              createdAt: new Date().toISOString(), projectId, operation: 'copy-zones',
              sourceShopId, sourceShopName: sourceDoc.name?.ru || null, zones: sourceZones
            });
          }

          showToast(`Копируем ${sourceZones.length} зон(ы) в ${targetShopIds.length} ресторан(ов)...`, 'info', 3000);
          const result = await copyZonesToShops(projectId, sourceZones, sourceAddress, targetShopIds, {
            autoPublish: state.autoPublish, forcePublish: state.forcePublish
          });

          const addedEntries = Object.values(result.addedByShop);
          let msg = `✅ Скопировано в ${addedEntries.length} из ${targetShopIds.length} ресторан(ов):\n`
            + addedEntries.slice(0, 20).map(a => `• ${a.shopName}: ${a.zoneNames.join(', ')}`).join('\n');
          let toastType = 'success';
          const skippedPublish = addedEntries.filter(a => a.publishSkipped);
          if (skippedPublish.length > 0) {
            msg += `\n\n⏸ Публикация пропущена (${skippedPublish.length}) — есть посторонние неопубликованные изменения`;
            toastType = 'warning';
          }
          if (result.skippedMsgs.length > 0) {
            msg += `\n\n⚠️ Уже существовали, пропущено:\n` + result.skippedMsgs.slice(0, 20).join('\n');
            toastType = 'warning';
          }
          if (result.errors.length > 0) {
            msg += `\n\n⛔ Ошибки (${result.errors.length}):\n` + result.errors.slice(0, 20).join('\n');
            toastType = 'error';
          }
          if (!state.autoPublish && addedEntries.length > 0) msg += '\n\nНажмите «Опубликовать» в интерфейсах изменённых ресторанов.';
          const duration = toastType === 'success' ? 8000 : 15000;
          showToast(msg, toastType, duration);
          if (state.reloadAfter) setTimeout(() => location.reload(), duration + 500);
        } catch (e) {
          showToast('Ошибка: ' + e.message, 'error');
        }
      }
    });
    el.appendChild(footer.el);

    return { el };
  }

  // Вкладка «Способы оплаты»: включить/выключить один способ оплаты в выбранных
  // зонах — точечная операция (добавить/убрать значение из массива paymentTypes
  // каждого затронутого типа доставки), а не замена всего списка целиком, как
  // раньше делала галочка «Типы оплаты» в общем редакторе условий.
  function buildPaymentToggleTab(projectId, initialShopId, overlay) {
    const el = document.createElement('div');

    const controlsWrap = document.createElement('div');
    controlsWrap.style.cssText = 'display:flex; gap:20px; align-items:flex-end; flex-wrap:wrap; margin-bottom:20px;';

    const methodWrap = document.createElement('div');
    methodWrap.style.cssText = 'flex:1; min-width:220px;';
    methodWrap.innerHTML = `
      <div style="font-size:14px;font-weight:600;color:var(--smt-text-primary);margin-bottom:6px;">Способ оплаты</div>
      <select style="width:100%;height:42px;box-sizing:border-box;padding:0 10px;border:1px solid var(--smt-border);border-radius:6px;font-size:15px;font-family:inherit;background:var(--smt-bg-panel);color:var(--smt-text-primary);" data-sz-payment-method>
        ${PAYMENT_TYPES.map(pt => `<option value="${pt.value}">${pt.label}</option>`).join('')}
      </select>
    `;
    controlsWrap.appendChild(methodWrap);

    const actionWrap = document.createElement('div');
    actionWrap.innerHTML = `
      <div style="font-size:14px;font-weight:600;color:var(--smt-text-primary);margin-bottom:6px;">Действие</div>
      <div class="smt-tri">
        <input type="radio" name="sz-payment-action" id="sz-payment-action-on" checked>
        <label for="sz-payment-action-on" class="smt-tri-opt"><span class="smt-tri-fill"></span><span class="smt-tri-text">Включить</span></label>
        <input type="radio" name="sz-payment-action" id="sz-payment-action-off">
        <label for="sz-payment-action-off" class="smt-tri-opt"><span class="smt-tri-fill"></span><span class="smt-tri-text">Выключить</span></label>
      </div>
    `;
    controlsWrap.appendChild(actionWrap);
    el.appendChild(controlsWrap);

    const targetHeading = document.createElement('div');
    targetHeading.style.cssText = 'font-size:14px;font-weight:600;color:var(--smt-text-primary);margin-bottom:6px;';
    targetHeading.textContent = 'В каких зонах';
    el.appendChild(targetHeading);

    const targetTree = buildShopZoneTree(projectId, {
      allowSelectAllGlobal: true,
      autoExpandShopId: initialShopId || undefined,
      showDeliveryTypes: true,
      hint: 'У зоны может быть несколько способов получения (доставка, самовывоз...), и у каждого свой набор способов оплаты — если под зоной есть отдельный список способов получения, отметьте только нужные, иначе применится ко всей зоне.',
      onChange: () => footer.syncDangerBanner()
    });
    el.appendChild(targetTree.el);
    if (initialShopId) targetTree.load();

    const footer = buildApplyOptionsFooter({
      applyLabel: '💳 Применить к способу оплаты',
      getShopCount: () => Object.keys(targetTree.getSelection()).length,
      onApply: async (state) => {
        const method = el.querySelector('[data-sz-payment-method]').value;
        const enable = el.querySelector('#sz-payment-action-on').checked;
        const selectedShopZones = targetTree.getSelection();
        overlay.remove();
        await applyPaymentToggle(projectId, selectedShopZones, method, enable, state);
      }
    });
    el.appendChild(footer.el);

    return { el };
  }

  // Хаб-модалка «Управление зонами» — единая точка входа вместо трёх отдельных
  // кнопок в шапке ресторана. Ресторан(ы)/зоны выбираются внутри самой модалки
  // (переиспользуемым деревом buildShopZoneTree), а не через уже открытую
  // страницу — кнопка вызова теперь глобальная и не требует, чтобы ресторан
  // был открыт. Если ресторан всё же открыт — initialShopId подставляется как
  // удобный дефолт (разворачивается в дереве источника), но его всегда можно
  // сменить на любой другой.
  function openZonesHub(initialShopId) {
    const projectId = getProjectId();
    if (!projectId) { showToast('Не удалось определить Project ID. Обновите страницу.', 'error'); return; }

    const overlay = document.createElement('div');
    overlay.id = 'sz-edit-modal';
    applyStoredTheme(overlay);
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:999998;
      background:rgba(23,20,14,.5);
      display:flex;align-items:center;justify-content:center;
      font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    `;
    const modal = document.createElement('div');
    modal.style.cssText = `
      background:var(--smt-bg-panel);color:var(--smt-text-primary);border-radius:12px;padding:32px;
      width:820px;max-width:96vw;max-height:90vh;
      overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.25);
      position:relative;
      font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    `;
    const title = document.createElement('div');
    title.style.cssText = 'font-size:22px;font-weight:700;margin-bottom:6px;color:var(--smt-text-primary);padding-right:140px;';
    title.textContent = '🗂 Управление зонами';
    const subtitle = document.createElement('div');
    subtitle.style.cssText = 'font-size:15px;color:var(--smt-text-tertiary);margin-bottom:18px;';
    subtitle.textContent = 'Условия доставки, копирование зон между ресторанами, способы оплаты';

    const headerControls = document.createElement('div');
    headerControls.style.cssText = 'position:absolute;top:20px;right:22px;display:flex;align-items:center;gap:10px;';
    const themeSwitch = buildThemeSwitch(next => {
      overlay.classList.toggle('smt-dark', next === 'dark');
    });
    headerControls.appendChild(themeSwitch);
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.className = 'sz-flat-btn';
    closeBtn.style.cssText = 'width:34px;height:34px;font-size:16px;';
    closeBtn.addEventListener('click', () => overlay.remove());
    headerControls.appendChild(closeBtn);

    const modes = [
      { key: 'conditions', label: 'Условия' },
      { key: 'copy',       label: 'Копирование зон' },
      { key: 'payments',   label: 'Способы оплаты' }
    ];
    const triWrap = document.createElement('div');
    triWrap.className = 'smt-tri';
    triWrap.style.cssText = 'margin-bottom:20px;';
    modes.forEach((m, i) => {
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'sz-hub-mode';
      input.id = `sz-hub-mode-${m.key}`;
      if (i === 0) input.checked = true;
      const label = document.createElement('label');
      label.setAttribute('for', `sz-hub-mode-${m.key}`);
      label.className = 'smt-tri-opt';
      label.innerHTML = `<span class="smt-tri-fill"></span><span class="smt-tri-text">${m.label}</span>`;
      triWrap.appendChild(input);
      triWrap.appendChild(label);
    });

    // body — внешний контейнер, чью высоту анимируем (overflow:hidden, ей
    // управляет ResizeObserver ниже). bodyInner — настоящий контент, всегда
    // на естественной высоте (height не трогаем никогда) — именно за ним
    // следит ResizeObserver, поэтому колбэк реагирует только на реальные
    // изменения контента и никогда на анимацию самого body (иначе было бы
    // зацикливание: body меняется → наблюдатель видит своё же изменение).
    // Так анимируется ЛЮБОЕ изменение высоты — не только смена вкладки, но и
    // разворачивание ресторана/зоны, догрузка списка ресторанов, появление
    // блока условий после «Подставить условия» и т.п. — без необходимости
    // вручную дёргать анимацию из каждого места, где меняется контент.
    const body = document.createElement('div');
    body.style.cssText = 'overflow:hidden;';
    const bodyInner = document.createElement('div');
    body.appendChild(bodyInner);

    modal.appendChild(headerControls);
    modal.appendChild(title);
    modal.appendChild(subtitle);
    modal.appendChild(triWrap);
    modal.appendChild(body);
    overlay.appendChild(modal);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    const HEIGHT_ANIM_MS = 280;
    let lastBodyHeight = 0;
    let heightResetTimer = null;
    const heightObserver = new ResizeObserver(() => {
      const newHeight = bodyInner.offsetHeight;
      if (newHeight === lastBodyHeight) return;
      body.style.transition = 'none';
      body.style.height = lastBodyHeight + 'px';
      body.offsetHeight; // форсируем layout, чтобы старая высота зафиксировалась до смены на новую
      requestAnimationFrame(() => {
        body.style.transition = `height ${HEIGHT_ANIM_MS}ms ease`;
        body.style.height = newHeight + 'px';
      });
      lastBodyHeight = newHeight;
      clearTimeout(heightResetTimer);
      // возвращаем на 'auto' после анимации — иначе контент, который вырастет
      // позже (например, поля условий после «Подставить условия»), обрежется
      // зафиксированной высотой вместо того, чтобы просто раздвинуть модалку
      heightResetTimer = setTimeout(() => { body.style.height = 'auto'; }, HEIGHT_ANIM_MS + 40);
    });
    heightObserver.observe(bodyInner);
    // overlay.remove() дёргается из многих мест (крестик, клик по фону, все
    // три onApply в самих вкладках) — проще один раз подменить сам метод,
    // чем тащить disconnect() во все точки вызова.
    const closeOverlay = overlay.remove.bind(overlay);
    overlay.remove = () => { heightObserver.disconnect(); closeOverlay(); };

    // Вкладки строятся лениво — при первом переключении на них, а не все три
    // сразу при открытии модалки, чтобы не гонять fetchAllShops() впустую.
    const built = {};
    function showMode(key) {
      bodyInner.innerHTML = '';
      if (!built[key]) {
        if (key === 'conditions') built[key] = buildConditionsTab(projectId, initialShopId, overlay);
        else if (key === 'copy')  built[key] = buildCopyZonesTab(projectId, initialShopId, overlay);
        else                       built[key] = buildPaymentToggleTab(projectId, initialShopId, overlay);
      }
      bodyInner.appendChild(built[key].el);
    }
    modes.forEach(m => {
      triWrap.querySelector(`#sz-hub-mode-${m.key}`).addEventListener('change', () => showMode(m.key));
    });
    showMode('conditions');
  }

  function gradRowValue(row, dynamicCalc) {
    if (!row) return 0;
    const v = dynamicCalc ? row.compensation?.compensationValue : row.price;
    return (typeof v === 'number' && !isNaN(v)) ? v : 0;
  }

  function gradRowsToMap(rows, dynamicCalc) {
    const map = {};
    for (const r of (rows || [])) {
      if (r?.basketPriceTo === undefined || r?.basketPriceTo === null) continue;
      map[r.basketPriceTo] = gradRowValue(r, dynamicCalc);
    }
    return map;
  }

  function collectPriceWarnings(zoneName, typeName, dtp, change, priceFieldName, dynamicCalc) {
    const warnings = [];
    const oldDefault = (typeof dtp?.[priceFieldName] === 'number') ? dtp[priceFieldName] : 0;
    const newDefault = (priceFieldName in change) ? change[priceFieldName] : oldDefault;
    if (newDefault !== oldDefault && (newDefault > 0 || oldDefault > 0)) {
      warnings.push(`${zoneName} — ${typeName}: цена ${oldDefault}₽ → ${newDefault}₽`);
    }
    const oldGradMap = gradRowsToMap(dtp?.deliveryPrice, dynamicCalc);
    const newGradMap = ('deliveryPrice' in change) ? gradRowsToMap(change.deliveryPrice, dynamicCalc) : oldGradMap;
    const allKeys = new Set([...Object.keys(oldGradMap), ...Object.keys(newGradMap)]);
    for (const key of allKeys) {
      const oldVal = oldGradMap[key] ?? 0;
      const newVal = newGradMap[key] ?? 0;
      if (oldVal !== newVal && (newVal > 0 || oldVal > 0)) {
        warnings.push(`${zoneName} — ${typeName}: ступень до ${key}₽: ${oldVal} → ${newVal}`);
      }
    }
    return warnings;
  }

  // Единая функция применения условий — раньше было два отдельных пути
  // ("одиночное" на уже загрученном currentDoc и "массовое" с повторным
  // fetch по каждому ресторану). Теперь источник и цель всегда выбираются
  // явно в модалке, поэтому один ресторан — это просто selectedShopZones
  // из одной пары {shopId: [zoneKey,...]}, код для 1 и N ресторанов общий.
  async function applyConditionsToTargets(projectId, selectedShopZones, changes, typeMeta, state) {
    const shopIds = Object.keys(selectedShopZones);
    if (shopIds.length === 0) { showToast('Нет выбранных зон', 'warning'); return; }

    // Предполётная проверка: если публикуем автоматически, сначала убеждаемся,
    // что ВСЕ выбранные рестораны проходят валидацию Studio (через SPA-переход
    // по каждому и чтение её собственной панели «Валидация» — надёжнее любой
    // самописной проверки, так как учитывает вообще все кастомные правила схемы).
    if (state.autoPublish && state.preflightValidation) {
      const workspace    = currentWorkspace();
      const originalPath = location.pathname;
      showToast(`Проверяем валидацию ${shopIds.length} ресторан(ов) перед публикацией...`, 'info', 3000);
      let invalidShops;
      try {
        invalidShops = await checkShopsValidationBeforePublish(workspace, shopIds, originalPath, true);
      } catch (e) {
        showToast('Не удалось проверить валидацию: ' + e.message + '. Публикация отменена — попробуйте ещё раз или снимите галочку предполётной проверки.', 'error', 15000);
        return;
      }
      if (invalidShops.length > 0) {
        const list = invalidShops.map(s => `• ${s.shopName}`).join('\n');
        showToast(
          `⛔ Публикация заблокирована.\n\n` +
          `У ${invalidShops.length} из ${shopIds.length} ресторан(ов) не заполнены обязательные поля ` +
          `(валидация Studio не пройдена):\n${list}\n\n` +
          `Сначала заполните обязательные поля в этих ресторанах вручную в интерфейсе, ` +
          `и только потом повторите применение. Ни один ресторан не был изменён.`,
          'error', 25000
        );
        return;
      }
      showToast('Валидация пройдена во всех ресторанах, продолжаем...', 'success', 2000);
    }

    let progress = 0;
    const total = shopIds.length;
    const allWarnings = [];
    const priceWarnings = [];
    const publishSkippedWarnings = [];
    const backups = [];

    for (const shopId of shopIds) {
      progress++;
      showToast(`Применяем условия: ${progress} из ${total}...`, 'info', 2000);
      const zoneKeys = selectedShopZones[shopId] || [];
      if (zoneKeys.length === 0) continue;
      try {
        const doc = await getDoc(projectId, shopId);
        if (!doc) { allWarnings.push(`${shopId}: заведение не найдено.`); continue; }

        const allRefs = new Set();
        for (const zone of (doc.deliveryZones || []))
          for (const dtp of (zone.deliveryTypePrices || []))
            if (dtp.deliveryType?._ref) allRefs.add(dtp.deliveryType._ref);
        const typeNameMap = await resolveDeliveryTypeNames(projectId, [...allRefs]);

        // Матчим зоны по _key, а не по имени — так надёжно работает,
        // даже если в ресторане другое число зон или другие названия.
        const targetZones = (doc.deliveryZones || []).filter(z => zoneKeys.includes(z._key));
        if (targetZones.length === 0) {
          allWarnings.push(`${doc.name?.ru || shopId}: выбранные зоны не найдены (возможно, были изменены после загрузки списка — обновите список и попробуйте снова).`);
          continue;
        }

        if (state.backupBefore) backups.push({ shopId, shopName: doc.name?.ru || null, zones: targetZones });

        const draftId  = 'drafts.' + shopId;
        const hasDraft = doc._id.startsWith('drafts.');
        // "Свой" черновик — это либо новый (мы его сейчас создаём), либо уже существующий,
        // но с ревизией, совпадающей с той, что скрипт сам оставил в прошлый раз.
        const ownedRev       = hasDraft ? getOwnedDraftRev(projectId, shopId) : null;
        const isKnownOwned   = !hasDraft || (ownedRev !== null && ownedRev === doc._rev);
        const isForeignDraft = hasDraft && !isKnownOwned;
        const mutations = [];
        if (!hasDraft) {
          const { documents } = await (await apiFetch(projectId, `/data/doc/production/${shopId}`)).json();
          mutations.push({ createIfNotExists: { ...documents[0], _id: draftId } });
        }

        const appliedTypes = new Set();
        for (const zone of targetZones) {
          for (const dtp of (zone.deliveryTypePrices || [])) {
            const typeName = typeNameMap[dtp.deliveryType?._ref];
            const change   = changes[typeName];
            if (!change) continue;
            appliedTypes.add(typeName);
            const path = `deliveryZones[_key=="${zone._key}"].deliveryTypePrices[_key=="${dtp._key}"]`;
            const setFields = {};
            const unsetPaths = [];
            for (const key of Object.keys(change)) {
              if (change[key] === null) unsetPaths.push(`${path}.${key}`);
              else setFields[`${path}.${key}`] = change[key];
            }
            const dtpPatch = {};
            if (Object.keys(setFields).length > 0) dtpPatch.set = setFields;
            if (unsetPaths.length > 0) dtpPatch.unset = unsetPaths;
            if (dtpPatch.set || dtpPatch.unset) mutations.push({ patch: { id: draftId, ...dtpPatch } });

            const meta = typeMeta[typeName];
            if (meta) priceWarnings.push(...collectPriceWarnings(zone.name, typeName, dtp, change, meta.priceFieldName, meta.dynamicCalc));
          }
        }
        for (const typeName of Object.keys(changes)) {
          if (!appliedTypes.has(typeName)) {
            allWarnings.push(`${doc.name?.ru || shopId}: в выбранных зонах нет типа "${typeName}"`);
          }
        }

        if (mutations.length === 0) continue;

        const r = await apiFetch(projectId, `/data/mutate/production?returnIds=true&returnDocuments=true`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mutations })
        });
        if (!r.ok) {
          const result = await r.json();
          allWarnings.push(`${doc.name?.ru || shopId}: ошибка Sanity - ${JSON.stringify(result?.error || result)}`);
          continue;
        }
        const result = await r.json();
        const draftResult = result.results?.find(x => x.id === draftId);
        const newRev = draftResult?.document?._rev || null;
        if (isKnownOwned) setOwnedDraftRev(projectId, shopId, newRev);

        if (state.autoPublish) {
          if (isForeignDraft && !state.forcePublish) {
            publishSkippedWarnings.push(`${doc.name?.ru || shopId}: есть другие неопубликованные изменения — публикация пропущена`);
          } else {
            try {
              await publishDoc(projectId, shopId);
              clearOwnedDraftRev(projectId, shopId);
            }
            catch (e) { allWarnings.push(`${doc.name?.ru || shopId}: изменения сохранены, но публикация не удалась - ${e.message}`); }
          }
        }
      } catch (e) {
        allWarnings.push(`${shopId}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    if (state.backupBefore && backups.length > 0) {
      downloadJson(backupFilename('sanity-backup_apply-conditions'), {
        createdAt: new Date().toISOString(),
        projectId,
        operation: 'apply-conditions',
        typesChanged: Object.keys(changes),
        shopsCount: backups.length,
        shops: backups
      });
    }

    let msg = state.autoPublish
      ? `✅ Условия применены (${total} ресторан(ов)).`
      : `✅ Условия применены (${total} ресторан(ов)).\nНажмите «Опубликовать» в интерфейсах изменённых ресторанов.`;
    let toastType = 'success';
    if (publishSkippedWarnings.length > 0) {
      msg += `\n\n⏸ Публикация пропущена (${publishSkippedWarnings.length}) — в этих ресторанах уже были другие неопубликованные изменения:\n`
        + publishSkippedWarnings.slice(0, 30).join('\n');
      toastType = 'warning';
    }
    if (priceWarnings.length > 0) {
      msg += '\n\n⚠️ Проверьте «Позицию для доставки»:\n' + priceWarnings.slice(0, 30).map(w => `• ${w}`).join('\n');
      toastType = 'warning';
    }
    if (allWarnings.length > 0) {
      msg += `\n\n⚠️ Предупреждения (${allWarnings.length}):\n` + allWarnings.slice(0, 30).join('\n');
      toastType = 'warning';
    }
    const duration = toastType === 'warning' ? 15000 : 6000;
    showToast(msg, toastType, duration);
    if (state.reloadAfter) setTimeout(() => location.reload(), duration + 500);
  }

  // Точечное включение/выключение одного способа оплаты в выбранных зонах —
  // добавляет/убирает значение из paymentTypes каждого затронутого типа
  // доставки, читая ТЕКУЩИЙ массив перед записью (а не заменяя его целиком),
  // чтобы не затереть другие способы оплаты, уже настроенные в этой зоне.
  // Если paymentTypes вообще не задан (undefined) — зона пропускается с
  // предупреждением, а не молча получает угаданный список: см. обсуждение
  // в чате — на реальных данных таких записей не нашлось, но гадать в
  // сторону "разрешить всё" или "запретить всё" одинаково рискованно.
  async function applyPaymentToggle(projectId, selectedShopZones, method, enable, state) {
    const shopIds = Object.keys(selectedShopZones);
    if (shopIds.length === 0) { showToast('Нет выбранных зон', 'warning'); return; }
    const methodLabel = PAYMENT_TYPES.find(p => p.value === method)?.label || method;

    if (state.autoPublish && state.preflightValidation) {
      const workspace    = currentWorkspace();
      const originalPath = location.pathname;
      showToast(`Проверяем валидацию ${shopIds.length} ресторан(ов) перед публикацией...`, 'info', 3000);
      let invalidShops;
      try {
        invalidShops = await checkShopsValidationBeforePublish(workspace, shopIds, originalPath, true);
      } catch (e) {
        showToast('Не удалось проверить валидацию: ' + e.message + '. Публикация отменена.', 'error', 15000);
        return;
      }
      if (invalidShops.length > 0) {
        const list = invalidShops.map(s => `• ${s.shopName}`).join('\n');
        showToast(`⛔ Публикация заблокирована — не пройдена валидация у:\n${list}\n\nНи один ресторан не был изменён.`, 'error', 20000);
        return;
      }
    }

    let progress = 0;
    const total = shopIds.length;
    const changedShops = [];
    const skippedUndefined = [];
    const allWarnings = [];
    const backups = [];

    for (const shopId of shopIds) {
      progress++;
      showToast(`${enable ? 'Включаем' : 'Выключаем'} «${methodLabel}»: ${progress} из ${total}...`, 'info', 2000);
      const zoneMap  = selectedShopZones[shopId] || {};
      const zoneKeys = Object.keys(zoneMap);
      if (zoneKeys.length === 0) continue;
      try {
        const doc = await getDoc(projectId, shopId);
        if (!doc) { allWarnings.push(`${shopId}: заведение не найдено`); continue; }
        const targetZones = (doc.deliveryZones || []).filter(z => zoneKeys.includes(z._key));
        if (targetZones.length === 0) { allWarnings.push(`${doc.name?.ru || shopId}: выбранные зоны не найдены`); continue; }

        if (state.backupBefore) backups.push({ shopId, shopName: doc.name?.ru || null, zones: targetZones });

        const draftId  = 'drafts.' + shopId;
        const hasDraft = doc._id.startsWith('drafts.');
        const ownedRev       = hasDraft ? getOwnedDraftRev(projectId, shopId) : null;
        const isKnownOwned   = !hasDraft || (ownedRev !== null && ownedRev === doc._rev);
        const isForeignDraft = hasDraft && !isKnownOwned;
        const mutations = [];
        if (!hasDraft) {
          const { documents } = await (await apiFetch(projectId, `/data/doc/production/${shopId}`)).json();
          mutations.push({ createIfNotExists: { ...documents[0], _id: draftId } });
        }

        let touchedCount = 0;
        for (const zone of targetZones) {
          // null/отсутствие записи — вся зона, всё способы получения; массив —
          // только перечисленные _key способов получения внутри этой зоны.
          const typeFilter = zoneMap[zone._key];
          for (const dtp of (zone.deliveryTypePrices || [])) {
            if (Array.isArray(typeFilter) && !typeFilter.includes(dtp._key)) continue;
            const current = dtp.paymentTypes;
            if (current === undefined) {
              skippedUndefined.push(`${doc.name?.ru || shopId} — ${zone.name}: список способов оплаты не задан вообще — пропущено, настройте вручную`);
              continue;
            }
            const has = current.includes(method);
            if (enable === has) continue; // уже в нужном состоянии
            const next = enable ? [...current, method] : current.filter(m => m !== method);
            const path = `deliveryZones[_key=="${zone._key}"].deliveryTypePrices[_key=="${dtp._key}"].paymentTypes`;
            mutations.push({ patch: { id: draftId, set: { [path]: next } } });
            touchedCount++;
          }
        }
        if (touchedCount === 0) continue;

        const r = await apiFetch(projectId, `/data/mutate/production?returnIds=true&returnDocuments=true`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mutations })
        });
        if (!r.ok) {
          const result = await r.json();
          allWarnings.push(`${doc.name?.ru || shopId}: ошибка Sanity — ${JSON.stringify(result?.error || result)}`);
          continue;
        }
        const result = await r.json();
        const draftResult = result.results?.find(x => x.id === draftId);
        if (isKnownOwned) setOwnedDraftRev(projectId, shopId, draftResult?.document?._rev || null);
        changedShops.push(doc.name?.ru || shopId);

        if (state.autoPublish) {
          if (isForeignDraft && !state.forcePublish) {
            allWarnings.push(`${doc.name?.ru || shopId}: публикация пропущена — есть посторонние неопубликованные изменения`);
          } else {
            try { await publishDoc(projectId, shopId); clearOwnedDraftRev(projectId, shopId); }
            catch (e) { allWarnings.push(`${doc.name?.ru || shopId}: изменения сохранены, но публикация не удалась — ${e.message}`); }
          }
        }
      } catch (e) {
        allWarnings.push(`${shopId}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    if (state.backupBefore && backups.length > 0) {
      downloadJson(backupFilename(`sanity-backup_payment-${method}`), {
        createdAt: new Date().toISOString(),
        projectId,
        operation: 'payment-toggle',
        method, enable,
        shopsCount: backups.length,
        shops: backups
      });
    }

    let msg = `${enable ? '✅ Включено' : '✅ Выключено'} «${methodLabel}» в ${changedShops.length} из ${total} ресторан(ов).`;
    let toastType = 'success';
    if (skippedUndefined.length > 0) {
      msg += `\n\n⚠️ Пропущено без изменений (${skippedUndefined.length}) — список способов оплаты не настроен вообще, решение неоднозначно:\n` + skippedUndefined.slice(0, 20).join('\n');
      toastType = 'warning';
    }
    if (allWarnings.length > 0) {
      msg += `\n\n⚠️ Предупреждения (${allWarnings.length}):\n` + allWarnings.slice(0, 20).join('\n');
      toastType = 'warning';
    }
    const duration = toastType === 'warning' ? 15000 : 6000;
    showToast(msg, toastType, duration);
    if (state.reloadAfter) setTimeout(() => location.reload(), duration + 500);
  }

  // ---------------------------------------------------------------------
  // Кнопка вызова хаба в левом меню Studio — там же, где кнопка баннеров
  // в sanity-banners-manager.user.js: ищем пункт меню «Schedules» и вставляем
  // свою кнопку туда же (тот же приём, тот же сайт — оба скрипта работают
  // с одним и тем же левым меню). В отличие от старых кнопок в шапке
  // карточки ресторана, эта не привязана к открытому документу — работает
  // на любой странице, ресторан(ы)/зоны выбираются внутри самой модалки.
  // ---------------------------------------------------------------------
  function findNavContainer() {
    const link = Array.from(document.querySelectorAll('a')).find(
      a => a.textContent.trim() === 'Schedules'
    );
    return link ? link.parentElement : null;
  }

  // Кнопка нужна только на странице списка заведений и на страницах отдельных
  // заведений (и глубже) — не на каждой странице Studio. parts[2] у списка —
  // "shops-item;shops", у конкретного заведения — "shops-item;shops;{id}".
  function isZonesRoute() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length < 3) return false;
    if (parts[1] !== 'structure') return false;
    return parts[2].startsWith('shops-item;shops');
  }

  function createNavButton() {
    const btn = document.createElement('button');
    btn.id = 'sz-nav-btn';
    btn.type = 'button';
    btn.textContent = '🗂 Управление зонами';
    btn.addEventListener('click', () => openZonesHub(getShopId()));
    return btn;
  }

  function createFallbackFab() {
    const btn = document.createElement('button');
    btn.id = 'sz-fab';
    btn.type = 'button';
    btn.textContent = '🗂 Управление зонами';
    btn.addEventListener('click', () => openZonesHub(getShopId()));
    return btn;
  }

  // Даём левому меню время отрисоваться и только если оно так и не появилось
  // спустя разумное время — показываем плавающую кнопку внизу справа (тот же
  // приём, что в sanity-banners-manager.user.js, чтобы не было вспышки кнопки
  // при обычной загрузке страницы).
  const NAV_FALLBACK_GRACE_MS = 2500;
  let navButtonSince = null;

  function syncNavButton() {
    if (!document.body) return;
    const navBtn = document.getElementById('sz-nav-btn');
    const fab    = document.getElementById('sz-fab');

    if (!isZonesRoute()) {
      navButtonSince = null;
      if (navBtn) navBtn.remove();
      if (fab) fab.remove();
      return;
    }

    ensureModalStyles();
    if (navButtonSince === null) navButtonSince = Date.now();
    const container = findNavContainer();

    if (container) {
      if (fab) fab.remove();
      if (!navBtn || navBtn.parentElement !== container) {
        if (navBtn) navBtn.remove();
        container.appendChild(createNavButton());
      }
      return;
    }

    if (Date.now() - navButtonSince > NAV_FALLBACK_GRACE_MS && !fab) {
      document.body.appendChild(createFallbackFab());
    }
  }

  setInterval(syncNavButton, 250);
  if (document.body) {
    syncNavButton();
  } else {
    document.addEventListener('DOMContentLoaded', syncNavButton, { once: true });
  }

})();
