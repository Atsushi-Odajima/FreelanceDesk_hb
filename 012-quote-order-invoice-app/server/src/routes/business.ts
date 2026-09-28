import { Hono } from 'hono';
import { type AppEnv, body, type Services } from '../context';
import { one } from '../db';
import { businessSchema } from '../schemas';
import { camelRow } from '../services/format';

export function businessRoutes(s: Services) {
  const r = new Hono<AppEnv>();

  r.get('/', async (c) => {
    const b = await one(s.pool, 'SELECT * FROM business_profiles WHERE account_id=$1', [c.get('accountId')]);
    return c.json({ business: camelRow(b) });
  });

  r.put('/', async (c) => {
    const i = await body(c, businessSchema);
    const b = await one(
      s.pool,
      `UPDATE business_profiles SET name=$2, contact_name=$3, postal_code=$4, address=$5, phone=$6, email=$7, bank_info=$8, registration_no=$9,
         brand_color=$10, default_payment_terms=$11, default_notes=$12, default_tax_rate=$13, tax_mode=$14, line_rounding=$15, tax_rounding=$16,
         quote_valid_days=$17, invoice_due_days=$18, updated_at=now()
       WHERE account_id=$1 RETURNING *`,
      [
        c.get('accountId'),
        i.name,
        i.contactName,
        i.postalCode,
        i.address,
        i.phone,
        i.email,
        i.bankInfo,
        i.registrationNo,
        i.brandColor,
        i.defaultPaymentTerms,
        i.defaultNotes,
        i.defaultTaxRate,
        i.taxMode,
        i.lineRounding,
        i.taxRounding,
        i.quoteValidDays,
        i.invoiceDueDays,
      ],
    );
    return c.json({ business: camelRow(b) });
  });

  return r;
}
