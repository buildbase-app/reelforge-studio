# Draft: request to BuildBase support for the live-selling pilot (#90)

For the founder to send from the account that owns the ReelForge
organisation. The agent did not send it and contacted no one. No secrets,
keys or client ids below; the organisation id and the development
environment key are the ones already public in `docs/STATUS.md` §4.

Before sending: in the console, open **Your plan** and check whether it lists
"live selling with real money"; fill the line marked `[PLAN]` with what it
says.

## Subject

Add the ReelForge production organisation to the live-selling pilot

## Message

```text
Hello BuildBase support,

Please add our organisation to the live-selling pilot so its own store can
take live payments.

Organisation: ReelForge, id 6b01478bb42d2c444e99fcd8 (production
environment). Site: https://reelforge.buildbase.app

How we sell:
- Our own store only: the app sells its own items to buyers, paid to our own
  Stripe account. No sellers, no Stripe Connect, no marketplace or
  storefront shape.
- Items are software licences: a free "Personal" item (free claim) and a
  paid one-time "Commercial" item in tiers. The benefit is a licence key,
  which our self-hosted software activates and validates through the
  BuildBase licence API.
- Live Stripe keys are already saved in production. Products will be
  created there once our prices are final.

What already works in the organisation's development environment
(fsyqdskf, Stripe test keys):
- A test purchase with a Stripe test card returns to our order page with the
  Commercial licence key, and the key shows in the buyer's dashboard.
- The free Personal claim completes without a payment page.
- Our self-hosted software activates, validates and deactivates a key from
  a test purchase against the licence API.

Our understanding from https://docs.buildbase.app/billing/selling ("Test in
Staging, then go live") is that, until the app is on the pilot list,
turning selling on with live keys and a buyer's checkout with live keys
answer 403 LIVE_SELLING_NOT_ALLOWED.

[PLAN] Our plan page shows: <what Your plan says about "live selling with
real money">. If our plan needs a change for live selling, please tell us
which.

We would like to go live by Monday 30 November. Could you let us know
whether the organisation can join the pilot, and roughly when?

Thank you,
{{founder_name}}
ReelForge
```

## After the answer

Record the date and the answer (yes/no, any conditions) in #90 and in
`docs/STATUS.md` (an agent can make the STATUS edit in a PR). If there is no
yes by Nov 27, the founder decides the contingency in #249 §1 and
`SITE_PLAN.md` §E.4.

## Facts checked

- Organisation id, development environment `fsyqdskf`, live Stripe keys
  saved, no products yet: [`STATUS.md` §4](../STATUS.md) "Infrastructure inventory".
- Own store needs no Connect: [`SITE_PLAN.md` §0](../research/SITE_PLAN.md) item 2; #90 context;
  BuildBase docs "Your own store" (https://docs.buildbase.app/billing/selling, read 2026-11-23).
- `LIVE_SELLING_NOT_ALLOWED` for live keys until the app is on the pilot list, and the
  "live selling with real money" plan feature: same BuildBase page, "Test in Staging, then go live".
- Test purchase with the key on the order page and in Dashboard > Licences; free Personal claim:
  [`docs/public/walkthroughs.md`](../public/walkthroughs.md); [`STATUS.md` §6](../STATUS.md) B2, B5.
- Live key check against the dev environment (activate → valid 1/1 → deactivate):
  [`STATUS.md` §3](../STATUS.md) "Licence activation".
- Go-live gate Nov 30, contingency by Nov 27: #90, #249 §1.
