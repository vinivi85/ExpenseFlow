// Lógica compartilhada de sincronização com o Plaid, usada tanto pelo botão manual
// "Sincronizar tudo" quanto pelo cron diário automático. Não é uma rota (o "_" no
// nome do arquivo faz a Vercel ignorar isso como endpoint).

function plaidBaseUrl() {
  const env = process.env.PLAID_ENV || 'sandbox';
  return env === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';
}

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

// Sincroniza UMA conexão (um cartão). Recebe os dados já carregados (cartões,
// categorias, usuário padrão) pra não precisar buscar de novo a cada cartão
// quando estamos sincronizando vários de uma vez.
async function syncOneConnection({ supabaseUrl, serviceKey, clientId, secret, conn, cardName, categoryNames, defaultUser }) {
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
      return { error: syncData.error_message || 'Erro ao sincronizar' };
    }
    added = added.concat(syncData.added || []);
    cursor = syncData.next_cursor;
    hasMore = syncData.has_more;
  }

  const toInsert = added
    .filter(t => !t.pending && t.amount > 0)
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
      return { error: 'Erro ao salvar despesas: ' + errText };
    }
  }

  await supaFetch(supabaseUrl, serviceKey, `plaid_connections?id=eq.${conn.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ cursor, last_synced_at: new Date().toISOString(), status: 'connected' }),
  });

  return { imported: toInsert.length };
}

// Sincroniza TODAS as conexões ativas de uma vez (usado pelo botão "Sincronizar tudo" e pelo cron).
async function syncAllConnections({ supabaseUrl, serviceKey, clientId, secret }) {
  const [connRes, cardRes, catRes, userRes] = await Promise.all([
    supaFetch(supabaseUrl, serviceKey, 'plaid_connections?select=*'),
    supaFetch(supabaseUrl, serviceKey, 'cards?select=id,name'),
    supaFetch(supabaseUrl, serviceKey, 'categories?select=name'),
    supaFetch(supabaseUrl, serviceKey, 'users?select=name&order=created_at.asc&limit=1'),
  ]);
  const connections = await connRes.json();
  const cardRows = await cardRes.json();
  const categoryNames = (await catRes.json()).map(c => c.name);
  const defaultUser = (await userRes.json())[0]?.name || 'Vinicius';
  const cardById = {};
  cardRows.forEach(c => { cardById[c.id] = c.name; });

  const results = [];
  for (const conn of connections) {
    const cardName = cardById[conn.card_id] || conn.account_name || 'Cartão';
    const result = await syncOneConnection({ supabaseUrl, serviceKey, clientId, secret, conn, cardName, categoryNames, defaultUser });
    results.push({ card: cardName, ...result });
  }
  return results;
}

export { syncOneConnection, syncAllConnections, plaidBaseUrl };
