import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const clients = sqliteTable('client', { id: text('id').primaryKey(), orgId: text('org_id').notNull(), name: text('name').notNull(), timezone: text('timezone').notNull(), domain: text('domain') });
export const properties = sqliteTable('property', { id: text('id').primaryKey(), clientId: text('client_id').notNull(), type: text('type').notNull(), externalId: text('external_id').notNull(), connectionId: text('connection_id') });
export const pages = sqliteTable('page', { id: text('id').primaryKey(), clientId: text('client_id').notNull(), url: text('url').notNull(), canonical: text('canonical'), tags: text('tags').notNull() });
