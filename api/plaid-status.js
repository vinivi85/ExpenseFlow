// Vercel Serverless Function
// Devolve pro app só o status de conexão por cartão (conectado/desconectado),
// nunca o access_token em si. Usa a service_role key pra ler a tabela protegida.

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados no servidor' });
    return;
  }

  try {
    const upstream = await fetch(
      `${supabaseUrl}/rest/v1/plaid_connections?select=card_id,institution_name,account_name,status,last_synced_at`,
      {
        headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` },
      }
    );
    const data = await upstream.json();
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'Erro ao consultar conexões' });
      return;
    }
    res.status(200).json({ connections: data });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
