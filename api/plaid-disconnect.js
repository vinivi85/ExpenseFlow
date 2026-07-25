// Vercel Serverless Function
// Desassocia um cartão da conta do Plaid. Se essa era a última conta usando aquele
// login (item), remove o login inteiro no lado do Plaid também (libera a vaga
// contra o limite de Items). Se outras contas do mesmo login ainda estiverem em uso
// por outros cartões, só desfaz essa associação específica.

function plaidBaseUrl() {
  const env = process.env.PLAID_ENV || 'sandbox';
  return env === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';
}

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
  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados no servidor' });
    return;
  }

  try {
    const { card_id } = req.body;
    if (!card_id) { res.status(400).json({ error: 'card_id é obrigatório' }); return; }

    const connRes = await supaFetch(supabaseUrl, serviceKey, `plaid_connections?card_id=eq.${card_id}&select=*`);
    const connections = await connRes.json();
    if (!connections || connections.length === 0) {
      res.status(404).json({ error: 'Cartão não tem conexão pra desconectar' });
      return;
    }
    const conn = connections[0];
    const itemRef = conn.item_ref;

    // Remove só essa conexão específica (desassocia do cartão)
    await supaFetch(supabaseUrl, serviceKey, `plaid_connections?id=eq.${conn.id}`, { method: 'DELETE' });

    // Se não sobrou mais nenhuma conta desse mesmo login usando um cartão, remove o login inteiro
    if (itemRef) {
      const remainingRes = await supaFetch(supabaseUrl, serviceKey, `plaid_connections?item_ref=eq.${itemRef}&select=id`);
      const remaining = await remainingRes.json();
      if (!remaining || remaining.length === 0) {
        const itemRowRes = await supaFetch(supabaseUrl, serviceKey, `plaid_items?id=eq.${itemRef}&select=*`);
        const itemRow = (await itemRowRes.json())[0];
        if (itemRow && clientId && secret) {
          try {
            await fetch(`${plaidBaseUrl()}/item/remove`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ client_id: clientId, secret: secret, access_token: itemRow.plaid_access_token }),
            });
          } catch (e) { /* token pode já ser inválido (ex: sobra de Sandbox), não bloqueia */ }
        }
        await supaFetch(supabaseUrl, serviceKey, `plaid_items?id=eq.${itemRef}`, { method: 'DELETE' });
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
