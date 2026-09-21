import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import './services/runtime-env.mjs';
import { DatabaseProductProvider, FileProductProvider, QuotationHistoryProvider, mergeProductResults, normalizeProductText } from './providers/productProviders.mjs';
import { GeminiProductSynthesisProvider, ProductResearchOrchestrator, buildProductIntelligenceInput, schemaForCategory, normalizeProductName as normalizeProductNameV25, compactModel as compactModelV25 } from './services/product-intelligence/index.mjs';
import { parseGoogleSourceUrl, readPriceSourceStatus, readGoogleAuth, writeGoogleAuth, GoogleSheetPriceProvider } from './services/google-price-source.mjs';
import { OnlinePriceResearchProvider } from './services/online-price-research.mjs';

// NUNES operates in India. Force CRM day/week/month boundaries to Asia/Kolkata
// so Today/This Week stay correct even if Windows/server timezone is changed.
process.env.TZ='Asia/Kolkata';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const LOG_DIR = path.join(ROOT, 'logs');
const CONFIG_PATH = path.join(ROOT, 'config', 'crm-config.json');
const DB_PATH = path.join(DATA_DIR, 'nunes-crm.sqlite');
const PORT_FILE = path.join(DATA_DIR, 'active_port.txt');
const PID_FILE = path.join(DATA_DIR, 'crm.pid');
const CRM_CONNECTION_PATH = path.join(DATA_DIR, 'company-crm.json');
const CRM_SECRET_PATH = path.join(DATA_DIR, 'company-crm-key.txt');
const GOOGLE_AUTH_PATH = path.join(DATA_DIR, 'google-drive-auth.json');
const GMAIL_CLIENT_PATH = path.join(DATA_DIR, 'gmail-oauth-client.json');
const GMAIL_AUTH_PATH = path.join(DATA_DIR, 'gmail-oauth-token.json');
const WHATSAPP_CLOUD_PATH = path.join(DATA_DIR, 'whatsapp-cloud.json');
const APP_ID = 'NUNES_AI_CRM_V1';


const SCORE_FACTORS_V2 = [
  ['exact_product','Exact product identified',6],['exact_model','Exact model identified',8],['brand','Brand identified',4],['quantity','Quantity provided',4],
  ['application','Application provided',4],['technical_requirement','Technical requirement provided',5],['quotation_request','Quotation requested',10],['best_price','Best price requested',7],
  ['catalogue','Catalogue requested',3],['delivery_date','Delivery date specified',7],['urgent','Urgent / immediate',10],['budget_confirmed','Budget confirmed',10],
  ['company','Business / company identified',4],['phone','Phone available',2],['email','Email available',2],['repeat_customer','Repeat customer',7],
  ['previous_order','Previous order',8],['previous_quote','Previous quotation',5],['decision_maker','Decision maker confirmed',5],['internal_product_match','Internal product match',6],
  ['price_fit','Verified price available',5],['sales_verification','Salesperson verification',6],['engagement','Customer engagement',5],['ready_to_buy','Ready to buy',15]
];
const SCORE_CONFIG_VERSION = '2';
const ANALYSIS_VERSION = 8;
const PRODUCT_INTELLIGENCE_VERSION = 'V3_REQUEST_AWARE';
const DEPLOYMENT_VERSION = 'V2_11_17_LEADSPHERE_LIVE_AUTO_RECOVERY';
const APP_VERSION = '2.11.17';
const CLIENT_LAUNCHER_VERSION = '2.11.17';
const GITHUB_UPDATE_REPO = String(process.env.CRM_UPDATE_REPO||'Nunes-instruments/Nunes_AI_Crm').trim();
const GITHUB_UPDATE_BRANCH = String(process.env.CRM_UPDATE_BRANCH||'main').trim()||'main';
const GITHUB_AUTO_UPDATE_ENABLED = String(process.env.CRM_GITHUB_AUTO_UPDATE||'true').toLowerCase()!=='false';
const GITHUB_UPDATE_CHECK_MINUTES = Math.max(1, Number(process.env.CRM_GITHUB_UPDATE_CHECK_MINUTES||5)||5);
let githubUpdateState={enabled:GITHUB_AUTO_UPDATE_ENABLED,repo:GITHUB_UPDATE_REPO,branch:GITHUB_UPDATE_BRANCH,current_version:APP_VERSION,latest_version:APP_VERSION,status:'STARTING',last_checked_at:null,last_error:null,update_started_at:null};
// 0 = keep generated product information permanently. This is the default so
// the next staff member asking for the same product reuses the saved record
// instead of calling Gemini again.
const PRODUCT_INTELLIGENCE_CACHE_DAYS = Math.max(0, Number(process.env.PRODUCT_INTELLIGENCE_CACHE_DAYS??0));
const DEFAULT_BUDGET_REQUEST_MESSAGE = 'Dear {customer_name},\n\nThank you for your enquiry for {product_name}{model_line}. Could you please share your expected budget / target price for this product? This will help us offer the most suitable option and our best price.\n\nRegards,\nNunes Instrumentation';
const DEFAULT_BUDGET_REQUEST_SUBJECT = 'Budget / Target Price Required - {product_name}';
const ONLINE_PRICE_CACHE_HOURS = Math.max(1, Number(process.env.ONLINE_PRICE_CACHE_HOURS||72));
const INDIA_MARGIN_MIN=30, INDIA_MARGIN_MAX=40, EXPORT_MARGIN_MIN=30, EXPORT_MARGIN_MAX=60, DEFAULT_MARGIN_PERCENT=30;

// V2.7.5: staff portraits supplied by Nunes are bundled with the CRM and
// matched by the existing CRM staff name. This avoids relying on a remote
// protected image URL and makes the Dashboard race photos load instantly.
const BUNDLED_STAFF_PHOTOS = new Map();

function staffPhotoNameKey(value=''){ return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,''); }
function bundledStaffPhotoRef(name=''){ const rel=BUNDLED_STAFF_PHOTOS.get(staffPhotoNameKey(name));return rel?`local:${rel}`:''; }
function imageMimeForFile(file=''){ const ext=path.extname(String(file||'')).toLowerCase();return ext==='.png'?'image/png':ext==='.webp'?'image/webp':ext==='.gif'?'image/gif':ext==='.bmp'?'image/bmp':'image/jpeg'; }
function applyBundledStaffPhotos(){
  let updated=0;
  const rows=db.prepare("SELECT id,name,photo_data FROM users WHERE active=1 AND role='SALESPERSON'").all();
  for(const u of rows){
    const bundled=bundledStaffPhotoRef(u.name);if(!bundled)continue;
    if(String(u.photo_data||'')!==bundled){db.prepare('UPDATE users SET photo_data=? WHERE id=?').run(bundled,u.id);updated++;}
  }
  return updated;
}

const PLAYBOOK_STAGES = [
  {no:1,name:'Qualify Leads',short:'Qualify',description:'Assess customer need, budget, urgency, authority and genuine purchase interest.'},
  {no:2,name:'Follow Up Promptly',short:'Prompt Follow-Up',description:'Contact the customer quickly after the enquiry and record the outcome.'},
  {no:3,name:'Understand Customer Needs',short:'Understand Needs',description:'Clarify application, specification, quantity, brand, budget, delivery and decision criteria.'},
  {no:4,name:'Present Clear Value',short:'Present Value',description:'Explain the benefits and business value of the recommended product or service.'},
  {no:5,name:'Offer Solutions',short:'Offer Solutions',description:'Position the recommended solution and useful alternatives around the customer problem.'},
  {no:6,name:'Provide Detailed Information',short:'Detailed Info',description:'Share specifications, pricing status, GST, terms, catalogue, certificates and relevant details.'},
  {no:7,name:'Create Urgency',short:'Create Urgency',description:'Use genuine stock, delivery or quotation-validity reasons to encourage timely decisions.'},
  {no:8,name:'Address Objections',short:'Objections',description:'Capture customer concerns and record the salesperson response and resolution.'},
  {no:9,name:'Use Professional Proposals',short:'Proposal',description:'Prepare a clear structured proposal or quotation with offer, terms and next steps.'},
  {no:10,name:'Ask for the Order',short:'Ask Order',description:'Clearly ask the customer to proceed when the opportunity is ready.'},
  {no:11,name:'Follow Up',short:'Follow Up',description:'Schedule the next follow-up and keep the opportunity moving until a decision is made.'},
  {no:12,name:'Nurture Relationships',short:'Nurture',description:'Maintain the relationship for repeat orders and future opportunities even if the current lead does not convert.'}
];

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const DEFAULT_PRICE_SHEET_URL=String(process.env.DEFAULT_PRICE_SHEET_URL||config.default_price_sheet_url||'').trim();
const PRICE_SHEET_REFRESH_MINUTES=Math.max(30,Number(process.env.PRICE_SHEET_REFRESH_MINUTES||config.price_sheet_auto_refresh_minutes||60));
const db = new DatabaseSync(DB_PATH);

// V2.9.0: keep the live SQLite database on the main CRM computer only.
// WAL is ideal on a local Windows disk, but SMB/NAS shares can reject the
// shared-memory files used by WAL and raise SQLITE_IOERR (disk I/O error).
// The Windows launcher now installs the server locally before it starts.
// This fallback also prevents a hard crash if the folder is started manually.
function configureSqlite(){
  try{ db.exec('PRAGMA foreign_keys = ON;'); }catch{}
  try{ db.exec('PRAGMA busy_timeout = 5000;'); }catch{}
  let journal='WAL';
  try{ db.exec('PRAGMA journal_mode = WAL;'); }
  catch(e){
    journal='DELETE';
    console.warn('[DATABASE] WAL mode is unavailable at this location. Falling back to DELETE journal mode:',e.message);
    try{ db.exec('PRAGMA journal_mode = DELETE;'); }catch{}
  }
  for(const pragma of [
    'PRAGMA synchronous = NORMAL;',
    'PRAGMA temp_store = MEMORY;',
    'PRAGMA cache_size = -20000;',
    'PRAGMA mmap_size = 268435456;'
  ]){try{db.exec(pragma);}catch(e){console.warn('[DATABASE] Optional SQLite tuning skipped:',pragma,e.message);}}
  console.log(`[DATABASE] ${DB_PATH} (${journal})`);
}
configureSqlite();

function nowIso() { return new Date().toISOString(); }
function minAgo(n) { return new Date(Date.now() - n * 60000).toISOString(); }
function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }
function safeJson(v, fallback = null) { try { return JSON.parse(v); } catch { return fallback; } }
function json(v) { return JSON.stringify(v ?? null); }
function inr(v) { return v == null ? null : Number(v); }
function temperatureFor(score) {
  if (score >= 90) return 'VERY HOT';
  if (score >= 75) return 'HOT';
  if (score >= 55) return 'WARM';
  if (score >= 35) return 'DEVELOPING';
  if (score >= 15) return 'LOW';
  return 'COLD';
}
function priorityFor(score, urgency) {
  if (score >= 75 || ['IMMEDIATE','THIS WEEK'].includes(urgency)) return 'HIGH';
  if (score >= 50) return 'MEDIUM';
  return 'NORMAL';
}
function normalizeText(s='') { return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function extractBudgetAmount(text='') {
  const raw=String(text||'').replace(/,/g,'');
  const patterns=[
    /(?:budget|target\s*price|expected\s*price|price\s*expectation)\s*(?:is|of|around|approx(?:imately)?|:|-)?\s*(?:inr|rs\.?|₹)?\s*([0-9]+(?:\.[0-9]+)?)\s*(k|thousand|lakh|lac|crore|cr)?/i,
    /(?:can\s*spend|up\s*to|within)\s*(?:inr|rs\.?|₹)?\s*([0-9]+(?:\.[0-9]+)?)\s*(k|thousand|lakh|lac|crore|cr)?/i
  ];
  for(const re of patterns){const m=raw.match(re);if(!m)continue;let n=Number(m[1]);if(!Number.isFinite(n)||n<=0)continue;const u=String(m[2]||'').toLowerCase();if(u==='k'||u==='thousand')n*=1000;else if(u==='lakh'||u==='lac')n*=100000;else if(u==='crore'||u==='cr')n*=10000000;return Math.round(n*100)/100;}
  return null;
}

function tableColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x=>String(x.name)));
}
function ensureColumn(table,column,ddl) {
  const cols=tableColumns(table);
  if(!cols.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
function stableHash(text='') { return createHash('sha256').update(String(text)).digest('hex'); }
function normalizeCountryBucket(value='') {
  const raw=String(value||'').trim().toLowerCase();
  const compact=raw.replace(/[^a-z0-9]/g,'');
  if(['in','ind','india','bharat'].includes(compact)||raw.startsWith('india')) return 'INDIA';
  return raw ? 'EXPORT' : 'INDIA';
}

function initSchema() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, branch TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, role TEXT NOT NULL, team_id INTEGER, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(team_id) REFERENCES teams(id)
  );
  CREATE TABLE IF NOT EXISTS device_sessions (
    id INTEGER PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL, device_type TEXT NOT NULL, device_name TEXT,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_seen_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, company TEXT, phone TEXT, email TEXT, address TEXT, city TEXT, state TEXT, country TEXT,
    pincode TEXT, customer_since TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS customer_contacts (
    id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, name TEXT, designation TEXT, phone TEXT, email TEXT, is_primary INTEGER DEFAULT 0,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS lead_sources (
    id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, enabled INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY, lead_code TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL, source_type TEXT NOT NULL, source_reference TEXT,
    external_lead_id TEXT, raw_message TEXT, source_metadata TEXT, received_at TEXT NOT NULL, assigned_to INTEGER,
    temperature TEXT NOT NULL, purchase_probability INTEGER NOT NULL DEFAULT 0, ai_score INTEGER NOT NULL DEFAULT 0, priority TEXT NOT NULL DEFAULT 'NORMAL',
    pipeline_stage TEXT NOT NULL DEFAULT 'NEW', requirement_status TEXT NOT NULL DEFAULT 'NEEDS CLARIFICATION', budget_status TEXT NOT NULL DEFAULT 'UNKNOWN',
    urgency TEXT NOT NULL DEFAULT 'UNKNOWN', decision_maker TEXT NOT NULL DEFAULT 'UNKNOWN', purchase_intent TEXT NOT NULL DEFAULT 'JUST ENQUIRY',
    timeline TEXT NOT NULL DEFAULT 'UNKNOWN', expected_value REAL, last_contact_at TEXT, next_followup_at TEXT, followup_count INTEGER DEFAULT 0,
    response_status TEXT NOT NULL DEFAULT 'NOT CONTACTED', status TEXT NOT NULL DEFAULT 'OPEN', manual_override TEXT, manual_override_reason TEXT,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id), FOREIGN KEY(assigned_to) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, brand TEXT, series TEXT, model TEXT, category TEXT, description TEXT,
    key_features_json TEXT, applications_json TEXT, image_path TEXT, internal_code TEXT, demo INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS product_aliases (
    id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, alias TEXT NOT NULL, FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS product_specifications (
    id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, spec_key TEXT NOT NULL, spec_value TEXT, source TEXT, confidence INTEGER,
    verification_status TEXT NOT NULL DEFAULT 'NEEDS VERIFICATION', is_manual INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS product_prices (
    id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, purchase_price REAL, selling_price REAL, previous_quoted_price REAL,
    suggested_selling_price REAL, gst_percent REAL, margin_percent REAL, price_date TEXT, supplier TEXT, stock_status TEXT,
    lead_time TEXT, source TEXT, reliability TEXT, verified INTEGER DEFAULT 0, FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS product_requirements (
    id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL, product_name TEXT NOT NULL, requested_brand TEXT, requested_model TEXT,
    customer_reference TEXT, quantity REAL, unit TEXT, application TEXT, required_specification TEXT, required_accuracy TEXT, required_range TEXT,
    requested_features TEXT, requested_certification TEXT, requested_accessories TEXT, delivery_location TEXT, required_delivery_date TEXT,
    budget REAL, price_expectation REAL, preferred_brand TEXT, alternative_brand_accepted TEXT, catalogue_required INTEGER DEFAULT 0,
    quotation_required INTEGER DEFAULT 0, technical_datasheet_required INTEGER DEFAULT 0, installation_required INTEGER DEFAULT 0,
    calibration_required INTEGER DEFAULT 0, other_notes TEXT, status_json TEXT,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS lead_products (
    id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL, requirement_id INTEGER, product_id INTEGER, match_confidence INTEGER DEFAULT 0,
    match_reason TEXT, selected INTEGER DEFAULT 1, FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY(requirement_id) REFERENCES product_requirements(id) ON DELETE CASCADE, FOREIGN KEY(product_id) REFERENCES products(id)
  );
  CREATE TABLE IF NOT EXISTS lead_scores (
    id INTEGER PRIMARY KEY, lead_id INTEGER UNIQUE NOT NULL, score INTEGER NOT NULL, factor_json TEXT, calculated_at TEXT NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS score_factors (
    id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, label TEXT NOT NULL, weight INTEGER NOT NULL, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS pipeline_history (
    id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL, from_stage TEXT, to_stage TEXT NOT NULL, changed_by INTEGER, changed_at TEXT NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS sales_playbook_progress (
    id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL, stage_no INTEGER NOT NULL, stage_name TEXT NOT NULL, status TEXT NOT NULL,
    notes TEXT, updated_at TEXT NOT NULL, UNIQUE(lead_id, stage_no), FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS communications (
    id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL, method TEXT NOT NULL, direction TEXT, subject TEXT, body TEXT, outcome TEXT,
    communicated_at TEXT NOT NULL, user_id INTEGER, FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS followups (
    id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL, due_at TEXT NOT NULL, method TEXT, status TEXT NOT NULL DEFAULT 'PENDING',
    outcome TEXT, notes TEXT, created_by INTEGER, created_at TEXT NOT NULL, completed_at TEXT,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY, lead_id INTEGER, title TEXT NOT NULL, due_at TEXT, status TEXT DEFAULT 'OPEN', assigned_to INTEGER, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY, lead_id INTEGER, customer_id INTEGER, note TEXT NOT NULL, user_id INTEGER, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY, lead_id INTEGER, file_name TEXT, file_path TEXT, mime_type TEXT, size_bytes INTEGER, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS quotations (
    id INTEGER PRIMARY KEY, quotation_no TEXT UNIQUE NOT NULL, lead_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, status TEXT NOT NULL,
    subtotal REAL, gst REAL, total REAL, validity TEXT, payment_terms TEXT, delivery_terms TEXT, warranty TEXT, created_at TEXT NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id), FOREIGN KEY(customer_id) REFERENCES customers(id)
  );
  CREATE TABLE IF NOT EXISTS quotation_uploads (
    id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL, file_name TEXT NOT NULL, file_path TEXT NOT NULL, mime_type TEXT, size_bytes INTEGER,
    quotation_no TEXT, status TEXT NOT NULL DEFAULT 'UPLOADED', total REAL, notes TEXT, uploaded_by INTEGER, created_at TEXT NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS quotation_items (
    id INTEGER PRIMARY KEY, quotation_id INTEGER NOT NULL, product_name TEXT NOT NULL, model TEXT, specification TEXT, quantity REAL, unit TEXT,
    unit_price REAL, gst_percent REAL, line_total REAL, FOREIGN KEY(quotation_id) REFERENCES quotations(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS objections (
    id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL, objection TEXT NOT NULL, customer_comment TEXT, salesperson_response TEXT,
    resolution_status TEXT NOT NULL DEFAULT 'OPEN', created_at TEXT NOT NULL, FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY, lead_id INTEGER, customer_id INTEGER, activity_type TEXT NOT NULL, title TEXT NOT NULL, detail TEXT,
    created_at TEXT NOT NULL, user_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY, user_id INTEGER, lead_id INTEGER, type TEXT, message TEXT NOT NULL, is_read INTEGER DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY, user_id INTEGER, entity_type TEXT, entity_id INTEGER, action TEXT NOT NULL, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS external_owner_mappings (
    id INTEGER PRIMARY KEY, external_system TEXT NOT NULL DEFAULT 'LeadSphere', external_user_id TEXT, external_user_name TEXT, local_user_id INTEGER,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(external_system, external_user_id, external_user_name),
    FOREIGN KEY(local_user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS company_crm_sync_runs (
    id INTEGER PRIMARY KEY, sync_type TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, success INTEGER DEFAULT 0,
    received INTEGER DEFAULT 0, inserted INTEGER DEFAULT 0, updated INTEGER DEFAULT 0, duplicates INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
    pages INTEGER DEFAULT 0, response_ms INTEGER DEFAULT 0, last_error TEXT, cursor_before TEXT, cursor_after TEXT
  );
  CREATE TABLE IF NOT EXISTS lead_verifications (
    id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL, user_id INTEGER, field_name TEXT NOT NULL, previous_value TEXT, new_value TEXT,
    reason TEXT, verified_at TEXT NOT NULL, FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS customer_nurture (
    id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL UNIQUE, future_requirement TEXT, expected_purchase_month TEXT, preferred_brands TEXT,
    products_of_interest TEXT, next_relationship_followup_at TEXT, notes TEXT, updated_at TEXT NOT NULL,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS lead_specification_overrides (
    id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL, spec_key TEXT NOT NULL, spec_value TEXT, source TEXT NOT NULL DEFAULT 'Salesperson Verification',
    verification_status TEXT NOT NULL DEFAULT 'CONFIRMED', updated_at TEXT NOT NULL, UNIQUE(lead_id, spec_key),
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS lead_product_content (
    lead_id INTEGER PRIMARY KEY, description TEXT, features_json TEXT, applications_json TEXT, updated_at TEXT NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS product_sources (
    id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, source_type TEXT, source_name TEXT, source_url TEXT,
    confidence INTEGER DEFAULT 0, verification_status TEXT NOT NULL DEFAULT 'NEEDS VERIFICATION', retrieved_at TEXT NOT NULL,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS product_intelligence_cache (
    id INTEGER PRIMARY KEY, cache_key TEXT UNIQUE NOT NULL, product_id INTEGER, original_product_name TEXT, normalized_product_name TEXT,
    brand TEXT, model TEXT, category TEXT, identity_confidence INTEGER DEFAULT 0, provider TEXT, status TEXT NOT NULL DEFAULT 'COMPLETE',
    raw_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS product_research_runs (
    id INTEGER PRIMARY KEY, lead_id INTEGER, requirement_id INTEGER, cache_key TEXT, requested_product TEXT, status TEXT NOT NULL,
    provider_trace_json TEXT, last_error TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY(requirement_id) REFERENCES product_requirements(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS online_price_research (
    id INTEGER PRIMARY KEY, lead_id INTEGER, requirement_id INTEGER, cache_key TEXT, requested_product TEXT, requested_model TEXT,
    matched_product TEXT, matched_model TEXT, original_price REAL, currency TEXT DEFAULT 'INR', gst_percent REAL, supplier TEXT,
    stock_status TEXT, source_name TEXT, source_url TEXT, confidence INTEGER DEFAULT 0, status TEXT NOT NULL, skip_reason TEXT,
    market_type TEXT, margin_percent REAL, suggested_selling_price REAL, raw_json TEXT, searched_at TEXT NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY(requirement_id) REFERENCES product_requirements(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS limited_time_offers (
    id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL, requirement_id INTEGER, product_name TEXT, channel TEXT,
    base_price REAL NOT NULL, regular_selling_price REAL NOT NULL, regular_margin_percent REAL NOT NULL, minimum_margin_percent REAL NOT NULL,
    discount_percent REAL NOT NULL DEFAULT 0, offer_price REAL NOT NULL, validity_minutes INTEGER NOT NULL DEFAULT 10,
    status TEXT NOT NULL DEFAULT 'DRAFT', message TEXT, prepared_at TEXT NOT NULL, sent_at TEXT, expires_at TEXT,
    accepted_at TEXT, declined_at TEXT, updated_at TEXT NOT NULL, created_by TEXT DEFAULT 'Sebastian Nunes',
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY(requirement_id) REFERENCES product_requirements(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS limited_offer_status_history (
    id INTEGER PRIMARY KEY, offer_id INTEGER NOT NULL, lead_id INTEGER NOT NULL, status TEXT NOT NULL, changed_at TEXT NOT NULL, note TEXT,
    FOREIGN KEY(offer_id) REFERENCES limited_time_offers(id) ON DELETE CASCADE,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_offer_status_history_offer ON limited_offer_status_history(offer_id, id);
  CREATE INDEX IF NOT EXISTS idx_offer_status_history_lead ON limited_offer_status_history(lead_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_leads_received ON leads(received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_leads_temperature ON leads(temperature);
  CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(pipeline_stage);
  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
  CREATE INDEX IF NOT EXISTS idx_leads_status_temperature ON leads(status, temperature);
  CREATE INDEX IF NOT EXISTS idx_leads_status_stage ON leads(status, pipeline_stage);
  CREATE INDEX IF NOT EXISTS idx_leads_probability_received ON leads(purchase_probability DESC, received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_leads_customer_received ON leads(customer_id, received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON leads(assigned_to);
  CREATE INDEX IF NOT EXISTS idx_leads_demo ON leads(demo);
  CREATE INDEX IF NOT EXISTS idx_product_requirements_lead_first ON product_requirements(lead_id, id);
  CREATE INDEX IF NOT EXISTS idx_lead_products_lead_id ON lead_products(lead_id, id);
  CREATE INDEX IF NOT EXISTS idx_product_specs_product_id ON product_specifications(product_id, id);
  CREATE INDEX IF NOT EXISTS idx_product_research_lead_req ON product_research_runs(lead_id, requirement_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_online_price_lead_req ON online_price_research(lead_id, requirement_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_online_price_cache ON online_price_research(cache_key, searched_at DESC);
  CREATE INDEX IF NOT EXISTS idx_limited_offers_lead ON limited_time_offers(lead_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_limited_offers_status_expiry ON limited_time_offers(status, expires_at);
  CREATE INDEX IF NOT EXISTS idx_product_prices_product_id ON product_prices(product_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_followups_due ON followups(due_at, status);
  CREATE INDEX IF NOT EXISTS idx_followups_lead_due ON followups(lead_id, due_at DESC);
  CREATE INDEX IF NOT EXISTS idx_quotation_uploads_lead ON quotation_uploads(lead_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_activities_lead_created ON activities(lead_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_activities_customer_created ON activities(customer_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_objections_lead_created ON objections(lead_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_quotations_lead_created ON quotations(lead_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_quotations_customer_created ON quotations(customer_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_playbook_lead_stage ON sales_playbook_progress(lead_id, stage_no);
  CREATE INDEX IF NOT EXISTS idx_products_demo ON products(demo);
  CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
  CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
  CREATE INDEX IF NOT EXISTS idx_products_model ON products(model);
  CREATE INDEX IF NOT EXISTS idx_leads_external_lead_id ON leads(external_lead_id);
  CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_leads_source_type ON leads(source_type);
  CREATE INDEX IF NOT EXISTS idx_product_requirements_name ON product_requirements(product_name);
  CREATE INDEX IF NOT EXISTS idx_customers_city ON customers(city);
  CREATE INDEX IF NOT EXISTS idx_customers_state ON customers(state);
  CREATE INDEX IF NOT EXISTS idx_notifications_read_created ON notifications(is_read,created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_verifications_lead_time ON lead_verifications(lead_id,verified_at DESC);
  CREATE INDEX IF NOT EXISTS idx_lead_spec_overrides_lead ON lead_specification_overrides(lead_id, id);
  CREATE INDEX IF NOT EXISTS idx_product_sources_product ON product_sources(product_id, id);
  CREATE INDEX IF NOT EXISTS idx_product_sources_url ON product_sources(source_url);
  CREATE INDEX IF NOT EXISTS idx_product_intel_cache_product ON product_intelligence_cache(product_id);
  CREATE INDEX IF NOT EXISTS idx_product_intel_cache_expiry ON product_intelligence_cache(expires_at);

  `);
  ensureColumn('leads','external_event_id','TEXT');
  ensureColumn('leads','external_updated_at','TEXT');
  ensureColumn('leads','external_owner_id','TEXT');
  ensureColumn('leads','external_owner_name','TEXT');
  ensureColumn('leads','external_status','TEXT');
  ensureColumn('leads','external_source','TEXT');
  ensureColumn('leads','external_source_account_id','TEXT');
  ensureColumn('leads','external_source_account_name','TEXT');
  ensureColumn('leads','external_lead_group','TEXT');
  ensureColumn('leads','external_country_bucket','TEXT');
  ensureColumn('leads','quotation_sent','INTEGER DEFAULT 0');
  ensureColumn('leads','quotation_no','TEXT');
  ensureColumn('leads','quotation_sent_by','TEXT');
  ensureColumn('leads','quotation_sent_at','TEXT');
  ensureColumn('leads','sync_signature','TEXT');
  ensureColumn('sales_playbook_progress','stage_data_json','TEXT');
  ensureColumn('sales_playbook_progress','completed_at','TEXT');
  ensureColumn('leads','verified_score','INTEGER');
  ensureColumn('leads','verified_temperature','TEXT');
  ensureColumn('leads','verified_at','TEXT');
  ensureColumn('leads','verified_by','TEXT');
  ensureColumn('leads','first_response_at','TEXT');
  ensureColumn('leads','contact_attempts','INTEGER DEFAULT 0');
  ensureColumn('leads','live_classification',"TEXT DEFAULT 'LIVE'");
  ensureColumn('leads','next_action','TEXT');
  ensureColumn('leads','product_analysis_status',"TEXT DEFAULT 'PENDING'");
  ensureColumn('leads','price_analysis_status',"TEXT DEFAULT 'PENDING'");
  ensureColumn('leads','qualification_status',"TEXT DEFAULT 'PENDING'");
  ensureColumn('leads','analysis_version','INTEGER DEFAULT 0');
  ensureColumn('leads','lost_reason','TEXT');
  ensureColumn('leads','order_value','REAL');
  ensureColumn('leads','order_date','TEXT');
  ensureColumn('leads','po_number','TEXT');
  ensureColumn('leads','possible_duplicate','INTEGER DEFAULT 0');
  ensureColumn('leads','duplicate_reason','TEXT');
  ensureColumn('leads','repeat_opportunity','INTEGER DEFAULT 0');
  ensureColumn('customers','external_contact_id','TEXT');
  ensureColumn('customers','normalized_phone','TEXT');
  ensureColumn('quotations','discount_total','REAL');
  ensureColumn('quotations','freight','REAL');
  ensureColumn('quotations','other_charge','REAL');
  ensureColumn('quotations','price_confirmed','INTEGER DEFAULT 0');
  ensureColumn('quotations','sent_at','TEXT');
  ensureColumn('quotations','viewed_at','TEXT');
  ensureColumn('quotations','replied_at','TEXT');
  ensureColumn('quotation_items','discount_percent','REAL DEFAULT 0');
  ensureColumn('followups','priority',"TEXT DEFAULT 'NORMAL'");
  ensureColumn('followups','reason','TEXT');
  ensureColumn('followups','assigned_to','INTEGER');
  ensureColumn('objections','category','TEXT');
  ensureColumn('objections','salesperson_notes','TEXT');
  ensureColumn('objections','ai_suggested_response','TEXT');
  ensureColumn('leads','market_type_override','TEXT');
  ensureColumn('leads','budget_band','TEXT');
  ensureColumn('leads','decision_role','TEXT');
  ensureColumn('leads','decision_influence','TEXT');
  ensureColumn('leads','commercial_potential','TEXT');
  ensureColumn('leads','buying_signals_json','TEXT');
  // V2.11.15: remembers only fields explicitly selected by staff. Existing rows remain untouched.
  ensureColumn('leads','form_choices_json','TEXT');
  ensureColumn('leads','customer_value_message','TEXT');
  ensureColumn('leads','recommended_product','TEXT');
  ensureColumn('leads','alternative_product','TEXT');
  ensureColumn('leads','economy_option','TEXT');
  ensureColumn('leads','premium_option','TEXT');
  ensureColumn('leads','verified_urgency_note','TEXT');
  ensureColumn('leads','order_status',"TEXT DEFAULT 'NOT READY'");
  ensureColumn('leads','contact_notes','TEXT');
  ensureColumn('leads','final_notes','TEXT');
  ensureColumn('product_prices','verified_by','TEXT');
  ensureColumn('product_prices','verified_at','TEXT');
  ensureColumn('sales_playbook_progress','skip_reason','TEXT');
  ensureColumn('product_requirements','original_product_name','TEXT');
  ensureColumn('product_requirements','normalized_product_name','TEXT');
  ensureColumn('product_requirements','detected_brand','TEXT');
  ensureColumn('product_requirements','detected_model','TEXT');
  ensureColumn('product_requirements','detected_category','TEXT');
  ensureColumn('product_requirements','product_identity_confidence','INTEGER');
  ensureColumn('product_requirements','request_analysis_json','TEXT');
  ensureColumn('product_specifications','source_url','TEXT');
  ensureColumn('products','normalized_name','TEXT');
  ensureColumn('products','manual_verified','INTEGER DEFAULT 0');
  ensureColumn('products','updated_at','TEXT');
  ensureColumn('product_intelligence_cache','product_intelligence_version','TEXT');
  ensureColumn('product_intelligence_cache','generation_status',"TEXT DEFAULT 'PENDING'");
  ensureColumn('product_intelligence_cache','last_used_at','TEXT');
  ensureColumn('product_intelligence_cache','use_count','INTEGER DEFAULT 0');
  ensureColumn('users','designation','TEXT');
  ensureColumn('users','photo_data','TEXT');
  ensureColumn('users','display_order','INTEGER DEFAULT 999');
  ensureColumn('users','phone','TEXT');
  ensureColumn('leads','form_status',"TEXT DEFAULT 'WAITING'");
  ensureColumn('leads','form_completion_percent','INTEGER DEFAULT 0');
  ensureColumn('leads','form_started_at','TEXT');
  ensureColumn('leads','form_last_saved_at','TEXT');
  ensureColumn('leads','form_completed_at','TEXT');
  // V2.10.0: explicit staff work state. Additive migration only — existing records are preserved.
  ensureColumn('leads','work_status',"TEXT DEFAULT 'ACTIVE'");
  ensureColumn('leads','hold_reason','TEXT');
  ensureColumn('leads','work_status_changed_at','TEXT');
  ensureColumn('leads','work_status_changed_by','INTEGER');
  ensureColumn('leads','work_completed_at','TEXT');
  // V2.11.5: fast no-response skip. Additive only; no existing lead data is removed.
  ensureColumn('leads','quick_skip_reason','TEXT');
  ensureColumn('leads','quick_skip_at','TEXT');
  ensureColumn('leads','quick_skip_by','INTEGER');
  ensureColumn('leads','quick_skip_count','INTEGER DEFAULT 0');
  ensureColumn('device_sessions','client_version','TEXT');
  ensureColumn('device_sessions','last_server_version','TEXT');
  ensureColumn('device_sessions','last_update_check_at','TEXT');
  ensureColumn('device_sessions','last_update_applied_at','TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_leads_live_classification ON leads(live_classification, received_at DESC);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_customers_normalized_phone ON customers(normalized_phone);');
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_external_event ON leads(source_type,external_event_id) WHERE external_event_id IS NOT NULL AND external_event_id<>'';");
  db.exec('CREATE INDEX IF NOT EXISTS idx_leads_external_updated ON leads(external_updated_at);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_leads_form_status ON leads(form_status, form_completed_at DESC);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_leads_assigned_form ON leads(assigned_to, form_status, received_at DESC);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_leads_work_status ON leads(work_status, work_status_changed_at DESC);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_leads_quick_skip ON leads(quick_skip_at DESC, quick_skip_by);');
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (1,?)').run(nowIso());
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (2,?)').run(nowIso());
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (3,?)').run(nowIso());
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (4,?)').run(nowIso());
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (5,?)').run(nowIso());
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (6,?)').run(nowIso());
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (7,?)').run(nowIso());
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (8,?)').run(nowIso());
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (9,?)').run(nowIso());
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (10,?)').run(nowIso());
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (11,?)').run(nowIso());
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (12,?)').run(nowIso());
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (13,?)').run(nowIso());
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (14,?)').run(nowIso());

}

function seed() {
  // Production builds start empty. Only structural master data is initialized.
  if (!db.prepare('SELECT id FROM teams LIMIT 1').get()) db.prepare(`INSERT INTO teams(name,branch) VALUES (?,?)`).run('Sales & Marketing', 'Rathinapuri');
  const teamId = db.prepare('SELECT id FROM teams ORDER BY id LIMIT 1').get().id;
  db.prepare(`INSERT OR IGNORE INTO users(name,email,role,team_id,designation,display_order) VALUES (?,?,?,?,?,?)`).run('Sebastian Nunes', 'sales@nunes.local', 'ADMIN', teamId, 'Owner / Administrator', 0);
  // V2.9.7: ADMIN is the business owner profile; the main Windows computer is only the server host.
  db.prepare("UPDATE users SET designation='Owner / Management' WHERE role='ADMIN' AND COALESCE(designation,'') IN ('','Owner / Administrator','Administrator')").run();
  // V2.7.2: use the real staff profiles already stored in CRM.
  // Older builds auto-created Staff 01..10 placeholders; hide/deactivate only unused placeholders.
  // A placeholder that owns any lead is kept active so no historical ownership/data can disappear.
  const defaultStaff=db.prepare("SELECT id,name,email FROM users WHERE role='SALESPERSON' AND active=1 AND name GLOB 'Staff [0-9][0-9]' AND email GLOB 'staff[0-9][0-9]@nunes.local'").all();
  for(const u of defaultStaff){
    const hasLead=Number(db.prepare('SELECT COUNT(*) AS c FROM leads WHERE assigned_to=?').get(u.id)?.c||0)>0;
    if(!hasLead) db.prepare('UPDATE users SET active=0 WHERE id=?').run(u.id);
  }
  for (const code of ['MANUAL','INDIAMART','EMAIL','WHATSAPP','WEBSITE','CRM','IMPORT','OTHER']) db.prepare('INSERT OR IGNORE INTO lead_sources(code,name) VALUES (?,?)').run(code, code[0] + code.slice(1).toLowerCase());
  const currentScoreVersion=db.prepare("SELECT value FROM app_settings WHERE key='score_config_version'").get()?.value||'';
  if(currentScoreVersion!==SCORE_CONFIG_VERSION){
    db.prepare('UPDATE score_factors SET active=0').run();
    for (const f of SCORE_FACTORS_V2) db.prepare(`INSERT INTO score_factors(code,label,weight,active) VALUES (?,?,?,1) ON CONFLICT(code) DO UPDATE SET label=excluded.label,weight=excluded.weight,active=1`).run(...f);
    db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES ('score_config_version',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(SCORE_CONFIG_VERSION,nowIso());
  } else {
    for (const f of SCORE_FACTORS_V2) db.prepare('INSERT OR IGNORE INTO score_factors(code,label,weight,active) VALUES (?,?,?,1)').run(...f);
  }
  for (const [key,value] of [['response_sla_minutes','15'],['company_name','Nunes Instrumentation'],['currency','INR'],['gst_default','18'],['pipeline_page_size','25']]) db.prepare('INSERT OR IGNORE INTO app_settings(key,value,updated_at) VALUES (?,?,?)').run(key,value,nowIso());
  const liveStart=db.prepare("SELECT value FROM app_settings WHERE key='company_crm_live_start_at'").get()?.value;
  if(!liveStart) db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES ('company_crm_live_start_at',?,?)`).run(nowIso(),nowIso());
}

function ensurePlaybookForLead(leadId) {
  const existing=new Map(db.prepare('SELECT stage_no,status,notes,stage_data_json,completed_at FROM sales_playbook_progress WHERE lead_id=?').all(leadId).map(x=>[Number(x.stage_no),x]));
  for(const stage of PLAYBOOK_STAGES){
    const row=existing.get(stage.no);
    if(!row){
      db.prepare('INSERT INTO sales_playbook_progress(lead_id,stage_no,stage_name,status,notes,stage_data_json,completed_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(leadId,stage.no,stage.name,stage.no===1?'ACTIVE':'PENDING',null,null,null,nowIso());
    }else if(String(row.stage_name||'')!==stage.name){
      db.prepare('UPDATE sales_playbook_progress SET stage_name=?,updated_at=? WHERE lead_id=? AND stage_no=?').run(stage.name,nowIso(),leadId,stage.no);
    }
  }
}

function repairPlaybooks() {
  db.exec('BEGIN');
  try{
    for(const stage of PLAYBOOK_STAGES){
      db.prepare(`INSERT INTO sales_playbook_progress(lead_id,stage_no,stage_name,status,notes,stage_data_json,completed_at,updated_at)
        SELECT l.id,?,?,?,NULL,NULL,NULL,? FROM leads l
        WHERE NOT EXISTS (SELECT 1 FROM sales_playbook_progress p WHERE p.lead_id=l.id AND p.stage_no=?)`).run(stage.no,stage.name,stage.no===1?'ACTIVE':'PENDING',nowIso(),stage.no);
      db.prepare('UPDATE sales_playbook_progress SET stage_name=? WHERE stage_no=? AND stage_name<>?').run(stage.name,stage.no,stage.name);
    }
    db.exec('COMMIT');
  }catch(e){try{db.exec('ROLLBACK')}catch{};throw e;}
}

function normalizePlaybookStatuses(leadId){
  const first=db.prepare(`SELECT MIN(stage_no) AS n FROM sales_playbook_progress WHERE lead_id=? AND status NOT IN ('COMPLETED','SKIPPED')`).get(leadId)?.n;
  if(first==null)return;
  db.prepare(`UPDATE sales_playbook_progress SET status=CASE WHEN stage_no=? THEN 'ACTIVE' WHEN status NOT IN ('COMPLETED','SKIPPED') THEN 'PENDING' ELSE status END,updated_at=? WHERE lead_id=?`).run(first,nowIso(),leadId);
}

function playbookRowData(row){return row?{...row,stage_data:safeJson(row.stage_data_json,{})}:null;}
function completePlaybookStage(leadId,stageNo,{notes=null,data=null,status='COMPLETED',activity=true}={}) {
  ensurePlaybookForLead(leadId);
  const stage=PLAYBOOK_STAGES.find(x=>x.no===Number(stageNo));
  if(!stage) throw new Error('Invalid sales playbook stage.');
  const previous=db.prepare('SELECT * FROM sales_playbook_progress WHERE lead_id=? AND stage_no=?').get(leadId,stageNo);
  const merged={...safeJson(previous?.stage_data_json,{}),...(data&&typeof data==='object'?data:{})};
  const completedAt=['COMPLETED','SKIPPED'].includes(status)?(previous?.completed_at||nowIso()):null;
  db.prepare('UPDATE sales_playbook_progress SET stage_name=?,status=?,notes=?,stage_data_json=?,completed_at=?,updated_at=? WHERE lead_id=? AND stage_no=?').run(stage.name,status,notes??previous?.notes??null,json(merged),completedAt,nowIso(),leadId,stageNo);
  if(['COMPLETED','SKIPPED'].includes(status)) normalizePlaybookStatuses(leadId);
  if(activity) addActivity(leadId,'PLAYBOOK',`Step ${stageNo} ${status==='SKIPPED'?'skipped':'completed'} — ${stage.name}`,notes||stage.description);
}

function syncPlaybookEvidence(leadId) {
  ensurePlaybookForLead(leadId);
  const lead=db.prepare('SELECT * FROM leads WHERE id=?').get(leadId); if(!lead)return;
  const contact=db.prepare('SELECT id FROM communications WHERE lead_id=? LIMIT 1').get(leadId);
  const req=db.prepare('SELECT * FROM product_requirements WHERE lead_id=? ORDER BY id LIMIT 1').get(leadId);
  const objection=db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN resolution_status='RESOLVED' THEN 1 ELSE 0 END) AS resolved FROM objections WHERE lead_id=?`).get(leadId);
  const quote=db.prepare('SELECT id,quotation_no FROM quotations WHERE lead_id=? ORDER BY id DESC LIMIT 1').get(leadId);
  const follow=db.prepare('SELECT id,due_at FROM followups WHERE lead_id=? ORDER BY id DESC LIMIT 1').get(leadId);
  const completeIf=(n,ok,data,notes)=>{const r=db.prepare('SELECT status FROM sales_playbook_progress WHERE lead_id=? AND stage_no=?').get(leadId,n);if(ok&&r&&r.status!=='COMPLETED')completePlaybookStage(leadId,n,{data,notes,activity:false});};
  completeIf(2,Boolean(lead.last_contact_at||contact),{last_contact_at:lead.last_contact_at},'Customer contact recorded.');
  const needsKnown=Boolean(req&&(req.application||req.required_range||req.required_accuracy||req.requested_brand||req.requested_model||req.budget||req.required_delivery_date));
  completeIf(3,needsKnown,{requirement_id:req?.id},'Customer need details recorded.');
  completeIf(8,Number(objection?.total||0)>0&&Number(objection?.total||0)===Number(objection?.resolved||0),{objections:Number(objection.total)},'Recorded objections have been resolved.');
  completeIf(9,Boolean(quote),{quotation_id:quote?.id,quotation_no:quote?.quotation_no},`Professional proposal ${quote?.quotation_no||''} created.`);
  completeIf(11,Boolean(follow),{followup_id:follow?.id,due_at:follow?.due_at},'Follow-up has been scheduled.');
}

function playbookSummaryForLead(leadId) {
  ensurePlaybookForLead(leadId);
  const rows=db.prepare('SELECT * FROM sales_playbook_progress WHERE lead_id=? ORDER BY stage_no').all(leadId).map(playbookRowData);
  const completed=rows.filter(x=>x.status==='COMPLETED').length;
  const skipped=rows.filter(x=>x.status==='SKIPPED').length;
  const terminal=completed+skipped;
  const active=rows.find(x=>x.status==='ACTIVE')||rows.find(x=>!['COMPLETED','SKIPPED'].includes(x.status))||rows.at(-1);
  return {completed,skipped,terminal,total:PLAYBOOK_STAGES.length,percent:Math.round((terminal/PLAYBOOK_STAGES.length)*100),current_stage_no:active?.stage_no||12,current_stage_name:active?.stage_name||PLAYBOOK_STAGES.at(-1).name,rows};
}

function applyPlaybookStageData(leadId,stageNo,data={}) {
  const lead=db.prepare('SELECT * FROM leads WHERE id=?').get(leadId); if(!lead) throw new Error('Lead not found');
  const req=db.prepare('SELECT * FROM product_requirements WHERE lead_id=? ORDER BY id LIMIT 1').get(leadId);
  const clean=v=>String(v??'').trim();
  if(stageNo===1){
    const fields=['budget_status','requirement_status','urgency','decision_maker','purchase_intent','timeline'];const sets=[],vals=[];
    for(const f of fields) if(data[f]){sets.push(`${f}=?`);vals.push(data[f]);}
    if(sets.length)db.prepare(`UPDATE leads SET ${sets.join(',')},updated_at=? WHERE id=?`).run(...vals,nowIso(),leadId);
    calculateLeadScore(leadId);
  } else if(stageNo===2){
    const method=clean(data.method)||'CALL',outcome=clean(data.outcome)||'CONTACTED',detail=clean(data.detail)||'Prompt follow-up completed.';
    const stamp=nowIso();
    const successful=['CONNECTED','CONTACTED','WHATSAPP SENT','EMAIL SENT','CALL BACK','CUSTOMER INTERESTED','READY TO BUY'].includes(outcome.toUpperCase());
    db.prepare(`UPDATE leads SET last_contact_at=?,first_response_at=COALESCE(first_response_at,?),response_status=?,contact_attempts=COALESCE(contact_attempts,0)+1,updated_at=? WHERE id=?`).run(stamp,successful?stamp:null,successful?'CONTACTED':outcome.toUpperCase(),stamp,leadId);
    db.prepare('INSERT INTO communications(lead_id,method,direction,subject,body,outcome,communicated_at,user_id) VALUES (?,?,?,?,?,?,?,1)').run(leadId,method,'OUTBOUND','Prompt customer follow-up',detail,outcome,stamp);
    addActivity(leadId,'CONTACT',`${method} customer contact`,detail);
    calculateLeadScore(leadId);
  } else if(stageNo===3 && req){
    const fields=['application','required_specification','required_accuracy','required_range','requested_brand','requested_model','delivery_location','required_delivery_date','budget','price_expectation','other_notes'];const sets=[],vals=[];
    for(const f of fields) if(Object.hasOwn(data,f)&&data[f]!==''&&data[f]!==null){sets.push(`${f}=?`);vals.push(['budget','price_expectation'].includes(f)?Number(data[f])||null:data[f]);}
    if(data.quantity){sets.push('quantity=?');vals.push(Number(data.quantity)||req.quantity);}
    if(sets.length)db.prepare(`UPDATE product_requirements SET ${sets.join(',')} WHERE id=?`).run(...vals,req.id);
    const capturedBudget=data.budget?Number(data.budget):null;
    db.prepare(`UPDATE leads SET requirement_status='CONFIRMED',budget_status=CASE WHEN ? IS NOT NULL THEN 'CONFIRMED' ELSE budget_status END,expected_value=CASE WHEN expected_value IS NULL AND ? IS NOT NULL THEN ? ELSE expected_value END,analysis_version=0,product_analysis_status='ANALYZING',price_analysis_status='SEARCHING',qualification_status='CALCULATING',updated_at=? WHERE id=?`).run(capturedBudget,capturedBudget,capturedBudget,nowIso(),leadId);
    enqueueLeadAnalysis(leadId,lead.live_classification||'LIVE');
  } else if(stageNo===4){
    addActivity(leadId,'VALUE_PRESENTED','Clear value presented',[data.benefits,data.proof,data.customer_value].filter(Boolean).join(' | ')||'Product/service value explained to the customer.');
  } else if(stageNo===5){
    addActivity(leadId,'SOLUTION','Solutions offered',[data.recommended_solution,data.alternative_solution,data.fit_reason].filter(Boolean).join(' | ')||'Recommended solution and alternatives discussed.');
  } else if(stageNo===6){
    addActivity(leadId,'DETAILS_SHARED','Detailed information shared',[data.details_shared,data.pricing_status,data.terms,data.documents].filter(Boolean).join(' | ')||'Product and commercial information shared.');
  } else if(stageNo===7){
    if(data.no_verified_urgency===true||String(data.no_verified_urgency).toLowerCase()==='true'){
      addActivity(leadId,'URGENCY','No verified urgency available','Stage reviewed without fabricating stock, expiry, price revision or delivery claims.');
    }else{
      const evidence=[data.source,data.valid_until,data.stock_note,data.delivery_note].filter(v=>clean(v));
      if(!clean(data.reason)||!evidence.length)throw new Error('Add a genuine urgency reason plus its source/evidence, or choose No Verified Urgency Available.');
      if(data.urgency&&['IMMEDIATE','THIS WEEK','THIS MONTH','LATER','UNKNOWN'].includes(data.urgency))db.prepare('UPDATE leads SET urgency=?,updated_at=? WHERE id=?').run(data.urgency,nowIso(),leadId);
      addActivity(leadId,'URGENCY','Verified urgency communicated',[data.reason,data.source,data.valid_until,data.stock_note,data.delivery_note].filter(Boolean).join(' | '));
      calculateLeadScore(leadId);
    }
  } else if(stageNo===8){
    if(clean(data.objection))db.prepare('INSERT INTO objections(lead_id,objection,customer_comment,salesperson_response,resolution_status,created_at) VALUES (?,?,?,?,?,?)').run(leadId,clean(data.objection),clean(data.customer_comment),clean(data.salesperson_response),clean(data.resolution_status)||'RESOLVED',nowIso());
    addActivity(leadId,'OBJECTION','Objection handling reviewed',clean(data.salesperson_response)||clean(data.objection)||'No unresolved objection remains.');
  } else if(stageNo===9){
    addActivity(leadId,'PROPOSAL','Professional proposal reviewed',[data.proposal_no,data.offer_summary,data.terms,data.next_step].filter(Boolean).join(' | ')||'Proposal/quotation prepared and reviewed.');
  } else if(stageNo===10){
    const response=clean(data.order_response).toUpperCase();
    if(response==='YES'||response==='READY TO BUY'){
      const before=lead.pipeline_stage;
      db.prepare(`UPDATE leads SET purchase_intent='READY TO BUY',pipeline_stage='ORDER EXPECTED',updated_at=? WHERE id=?`).run(nowIso(),leadId);
      if(before!=='ORDER EXPECTED')db.prepare('INSERT INTO pipeline_history(lead_id,from_stage,to_stage,changed_by,changed_at) VALUES (?,?,?,?,?)').run(leadId,before,'ORDER EXPECTED',1,nowIso());
    }
    addActivity(leadId,'ASK_ORDER','Asked customer for the order',[data.order_question,data.order_response,data.customer_reply].filter(Boolean).join(' | ')||'Salesperson clearly asked for the order.');
    calculateLeadScore(leadId);
  } else if(stageNo===11){
    if(data.due_at){
      const due=new Date(data.due_at); if(!Number.isFinite(due.getTime()))throw new Error('Valid follow-up date/time is required.');
      const dueIso=due.toISOString();
      db.prepare('INSERT INTO followups(lead_id,due_at,method,status,notes,created_by,created_at) VALUES (?,?,?,?,?,1,?)').run(leadId,dueIso,clean(data.method)||'CALL','PENDING',clean(data.followup_notes),nowIso());
      db.prepare('UPDATE leads SET next_followup_at=?,followup_count=followup_count+1,updated_at=? WHERE id=?').run(dueIso,nowIso(),leadId);
      addActivity(leadId,'FOLLOWUP','Follow-up scheduled',`${clean(data.method)||'CALL'} — ${dueIso}`);
    }
  } else if(stageNo===12){
    const nextRel=data.future_followup_at?validDateIso(data.future_followup_at):null;
    db.prepare(`INSERT INTO customer_nurture(customer_id,future_requirement,expected_purchase_month,preferred_brands,products_of_interest,next_relationship_followup_at,notes,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET future_requirement=COALESCE(excluded.future_requirement,future_requirement),expected_purchase_month=COALESCE(excluded.expected_purchase_month,expected_purchase_month),preferred_brands=COALESCE(excluded.preferred_brands,preferred_brands),products_of_interest=COALESCE(excluded.products_of_interest,products_of_interest),next_relationship_followup_at=COALESCE(excluded.next_relationship_followup_at,next_relationship_followup_at),notes=COALESCE(excluded.notes,notes),updated_at=excluded.updated_at`).run(lead.customer_id,clean(data.future_requirement)||null,clean(data.expected_purchase_month)||null,clean(data.preferred_brands)||null,clean(data.products_of_interest)||null,nextRel,clean(data.relationship_notes)||null,nowIso());
    if(data.future_followup_at){
      const due=new Date(data.future_followup_at); if(Number.isFinite(due.getTime())){
        db.prepare('INSERT INTO followups(lead_id,due_at,method,status,notes,created_by,created_at) VALUES (?,?,?,?,?,1,?)').run(leadId,due.toISOString(),clean(data.method)||'CALL','PENDING',clean(data.relationship_notes)||'Relationship nurture follow-up',nowIso());
        db.prepare('UPDATE leads SET next_followup_at=?,followup_count=followup_count+1,updated_at=? WHERE id=?').run(due.toISOString(),nowIso(),leadId);
      }
    }
    if(data.move_to_nurture===true||String(data.move_to_nurture).toLowerCase()==='true'){
      const before=lead.pipeline_stage;db.prepare(`UPDATE leads SET pipeline_stage='NURTURE',updated_at=? WHERE id=?`).run(nowIso(),leadId);
      if(before!=='NURTURE')db.prepare('INSERT INTO pipeline_history(lead_id,from_stage,to_stage,changed_by,changed_at) VALUES (?,?,?,?,?)').run(leadId,before,'NURTURE',1,nowIso());
    }
    addActivity(leadId,'NURTURE','Relationship nurture recorded',clean(data.relationship_notes)||'Future relationship and repeat opportunity noted.');
  }
}

function purgeDemoData() {
  const demoLeadIds = db.prepare('SELECT id FROM leads WHERE demo=1').all().map(x=>x.id);
  const demoProductIds = db.prepare('SELECT id FROM products WHERE demo=1').all().map(x=>x.id);
  db.exec('BEGIN');
  try {
    for (const id of demoLeadIds) {
      db.prepare('DELETE FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE lead_id=?)').run(id);
      for (const table of ['quotations','communications','followups','notes','objections','sales_playbook_progress','pipeline_history','lead_scores','lead_products','product_requirements','activities','notifications','attachments','tasks']) db.prepare(`DELETE FROM ${table} WHERE lead_id=?`).run(id);
      db.prepare('DELETE FROM leads WHERE id=?').run(id);
    }
    for (const id of demoProductIds) {
      for (const table of ['product_specifications','product_aliases','product_prices']) db.prepare(`DELETE FROM ${table} WHERE product_id=?`).run(id);
      db.prepare('DELETE FROM products WHERE id=?').run(id);
    }
    db.prepare('DELETE FROM customers WHERE id NOT IN (SELECT DISTINCT customer_id FROM leads)').run();
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

initSchema();
purgeDemoData();
seed();
applyBundledStaffPhotos();
repairPlaybooks();

const PRODUCT_PROVIDERS = [new DatabaseProductProvider(db), new FileProductProvider(DATA_DIR), new QuotationHistoryProvider(db)];
let dataRevision=1;
const responseCache=new Map();
function bumpDataRevision(){ dataRevision++; responseCache.clear(); }
function cached(key,ttlMs,fn){const now=Date.now(),hit=responseCache.get(key);if(hit&&hit.rev===dataRevision&&now-hit.at<ttlMs)return hit.value;const value=fn();responseCache.set(key,{value,at:now,rev:dataRevision});return value;}
function getSetting(key,fallback=''){return db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value??fallback;}
function normalizePhone(value=''){return String(value||'').replace(/\D/g,'').replace(/^91(?=\d{10}$)/,'').slice(-10);}
function validDateIso(value){const t=Date.parse(value||'');return Number.isFinite(t)?new Date(t).toISOString():null;}
function liveClassificationFor(receivedAt,sourceType='CRM'){
  if(String(sourceType).toUpperCase()==='MANUAL')return 'LIVE';
  const liveStart=Date.parse(getSetting('company_crm_live_start_at',nowIso()));
  const received=Date.parse(receivedAt||'');
  return Number.isFinite(received)&&received>=liveStart?'LIVE':'HISTORICAL';
}
function migrateV2Data(){
  const liveStart=getSetting('company_crm_live_start_at',nowIso());
  for(const c of db.prepare("SELECT id,phone,normalized_phone FROM customers WHERE phone IS NOT NULL AND phone<>''").all()){const n=normalizePhone(c.phone);if(n&&n!==c.normalized_phone)db.prepare('UPDATE customers SET normalized_phone=? WHERE id=?').run(n,c.id);}
  db.prepare(`UPDATE leads SET live_classification=CASE WHEN source_type='MANUAL' THEN 'LIVE' WHEN received_at>=? THEN 'LIVE' ELSE 'HISTORICAL' END WHERE live_classification IS NULL OR live_classification='' OR analysis_version<2`).run(liveStart);
  db.prepare(`UPDATE leads SET product_analysis_status=COALESCE(NULLIF(product_analysis_status,''),'PENDING'),price_analysis_status=COALESCE(NULLIF(price_analysis_status,''),'PENDING'),qualification_status=COALESCE(NULLIF(qualification_status,''),'PENDING')`).run();
  db.prepare(`UPDATE leads SET verified_score=NULL,verified_temperature=NULL WHERE verified_at IS NULL AND COALESCE(verified_score,0)=0`).run();
}
migrateV2Data();

const GEMINI_PRODUCT_PROVIDER = new GeminiProductSynthesisProvider();
const PRODUCT_RESEARCH_ORCHESTRATOR = new ProductResearchOrchestrator({db,dataDir:DATA_DIR,geminiSynthesisProvider:GEMINI_PRODUCT_PROVIDER});
const ONLINE_PRICE_PROVIDER = new OnlinePriceResearchProvider();
const productIntelligenceInflight = new Map();

function productIntelligenceProviderStatus(){
  return {...GEMINI_PRODUCT_PROVIDER.status(),research_orchestrator:PRODUCT_RESEARCH_ORCHESTRATOR.status()};
}
function latestProductResearchRun(leadId,requirementId){return db.prepare('SELECT * FROM product_research_runs WHERE lead_id=? AND requirement_id=? ORDER BY id DESC LIMIT 1').get(leadId,requirementId)||null;}
function beginProductResearchRun(leadId,requirement,input){const stamp=nowIso();return Number(db.prepare('INSERT INTO product_research_runs(lead_id,requirement_id,cache_key,requested_product,status,provider_trace_json,started_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(leadId,requirement.id,input.cache_key,input.product_name,'QUEUED',json([]),stamp,stamp).lastInsertRowid);}
function updateProductResearchRun(runId,status,{trace=null,error=null,complete=false}={}){if(!runId)return;db.prepare('UPDATE product_research_runs SET status=?,provider_trace_json=COALESCE(?,provider_trace_json),last_error=?,updated_at=?,completed_at=CASE WHEN ?=1 THEN ? ELSE completed_at END WHERE id=?').run(status,trace?json(trace):null,error||null,nowIso(),complete?1:0,complete?nowIso():null,runId);}

const GENERIC_PRODUCT_PLACEHOLDER_PATTERNS=[
  /product details below are working guidance/i,
  /match the confirmed measuring range\s*\/\s*capacity/i,
  /meet the required accuracy\s*\/\s*resolution/i,
  /suitable for the stated customer application/i,
  /confirm calibration\s*\/\s*certification/i,
  /customer application to be confirmed/i,
  /confirm required range/i,
  /match customer requirement/i,
  /product details need verification/i,
  /suitable for customer application/i,
  /please verify with supplier/i,
  /^\s*model dependent\s*$/i,
  /^\s*to be confirmed\s*$/i
];
function isGenericProductPlaceholder(value=''){
  const text=String(value||'').trim();
  return Boolean(text)&&GENERIC_PRODUCT_PLACEHOLDER_PATTERNS.some(re=>re.test(text));
}
function cleanGeneratedProductList(values=[]){
  const arr=Array.isArray(values)?values:[];const out=[];
  for(const value of arr){const text=String(value||'').replace(/^\s*[•\-*]+\s*/,'').trim();if(text&&!isGenericProductPlaceholder(text)&&!out.includes(text))out.push(text);}
  return out;
}
function productDescriptionText(value=''){
  const raw=String(value||'').trim();if(!raw)return '';
  const parts=raw.split(/\r?\n+/).map(x=>String(x).replace(/^\s*[•\-*]+\s*/,'').trim()).filter(Boolean).filter(x=>!isGenericProductPlaceholder(x));
  return parts.join(' ').replace(/\s+/g,' ').trim();
}
function generatedDescription(result={}){
  return productDescriptionText(result.description || (Array.isArray(result.description_bullets)?result.description_bullets.join(' '):''));
}
function cacheContainsGenericProductContent(row){
  const raw=safeJson(row?.raw_json,{})||{};
  const specs=(raw.specifications||[]).flatMap(x=>[x?.name,x?.value]);
  const values=[raw.description,...(raw.description_bullets||[]),...(raw.features||raw.key_features||[]),...(raw.applications||[]),...specs];
  return values.some(isGenericProductPlaceholder);
}
function completeGeneratedResult(result={}){
  const specs=(result.specifications||[]).filter(x=>String(x?.name||'').trim()&&String(x?.value||'').trim());
  const description=productDescriptionText(result.description||'');
  const features=cleanGeneratedProductList(result.features?.length?result.features:result.key_features||[]);
  const applications=cleanGeneratedProductList(result.applications||[]);
  return {ok:specs.length>=3&&Boolean(description)&&features.length>=3&&applications.length>=2,specs:specs.length,description:Boolean(description),features:features.length,applications:applications.length};
}
function productCacheRow(cacheKey=''){
  if(!cacheKey)return null;
  const row=db.prepare('SELECT * FROM product_intelligence_cache WHERE cache_key=?').get(cacheKey);
  if(!row)return null;
  const raw=safeJson(row.raw_json,{})||{};
  const invalidVersion=String(row.product_intelligence_version||raw.product_intelligence_version||'')!==PRODUCT_INTELLIGENCE_VERSION;
  const incomplete=!completeGeneratedResult(raw).ok;
  const generic=cacheContainsGenericProductContent(row);
  if(invalidVersion||incomplete||generic||String(row.generation_status||'').toUpperCase()!=='COMPLETE'){
    db.prepare("UPDATE product_intelligence_cache SET status=?,generation_status='PENDING',updated_at=? WHERE id=?").run(generic?'INVALID':'STALE',nowIso(),row.id);
    return null;
  }
  const expires=Date.parse(row.expires_at||'');
  if(Number.isFinite(expires)&&expires<Date.now())return null;
  db.prepare('UPDATE product_intelligence_cache SET last_used_at=?,use_count=COALESCE(use_count,0)+1 WHERE id=?').run(nowIso(),row.id);
  return row;
}
function productCacheRowForInput(input={}){
  const exact=productCacheRow(input.cache_key);if(exact)return exact;
  const normalized=String(input.normalized_product_name||'').trim();if(!normalized)return null;
  const candidates=db.prepare(`SELECT * FROM product_intelligence_cache WHERE normalized_product_name=? ORDER BY updated_at DESC,id DESC LIMIT 8`).all(normalized);
  const wantedModel=compactModelV25(input.model||'');
  const wantedCaps=(input.requested_capabilities||input.request_analysis?.requested_capabilities||[]).map(x=>normalizeProductNameV25(x)).filter(Boolean);
  for(const row of candidates){
    const rowModel=compactModelV25(row.model||'');
    if(wantedModel&&rowModel&&wantedModel!==rowModel)continue;
    if(wantedCaps.length){const raw=safeJson(row.raw_json,{})||{},rowCaps=(raw.request_analysis?.requested_capabilities||[]).map(x=>normalizeProductNameV25(x));if(!wantedCaps.every(w=>rowCaps.some(r=>r===w||r.includes(w)||w.includes(r))))continue;}
    const valid=productCacheRow(row.cache_key);if(valid)return valid;
  }
  return null;
}
function productSpecCount(productId){
  if(!productId)return 0;
  return Number(db.prepare("SELECT COUNT(*) AS c FROM product_specifications WHERE product_id=? AND TRIM(COALESCE(spec_value,''))<>''").get(productId)?.c||0);
}
function productRecordIsComplete(productId){
  if(!productId)return false;
  const p=db.prepare('SELECT description,key_features_json,applications_json FROM products WHERE id=?').get(productId);if(!p)return false;
  const features=cleanGeneratedProductList(safeJson(p.key_features_json,[])||[]),apps=cleanGeneratedProductList(safeJson(p.applications_json,[])||[]);
  return productSpecCount(productId)>=3&&Boolean(productDescriptionText(p.description||''))&&features.length>=3&&apps.length>=2;
}
function findProductByIdentity(input={}){
  const rows=db.prepare('SELECT * FROM products ORDER BY id DESC LIMIT 5000').all();
  const rm=compactModelV25(input.model||''), rb=normalizeProductNameV25(input.brand||''), rn=normalizeProductNameV25(input.product_name||'');
  let best=null,bestScore=0;
  for(const p of rows){
    const pm=compactModelV25(p.model||''), pb=normalizeProductNameV25(p.brand||''), pn=normalizeProductNameV25(p.name||'');
    let score=0;
    if(rm&&pm&&rm===pm)score+=70;
    if(rb&&pb&&rb===pb)score+=18;
    if(rn&&pn&&rn===pn)score+=35; else if(rn&&pn&&(rn.includes(pn)||pn.includes(rn)))score+=18;
    if(score>bestScore){bestScore=score;best=p;}
  }
  return bestScore>=55?best:null;
}
function findExactStoredProduct(input={}){
  const normalized=String(input.normalized_product_name||normalizeProductNameV25(input.product_name||'')).trim();
  if(normalized){const byName=db.prepare("SELECT * FROM products WHERE normalized_name=? AND COALESCE(demo,0)=0 ORDER BY manual_verified DESC,id DESC LIMIT 1").get(normalized);if(byName&&productRecordIsComplete(byName.id))return byName;}
  const model=compactModelV25(input.model||''),brand=normalizeProductNameV25(input.brand||'');
  if(model){
    const rows=db.prepare("SELECT * FROM products WHERE TRIM(COALESCE(model,''))<>'' AND COALESCE(demo,0)=0 ORDER BY manual_verified DESC,id DESC LIMIT 2500").all();
    const hit=rows.find(p=>compactModelV25(p.model||'')===model&&(!brand||!p.brand||normalizeProductNameV25(p.brand||'')===brand));
    if(hit&&productRecordIsComplete(hit.id))return hit;
  }
  return null;
}
function upsertGeneratedProduct(input,result,{force=false}={}){
  const complete=completeGeneratedResult(result);if(!complete.ok)return null;
  const identity=result?.identity||{};const confidence=Math.max(0,Math.min(100,Number(identity.confidence||identity.identity_confidence||0)));
  const expiresAt=PRODUCT_INTELLIGENCE_CACHE_DAYS>0?new Date(Date.now()+PRODUCT_INTELLIGENCE_CACHE_DAYS*86400000).toISOString():null;
  let product=findProductByIdentity({product_name:identity.product_name||input.product_name,brand:identity.brand||input.brand,model:identity.model||input.model});
  let productId=product?.id||null;
  const generatedDesc=generatedDescription(result),generatedFeatures=cleanGeneratedProductList(result.features||result.key_features||[]),generatedApps=cleanGeneratedProductList(result.applications||[]);
  if(!productId){
    productId=db.prepare(`INSERT INTO products(name,brand,series,model,category,description,key_features_json,applications_json,normalized_name,manual_verified,updated_at,demo) VALUES (?,?,?,?,?,?,?,?,?,0,?,0)`).run(identity.product_name||input.product_name,identity.brand||input.brand||null,identity.series||null,identity.model||input.model||null,identity.category||input.category||null,generatedDesc||null,json(generatedFeatures),json(generatedApps),normalizeProductNameV25(identity.product_name||input.product_name),nowIso()).lastInsertRowid;
    product=db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  } else {
    const manualProduct=Number(product.manual_verified||0)===1;
    const currentFeatures=cleanGeneratedProductList(safeJson(product.key_features_json,[])||[]),currentApps=cleanGeneratedProductList(safeJson(product.applications_json,[])||[]);
    const desc=manualProduct&&productDescriptionText(product.description||'')?product.description:(generatedDesc||product.description||null);
    const features=manualProduct&&currentFeatures.length>=3?product.key_features_json:(generatedFeatures.length?json(generatedFeatures):product.key_features_json||json([]));
    const apps=manualProduct&&currentApps.length>=2?product.applications_json:(generatedApps.length?json(generatedApps):product.applications_json||json([]));
    const keep=(oldv,newv)=>manualProduct?(oldv||newv||null):(String(newv||'').trim()||oldv||null);
    db.prepare(`UPDATE products SET name=?,brand=?,series=?,model=?,category=?,description=?,key_features_json=?,applications_json=?,normalized_name=?,updated_at=? WHERE id=?`).run(keep(product.name,identity.product_name||input.product_name),keep(product.brand,identity.brand||input.brand),keep(product.series,identity.series),keep(product.model,identity.model||input.model),keep(product.category,identity.category||input.category),desc,features,apps,normalizeProductNameV25(identity.product_name||product.name||input.product_name),nowIso(),productId);
  }
  const aliases=[input.original_product_name,input.normalized_product_name,identity.product_name,identity.model,input.model].filter(Boolean);
  for(const alias of aliases){const exists=db.prepare('SELECT id FROM product_aliases WHERE product_id=? AND lower(alias)=lower(?) LIMIT 1').get(productId,alias);if(!exists)db.prepare('INSERT INTO product_aliases(product_id,alias) VALUES (?,?)').run(productId,alias);}
  const manualKeys=new Set(db.prepare('SELECT lower(spec_key) AS k FROM product_specifications WHERE product_id=? AND COALESCE(is_manual,0)=1').all(productId).map(x=>x.k));
  db.prepare('DELETE FROM product_specifications WHERE product_id=? AND COALESCE(is_manual,0)=0').run(productId);
  for(const spec of result.specifications||[]){
    const key=String(spec.name||'').trim(),value=String(spec.value||'').trim();if(!key||!value||manualKeys.has(key.toLowerCase()))continue;
    db.prepare(`INSERT INTO product_specifications(product_id,spec_key,spec_value,source,source_url,confidence,verification_status,is_manual) VALUES (?,?,?,?,?,?,?,0)`).run(productId,key,value,spec.source||'Gemini Product Intelligence',spec.source_url||null,Math.round(Number(spec.confidence||0)),spec.verification_status||'NEEDS VERIFICATION');
  }
  db.prepare('DELETE FROM product_sources WHERE product_id=?').run(productId);
  for(const src of result.sources||[]){db.prepare('INSERT INTO product_sources(product_id,source_type,source_name,source_url,confidence,verification_status,retrieved_at) VALUES (?,?,?,?,?,?,?)').run(productId,src.type||'Online Source',src.name||src.title||src.type||'Source',src.url||null,confidence,confidence>=90?'VERIFIED':'NEEDS VERIFICATION',nowIso());}
  const stored={...result,product_intelligence_version:PRODUCT_INTELLIGENCE_VERSION,generation_status:'COMPLETE'};
  db.prepare(`INSERT INTO product_intelligence_cache(cache_key,product_id,original_product_name,normalized_product_name,brand,model,category,identity_confidence,provider,status,raw_json,created_at,updated_at,expires_at,product_intelligence_version,generation_status,last_used_at,use_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET product_id=excluded.product_id,original_product_name=excluded.original_product_name,normalized_product_name=excluded.normalized_product_name,brand=excluded.brand,model=excluded.model,category=excluded.category,identity_confidence=excluded.identity_confidence,provider=excluded.provider,status=excluded.status,raw_json=excluded.raw_json,updated_at=excluded.updated_at,expires_at=excluded.expires_at,product_intelligence_version=excluded.product_intelligence_version,generation_status=excluded.generation_status,last_used_at=excluded.last_used_at,use_count=COALESCE(product_intelligence_cache.use_count,0)+1`).run(input.cache_key,productId,input.original_product_name,input.normalized_product_name,identity.brand||input.brand||null,identity.model||input.model||null,identity.category||input.category||null,confidence,result.provider||'Gemini Product Intelligence','COMPLETE',json(stored),nowIso(),nowIso(),expiresAt,PRODUCT_INTELLIGENCE_VERSION,'COMPLETE',nowIso(),1);
  return productId;
}

async function ensureAutomaticProductIntelligence(leadId,requirement,{force=false}={}){
  const input=buildProductIntelligenceInput(requirement);if(!input.product_name)return {status:'NO_PRODUCT'};
  console.log(`[PRODUCT-AI] Product: ${input.product_name}`);
  console.log(`[PRODUCT-AI] Gemini configured: ${GEMINI_PRODUCT_PROVIDER.isConfigured()?'YES':'NO'}`);
  db.prepare(`UPDATE product_requirements SET original_product_name=COALESCE(original_product_name,product_name),normalized_product_name=?,detected_brand=?,detected_model=?,detected_category=? WHERE id=?`).run(input.normalized_product_name,input.brand||null,input.model||null,input.category||null,requirement.id);
  if(!force){
    const cached=productCacheRowForInput(input);console.log(`[PRODUCT-AI] Cache: ${cached?'HIT':'MISS'}`);
    if(cached){const cachedRaw=safeJson(cached.raw_json,{})||{};db.prepare(`UPDATE product_requirements SET product_identity_confidence=?,request_analysis_json=COALESCE(NULLIF(request_analysis_json,''),?) WHERE id=?`).run(cached.identity_confidence||0,cachedRaw.request_analysis?json(cachedRaw.request_analysis):null,requirement.id);if(cached.product_id)return {status:'CACHE',productId:cached.product_id,confidence:cached.identity_confidence||0};}
    const local=findExactStoredProduct(input)||findProductByIdentity(input);if(local&&productRecordIsComplete(local.id)){const manual=Number(local.manual_verified||0)===1;console.log(`[PRODUCT-AI] Validation: PASS (${manual?'verified internal':'saved product library'} record)`);return {status:manual?'LOCAL_VERIFIED':'LOCAL_STORED',productId:local.id,confidence:manual?95:Math.max(80,Number(requirement.product_identity_confidence||0)||85)};}
  }else console.log('[PRODUCT-AI] Cache: BYPASSED');
  if(productIntelligenceInflight.has(input.cache_key))return productIntelligenceInflight.get(input.cache_key);
  const runId=beginProductResearchRun(leadId,requirement,input);
  const work=(async()=>{
    try{
      console.log('[PRODUCT-AI] Research started');
      const statusMap={SEARCHING_INTERNAL:'SEARCHING_INTERNAL',SEARCHING_DRIVE:'SEARCHING_DRIVE',SEARCHING_MANUFACTURER:'SEARCHING_MANUFACTURER',SEARCHING_INDIAMART:'SEARCHING_INDIAMART',SEARCHING_PUBLIC:'SEARCHING_PUBLIC',GENERATING:'GENERATING',COMPLETED:'COMPLETED'};
      const result=await PRODUCT_RESEARCH_ORCHESTRATOR.research(input,{force,onStatus:(status)=>updateProductResearchRun(runId,statusMap[status]||status)});
      const failureStatus=String(result?.status||'FAILED').toUpperCase();
      if(failureStatus!=='OK'){
        const keyMissing=['KEY_MISSING','NOT_CONFIGURED'].includes(failureStatus);const safe=keyMissing?'Product information service is not configured.':(result?.error||`Product research ended with ${failureStatus}.`);
        updateProductResearchRun(runId,keyMissing?'KEY_MISSING':failureStatus,{trace:result?.research_trace,error:safe,complete:true});
        console.error(`[PRODUCT-AI] Gemini request failed: ${failureStatus}`);
        return {...result,status:keyMissing?'KEY_MISSING':failureStatus};
      }
      console.log('[PRODUCT-AI] Gemini response received');
      const completeness=completeGeneratedResult(result);
      console.log(`[PRODUCT-AI] Specifications: ${completeness.specs}`);console.log(`[PRODUCT-AI] Description: ${completeness.description?'OK':'MISSING'}`);console.log(`[PRODUCT-AI] Features: ${completeness.features}`);console.log(`[PRODUCT-AI] Applications: ${completeness.applications}`);console.log(`[PRODUCT-AI] Validation: ${completeness.ok?'PASS':'FAIL'}`);
      if(!completeness.ok){updateProductResearchRun(runId,'INVALID_RESPONSE',{trace:result.research_trace,error:'Gemini response was incomplete after repair.',complete:true});return {status:'INVALID_RESPONSE',result,research_trace:result.research_trace};}
      let productId=Number(result.direct_product_id||0)||null;if(!productId||!productRecordIsComplete(productId))productId=upsertGeneratedProduct(input,result,{force});
      db.prepare('UPDATE product_requirements SET detected_brand=?,detected_model=?,detected_category=?,product_identity_confidence=?,request_analysis_json=? WHERE id=?').run(result.identity?.brand||input.brand||null,result.identity?.model||input.model||null,result.identity?.category||input.category||null,Number(result.identity?.confidence||result.identity?.identity_confidence||0),json(result.request_analysis||input.request_analysis||{}),requirement.id);
      const saved=Boolean(productId&&productRecordIsComplete(productId));updateProductResearchRun(runId,saved?'COMPLETED':'INVALID_RESPONSE',{trace:result.research_trace,error:saved?null:'Complete Product Information could not be saved.',complete:true});console.log(`[PRODUCT-AI] Saved: ${saved?'YES':'NO'}`);
      return {status:saved?'COMPLETE':'INVALID_RESPONSE',productId:saved?productId:null,confidence:Number(result.identity?.confidence||result.identity?.identity_confidence||0),result,research_trace:result.research_trace};
    }catch(e){const code=String(e?.code||'API_REQUEST_FAILED').toUpperCase();updateProductResearchRun(runId,code,{error:e.message,complete:true});console.error(`[PRODUCT-AI] Gemini request failed: ${code}`);return {status:code,error:e.message};}
    finally{productIntelligenceInflight.delete(input.cache_key);}
  })();
  productIntelligenceInflight.set(input.cache_key,work);return work;
}

function productSearch(requirement={}) {
  const groups=[];
  for(const provider of PRODUCT_PROVIDERS){try{groups.push(provider.search(requirement)||[]);}catch(e){console.warn(`[PRODUCT PROVIDER ${provider.name}]`,e.message);}}
  return mergeProductResults(groups).slice(0,12);
}
function getProductMatch(productName='', brand='', model='', extra={}) {
  const requirement={product_name:productName,requested_brand:brand,requested_model:model,...extra};
  const best=productSearch(requirement)[0]||null;
  return best&&best.confidence>=35?{product:best.product,score:best.confidence,provider:best.provider,source:best.source,verification_status:best.verification_status}:null;
}

function inferRequirementIdentity(requirement={}){
  const name=String(requirement.product_name||'').trim();
  if(!name)return {brand:requirement.requested_brand||null,model:requirement.requested_model||null};
  let brand=String(requirement.requested_brand||'').trim()||null;
  let model=String(requirement.requested_model||'').trim()||null;
  if(!brand){
    const brands=[
      [/\bUNI[-\s]?T\b/i,'UNI-T'],[/\bFLUKE\b/i,'Fluke'],[/\bOHAUS\b/i,'OHAUS'],[/\bMETRAVI\b/i,'Metravi'],[/\bHIOKI\b/i,'Hioki'],[/\bMEGGER\b/i,'Megger'],[/\bTESTO\b/i,'Testo'],[/\bHANNA\b/i,'Hanna'],[/\bEXTECH\b/i,'Extech'],[/\bKUSAM[-\s]?MECO\b/i,'Kusam Meco'],[/\bMOTWANE\b/i,'Motwane'],[/\bMITUTOYO\b/i,'Mitutoyo'],[/\bBROOKFIELD\b/i,'Brookfield'],[/\bMETTLER(?:\s+TOLEDO)?\b/i,'Mettler Toledo'],[/\bHTC\b/i,'HTC'],[/\bATAGO\b/i,'Atago'],[/\bUPCERA\b/i,'Upcera']
    ];
    for(const [re,label] of brands){if(re.test(name)){brand=label;break;}}
  }
  if(!model){
    const cleaned=name.replace(/\bUNI[-\s]?T\b/ig,' ').replace(/\bFLUKE\b/ig,' ').replace(/\bOHAUS\b/ig,' ').replace(/\bMETRAVI\b/ig,' ').replace(/\bHTC\b/ig,' ').replace(/\bATAGO\b/ig,' ').replace(/\bUPCERA\b/ig,' ').trim();
    const special=cleaned.match(/\b(UTD\d+[A-Z0-9+\/-]*(?:\s+PLUS)?|TI\d+[A-Z0-9+\/-]*(?:\s+PRO)?|AX\d+[A-Z0-9+\/-]*|MERA\s+PAL|A7\+)(?=\s|$)/i);
    if(special)model=special[1].replace(/\s+/g,' ').trim();
    else {
      const candidates=cleaned.match(/\b[A-Z]{1,8}[-/]?\d{2,}[A-Z0-9+./-]*(?:\s+(?:PLUS|PRO|MAX|II|III))?\b/ig)||[];
      model=candidates.map(x=>x.trim()).find(x=>!/^SF\d+/i.test(x)&&!/^20\d{2}$/.test(x))||null;
    }
  }
  return {brand,model};
}
function applyInferredRequirementIdentity(requirement={}){
  const inferred=inferRequirementIdentity(requirement);
  const updates=[];const values=[];const status=safeJson(requirement.status_json,{})||{};let changed=false;
  if(!String(requirement.requested_brand||'').trim()&&inferred.brand){updates.push('requested_brand=?');values.push(inferred.brand);status.brand='AI_INFERRED';changed=true;}
  if(!String(requirement.requested_model||'').trim()&&inferred.model){updates.push('requested_model=?');values.push(inferred.model);status.model='AI_INFERRED';changed=true;}
  if(changed){updates.push('status_json=?');values.push(json(status));db.prepare(`UPDATE product_requirements SET ${updates.join(',')} WHERE id=?`).run(...values,requirement.id);return db.prepare('SELECT * FROM product_requirements WHERE id=?').get(requirement.id);}
  return requirement;
}
function productQuestionSet(requirement={}){
  const n=normalizeProductText(`${requirement.product_name||''} ${requirement.requested_model||''}`);
  if(/oscilloscope|scopemeter|scope meter|\butd\s*\d|\bdso\s*\d/.test(n))return ['Required bandwidth?','How many channels are required?','Required real-time sample rate?','Required memory depth?','Bench or portable use?','Which probes/accessories are required?','USB/LAN/other interfaces required?','Application (electronics, service, education, R&D)?','Budget?','Required delivery date?','Quantity?'];
  if(/air quality|iaq|pollution/.test(n))return ['Which parameters must be measured (PM2.5, PM10, CO₂, VOC, temperature, humidity)?','Indoor or outdoor use?','Portable or fixed installation?','Is data logging required?','Which communication is required (USB, RS232, Modbus, Wi-Fi)?','Required accuracy/range?','Budget?','Required delivery date?','Quantity?'];
  if(/analytical balance|precision balance|balance/.test(n))return ['Required capacity?','Required readability/resolution?','Internal or external calibration?','Application / sample type?','Any GLP/GMP or certification requirement?','Communication/output required?','Budget?','Required delivery date?','Quantity?'];
  if(/ph meter|phmeter/.test(n))return ['Required pH range?','Required resolution and accuracy?','Bench, portable or online type?','Temperature compensation required?','Calibration points required?','Electrode/application type?','Data logging/communication required?','Budget?','Delivery date?','Quantity?'];
  if(/uv meter|ultraviolet|uv light/.test(n))return ['Which UV band is required (UVA / UVB / UVC)?','Required spectral range?','Required measuring range and resolution?','Required accuracy?','Handheld or fixed monitoring?','Data logging required?','Application (lamp validation, curing, sterilization, safety, research)?','Calibration/certificate required?','Budget?','Delivery date?','Quantity?'];
  if(/vibration/.test(n))return ['Velocity, acceleration or displacement measurement?','Required frequency range?','Required measuring range?','Handheld or continuous monitoring?','Sensor/probe type?','Data logging required?','Application/machine type?','Budget?','Delivery date?','Quantity?'];
  if(/distillation|distillation apparatus|all glass/.test(n))return ['Required capacity / flask size?','All-glass or metal heating assembly?','Required glass type / joint size?','Heating method or power requirement?','Required temperature range?','Condenser type required?','Single or multiple unit setup?','Application / sample type?','Any accessories or receiver required?','Budget?','Required delivery date?','Quantity?'];
  if(/skinfold|skin fold|caliper/.test(n))return ['Required measuring range?','Required measuring pressure?','Required accuracy / repeatability?','Dial or digital indication?','Clinical, sports or research application?','Calibration certificate required?','Budget?','Required delivery date?','Quantity?'];
  if(/moisture/.test(n))return ['Material / application?','Required measuring range?','Required accuracy / resolution?','Portable or bench type?','Probe / sensor requirement?','Data logging required?','Preferred brand/model?','Budget?','Required delivery date?','Quantity?'];
  return ['What is the exact application?','Any required range/capacity?','Required accuracy/resolution?','Preferred brand/model?','Any certification or calibration requirement?','Required accessories/features?','Budget?','Required delivery date?','Quantity?'];
}
function requestAnalysisForRequirement(requirement={}){
  const deterministic=buildProductIntelligenceInput(requirement).request_analysis||{};
  const saved=safeJson(requirement.request_analysis_json,{})||{};
  const mergeList=(a,b)=>{const out=[];for(const v of [...(Array.isArray(a)?a:[]),...(Array.isArray(b)?b:[])]){const x=String(v||'').trim();if(x&&!out.some(y=>y.toLowerCase()===x.toLowerCase()))out.push(x);}return out;};
  return {
    ...deterministic,...saved,
    original_request:saved.original_request||deterministic.original_request||requirement.product_name||'',
    base_product:saved.base_product||deterministic.base_product||requirement.product_name||'',
    requested_capabilities:mergeList(saved.requested_capabilities,deterministic.requested_capabilities),
    selection_focus:mergeList(saved.selection_focus,deterministic.selection_focus),
    questions_to_confirm:mergeList(saved.questions_to_confirm,[])
  };
}
function productIntelligenceForLead(leadId){
  const requirements=db.prepare('SELECT * FROM product_requirements WHERE lead_id=? ORDER BY id').all(leadId);
  return requirements.map(req=>{
    const request_analysis=requestAnalysisForRequirement(req);
    const results=productSearch(req);
    const linked=db.prepare('SELECT lp.*,p.* FROM lead_products lp LEFT JOIN products p ON p.id=lp.product_id WHERE lp.lead_id=? AND lp.requirement_id=? ORDER BY lp.match_confidence DESC,lp.id LIMIT 1').get(leadId,req.id);
    const best=linked?.product_id?{provider:'Internal Product Database',product:{id:linked.product_id,name:linked.name,brand:linked.brand,series:linked.series,model:linked.model,category:linked.category,description:linked.description,key_features_json:linked.key_features_json,applications_json:linked.applications_json,internal_code:linked.internal_code},confidence:Number(linked.match_confidence||req.product_identity_confidence||0),source:'Product Intelligence Cache',verification_status:Number(req.product_identity_confidence||0)>=90?'VERIFIED':'NEEDS VERIFICATION'}:(results[0]||null);
    let product=null,specs=[],features=[],applications=[],description='',verification_status='NEEDS VERIFICATION',sources=[];
    if(best?.product?.id){
      const p=db.prepare('SELECT * FROM products WHERE id=?').get(best.product.id);
      if(p){
        product={...p}; features=safeJson(p.key_features_json,[])||[]; applications=safeJson(p.applications_json,[])||[]; description=p.description||'';
        specs=db.prepare('SELECT * FROM product_specifications WHERE product_id=? ORDER BY id').all(p.id);
        sources=db.prepare('SELECT source_type AS type,source_name AS name,source_url AS url,confidence,verification_status,retrieved_at FROM product_sources WHERE product_id=? ORDER BY id').all(p.id);
        verification_status=best.verification_status||'CONFIRMED';
      }
    }
    if(!product&&best?.product){product={...best.product};verification_status=best.verification_status||'NEEDS VERIFICATION';}
    description=productDescriptionText(description);
    features=cleanGeneratedProductList(features);
    applications=cleanGeneratedProductList(applications);
    const identity={
      product_name:req.product_name||product?.name||'',
      brand:req.requested_brand||req.detected_brand||product?.brand||'',
      series:product?.series||'',
      model:req.requested_model||req.detected_model||product?.model||'',
      category:req.detected_category||product?.category||'',
      confidence:Number(req.product_identity_confidence||best?.confidence||0)
    };
    if(specs.length){
      const identityRows=[
        {spec_key:'Product Name',spec_value:identity.product_name,source:'CRM / Product Identity',source_url:null,confidence:100,verification_status:'CONFIRMED'},
        ...(identity.brand?[{spec_key:'Brand',spec_value:identity.brand,source:'Product Identity',source_url:null,confidence:identity.confidence||70,verification_status:identity.confidence>=90?'VERIFIED':'NEEDS VERIFICATION'}]:[]),
        ...(identity.series?[{spec_key:'Series',spec_value:identity.series,source:'Product Identity',source_url:null,confidence:identity.confidence||70,verification_status:identity.confidence>=90?'VERIFIED':'NEEDS VERIFICATION'}]:[]),
        ...(identity.model?[{spec_key:'Model',spec_value:identity.model,source:'Product Identity',source_url:null,confidence:identity.confidence||70,verification_status:identity.confidence>=90?'VERIFIED':'NEEDS VERIFICATION'}]:[])
      ];
      const seen=new Set(); specs=[...identityRows,...specs].filter(x=>{const k=normalizeProductText(x.spec_key);if(!k||seen.has(k))return false;seen.add(k);return true;});
    }
    const specOverrides=db.prepare('SELECT spec_key,spec_value,source,verification_status,updated_at FROM lead_specification_overrides WHERE lead_id=? ORDER BY id').all(leadId);
    if(specOverrides.length){
      const byKey=new Map(specs.map((x,i)=>[normalizeProductText(x.spec_key),i]));
      for(const o of specOverrides){const key=normalizeProductText(o.spec_key);if(byKey.has(key))specs[byKey.get(key)]={...specs[byKey.get(key)],...o,source_url:null,confidence:100};else specs.push({...o,source_url:null,confidence:100});}
    }
    const contentOverride=db.prepare('SELECT * FROM lead_product_content WHERE lead_id=?').get(leadId);
    if(contentOverride){
      if(contentOverride.description!=null&&String(contentOverride.description).trim()!=='')description=productDescriptionText(contentOverride.description);
      const f=safeJson(contentOverride.features_json,null);if(Array.isArray(f)&&f.length)features=f;
      const a=safeJson(contentOverride.applications_json,null);if(Array.isArray(a)&&a.length)applications=a;
    }
    description=productDescriptionText(description);features=cleanGeneratedProductList(features);applications=cleanGeneratedProductList(applications);
    const hasGeneratedContent=Boolean(specs.some(x=>String(x.spec_value||'').trim())||description||features.length||applications.length);
    const researchRun=latestProductResearchRun(leadId,req.id);
    return {requirement:req,best_match:best?{...best,product}:null,alternatives:results.filter(x=>!best?.product?.id||x.product?.id!==best.product.id).slice(0,4),identity,request_analysis,identity_warning:identity.product_name&&identity.confidence<70?'Product identity needs verification.':'',description,features,applications,specs,sources,verification_status,generator:'Product Research Orchestrator',gemini_configured:GEMINI_PRODUCT_PROVIDER.isConfigured(),product_service_configured:GEMINI_PRODUCT_PROVIDER.isConfigured()||Boolean(best?.product?.id),research_status:researchRun?.status||null,research_error:researchRun?.last_error||null,has_generated_content:hasGeneratedContent,discovery_questions:request_analysis.questions_to_confirm?.length?request_analysis.questions_to_confirm:productQuestionSet(req)};
  });
}
function priceMarginPolicy(marketType='INDIA'){
  const market=String(marketType||'INDIA').toUpperCase()==='EXPORT'?'EXPORT':'INDIA';
  return market==='EXPORT'?{market,min:EXPORT_MARGIN_MIN,max:EXPORT_MARGIN_MAX,default:DEFAULT_MARGIN_PERCENT}:{market,min:INDIA_MARGIN_MIN,max:INDIA_MARGIN_MAX,default:DEFAULT_MARGIN_PERCENT};
}
function leadMarketType(leadId){
  const row=db.prepare('SELECT l.market_type_override,l.external_country_bucket,c.country FROM leads l JOIN customers c ON c.id=l.customer_id WHERE l.id=?').get(leadId)||{};
  const explicit=String(row.market_type_override||row.external_country_bucket||'').toUpperCase();
  if(['INDIA','EXPORT'].includes(explicit))return explicit;
  return normalizeCountryBucket(row.country||'India');
}
function latestOnlinePriceResearch(leadId,requirementId=null){
  if(requirementId)return db.prepare('SELECT * FROM online_price_research WHERE lead_id=? AND requirement_id=? ORDER BY id DESC LIMIT 1').get(leadId,requirementId)||null;
  return db.prepare('SELECT * FROM online_price_research WHERE lead_id=? ORDER BY id DESC LIMIT 1').get(leadId)||null;
}
function insertOnlinePriceResearch({leadId,requirement,input,result,market,marginPercent,fromCache=false}={}){
  const c=result?.candidate||null,status=String(result?.status||'SKIPPED').toUpperCase()==='FOUND'?'FOUND':'SKIPPED';
  const original=status==='FOUND'?Number(c?.price||0)||null:null;
  const margin=Number.isFinite(Number(marginPercent))?Number(marginPercent):priceMarginPolicy(market).default;
  const suggested=original?Math.round((original*(1+(margin/100)))*100)/100:null;
  const raw={provider:result?.provider||null,trace:result?.trace||[],candidates:(result?.candidates||[]).slice(0,6),from_cache:Boolean(fromCache)};
  db.prepare(`INSERT INTO online_price_research(lead_id,requirement_id,cache_key,requested_product,requested_model,matched_product,matched_model,original_price,currency,gst_percent,supplier,stock_status,source_name,source_url,confidence,status,skip_reason,market_type,margin_percent,suggested_selling_price,raw_json,searched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    leadId,requirement.id,input.cache_key,input.product_name,input.model||null,c?.matched_product||null,c?.matched_model||null,original,c?.currency||'INR',(c?.gst_percent===null||c?.gst_percent===undefined||c?.gst_percent==='')?null:Number(c.gst_percent),c?.supplier||null,c?.stock_status||null,c?.source_name||result?.provider||null,c?.source_url||null,Number(c?.confidence||0),status,result?.skip_reason||null,market,margin,suggested,json(raw),nowIso()
  );
  return latestOnlinePriceResearch(leadId,requirement.id);
}
async function ensureOnlinePriceResearch(leadId,requirement,{force=false}={}){
  const input=buildProductIntelligenceInput(requirement);if(!input.product_name)return null;
  const market=leadMarketType(leadId),policy=priceMarginPolicy(market),cutoff=new Date(Date.now()-(ONLINE_PRICE_CACHE_HOURS*3600000)).toISOString();
  const previous=latestOnlinePriceResearch(leadId,requirement.id);
  let preferredMargin=Number(previous?.margin_percent);
  if(!Number.isFinite(preferredMargin)||preferredMargin<policy.min||preferredMargin>policy.max)preferredMargin=policy.default;
  if(!force){
    const own=previous;if(own&&own.cache_key===input.cache_key&&own.status==='FOUND'&&String(own.searched_at||'')>=cutoff)return own;
    const cached=db.prepare("SELECT * FROM online_price_research WHERE cache_key=? AND status='FOUND' AND searched_at>=? ORDER BY searched_at DESC,id DESC LIMIT 1").get(input.cache_key,cutoff);
    if(cached){const candidate={matched_product:cached.matched_product,matched_model:cached.matched_model,price:cached.original_price,currency:cached.currency,gst_percent:cached.gst_percent,supplier:cached.supplier,stock_status:cached.stock_status,source_name:cached.source_name,source_url:cached.source_url,confidence:cached.confidence};return insertOnlinePriceResearch({leadId,requirement,input,result:{status:'FOUND',provider:cached.source_name||'Cached Online Price',candidate,candidates:[candidate],trace:[{provider:'Online Price Cache',status:'REUSED'}]},market,marginPercent:preferredMargin,fromCache:true});}
  }
  let result;try{result=await ONLINE_PRICE_PROVIDER.research(input);}catch(e){result={status:'SKIPPED',provider:'Online Search',skip_reason:`Skipped online price: ${String(e.message||e).slice(0,220)}`,trace:[{provider:'Online Search',status:'ERROR',error:String(e.message||e).slice(0,180)}]};}
  return insertOnlinePriceResearch({leadId,requirement,input,result,market,marginPercent:preferredMargin});
}
function updateOnlinePricePreferencesForLead(leadId,b={}){
  const hasMargin=Object.hasOwn(b,'online_margin_percent'),hasMarket=Object.hasOwn(b,'market_type'),hasBase=Object.hasOwn(b,'online_reference_price'),hasSelling=Object.hasOwn(b,'verified_selling_price');
  if(!hasMargin&&!hasMarket&&!hasBase&&!hasSelling)return;
  let row=latestOnlinePriceResearch(leadId);
  const market=String(b.market_type||row?.market_type||leadMarketType(leadId)).toUpperCase()==='EXPORT'?'EXPORT':'INDIA',policy=priceMarginPolicy(market);
  let margin=hasMargin?Number(b.online_margin_percent):Number(row?.margin_percent);
  if(!Number.isFinite(margin))margin=policy.default;margin=Math.min(policy.max,Math.max(policy.min,margin));
  const requestedBase=hasBase?Number(b.online_reference_price):Number(row?.original_price||0);
  const requestedSelling=hasSelling?Number(b.verified_selling_price):Number(row?.suggested_selling_price||0);
  if(requestedBase>0&&!row){
    const requirement=db.prepare('SELECT * FROM product_requirements WHERE lead_id=? ORDER BY id LIMIT 1').get(leadId);if(!requirement)return;
    const input=buildProductIntelligenceInput(requirement),suggested=requestedSelling>0?roundMoney(requestedSelling):roundMoney(requestedBase*(1+margin/100)),stamp=nowIso();
    db.prepare(`INSERT INTO online_price_research(lead_id,requirement_id,cache_key,requested_product,requested_model,matched_product,matched_model,original_price,currency,gst_percent,supplier,stock_status,source_name,source_url,confidence,status,skip_reason,market_type,margin_percent,suggested_selling_price,raw_json,searched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      leadId,requirement.id,input.cache_key,input.product_name,input.model||null,input.product_name||requirement.product_name||null,input.model||requirement.requested_model||null,roundMoney(requestedBase),'INR',null,b.supplier||null,b.stock_status||null,'Manual Price Entry',null,100,'FOUND',null,market,margin,suggested,json({provider:'Manual Price Entry',manual:true}),stamp
    );
    return;
  }
  if(!row)return;
  const oldBase=Number(row.original_price||0),manualOverride=requestedBase>0&&(row.status!=='FOUND'||Math.abs(oldBase-requestedBase)>0.009);
  const original=requestedBase>0?roundMoney(requestedBase):oldBase;
  const suggested=requestedSelling>0?roundMoney(requestedSelling):(original>0?roundMoney(original*(1+(margin/100))):null);
  if(manualOverride){
    db.prepare("UPDATE online_price_research SET original_price=?,currency='INR',market_type=?,margin_percent=?,suggested_selling_price=?,source_name='Manual Price Entry',source_url=NULL,confidence=100,status='FOUND',skip_reason=NULL,raw_json=?,searched_at=? WHERE id=?").run(original,market,margin,suggested,json({provider:'Manual Price Entry',manual:true}),nowIso(),row.id);
  }else{
    db.prepare('UPDATE online_price_research SET original_price=?,market_type=?,margin_percent=?,suggested_selling_price=? WHERE id=?').run(original||null,market,margin,suggested,row.id);
  }
}
function priceIntelligenceForLead(leadId){
  const req=db.prepare('SELECT * FROM product_requirements WHERE lead_id=? ORDER BY id LIMIT 1').get(leadId);
  if(!req)return {status:'NOT AVAILABLE',reliability:'LOW',records:[],online_status:'NOT SEARCHED'};
  const match=db.prepare('SELECT lp.*,p.name,p.model,p.brand FROM lead_products lp LEFT JOIN products p ON p.id=lp.product_id WHERE lp.lead_id=? ORDER BY lp.match_confidence DESC,lp.id LIMIT 1').get(leadId);
  const records=[];
  if(match?.product_id){
    for(const r of db.prepare("SELECT * FROM product_prices WHERE product_id=? ORDER BY COALESCE(price_date,'') DESC,id DESC LIMIT 10").all(match.product_id)) records.push({type:'INTERNAL PRICE',...r,match_confidence:match.match_confidence,source:r.source||'Internal Product Database'});
  }
  try{
    const fileProvider=PRODUCT_PROVIDERS?.find?.(x=>x?.name==='Company Product Master File');
    const numberFrom=v=>{const n=Number(String(v??'').replace(/[^0-9.\-]/g,''));return Number.isFinite(n)&&n>0?n:null};
    const normalizedRow=row=>Object.fromEntries(Object.entries(row||{}).map(([k,v])=>[normalizeProductText(k).replace(/ /g,'_'),v]));
    for(const hit of fileProvider?.search(req)||[]){
      if(Number(hit.confidence||0)<45)continue;const raw=normalizedRow(hit.raw||{});
      const purchase=numberFrom(raw.last_purchase_price??raw.purchase_price??raw.buy_price??raw.cost_price??raw.cost),selling=numberFrom(raw.last_selling_price??raw.selling_price??raw.sale_price??raw.unit_price??raw.price??raw.rate),previous=numberFrom(raw.previous_quoted_price??raw.quoted_price??raw.quote_price??raw.previous_quote),suggested=numberFrom(raw.suggested_selling_price??raw.suggested_price)??selling??previous;
      if(![purchase,selling,previous,suggested].some(v=>Number(v)>0))continue;
      records.push({type:'COMPANY PRODUCT MASTER',matched_product:hit.product?.name||raw.product_name||raw.product||raw.item_name||null,matched_model:hit.product?.model||raw.model||raw.model_no||raw.model_number||null,purchase_price:purchase,selling_price:selling,previous_quoted_price:previous,suggested_selling_price:suggested,gst_percent:numberFrom(raw.gst_percent??raw.gst),price_date:raw.price_date||raw.date||raw.updated_at||raw.quotation_date||null,supplier:raw.supplier||raw.vendor||raw.company||null,stock_status:raw.stock_status||raw.stock||null,lead_time:raw.lead_time||raw.delivery||null,source:raw.source||`Company Product Master (${hit.source||'Excel / Drive / Sheets export'})`,match_confidence:Number(hit.confidence||0),verified:0});
    }
  }catch(e){console.warn('[PRICE] Company product master search skipped:',e.message)}
  const qn=normalizeProductText(req.product_name),qm=normalizeProductText(req.requested_model||'');const history=db.prepare(`SELECT qi.*,q.quotation_no,q.created_at AS price_date,q.status,c.name AS customer_name FROM quotation_items qi JOIN quotations q ON q.id=qi.quotation_id JOIN customers c ON c.id=q.customer_id WHERE qi.unit_price IS NOT NULL ORDER BY q.created_at DESC LIMIT 1000`).all();
  for(const h of history){const hn=normalizeProductText(h.product_name),hm=normalizeProductText(h.model||'');const nameMatch=qn&&(hn===qn||hn.includes(qn)||qn.includes(hn)),modelMatch=qm&&hm&&(hm===qm||hm.includes(qm)||qm.includes(hm));if(modelMatch||nameMatch)records.push({type:'PREVIOUS QUOTATION',previous_quoted_price:h.unit_price,selling_price:h.unit_price,price_date:h.price_date,customer:h.customer_name,source:`Quotation ${h.quotation_no}`,match_confidence:modelMatch?95:nameMatch?75:45,verified:1});}
  records.sort((a,b)=>(Number(b.match_confidence||0)-Number(a.match_confidence||0))||(Date.parse(b.price_date||0)-Date.parse(a.price_date||0)));
  const latest=records[0]||null,online=latestOnlinePriceResearch(leadId,req.id),onlineFound=online?.status==='FOUND'&&Number(online.original_price)>0,policy=priceMarginPolicy(online?.market_type||leadMarketType(leadId));
  const first=key=>records.map(r=>Number(r[key])).find(v=>Number.isFinite(v)&&v>0)||null;
  if(!latest&&!onlineFound)return {status:'NEEDS PRICE VERIFICATION',reliability:'LOW',records:[],matched_product:match?.name||req.product_name||null,match_percent:Number(match?.match_confidence||0)||null,last_purchase:null,last_selling:null,previous_quote:null,suggested_selling:null,gst_percent:18,online_status:online?.status||'NOT SEARCHED',online_skip_reason:online?.skip_reason||null,online_price:null,margin_policy:policy};
  let reliability='LOW';if(latest){const ageDays=(Date.now()-Date.parse(latest.price_date||0))/86400000,exact=(latest.match_confidence||0)>=90;reliability=exact&&ageDays<=180?'HIGH':exact||ageDays<=365?'MEDIUM':'LOW';}
  const status=latest?'AVAILABLE':'ONLINE PRICE FOUND';
  return {status,reliability,records:records.slice(0,10),matched_product:latest?.matched_product||online?.matched_product||match?.name||req.product_name||null,match_percent:Number(latest?.match_confidence||online?.confidence||match?.match_confidence||0)||null,last_purchase:first('purchase_price'),last_selling:first('selling_price'),previous_quote:first('previous_quoted_price'),suggested_selling:first('suggested_selling_price')||first('selling_price')||first('previous_quoted_price')||(onlineFound?Number(online.suggested_selling_price):null),gst_percent:first('gst_percent')??(onlineFound&&online.gst_percent!==null&&online.gst_percent!==undefined?Number(online.gst_percent):18),margin_percent:onlineFound?Number(online.margin_percent):first('margin_percent'),price_date:latest?.price_date||online?.searched_at||null,supplier:latest?.supplier||online?.supplier||null,stock_status:latest?.stock_status||online?.stock_status||null,lead_time:latest?.lead_time||null,source:latest?.source||online?.source_name||null,online_status:online?.status||'NOT SEARCHED',online_skip_reason:online?.skip_reason||null,online_price:onlineFound?{id:online.id,original_price:Number(online.original_price),currency:online.currency||'INR',matched_product:online.matched_product,matched_model:online.matched_model,gst_percent:(online.gst_percent===null||online.gst_percent===undefined)?null:Number(online.gst_percent),supplier:online.supplier||null,stock_status:online.stock_status||null,source_name:online.source_name||null,source_url:online.source_url||null,confidence:Number(online.confidence||0),searched_at:online.searched_at,market_type:online.market_type||policy.market,margin_percent:Number(online.margin_percent),suggested_selling_price:Number(online.suggested_selling_price)}:null,margin_policy:policy};
}

function parseEnquiry(raw='') {
  const text = String(raw).replace(/\r/g,'');
  const lines = text.split('\n').map(s=>s.trim()).filter(Boolean);
  const valueAfter = (labels) => {
    for (const label of labels) {
      const r = new RegExp(`^${label}\\s*[:\\-]\\s*(.+)$`, 'i');
      for (const line of lines) { const m=line.match(r); if (m) return m[1].trim(); }
    }
    return null;
  };
  const email = valueAfter(['Email','E-mail']) || (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null);
  const phone = valueAfter(['Phone','Mobile','Phone Number']) || (text.match(/(?:\+?91[\s-]?)?[6-9]\d{9}/)?.[0] ?? null);
  const location = valueAfter(['Location','Delivery Location']);
  const parts = location ? location.split(',').map(s=>s.trim()) : [];
  const customer = {
    name: valueAfter(['Customer','Customer Name','Name']), company: valueAfter(['Company','Company Name']), email, phone,
    address: valueAfter(['Address']), city: valueAfter(['City']) || parts[0] || null,
    state: valueAfter(['State']) || parts[1] || null, country: valueAfter(['Country']) || parts[2] || (location ? 'India' : null), pincode: valueAfter(['PIN','Pincode','Postal Code'])
  };

  let productNames = [];
  for (const line of lines) {
    const m=line.match(/^Product\s*[:\-]\s*(.+)$/i); if (m) productNames.push(m[1].trim());
  }
  const known = ['UV Meter','Analytical Balance','Vibration Meter','pH Meter','Flow Meter','Coating Thickness Gauge','Calibration Service'];
  if (!productNames.length) for (const k of known) if (normalizeText(text).includes(normalizeText(k))) productNames.push(k);
  productNames = [...new Set(productNames)];
  if (!productNames.length) {
    const m=text.match(/looking for\s+([^\.\n]+)/i) || text.match(/need\s+([^\.\n]+)/i);
    if (m) productNames=[m[1].replace(/quantity.*$/i,'').trim()];
  }

  const qtyRaw = valueAfter(['Quantity','Qty']);
  let quantity = qtyRaw ? Number(qtyRaw.match(/[\d.]+/)?.[0] ?? 1) : Number(text.match(/quantity\s*[:\-]?\s*(\d+(?:\.\d+)?)/i)?.[1] ?? 1);
  if (!Number.isFinite(quantity)) quantity=1;
  const unit = qtyRaw?.replace(/[\d.]/g,'').trim() || (text.match(/\b(piece|pieces|pcs|nos|no|unit|units|set|sets|service)\b/i)?.[1] ?? 'Piece');
  const reference = valueAfter(['Reference','Product Reference']) || (text.match(/\bSF\d{6,}\b/i)?.[0] ?? null);
  const brand = valueAfter(['Brand','Preferred Brand']);
  const model = valueAfter(['Model']);
  const budgetRaw = valueAfter(['Budget','Expected Budget','Target Price','Expected Price']);
  const budget = budgetRaw ? Number(budgetRaw.replace(/[^\d.]/g,'')) || extractBudgetAmount(text) : extractBudgetAmount(text);
  const application = valueAfter(['Application','Usage','Usage/Application']);
  const requiredDelivery = valueAfter(['Required By','Delivery Date','Required Delivery Date']);

  const requirements = productNames.map((product_name, idx) => ({
    product_name, requested_brand: brand, requested_model: model, customer_reference: idx===0 ? reference : null,
    quantity: idx===0 ? quantity : 1, quantity_provided: idx===0 ? Boolean(qtyRaw||/\b(?:qty|quantity)\s*[:\-]?\s*\d+/i.test(text)) : false, unit: idx===0 ? unit : 'Piece', application, required_specification: valueAfter(['Specification','Technical Requirement']),
    required_accuracy: valueAfter(['Accuracy']), required_range: valueAfter(['Range']), requested_features: valueAfter(['Features']),
    requested_certification: valueAfter(['Certification']), requested_accessories: valueAfter(['Accessories']), delivery_location: location,
    required_delivery_date: requiredDelivery, budget, preferred_brand: brand,
    catalogue_required: /catalog(?:ue|og)/i.test(text), quotation_required: /quot(?:e|ation)|best offer|offer/i.test(text),
    technical_datasheet_required: /datasheet|data sheet/i.test(text), installation_required: /installation/i.test(text), calibration_required: /calibration/i.test(text),
    other_notes: text.slice(0,1200)
  }));

  return { customer, requirements, raw_message:text, source_type: /indiamart/i.test(text) ? 'INDIAMART' : 'MANUAL' };
}

function leadCode() {
  const row = db.prepare(`SELECT lead_code FROM leads WHERE lead_code LIKE 'NS-%' ORDER BY id DESC LIMIT 1`).get();
  const n = row ? Number(row.lead_code.replace(/\D/g,'')) + 1 : 1;
  return `NS-${String(n).padStart(6,'0')}`;
}
function quoteNo() {
  const year = new Date().getFullYear();
  const c = db.prepare('SELECT COUNT(*) AS c FROM quotations WHERE quotation_no LIKE ?').get(`QTN-${year}-%`).c + 1;
  return `QTN-${year}-${String(c).padStart(4,'0')}`;
}
function addActivity(leadId,type,title,detail='') {
  db.prepare('INSERT INTO activities(lead_id,activity_type,title,detail,created_at,user_id) VALUES (?,?,?,?,?,1)').run(leadId,type,title,detail,nowIso());
}
function addAudit(entityType, entityId, action, before, after) {
  db.prepare('INSERT INTO audit_logs(user_id,entity_type,entity_id,action,before_json,after_json,created_at) VALUES (1,?,?,?,?,?,?)').run(entityType,entityId,action,json(before),json(after),nowIso());
}

function scoreEvidence(leadId){
  const lead=db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);if(!lead)return {lead:null,evidence:{}};
  const customer=db.prepare('SELECT * FROM customers WHERE id=?').get(lead.customer_id)||{};
  const req=db.prepare('SELECT * FROM product_requirements WHERE lead_id=? ORDER BY id LIMIT 1').get(leadId)||{};
  const status=safeJson(req.status_json,{})||{};
  const raw=String(lead.raw_message||req.other_notes||'');
  const buyingSignals=safeJson(lead.buying_signals_json,[])||[];
  const hasSignal=(x)=>buyingSignals.map(v=>String(v).toUpperCase()).includes(String(x).toUpperCase());
  const previousLeads=Number(db.prepare('SELECT COUNT(*) AS c FROM leads WHERE customer_id=?').get(lead.customer_id)?.c||0);
  const previousOrders=Number(db.prepare("SELECT COUNT(*) AS c FROM leads WHERE customer_id=? AND pipeline_stage='WON'").get(lead.customer_id)?.c||0);
  const previousQuotes=Number(db.prepare('SELECT COUNT(*) AS c FROM quotations WHERE customer_id=?').get(lead.customer_id)?.c||0);
  const match=Number(db.prepare('SELECT MAX(match_confidence) AS m FROM lead_products WHERE lead_id=?').get(leadId)?.m||0);
  const price=priceIntelligenceForLead(leadId);
  const evidence={
    exact_product:Boolean(req.product_name&&normalizeProductText(req.product_name)!=='needs confirmation'),
    exact_model:Boolean(req.requested_model),brand:Boolean(req.requested_brand||req.preferred_brand),
    quantity:Boolean(Number(req.quantity)>0&&(status.quantity==='CONFIRMED'||/\b(?:qty|quantity)\s*[:\-]?\s*\d+/i.test(raw))),
    application:Boolean(req.application),technical_requirement:Boolean(req.required_specification||req.required_accuracy||req.required_range||req.requested_features),
    quotation_request:Boolean(req.quotation_required||hasSignal('QUOTATION REQUESTED')||String(lead.purchase_intent||'').toUpperCase()==='QUOTATION REQUIRED'||/quotation|quote|detailed offer|best offer/i.test(raw)),best_price:hasSignal('BEST PRICE REQUESTED')||/best\s+(?:price|offer)|lowest\s+price/i.test(raw),
    catalogue:Boolean(req.catalogue_required||hasSignal('CATALOGUE REQUESTED')||/catalog(?:ue|og)/i.test(raw)),delivery_date:Boolean(req.required_delivery_date||hasSignal('DELIVERY ASKED')),
    urgent:['IMMEDIATE','THIS WEEK'].includes(lead.urgency)||/urgent|immediate|today|asap|very soon/i.test(raw),
    budget_confirmed:lead.budget_status==='CONFIRMED'||Number(req.budget)>0||Boolean(lead.budget_band&&lead.budget_band!=='UNKNOWN'),company:Boolean(customer.company),phone:Boolean(normalizePhone(customer.phone)),email:Boolean(customer.email),
    repeat_customer:previousLeads>1,previous_order:previousOrders>0,previous_quote:previousQuotes>0,decision_maker:lead.decision_maker==='YES'||Boolean(lead.decision_role&&lead.decision_role!=='UNKNOWN'&&['HIGH','MEDIUM'].includes(String(lead.decision_influence||'').toUpperCase())),
    internal_product_match:match>=60,price_fit:price.status==='AVAILABLE'&&['HIGH','MEDIUM'].includes(price.reliability),sales_verification:lead.verified_score!==null&&lead.verified_score!==''&&Number.isFinite(Number(lead.verified_score)),
    engagement:Boolean(lead.last_contact_at)||Number(lead.contact_attempts||0)>0,ready_to_buy:lead.purchase_intent==='READY TO BUY'||lead.pipeline_stage==='ORDER EXPECTED'
  };
  return {lead,customer,req,evidence,match,price,previousLeads,previousOrders,previousQuotes};
}
function calculateLeadScore(leadId,{markVerified=false,verifiedScore=null}={}) {
  const ctx=scoreEvidence(leadId);if(!ctx.lead)throw new Error('Lead not found');
  const factors=db.prepare('SELECT * FROM score_factors WHERE active=1 ORDER BY id').all();
  let rawPoints=0;const detail={};
  for(const f of factors){const yes=Boolean(ctx.evidence[f.code]);const points=yes?Number(f.weight||0):0;rawPoints+=points;detail[f.code]={weight:Number(f.weight||0),matched:yes,points};}
  let aiScore=Math.max(0,Math.min(100,Math.round(rawPoints)));
  if(ctx.lead.requirement_status==='CONFIRMED'||ctx.lead.requirement_status==='CLEAR')aiScore=Math.min(100,aiScore+4);
  if(ctx.lead.urgency==='THIS MONTH'||ctx.lead.urgency==='1–2 WEEKS')aiScore=Math.min(100,aiScore+3);
  const intent=String(ctx.lead.purchase_intent||'').toUpperCase();
  if(['SERIOUS','GENUINE REQUIREMENT','QUOTATION REQUIRED','NEEDS QUOTATION'].includes(intent))aiScore=Math.min(100,aiScore+6);
  if(['INTERESTED','COMPARING','COMPARING SUPPLIERS'].includes(intent))aiScore=Math.min(100,aiScore+3);
  if(intent==='NEGOTIATING')aiScore=Math.min(100,aiScore+7);
  if(intent==='READY TO BUY')aiScore=Math.min(100,aiScore+10);
  if(intent==='FUTURE REQUIREMENT')aiScore=Math.max(0,aiScore-6);
  const reqStatus=String(ctx.lead.requirement_status||'').toUpperCase();
  if(reqStatus==='GENERAL ENQUIRY')aiScore=Math.max(0,aiScore-7);
  if(reqStatus==='WRONG REQUIREMENT')aiScore=Math.max(0,aiScore-25);
  if(String(ctx.lead.decision_influence||'').toUpperCase()==='HIGH')aiScore=Math.min(100,aiScore+4);
  else if(String(ctx.lead.decision_influence||'').toUpperCase()==='MEDIUM')aiScore=Math.min(100,aiScore+2);
  if(String(ctx.lead.commercial_potential||'').toUpperCase()==='HIGH')aiScore=Math.min(100,aiScore+4);
  else if(String(ctx.lead.commercial_potential||'').toUpperCase()==='MEDIUM')aiScore=Math.min(100,aiScore+2);
  let human=null;
  if(verifiedScore!==null&&verifiedScore!==''&&Number.isFinite(Number(verifiedScore))) human=Math.max(0,Math.min(100,Math.round(Number(verifiedScore))));
  else if(!markVerified&&ctx.lead.verified_at&&ctx.lead.verified_score!==null&&ctx.lead.verified_score!==''&&Number.isFinite(Number(ctx.lead.verified_score))) human=Math.max(0,Math.min(100,Math.round(Number(ctx.lead.verified_score))));
  if(markVerified&&human===null)human=aiScore;
  // Purchase probability blends objective AI evidence with salesperson verification, so later customer actions can still move the probability.
  const finalScore=human!==null?Math.max(0,Math.min(100,Math.round((aiScore*0.55)+(human*0.45)))):aiScore;
  let temp=temperatureFor(finalScore);
  const override=String(ctx.lead.manual_override||'').toUpperCase().trim();
  if(['VERY HOT','HOT','WARM','DEVELOPING','LOW','COLD'].includes(override))temp=override;
  const priority=priorityFor(finalScore,ctx.lead.urgency);
  const next=nextBestAction({...ctx.lead,purchase_probability:finalScore,temperature:temp},[],[],[]);
  db.prepare(`UPDATE leads SET ai_score=?,verified_score=?,verified_temperature=?,purchase_probability=?,temperature=?,priority=?,qualification_status='COMPLETE',next_action=?,analysis_version=?,updated_at=? WHERE id=?`).run(aiScore,human!==null?human:null,human!==null?temperatureFor(human):null,finalScore,temp,priority,next.title,ANALYSIS_VERSION,nowIso(),leadId);
  db.prepare(`INSERT INTO lead_scores(lead_id,score,factor_json,calculated_at) VALUES (?,?,?,?) ON CONFLICT(lead_id) DO UPDATE SET score=excluded.score,factor_json=excluded.factor_json,calculated_at=excluded.calculated_at`).run(leadId,aiScore,json({version:SCORE_CONFIG_VERSION,evidence:detail}),nowIso());
  bumpDataRevision();
  return {score:finalScore,ai_score:aiScore,verified_score:human!==null?human:null,temperature:temp,priority,factors:detail};
}

function nextBestAction(lead, products=[], quotations=[], objections=[]) {
  if (lead.live_classification==='HISTORICAL' && !lead.last_contact_at && lead.status==='OPEN') return { icon:'🗂️', title:'REVIEW HISTORICAL LEAD', reason:'This record predates the live integration window. Review it without mixing it into the live queue.', question:'Confirm whether this opportunity is still active.' };
  if (!lead.last_contact_at) return { icon:'📞', title:'CALL CUSTOMER NOW', reason:'The enquiry has not yet been contacted. Fast response improves the chance of conversion.', question:'Confirm the application, budget and required delivery date.' };
  if (lead.requirement_status !== 'CONFIRMED') return { icon:'🎯', title:'CLARIFY CUSTOMER NEED', reason:'The product is identified, but the actual application/specification is incomplete.', question:'Confirm application, range/capacity, accuracy, quantity and delivery.' };
  if (lead.budget_status !== 'CONFIRMED') return { icon:'💰', title:'CONFIRM BUDGET', reason:'Requirement is clearer, but the budget is not confirmed.', question:'May I know your expected budget for this purchase?' };
  const missingPrice = products.length ? products.some(p => !p.price?.suggested_selling_price && !p.price?.selling_price) : lead.price_analysis_status!=='COMPLETE';
  if (missingPrice) return { icon:'₹', title:'VERIFY PRICE', reason:'A reliable selling price is not yet confirmed.', question:'Verify the latest internal/supplier price before quotation.' };
  if (!quotations.length && !lead.quotation_no) return { icon:'📄', title:'PREPARE QUOTATION', reason:'Requirement is ready, but no professional quotation has been created.', question:'Prepare the quotation with price, GST, delivery, payment, warranty and validity.' };
  if (objections.some(o=>!['RESOLVED','LOST'].includes(o.resolution_status))) return { icon:'💬', title:'RESOLVE OPEN OBJECTION', reason:'There is an unresolved customer objection.', question:'Address the objection and record the customer response.' };
  if (lead.purchase_intent === 'READY TO BUY' || lead.purchase_probability>=85 || lead.pipeline_stage==='ORDER EXPECTED') return { icon:'✅', title:'ASK FOR THE ORDER', reason:'The opportunity has strong buying signals and is commercially ready.', question:'Shall we proceed with the order / purchase order?' };
  return { icon:'⏰', title:'FOLLOW UP', reason:'The opportunity is active and needs a planned next contact.', question:'Confirm feedback, decision status and next follow-up date.' };
}

function safeUploadFilename(name='quotation.pdf'){
  const raw=String(name||'quotation.pdf').replace(/[\\/:*?"<>|\x00-\x1F]/g,'_').trim();
  const base=(raw||'quotation.pdf').slice(-160);
  return base.replace(/^\.+/,'')||'quotation.pdf';
}
function quotationUploadPublicRow(row){
  if(!row)return null;
  return {...row,file_url:`/api/quotation-uploads/${Number(row.id)}/file`};
}
function quotationUploadsForLead(leadId){
  return db.prepare('SELECT * FROM quotation_uploads WHERE lead_id=? ORDER BY created_at DESC,id DESC').all(leadId).map(quotationUploadPublicRow);
}
function storeQuotationUpload(leadId,b,viewer){
  const lead=db.prepare('SELECT id,assigned_to FROM leads WHERE id=?').get(leadId);if(!lead)throw new Error('Lead not found');
  if(!viewerCanAccessLead(viewer,leadId))throw new Error('This enquiry belongs to another staff member.');
  const fileName=safeUploadFilename(b.file_name||'quotation.pdf'),mime=String(b.mime_type||'application/octet-stream').toLowerCase();
  const allowedExt=new Set(['.pdf','.jpg','.jpeg','.png','.webp','.doc','.docx','.xls','.xlsx']);
  const ext=path.extname(fileName).toLowerCase();if(!allowedExt.has(ext))throw new Error('Upload quotation as PDF, image, Word or Excel file.');
  const raw=String(b.data_base64||'').replace(/^data:[^;]+;base64,/,'');if(!raw)throw new Error('Choose a quotation file to upload.');
  let buffer;try{buffer=Buffer.from(raw,'base64')}catch{throw new Error('Quotation file could not be read.');}
  if(!buffer.length)throw new Error('Quotation file is empty.');if(buffer.length>8*1024*1024)throw new Error('Quotation file is too large. Maximum size is 8 MB.');
  const folder=path.join(DATA_DIR,'uploads','quotations',String(leadId));fs.mkdirSync(folder,{recursive:true});
  const storedName=`${Date.now()}_${randomBytes(4).toString('hex')}_${fileName}`;const fullPath=path.join(folder,storedName);fs.writeFileSync(fullPath,buffer);
  const status=String(b.status||'UPLOADED').toUpperCase();const allowedStatus=new Set(['UPLOADED','READY','SENT','NEGOTIATION','ACCEPTED','REJECTED']);
  const finalStatus=allowedStatus.has(status)?status:'UPLOADED';const total=Number(b.total);const totalValue=Number.isFinite(total)&&total>0?total:null;
  const quoteNo=String(b.quotation_no||path.basename(fileName,ext)||'').trim().slice(0,100)||null;const notes=String(b.notes||'').trim().slice(0,2000)||null;
  const id=db.prepare('INSERT INTO quotation_uploads(lead_id,file_name,file_path,mime_type,size_bytes,quotation_no,status,total,notes,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(leadId,fileName,fullPath,mime,buffer.length,quoteNo,finalStatus,totalValue,notes,Number(viewer?.id)||null,nowIso()).lastInsertRowid;
  db.prepare('UPDATE product_requirements SET quotation_required=1 WHERE lead_id=?').run(leadId);
  addActivity(leadId,'QUOTATION_UPLOAD','Existing quotation uploaded',`${quoteNo||fileName} • ${finalStatus}`);
  try{completePlaybookStage(leadId,9,{status:'COMPLETED',notes:`Existing quotation uploaded: ${quoteNo||fileName}`,data:{quotation_upload_id:Number(id)},activity:false});}catch{}
  bumpDataRevision();return quotationUploadPublicRow(db.prepare('SELECT * FROM quotation_uploads WHERE id=?').get(id));
}
function hydrateLead(id) {
  const lead = db.prepare(`SELECT l.*, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id=l.assigned_to WHERE l.id=?`).get(id);
  if (!lead) return null;
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(lead.customer_id);
  const reqs = db.prepare('SELECT * FROM product_requirements WHERE lead_id=? ORDER BY id').all(id).map(r=>({ ...r, status:safeJson(r.status_json,{}) }));
  const lp = db.prepare('SELECT * FROM lead_products WHERE lead_id=? ORDER BY match_confidence DESC,id').all(id);
  const products = lp.map(x=>{
    const req = reqs.find(r=>r.id===x.requirement_id);
    const p = x.product_id ? db.prepare('SELECT * FROM products WHERE id=?').get(x.product_id) : null;
    const specs = p ? db.prepare('SELECT * FROM product_specifications WHERE product_id=? ORDER BY id').all(p.id) : [];
    const price = p ? db.prepare("SELECT * FROM product_prices WHERE product_id=? ORDER BY COALESCE(price_date,'') DESC,id DESC LIMIT 1").get(p.id) : null;
    return { ...x, requirement:req, product:p ? {...p,key_features:safeJson(p.key_features_json,[]),applications:safeJson(p.applications_json,[])} : null, specs, price };
  });
  const activities = db.prepare('SELECT * FROM activities WHERE lead_id=? ORDER BY created_at DESC, id DESC LIMIT 100').all(id);
  const communications = db.prepare('SELECT * FROM communications WHERE lead_id=? ORDER BY communicated_at DESC,id DESC LIMIT 100').all(id);
  const followups = db.prepare('SELECT * FROM followups WHERE lead_id=? ORDER BY due_at DESC,id DESC').all(id);
  const objections = db.prepare('SELECT * FROM objections WHERE lead_id=? ORDER BY created_at DESC,id DESC').all(id);
  const quotations = db.prepare('SELECT * FROM quotations WHERE lead_id=? ORDER BY created_at DESC,id DESC').all(id).map(q=>({...q,items:db.prepare('SELECT * FROM quotation_items WHERE quotation_id=? ORDER BY id').all(q.id)}));
  const quotation_uploads = quotationUploadsForLead(id);
  const verifications=db.prepare('SELECT v.*,u.name AS user_name FROM lead_verifications v LEFT JOIN users u ON u.id=v.user_id WHERE v.lead_id=? ORDER BY v.verified_at DESC,id DESC LIMIT 50').all(id);
  const nurture=db.prepare('SELECT * FROM customer_nurture WHERE customer_id=?').get(lead.customer_id)||null;
  const users=db.prepare('SELECT id,name,role FROM users WHERE active=1 ORDER BY name').all();
  syncPlaybookEvidence(id);
  const playbookProgress = playbookSummaryForLead(id);
  const score = db.prepare('SELECT * FROM lead_scores WHERE lead_id=?').get(id);
  const product_intelligence=productIntelligenceForLead(id);
  const price_intelligence=priceIntelligenceForLead(id);
  const next = nextBestAction(lead,products,quotations,objections);
  const limited_offer=latestLimitedOfferForLead(id);
  return { lead:{...lead,next_action:next.title}, customer, requirements:reqs, products, product_intelligence, price_intelligence, limited_offer, customer_messaging:customerMessagingStatus(), activities, communications, followups, objections, quotations, quotation_uploads, verifications, nurture, users, playbook:playbookProgress.rows, playbook_progress:{completed:playbookProgress.completed,skipped:playbookProgress.skipped||0,terminal:playbookProgress.terminal??playbookProgress.completed,total:playbookProgress.total,percent:playbookProgress.percent,current_stage_no:playbookProgress.current_stage_no,current_stage_name:playbookProgress.current_stage_name}, score: score ? {...score,factors:safeJson(score.factor_json,{})}:null, next_best_action:next, discovery_questions:product_intelligence.flatMap(x=>x.discovery_questions||[]) };
}

const LEAD_LIST_FROM = `FROM leads l
  JOIN customers c ON c.id=l.customer_id
  LEFT JOIN users u ON u.id=l.assigned_to
  LEFT JOIN product_requirements pr ON pr.id=(SELECT MIN(pr0.id) FROM product_requirements pr0 WHERE pr0.lead_id=l.id)
  LEFT JOIN lead_products lp_best ON lp_best.id=(SELECT lp0.id FROM lead_products lp0 WHERE lp0.lead_id=l.id ORDER BY lp0.match_confidence DESC,lp0.id LIMIT 1)
  LEFT JOIN products p ON p.id=lp_best.product_id`;
const LEAD_LIST_SELECT = `SELECT l.*, c.name AS customer_name,c.company,c.city,c.state,c.country,c.phone,c.email,u.name AS owner_name,
  pr.product_name AS product_name,pr.quantity AS quantity ${LEAD_LIST_FROM}`;
const LEAD_COMPACT_SELECT = `SELECT l.id,l.lead_code,l.customer_id,l.source_type,l.received_at,l.assigned_to,l.temperature,l.purchase_probability,l.ai_score,l.verified_score,l.priority,
  l.pipeline_stage,l.expected_value,l.last_contact_at,l.first_response_at,l.next_followup_at,l.response_status,l.contact_attempts,l.status,l.live_classification,l.next_action,
  l.product_analysis_status,l.price_analysis_status,l.qualification_status,l.possible_duplicate,l.market_type_override,l.form_status,l.form_completion_percent,l.form_last_saved_at,l.form_completed_at,l.work_status,l.hold_reason,l.work_status_changed_at,l.work_completed_at,
  c.name AS customer_name,c.company,c.city,c.state,c.country,c.phone,c.email,u.name AS owner_name,pr.product_name AS product_name,pr.requested_model AS requested_model,pr.quantity AS quantity,
  COALESCE((SELECT MAX(lp0.match_confidence) FROM lead_products lp0 WHERE lp0.lead_id=l.id),0) AS product_match_confidence,
  CASE WHEN EXISTS(SELECT 1 FROM lead_products lp1 JOIN product_prices pp1 ON pp1.product_id=lp1.product_id WHERE lp1.lead_id=l.id AND COALESCE(pp1.suggested_selling_price,pp1.selling_price,pp1.previous_quoted_price)>0) THEN 'MATCHED'
       WHEN EXISTS(SELECT 1 FROM quotations q1 JOIN quotation_items qi1 ON qi1.quotation_id=q1.id WHERE q1.lead_id=l.id AND qi1.unit_price>0) THEN 'MATCHED' ELSE 'NOT AVAILABLE' END AS price_match_status
  ${LEAD_LIST_FROM}`;

function leadRows(select,where='1=1',orderBy='l.received_at DESC',limit='',params=[]) {
  return db.prepare(`${select} WHERE ${where} ORDER BY ${orderBy} ${limit}`).all(...params);
}
function leadSummaryRows(where='1=1',orderBy='l.received_at DESC',limit='',params=[]) { return leadRows(LEAD_LIST_SELECT,where,orderBy,limit,params); }
function leadCompactRows(where='1=1',orderBy='l.received_at DESC',limit='',params=[]) { return leadRows(LEAD_COMPACT_SELECT,where,orderBy,limit,params); }
function leadListFilters(url){
  const q=(url.searchParams.get('q')||'').trim();
  const temp=url.searchParams.get('temperature');
  const stage=url.searchParams.get('stage');
  const temperatureGroup=url.searchParams.get('temperature_group');
  const classification=url.searchParams.get('classification');
  const contact=url.searchParams.get('contact');
  const source=url.searchParams.get('source');
  const owner=url.searchParams.get('owner');
  const formStatus=String(url.searchParams.get('form_status')||'').toUpperCase();
  const completionStatus=String(url.searchParams.get('completion_status')||'').toUpperCase();
  const where=[]; const params=[];
  if(temperatureGroup==='HOT'||temp==='HOT')where.push(`l.temperature IN ('HOT','VERY HOT')`);
  else if(temp){where.push('l.temperature=?');params.push(temp);}
  if(stage){where.push('l.pipeline_stage=?');params.push(stage);}
  if(classification){where.push('l.live_classification=?');params.push(classification);}
  if(contact==='UNCONTACTED')where.push('l.last_contact_at IS NULL');
  if(contact==='CONTACTED')where.push('l.last_contact_at IS NOT NULL');
  if(source){where.push('l.source_type=?');params.push(source);}
  if(owner){where.push('l.assigned_to=?');params.push(Number(owner));}
  if(completionStatus==='COMPLETED')where.push("(COALESCE(l.form_status,'WAITING')='COMPLETED' OR COALESCE(l.work_status,'ACTIVE')='COMPLETED')");
  else if(completionStatus==='INCOMPLETE')where.push("(COALESCE(l.form_status,'WAITING')<>'COMPLETED' AND COALESCE(l.work_status,'ACTIVE')<>'COMPLETED')");
  else if(formStatus==='COMPLETED')where.push("COALESCE(l.form_status,'WAITING')='COMPLETED'");
  else if(formStatus==='INCOMPLETE')where.push("COALESCE(l.form_status,'WAITING')<>'COMPLETED'");
  if(q){
    const like=`%${q}%`;
    where.push(`(l.lead_code LIKE ? COLLATE NOCASE OR c.name LIKE ? COLLATE NOCASE OR COALESCE(c.company,'') LIKE ? COLLATE NOCASE OR COALESCE(c.phone,'') LIKE ? COLLATE NOCASE OR COALESCE(c.email,'') LIKE ? COLLATE NOCASE OR COALESCE(pr.product_name,'') LIKE ? COLLATE NOCASE OR COALESCE(pr.requested_model,'') LIKE ? COLLATE NOCASE OR COALESCE(c.city,'') LIKE ? COLLATE NOCASE OR COALESCE(c.state,'') LIKE ? COLLATE NOCASE)`);
    params.push(like,like,like,like,like,like,like,like,like);
  }
  return {where:where.length?where.join(' AND '):'1=1',params};
}
function listLeads(url) { const f=leadListFilters(url); return leadSummaryRows(f.where,'l.received_at DESC','',f.params); }
function listLeadSummaries(url) { const f=leadListFilters(url); return leadCompactRows(f.where,'l.received_at DESC','',f.params); }
function listLeadPage(url){
  const f=leadListFilters(url);const page=Math.max(1,Number(url.searchParams.get('page')||1));const limit=Math.max(10,Math.min(100,Number(url.searchParams.get('limit')||50)));const offset=(page-1)*limit;
  const total=Number(db.prepare(`SELECT COUNT(*) AS c ${LEAD_LIST_FROM} WHERE ${f.where}`).get(...f.params)?.c||0);
  const rows=leadCompactRows(f.where,'l.received_at DESC',`LIMIT ${limit} OFFSET ${offset}`,f.params);
  return {rows,total,page,limit,pages:Math.max(1,Math.ceil(total/limit)),has_more:offset+rows.length<total};
}

function playbookPerformance() {
  const rows=db.prepare(`SELECT stage_no,MAX(stage_name) AS stage_name,COUNT(*) AS total,
    SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN status='ACTIVE' THEN 1 ELSE 0 END) AS active
    FROM sales_playbook_progress GROUP BY stage_no ORDER BY stage_no`).all();
  const byNo=new Map(rows.map(r=>[Number(r.stage_no),r]));
  return Object.fromEntries(PLAYBOOK_STAGES.map(stage=>{const r=byNo.get(stage.no)||{};return [stage.name,{stage_no:stage.no,total:Number(r.total||0),completed:Number(r.completed||0),active:Number(r.active||0)}]}));
}

function dashboardData() {
  return cached('dashboard',4000,()=>{
    const today=new Date();const start=new Date(today.getFullYear(),today.getMonth(),today.getDate()).toISOString();const end=new Date(today.getFullYear(),today.getMonth(),today.getDate()+1).toISOString();
    const stats=db.prepare(`SELECT
      SUM(CASE WHEN live_classification='LIVE' AND received_at>=? AND received_at<? THEN 1 ELSE 0 END) AS new_today,
      SUM(CASE WHEN live_classification='LIVE' AND received_at>=? AND received_at<? AND temperature IN ('HOT','VERY HOT') THEN 1 ELSE 0 END) AS hot_today,
      SUM(CASE WHEN live_classification='LIVE' AND pipeline_stage NOT IN ('WON','LOST') AND last_contact_at IS NULL THEN 1 ELSE 0 END) AS live_uncontacted,
      SUM(CASE WHEN live_classification='HISTORICAL' AND pipeline_stage NOT IN ('WON','LOST') AND last_contact_at IS NULL THEN 1 ELSE 0 END) AS historical_unprocessed,
      SUM(CASE WHEN live_classification='LIVE' AND pipeline_stage NOT IN ('WON','LOST') AND temperature IN ('HOT','VERY HOT') AND last_contact_at IS NULL THEN 1 ELSE 0 END) AS hot_not_contacted,
      SUM(CASE WHEN pipeline_stage NOT IN ('WON','LOST') AND COALESCE(budget_status,'')<>'CONFIRMED' THEN 1 ELSE 0 END) AS missing_budget,
      SUM(CASE WHEN pipeline_stage NOT IN ('WON','LOST') AND (purchase_intent='READY TO BUY' OR pipeline_stage='ORDER EXPECTED') THEN 1 ELSE 0 END) AS ready_to_buy,
      SUM(CASE WHEN pipeline_stage='ORDER EXPECTED' THEN 1 ELSE 0 END) AS order_expected,
      COALESCE(SUM(CASE WHEN pipeline_stage NOT IN ('WON','LOST') AND purchase_probability>=55 THEN COALESCE(expected_value,0) ELSE 0 END),0) AS expected_revenue
      FROM leads`).get(start,end,start,end);
    const dueNow=new Date().toISOString(),due24=new Date(Date.now()+86400000).toISOString();
    const followupsDue=Number(db.prepare(`SELECT COUNT(*) AS c FROM followups WHERE status='PENDING' AND due_at<=?`).get(due24).c||0);
    const overdue=Number(db.prepare(`SELECT COUNT(*) AS c FROM followups WHERE status='PENDING' AND due_at<?`).get(dueNow).c||0);
    const quotesWaiting=Number(db.prepare(`SELECT COUNT(*) AS c FROM quotations WHERE status IN ('PRICE VERIFICATION','READY','SENT','VIEWED','CUSTOMER REPLIED','NEGOTIATION')`).get()?.c||0);
    const counts={new_today:Number(stats.new_today||0),hot_today:Number(stats.hot_today||0),hot_leads:Number(stats.hot_today||0),followups_due:followupsDue,quotes_waiting:quotesWaiting,quotation_pending:quotesWaiting,order_expected:Number(stats.order_expected||0),expected_revenue:Number(stats.expected_revenue||0),live_uncontacted:Number(stats.live_uncontacted||0),historical_unprocessed:Number(stats.historical_unprocessed||0)};
    const attention=[
      {icon:'🔥',label:'HOT leads not contacted',count:Number(stats.hot_not_contacted||0),route:'#/hot?classification=LIVE&contact=UNCONTACTED'},
      {icon:'⏰',label:'Overdue follow-ups',count:overdue,route:'#/followups?status=OVERDUE'},
      {icon:'💰',label:'Quotations awaiting customer/action',count:quotesWaiting,route:'#/quotations'},
      {icon:'⚠️',label:'Leads missing budget confirmation',count:Number(stats.missing_budget||0),route:'#/leads?budget=MISSING'},
      {icon:'📦',label:'Customers ready to order',count:Number(stats.ready_to_buy||0),route:'#/leads?ready=1'},
      {icon:'🗂️',label:'Historical leads unprocessed',count:Number(stats.historical_unprocessed||0),route:'#/leads?classification=HISTORICAL&contact=UNCONTACTED'}
    ];
    const top_opportunities=leadCompactRows(`l.pipeline_stage NOT IN ('WON','LOST') AND l.live_classification='LIVE'`,'l.purchase_probability DESC, l.received_at DESC','LIMIT 8');
    const recent_live_leads=leadCompactRows(`l.live_classification='LIVE'`,'l.received_at DESC','LIMIT 8');
    return {counts,attention,top_opportunities,recent_live_leads,recent_leads:recent_live_leads,playbook_overview:playbookPerformance(),generated_at:nowIso()};
  });
}


function isLoopbackRequest(req){
  const ip=String(req?.socket?.remoteAddress||'').toLowerCase();
  return ip==='127.0.0.1'||ip==='::1'||ip==='::ffff:127.0.0.1';
}
function deviceTokenHash(token=''){return stableHash(`nunes-device:${String(token||'').trim()}`);}
function ownerSetupCodeHash(code=''){return stableHash(`nunes-owner-setup:${String(code||'').trim().toUpperCase()}`);}
function issueDeviceSession(userId,deviceType='STAFF',deviceName=''){
  const user=db.prepare('SELECT id,name,email,role,designation,photo_data,display_order,phone,active FROM users WHERE id=? AND active=1').get(Number(userId));
  if(!user)throw new Error('CRM user profile is not active.');
  const raw=randomBytes(32).toString('hex'),hash=deviceTokenHash(raw),stamp=nowIso();
  db.prepare('INSERT INTO device_sessions(token_hash,user_id,device_type,device_name,active,created_at,last_seen_at,client_version,last_server_version,last_update_check_at) VALUES (?,?,?,?,1,?,?,?,?,?)').run(hash,user.id,String(deviceType||'STAFF').toUpperCase(),String(deviceName||'').slice(0,160)||null,stamp,stamp,CLIENT_LAUNCHER_VERSION,APP_VERSION,stamp);
  return {device_token:raw,user};
}
function sessionViewerFromToken(token=''){
  const raw=String(token||'').trim();if(!raw)return null;
  const hash=deviceTokenHash(raw);
  const row=db.prepare(`SELECT u.id,u.name,u.email,u.role,u.designation,u.photo_data,u.display_order,u.phone,u.active,ds.id AS device_session_id,ds.device_type,ds.device_name,ds.client_version,ds.last_server_version,ds.last_update_check_at,ds.last_update_applied_at
    FROM device_sessions ds JOIN users u ON u.id=ds.user_id WHERE ds.token_hash=? AND ds.active=1 AND u.active=1`).get(hash);
  if(row){try{db.prepare('UPDATE device_sessions SET last_seen_at=? WHERE token_hash=?').run(nowIso(),hash);}catch{}}
  return row||null;
}
function viewerFromRequest(req){
  let token=String(req?.headers?.['x-nunes-device-token']||'').trim();
  if(!token){try{token=String(new URL(String(req?.url||''),'http://localhost').searchParams.get('device_token')||'').trim();}catch{}}
  const session=sessionViewerFromToken(token);if(session)return session;
  // Only the main server itself keeps the old numeric-user fallback.
  if(isLoopbackRequest(req)){
    const id=Math.max(1,Number(req?.headers?.['x-nunes-user-id']||1)||1);
    return db.prepare('SELECT id,name,email,role,designation,photo_data,display_order,phone,active FROM users WHERE id=? AND active=1').get(id)
      || db.prepare("SELECT id,name,email,role,designation,photo_data,display_order,phone,active FROM users WHERE role='ADMIN' AND active=1 ORDER BY id LIMIT 1").get();
  }
  return {id:0,name:'Unconfigured Device',email:null,role:'UNAUTHENTICATED',designation:'Run PC setup',active:0};
}
function viewerIsOwner(viewer){return String(viewer?.role||'').toUpperCase()==='ADMIN';}
function viewerCanAccessLead(viewer,leadId){
  if(viewerIsOwner(viewer))return true;if(!viewer||Number(viewer.id)<=0)return false;
  const row=db.prepare('SELECT assigned_to FROM leads WHERE id=?').get(Number(leadId));return Number(row?.assigned_to)===Number(viewer.id);
}

function ownerUserId(){return Number(db.prepare("SELECT id FROM users WHERE role='ADMIN' AND active=1 ORDER BY id LIMIT 1").get()?.id||1);}
function createOwnerWorkNotification(leadId,type,message){
  const ownerId=ownerUserId(),stamp=nowIso();
  db.prepare('INSERT INTO notifications(user_id,lead_id,type,message,is_read,created_at) VALUES (?,?,?,?,0,?)').run(ownerId,leadId,type,message,stamp);
}
function leadWorkContext(leadId){
  return db.prepare(`SELECT l.id,l.lead_code,l.assigned_to,l.work_status,l.hold_reason,l.work_status_changed_at,l.work_completed_at,u.name AS staff_name,c.name AS customer_name,pr.product_name
    FROM leads l LEFT JOIN users u ON u.id=l.assigned_to JOIN customers c ON c.id=l.customer_id LEFT JOIN product_requirements pr ON pr.id=(SELECT MIN(x.id) FROM product_requirements x WHERE x.lead_id=l.id) WHERE l.id=?`).get(leadId);
}
function setLeadWorkStatus(leadId,status,reason='',viewer=null,{silentDuplicate=true}={}){
  const wanted=String(status||'').trim().toUpperCase().replaceAll(' ','_');
  const normalized=({ACTIVE:'ACTIVE',IN_PROGRESS:'ACTIVE',RESUME:'ACTIVE',HOLD:'HOLD',ON_HOLD:'HOLD',COMPLETED:'COMPLETED',COMPLETE:'COMPLETED'})[wanted];
  if(!normalized)throw new Error('Work status must be Active, On Hold or Completed.');
  const before=leadWorkContext(leadId);if(!before)throw new Error('Lead not found');
  const why=String(reason||'').trim();if(normalized==='HOLD'&&!why)throw new Error('Enter the reason before putting this enquiry on hold.');
  if(silentDuplicate&&String(before.work_status||'ACTIVE')===normalized&&(normalized!=='HOLD'||String(before.hold_reason||'').trim()===why))return before;
  const stamp=nowIso(),by=Number(viewer?.id||before.assigned_to||ownerUserId());
  db.prepare(`UPDATE leads SET work_status=?,hold_reason=?,work_status_changed_at=?,work_status_changed_by=?,work_completed_at=CASE WHEN ?='COMPLETED' THEN COALESCE(work_completed_at,?) WHEN ?='ACTIVE' THEN NULL ELSE work_completed_at END,updated_at=? WHERE id=?`)
    .run(normalized,normalized==='HOLD'?why:null,stamp,by,normalized,stamp,normalized,stamp,leadId);
  const after=leadWorkContext(leadId),staff=after?.staff_name||viewer?.name||'Staff',lead=after?.lead_code||`Lead ${leadId}`,product=after?.product_name||'enquiry';
  if(normalized==='HOLD'){
    addActivity(leadId,'WORK_HOLD','Enquiry put on hold',why);
    createOwnerWorkNotification(leadId,'STAFF_HOLD',`${staff} put ${lead} (${product}) on hold — ${why}`);
  }else if(normalized==='COMPLETED'){
    addActivity(leadId,'WORK_COMPLETED','Staff marked enquiry completed',`${staff} completed the assigned work.`);
    createOwnerWorkNotification(leadId,'STAFF_COMPLETED',`${staff} completed ${lead} (${product}).`);
  }else{
    addActivity(leadId,'WORK_RESUMED','Enquiry resumed',`${staff} resumed this enquiry.`);
    createOwnerWorkNotification(leadId,'STAFF_RESUMED',`${staff} resumed ${lead} (${product}).`);
  }
  bumpDataRevision();return after;
}

const QUICK_SKIP_REASONS={
  CALL_NO_ANSWER:'Customer did not answer call',
  TEXT_NO_REPLY:'Customer did not reply to text'
};
function quickSkipReasonLabel(code=''){
  return QUICK_SKIP_REASONS[String(code||'').trim().toUpperCase()]||'Customer no response';
}
function recordLeadQuickSkip(leadId,reasonCode,viewer=null){
  const code=String(reasonCode||'').trim().toUpperCase(),reason=QUICK_SKIP_REASONS[code];
  if(!reason)throw new Error('Choose either Customer did not answer call or Customer did not reply to text.');
  const before=leadWorkContext(leadId);if(!before)throw new Error('Lead not found');
  const stamp=nowIso(),by=Number(viewer?.id||before.assigned_to||ownerUserId()),staff=before?.staff_name||viewer?.name||'Staff';
  const response=code==='CALL_NO_ANSWER'?'NO ANSWER':'NO REPLY';
  db.prepare(`UPDATE leads SET quick_skip_reason=?,quick_skip_at=?,quick_skip_by=?,quick_skip_count=COALESCE(quick_skip_count,0)+1,
    response_status=?,contact_attempts=COALESCE(contact_attempts,0)+1,last_contact_at=?,
    work_status='HOLD',hold_reason=?,work_status_changed_at=?,work_status_changed_by=?,work_completed_at=NULL,updated_at=? WHERE id=?`)
    .run(code,stamp,by,response,stamp,reason,stamp,by,stamp,leadId);
  const method=code==='CALL_NO_ANSWER'?'CALL':'MESSAGE';
  db.prepare('INSERT INTO communications(lead_id,method,direction,subject,body,outcome,communicated_at,user_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(leadId,method,'OUTBOUND','No-response quick skip',reason,response,stamp,by);
  addActivity(leadId,'QUICK_SKIP',`Form skipped — ${reason}`,`${staff} saved this enquiry without filling the full form because the customer did not respond.`);
  createOwnerWorkNotification(leadId,'STAFF_NO_RESPONSE',`${staff} skipped ${before.lead_code||`Lead ${leadId}`} — ${reason}.`);
  bumpDataRevision();
  return db.prepare(`SELECT l.id,l.lead_code,l.quick_skip_reason,l.quick_skip_at,l.quick_skip_by,l.quick_skip_count,l.work_status,l.hold_reason,l.response_status,u.name AS staff_name,c.name AS customer_name,pr.product_name
    FROM leads l LEFT JOIN users u ON u.id=l.assigned_to JOIN customers c ON c.id=l.customer_id LEFT JOIN product_requirements pr ON pr.id=(SELECT MIN(x.id) FROM product_requirements x WHERE x.lead_id=l.id) WHERE l.id=?`).get(leadId);
}
function quickSkipRows(userId=null,limit=30,window=null){
  const where=['l.quick_skip_at IS NOT NULL'],params=[];
  if(userId){where.push('l.assigned_to=?');params.push(Number(userId));}
  if(window?.start&&window?.end){where.push('l.quick_skip_at>=? AND l.quick_skip_at<?');params.push(window.start,window.end);}
  params.push(Math.max(1,Math.min(100,Number(limit)||30)));
  return db.prepare(`SELECT l.id,l.lead_code,l.quick_skip_reason,l.quick_skip_at,l.quick_skip_count,l.response_status,l.work_status,l.hold_reason,
    u.name AS staff_name,c.name AS customer_name,c.company,pr.product_name
    FROM leads l LEFT JOIN users u ON u.id=l.assigned_to JOIN customers c ON c.id=l.customer_id
    LEFT JOIN product_requirements pr ON pr.id=(SELECT MIN(x.id) FROM product_requirements x WHERE x.lead_id=l.id)
    WHERE ${where.join(' AND ')} ORDER BY l.quick_skip_at DESC LIMIT ?`).all(...params);
}

function clientLauncherPayload(){
  const file=path.join(ROOT,'scripts','open_staff_app.ps1');const text=fs.readFileSync(file,'utf8');return {text,sha256:createHash('sha256').update(text,'utf8').digest('hex')};
}
function clientDeviceStatus(){
  const rows=db.prepare(`SELECT ds.id,ds.device_type,ds.device_name,ds.client_version,ds.last_server_version,ds.last_seen_at,ds.last_update_check_at,ds.last_update_applied_at,u.id AS user_id,u.name AS user_name,u.role
    FROM device_sessions ds JOIN users u ON u.id=ds.user_id WHERE ds.active=1 ORDER BY COALESCE(ds.last_seen_at,ds.created_at) DESC`).all();
  return rows.map(x=>({...x,current:String(x.client_version||'')===CLIENT_LAUNCHER_VERSION,server_version:APP_VERSION,launcher_version:CLIENT_LAUNCHER_VERSION}));
}
function rotateOwnerSetupCode(){
  const file=path.join(DATA_DIR,'OWNER_SETUP_CODE.txt'),code=randomBytes(5).toString('hex').toUpperCase();saveSetting('owner_setup_code_hash',ownerSetupCodeHash(code));
  fs.mkdirSync(DATA_DIR,{recursive:true});
  try{fs.writeFileSync(file,code+'\r\n',{encoding:'utf8',mode:0o600});}catch(e){console.warn('[OWNER SETUP] Could not write owner setup code file:',e.message);}
  return code;
}
function ensureOwnerSetupCode(){
  const file=path.join(DATA_DIR,'OWNER_SETUP_CODE.txt'),hash=String(getSetting('owner_setup_code_hash','')||'').trim();
  if(hash&&fs.existsSync(file)){
    try{
      const code=String(fs.readFileSync(file,'utf8')||'').trim().toUpperCase();
      if(code&&ownerSetupCodeHash(code)===hash)return code;
    }catch{}
  }
  return rotateOwnerSetupCode();
}
ensureOwnerSetupCode();
function dashboardWindow(period='TODAY'){
  const p=String(period||'TODAY').toUpperCase(),now=new Date();let start,end;
  if(p==='THIS_WEEK'){
    const monday=(now.getDay()+6)%7;start=new Date(now.getFullYear(),now.getMonth(),now.getDate()-monday);end=new Date(start.getFullYear(),start.getMonth(),start.getDate()+7);
  }else if(p==='THIS_MONTH'){
    start=new Date(now.getFullYear(),now.getMonth(),1);end=new Date(now.getFullYear(),now.getMonth()+1,1);
  }else{
    start=new Date(now.getFullYear(),now.getMonth(),now.getDate());end=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
  }
  return {period:p,start:start.toISOString(),end:end.toISOString()};
}
function teamUsers(){
  return db.prepare("SELECT id,name,email,role,designation,photo_data,display_order,phone,active FROM users WHERE active=1 ORDER BY CASE WHEN role='ADMIN' THEN 0 ELSE 1 END,display_order,id").all();
}
function staffSummaryForWindow(userId,window){
  const assigned=Number(db.prepare('SELECT COUNT(*) AS c FROM leads WHERE assigned_to=? AND received_at>=? AND received_at<?').get(userId,window.start,window.end)?.c||0);
  const completed=Number(db.prepare("SELECT COUNT(*) AS c FROM leads WHERE assigned_to=? AND COALESCE(work_completed_at,form_completed_at)>=? AND COALESCE(work_completed_at,form_completed_at)<?").get(userId,window.start,window.end)?.c||0);
  const saved=Number(db.prepare("SELECT COUNT(*) AS c FROM leads WHERE assigned_to=? AND form_last_saved_at>=? AND form_last_saved_at<?").get(userId,window.start,window.end)?.c||0);
  const won=Number(db.prepare("SELECT COUNT(*) AS c FROM leads WHERE assigned_to=? AND pipeline_stage='WON' AND COALESCE(order_date,updated_at)>=? AND COALESCE(order_date,updated_at)<?").get(userId,window.start,window.end)?.c||0);
  const wonValue=Number(db.prepare("SELECT COALESCE(SUM(COALESCE(order_value,expected_value,0)),0) AS v FROM leads WHERE assigned_to=? AND pipeline_stage='WON' AND COALESCE(order_date,updated_at)>=? AND COALESCE(order_date,updated_at)<?").get(userId,window.start,window.end)?.v||0);
  const open=Number(db.prepare("SELECT COUNT(*) AS c FROM leads WHERE assigned_to=? AND pipeline_stage NOT IN ('WON','LOST')").get(userId)?.c||0);
  const pendingForms=Number(db.prepare("SELECT COUNT(*) AS c FROM leads WHERE assigned_to=? AND pipeline_stage NOT IN ('WON','LOST') AND COALESCE(form_status,'WAITING')<>'COMPLETED'").get(userId)?.c||0);
  const waitingProduct=Number(db.prepare("SELECT COUNT(*) AS c FROM leads WHERE assigned_to=? AND pipeline_stage NOT IN ('WON','LOST') AND COALESCE(product_analysis_status,'PENDING') NOT IN ('COMPLETE','COMPLETED','AVAILABLE','READY')").get(userId)?.c||0);
  const waitingPrice=Number(db.prepare("SELECT COUNT(*) AS c FROM leads WHERE assigned_to=? AND pipeline_stage NOT IN ('WON','LOST') AND COALESCE(price_analysis_status,'PENDING') NOT IN ('COMPLETE','COMPLETED','AVAILABLE','READY','VERIFIED')").get(userId)?.c||0);
  const missingBudget=Number(db.prepare("SELECT COUNT(*) AS c FROM leads WHERE assigned_to=? AND pipeline_stage NOT IN ('WON','LOST') AND COALESCE(budget_status,'UNKNOWN')<>'CONFIRMED'").get(userId)?.c||0);
  const overdue=Number(db.prepare("SELECT COUNT(*) AS c FROM followups f JOIN leads l ON l.id=f.lead_id WHERE l.assigned_to=? AND f.status='PENDING' AND f.due_at<?").get(userId,nowIso())?.c||0);
  const completionRate=assigned?Math.min(100,Math.round(completed*100/assigned)):(completed?100:0);
  const canTakeClient=open<20&&pendingForms<8;
  return {assigned,completed,saved,won,won_value:wonValue,open_leads:open,pending_forms:pendingForms,waiting_product:waitingProduct,waiting_price:waitingPrice,missing_budget:missingBudget,overdue_followups:overdue,completion_rate:completionRate,can_take_client:canTakeClient};
}
function dailyStaffTrend(userId=null,days=7){
  const out=[];const now=new Date();
  for(let i=days-1;i>=0;i--){
    const st=new Date(now.getFullYear(),now.getMonth(),now.getDate()-i),en=new Date(st.getFullYear(),st.getMonth(),st.getDate()+1);const a=st.toISOString(),b=en.toISOString();
    const ownerSql=userId?' AND assigned_to=?':'';const params=userId?[a,b,userId]:[a,b];
    const assigned=Number(db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE received_at>=? AND received_at<?${ownerSql}`).get(...params)?.c||0);
    const params2=userId?[a,b,userId]:[a,b];
    const completed=Number(db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE COALESCE(work_completed_at,form_completed_at)>=? AND COALESCE(work_completed_at,form_completed_at)<?${ownerSql}`).get(...params2)?.c||0);
    out.push({date:a.slice(0,10),label:st.toLocaleDateString('en-IN',{weekday:'short'}),assigned,completed});
  }
  return out;
}
function weeklyStaffTrend(userId=null,weeks=8){
  const out=[];const now=new Date();const mondayOffset=(now.getDay()+6)%7;const thisMonday=new Date(now.getFullYear(),now.getMonth(),now.getDate()-mondayOffset);
  for(let i=weeks-1;i>=0;i--){
    const st=new Date(thisMonday.getFullYear(),thisMonday.getMonth(),thisMonday.getDate()-i*7),en=new Date(st.getFullYear(),st.getMonth(),st.getDate()+7);const a=st.toISOString(),b=en.toISOString();const ownerSql=userId?' AND assigned_to=?':'';
    const assigned=Number(db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE received_at>=? AND received_at<?${ownerSql}`).get(...(userId?[a,b,userId]:[a,b]))?.c||0);
    const completed=Number(db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE COALESCE(work_completed_at,form_completed_at)>=? AND COALESCE(work_completed_at,form_completed_at)<?${ownerSql}`).get(...(userId?[a,b,userId]:[a,b]))?.c||0);
    out.push({start:a.slice(0,10),label:`${String(st.getDate()).padStart(2,'0')}/${String(st.getMonth()+1).padStart(2,'0')}`,assigned,completed});
  }
  return out;
}
function monthlyStaffTrend(userId=null,months=6){
  const out=[];const now=new Date();
  for(let i=months-1;i>=0;i--){
    const st=new Date(now.getFullYear(),now.getMonth()-i,1),en=new Date(st.getFullYear(),st.getMonth()+1,1);const a=st.toISOString(),b=en.toISOString();const ownerSql=userId?' AND assigned_to=?':'';
    const assigned=Number(db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE received_at>=? AND received_at<?${ownerSql}`).get(...(userId?[a,b,userId]:[a,b]))?.c||0);
    const completed=Number(db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE COALESCE(work_completed_at,form_completed_at)>=? AND COALESCE(work_completed_at,form_completed_at)<?${ownerSql}`).get(...(userId?[a,b,userId]:[a,b]))?.c||0);
    out.push({start:a.slice(0,10),label:st.toLocaleDateString('en-IN',{month:'short'}),assigned,completed});
  }
  return out;
}
function staffStatusForWindow(userId,window){
  const r=db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN pipeline_stage='WON' THEN 1 ELSE 0 END) AS purchased,
    SUM(CASE WHEN pipeline_stage='LOST' THEN 1 ELSE 0 END) AS not_purchase,
    SUM(CASE WHEN pipeline_stage NOT IN ('WON','LOST') AND (
      COALESCE(product_analysis_status,'PENDING') NOT IN ('COMPLETE','COMPLETED','AVAILABLE','READY') OR
      COALESCE(price_analysis_status,'PENDING') NOT IN ('COMPLETE','COMPLETED','AVAILABLE','READY','VERIFIED')
    ) THEN 1 ELSE 0 END) AS waiting,
    SUM(CASE WHEN pipeline_stage NOT IN ('WON','LOST') AND
      COALESCE(product_analysis_status,'PENDING') IN ('COMPLETE','COMPLETED','AVAILABLE','READY') AND
      COALESCE(price_analysis_status,'PENDING') IN ('COMPLETE','COMPLETED','AVAILABLE','READY','VERIFIED') AND
      COALESCE(form_status,'WAITING')<>'COMPLETED' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN pipeline_stage NOT IN ('WON','LOST') AND
      COALESCE(product_analysis_status,'PENDING') IN ('COMPLETE','COMPLETED','AVAILABLE','READY') AND
      COALESCE(price_analysis_status,'PENDING') IN ('COMPLETE','COMPLETED','AVAILABLE','READY','VERIFIED') AND
      COALESCE(form_status,'WAITING')='COMPLETED' THEN 1 ELSE 0 END) AS completed_ready,
    SUM(CASE WHEN COALESCE(work_status,'ACTIVE')='HOLD' THEN 1 ELSE 0 END) AS on_hold,
    SUM(CASE WHEN COALESCE(work_status,'ACTIVE')='COMPLETED' THEN 1 ELSE 0 END) AS work_completed
    FROM leads WHERE assigned_to=? AND received_at>=? AND received_at<?`).get(userId,window.start,window.end)||{};
  const quickSkipped=Number(db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE assigned_to=? AND quick_skip_at>=? AND quick_skip_at<?`).get(userId,window.start,window.end)?.c||0);
  return {total:Number(r.total||0),purchased:Number(r.purchased||0),not_purchase:Number(r.not_purchase||0),waiting:Number(r.waiting||0),pending:Number(r.pending||0),completed_ready:Number(r.completed_ready||0),on_hold:Number(r.on_hold||0),work_completed:Number(r.work_completed||0),quick_skipped:quickSkipped};
}
function raceRowsFromTeam(team,field){
  const rows=(team||[]).map(u=>{const s=u[field]||{},status=u[`${field}_status`]||{};return {id:u.id,name:u.name,designation:u.designation,photo_data:u.photo_data,completed:Number(s.completed||0),assigned:Number(s.assigned||0),completion_rate:Number(s.completion_rate||0),won:Number(s.won||0),won_value:Number(s.won_value||0),waiting:Number(status.waiting||0),pending:Number(status.pending||0),not_purchase:Number(status.not_purchase||0),purchased:Number(status.purchased||0)}});
  rows.sort((a,b)=>b.completed-a.completed||b.won-a.won||b.completion_rate-a.completion_rate||a.name.localeCompare(b.name));
  return rows.map((x,i)=>({...x,rank:i+1}));
}
function staffLeadRows(userId,{waitingOnly=false,limit=25}={}){
  const extra=waitingOnly?" AND l.pipeline_stage NOT IN ('WON','LOST') AND (COALESCE(l.form_status,'WAITING')<>'COMPLETED' OR COALESCE(l.product_analysis_status,'PENDING') NOT IN ('COMPLETE','COMPLETED','AVAILABLE','READY') OR COALESCE(l.price_analysis_status,'PENDING') NOT IN ('COMPLETE','COMPLETED','AVAILABLE','READY','VERIFIED'))":'';
  return db.prepare(`SELECT l.id,l.lead_code,l.received_at,l.pipeline_stage,l.order_status,l.temperature,l.purchase_probability,l.product_analysis_status,l.price_analysis_status,l.form_status,l.form_completion_percent,l.form_last_saved_at,l.form_completed_at,l.work_status,l.hold_reason,l.work_status_changed_at,l.work_completed_at,l.quick_skip_reason,l.quick_skip_at,l.quick_skip_count,l.response_status,l.budget_status,c.name AS customer_name,c.company,c.city,c.state,c.country,pr.product_name,pr.requested_model,u.name AS owner_name
    FROM leads l JOIN customers c ON c.id=l.customer_id LEFT JOIN users u ON u.id=l.assigned_to LEFT JOIN product_requirements pr ON pr.id=(SELECT MIN(x.id) FROM product_requirements x WHERE x.lead_id=l.id)
    WHERE l.assigned_to=?${extra} ORDER BY CASE WHEN l.pipeline_stage IN ('WON','LOST') THEN 1 ELSE 0 END,l.received_at DESC LIMIT ?`).all(userId,limit);
}
function staffDashboardData(userId,period='TODAY'){
  const staff=db.prepare("SELECT id,name,email,role,designation,photo_data,display_order,phone,active FROM users WHERE id=? AND active=1").get(userId);if(!staff)throw new Error('Staff member not found.');
  const windows={TODAY:dashboardWindow('TODAY'),THIS_WEEK:dashboardWindow('THIS_WEEK'),THIS_MONTH:dashboardWindow('THIS_MONTH')};
  return {staff,selected_period:String(period||'TODAY').toUpperCase(),today:staffSummaryForWindow(userId,windows.TODAY),week:staffSummaryForWindow(userId,windows.THIS_WEEK),month:staffSummaryForWindow(userId,windows.THIS_MONTH),today_status:staffStatusForWindow(userId,windows.TODAY),week_status:staffStatusForWindow(userId,windows.THIS_WEEK),month_status:staffStatusForWindow(userId,windows.THIS_MONTH),daily_trend:dailyStaffTrend(userId,7),weekly_trend:weeklyStaffTrend(userId,8),monthly_trend:monthlyStaffTrend(userId,6),waiting_leads:staffLeadRows(userId,{waitingOnly:true,limit:30}),recent_leads:staffLeadRows(userId,{limit:30}),quick_skips:quickSkipRows(userId,30),revision:dataRevision,generated_at:nowIso()};
}

function staffDateWorkWindow(period='TODAY'){
  const p=String(period||'TODAY').toUpperCase();
  const allowed=new Set(['YESTERDAY','TODAY','TOMORROW','THIS_WEEK','THIS_MONTH','ALL']);
  const selected=allowed.has(p)?p:'TODAY';
  if(selected==='ALL')return {period:selected,start:null,end:null,label:'All'};
  const now=new Date();let start,end,label;
  if(selected==='YESTERDAY'){
    start=new Date(now.getFullYear(),now.getMonth(),now.getDate()-1);end=new Date(now.getFullYear(),now.getMonth(),now.getDate());label='Yesterday';
  }else if(selected==='TOMORROW'){
    start=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);end=new Date(now.getFullYear(),now.getMonth(),now.getDate()+2);label='Tomorrow';
  }else if(selected==='THIS_WEEK'){
    const monday=(now.getDay()+6)%7;start=new Date(now.getFullYear(),now.getMonth(),now.getDate()-monday);end=new Date(start.getFullYear(),start.getMonth(),start.getDate()+7);label='This Week';
  }else if(selected==='THIS_MONTH'){
    start=new Date(now.getFullYear(),now.getMonth(),1);end=new Date(now.getFullYear(),now.getMonth()+1,1);label='This Month';
  }else{
    start=new Date(now.getFullYear(),now.getMonth(),now.getDate());end=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);label='Today';
  }
  return {period:selected,start:start.toISOString(),end:end.toISOString(),label};
}
function staffDateWorkData(userId,period='TODAY'){
  const staff=db.prepare("SELECT id,name,designation FROM users WHERE id=? AND active=1").get(userId);if(!staff)throw new Error('Staff member not found.');
  const w=staffDateWorkWindow(period),rangeSql=w.start?' AND f.due_at>=? AND f.due_at<?':'',rangeParams=w.start?[w.start,w.end]:[];
  const scheduled=db.prepare(`SELECT f.id AS followup_id,f.due_at,f.method,f.status,f.notes,f.priority,f.reason,l.id,l.lead_code,l.work_status,l.hold_reason,l.pipeline_stage,c.name AS customer_name,c.company,pr.product_name
    FROM followups f JOIN leads l ON l.id=f.lead_id JOIN customers c ON c.id=l.customer_id LEFT JOIN product_requirements pr ON pr.id=(SELECT MIN(x.id) FROM product_requirements x WHERE x.lead_id=l.id)
    WHERE l.assigned_to=? AND f.status='PENDING'${rangeSql}
    ORDER BY f.due_at ASC LIMIT 100`).all(userId,...rangeParams);
  const historyRangeSql=w.start?' AND a.created_at>=? AND a.created_at<?':'',historyParams=w.start?[w.start,w.end]:[];
  const history=db.prepare(`SELECT a.id AS activity_id,a.activity_type,a.title,a.detail,a.created_at,l.id,l.lead_code,l.work_status,l.hold_reason,l.pipeline_stage,c.name AS customer_name,c.company,pr.product_name
    FROM activities a JOIN leads l ON l.id=a.lead_id JOIN customers c ON c.id=l.customer_id LEFT JOIN product_requirements pr ON pr.id=(SELECT MIN(x.id) FROM product_requirements x WHERE x.lead_id=l.id)
    WHERE l.assigned_to=?${historyRangeSql}
    ORDER BY a.created_at DESC LIMIT 120`).all(userId,...historyParams);
  const changedRangeSql=w.start?' AND COALESCE(l.work_status_changed_at,l.form_last_saved_at,l.updated_at,l.received_at)>=? AND COALESCE(l.work_status_changed_at,l.form_last_saved_at,l.updated_at,l.received_at)<?':'';
  const changed=db.prepare(`SELECT l.id,l.lead_code,l.work_status,l.hold_reason,l.pipeline_stage,l.form_status,l.form_completion_percent,COALESCE(l.work_status_changed_at,l.form_last_saved_at,l.updated_at,l.received_at) AS changed_at,c.name AS customer_name,c.company,pr.product_name
    FROM leads l JOIN customers c ON c.id=l.customer_id LEFT JOIN product_requirements pr ON pr.id=(SELECT MIN(x.id) FROM product_requirements x WHERE x.lead_id=l.id)
    WHERE l.assigned_to=?${changedRangeSql}
    ORDER BY changed_at DESC LIMIT 80`).all(userId,...historyParams);
  return {staff,period:w.period,label:w.label,start:w.start,end:w.end,scheduled,history,changed,counts:{scheduled:scheduled.length,history:history.length,changed:changed.length},revision:dataRevision,generated_at:nowIso()};
}
function ownerDashboardData(period='TODAY'){
  const selected=dashboardWindow(period),today=dashboardWindow('TODAY'),week=dashboardWindow('THIS_WEEK'),month=dashboardWindow('THIS_MONTH');const staff=teamUsers().filter(x=>x.role!=='ADMIN');
  const team=staff.map(u=>({...u,period:staffSummaryForWindow(u.id,selected),status:staffStatusForWindow(u.id,selected),today:staffSummaryForWindow(u.id,today),today_status:staffStatusForWindow(u.id,today),week:staffSummaryForWindow(u.id,week),week_status:staffStatusForWindow(u.id,week),month:staffSummaryForWindow(u.id,month),month_status:staffStatusForWindow(u.id,month)}));
  const teamTotals=team.reduce((a,x)=>{for(const k of ['assigned','completed','won','open_leads','pending_forms','waiting_product','waiting_price','missing_budget','overdue_followups'])a[k]=(a[k]||0)+Number(x.period[k]||0);for(const k of ['waiting','pending','not_purchase','purchased','completed_ready','on_hold','work_completed','quick_skipped'])a[k]=(a[k]||0)+Number(x.status[k]||0);a.won_value=(a.won_value||0)+Number(x.period.won_value||0);return a;},{});
  teamTotals.completion_rate=teamTotals.assigned?Math.min(100,Math.round(teamTotals.completed*100/teamTotals.assigned)):(teamTotals.completed?100:0);
  teamTotals.available_staff=team.filter(x=>x.period.can_take_client).length;teamTotals.staff_count=team.length;
  const recent=db.prepare(`SELECT l.id,l.lead_code,l.received_at,l.pipeline_stage,l.order_status,l.temperature,l.purchase_probability,l.product_analysis_status,l.price_analysis_status,l.form_status,l.form_completion_percent,l.form_last_saved_at,l.form_completed_at,l.work_status,l.hold_reason,l.work_status_changed_at,l.work_completed_at,c.name AS customer_name,c.company,pr.product_name,u.id AS owner_id,u.name AS owner_name
    FROM leads l JOIN customers c ON c.id=l.customer_id LEFT JOIN users u ON u.id=l.assigned_to LEFT JOIN product_requirements pr ON pr.id=(SELECT MIN(x.id) FROM product_requirements x WHERE x.lead_id=l.id) ORDER BY COALESCE(l.form_last_saved_at,l.received_at) DESC LIMIT 40`).all();
  const owner=db.prepare("SELECT id FROM users WHERE role='ADMIN' AND active=1 ORDER BY id LIMIT 1").get();
  const assignmentQueue=db.prepare(`SELECT l.id,l.lead_code,l.received_at,l.temperature,l.purchase_probability,l.product_analysis_status,l.price_analysis_status,l.form_status,l.form_completion_percent,c.name AS customer_name,c.company,pr.product_name
    FROM leads l JOIN customers c ON c.id=l.customer_id LEFT JOIN product_requirements pr ON pr.id=(SELECT MIN(x.id) FROM product_requirements x WHERE x.lead_id=l.id)
    WHERE l.pipeline_stage NOT IN ('WON','LOST') AND (l.assigned_to IS NULL OR l.assigned_to=?) ORDER BY l.received_at DESC LIMIT 30`).all(Number(owner?.id||1));
  teamTotals.needs_assignment=assignmentQueue.length;
  const races={TODAY:raceRowsFromTeam(team,'today'),THIS_WEEK:raceRowsFromTeam(team,'week'),THIS_MONTH:raceRowsFromTeam(team,'month')};
  const ownerActivity=db.prepare(`SELECT l.id,l.lead_code,l.work_status,l.hold_reason,l.work_status_changed_at,l.work_completed_at,u.name AS staff_name,c.name AS customer_name,pr.product_name
    FROM leads l LEFT JOIN users u ON u.id=l.assigned_to JOIN customers c ON c.id=l.customer_id LEFT JOIN product_requirements pr ON pr.id=(SELECT MIN(x.id) FROM product_requirements x WHERE x.lead_id=l.id)
    WHERE l.work_status_changed_at IS NOT NULL ORDER BY l.work_status_changed_at DESC LIMIT 30`).all();
  const unreadOwner=Number(db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id=? AND is_read=0 AND type IN ('STAFF_HOLD','STAFF_COMPLETED','STAFF_RESUMED','STAFF_NO_RESPONSE')").get(ownerUserId())?.c||0);
  const devices=clientDeviceStatus();
  return {period:selected.period,period_start:selected.start,period_end:selected.end,totals:teamTotals,team,races,daily_trend:dailyStaffTrend(null,7),weekly_trend:weeklyStaffTrend(null,8),monthly_trend:monthlyStaffTrend(null,6),recent_forms:recent,owner_activity:ownerActivity,quick_skips:quickSkipRows(null,50,selected),owner_unread:unreadOwner,client_devices:devices,client_update:{server_version:APP_VERSION,launcher_version:CLIENT_LAUNCHER_VERSION,current:devices.filter(x=>x.current).length,total:devices.length},assignment_queue:assignmentQueue,backup:{last_at:getSetting('auto_backup_last_at',''),last_file:getSetting('auto_backup_last_file',''),last_error:getSetting('auto_backup_last_error','')},revision:dataRevision,generated_at:nowIso()};
}
function teamLiveSummary(period='TODAY'){const d=ownerDashboardData(period);return {period:d.period,races:d.races,revision:dataRevision,generated_at:d.generated_at};}

function reportFilter(url){
  const where=['1=1'];const params=[];const period=(url?.searchParams?.get('period')||'THIS_MONTH').toUpperCase();
  const now=new Date();let start=null,end=null;
  if(period==='TODAY'){start=new Date(now.getFullYear(),now.getMonth(),now.getDate());end=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);}
  else if(period==='THIS_WEEK'){const d=(now.getDay()+6)%7;start=new Date(now.getFullYear(),now.getMonth(),now.getDate()-d);end=new Date(start.getFullYear(),start.getMonth(),start.getDate()+7);}
  else if(period==='THIS_MONTH'){start=new Date(now.getFullYear(),now.getMonth(),1);end=new Date(now.getFullYear(),now.getMonth()+1,1);}
  else if(period==='CUSTOM'){const a=validDateIso(url.searchParams.get('from')),b=validDateIso(url.searchParams.get('to'));if(a){where.push('l.received_at>=?');params.push(a);}if(b){where.push('l.received_at<=?');params.push(b);}}
  if(start&&end){where.push('l.received_at>=? AND l.received_at<?');params.push(start.toISOString(),end.toISOString());}
  for(const [param,col] of [['source','l.source_type'],['salesperson','l.assigned_to'],['state','c.state'],['country_bucket','l.external_country_bucket']]){const v=url?.searchParams?.get(param);if(v){where.push(`${col}=?`);params.push(param==='salesperson'?Number(v):v);}}
  const category=url?.searchParams?.get('category');if(category){where.push("COALESCE(p.category,'')=?");params.push(category);}
  return {where:where.join(' AND '),params,period};
}
function managerData(url=new URL('http://x/?period=THIS_MONTH')) {
  const f=reportFilter(url);const from=`FROM leads l JOIN customers c ON c.id=l.customer_id LEFT JOIN users u ON u.id=l.assigned_to LEFT JOIN product_requirements pr ON pr.id=(SELECT MIN(pr0.id) FROM product_requirements pr0 WHERE pr0.lead_id=l.id) LEFT JOIN lead_products lp ON lp.id=(SELECT lp0.id FROM lead_products lp0 WHERE lp0.lead_id=l.id ORDER BY lp0.match_confidence DESC,lp0.id LIMIT 1) LEFT JOIN products p ON p.id=lp.product_id`;
  const m=db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN l.live_classification='LIVE' THEN 1 ELSE 0 END) AS live_leads,
    SUM(CASE WHEN l.temperature IN ('HOT','VERY HOT') THEN 1 ELSE 0 END) AS hot_leads,
    SUM(CASE WHEN l.last_contact_at IS NULL THEN 1 ELSE 0 END) AS not_contacted,
    AVG(CASE WHEN l.first_response_at IS NOT NULL THEN (julianday(l.first_response_at)-julianday(l.received_at))*1440 END) AS avg_response,
    SUM(CASE WHEN l.pipeline_stage='WON' THEN 1 ELSE 0 END) AS won,
    SUM(CASE WHEN l.pipeline_stage='WON' THEN COALESCE(l.order_value,l.expected_value,0) ELSE 0 END) AS won_revenue,
    SUM(CASE WHEN l.pipeline_stage NOT IN ('WON','LOST') THEN COALESCE(l.expected_value,0) ELSE 0 END) AS pipeline_value,
    SUM(CASE WHEN l.pipeline_stage NOT IN ('WON','LOST') THEN COALESCE(l.expected_value,0)*(l.purchase_probability/100.0) ELSE 0 END) AS expected_revenue
    ${from} WHERE ${f.where}`).get(...f.params);
  let quoteCount=0,quoteAccepted=0,quoteValue=0;
  try{
    const qr=db.prepare(`SELECT COUNT(DISTINCT q.id) AS c,SUM(CASE WHEN q.status='ACCEPTED' THEN 1 ELSE 0 END) AS a,SUM(COALESCE(q.total,0)) AS v FROM quotations q JOIN leads l ON l.id=q.lead_id JOIN customers c ON c.id=l.customer_id LEFT JOIN users u ON u.id=l.assigned_to LEFT JOIN product_requirements pr ON pr.id=(SELECT MIN(pr0.id) FROM product_requirements pr0 WHERE pr0.lead_id=l.id) LEFT JOIN lead_products lp ON lp.id=(SELECT lp0.id FROM lead_products lp0 WHERE lp0.lead_id=l.id ORDER BY lp0.match_confidence DESC,lp0.id LIMIT 1) LEFT JOIN products p ON p.id=lp.product_id WHERE ${f.where}`).get(...f.params);
    quoteCount=Number(qr.c||0);quoteAccepted=Number(qr.a||0);quoteValue=Number(qr.v||0);
  }catch{}
  const sources=db.prepare(`SELECT COALESCE(l.source_type,'Unknown') AS label,COUNT(*) AS value,SUM(CASE WHEN l.pipeline_stage='WON' THEN 1 ELSE 0 END) AS won ${from} WHERE ${f.where} GROUP BY l.source_type ORDER BY value DESC LIMIT 10`).all(...f.params);
  const products=db.prepare(`SELECT COALESCE(pr.product_name,'Unknown') AS label,COUNT(*) AS value ${from} WHERE ${f.where} GROUP BY pr.product_name ORDER BY value DESC LIMIT 10`).all(...f.params);
  const regions=db.prepare(`SELECT COALESCE(NULLIF(c.state,''),NULLIF(c.city,''),'Unknown') AS label,COUNT(*) AS value ${from} WHERE ${f.where} GROUP BY label ORDER BY value DESC LIMIT 10`).all(...f.params);
  const lostReasons=db.prepare(`SELECT COALESCE(NULLIF(l.lost_reason,''),'Not recorded') AS label,COUNT(*) AS value ${from} WHERE ${f.where} AND l.pipeline_stage='LOST' GROUP BY label ORDER BY value DESC LIMIT 10`).all(...f.params);
  const salespeople=db.prepare(`SELECT COALESCE(u.name,'Unassigned') AS label,COUNT(*) AS leads,SUM(CASE WHEN l.pipeline_stage='WON' THEN 1 ELSE 0 END) AS won,ROUND(AVG(l.purchase_probability),0) AS avg_probability ${from} WHERE ${f.where} GROUP BY l.assigned_to ORDER BY won DESC,leads DESC LIMIT 20`).all(...f.params);
  const top=leadCompactRows(f.where,'l.purchase_probability DESC,l.received_at DESC','LIMIT 8',f.params);
  const duePast=Number(db.prepare(`SELECT COUNT(*) AS c FROM followups f JOIN leads l ON l.id=f.lead_id JOIN customers c ON c.id=l.customer_id LEFT JOIN users u ON u.id=l.assigned_to LEFT JOIN product_requirements pr ON pr.id=(SELECT MIN(pr0.id) FROM product_requirements pr0 WHERE pr0.lead_id=l.id) LEFT JOIN lead_products lp ON lp.id=(SELECT lp0.id FROM lead_products lp0 WHERE lp0.lead_id=l.id LIMIT 1) LEFT JOIN products p ON p.id=lp.product_id WHERE ${f.where} AND f.due_at<=?`).get(...f.params,nowIso())?.c||0);
  const completedDue=Number(db.prepare(`SELECT COUNT(*) AS c FROM followups f JOIN leads l ON l.id=f.lead_id JOIN customers c ON c.id=l.customer_id LEFT JOIN users u ON u.id=l.assigned_to LEFT JOIN product_requirements pr ON pr.id=(SELECT MIN(pr0.id) FROM product_requirements pr0 WHERE pr0.lead_id=l.id) LEFT JOIN lead_products lp ON lp.id=(SELECT lp0.id FROM lead_products lp0 WHERE lp0.lead_id=l.id LIMIT 1) LEFT JOIN products p ON p.id=lp.product_id WHERE ${f.where} AND f.due_at<=? AND f.status='COMPLETED'`).get(...f.params,nowIso())?.c||0);
  const total=Number(m.total||0),won=Number(m.won||0),hot=Number(m.hot_leads||0);
  return {revision:dataRevision,generated_at:nowIso(),filters:{period:f.period},metrics:{total_leads:total,today_leads:total,hot_leads:hot,not_contacted:Number(m.not_contacted||0),avg_response_minutes:Math.max(0,Math.round(Number(m.avg_response||0))),quotations_sent:quoteCount,quotation_value:quoteValue,quote_conversion:quoteCount?Math.round((quoteAccepted/quoteCount)*100):0,orders_won:won,conversion_rate:total?Math.round((won/total)*100):0,hot_to_won:hot?Math.round((won/hot)*100):0,pipeline_value:Number(m.pipeline_value||0),expected_order_value:Number(m.expected_revenue||0),expected_revenue:Number(m.expected_revenue||0),won_revenue:Number(m.won_revenue||0),followup_compliance:duePast?Math.round((completedDue/duePast)*100):100},source_performance:Object.fromEntries(sources.map(x=>[x.label,Number(x.value)])),source_conversion:sources,product_demand:Object.fromEntries(products.map(x=>[x.label,Number(x.value)])),region_demand:Object.fromEntries(regions.map(x=>[x.label,Number(x.value)])),lost_reasons:lostReasons,salesperson_performance:salespeople,top_opportunities:top,playbook_performance:playbookPerformance()};
}

function customer360(id) {
  const customer=db.prepare('SELECT * FROM customers WHERE id=?').get(id); if(!customer)return null;
  const leads=db.prepare(`SELECT l.*, (SELECT product_name FROM product_requirements pr WHERE pr.lead_id=l.id ORDER BY pr.id LIMIT 1) AS product_name FROM leads l WHERE customer_id=? ORDER BY received_at DESC`).all(id);
  const quotes=db.prepare('SELECT * FROM quotations WHERE customer_id=? ORDER BY created_at DESC').all(id);
  const activities=db.prepare('SELECT * FROM activities WHERE customer_id=? OR lead_id IN (SELECT id FROM leads WHERE customer_id=?) ORDER BY created_at DESC LIMIT 100').all(id,id);
  const won=leads.filter(l=>l.pipeline_stage==='WON').reduce((a,l)=>a+(l.order_value||l.expected_value||0),0); const lost=leads.filter(l=>l.pipeline_stage==='LOST').reduce((a,l)=>a+(l.expected_value||0),0);
  const nurture=db.prepare('SELECT * FROM customer_nurture WHERE customer_id=?').get(id)||null;
  return {customer,leads,quotations:quotes,activities,nurture,metrics:{total_enquiries:leads.length,total_quotations:quotes.length,orders:leads.filter(l=>l.pipeline_stage==='WON').length,won_value:won,lost_value:lost}};
}

const analysisQueue=[];const queuedLeadIds=new Set();let analysisActive=0;const ANALYSIS_CONCURRENCY=Math.max(1,Math.min(4,Number(process.env.LEAD_ANALYSIS_CONCURRENCY||3)));
function enqueueLeadAnalysis(leadId,priority='LIVE'){
  const id=Number(leadId);if(!id||queuedLeadIds.has(id))return;queuedLeadIds.add(id);const job={leadId:id,priority:priority==='LIVE'?0:1,queuedAt:Date.now()};analysisQueue.push(job);analysisQueue.sort((a,b)=>a.priority-b.priority||a.queuedAt-b.queuedAt);setImmediate(processAnalysisQueue);
}
function processAnalysisQueue(){
  while(analysisActive<ANALYSIS_CONCURRENCY&&analysisQueue.length){
    const job=analysisQueue.shift();queuedLeadIds.delete(job.leadId);analysisActive++;
    Promise.resolve(runLeadAnalysis(job.leadId)).catch(e=>{
      console.error('[LEAD ANALYSIS]',job.leadId,e.message);
      db.prepare(`UPDATE leads SET product_analysis_status='TEMPORARILY UNAVAILABLE',price_analysis_status=CASE WHEN price_analysis_status='SEARCHING' THEN 'NEEDS VERIFICATION' ELSE price_analysis_status END,qualification_status=CASE WHEN qualification_status='CALCULATING' THEN 'COMPLETE' ELSE qualification_status END,updated_at=? WHERE id=?`).run(nowIso(),job.leadId);
    }).finally(()=>{analysisActive--;setImmediate(processAnalysisQueue);});
  }
}
function scheduleAnalysisBackfill(){
  const rows=db.prepare(`SELECT id,live_classification FROM leads WHERE COALESCE(analysis_version,0)<? ORDER BY CASE WHEN live_classification='LIVE' THEN 0 ELSE 1 END, received_at DESC`).all(ANALYSIS_VERSION);
  if(!rows.length)return;
  let i=0;
  const batch=()=>{
    const end=Math.min(i+35,rows.length);
    for(;i<end;i++)enqueueLeadAnalysis(rows[i].id,rows[i].live_classification||'HISTORICAL');
    if(i<rows.length)setTimeout(batch,750).unref();
  };
  batch();
}
async function runLeadPriceRefresh(leadId,{force=true}={}){
  const lead=db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);if(!lead)return null;
  const req=db.prepare('SELECT * FROM product_requirements WHERE lead_id=? ORDER BY id LIMIT 1').get(leadId);if(!req)return null;
  const inferred=applyInferredRequirementIdentity(req);
  db.prepare(`UPDATE leads SET price_analysis_status='SEARCHING',updated_at=? WHERE id=?`).run(nowIso(),leadId);
  try{await ensureOnlinePriceResearch(leadId,inferred,{force});}
  catch(e){console.warn('[ONLINE PRICE]',leadId,e.message);}
  const price=priceIntelligenceForLead(leadId);
  db.prepare(`UPDATE leads SET price_analysis_status=?,updated_at=? WHERE id=?`).run(['AVAILABLE','ONLINE PRICE FOUND'].includes(price.status)?'COMPLETE':'NEEDS VERIFICATION',nowIso(),leadId);
  bumpDataRevision();
  return price;
}

async function runLeadAnalysis(leadId,{forceProductRefresh=false,forcePriceRefresh=false}={}){
  const lead=db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);if(!lead)return;
  const firstRun=Number(lead.analysis_version||0)<ANALYSIS_VERSION;
  db.prepare(`UPDATE leads SET product_analysis_status='ANALYZING',price_analysis_status='SEARCHING',qualification_status='CALCULATING',updated_at=? WHERE id=?`).run(nowIso(),leadId);
  const reqs=db.prepare('SELECT * FROM product_requirements WHERE lead_id=? ORDER BY id').all(leadId);
  // Start online-price research at the same time as product-information research.
  // Both use the same already-inferred product identity, so a new lead no longer
  // waits for product generation to finish before starting its price search.
  let priceResearchPromise=null;
  if(reqs[0]){
    const priceReq=applyInferredRequirementIdentity(reqs[0]);
    priceResearchPromise=ensureOnlinePriceResearch(leadId,priceReq,{force:forcePriceRefresh}).catch(e=>{console.warn('[ONLINE PRICE]',leadId,e.message);return null;});
  }
  let productFailureStatus='';
  for(const rawReq of reqs){
    const req=applyInferredRequirementIdentity(rawReq);
    let results=productSearch(req),best=results[0]||null;
    const localGood=Boolean(best?.product?.id&&best.confidence>=80&&productRecordIsComplete(best.product.id));
    if(forceProductRefresh||!localGood){
      try{
        const enriched=await ensureAutomaticProductIntelligence(leadId,req,{force:forceProductRefresh});
        if(enriched?.status==='COMPLETE'||enriched?.status==='CACHE'||enriched?.status==='LOCAL_VERIFIED'||enriched?.status==='LOCAL_STORED'){
          results=productSearch(db.prepare('SELECT * FROM product_requirements WHERE id=?').get(req.id));best=results[0]||best;
          if(enriched.productId){
            const generated=db.prepare('SELECT * FROM products WHERE id=?').get(enriched.productId);
            if(generated){best={provider:'Gemini Product Intelligence',product:generated,confidence:Number(enriched.confidence||95),source:enriched.status==='CACHE'?'Product Intelligence Cache':'Gemini / Online Product Sources',verification_status:Number(enriched.confidence||0)>=90?'VERIFIED':'NEEDS VERIFICATION'};}
          }
        }else if(enriched?.status==='LOW_CONFIDENCE'){
          best=null;
        }else if(['KEY_MISSING','NOT_CONFIGURED'].includes(String(enriched?.status||'').toUpperCase())){
          productFailureStatus='NOT CONFIGURED';
        }else if(enriched?.status){
          productFailureStatus=String(enriched.status).replaceAll('_',' ');
        }
      }catch(e){productFailureStatus=String(e?.code||'API REQUEST FAILED').replaceAll('_',' ');console.error('[PRODUCT INTELLIGENCE]',leadId,e.message);}
    }
    const currentReq=db.prepare('SELECT * FROM product_requirements WHERE id=?').get(req.id)||req;
    const existing=db.prepare('SELECT id FROM lead_products WHERE lead_id=? AND requirement_id=? ORDER BY id LIMIT 1').get(leadId,req.id);
    const productId=best?.product?.id||null,confidence=Number(best?.confidence||currentReq.product_identity_confidence||0),reason=best?`${best.provider}: ${best.product?.name||req.product_name} (${confidence}%)`:'Product identity / exact model needs verification.';
    if(existing)db.prepare('UPDATE lead_products SET product_id=?,match_confidence=?,match_reason=? WHERE id=?').run(productId,confidence,reason,existing.id);
    else db.prepare('INSERT INTO lead_products(lead_id,requirement_id,product_id,match_confidence,match_reason) VALUES (?,?,?,?,?)').run(leadId,req.id,productId,confidence,reason);
  }
  db.prepare(`UPDATE leads SET product_analysis_status=?,updated_at=? WHERE id=?`).run(productFailureStatus||'COMPLETE',nowIso(),leadId);
  if(priceResearchPromise)await priceResearchPromise;
  const price=priceIntelligenceForLead(leadId);
  db.prepare(`UPDATE leads SET price_analysis_status=?,updated_at=? WHERE id=?`).run(['AVAILABLE','ONLINE PRICE FOUND'].includes(price.status)?'COMPLETE':'NEEDS VERIFICATION',nowIso(),leadId);
  const score=calculateLeadScore(leadId);
  const nba=nextBestAction(db.prepare('SELECT * FROM leads WHERE id=?').get(leadId),[],db.prepare('SELECT * FROM quotations WHERE lead_id=?').all(leadId),db.prepare('SELECT * FROM objections WHERE lead_id=?').all(leadId));
  db.prepare('UPDATE leads SET next_action=?,analysis_version=?,updated_at=? WHERE id=?').run(nba.title,ANALYSIS_VERSION,nowIso(),leadId);
  if(firstRun){
    const best=Number(db.prepare('SELECT MAX(match_confidence) AS m FROM lead_products WHERE lead_id=?').get(leadId)?.m||0);
    addActivity(leadId,'PRODUCT_ANALYSIS',best>=60?`Product match found — ${best}%`:'Product match needs verification',best>=60?'Internal, Drive, manufacturer, IndiaMART and public research sources were orchestrated and cached where needed.':'No sufficiently strong exact product identity was found; precise unverified specifications were not invented.');
    addActivity(leadId,'PRICE_ANALYSIS',price.status==='AVAILABLE'?`Price intelligence ${price.reliability}`:'Price verification required',price.source||'No matching historical price found.');
    addActivity(leadId,'QUALIFICATION',`AI preliminary score ${score.ai_score}% — ${score.temperature}`,'Dynamic enquiry scoring completed.');
  }
  if(lead.live_classification==='LIVE'&&['HOT','VERY HOT'].includes(score.temperature)&&!lead.last_contact_at){
    const exists=db.prepare("SELECT id FROM notifications WHERE lead_id=? AND type='HOT_WAITING' AND is_read=0 LIMIT 1").get(leadId);if(!exists)db.prepare("INSERT INTO notifications(user_id,lead_id,type,message,is_read,created_at) VALUES (1,?,'HOT_WAITING',?,0,?)").run(leadId,`${lead.lead_code} is ${score.temperature} and not contacted.`,nowIso());
  }
  bumpDataRevision();
}
function findCustomerForLead(c={}){
  const ext=String(c.external_contact_id||'').trim();if(ext){const x=db.prepare('SELECT * FROM customers WHERE external_contact_id=? LIMIT 1').get(ext);if(x)return x;}
  if(c.email){const x=db.prepare('SELECT * FROM customers WHERE lower(email)=lower(?) LIMIT 1').get(c.email);if(x)return x;}
  const np=normalizePhone(c.phone);if(np){const x=db.prepare('SELECT * FROM customers WHERE normalized_phone=? LIMIT 1').get(np);if(x)return x;}
  if(c.company&&c.name){const x=db.prepare('SELECT * FROM customers WHERE lower(company)=lower(?) AND lower(name)=lower(?) LIMIT 1').get(c.company,c.name);if(x)return x;}
  return null;
}
function createLead(parsed, sourceType='MANUAL', options={}) {
  let leadId=null;db.exec('BEGIN');
  try {
    const c=parsed.customer||{}; const reqs=parsed.requirements||[]; if(!reqs.length) throw new Error('At least one product requirement is required.');
    let customer=findCustomerForLead(c);
    if(!customer) {
      const customerValues=[c.name||'Needs Confirmation',c.company,c.phone,c.email,c.address,c.city,c.state,c.country||null,c.pincode,nowIso()].map(v=>v===undefined?null:v);
      const cid=db.prepare(`INSERT INTO customers(name,company,phone,email,address,city,state,country,pincode,customer_since,external_contact_id,normalized_phone) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(...customerValues,c.external_contact_id||null,normalizePhone(c.phone)||null).lastInsertRowid;
      customer=db.prepare('SELECT * FROM customers WHERE id=?').get(cid);
    } else {
      db.prepare(`UPDATE customers SET company=COALESCE(NULLIF(?,''),company),phone=COALESCE(NULLIF(?,''),phone),normalized_phone=COALESCE(NULLIF(?,''),normalized_phone),email=COALESCE(NULLIF(?,''),email),address=COALESCE(NULLIF(?,''),address),city=COALESCE(NULLIF(?,''),city),state=COALESCE(NULLIF(?,''),state),country=COALESCE(NULLIF(?,''),country),updated_at=? WHERE id=?`).run(c.company,c.phone,normalizePhone(c.phone),c.email,c.address,c.city,c.state,c.country,nowIso(),customer.id);
    }
    const raw=String(parsed.raw_message||'');const receivedAt=validDateIso(options.receivedAt)||nowIso();
    const initialBudget=reqs.map(r=>Number(r.budget||r.price_expectation||0)).find(v=>Number.isFinite(v)&&v>0)||null;
    const purchaseIntent=/purchase order|\bpo\b|proforma|pro forma|ready to buy|place the order/i.test(raw)?'READY TO BUY':(/quotation|quote|best offer|best price|detailed offer/i.test(raw)?'INTERESTED':'JUST ENQUIRY');
    const urgency=/urgent|immediate|asap|today/i.test(raw)?'IMMEDIATE':/this week/i.test(raw)?'THIS WEEK':'UNKNOWN';
    const timeline=urgency==='IMMEDIATE'?'IMMEDIATE':urgency==='THIS WEEK'?'THIS WEEK':reqs.some(r=>r.required_delivery_date)?'THIS MONTH':'UNKNOWN';
    const requirementStatus=reqs.some(r=>r.application||r.required_specification||r.required_range||r.required_accuracy)?'CONFIRMED':'NEEDS CLARIFICATION';
    const budgetStatus=initialBudget?'CONFIRMED':'UNKNOWN';
    const previousCount=Number(db.prepare('SELECT COUNT(*) AS c FROM leads WHERE customer_id=?').get(customer.id)?.c||0);
    const code=leadCode();
    leadId=db.prepare(`INSERT INTO leads(lead_code,customer_id,source_type,raw_message,received_at,assigned_to,temperature,purchase_probability,ai_score,priority,pipeline_stage,requirement_status,budget_status,urgency,decision_maker,purchase_intent,timeline,response_status,demo,expected_value,live_classification,product_analysis_status,price_analysis_status,qualification_status,analysis_version,repeat_opportunity) VALUES (?,?,?,?,?,1,'COLD',0,0,'NORMAL','NEW',?,?,?,?,?,?, 'NOT CONTACTED',0,? ,?,'ANALYZING','SEARCHING','CALCULATING',0,?)`).run(code,customer.id,sourceType||parsed.source_type||'MANUAL',raw,receivedAt,requirementStatus,budgetStatus,urgency,'UNKNOWN',purchaseIntent,timeline,initialBudget,liveClassificationFor(receivedAt,sourceType||parsed.source_type||'MANUAL'),previousCount>0?1:0).lastInsertRowid;
    for (const req of reqs) {
      const statuses={product:req.product_name?'CONFIRMED':'NEEDS_CONFIRMATION',quantity:(Number(req.quantity)>0&&(req.quantity_provided===true||/\b(?:qty|quantity)\b/i.test(raw)||Number(req.quantity)!==1))?'CONFIRMED':'NEEDS_CONFIRMATION',brand:req.requested_brand?'CONFIRMED':'NOT_AVAILABLE',model:req.requested_model?'CONFIRMED':'NOT_AVAILABLE',application:req.application?'CONFIRMED':'NEEDS_CONFIRMATION',budget:req.budget?'CONFIRMED':'NEEDS_CONFIRMATION',required_delivery:req.required_delivery_date?'CONFIRMED':'NEEDS_CONFIRMATION',delivery:req.delivery_location?'CONFIRMED':'NOT_AVAILABLE',simple_choices:{...(req.source_choices||{})}};
      const reqValues=[leadId,req.product_name,req.requested_brand,req.requested_model,req.customer_reference,req.quantity||1,req.unit||'Piece',req.application,req.required_specification,req.required_accuracy,req.required_range,req.requested_features,req.requested_certification,req.requested_accessories,req.delivery_location,req.required_delivery_date,req.budget,req.price_expectation,req.preferred_brand,req.alternative_brand_accepted,req.catalogue_required?1:0,req.quotation_required?1:0,req.technical_datasheet_required?1:0,req.installation_required?1:0,req.calibration_required?1:0,req.other_notes,json(statuses)].map(v=>v===undefined?null:v);
      const rid=db.prepare(`INSERT INTO product_requirements(lead_id,product_name,requested_brand,requested_model,customer_reference,quantity,unit,application,required_specification,required_accuracy,required_range,requested_features,requested_certification,requested_accessories,delivery_location,required_delivery_date,budget,price_expectation,preferred_brand,alternative_brand_accepted,catalogue_required,quotation_required,technical_datasheet_required,installation_required,calibration_required,other_notes,status_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...reqValues).lastInsertRowid;
      db.prepare('INSERT INTO lead_products(lead_id,requirement_id,product_id,match_confidence,match_reason) VALUES (?,?,?,?,?)').run(leadId,rid,null,0,'Product analysis queued');
    }
    const firstReq=reqs[0];const cutoff=new Date(Date.parse(receivedAt)-72*3600000).toISOString();
    const dupe=db.prepare(`SELECT l.id,l.lead_code FROM leads l JOIN customers c2 ON c2.id=l.customer_id LEFT JOIN product_requirements pr2 ON pr2.id=(SELECT MIN(x.id) FROM product_requirements x WHERE x.lead_id=l.id) WHERE l.id<>? AND l.received_at>=? AND (l.customer_id=? OR (?<>'' AND c2.normalized_phone=? ) OR (?<>'' AND lower(c2.email)=lower(?))) AND lower(COALESCE(pr2.product_name,''))=lower(?) ORDER BY l.received_at DESC LIMIT 1`).get(leadId,cutoff,customer.id,normalizePhone(c.phone),normalizePhone(c.phone),String(c.email||''),String(c.email||''),firstReq.product_name||'');
    if(dupe)db.prepare('UPDATE leads SET possible_duplicate=1,duplicate_reason=? WHERE id=?').run(`Similar customer + product within 72 hours (${dupe.lead_code})`,leadId);
    ensurePlaybookForLead(leadId);
    addActivity(leadId,'LEAD_RECEIVED','Lead imported / created',`Source: ${sourceType||parsed.source_type||'MANUAL'} • ${liveClassificationFor(receivedAt,sourceType||parsed.source_type||'MANUAL')}`);
    addActivity(leadId,'AI_PARSE','Buyer requirement parsed','Customer and product requirement fields were structured from the enquiry without delaying lead display.');
    db.exec('COMMIT');bumpDataRevision();
  } catch (e) {try { db.exec('ROLLBACK'); } catch {} throw e;}
  enqueueLeadAnalysis(leadId,db.prepare('SELECT live_classification FROM leads WHERE id=?').get(leadId)?.live_classification||'LIVE');
  return hydrateLead(leadId);
}

let crmConnectionCache={mtimeMs:-1,value:null};
let crmSecretCache={mtimeMs:-1,value:''};
let crmAutoSyncState={enabled:false,running:false,last_attempt:null,last_mode:null,last_result:null,last_error:null};
function readCrmConnection() {
  if (!fs.existsSync(CRM_CONNECTION_PATH)) { crmConnectionCache={mtimeMs:-1,value:null}; return null; }
  try {
    const mtimeMs=fs.statSync(CRM_CONNECTION_PATH).mtimeMs;
    if(crmConnectionCache.mtimeMs===mtimeMs) return crmConnectionCache.value;
    const raw=fs.readFileSync(CRM_CONNECTION_PATH,'utf8').replace(/^\uFEFF/,'').trim();
    const value=raw?JSON.parse(raw):null;
    crmConnectionCache={mtimeMs,value};
    return value;
  } catch(e) {
    console.error('[LEADSPHERE CONFIG] Could not read company-crm.json:',e.message);
    return null;
  }
}
function readCrmSecret() {
  if (process.env.COMPANY_CRM_API_KEY) return process.env.COMPANY_CRM_API_KEY.trim();
  if (process.platform !== 'win32' || !fs.existsSync(CRM_SECRET_PATH)) return '';
  try {
    const mtimeMs=fs.statSync(CRM_SECRET_PATH).mtimeMs;
    if(crmSecretCache.mtimeMs===mtimeMs) return crmSecretCache.value;
    const value=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'scripts','read_crm_secret.ps1'),CRM_SECRET_PATH],{encoding:'utf8',windowsHide:true}).trim();
    crmSecretCache={mtimeMs,value};
    return value;
  } catch { return ''; }
}
function crmStatus() {
  const c=readCrmConnection(); const secret=readCrmSecret();
  const lastRun=db.prepare('SELECT * FROM company_crm_sync_runs ORDER BY id DESC LIMIT 1').get();
  const lastSuccess=db.prepare('SELECT * FROM company_crm_sync_runs WHERE success=1 ORDER BY id DESC LIMIT 1').get();
  return {
    configured:Boolean(c?.baseUrl&&secret),
    base_url:c?.baseUrl||null,
    active_base_url:db.prepare("SELECT value FROM app_settings WHERE key='company_crm_active_base_url'").get()?.value||c?.baseUrl||null,
    transport_error:db.prepare("SELECT value FROM app_settings WHERE key='company_crm_last_transport_error'").get()?.value||null,
    leads_path:c?.leadsPath||null,
    status_path:c?.statusPath||'/external-api/v1/status',
    sync_interval_seconds:Math.max(10,Math.min(20,Number(c?.syncIntervalSeconds)||20)),
    reconciliation_minutes:Math.max(1,Math.min(2,Number(c?.reconciliationMinutes)||2)),
    last_sync:db.prepare("SELECT value FROM app_settings WHERE key='company_crm_last_sync'").get()?.value||null,
    last_successful_sync:db.prepare("SELECT value FROM app_settings WHERE key='company_crm_last_success'").get()?.value||lastSuccess?.finished_at||null,
    last_error:db.prepare("SELECT value FROM app_settings WHERE key='company_crm_last_error'").get()?.value||null,
    api_latency_ms:Number(db.prepare("SELECT value FROM app_settings WHERE key='company_crm_last_latency_ms'").get()?.value||lastRun?.response_ms||0)||null,
    latest_lead:db.prepare(`SELECT lead_code,external_lead_id,received_at FROM leads WHERE source_type IN ('CRM','INDIAMART','EMAIL','WHATSAPP','WEBSITE') ORDER BY received_at DESC LIMIT 1`).get()||null,
    last_run:lastRun||null,
    last_success:lastSuccess||null,
    auto_sync:{...crmAutoSyncState}
  };
}

function saveSetting(key,value) {
  db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key,String(value??''),nowIso());
}

function isTailscaleIpv4(value=''){
  const m=String(value||'').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);if(!m)return false;
  const a=Number(m[1]),b=Number(m[2]);return a===100&&b>=64&&b<=127;
}
function crmNetworkErrorDetail(error,baseUrl=''){
  const code=String(error?.cause?.code||error?.code||'').toUpperCase();
  let host='LeadSphere server',port='';try{const u=new URL(baseUrl);host=u.hostname;port=u.port||((u.protocol==='https:')?'443':'80');}catch{}
  if(code==='ECONNREFUSED')return `LeadSphere machine is reachable, but the API service is not listening on port ${port||'5000'}. Start the LeadSphere API/server on ${host}.`;
  if(code==='ENOTFOUND'||code==='EAI_AGAIN')return `Tailscale/MagicDNS could not resolve ${host}. Check Tailscale on both PCs; the CRM will also try the peer Tailscale IP automatically.`;
  if(code==='ETIMEDOUT'||String(error?.name||'').includes('Timeout'))return `Connection to ${host}:${port||'5000'} timed out. Check Tailscale, Windows Firewall and that the LeadSphere API service is running.`;
  if(code==='ECONNRESET')return `Connection to ${host}:${port||'5000'} was reset. Restart the LeadSphere API service and check its firewall rule.`;
  return `LeadSphere network connection failed at ${host}${port?`:${port}`:''}. Check Tailscale and make sure the LeadSphere API/server is running.`;
}
function tailscalePeerIpv4s(hostname=''){
  if(process.platform!=='win32')return [];
  const wanted=String(hostname||'').toLowerCase().replace(/\.$/,'');const short=wanted.split('.')[0];
  const paths=['tailscale.exe','C:\\Program Files\\Tailscale\\tailscale.exe','C:\\Program Files (x86)\\Tailscale\\tailscale.exe'];
  for(const exe of paths){
    try{
      const raw=execFileSync(exe,['status','--json'],{encoding:'utf8',windowsHide:true,timeout:4000});const data=JSON.parse(raw);const peers=Object.values(data?.Peer||{});const out=[];
      for(const peer of peers){const dns=String(peer?.DNSName||'').toLowerCase().replace(/\.$/,'');const hn=String(peer?.HostName||'').toLowerCase();if(!(dns===wanted||dns.startsWith(short+'.')||hn===short))continue;for(const ip of (peer?.TailscaleIPs||[])){if(isTailscaleIpv4(ip))out.push(ip)}}
      if(out.length)return [...new Set(out)];
    }catch{}
  }
  return [];
}
async function crmBaseUrlCandidates(c={}){
  const raw=String(c?.baseUrl||'').trim();if(!raw)return [];
  let u;try{u=new URL(raw)}catch{return [raw]}
  const candidates=[raw.replace(/\/$/,'')];const addIp=ip=>{if(!isTailscaleIpv4(ip))return;const port=u.port?`:${u.port}`:'';candidates.push(`${u.protocol}//${ip}${port}`)};
  if(isTailscaleIpv4(u.hostname))addIp(u.hostname);
  else{
    try{for(const x of await dnsLookup(u.hostname,{all:true,family:4})){addIp(x.address)}}catch{}
    for(const ip of tailscalePeerIpv4s(u.hostname))addIp(ip);
  }
  return [...new Set(candidates)];
}
async function crmFetchWithRecovery(c,pathOrUrl,{headers={},params={},timeoutMs=30000}={}){
  const bases=await crmBaseUrlCandidates(c);let lastError=null;
  for(const base of bases){
    let endpoint;try{endpoint=new URL(pathOrUrl,base.endsWith('/')?base:base+'/')}catch(e){lastError=e;continue}
    for(const [k,v] of Object.entries(params||{}))if(v!==undefined&&v!==null&&v!=='')endpoint.searchParams.set(k,String(v));
    try{
      const response=await fetch(endpoint,{headers,signal:AbortSignal.timeout(Number(timeoutMs||30000))});
      saveSetting('company_crm_active_base_url',base);saveSetting('company_crm_last_transport_error','');
      return {response,endpoint,activeBaseUrl:base};
    }catch(e){lastError=e;saveSetting('company_crm_last_transport_error',String(e?.cause?.code||e?.message||e));}
  }
  const hint=crmNetworkErrorDetail(lastError,c?.baseUrl||'');
  const e=new Error(hint);e.cause=lastError;throw e;
}

function readJsonFile(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
function writePrivateJson(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2),'utf8');try{fs.chmodSync(file,0o600);}catch{}}
function activeLocalPort(){return Number(fs.existsSync(PORT_FILE)?fs.readFileSync(PORT_FILE,'utf8').toString().trim():0)||Number(process.env.CRM_PORT||config.port||8765);}
function templateBudgetText(template,d){const r=d.requirements?.[0]||{},c=d.customer||{};const model=String(r.requested_model||'').trim();const vars={customer_name:c.name||'Customer',company:c.company||'',product_name:r.product_name||'the requested product',model:model,model_line:model?` (Model: ${model})`:''};return String(template||'').replace(/\{(customer_name|company|product_name|model|model_line)\}/g,(_,k)=>vars[k]??'');}
function budgetRequestContent(d){const bodyTemplate=getSetting('budget_request_message',DEFAULT_BUDGET_REQUEST_MESSAGE)||DEFAULT_BUDGET_REQUEST_MESSAGE;const subjectTemplate=getSetting('budget_request_subject',DEFAULT_BUDGET_REQUEST_SUBJECT)||DEFAULT_BUDGET_REQUEST_SUBJECT;return {subject:templateBudgetText(subjectTemplate,d).replace(/[\r\n]+/g,' ').trim(),message:templateBudgetText(bodyTemplate,d).trim()};}
function normalizeWhatsAppPhone(phone,country='India'){let n=String(phone||'').replace(/\D/g,'');if(!n)return '';if(n.startsWith('00'))n=n.slice(2);if(n.startsWith('0')&&n.length===11)n=n.slice(1);const india=normalizeCountryBucket(country)==='INDIA';if(india&&n.length===10)n='91'+n;return n;}
function whatsappPersonalUrl(phone,message=''){const n=String(phone||'').replace(/\D/g,'');if(!n)throw new Error('Customer phone number is not available.');return `https://web.whatsapp.com/send?phone=${encodeURIComponent(n)}&text=${encodeURIComponent(String(message||''))}`;}
function gmailPersonalComposeUrl({to='',subject='',body=''}){if(!String(to||'').trim())throw new Error('Customer email is not available.');const q=new URLSearchParams({view:'cm',fs:'1',to:String(to).trim(),su:String(subject||''),body:String(body||'')});return `https://mail.google.com/mail/?${q.toString()}`;}
function customerMessagingStatus(){return {whatsapp:{shared_server:false,mode:'PERSONAL_BROWSER',configured:true},whatsapp_web:{enabled:true,personal_browser:true,shared_server:false,web_url:'https://web.whatsapp.com/'},gmail:{shared_server:false,personal_browser:true,authorized:true,client_configured:false,account_email:null,web_url:'https://mail.google.com/',mode:'PERSONAL_BROWSER'},templates:{budget_request_subject:getSetting('budget_request_subject',DEFAULT_BUDGET_REQUEST_SUBJECT)||DEFAULT_BUDGET_REQUEST_SUBJECT,budget_request_message:getSetting('budget_request_message',DEFAULT_BUDGET_REQUEST_MESSAGE)||DEFAULT_BUDGET_REQUEST_MESSAGE}};}

function roundMoney(v){return Math.round(Number(v||0)*100)/100;}
function refreshLimitedOfferExpiry(leadId=null){
  const stamp=nowIso();
  const rows=leadId?db.prepare("SELECT id,lead_id FROM limited_time_offers WHERE lead_id=? AND status='ACTIVE' AND expires_at IS NOT NULL AND expires_at<=?").all(leadId,stamp):db.prepare("SELECT id,lead_id FROM limited_time_offers WHERE status='ACTIVE' AND expires_at IS NOT NULL AND expires_at<=?").all(stamp);
  if(!rows.length)return 0;
  const upd=db.prepare("UPDATE limited_time_offers SET status='EXPIRED',updated_at=? WHERE id=? AND status='ACTIVE'");
  for(const row of rows){upd.run(stamp,row.id);recordLimitedOfferStatus(row.id,row.lead_id,'EXPIRED','Offer validity ended without acceptance.');addActivity(row.lead_id,'LIMITED_OFFER','Limited-time offer expired','Offer validity ended without acceptance.');}
  return rows.length;
}
function latestLimitedOfferForLead(leadId){
  refreshLimitedOfferExpiry(leadId);
  const row=db.prepare('SELECT * FROM limited_time_offers WHERE lead_id=? ORDER BY id DESC LIMIT 1').get(leadId)||null;
  if(!row)return null;
  const now=Date.now(),exp=row.expires_at?Date.parse(row.expires_at):NaN,history=db.prepare('SELECT status,changed_at,note FROM limited_offer_status_history WHERE offer_id=? ORDER BY id').all(row.id);
  return {...row,status_history:history,remaining_seconds:row.status==='ACTIVE'&&Number.isFinite(exp)?Math.max(0,Math.ceil((exp-now)/1000)):0};
}
function offerPriceContext(leadId,b={}){
  const d=hydrateLead(leadId);if(!d)throw new Error('Lead not found');
  const p=d.price_intelligence||{},online=p.online_price||{};
  const market=String(b.market_type||d.lead?.market_type_override||online.market_type||normalizeCountryBucket(d.customer?.country||'')).toUpperCase()==='EXPORT'?'EXPORT':'INDIA';
  const minMargin=market==='EXPORT'?EXPORT_MARGIN_MIN:INDIA_MARGIN_MIN;
  const maxMargin=market==='EXPORT'?EXPORT_MARGIN_MAX:INDIA_MARGIN_MAX;
  let regularMargin=Number(b.regular_margin_percent??online.margin_percent??p.margin_percent??DEFAULT_MARGIN_PERCENT);
  if(!Number.isFinite(regularMargin))regularMargin=DEFAULT_MARGIN_PERCENT;
  regularMargin=Math.min(maxMargin,Math.max(minMargin,regularMargin));
  const enteredRegular=Number(b.regular_selling_price||0),explicitBase=Number(b.base_price||online.original_price||0);if(!(explicitBase>0)&&enteredRegular>0)regularMargin=maxMargin;
  const base=explicitBase>0?explicitBase:(enteredRegular>0?enteredRegular/(1+regularMargin/100):0);
  if(!(base>0))throw new Error('Enter the Online Price or Regular Selling Price before creating a limited-time offer.');
  const floorPrice=roundMoney(base*(1+minMargin/100));
  const regularSelling=Math.max(floorPrice,roundMoney(Number(b.regular_selling_price)||base*(1+regularMargin/100)));
  const maxDiscount=Math.max(0,Math.floor(((1-(floorPrice/regularSelling))*100)*100)/100);
  let requested=Number(b.discount_percent);
  if(!Number.isFinite(requested))requested=Math.min(5,maxDiscount);
  const requestedOffer=Number(b.offer_price);
  let offerPrice,discount;
  if(Number.isFinite(requestedOffer)&&requestedOffer>0){
    offerPrice=roundMoney(Math.min(regularSelling,Math.max(floorPrice,requestedOffer)));
    discount=regularSelling>0?roundMoney((1-offerPrice/regularSelling)*100):0;
  }else{
    discount=Math.max(0,Math.min(maxDiscount,requested));
    const rawOffer=roundMoney(regularSelling*(1-discount/100));
    offerPrice=Math.max(floorPrice,rawOffer);
  }
  const effectiveDiscount=regularSelling>0?roundMoney((1-offerPrice/regularSelling)*100):0;
  let validity=Math.round(Number(b.validity_minutes||10));if(!Number.isFinite(validity))validity=10;validity=Math.min(1440,Math.max(1,validity));
  return {d,market,base_price:roundMoney(base),regular_margin_percent:regularMargin,minimum_margin_percent:minMargin,maximum_margin_percent:maxMargin,regular_selling_price:regularSelling,minimum_offer_price:floorPrice,max_discount_percent:maxDiscount,discount_percent:effectiveDiscount,offer_price:roundMoney(offerPrice),validity_minutes:validity};
}
function limitedOfferMessage(ctx){
  const d=ctx.d,r=d.requirements?.[0]||{},c=d.customer||{},model=String(r.requested_model||'').trim();
  const money=n=>`₹${Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:0,maximumFractionDigits:2})}`;
  const validity=ctx.validity_minutes===1?'1 minute':`${ctx.validity_minutes} minutes`;
  const subject=`Limited-Time Offer - ${r.product_name||'Product'}`;
  const message=[`Dear ${c.name||'Customer'},`,'',`Limited-time offer for ${r.product_name||'the requested product'}${model?` (Model: ${model})`:''}.`,`Regular price: ${money(ctx.regular_selling_price)}`,`Offer price: ${money(ctx.offer_price)}${ctx.discount_percent>0?` (${ctx.discount_percent}% discount)`:''}`,`Validity: ${validity} from the time this message is sent.`,`Reply ACCEPT to confirm this offer.`,'','Regards,','Nunes Instrumentation'].join('\n');
  return {subject,message};
}
function recordLimitedOfferStatus(offerId,leadId,status,note=''){db.prepare('INSERT INTO limited_offer_status_history(offer_id,lead_id,status,changed_at,note) VALUES (?,?,?,?,?)').run(offerId,leadId,String(status||'').toUpperCase(),nowIso(),String(note||'').trim()||null)}
function prepareLimitedOffer(leadId,b={},channel=''){
  const ctx=offerPriceContext(leadId,b),content=limitedOfferMessage(ctx),r=ctx.d.requirements?.[0]||{},stamp=nowIso();
  const result=db.prepare(`INSERT INTO limited_time_offers(lead_id,requirement_id,product_name,channel,base_price,regular_selling_price,regular_margin_percent,minimum_margin_percent,discount_percent,offer_price,validity_minutes,status,message,prepared_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(leadId,r.id||null,r.product_name||null,String(channel||'').toUpperCase()||null,ctx.base_price,ctx.regular_selling_price,ctx.regular_margin_percent,ctx.minimum_margin_percent,ctx.discount_percent,ctx.offer_price,ctx.validity_minutes,'DRAFT',content.message,stamp,stamp,'Sebastian Nunes');
  const offerId=Number(result.lastInsertRowid);recordLimitedOfferStatus(offerId,leadId,'DRAFT','Offer prepared for salesperson review.');
  return {id:offerId,ctx,content};
}
function activateLimitedOffer(offerId,channel){
  const row=db.prepare('SELECT * FROM limited_time_offers WHERE id=?').get(offerId);if(!row)throw new Error('Offer not found');
  const stamp=nowIso(),expires=new Date(Date.now()+Math.max(1,Number(row.validity_minutes||10))*60000).toISOString();
  db.prepare("UPDATE limited_time_offers SET channel=?,status='ACTIVE',sent_at=?,expires_at=?,updated_at=? WHERE id=?").run(String(channel||row.channel||'').toUpperCase(),stamp,expires,stamp,offerId);
  recordLimitedOfferStatus(offerId,row.lead_id,'SENT',`Message sent by ${String(channel||row.channel||'').toUpperCase()}.`);recordLimitedOfferStatus(offerId,row.lead_id,'ACTIVE',`Countdown started for ${row.validity_minutes} minute(s).`);
  db.prepare("UPDATE limited_time_offers SET status='EXPIRED',updated_at=? WHERE lead_id=? AND id<>? AND status='ACTIVE'").run(stamp,row.lead_id,offerId);
  addActivity(row.lead_id,'LIMITED_OFFER',`Limited-time offer sent by ${String(channel||row.channel||'').toUpperCase()}`,`Offer ₹${Number(row.offer_price||0).toLocaleString('en-IN')} • valid ${row.validity_minutes} min • expires ${expires}.`);
  return db.prepare('SELECT * FROM limited_time_offers WHERE id=?').get(offerId);
}

function googleOAuthConfigured(){return Boolean(String(process.env.GOOGLE_CLIENT_ID||'').trim()&&String(process.env.GOOGLE_CLIENT_SECRET||'').trim());}
function googleRedirectUri(){const active=Number(fs.existsSync(PORT_FILE)?fs.readFileSync(PORT_FILE,'utf8').toString().trim():0)||Number(process.env.CRM_PORT||config.port||8765);return `http://127.0.0.1:${active}/api/google/oauth/callback`;}
async function refreshGoogleAccessToken(auth){
  if(!auth?.refresh_token||!googleOAuthConfigured())return null;
  const body=new URLSearchParams({client_id:String(process.env.GOOGLE_CLIENT_ID),client_secret:String(process.env.GOOGLE_CLIENT_SECRET),refresh_token:String(auth.refresh_token),grant_type:'refresh_token'});
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});if(!r.ok)throw new Error(`Google authorization refresh failed (${r.status}).`);const x=await r.json();
  const next={...auth,...x,refresh_token:auth.refresh_token,expires_at:Date.now()+Math.max(60,Number(x.expires_in||3600)-60)*1000,updated_at:nowIso()};writeGoogleAuth(GOOGLE_AUTH_PATH,next);return next.access_token||null;
}
async function googleAccessToken(){const auth=readGoogleAuth(GOOGLE_AUTH_PATH);if(!auth)return null;if(auth.access_token&&Number(auth.expires_at||0)>Date.now()+60000)return auth.access_token;try{return await refreshGoogleAccessToken(auth)}catch(e){console.warn('[GOOGLE DRIVE]',e.message);return null;}}
async function listGooglePriceFiles(){
  const token=await googleAccessToken();if(!token){const e=new Error('Connect the Admin Google account to browse private Google Drive files.');e.status=401;e.authorization_required=true;throw e;}
  const q="trashed = false and (mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' or mimeType = 'text/csv')";
  const u=new URL('https://www.googleapis.com/drive/v3/files');u.searchParams.set('q',q);u.searchParams.set('pageSize','50');u.searchParams.set('orderBy','modifiedTime desc');u.searchParams.set('fields','files(id,name,mimeType,modifiedTime,size,webViewLink)');
  const r=await fetch(u,{headers:{Authorization:`Bearer ${token}`}});if(!r.ok){const e=new Error(r.status===403?'Google Drive access was denied. Reconnect the Admin Google account.':`Google Drive file list failed (${r.status}).`);e.status=r.status;throw e;}
  const j=await r.json();return (j.files||[]).map(f=>({...f,url:f.webViewLink||(f.mimeType==='application/vnd.google-apps.spreadsheet'?`https://docs.google.com/spreadsheets/d/${f.id}/edit`:`https://drive.google.com/file/d/${f.id}/view`)}));
}
const GOOGLE_SHEET_PRICE_PROVIDER=new GoogleSheetPriceProvider({dataDir:DATA_DIR,defaultUrl:DEFAULT_PRICE_SHEET_URL,getAccessToken:googleAccessToken,oauthConfigured:googleOAuthConfigured,searchProducts:requirement=>PRODUCT_PROVIDERS?.find?.(x=>x?.name==='Company Product Master File')?.search?.(requirement)||[],logger:console});
let priceSourceBusy=false;
function configuredPriceSourceUrl(){return String(getSetting('price_source_url','')||getSetting('price_source_pending_url','')||DEFAULT_PRICE_SHEET_URL||'').trim();}
async function connectCompanyPriceSource(link,{refresh=false}={}){
  const target=String(link||configuredPriceSourceUrl()).trim();if(!target)throw new Error('No Google Sheet price source is configured.');
  if(priceSourceBusy){const e=new Error('Price data synchronization is already running.');e.status=409;throw e;}
  priceSourceBusy=true;saveSetting('price_source_pending_url',target);
  try{const meta=refresh?await GOOGLE_SHEET_PRICE_PROVIDER.sync(target):await GOOGLE_SHEET_PRICE_PROVIDER.connect(target);saveSetting('price_source_url',target);saveSetting('price_source_pending_url','');saveSetting('price_source_last_updated',meta.last_updated||'');saveSetting('price_source_rows',meta.rows||0);return meta;}
  finally{priceSourceBusy=false;}
}
function priceSourceAdminStatus(){const s=GOOGLE_SHEET_PRICE_PROVIDER.getStatus(),auth=readGoogleAuth(GOOGLE_AUTH_PATH),saved=getSetting('price_source_url',''),pending=getSetting('price_source_pending_url','');return {...s,url:s.url||saved||pending||DEFAULT_PRICE_SHEET_URL||null,default_url:DEFAULT_PRICE_SHEET_URL||null,oauth_configured:googleOAuthConfigured(),authorized:Boolean(auth?.refresh_token||auth?.access_token),pending_url:pending||null,busy:priceSourceBusy};}
function priceSourceHealth(){const s=priceSourceAdminStatus();return {state:s.state||'DISCONNECTED',sheet_connected:Boolean(s.connected),index_ready:Boolean(s.index_ready),indexed_rows:Number(s.rows||0),sheets_detected:Number(s.sheets_detected||s.sheets?.length||0),sheets_indexed:Number(s.sheets_indexed||0),last_sync:s.last_successful_sync||s.last_updated||null,using_cached:Boolean(s.using_cached),last_error:s.last_error||null};}
function firstValue(obj,paths) {
  for(const p of paths){let v=obj;for(const k of p.split('.'))v=v?.[k];if(v!==undefined&&v!==null&&v!=='')return v;} return null;
}
function firstPresent(obj,paths){for(const p of paths){let v=obj,ok=true;for(const k of p.split('.')){if(v==null||!Object.prototype.hasOwnProperty.call(Object(v),k)){ok=false;break}v=v[k];}if(ok&&v!==undefined&&v!==null)return {present:true,value:v,path:p};}return {present:false,value:null,path:null};}
function booleanChoice(value){if(value===true||value===1)return 'YES';if(value===false||value===0)return 'NO';const x=String(value??'').trim().toUpperCase();if(['YES','Y','TRUE','1','REQUIRED','REQUESTED'].includes(x))return 'YES';if(['NO','N','FALSE','0','NOT REQUIRED','NOT REQUESTED'].includes(x))return 'NO';return '';}
function crmLeadToParsed(row) {
  const name=firstValue(row,['lead_name','customer_name','contact_name','name','customer.name','contact.name','full_name']);
  const company=firstValue(row,['company','company_name','organization','account.name','customer.company']);
  const product=firstValue(row,['product_name','product','requirement.product_name','requirement','subject','title']);
  const quantityRaw=firstPresent(row,['quantity','qty','requirement.quantity']),quantity=quantityRaw.present?(Number(quantityRaw.value)||null):1;
  const raw=firstValue(row,['raw_message','message','description','notes','requirement','enquiry'])||JSON.stringify(row);
  const deliveryDate=firstValue(row,['required_delivery_date','delivery_date','purchase_date','expected_purchase_date']);
  const quoteDirect=firstPresent(row,['quotation_required','requirement.quotation_required']),quoteSent=Boolean(firstValue(row,['quotation_sent']));
  const catalogueDirect=firstPresent(row,['catalogue_required','catalog_required','requirement.catalogue_required']);
  const datasheetDirect=firstPresent(row,['technical_datasheet_required','datasheet_required','requirement.datasheet_required']);
  const calibrationDirect=firstPresent(row,['calibration_required','requirement.calibration_required']);
  const installationDirect=firstPresent(row,['installation_required','requirement.installation_required']);
  const sourceChoices={};
  const setChoice=(key,direct,positiveRegex)=>{let c=direct.present?booleanChoice(direct.value):'';if(!c&&positiveRegex?.test(String(raw)))c='YES';if(c)sourceChoices[key]=c;return c==='YES';};
  const quoteFlag=setChoice('quotation_required',quoteDirect,/quotation|quote|best offer|detailed offer/i)||quoteSent;
  if(quoteSent)sourceChoices.quotation_required='YES';
  const catalogueFlag=setChoice('catalogue_required',catalogueDirect,/catalog(?:ue|og)/i);
  const datasheetFlag=setChoice('datasheet_required',datasheetDirect,/datasheet|data sheet/i);
  const calibrationFlag=setChoice('calibration_required',calibrationDirect,/calibration/i);
  const installationFlag=setChoice('installation_required',installationDirect,/installation|install at site|commissioning/i);
  return {customer:{name:name||'Needs Confirmation',company,external_contact_id:firstValue(row,['contact_id','customer_id','external_contact_id','contact.id','customer.id']),phone:firstValue(row,['mobile','phone','phone_number','customer.phone','contact.phone']),email:firstValue(row,['email','email_address','customer.email','contact.email']),address:firstValue(row,['address','customer.address']),city:firstValue(row,['city','customer.city']),state:firstValue(row,['state','customer.state']),country:firstValue(row,['country','customer.country']),pincode:firstValue(row,['pincode','postal_code','zip'])},requirements:[{product_name:product||'Needs Confirmation',requested_brand:firstValue(row,['brand','preferred_brand']),requested_model:firstValue(row,['model','product_model']),quantity:quantity||1,quantity_provided:quantityRaw.present,unit:firstValue(row,['unit','uom'])||'Piece',application:firstValue(row,['application','usage']),required_specification:firstValue(row,['specification','requirement','requirements']),required_accuracy:firstValue(row,['accuracy','required_accuracy']),required_range:firstValue(row,['range','required_range']),requested_features:firstValue(row,['features','requested_features']),requested_certification:firstValue(row,['certification','certificate']),delivery_location:firstValue(row,['delivery_location','location']),required_delivery_date:deliveryDate,budget:Number(firstValue(row,['budget','expected_value']))||extractBudgetAmount(raw)||null,catalogue_required:catalogueFlag,quotation_required:quoteFlag,technical_datasheet_required:datasheetFlag,installation_required:installationFlag,calibration_required:calibrationFlag,source_choices:sourceChoices,other_notes:String(raw)}],raw_message:String(raw),source_type:'CRM'};
}

function externalEventId(row) {
  const direct=String(firstValue(row,['event_id','external_event_id','idempotency_key'])||'').trim();
  if(direct) return direct;
  const leadId=String(firstValue(row,['lead_id','id','leadId','uuid','reference'])||'').trim();
  if(leadId) return `lead:${leadId}`;
  const fallback=[firstValue(row,['mobile','phone']),firstValue(row,['email']),firstValue(row,['product_name','product']),String(firstValue(row,['received_at','created_at'])||'').slice(0,10)].join('|');
  return `fallback:${stableHash(fallback).slice(0,32)}`;
}

function sourceTypeForRow(row) {
  const text=[row.lead_source,row.external_source,row.source_account_name,row.source_account_id].filter(Boolean).join(' ').toLowerCase();
  if(text.includes('indiamart')||text.includes('sf site')||text.includes('krishna site')||text.includes('mohammed site')) return 'INDIAMART';
  if(text.includes('whatsapp')) return 'WHATSAPP';
  if(text.includes('email')||text.includes('mail')) return 'EMAIL';
  if(text.includes('website')||text.includes('web')) return 'WEBSITE';
  return 'CRM';
}

function deepPhotoCandidate(value,depth=0){
  if(depth>5||value==null)return '';
  if(typeof value==='string'){
    const t=value.trim();
    if(/^data:image\//i.test(t)||/^https?:\/\//i.test(t)||/\.(?:png|jpe?g|webp|gif|bmp)(?:\?|$)/i.test(t))return t;
    return '';
  }
  if(Array.isArray(value)){for(const x of value){const hit=deepPhotoCandidate(x,depth+1);if(hit)return hit;}return '';}
  if(typeof value!=='object')return '';
  const keys=Object.keys(value);
  const preferred=keys.filter(k=>/(photo|avatar|profile.?pic|profile.?image|image.?url|picture)/i.test(k));
  for(const k of preferred){const hit=deepPhotoCandidate(value[k],depth+1)||String(value[k]??'').trim();if(hit)return hit;}
  const ownerish=keys.filter(k=>/(assigned|owner|staff|sales|user|employee|agent)/i.test(k));
  for(const k of ownerish){const hit=deepPhotoCandidate(value[k],depth+1);if(hit)return hit;}
  return '';
}
function crmStaffPhotoValue(row){
  return firstValue(row,[
    'assigned_user_photo_url','assigned_user_photo','assigned_user_image_url','assigned_user_image','assigned_user_avatar_url','assigned_user_avatar','assigned_user_profile_picture','assigned_user_profile_image',
    'lead_owner_photo_url','lead_owner_photo','lead_owner_image','lead_owner_avatar','owner_photo_url','owner_photo','owner_image','owner_avatar','profile_photo_url','profile_photo','profile_image_url','profile_image','profile_picture','picture','photo_url','avatar_url','image_url','image',
    'assigned_user.photo_url','assigned_user.photo','assigned_user.image_url','assigned_user.image','assigned_user.avatar_url','assigned_user.avatar','assigned_user.profile_photo','assigned_user.profile_image','assigned_user.profile_picture',
    'owner.photo_url','owner.photo','owner.image_url','owner.image','owner.avatar','owner.profile_photo','owner.profile_image','user.photo_url','user.photo','user.image_url','user.image','user.avatar','user.profile_photo','user.profile_image'
  ])||deepPhotoCandidate(row);
}
function normalizeCrmStaffPhoto(value){
  const raw=String(value||'').trim();if(!raw)return '';
  if(/^data:image\//i.test(raw)||/^https?:\/\//i.test(raw))return raw;
  const c=readCrmConnection()||{};if(!c.baseUrl)return raw;
  try{
    if(raw.startsWith('/'))return new URL(raw,c.baseUrl).toString();
    if(/[\\/]/.test(raw))return new URL(raw.replace(/^\.\//,''),String(c.baseUrl).replace(/\/?$/,'/')).toString();
    // LeadSphere may expose only the stored image filename. /uploads/ is the most common public upload path;
    // if it is not reachable, the UI safely falls back to initials instead of breaking the dashboard.
    return new URL(`uploads/${encodeURIComponent(raw)}`,String(c.baseUrl).replace(/\/?$/,'/')).toString();
  }catch{return raw;}
}

function crmAuthHeaders(c,secret,accept='application/json'){
  const headers={'Accept':accept,'X-Client-ID':c.clientId||`nunes-ai-crm-${os.hostname().toLowerCase()}`,'X-Client-Name':c.clientName||'NUNES AI CRM'};
  headers[c.authHeader||'Authorization']=(Object.hasOwn(c,'authScheme')?String(c.authScheme):'Bearer ')+secret;
  return headers;
}
function crmDirectoryRows(body){
  if(Array.isArray(body))return body;
  return firstValue(body||{},['data.users','data.staff','data.employees','data.team','data.items','data.records','users','staff','employees','team','items','records','results'])||[];
}
function crmDirectoryIdentity(row){
  return {id:String(firstValue(row,['id','user_id','staff_id','employee_id','assigned_user_id','uuid'])||'').trim(),name:String(firstValue(row,['name','full_name','display_name','user_name','staff_name','employee_name'])||'').trim()};
}
async function syncCrmStaffDirectory(){
  const c=readCrmConnection(),secret=readCrmSecret();if(!c?.baseUrl||!secret)return {updated:0,path:null};
  const candidates=[c.usersPath,c.staffPath,getSetting('company_crm_staff_path',''),'/external-api/v1/users','/external-api/v1/staff','/external-api/v1/team','/api/users','/api/staff'].filter(Boolean);
  const seen=new Set();let rows=[],usedPath=null;
  for(const candidate of candidates){const key=String(candidate);if(seen.has(key))continue;seen.add(key);try{const endpoint=new URL(key,c.baseUrl),r=await fetch(endpoint,{headers:crmAuthHeaders(c,secret),signal:AbortSignal.timeout(Math.min(4500,Number(c.timeoutMs||4500)))});if(!r.ok)continue;const body=await r.json().catch(()=>null),list=crmDirectoryRows(body);if(Array.isArray(list)&&list.length){rows=list;usedPath=key;break;}}catch{}}
  let updated=0;
  for(const row of rows){
    const ident=crmDirectoryIdentity(row),photo=normalizeCrmStaffPhoto(crmStaffPhotoValue(row));if(!ident.name&&!ident.id)continue;
    let local=null;
    if(ident.id)local=db.prepare("SELECT u.id FROM external_owner_mappings m JOIN users u ON u.id=m.local_user_id WHERE m.external_system='LeadSphere' AND m.active=1 AND m.external_user_id=? ORDER BY m.id DESC LIMIT 1").get(ident.id);
    if(!local&&ident.name)local=db.prepare('SELECT id FROM users WHERE active=1 AND lower(name)=lower(?) LIMIT 1').get(ident.name);
    if(!local)continue;
    const current=db.prepare('SELECT name,email,designation,phone,photo_data FROM users WHERE id=?').get(local.id);if(!current)continue;
    const email=String(firstValue(row,['email','email_address','work_email'])||current.email||'').trim();
    const phone=String(firstValue(row,['phone','mobile','phone_number','mobile_number'])||current.phone||'').trim();
    const designation=String(firstValue(row,['designation','title','role_name','job_title'])||current.designation||'Sales Team').trim();
    const finalName=ident.name||current.name,bundled=bundledStaffPhotoRef(finalName);
    db.prepare('UPDATE users SET name=?,email=?,designation=?,phone=?,photo_data=? WHERE id=?').run(finalName,email||null,designation||'Sales Team',phone||null,bundled||photo||current.photo_data,local.id);updated++;
  }
  const bundledUpdated=applyBundledStaffPhotos();updated+=bundledUpdated;
  if(usedPath||bundledUpdated){if(usedPath)saveSetting('company_crm_staff_path',usedPath);saveSetting('company_crm_staff_photo_sync_at',nowIso());saveSetting('company_crm_staff_photo_sync_count',String(updated));if(updated)bumpDataRevision();}
  return {updated,path:usedPath,bundled_photos:bundledUpdated};
}
async function staffPhotoBuffer(userId){
  const row=db.prepare('SELECT name,photo_data FROM users WHERE id=? AND active=1').get(Number(userId));let raw=String(row?.photo_data||'').trim();
  const bundled=bundledStaffPhotoRef(row?.name||'');if(bundled&&raw!==bundled){db.prepare('UPDATE users SET photo_data=? WHERE id=?').run(bundled,Number(userId));raw=bundled;}
  if(!raw)return null;
  if(raw.startsWith('local:')){
    const rel=raw.slice(6).replace(/\\/g,'/').replace(/^\/+/,''),target=path.resolve(PUBLIC_DIR,rel),base=path.resolve(PUBLIC_DIR)+path.sep;
    if(!target.startsWith(base)||!fs.existsSync(target)||!fs.statSync(target).isFile())return null;
    return {buffer:fs.readFileSync(target),type:imageMimeForFile(target)};
  }
  const data=raw.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);if(data)return {buffer:Buffer.from(data[2],'base64'),type:data[1]};
  const c=readCrmConnection()||{},secret=readCrmSecret();let target=raw;try{if(!/^https?:\/\//i.test(target)&&c.baseUrl)target=new URL(target,c.baseUrl).toString();}catch{}
  if(!/^https?:\/\//i.test(target))return null;
  const base=String(c.baseUrl||'').replace(/\/$/,'');const headers=secret&&base&&target.startsWith(base)?crmAuthHeaders(c,secret,'image/*'):{Accept:'image/*'};
  const r=await fetch(target,{headers,signal:AbortSignal.timeout(6000)});if(!r.ok)return null;const type=String(r.headers.get('content-type')||'image/jpeg');if(!type.startsWith('image/'))return null;return {buffer:Buffer.from(await r.arrayBuffer()),type};
}

function syncExternalStaffProfile(userId,row,extName=''){
  const id=Number(userId);if(!id)return;
  const current=db.prepare('SELECT name,email,designation,phone,photo_data FROM users WHERE id=?').get(id);if(!current)return;
  const name=String(extName||firstValue(row,['lead_owner','assigned_user_name','assigned_user.name','owner.name','user.name'])||'').trim();
  const email=String(firstValue(row,['assigned_user_email','lead_owner_email','owner_email','assigned_user.email','owner.email','user.email'])||'').trim();
  const phone=String(firstValue(row,['assigned_user_phone','assigned_user_mobile','lead_owner_phone','owner_phone','assigned_user.phone','assigned_user.mobile','owner.phone','user.phone'])||'').trim();
  const designation=String(firstValue(row,['assigned_user_designation','lead_owner_designation','owner_designation','assigned_user.designation','owner.designation','user.designation'])||'').trim();
  const photo=normalizeCrmStaffPhoto(crmStaffPhotoValue(row)),finalName=name||current.name,bundled=bundledStaffPhotoRef(finalName);
  db.prepare(`UPDATE users SET name=?,email=?,designation=?,phone=?,photo_data=? WHERE id=?`).run(
    finalName,email||current.email,designation||current.designation||'Sales Team',phone||current.phone,bundled||photo||current.photo_data,id
  );
}

function resolveExternalOwner(row) {
  const extId=String(row.assigned_user_id??'').trim();
  const extName=String(row.lead_owner||row.assigned_user_name||'').trim();
  if(!extId&&!extName) return 1;
  let mapping=db.prepare(`SELECT * FROM external_owner_mappings WHERE external_system='LeadSphere' AND active=1 AND ((external_user_id<>'' AND external_user_id=?) OR (external_user_name<>'' AND lower(external_user_name)=lower(?))) ORDER BY id DESC LIMIT 1`).get(extId,extName);
  if(mapping?.local_user_id){const id=Number(mapping.local_user_id);syncExternalStaffProfile(id,row,extName);return id;}
  let user=extName?db.prepare('SELECT id FROM users WHERE active=1 AND lower(name)=lower(?) LIMIT 1').get(extName):null;
  if(!user&&extName) {
    const team=db.prepare('SELECT id FROM teams ORDER BY id LIMIT 1').get();
    const email=`${normalizeText(extName).replace(/ /g,'.')||'user'}@leadsphere.local`;
    const id=db.prepare(`INSERT INTO users(name,email,role,team_id,active) VALUES (?,?,?,?,1)`).run(extName,email,'SALESPERSON',team?.id||null).lastInsertRowid;
    user={id};
    syncExternalStaffProfile(Number(id),row,extName);
  }
  const localId=Number(user?.id||1);
  syncExternalStaffProfile(localId,row,extName);
  db.prepare(`INSERT OR IGNORE INTO external_owner_mappings(external_system,external_user_id,external_user_name,local_user_id,active,created_at,updated_at) VALUES ('LeadSphere',?,?,?,?,?,?)`).run(extId,extName,localId,1,nowIso(),nowIso());
  return localId;
}

function syncSignature(row) {
  // Hash every CRM field that can materially change what staff see. This fixes
  // updates that previously looked "unchanged" when only model/spec/budget/etc changed.
  return stableHash(JSON.stringify({
    event_id:externalEventId(row),updated_at:row.updated_at||row.modified_at||row.received_at||'',
    owner:row.assigned_user_id||row.lead_owner||row.assigned_user_name||'',status:row.status||row.lead_status||'',
    customer:row.lead_name||row.customer_name||row.contact_name||'',company:row.company||row.company_name||'',mobile:row.mobile||row.phone||'',email:row.email||'',
    city:row.city||'',state:row.state||'',country:row.country||'',product:row.product_name||row.product||'',brand:row.brand||row.preferred_brand||'',model:row.model||row.product_model||'',
    quantity:row.quantity??row.qty??'',unit:row.unit||row.uom||'',application:row.application||row.usage||'',requirement:row.requirement||row.requirements||row.specification||'',
    accuracy:row.accuracy||row.required_accuracy||'',range:row.range||row.required_range||'',features:row.features||row.requested_features||'',certification:row.certification||row.certificate||'',
    delivery_location:row.delivery_location||row.location||'',delivery_date:row.required_delivery_date||row.delivery_date||row.purchase_date||row.expected_purchase_date||'',
    budget:row.budget??row.expected_value??'',catalogue_required:row.catalogue_required??row.catalog_required??'',datasheet_required:row.technical_datasheet_required??row.datasheet_required??'',
    calibration_required:row.calibration_required??'',installation_required:row.installation_required??'',raw_message:row.raw_message||row.message||row.description||row.notes||row.enquiry||'',
    source:row.lead_source||row.external_source||'',site:row.source_account_name||row.source_account_id||'',lead_group:row.lead_group||'',country_bucket:row.country_bucket||'',
    quotation_required:row.quotation_required??'',quotation_sent:Boolean(row.quotation_sent),quotation_no:row.quotation_no||'',quotation_by:row.quotation_sent_by||'',quotation_at:row.quotation_sent_at||''
  }));
}

function updateExistingExternalLead(existing,row) {
  const parsed=crmLeadToParsed(row), c=parsed.customer||{}, req=parsed.requirements?.[0]||{};
  const ownerId=resolveExternalOwner(row), sig=syncSignature(row);
  if(String(existing.sync_signature||'')===sig) return {changed:false,id:existing.id};
  // Data-safety rule: once a staff member has saved this lead, CRM refresh may fill
  // missing values but must not replace non-empty staff work. No legacy row is migrated/cleared.
  const staffSaved=Boolean(existing.form_last_saved_at||existing.form_completed_at);
  const useful=v=>{const t=String(v??'').trim();return t&&!/^(needs confirmation|not available)$/i.test(t)};
  const mergeText=(oldVal,newVal)=>{if(!useful(newVal))return oldVal??null;if(staffSaved&&useful(oldVal))return oldVal;return String(newVal).trim();};
  const customer=db.prepare('SELECT * FROM customers WHERE id=?').get(existing.customer_id);
  if(customer){
    const next={
      name:mergeText(customer.name,c.name),company:mergeText(customer.company,c.company),phone:mergeText(customer.phone,c.phone),email:mergeText(customer.email,c.email),
      address:mergeText(customer.address,c.address),city:mergeText(customer.city,c.city),state:mergeText(customer.state,c.state),country:mergeText(customer.country,c.country),pincode:mergeText(customer.pincode,c.pincode),external_contact_id:mergeText(customer.external_contact_id,c.external_contact_id)
    };
    db.prepare(`UPDATE customers SET name=?,company=?,phone=?,normalized_phone=?,email=?,address=?,city=?,state=?,country=?,pincode=?,external_contact_id=?,updated_at=? WHERE id=?`).run(next.name||customer.name||'Needs Confirmation',next.company,next.phone,normalizePhone(next.phone)||customer.normalized_phone||null,next.email,next.address,next.city,next.state,next.country,next.pincode,next.external_contact_id,nowIso(),customer.id);
  }
  const requirement=db.prepare('SELECT * FROM product_requirements WHERE lead_id=? ORDER BY id LIMIT 1').get(existing.id);
  if(requirement){
    const status=safeJson(requirement.status_json,{})||{};status.simple_choices=status.simple_choices||{};
    const reqMerge=(oldVal,newVal)=>mergeText(oldVal,newVal);
    const nextProduct=reqMerge(requirement.product_name,req.product_name),nextBrand=reqMerge(requirement.requested_brand,req.requested_brand),nextModel=reqMerge(requirement.requested_model,req.requested_model),nextUnit=reqMerge(requirement.unit,req.unit),nextApp=reqMerge(requirement.application,req.application),nextSpec=reqMerge(requirement.required_specification,req.required_specification),nextAcc=reqMerge(requirement.required_accuracy,req.required_accuracy),nextRange=reqMerge(requirement.required_range,req.required_range),nextFeatures=reqMerge(requirement.requested_features,req.requested_features),nextCert=reqMerge(requirement.requested_certification,req.requested_certification),nextLoc=reqMerge(requirement.delivery_location,req.delivery_location),nextDate=reqMerge(requirement.required_delivery_date,req.required_delivery_date),nextNotes=reqMerge(requirement.other_notes,req.other_notes);
    let nextQty=requirement.quantity;if(req.quantity_provided&&Number(req.quantity)>0&&(!staffSaved||String(status.quantity||'').toUpperCase()!=='CONFIRMED')){nextQty=Number(req.quantity);status.quantity='CONFIRMED';}
    let nextBudget=requirement.budget;if(Number(req.budget)>0&&(!staffSaved||!(Number(requirement.budget)>0)))nextBudget=Number(req.budget);
    const boolMap={catalogue_required:'catalogue_required',quotation_required:'quotation_required',datasheet_required:'technical_datasheet_required',installation_required:'installation_required',calibration_required:'calibration_required'};
    const boolVals={catalogue_required:Number(requirement.catalogue_required)||0,quotation_required:Number(requirement.quotation_required)||0,datasheet_required:Number(requirement.technical_datasheet_required)||0,installation_required:Number(requirement.installation_required)||0,calibration_required:Number(requirement.calibration_required)||0};
    for(const [choiceKey] of Object.entries(boolMap)){const incoming=String(req.source_choices?.[choiceKey]||'').toUpperCase();if(!incoming)continue;const oldChoice=String(status.simple_choices?.[choiceKey]||'').toUpperCase();if(staffSaved&&oldChoice)continue;if(staffSaved&&boolVals[choiceKey]===1&&incoming==='NO')continue;status.simple_choices[choiceKey]=incoming;boolVals[choiceKey]=incoming==='YES'?1:0;}
    db.prepare(`UPDATE product_requirements SET product_name=?,requested_brand=?,requested_model=?,quantity=?,unit=?,application=?,required_specification=?,required_accuracy=?,required_range=?,requested_features=?,requested_certification=?,delivery_location=?,required_delivery_date=?,budget=?,other_notes=?,catalogue_required=?,quotation_required=?,technical_datasheet_required=?,installation_required=?,calibration_required=?,status_json=? WHERE id=?`).run(
      nextProduct||requirement.product_name,nextBrand,nextModel,nextQty,nextUnit||requirement.unit,nextApp,nextSpec,nextAcc,nextRange,nextFeatures,nextCert,nextLoc,nextDate,nextBudget,nextNotes,boolVals.catalogue_required,boolVals.quotation_required,boolVals.datasheet_required,boolVals.installation_required,boolVals.calibration_required,json(status),requirement.id
    );
  }
  const received=firstValue(row,['received_at','created_at','createdAt']);
  const extUpdated=String(row.updated_at||row.modified_at||row.received_at||row.created_at||nowIso());
  const sourceType=sourceTypeForRow(row);
  const countryBucket=String(row.country_bucket||normalizeCountryBucket(row.country));
  const receivedIso=received&&Number.isFinite(Date.parse(received))?new Date(received).toISOString():existing.received_at;
  db.prepare(`UPDATE leads SET source_type=?,source_reference=?,source_metadata=?,raw_message=?,received_at=COALESCE(?,received_at),live_classification=?,assigned_to=?,external_updated_at=?,external_owner_id=?,external_owner_name=?,external_status=?,external_source=?,external_source_account_id=?,external_source_account_name=?,external_lead_group=?,external_country_bucket=?,quotation_sent=?,quotation_no=?,quotation_sent_by=?,quotation_sent_at=?,sync_signature=?,analysis_version=0,product_analysis_status='ANALYZING',price_analysis_status='SEARCHING',qualification_status='CALCULATING',updated_at=? WHERE id=?`).run(
    sourceType,String(row.external_inquiry_id||row.lead_id||''),json(row),parsed.raw_message,receivedIso,liveClassificationFor(receivedIso,sourceType),ownerId,extUpdated,String(row.assigned_user_id??''),String(row.lead_owner||''),String(row.status||''),String(row.lead_source||row.external_source||''),String(row.source_account_id||''),String(row.source_account_name||''),String(row.lead_group||''),countryBucket,row.quotation_sent?1:0,String(row.quotation_no||''),String(row.quotation_sent_by||''),String(row.quotation_sent_at||''),sig,nowIso(),existing.id);
  const externalValue=Number(firstValue(row,['expected_value','budget','value','amount']))||null;
  if(externalValue&&!staffSaved) db.prepare('UPDATE leads SET expected_value=?,updated_at=? WHERE id=?').run(externalValue,nowIso(),existing.id);
  if(row.quotation_sent&&existing.pipeline_stage==='NEW'){
    db.prepare(`UPDATE leads SET pipeline_stage='QUOTATION SENT',updated_at=? WHERE id=?`).run(nowIso(),existing.id);
    db.prepare('INSERT INTO pipeline_history(lead_id,from_stage,to_stage,changed_by,changed_at) VALUES (?,?,?,?,?)').run(existing.id,'NEW','QUOTATION SENT',1,nowIso());
  }
  addActivity(existing.id,'EXTERNAL_SYNC','LeadSphere live update applied',`Status: ${row.status||'-'} · Owner: ${row.lead_owner||'-'}${staffSaved?' · staff-entered values protected':''}${row.quotation_sent?' · quotation already sent':''}`);
  enqueueLeadAnalysis(existing.id,liveClassificationFor(receivedIso,sourceType));bumpDataRevision();
  return {changed:true,id:existing.id};
}

function insertExternalLead(row) {
  const parsed=crmLeadToParsed(row);
  const sourceType=sourceTypeForRow(row);
  const received=firstValue(row,['received_at','created_at','createdAt']);
  const receivedIso=received&&Number.isFinite(Date.parse(received))?new Date(received).toISOString():nowIso();
  const made=createLead(parsed,sourceType,{receivedAt:receivedIso});
  const eventId=externalEventId(row);
  const ownerId=resolveExternalOwner(row);
  db.prepare(`UPDATE leads SET external_lead_id=?,external_event_id=?,source_reference=?,source_metadata=?,received_at=?,live_classification=?,assigned_to=?,external_updated_at=?,external_owner_id=?,external_owner_name=?,external_status=?,external_source=?,external_source_account_id=?,external_source_account_name=?,external_lead_group=?,external_country_bucket=?,quotation_sent=?,quotation_no=?,quotation_sent_by=?,quotation_sent_at=?,sync_signature=?,updated_at=? WHERE id=?`).run(
    eventId,eventId,String(row.external_inquiry_id||row.lead_id||''),json(row),receivedIso,liveClassificationFor(receivedIso,sourceType),ownerId,String(row.updated_at||row.received_at||row.created_at||nowIso()),String(row.assigned_user_id??''),String(row.lead_owner||''),String(row.status||''),String(row.lead_source||row.external_source||''),String(row.source_account_id||''),String(row.source_account_name||''),String(row.lead_group||''),String(row.country_bucket||normalizeCountryBucket(row.country)),row.quotation_sent?1:0,String(row.quotation_no||''),String(row.quotation_sent_by||''),String(row.quotation_sent_at||''),syncSignature(row),nowIso(),made.lead.id);
  if(row.quotation_sent){
    db.prepare(`UPDATE leads SET pipeline_stage='QUOTATION SENT',updated_at=? WHERE id=?`).run(nowIso(),made.lead.id);
    db.prepare('INSERT INTO pipeline_history(lead_id,from_stage,to_stage,changed_by,changed_at) VALUES (?,?,?,?,?)').run(made.lead.id,'NEW','QUOTATION SENT',1,nowIso());
  }
  enqueueLeadAnalysis(made.lead.id,liveClassificationFor(receivedIso,sourceType));bumpDataRevision();
  return made.lead.id;
}

async function fetchCrmPage(c,secret,params) {
  const headers={'Accept':'application/json','X-Client-ID':c.clientId||`nunes-ai-crm-${os.hostname().toLowerCase()}`,'X-Client-Name':c.clientName||'NUNES AI CRM'};
  const scheme=Object.hasOwn(c,'authScheme')?String(c.authScheme):'Bearer ';
  headers[c.authHeader||'Authorization']=scheme+secret;
  const started=Date.now();
  const transport=await crmFetchWithRecovery(c,c.leadsPath||'/external-api/v1/leads',{headers,params,timeoutMs:Number(c.timeoutMs||30000)});
  const response=transport.response;
  const body=await response.json().catch(()=>null);
  if(!response.ok) throw new Error(`LeadSphere returned HTTP ${response.status}${body?.error||body?.message?`: ${body.error||body.message}`:''}`);
  const rows=Array.isArray(body)?body:firstValue(body||{},['data.leads','data.items','data.records','data','leads','items','records','results']);
  if(!Array.isArray(rows)) throw new Error('LeadSphere response does not contain a lead list.');
  return {body,rows,responseMs:Date.now()-started};
}

async function syncCompanyCrm({reconciliation=false}={}) {
  const c=readCrmConnection(), secret=readCrmSecret();
  if(!c?.baseUrl) throw new Error('LeadSphere API URL is not configured. Run CONFIGURE_COMPANY_CRM.bat.');
  if(!secret) throw new Error('LeadSphere API key is not configured. Run CONFIGURE_COMPANY_CRM.bat.');
  const started=nowIso();
  const lastSuccess=db.prepare("SELECT value FROM app_settings WHERE key='company_crm_last_success'").get()?.value||'';
  const overlapMinutes=Math.max(1,Number(c.overlapMinutes||5));
  const incrementalAfter=lastSuccess&&!reconciliation?new Date(new Date(lastSuccess).getTime()-overlapMinutes*60000).toISOString():'';
  const days=Math.max(1,Math.min(31,Number(c.reconciliationDays||7)));
  const today=new Date();
  const dateTo=today.toISOString().slice(0,10);
  const dateFrom=new Date(today.getTime()-(days-1)*86400000).toISOString().slice(0,10);
  const runId=db.prepare(`INSERT INTO company_crm_sync_runs(sync_type,started_at,cursor_before) VALUES (?,?,?)`).run(reconciliation?'RECONCILIATION':'INCREMENTAL',started,lastSuccess).lastInsertRowid;
  let inserted=0,updated=0,duplicates=0,failed=0,received=0,pages=0,totalResponseMs=0,offset=0,cursor='';
  try {
    while(true) {
      const params={limit:Math.max(50,Math.min(5000,Number(c.pageSize||500))),sort:'asc'};
      if(cursor) params.cursor=cursor; else params.offset=offset;
      if(reconciliation||!incrementalAfter){params.date_from=dateFrom;params.date_to=dateTo;} else params.updated_after=incrementalAfter;
      const page=await fetchCrmPage(c,secret,params); pages++; totalResponseMs+=page.responseMs; received+=page.rows.length;
      for(const row of page.rows) {
        try {
          const eventId=externalEventId(row);
          const existing=db.prepare(`SELECT * FROM leads WHERE external_event_id=? OR (source_type IN ('CRM','INDIAMART','EMAIL','WHATSAPP','WEBSITE') AND external_lead_id=?) ORDER BY id LIMIT 1`).get(eventId,eventId);
          if(existing) { const r=updateExistingExternalLead(existing,row); if(r.changed)updated++; else duplicates++; }
          else { insertExternalLead(row); inserted++; }
        } catch(e) { failed++; console.error('[LEADSPHERE ROW]',e.message); }
      }
      const body=page.body||{};
      if(!body.has_more) break;
      if(body.next_cursor){cursor=String(body.next_cursor);offset=0;}
      else if(Number.isFinite(Number(body.next_offset))){offset=Number(body.next_offset);cursor='';}
      else {offset+=page.rows.length;cursor='';}
      if(pages>=1000) throw new Error('LeadSphere pagination safety limit reached.');
    }
    if(reconciliation){try{await syncCrmStaffDirectory();}catch(e){console.warn('[LEADSPHERE STAFF PHOTOS]',e.message);}}
    const finished=nowIso();
    saveSetting('company_crm_last_sync',finished);saveSetting('company_crm_last_success',finished);saveSetting('company_crm_last_error','');
    db.prepare(`UPDATE company_crm_sync_runs SET finished_at=?,success=1,received=?,inserted=?,updated=?,duplicates=?,failed=?,pages=?,response_ms=?,cursor_after=? WHERE id=?`).run(finished,received,inserted,updated,duplicates,failed,pages,totalResponseMs,finished,runId);
    return {received,imported:inserted,inserted,updated,skipped:duplicates,duplicates,failed,pages,response_ms:totalResponseMs,last_successful_sync:finished,sync_type:reconciliation?'RECONCILIATION':'INCREMENTAL'};
  } catch(e) {
    const finished=nowIso(); saveSetting('company_crm_last_sync',finished);saveSetting('company_crm_last_error',e.message);
    db.prepare(`UPDATE company_crm_sync_runs SET finished_at=?,success=0,received=?,inserted=?,updated=?,duplicates=?,failed=?,pages=?,response_ms=?,last_error=? WHERE id=?`).run(finished,received,inserted,updated,duplicates,failed,pages,totalResponseMs,e.message,runId);
    throw e;
  }
}

async function testCompanyCrmConnection() {
  const c=readCrmConnection(),secret=readCrmSecret();
  if(!c?.baseUrl||!secret) throw new Error('LeadSphere connection is not configured.');
  const headers={'Accept':'application/json','X-Client-ID':c.clientId||`nunes-ai-crm-${os.hostname().toLowerCase()}`,'X-Client-Name':c.clientName||'NUNES AI CRM'};
  headers[c.authHeader||'Authorization']=(Object.hasOwn(c,'authScheme')?String(c.authScheme):'Bearer ')+secret;
  const transport=await crmFetchWithRecovery(c,c.statusPath||'/external-api/v1/status',{headers,timeoutMs:Number(c.timeoutMs||15000)});
  const response=transport.response;
  const body=await response.json().catch(()=>null);
  if(!response.ok) throw new Error(`LeadSphere status HTTP ${response.status}`);
  return body;
}

function constantTimeEqualText(a,b){
  const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));
  if(x.length!==y.length)return false;let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0;
}
function ingestLeadSphereWebhook(payload){
  const c=readCrmConnection()||{};
  const rows=Array.isArray(payload)?payload:(Array.isArray(payload?.events)?payload.events:(Array.isArray(payload?.data)?payload.data:[payload?.event||payload]));
  let inserted=0,updated=0,duplicates=0,failed=0;
  const runId=db.prepare(`INSERT INTO company_crm_sync_runs(sync_type,started_at) VALUES ('WEBHOOK',?)`).run(nowIso()).lastInsertRowid;
  for(const row of rows.filter(Boolean)){try{const id=externalEventId(row);const existing=db.prepare(`SELECT * FROM leads WHERE external_event_id=? OR external_lead_id=? ORDER BY id LIMIT 1`).get(id,id);if(existing){const r=updateExistingExternalLead(existing,row);if(r.changed)updated++;else duplicates++;}else{insertExternalLead(row);inserted++;}}catch(e){failed++;console.error('[LEADSPHERE WEBHOOK ROW]',e.message);}}
  const stamp=nowIso();db.prepare(`UPDATE company_crm_sync_runs SET finished_at=?,success=?,received=?,inserted=?,updated=?,duplicates=?,failed=?,pages=1 WHERE id=?`).run(stamp,failed?0:1,rows.length,inserted,updated,duplicates,failed,runId);
  if(!failed){saveSetting('company_crm_last_sync',stamp);saveSetting('company_crm_last_success',stamp);saveSetting('company_crm_last_error','');}
  return {received:rows.length,inserted,updated,duplicates,failed};
}

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.png':'image/png','.json':'application/json; charset=utf-8'};
function send(res,status,body,headers={}){
  const outHeaders={'Cache-Control':'no-store',...headers};
  const type=String(outHeaders['Content-Type']||'');
  const acceptsGzip=String(res.req?.headers?.['accept-encoding']||'').includes('gzip');
  const compressible=type.startsWith('text/')||type.includes('application/json')||type.includes('javascript')||type.includes('svg');
  let payload=body;
  const size=Buffer.isBuffer(body)?body.length:Buffer.byteLength(String(body??''));
  if(acceptsGzip&&compressible&&size>1024){
    payload=gzipSync(Buffer.isBuffer(body)?body:Buffer.from(String(body)),{level:1});
    outHeaders['Content-Encoding']='gzip';
    outHeaders['Vary']='Accept-Encoding';
  }
  outHeaders['Content-Length']=Buffer.isBuffer(payload)?payload.length:Buffer.byteLength(String(payload??''));
  res.writeHead(status,outHeaders);
  res.end(payload);
}
function sendJson(res,status,obj){send(res,status,JSON.stringify(obj),{'Content-Type':'application/json; charset=utf-8'});}
async function readBody(req,maxBytes=2_000_000){return new Promise((resolve,reject)=>{let s='';req.on('data',d=>{s+=d;if(s.length>maxBytes){reject(new Error('Request too large'));req.destroy();}});req.on('end',()=>{try{resolve(s?JSON.parse(s):{});}catch{reject(new Error('Invalid JSON'));}});req.on('error',reject);});}


function recordVerification(leadId,fieldName,previousValue,newValue,reason=''){
  db.prepare('INSERT INTO lead_verifications(lead_id,user_id,field_name,previous_value,new_value,reason,verified_at) VALUES (?,1,?,?,?,?,?)').run(leadId,fieldName,String(previousValue??''),String(newValue??''),String(reason||''),nowIso());
}
function contactLead(leadId,{method='CALL',outcome='CONNECTED',detail='',title='Customer contact'}={}){
  const lead=db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);if(!lead)throw new Error('Lead not found');
  const stamp=nowIso();const successful=['CONNECTED','CONTACTED','WHATSAPP SENT','EMAIL SENT','CALL BACK','CUSTOMER INTERESTED','READY TO BUY'].includes(String(outcome).toUpperCase());
  const first=lead.first_response_at||(successful?stamp:null);const status=successful?'CONTACTED':String(outcome||'NO ANSWER').toUpperCase();
  db.prepare('UPDATE leads SET last_contact_at=?,first_response_at=COALESCE(first_response_at,?),response_status=?,contact_attempts=COALESCE(contact_attempts,0)+1,updated_at=? WHERE id=?').run(stamp,first,status,stamp,leadId);
  db.prepare('INSERT INTO communications(lead_id,method,direction,subject,body,outcome,communicated_at,user_id) VALUES (?,?,?,?,?,?,?,1)').run(leadId,method,'OUTBOUND',title,detail||'',outcome,stamp);
  addActivity(leadId,'CONTACT',`${method} — ${outcome}`,detail||title);
  if(successful)completePlaybookStage(leadId,2,{notes:`${method} contact: ${outcome}`,data:{method,outcome},activity:false});
  calculateLeadScore(leadId);bumpDataRevision();return hydrateLead(leadId);
}
function createFollowup(leadId,b={}){
  if(!b.due_at)throw new Error('Follow-up date/time is required.');const due=validDateIso(b.due_at);if(!due)throw new Error('Valid follow-up date/time is required.');
  const id=db.prepare('INSERT INTO followups(lead_id,due_at,method,status,outcome,notes,priority,reason,assigned_to,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,?)').run(leadId,due,b.method||'CALL','PENDING',null,b.notes||'',b.priority||'NORMAL',b.reason||'',Number(b.assigned_to)||1,nowIso()).lastInsertRowid;
  db.prepare('UPDATE leads SET next_followup_at=?,followup_count=COALESCE(followup_count,0)+1,updated_at=? WHERE id=?').run(due,nowIso(),leadId);addActivity(leadId,'FOLLOWUP','Follow-up scheduled',`${b.method||'CALL'} — ${due}${b.reason?` — ${b.reason}`:''}`);completePlaybookStage(leadId,11,{notes:'Follow-up scheduled',data:{followup_id:id,due_at:due,method:b.method||'CALL'},activity:false});bumpDataRevision();return id;
}
function completeFollowup(followupId,b={}){
  const f=db.prepare('SELECT * FROM followups WHERE id=?').get(followupId);if(!f)throw new Error('Follow-up not found');const outcome=String(b.outcome||'OTHER').toUpperCase();
  db.prepare("UPDATE followups SET status='COMPLETED',outcome=?,notes=CASE WHEN ?<>'' THEN ? ELSE notes END,completed_at=? WHERE id=?").run(outcome,String(b.notes||''),String(b.notes||''),nowIso(),followupId);
  const next=db.prepare("SELECT due_at FROM followups WHERE lead_id=? AND status='PENDING' ORDER BY due_at LIMIT 1").get(f.lead_id)?.due_at||null;
  let intent=null;if(outcome==='READY TO BUY'||outcome==='CUSTOMER INTERESTED')intent=outcome==='READY TO BUY'?'READY TO BUY':'INTERESTED';
  db.prepare('UPDATE leads SET next_followup_at=?,purchase_intent=COALESCE(?,purchase_intent),updated_at=? WHERE id=?').run(next,intent,nowIso(),f.lead_id);
  addActivity(f.lead_id,'FOLLOWUP_OUTCOME',`Follow-up outcome — ${outcome}`,b.notes||'');calculateLeadScore(f.lead_id);bumpDataRevision();return hydrateLead(f.lead_id);
}
function createQuotation(leadId,b={}){
  const data=hydrateLead(leadId);if(!data)throw new Error('Lead not found');const no=quoteNo();
  const supplied=Array.isArray(b.items)&&b.items.length?b.items:null;const defaultItems=(data.requirements||[]).map((r,i)=>{const pi=data.price_intelligence||{};return {product_name:r.product_name,model:r.requested_model||data.product_intelligence?.[i]?.best_match?.product?.model||'',specification:r.required_specification||'',quantity:Number(r.quantity)||1,unit:r.unit||'Piece',unit_price:i===0?(pi.suggested_selling??null):null,discount_percent:0,gst_percent:Number(pi.gst_percent||18)};});
  const items=(supplied||defaultItems).map(x=>({product_name:String(x.product_name||''),model:String(x.model||''),specification:String(x.specification||''),quantity:Math.max(0.0001,Number(x.quantity)||1),unit:String(x.unit||'Piece'),unit_price:(x.unit_price===null||x.unit_price===''||!Number.isFinite(Number(x.unit_price)))?null:Number(x.unit_price),discount_percent:Math.max(0,Math.min(100,Number(x.discount_percent)||0)),gst_percent:Math.max(0,Number(x.gst_percent)||18)}));
  if(!items.length)throw new Error('At least one quotation item is required.');
  const missingPrice=items.some(i=>i.unit_price==null||i.unit_price<=0);let subtotal=0,gst=0,discountTotal=0;
  if(!missingPrice)for(const i of items){const gross=i.quantity*i.unit_price;const disc=gross*(i.discount_percent/100);const taxable=gross-disc;discountTotal+=disc;subtotal+=taxable;gst+=taxable*(i.gst_percent/100);i.line_total=taxable+(taxable*i.gst_percent/100);}
  const freight=missingPrice?0:Math.max(0,Number(b.freight)||0),other=missingPrice?0:Math.max(0,Number(b.other_charge)||0),total=missingPrice?null:subtotal+gst+freight+other;
  const confirmed=Boolean(b.price_confirmed)&&!missingPrice;const status=missingPrice||!confirmed?'PRICE VERIFICATION':'DRAFT';
  const qid=db.prepare('INSERT INTO quotations(quotation_no,lead_id,customer_id,status,subtotal,gst,total,validity,payment_terms,delivery_terms,warranty,discount_total,freight,other_charge,price_confirmed,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(no,leadId,data.customer.id,status,missingPrice?null:subtotal,missingPrice?null:gst,total,b.validity||'15 days',b.payment_terms||'As per final offer',b.delivery_terms||'To be confirmed',b.warranty||'As per manufacturer',missingPrice?null:discountTotal,freight,other,confirmed?1:0,nowIso()).lastInsertRowid;
  for(const i of items)db.prepare('INSERT INTO quotation_items(quotation_id,product_name,model,specification,quantity,unit,unit_price,discount_percent,gst_percent,line_total) VALUES (?,?,?,?,?,?,?,?,?,?)').run(qid,i.product_name,i.model,i.specification,i.quantity,i.unit,i.unit_price,i.discount_percent,i.gst_percent,i.line_total??null);
  db.prepare('UPDATE leads SET quotation_no=?,pipeline_stage=CASE WHEN pipeline_stage IN (\'NEW\',\'QUALIFIED\',\'REQUIREMENT CONFIRMED\',\'PRODUCT SELECTED\',\'PRICE VERIFIED\') THEN \'QUOTATION READY\' ELSE pipeline_stage END,updated_at=? WHERE id=?').run(no,nowIso(),leadId);
  addActivity(leadId,'QUOTATION',`Quotation ${no} created`,status==='PRICE VERIFICATION'?'Price verification required before sending.':'Draft quotation prepared.');completePlaybookStage(leadId,9,{notes:`Professional proposal ${no} created`,data:{quotation_id:qid,quotation_no:no},activity:false});bumpDataRevision();
  return {quotation:db.prepare('SELECT * FROM quotations WHERE id=?').get(qid),items:db.prepare('SELECT * FROM quotation_items WHERE quotation_id=? ORDER BY id').all(qid)};
}
function quotationStatusUpdate(id,b={}){
  const q=db.prepare('SELECT * FROM quotations WHERE id=?').get(id);if(!q)throw new Error('Quotation not found');const status=String(b.status||'').toUpperCase();const allowed=['DRAFT','PRICE VERIFICATION','READY','SENT','VIEWED','CUSTOMER REPLIED','NEGOTIATION','ACCEPTED','REJECTED','EXPIRED'];if(!allowed.includes(status))throw new Error('Invalid quotation status.');
  if(['READY','SENT','VIEWED','CUSTOMER REPLIED','NEGOTIATION','ACCEPTED'].includes(status)&&!q.price_confirmed)throw new Error('PRICE VERIFICATION REQUIRED. Confirm price before sending.');
  const sentAt=status==='SENT'?(q.sent_at||nowIso()):q.sent_at,viewedAt=status==='VIEWED'?(q.viewed_at||nowIso()):q.viewed_at,repliedAt=status==='CUSTOMER REPLIED'?(q.replied_at||nowIso()):q.replied_at;
  db.prepare('UPDATE quotations SET status=?,sent_at=?,viewed_at=?,replied_at=? WHERE id=?').run(status,sentAt,viewedAt,repliedAt,id);const stageMap={READY:'QUOTATION READY',SENT:'QUOTATION SENT',VIEWED:'QUOTATION SENT','CUSTOMER REPLIED':'NEGOTIATION',NEGOTIATION:'NEGOTIATION',ACCEPTED:'ORDER EXPECTED',REJECTED:'LOST'};if(stageMap[status]){const lead=db.prepare('SELECT pipeline_stage FROM leads WHERE id=?').get(q.lead_id);db.prepare('UPDATE leads SET pipeline_stage=?,quotation_sent=?,quotation_sent_at=?,updated_at=? WHERE id=?').run(stageMap[status],['SENT','VIEWED','CUSTOMER REPLIED','NEGOTIATION','ACCEPTED'].includes(status)?1:0,sentAt,nowIso(),q.lead_id);if(lead?.pipeline_stage!==stageMap[status])db.prepare('INSERT INTO pipeline_history(lead_id,from_stage,to_stage,changed_by,changed_at) VALUES (?,?,?,?,?)').run(q.lead_id,lead?.pipeline_stage,stageMap[status],1,nowIso());}
  addActivity(q.lead_id,'QUOTATION_STATUS',`Quotation ${q.quotation_no} — ${status}`,'Quotation status updated.');calculateLeadScore(q.lead_id);bumpDataRevision();return hydrateLead(q.lead_id);
}
function pdfEscape(s=''){return String(s??'').replace(/[\\()]/g,m=>'\\'+m).replace(/[^\x20-\x7E]/g,'?');}
function buildSimplePdf(lines=[]){
  const content=[];let y=800;for(const line of lines){const size=line.size||10;content.push(`BT /F1 ${size} Tf ${line.bold?'0.7 w ':''}50 ${y} Td (${pdfEscape(line.text)}) Tj ET`);y-=line.gap||Math.max(14,size+5);if(y<50)break;}const stream=Buffer.from(content.join('\n'),'ascii');
  const objs=[];const add=x=>{objs.push(Buffer.isBuffer(x)?x:Buffer.from(String(x),'ascii'));return objs.length;};
  const catalog=add('<< /Type /Catalog /Pages 2 0 R >>');const pages=add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');const page=add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>');const contents=add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),stream,Buffer.from('\nendstream')]));const font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const chunks=[Buffer.from('%PDF-1.4\n')];const offsets=[0];let pos=chunks[0].length;for(let i=0;i<objs.length;i++){offsets.push(pos);const h=Buffer.from(`${i+1} 0 obj\n`),t=Buffer.from('\nendobj\n');chunks.push(h,objs[i],t);pos+=h.length+objs[i].length+t.length;}const xref=pos;let table=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`;for(let i=1;i<offsets.length;i++)table+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;table+=`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;chunks.push(Buffer.from(table));return Buffer.concat(chunks);
}
function pdfMoney(v){return v==null||!Number.isFinite(Number(v))?'-':`INR ${Number(v).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;}
function pdfWrapText(text,maxWidth,size=9){
  const raw=String(text??'').replace(/\s+/g,' ').trim();if(!raw)return [''];const approx=Math.max(4,Math.floor(maxWidth/(size*0.52))),words=raw.split(' '),lines=[];let line='';
  for(const word of words){const next=line?`${line} ${word}`:word;if(next.length<=approx)line=next;else{if(line)lines.push(line);line=word.length>approx?word.slice(0,approx):word;}}
  if(line)lines.push(line);return lines;
}
function buildProfessionalQuotationPdf(q,items=[]){
  const W=595,H=842,M=38,commands=[];
  const yPdf=(top,h=0)=>H-top-h;
  const txt=(text,x,top,size=9,bold=false,align='left')=>{let value=pdfEscape(text);let tx=x;if(align==='right'){const approx=String(text??'').length*size*0.50;tx=Math.max(M,x-approx);}commands.push(`BT /${bold?'F2':'F1'} ${size} Tf 0 g ${tx.toFixed(1)} ${yPdf(top,size).toFixed(1)} Td (${value}) Tj ET`);};
  const rect=(x,top,w,h,fill=null,stroke=.55)=>{if(fill!=null)commands.push(`${fill} g ${x} ${yPdf(top,h)} ${w} ${h} re f`);commands.push(`${stroke} G ${x} ${yPdf(top,h)} ${w} ${h} re S`);};
  const line=(x1,top1,x2,top2,stroke=.7)=>commands.push(`${stroke} G ${x1} ${yPdf(top1)} m ${x2} ${yPdf(top2)} l S`);
  const wrapped=(text,x,top,maxWidth,size=8.5,maxLines=3,bold=false)=>{const arr=pdfWrapText(text,maxWidth,size).slice(0,maxLines);arr.forEach((v,i)=>txt(v,x,top+i*(size+3),size,bold));return arr.length;};
  // Header
  txt(String(getSetting('company_name','Nunes Instrumentation')||'Nunes Instrumentation').toUpperCase(),M,38,18,true);txt('INSTRUMENTATION | SALES | SERVICE',M,62,8,false);txt('QUOTATION',W-M,38,19,true,'right');
  line(M,78,W-M,78,.35);
  // Customer and quotation boxes
  rect(M,92,327,118,.96,.6);rect(379,92,178,118,.985,.6);
  txt('QUOTATION TO',M+12,106,8,true);txt(q.customer_name||'Customer',M+12,124,11,true);if(q.company)txt(q.company,M+12,142,9,true);
  wrapped([q.address,q.city,q.state,q.country].filter(Boolean).join(', ')||'Address not available',M+12,160,300,8,2,false);
  txt(`Phone: ${q.phone||'—'}`,M+12,190,8);if(q.email)txt(`Email: ${q.email}`,M+130,190,8);
  txt('Quotation No.',391,106,8,true);txt(q.quotation_no||'—',545,106,9,true,'right');txt('Date',391,130,8,true);txt(String(q.created_at||'').slice(0,10)||'—',545,130,9,false,'right');txt('Lead Ref.',391,154,8,true);txt(q.lead_code||'—',545,154,9,false,'right');txt('Status',391,178,8,true);txt(String(q.status||'DRAFT').replaceAll('_',' '),545,178,8,true,'right');
  // Item table
  const tableTop=228,cols=[38,66,286,329,399,449,493,557];const headers=['#','DESCRIPTION','QTY','UNIT PRICE','DISC.','GST','AMOUNT'];
  rect(M,tableTop,519,28,.91,.55);for(let i=0;i<headers.length;i++){const left=cols[i],right=cols[i+1];if(i<2)txt(headers[i],i===0?left+10:left+6,tableTop+9,7.1,true);else txt(headers[i],right-5,tableTop+9,6.8,true,'right');}
  let y=tableTop+28;const maxItems=Math.min(items.length,7);
  for(let idx=0;idx<maxItems;idx++){
    const i=items[idx],descLines=[];for(const part of [String(i.product_name||''),i.model?`Model: ${i.model}`:'',i.specification?`Spec: ${i.specification}`:''].filter(Boolean)){for(const lineText of pdfWrapText(part,208,8)){if(descLines.length<3)descLines.push(lineText);}}const rowH=Math.max(40,16+descLines.length*10);rect(M,y,519,rowH,null,.82);
    for(const x of cols.slice(1,-1))line(x,y,x,y+rowH,.84);
    txt(String(idx+1),M+14,y+12,8.2);descLines.forEach((v,n)=>txt(v,72,y+9+n*10,8,n===0));
    const qty=`${Number(i.quantity||0).toLocaleString('en-IN')} ${i.unit||''}`.trim(),unit=i.unit_price==null?'VERIFY':pdfMoney(i.unit_price).replace('INR ',''),disc=`${Number(i.discount_percent||0).toFixed(1)}%`,gst=`${Number(i.gst_percent||0).toFixed(1)}%`;
    const taxable=i.unit_price==null?null:(Number(i.quantity||0)*Number(i.unit_price||0)*(1-Number(i.discount_percent||0)/100));
    txt(qty,cols[3]-6,y+13,7.8,false,'right');txt(unit,cols[4]-6,y+13,7.8,false,'right');txt(disc,cols[5]-6,y+13,7.8,false,'right');txt(gst,cols[6]-6,y+13,7.8,false,'right');txt(taxable==null?'VERIFY':Number(taxable).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}),cols[7]-6,y+13,7.8,true,'right');y+=rowH;
  }
  if(items.length>maxItems){rect(M,y,519,24,.98,.82);txt(`+ ${items.length-maxItems} additional item(s) are included in this quotation record.`,M+8,y+8,8);y+=24;}
  // Totals
  y+=12;const totalsX=340,totalsW=217,row=21,grossAmount=items.reduce((sum,i)=>sum+(i.unit_price==null?0:Number(i.quantity||0)*Number(i.unit_price||0)),0),totals=[['Gross Amount',q.total==null?'-':pdfMoney(grossAmount)],['Discount',pdfMoney(q.discount_total||0)],['Taxable Value',pdfMoney(q.subtotal)],['GST',pdfMoney(q.gst)],['Freight',pdfMoney(q.freight||0)],['Other Charges',pdfMoney(q.other_charge||0)],['GRAND TOTAL',q.total==null?'PRICE VERIFICATION REQUIRED':pdfMoney(q.total)]];rect(totalsX,y,totalsW,row*totals.length,.985,.65);for(let r=1;r<totals.length;r++)line(totalsX,y+r*row,totalsX+totalsW,y+r*row,.86);line(452,y,452,y+row*totals.length,.86);
  totals.forEach((r,i)=>{const last=i===totals.length-1;txt(r[0],348,y+6+i*row,8,last);txt(r[1],549,y+6+i*row,last?9:8,last,'right');});
  // Terms box
  const termsTop=y+row*totals.length+16;rect(M,termsTop,519,100,.975,.65);txt('COMMERCIAL TERMS',M+10,termsTop+10,8,true);
  const terms=[['Delivery',q.delivery_terms||'To be confirmed'],['Payment',q.payment_terms||'As per final offer'],['Warranty',q.warranty||'As per manufacturer'],['Validity',q.validity||'15 days']];
  terms.forEach((t,i)=>{const top=termsTop+29+i*16;txt(`${t[0]}:`,M+12,top,8,true);wrapped(t[1],M+76,top,455,8,1,false);});
  const footerTop=Math.min(790,termsTop+118);line(M,footerTop,W-M,footerTop,.65);txt('Thank you for your enquiry. We look forward to your order.',M,footerTop+10,8);txt('For Nunes Instrumentation',W-M,footerTop+10,8,true,'right');txt('Authorized Signatory',W-M,footerTop+30,8,false,'right');
  if(q.total==null){rect(M,footerTop-34,265,24,.95,.6);txt('PRICE VERIFICATION REQUIRED BEFORE SENDING',M+8,footerTop-27,8,true);}
  const stream=Buffer.from(commands.join('\n'),'ascii'),objs=[];const add=x=>{objs.push(Buffer.isBuffer(x)?x:Buffer.from(String(x),'ascii'));return objs.length;};
  add('<< /Type /Catalog /Pages 2 0 R >>');add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>');add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),stream,Buffer.from('\nendstream')]));add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const chunks=[Buffer.from('%PDF-1.4\n')],offsets=[0];let pos=chunks[0].length;for(let i=0;i<objs.length;i++){offsets.push(pos);const h=Buffer.from(`${i+1} 0 obj\n`),t=Buffer.from('\nendobj\n');chunks.push(h,objs[i],t);pos+=h.length+objs[i].length+t.length;}const xref=pos;let table=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`;for(let i=1;i<offsets.length;i++)table+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;table+=`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;chunks.push(Buffer.from(table));return Buffer.concat(chunks);
}
function quotationPdf(id){
  const q=db.prepare(`SELECT q.*,l.lead_code,c.name AS customer_name,c.company,c.phone,c.email,c.address,c.city,c.state,c.country FROM quotations q JOIN leads l ON l.id=q.lead_id JOIN customers c ON c.id=q.customer_id WHERE q.id=?`).get(id);if(!q)throw new Error('Quotation not found');const items=db.prepare('SELECT * FROM quotation_items WHERE quotation_id=? ORDER BY id').all(id);
  return {q,items,buffer:buildProfessionalQuotationPdf(q,items)};
}
function quotationEmailContent(q){return {subject:`Quotation ${q.quotation_no} - Nunes Instrumentation`,message:`Dear ${q.customer_name||'Customer'},\n\nThank you for your enquiry. Please find attached our quotation ${q.quotation_no}.\n\nKindly review the product, price and commercial terms and let us know if we may proceed with the order.\n\nRegards,\nNunes Instrumentation`};}
async function emailQuotation(id,viewerId=1){
  const pdf=quotationPdf(id),q=pdf.q;if(!q.email)throw new Error('Customer email is not available. Add the customer email address first.');if(!q.price_confirmed||q.total==null)throw new Error('Confirm the quotation price before preparing the email.');
  const content=quotationEmailContent(q),stamp=nowIso(),url=gmailPersonalComposeUrl({to:q.email,subject:content.subject,body:content.message});
  db.prepare('INSERT INTO communications(lead_id,method,direction,subject,body,outcome,communicated_at,user_id) VALUES (?,?,?,?,?,?,?,?)').run(q.lead_id,'EMAIL','OUTBOUND',content.subject,content.message,'QUOTATION EMAIL PREPARED',stamp,viewerId||1);addActivity(q.lead_id,'QUOTATION_EMAIL',`Quotation ${q.quotation_no} prepared in personal Gmail`,`Opened for ${q.email}. Staff must attach the quotation PDF and press Send.`);bumpDataRevision();return {prepared:true,url,pdf_url:`/api/quotations/${id}/pdf`,to:q.email,quotation_no:q.quotation_no,message:'Quotation opened in your personal Gmail. Attach the opened PDF and press Send.'};
}
function proformaInvoicePdf(leadId){const d=hydrateLead(leadId);if(!d)throw new Error('Lead not found');const l=d.lead,c=d.customer,r=d.requirements?.[0]||{},p=d.price_intelligence||{},online=p.online_price||{},q=d.quotations?.[0]||null,qty=Number(r.quantity||1),unitPrice=Number(p.suggested_selling||online.suggested_selling_price||0),gst=Number(p.gst_percent??online.gst_percent??18)||18,sub=unitPrice>0?roundMoney(unitPrice*qty):0,tax=sub>0?roundMoney(sub*gst/100):0,total=sub>0?roundMoney(sub+tax):0,piNo=`PI-${String(l.lead_code||leadId).replace(/[^A-Za-z0-9-]/g,'')}`;const lines=[{text:'NUNES INSTRUMENTATION',size:18,gap:24},{text:'PROFORMA INVOICE',size:14,gap:22},{text:`PI No: ${piNo}    Date: ${String(nowIso()).slice(0,10)}`},{text:`Customer: ${c.name||'-'}${c.company?` / ${c.company}`:''}`},{text:`Contact: ${c.phone||'-'}  ${c.email||''}`},{text:`Product: ${r.product_name||'-'}${r.requested_model?` - ${r.requested_model}`:''}`,gap:18},{text:`Quantity: ${qty} ${r.unit||'Piece'}`},{text:`Unit Price: ${unitPrice>0?`INR ${unitPrice.toFixed(2)}`:'PRICE TO BE CONFIRMED'}`},{text:`GST: ${gst}%`},{text:`Subtotal: ${sub>0?`INR ${sub.toFixed(2)}`:'Not Available'}`},{text:`GST Amount: ${tax>0?`INR ${tax.toFixed(2)}`:'Not Available'}`},{text:`TOTAL: ${total>0?`INR ${total.toFixed(2)}`:'PRICE TO BE CONFIRMED'}`,size:12,gap:20},{text:`Reference Quotation: ${q?.quotation_no||'-'}`},{text:'Please confirm the purchase order/payment to proceed.'},{text:'Nunes Instrumentation'}];return {buffer:buildSimplePdf(lines),filename:`${piNo}.pdf`,piNo,total}}
function closeSaleMessage(d,action){const c=d.customer||{},r=d.requirements?.[0]||{},product=r.product_name||'the requested product',name=c.name||'Customer';if(action==='ASK_FOR_ORDER')return {subject:`Order Confirmation - ${product}`,message:`Dear ${name},\n\nThank you for your enquiry for ${product}. Shall we proceed with the order? Please confirm so we can arrange the next step immediately.\n\nRegards,\nNunes Instrumentation`};if(action==='PAYMENT_FOLLOW_UP')return {subject:`Payment Follow-Up - ${product}`,message:`Dear ${name},\n\nA quick follow-up regarding payment for ${product}. Please share the payment status / expected payment date so we can proceed without delay.\n\nRegards,\nNunes Instrumentation`};return {subject:`Proforma Invoice - ${product}`,message:`Dear ${name},\n\nPlease find attached the Proforma Invoice for ${product}. Kindly confirm the order / payment to proceed.\n\nRegards,\nNunes Instrumentation`}}
function globalSearch(term='',userId=null){
  const q=String(term||'').trim();if(!q)return {leads:[],customers:[],products:[],quotations:[]};const like=`%${q}%`,uid=Number(userId||0);
  const ownerClause=uid?' AND l.assigned_to=?':'';
  const leads=db.prepare(`${LEAD_COMPACT_SELECT} WHERE (l.lead_code LIKE ? COLLATE NOCASE OR c.name LIKE ? COLLATE NOCASE OR COALESCE(c.company,'') LIKE ? COLLATE NOCASE OR COALESCE(c.phone,'') LIKE ? COLLATE NOCASE OR COALESCE(c.email,'') LIKE ? COLLATE NOCASE OR COALESCE(pr.product_name,'') LIKE ? COLLATE NOCASE OR COALESCE(pr.requested_model,'') LIKE ? COLLATE NOCASE OR COALESCE(c.city,'') LIKE ? COLLATE NOCASE)${ownerClause} ORDER BY l.received_at DESC LIMIT 8`).all(like,like,like,like,like,like,like,like,...(uid?[uid]:[]));
  const customers=uid?db.prepare(`SELECT c.id,c.name,c.company,c.phone,c.email,c.city,c.state FROM customers c WHERE (c.name LIKE ? COLLATE NOCASE OR COALESCE(c.company,'') LIKE ? COLLATE NOCASE OR COALESCE(c.phone,'') LIKE ? COLLATE NOCASE OR COALESCE(c.email,'') LIKE ? COLLATE NOCASE) AND EXISTS(SELECT 1 FROM leads lx WHERE lx.customer_id=c.id AND lx.assigned_to=?) LIMIT 8`).all(like,like,like,like,uid):db.prepare(`SELECT id,name,company,phone,email,city,state FROM customers WHERE name LIKE ? COLLATE NOCASE OR COALESCE(company,'') LIKE ? COLLATE NOCASE OR COALESCE(phone,'') LIKE ? COLLATE NOCASE OR COALESCE(email,'') LIKE ? COLLATE NOCASE LIMIT 8`).all(like,like,like,like);
  const products=uid?[]:db.prepare(`SELECT id,name,brand,model,category,internal_code FROM products WHERE name LIKE ? COLLATE NOCASE OR COALESCE(brand,'') LIKE ? COLLATE NOCASE OR COALESCE(model,'') LIKE ? COLLATE NOCASE OR COALESCE(internal_code,'') LIKE ? COLLATE NOCASE LIMIT 8`).all(like,like,like,like);
  const quotations=uid?db.prepare(`SELECT q.id,q.quotation_no,q.status,q.total,c.name AS customer_name FROM quotations q JOIN customers c ON c.id=q.customer_id JOIN leads l ON l.id=q.lead_id WHERE (q.quotation_no LIKE ? COLLATE NOCASE OR c.name LIKE ? COLLATE NOCASE OR COALESCE(c.company,'') LIKE ? COLLATE NOCASE) AND l.assigned_to=? ORDER BY q.created_at DESC LIMIT 8`).all(like,like,like,uid):db.prepare(`SELECT q.id,q.quotation_no,q.status,q.total,c.name AS customer_name FROM quotations q JOIN customers c ON c.id=q.customer_id WHERE q.quotation_no LIKE ? COLLATE NOCASE OR c.name LIKE ? COLLATE NOCASE OR COALESCE(c.company,'') LIKE ? COLLATE NOCASE ORDER BY q.created_at DESC LIMIT 8`).all(like,like,like);
  return {leads,customers,products,quotations};
}

function pipelineData(){
  const stages=config.pipeline_stages;const columns={};for(const stage of stages){const summary=db.prepare('SELECT COUNT(*) AS c,COALESCE(SUM(expected_value),0) AS value FROM leads WHERE pipeline_stage=?').get(stage);const rows=leadCompactRows('l.pipeline_stage=?','l.purchase_probability DESC,l.received_at DESC','LIMIT 25',[stage]);columns[stage]={count:Number(summary.c||0),value:Number(summary.value||0),rows,has_more:Number(summary.c||0)>rows.length};}return {stages,columns,page_size:25};
}
function pipelineStagePage(stage,page=1,limit=25){const p=Math.max(1,Number(page)||1),l=Math.max(5,Math.min(100,Number(limit)||25)),offset=(p-1)*l;const summary=db.prepare('SELECT COUNT(*) AS c,COALESCE(SUM(expected_value),0) AS value FROM leads WHERE pipeline_stage=?').get(stage);const rows=leadCompactRows('l.pipeline_stage=?','l.purchase_probability DESC,l.received_at DESC',`LIMIT ${l} OFFSET ${offset}`,[stage]);return {stage,count:Number(summary.c||0),value:Number(summary.value||0),rows,page:p,limit:l,has_more:offset+rows.length<Number(summary.c||0)};}
function customerSummaryPage(url,userId=null){
  const q=String(url.searchParams.get('q')||'').trim(),page=Math.max(1,Number(url.searchParams.get('page')||1)),limit=Math.max(12,Math.min(60,Number(url.searchParams.get('limit')||30))),uid=Number(userId||0);
  const conditions=[];const params=[];
  if(q){conditions.push(`(c.name LIKE ? COLLATE NOCASE OR COALESCE(c.company,'') LIKE ? COLLATE NOCASE OR COALESCE(c.phone,'') LIKE ? COLLATE NOCASE OR COALESCE(c.email,'') LIKE ? COLLATE NOCASE)`);params.push(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`);}
  if(uid){conditions.push('EXISTS(SELECT 1 FROM leads lx WHERE lx.customer_id=c.id AND lx.assigned_to=?)');params.push(uid);}
  const where=conditions.length?'WHERE '+conditions.join(' AND '):'';
  const total=Number(db.prepare(`SELECT COUNT(*) AS c FROM customers c ${where}`).get(...params)?.c||0);
  const rows=db.prepare(`SELECT c.id,c.name,c.company,c.city,c.state,c.phone,c.email,COUNT(CASE WHEN ${uid?'l.assigned_to='+uid:'1=1'} THEN l.id END) AS total_enquiries,SUM(CASE WHEN ${uid?'l.assigned_to='+uid+' AND ':''}l.pipeline_stage NOT IN ('WON','LOST') THEN 1 ELSE 0 END) AS open_opportunities,MAX(CASE WHEN ${uid?'l.assigned_to='+uid:'1=1'} THEN l.received_at END) AS last_enquiry,(SELECT product_name FROM product_requirements pr WHERE pr.lead_id=(SELECT l2.id FROM leads l2 WHERE l2.customer_id=c.id ${uid?'AND l2.assigned_to='+uid:''} ORDER BY l2.received_at DESC LIMIT 1) ORDER BY pr.id LIMIT 1) AS last_product,MAX(CASE WHEN ${uid?'l.assigned_to='+uid:'1=1'} THEN l.last_contact_at END) AS last_contact,COALESCE(SUM(CASE WHEN ${uid?'l.assigned_to='+uid+' AND ':''}l.pipeline_stage NOT IN ('WON','LOST') THEN l.expected_value ELSE 0 END),0) AS potential_value,SUM(CASE WHEN ${uid?'l.assigned_to='+uid+' AND ':''}l.pipeline_stage='WON' THEN 1 ELSE 0 END) AS orders,COALESCE(SUM(CASE WHEN ${uid?'l.assigned_to='+uid+' AND ':''}l.pipeline_stage='WON' THEN COALESCE(l.order_value,l.expected_value,0) ELSE 0 END),0) AS won_value FROM customers c LEFT JOIN leads l ON l.customer_id=c.id ${where} GROUP BY c.id ORDER BY COALESCE(MAX(CASE WHEN ${uid?'l.assigned_to='+uid:'1=1'} THEN l.received_at END),c.updated_at) DESC LIMIT ${limit} OFFSET ${(page-1)*limit}`).all(...params);
  return {rows,total,page,limit,pages:Math.max(1,Math.ceil(total/limit)),has_more:page*limit<total};
}



function objectionSuggestion(category='NONE'){
  const c=String(category||'NONE').toUpperCase();
  const suggestions={
    PRICE:'Confirm what is included in the comparison, then explain the verified product fit, warranty, delivery and any technically valid lower-cost option.',
    BRAND:'Confirm the requested brand/model and offer an equivalent only when the specification genuinely matches.',
    DELIVERY:'Verify actual stock and supplier lead time, then offer the fastest realistic delivery option.',
    TECHNICAL:'Clarify the exact technical concern and respond only with verified specification data.',
    CALIBRATION:'Confirm the required calibration scope/certificate and include the verified calibration terms.',
    PAYMENT:'Confirm the requested payment terms and compare them with approved company terms.',
    WARRANTY:'Confirm the manufacturer warranty and after-sales/service coverage in writing.',
    'MANAGEMENT APPROVAL':'Ask what information management needs for approval and schedule a follow-up around the decision date.',
    'COMPETITOR PRICE':'Compare the exact model, included accessories, warranty, calibration, delivery and technical scope before discussing price.',
    OTHER:'Clarify the concern, verify the facts, respond accurately and record the customer decision.'
  };
  return c==='NONE'?'':(suggestions[c]||suggestions.OTHER);
}
function verifiedPriceForLead(leadId){
  const d=priceIntelligenceForLead(leadId);const r=d.records?.find(x=>Number(x.verified)===1)||d.records?.[0]||null;
  return r&&Number(r.verified)===1?r:null;
}
function saveVerifiedPriceForLead(id,b={},finalSave=false){
  const priceYes=String(b.price_verified||'').toUpperCase()==='YES'||b.price_verified===true;
  if(!priceYes)return null;
  const amount=Number(b.verified_selling_price||b.suggested_selling_price||b.selling_price||0);
  if(!(amount>0)){if(finalSave)throw new Error('Enter a verified selling price or choose Price Verified = NO.');return null;}
  const online=latestOnlinePriceResearch(id),automaticSource=online?.status==='FOUND'?(online.source_name||'Online Price Research'):'Salesperson Verification';
  const source=String(b.price_source||b.source||automaticSource).trim()||'Salesperson Verification';
  const current=verifiedPriceForLead(id);
  if(current&&Math.abs(Number(current.suggested_selling_price||current.selling_price||0)-amount)<0.0001&&String(current.source||'')===source)return current;
  const d=hydrateLead(id);if(!d)throw new Error('Lead not found');const req0=d.requirements[0];if(!req0)throw new Error('Product requirement not found');
  let productId=d.products.find(x=>x.product_id)?.product_id||null;
  if(!productId){
    productId=db.prepare('INSERT INTO products(name,brand,model,category,description,internal_code,demo) VALUES (?,?,?,?,?,?,0)').run(req0.product_name,req0.requested_brand||null,req0.requested_model||null,b.category||null,'Salesperson verified product record',b.internal_code||null).lastInsertRowid;
    const lp=db.prepare('SELECT id FROM lead_products WHERE lead_id=? AND requirement_id=? ORDER BY id LIMIT 1').get(id,req0.id);
    if(lp)db.prepare('UPDATE lead_products SET product_id=?,match_confidence=100,match_reason=? WHERE id=?').run(productId,'Salesperson verified product match',lp.id);
    else db.prepare('INSERT INTO lead_products(lead_id,requirement_id,product_id,match_confidence,match_reason,selected) VALUES (?,?,?,?,?,1)').run(id,req0.id,productId,100,'Salesperson verified product match');
  }
  const gst=Number(b.gst_percent||18)||18;
  const margin=Number.isFinite(Number(b.online_margin_percent))?Number(b.online_margin_percent):(Number(online?.margin_percent)||null);
  const date=validDateIso(b.price_date)||validDateIso(online?.searched_at)||nowIso();
  db.prepare('INSERT INTO product_prices(product_id,purchase_price,selling_price,previous_quoted_price,suggested_selling_price,gst_percent,margin_percent,price_date,supplier,stock_status,lead_time,source,reliability,verified,verified_by,verified_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)').run(productId,null,amount,null,amount,gst,margin,date,b.supplier||online?.supplier||null,b.stock_status||online?.stock_status||null,null,source,'HIGH','Sebastian Nunes',nowIso());
  db.prepare("UPDATE leads SET price_analysis_status='COMPLETE',pipeline_stage=CASE WHEN pipeline_stage IN ('NEW','QUALIFIED','REQUIREMENT CONFIRMED','PRODUCT SELECTED') THEN 'PRICE VERIFIED' ELSE pipeline_stage END,updated_at=? WHERE id=?").run(nowIso(),id);
  if(finalSave)addActivity(id,'PRICE_VERIFIED','Price verified',`Selling: ${amount} • Source: ${source}`);
  return verifiedPriceForLead(id);
}
function upsertLeadFollowupFromForm(leadId,b={},finalSave=false){
  if(!Object.hasOwn(b,'next_followup_at'))return;
  const raw=String(b.next_followup_at||'').trim();
  const lead=db.prepare('SELECT next_followup_at,assigned_to FROM leads WHERE id=?').get(leadId);if(!lead)return;
  if(!raw){
    db.prepare("UPDATE followups SET status='CANCELLED',completed_at=? WHERE lead_id=? AND status='PENDING'").run(nowIso(),leadId);
    db.prepare('UPDATE leads SET next_followup_at=NULL,updated_at=? WHERE id=?').run(nowIso(),leadId);return;
  }
  const due=validDateIso(raw);if(!due){if(finalSave)throw new Error('Enter a valid next follow-up date/time.');return;}
  const method=String(b.followup_reason||'CALL').toUpperCase();const notes=String(b.followup_notes||'').trim();
  const pending=db.prepare("SELECT * FROM followups WHERE lead_id=? AND status='PENDING' ORDER BY due_at LIMIT 1").get(leadId);
  if(pending){
    if(pending.due_at!==due||pending.method!==method||String(pending.notes||'')!==notes)db.prepare('UPDATE followups SET due_at=?,method=?,reason=?,notes=?,priority=? WHERE id=?').run(due,method,method,notes,b.priority||'NORMAL',pending.id);
  }else{
    db.prepare('INSERT INTO followups(lead_id,due_at,method,status,notes,priority,reason,assigned_to,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,1,?)').run(leadId,due,method,'PENDING',notes,b.priority||'NORMAL',method,lead.assigned_to||1,nowIso());
  }
  db.prepare('UPDATE leads SET next_followup_at=?,updated_at=? WHERE id=?').run(due,nowIso(),leadId);
}
function upsertSimpleObjection(leadId,b={},finalSave=false){
  if(!Object.hasOwn(b,'customer_objection'))return;
  const category=String(b.customer_objection||'NONE').toUpperCase();
  if(category==='NONE'){
    completePlaybookStage(leadId,8,{notes:'No current customer objection.',data:{no_objection:true},activity:false});return;
  }
  const notes=String(b.objection_notes||'').trim(),ai=String(b.ai_objection_response||'').trim();
  const existing=db.prepare('SELECT * FROM objections WHERE lead_id=? ORDER BY id DESC LIMIT 1').get(leadId);
  const mapped={'PRICE HIGH':'PRICE TOO HIGH',BRAND:'OTHER BRAND REQUIRED',DELIVERY:'DELIVERY TOO LONG',TECHNICAL:'NEED TECHNICAL CONFIRMATION',PAYMENT:'PAYMENT TERMS',WARRANTY:'WARRANTY','APPROVAL PENDING':'MANAGEMENT APPROVAL',COMPETITOR:'COMPETITOR CHEAPER',OTHER:'OTHER'}[category]||category;
  if(existing&&['OPEN','RESPONDED'].includes(existing.resolution_status))db.prepare("UPDATE objections SET objection=?,category=?,customer_comment=?,salesperson_notes=?,ai_suggested_response=COALESCE(NULLIF(?,''),ai_suggested_response) WHERE id=?").run(mapped,mapped,notes,notes,ai,existing.id);
  else if(finalSave||notes||ai)db.prepare('INSERT INTO objections(lead_id,objection,customer_comment,resolution_status,created_at,category,salesperson_notes,ai_suggested_response) VALUES (?,?,?,?,?,?,?,?)').run(leadId,mapped,notes,'OPEN',nowIso(),mapped,notes,ai||null);
}
function syncSimpleFormPrinciples(leadId,finalSave=false){
  ensurePlaybookForLead(leadId);const d=hydrateLead(leadId);if(!d)return;
  const l=d.lead,r=d.requirements?.[0]||{},p=d.price_intelligence||{},q=d.quotation_uploads?.[0]||d.quotations?.[0],ob=d.objections?.[0],n=d.nurture||{},pi=d.product_intelligence?.[0]||null,choices=safeJson(l.form_choices_json,{})||{};
  const hasChoice=k=>Object.prototype.hasOwnProperty.call(choices,k), meaningful=(v,blanks=[])=>{const x=String(v??'').trim().toUpperCase();return Boolean(x)&&!blanks.map(z=>String(z).toUpperCase()).includes(x)};
  const mark=(no,ok,data,notes)=>{if(!ok)return;const row=db.prepare('SELECT status FROM sales_playbook_progress WHERE lead_id=? AND stage_no=?').get(leadId,no);if(row&&row.status!=='COMPLETED')completePlaybookStage(leadId,no,{data,notes,activity:false});};
  const qualificationRecorded=hasChoice('requirement_status')||hasChoice('budget_band')||hasChoice('urgency')||hasChoice('decision_role')||hasChoice('decision_influence')||hasChoice('purchase_intent')||meaningful(l.requirement_status,['NEEDS CLARIFICATION'])||meaningful(l.budget_status,['UNKNOWN'])||meaningful(l.urgency,['UNKNOWN'])||meaningful(l.decision_role,['UNKNOWN'])||meaningful(l.decision_influence,['UNKNOWN'])||meaningful(l.purchase_intent,['UNKNOWN','JUST ENQUIRY','INTERESTED']);
  mark(1,qualificationRecorded,{requirement_status:l.requirement_status,budget_band:l.budget_band,urgency:l.urgency,decision_role:l.decision_role,decision_influence:l.decision_influence,purchase_intent:l.purchase_intent},'Qualification contains CRM-reported or staff-selected information.');
  mark(2,Boolean(l.last_contact_at||Number(l.contact_attempts||0)>0||meaningful(l.response_status,['NOT CONTACTED'])),{response_status:l.response_status,last_contact_at:l.last_contact_at},'Customer contact status is recorded.');
  mark(3,Boolean(r.application||r.required_range||r.required_accuracy||r.required_specification||r.requested_model||r.requested_brand||r.delivery_location||r.required_delivery_date),{requirement_id:r.id},'Buyer requirement information is captured.');
  mark(4,Boolean(finalSave&&pi&&(pi.description||pi.best_match)&&meaningful(l.requirement_status,['NEEDS CLARIFICATION'])),{handled_internally:true,product_match:pi?.best_match?.confidence||0},'Customer value alignment is evaluated from recorded requirement and product information.');
  mark(5,Boolean(l.recommended_product||pi?.best_match?.product?.name),{recommended_solution:l.recommended_product||pi?.best_match?.product?.name||null},'A suitable product solution is available from product matching.');
  mark(6,Boolean(pi&&(pi.description||pi.specs?.length||pi.features?.length||pi.applications?.length)),{price_status:p.status,catalogue_required:r.catalogue_required,datasheet_required:r.technical_datasheet_required},'Detailed product information is available in the form.');
  const urgencyRecorded=hasChoice('urgency')||meaningful(l.urgency,['UNKNOWN']);
  if(finalSave&&urgencyRecorded)mark(7,true,{purchase_urgency:l.urgency},'Customer purchase urgency/timeline was explicitly recorded.');
  const objectionRecorded=Boolean(ob)||hasChoice('customer_objection')||Boolean(db.prepare('SELECT stage_data_json FROM sales_playbook_progress WHERE lead_id=? AND stage_no=8').get(leadId)?.stage_data_json?.includes('no_objection'));
  mark(8,objectionRecorded,{objection:ob?.category||choices.customer_objection||null},'Customer objection status was explicitly reviewed.');
  mark(9,Boolean(q),{quotation_id:q?.id,quotation_no:q?.quotation_no,status:q?.status},'Quotation/proposal exists.');
  mark(10,Boolean(hasChoice('order_status')||meaningful(l.order_status,['NOT READY'])),{order_status:l.order_status},'Order readiness/status was explicitly recorded.');
  mark(11,Boolean(l.next_followup_at),{due_at:l.next_followup_at},'Next follow-up scheduled.');
  mark(12,Boolean(n.future_requirement||n.expected_purchase_month||n.next_relationship_followup_at),{future_requirement:n.future_requirement,expected_purchase_month:n.expected_purchase_month,future_followup_at:n.next_relationship_followup_at},'Future relationship/opportunity information recorded.');
}

function saveSimpleLeadForm(leadId,b={},viewer=null){
  const finalSave=Boolean(b.final_save);const leadBefore=db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);if(!leadBefore)throw new Error('Lead not found');
  // V2.11.15: remember only choices that were actually present in the submitted form.
  // Unselected radio/check groups are absent, so opening a lead cannot silently invent an answer.
  const formChoices=safeJson(leadBefore.form_choices_json,{})||{};let formChoicesChanged=Boolean(!leadBefore.form_last_saved_at&&!leadBefore.form_completed_at&&!String(leadBefore.form_choices_json||'').trim());
  const rememberChoice=(key,value)=>{const next=Array.isArray(value)?value.map(x=>String(x)):String(value??'');if(JSON.stringify(formChoices[key])!==JSON.stringify(next)){formChoices[key]=next;formChoicesChanged=true;}};
  for(const key of ['requirement_status','budget_band','urgency','decision_role','decision_influence','purchase_intent','contact_status','followup_reason','customer_objection','quotation_required','order_status','price_verified'])if(Object.hasOwn(b,key))rememberChoice(key,b[key]);
  if(Object.hasOwn(b,'buying_signals'))rememberChoice('buying_signals',Array.isArray(b.buying_signals)?b.buying_signals:[]);
  if(finalSave&&Object.hasOwn(b,'product_name')&&!String(b.product_name||'').trim())throw new Error('Product Name is required.');
  const customerBefore=db.prepare('SELECT * FROM customers WHERE id=?').get(leadBefore.customer_id);const reqBefore=db.prepare('SELECT * FROM product_requirements WHERE lead_id=? ORDER BY id LIMIT 1').get(leadId);if(!reqBefore)throw new Error('Product requirement not found');
  const c=b.customer||b;const customerFields=['name','company','phone','email','city','state','country'];const csets=[],cvals=[];
  for(const f of customerFields)if(Object.hasOwn(c,f)){csets.push(`${f}=?`);cvals.push(String(c[f]??'').trim()||null);}
  if(Object.hasOwn(c,'phone')){csets.push('normalized_phone=?');cvals.push(normalizePhone(c.phone)||null);}
  if(csets.length)db.prepare(`UPDATE customers SET ${csets.join(',')},updated_at=? WHERE id=?`).run(...cvals,nowIso(),leadBefore.customer_id);
  const reqMap={product_name:'product_name',quantity:'quantity',brand:'requested_brand',model:'requested_model',application:'application',required_range:'required_range',required_accuracy:'required_accuracy',required_specification:'required_specification',accessories_required:'requested_accessories',calibration_required:'calibration_required',installation_required:'installation_required',catalogue_required:'catalogue_required',datasheet_required:'technical_datasheet_required',budget_amount:'budget',required_delivery_date:'required_delivery_date',delivery_location:'delivery_location',customer_notes:'other_notes'};
  const rsets=[],rvals=[];let analysisChanged=false,productIdentityChanged=false;const boolReqFields=new Set(['calibration_required','installation_required','catalogue_required','datasheet_required']);const reqStatus=safeJson(reqBefore.status_json,{})||{};reqStatus.simple_choices=reqStatus.simple_choices||{};let reqStatusChanged=false;
  for(const [src,dst] of Object.entries(reqMap))if(Object.hasOwn(b,src)){
    let v=b[src];
    if(boolReqFields.has(src)){const raw=String(v??'').trim().toUpperCase();if(!raw)continue;const allowUnknown=['calibration_required','installation_required'].includes(src);const choice=allowUnknown&&raw==='UNKNOWN'?'UNKNOWN':(['YES','1','TRUE','ON'].includes(raw)?'YES':'NO');v=choice==='UNKNOWN'?null:(choice==='YES'?1:0);if(reqStatus.simple_choices[src]!==choice){reqStatus.simple_choices[src]=choice;reqStatusChanged=true;}}
    else if(['quantity','budget_amount'].includes(src))v=String(v??'').trim()===''?null:Number(v)||null;else v=String(v??'').trim()||null;
    if(String(reqBefore[dst]??'')!==String(v??'')){analysisChanged=true;if(['product_name','requested_brand','requested_model'].includes(dst))productIdentityChanged=true;}rsets.push(`${dst}=?`);rvals.push(v);
  }
  if(reqStatusChanged){rsets.push('status_json=?');rvals.push(json(reqStatus));}
  if(rsets.length)db.prepare(`UPDATE product_requirements SET ${rsets.join(',')} WHERE id=?`).run(...rvals,reqBefore.id);
  if(productIdentityChanged){
    // Product-specific staff overrides belong to the old product identity. Remove them
    // when the product/brand/model changes so stale Freeze Dryer data can never remain
    // attached after changing to an exact model such as Labconco FreeZone 6.
    db.prepare('DELETE FROM lead_product_content WHERE lead_id=?').run(leadId);
    db.prepare('DELETE FROM lead_specification_overrides WHERE lead_id=?').run(leadId);
    db.prepare('UPDATE lead_products SET product_id=NULL,match_confidence=0,match_reason=? WHERE lead_id=? AND requirement_id=?').run('Product identity changed — automatic research queued',leadId,reqBefore.id);
    addActivity(leadId,'PRODUCT_CHANGE','Product identity changed','Previous product-specific display overrides were cleared and fresh automatic research was queued.');
  }
  const leadFields={market_type:'market_type_override',budget_band:'budget_band',urgency:'urgency',decision_role:'decision_role',decision_influence:'decision_influence',purchase_intent:'purchase_intent',commercial_potential:'commercial_potential',estimated_value:'expected_value',customer_value_message:'customer_value_message',recommended_product:'recommended_product',alternative_product:'alternative_product',economy_option:'economy_option',premium_option:'premium_option',verified_urgency_note:'verified_urgency_note',order_status:'order_status',contact_notes:'contact_notes',final_notes:'final_notes'};
  const lsets=[],lvals=[];
  for(const [src,dst] of Object.entries(leadFields))if(Object.hasOwn(b,src)){
    let v=b[src];if(src==='estimated_value')v=String(v??'').trim()===''?null:Number(v)||null;else v=String(v??'').trim()||null;lsets.push(`${dst}=?`);lvals.push(v);
  }
  if(Object.hasOwn(b,'requirement_status')){const map={CLEAR:'CONFIRMED','NEEDS CLARIFICATION':'NEEDS CLARIFICATION','GENERAL ENQUIRY':'GENERAL ENQUIRY','WRONG REQUIREMENT':'WRONG REQUIREMENT'};lsets.push('requirement_status=?');lvals.push(map[String(b.requirement_status||'').toUpperCase()]||b.requirement_status||'NEEDS CLARIFICATION');}
  const budgetBand=String(b.budget_band||leadBefore.budget_band||'UNKNOWN').toUpperCase();const budgetAmount=Number(b.budget_amount||0);if(Object.hasOwn(b,'budget_band')||Object.hasOwn(b,'budget_amount')){lsets.push('budget_status=?');lvals.push((budgetAmount>0||!['','UNKNOWN'].includes(budgetBand))?'CONFIRMED':'UNKNOWN');}
  if(Object.hasOwn(b,'decision_influence')){lsets.push('decision_maker=?');lvals.push(['HIGH','MEDIUM'].includes(String(b.decision_influence||'').toUpperCase())?'YES':String(b.decision_influence||'').toUpperCase()==='LOW'?'NO':'UNKNOWN');}
  if(Object.hasOwn(b,'buying_signals')){lsets.push('buying_signals_json=?');lvals.push(json(Array.isArray(b.buying_signals)?b.buying_signals:[]));}
  if(Object.hasOwn(b,'owner_id')){const owner=Number(b.owner_id);if(owner&&db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(owner)){lsets.push('assigned_to=?');lvals.push(owner);}}
  if(Object.hasOwn(b,'contact_status')){
    const status=String(b.contact_status||'NOT CONTACTED').toUpperCase();lsets.push('response_status=?');lvals.push(status);
    let lc=b.last_contact_at?validDateIso(b.last_contact_at):leadBefore.last_contact_at;if(status!=='NOT CONTACTED'&&!lc)lc=nowIso();lsets.push('last_contact_at=?');lvals.push(lc||null);
    if(status!==leadBefore.response_status&&status!=='NOT CONTACTED'&&finalSave){db.prepare('INSERT INTO communications(lead_id,method,direction,subject,body,outcome,communicated_at,user_id) VALUES (?,?,?,?,?,?,?,1)').run(leadId,status.includes('WHATSAPP')?'WHATSAPP':status.includes('EMAIL')?'EMAIL':'CALL','OUTBOUND','Customer contact update',b.contact_notes||'',status,lc||nowIso());}
  }
  if(Object.hasOwn(b,'quotation_required')){const choice=String(b.quotation_required||'').toUpperCase();db.prepare('UPDATE product_requirements SET quotation_required=? WHERE id=?').run(choice==='YES'?1:0,reqBefore.id);if(reqStatus.simple_choices.quotation_required!==choice){reqStatus.simple_choices.quotation_required=choice;db.prepare('UPDATE product_requirements SET status_json=? WHERE id=?').run(json(reqStatus),reqBefore.id);}}
  if(formChoicesChanged){lsets.push('form_choices_json=?');lvals.push(json(formChoices));}
  if(lsets.length)db.prepare(`UPDATE leads SET ${lsets.join(',')},updated_at=? WHERE id=?`).run(...lvals,nowIso(),leadId);
  if(analysisChanged){db.prepare("UPDATE leads SET analysis_version=0,product_analysis_status='ANALYZING',price_analysis_status='SEARCHING',qualification_status='CALCULATING',updated_at=? WHERE id=?").run(nowIso(),leadId);enqueueLeadAnalysis(leadId,leadBefore.live_classification||'LIVE');}
  if(Array.isArray(b.specifications))for(const spec of b.specifications){const key=String(spec.key||spec.spec_key||'').trim();if(!key)continue;const value=String(spec.value??spec.spec_value??'').trim();if(!value)db.prepare('DELETE FROM lead_specification_overrides WHERE lead_id=? AND spec_key=?').run(leadId,key);else db.prepare(`INSERT INTO lead_specification_overrides(lead_id,spec_key,spec_value,source,verification_status,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(lead_id,spec_key) DO UPDATE SET spec_value=excluded.spec_value,source=excluded.source,verification_status=excluded.verification_status,updated_at=excluded.updated_at`).run(leadId,key,value,'Salesperson Verification','CONFIRMED',nowIso());}
  if(Object.hasOwn(b,'product_description')||Object.hasOwn(b,'key_features')||Object.hasOwn(b,'applications')){
    const old=db.prepare('SELECT * FROM lead_product_content WHERE lead_id=?').get(leadId)||{};const features=Array.isArray(b.key_features)?b.key_features:String(b.key_features??'').split(/\n+/).map(x=>x.replace(/^[-•]\s*/,'').trim()).filter(Boolean);const apps=Array.isArray(b.applications)?b.applications:String(b.applications??'').split(/\n+/).map(x=>x.replace(/^[-•]\s*/,'').trim()).filter(Boolean);
    db.prepare(`INSERT INTO lead_product_content(lead_id,description,features_json,applications_json,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(lead_id) DO UPDATE SET description=excluded.description,features_json=excluded.features_json,applications_json=excluded.applications_json,updated_at=excluded.updated_at`).run(leadId,Object.hasOwn(b,'product_description')?String(b.product_description||''):old.description||null,Object.hasOwn(b,'key_features')?json(features):old.features_json||null,Object.hasOwn(b,'applications')?json(apps):old.applications_json||null,nowIso());
  }
  updateOnlinePricePreferencesForLead(leadId,b);
  saveVerifiedPriceForLead(leadId,b,finalSave);
  upsertLeadFollowupFromForm(leadId,b,finalSave);
  upsertSimpleObjection(leadId,b,finalSave);
  const latestQuote=db.prepare('SELECT * FROM quotations WHERE lead_id=? ORDER BY id DESC LIMIT 1').get(leadId);if(latestQuote&&b.quotation_status&&String(b.quotation_status).toUpperCase()!==latestQuote.status){try{quotationStatusUpdate(latestQuote.id,{status:String(b.quotation_status).toUpperCase()});}catch(e){if(finalSave)throw e;}}
  const currentLead=db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);const hasOrderStatus=Object.hasOwn(b,'order_status')&&String(b.order_status||'').trim()!=='';const orderStatus=hasOrderStatus?String(b.order_status).toUpperCase():String(currentLead.order_status||'').toUpperCase();if(hasOrderStatus&&orderStatus!==String(leadBefore.order_status||'').toUpperCase()){
    if(orderStatus==='ORDER CONFIRMED'){db.prepare("UPDATE leads SET order_status=?,pipeline_stage='WON',status='WON',purchase_intent='READY TO BUY',order_value=?,order_date=COALESCE(order_date,?),po_number=?,updated_at=? WHERE id=?").run(orderStatus,Number(b.won_value||b.estimated_value||0)||currentLead.expected_value||null,nowIso(),b.po_number||currentLead.po_number||null,nowIso(),leadId);}
    else if(orderStatus==='LOST'){if(finalSave&&!String(b.lost_reason||'').trim())throw new Error('Select a Lost Reason.');if(String(b.lost_reason||'').trim())db.prepare("UPDATE leads SET order_status=?,pipeline_stage='LOST',status='LOST',lost_reason=?,updated_at=? WHERE id=?").run(orderStatus,b.lost_reason,nowIso(),leadId);}
    else if(['READY TO ORDER','WAITING FOR PO','WAITING APPROVAL','NEGOTIATING'].includes(orderStatus)){const stage=orderStatus==='NEGOTIATING'?'NEGOTIATION':'ORDER EXPECTED';db.prepare('UPDATE leads SET order_status=?,pipeline_stage=?,updated_at=? WHERE id=?').run(orderStatus,stage,nowIso(),leadId);}
    else db.prepare('UPDATE leads SET order_status=?,updated_at=? WHERE id=?').run(orderStatus,nowIso(),leadId);
  }
  if(Object.hasOwn(b,'po_number'))db.prepare('UPDATE leads SET po_number=?,updated_at=? WHERE id=?').run(String(b.po_number||'').trim()||null,nowIso(),leadId);
  if(Object.hasOwn(b,'won_value')&&String(b.won_value||'').trim()!=='')db.prepare('UPDATE leads SET order_value=?,updated_at=? WHERE id=?').run(Number(b.won_value)||null,nowIso(),leadId);
  if(Object.hasOwn(b,'future_requirement')||Object.hasOwn(b,'expected_purchase_month')||Object.hasOwn(b,'next_long_term_contact')){
    const next=b.next_long_term_contact?validDateIso(b.next_long_term_contact):null;db.prepare(`INSERT INTO customer_nurture(customer_id,future_requirement,expected_purchase_month,products_of_interest,next_relationship_followup_at,notes,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET future_requirement=excluded.future_requirement,expected_purchase_month=excluded.expected_purchase_month,products_of_interest=excluded.products_of_interest,next_relationship_followup_at=excluded.next_relationship_followup_at,notes=excluded.notes,updated_at=excluded.updated_at`).run(leadBefore.customer_id,String(b.future_requirement||'').trim()||null,String(b.expected_purchase_month||'').trim()||null,reqBefore.product_name,next,String(b.final_notes||'').trim()||null,nowIso());
  }
  calculateLeadScore(leadId);syncSimpleFormPrinciples(leadId,finalSave);
  const pb=db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN status IN ('COMPLETED','SKIPPED') THEN 1 ELSE 0 END) AS done FROM sales_playbook_progress WHERE lead_id=?").get(leadId);const progress=finalSave?100:Math.max(0,Math.min(99,Math.round(Number(pb?.done||0)*100/Math.max(1,Number(pb?.total||12)))));const stamp=nowIso();
  db.prepare(`UPDATE leads SET form_status=?,form_completion_percent=?,form_started_at=COALESCE(form_started_at,?),form_last_saved_at=?,form_completed_at=CASE WHEN ?=1 THEN COALESCE(form_completed_at,?) ELSE form_completed_at END,updated_at=? WHERE id=?`).run(finalSave?'COMPLETED':'IN PROGRESS',progress,stamp,stamp,finalSave?1:0,stamp,stamp,leadId);
  if(finalSave){
    addActivity(leadId,'FORM_SAVED','Lead sales form saved','Single-page sales form reviewed and saved.');
    setLeadWorkStatus(leadId,'COMPLETED','',viewer,{silentDuplicate:true});
    // Even if the lead was already marked COMPLETED, the edited form itself changed.
    // Always advance the shared revision so Owner/Staff dashboards refresh immediately.
    bumpDataRevision();
  }else bumpDataRevision();
  return hydrateLead(leadId);
}

async function api(req,res,url){
  try{
    if(req.method==='POST'&&url.pathname==='/api/integrations/leadsphere/webhook'){
      const c=readCrmConnection()||{};const supplied=String(req.headers['x-nunes-webhook-secret']||'');if(!c.webhookSecret||!constantTimeEqualText(supplied,c.webhookSecret))return sendJson(res,401,{ok:false,error:'Invalid webhook secret'});const body=await readBody(req);return sendJson(res,200,{ok:true,data:ingestLeadSphereWebhook(body)});
    }
    if(req.method==='GET'&&url.pathname==='/api/health') return sendJson(res,200,{ok:true,app:APP_ID,time:nowIso(),version:APP_VERSION,deployment:DEPLOYMENT_VERSION,client_launcher_version:CLIENT_LAUNCHER_VERSION,github_update:githubUpdateState,company_crm:crmStatus(),price_source:priceSourceHealth(),analysis_queue:analysisQueue.length,product_intelligence:productIntelligenceProviderStatus()});
    if(req.method==='GET'&&url.pathname==='/api/client/update-manifest'){
      const viewer=viewerFromRequest(req);if(Number(viewer?.id||0)<=0)return sendJson(res,401,{ok:false,error:'This computer is not configured.'});
      const current=String(url.searchParams.get('client_version')||req.headers['x-nunes-client-version']||'').trim();const payload=clientLauncherPayload();
      try{if(viewer.device_session_id)db.prepare(`UPDATE device_sessions SET client_version=COALESCE(NULLIF(?,''),client_version),last_server_version=?,last_update_check_at=?,last_seen_at=? WHERE id=?`).run(current,APP_VERSION,nowIso(),nowIso(),viewer.device_session_id);}catch{}
      return sendJson(res,200,{ok:true,data:{server_version:APP_VERSION,launcher_version:CLIENT_LAUNCHER_VERSION,current_version:current,update_available:current!==CLIENT_LAUNCHER_VERSION,launcher_sha256:payload.sha256,launcher_url:'/api/client/launcher.ps1'}});
    }
    if(req.method==='GET'&&url.pathname==='/api/client/launcher.ps1'){
      const viewer=viewerFromRequest(req);if(Number(viewer?.id||0)<=0)return sendJson(res,401,{ok:false,error:'This computer is not configured.'});const payload=clientLauncherPayload();
      return send(res,200,payload.text,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Nunes-Launcher-Version':CLIENT_LAUNCHER_VERSION,'X-Nunes-SHA256':payload.sha256});
    }
    if(req.method==='POST'&&url.pathname==='/api/client/update-applied'){
      const viewer=viewerFromRequest(req);if(Number(viewer?.id||0)<=0)return sendJson(res,401,{ok:false,error:'This computer is not configured.'});const b=await readBody(req),v=String(b.client_version||CLIENT_LAUNCHER_VERSION);
      if(viewer.device_session_id)db.prepare('UPDATE device_sessions SET client_version=?,last_server_version=?,last_update_applied_at=?,last_update_check_at=?,last_seen_at=? WHERE id=?').run(v,APP_VERSION,nowIso(),nowIso(),nowIso(),viewer.device_session_id);
      bumpDataRevision();
      return sendJson(res,200,{ok:true,data:{saved:true,client_version:v}});
    }
    if(req.method==='GET'&&url.pathname==='/api/device/owner-setup-code'){
      if(!isLoopbackRequest(req))return sendJson(res,403,{ok:false,error:'Owner setup code can be viewed only on the main CRM server computer.'});
      const code=ensureOwnerSetupCode();
      return sendJson(res,200,{ok:true,data:{setup_code:code,server_only:true,generated_at:nowIso()}});
    }
    if(req.method==='POST'&&url.pathname==='/api/device/register-staff'){
      const b=await readBody(req),userId=Number(b.user_id),u=db.prepare("SELECT id,name,email,role,designation FROM users WHERE id=? AND active=1 AND role='SALESPERSON'").get(userId);
      if(!u)return sendJson(res,400,{ok:false,error:'Choose a valid active staff profile.'});
      const data=issueDeviceSession(u.id,'STAFF',b.device_name||'Staff PC');return sendJson(res,200,{ok:true,data});
    }
    if(req.method==='POST'&&url.pathname==='/api/device/register-owner'){
      const b=await readBody(req),code=String(b.setup_code||'').trim().toUpperCase(),expected=String(getSetting('owner_setup_code_hash','')||'');
      if(!code||!expected||ownerSetupCodeHash(code)!==expected)return sendJson(res,403,{ok:false,error:'Owner setup code is not correct. Run SHOW_OWNER_SETUP_CODE.bat on the main server computer.'});
      const owner=db.prepare("SELECT id FROM users WHERE role='ADMIN' AND active=1 ORDER BY id LIMIT 1").get();if(!owner)return sendJson(res,404,{ok:false,error:'Owner profile is not available.'});
      const data=issueDeviceSession(owner.id,'OWNER',b.device_name||'Owner PC');rotateOwnerSetupCode();return sendJson(res,200,{ok:true,data});
    }
    if(req.method==='GET'&&url.pathname==='/api/session'){
      const viewer=viewerFromRequest(req);if(!viewer||viewer.role==='UNAUTHENTICATED')return sendJson(res,401,{ok:false,error:'This computer is not configured for a CRM user. Run the Owner or Staff PC setup once.'});
      return sendJson(res,200,{ok:true,data:viewer});
    }
    if(req.method==='GET'&&url.pathname==='/api/live-revision') return sendJson(res,200,{ok:true,data:{revision:dataRevision,time:nowIso(),crm_last_success:getSetting('company_crm_last_success',''),crm_last_error:getSetting('company_crm_last_error','')}});
    if(req.method==='GET'&&url.pathname==='/api/team-live-summary') return sendJson(res,200,{ok:true,data:teamLiveSummary(url.searchParams.get('period')||'TODAY')});
    if(req.method==='GET'&&url.pathname==='/api/integrations/company-crm/status') return sendJson(res,200,{ok:true,data:crmStatus()});
    if(req.method==='GET'&&url.pathname==='/api/integrations/company-crm/history') return sendJson(res,200,{ok:true,data:db.prepare('SELECT * FROM company_crm_sync_runs ORDER BY id DESC LIMIT 50').all()});
    if(req.method==='POST'&&url.pathname==='/api/integrations/company-crm/test'){try{const started=Date.now();const data=await testCompanyCrmConnection();saveSetting('company_crm_last_latency_ms',Date.now()-started);return sendJson(res,200,{ok:true,data});}catch(e){saveSetting('company_crm_last_error',e.message);throw e;}}
    if(req.method==='POST'&&url.pathname==='/api/integrations/company-crm/sync'){try{const b=await readBody(req);const data=await syncCompanyCrm({reconciliation:Boolean(b?.reconciliation)});bumpDataRevision();return sendJson(res,200,{ok:true,data});}catch(e){saveSetting('company_crm_last_error',e.message);throw e;}}

    if(req.method==='GET'&&url.pathname==='/api/integrations/customer-messaging/status') return sendJson(res,200,{ok:true,data:customerMessagingStatus()});
    if(req.method==='POST'&&url.pathname==='/api/integrations/whatsapp-web/enable') return sendJson(res,200,{ok:true,data:customerMessagingStatus()});
    if(req.method==='POST'&&['/api/integrations/whatsapp-cloud/config','/api/integrations/whatsapp-cloud/test','/api/integrations/whatsapp-cloud/disconnect','/api/integrations/gmail/client-json','/api/integrations/gmail/disconnect'].includes(url.pathname)) return sendJson(res,410,{ok:false,error:'Shared company WhatsApp/Gmail was removed. Each staff member now uses their own WhatsApp Web and Gmail login on their own PC/browser.'});
    if(req.method==='GET'&&url.pathname==='/api/gmail/oauth/start'){res.writeHead(302,{Location:'https://mail.google.com/','Cache-Control':'no-store'});res.end();return;}
    if(req.method==='GET'&&url.pathname==='/api/gmail/oauth/callback'){res.writeHead(302,{Location:'/#/dashboard','Cache-Control':'no-store'});res.end();return;}

    if(req.method==='GET'&&url.pathname==='/api/bootstrap'){const viewer=viewerFromRequest(req);if(!viewerIsOwner(viewer))return sendJson(res,403,{ok:false,error:'Overall dashboard is available only to the owner.'});return sendJson(res,200,{ok:true,data:dashboardData()});}
    if(req.method==='GET'&&url.pathname==='/api/team/users') return sendJson(res,200,{ok:true,data:teamUsers()});
    if(req.method==='POST'&&url.pathname==='/api/team/users'){
      const viewer=viewerFromRequest(req);if(!viewerIsOwner(viewer))return sendJson(res,403,{ok:false,error:'Only the owner can add staff profiles.'});
      const b=await readBody(req),name=String(b.name||'').trim(),email=String(b.email||'').trim()||null,designation=String(b.designation||'Sales Team').trim()||'Sales Team',phone=String(b.phone||'').trim()||null;
      if(!name)return sendJson(res,400,{ok:false,error:'Enter the staff name.'});
      let existing=db.prepare("SELECT * FROM users WHERE role='SALESPERSON' AND lower(name)=lower(?) ORDER BY id LIMIT 1").get(name);
      if(existing){
        db.prepare("UPDATE users SET active=1,email=COALESCE(?,email),designation=?,phone=COALESCE(?,phone) WHERE id=?").run(email,designation,phone,existing.id);
        bumpDataRevision();
        return sendJson(res,200,{ok:true,data:db.prepare('SELECT id,name,email,role,designation,photo_data,display_order,phone,active FROM users WHERE id=?').get(existing.id),reactivated:true});
      }
      const activeCount=Number(db.prepare("SELECT COUNT(*) AS c FROM users WHERE active=1 AND role='SALESPERSON'").get()?.c||0);
      if(activeCount>=10)return sendJson(res,400,{ok:false,error:'10 active staff profiles already exist. Deactivate or reuse an existing profile before adding another.'});
      const team=db.prepare('SELECT id FROM teams ORDER BY id LIMIT 1').get();
      const nextOrder=Number(db.prepare("SELECT COALESCE(MAX(display_order),0)+1 AS n FROM users WHERE role='SALESPERSON'").get()?.n||1);
      const id=db.prepare("INSERT INTO users(name,email,role,team_id,designation,display_order,phone,active) VALUES (?,?,?,?,?,?,?,1)").run(name,email,'SALESPERSON',team?.id||null,designation,nextOrder,phone).lastInsertRowid;
      bumpDataRevision();
      return sendJson(res,201,{ok:true,data:db.prepare('SELECT id,name,email,role,designation,photo_data,display_order,phone,active FROM users WHERE id=?').get(id)});
    }
    const staffPhotoRoute=url.pathname.match(/^\/api\/team\/users\/(\d+)\/photo$/);if(staffPhotoRoute&&req.method==='GET'){try{const out=await staffPhotoBuffer(Number(staffPhotoRoute[1]));if(!out)return send(res,404,'Photo not available',{'Content-Type':'text/plain; charset=utf-8'});return send(res,200,out.buffer,{'Content-Type':out.type,'Cache-Control':'private, max-age=300'});}catch{return send(res,404,'Photo not available',{'Content-Type':'text/plain; charset=utf-8'});}}
    if(req.method==='POST'&&url.pathname==='/api/team/sync-crm-photos'){const viewer=viewerFromRequest(req);if(!viewerIsOwner(viewer))return sendJson(res,403,{ok:false,error:'Only the owner can refresh CRM staff photos.'});const data=await syncCrmStaffDirectory();return sendJson(res,200,{ok:true,data});}
    if(req.method==='GET'&&url.pathname==='/api/owner-dashboard'){const viewer=viewerFromRequest(req);if(!viewerIsOwner(viewer))return sendJson(res,403,{ok:false,error:'Owner dashboard is available only on the owner profile.'});return sendJson(res,200,{ok:true,data:ownerDashboardData(url.searchParams.get('period')||'TODAY')});}
    if(req.method==='GET'&&url.pathname==='/api/system/client-devices'){const viewer=viewerFromRequest(req);if(!viewerIsOwner(viewer))return sendJson(res,403,{ok:false,error:'Only the owner can view client update status.'});return sendJson(res,200,{ok:true,data:{server_version:APP_VERSION,launcher_version:CLIENT_LAUNCHER_VERSION,devices:clientDeviceStatus()}});}
    const staffDash=url.pathname.match(/^\/api\/staff-dashboard\/(\d+)$/);if(staffDash&&req.method==='GET'){const viewer=viewerFromRequest(req),id=Number(staffDash[1]);if(!viewerIsOwner(viewer)&&Number(viewer?.id)!==id)return sendJson(res,403,{ok:false,error:'This staff dashboard belongs to another user.'});return sendJson(res,200,{ok:true,data:staffDashboardData(id,url.searchParams.get('period')||'TODAY')});}
    const staffDateWork=url.pathname.match(/^\/api\/staff-date-work\/(\d+)$/);if(staffDateWork&&req.method==='GET'){const viewer=viewerFromRequest(req),id=Number(staffDateWork[1]);if(!viewerIsOwner(viewer)&&Number(viewer?.id)!==id)return sendJson(res,403,{ok:false,error:'This date-wise staff history belongs to another user.'});return sendJson(res,200,{ok:true,data:staffDateWorkData(id,url.searchParams.get('period')||'TODAY')});}
    const staffUpdate=url.pathname.match(/^\/api\/team\/users\/(\d+)$/);if(staffUpdate&&req.method==='PATCH'){const viewer=viewerFromRequest(req);if(!viewerIsOwner(viewer))return sendJson(res,403,{ok:false,error:'Only the owner can edit staff profiles.'});const id=Number(staffUpdate[1]),b=await readBody(req),row=db.prepare('SELECT * FROM users WHERE id=?').get(id);if(!row)return sendJson(res,404,{ok:false,error:'Staff member not found'});const name=String(b.name??row.name).trim()||row.name,email=String(b.email??row.email??'').trim()||null,designation=String(b.designation??row.designation??'Sales Team').trim()||'Sales Team',phone=String(b.phone??row.phone??'').trim()||null;let photo=Object.hasOwn(b,'photo_data')?String(b.photo_data||''):(bundledStaffPhotoRef(name)||String(row.photo_data||''));if(photo&&photo.length>1500000)throw new Error('Staff photo is too large. Use an image below about 1 MB.');db.prepare('UPDATE users SET name=?,email=?,designation=?,phone=?,photo_data=? WHERE id=?').run(name,email,designation,phone,photo||null,id);bumpDataRevision();return sendJson(res,200,{ok:true,data:db.prepare('SELECT id,name,email,role,designation,photo_data,display_order,phone,active FROM users WHERE id=?').get(id)});}
    const leadAccessRoute=url.pathname.match(/^\/api\/leads\/(\d+)(?:\/|$)/);
    if(leadAccessRoute){const viewer=viewerFromRequest(req),leadId=Number(leadAccessRoute[1]);if(!viewerCanAccessLead(viewer,leadId))return sendJson(res,403,{ok:false,error:'This enquiry belongs to another staff member. Owner access is required.'});}
    const assignLead=url.pathname.match(/^\/api\/leads\/(\d+)\/assign$/);if(assignLead&&req.method==='PATCH'){const viewer=viewerFromRequest(req);if(!viewerIsOwner(viewer))return sendJson(res,403,{ok:false,error:'Only the owner can assign enquiries.'});const id=Number(assignLead[1]),b=await readBody(req),userId=Number(b.user_id);const u=db.prepare("SELECT id,name FROM users WHERE id=? AND active=1 AND role='SALESPERSON'").get(userId);if(!u)return sendJson(res,400,{ok:false,error:'Choose a valid sales staff member.'});const lead=db.prepare('SELECT id,assigned_to FROM leads WHERE id=?').get(id);if(!lead)return sendJson(res,404,{ok:false,error:'Lead not found'});db.prepare('UPDATE leads SET assigned_to=?,updated_at=? WHERE id=?').run(userId,nowIso(),id);addActivity(id,'ASSIGNMENT','Lead assigned to staff',`Owner assigned this enquiry to ${u.name}.`);bumpDataRevision();return sendJson(res,200,{ok:true,data:{lead_id:id,user_id:userId,user_name:u.name}});}
    const quickSkipRoute=url.pathname.match(/^\/api\/leads\/(\d+)\/quick-skip$/);if(quickSkipRoute&&req.method==='POST'){
      const viewer=viewerFromRequest(req),id=Number(quickSkipRoute[1]);if(!viewerCanAccessLead(viewer,id))return sendJson(res,403,{ok:false,error:'This enquiry belongs to another staff member.'});if(viewerIsOwner(viewer))return sendJson(res,403,{ok:false,error:'Quick no-response skip is a staff action. Open the staff profile to record it.'});const b=await readBody(req);
      return sendJson(res,200,{ok:true,data:recordLeadQuickSkip(id,b.reason_code,viewer)});
    }
    const workStatusRoute=url.pathname.match(/^\/api\/leads\/(\d+)\/work-status$/);if(workStatusRoute&&req.method==='PATCH'){
      const viewer=viewerFromRequest(req),id=Number(workStatusRoute[1]);if(!viewerCanAccessLead(viewer,id))return sendJson(res,403,{ok:false,error:'This enquiry belongs to another staff member.'});const b=await readBody(req);
      return sendJson(res,200,{ok:true,data:setLeadWorkStatus(id,b.status,b.reason||'',viewer,{silentDuplicate:true})});
    }
    if(req.method==='GET'&&url.pathname==='/api/search'){const viewer=viewerFromRequest(req);return sendJson(res,200,{ok:true,data:globalSearch(url.searchParams.get('q')||'',viewerIsOwner(viewer)?null:viewer.id)});}
    if(req.method==='GET'&&url.pathname==='/api/notifications'){
      const viewer=viewerFromRequest(req);if(Number(viewer?.id||0)<=0)return sendJson(res,401,{ok:false,error:'This computer is not configured.'});
      const rows=viewerIsOwner(viewer)?db.prepare(`SELECT n.*,l.lead_code,u.name AS staff_name,c.name AS customer_name,pr.product_name FROM notifications n LEFT JOIN leads l ON l.id=n.lead_id LEFT JOIN users u ON u.id=l.assigned_to LEFT JOIN customers c ON c.id=l.customer_id LEFT JOIN product_requirements pr ON pr.id=(SELECT MIN(x.id) FROM product_requirements x WHERE x.lead_id=l.id) WHERE n.is_read=0 AND (n.user_id IS NULL OR n.user_id=?) ORDER BY n.created_at DESC LIMIT 50`).all(viewer.id):db.prepare(`SELECT n.*,l.lead_code FROM notifications n JOIN leads l ON l.id=n.lead_id WHERE n.is_read=0 AND l.assigned_to=? ORDER BY n.created_at DESC LIMIT 30`).all(viewer.id);
      const overdue=viewerIsOwner(viewer)?Number(db.prepare("SELECT COUNT(*) AS c FROM followups WHERE status='PENDING' AND due_at<?").get(nowIso())?.c||0):Number(db.prepare("SELECT COUNT(*) AS c FROM followups f JOIN leads l ON l.id=f.lead_id WHERE f.status='PENDING' AND f.due_at<? AND l.assigned_to=?").get(nowIso(),viewer.id)?.c||0);return sendJson(res,200,{ok:true,data:{rows,unread:rows.length,overdue_followups:overdue}});
    }
    const nm=url.pathname.match(/^\/api\/notifications\/(\d+)$/);if(nm&&req.method==='PATCH'){const viewer=viewerFromRequest(req),id=Number(nm[1]);if(!viewerIsOwner(viewer)){const ok=db.prepare('SELECT 1 FROM notifications n JOIN leads l ON l.id=n.lead_id WHERE n.id=? AND l.assigned_to=?').get(id,viewer.id);if(!ok)return sendJson(res,403,{ok:false,error:'This notification belongs to another staff member.'});}db.prepare('UPDATE notifications SET is_read=1 WHERE id=?').run(id);return sendJson(res,200,{ok:true,data:{saved:true}});}

    if(req.method==='GET'&&(url.pathname==='/api/leads/summary'||url.pathname==='/api/leads')){const viewer=viewerFromRequest(req);if(!viewerIsOwner(viewer))url.searchParams.set('owner',String(viewer.id));return sendJson(res,200,{ok:true,data:listLeadPage(url)});}
    if(req.method==='POST'&&url.pathname==='/api/leads/parse'){const b=await readBody(req);return sendJson(res,200,{ok:true,data:parseEnquiry(b.text||'')});}
    if(req.method==='POST'&&url.pathname==='/api/leads'){const b=await readBody(req),viewer=viewerFromRequest(req);const data=createLead(b.parsed||b,b.source_type||'MANUAL');if(!viewerIsOwner(viewer)&&data?.lead?.id){db.prepare('UPDATE leads SET assigned_to=?,updated_at=? WHERE id=?').run(viewer.id,nowIso(),data.lead.id);bumpDataRevision();return sendJson(res,201,{ok:true,data:hydrateLead(data.lead.id)});}return sendJson(res,201,{ok:true,data});}
    const lm=url.pathname.match(/^\/api\/leads\/(\d+)$/);if(lm&&req.method==='GET'){const id=Number(lm[1]),viewer=viewerFromRequest(req),row=db.prepare('SELECT assigned_to FROM leads WHERE id=?').get(id);if(!viewerIsOwner(viewer)&&Number(row?.assigned_to)!==Number(viewer?.id))return sendJson(res,403,{ok:false,error:'This enquiry is assigned to another staff member.'});const d=hydrateLead(id);return d?sendJson(res,200,{ok:true,data:d}):sendJson(res,404,{ok:false,error:'Lead not found'});}
    const budgetWhatsapp=url.pathname.match(/^\/api\/leads\/(\d+)\/request-budget\/whatsapp$/);if(budgetWhatsapp&&req.method==='POST'){const id=Number(budgetWhatsapp[1]),d=hydrateLead(id);if(!d)return sendJson(res,404,{ok:false,error:'Lead not found'});const r=d.requirements?.[0]||{};if(Number(r.budget)>0||Number(r.price_expectation)>0)return sendJson(res,409,{ok:false,error:'Customer budget / target price is already available for this lead.'});const phone=normalizeWhatsAppPhone(d.customer?.phone,d.customer?.country);if(!phone)return sendJson(res,400,{ok:false,error:'Customer phone number is not available.'});const content=budgetRequestContent(d),wa=whatsappPersonalUrl(phone,content.message);db.prepare('INSERT INTO communications(lead_id,method,direction,subject,body,outcome,communicated_at,user_id) VALUES (?,?,?,?,?,?,?,?)').run(id,'WHATSAPP','OUTBOUND','Budget request',content.message,'BUDGET REQUEST PREPARED',nowIso(),viewerFromRequest(req)?.id||1);addActivity(id,'BUDGET_REQUEST','Budget request opened in personal WhatsApp',`Opened for ${d.customer?.phone||phone}. Staff must press Send in WhatsApp.`);bumpDataRevision();return sendJson(res,200,{ok:true,data:{url:wa,message:content.message,shared_server:false,personal_browser:true}});}
    const budgetEmail=url.pathname.match(/^\/api\/leads\/(\d+)\/request-budget\/email$/);if(budgetEmail&&req.method==='POST'){const id=Number(budgetEmail[1]),d=hydrateLead(id);if(!d)return sendJson(res,404,{ok:false,error:'Lead not found'});const r=d.requirements?.[0]||{};if(Number(r.budget)>0||Number(r.price_expectation)>0)return sendJson(res,409,{ok:false,error:'Customer budget / target price is already available for this lead.'});if(!d.customer?.email)return sendJson(res,400,{ok:false,error:'Customer email is not available.'});const content=budgetRequestContent(d),url=gmailPersonalComposeUrl({to:d.customer.email,subject:content.subject,body:content.message});db.prepare('INSERT INTO communications(lead_id,method,direction,subject,body,outcome,communicated_at,user_id) VALUES (?,?,?,?,?,?,?,?)').run(id,'EMAIL','OUTBOUND',content.subject,content.message,'BUDGET REQUEST PREPARED',nowIso(),viewerFromRequest(req)?.id||1);addActivity(id,'BUDGET_REQUEST','Budget request opened in personal Gmail',`Opened for ${d.customer.email}. Staff must press Send in Gmail.`);bumpDataRevision();return sendJson(res,200,{ok:true,data:{url,to:d.customer.email,subject:content.subject,personal_browser:true}});}
    const objectionWa=url.pathname.match(/^\/api\/leads\/(\d+)\/objection-assistant\/whatsapp$/);if(objectionWa&&req.method==='POST'){const id=Number(objectionWa[1]),b=await readBody(req),d=hydrateLead(id);if(!d)return sendJson(res,404,{ok:false,error:'Lead not found'});const phone=normalizeWhatsAppPhone(d.customer?.phone,d.customer?.country);if(!phone)return sendJson(res,400,{ok:false,error:'Customer phone number is not available.'});const response=String(b.response||d.objections?.[0]?.ai_suggested_response||'').trim();if(!response)return sendJson(res,400,{ok:false,error:'No objection response is available.'});const wa=whatsappPersonalUrl(phone,response);addActivity(id,'OBJECTION_RESPONSE','Objection response opened in personal WhatsApp',response);bumpDataRevision();return sendJson(res,200,{ok:true,data:{url:wa,shared_server:false,personal_browser:true}});}
    const objectionMail=url.pathname.match(/^\/api\/leads\/(\d+)\/objection-assistant\/email$/);if(objectionMail&&req.method==='POST'){const id=Number(objectionMail[1]),b=await readBody(req),d=hydrateLead(id);if(!d)return sendJson(res,404,{ok:false,error:'Lead not found'});if(!d.customer?.email)return sendJson(res,400,{ok:false,error:'Customer email is not available.'});const response=String(b.response||d.objections?.[0]?.ai_suggested_response||'').trim();if(!response)return sendJson(res,400,{ok:false,error:'No objection response is available.'});const subject=`Response - ${d.requirements?.[0]?.product_name||'Product Enquiry'}`,url=gmailPersonalComposeUrl({to:d.customer.email,subject,body:response});db.prepare('INSERT INTO communications(lead_id,method,direction,subject,body,outcome,communicated_at,user_id) VALUES (?,?,?,?,?,?,?,?)').run(id,'EMAIL','OUTBOUND',subject,response,'OBJECTION RESPONSE PREPARED',nowIso(),viewerFromRequest(req)?.id||1);addActivity(id,'OBJECTION_RESPONSE','Objection response opened in personal Gmail',response);bumpDataRevision();return sendJson(res,200,{ok:true,data:{url,personal_browser:true}});}
    const closeAction=url.pathname.match(/^\/api\/leads\/(\d+)\/close-action$/);if(closeAction&&req.method==='POST'){const id=Number(closeAction[1]),b=await readBody(req),action=String(b.action||'').toUpperCase(),d=hydrateLead(id);if(!d)return sendJson(res,404,{ok:false,error:'Lead not found'});if(!['ASK_FOR_ORDER','SEND_PI','CONFIRM_ORDER','PAYMENT_FOLLOW_UP'].includes(action))return sendJson(res,400,{ok:false,error:'Invalid close-sale action.'});if(action==='CONFIRM_ORDER'){const value=Number(d.price_intelligence?.suggested_selling||d.quotations?.[0]?.total||d.lead.expected_value||0)||null;db.prepare("UPDATE leads SET order_status='ORDER CONFIRMED',pipeline_stage='WON',status='WON',purchase_intent='READY TO BUY',order_value=COALESCE(order_value,?),order_date=COALESCE(order_date,?),updated_at=? WHERE id=?").run(value,nowIso(),nowIso(),id);addActivity(id,'ORDER_CONFIRMED','Order confirmed from Close This Sale','Salesperson confirmed the customer order.');setLeadWorkStatus(id,'COMPLETED','',viewerFromRequest(req),{silentDuplicate:true});return sendJson(res,200,{ok:true,data:{message:'Order confirmed'}})}const content=closeSaleMessage(d,action),viewerId=viewerFromRequest(req)?.id||1;if(action==='SEND_PI'){if(!d.customer?.email)return sendJson(res,400,{ok:false,error:'Customer email is not available. Add it before sending the Proforma Invoice.'});const url=gmailPersonalComposeUrl({to:d.customer.email,subject:content.subject,body:content.message});db.prepare('INSERT INTO communications(lead_id,method,direction,subject,body,outcome,communicated_at,user_id) VALUES (?,?,?,?,?,?,?,?)').run(id,'EMAIL','OUTBOUND',content.subject,content.message,'PROFORMA INVOICE EMAIL PREPARED',nowIso(),viewerId);addActivity(id,'PROFORMA_INVOICE','Proforma Invoice opened in personal Gmail','Staff must attach the opened PI PDF and press Send.');bumpDataRevision();return sendJson(res,200,{ok:true,data:{url,pdf_url:`/api/leads/${id}/proforma-invoice.pdf`,message:'Proforma Invoice email opened in your personal Gmail. Attach the opened PDF and press Send.'}})}if(action==='ASK_FOR_ORDER')db.prepare("UPDATE leads SET order_status='READY TO ORDER',purchase_intent='READY TO BUY',pipeline_stage=CASE WHEN pipeline_stage='WON' THEN pipeline_stage ELSE 'ORDER EXPECTED' END,updated_at=? WHERE id=?").run(nowIso(),id);if(action==='PAYMENT_FOLLOW_UP'){const due=new Date(Date.now()+86400000).toISOString();db.prepare("INSERT INTO followups(lead_id,due_at,method,status,notes,priority,reason,assigned_to,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,1,?)").run(id,due,'PAYMENT','PENDING','Payment follow-up from Close This Sale','HIGH','PAYMENT',d.lead.assigned_to||1,nowIso());db.prepare('UPDATE leads SET next_followup_at=?,updated_at=? WHERE id=?').run(due,nowIso(),id)}addActivity(id,'CLOSE_SALE',action.replaceAll('_',' '),content.message);bumpDataRevision();const phone=normalizeWhatsAppPhone(d.customer?.phone,d.customer?.country);if(phone)return sendJson(res,200,{ok:true,data:{url:whatsappPersonalUrl(phone,content.message),shared_server:false,personal_browser:true,message:action==='ASK_FOR_ORDER'?'Ask-for-order message opened in your personal WhatsApp':'Payment follow-up opened in your personal WhatsApp'}});if(d.customer?.email)return sendJson(res,200,{ok:true,data:{url:gmailPersonalComposeUrl({to:d.customer.email,subject:content.subject,body:content.message}),personal_browser:true,message:action==='ASK_FOR_ORDER'?'Ask-for-order email opened in your personal Gmail':'Payment follow-up email opened in your personal Gmail'}});return sendJson(res,200,{ok:true,data:{message:'Action saved. Add the customer phone number or email to prepare the message.'}});}
    const piPdfRoute=url.pathname.match(/^\/api\/leads\/(\d+)\/proforma-invoice\.pdf$/);if(piPdfRoute&&req.method==='GET'){const pi=proformaInvoicePdf(Number(piPdfRoute[1]));res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':`inline; filename="${pi.filename}"`,'Cache-Control':'no-store'});return res.end(pi.buffer);}
    const offerPreview=url.pathname.match(/^\/api\/leads\/(\d+)\/limited-offer\/preview$/);if(offerPreview&&req.method==='POST'){const id=Number(offerPreview[1]),b=await readBody(req);const ctx=offerPriceContext(id,b);return sendJson(res,200,{ok:true,data:{market_type:ctx.market,base_price:ctx.base_price,regular_selling_price:ctx.regular_selling_price,regular_margin_percent:ctx.regular_margin_percent,minimum_margin_percent:ctx.minimum_margin_percent,minimum_offer_price:ctx.minimum_offer_price,max_discount_percent:ctx.max_discount_percent,discount_percent:ctx.discount_percent,offer_price:ctx.offer_price,validity_minutes:ctx.validity_minutes}});}
    const offerWhatsapp=url.pathname.match(/^\/api\/leads\/(\d+)\/limited-offer\/whatsapp$/);if(offerWhatsapp&&req.method==='POST'){const id=Number(offerWhatsapp[1]),b=await readBody(req),d=hydrateLead(id);if(!d)return sendJson(res,404,{ok:false,error:'Lead not found'});const phone=normalizeWhatsAppPhone(d.customer?.phone,d.customer?.country);if(!phone)return sendJson(res,400,{ok:false,error:'Customer phone number is not available.'});const made=prepareLimitedOffer(id,b,'WHATSAPP');db.prepare("UPDATE limited_time_offers SET status='PENDING_SEND',updated_at=? WHERE id=?").run(nowIso(),made.id);const wa=whatsappPersonalUrl(phone,made.content.message);db.prepare('INSERT INTO communications(lead_id,method,direction,subject,body,outcome,communicated_at,user_id) VALUES (?,?,?,?,?,?,?,?)').run(id,'WHATSAPP','OUTBOUND','Limited-time offer',made.content.message,'OFFER PREPARED - NOT YET CONFIRMED SENT',nowIso(),viewerFromRequest(req)?.id||1);addActivity(id,'LIMITED_OFFER','Limited-time offer opened in personal WhatsApp','Countdown has not started. Confirm only after the WhatsApp message is actually sent.');bumpDataRevision();return sendJson(res,200,{ok:true,data:{url:wa,shared_server:false,personal_browser:true,offer:latestLimitedOfferForLead(id)}});}
    const offerWhatsappConfirm=url.pathname.match(/^\/api\/limited-offers\/(\d+)\/confirm-(?:whatsapp-)?sent$/);if(offerWhatsappConfirm&&req.method==='POST'){const offerId=Number(offerWhatsappConfirm[1]),row=db.prepare('SELECT * FROM limited_time_offers WHERE id=?').get(offerId);if(!row)return sendJson(res,404,{ok:false,error:'Offer not found'});if(!['PENDING_SEND','DRAFT'].includes(String(row.status||'').toUpperCase()))return sendJson(res,409,{ok:false,error:'This offer is not waiting for send confirmation.'});const channel=String(row.channel||'WHATSAPP').toUpperCase()==='EMAIL'?'EMAIL':'WHATSAPP',active=activateLimitedOffer(offerId,channel);db.prepare("UPDATE communications SET outcome='LIMITED OFFER SENT' WHERE id=(SELECT id FROM communications WHERE lead_id=? AND method=? AND subject='Limited-time offer' ORDER BY id DESC LIMIT 1)").run(row.lead_id,channel);bumpDataRevision();return sendJson(res,200,{ok:true,data:{...active,remaining_seconds:Math.max(0,Math.ceil((Date.parse(active.expires_at)-Date.now())/1000))}});}
    const offerEmail=url.pathname.match(/^\/api\/leads\/(\d+)\/limited-offer\/email$/);if(offerEmail&&req.method==='POST'){const id=Number(offerEmail[1]),b=await readBody(req),d=hydrateLead(id);if(!d)return sendJson(res,404,{ok:false,error:'Lead not found'});if(!d.customer?.email)return sendJson(res,400,{ok:false,error:'Customer email is not available.'});const made=prepareLimitedOffer(id,b,'EMAIL');db.prepare("UPDATE limited_time_offers SET status='PENDING_SEND',updated_at=? WHERE id=?").run(nowIso(),made.id);const url=gmailPersonalComposeUrl({to:d.customer.email,subject:made.content.subject,body:made.content.message});db.prepare('INSERT INTO communications(lead_id,method,direction,subject,body,outcome,communicated_at,user_id) VALUES (?,?,?,?,?,?,?,?)').run(id,'EMAIL','OUTBOUND','Limited-time offer',made.content.message,'OFFER PREPARED - NOT YET CONFIRMED SENT',nowIso(),viewerFromRequest(req)?.id||1);addActivity(id,'LIMITED_OFFER','Limited-time offer opened in personal Gmail','Countdown has not started. Confirm only after the email is actually sent.');bumpDataRevision();return sendJson(res,200,{ok:true,data:{url,personal_browser:true,offer:latestLimitedOfferForLead(id)}});}
    const offerStatus=url.pathname.match(/^\/api\/limited-offers\/(\d+)\/status$/);if(offerStatus&&req.method==='PATCH'){const offerId=Number(offerStatus[1]),b=await readBody(req),row=db.prepare('SELECT * FROM limited_time_offers WHERE id=?').get(offerId);if(!row)return sendJson(res,404,{ok:false,error:'Offer not found'});refreshLimitedOfferExpiry(row.lead_id);const fresh=db.prepare('SELECT * FROM limited_time_offers WHERE id=?').get(offerId);const next=String(b.status||'').toUpperCase();if(!['ACCEPTED','DECLINED'].includes(next))return sendJson(res,400,{ok:false,error:'Offer status can only be changed to Accepted or Declined.'});if(String(fresh.status||'').toUpperCase()!=='ACTIVE')return sendJson(res,409,{ok:false,error:`Only an active offer can be marked Accepted or Declined. Current status: ${fresh.status}.`});const stamp=nowIso();db.prepare(`UPDATE limited_time_offers SET status=?,accepted_at=?,declined_at=?,updated_at=? WHERE id=?`).run(next,next==='ACCEPTED'?stamp:null,next==='DECLINED'?stamp:null,stamp,offerId);recordLimitedOfferStatus(offerId,fresh.lead_id,next,b.note||`Customer marked the limited-time offer as ${next.toLowerCase()}.`);addActivity(fresh.lead_id,'LIMITED_OFFER',`Offer ${next.toLowerCase()}`,b.note||`Customer marked the limited-time offer as ${next.toLowerCase()}.`);bumpDataRevision();return sendJson(res,200,{ok:true,data:latestLimitedOfferForLead(fresh.lead_id)});}
    const offerGet=url.pathname.match(/^\/api\/leads\/(\d+)\/limited-offer$/);if(offerGet&&req.method==='GET'){const id=Number(offerGet[1]);if(!db.prepare('SELECT id FROM leads WHERE id=?').get(id))return sendJson(res,404,{ok:false,error:'Lead not found'});return sendJson(res,200,{ok:true,data:latestLimitedOfferForLead(id)});}
    const productInfoRoute=url.pathname.match(/^\/api\/leads\/(\d+)\/product-intelligence$/);if(productInfoRoute&&req.method==='GET'){const id=Number(productInfoRoute[1]);const lead=db.prepare('SELECT product_analysis_status FROM leads WHERE id=?').get(id);if(!lead)return sendJson(res,404,{ok:false,error:'Lead not found'});return sendJson(res,200,{ok:true,data:{status:lead.product_analysis_status,items:productIntelligenceForLead(id)}});}
    const formRoute=url.pathname.match(/^\/api\/leads\/(\d+)\/form$/);if(formRoute&&req.method==='PATCH'){const id=Number(formRoute[1]),b=await readBody(req),viewer=viewerFromRequest(req);if(!viewerIsOwner(viewer))b.owner_id=viewer.id;return sendJson(res,200,{ok:true,data:saveSimpleLeadForm(id,b,viewer)});}
const profile=url.pathname.match(/^\/api\/leads\/(\d+)\/profile$/);if(profile&&req.method==='PATCH'){
      const id=Number(profile[1]),b=await readBody(req),lead=db.prepare('SELECT * FROM leads WHERE id=?').get(id);if(!lead)return sendJson(res,404,{ok:false,error:'Lead not found'});
      const customer=db.prepare('SELECT * FROM customers WHERE id=?').get(lead.customer_id);const c=b.customer||b;
      const customerFields=['name','company','phone','email','address','city','state','country','pincode'];const sets=[],vals=[];
      for(const f of customerFields)if(Object.hasOwn(c,f)){sets.push(`${f}=?`);vals.push(c[f]||null);}
      if(Object.hasOwn(c,'phone')){sets.push('normalized_phone=?');vals.push(normalizePhone(c.phone)||null);}
      if(sets.length)db.prepare(`UPDATE customers SET ${sets.join(',')},updated_at=? WHERE id=?`).run(...vals,nowIso(),lead.customer_id);
      if(Object.hasOwn(b,'market_type_override')){const m=String(b.market_type_override||'').toUpperCase();db.prepare('UPDATE leads SET market_type_override=?,updated_at=? WHERE id=?').run(['INDIA','EXPORT'].includes(m)?m:null,nowIso(),id);}
      addActivity(id,'PROFILE','Lead/customer information updated','Customer contact/location or India/Export classification updated.');bumpDataRevision();return sendJson(res,200,{ok:true,data:hydrateLead(id)});
    }
    const analyze=url.pathname.match(/^\/api\/leads\/(\d+)\/analyze$/);if(analyze&&req.method==='POST'){const id=Number(analyze[1]),b=await readBody(req);if(Boolean(b?.price_only)&&Boolean(b?.force_price_refresh)&&!Boolean(b?.force_product_refresh))await runLeadPriceRefresh(id,{force:true});else await runLeadAnalysis(id,{forceProductRefresh:Boolean(b?.force_product_refresh),forcePriceRefresh:Boolean(b?.force_price_refresh)});return sendJson(res,200,{ok:true,data:hydrateLead(id)});}

    const qlm=url.pathname.match(/^\/api\/leads\/(\d+)\/qualification$/);if(qlm&&req.method==='PATCH'){
      const id=Number(qlm[1]);const before=db.prepare('SELECT * FROM leads WHERE id=?').get(id);const b=await readBody(req);if(!before)return sendJson(res,404,{ok:false,error:'Lead not found'});
      const fields=['budget_status','requirement_status','urgency','decision_maker','purchase_intent','timeline','manual_override','manual_override_reason','expected_value'];const sets=[],vals=[];
      for(const f of fields)if(Object.hasOwn(b,f)){sets.push(`${f}=?`);const nextVal=f==='expected_value'?(b[f]===''?null:Number(b[f])||null):b[f];vals.push(nextVal);if(String(before[f]??'')!==String(nextVal??''))recordVerification(id,f,before[f],nextVal,b.reason_for_override||b.manual_override_reason||'Marketing verification');}
      if(sets.length)db.prepare(`UPDATE leads SET ${sets.join(',')},updated_at=? WHERE id=?`).run(...vals,nowIso(),id);
      db.prepare(`UPDATE leads SET verified_at=?,verified_by=?,updated_at=? WHERE id=?`).run(nowIso(),'Sebastian Nunes',nowIso(),id);
      const score=calculateLeadScore(id,{markVerified:true,verifiedScore:Object.hasOwn(b,'verified_score')?b.verified_score:null});const after=db.prepare('SELECT * FROM leads WHERE id=?').get(id);addAudit('lead',id,'QUALIFICATION_UPDATE',before,after);addActivity(id,'QUALIFICATION',`Marketing verification saved — ${score.score}%`,`${score.temperature} / ${score.priority} priority${b.manual_override_reason?` — ${b.manual_override_reason}`:''}`);
      const known=v=>v&&v!=='UNKNOWN';const ready=after.requirement_status==='CONFIRMED'&&after.budget_status!=='UNKNOWN'&&known(after.urgency)&&known(after.decision_maker)&&known(after.timeline)&&after.purchase_intent!=='JUST ENQUIRY';
      if(ready)completePlaybookStage(id,1,{notes:`Qualification verified — ${score.temperature} / ${score.score}%`,data:b,activity:false});else{ensurePlaybookForLead(id);db.prepare(`UPDATE sales_playbook_progress SET status='ACTIVE',stage_data_json=?,notes=?,updated_at=? WHERE lead_id=? AND stage_no=1`).run(json(b),'Qualification saved; some verification fields are still pending.',nowIso(),id);}
      bumpDataRevision();return sendJson(res,200,{ok:true,data:hydrateLead(id)});
    }

    const rm=url.pathname.match(/^\/api\/leads\/(\d+)\/requirements\/(\d+)$/);if(rm&&req.method==='PATCH'){
      const leadId=Number(rm[1]),rid=Number(rm[2]),b=await readBody(req);const reqRow=db.prepare('SELECT * FROM product_requirements WHERE id=? AND lead_id=?').get(rid,leadId);if(!reqRow)return sendJson(res,404,{ok:false,error:'Requirement not found'});
      const fields=['product_name','requested_brand','requested_model','quantity','unit','application','required_specification','required_accuracy','required_range','requested_features','requested_certification','requested_accessories','delivery_location','required_delivery_date','budget','price_expectation','preferred_brand','alternative_brand_accepted','catalogue_required','quotation_required','technical_datasheet_required','installation_required','calibration_required','other_notes'];const sets=[],vals=[],reqStatus=safeJson(reqRow.status_json,{})||{};reqStatus.simple_choices=reqStatus.simple_choices||{};let reqStatusChanged=false;const boolChoiceKey={catalogue_required:'catalogue_required',quotation_required:'quotation_required',technical_datasheet_required:'datasheet_required',installation_required:'installation_required',calibration_required:'calibration_required'};for(const f of fields)if(Object.hasOwn(b,f)){if(Object.hasOwn(boolChoiceKey,f)&&String(b[f]??'').trim()==='')continue;sets.push(`${f}=?`);if(['quantity','budget','price_expectation'].includes(f))vals.push(b[f]!==''?Number(b[f])||null:null);else if(Object.hasOwn(boolChoiceKey,f)){const yes=['1','true','yes','on'].includes(String(b[f]).toLowerCase());vals.push(yes?1:0);reqStatus.simple_choices[boolChoiceKey[f]]=yes?'YES':'NO';reqStatusChanged=true;}else vals.push(b[f]);}if(reqStatusChanged){sets.push('status_json=?');vals.push(json(reqStatus));}
      if(sets.length)db.prepare(`UPDATE product_requirements SET ${sets.join(',')} WHERE id=? AND lead_id=?`).run(...vals,rid,leadId);
      const updated=db.prepare('SELECT * FROM product_requirements WHERE id=?').get(rid);const hasNeed=Boolean(updated.application||updated.required_specification||updated.required_range||updated.required_accuracy);db.prepare(`UPDATE leads SET requirement_status=?,budget_status=CASE WHEN ? IS NOT NULL THEN 'CONFIRMED' ELSE budget_status END,expected_value=COALESCE(expected_value,?),analysis_version=0,product_analysis_status='ANALYZING',price_analysis_status='SEARCHING',qualification_status='CALCULATING',updated_at=? WHERE id=?`).run(hasNeed?'CONFIRMED':'NEEDS CLARIFICATION',updated.budget,updated.budget,nowIso(),leadId);addActivity(leadId,'REQUIREMENT','Buyer requirement updated','Discovery answers saved to Buyer Requirements. Product matching and qualification recalculation queued.');if(hasNeed)completePlaybookStage(leadId,3,{notes:'Customer need details saved',data:{requirement_id:rid},activity:false});enqueueLeadAnalysis(leadId,db.prepare('SELECT live_classification FROM leads WHERE id=?').get(leadId)?.live_classification);bumpDataRevision();return sendJson(res,200,{ok:true,data:hydrateLead(leadId)});
    }

    const sm=url.pathname.match(/^\/api\/leads\/(\d+)\/stage$/);if(sm&&req.method==='PATCH'){
      const id=Number(sm[1]),b=await readBody(req);const before=db.prepare('SELECT pipeline_stage FROM leads WHERE id=?').get(id);if(!before)return sendJson(res,404,{ok:false,error:'Lead not found'});if(!config.pipeline_stages.includes(b.stage))throw new Error('Invalid pipeline stage.');db.prepare('UPDATE leads SET pipeline_stage=?,updated_at=? WHERE id=?').run(b.stage,nowIso(),id);if(before.pipeline_stage!==b.stage)db.prepare('INSERT INTO pipeline_history(lead_id,from_stage,to_stage,changed_by,changed_at) VALUES (?,?,?,?,?)').run(id,before.pipeline_stage,b.stage,1,nowIso());addActivity(id,'STAGE',`Pipeline moved to ${b.stage}`,`Previous stage: ${before.pipeline_stage}`);calculateLeadScore(id);bumpDataRevision();return sendJson(res,200,{ok:true,data:hydrateLead(id)});
    }
    const outcome=url.pathname.match(/^\/api\/leads\/(\d+)\/outcome$/);if(outcome&&req.method==='POST'){
      const id=Number(outcome[1]),b=await readBody(req),lead=db.prepare('SELECT * FROM leads WHERE id=?').get(id);if(!lead)return sendJson(res,404,{ok:false,error:'Lead not found'});const action=String(b.action||'').toUpperCase();let stage=lead.pipeline_stage;
      if(action==='ORDER CONFIRMED'||action==='WON'){stage='WON';db.prepare("UPDATE leads SET pipeline_stage='WON',status='WON',purchase_intent='READY TO BUY',order_value=?,order_date=?,po_number=?,updated_at=? WHERE id=?").run(Number(b.order_value)||lead.expected_value||null,validDateIso(b.order_date)||nowIso(),b.po_number||null,nowIso(),id);completePlaybookStage(id,10,{notes:'Order confirmed',data:b,activity:false});addActivity(id,'ORDER_CONFIRMED','Order confirmed',`Value: ${b.order_value||lead.expected_value||'Not Available'}${b.po_number?` • PO ${b.po_number}`:''}`);}
      else if(action==='LOST'){if(!b.reason)throw new Error('Lost reason is required.');stage='LOST';db.prepare("UPDATE leads SET pipeline_stage='LOST',status='LOST',lost_reason=?,updated_at=? WHERE id=?").run(b.reason,nowIso(),id);completePlaybookStage(id,10,{notes:`Order decision recorded — LOST (${b.reason})`,data:b,activity:false});addActivity(id,'LOST',`Lead lost — ${b.reason}`,b.notes||'');}
      else if(action==='NURTURE'){stage='NURTURE';db.prepare("UPDATE leads SET pipeline_stage='NURTURE',status='OPEN',updated_at=? WHERE id=?").run(nowIso(),id);addActivity(id,'NURTURE','Lead moved to nurture',b.notes||'');}
      else if(['WAITING FOR PO','WAITING FOR APPROVAL','FOLLOW-UP REQUIRED','NOT READY','NEGOTIATING'].includes(action)){stage=action==='WAITING FOR PO'?'ORDER EXPECTED':action==='NEGOTIATING'?'NEGOTIATION':lead.pipeline_stage;db.prepare('UPDATE leads SET pipeline_stage=?,updated_at=? WHERE id=?').run(stage,nowIso(),id);completePlaybookStage(id,10,{notes:`Asked for order — ${action}`,data:{action,...b},activity:false});addActivity(id,'ORDER_STATUS',action,b.notes||'');}
      if(stage!==lead.pipeline_stage)db.prepare('INSERT INTO pipeline_history(lead_id,from_stage,to_stage,changed_by,changed_at) VALUES (?,?,?,?,?)').run(id,lead.pipeline_stage,stage,1,nowIso());calculateLeadScore(id);bumpDataRevision();return sendJson(res,200,{ok:true,data:hydrateLead(id)});
    }

    const pm=url.pathname.match(/^\/api\/leads\/(\d+)\/playbook\/(\d+)$/);if(pm&&req.method==='PATCH'){
      const leadId=Number(pm[1]),stageNo=Number(pm[2]),b=await readBody(req),status=String(b.status||'COMPLETED').toUpperCase();if(stageNo<1||stageNo>PLAYBOOK_STAGES.length)throw new Error('Invalid playbook step');if(!['COMPLETED','SKIPPED','ACTIVE','PENDING'].includes(status))throw new Error('Invalid playbook status');if(!db.prepare('SELECT id FROM leads WHERE id=?').get(leadId))return sendJson(res,404,{ok:false,error:'Lead not found'});if(status==='SKIPPED'&&!String(b.skip_reason||b.notes||'').trim())throw new Error('Skip reason is required.');if(status==='COMPLETED')applyPlaybookStageData(leadId,stageNo,b.data||{});completePlaybookStage(leadId,stageNo,{status,notes:b.notes||b.skip_reason||null,data:{...(b.data||{}),...(status==='SKIPPED'?{skip_reason:b.skip_reason||b.notes}:{} )},activity:true});if(status==='SKIPPED')db.prepare('UPDATE sales_playbook_progress SET skip_reason=? WHERE lead_id=? AND stage_no=?').run(String(b.skip_reason||b.notes||'').trim(),leadId,stageNo);syncPlaybookEvidence(leadId);bumpDataRevision();return sendJson(res,200,{ok:true,data:hydrateLead(leadId)});
    }

    const am=url.pathname.match(/^\/api\/leads\/(\d+)\/activity$/);if(am&&req.method==='POST'){
      const id=Number(am[1]),b=await readBody(req);if(b.type==='CONTACT')return sendJson(res,200,{ok:true,data:contactLead(id,b)});if(b.type==='MARK_CONTACTED')return sendJson(res,200,{ok:true,data:contactLead(id,{method:b.method||'CALL',outcome:'CONTACTED',detail:b.detail||''})});if(b.type==='NOTE'&&b.detail)db.prepare('INSERT INTO notes(lead_id,note,user_id,created_at) VALUES (?,?,1,?)').run(id,b.detail,nowIso());addActivity(id,b.type||'ACTION',b.title||'Activity recorded',b.detail||'');bumpDataRevision();return sendJson(res,200,{ok:true,data:hydrateLead(id)});
    }

    const fm=url.pathname.match(/^\/api\/leads\/(\d+)\/followups$/);if(fm&&req.method==='POST'){const id=Number(fm[1]),b=await readBody(req);createFollowup(id,b);return sendJson(res,201,{ok:true,data:hydrateLead(id)});}
    const fud=url.pathname.match(/^\/api\/followups\/(\d+)\/details$/);if(fud&&req.method==='GET'){const viewer=viewerFromRequest(req),row=db.prepare(`SELECT f.*,l.id AS lead_id,l.lead_code,l.assigned_to,l.form_status,l.form_completion_percent,l.form_last_saved_at,l.form_completed_at,l.work_status,l.hold_reason,l.pipeline_stage,l.order_status,c.name AS customer_name,c.company,c.phone,c.email,u.name AS staff_name,(SELECT product_name FROM product_requirements pr WHERE pr.lead_id=l.id ORDER BY pr.id LIMIT 1) AS product_name,(SELECT requested_model FROM product_requirements pr WHERE pr.lead_id=l.id ORDER BY pr.id LIMIT 1) AS requested_model,(SELECT matched_product FROM online_price_research opr WHERE opr.lead_id=l.id ORDER BY opr.id DESC LIMIT 1) AS matched_product,(SELECT original_price FROM online_price_research opr WHERE opr.lead_id=l.id ORDER BY opr.id DESC LIMIT 1) AS online_reference_price,(SELECT suggested_selling_price FROM online_price_research opr WHERE opr.lead_id=l.id ORDER BY opr.id DESC LIMIT 1) AS suggested_selling_price,(SELECT supplier FROM online_price_research opr WHERE opr.lead_id=l.id ORDER BY opr.id DESC LIMIT 1) AS supplier,(SELECT stock_status FROM online_price_research opr WHERE opr.lead_id=l.id ORDER BY opr.id DESC LIMIT 1) AS stock_status,(SELECT status FROM online_price_research opr WHERE opr.lead_id=l.id ORDER BY opr.id DESC LIMIT 1) AS online_price_status,(SELECT skip_reason FROM online_price_research opr WHERE opr.lead_id=l.id ORDER BY opr.id DESC LIMIT 1) AS online_skip_reason FROM followups f JOIN leads l ON l.id=f.lead_id JOIN customers c ON c.id=l.customer_id LEFT JOIN users u ON u.id=l.assigned_to WHERE f.id=?`).get(Number(fud[1]));if(!row)return sendJson(res,404,{ok:false,error:'Follow-up not found'});if(!viewerIsOwner(viewer)&&Number(row.assigned_to)!==Number(viewer?.id))return sendJson(res,403,{ok:false,error:'This follow-up belongs to another staff member.'});return sendJson(res,200,{ok:true,data:row});}
    const fum=url.pathname.match(/^\/api\/followups\/(\d+)$/);if(fum&&req.method==='PATCH'){const b=await readBody(req);return sendJson(res,200,{ok:true,data:completeFollowup(Number(fum[1]),b)});}

    const om=url.pathname.match(/^\/api\/leads\/(\d+)\/objections$/);if(om&&req.method==='POST'){
      const id=Number(om[1]),b=await readBody(req);const category=String(b.category||'OTHER').toUpperCase();const suggestions={'PRICE TOO HIGH':'Confirm the comparison basis, explain value and verify whether a technically suitable economy option is available.','OTHER BRAND REQUIRED':'Confirm the required brand/model and explain equivalent options only when specifications genuinely match.','DELIVERY TOO LONG':'Verify actual stock and supplier lead time before proposing the fastest realistic option.','NEED TECHNICAL CONFIRMATION':'Clarify the missing specification and provide only verified technical data.','BUDGET NOT APPROVED':'Confirm approval timeline and budget range; keep the proposal ready for the decision date.','MANAGEMENT APPROVAL':'Ask what information management needs and schedule a decision follow-up.','COMPETITOR CHEAPER':'Compare exact model, specification, warranty, calibration, delivery and included accessories before discussing price.','CALIBRATION REQUIRED':'Confirm required calibration scope/certificate and include verified calibration terms.','WARRANTY':'Confirm manufacturer warranty and service support in writing.','PAYMENT TERMS':'Confirm the customer requirement and approved company payment terms.'};const ai=b.ai_suggested_response||suggestions[category]||'Clarify the objection, verify the facts, respond accurately and record the customer decision.';
      db.prepare('INSERT INTO objections(lead_id,objection,customer_comment,salesperson_response,resolution_status,created_at,category,salesperson_notes,ai_suggested_response) VALUES (?,?,?,?,?,?,?,?,?)').run(id,b.objection||category,b.customer_comment||'',b.salesperson_response||'',b.resolution_status||'OPEN',nowIso(),category,b.salesperson_notes||'',ai);addActivity(id,'OBJECTION',`Objection — ${category}`,b.customer_comment||b.objection||'');if((b.resolution_status||'OPEN')==='RESOLVED')completePlaybookStage(id,8,{notes:'Customer objection resolved',data:b,activity:false});bumpDataRevision();return sendJson(res,201,{ok:true,data:hydrateLead(id)});
    }
    const obu=url.pathname.match(/^\/api\/objections\/(\d+)$/);if(obu&&req.method==='PATCH'){const b=await readBody(req),o=db.prepare('SELECT * FROM objections WHERE id=?').get(Number(obu[1]));if(!o)throw new Error('Objection not found');db.prepare('UPDATE objections SET salesperson_response=COALESCE(?,salesperson_response),salesperson_notes=COALESCE(?,salesperson_notes),resolution_status=COALESCE(?,resolution_status) WHERE id=?').run(b.salesperson_response??null,b.salesperson_notes??null,b.resolution_status??null,o.id);addActivity(o.lead_id,'OBJECTION',`Objection updated — ${b.resolution_status||o.resolution_status}`,b.salesperson_response||'');syncPlaybookEvidence(o.lead_id);bumpDataRevision();return sendJson(res,200,{ok:true,data:hydrateLead(o.lead_id)});}

    const priceRoute=url.pathname.match(/^\/api\/leads\/(\d+)\/price$/);if(priceRoute&&req.method==='POST'){
      const id=Number(priceRoute[1]),b=await readBody(req);if(!hydrateLead(id))throw new Error('Lead not found');updateOnlinePricePreferencesForLead(id,b);const saved=saveVerifiedPriceForLead(id,{...b,price_verified:'YES',verified_selling_price:b.verified_selling_price??b.selling_price??b.suggested_selling_price},true);if(!saved)throw new Error('Enter a verified non-zero selling price.');calculateLeadScore(id);bumpDataRevision();return sendJson(res,200,{ok:true,data:hydrateLead(id)});
    }

    const quotationUploadRoute=url.pathname.match(/^\/api\/leads\/(\d+)\/quotation-upload$/);if(quotationUploadRoute&&req.method==='POST'){
      const viewer=viewerFromRequest(req),id=Number(quotationUploadRoute[1]);if(!viewerCanAccessLead(viewer,id))return sendJson(res,403,{ok:false,error:'This enquiry belongs to another staff member.'});
      const b=await readBody(req,12_000_000);try{return sendJson(res,201,{ok:true,data:storeQuotationUpload(id,b,viewer)});}catch(e){return sendJson(res,400,{ok:false,error:e.message});}
    }
    const quotationUploadFile=url.pathname.match(/^\/api\/quotation-uploads\/(\d+)\/file$/);if(quotationUploadFile&&req.method==='GET'){
      const viewer=viewerFromRequest(req),row=db.prepare('SELECT * FROM quotation_uploads WHERE id=?').get(Number(quotationUploadFile[1]));if(!row)return sendJson(res,404,{ok:false,error:'Uploaded quotation not found'});if(!viewerCanAccessLead(viewer,row.lead_id))return sendJson(res,403,{ok:false,error:'This quotation belongs to another staff member.'});if(!fs.existsSync(row.file_path))return sendJson(res,404,{ok:false,error:'Quotation file is missing from the server storage.'});
      const ascii=safeUploadFilename(row.file_name).replace(/[^\x20-\x7E]/g,'_').replace(/"/g,'');res.writeHead(200,{'Content-Type':row.mime_type||'application/octet-stream','Content-Disposition':`inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,'Cache-Control':'private, no-store'});return fs.createReadStream(row.file_path).pipe(res);
    }
    const quotationUploadUpdate=url.pathname.match(/^\/api\/quotation-uploads\/(\d+)$/);if(quotationUploadUpdate&&req.method==='PATCH'){
      const viewer=viewerFromRequest(req),row=db.prepare('SELECT * FROM quotation_uploads WHERE id=?').get(Number(quotationUploadUpdate[1]));if(!row)return sendJson(res,404,{ok:false,error:'Uploaded quotation not found'});if(!viewerCanAccessLead(viewer,row.lead_id))return sendJson(res,403,{ok:false,error:'This quotation belongs to another staff member.'});const b=await readBody(req);const status=String(b.status||row.status||'UPLOADED').toUpperCase();if(!['UPLOADED','READY','SENT','NEGOTIATION','ACCEPTED','REJECTED'].includes(status))return sendJson(res,400,{ok:false,error:'Invalid quotation status.'});const total=Object.hasOwn(b,'total')?(Number(b.total)>0?Number(b.total):null):row.total;db.prepare('UPDATE quotation_uploads SET quotation_no=?,status=?,total=?,notes=? WHERE id=?').run(String(b.quotation_no??row.quotation_no??'').trim()||null,status,total,String(b.notes??row.notes??'').trim()||null,row.id);bumpDataRevision();return sendJson(res,200,{ok:true,data:quotationUploadPublicRow(db.prepare('SELECT * FROM quotation_uploads WHERE id=?').get(row.id))});
    }
    const qm=url.pathname.match(/^\/api\/leads\/(\d+)\/quotation$/);if(qm&&req.method==='POST'){const b=await readBody(req);return sendJson(res,201,{ok:true,data:createQuotation(Number(qm[1]),b)});}
    const quotationAccessRoute=url.pathname.match(/^\/api\/quotations\/(\d+)(?:\/|$)/);if(quotationAccessRoute){const viewer=viewerFromRequest(req),qid=Number(quotationAccessRoute[1]);if(!viewerIsOwner(viewer)){const ok=db.prepare('SELECT 1 FROM quotations q JOIN leads l ON l.id=q.lead_id WHERE q.id=? AND l.assigned_to=?').get(qid,viewer.id);if(!ok)return sendJson(res,403,{ok:false,error:'This quotation belongs to another staff member.'});}}
    const quoteGet=url.pathname.match(/^\/api\/quotations\/(\d+)$/);if(quoteGet&&req.method==='GET'){const q=db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(quoteGet[1]));if(!q)return sendJson(res,404,{ok:false,error:'Quotation not found'});return sendJson(res,200,{ok:true,data:{quotation:q,items:db.prepare('SELECT * FROM quotation_items WHERE quotation_id=? ORDER BY id').all(q.id)}});}
    if(quoteGet&&req.method==='PATCH'){const b=await readBody(req);return sendJson(res,200,{ok:true,data:quotationStatusUpdate(Number(quoteGet[1]),b)});}
    const pdfm=url.pathname.match(/^\/api\/quotations\/(\d+)\/pdf$/);if(pdfm&&req.method==='GET'){const d=quotationPdf(Number(pdfm[1]));return send(res,200,d.buffer,{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${d.q.quotation_no}.pdf"`});}
    const quoteEmail=url.pathname.match(/^\/api\/quotations\/(\d+)\/email$/);if(quoteEmail&&req.method==='POST'){return sendJson(res,200,{ok:true,data:await emailQuotation(Number(quoteEmail[1]),viewerFromRequest(req)?.id||1)});}

    const customerAccessRoute=url.pathname.match(/^\/api\/customers\/(\d+)(?:\/|$)/);
    if(customerAccessRoute){const viewer=viewerFromRequest(req),customerId=Number(customerAccessRoute[1]);if(!viewerIsOwner(viewer)){const ok=db.prepare('SELECT 1 FROM leads WHERE customer_id=? AND assigned_to=? LIMIT 1').get(customerId,viewer.id);if(!ok)return sendJson(res,403,{ok:false,error:'This customer belongs to another staff member.'});}}
    if(req.method==='GET'&&url.pathname==='/api/customers/summary'){const viewer=viewerFromRequest(req);return sendJson(res,200,{ok:true,data:customerSummaryPage(url,viewerIsOwner(viewer)?null:viewer.id)});}
    if(req.method==='GET'&&url.pathname==='/api/customers'){const viewer=viewerFromRequest(req);return sendJson(res,200,{ok:true,data:customerSummaryPage(url,viewerIsOwner(viewer)?null:viewer.id)});}
    if(req.method==='POST'&&url.pathname==='/api/customers'){const b=await readBody(req);const id=db.prepare('INSERT INTO customers(name,company,phone,normalized_phone,email,address,city,state,country,pincode,customer_since) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(b.name||'Needs Confirmation',b.company||null,b.phone||null,normalizePhone(b.phone)||null,b.email||null,b.address||null,b.city||null,b.state||null,b.country||'India',b.pincode||null,nowIso()).lastInsertRowid;bumpDataRevision();return sendJson(res,201,{ok:true,data:db.prepare('SELECT * FROM customers WHERE id=?').get(id)});}
    const cm=url.pathname.match(/^\/api\/customers\/(\d+)$/);if(cm&&req.method==='GET'){const d=customer360(Number(cm[1]));return d?sendJson(res,200,{ok:true,data:d}):sendJson(res,404,{ok:false,error:'Customer not found'});}
    const nurture=url.pathname.match(/^\/api\/customers\/(\d+)\/nurture$/);if(nurture&&req.method==='PATCH'){const id=Number(nurture[1]),b=await readBody(req),customer=db.prepare('SELECT * FROM customers WHERE id=?').get(id);if(!customer)throw new Error('Customer not found');const next=b.next_relationship_followup_at?validDateIso(b.next_relationship_followup_at):null;db.prepare(`INSERT INTO customer_nurture(customer_id,future_requirement,expected_purchase_month,preferred_brands,products_of_interest,next_relationship_followup_at,notes,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET future_requirement=excluded.future_requirement,expected_purchase_month=excluded.expected_purchase_month,preferred_brands=excluded.preferred_brands,products_of_interest=excluded.products_of_interest,next_relationship_followup_at=excluded.next_relationship_followup_at,notes=excluded.notes,updated_at=excluded.updated_at`).run(id,b.future_requirement||null,b.expected_purchase_month||null,b.preferred_brands||null,b.products_of_interest||null,next,b.notes||null,nowIso());if(next){const latestLead=db.prepare('SELECT id FROM leads WHERE customer_id=? ORDER BY received_at DESC LIMIT 1').get(id);if(latestLead)createFollowup(latestLead.id,{due_at:next,method:'CALL',reason:'RELATIONSHIP NURTURE',notes:b.notes||'Relationship follow-up',priority:'NORMAL'});}bumpDataRevision();return sendJson(res,200,{ok:true,data:customer360(id)});}

    if(req.method==='GET'&&url.pathname==='/api/pipeline'){const viewer=viewerFromRequest(req);if(!viewerIsOwner(viewer))return sendJson(res,403,{ok:false,error:'Company pipeline is available only to the owner.'});return sendJson(res,200,{ok:true,data:pipelineData()});}
    const psm=url.pathname.match(/^\/api\/pipeline\/stage$/);if(psm&&req.method==='GET'){const viewer=viewerFromRequest(req);if(!viewerIsOwner(viewer))return sendJson(res,403,{ok:false,error:'Company pipeline is available only to the owner.'});const stage=url.searchParams.get('stage');if(!config.pipeline_stages.includes(stage))throw new Error('Invalid pipeline stage');return sendJson(res,200,{ok:true,data:pipelineStagePage(stage,url.searchParams.get('page'),url.searchParams.get('limit'))});}

    if(req.method==='GET'&&url.pathname==='/api/followups'){
      const viewer=viewerFromRequest(req),status=(url.searchParams.get('status')||'').toUpperCase();const where=[];const params=[];if(!viewerIsOwner(viewer)){where.push('l.assigned_to=?');params.push(viewer.id);}if(status==='OVERDUE'){where.push("f.status='PENDING' AND f.due_at<?");params.push(nowIso());}else if(status){where.push('f.status=?');params.push(status);}const rows=db.prepare(`SELECT f.*,l.lead_code,l.temperature,l.priority AS lead_priority,l.form_status,l.form_completion_percent,l.work_status,l.hold_reason,l.pipeline_stage,c.name AS customer_name,c.company,u.name AS staff_name,(SELECT product_name FROM product_requirements pr WHERE pr.lead_id=l.id ORDER BY pr.id LIMIT 1) AS product_name,CASE WHEN f.status='PENDING' AND f.due_at<? THEN 1 ELSE 0 END AS overdue FROM followups f JOIN leads l ON l.id=f.lead_id JOIN customers c ON c.id=l.customer_id LEFT JOIN users u ON u.id=l.assigned_to ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY CASE WHEN f.status='PENDING' THEN 0 ELSE 1 END,f.due_at LIMIT 500`).all(nowIso(),...params);return sendJson(res,200,{ok:true,data:rows});
    }
    if(req.method==='GET'&&url.pathname==='/api/quotations'){const viewer=viewerFromRequest(req),owner=viewerIsOwner(viewer);const where=owner?'':' WHERE l.assigned_to=?',params=owner?[]:[viewer.id];const legacy=db.prepare(`SELECT q.*,l.lead_code,c.name AS customer_name,c.company,0 AS uploaded_file,NULL AS file_name,NULL AS file_url FROM quotations q JOIN leads l ON l.id=q.lead_id JOIN customers c ON c.id=l.customer_id${where}`).all(...params);const uploads=db.prepare(`SELECT qu.id,qu.quotation_no,qu.lead_id,qu.status,qu.total,qu.created_at,l.lead_code,c.name AS customer_name,c.company,1 AS uploaded_file,qu.file_name,('/api/quotation-uploads/'||qu.id||'/file') AS file_url FROM quotation_uploads qu JOIN leads l ON l.id=qu.lead_id JOIN customers c ON c.id=l.customer_id${where}`).all(...params);const rows=[...uploads,...legacy].sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||''))).slice(0,500);return sendJson(res,200,{ok:true,data:rows});}
    if(req.method==='GET'&&url.pathname==='/api/manager'){const viewer=viewerFromRequest(req);if(!viewerIsOwner(viewer))return sendJson(res,403,{ok:false,error:'Overall company reports are available only to the owner.'});return sendJson(res,200,{ok:true,data:managerData(url)});}

    if(req.method==='GET'&&url.pathname==='/api/price-source/status')return sendJson(res,200,{ok:true,data:priceSourceAdminStatus()});
    if(req.method==='POST'&&url.pathname==='/api/price-source/connect'){
      const b=await readBody(req);try{const data=await connectCompanyPriceSource(String(b.url||configuredPriceSourceUrl()),{refresh:false});bumpDataRevision();return sendJson(res,200,{ok:true,data});}catch(e){const status=e.authorization_required?409:(Number(e.status)>=400&&Number(e.status)<600?Number(e.status):502);return sendJson(res,status,{ok:false,error:e.message,authorization_required:Boolean(e.authorization_required),oauth_configured:Boolean(e.oauth_configured),authorize_url:e.authorization_required&&e.oauth_configured?'/api/google/oauth/start':null,price_source:priceSourceAdminStatus()});}
    }
    if(req.method==='POST'&&url.pathname==='/api/price-source/refresh'){
      const link=String((await readBody(req))?.url||configuredPriceSourceUrl()).trim();if(!link)return sendJson(res,400,{ok:false,error:'No Google Drive / Sheet source is configured.'});try{const data=await connectCompanyPriceSource(link,{refresh:true});bumpDataRevision();return sendJson(res,200,{ok:true,data});}catch(e){const status=e.authorization_required?409:(Number(e.status)>=400&&Number(e.status)<600?Number(e.status):502);return sendJson(res,status,{ok:false,error:e.message,authorization_required:Boolean(e.authorization_required),oauth_configured:Boolean(e.oauth_configured),authorize_url:e.authorization_required&&e.oauth_configured?'/api/google/oauth/start':null,price_source:priceSourceAdminStatus()});}
    }
    if(req.method==='GET'&&url.pathname==='/api/google/drive-files'){
      try{return sendJson(res,200,{ok:true,data:{files:await listGooglePriceFiles(),authorized:true}});}catch(e){return sendJson(res,Number(e.status||401),{ok:false,error:e.message,authorization_required:Boolean(e.authorization_required||Number(e.status)===401),oauth_configured:googleOAuthConfigured(),authorize_url:googleOAuthConfigured()?'/api/google/oauth/start':null});}
    }
    if(req.method==='GET'&&url.pathname==='/api/google/oauth/start'){
      if(!googleOAuthConfigured())return sendJson(res,400,{ok:false,error:'Private Google Drive authorization is not configured on this server. Public/shared Google links still work.'});
      const state=randomBytes(18).toString('hex');saveSetting('google_oauth_state',state);const q=new URLSearchParams({client_id:String(process.env.GOOGLE_CLIENT_ID),redirect_uri:googleRedirectUri(),response_type:'code',scope:'https://www.googleapis.com/auth/drive.readonly',access_type:'offline',prompt:'consent',state});res.writeHead(302,{Location:`https://accounts.google.com/o/oauth2/v2/auth?${q}`,'Cache-Control':'no-store'});res.end();return;
    }
    if(req.method==='GET'&&url.pathname==='/api/google/oauth/callback'){
      if(!googleOAuthConfigured())throw new Error('Google authorization is not configured.');const state=String(url.searchParams.get('state')||''),expected=String(getSetting('google_oauth_state',''));if(!state||!expected||state!==expected)throw new Error('Google authorization state check failed.');const code=String(url.searchParams.get('code')||'');if(!code)throw new Error(url.searchParams.get('error')||'Google authorization was cancelled.');
      const body=new URLSearchParams({client_id:String(process.env.GOOGLE_CLIENT_ID),client_secret:String(process.env.GOOGLE_CLIENT_SECRET),code,grant_type:'authorization_code',redirect_uri:googleRedirectUri()});const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});if(!tr.ok)throw new Error(`Google authorization failed (${tr.status}).`);const tok=await tr.json(),previous=readGoogleAuth(GOOGLE_AUTH_PATH)||{};writeGoogleAuth(GOOGLE_AUTH_PATH,{...previous,...tok,refresh_token:tok.refresh_token||previous.refresh_token||null,expires_at:Date.now()+Math.max(60,Number(tok.expires_in||3600)-60)*1000,updated_at:nowIso()});saveSetting('google_oauth_state','');const pending=getSetting('price_source_pending_url','');let result='authorized';if(pending){try{await connectCompanyPriceSource(pending);result='connected';}catch(e){console.warn('[GOOGLE DRIVE] Authorized but price import failed:',e.message);}}res.writeHead(302,{Location:`/#/settings?google=${result}`,'Cache-Control':'no-store'});res.end();return;
    }

    if(req.method==='GET'&&url.pathname==='/api/settings'){
      const viewer=viewerFromRequest(req);if(!viewerIsOwner(viewer))return sendJson(res,403,{ok:false,error:'Admin Settings is available only on the owner profile.'});
      const factors=db.prepare('SELECT * FROM score_factors WHERE active=1 ORDER BY id').all();const settings=Object.fromEntries(db.prepare('SELECT key,value FROM app_settings').all().map(x=>[x.key,x.value]));const companyCrm=crmStatus();const integrations=config.integrations.map(i=>['Own Company CRM','LeadSphere CRM'].includes(i.name)?{...i,status:companyCrm.configured?'Connected — Live import ready':'Setup Required — run CONFIGURE_COMPANY_CRM.bat'}:i);const productMaster=['product-master.json','product-master.csv'].map(n=>({name:n,exists:fs.existsSync(path.join(DATA_DIR,n))}));return sendJson(res,200,{ok:true,data:{factors,settings,pipeline_stages:config.pipeline_stages,integrations,company_crm:companyCrm,product_providers:[{name:'Internal Product Database',status:'ACTIVE'},{name:'Connected Drive / Product Master',status:productMaster.some(x=>x.exists)?'ACTIVE':'READY'},{name:'Manufacturer Research',status:GEMINI_PRODUCT_PROVIDER.isConfigured()?'ACTIVE':'NEEDS GEMINI'},{name:'IndiaMART Product Research',status:String(process.env.INDIAMART_RESEARCH_ENABLED||'true').toLowerCase()==='false'?'DISABLED':'ACTIVE'},{name:'Public Web Product Research',status:GEMINI_PRODUCT_PROVIDER.isConfigured()?'ACTIVE':'NEEDS GEMINI'},{name:'Gemini Product Synthesis',status:GEMINI_PRODUCT_PROVIDER.status().status}],gemini_product_intelligence:productIntelligenceProviderStatus(),product_master_files:productMaster,price_source:priceSourceAdminStatus(),customer_messaging:customerMessagingStatus(),users:db.prepare("SELECT id,name,email,role,designation,photo_data,display_order,phone,active FROM users WHERE active=1 ORDER BY CASE WHEN role='ADMIN' THEN 0 ELSE 1 END,display_order,id").all()}});
    }
    if(req.method==='PUT'&&url.pathname==='/api/settings'){const viewer=viewerFromRequest(req);if(!viewerIsOwner(viewer))return sendJson(res,403,{ok:false,error:'Only the owner can change Admin Settings.'});const b=await readBody(req);if(Array.isArray(b.factors))for(const f of b.factors)db.prepare('UPDATE score_factors SET weight=? WHERE code=?').run(Math.max(0,Number(f.weight)||0),f.code);if(b.settings)for(const [k,v] of Object.entries(b.settings))saveSetting(k,v);for(const x of db.prepare('SELECT id,live_classification FROM leads WHERE status=\'OPEN\' ORDER BY live_classification=\'LIVE\' DESC,received_at DESC LIMIT 200').all())enqueueLeadAnalysis(x.id,x.live_classification);bumpDataRevision();return sendJson(res,200,{ok:true,data:{saved:true}});}

    return sendJson(res,404,{ok:false,error:'API route not found'});
  }catch(e){console.error('[API ERROR]',e);sendJson(res,400,{ok:false,error:e.message||'Request failed'});}
}

function buildStaticCache(){
  const cache=new Map();
  for(const name of fs.readdirSync(PUBLIC_DIR)){
    const full=path.join(PUBLIC_DIR,name);let stat;try{stat=fs.statSync(full);}catch{continue;}if(!stat.isFile())continue;
    const rel=`/${name}`;const data=fs.readFileSync(full);const type=MIME[path.extname(name)]||'application/octet-stream';
    const compressible=type.startsWith('text/')||type.includes('javascript')||type.includes('json')||type.includes('svg');
    cache.set(rel,{data,gzip:compressible&&data.length>1024?gzipSync(data,{level:1}):null,type,isHtml:path.extname(name)==='.html'});
  }
  return cache;
}
const STATIC_CACHE=buildStaticCache();
function serveStatic(req,res,url){
  let rel;try{rel=decodeURIComponent(url.pathname);}catch{return send(res,400,'Bad Request');}
  if(rel==='/'||!path.extname(rel)) rel='/index.html';
  let asset=STATIC_CACHE.get(rel);
  if(!asset&&rel!=='/index.html') asset=STATIC_CACHE.get('/index.html');
  if(!asset) return send(res,404,'Not Found');
  const acceptsGzip=String(req.headers['accept-encoding']||'').includes('gzip');
  const payload=acceptsGzip&&asset.gzip?asset.gzip:asset.data;
  const headers={'Content-Type':asset.type,'Cache-Control':'no-store','Content-Length':payload.length};
  if(acceptsGzip&&asset.gzip){headers['Content-Encoding']='gzip';headers['Vary']='Accept-Encoding';}
  res.writeHead(200,headers);res.end(payload);
}

const server=http.createServer(async(req,res)=>{const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);if(url.pathname.startsWith('/api/')) return api(req,res,url);serveStatic(req,res,url);});
server.keepAliveTimeout=65000;
server.headersTimeout=66000;
server.on('connection',socket=>socket.setNoDelay(true));

function localIps(){const out=[];try{for(const arr of Object.values(os.networkInterfaces()))for(const x of arr||[])if(x.family==='IPv4'&&!x.internal)out.push(x.address);}catch{}return out;}
function openBrowser(url){if(process.env.CRM_NO_BROWSER==='1')return;if(process.platform==='win32')spawn('cmd',['/c','start','',url],{detached:true,stdio:'ignore'}).unref();else if(process.platform==='darwin')spawn('open',[url],{detached:true,stdio:'ignore'}).unref();}
async function healthCheck(port){return new Promise(resolve=>{const r=http.get({hostname:'127.0.0.1',port,path:'/api/health',timeout:800},res=>{let s='';res.on('data',d=>s+=d);res.on('end',()=>{try{resolve(JSON.parse(s).app===APP_ID)}catch{resolve(false)}})});r.on('error',()=>resolve(false));r.on('timeout',()=>{r.destroy();resolve(false)});});}
let syncBusy=false;
function startCompanyCrmAutoSync(){
  // V2.11.16: resilient live-sync supervisor.
  // Important change: a failed reconciliation no longer waits the full normal interval
  // before retrying. Config/secret are re-read every tick so repaired settings start live
  // sync without a server restart.
  let lastIncremental=0,lastReconcile=0,tickBusy=false;
  const run=async(reconciliation=false)=>{
    if(syncBusy)return {ok:false,busy:true};
    const c=readCrmConnection(),secret=readCrmSecret();
    crmAutoSyncState.enabled=Boolean(c?.baseUrl&&secret);
    if(!crmAutoSyncState.enabled){crmAutoSyncState.running=false;return {ok:false,not_configured:true};}
    syncBusy=true;crmAutoSyncState.running=true;crmAutoSyncState.last_attempt=nowIso();crmAutoSyncState.last_mode=reconciliation?'RECONCILIATION':'INCREMENTAL';
    try{
      const r=await syncCompanyCrm({reconciliation});
      crmAutoSyncState.last_result={inserted:r.inserted,updated:r.updated,duplicates:r.duplicates,failed:r.failed,received:r.received,pages:r.pages,finished_at:r.last_successful_sync};
      crmAutoSyncState.last_error=null;
      if(r.inserted||r.updated||r.failed)console.log(`[LEADSPHERE] ${reconciliation?'Reconcile':'Live sync'}: +${r.inserted} new, ${r.updated} updated, ${r.duplicates} unchanged, ${r.failed} failed.`);
      return {ok:true,result:r};
    }catch(e){
      saveSetting('company_crm_last_error',e.message);crmAutoSyncState.last_error=e.message;console.error('[LEADSPHERE]',e.message);return {ok:false,error:e.message};
    }finally{syncBusy=false;crmAutoSyncState.running=false;}
  };
  const tick=async()=>{
    if(tickBusy)return;tickBusy=true;
    try{
      const c=readCrmConnection(),secret=readCrmSecret();
      crmAutoSyncState.enabled=Boolean(c?.baseUrl&&secret);
      if(!crmAutoSyncState.enabled)return;
      const now=Date.now(),incrementalSec=Math.max(10,Math.min(20,Number(c.syncIntervalSeconds)||20)),reconcileMin=Math.max(1,Math.min(2,Number(c.reconciliationMinutes)||2));
      if(!lastReconcile||now-lastReconcile>=reconcileMin*60000){
        const result=await run(true);
        // Successful reconciliation uses the normal interval; failure retries in ~10 sec.
        lastReconcile=result.ok?Date.now():(Date.now()-reconcileMin*60000+10000);
        if(result.ok)lastIncremental=Date.now();
        return;
      }
      if(!lastIncremental||now-lastIncremental>=incrementalSec*1000){
        const result=await run(false);
        // Failed incremental sync retries quickly instead of appearing dead for a full cycle.
        lastIncremental=result.ok?Date.now():(Date.now()-incrementalSec*1000+10000);
      }
    }finally{tickBusy=false;}
  };
  setTimeout(()=>tick().catch(()=>{}),1000).unref();
  setInterval(()=>tick().catch(()=>{}),5000).unref();
}

async function checkGeminiAtStartup(){
  const initial=GEMINI_PRODUCT_PROVIDER.status();
  if(!initial.configured){console.log('Gemini Product Intelligence: NOT CONFIGURED');return initial;}
  const checked=await GEMINI_PRODUCT_PROVIDER.checkConnection();
  console.log(`Gemini Product Intelligence: ${checked.status}`);
  return checked;
}

function startPriceSourceAutoSync(){
  if(!configuredPriceSourceUrl())return;
  if(!getSetting('price_source_url','')&&DEFAULT_PRICE_SHEET_URL)saveSetting('price_source_pending_url',DEFAULT_PRICE_SHEET_URL);
  // Pre-warm the persisted local index in the background so the first lead search does not scan/reparse the full file.
  setTimeout(()=>{try{PRODUCT_PROVIDERS?.find?.(x=>x?.name==='Company Product Master File')?.search?.({product_name:'local index warmup'});}catch(e){console.warn('[PRICE INDEX] Warm-up skipped:',e.message);}},400).unref();
  const run=async(reason='background')=>{if(priceSourceBusy)return;const target=configuredPriceSourceUrl();if(!target)return;try{const current=readPriceSourceStatus(DATA_DIR),refresh=Boolean(current.index_ready||getSetting('price_source_url',''));const meta=await connectCompanyPriceSource(target,{refresh});console.log(`[PRICE SOURCE] ${reason}: ${meta.rows||0} rows indexed from ${meta.sheets_indexed||0}/${meta.sheets_detected||meta.sheets?.length||0} sheets.`);}catch(e){console.warn(`[PRICE SOURCE] ${reason}: ${e.message}`);}};
  // The local index is available immediately; Google refresh starts only after the CRM server is ready.
  setTimeout(()=>run('startup'),1800).unref();
  setInterval(()=>run('scheduled refresh'),PRICE_SHEET_REFRESH_MINUTES*60000).unref();
}


let autoBackupBusy=false;
async function createAutomaticBackup(reason='scheduled'){
  if(autoBackupBusy)return;autoBackupBusy=true;
  try{
    const backupDir=path.join(ROOT,'backups','automatic');fs.mkdirSync(backupDir,{recursive:true});
    const d=new Date(),pad=n=>String(n).padStart(2,'0'),stamp=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const target=path.join(backupDir,`nunes-crm_${stamp}.sqlite`);await backup(db,target);
    saveSetting('auto_backup_last_at',nowIso());saveSetting('auto_backup_last_file',target);saveSetting('auto_backup_last_error','');
    const files=fs.readdirSync(backupDir).filter(x=>/^nunes-crm_.*\.sqlite$/i.test(x)).sort().reverse();for(const old of files.slice(30)){try{fs.rmSync(path.join(backupDir,old),{force:true});}catch{}}
    console.log(`[DATA SAFETY] Automatic backup (${reason}) saved: ${target}`);
  }catch(e){saveSetting('auto_backup_last_error',e.message);console.warn('[DATA SAFETY] Automatic backup failed:',e.message);}finally{autoBackupBusy=false;}
}


function versionParts(v=''){return String(v||'').trim().replace(/^v/i,'').split('.').map(x=>Number(String(x).replace(/[^0-9].*$/,''))||0);}
function compareVersions(a,b){const A=versionParts(a),B=versionParts(b),n=Math.max(A.length,B.length,3);for(let i=0;i<n;i++){const d=(A[i]||0)-(B[i]||0);if(d)return d>0?1:-1;}return 0;}
let githubUpdateCheckBusy=false;
async function checkGithubSourceUpdate({apply=true}={}){
  if(!GITHUB_AUTO_UPDATE_ENABLED||githubUpdateCheckBusy||!GITHUB_UPDATE_REPO)return githubUpdateState;
  githubUpdateCheckBusy=true;
  try{
    const raw=`https://raw.githubusercontent.com/${GITHUB_UPDATE_REPO}/${encodeURIComponent(GITHUB_UPDATE_BRANCH)}/VERSION.txt?ts=${Date.now()}`;
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),7000);
    let r;try{r=await fetch(raw,{headers:{'User-Agent':'NUNES-AI-CRM-Updater','Cache-Control':'no-cache'},signal:ctl.signal});}finally{clearTimeout(timer);}
    if(!r.ok)throw new Error(`GitHub version check failed (${r.status})`);
    const latest=String(await r.text()).trim();if(!/^\d+\.\d+\.\d+/.test(latest))throw new Error('GitHub VERSION.txt is invalid.');
    githubUpdateState={...githubUpdateState,current_version:APP_VERSION,latest_version:latest,last_checked_at:nowIso(),last_error:null,status:compareVersions(latest,APP_VERSION)>0?'UPDATE_AVAILABLE':'CURRENT'};
    if(apply&&compareVersions(latest,APP_VERSION)>0&&process.platform==='win32'){
      const updater=path.join(ROOT,'scripts','update_from_github.ps1');
      const lock=path.join(DATA_DIR,'github-update-started.lock');
      let recently=false;try{if(fs.existsSync(lock)){recently=(Date.now()-fs.statSync(lock).mtimeMs)<10*60*1000;}}catch{}
      if(fs.existsSync(updater)&&!recently){
        try{fs.writeFileSync(lock,nowIso());}catch{}
        githubUpdateState={...githubUpdateState,status:'APPLYING',update_started_at:nowIso()};
        const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',updater,'-Repo',GITHUB_UPDATE_REPO,'-Branch',GITHUB_UPDATE_BRANCH,'-InstallRoot',ROOT,'-Quiet'],{detached:true,stdio:'ignore',windowsHide:true});
        child.unref();
        console.log(`[GITHUB UPDATE] ${APP_VERSION} -> ${latest}. Safe updater started.`);
      }
    }
  }catch(e){githubUpdateState={...githubUpdateState,last_checked_at:nowIso(),last_error:String(e?.message||e),status:'CHECK_FAILED'};console.warn('[GITHUB UPDATE]',e?.message||e);}
  finally{githubUpdateCheckBusy=false;}
  return githubUpdateState;
}
function startGithubAutoUpdate(){
  if(!GITHUB_AUTO_UPDATE_ENABLED){githubUpdateState={...githubUpdateState,status:'DISABLED'};return;}
  setTimeout(()=>checkGithubSourceUpdate({apply:true}).catch(()=>{}),15000).unref();
  setInterval(()=>checkGithubSourceUpdate({apply:true}).catch(()=>{}),GITHUB_UPDATE_CHECK_MINUTES*60*1000).unref();
}

async function start(){
  if(fs.existsSync(PORT_FILE)){const p=Number(fs.readFileSync(PORT_FILE,'utf8').trim());if(p&&await healthCheck(p)){console.log(`NUNES AI CRM is already running at http://127.0.0.1:${p}`);openBrowser(`http://127.0.0.1:${p}`);return process.exit(0);}}
  const preferred=Number(process.env.CRM_PORT||config.port||8765);let port=preferred;
  while(port<preferred+11){const ok=await new Promise(resolve=>{const onErr=e=>{server.off('listening',onListen);if(e.code==='EADDRINUSE')resolve(false);else throw e};const onListen=()=>{server.off('error',onErr);resolve(true)};server.once('error',onErr);server.once('listening',onListen);server.listen(port,config.bind_host||'0.0.0.0');});if(ok)break;port++;}
  if(!server.listening) throw new Error(`Ports ${preferred}-${preferred+10} are already in use.`);
  fs.writeFileSync(PORT_FILE,String(port));fs.writeFileSync(PID_FILE,String(process.pid));
  const ips=localIps();
  console.clear?.();
  console.log('====================================================');
  console.log('               NUNES AI CRM');
  console.log('====================================================');
  console.log('Status: RUNNING');
  console.log('');
  console.log(`Local CRM:      http://127.0.0.1:${port}`);
  console.log(`Office Network: ${ips.length?`http://${ips[0]}:${port}`:'No LAN IPv4 address detected'}`);
  if(process.platform==='win32') console.log(`Staff PC name:  http://${os.hostname()}:${port}`);
  console.log('Database:       MAIN SERVER PC ONLY (staff PCs use desktop client shortcuts)');
  console.log('');
  if(port!==preferred) console.log(`Note: Preferred port ${preferred} was busy; using ${port}.`);
  console.log('Do not close this window while using the CRM.');
  console.log('====================================================');
  startCompanyCrmAutoSync();
  setTimeout(()=>syncCrmStaffDirectory().catch(e=>console.warn('[LEADSPHERE STAFF PHOTOS]',e.message)),1200).unref();
  setInterval(()=>syncCrmStaffDirectory().catch(()=>{}),10*60*1000).unref();
  startPriceSourceAutoSync();
  setTimeout(()=>checkGeminiAtStartup().catch(e=>console.warn('[PRODUCT-AI] Gemini startup check failed:',e.message)),350).unref();
  // Re-score older records in small background batches; LIVE leads are queued first so startup stays responsive.
  setTimeout(scheduleAnalysisBackfill,2500).unref();
  setTimeout(()=>createAutomaticBackup('startup').catch(()=>{}),4500).unref();
  setInterval(()=>createAutomaticBackup('6-hour safety').catch(()=>{}),6*60*60*1000).unref();
  startGithubAutoUpdate();
  setTimeout(()=>openBrowser(`http://127.0.0.1:${port}`),200);
}

function shutdown(){try{fs.rmSync(PID_FILE,{force:true});fs.rmSync(PORT_FILE,{force:true});}catch{}try{db.exec('PRAGMA wal_checkpoint(FULL)');}catch{}try{db.close();}catch{}server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1000);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);process.on('uncaughtException',e=>{console.error('ERROR STARTING NUNES AI CRM\nReason:',e);});
start().catch(e=>{console.error('\nERROR STARTING NUNES AI CRM\n\nReason:\n'+e.message+'\n');process.exitCode=1;});
