# Shared fund setup (GitHub Pages)

The site remains at its existing URL. With Supabase configured, every visitor reads the current community or activities ledger from the same database. Visitors can view records; only explicitly authorized administrator accounts can edit them.

## Configure Supabase

1. Create a Supabase project.
2. In **Project Settings → API**, copy the project URL and the publishable (or legacy `anon`) key into `supabase-config.js`:

   ```js
   window.FUND_APP_CONFIG = {
       url: "https://YOUR-PROJECT.supabase.co",
       anonKey: "YOUR-PUBLISHABLE-KEY"
   };
   ```

   These values are public in a browser app. **Never** put a service-role key or database password in this file.

3. Open the Supabase SQL Editor and run all of `supabase-setup.sql`.
4. In **Authentication → Users**, create the fund administrator account.
5. In the SQL Editor, authorize that account, replacing the email:

   ```sql
   insert into public.fund_admins (user_id)
   select id from auth.users where email = 'admin@example.com'
   on conflict (user_id) do nothing;
   ```

6. Deploy `index.html`, `script.js`, `style.css`, `supabase-config.js`, and the logo to GitHub Pages. `supabase-setup.sql` is run in Supabase; it does not need to be served by GitHub Pages.

## Import existing browser records

Existing localStorage records are not automatically uploaded or discarded. From the browser that has the records, open the relevant fund at the normal site URL, sign in as the authorized administrator, and select **Import this browser’s records** when offered. The import button is only offered when the corresponding shared ledger is empty. Repeat for the other fund if it has separate local records.

After import, normal edits save to the shared database, and already-open pages receive live updates. If Supabase is configured but unreachable, the site reports the problem and disables edits rather than claiming local-only changes were shared.

## Visibility and access

Both funds are publicly readable to anyone who can visit the site. This includes the External Activities Fund despite its “Highly Confidential” label; that label is not access control. Editing requires a Supabase-authenticated user listed in `fund_admins`. Do not authorize an account unless it should be able to change the shared ledgers.
