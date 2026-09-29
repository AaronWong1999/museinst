




//


import type { Env } from "./env";
import { newId, now } from "./util";
import { sendOutbound } from "./channels/outbound";

export interface LocationPoint {
  id: string;
  source: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  live: number;
  created_at: number;
}

export interface SavedPlace {
  id: string;
  label: string;
  lat: number;
  lng: number;
  radius_m: number;
}

export interface LocationTrigger {
  id: string;
  label: string;
  kind: "enter" | "leave";
  place_id: string | null;
  lat: number | null;
  lng: number | null;
  radius_m: number | null;
  message: string;
  channel: string;
  external_id: string;
  context_token: string | null;
  enabled: number;
  inside: number;
  last_fired_at: number | null;
}

export interface Visit {
  label: string | null;
  lat: number;
  lng: number;
  arrivedAt: number;
  leftAt: number;
  minutes: number;
}

const EARTH_R = 6_371_000;
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}



export async function ingestLocation(
  env: Env,
  workspaceId: string,
  p: { source: string; lat: number; lng: number; accuracy?: number; live?: boolean },
): Promise<{ ok: boolean; firedTriggers: number }> {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
    return { ok: false, firedTriggers: 0 };
  }
  await env.DB.prepare(
    `INSERT INTO location_points (id, workspace_id, source, lat, lng, accuracy, live, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId("loc"), workspaceId, p.source.slice(0, 16), p.lat, p.lng, p.accuracy ?? null, p.live ? 1 : 0, now())
    .run();

  await env.DB.prepare(
    `DELETE FROM location_points WHERE workspace_id=? AND created_at < ?`,
  )
    .bind(workspaceId, now() - 30 * 86_400_000)
    .run();
  const fired = await evaluateTriggers(env, workspaceId);
  return { ok: true, firedTriggers: fired };
}



export async function recentPoints(env: Env, workspaceId: string, sinceMs: number, limit = 500): Promise<LocationPoint[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, source, lat, lng, accuracy, live, created_at FROM location_points
      WHERE workspace_id=? AND created_at >= ? ORDER BY created_at ASC LIMIT ?`,
  )
    .bind(workspaceId, sinceMs, limit)
    .all<LocationPoint>();
  return results ?? [];
}


export function computeVisits(points: LocationPoint[], radiusM = 150, minDwellMs = 5 * 60_000): Visit[] {
  const visits: Visit[] = [];
  let cluster: LocationPoint[] = [];
  const flush = () => {
    if (cluster.length >= 2) {
      const arrivedAt = cluster[0].created_at;
      const leftAt = cluster[cluster.length - 1].created_at;
      if (leftAt - arrivedAt >= minDwellMs) {
        const lat = cluster.reduce((s, p) => s + p.lat, 0) / cluster.length;
        const lng = cluster.reduce((s, p) => s + p.lng, 0) / cluster.length;
        visits.push({ label: null, lat, lng, arrivedAt, leftAt, minutes: Math.round((leftAt - arrivedAt) / 60_000) });
      }
    }
    cluster = [];
  };
  for (const p of points) {
    if (cluster.length === 0 || haversineM(cluster[cluster.length - 1].lat, cluster[cluster.length - 1].lng, p.lat, p.lng) <= radiusM) {
      cluster.push(p);
    } else {
      flush();
      cluster.push(p);
    }
  }
  flush();
  return visits;
}

export async function lastKnown(env: Env, workspaceId: string): Promise<LocationPoint | null> {
  const row = await env.DB.prepare(
    `SELECT id, source, lat, lng, accuracy, live, created_at FROM location_points
      WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(workspaceId)
    .first<LocationPoint>();
  return row ?? null;
}


export async function labelVisits(env: Env, workspaceId: string, visits: Visit[]): Promise<Visit[]> {
  const places = await listPlaces(env, workspaceId);
  for (const v of visits) {
    const hit = places.find((pl) => haversineM(pl.lat, pl.lng, v.lat, v.lng) <= pl.radius_m);
    if (hit) v.label = hit.label;
    // Keep null when cluster center is not in any saved places; model uses coordinates
  }
  return visits;
}



export async function listPlaces(env: Env, workspaceId: string): Promise<SavedPlace[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, label, lat, lng, radius_m FROM saved_places WHERE workspace_id=? ORDER BY created_at ASC`,
  )
    .bind(workspaceId)
    .all<SavedPlace>();
  return results ?? [];
}

export async function savePlace(env: Env, workspaceId: string, label: string, lat: number, lng: number, radiusM = 150): Promise<SavedPlace> {
  const id = newId("pl");
  await env.DB.prepare(
    `INSERT INTO saved_places (id, workspace_id, label, lat, lng, radius_m, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, label) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, radius_m=excluded.radius_m`,
  )
    .bind(id, workspaceId, label.slice(0, 40), lat, lng, radiusM, now())
    .run();
  const row = await env.DB.prepare(
    `SELECT id, label, lat, lng, radius_m FROM saved_places WHERE workspace_id=? AND label=?`,
  )
    .bind(workspaceId, label.slice(0, 40))
    .first<SavedPlace>();
  return row!;
}

export async function deletePlace(env: Env, workspaceId: string, labelOrId: string): Promise<boolean> {
  const r = await env.DB.prepare(`DELETE FROM saved_places WHERE workspace_id=? AND (id=? OR label=?)`)
    .bind(workspaceId, labelOrId, labelOrId)
    .run();

  return (r.meta?.changes ?? 0) > 0;
}



export async function listTriggers(env: Env, workspaceId: string): Promise<Array<LocationTrigger & { placeLabel: string | null }>> {
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.label, t.kind, t.place_id, t.lat, t.lng, t.radius_m, t.message, t.channel,
            t.external_id, t.context_token, t.enabled, t.inside, t.last_fired_at,
            p.label AS placeLabel
       FROM location_triggers t LEFT JOIN saved_places p ON p.id = t.place_id
      WHERE t.workspace_id=? ORDER BY t.created_at ASC`,
  )
    .bind(workspaceId)
    .all<LocationTrigger & { placeLabel: string | null }>();
  return results ?? [];
}

export async function createTrigger(
  env: Env,
  workspaceId: string,
  t: {
    label: string;
    kind: "enter" | "leave";
    placeLabel?: string;
    lat?: number;
    lng?: number;
    radiusM?: number;
    message: string;
    channel: string;
    externalId: string;
    contextToken?: string;
  },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  let placeId: string | null = null;
  let lat = t.lat ?? null;
  let lng = t.lng ?? null;
  let radiusM = t.radiusM ?? null;
  if (t.placeLabel) {
    const places = await listPlaces(env, workspaceId);
    const hit = places.find((p) => p.label === t.placeLabel);
    if (!hit) return { ok: false, error: `unknown_place:${t.placeLabel}` };
    placeId = hit.id;
    lat = hit.lat;
    lng = hit.lng;
    radiusM = t.radiusM ?? hit.radius_m;
  }
  if (lat == null || lng == null) return { ok: false, error: "need_place_or_coords" };
  const id = newId("trg");
  await env.DB.prepare(
    `INSERT INTO location_triggers (id, workspace_id, label, kind, place_id, lat, lng, radius_m,
                                    message, channel, external_id, context_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id, workspaceId, t.label.slice(0, 60), t.kind, placeId, lat, lng, radiusM ?? 150,
      t.message.slice(0, 500), t.channel.slice(0, 16), t.externalId.slice(0, 64), t.contextToken ?? null, now(),
    )
    .run();
  return { ok: true, id };
}

export async function deleteTrigger(env: Env, workspaceId: string, idOrLabel: string): Promise<boolean> {
  const r = await env.DB.prepare(`DELETE FROM location_triggers WHERE workspace_id=? AND (id=? OR label=?)`)
    .bind(workspaceId, idOrLabel, idOrLabel)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}


export async function evaluateTriggers(env: Env, workspaceId: string): Promise<number> {
  const triggers = await env.DB.prepare(
    `SELECT id, label, kind, lat, lng, radius_m, message, channel, external_id, context_token, inside, last_fired_at
       FROM location_triggers WHERE workspace_id=? AND enabled=1 AND lat IS NOT NULL`,
  )
    .bind(workspaceId)
    .all<{ id: string; label: string; kind: "enter" | "leave"; lat: number; lng: number; radius_m: number; message: string; channel: string; external_id: string; context_token: string | null; inside: number; last_fired_at: number | null }>();
  const rows = triggers.results ?? [];
  if (rows.length === 0) return 0;
  const cur = await lastKnown(env, workspaceId);
  if (!cur || now() - cur.created_at > 30 * 60_000) return 0;
  let fired = 0;
  for (const t of rows) {
    const dist = haversineM(cur.lat, cur.lng, t.lat, t.lng);
    const inside = dist <= (t.radius_m || 150);
    const wasInside = t.inside === 1;
    const edge = t.kind === "enter" ? inside && !wasInside : !inside && wasInside;
    const cooled = !t.last_fired_at || now() - t.last_fired_at > 30 * 60_000;
    let didFire = false;
    if (edge && cooled) {
      const res = await sendOutbound(env, t.channel as any, t.external_id, t.message, t.context_token ?? undefined);
      if (res.ok) {
        fired++;
        didFire = true;
      }
    }
    if (inside !== wasInside) {
      await env.DB.prepare(
        `UPDATE location_triggers SET inside=?, last_fired_at=CASE WHEN ?=1 THEN ? ELSE last_fired_at END WHERE id=?`,
      )
        .bind(inside ? 1 : 0, didFire ? 1 : 0, now(), t.id)
        .run();
    } else if (edge) {
      await env.DB.prepare(`UPDATE location_triggers SET last_fired_at=? WHERE id=?`).bind(now(), t.id).run();
    }
  }
  return fired;
}



const UA = "openinst-location/1.0 (self-hosted personal agent)";

export async function geocode(query: string): Promise<Array<{ name: string; lat: number; lng: number }>> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) return [];
  const j = (await res.json()) as Array<{ display_name: string; lat: string; lon: string }>;
  return j.map((r) => ({ name: r.display_name, lat: Number(r.lat), lng: Number(r.lon) }));
}

export async function reverseGeocode(lat: number, lng: number): Promise<string> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  const j = (await res.json()) as { display_name?: string };
  return j.display_name ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}


export async function nearbySearch(lat: number, lng: number, amenity: string, radiusM = 1000): Promise<Array<{ name: string; distM: number }>> {
  const around = `${lat},${lng},${radiusM}`;
  const q = `[out:json][timeout:10];node["amenity"="${amenity}"](around:${around});out center 20;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: `data=${encodeURIComponent(q)}`,
  });
  if (!res.ok) return [];
  const j = (await res.json()) as { elements?: Array<{ lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: { name?: string } }> };
  return (j.elements ?? [])
    .map((e) => {
      const plat = e.center?.lat ?? e.lat ?? 0;
      const plng = e.center?.lon ?? e.lon ?? 0;
      return { name: e.tags?.name ?? "(unnamed)", distM: Math.round(haversineM(lat, lng, plat, plng)) };
    })
    .sort((a, b) => a.distM - b.distM)
    .slice(0, 12);
}


export async function locationContextBlock(env: Env, workspaceId: string): Promise<string> {
  const cur = await lastKnown(env, workspaceId);
  if (!cur) return "";
  const lines: string[] = [];
  lines.push(`最新位置：${cur.lat.toFixed(5)}, ${cur.lng.toFixed(5)}（${new Date(cur.created_at).toLocaleString("zh-CN")}，来源 ${cur.source}${cur.live ? "，实时共享中" : ""}）`);
  const places = await listPlaces(env, workspaceId);
  if (places.length) lines.push(`已存地点：${places.map((p) => `${p.label}(${p.lat.toFixed(4)},${p.lng.toFixed(4)},半径${p.radius_m}m)`).join("；")}`);
  const triggers = (await listTriggers(env, workspaceId)).filter((t) => t.enabled);
  if (triggers.length) lines.push(`围栏触发器：${triggers.map((t) => `${t.kind === "enter" ? "进入" : "离开"}${t.placeLabel ?? `${t.lat?.toFixed(4)},${t.lng?.toFixed(4)}`} → 发「${t.message.slice(0, 30)}」`).join("；")}`);
  const visits = await labelVisits(env, workspaceId, computeVisits(await recentPoints(env, workspaceId, now() - 7 * 86_400_000)));
  if (visits.length) {
    lines.push(`近 7 天造访（聚类）：${visits.slice(-8).map((v) => `${v.label ?? `${v.lat.toFixed(4)},${v.lng.toFixed(4)}`} ${new Date(v.arrivedAt).toLocaleDateString("zh-CN")} ${v.minutes}分钟`).join("；")}`);
  }
  return lines.join("\n");
}
