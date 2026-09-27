// ATLAS-BALIE — de balie van je oordeelgeheugen.
// Routes: ingest (notities erin) · embed-pending (nieuwe notities doorzoekbaar maken)
//         vraag (zoeken) · inbox (losse gedachte parkeren)
// Embeddings: gte-small (384 dim), ingebouwd in Supabase — geen extra sleutel of account nodig.
// Elke aanroep vereist TWEE headers:
//   Authorization: Bearer <jouw anon key>      (de standaard deur van Supabase)
//   x-atlas-key: <jouw sleutel uit de tabel instellingen>
// Let op: de ingebouwde rekenkracht haalt 3 tot 5 embeddings per aanroep.
// Daarom werkt embed-pending in kleine stapjes; een klok-flow in n8n roept hem vaker aan.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const model = new Supabase.ai.Session('gte-small')
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, x-atlas-key, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  })

async function sleutelKlopt(req: Request): Promise<boolean> {
  const aangeboden = req.headers.get('x-atlas-key')
  if (!aangeboden) return false
  const { data } = await db.from('instellingen').select('waarde_text').eq('sleutel', 'atlas_balie_key').single()
  return !!data?.waarde_text && data.waarde_text !== 'VERVANG-MIJ' && data.waarde_text === aangeboden
}

const embed = async (t: string) => (await model.run(t, { mean_pool: true, normalize: true })) as number[]
async function sha(t: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true })
  if (req.method !== 'POST') return json({ fout: 'alleen POST' }, 405)
  if (!(await sleutelKlopt(req))) {
    return json({ fout: 'x-atlas-key ontbreekt, klopt niet, of staat nog op VERVANG-MIJ' }, 401)
  }

  const route = new URL(req.url).pathname.split('/').filter(Boolean).pop()
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { body = {} }

  // Nieuwe notities doorzoekbaar maken, in kleine stapjes.
  if (route === 'embed-pending') {
    const { data, error } = await db.from('atlas_chunks')
      .select('id,titel,inhoud').is('embedding', null)
      .limit(Math.min(Number(body.limiet ?? 3), 5))
    if (error) return json({ fout: error.message }, 500)
    let gedaan = 0
    for (const r of data ?? []) {
      const embedding = await embed(`${r.titel}\n\n${r.inhoud}`.slice(0, 6000))
      const { error: e2 } = await db.from('atlas_chunks')
        .update({ embedding, bijgewerkt: new Date().toISOString() }).eq('id', r.id)
      if (e2) return json({ fout: e2.message, id: r.id, gedaan }, 500)
      gedaan++
    }
    const { count } = await db.from('atlas_chunks').select('id', { count: 'exact', head: true }).is('embedding', null)
    return json({ ok: true, geembed: gedaan, nog_te_doen: count ?? 0 })
  }

  // Notities erin, maximaal 5 per aanroep. Ongewijzigde notities worden overgeslagen.
  if (route === 'ingest') {
    const notities = (body.notities ?? []) as Array<{ pad: string; type: string; titel: string; inhoud: string }>
    if (!Array.isArray(notities) || notities.length === 0) return json({ fout: 'notities ontbreekt' }, 400)
    let nieuw = 0, bijgewerkt = 0, ongewijzigd = 0
    for (const n of notities.slice(0, 5)) {
      if (!n?.pad || !n?.inhoud) continue
      const hash = await sha(n.inhoud)
      const { data: bestaand } = await db.from('atlas_chunks').select('id,hash').eq('pad', n.pad).maybeSingle()
      if (bestaand?.hash === hash) { ongewijzigd++; continue }
      const embedding = await embed(`${n.titel}\n\n${n.inhoud}`.slice(0, 6000))
      const { error } = await db.from('atlas_chunks').upsert({
        pad: n.pad, type: n.type ?? 'kader', titel: n.titel ?? n.pad,
        inhoud: n.inhoud, hash, embedding, bijgewerkt: new Date().toISOString(),
      }, { onConflict: 'pad' })
      if (error) return json({ fout: error.message, pad: n.pad }, 500)
      bestaand ? bijgewerkt++ : nieuw++
    }
    return json({ ok: true, nieuw, bijgewerkt, ongewijzigd, let_op: 'maximaal 5 notities per aanroep' })
  }

  // Zoeken in het oordeelgeheugen: op betekenis (vector) én op Nederlandse woorden, samengevoegd in match_atlas.
  // Het ingebouwde model is Engels getraind; in het Nederlands zegt de gelijkenis weinig (alles scoort 0,83 tot 0,92).
  // Het echte signaal is de woordtreffer: dekt geen enkele notitie de woorden van de vraag, dan is er waarschijnlijk geen kader.
  if (route === 'vraag') {
    const vraag = String(body.vraag ?? '').trim()
    if (!vraag) return json({ fout: 'vraag ontbreekt' }, 400)
    const { data, error } = await db.rpc('match_atlas', {
      query_embedding: await embed(vraag),
      query_text: vraag,
      match_count: Math.min(Number(body.aantal ?? 6), 12),
      filter_type: (body.type as string) ?? null,
    })
    if (error) return json({ fout: error.message }, 500)
    type Treffer = { pad: string; type: string; titel: string; inhoud: string; gelijkenis: number; dekking: number; woordtreffer: boolean }
    const treffers = (data ?? []) as Treffer[]
    const metWoord = treffers.filter((t) => t.woordtreffer)
    return json({
      vraag,
      gevonden: metWoord.length,
      denken: treffers.map((t) => ({
        notitie: t.pad, type: t.type, titel: t.titel, tekst: t.inhoud,
        gelijkenis: Number(t.gelijkenis.toFixed(3)), dekking: t.dekking, woordtreffer: t.woordtreffer,
      })),
      gebruik: metWoord.length === 0
        ? 'Geen enkele notitie dekt de woorden van deze vraag. Waarschijnlijk heeft Atlas hier niets over: zeg dat eerlijk, verzin geen kader. Gebruik een notitie hieronder alleen als hij er aantoonbaar over gaat.'
        : 'Notities met woordtreffer zijn het meest waarschijnlijk. Feiten komen uit Cortex, het oordeel uit deze kaders. Bij tegenspraak wint Atlas voor het denken en Cortex voor het feit.',
    })
  }

  // Losse gedachte parkeren voor later.
  if (route === 'inbox') {
    const tekst = String(body.tekst ?? '').trim()
    if (!tekst) return json({ fout: 'tekst ontbreekt' }, 400)
    const { data, error } = await db.from('atlas_inbox').insert({
      tekst,
      context: body.context ? String(body.context).slice(0, 4000) : null,
      bron: body.bron ? String(body.bron) : 'balie',
      aangemaakt_door: body.door ? String(body.door) : null,
    }).select('id').single()
    if (error) return json({ fout: error.message }, 500)
    return json({ ok: true, id: data.id, melding: 'Vastgelegd. Loop je inbox wekelijks langs.' })
  }

  return json({ fout: 'onbekende route', routes: ['ingest', 'embed-pending', 'vraag', 'inbox'] }, 404)
})
