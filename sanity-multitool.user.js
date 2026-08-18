// ==UserScript==
// @name         Sanity — мультитул по зонам (Mass Update)
// @namespace    starterapp-delivery-zones
// @version      6.11
// @description  Чекбоксы, копирование/вставка зон, точечный выбор условий, поиск и выбор блюда каталога ("Позиция для доставки из POS-системы") для платных цен доставки, JSON-бэкап перед изменением, массовое применение (опасная зона с доп. подтверждением "Точно?") с выбором зон, умное отслеживание "своих" черновиков, предполётная проверка валидации Studio
// @match        https://my.starterapp.ru/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/Gnomophile/sanity-multitool/main/sanity-multitool.user.js
// @downloadURL  https://raw.githubusercontent.com/Gnomophile/sanity-multitool/main/sanity-multitool.user.js
// ==/UserScript==

(function () {
  'use strict';

  let clipboard   = null;
  let isInjecting = false;

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
  // в массовом применении условий.
  async function fetchAllShops(projectId) {
    const query = encodeURIComponent(
      `*[_type == "shop" && !(_id in path("drafts.**")) && isArchived != true] | order(name.ru asc) {
        _id, name, address,
        "zones": deliveryZones[]{_key, name}
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

  // Доп. подтверждение перед массовым применением — легко ошибиться, задев сразу
  // много ресторанов, а откат из бэкапа небыстрый. "Нет" просто закрывает окно
  // подтверждения и возвращает к прежним настройкам в модалке — ничего не сбрасывается.
  function showMassApplyConfirm(shopsCount, onConfirm) {
    const confirmOverlay = document.createElement('div');
    confirmOverlay.style.cssText = `
      position:fixed;inset:0;z-index:9999999;
      background:rgba(0,0,0,0.55);
      display:flex;align-items:center;justify-content:center;
      font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    `;
    const box = document.createElement('div');
    box.style.cssText = `
      background:#fff;border-radius:12px;padding:28px;
      width:420px;max-width:90vw;
      box-shadow:0 10px 40px rgba(0,0,0,0.35);
      text-align:center;
    `;
    const shopsLabel = shopsCount != null ? `${shopsCount} ${shopsCount === 1 ? 'ресторан' : 'ресторанов'}` : 'несколько ресторанов';
    box.innerHTML = `
      <div style="font-size:38px;margin-bottom:8px;">⚠️</div>
      <div style="font-size:19px;font-weight:700;color:#333;margin-bottom:10px;">Точно?</div>
      <div style="font-size:14px;color:#666;margin-bottom:24px;line-height:1.55;">
        Изменения применятся сразу к ${shopsLabel}. Это действие нельзя откатить одним кликом —
        восстановление из бэкапа придётся делать вручную. Проверьте ещё раз список
        ресторанов и зон перед тем, как продолжить.
      </div>
      <div style="display:flex; gap:12px;">
        <button id="sz-confirm-no" style="flex:1;padding:12px;border:1px solid #ccc;background:#fff;color:#333;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;">Нет, вернуться</button>
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

  function updateCopyButtonLabel() {
    const fieldset = document.querySelector('fieldset[data-testid="field-deliveryZones"]');
    if (!fieldset) return;
    const copyBtn = fieldset.querySelector('[data-sz-copy-btn] button');
    if (!copyBtn) return;
    const checkboxes   = Array.from(fieldset.querySelectorAll('input[data-sz-checkbox]'));
    const checkedCount = checkboxes.filter(cb => cb.checked).length;
    if (checkedCount === 0)      copyBtn.textContent = '📋 Копировать все зоны';
    else if (checkedCount === 1) copyBtn.textContent = '📋 Копировать зону';
    else                         copyBtn.textContent = '📋 Копировать зоны';
  }

  function getCheckedZoneNames() {
    const fieldset = document.querySelector('fieldset[data-testid="field-deliveryZones"]');
    if (!fieldset) return null;
    const checkboxes = Array.from(fieldset.querySelectorAll('input[data-sz-checkbox]'));
    const checked = checkboxes.filter(cb => cb.checked).map(cb => cb.getAttribute('data-zone-name'));
    return checked.length > 0 ? checked : null;
  }

  async function onCopy() {
    const projectId = getProjectId();
    const shopId    = getShopId();
    if (!projectId) { showToast('Не удалось определить Project ID. Обновите страницу.', 'error'); return; }
    if (!shopId)    { showToast('Не удалось определить ID заведения', 'error'); return; }
    showToast('Копируем зоны...', 'info');
    try {
      const doc = await getDoc(projectId, shopId);
      if (!doc) { showToast('Заведение не найдено', 'error'); return; }
      const allZones    = doc.deliveryZones || [];
      const zoneNames   = getCheckedZoneNames();
      const zonesToCopy = zoneNames ? allZones.filter(z => zoneNames.includes(z.name)) : allZones;
      if (zonesToCopy.length === 0) { showToast('Нет зон для копирования', 'warning'); return; }
      clipboard = { zones: zonesToCopy, sourceAddress: getAddress(doc) };
      showToast(`✅ Скопировано зон: ${zonesToCopy.length}\n` + zonesToCopy.map(z => `• ${z.name}`).join('\n'), 'success');
    } catch (e) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function onPaste() {
    if (!clipboard) { showToast('Сначала нажмите «Копировать зоны» на заведении-источнике', 'warning'); return; }
    const projectId = getProjectId();
    const shopId    = getShopId();
    if (!projectId) { showToast('Не удалось определить Project ID. Обновите страницу.', 'error'); return; }
    if (!shopId)    { showToast('Не удалось определить ID заведения', 'error'); return; }
    showToast('Вставляем зоны...', 'info');
    try {
      const targetDoc = await getDoc(projectId, shopId);
      if (!targetDoc) { showToast('Целевое заведение не найдено', 'error'); return; }
      const targetZones = targetDoc.deliveryZones || [];
      const draftId     = 'drafts.' + shopId;
      const hasDraft    = targetDoc._id.startsWith('drafts.');
      const zonesToAdd  = [];
      const skipped     = [];
      for (const zone of clipboard.zones) {
        const newName = `${zone.name} с ${clipboard.sourceAddress}`;
        if (targetZones.find(z => z.name === newName)) { skipped.push(newName); continue; }
        const clone = deepClone(zone);
        clone.name  = newName;
        zonesToAdd.push(clone);
      }
      if (zonesToAdd.length === 0) { showToast('Все выбранные зоны уже есть в этом заведении', 'warning'); return; }
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
      const r = await apiFetch(projectId, `/data/mutate/production`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mutations })
      });
      const result = await r.json();
      if (r.ok) {
        let msg = `✅ Вставлено зон: ${zonesToAdd.length}\n` + zonesToAdd.map(z => `• ${z.name}`).join('\n');
        if (skipped.length) msg += `\n\n⚠️ Пропущено (уже есть): ${skipped.length}`;
        msg += '\n\nНажмите «Опубликовать» в интерфейсе';
        showToast(msg, 'success');
      } else {
        showToast('Ошибка Sanity: ' + JSON.stringify(result?.error || result), 'error');
      }
    } catch (e) {
      showToast('Ошибка: ' + e.message, 'error');
    }
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
    title.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;color:#555;margin-bottom:8px;cursor:pointer;';
    title.innerHTML = '<input type="checkbox" data-sz-include-payment style="width:15px;height:15px;cursor:pointer;"> Типы оплаты';
    wrap.appendChild(title);

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;';
    const known = new Set(currentValues || []);
    for (const pt of PAYMENT_TYPES) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;color:#333;cursor:pointer;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.setAttribute('data-sz-payment-value', pt.value);
      cb.checked = known.has(pt.value);
      cb.style.cssText = 'width:16px;height:16px;cursor:pointer;';
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
    label.style.cssText = 'font-size:12px;color:#888;margin-bottom:4px;';
    wrap.appendChild(label);

    const chipRow = document.createElement('div');
    chipRow.style.cssText = 'display:flex;align-items:center;gap:6px;';

    const chip = document.createElement('div');
    chip.style.cssText = 'flex:1;min-width:0;padding:7px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;background:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

    const searchBtn = document.createElement('button');
    searchBtn.type = 'button';
    searchBtn.textContent = '🔍';
    searchBtn.title = 'Найти блюдо в каталоге Sanity';
    searchBtn.style.cssText = 'padding:7px 10px;border:1px solid #4a90e2;background:#fff;color:#4a90e2;border-radius:6px;cursor:pointer;font-size:13px;flex-shrink:0;';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = '✕';
    clearBtn.title = 'Убрать выбранное блюдо';
    clearBtn.style.cssText = 'padding:7px 9px;border:1px solid #e74c3c;background:#fff;color:#e74c3c;border-radius:6px;cursor:pointer;font-size:13px;flex-shrink:0;';

    chipRow.appendChild(chip);
    chipRow.appendChild(searchBtn);
    chipRow.appendChild(clearBtn);
    wrap.appendChild(chipRow);

    const searchPanel = document.createElement('div');
    searchPanel.style.cssText = 'display:none;margin-top:6px;border:1px solid #ddd;border-radius:6px;padding:8px;background:#fafafa;';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Поиск блюда по названию...';
    searchInput.style.cssText = 'width:100%;padding:7px 9px;border:1px solid #ccc;border-radius:6px;font-size:13px;box-sizing:border-box;';
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
        chip.style.color = '#333';
        clearBtn.style.display = '';
      } else {
        chip.textContent = 'Блюдо не выбрано';
        chip.style.color = '#aaa';
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
        resultsList.innerHTML = '<div style="padding:6px;color:#999;font-size:12px;">Ищем...</div>';
        try {
          const items = await searchMeals(projectId, term);
          resultsList.innerHTML = '';
          if (!items.length) {
            resultsList.innerHTML = '<div style="padding:6px;color:#999;font-size:12px;">Ничего не найдено</div>';
            return;
          }
          items.forEach(m => {
            const row = document.createElement('div');
            row.style.cssText = 'padding:6px 8px;cursor:pointer;border-radius:4px;font-size:13px;color:#333;';
            let text = m.title + (m.status === false ? ' (отключено)' : '');
            if (m.code) text += ' — ' + m.code;
            row.textContent = text;
            row.addEventListener('mouseenter', () => { row.style.background = '#eef4fc'; });
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
      return '<select style="padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:16px;" ' +
        'data-sz-grad-comp-type data-sz-raw-map="' + encodedMap + '">' + optionsHtml + '</select>';
    }

    function addRow(basketPriceTo, price, compType, compValue, productRef, productTitle) {
      basketPriceTo = basketPriceTo ?? '';
      price = price ?? '';
      compValue = compValue ?? '';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; flex-direction:column; gap:8px; padding:8px; border:1px solid #eee; border-radius:8px; background:#fff;';
      const topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex; gap:10px; align-items:center; flex-wrap:wrap;';
      if (dynamicCalc) {
        topRow.innerHTML =
          '<span style="font-size:14px;color:#888;white-space:nowrap;">до &#8381;</span>' +
          '<input type="number" placeholder="сумма корзины" value="' + basketPriceTo + '" ' +
            'style="width:130px;padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:16px;" data-sz-grad-to>' +
          '<span style="font-size:14px;color:#888;">&rarr;</span>' +
          renderCompTypeSelect(compType) +
          '<input type="number" placeholder="значение" value="' + compValue + '" ' +
            'style="width:110px;padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:16px;" data-sz-grad-comp-value>' +
          '<button type="button" style="padding:6px 12px;border:none;background:#e74c3c;color:#fff;border-radius:6px;cursor:pointer;font-size:15px;" data-sz-grad-del>&#10005;</button>';
      } else {
        topRow.innerHTML =
          '<span style="font-size:14px;color:#888;white-space:nowrap;">до &#8381;</span>' +
          '<input type="number" placeholder="сумма корзины" value="' + basketPriceTo + '" ' +
            'style="width:130px;padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:16px;" data-sz-grad-to>' +
          '<span style="font-size:14px;color:#888;">&rarr; &#8381;</span>' +
          '<input type="number" placeholder="цена" value="' + price + '" ' +
            'style="width:110px;padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:16px;" data-sz-grad-price>' +
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
    addBtn.style.cssText = 'margin-top:8px;padding:8px 14px;border:1px dashed #4a90e2;background:transparent;color:#4a90e2;border-radius:6px;cursor:pointer;font-size:14px;';
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
    content.style.cssText = 'padding:16px;background:#f8f9fa;border-radius:8px;border:1px solid #e0e0e0;';
    content.innerHTML = `
      <label style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:#333;cursor:pointer;background:#eef4fc;border:1px solid #d5e6fb;border-radius:6px;padding:8px 12px;margin-bottom:14px;">
        <input type="checkbox" data-sz-select-all-fields style="width:16px;height:16px;cursor:pointer;">
        <span>Выбрать все условия этого типа доставки</span>
      </label>
      <div style="font-size:13px;color:#888;margin-bottom:10px;">
        Отметьте галочкой только те условия, которые нужно скопировать/применить. Невыбранные условия останутся в каждой зоне как есть.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:14px;">
        <label style="font-size:14px;color:#555;">
          <span style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">
            <input type="checkbox" data-sz-include="${timeFieldName}" style="width:15px;height:15px;cursor:pointer;">
            ${dynamicCalc ? 'Время динамической доставки (мин)' : 'Время доставки (мин)'}
          </span>
          <input type="number" placeholder="значение" value="${existingTime}"
            style="display:block;width:100%;padding:9px 10px;border:1px solid #ccc;border-radius:6px;font-size:16px;box-sizing:border-box;"
            data-sz-field="${timeFieldName}">
        </label>
        <label style="font-size:14px;color:#555;">
          <span style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">
            <input type="checkbox" data-sz-include="minBasketPrice" style="width:15px;height:15px;cursor:pointer;">
            Мин. сумма корзины
          </span>
          <input type="number" placeholder="значение" value="${existingMin}"
            style="display:block;width:100%;padding:9px 10px;border:1px solid #ccc;border-radius:6px;font-size:16px;box-sizing:border-box;"
            data-sz-field="minBasketPrice">
        </label>
        <label style="font-size:14px;color:#555;">
          <span style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">
            <input type="checkbox" data-sz-include="${priceFieldName}" style="width:15px;height:15px;cursor:pointer;">
            ${dynamicCalc ? 'Цена динамической доставки по умолчанию' : 'Цена по умолчанию'}
          </span>
          <input type="number" placeholder="значение" value="${existingDef}"
            style="display:block;width:100%;padding:9px 10px;border:1px solid #ccc;border-radius:6px;font-size:16px;box-sizing:border-box;"
            data-sz-field="${priceFieldName}">
        </label>
      </div>
      ${dynamicCalc ? `
      <div style="font-size:13px;color:#8e44ad;background:#f4ecfb;border:1px solid #e3d3f5;border-radius:6px;padding:8px 12px;margin-bottom:12px;">
        ⚡ Активирован динамический расчёт — ступени градации задаются компенсацией (тип и значение), а не фиксированной ценой.
      </div>` : ''}
      <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:#555;margin-bottom:8px;cursor:pointer;">
        <input type="checkbox" data-sz-include-grad style="width:15px;height:15px;cursor:pointer;">
        <span>Градация цен <span style="color:#888;">(пустая таблица при включённой галочке = очистить градацию)</span></span>
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
      summary.style.cssText = 'cursor:pointer;font-size:16px;font-weight:600;color:#555;user-select:none;padding:4px 0;';
      summary.textContent = label;
      details.appendChild(summary);
      details.appendChild(content);
      section.appendChild(details);
    } else {
      const titleEl = document.createElement('div');
      titleEl.style.cssText = 'font-size:16px;font-weight:700;color:#333;margin-bottom:8px;';
      titleEl.textContent = label;
      section.appendChild(titleEl);
      section.appendChild(content);
    }
    return section;
  }

  async function onEditConditions() {
    const projectId = getProjectId();
    const shopId    = getShopId();
    if (!projectId) { showToast('Не удалось определить Project ID. Обновите страницу.', 'error'); return; }
    if (!shopId)    { showToast('Не удалось определить ID заведения', 'error'); return; }
    showToast('Загружаем данные...', 'info');
    let doc, typeNameMap;
    try {
      doc = await getDoc(projectId, shopId);
      if (!doc) { showToast('Заведение не найдено', 'error'); return; }
      const allRefs = new Set();
      for (const zone of (doc.deliveryZones || []))
        for (const dtp of (zone.deliveryTypePrices || []))
          if (dtp.deliveryType?._ref) allRefs.add(dtp.deliveryType._ref);
      typeNameMap = await resolveDeliveryTypeNames(projectId, [...allRefs]);
    } catch (e) {
      showToast('Ошибка загрузки: ' + e.message, 'error'); return;
    }

    const zoneNames   = getCheckedZoneNames();
    const targetZones = zoneNames
      ? (doc.deliveryZones || []).filter(z => zoneNames.includes(z.name))
      : (doc.deliveryZones || []);
    if (targetZones.length === 0) { showToast('Нет зон для редактирования', 'warning'); return; }

    const firstZone = targetZones[0];
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

    const overlay = document.createElement('div');
    overlay.id = 'sz-edit-modal';
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:999998;
      background:rgba(0,0,0,0.45);
      display:flex;align-items:center;justify-content:center;
      font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    `;
    const modal = document.createElement('div');
    modal.style.cssText = `
      background:#fff;border-radius:12px;padding:32px;
      width:760px;max-width:96vw;max-height:90vh;
      overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.25);
      position:relative;
      font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    `;
    const title = document.createElement('div');
    title.style.cssText = 'font-size:22px;font-weight:700;margin-bottom:6px;';
    title.textContent = '✏️ Изменить условия доставки';
    const subtitle = document.createElement('div');
    subtitle.style.cssText = 'font-size:15px;color:#888;margin-bottom:20px;';
    subtitle.textContent = `Зоны: ${targetZones.map(z => z.name).join(', ')}`;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'position:absolute;top:20px;right:22px;background:none;border:none;font-size:24px;cursor:pointer;color:#999;line-height:1;';
    closeBtn.addEventListener('click', () => overlay.remove());

    modal.appendChild(closeBtn);
    modal.appendChild(title);
    modal.appendChild(subtitle);

    for (let i = 0; i < allTypeNames.length; i++) {
      modal.appendChild(buildDeliveryTypeSection(allTypeNames[i], dtpByName[allTypeNames[i]] || null, allTypeNames[i] !== 'Доставка', projectId, mealNameMap));
    }

    // --- БЛОК МАССОВОГО ПРИМЕНЕНИЯ ---
    const massApplyWrap = document.createElement('div');
    massApplyWrap.style.cssText = 'margin-top:22px; padding:16px; background:#fef2f2; border:2px solid #f3b6b6; border-radius:8px;';
    massApplyWrap.innerHTML = `
      <label style="display:flex;align-items:center;gap:10px;font-size:15px;color:#333;cursor:pointer;font-weight:600;">
        <input type="checkbox" id="sz-mass-toggle" style="width:18px;height:18px;accent-color:#d64236;">
        <span>⚠️ Применить к нескольким ресторанам <span style="color:#b3261e;font-weight:700;">— будь внимателен!</span></span>
      </label>
      <div style="font-size:13px;color:#a13a34;margin-top:6px;margin-left:28px;">
        Эта операция задевает сразу много ресторанов. Ошибку здесь не откатить одним кликом —
        восстановление из бэкапа придётся делать вручную и это долго. Дважды проверьте выбор
        зон и условий перед тем, как жать «Применить».
      </div>
      <div id="sz-mass-content" style="display:none; margin-top:15px; border-top:1px solid #f3b6b6; padding-top:15px;">
        <label style="display:flex;align-items:center;gap:10px;font-size:14px;color:#333;cursor:pointer;font-weight:600;background:#fff3cd;border:1px solid #ffe08a;border-radius:6px;padding:8px 12px;margin-bottom:12px;">
          <input type="checkbox" id="sz-select-all-global" style="width:17px;height:17px;accent-color:#e67e22;cursor:pointer;">
          🌍 Применить ко всем зонам во всех ресторанах (кроме архивных)
        </label>
        <button id="sz-load-shops-btn" style="padding:10px 14px; border:1px solid #4a90e2; background:#4a90e2; color:#fff; border-radius:6px; cursor:pointer; font-weight:600;">
          🔄 Загрузить список ресторанов и зон
        </button>
        <div style="font-size:13px;color:#888;margin-top:8px;">
          У каждого ресторана могут быть зоны с разными названиями — раскройте ресторан (клик по стрелке ▸ слева) и отметьте
          галочками именно те зоны, куда нужно перенести условия. Рестораны без зон показаны в конце списка.
        </div>
        <div id="sz-shops-container" style="display:none; margin-top:15px;"></div>
      </div>
    `;
    modal.appendChild(massApplyWrap);

    const backupWrap = document.createElement('label');
    backupWrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;color:#555;margin-top:18px;cursor:pointer;';
    backupWrap.innerHTML = `
      <input type="checkbox" id="sz-backup-before" checked style="width:16px;height:16px;cursor:pointer;">
      <span>Скачать бэкап зон в JSON перед применением <span style="color:#888;">(снимок состояния затронутых зон до изменений — файл сохранится в папку загрузок браузера, пригодится для отката вручную)</span></span>
    `;
    modal.appendChild(backupWrap);
    const backupBeforeCb = backupWrap.querySelector('#sz-backup-before');

    const publishWrap = document.createElement('label');
    publishWrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;color:#555;margin-top:14px;cursor:pointer;';
    publishWrap.innerHTML = `
      <input type="checkbox" id="sz-auto-publish" style="width:16px;height:16px;cursor:pointer;">
      <span>Опубликовать сразу после применения <span style="color:#888;">(иначе изменения останутся черновиком — сохранятся, но не будут видны на сайте, пока вы не нажмёте «Опубликовать» вручную. Скрипт запоминает свои же правки — если черновик с прошлого раза никто, кроме скрипта, не трогал, публикация пройдёт автоматически; если в нём есть посторонние изменения — она пропускается. Для текущего открытого ресторана публикация также не пройдёт, если сама Studio показывает ошибку валидации)</span></span>
    `;
    modal.appendChild(publishWrap);
    const autoPublishCb = publishWrap.querySelector('#sz-auto-publish');

    const forcePublishWrap = document.createElement('label');
    forcePublishWrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;color:#a15c00;margin-top:8px;margin-left:26px;cursor:pointer;';
    forcePublishWrap.innerHTML = `
      <input type="checkbox" id="sz-force-publish" style="width:15px;height:15px;cursor:pointer;">
      <span>🔓 Разрешить публикацию, даже если в ресторане есть посторонние неопубликованные изменения <span style="color:#c98a3a;">(они тоже уйдут в публикацию вместе с вашими — используйте, только если уверены, что ничего чужого не потеряется)</span></span>
    `;
    modal.appendChild(forcePublishWrap);
    const forcePublishCb = forcePublishWrap.querySelector('#sz-force-publish');

    const preflightWrap = document.createElement('label');
    preflightWrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;color:#555;margin-top:8px;margin-left:26px;cursor:pointer;';
    preflightWrap.innerHTML = `
      <input type="checkbox" id="sz-preflight-validation" checked style="width:15px;height:15px;cursor:pointer;">
      <span>🛡️ Перед массовой публикацией проверить валидацию во всех выбранных ресторанах <span style="color:#888;">(медленнее — скрипт по очереди открывает каждый ресторан, ~1–2 сек на ресторан. Если хотя бы у одного не заполнены обязательные поля — публикация всей партии блокируется целиком, ни один ресторан не публикуется, пока поля не будут заполнены вручную)</span></span>
    `;
    modal.appendChild(preflightWrap);
    const preflightValidationCb = preflightWrap.querySelector('#sz-preflight-validation');

    const reloadWrap = document.createElement('label');
    reloadWrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;color:#555;margin-top:14px;cursor:pointer;';
    reloadWrap.innerHTML = `
      <input type="checkbox" id="sz-reload-after" style="width:16px;height:16px;cursor:pointer;">
      <span>Обновить страницу после применения <span style="color:#888;">(список «Все заведения» иногда не пересчитывает порядок сам — обновление страницы это исправляет; произойдёт через несколько секунд, после того как вы увидите итоговое сообщение)</span></span>
    `;
    modal.appendChild(reloadWrap);
    const reloadAfterCb = reloadWrap.querySelector('#sz-reload-after');

    const applyBtn = document.createElement('button');
    applyBtn.textContent = '✅ Применить';
    applyBtn.style.cssText = `
      margin-top:14px;width:100%;padding:15px;
      background:#4a90e2;color:#fff;border:none;border-radius:8px;
      font-size:16px;font-weight:700;cursor:pointer;
    `;

    // Логика загрузки двухуровневого списка ресторан → зоны
    let lastLoadedShops = null;
    const massToggle = massApplyWrap.querySelector('#sz-mass-toggle');
    const massContent = massApplyWrap.querySelector('#sz-mass-content');
    const loadShopsBtn = massApplyWrap.querySelector('#sz-load-shops-btn');
    const shopsContainer = massApplyWrap.querySelector('#sz-shops-container');
    const selectAllGlobalCb = massApplyWrap.querySelector('#sz-select-all-global');

    massToggle.addEventListener('change', () => {
      massContent.style.display = massToggle.checked ? 'block' : 'none';
      if (massToggle.checked) loadShopsBtn.click();
    });

    selectAllGlobalCb.addEventListener('change', () => {
      if (selectAllGlobalCb.checked) {
        if (!lastLoadedShops) loadShopsBtn.click();
        shopsContainer.style.opacity = '0.4';
        shopsContainer.style.pointerEvents = 'none';
      } else {
        shopsContainer.style.opacity = '1';
        shopsContainer.style.pointerEvents = 'auto';
      }
    });

    loadShopsBtn.addEventListener('click', async () => {
      loadShopsBtn.textContent = '⏳ Загрузка...';
      loadShopsBtn.disabled = true;
      try {
        const shops = await fetchAllShops(projectId);
        // Рестораны без зон переносим в конец списка (сортировка стабильна,
        // порядок name.ru asc внутри каждой группы сохраняется)
        shops.sort((a, b) => {
          const aEmpty = (a.zones || []).length === 0;
          const bEmpty = (b.zones || []).length === 0;
          if (aEmpty === bEmpty) return 0;
          return aEmpty ? 1 : -1;
        });
        lastLoadedShops = shops;
        shopsContainer.innerHTML = '';
        if (shops.length === 0) {
          shopsContainer.innerHTML = '<div style="color:#888;">Рестораны не найдены</div>';
        } else {
          const searchBox = document.createElement('input');
          searchBox.type = 'text';
          searchBox.placeholder = 'Поиск по названию ресторана...';
          searchBox.style.cssText = 'width:100%; padding:8px; margin-bottom:10px; border:1px solid #ccc; border-radius:6px; box-sizing:border-box;';
          shopsContainer.appendChild(searchBox);

          const globalActions = document.createElement('div');
          globalActions.style.cssText = 'display:flex; gap:14px; margin-bottom:8px; font-size:13px;';
          globalActions.innerHTML = `
            <a href="#" data-sz-expand-all style="color:#4a90e2; text-decoration:none;">Развернуть все</a>
            <a href="#" data-sz-collapse-all style="color:#4a90e2; text-decoration:none;">Свернуть все</a>
          `;
          shopsContainer.appendChild(globalActions);

          const shopsList = document.createElement('div');
          shopsList.style.cssText = 'max-height:340px; overflow-y:auto; border:1px solid #eee; border-radius:6px; padding:10px;';

          for (const shop of shops) {
            const zones = shop.zones || [];
            const shopDetails = document.createElement('details');
            shopDetails.setAttribute('data-sz-shop-block', shop._id);
            shopDetails.style.cssText = 'border:1px solid #eee; border-radius:6px; margin-bottom:6px; padding:6px 10px;';
            shopDetails.dataset.shopName = (shop.name?.ru || '').toLowerCase();

            const summary = document.createElement('summary');
            summary.style.cssText = 'display:flex; align-items:center; gap:8px; cursor:pointer; list-style:none;';

            const chevron = document.createElement('span');
            chevron.textContent = zones.length > 0 ? '▸' : '';
            chevron.title = zones.length > 0 ? 'Развернуть/свернуть зоны' : '';
            chevron.style.cssText = 'display:inline-flex; align-items:center; justify-content:center; width:18px; flex-shrink:0; color:#444; font-size:18px; font-weight:700; transition:transform 0.15s ease;';

            const shopAllCb = document.createElement('input');
            shopAllCb.type = 'checkbox';
            shopAllCb.setAttribute('data-sz-shop-all', shop._id);
            shopAllCb.style.cssText = 'width:16px;height:16px;cursor:pointer;flex-shrink:0;';
            shopAllCb.disabled = zones.length === 0;
            shopAllCb.addEventListener('click', e => e.stopPropagation());

            const labelSpan = document.createElement('span');
            const addressStr = `${shop.address?.street?.ru || ''} ${shop.address?.house?.ru || ''}`.trim();
            labelSpan.textContent = `${shop.name?.ru || shop._id}${addressStr ? ' (' + addressStr + ')' : ''} — ${zones.length} ${zones.length === 1 ? 'зона' : 'зон'}`;
            labelSpan.style.cssText = zones.length === 0 ? 'color:#bbb;' : '';

            summary.appendChild(chevron);
            summary.appendChild(shopAllCb);
            summary.appendChild(labelSpan);
            shopDetails.appendChild(summary);

            if (zones.length > 0) {
              shopDetails.addEventListener('toggle', () => {
                chevron.style.transform = shopDetails.open ? 'rotate(90deg)' : 'rotate(0deg)';
              });
              const zonesWrap = document.createElement('div');
              zonesWrap.style.cssText = 'margin-top:8px; padding-left:26px; display:flex; flex-direction:column; gap:5px;';

              for (const zone of zones) {
                const zLabel = document.createElement('label');
                zLabel.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:14px; color:#333; cursor:pointer;';
                const zCb = document.createElement('input');
                zCb.type = 'checkbox';
                zCb.setAttribute('data-sz-shop-id', shop._id);
                zCb.setAttribute('data-sz-zone-key', zone._key);
                zCb.style.cssText = 'width:15px;height:15px;cursor:pointer;flex-shrink:0;';
                const zSpan = document.createElement('span');
                zSpan.textContent = zone.name || '(без названия)';
                zLabel.appendChild(zCb);
                zLabel.appendChild(zSpan);
                zonesWrap.appendChild(zLabel);
              }

              shopAllCb.addEventListener('change', () => {
                zonesWrap.querySelectorAll('input[data-sz-zone-key]').forEach(cb => { cb.checked = shopAllCb.checked; });
              });
              zonesWrap.addEventListener('change', () => {
                const all    = zonesWrap.querySelectorAll('input[data-sz-zone-key]');
                const checked = zonesWrap.querySelectorAll('input[data-sz-zone-key]:checked');
                shopAllCb.checked       = all.length > 0 && checked.length === all.length;
                shopAllCb.indeterminate = checked.length > 0 && checked.length < all.length;
              });

              shopDetails.appendChild(zonesWrap);
            }

            shopsList.appendChild(shopDetails);
          }

          shopsContainer.appendChild(shopsList);

          searchBox.addEventListener('input', () => {
            const term = searchBox.value.toLowerCase();
            shopsList.querySelectorAll('details[data-sz-shop-block]').forEach(d => {
              d.style.display = (d.dataset.shopName || '').includes(term) ? '' : 'none';
            });
          });

          globalActions.querySelector('[data-sz-expand-all]').addEventListener('click', e => {
            e.preventDefault();
            shopsList.querySelectorAll('details[data-sz-shop-block]').forEach(d => { d.open = true; });
          });
          globalActions.querySelector('[data-sz-collapse-all]').addEventListener('click', e => {
            e.preventDefault();
            shopsList.querySelectorAll('details[data-sz-shop-block]').forEach(d => { d.open = false; });
          });
        }
        shopsContainer.style.display = 'block';
        if (selectAllGlobalCb.checked) {
          shopsContainer.style.opacity = '0.4';
          shopsContainer.style.pointerEvents = 'none';
        }
      } catch(e) {
        showToast('Ошибка загрузки списка: ' + e.message, 'error');
      } finally {
        loadShopsBtn.textContent = '🔄 Загрузить список ресторанов и зон';
        loadShopsBtn.disabled = false;
      }
    });

    // Собирает выбор пользователя как карту { shopId: [zoneKey, zoneKey, ...] }.
    // Если включён глобальный чекбокс — берём все зоны всех загруженных ресторанов
    // (у ресторанов без зон массив зон просто пуст и они будут пропущены).
    function collectSelectedShopZones() {
      if (selectAllGlobalCb.checked) {
        const map = {};
        for (const shop of (lastLoadedShops || [])) {
          const zones = shop.zones || [];
          if (zones.length === 0) continue;
          map[shop._id] = zones.map(z => z._key);
        }
        return map;
      }
      const map = {};
      shopsContainer.querySelectorAll('input[data-sz-zone-key]:checked').forEach(cb => {
        const shopId  = cb.getAttribute('data-sz-shop-id');
        const zoneKey = cb.getAttribute('data-sz-zone-key');
        (map[shopId] ||= []).push(zoneKey);
      });
      return map;
    }

    applyBtn.addEventListener('click', () => {
      const missingProducts = collectMissingProductWarnings(modal, allTypeNames);
      if (missingProducts.length > 0) {
        showToast(
          '⛔ Нельзя применить — для платной доставки обязательно нужно указать блюдо из каталога:\n' +
          missingProducts.map(w => `• ${w}`).join('\n') +
          '\n\nОткройте 🔍 у соответствующего поля и выберите блюдо.',
          'error', 15000
        );
        return;
      }
      const isMassApply  = massToggle.checked;
      const autoPublish  = autoPublishCb.checked;
      const forcePublish = forcePublishCb.checked;
      const reloadAfter  = reloadAfterCb.checked;
      const backupBefore = backupBeforeCb.checked;
      const preflightValidation = preflightValidationCb.checked;
      let selectedShopZones = {};
      if (isMassApply) {
        selectedShopZones = collectSelectedShopZones();
        if (Object.keys(selectedShopZones).length === 0) {
          showToast('Отметьте хотя бы одну зону хотя бы в одном ресторане (или включите «Применить ко всем зонам во всех ресторанах»)', 'warning');
          return;
        }
      }
      const doApply = () => {
        applyConditions(overlay, modal, projectId, shopId, doc, targetZones, typeNameMap, allTypeNames, isMassApply, selectedShopZones, autoPublish, reloadAfter, backupBefore, forcePublish, preflightValidation);
      };

      if (isMassApply) {
        showMassApplyConfirm(Object.keys(selectedShopZones).length, doApply);
      } else {
        doApply();
      }
    });

    modal.appendChild(applyBtn);
    overlay.appendChild(modal);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
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

  async function applyConditions(overlay, modal, projectId, currentShopId, currentDoc, currentTargetZones, currentTypeNameMap, allTypeNames, isMassApply, selectedShopZones, autoPublish, reloadAfter, backupBefore, forcePublish, preflightValidation) {
    const changes  = {};
    const typeMeta = {};
    for (const typeName of allTypeNames) {
      const section = modal.querySelector(`[data-sz-section="${typeName}"]`);
      if (!section) continue;
      const dynamicCalc    = section.getAttribute('data-sz-dynamic-calc') === '1';
      const priceFieldName = section.getAttribute('data-sz-price-field') || 'defaultDeliveryPrice';
      typeMeta[typeName] = { dynamicCalc, priceFieldName };

      const entry = {};
      section.querySelectorAll('[data-sz-field]').forEach(input => {
        const fieldName  = input.getAttribute('data-sz-field');
        const includeCb  = section.querySelector(`[data-sz-include="${fieldName}"]`);
        if (!includeCb?.checked) return;
        const val = input.value.trim();
        entry[fieldName] = val === '' ? undefined : parseFloat(val);
      });
      // Убираем поля, которые отмечены галочкой, но оставлены пустыми — применять нечего
      for (const key of Object.keys(entry)) {
        if (entry[key] === undefined || isNaN(entry[key])) delete entry[key];
      }

      // "Позиция для доставки из POS-системы" для цены по умолчанию идёт в паре с
      // самой ценой — сохраняем её выбор, только если галочка цены по умолчанию
      // включена. null означает "снять ссылку" (явно нажали ✕ в поиске блюда) —
      // применяющий код ниже превращает такие поля в unset вместо set.
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
    if (Object.keys(changes).length === 0) { showToast('Нет изменений для применения', 'warning'); return; }

    overlay.remove();

    // Одиночное применение (оригинальный функционал, без изменений)
    if (!isMassApply) {
      if (backupBefore) {
        downloadJson(backupFilename(`sanity-backup_${currentDoc.name?.ru || currentShopId}`), {
          createdAt: new Date().toISOString(),
          projectId,
          operation: 'single-apply',
          shopId: currentShopId,
          shopName: currentDoc.name?.ru || null,
          typesChanged: Object.keys(changes),
          zonesBackup: currentTargetZones
        });
      }
      showToast('Применяем изменения...', 'info');
      try {
        const draftId  = 'drafts.' + currentShopId;
        const hasDraft = currentDoc._id.startsWith('drafts.');
        // "Свой" черновик — это либо новый (мы его сейчас создаём), либо уже существующий,
        // но с ревизией, совпадающей с той, что скрипт сам оставил в прошлый раз.
        const ownedRev     = hasDraft ? getOwnedDraftRev(projectId, currentShopId) : null;
        const isKnownOwned = !hasDraft || (ownedRev !== null && ownedRev === currentDoc._rev);
        const isForeignDraft = hasDraft && !isKnownOwned;
        const mutations = [];
        if (!hasDraft) {
          const { documents } = await (await apiFetch(projectId, `/data/doc/production/${currentShopId}`)).json();
          mutations.push({ createIfNotExists: { ...documents[0], _id: draftId } });
        }

        const priceWarnings = [];
        for (const zone of currentTargetZones) {
          for (const dtp of (zone.deliveryTypePrices || [])) {
            const typeName = currentTypeNameMap[dtp.deliveryType?._ref];
            const change   = changes[typeName];
            if (!change) continue;
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

        if (mutations.length === 0) { showToast('Не найдены совпадающие типы доставки в зонах', 'warning'); return; }

        const r = await apiFetch(projectId, `/data/mutate/production?returnIds=true&returnDocuments=true`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mutations })
        });
        const result = await r.json();
        if (r.ok) {
          // Патч прошёл успешно. Если весь черновик был (или стал) полностью "нашим" —
          // запоминаем новую ревизию, чтобы в следующий раз распознать его как свой.
          const draftResult = result.results?.find(x => x.id === draftId);
          const newRev = draftResult?.document?._rev || null;
          if (isKnownOwned) setOwnedDraftRev(projectId, currentShopId, newRev);

          let published = false;
          let publishError = null;
          let publishSkipped = false;
          let skipReason = null; // 'foreign' | 'validation'
          if (autoPublish) {
            if (isForeignDraft && !forcePublish) {
              // В черновике есть правки, оставленные не этим скриптом (или другим браузером/
              // компьютером без той же localStorage-метки) — публиковать их вслепую нельзя.
              publishSkipped = true;
              skipReason = 'foreign';
            } else if (hasStudioValidationError()) {
              // Сама Studio уже посчитала и показала ошибку валидации на этой странице
              // (панель "Валидация" справа) — какая бы кастомная проверка ни сработала,
              // публиковать нельзя, пока она не исправлена.
              publishSkipped = true;
              skipReason = 'validation';
            } else {
              try {
                published = await publishDoc(projectId, currentShopId);
                if (published) clearOwnedDraftRev(projectId, currentShopId);
              }
              catch (e) { publishError = e.message; }
            }
          }
          let msg = `✅ Условия обновлены в ${currentTargetZones.length} зон(ах):\n` + Object.keys(changes).map(t => `• ${t}`).join('\n');
          if (published) {
            msg += '\n\n✅ Опубликовано';
          } else if (publishSkipped && skipReason === 'validation') {
            msg += '\n\n⏸ Публикация пропущена: Studio показывает ошибки валидации на этой странице (см. панель «Валидация» справа) — исправьте и опубликуйте вручную.';
          } else if (publishSkipped) {
            msg += '\n\n⏸ Публикация пропущена: в этом ресторане уже есть другие неопубликованные изменения — требуется ручная проверка перед публикацией (или включите «Разрешить публикацию поверх посторонних изменений»).';
          } else if (autoPublish) {
            msg += `\n\n⚠️ Не удалось опубликовать автоматически: ${publishError}. Нажмите «Опубликовать» вручную.`;
          } else {
            msg += '\n\nНажмите «Опубликовать»';
          }
          let type = (publishSkipped || (priceWarnings.length > 0)) ? 'warning' : 'success';
          if (priceWarnings.length > 0) {
            msg += '\n\n⚠️ Проверьте «Позицию для доставки»:\n' + priceWarnings.map(w => `• ${w}`).join('\n');
          }
          const toastDuration = (publishSkipped || priceWarnings.length > 0) ? 12000 : 5000;
          showToast(msg, type, toastDuration);
          if (reloadAfter) setTimeout(() => location.reload(), toastDuration + 500);
        } else {
          showToast('Ошибка Sanity: ' + JSON.stringify(result?.error || result), 'error');
        }
      } catch (e) {
        showToast('Ошибка: ' + e.message, 'error');
      }
      return;
    }

    // --- МАССОВОЕ ПРИМЕНЕНИЕ (по явно выбранным зонам в каждом ресторане) ---
    const shopIds = Object.keys(selectedShopZones);

    // Предполётная проверка: если публикуем автоматически, сначала убеждаемся,
    // что ВСЕ выбранные рестораны проходят валидацию Studio. Если хотя бы один
    // не проходит — блокируем ВСЮ операцию целиком, ни один ресторан не трогаем.
    if (autoPublish && preflightValidation) {
      const workspace    = currentWorkspace();
      const originalPath = location.pathname;
      showToast(`Проверяем валидацию ${shopIds.length} ресторан(ов) перед публикацией...`, 'info', 3000);
      let invalidShops;
      try {
        invalidShops = await checkShopsValidationBeforePublish(workspace, shopIds, originalPath, true);
      } catch (e) {
        showToast('Не удалось проверить валидацию: ' + e.message + '. Массовая публикация отменена — попробуйте ещё раз или снимите галочку предполётной проверки.', 'error', 15000);
        return;
      }
      if (invalidShops.length > 0) {
        const list = invalidShops.map(s => `• ${s.shopName}`).join('\n');
        showToast(
          `⛔ Массовая публикация заблокирована.\n\n` +
          `У ${invalidShops.length} из ${shopIds.length} ресторан(ов) не заполнены обязательные поля ` +
          `(валидация Studio не пройдена):\n${list}\n\n` +
          `Сначала заполните обязательные поля в этих ресторанах вручную в интерфейсе, ` +
          `и только потом повторите массовое применение. Ни один ресторан не был изменён.`,
          'error', 25000
        );
        return;
      }
      showToast('Валидация пройдена во всех ресторанах, продолжаем...', 'success', 2000);
    }

    let progress = 0;
    const total = shopIds.length;
    const allWarnings = [];
    const publishSkippedWarnings = [];
    const massBackups = [];

    for (const shopId of shopIds) {
      progress++;
      showToast(`Массовое обновление: ${progress} из ${total}...`, 'info', 2000);
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

        if (backupBefore) {
          massBackups.push({ shopId, shopName: doc.name?.ru || null, zones: targetZones });
        }

        const draftId = 'drafts.' + shopId;
        const hasDraft = doc._id.startsWith('drafts.');
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
            const change = changes[typeName];
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
          }
        }

        for (const typeName of Object.keys(changes)) {
          if (!appliedTypes.has(typeName)) {
            allWarnings.push(`${doc.name?.ru || shopId}: в выбранных зонах нет типа "${typeName}"`);
          }
        }

        if (mutations.length > 0) {
          const r = await apiFetch(projectId, `/data/mutate/production?returnIds=true&returnDocuments=true`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mutations })
          });
          if (!r.ok) {
            const result = await r.json();
            allWarnings.push(`${doc.name?.ru || shopId}: ошибка Sanity - ${JSON.stringify(result?.error)}`);
          } else {
            const mutateResult = await r.json();
            const draftResult  = mutateResult.results?.find(x => x.id === draftId);
            const newRev = draftResult?.document?._rev || null;
            if (isKnownOwned) setOwnedDraftRev(projectId, shopId, newRev);

            if (autoPublish) {
              if (isForeignDraft && !forcePublish) {
                // В черновике есть правки не от этого скрипта — публиковать их вслепую нельзя,
                // нужна ручная проверка в интерфейсе (или включите «Разрешить публикацию
                // поверх посторонних изменений»).
                publishSkippedWarnings.push(`${doc.name?.ru || shopId}: есть другие неопубликованные изменения — публикация пропущена`);
              } else {
                try {
                  await publishDoc(projectId, shopId);
                  clearOwnedDraftRev(projectId, shopId);
                }
                catch (e) { allWarnings.push(`${doc.name?.ru || shopId}: изменения сохранены, но публикация не удалась - ${e.message}`); }
              }
            }
          }
        }
      } catch(e) {
        allWarnings.push(`${shopId}: ${e.message}`);
      }
      // Задержка 300мс для стабильности API
      await new Promise(r => setTimeout(r, 300));
    }

    if (backupBefore && massBackups.length > 0) {
      downloadJson(backupFilename('sanity-backup_mass-apply'), {
        createdAt: new Date().toISOString(),
        projectId,
        operation: 'mass-apply',
        typesChanged: Object.keys(changes),
        shopsCount: massBackups.length,
        shops: massBackups
      });
    }

    let msg = autoPublish
      ? `✅ Массовое обновление завершено (${total} ресторанов).`
      : `✅ Массовое обновление завершено (${total} ресторанов).\nНажмите «Опубликовать» в интерфейсах обновленных ресторанов.`;
    let toastType = 'success';
    if (publishSkippedWarnings.length > 0) {
      msg += `\n\n⏸ Публикация пропущена (${publishSkippedWarnings.length}) — в этих ресторанах уже были другие неопубликованные изменения, нужна ручная проверка перед публикацией:\n`
        + publishSkippedWarnings.slice(0, 30).map(w => `• ${w}`).join('\n');
      if (publishSkippedWarnings.length > 30) msg += `\n...и еще ${publishSkippedWarnings.length - 30}`;
      toastType = 'warning';
    }
    if (allWarnings.length > 0) {
      msg += `\n\n⚠️ Предупреждения (${allWarnings.length}):\n` + allWarnings.slice(0, 30).join('\n');
      if (allWarnings.length > 30) msg += `\n...и еще ${allWarnings.length - 30}`;
      toastType = 'warning';
    }
    if (toastType === 'warning') {
      showToast(msg, 'warning', 15000);
      if (reloadAfter) setTimeout(() => location.reload(), 15500);
    } else {
      showToast(msg, 'success', 8000);
      if (reloadAfter) setTimeout(() => location.reload(), 8500);
    }
  }

  function createButton(text, color, onClick) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `
      flex:1; padding:10px 14px; background:${color}; color:#fff;
      border:none; border-radius:6px; font-size:13px; font-weight:600;
      cursor:pointer; transition:opacity 0.2s; white-space:nowrap;
    `;
    btn.addEventListener('mouseenter', () => btn.style.opacity = '0.85');
    btn.addEventListener('mouseleave', () => btn.style.opacity = '1');
    btn.addEventListener('click', onClick);
    return btn;
  }

  function addCheckboxToZoneItem(preview) {
    let flex = preview;
    for (let i = 0; i < 4; i++) flex = flex.parentElement;
    if (!flex || flex.getAttribute('data-ui') !== 'Flex') return;
    if (flex.getAttribute('data-sz-zone') === 'marked') return;
    const header   = preview.querySelector('[data-testid="default-preview__header"]');
    const zoneName = header?.querySelector('span')?.textContent.trim() || '';
    if (!zoneName) return;
    const rightFlex = flex.children[2];
    if (!rightFlex) return;
    const label = document.createElement('label');
    label.title = 'Выбрать для копирования / редактирования';
    label.style.cssText = 'display:flex; align-items:center; cursor:pointer; padding:0 6px;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.setAttribute('data-sz-checkbox', 'true');
    cb.setAttribute('data-zone-name', zoneName);
    cb.style.cssText = 'width:16px; height:16px; cursor:pointer; accent-color:#4a90e2; flex-shrink:0;';
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', updateCopyButtonLabel);
    label.appendChild(cb);
    rightFlex.insertBefore(label, rightFlex.firstChild);
    flex.setAttribute('data-sz-zone', 'marked');
  }

  function inject() {
    if (isInjecting) return;
    const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
    if (activeTab?.textContent.trim() !== 'Доставка') return;
    const fieldset = document.querySelector('fieldset[data-testid="field-deliveryZones"]');
    if (!fieldset) return;
    const previews   = fieldset.querySelectorAll('[data-testid="default-preview"]');
    const hasButtons = !!fieldset.querySelector('[data-sz-wrapper]');
    const allHaveCb  = Array.from(previews).every(p => {
      let flex = p;
      for (let i = 0; i < 4; i++) flex = flex.parentElement;
      return flex?.getAttribute('data-sz-zone') === 'marked';
    });
    if (hasButtons && allHaveCb) return;
    isInjecting = true;
    observer.disconnect();
    try {
      previews.forEach(p => addCheckboxToZoneItem(p));
      if (!hasButtons) {
        const addBtn = fieldset.querySelector('button[data-testid="add-single-object-button"]');
        if (addBtn) {
          const stack = addBtn.parentElement?.parentElement;
          if (stack) {
            fieldset.querySelector('[data-sz-btn]')?.remove();
            const wrapper = document.createElement('div');
            wrapper.setAttribute('data-sz-btn', 'true');
            wrapper.setAttribute('data-sz-wrapper', 'true');
            wrapper.style.cssText = 'margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;';
            const copyWrap = document.createElement('span');
            copyWrap.setAttribute('data-sz-copy-btn', 'true');
            copyWrap.style.cssText = 'flex:1;display:flex;';
            copyWrap.appendChild(createButton('📋 Копировать все зоны', '#4a90e2', onCopy));
            wrapper.appendChild(copyWrap);
            wrapper.appendChild(createButton('📌 Вставить зоны', '#27ae60', onPaste));
            wrapper.appendChild(createButton('✏️ Условия',       '#8e44ad', onEditConditions));
            stack.appendChild(wrapper);
          }
        }
      }
    } finally {
      isInjecting = false;
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(inject, 150);
  });

  function startObserving() {
    observer.observe(document.body, { childList: true, subtree: true });
    inject();
  }

  if (document.body) {
    startObserving();
  } else {
    document.addEventListener('DOMContentLoaded', startObserving, { once: true });
  }

})();
