// Serverless: guarda/recupera o estado do Afinar via Upstash Redis.
// Modelo multi-chave: data = { "<chave localStorage>": "<valor string>", ... }
//
// GET            -> { v, data }
// GET ?v=1       -> { v }
// POST { set:{k:v}, del:[k] } -> merge por chave (e por campo nos registros) -> { ok, v }
//
// MERGE POR CAMPO nos registros afinar_v4::<nome>::<ano>-<mes>:
//   os campos do colaborador (funcao/data/self/pdi/selfCompleto) e os do gestor
//   (ment/mentor/roteiro/reuniao/mentCompleto) são mesclados usando as marcas de
//   tempo selfUpdatedAt / mentUpdatedAt, para que salvar de um lado nunca apague
//   o que o outro lado gravou no mesmo mês.

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
const GEST_FIELDS  = ['ment','mentor','roteiro','reuniao','mentCompleto'];

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

  res.updatedAt = Math.max(o.updatedAt||0, n.updatedAt||0);
  return canon(res);
}

// comparação canônica (chaves de topo ordenadas) para detectar no-op
function stable(data){
  return JSON.stringify(Object.keys(data).sort().reduce((a,k)=>{a[k]=data[k];return a;}, {}));
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

      Object.keys(set).forEach(k => {
        const nv = set[k];
        if(isRecordKey(k)) data[k] = mergeRecord(data[k], typeof nv==='string' ? nv : JSON.stringify(nv));
        else data[k] = (typeof nv==='string' ? nv : JSON.stringify(nv));
      });
      del.forEach(k => { delete data[k]; });

      if(stable(data) === before){
        return res.status(200).json({ ok:true, v:cur.v, unchanged:true }); // no-op: não avança versão
      }
      const nv = (cur.v||0) + 1;
      await redis(['SET', REDIS_KEY, JSON.stringify({ v:nv, data })]);
      return res.status(200).json({ ok:true, v:nv });
    }
    res.status(405).json({ error:'method_not_allowed' });
  }catch(e){
    res.status(502).json({ error:'storage_error', detail:String(e && e.message || e) });
  }
};
