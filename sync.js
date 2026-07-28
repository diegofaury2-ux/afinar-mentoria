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
//
// ENDURECIDO EM 28/07/2026 depois do incidente da Plataforma Manjuba, que
// nasceu deste mesmo arquivo e perdeu por completo as respostas já enviadas de
// uma sócia. Os três defeitos eram estes, e estão corrigidos aqui:
//   1. resposta 500/502 do servidor caía no caminho de SUCESSO (`r.ok ?
//      r.json() : null`): a alteração era descartada em silêncio, sem
//      retentativa. Agora !r.ok é falha, volta pra fila e tem backoff.
//   2. keepalive:true em todo POST. O teto de keepalive do navegador é de
//      64 KiB COMPARTILHADO entre as requisições em voo: corpo grande (ou duas
//      requisições ao mesmo tempo) mata o fetch com TypeError antes de sair da
//      máquina. Agora só usa keepalive em corpo pequeno.
//   3. a nuvem apagava do navegador qualquer chave que ela não tivesse. Somado
//      ao defeito 1, uma subida falhada destruía também a única cópia local.
//      Agora existe o conjunto `unsynced`: chave com alteração não confirmada
//      pelo servidor não pode ser apagada nem sobrescrita pela nuvem.
// Além disso o sync agora tem estado observável (AfinarSync.onStatus) e mostra
// um selo "Salvando / Salvo / Falha ao salvar": o silêncio foi o que escondeu a
// perda na Manjuba.
//
// E fecha um QUARTO buraco, encontrado no teste desta correção: o conjunto
// `unsynced` só existia na memória da aba. Se a subida falhava e a pessoa
// recarregava a página (F5, fechar e reabrir), o conjunto voltava vazio, a
// hidratação encontrava a chave no navegador e não na nuvem e apagava a única
// cópia que restava. Agora a fila de envio é persistida no localStorage
// (afinar_sync_outbox, que não sobe pra nuvem) e é RETOMADA no boot: a alteração
// que não subiu sobrevive ao recarregamento, é protegida da hidratação e sobe
// sozinha quando o servidor volta.
(function () {
  const API = '/api/state';
  const PREFIX = 'afinar_v4';          // toda chave do app começa com isto
  const POLL_MS = 6000;
  const DEBOUNCE_MS = 1000;
  // acima disto o POST vai SEM keepalive (ver defeito 2 no cabeçalho)
  const KEEPALIVE_MAX = 24000;
  const BACKOFF_MAX_MS = 30000;

  let _ver = 0;
  let ready = false;
  let pushTimer = null, pushing = false, pendingPush = false;
  let checking = false, applying = false;
  let failCount = 0;                   // envios consecutivos que falharam
  let status = 'idle';                 // idle | saving | error
  const statusCbs = [];

  // chaves com alteração local que AINDA não foi confirmada pelo servidor.
  // Enquanto uma chave está aqui, a nuvem não pode apagá-la nem sobrescrevê-la.
  const unsynced = new Set();

  function setStatus(s) {
    if (s === status) return;
    status = s;
    statusCbs.forEach(cb => { try { cb(s); } catch (e) {} });
  }

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

  // ── fila de envio persistente (outbox) ──────────────────────────────────────
  // Sobrevive ao recarregamento da página: enquanto uma alteração não é
  // confirmada pelo servidor, ela fica aqui. Não começa com 'afinar_v4', então
  // nunca é sincronizada nem aparece no backup do app.
  const OUTBOX_KEY = 'afinar_sync_outbox';
  // o que está em voo agora (já saiu de pendingSet mas ainda não foi confirmado)
  let inflightSet = {}, inflightDel = [];
  function saveOutbox() {
    try {
      const set = Object.assign({}, inflightSet, pendingSet);
      const del = Array.from(new Set(inflightDel.concat(Array.from(pendingDel))));
      if (!Object.keys(set).length && !del.length) { _remove(OUTBOX_KEY); return; }
      _set(OUTBOX_KEY, JSON.stringify({ set: set, del: del }));
    } catch (e) {
      // quota cheia: não deixa o app quebrar por causa do backup da fila
      console.warn('[sync] outbox', e);
    }
  }
  // retoma a fila salva por uma sessão anterior. Chamado ANTES da hidratação,
  // para que `unsynced` já esteja povoado e a nuvem não apague o que não subiu.
  function loadOutbox() {
    let o = null;
    try { o = JSON.parse(_get(OUTBOX_KEY) || 'null'); } catch (e) { o = null; }
    if (!o || typeof o !== 'object') return;
    const set = (o.set && typeof o.set === 'object') ? o.set : {};
    const del = Array.isArray(o.del) ? o.del : [];
    Object.keys(set).forEach(k => {
      if (!isAfinarKey(k)) return;
      // se a chave ainda existe no navegador, o valor local é a verdade;
      // se foi apagada de lá, não ressuscita.
      const cur = _get(k);
      if (cur === null) return;
      pendingSet[k] = cur; unsynced.add(k);
    });
    del.forEach(k => {
      if (!isAfinarKey(k)) return;
      if (_get(k) !== null) return;   // voltou a existir: a remoção não vale mais
      pendingDel.add(k); unsynced.add(k);
    });
    saveOutbox();
  }

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
      // modal do Afinar. O :not([hidden]) é essencial: o #modal-overlay vive
      // sempre no DOM e só alterna o atributo hidden, então o seletor sem ele
      // dava SEMPRE positivo e o poll nunca aplicava nada sozinho, só mostrava
      // o aviso "Atualizar" (corrigido em 28/07/2026).
      if (document.querySelector('.modal-overlay:not([hidden])')) return true;
      // Campo focado não é o único caso de "está editando": se a pessoa digitou
      // e clicou fora (blur) sem salvar, o __afinarReload re-renderiza o
      // formulário a partir do armazenamento e apagaria o que ela digitou.
      // isDirty() é a mesma checagem que o app usa pra barrar a saída de tela.
      if (typeof window.isDirty === 'function' && window.isDirty()) return true;
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
    inflightSet = set; inflightDel = del;    // segue no outbox até o servidor confirmar
    pushing = true;
    setStatus('saving');
    // devolve as alterações à fila: nada de gravação descartada em silêncio
    const requeue = () => {
      Object.keys(set).forEach(k => { if (!(k in pendingSet)) pendingSet[k] = set[k]; });
      del.forEach(k => pendingDel.add(k));
      failCount++;
      setStatus('error');
    };
    const body = JSON.stringify({ set: set, del: del });
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body };
    // keepalive faz o navegador tentar entregar o POST mesmo se a aba for
    // fechada no meio do envio, mas só cabe corpo pequeno (defeito 2)
    if (body.length < KEEPALIVE_MAX) opts.keepalive = true;
    fetch(API, opts)
      .then(r => {
        // ANTES: `r.ok ? r.json() : null` caía no caminho de sucesso quando o
        // servidor respondia 500/502 e a alteração era jogada fora pra sempre.
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(j => {
        if (!j || j.ok === false) throw new Error('resposta inválida');
        if (typeof j.v === 'number') _ver = j.v;
        // confirmado pelo servidor: agora a nuvem pode mandar nestas chaves.
        // MENOS as que voltaram pra fila enquanto este envio estava em voo (a
        // pessoa salvou de novo): essa alteração mais nova ainda não subiu.
        const aindaPendente = k => (k in pendingSet) || pendingDel.has(k);
        Object.keys(set).forEach(k => { if (!aindaPendente(k)) unsynced.delete(k); });
        del.forEach(k => { if (!aindaPendente(k)) unsynced.delete(k); });
        failCount = 0;
        if (!anyPending()) setStatus('idle');
      })
      .catch(requeue)
      .finally(() => {
        pushing = false;
        inflightSet = {}; inflightDel = [];   // confirmado ou já devolvido à fila
        saveOutbox();
        if (pendingPush || anyPending()) { pendingPush = false; schedulePush(); }
      });
  }
  function schedulePush() {
    if (pushTimer) clearTimeout(pushTimer);
    // espera mais a cada falha consecutiva (1s, 2s, 4s... até 30s) pra não
    // martelar um servidor que está fora do ar
    const wait = failCount ? Math.min(BACKOFF_MAX_MS, DEBOUNCE_MS * Math.pow(2, failCount)) : DEBOUNCE_MS;
    pushTimer = setTimeout(() => { pushTimer = null; doPush(); }, wait);
  }
  function hasPending() { return ready && (!!pushTimer || pushing || pendingPush || anyPending()); }
  function flushNow() { if (!ready) return; if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; } doPush(); }

  // ── intercepta gravações/remoções do app ────────────────────────────────────
  localStorage.setItem = function (k, v) {
    _set(k, v);
    if (ready && isAfinarKey(k)) { pendingSet[k] = v; pendingDel.delete(k); unsynced.add(k); saveOutbox(); schedulePush(); }
  };
  localStorage.removeItem = function (k) {
    _remove(k);
    if (ready && isAfinarKey(k)) { pendingDel.add(k); delete pendingSet[k]; unsynced.add(k); saveOutbox(); schedulePush(); }
  };

  // ── escreve o mapa da nuvem no localStorage (sem eco) ────────────────────────
  function writeCloudToLocal(data) {
    // remove chaves locais que sumiram da nuvem (deleções feitas por outros),
    // MENOS as que têm alteração local ainda não confirmada pelo servidor. Sem
    // essa exceção, uma subida que falhou virava perda total: a nuvem (sem o
    // dado) apagava o navegador (com o dado).
    localAfinarKeys().forEach(k => { if (!(k in data) && !unsynced.has(k)) _remove(k); });
    Object.keys(data).forEach(k => {
      if (unsynced.has(k)) return;   // o local é mais novo: não sobrescreve
      _set(k, typeof data[k] === 'string' ? data[k] : JSON.stringify(data[k]));
    });
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

  // ── selo de estado do salvamento ────────────────────────────────────────────
  // O sync se desenha sozinho: o Afinar tem topbar em 6 telas diferentes e um
  // selo flutuante evita ter que mexer em todas. "Salvo" some depois de 4s;
  // "Salvando" e "Falha" ficam à vista, e clicar em "Falha" tenta de novo.
  const SYNC_LABEL = { idle: 'Salvo na nuvem', saving: 'Salvando…', error: 'Falha ao salvar' };
  let badgeEl = null, badgeHideTimer = null;
  function ensureBadge() {
    if (badgeEl) return badgeEl;
    const host = document.body || document.documentElement;
    if (!host) return null;
    // não aparece na impressão, igual ao resto do mobiliário flutuante do app
    // (.appbar, .savebar, #toast, .jump-eval já são escondidos no @media print)
    const st = document.createElement('style');
    st.textContent = '@media print{#__afinarSync{display:none!important}}';
    host.appendChild(st);
    badgeEl = document.createElement('div');
    badgeEl.id = '__afinarSync';
    badgeEl.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483646;' +
      'font-family:sans-serif;font-size:12.5px;font-weight:700;letter-spacing:.01em;' +
      'padding:8px 13px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.35);' +
      'opacity:0;pointer-events:none;transition:opacity .2s ease;max-width:80vw';
    host.appendChild(badgeEl);
    return badgeEl;
  }
  // a barra de salvar do formulário é sticky e ocupa os ~70px de baixo da tela.
  // O selo sobe acima dela pra não cobrir o botão Salvar (a tela do app não muda).
  function badgeBottom() {
    let h = 0;
    try {
      document.querySelectorAll('.savebar').forEach(sb => {
        const r = sb.getBoundingClientRect();
        if (r.height > 0 && r.bottom >= window.innerHeight - 2) h = Math.max(h, r.height);
      });
    } catch (e) {}
    return (h ? h + 12 : 16) + 'px';
  }
  function paintBadge(st) {
    const el = ensureBadge();
    if (!el) return;
    el.style.bottom = badgeBottom();
    el.textContent = SYNC_LABEL[st] || '';
    if (st === 'error') {
      el.style.background = '#d0104a'; el.style.color = '#fff';
      el.style.cursor = 'pointer'; el.style.pointerEvents = 'auto';
      el.title = 'Não foi possível salvar na nuvem. Clique para tentar de novo.';
      el.onclick = () => { failCount = 0; flushNow(); };
    } else {
      el.style.background = st === 'saving' ? '#3a3a36' : '#c4e01a';
      el.style.color = st === 'saving' ? '#f5f2eb' : '#0a0a0a';
      el.style.cursor = 'default'; el.style.pointerEvents = 'none';
      el.title = 'Estado do salvamento na nuvem';
      el.onclick = null;
    }
    el.style.opacity = '1';
    if (badgeHideTimer) { clearTimeout(badgeHideTimer); badgeHideTimer = null; }
    if (st === 'idle') badgeHideTimer = setTimeout(() => { el.style.opacity = '0'; }, 4000);
  }

  // ── API pública ─────────────────────────────────────────────────────────────
  window.AfinarSync = {
    // permite à interface mostrar "Salvando… / Salvo / Falha ao salvar"
    onStatus(cb) { if (typeof cb === 'function') { statusCbs.push(cb); cb(status); } },
    status() { return status; },
    pending() { return hasPending(); },
    // força uma tentativa imediata (botão "tentar de novo")
    retry() { failCount = 0; flushNow(); },
    flush() { flushNow(); },
    // espera o que está pendente subir. Devolve { pending:boolean } para quem
    // precisa saber se pode seguir (ex.: confirmar um envio definitivo).
    async settle(timeoutMs) {
      if (!ready) return { pending: false };
      flushNow();
      const deadline = Date.now() + (typeof timeoutMs === 'number' ? timeoutMs : 8000);
      while ((pushing || pendingPush || anyPending()) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
      return { pending: !!(pushing || pendingPush || anyPending()) };
    }
  };

  // ── hidratar e então bootar ──────────────────────────────────────────────────
  window.__cloudHydrate = function (bootFn) {
    // retoma a fila da sessão anterior ANTES de puxar a nuvem: o que não subiu
    // fica protegido da hidratação (ver quarto buraco no cabeçalho)
    loadOutbox();
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
        statusCbs.push(paintBadge);
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
