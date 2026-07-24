// Vercel Serverless Function — acionada automaticamente 1x/dia pelo Cron da Vercel
// (configurado em vercel.json). Protegida pelo CRON_SECRET que a própria Vercel
// injeta como variável de ambiente — qualquer chamada sem esse segredo é rejeitada,
// pra ninguém conseguir disparar sincronizações só sabendo a URL.

import { syncAllConnections } from './_plaid-lib.js';

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Não autorizado' });
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
    res.status(200).json({ ok: true, totalImported, results });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
