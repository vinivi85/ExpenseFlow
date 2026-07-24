// Vercel Serverless Function
// Sincroniza as transações novas de UM cartão conectado via Plaid (botão
// "sincronizar" individual na aba Config). Usa a mesma lógica compartilhada
// do "Sincronizar tudo".

import { syncOneConnection } from './_plaid-lib.js';

async function supaFetch(supabaseUrl, serviceKey, path, opts = {}) {
  return fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      ...(opts.headers || {}),
    },
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!clientId || !secret || !supabaseUrl || !serviceKey) {
    res.status(500).json({ error: 'Variáveis de ambiente do Plaid/Supabase não configuradas no servidor' });
    return;
  }

  try {
    const { card_id } = req.body;
    if (!card_id) { res.status(400).json({ error: 'card_id é obrigatório' }); return; }

    const connRes = await supaFetch(supabaseUrl, serviceKey, `plaid_connections?card_id=eq.${card_id}&select=*`);
    const connections = await connRes.json();
    if (!connections || connections.length === 0) {
      res.status(404).json({ error: 'Cartão não tem conexão com o Plaid' });
      return;
    }
    const conn = connections[0];

    const [cardRes, catRes, userRes] = await Promise.all([
      supaFetch(supabaseUrl, serviceKey, `cards?id=eq.${card_id}&select=name`),
      supaFetch(supabaseUrl, serviceKey, `categories?select=name`),
      supaFetch(supabaseUrl, serviceKey, `users?select=name&order=created_at.asc&limit=1`),
    ]);
    const cardRows = await cardRes.json();
    const cardName = cardRows[0]?.name || conn.account_name || 'Cartão';
    const categoryNames = (await catRes.json()).map(c => c.name);
    const defaultUser = (await userRes.json())[0]?.name || 'Vinicius';

    const result = await syncOneConnection({ supabaseUrl, serviceKey, clientId, secret, conn, cardName, categoryNames, defaultUser });
    if (result.error) { res.status(500).json({ error: result.error }); return; }

    res.status(200).json({ ok: true, imported: result.imported });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
