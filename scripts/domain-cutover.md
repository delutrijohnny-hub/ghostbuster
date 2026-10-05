# Moving Ghost Recall to a new domain

> **DONE — 5 October 2026.** Live on `www.ghostrecallcrm.com`. All three old
> entry points 308 to it in a single hop, and `ghostbustercrm.com/app` still
> resolves through to the app. Kept below as the record, including the two
> things this document got wrong, because they are the parts worth knowing if
> it is ever done again.
>
> **What the plan got wrong, both found while doing it:**
>
> 1. **It blamed the wrong console.** This said Google's allow-list was what
>    could lock everyone out. It is Supabase's. Google's authorised redirect
>    URI is Supabase's callback and a domain move never touches it. Following
>    the original would have meant time spent in Google Cloud Console, a
>    confident "done", and then nobody able to sign in.
>
> 2. **Vercel refuses to redirect a domain that something else redirects TO.**
>    `ghostbustercrm.com` pointed at `www.ghostbustercrm.com`, so the www could
>    not itself be made a redirect until the apex was repointed first. The
>    error names this clearly but only after you try, so do the apex first.
>
> **Two traps in the Vercel UI, neither of which errors:**
>
> - The Edit panel pre-fills the redirect target with the *other* existing
>   domain, which makes pointing the NEW domain at the OLD one look correct.
>   The row being edited is the one that gets sent away. Check the Domain field
>   at the top before changing anything.
> - It defaults to **307 Temporary**. For a rename you want **308 Permanent**,
>   or the old name never actually retires and search ranking does not move.


No code change is needed. Verified on 2026-10-02: the only place the app cared
about its own address was the Google sign-in redirect, and that reads
`window.location.origin`, so it follows whatever domain serves the page. The
last hard-coded mention of `ghostbustercrm.com` was a comment in
`supabase/functions/gemini-draft/index.ts` and it is gone. The whole move is
configuration in three consoles.

## The one way this breaks

Switch DNS before **Supabase** knows about the new domain and **every sign-in
fails at once** — for the whole team, not gradually. Supabase refuses to
redirect back to an address that is not on its allow-list, so people complete
the Google prompt and then land nowhere.

See the section below for why it is Supabase rather than Google: the first
draft of this file blamed the wrong console.

So the order matters. Every step up to and including 4 is additive and changes
nothing for anyone while the old domain keeps serving. Nobody is affected
until step 6.

## Which console actually matters

Corrected after reading `hosted/auth.js`. It calls `signInWithOAuth` with
`redirectTo`, so the flow is:

```
browser -> Supabase /auth/v1/authorize -> Google -> Supabase callback -> your app
```

Google never redirects to your domain. Its authorised redirect URI is
**Supabase's** callback, `https://gqfpsjksosxvszzhhezu.supabase.co/auth/v1/callback`,
which does not change when the domain does.

**So the allow-list that can lock everyone out is Supabase's, not Google's.**
An earlier draft of this file had that backwards and would have sent you to
spend time in Google Cloud Console believing the job was done.

Confirm it in one look before starting: Google Cloud Console -> Credentials ->
your OAuth client -> Authorised redirect URIs. If it lists the Supabase
callback, nothing there needs touching for sign-in to keep working. If it
somehow lists `ghostbustercrm.com`, tell me, because the rest of this changes.

## Order of operations

New domain: **ghostrecallcrm.com**

1. **Register it.** Confirm availability at the registrar; a DNS check showed
   no nameservers, which is a strong hint but not proof.

2. **Supabase — the one that matters.** Dashboard -> Authentication -> URL
   Configuration. ADD to **Redirect URLs** (do not remove the old ones):
   - `https://ghostrecallcrm.com/**`
   - `https://www.ghostrecallcrm.com/**`

   Leave **Site URL** on the old domain for now; it changes in step 6.

3. **Vercel.** Project -> Settings -> Domains -> Add `ghostrecallcrm.com` (and
   the `www` variant). Vercel shows the DNS records it wants. Do not set it as
   primary yet.

4. **DNS.** At the registrar, add exactly the records Vercel asked for. Wait
   for Vercel to show the domain as Valid.

5. **Verify before switching anything.** Open `https://ghostrecallcrm.com/app`
   and sign in with Google. This is the real test. If it fails, the old domain
   is still serving everyone normally while you fix it. The likely error is a
   redirect that bounces back to the old address — that means step 2 is
   incomplete.

6. **Make it primary.** Vercel: set `ghostrecallcrm.com` as primary and leave
   `ghostbustercrm.com` redirecting to it. Supabase: change **Site URL** to
   `https://ghostrecallcrm.com`.

7. **Branding, not function.** Google Cloud Console -> OAuth consent screen:
   app name to Ghost Recall, homepage and privacy policy link to
   `https://ghostrecallcrm.com/privacy`. This cannot break sign-in, but
   changing the name or links on a published app can trigger re-review, so do
   it deliberately rather than late on a Friday.

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
