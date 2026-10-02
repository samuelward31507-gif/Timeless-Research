/*
 * Operations console: the audit log. GET only, and the log itself is
 * append-only in the database.
 *
 *   GET ?entity_type=&entity_id=&action=&limit=&cursor=
 *
 * Needs audit.read. Reads admin_audit_log (migration 0004), newest first.
 * See netlify/lib/admin-api.js for the request rules.
 */
'use strict';

const { readEndpoint, ApiError, v, decodeCursor, page } = require('../lib/admin-api.js');

const COLUMNS = ['id', 'occurred_at', 'actor_id', 'actor_email', 'action', 'entity_type', 'entity_id', 'details'];

const ENTITY_TYPE = /^[a-z_]+$/;
// Entity ids are UUIDs, numbers, or "product|pack size" for stock items.
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9 .|_-]*$/;
const ACTION = /^[a-z_]+\.[a-z_]+$/;

exports.handler = readEndpoint('admin-audit', async ({ params, require, select }) => {
  await require('audit.read');
  const p = params(['entity_type', 'entity_id', 'action', 'limit', 'cursor']);
  const entityType = v.pattern(p.entity_type, 'entity_type', ENTITY_TYPE, 40);
  const entityId = v.pattern(p.entity_id, 'entity_id', ENTITY_ID, 120);
  if (entityId && !entityType) throw new ApiError(400, 'invalid_parameter', { parameter: 'entity_type' });
  const action = v.pattern(p.action, 'action', ACTION, 60);
  const limit = v.limit(p.limit);
  const cursor = decodeCursor(p.cursor, ['id']);

  const query = [];
  if (entityType) query.push(['entity_type', `eq.${entityType}`]);
  if (entityId) query.push(['entity_id', `eq.${entityId}`]);
  if (action) query.push(['action', `eq.${action}`]);
  if (cursor) query.push(['id', `lt.${cursor[0]}`]);
  query.push(['order', 'id.desc'], ['limit', String(limit + 1)]);

  const rows = await select('admin_audit_log', COLUMNS, query);
  const result = page(rows, limit, (r) => [r.id]);
  return { entries: result.items, next_cursor: result.next_cursor };
});
