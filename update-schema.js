#!/usr/bin/env node
/**
 * update-schema.js
 * ─────────────────────────────────────────────────────────────
 * Queries your Supabase database and regenerates the
 * SCHEMA_DATA block inside index.html (served as site root on Vercel).
 *
 * SETUP (one-time):
 *   1. npm install node-fetch   (or use Node 18+ which has built-in fetch)
 *   2. Create a .env file (or export env vars) with:
 *        SUPABASE_PROJECT_REF=dvrhazdtbsttzduaedzu
 *        SUPABASE_ACCESS_TOKEN=sbp_xxxxxxxxxxxxxxx   ← Supabase Personal Access Token
 *                                                       (Settings → Access Tokens in dashboard)
 *   3. npm run update-schema
 *
 * ADD TO package.json:
 *   "scripts": {
 *     "update-schema": "node update-schema.js"
 *   }
 *
 * CURSOR AUTO-UPDATE:
 *   Add to your .cursorrules file:
 *   ─────────────────────────────
 *   After applying any database migration or adding new tables,
 *   automatically run `npm run update-schema` to regenerate the
 *   schema neural map diagram.
 *   ─────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────
require('dotenv').config(); // optional — works if dotenv is installed

const PROJECT_REF   = process.env.SUPABASE_PROJECT_REF  || 'dvrhazdtbsttzduaedzu';
const ACCESS_TOKEN  = process.env.SUPABASE_ACCESS_TOKEN  || '';
const DIAGRAM_FILE  = path.join(__dirname, 'index.html');

if (!ACCESS_TOKEN) {
  console.error('❌  SUPABASE_ACCESS_TOKEN env var is required.');
  console.error('   Get yours at: https://supabase.com/dashboard/account/tokens');
  process.exit(1);
}

// ── Domain Classification ────────────────────────────────────
// Tables are auto-classified by name patterns.
// Add custom overrides in DOMAIN_OVERRIDES.
const DOMAIN_RULES = [
  { pattern: /^member_(database|memberships|holds|programs|addons|not_renew|staging|gym_flag|priority|batch|sessions|weekly|daily|parking|boxing|lcns|myzone|bodyweight|newsale_meta|renewal_meta|referral)|^membership_(types|versions|holds|addons)|^holds_policies|^sale_types/, domain: 'members' },
  { pattern: /^staff_|^hr_|^coach_slack|^work_calendar/, domain: 'staff' },
  { pattern: /^schedule_|^rolling_schedule|^system_session|^session_forecast/, domain: 'scheduling' },
  { pattern: /^stripe_|^fin_|^payment|^newsale_membership_price/, domain: 'finance' },
  { pattern: /^member_(health_metrics|physicals|memberhealth|cardio|biomap|tbhealth|tbresult|vo2)|^biomap_|^physicals_|^stg_member_health|^cardio_workouts|^manual_first_vo2|^member_vo2/, domain: 'health' },
  { pattern: /^hubspot_|^crm_|^allcontacts|^contacts_table|^deals_table|^lead_referral|^member_(referral_log|referral_credits|referral_view)|^member_hubspot/, domain: 'crm' },
  { pattern: /^programming_|^exercise_library|^teambuildr|^member_(programs$)|^cardio_workouts/, domain: 'programming' },
  { pattern: /^coach_(call|monthly|wcr|perf|pr|survey|3month|rm_|tech_|core_|session_|renewal_|weekly_hours)|^member_(call|coach_notes)|^google_reviews|^survey_|^audit_revenue|^renewal_reminders|^call_(links|types)|^member_not_renewing/, domain: 'coach_ops' },
  { pattern: /^pm_|^admin_|^work_estimations|^management_velocity|^tech_docs|^vicky_|^webhook_/, domain: 'pm' },
  { pattern: /^system_|^membership_addons|^maintenance_|^ops_|^physicals_(config|stages_config|scoring|quarterly)|^sale_types|^payment_statuses/, domain: 'system' },
];

const DOMAIN_OVERRIDES = {
  // Override specific tables here if classification is wrong
  // 'some_table': 'finance',
};

function classifyDomain(tableName) {
  if (DOMAIN_OVERRIDES[tableName]) return DOMAIN_OVERRIDES[tableName];
  for (const rule of DOMAIN_RULES) {
    if (rule.pattern.test(tableName)) return rule.domain;
  }
  return 'system'; // default
}

// Tables to skip (internal, views, backup tables)
const SKIP_PATTERNS = [
  /^view_/, /^v_/, /^vw_/, /_backup/, /_staging$/, /_staging_/, /^audit_/,
  /craftmypdf/, /renewal_october_per_session/, /vicky_drift/, /crm_contacts_compare/,
  /member_hubspot_email_comparison/, /unpaid_sessions/, /consolidated_crm/,
  /coach_client_dashboard/, /coach_rm_intensives/, /coach_tech_intensives/,
  /_dd$/, /^session_forecast_next/,  // keep session_forecast_next_14_days as it's useful
];

// These are important enough to keep even if they match skip patterns
const KEEP_ALWAYS = new Set(['teambuildr_completion_dd', 'session_forecast_next_14_days']);

function shouldSkip(tableName) {
  if (KEEP_ALWAYS.has(tableName)) return false;
  return SKIP_PATTERNS.some(p => p.test(tableName));
}

// Hub tables (displayed larger, with pulse animation)
const HUB_TABLES = new Set([
  'member_database', 'staff_database', 'schedule_sessions', 'stripe_customers',
  'member_health_metrics', 'hubspot_contacts_clean', 'programming_generated',
  'coach_call_summary', 'pm_projects', 'member_biomap', 'member_memberships',
]);

// ── SQL Queries ──────────────────────────────────────────────
const TABLES_SQL = `
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE'
  ORDER BY table_name;
`;

const COLUMNS_SQL = `
  SELECT table_name, column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
  ORDER BY table_name, ordinal_position;
`;

const FK_SQL = `
  SELECT
    tc.table_name AS source_table,
    kcu.column_name AS source_column,
    ccu.table_name AS target_table,
    ccu.column_name AS target_column
  FROM information_schema.table_constraints AS tc
  JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage AS ccu
    ON ccu.constraint_name = tc.constraint_name
    AND ccu.table_schema = tc.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
  ORDER BY tc.table_name;
`;

// ── Supabase Management API ──────────────────────────────────
async function runSQL(sql) {
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase API error ${res.status}: ${err}`);
  }

  return res.json();
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('🔍  Connecting to Supabase project:', PROJECT_REF);

  // 1. Fetch schema
  const [tablesResult, columnsResult, fkResult] = await Promise.all([
    runSQL(TABLES_SQL),
    runSQL(COLUMNS_SQL),
    runSQL(FK_SQL),
  ]);

  const allTables = tablesResult.map(r => r.table_name).filter(t => !shouldSkip(t));
  console.log(`📊  Found ${allTables.length} tables (after filtering views/backups)`);

  // 2. Build column map for descriptions
  const colMap = {};
  columnsResult.forEach(r => {
    if (!colMap[r.table_name]) colMap[r.table_name] = [];
    colMap[r.table_name].push(r.column_name);
  });

  // 3. Build nodes
  const nodes = allTables.map(t => ({
    id: t,
    domain: classifyDomain(t),
    hub: HUB_TABLES.has(t),
    desc: generateDescription(t, colMap[t] || []),
  }));

  const nodeSet = new Set(allTables);

  // 4. Build links from FKs (only include links where both tables are in our node set)
  const links = [];
  const seenLinks = new Set();

  fkResult.forEach(fk => {
    const { source_table, source_column, target_table, target_column } = fk;
    if (!nodeSet.has(source_table) || !nodeSet.has(target_table)) return;
    const key = `${source_table}→${target_table}:${source_column}`;
    if (seenLinks.has(key)) return;
    seenLinks.add(key);
    links.push({ s: source_table, t: target_table, lbl: source_column });
  });

  console.log(`🔗  Found ${links.length} foreign key relationships`);

  // 5. Generate the data block
  const generated = new Date().toISOString().slice(0, 10);
  const dataBlock = buildDataBlock(nodes, links, generated);

  // 6. Inject into HTML
  const html = fs.readFileSync(DIAGRAM_FILE, 'utf-8');
  const startMarker = '/* SCHEMA_DATA_START */';
  const endMarker   = '/* SCHEMA_DATA_END */';
  const start = html.indexOf(startMarker);
  const end   = html.indexOf(endMarker) + endMarker.length;

  if (start === -1 || end === -1) {
    console.error('❌  Could not find SCHEMA_DATA markers in HTML file.');
    process.exit(1);
  }

  const updated = html.slice(0, start) + dataBlock + html.slice(end);

  // Also update the generated date in the header
  const finalHtml = updated.replace(
    /Generated: \d{4}-\d{2}-\d{2}/,
    `Generated: ${generated}`
  );

  fs.writeFileSync(DIAGRAM_FILE, finalHtml, 'utf-8');

  console.log(`✅  Updated index.html`);
  console.log(`   ${nodes.length} tables · ${links.length} relationships · ${generated}`);
  console.log(`\n   Open: ${DIAGRAM_FILE}`);
}

// ── Description Generator ────────────────────────────────────
// Generates a human-readable description based on table name + columns
function generateDescription(tableName, columns) {
  const has = col => columns.includes(col);

  // Detect common patterns
  const isPK      = has('id');
  const hasMember = has('member_id');
  const hasCoach  = has('coach_id') || has('staff_id');
  const hasDate   = columns.some(c => c.endsWith('_date') || c.endsWith('_at'));

  // Table-name based descriptions
  const presets = {
    member_database:    'Core member records — the central hub for all member data',
    member_memberships: 'Membership contracts per member (one row per contract period/renewal)',
    member_holds:       'Membership pause periods — members on hold remain active in member_database',
    member_programs:    'Programming assignments: maps members to their programming coaches',
    staff_database:     'All Locker Room staff and coaches — roles, gym, RM ceiling, hierarchy',
    stripe_invoices:    'All Stripe invoices — primary revenue source of truth (amounts in AUD cents)',
    stripe_customers:   'Stripe customer records linked to Locker Room members',
    stripe_transactions:'Individual payment transactions and charge attempts',
    schedule_sessions:  'Every scheduled gym session across all three gym locations',
    schedule_final:     'Locked final schedule — confirmed coach block assignments per week',
    schedule_preferences: 'Coach block preferences: HARD (unavailable) / SOFT / PREFERRED',
    hubspot_contacts_clean: 'HubSpot CRM contacts (leads/prospects) — synced periodically, not real-time',
    member_health_metrics: 'Body composition time series (InBody + app/wearable ingest): weight, BF%, masses, BMR, score, source — see architecture §12',
    member_physicals_raw: 'Quarterly fitness assessments: VO2, push-ups, grip strength, vertical jump, RSI',
    programming_generated: 'AI-generated personalised workout programs for members',
    pm_projects:        'Internal project tracking — top-level projects and initiatives',
  };

  if (presets[tableName]) return presets[tableName];

  // Auto-generate from name
  const parts = tableName.split('_');
  const entity = parts.slice(0, 2).join(' ');
  let desc = `${entity.replace(/_/g,' ')} data`;
  if (hasMember) desc += ` · linked to member_database`;
  if (hasCoach && !hasMember) desc += ` · linked to staff_database`;
  if (hasDate) desc += ` · timestamped records`;
  return desc.charAt(0).toUpperCase() + desc.slice(1);
}

// ── Data Block Builder ───────────────────────────────────────
function buildDataBlock(nodes, links, date) {
  // Group nodes by domain for the DOMAINS object
  const domainsJS = `const DOMAINS = {
  members:     { label: "Members",            color: "#00E5FF" },
  staff:       { label: "Staff & Coaches",    color: "#64FFDA" },
  scheduling:  { label: "Scheduling",         color: "#CE93D8" },
  finance:     { label: "Finance",            color: "#FFD54F" },
  health:      { label: "Health & Physicals", color: "#FF6E6E" },
  crm:         { label: "CRM & Sales",        color: "#FFB74D" },
  programming: { label: "Programming",        color: "#A5D6A7" },
  coach_ops:   { label: "Coach Operations",   color: "#F48FB1" },
  pm:          { label: "Project Mgmt",       color: "#81D4FA" },
  system:      { label: "System Config",      color: "#90A4AE" },
};`;

  const nodesJS = `const RAW_NODES = [\n` +
    nodes.map(n =>
      `  { id:${JSON.stringify(n.id)}, domain:${JSON.stringify(n.domain)}, hub:${n.hub}, desc:${JSON.stringify(n.desc)} },`
    ).join('\n') +
    `\n];`;

  const linksJS = `const RAW_LINKS = [\n` +
    links.map(l =>
      `  { s:${JSON.stringify(l.s)}, t:${JSON.stringify(l.t)}, lbl:${JSON.stringify(l.lbl)} },`
    ).join('\n') +
    `\n];`;

  return `/* SCHEMA_DATA_START */
// Auto-generated: ${date}
// Run \`node update-schema.js\` to refresh
${domainsJS}

${nodesJS}

${linksJS}
/* SCHEMA_DATA_END */`;
}

// ── Run ──────────────────────────────────────────────────────
main().catch(err => {
  console.error('❌  Error:', err.message);
  process.exit(1);
});
