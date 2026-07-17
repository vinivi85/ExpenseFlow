# Razão · Controle de Gastos

App de controle de gastos compartilhado (Vinicius + Aline), com importação de fatura em PDF via IA.

## Deploy (Vercel)

1. Crie um repo novo no GitHub e suba esta pasta (`git init`, `git add .`, `git commit`, `git push`).
2. Em vercel.com → **Add New Project** → importe o repo.
3. Em **Settings → Environment Variables**, adicione:
   - `GEMINI_API_KEY` = sua chave gratuita do Google AI Studio (aistudio.google.com/apikey — não pede cartão)
4. Deploy. A Vercel detecta `vercel.json` e serve `index.html` como estático + `api/gemini.js` como função serverless automaticamente.

## Configurar o banco (Supabase)

1. Crie um projeto grátis em supabase.com.
2. Vá em **SQL Editor** e rode o SQL que aparece na aba **Config** do próprio app (ou copie do bloco abaixo).
3. Vá em **Project Settings → API**, copie a **Project URL** e a **anon public key**.
4. Abra o app publicado, vá na aba **Config**, cole a URL e a key, salve.

```sql
create extension if not exists "uuid-ossp";

create table if not exists expenses (
  id uuid primary key default uuid_generate_v4(),
  description text not null,
  amount numeric not null,
  category text,
  date date not null,
  added_by text not null,
  source text default 'manual',
  created_at timestamp default now()
);

alter table expenses enable row level security;

create policy "anyone_select_expenses" on expenses for select using (true);
create policy "anyone_insert_expenses" on expenses for insert with check (true);
create policy "anyone_delete_expenses" on expenses for delete using (true);
create policy "anyone_update_expenses" on expenses for update using (true);
```

## Como funciona a parte de IA

O frontend nunca fala direto com a API do Google. Ele chama `/api/gemini`,
uma função serverless que roda no servidor da Vercel, usa a variável de
ambiente `GEMINI_API_KEY` (nunca exposta no navegador) e repassa a
resposta. Usa o modelo `gemini-2.5-flash`, que fica no tier gratuito do
Google (sem cartão de crédito, ~10 requisições/min, 250/dia — bem mais do
que um app pessoal de gastos costuma usar). Isso é usado em dois lugares:

- **Importar fatura em PDF**: extrai as transações e sugere categoria pra cada uma.
- **Sugerir categoria** ao adicionar um gasto manual.

## Uso compartilhado

Não há login — é uma "casa" compartilhada. Cada lançamento fica marcado com
quem adicionou (Vinicius ou Aline), escolhido no topo do app. Os dois veem os
mesmos dados em tempo real (via Supabase).
