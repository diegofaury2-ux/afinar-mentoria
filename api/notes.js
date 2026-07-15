// Serverless: guarda/recupera as ANOTAÇÕES PRIVADAS do colaborador via Upstash Redis.
// Endpoint SEPARADO de /api/state, com uma chave Redis própria (afinar:notas:v1) —
// assim, mesmo que o app do mentor tenha algum bug, o endpoint que ele usa
// (/api/state) nunca lê essa chave e nunca pode devolver anotações de ninguém.
// O único jeito de ler/escrever aqui é dizendo de quem são as anotações (?nome=),
// e só se aceita ler/escrever chaves que pertençam a esse mesmo nome.
//
// GET  ?nome=<nome>                    -> { v, data } (só as chaves desse nome)
// POST { nome, set:{k:v}, del:[k] }    -> só aceita chaves do próprio nome -> { ok, v }

const REDIS_KEY = process.env.REDIS_KEY_NOTAS || 'afinar:notas:v1';
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
function stable(data){
  return JSON.stringify(Object.keys(data).sort().reduce((a,k)=>{a[k]=data[k];return a;}, {}));
}

const PREFIX_NOTAS = 'afinar_v4_notas::';
function pertenceAoNome(k, nome){ return typeof k === 'string' && k.indexOf(PREFIX_NOTAS + nome + '::') === 0; }

module.exports = async (req, res) => {
  res.setHeader('Cache-Control','no-store');
  if(!kvUrl() || !kvToken()) return res.status(500).json({ error:'storage_not_configured' });
  try{
    let nome = '';
    let body = {};
    if(req.method === 'GET'){
      nome = (req.query && req.query.nome) || '';
    } else if(req.method === 'POST'){
      body = req.body;
      if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch{ body = {}; } }
      body = body || {};
      nome = body.nome || '';
    }
    if(!nome || typeof nome !== 'string') return res.status(400).json({ error:'nome_obrigatorio' });

    if(req.method === 'GET'){
      const s = await readState();
      const data = {};
      Object.keys(s.data).forEach(k => { if(pertenceAoNome(k, nome)) data[k] = s.data[k]; });
      return res.status(200).json({ v:s.v, data });
    }
    if(req.method === 'POST'){
      const set = (body.set && typeof body.set==='object') ? body.set : {};
      const del = Array.isArray(body.del) ? body.del : [];
      // trava de escopo: só aceita gravar/apagar chaves que pertençam ao próprio nome
      const forasDoEscopo = Object.keys(set).concat(del).some(k => !pertenceAoNome(k, nome));
      if(forasDoEscopo) return res.status(400).json({ error:'chave_fora_do_escopo' });

      const cur = await readState();
      const data = Object.assign({}, cur.data);
      const before = stable(data);
      Object.keys(set).forEach(k => { const nv = set[k]; data[k] = (typeof nv==='string' ? nv : JSON.stringify(nv)); });
      del.forEach(k => { delete data[k]; });

      if(stable(data) === before){
        return res.status(200).json({ ok:true, v:cur.v, unchanged:true });
      }
      const nv2 = (cur.v||0) + 1;
      await redis(['SET', REDIS_KEY, JSON.stringify({ v:nv2, data })]);
      return res.status(200).json({ ok:true, v:nv2 });
    }
    res.status(405).json({ error:'method_not_allowed' });
  }catch(e){
    res.status(502).json({ error:'storage_error', detail:String(e && e.message || e) });
  }
};
