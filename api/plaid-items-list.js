// Vercel Serverless Function
// Lista os logins do Plaid (plaid_items) com quantas contas (plaid_connections)
// cada um tem — usado pelo botão "Sincronizar tudo" pra saber de antemão quantas
// conexões existem no total, antes de disparar a sincronização de cada login.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: 'Variáveis de ambiente do Supabase não configuradas no servidor' });
    return;
  }

  try {
    const headers = { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` };
    const [itemRes, connRes] = await Promise.all([
      fetch(`${supabaseUrl}/rest/v1/plaid_items?select=id,institution_name,plaid_account`, { headers }),
      fetch(`${supabaseUrl}/rest/v1/plaid_connections?select=item_ref`, { headers }),
    ]);
    const items = await itemRes.json();
    const conns = await connRes.json();
    const counts = {};
    conns.forEach(c => { counts[c.item_ref] = (counts[c.item_ref] || 0) + 1; });
    const result = items.map(it => ({ ...it, connectionCount: counts[it.id] || 0 }));
    res.status(200).json({ items: result });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
