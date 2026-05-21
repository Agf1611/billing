const fs = require('fs');
const path = require('path');
const db = require('../config/database');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function toFixed6(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(6)) : null;
}

function formatCoord(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(6) : '';
}

function getNodeLatLng(node) {
  const lat = Number(node?.data?.latitude);
  const lng = Number(node?.data?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function isSamePoint(a, b, tolerance = 0.000001) {
  if (!a || !b) return false;
  const aLat = Array.isArray(a) ? Number(a[0]) : Number(a.lat);
  const aLng = Array.isArray(a) ? Number(a[1]) : Number(a.lng);
  const bLat = Array.isArray(b) ? Number(b[0]) : Number(b.lat);
  const bLng = Array.isArray(b) ? Number(b[1]) : Number(b.lng);
  if (![aLat, aLng, bLat, bLng].every(Number.isFinite)) return false;
  return Math.abs(aLat - bLat) <= tolerance && Math.abs(aLng - bLng) <= tolerance;
}

function sanitizeWaypoint(point) {
  if (!Array.isArray(point) || point.length < 2) return null;
  const lat = Number(point[0]);
  const lng = Number(point[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [toFixed6(lat), toFixed6(lng)];
}

function buildEdgePoints(edge, nodeMap) {
  const sourceNode = nodeMap.get(edge.source);
  const targetNode = nodeMap.get(edge.target);
  const sourceLatLng = getNodeLatLng(sourceNode);
  const targetLatLng = getNodeLatLng(targetNode);
  const points = Array.isArray(edge?.data?.waypoints)
    ? edge.data.waypoints.map(sanitizeWaypoint).filter(Boolean)
    : [];

  if (!points.length) {
    const fallback = [];
    if (sourceLatLng) fallback.push([toFixed6(sourceLatLng.lat), toFixed6(sourceLatLng.lng)]);
    if (targetLatLng && !isSamePoint(fallback[fallback.length - 1], targetLatLng)) {
      fallback.push([toFixed6(targetLatLng.lat), toFixed6(targetLatLng.lng)]);
    }
    return fallback;
  }

  const out = points.slice();
  if (sourceLatLng && !isSamePoint(out[0], sourceLatLng)) {
    out.unshift([toFixed6(sourceLatLng.lat), toFixed6(sourceLatLng.lng)]);
  }
  if (targetLatLng && !isSamePoint(out[out.length - 1], targetLatLng)) {
    out.push([toFixed6(targetLatLng.lat), toFixed6(targetLatLng.lng)]);
  }
  return out;
}

function orientEdgePoints(edge, fromId, toId, nodeMap) {
  const points = buildEdgePoints(edge, nodeMap);
  if (!points.length) return [];
  if (edge.source === fromId && edge.target === toId) return points;
  if (edge.source === toId && edge.target === fromId) return points.slice().reverse();
  return points;
}

function edgeWeight(edge, nodeMap) {
  const declared = Number(edge?.data?.distance);
  if (Number.isFinite(declared) && declared > 0) return declared;
  const points = buildEdgePoints(edge, nodeMap);
  if (points.length < 2) return 1;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    total += Math.sqrt(((curr[0] - prev[0]) ** 2) + ((curr[1] - prev[1]) ** 2));
  }
  return total || 1;
}

function dijkstraToNearestOdp(startNodeId, adjacency, nodeMap) {
  const distances = new Map([[startNodeId, 0]]);
  const previous = new Map();
  const visited = new Set();
  const frontier = [{ nodeId: startNodeId, distance: 0 }];

  while (frontier.length) {
    frontier.sort((a, b) => a.distance - b.distance);
    const current = frontier.shift();
    if (!current || visited.has(current.nodeId)) continue;
    visited.add(current.nodeId);
    const currentNode = nodeMap.get(current.nodeId);
    if (currentNode?.type === 'odp' && current.nodeId !== startNodeId) {
      return { targetNodeId: current.nodeId, previous, distance: current.distance };
    }

    const neighbors = adjacency.get(current.nodeId) || [];
    for (const neighbor of neighbors) {
      if (visited.has(neighbor.nodeId)) continue;
      const nextDistance = current.distance + neighbor.weight;
      if (nextDistance >= (distances.get(neighbor.nodeId) ?? Number.POSITIVE_INFINITY)) continue;
      distances.set(neighbor.nodeId, nextDistance);
      previous.set(neighbor.nodeId, {
        nodeId: current.nodeId,
        edge: neighbor.edge
      });
      frontier.push({ nodeId: neighbor.nodeId, distance: nextDistance });
    }
  }

  return null;
}

function reconstructPath(result, startNodeId, nodeMap) {
  if (!result?.targetNodeId) return null;
  const segments = [];
  let cursor = result.targetNodeId;
  while (cursor !== startNodeId) {
    const prev = result.previous.get(cursor);
    if (!prev) return null;
    segments.push({
      fromId: prev.nodeId,
      toId: cursor,
      edge: prev.edge
    });
    cursor = prev.nodeId;
  }
  segments.reverse();

  const fullPoints = [];
  for (const segment of segments) {
    const edgePoints = orientEdgePoints(segment.edge, segment.fromId, segment.toId, nodeMap);
    if (!edgePoints.length) continue;
    if (!fullPoints.length) {
      fullPoints.push(...edgePoints);
      continue;
    }
    const appendPoints = isSamePoint(fullPoints[fullPoints.length - 1], edgePoints[0])
      ? edgePoints.slice(1)
      : edgePoints;
    fullPoints.push(...appendPoints);
  }
  return {
    odpNodeId: result.targetNodeId,
    points: fullPoints
  };
}

function parseMapFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const payload = JSON.parse(raw);
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const edges = Array.isArray(payload.edges) ? payload.edges : [];
  return { nodes, edges };
}

function buildAdjacency(edges, nodeMap) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue;
    const weight = edgeWeight(edge, nodeMap);
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
    adjacency.get(edge.source).push({ nodeId: edge.target, edge, weight });
    adjacency.get(edge.target).push({ nodeId: edge.source, edge, weight });
  }
  return adjacency;
}

function getExistingOdps() {
  return db.prepare(`
    SELECT id, name, lat, lng, description, port_capacity
    FROM odps
    ORDER BY id ASC
  `).all();
}

function getExistingCustomers() {
  return db.prepare(`
    SELECT id, name, pppoe_username, genieacs_tag, lat, lng, odp_id, cable_path
    FROM customers
    ORDER BY id ASC
  `).all();
}

function buildOdpLookup(rows) {
  const lookup = new Map();
  rows.forEach((row) => {
    const key = `${normalizeKey(row.name)}|${formatCoord(row.lat)}|${formatCoord(row.lng)}`;
    if (!lookup.has(key)) lookup.set(key, row);
  });
  return lookup;
}

function buildCustomerLookup(rows) {
  const byPppoe = new Map();
  rows.forEach((row) => {
    const username = normalizeKey(row.pppoe_username || row.genieacs_tag || '');
    if (!username || byPppoe.has(username)) return;
    byPppoe.set(username, row);
  });
  return byPppoe;
}

function ensureOdp(node, existingLookup, statements, report) {
  const lat = formatCoord(node?.data?.latitude);
  const lng = formatCoord(node?.data?.longitude);
  const name = normalizeText(node?.data?.name || node?.id || 'ODP');
  const description = normalizeText(node?.data?.notes || '');
  const capacity = Math.max(1, Number(node?.data?.capacity || 0) || 16);
  const key = `${normalizeKey(name)}|${lat}|${lng}`;
  const existing = existingLookup.get(key);
  if (existing) {
    const needsUpdate =
      normalizeText(existing.description || '') !== description ||
      Number(existing.port_capacity || 0) !== capacity;
    if (needsUpdate) {
      statements.updateOdp.run(name, capacity, lat, lng, description, existing.id);
      existing.name = name;
      existing.port_capacity = capacity;
      existing.lat = lat;
      existing.lng = lng;
      existing.description = description;
      report.odps.updated.push({ id: existing.id, name, lat, lng });
    } else {
      report.odps.matched.push({ id: existing.id, name, lat, lng });
    }
    return existing.id;
  }

  const info = statements.insertOdp.run(name, null, '', capacity, lat, lng, description);
  const row = {
    id: Number(info.lastInsertRowid),
    name,
    port_capacity: capacity,
    lat,
    lng,
    description
  };
  existingLookup.set(key, row);
  report.odps.created.push({ id: row.id, name, lat, lng });
  return row.id;
}

function importNetworkMap(filePath, options = {}) {
  const apply = Boolean(options.apply);
  const payload = parseMapFile(filePath);
  const nodes = payload.nodes;
  const edges = payload.edges;
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = buildAdjacency(edges, nodeMap);
  const odps = nodes.filter((node) => node.type === 'odp');
  const onts = nodes.filter((node) => node.type === 'ont');
  const existingOdpLookup = buildOdpLookup(getExistingOdps());
  const customerLookup = buildCustomerLookup(getExistingCustomers());
  const importedOdpIds = new Map();

  const report = {
    sourceFile: filePath,
    applied: apply,
    createdAt: new Date().toISOString(),
    summary: {
      nodes: nodes.length,
      edges: edges.length,
      odpsInSource: odps.length,
      ontsInSource: onts.length,
      odpsCreated: 0,
      odpsUpdated: 0,
      odpsMatched: 0,
      customersMatched: 0,
      customersUpdated: 0,
      customersWithPath: 0,
      customersWithoutPath: 0,
      customersUnmatched: 0
    },
    odps: {
      created: [],
      updated: [],
      matched: []
    },
    customers: {
      updated: [],
      unmatched: [],
      unresolvedPath: []
    }
  };

  const statements = {
    insertOdp: db.prepare(`
      INSERT INTO odps (name, olt_id, pon_port, port_capacity, lat, lng, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    updateOdp: db.prepare(`
      UPDATE odps
      SET name = ?, port_capacity = ?, lat = ?, lng = ?, description = ?
      WHERE id = ?
    `),
    updateCustomerMap: db.prepare(`
      UPDATE customers
      SET lat = ?, lng = ?, odp_id = ?, cable_path = ?
      WHERE id = ?
    `)
  };

  const runner = db.transaction(() => {
    odps.forEach((node) => {
      const odpId = ensureOdp(node, existingOdpLookup, statements, report);
      importedOdpIds.set(node.id, odpId);
    });

    onts.forEach((node) => {
      const pppoe = normalizeKey(node?.data?.pppoe || node?.data?.name || '');
      if (!pppoe) {
        report.customers.unmatched.push({
          reason: 'pppoe-empty',
          nodeId: node.id,
          name: node?.data?.name || ''
        });
        return;
      }
      const customer = customerLookup.get(pppoe);
      if (!customer) {
        report.customers.unmatched.push({
          reason: 'customer-not-found',
          nodeId: node.id,
          pppoe: node?.data?.pppoe || '',
          name: node?.data?.name || ''
        });
        return;
      }

      const latLng = getNodeLatLng(node);
      if (!latLng) {
        report.customers.unresolvedPath.push({
          customerId: customer.id,
          pppoe: customer.pppoe_username,
          reason: 'ont-coordinate-missing'
        });
        return;
      }

      const dijkstraResult = dijkstraToNearestOdp(node.id, adjacency, nodeMap);
      const rebuiltPath = reconstructPath(dijkstraResult, node.id, nodeMap);
      const importedOdpId = rebuiltPath?.odpNodeId ? importedOdpIds.get(rebuiltPath.odpNodeId) || null : null;
      const cablePath = rebuiltPath?.points?.length ? JSON.stringify(rebuiltPath.points) : null;

      if (!cablePath) {
        report.customers.unresolvedPath.push({
          customerId: customer.id,
          pppoe: customer.pppoe_username,
          reason: 'odp-path-not-found'
        });
      }

      report.summary.customersMatched += 1;
      if (cablePath) report.summary.customersWithPath += 1;
      else report.summary.customersWithoutPath += 1;

      if (apply) {
        statements.updateCustomerMap.run(
          formatCoord(latLng.lat),
          formatCoord(latLng.lng),
          importedOdpId,
          cablePath,
          customer.id
        );
      }

      report.customers.updated.push({
        customerId: customer.id,
        customerName: customer.name,
        pppoe: customer.pppoe_username,
        ontNodeId: node.id,
        odpId: importedOdpId,
        lat: formatCoord(latLng.lat),
        lng: formatCoord(latLng.lng),
        cablePointCount: rebuiltPath?.points?.length || 0
      });
    });
  });

  if (apply) runner();
  else {
    // simulate ODP mapping and customer path building without writing
    odps.forEach((node) => {
      const lat = formatCoord(node?.data?.latitude);
      const lng = formatCoord(node?.data?.longitude);
      const name = normalizeText(node?.data?.name || node?.id || 'ODP');
      const key = `${normalizeKey(name)}|${lat}|${lng}`;
      const existing = existingOdpLookup.get(key);
      if (existing) {
        importedOdpIds.set(node.id, existing.id);
        report.odps.matched.push({ id: existing.id, name, lat, lng });
      } else {
        importedOdpIds.set(node.id, null);
        report.odps.created.push({ id: null, name, lat, lng });
      }
    });

    onts.forEach((node) => {
      const pppoe = normalizeKey(node?.data?.pppoe || node?.data?.name || '');
      if (!pppoe) {
        report.customers.unmatched.push({
          reason: 'pppoe-empty',
          nodeId: node.id,
          name: node?.data?.name || ''
        });
        return;
      }
      const customer = customerLookup.get(pppoe);
      if (!customer) {
        report.customers.unmatched.push({
          reason: 'customer-not-found',
          nodeId: node.id,
          pppoe: node?.data?.pppoe || '',
          name: node?.data?.name || ''
        });
        return;
      }
      const latLng = getNodeLatLng(node);
      const dijkstraResult = dijkstraToNearestOdp(node.id, adjacency, nodeMap);
      const rebuiltPath = reconstructPath(dijkstraResult, node.id, nodeMap);
      const importedOdpId = rebuiltPath?.odpNodeId ? importedOdpIds.get(rebuiltPath.odpNodeId) || null : null;
      report.summary.customersMatched += 1;
      if (rebuiltPath?.points?.length) report.summary.customersWithPath += 1;
      else report.summary.customersWithoutPath += 1;
      report.customers.updated.push({
        customerId: customer.id,
        customerName: customer.name,
        pppoe: customer.pppoe_username,
        ontNodeId: node.id,
        odpId: importedOdpId,
        lat: latLng ? formatCoord(latLng.lat) : '',
        lng: latLng ? formatCoord(latLng.lng) : '',
        cablePointCount: rebuiltPath?.points?.length || 0
      });
    });
  }

  report.summary.odpsCreated = report.odps.created.filter((item) => item.id == null || item.id > 0).length;
  report.summary.odpsUpdated = report.odps.updated.length;
  report.summary.odpsMatched = report.odps.matched.length;
  report.summary.customersUpdated = report.customers.updated.length;
  report.summary.customersUnmatched = report.customers.unmatched.length;

  return report;
}

function resolveReportPath(inputFile, explicitReportPath, apply) {
  if (explicitReportPath) return path.resolve(explicitReportPath);
  const parsed = path.parse(path.resolve(inputFile));
  const suffix = apply ? 'import-report' : 'dry-run-report';
  return path.join(parsed.dir, `${parsed.name}.${suffix}.json`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(String(args.file || '').trim());
  if (!filePath) {
    console.error('Usage: node scripts/import-network-map.js --file <network-map.json> [--apply] [--report <file>]');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`File tidak ditemukan: ${filePath}`);
    process.exit(1);
  }

  const apply = Boolean(args.apply);
  const report = importNetworkMap(filePath, { apply });
  const reportPath = resolveReportPath(filePath, args.report, apply);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`Source: ${filePath}`);
  console.log(`Mode: ${apply ? 'apply' : 'dry-run'}`);
  console.log(`ODP source: ${report.summary.odpsInSource}`);
  console.log(`ONT source: ${report.summary.ontsInSource}`);
  console.log(`ODP created: ${report.summary.odpsCreated}`);
  console.log(`ODP updated: ${report.summary.odpsUpdated}`);
  console.log(`ODP matched: ${report.summary.odpsMatched}`);
  console.log(`Customers matched: ${report.summary.customersMatched}`);
  console.log(`Customers updated: ${report.summary.customersUpdated}`);
  console.log(`Customers unmatched: ${report.summary.customersUnmatched}`);
  console.log(`Customers with path: ${report.summary.customersWithPath}`);
  console.log(`Customers without path: ${report.summary.customersWithoutPath}`);
  console.log(`Report: ${reportPath}`);
}

main();
