# Private shared-fund setup

The site uses the existing GitHub Pages URL and only the Supabase publishable key. Admin writes remain protected by database authorization. Passwordless **Member login** intentionally exposes the complete selected fund ledger through a read-only database function to anyone who can reach the site.

## Secure the existing Supabase project

1. In Supabase, open **SQL Editor** and run `supabase-privacy-migration.sql`. It protects direct ledger-table access and installs the admin/read functions.
   The migration also creates the read-only function used by **Member login**. It returns all records in the Community Fund without an account; reading the Activities Fund additionally requires the shared `1111` PIN. Admin sign-in is still required for edits.
2. Run the local `supabase-private-roster.sql` file in the SQL Editor. It seeds the member directory without shipping names and birthdays in the public JavaScript bundle. This file is intentionally ignored by Git; do not publish it.
3. Keep the existing administrator account in **Authentication → Users** and confirm that it is authorized in `public.fund_admins`. Admins can read and edit both ledgers.
4. **Optional:** Create Auth accounts for members who need account-specific access through the authenticated database function. This is not required for passwordless **Member login**. Map each account to exactly one community member using that member's zero-based index from the roster:

   ```sql
   insert into public.fund_member_accounts (fund_id, member_index, user_id)
   select 'fund', 0, id
   from auth.users
   where email = 'member@example.com'
   on conflict (fund_id, member_index)
   do update set user_id = excluded.user_id;
   ```

   Replace the example email and index. Repeat for each community member. A community account sees only its own contributions, expense share, and receipts.
5. **Optional:** Create Auth accounts for Activities Fund viewers who need account-specific access through the authenticated database function. This is not required for passwordless **Member login**:

   ```sql
   insert into public.fund_activities_viewers (user_id, member_index)
   select id, 0
   from auth.users
   where email = 'approved-viewer@example.com'
   on conflict (user_id)
   do update set member_index = excluded.member_index;
   ```

   Replace the email and zero-based Activities Fund member index. Approved viewers may see the Activities ledger; receipts remain limited to their own account and admins.
6. Publish the updated `index.html`, `script.js`, `style.css`, and `supabase-config.js` to GitHub Pages **after** both SQL files have been run. Until the migration is applied, the old public-read policy remains active.

Do not put a service-role key, database password, or user password in the repository or browser config. The publishable key is expected to be visible to site visitors.

## Existing browser records

Shared mode does not load or cache ledger contents in local storage. To preserve old browser-only records, an administrator should sign in on the browser that has them and use **Import this browser’s records** while that shared ledger is empty. The app clears its old local cache after import or when a non-admin account signs in.

## Privacy limits

The previous setup allowed public reads. Treat data that was stored before the migration as potentially exposed; applying the migration cannot recall copies already downloaded or cached. Names and birthdays were also present in previously published JavaScript. This update stops shipping the roster in new app code; the read-only member functions expose the roster and Community Fund at runtime, and expose the Activities Fund to anyone who enters the shared PIN.

The Activities Fund's shared `1111` PIN is checked by the UI and the database read function. It is only a four-digit shared PIN, not strong authentication; anyone who knows or guesses it can view the entire Activities Fund. Do not store information that must remain confidential from site visitors. Database writes still require an authorized administrator.
