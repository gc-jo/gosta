# GOSTA

Branch inventory system, being rebuilt on Supabase (Postgres, Auth, Edge Functions).
The database schema, security rules and tests live in `supabase/`.

## Local development

Requires Docker and the [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
supabase start      # start the local stack
supabase db reset   # apply all migrations, then supabase/seed.sql
supabase test db    # run every supabase/tests/*.test.sql (pgTAP)
```

## legacy/

`legacy/` holds the old Google Apps Script app (`Code.js`, `index.html`). It is reference only
and is not deployed from this repo.
