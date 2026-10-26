import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Dataset, Fact, Scope } from '../../packages/metrics/types.js';

export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, 'Use a valid YYYY-MM-DD date.');
const time = z.string().datetime({ offset: true });
const identifier = z.string().min(1).max(150).regex(/^[a-zA-Z0-9_.:/-]+$/);
const number = z.coerce.number().finite();
const surveySchema = z.object({
  team: identifier, from: daySchema, to: daySchema,
  question: z.enum(['satisfaction', 'friction', 'sustainability', 'copilot-usefulness', 'quality-outcome']),
  min: number, max: number, responses: number.int().positive(), score: number,
  eligible: z.union([z.literal(''), number.int().positive()]).optional(),
}).strict().superRefine((row, ctx) => {
  if (row.from > row.to) ctx.addIssue({ code: 'custom', message: 'Survey from must not exceed to.' });
  if (row.min >= row.max || row.score < row.min || row.score > row.max) ctx.addIssue({ code: 'custom', message: 'Score must fit a valid min/max scale.' });
  if (typeof row.eligible === 'number' && row.eligible < row.responses) ctx.addIssue({ code: 'custom', message: 'Responses exceed eligible population.' });
});
const incidentSchema = z.object({
  record_type: z.enum(['incident', 'coverage']),
  service: identifier,
  incident_id: z.string().max(150),
  failed_at: z.union([z.literal(''), time]),
  recovered_at: z.union([z.literal(''), time]),
  failed_deployments: z.string().max(4000),
  rework_deployments: z.string().max(4000),
  from: z.union([z.literal(''), daySchema]),
  to: z.union([z.literal(''), daySchema]),
}).strict().superRefine((row, ctx) => {
  if (row.record_type === 'coverage') {
    if (!row.from || !row.to || row.from > row.to) ctx.addIssue({ code: 'custom', message: 'Coverage needs a valid from/to window.' });
    if (row.incident_id || row.failed_at || row.recovered_at || row.failed_deployments || row.rework_deployments) ctx.addIssue({ code: 'custom', message: 'Coverage rows cannot contain incident fields.' });
  } else {
    if (!row.incident_id || !row.failed_at || !row.failed_deployments) ctx.addIssue({ code: 'custom', message: 'Incident needs ID, failure timestamp, and failed deployment links.' });
    if (row.recovered_at && Date.parse(row.recovered_at) < Date.parse(row.failed_at)) ctx.addIssue({ code: 'custom', message: 'Recovery cannot precede failure.' });
    if (row.from || row.to) ctx.addIssue({ code: 'custom', message: 'Use a separate coverage row for observation dates.' });
  }
});
export interface ImportPreview {
  kind: 'surveys' | 'incidents';
  count: number;
  suppressedRows: number;
  errors: { row: number; message: string }[];
  facts: Fact[];
  fingerprint: string;
}
export function previewImport(kind: 'surveys' | 'incidents', csv: string, scope: Scope, existing: Dataset): ImportPreview {
  if (Buffer.byteLength(csv) > 2 * 1024 * 1024) throw new Error('CSV exceeds the 2 MB import limit.');
  let rows: unknown[];
  try {
    rows = parse(csv, { columns: (headers: string[]) => {
      if (new Set(headers).size !== headers.length) throw new Error('Duplicate headers.');
      return headers;
    }, bom: true, skip_empty_lines: true, max_record_size: 16_384, trim: true }) as unknown[];
  } catch {
    throw new Error('CSV could not be parsed. Use the supplied template, unique headers, and quoted comma-containing values.');
  }
  if (!rows.length || rows.length > 10_000) throw new Error('Import requires between 1 and 10,000 rows.');
  const facts: Fact[] = [], errors: ImportPreview['errors'] = [];
  let suppressedRows = 0;
  const seen = new Set<string>();
  for (const [index, input] of rows.entries()) {
    const result = kind === 'surveys' ? surveySchema.safeParse(input) : incidentSchema.safeParse(input);
    if (!result.success) {
      errors.push({ row: index + 2, message: result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
      continue;
    }
    const row = result.data;
    let fact: Fact;
    if ('team' in row) {
      const id = `${row.team}:${row.question}:${row.from}:${row.to}`;
      if ([...existing.facts, ...facts].some(f => f.source === 'surveys' && f.id !== id && f.data.team === row.team && f.data.question === row.question && String(f.data.from) <= row.to && String(f.data.to) >= row.from)) {
        errors.push({ row: index + 2, message: 'Survey period overlaps another aggregate for the same team and question.' });
        continue;
      }
      if (row.responses < 5) suppressedRows++;
      fact = { source: 'surveys', id, day: row.to, data: { ...row, eligible: row.eligible === '' ? undefined : row.eligible } };
    } else {
      if (!scope.services.some(s => s.id === row.service)) {
        errors.push({ row: index + 2, message: 'Service is not mapped in this scope.' }); continue;
      }
      if (row.record_type === 'coverage') {
        fact = { source: 'observation', id: `${row.service}:${row.from}:${row.to}`, day: row.to, data: { service: row.service, from: row.from, to: row.to } };
      } else {
        const split = (value: string) => [...new Set(value.split(';').map(v => v.trim()).filter(Boolean))];
        const failed = split(row.failed_deployments), rework = split(row.rework_deployments);
        const validLinks = new Set(existing.facts.filter(f => f.source === 'deployments' && f.data.service === row.service).map(f => f.id));
        const invalid = [...failed, ...rework].some(id => !validLinks.has(id));
        if (invalid) { errors.push({ row: index + 2, message: 'Deployment link not found in synced production evidence for this service. Use IDs from the deployment evidence export.' }); continue; }
        fact = { source: 'incidents', id: `${row.service}:${row.incident_id}`, day: row.failed_at.slice(0, 10), data: {
          service: row.service, failed_at: new Date(row.failed_at).toISOString(), recovered_at: row.recovered_at ? new Date(row.recovered_at).toISOString() : null,
          failed_deployments: failed, rework_deployments: rework,
        } };
      }
    }
    if (seen.has(`${fact.source}:${fact.id}`)) { errors.push({ row: index + 2, message: 'Duplicate row identity in this import.' }); continue; }
    seen.add(`${fact.source}:${fact.id}`);
    facts.push(fact);
  }
  return { kind, count: facts.length, suppressedRows, errors, facts, fingerprint: createHash('sha256').update(csv).digest('hex') };
}
export const templates = {
  surveys: 'team,from,to,question,min,max,responses,score,eligible\n',
  incidents: 'record_type,service,incident_id,failed_at,recovered_at,failed_deployments,rework_deployments,from,to\n',
};
export function csvEscape(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
