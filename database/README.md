# Database

The actual SQLite schema is created and migrated idempotently by `server.mjs` on startup. The database file is intentionally stored under `data/nunes-crm.sqlite` so source-code updates do not remove business data.

Core normalized entities include users, teams, customers, customer contacts, leads, lead sources, product requirements, products, aliases, specifications, prices, scores, score factors, pipeline history, playbook progress, communications, follow-ups, tasks, notes, attachments, quotations, quotation items, objections, activities, notifications, audit logs, and settings.
