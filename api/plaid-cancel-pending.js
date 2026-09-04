// Vercel Serverless Function
// Cancela uma conta do Plaid que ainda está esperando associação (não tem
// card_id ainda) — usado quando o login trouxe conta(s) demais por engano
// (ex: clicou "conectar" duas vezes sem querer) e a pessoa quer desistir
// dessa conexão específica antes de terminar de associar a um cartão.
// Se essa era a última conta daquele login, remove o login inteiro também
// (libera a vaga contra o limite de Items do Plaid).

function plaidBaseUrl() {
  const env = process.env.PLAID_ENV || 'sandbox';
  return env === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';
}

function plaidCredsFor(account) {
  if (Number(account) === 2) {
    return { clientId: process.env.PLAID_CLIENT_ID_2, secret: process.env.PLAID_SECRET_2 };
  }
  return { clientId: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET };
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

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados no servidor' });
    return;
  }

  try {
    const { connection_id } = req.body;
    if (!connection_id) { res.status(400).json({ error: 'connection_id é obrigatório' }); return; }

    const connRes = await supaFetch(supabaseUrl, serviceKey, `plaid_connections?id=eq.${connection_id}&select=*`);
    const conns = await connRes.json();
    if (!conns || conns.length === 0) { res.status(404).json({ error: 'Conexão não encontrada' }); return; }
    const conn = conns[0];
    const itemRef = conn.item_ref;

    await supaFetch(supabaseUrl, serviceKey, `plaid_connections?id=eq.${connection_id}`, { method: 'DELETE' });

    // Se não sobrou mais nenhuma conta desse mesmo login, remove o login inteiro
    if (itemRef) {
      const remainingRes = await supaFetch(supabaseUrl, serviceKey, `plaid_connections?item_ref=eq.${itemRef}&select=id`);
      const remaining = await remainingRes.json();
      if (!remaining || remaining.length === 0) {
        const itemRowRes = await supaFetch(supabaseUrl, serviceKey, `plaid_items?id=eq.${itemRef}&select=*`);
        const itemRow = (await itemRowRes.json())[0];
        const { clientId, secret } = plaidCredsFor(itemRow?.plaid_account);
        if (itemRow && clientId && secret) {
          try {
            await fetch(`${plaidBaseUrl()}/item/remove`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ client_id: clientId, secret: secret, access_token: itemRow.plaid_access_token }),
            });
          } catch (e) { /* token pode já não valer mais, não bloqueia a limpeza local */ }
        }
        await supaFetch(supabaseUrl, serviceKey, `plaid_items?id=eq.${itemRef}`, { method: 'DELETE' });
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
