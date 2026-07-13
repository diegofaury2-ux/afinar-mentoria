// Serverless: valida a senha do gestor no SERVIDOR (nunca no client).
// A senha fica só na env var SYNC_PASSWORD do projeto Vercel.
// POST { senha } -> { ok: true|false }
module.exports = async (req, res) => {
  res.setHeader('Cache-Control','no-store');
  if(req.method !== 'POST') return res.status(405).json({ error:'method_not_allowed' });

  let b = req.body;
  if(typeof b === 'string'){ try{ b = JSON.parse(b); }catch{ b = {}; } }
  const senha = (b && typeof b.senha === 'string') ? b.senha : '';

  const expected = process.env.SYNC_PASSWORD || '';
  if(!expected) return res.status(500).json({ error:'not_configured' });

  // comparação de tempo ~constante (evita micro-vazamento por timing)
  let ok = senha.length === expected.length;
  for(let i=0; i<expected.length; i++){
    if(senha.charCodeAt(i) !== expected.charCodeAt(i)) ok = false;
  }
  return res.status(200).json({ ok: ok });
};
