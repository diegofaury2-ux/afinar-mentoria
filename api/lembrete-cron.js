// Cron diário (ver vercel.json, "0 12 * * *" = 9h em Brasília) que checa se
// hoje é uma das DATAS ESCOLHIDAS MANUALMENTE em Configurações e, se for,
// manda um lembrete por e-mail pra cada colaborador com e-mail cadastrado que
// AINDA não completou a autoavaliação do ciclo (trimestral) atual.
//
// Roda todo dia (o cron da Vercel Hobby só permite frequência diária), mas só
// FAZ alguma coisa nas datas da lista — a lista de datas é editada livremente
// em Configurações, sem precisar mexer em vercel.json nem redeploy.
//
// Protegido por CRON_SECRET: só a própria Vercel (que manda esse header nas
// chamadas de cron) consegue disparar o envio.
const state = require('./state.js');

function pad2(n){ return String(n).padStart(2, '0'); }

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers && req.headers.authorization;
  if(!cronSecret || auth !== ('Bearer ' + cronSecret)){
    return res.status(401).json({ error: 'unauthorized' });
  }
  try{
    const { data } = await state.readState();
    const config = state.safeParse(data['afinar_v4_lembretes'], null);
    if(!config || !config.ativo){
      return res.status(200).json({ ok: true, skipped: 'lembretes_desativados' });
    }
    const hoje = new Date();
    const hojeStr = hoje.getFullYear() + '-' + pad2(hoje.getMonth() + 1) + '-' + pad2(hoje.getDate());
    const datas = Array.isArray(config.datas) ? config.datas : [];
    if(!datas.includes(hojeStr)){
      return res.status(200).json({ ok: true, skipped: 'hoje_nao_esta_na_lista', hoje: hojeStr, datas: datas });
    }

    const ano = hoje.getFullYear();
    const mes = hoje.getMonth() + 1;
    const ciclo = Math.ceil(mes / 3);
    const mesAncora = (ciclo - 1) * 3 + 1; // autoavaliação é 1x por ciclo, ancorada no 1º mês
    const chaveAncora = ano + '-' + pad2(mesAncora);
    const colaboradores = state.safeParse(data['afinar_v4_colaboradores'], []);
    const prazo = (config.textoPrazo || 'até o fim do mês').trim();
    const appUrl = process.env.AFINAR_APP_URL || 'https://afinar-mentoria.vercel.app';

    const comEmail = (colaboradores || []).filter(c => c && c.email);
    let enviados = 0;
    await Promise.all(comEmail.map(async c => {
      const rec = state.safeParse(data['afinar_v4::' + c.nome + '::' + chaveAncora], {});
      if(rec.selfCompleto) return; // já preencheu: sem lembrete
      await state.enviarEmailResend(
        c.email,
        'Lembrete: autoavaliação do ciclo ' + ciclo + ' pendente',
        'Oi, ' + c.nome + '! Este é um lembrete de que sua autoavaliação de desempenho do ciclo ' + ciclo + ' (' + ano + ') ainda não foi enviada.\n\n' +
        'Prazo: ' + prazo + '.\n\n' +
        'Acesse o app para preencher: ' + appUrl
      );
      enviados++;
    }));
    return res.status(200).json({ ok: true, enviados, elegiveis: comEmail.length, ciclo, chaveAncora });
  }catch(e){
    return res.status(502).json({ error: 'lembrete_error', detail: String(e && e.message || e) });
  }
};
