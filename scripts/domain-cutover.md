# Moving Ghost Recall to a new domain

No code change is needed. Verified on 2026-10-02: the only place the app cared
about its own address was the Google sign-in redirect, and that reads
`window.location.origin`, so it follows whatever domain serves the page. The
last hard-coded mention of `ghostbustercrm.com` was a comment in
`supabase/functions/gemini-draft/index.ts` and it is gone. The whole move is
configuration in three consoles.

## The one way this breaks

Switch DNS before Google and Supabase know about the new domain, and **every
sign-in fails at once** — for the whole team, not gradually. Google rejects the
OAuth redirect because the origin is not on its allow-list, and Supabase
rejects it because the redirect URL is not on its.

So the order below matters. Steps 1–3 are additive and change nothing for
anyone while the old domain keeps serving. Nobody is affected until step 5.

## Order of operations

1. **Google Cloud Console** — APIs & Services → Credentials → the OAuth 2.0
   client used for sign-in. ADD (do not replace):
   - Authorised JavaScript origins: `https://NEWDOMAIN`
   - Authorised redirect URIs: `https://NEWDOMAIN` and `https://NEWDOMAIN/app`

   Leave the existing `ghostbustercrm.com` entries in place. Both domains work
   from here until you choose to remove the old one.

2. **Supabase** — Authentication → URL Configuration. Add `https://NEWDOMAIN`
   and `https://NEWDOMAIN/**` to Redirect URLs. Leave Site URL pointing at the
   old domain for now; change it in step 6.

3. **Vercel** — Project → Settings → Domains → Add `NEWDOMAIN`. Vercel will
   show the DNS records it wants. Do not set it as primary yet.

4. **DNS** — at the registrar for the new domain, add the records Vercel asked
   for. Wait for Vercel to show the domain as Valid.

5. **Verify before switching.** Open `https://NEWDOMAIN/app` and sign in with
   Google. This is the real test: if the consent screen errors with
   `redirect_uri_mismatch`, step 1 or 2 is incomplete, and the old domain is
   still serving everyone normally while you fix it.

6. **Make it primary.** In Vercel set `NEWDOMAIN` as the primary domain and
   leave `ghostbustercrm.com` as a redirect to it. In Supabase change Site URL
   to `https://NEWDOMAIN`.

7. **Consent screen.** Google Cloud → OAuth consent screen: update the app
   name to Ghost Recall, the application home page, and the privacy policy link
   to `https://NEWDOMAIN/privacy`. Changing the name or the links can put the
   app back into review if it is published — worth doing deliberately rather
   than on a Friday.

## Afterwards

- `hosted/privacy.html` already says Ghost Recall; it does not name a domain,
  so nothing there needs editing.
- Edge Functions send `Access-Control-Allow-Origin: *`, so no CORS change.
- Leave the old domain redirecting rather than letting it lapse: calendar
  invites, emails and bookmarks already in the wild point at it.

## What not to do

- Do not remove the old domain from Google's allow-list in the same sitting.
  If anything is wrong you want the old address still working.
- Do not change Supabase's Site URL before step 5 passes. It is what password
  and magic-link flows build their links from.
