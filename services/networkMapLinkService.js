const db = require('../config/database');

function listAllNetworkMapLinks() {
  return db.prepare(`
    SELECT l.*,
           o1.name AS from_odp_name,
           o1.lat AS from_odp_lat,
           o1.lng AS from_odp_lng,
           o2.name AS to_odp_name,
           o2.lat AS to_odp_lat,
           o2.lng AS to_odp_lng
    FROM network_map_links l
    JOIN odps o1 ON o1.id = l.from_odp_id
    JOIN odps o2 ON o2.id = l.to_odp_id
    ORDER BY l.id ASC
  `).all();
}

function getNetworkMapLinkByPair(fromOdpId, toOdpId) {
  const fromId = Number(fromOdpId);
  const toId = Number(toOdpId);
  if (!Number.isFinite(fromId) || !Number.isFinite(toId)) return null;
  return db.prepare(`
    SELECT *
    FROM network_map_links
    WHERE (from_odp_id = ? AND to_odp_id = ?)
       OR (from_odp_id = ? AND to_odp_id = ?)
    LIMIT 1
  `).get(fromId, toId, toId, fromId);
}

function saveNetworkMapLink(data = {}) {
  const fromOdpId = Number(data.fromOdpId || 0);
  const toOdpId = Number(data.toOdpId || 0);
  if (!Number.isFinite(fromOdpId) || fromOdpId <= 0) throw new Error('ODP asal tidak valid');
  if (!Number.isFinite(toOdpId) || toOdpId <= 0) throw new Error('ODP tujuan tidak valid');
  if (fromOdpId === toOdpId) throw new Error('ODP asal dan tujuan tidak boleh sama');
  const linkKind = String(data.linkKind || 'backbone').trim().toLowerCase() || 'backbone';
  const cableSize = String(data.cableSize || '').trim();
  const pathJson = String(data.pathJson || '').trim();
  const color = String(data.color || '').trim();
  const existing = getNetworkMapLinkByPair(fromOdpId, toOdpId);
  if (existing) {
    db.prepare(`
      UPDATE network_map_links
      SET from_odp_id = ?,
          to_odp_id = ?,
          link_kind = ?,
          cable_size = ?,
          path_json = ?,
          color = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(fromOdpId, toOdpId, linkKind, cableSize, pathJson, color, existing.id);
    return { id: existing.id, updated: true };
  }
  const result = db.prepare(`
    INSERT INTO network_map_links (from_odp_id, to_odp_id, link_kind, cable_size, path_json, color)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(fromOdpId, toOdpId, linkKind, cableSize, pathJson, color);
  return { id: result.lastInsertRowid, created: true };
}

function deleteNetworkMapLink(id) {
  const linkId = Number(id || 0);
  if (!Number.isFinite(linkId) || linkId <= 0) throw new Error('ID jalur backbone tidak valid');
  return db.prepare('DELETE FROM network_map_links WHERE id = ?').run(linkId);
}

module.exports = {
  listAllNetworkMapLinks,
  getNetworkMapLinkByPair,
  saveNetworkMapLink,
  deleteNetworkMapLink
};
