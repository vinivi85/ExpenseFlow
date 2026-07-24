// Vercel Serverless Function
// Endpoint do botão "Sincronizar tudo" — dispara a sincronização de todos os
// cartões conectados ao Plaid de uma vez, chamado manualmente pelo usuário.

import { syncAllConnections } from './_plaid-lib.js';

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
    const results = await syncAllConnections({ supabaseUrl, serviceKey, clientId, secret });
    const totalImported = results.reduce((s, r) => s + (r.imported || 0), 0);
    const errors = results.filter(r => r.error);
    res.status(200).json({ ok: true, totalImported, results, hadErrors: errors.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
