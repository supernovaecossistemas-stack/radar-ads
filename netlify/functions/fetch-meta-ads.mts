// netlify/functions/fetch-meta-ads.mts
//
// Scheduled Function (Netlify) que roda de hora em hora, busca dados de
// orçamento e métricas de cada conta de anúncio no Meta e salva no Supabase.
//
// Configuração necessária (Netlify > Site settings > Environment variables):
//   META_ACCESS_TOKEN   -> token de um System User com permissão ads_read
//   SUPABASE_URL        -> url do seu projeto Supabase
//   SUPABASE_SERVICE_KEY -> service role key do Supabase (não a anon key)
//
// A lista de contas monitoradas fica na tabela `clients` do Supabase
// (ver supabase-schema.sql) em vez de hardcoded aqui, pra você poder
// adicionar/remover clientes sem precisar redeployar.

import type { Config } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const META_API_VERSION = "v21.0";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function fetchAccountInsights(adAccountId: string) {
  // adAccountId no formato "act_1234567890"
  const fields = [
    "spend",
    "actions",
    "cost_per_action_type",
  ].join(",");

  const url = `https://graph.facebook.com/${META_API_VERSION}/${adAccountId}/insights` +
    `?fields=${fields}&date_preset=last_7d&access_token=${process.env.META_ACCESS_TOKEN}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Meta API error for ${adAccountId}: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  const row = json.data?.[0] ?? null;
  if (!row) return null;

  // "lead" cobre a maioria das contas; contas com pixel customizado podem usar
  // "offsite_conversion.fb_pixel_lead" ou "onsite_conversion.lead_grouped".
  const leadAction = row.actions?.find((a: any) => a.action_type.includes("lead"));
  const leadCostAction = row.cost_per_action_type?.find((a: any) => a.action_type.includes("lead"));

  const leads = leadAction ? Number(leadAction.value) : 0;
  const spend = row.spend ? Number(row.spend) : 0;
  const cpl = leadCostAction
    ? Number(leadCostAction.value)
    : (leads > 0 ? spend / leads : null);

  return { spend, leads, cpl };
}

// Gasto de HOJE da conta (não os últimos 7 dias).
async function fetchTodaySpend(adAccountId: string) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${adAccountId}/insights` +
    `?fields=spend&date_preset=today&access_token=${process.env.META_ACCESS_TOKEN}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Meta API error for ${adAccountId}: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  const row = json.data?.[0] ?? null;
  return row?.spend ? Number(row.spend) : 0;
}

// Soma do orçamento diário de todas as campanhas ATIVAS da conta.
// Campanhas com CBO trazem daily_budget na campanha; campanhas sem CBO
// trazem o orçamento nos ad sets, então somamos os dois casos.
async function fetchActiveDailyBudget(adAccountId: string) {
  let total = 0;

  // Orçamento diário nas campanhas ativas (CBO)
  const campUrl = `https://graph.facebook.com/${META_API_VERSION}/${adAccountId}/campaigns` +
    `?fields=daily_budget,effective_status&effective_status=["ACTIVE"]&limit=500` +
    `&access_token=${process.env.META_ACCESS_TOKEN}`;
  const campRes = await fetch(campUrl);
  if (campRes.ok) {
    const campJson = await campRes.json();
    for (const c of campJson.data ?? []) {
      if (c.daily_budget) total += Number(c.daily_budget);
    }
  }

  // Orçamento diário nos ad sets ativos (campanhas sem CBO)
  const setUrl = `https://graph.facebook.com/${META_API_VERSION}/${adAccountId}/adsets` +
    `?fields=daily_budget,effective_status&effective_status=["ACTIVE"]&limit=500` +
    `&access_token=${process.env.META_ACCESS_TOKEN}`;
  const setRes = await fetch(setUrl);
  if (setRes.ok) {
    const setJson = await setRes.json();
    for (const s of setJson.data ?? []) {
      if (s.daily_budget) total += Number(s.daily_budget);
    }
  }

  // Meta devolve valores em centavos
  return total / 100;
}

// Fundos disponíveis da conta (só existe em contas pré-pagas).
async function fetchAccountFunds(adAccountId: string) {
  const fields = [
    "balance",
    "amount_spent",
    "spend_cap",
    "currency",
    "funding_source_details",
  ].join(",");
  const url = `https://graph.facebook.com/${META_API_VERSION}/${adAccountId}` +
    `?fields=${fields}&access_token=${process.env.META_ACCESS_TOKEN}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Meta API error for ${adAccountId}: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();

  // O saldo pré-pago pode vir em lugares diferentes conforme a conta.
  // Tentamos as fontes conhecidas, na ordem, e usamos a primeira que existir.
  let funds: number | null = null;
  const fsd = json.funding_source_details;

  // 1) Campo numérico direto (algumas contas)
  const prepay = fsd?.prepay_balance;
  if (prepay?.amount != null) {
    funds = Number(prepay.amount) / 100;
  } else if (typeof prepay === "string" || typeof prepay === "number") {
    funds = Number(prepay) / 100;
  }

  // 2) Texto "Saldo disponível (R$548,71 BRL)" — extrai o número de dentro
  if (funds == null && typeof fsd?.display_string === "string") {
    const m = fsd.display_string.match(/R\$\s?([\d.]+,\d{2})/);
    if (m) {
      // "548,71" -> 548.71
      funds = Number(m[1].replace(/\./g, "").replace(",", "."));
    }
  }

  return { funds };
}

export default async () => {
  const { data: clients, error } = await supabase
    .from("clients")
    .select("id, name, meta_ad_account_id")
    .not("meta_ad_account_id", "is", null);

  if (error) {
    console.error("Erro ao buscar clientes no Supabase:", error);
    return new Response("erro", { status: 500 });
  }

  for (const client of clients) {
    try {
      const [insights, todaySpend, dailyBudget, funds] = await Promise.all([
        fetchAccountInsights(client.meta_ad_account_id),
        fetchTodaySpend(client.meta_ad_account_id),
        fetchActiveDailyBudget(client.meta_ad_account_id),
        fetchAccountFunds(client.meta_ad_account_id),
      ]);

      await supabase.from("ad_snapshots").insert({
        client_id: client.id,
        platform: "meta",
        spend_7d: insights?.spend ?? null,
        leads_7d: insights?.leads ?? null,
        cpl_7d: insights?.cpl ?? null,
        daily_budget: dailyBudget,
        today_spend: todaySpend,
        remaining_funds: funds?.funds ?? null,
        checked_at: new Date().toISOString(),
      });

      console.log(`OK: ${client.name}`);
    } catch (err) {
      console.error(`Falhou: ${client.name}`, err);
      // Continua para os próximos clientes mesmo se um falhar
    }
  }

  return new Response("done", { status: 200 });
};

export const config: Config = {
  schedule: "@hourly",
};
