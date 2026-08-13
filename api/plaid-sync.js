// Vercel Serverless Function
// Sincroniza o LOGIN (item) inteiro por trás de um cartão específico — se esse
// login tiver outras contas associadas a outros cartões, todas são sincronizadas
// juntas (é assim que a API do Plaid funciona: sync é por login, não por conta).

import { syncOneItem } from './_plaid-lib.js';

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
    const connectionsForCard = await connRes.json();
    if (!connectionsForCard || connectionsForCard.length === 0) {
      res.status(404).json({ error: 'Cartão não tem conexão com o Plaid' });
      return;
    }
    const itemRef = connectionsForCard[0].item_ref;

    const [itemRes, allConnRes, cardRes, catRes, userRes] = await Promise.all([
      supaFetch(supabaseUrl, serviceKey, `plaid_items?id=eq.${itemRef}&select=*`),
      supaFetch(supabaseUrl, serviceKey, `plaid_connections?item_ref=eq.${itemRef}&select=*`),
      supaFetch(supabaseUrl, serviceKey, `cards?select=id,name`),
      supaFetch(supabaseUrl, serviceKey, `categories?select=name`),
      supaFetch(supabaseUrl, serviceKey, `users?select=name&order=created_at.asc&limit=1`),
    ]);
    const item = (await itemRes.json())[0];
    if (!item) { res.status(404).json({ error: 'Login não encontrado' }); return; }
    const connections = await allConnRes.json();
    const cardRows = await cardRes.json();
    const categoryNames = (await catRes.json()).map(c => c.name);
    const defaultUser = (await userRes.json())[0]?.name || 'Vinicius';
    const cardById = {};
    cardRows.forEach(c => { cardById[c.id] = c.name; });

    const result = await syncOneItem({ supabaseUrl, serviceKey, clientId, secret, item, connections, cardById, categoryNames, defaultUser });
    if (result.error) { res.status(500).json({ error: result.error }); return; }

    res.status(200).json({ ok: true, imported: result.imported, pending: result.pending });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
