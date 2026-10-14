// Messaging providers behind one interface.
//
// send-sms talked to Twilio directly, which meant three things were welded
// together: deciding a message may be sent, carrying it, and recording what
// happened. Adding a second provider would have meant editing the send path,
// and testing any of it meant sending a real text to a real phone.
//
// A provider does exactly one job: take a message, hand it somewhere, and say
// what it knows. It does not decide whether sending is allowed -- opt-out,
// quiet hours and the registered-number rules stay in send-sms, where they
// apply to every provider rather than being re-implemented per provider and
// eventually forgotten in one of them.

export interface SendArgs {
  from: string;
  to: string;
  body: string;
  statusCallback: string;
}

export interface SendResult {
  ok: boolean;
  id?: string;
  /* The state the message is in once the provider has it. A provider that
     cannot confirm anything says 'queued' rather than borrowing 'sent' -- the
     whole point of the delivery states is that each one is earned. */
  status?: 'queued' | 'sent' | 'delivered' | 'failed';
  error?: string;
}

export interface Provider {
  name: string;
  /* Whether messages through this provider reach a real phone. The UI uses it
     to say so plainly: a sandbox that looks identical to production is a
     sandbox somebody will eventually mistake for production. */
  real: boolean;
  send(args: SendArgs): Promise<SendResult>;
}

// --- Twilio ---------------------------------------------------------------

export function twilioProvider(accountSid: string, authToken: string): Provider {
  return {
    name: 'twilio',
    real: true,
    async send(args: SendArgs): Promise<SendResult> {
      const form = new URLSearchParams({
        From: args.from, To: args.to, Body: args.body,
        // Without this the delivery receipt never arrives and 'sent' is the
        // last thing we ever know -- indistinguishable from a text the
        // carrier silently dropped.
        StatusCallback: args.statusCallback,
      });
      let res: Response;
      try {
        res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
            method: 'POST',
            headers: {
              Authorization: 'Basic ' + btoa(`${accountSid}:${authToken}`),
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: form.toString(),
          });
      } catch (e) {
        // A network failure is not a send. Reporting it as one would put a
        // message in the thread that never left the building.
        return { ok: false, error: 'could not reach the provider: ' + (e as Error).message };
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: body?.message || `provider returned ${res.status}` };
      }
      return { ok: true, id: body?.sid, status: 'sent' };
    },
  };
}

// --- Sandbox --------------------------------------------------------------

/* A provider that carries nothing anywhere.
 *
 * It exists so the whole loop -- compose, send, thread, reply, follow-up
 * state -- can be exercised without a carrier account, without 10DLC
 * registration, and above all without texting a real customer to find out
 * whether the code works. Every message it accepts is recorded exactly as a
 * real one would be, so what is being tested is the real path.
 *
 * It reports 'delivered' immediately. That is honest here precisely because
 * nothing is in flight: there is no carrier that could fail later. A sandbox
 * that reported 'queued' forever would make the delivery states untestable,
 * which is the one thing it is for.
 */
export function sandboxProvider(): Provider {
  return {
    name: 'sandbox',
    real: false,
    send(args: SendArgs): Promise<SendResult> {
      const id = 'SBX' + crypto.randomUUID().replace(/-/g, '').slice(0, 29);
      /* A body the test can steer with: anything containing FAIL comes back
         as a provider rejection, so the failure path is reachable without
         breaking the provider or waiting for a real carrier to misbehave. */
      if (/\bFAIL\b/.test(args.body)) {
        return Promise.resolve({ ok: false, error: 'sandbox: asked to fail' });
      }
      return Promise.resolve({ ok: true, id, status: 'delivered' });
    },
  };
}

// --- picking one ----------------------------------------------------------

/* By the name on the number's row, so a team can run one rep on a sandbox
   number while the rest send for real -- which is how this gets tried without
   a flag day. An unknown provider is refused rather than quietly falling back
   to a real one: silently sending for real when someone expected a sandbox is
   the worst possible direction for that mistake to go. */
export function providerFor(
  name: string | null | undefined,
  env: { accountSid?: string; authToken?: string },
): { provider?: Provider; error?: string } {
  const key = (name || 'twilio').toLowerCase();
  if (key === 'sandbox') return { provider: sandboxProvider() };
  if (key === 'twilio') {
    if (!env.accountSid || !env.authToken) {
      return { error: 'Texting is not configured yet. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on this function.' };
    }
    return { provider: twilioProvider(env.accountSid, env.authToken) };
  }
  return { error: `Unknown messaging provider "${key}" on that number.` };
}
