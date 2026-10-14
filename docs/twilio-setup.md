# Twilio + A2P 10DLC setup

Everything in Ghost Recall's SMS path is built, deployed and tested. This is
the part that needs a human with a credit card and a tax ID, plus the carrier
filing that gates the whole thing.

**The only step with a long clock is the campaign review.** Everything else is
minutes. File the campaign the same day you open the account.

---

## 1. Account (you, in a browser)

https://www.twilio.com/try-twilio — sign up as **Market Maker Management**,
not a personal account. The brand registration in step 3 has to match a real
business with a real EIN, and moving a number between accounts later means
re-registering.

Upgrade out of trial immediately (Console → top right → Upgrade). A trial
account cannot send to unverified numbers, which would look exactly like the
carrier filtering this setup exists to avoid.

Do **not** buy a phone number yet. Step 3 first — a number that is not
attached to an approved campaign gets its traffic blocked, and the block is
silent.

## 2. Collect what the filing needs

- Legal business name, exactly as registered
- **EIN** (federal tax ID). A sole-proprietor filing is possible but has a far
  lower throughput cap and a harder review.
- Registered business address
- Website — **ghostrecallcrm.com** is the sending product; if Market Maker
  Management has its own site, use that, since the brand is the business
- A business email on the domain (john@marketmakermgmt.com)
- Mobile number for the verification code

## 3. Brand, then campaign

Console → **Messaging → Regulatory Compliance → A2P 10DLC**.

**Brand:** Private for-profit, Standard (not Low-Volume) if you intend more
than one number or more than ~3,000 segments/day.

**Campaign use case:** *Customer Care*. Not Marketing — these are
confirmations and reminders for appointments the recipient booked themselves,
and a Marketing filing invites stricter review and lower throughput for no
benefit.

### Campaign description

> Appointment confirmations, reminders and follow-ups sent to prospects and
> customers who have booked a call or appointment with Market Maker
> Management. Messages confirm the time, remind before the appointment, and
> follow up afterwards. Recipients provide their mobile number when booking.

### Message flow — the field that gets campaigns rejected

Be literal about where the number comes from. Vague consent language is the
single most common rejection.

> The recipient books an appointment through our booking page or by scheduling
> a meeting with a team member, and supplies their mobile number as part of
> that booking. The booking form states that they will receive text messages
> about the appointment. Consent is collected at the point of booking; we do
> not purchase, rent or import contact lists. Messages relate only to the
> appointment that person booked.

**This must be true before you file.** If the booking page does not currently
say that texts will be sent, add that line to it first — see section 5.

### Sample messages

Paste these verbatim; they are produced by the live templates.

1. `Hi Sarah, Johnny here. We're set for Oct 15 at 6:08 PM PDT. If there's something in particular you want covered, reply and I'll make sure we get to it. Reply STOP to opt out.`
2. `Hey Sarah, quick heads up that we're on for this Thursday at 6:08 PM PDT. Nothing needed from you beforehand - just keep it on the calendar.`
3. `Hey Sarah, we're on in about an hour at 6:08 PM PDT. Here's the link so it's handy: https://meet.google.com/abc-defg-hij`
4. `Hey Sarah, Johnny here. Been a while. If this is still on the list, happy to pick it back up. If not, no hard feelings and I'll leave you be.`

### Opt-in / opt-out / help

- **Opt-in:** collected at booking (not a keyword). Say so.
- **Opt-out keywords:** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT
- **Opt-out reply:** `You have been unsubscribed and will not receive further messages from Market Maker Management.`
- **Help keywords:** HELP, INFO
- **Help reply:** `Market Maker Management appointment reminders. Call (your number) or email john@marketmakermgmt.com. Reply STOP to opt out.`

Answer **yes** to "do messages include links" (the hour-before message
includes the meeting link). Answer **no** to affiliate marketing, lead
generation, age-gated content and loan content.

## 4. Number, secrets, webhooks

Only after the campaign is **approved**.

1. Buy a local number and attach it to the approved campaign.
2. Console → the number → **Messaging**:
   - *A message comes in* → `https://gqfpsjksosxvszzhhezu.supabase.co/functions/v1/sms-webhook` (HTTP POST)
   - *Status callback URL* → the same URL
3. Set the secrets (Account SID and Auth Token from the Console dashboard):

   ```
   supabase secrets set TWILIO_ACCOUNT_SID=ACxxxx TWILIO_AUTH_TOKEN=xxxx --project-ref gqfpsjksosxvszzhhezu
   ```

   Do not paste these into chat. Ghost Recall never needs to see them.

4. Register the number in Ghost Recall. **This row is the switch** — until it
   exists with `status = 'registered'`, every contact falls back to the
   Open-in-Messages handoff and nothing changes for anyone:

   ```sql
   insert into public.org_phone_numbers (phone_number, org_id, provider, status, label)
   values ('+1XXXXXXXXXX', 'ee73ce65-bc6c-4f4f-97d2-42dce27f67c9', 'twilio', 'registered', 'main');
   ```

   (That org id is Market Maker Management. One number per org.)

## 5. Before you file: the booking page

The message-flow text above claims the booking form tells people they will be
texted. Make that true, or the filing is describing something that does not
happen — carriers do check landing pages.

Add to the booking page, near the phone field:

> By booking, you agree to receive text messages about this appointment.
> Message and data rates may apply. Reply STOP to opt out.

## 6. First real send

Send to your own phone first, then reply **STOP**, then check:

```sql
select id, name, sms_status, sms_status_at from public.clients where sms_status <> 'ok';
```

Your contact should read `opted_out`, and the Send text button should be
replaced by "opted out of texts". That exercises the two paths that cannot be
tested without a live number: send-sms against real Twilio, and its refusal
to text an opted-out contact.

---

## Cost note

Five of the 29 starter templates contain an em-dash or a 👍, which forces
UCS-2 encoding and cuts a segment from 160 characters to 70. Those five cost
2-3 segments each instead of 1 — about 18% of the per-message cost of the
whole book, for three em-dashes and two emoji. Sample message 2 above has the
em-dash already replaced with a hyphen; the templates themselves have not been
changed, because editing builtin copy retires that variant's accumulated
stats.
