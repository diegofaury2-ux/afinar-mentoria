// sync.js — Programa Afinar (mentoria) — sync robusto in-place, multi-chave.
// Baseado no sync dos radares Hithammers, adaptado para o modelo do Afinar:
// o app guarda VÁRIAS chaves no localStorage (afinar_v4::<nome>::<ano>-<mes>
// por registro + afinar_v4_colaboradores), não um blob único.
//
// - Hidrata da nuvem ANTES do boot (a nuvem é a fonte da verdade).
// - Intercepta setItem/removeItem das chaves afinar_v4* e envia as MUDANÇAS
//   (só as chaves alteradas/removidas), com debounce ~1s.
// - Poll a cada 6s: se a versão da nuvem mudou, aplica IN-PLACE (atualiza o
//   localStorage e chama window.__afinarReload) SEM recarregar a página.
//   Se o usuário estiver digitando (campo focado / modal aberto), mostra um
//   aviso "Atualizar" em vez de sobrescrever.
// - O servidor faz MERGE por chave e, nos registros, por campo (lado do
//   colaborador vs lado do gestor), então salvamentos simultâneos não se
//   apagam.
(function () {
  const API = '/api/state';
  const PREFIX = 'afinar_v4';          // toda chave do app começa com isto
  const POLL_MS = 6000;
  const DEBOUNCE_MS = 1000;

  let _ver = 0;
  let ready = false;
  let pushTimer = null, pushing = false, pendingPush = false;
  let checking = false, applying = false;

  // originais (não interceptados) para evitar eco
  const _set = localStorage.setItem.bind(localStorage);
  const _get = localStorage.getItem.bind(localStorage);
  const _remove = localStorage.removeItem.bind(localStorage);

  // afinar_v4_notas:: são as anotações pessoais do colaborador: nunca sobem
  // para a nuvem, senão o mentor passaria a enxergá-las ao puxar o estado.
  const PREFIX_PRIVADO = 'afinar_v4_notas::';
  const isAfinarKey = k => typeof k === 'string' && k.indexOf(PREFIX) === 0 && k.indexOf(PREFIX_PRIVADO) !== 0;
  function cloudData(j) {
    if (j && j.data !== undefined && j.data !== null) return j.data;
    return null;
  }
  function hasData(d) { return d && typeof d === 'object' && Object.keys(d).length > 0; }

  // mudanças locais pendentes desde o último envio
  let pendingSet = {};       // { chave: valor }
  const pendingDel = new Set(); // chaves removidas
  function anyPending() { return Object.keys(pendingSet).length > 0 || pendingDel.size > 0; }

  function localAfinarKeys() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (isAfinarKey(k)) out.push(k); }
    return out;
  }

  function applyToApp() {
    try { if (typeof window.__afinarReload === 'function') window.__afinarReload(); }
    catch (e) { console.warn('[sync] reload', e); }
  }

  function isEditing() {
    try {
      const ae = document.activeElement;
      if (ae) {
        if (ae.tagName === 'TEXTAREA' || ae.isContentEditable) return true;
        if (ae.tagName === 'INPUT') {
          const t = (ae.getAttribute('type') || 'text').toLowerCase();
          if (t !== 'checkbox' && t !== 'radio' && t !== 'button' && t !== 'submit' && t !== 'reset') return true;
        }
      }
      if (document.querySelector('.modal-overlay')) return true; // modal do Afinar
    } catch (e) {}
    return false;
  }

  // ── envio (debounce) ────────────────────────────────────────────────────────
  function doPush() {
    if (!ready) return;
    if (pushing) { pendingPush = true; return; }
    if (!anyPending()) return;
    const set = pendingSet; const del = Array.from(pendingDel);
    pendingSet = {}; pendingDel.clear();     // limpa otimista; restaura se falhar
    pushing = true;
    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ set: set, del: del }),
      keepalive: true   // garante que o navegador tenta entregar o POST mesmo se a aba for fechada/navegada no meio do envio
    })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (j && typeof j.v === 'number') _ver = j.v; })
      .catch(() => {
        // offline: devolve as mudanças pra fila e tenta depois
        Object.keys(set).forEach(k => { if (!(k in pendingSet)) pendingSet[k] = set[k]; });
        del.forEach(k => pendingDel.add(k));
      })
      .finally(() => { pushing = false; if (pendingPush || anyPending()) { pendingPush = false; schedulePush(); } });
  }
  function schedulePush() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushTimer = null; doPush(); }, DEBOUNCE_MS);
  }
  function hasPending() { return ready && (!!pushTimer || pushing || pendingPush || anyPending()); }
  function flushNow() { if (!ready) return; if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; } doPush(); }

  // ── intercepta gravações/remoções do app ────────────────────────────────────
  localStorage.setItem = function (k, v) {
    _set(k, v);
    if (ready && isAfinarKey(k)) { pendingSet[k] = v; pendingDel.delete(k); schedulePush(); }
  };
  localStorage.removeItem = function (k) {
    _remove(k);
    if (ready && isAfinarKey(k)) { pendingDel.add(k); delete pendingSet[k]; schedulePush(); }
  };

  // ── escreve o mapa da nuvem no localStorage (sem eco) ────────────────────────
  function writeCloudToLocal(data) {
    const cloudKeys = Object.keys(data);
    // remove chaves locais que sumiram da nuvem (deleções feitas por outros)
    localAfinarKeys().forEach(k => { if (!(k in data)) _remove(k); });
    cloudKeys.forEach(k => { _set(k, typeof data[k] === 'string' ? data[k] : JSON.stringify(data[k])); });
  }

  // ── aplica mudança remota IN-PLACE ──────────────────────────────────────────
  function applyRemote() {
    if (applying) return;
    applying = true;
    fetch(API + '?t=' + Date.now())
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        const d = j ? cloudData(j) : null;
        if (!d || typeof d !== 'object') return;
        if (j && typeof j.v === 'number') _ver = j.v;
        writeCloudToLocal(d);
        applyToApp();
        const b = document.getElementById('__cloudUpdate'); if (b) b.remove();
      })
      .catch(() => {})
      .finally(() => { applying = false; });
  }

  function showUpdateBanner() {
    if (document.getElementById('__cloudUpdate')) return;
    const d = document.createElement('div');
    d.id = '__cloudUpdate';
    d.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;' +
      'background:#d0104a;color:#fff;padding:13px 18px;border-radius:10px;font-family:sans-serif;font-size:14px;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.45);max-width:92vw;line-height:1.4';
    d.innerHTML = '🔄 Outra pessoa salvou alterações. Termine sua edição e ' +
      '<button id="__cloudUpdateBtn" style="margin-left:6px;background:#c4e01a;color:#0a0a0a;border:0;' +
      'border-radius:6px;padding:7px 14px;font-weight:700;cursor:pointer">Atualizar</button>';
    (document.body || document.documentElement).appendChild(d);
    const btn = document.getElementById('__cloudUpdateBtn');
    if (btn) btn.onclick = applyRemote;
  }

  function checkRemote() {
    if (!ready || checking) return;
    if (hasPending() || pushing) return;
    checking = true;
    fetch(API + '?v=1&t=' + Date.now())
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        const v = (j && typeof j.v === 'number') ? j.v : 0;
        if (v <= _ver) return;
        if (isEditing()) { _ver = v; showUpdateBanner(); }
        else applyRemote();
      })
      .catch(() => {})
      .finally(() => { checking = false; });
  }

  // ── hidratar e então bootar ──────────────────────────────────────────────────
  window.__cloudHydrate = function (bootFn) {
    fetch(API + '?t=' + Date.now())
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        const d = j ? cloudData(j) : null;
        if (hasData(d)) {
          if (j && typeof j.v === 'number') _ver = j.v;
          writeCloudToLocal(d);
        }
      })
      .catch(() => { /* offline: usa o localStorage local */ })
      .finally(() => {
        ready = true;
        if (typeof bootFn === 'function') { try { bootFn(); } catch (e) { console.error(e); } }
        // se o app semeou algo no boot (ex.: lista de colaboradores em nuvem vazia), sobe
        if (anyPending()) schedulePush();
        setInterval(checkRemote, POLL_MS);
      });
  };

  // ── flush ao sair/minimizar ──────────────────────────────────────────────────
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushNow();
    else checkRemote();
  });
  window.addEventListener('pagehide', flushNow);
  window.addEventListener('beforeunload', function (e) {
    if (hasPending()) { flushNow(); e.preventDefault(); e.returnValue = ''; }
  });
})();
