// Vercel Serverless Function
// Sincroniza as transações novas de um cartão conectado via Plaid, jogando
// direto na tabela expenses (já com o nome do cartão certo). Usa /transactions/sync,
// que é incremental — guarda um "cursor" pra só trazer o que é novo da próxima vez.

function plaidBaseUrl() {
  const env = process.env.PLAID_ENV || 'sandbox';
  return env === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';
}

// Mapeia a categoria do Plaid (personal_finance_category.primary) pras nossas categorias
const PLAID_CATEGORY_MAP = {
  FOOD_AND_DRINK: 'Restaurante',
  GROCERIES: 'Mercado',
  GENERAL_MERCHANDISE: 'Compras',
  TRANSPORTATION: 'Transporte',
  TRAVEL: 'Viagem',
  RENT_AND_UTILITIES: 'Contas Fixas',
  MEDICAL: 'Saúde',
  PERSONAL_CARE: 'Saúde',
  ENTERTAINMENT: 'Lazer',
  EDUCATION: 'Educação',
  HOME_IMPROVEMENT: 'Casa',
  LOAN_PAYMENTS: 'Contas Fixas',
  GENERAL_SERVICES: 'Contas Fixas',
};

async function supaFetch(supabaseUrl, serviceKey, path, opts = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      ...(opts.headers || {}),
    },
  });
  return res;
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

    let cursor = conn.cursor || null;
    let added = [];
    let hasMore = true;
    while (hasMore) {
      const syncRes = await fetch(`${plaidBaseUrl()}/transactions/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId, secret: secret,
          access_token: conn.plaid_access_token,
          cursor: cursor || undefined,
        }),
      });
      const syncData = await syncRes.json();
      if (!syncRes.ok) {
        res.status(syncRes.status).json({ error: syncData.error_message || 'Erro ao sincronizar', detail: syncData });
        return;
      }
      added = added.concat(syncData.added || []);
      cursor = syncData.next_cursor;
      hasMore = syncData.has_more;
    }

    const toInsert = added
      .filter(t => !t.pending && t.amount > 0) // Plaid usa positivo pra gasto, negativo pra crédito/pagamento
      .map(t => {
        const primaryCat = t.personal_finance_category?.primary;
        const category = PLAID_CATEGORY_MAP[primaryCat] || categoryNames[categoryNames.length - 1] || 'Outros';
        return {
          description: t.merchant_name || t.name || 'Transação',
          amount: Math.abs(t.amount),
          category,
          card: cardName,
          date: t.date,
          added_by: defaultUser,
          source: 'plaid',
        };
      });

    if (toInsert.length > 0) {
      const insertRes = await supaFetch(supabaseUrl, serviceKey, 'expenses', {
        method: 'POST',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify(toInsert),
      });
      if (!insertRes.ok) {
        const errText = await insertRes.text();
        res.status(500).json({ error: 'Erro ao salvar despesas: ' + errText });
        return;
      }
    }

    await supaFetch(supabaseUrl, serviceKey, `plaid_connections?id=eq.${conn.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ cursor, last_synced_at: new Date().toISOString(), status: 'connected' }),
    });

    res.status(200).json({ ok: true, imported: toInsert.length });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
