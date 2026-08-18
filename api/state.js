// Serverless: guarda/recupera o estado do Afinar via Upstash Redis.
// Modelo multi-chave: data = { "<chave localStorage>": "<valor string>", ... }
//
// GET            -> { v, data }
// GET ?v=1       -> { v }
// POST { set:{k:v}, del:[k] } -> merge por chave (e por campo nos registros) -> { ok, v }
//
// MERGE POR CAMPO nos registros afinar_v4::<nome>::<ano>-<mes>:
//   os campos do colaborador (funcao/data/self/pdi/selfCompleto) e os do gestor
//   (ment/mentor/roteiro/reunioes/mentCompleto) são mesclados usando as marcas de
//   tempo selfUpdatedAt / mentUpdatedAt, para que salvar de um lado nunca apague
//   o que o outro lado gravou no mesmo mês.
//   Existe ainda uma TERCEIRA via, para o que os dois lados editam: o contador
//   reunioesFeitas, com carimbo próprio reunioesFeitasAt (17/08/2026).

const REDIS_KEY = process.env.REDIS_KEY || 'afinar:state:v1';
function kvUrl(){ return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL; }
function kvToken(){ return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN; }

async function redis(cmd){
  const r = await fetch(kvUrl(), {
    method:'POST',
    headers:{ Authorization:'Bearer '+kvToken(), 'Content-Type':'application/json' },
    body: JSON.stringify(cmd)
  });
  const txt = await r.text();
  if(!r.ok) throw new Error('redis '+r.status+': '+txt);
  return JSON.parse(txt);
}
async function readState(){
  const out = await redis(['GET', REDIS_KEY]);
  const raw = out && out.result;
  if(!raw) return { v:0, data:{} };
  let p; try{ p = JSON.parse(raw); }catch{ return { v:0, data:{} }; }
  if(p && typeof p.v === 'number') return { v:p.v, data:(p.data && typeof p.data==='object') ? p.data : {} };
  return { v:0, data:(p && typeof p==='object') ? p : {} };
}

const isRecordKey = k => k.indexOf('afinar_v4::') === 0;
const COLAB_FIELDS = ['funcao','data','self','pdi','selfCompleto'];
const GEST_FIELDS  = ['ment','mentor','roteiro','reunioes','mentCompleto'];
// Terceira via: campos que os DOIS lados editam (o contador de reuniões do mês).
// Não podem entrar em COLAB_FIELDS nem em GEST_FIELDS, senão a gravação de um
// dos lados seria descartada em silêncio pelo merge do outro. Carimbo próprio
// (reunioesFeitasAt), decidido só entre si: vence quem salvou por último.
const AMBOS_FIELDS = ['reunioesFeitas'];

// serializa um objeto com as chaves de topo ordenadas (saída determinística,
// para o guard de no-op detectar valores idênticos)
function canon(obj){
  return JSON.stringify(Object.keys(obj).sort().reduce((a,k)=>{ a[k]=obj[k]; return a; }, {}));
}

// mescla duas versões de um MESMO registro, por lado (colab vs gestor)
function mergeRecord(oldStr, newStr){
  let o, n;
  try{ n = JSON.parse(newStr); }catch{ return newStr; }        // valor novo inválido: usa como está
  if(!n || typeof n !== 'object') return newStr;
  try{ o = (oldStr == null) ? {} : JSON.parse(oldStr); }catch{ o = {}; }
  if(!o || typeof o !== 'object') o = {};

  const res = Object.assign({}, o, n);                          // base: campos neutros (nome/ano/mes...) do novo
  const oS = o.selfUpdatedAt||0, nS = n.selfUpdatedAt||0;
  const colabSrc = (nS >= oS) ? n : o;
  COLAB_FIELDS.forEach(f => { if(f in colabSrc) res[f] = colabSrc[f]; });
  res.selfUpdatedAt = Math.max(oS, nS);

  const oM = o.mentUpdatedAt||0, nM = n.mentUpdatedAt||0;
  const gestSrc = (nM >= oM) ? n : o;
  GEST_FIELDS.forEach(f => { if(f in gestSrc) res[f] = gestSrc[f]; });
  res.mentUpdatedAt = Math.max(oM, nM);

  // Contador de reuniões: aditivo. Registro sem reunioesFeitasAt (todos os que
  // já existem hoje) tem oR = nR = 0, cai no lado novo e sai igual ao que
  // entrou, então o merge segue se comportando exatamente como antes. E um
  // cliente antigo, que reenvia o contador com o carimbo velho que leu, perde
  // a disputa pro valor mais recente em vez de sobrescrevê-lo.
  const oR = o.reunioesFeitasAt||0, nR = n.reunioesFeitasAt||0;
  const ambosSrc = (nR >= oR) ? n : o;
  AMBOS_FIELDS.forEach(f => { if(f in ambosSrc) res[f] = ambosSrc[f]; });
  res.reunioesFeitasAt = Math.max(oR, nR);

  res.updatedAt = Math.max(o.updatedAt||0, n.updatedAt||0);
  return canon(res);
}

// comparação canônica (chaves de topo ordenadas) para detectar no-op
function stable(data){
  return JSON.stringify(Object.keys(data).sort().reduce((a,k)=>{a[k]=data[k];return a;}, {}));
}

// ---------------------------------------------------------------------------
// AVISO POR E-MAIL AO MENTOR (18/08/2026)
// Quando o registro de um colaborador vira selfCompleto:false -> true (ele
// terminou a autoavaliação), o mentor do ciclo recebe um e-mail. Detectado
// aqui no servidor (não no cliente) para disparar uma vez só, não importa de
// qual dispositivo veio o salvamento nem quantas vezes o cliente reenvie.
// Falha de e-mail NUNCA pode derrubar o salvamento do formulário: é só um
// aviso, o dado já está seguro no Redis antes de tentar enviar.
function parseRecordKey(k){
  const rest = k.slice('afinar_v4::'.length);
  const idx = rest.lastIndexOf('::');
  if(idx < 0) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(rest.slice(idx+2));
  if(!m) return null;
  return { nome: rest.slice(0, idx), ano: Number(m[1]), mes: Number(m[2]) };
}
function safeParse(str, fallback){
  if(str == null) return fallback;
  try{ const p = JSON.parse(str); return (p == null) ? fallback : p; }catch{ return fallback; }
}
// mesma regra do app (index.html: mentorImparDe/outroMentor/mentorDoCiclo):
// mentorImpar cobre os ciclos 1 e 3, o outro mentor cobre os ciclos 2 e 4.
function mentorDoCicloServer(colaboradores, nome, mes){
  const c = (colaboradores||[]).find(c => c && c.nome === nome);
  const impar = (c && c.mentorImpar) || 'Val';
  const outro = impar === 'Val' ? 'Luiz' : 'Val';
  const ciclo = Math.ceil(Number(mes) / 3);
  return (ciclo % 2 === 1) ? impar : outro;
}
async function enviarEmailResend(to, subject, text){
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if(!apiKey || !from || !to) return;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text })
  });
  if(!r.ok){ console.warn('[afinar] resend', r.status, await r.text().catch(()=>'')); }
}
// dispara (best-effort) o aviso pro mentor de UM registro que acabou de
// completar a autoavaliação. `data` já é o estado MESCLADO pós-gravação.
// Cada colaborador só tem UM mentor por ciclo (mentorDoCicloServer), então o
// aviso já sai separado por natureza: quem é do Val cai no e-mail do Val,
// quem é do Luiz cai no e-mail do Luiz — nunca os dois juntos.
async function avisarAutoavaliacaoConcluida(key, data){
  try{
    const p = parseRecordKey(key);
    if(!p) return;
    const colaboradores = safeParse(data['afinar_v4_colaboradores'], []);
    const mentorEmails = safeParse(data['afinar_v4_mentor_emails'], {});
    const mentor = mentorDoCicloServer(colaboradores, p.nome, p.mes);
    const email = mentorEmails && mentorEmails[mentor];
    if(!email) return; // e-mail do mentor não cadastrado em Configurações: sem aviso
    const appUrl = process.env.AFINAR_APP_URL || 'https://afinar-mentoria.vercel.app';
    await enviarEmailResend(
      email,
      'Autoavaliação concluída: ' + p.nome,
      p.nome + ' terminou de preencher a autoavaliação de desempenho (ciclo ' + Math.ceil(p.mes/3) + ', ' + p.ano + ').\n\n' +
      'Acesse o painel do mentor para avaliar os mesmos itens: ' + appUrl
    );
  }catch(e){ console.warn('[afinar] aviso mentor', e); }
}
// aviso INVERSO (18/08/2026): quando o MENTOR conclui a avaliação dele
// (mentCompleto false->true), o colaborador recebe um e-mail. Mesmo
// mecanismo, mesma garantia de disparo único, só troca quem é o destinatário
// (o próprio colaborador, pelo e-mail cadastrado nele em afinar_v4_colaboradores).
async function avisarMentorConcluiuAvaliacao(key, data){
  try{
    const p = parseRecordKey(key);
    if(!p) return;
    const colaboradores = safeParse(data['afinar_v4_colaboradores'], []);
    const c = (colaboradores||[]).find(c => c && c.nome === p.nome);
    const email = c && c.email;
    if(!email) return; // colaborador sem e-mail cadastrado: sem aviso
    const mentor = mentorDoCicloServer(colaboradores, p.nome, p.mes);
    const appUrl = process.env.AFINAR_APP_URL || 'https://afinar-mentoria.vercel.app';
    await enviarEmailResend(
      email,
      'Sua avaliação de desempenho foi concluída pelo mentor',
      'Seu mentor (' + mentor + ') terminou de preencher a avaliação do ciclo ' + Math.ceil(p.mes/3) + ' (' + p.ano + ').\n\n' +
      'Acesse o app pra ver o resultado: ' + appUrl
    );
  }catch(e){ console.warn('[afinar] aviso colaborador', e); }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control','no-store');
  if(!kvUrl() || !kvToken()) return res.status(500).json({ error:'storage_not_configured' });
  try{
    if(req.method === 'GET'){
      const s = await readState();
      if(req.query && req.query.v) return res.status(200).json({ v:s.v });
      return res.status(200).json(s);
    }
    if(req.method === 'POST'){
      let b = req.body;
      if(typeof b === 'string'){ try{ b = JSON.parse(b); }catch{ b = {}; } }
      b = b || {};
      const set = (b.set && typeof b.set==='object') ? b.set : {};
      const del = Array.isArray(b.del) ? b.del : [];

      const cur = await readState();
      const data = Object.assign({}, cur.data);
      const before = stable(data);

      const paraAvisarSelf = []; // chaves que viraram selfCompleto:true agora (avisa o mentor)
      const paraAvisarMent = []; // chaves que viraram mentCompleto:true agora (avisa o colaborador)
      Object.keys(set).forEach(k => {
        const nv = set[k];
        if(isRecordKey(k)){
          const antes = safeParse(data[k], {});
          data[k] = mergeRecord(data[k], typeof nv==='string' ? nv : JSON.stringify(nv));
          const depois = safeParse(data[k], {});
          if(!antes.selfCompleto && depois.selfCompleto) paraAvisarSelf.push(k);
          if(!antes.mentCompleto && depois.mentCompleto) paraAvisarMent.push(k);
        }
        else data[k] = (typeof nv==='string' ? nv : JSON.stringify(nv));
      });
      del.forEach(k => { delete data[k]; });

      if(stable(data) === before){
        return res.status(200).json({ ok:true, v:cur.v, unchanged:true }); // no-op: não avança versão
      }
      const nv = (cur.v||0) + 1;
      await redis(['SET', REDIS_KEY, JSON.stringify({ v:nv, data })]);
      // dado já está seguro no Redis; o aviso por e-mail vem depois e nunca
      // pode fazer a resposta do salvamento falhar (ver avisarAutoavaliacaoConcluida)
      await Promise.all([
        ...paraAvisarSelf.map(k => avisarAutoavaliacaoConcluida(k, data)),
        ...paraAvisarMent.map(k => avisarMentorConcluiuAvaliacao(k, data))
      ]);
      return res.status(200).json({ ok:true, v:nv });
    }
    res.status(405).json({ error:'method_not_allowed' });
  }catch(e){
    res.status(502).json({ error:'storage_error', detail:String(e && e.message || e) });
  }
};

// reaproveitado pelo api/lembrete-cron.js, pra não duplicar a conexão com o
// Redis nem o envio por Resend.
module.exports.kvUrl = kvUrl;
module.exports.kvToken = kvToken;
module.exports.readState = readState;
module.exports.safeParse = safeParse;
module.exports.enviarEmailResend = enviarEmailResend;
