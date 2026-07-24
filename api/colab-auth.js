// Serverless: gerencia a senha de acesso do colaborador — SEPARADA do estado do
// app. Chave Redis própria (afinar:colab-senhas:v1); /api/state nunca lê essa
// chave, então mesmo um bug ali não pode vazar ou sobrescrever senhas.
// A senha nunca é guardada em texto puro: hash com salt (scrypt).
//
// POST { nome, acao:'status' }              -> { hasPassword }
// POST { nome, acao:'set', senha }          -> cria a senha (só se ainda não existir) -> { ok }
// POST { nome, acao:'verify', senha }       -> valida a senha -> { ok }
// POST { nome, acao:'reset', senhaGestor }  -> gestor apaga a senha daquele nome -> { ok }

const crypto = require('crypto');

const REDIS_KEY = process.env.REDIS_KEY_SENHAS || 'afinar:colab-senhas:v1';
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
async function readMap(){
  const out = await redis(['GET', REDIS_KEY]);
  const raw = out && out.result;
  if(!raw) return {};
  try{ const p = JSON.parse(raw); return (p && typeof p==='object') ? p : {}; }catch{ return {}; }
}
async function writeMap(map){
  await redis(['SET', REDIS_KEY, JSON.stringify(map)]);
}

function hashSenha(senha, salt){
  return crypto.scryptSync(senha, salt, 64).toString('hex');
}
function novoSalt(){ return crypto.randomBytes(16).toString('hex'); }

module.exports = async (req, res) => {
  res.setHeader('Cache-Control','no-store');
  if(req.method !== 'POST') return res.status(405).json({ error:'method_not_allowed' });
  if(!kvUrl() || !kvToken()) return res.status(500).json({ error:'storage_not_configured' });

  let b = req.body;
  if(typeof b === 'string'){ try{ b = JSON.parse(b); }catch{ b = {}; } }
  b = b || {};
  const nome = typeof b.nome === 'string' ? b.nome.trim() : '';
  const acao = b.acao;
  if(!nome) return res.status(400).json({ error:'nome_obrigatorio' });

  try{
    const map = await readMap();
    const entry = map[nome];

    if(acao === 'status'){
      return res.status(200).json({ hasPassword: !!entry });
    }

    if(acao === 'set'){
      if(entry) return res.status(409).json({ error:'senha_ja_existe' });
      const senha = typeof b.senha === 'string' ? b.senha : '';
      if(senha.length < 4) return res.status(400).json({ error:'senha_curta' });
      const salt = novoSalt();
      map[nome] = { hash: hashSenha(senha, salt), salt, criadaEm: Date.now() };
      await writeMap(map);
      return res.status(200).json({ ok:true });
    }

    if(acao === 'verify'){
      const senha = typeof b.senha === 'string' ? b.senha : '';
      if(!entry) return res.status(200).json({ ok:false, needsSetup:true });
      const ok = hashSenha(senha, entry.salt) === entry.hash;
      return res.status(200).json({ ok });
    }

    if(acao === 'reset'){
      const expected = process.env.SYNC_PASSWORD || '';
      const senhaGestor = typeof b.senhaGestor === 'string' ? b.senhaGestor : '';
      if(!expected) return res.status(500).json({ error:'not_configured' });
      if(senhaGestor.length !== expected.length || senhaGestor !== expected){
        return res.status(403).json({ error:'senha_gestor_incorreta' });
      }
      delete map[nome];
      await writeMap(map);
      return res.status(200).json({ ok:true });
    }

    return res.status(400).json({ error:'acao_invalida' });
  }catch(e){
    return res.status(502).json({ error:'storage_error', detail:String(e && e.message || e) });
  }
};
