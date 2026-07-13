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

async function fetchAccountBudget(adAccountId: string) {
  const fields = ["amount_spent", "spend_cap", "balance"].join(",");
  const url = `https://graph.facebook.com/${META_API_VERSION}/${adAccountId}` +
    `?fields=${fields}&access_token=${process.env.META_ACCESS_TOKEN}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Meta API error for ${adAccountId}: ${res.status} ${await res.text()}`);
  }
  return res.json();
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
      const [insights, budget] = await Promise.all([
        fetchAccountInsights(client.meta_ad_account_id),
        fetchAccountBudget(client.meta_ad_account_id),
      ]);

      await supabase.from("ad_snapshots").insert({
        client_id: client.id,
        platform: "meta",
        spend_7d: insights?.spend ?? null,
        leads_7d: insights?.leads ?? null,
        cpl_7d: insights?.cpl ?? null,
        spend_cap: budget?.spend_cap ? Number(budget.spend_cap) / 100 : null,
        amount_spent: budget?.amount_spent ? Number(budget.amount_spent) / 100 : null,
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
