# @sattleme/checkout

Take Lightning and on-chain payments for a sattle.me merchant from an online shop's
**server**: the invoice of each order (a Lightning invoice, a deposit address of the merchant's
wallet, or both), its declaration in the merchant's registry, and the check of its payment.

- Everything runs on your server, which holds the integration's secret key. The customer's
  browser only ever gets the invoice and its address: on your page, or on the merchant's web app
  through a [checkout link](#checkout-links), if you ask for one.
- Payments go straight to the merchant's wallet. sattle.me runs no server and no API for
  integrations: this package talks to the merchant's Lightning address (breez.tips), to the
  merchant's Nostr relays and, for [on-chain payments](#on-chain-payments), to one block explorer
  (mempool.space, or [the merchant's own Bitcoin node](#the-merchants-bitcoin-node) when its app
  names one) and BlockCypher; nothing else (and to the rate source you choose, for prices in a
  currency).
- Amounts are exact: strings of digits (sats, a currency's minor units), never floating-point.

The protocol is specified, for implementations in other languages, in
[sattleme/checkout-spec](https://github.com/sattleme/checkout-spec) (`SPEC.md`),
with conformance vectors every implementation passes. This version implements its version 1.0.0
(`spec/PIN.json`).

## Requirements

- Node.js 22 or later (Bun and Deno: see [Other runtimes](#other-runtimes)), on a **server**.
- A clock synchronized by NTP: invoices more than 5 minutes off the server's clock are refused.
- An integration's secret key: the merchant creates the integration in the sattle.me app
  ("Integrations") and gives you its key, `sattleme_ck_…`.

```sh
npm install @sattleme/checkout
```

## The key is a secret

Keep the integration's key on the server only: in an environment variable or a secrets vault,
never in a web page, an app, a code repository or a log. With it, anyone can make invoices that
pay the merchant and mark sales as the integration's. It can never spend the merchant's funds nor
read their wallet.

If it leaks, the merchant removes the integration in the app ("Remove the integration") and
creates another one: the old key then makes no invoice, finds none and reads no merchant
(`RevokedError`). A check of an invoice it made still finds its Lightning payment: an invoice
without an address is checked as before, and one with an address is `RevokedError` unless its
Lightning invoice was paid (SPEC.md §14). The merchant settles by hand the orders still being paid
on-chain.

**One key, one shop.** The merchant creates one integration for each shop (each system with its
own orders' references), and two shops never share a key: the sale of an order is derived from the
key and the order's reference, so two shops with one key would share their references, and an
order of one would be found paid, or pending, with an invoice of the other. The servers of one
shop share its key.

## Quick start

```ts
import { Sattleme, InvoicePendingError } from "@sattleme/checkout";

// Nothing to connect nor to close: each call reads the merchant, opens one connection per relay
// and closes it when it is done.
const sattleme = new Sattleme({ key: process.env.SATTLEME_INTEGRATION_KEY! });

// When the customer checks out, or when the payment page asks again:
async function invoiceOf(order: Order) {
  if (order.invoice) return order.invoice; // one order, one invoice at a time
  try {
    order.invoice = await sattleme.createInvoice({
      ref: order.ref, // "ORD-1042": the order's reference, its sale in the merchant's app
      sats: "49000", // or: fiat: { amount: "24.50", currency: "CHF" }
      durationSeconds: 900, // 60 to 3600
      note: `Order ${order.number}` // shown to the merchant, 100 characters at most
    });
  } catch (error) {
    // An invoice of this order may still be paid (say, after a crash): keep that one. It is the
    // registry's copy: the same fields, without `rate`.
    if (!(error instanceof InvoicePendingError)) throw error;
    order.invoice = error.invoice;
  }
  await db.save(order);
  return order.invoice;
}

// The payment page gets the invoice alone: { paymentUri: "bitcoin:bc1p…?amount=…&lightning=lnbc…",
// expiresAt: 1791378900 }. When it asks for the order's status (every 1 to 2 seconds):
async function statusOf(order: Order) {
  const status = await sattleme.getStatus(order.invoice);
  if (status.state === "paid") {
    // In Lightning: keep the preimage, the proof of payment. On-chain: the transactions. Mixed
    // (on-chain, its rest in Lightning): both.
    await db.markPaid(order, status);
  } else if (status.state === "expired") {
    // Never paid: the order may get a new invoice. `received` above "0": an on-chain
    // underpayment the merchant received, to settle with the customer. One exception (SPEC.md §3):
    // an order the merchant accepted in its app may read `expired` when a relay that holds that
    // acceptance fails, then `paid` at a later check: settle such an order by hand.
    order.invoice = null;
    await db.save(order);
  }
  return status.state; // "open" | "unconfirmed" | "paid" | "expired"
}
```

`createInvoice` gives a plain JSON object to store with the order:

```ts
{
  ref: "ORD-1042",
  bolt11: "lnbc490u1p…", // the BOLT11 invoice; null for an order paid on-chain only
  paymentHash: "9c41…",
  verifyUrl: "https://breez.tips/lnurlp/verify/9c41…",
  onchainAddress: "bc1p…", // the deposit address it leased, or null (Lightning only)
  paymentUri: "bitcoin:bc1p…?amount=0.00049&lightning=lnbc490u1p…", // one QR code for both
  sats: "49000",
  fiat: null, // or { amount: "24.50", currency: "CHF", minor: "2450", digits: 2 }
  rate: null, // or { source: "coingecko", currency: "CHF", price: "69012", fetchedAt, time }
  note: "Order 1042",
  createdAt: 1791378000, // Unix seconds
  expiresAt: 1791378900,
  checkoutUrl: null, // a checkout link, with checkout: true
  redirectUrl: null
}
```

Every amount is a string of digits, every date an integer of Unix seconds, an absent value `null`:
the object is JSON as is, and an implementation in another language reads it.

**Stored invoices are your shop's.** Check only the invoices your shop stored itself with their
orders, where only it writes (its database), never one that comes from the customer (a form field,
a URL, a cookie): `getStatus` checks that a stored invoice is well formed (SPEC.md §22), never that
this integration made it. An invoice someone else wrote, with a Lightning invoice of their own that
they paid, reads as `paid` (SPEC.md §27).

Instead of polling from your page's requests, a background job may wait for the payment:

```ts
const final = await sattleme.waitForPayment(order.invoice, {
  intervalMs: 2000,
  signal, // an AbortSignal: stop waiting
  onStatus: (status) => console.log(status.state)
});
// final: { state: "paid", method: "lightning", preimage } |
//        { state: "paid", method: "onchain", received, txids } |
//        { state: "paid", method: "mixed", received, txids, preimages } | { state: "expired", received }
```

An `expired` status with `received` above "0" is final but in one case: the merchant's acceptance
of the order, when a relay that holds it failed ([On-chain payments](#on-chain-payments)).

A network failure only delays the next check. One that each check meets again (the explorer or the
Lightning address that does not answer…) is reported to your `logger` once, and again only after
it stopped.

### One order, one invoice at a time

- An order keeps its invoice until it has **expired**: `getStatus` says `expired` 120 seconds
  after the invoice's end (a payment of its last seconds may be reported that late). Only then may
  the order get a new invoice (but see the merchant's acceptance, [below](#on-chain-payments): an
  order it accepted may be paid after it read `expired`). `createInvoice` checks it in the
  merchant's registry and throws
  `InvoicePendingError` (with that invoice) while an earlier invoice of the same `ref` may still be
  paid (or its on-chain payment is being confirmed), or `OrderPaidError` (with its `status`, and
  the `preimage` of a Lightning payment) when one was paid.
- Only the order that holds an invoice is marked paid with it, in the database transaction that
  marks it paid. Keep the `preimage` (the proof of a Lightning payment) or the `txids` (of an
  on-chain one) and the `rate` the amount was converted at, to answer a customer or an audit.
- Invoices of the same `ref` are one sale in the merchant's app. One order, one `ref`: never
  reused for another order by anything that holds the key (a test copy of the shop, a restored
  database included), and never taken from what the customer sends (make it on your server).
- After a failure, `findInvoices(ref)` lists the invoices declared for an order, from the
  merchant's registry.
- "One at a time" holds within one `Sattleme` and against the registry: when several
  processes may make the invoice of the same order at once, lock the order (in your database)
  around `createInvoice`.

### Showing the invoice

This package is for servers only. The shop's page shows the invoice with its own code:

- a QR code of `paymentUri`, with any QR library: `bitcoin:<address>?amount=…&lightning=<bolt11>`
  with an address (BIP-21, the "unified QR" wallets read: they pay in Lightning or on-chain),
  `lightning:<bolt11>` without one;
- an "Open in wallet" link to the same URI;
- the time left until `expiresAt`, then the status your server gives (`open`, `unconfirmed`,
  `paid`, `expired`). With an on-chain underpayment, `open` carries what was `received` and its
  `rest`: show its `paymentUri` as the QR code (the rest in Lightning, and on-chain to the same
  address from 1 000 sats), until `expiresAt`.

The page talks to your server only: never give it the key, nor ask it to reach breez.tips or the
relays. Or send the customer to a checkout link instead (below).

## Checkout links

Instead of showing the invoice on your page, you may send the customer to a page of the merchant's
sattle.me web app made for this invoice: its QR code, a button that opens the customer's
wallet, the time left, then "Paid" or "Expired". Once the invoice is paid, the page sends the
customer back to your `redirectUrl`, 7 seconds later or at once with a tap.

```ts
const invoice = await sattleme.createInvoice({
  ref: "ORD-1042",
  fiat: { amount: "24.50", currency: "CHF" },
  note: "Order 1042", // shown to the customer too
  checkout: true,
  redirectUrl: "https://shop.example/orders/1042/thanks" // or "myshop://orders/1042"
});
// Store it with the order, then redirect the customer's browser to invoice.checkoutUrl:
// "https://…/pay#c.…" (nothing after "#" is ever sent to the web app's host).
```

- **Optional, per order.** Without `checkout: true`, nothing changes. `redirectUrl` alone is
  refused (`InvalidOrderError`, `param: "redirectUrl"`); without one, the page shows the receipt and
  sends the customer nowhere.
- **Not a proof of payment.** Anyone can open your redirect URL. When the customer arrives there,
  check the order with `getStatus(invoice)` (or `waitForPayment`) on your server, and mark it paid
  only then, as without checkout.
- **What the page gets**: a record the package publishes on a majority of the merchant's relays,
  before the invoice is declared: the invoice, its verify URL, its deposit address (with its amount
  and dates), the business's name, the price, the note and your redirect URL. Never the key, the merchant's Lightning address nor its registry.
  It is signed by a key of that link alone, forgotten once it is published: nobody, you included,
  can change a link afterwards. Relays that honor NIP-40 drop it a week after the invoice's end.
- **The rest of an underpayment**: with an address, the record also carries the key and the public
  key with which the page reads the invoices of the rest your server asks for (On-chain payments,
  below): the page shows the rest's invoice as soon as a check of your server published it, so
  keep checking the payment while the customer pays (`waitForPayment`, or `getStatus` from your
  page's polling). Only the integration key signs them.
- **Who sees the customer**: the customer's browser loads the web app, reads the record from the
  merchant's relays and checks the payment with the merchant's Lightning address (breez.tips):
  they see its IP address, which they never do when your page shows the invoice.
- **Redirect URLs**: `https://` with a lowercase host name (no IP address, no `localhost` nor a
  name under it, no `user:password@`), or an app's link (`myshop://…`), 2048 characters at most, every character of
  RFC 3986 (anything else percent-encoded, host names in punycode). Refused: `http:`, browser and
  file schemes, other browsers' schemes (`x-safari-https:`, `googlechrome:`, `firefox:`…, which
  would open a web page whose host the page cannot show: a web page is an `https` URL),
  `intent:`, payment schemes (`lightning:`, `bitcoin:`…), calls and messages. The page shows
  "Redirecting to shop.example" (or "myshop://") on its button. Prefer universal links (iOS) and
  App Links (Android), which are `https` URLs: browsers do not open an app on their own after a
  delay (Chrome on Android refuses it), so for an app's link the customer taps the button.
- **One order, one invoice at a time** holds with checkout links too. When an invoice of the
  order may still be paid, `InvoicePendingError` carries, with `checkout: true`, a new link to it:
  `error.checkoutUrl`. Send the customer there.
- **Availability**: the merchant's app says in the integration's channel where its web app is.
  An app without a web app gives none: `createInvoice` with `checkout: true` throws
  `CheckoutUnavailableError`; show the invoice on your page instead.

## On-chain payments

From 1 000 sats, an order may also be paid on-chain, to a deposit address of the merchant's
wallet. Nothing to ask for: `createInvoice` leases an address when the amount allows it, and the
Invoice's `paymentUri` shows both methods in one QR code.

| Amount                                          | Methods                                                      |
| ----------------------------------------------- | ------------------------------------------------------------ |
| below 1 000 sats                                | Lightning (outside its bounds: `InvalidOrderError`)          |
| 1 000 sats or more, within the Lightning bounds | Lightning and on-chain (Lightning only without an address)   |
| 1 000 sats or more, outside them                | on-chain only (`OnchainUnavailableError` without an address) |

- **The lot**: your server has no wallet and makes no address. The merchant's app gives the
  integration a lot of up to 100 taproot addresses (`bc1p…`) of its wallet, and fills it again
  whenever the merchant opens the app. `merchant().onchainAddresses` says how many it holds (0:
  no on-chain payment yet).
- **One address, one order**: an order leases an address in the merchant's registry until its
  invoice's end plus 120 seconds; two servers never keep the same one. The lease is published, read
  again on every relay of the merchant (it is confirmed when no other order holds the address),
  then marked confirmed: only then is the address the order's. An address the explorer shows paid
  already, or that a witness (below) names, is skipped.
- **Unconfirmed, then paid**: `getStatus` says `unconfirmed` once enough was sent in time, then
  `paid` (`method: "onchain"`) at 3 confirmations on the explorer (mempool.space, or the merchant's
  Bitcoin node): about 30 minutes. Ship the order only once it is `paid`. `waitForPayment` watches
  the address on the explorer's WebSocket meanwhile; a server that cannot wait that long
  checks again later with `getStatus` (`createInvoice` for the same `ref` throws
  `InvoicePendingError` while it is being confirmed).
- **In time**: a transaction counts for the order when it came while the lease ran. The package
  records each transaction it sees in the merchant's registry (a witness), so that the merchant's
  app tells the same order paid: check the payment while the customer pays (your page's polling,
  or `waitForPayment`), until the invoice's end and its 120 seconds. A transaction no check saw by
  then is told by BlockCypher's time; one received after the end is late: it reaches the merchant,
  but pays no order. A replacement (RBF, a fee bump) of a payment in time counts for it. A
  transaction counts for one invoice at most: one that a witness of another invoice names counts
  for nothing here.
- **Underpaid**: `received` is what came in time. Below the amount (and unless the merchant's
  tolerance or acceptance, below, accepted it), the invoice stays `open` until its end, then
  `expired` with `received` above "0": the merchant received it, settle it with the customer. An
  overpayment is `paid`.
- **The merchant's tolerance**: the merchant may accept, in its app, an on-chain payment a little
  short of the amount (up to 10 %) as paying the order in full. An order keeps the tolerance of its
  creation, whatever the merchant sets later. A payment short by no more than it is
  `unconfirmed`, then `paid`, with `received` below the amount: ship the order as for any `paid`
  status. One short by more is underpaid: its whole rest is asked. The tolerance is the
  merchant's: the package never gives it to your server, nor to your customer; the page of a
  checkout link learns only that this payment counts (an acceptance record), and sends the
  customer back to your shop.
- **The merchant's acceptance**: the merchant may also accept, by hand in its app, what an order
  underpaid on-chain received as paying it in full: one short by more than its tolerance, which
  the merchant would rather settle at what came. Nothing to configure, nothing to call: every
  check (`getStatus`, `waitForPayment`, and `createInvoice`'s check of an order's earlier
  invoices) reads it on every relay of the merchant with the order's witnesses, and counts it only
  when a majority of those relays hold it. The order is then `unconfirmed`, then `paid`
  (`method: "onchain"`, or `"mixed"` with invoices of the rest), with `received` below the amount,
  as with the tolerance: ship it as for any `paid` status. `waitForPayment` sees it at its next
  check of the on-chain part (within 60 s), the `rest` still given until then. Only the merchant's
  team can make one: neither your server's key nor a customer can. The page of a checkout link
  learns of it as of the tolerance, through an acceptance record. The limit (SPEC.md §3, §27): a
  relay that holds the acceptance and fails at a check after the invoice's end may make that check
  give `expired`, and a later one `unconfirmed`, then `paid`: an order you cancelled then is
  settled by hand.
- **The rest, in Lightning**: the check that sees an underpayment (`getStatus`, `waitForPayment`)
  asks the merchant's Lightning address for an invoice of the rest, until the invoice's end,
  declares it in the merchant's registry and publishes it for the order's checkout links, whose
  page shows it at once. `open` carries it in `rest`:

  ```ts
  {
    state: "open",
    expiresAt: 1791378900,
    received: "20000", // what came in time
    rest: {
      sats: "29000", // what is left
      bolt11: "lnbc290u1p…", // its invoice; null while there is none (asked at the next check)
      paymentUri: "bitcoin:bc1p…?amount=0.00029&lightning=lnbc290u1p…" // one QR code
    }
  }
  ```

  From 1 000 sats the rest is payable on-chain to the same address too; below, in Lightning only
  (`paymentUri` is `lightning:…`, or null while its invoice is asked). No invoice of the rest is
  asked with less than a minute left, nor outside the Lightning address's bounds; a failure is
  logged as a warning, never thrown: the next check asks again. Once the rest is paid, the order
  is `unconfirmed` until its on-chain part is 3 confirmations deep, then `paid` with
  `method: "mixed"`: keep its `txids` and the `preimages` of the invoices of the rest.

- **Who sees what**: the explorer (mempool.space, or the merchant's Bitcoin node, and
  mempool.space too when the node fails and its fallback allows it) sees your server's IP address
  and the addresses and transactions it asks about or watches; BlockCypher, a transaction no check
  saw in time. Never a key. A payment counts as made on what that one explorer shows.

### The merchant's Bitcoin node

The merchant may have the blockchain read from a node of its own that serves mempool.space's API
(an Umbrel, a server of its own) rather than from mempool.space. It sets it in its app, which
writes it in the integration's channel: nothing to configure on your server. Every call reads it
with the channel; every read of an address and of the chain's height (when an address is leased,
at each check), and `waitForPayment`'s WebSocket, then go to the node: `http://192.168.1.10:3006`
is read at `http://192.168.1.10:3006/api` and `ws://192.168.1.10:3006/api/v1/ws` (`wss://` for an
`https://` node). BlockCypher and the `"mempool"` rate source stay mempool.space's and
BlockCypher's.

- **Its URL** follows a rule of its own (SPEC.md §31): `https`, or `http` for a host of a local
  network only (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, a name under `.local`);
  an IPv4 address or a name, never `localhost`, 127.0.0.0/8 nor 0.0.0.0/8; no user name, query nor
  fragment. A node the channel names in any other way, or with an invalid `fallback` or `payers`,
  is none: mempool.space is read, and the channel stays valid.
- **Its `fallback`**, when the node does not answer a read (no answer, an error status, a redirect,
  an answer out of format):
  - `"mempool"`: the same read of mempool.space, `network` when both fail. A node that failed less
    than 60 s ago in the same call (`createInvoice`, `getStatus`, one `waitForPayment`) is asked
    after mempool.space, so that a node that is down does not make each read wait for its timeout.
    The WebSocket goes to mempool.space's when the node's fails.
  - `"none"`: mempool.space is never asked. While the node does not answer, no address is leased
    (`createInvoice` gives a Lightning invoice only, or `NetworkError` for an order paid on-chain
    only) and every check of an order with an address is `NetworkError`: never `expired` nor final
    underpaid for want of an answer. The order waits until the node answers again.

  A check's two reads (the address's transactions and the chain's height) always come from one
  explorer: when the node fails either, both are asked of mempool.space.

- **A node on the merchant's network** (`http://192.168.1.10:3006`, `http://umbrel.local`) is
  reachable only by a server on that network: a shop the merchant hosts itself, or one that
  joined it (by Tailscale, for one). Any other server fails every read of it, and its fallback
  applies: with `"none"`, no on-chain payment at all.
- **`payers`**: with `true` (only for a node of the Internet: `https` and a name, not under
  `.local`), the checkout links' records name the node (its `url` and `fallback`, never `payers`),
  and their page reads the chain from it too, with the same fallback; the node then sees the
  customer's IP address and the address the page follows, and whoever holds a link reads the
  node's URL. With `false`, only your server reads the node, and the page reads mempool.space.
- **Security**: a node's URL is the merchant's choice, and the package follows a valid one: GET
  requests at the paths of mempool.space's API under `/api`, and the WebSocket's two messages,
  in clear HTTP too to a host of a local network, and to an IPv4 address. Nothing is sent but
  deposit addresses, no redirect is followed, and every answer is bounded and checked. But if your
  server holds the keys of several merchants (a shared host), one merchant could so have it ask
  machines of your own network: restrict what your server can reach to public addresses (see
  [Outbound requests](#outbound-requests)); such a merchant's node is then unreachable, and its
  fallback applies. The node is trusted as mempool.space is: what it shows decides whether an
  order is paid. Over `http`, whoever is on the network between your server and the node can
  change its answers: it is as safe as that network.

## Prices in a currency

Give `fiat` instead of `sats`: the package converts the price to sats on your server, at the rate
of a price source, and declares the price to the merchant's app, which shows it. Nothing to set
up: without `rateSource`, it asks the default list of sources (below).

```ts
const invoice = await sattleme.createInvoice({
  ref: "ORD-1043",
  fiat: { amount: "24.50", currency: "CHF" } // a string: never a float
});
// 24.50 CHF at 69 012 CHF/BTC: ⌈2450 × 10^8 / 6 901 200⌉ = 35 502 sats
```

- `currency` is an ISO 4217 code in upper case, of the ISO 4217 currencies (List One, without
  funds, metals and test codes). `amount` is a string of digits with at most the currency's
  decimals (2 for CHF, 0 for JPY, 3 for KWD): those the merchant's app uses, from the package's own
  table, never from the platform's locale data. `currencyDigits("CHF")` gives them (null for a code
  that is not one).
- The conversion is exact, on integers: the price of one bitcoin is read as the decimal its source
  wrote, and the sats are **rounded up** to the next whole sat, so that the merchant never
  receives less than the price.
- The sats must fit the bounds of the merchant's Lightning address (`merchant()`), as for an
  amount in sats.

### Rate sources

`rateSource` is optional. Without it, the package asks these sources **one after the other**, the
next one only when the previous one does not answer, gives no usable price, or has no price in the
currency (`DEFAULT_RATE_SOURCES`):

`"coingecko"`, then `"mempool"`, `"coinbase"`, `"kraken"` and `"opennode"`.

The dated sources come first (a dated price is checked for its age), then the undated ones. The
first usable price is the rate, and `invoice.rate.source` names the source that gave it. Each
source that failed before it is reported to your `logger` as a warning.

To choose, give `rateSource` to the client or to an order (an order's wins):

```ts
new Sattleme({ key, rateSource: "kraken" }); // this source only: no other is asked
new Sattleme({ key, rateSource: ["kraken", "coingecko"] }); // asked in this order
await sattleme.createInvoice({ ref, fiat, rateSource: ["mempool", "coinbase"] }); // this order only
```

A list holds sources (names or functions), at least one, no name twice; anything else throws
`InvalidOptionError` (`InvalidOrderError` for an order). Each source asked may take up to
`httpTimeoutMs`: a list of 5 sources that all fail to answer may take 5 times as long.

| Source        | Currencies                  | Dated | Notes                                                                                                                |
| ------------- | --------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- |
| `"coingecko"` | many                        | yes   | No key needed. Optional: a Demo key (`coingeckoApiKey`), sent to CoinGecko only. Without one, limited by IP.         |
| `"mempool"`   | USD EUR GBP CAD CHF AUD JPY | yes   |                                                                                                                      |
| `"coinbase"`  | many                        | no    | Prices are decimal strings, read as written.                                                                         |
| `"kraken"`    | Kraken's pairs              | no    | The last trade's price.                                                                                              |
| `"opennode"`  | ~140                        | no    |                                                                                                                      |
| a function    | yours                       | maybe | `async (currency, { signal }) => "69012.5"`, or `{ price, time }`. Never a number. `rate.source` is then `"custom"`. |

Any other source (a CoinGecko Pro key, your own mempool instance, several sources checked against
each other) is a function. It gives the price as a **string**, as its source wrote it: a number
may already have lost digits.

```ts
const sattleme = new Sattleme({
  key: process.env.SATTLEME_INTEGRATION_KEY!,
  rateSource: async (currency, { signal }) => {
    // Your service answers { "price": "69012.50", "time": 1791378000 }: the price as a string.
    const response = await fetch(`https://rates.example.ch/btc/${currency}`, { signal });
    if (response.status === 404) throw new UnsupportedCurrencyError(currency, "rates.example.ch");
    const { price, time } = (await response.json()) as { price: string; time: number };
    return { price, time };
  }
});
```

A price its source dates is refused when it is more than an hour old, or more than 5 minutes
ahead: the next source of the list is then asked. When no source gives a price, `createInvoice`
throws `UnsupportedCurrencyError` if none of them has the currency, else the last `RateError` (no
usable price) or `NetworkError` (no answer), both retryable. Your function throws
`UnsupportedCurrencyError` when it has no price in a currency, `NetworkError` or `RateError` when it
cannot give one now: the next source is then asked. Any other error of yours becomes a
`RateError` (your error as its `cause`); an error of this package of another kind stops the list
and goes through as it is.

## Errors

Every error is a `SattlemeError` with a stable `code` and `retryable`, but for an aborted
call, which rejects with its signal's reason. None ever holds a secret: neither the key, nor a
sale's key, nor any key derived from them.

| Error                      | Code                   | When                                                                                                                                                   | Retry?           |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `InvalidKeyError`          | `invalid_key`          | The key is not an integration key (another prefix, damaged, an old `https://…/pay#…` link).                                                            | no               |
| `InvalidOptionError`       | `invalid_option`       | An option of the client or of `waitForPayment` is invalid: `error.param` names it.                                                                     | no               |
| `InvalidOrderError`        | `invalid_order`        | A parameter is invalid: `error.param` names it (`ref`, `sats`, `fiat`, `rateSource`, `durationSeconds`, `note`, `checkout`, `redirectUrl`, `invoice`). | no               |
| `RevokedError`             | `revoked`              | The merchant removed the integration.                                                                                                                  | no               |
| `ChannelNotFoundError`     | `channel_not_found`    | The relays answered without the integration's channel (`newerFormat`: update the package).                                                             | when not newer   |
| `NetworkError`             | `network`              | A relay, breez.tips, a rate source or the explorer did not answer, or fewer than a majority of the merchant's relays took a record.                    | yes              |
| `InvalidInvoiceError`      | `invalid_invoice`      | An invoice or a payment answer failed the checks. Never show such an invoice.                                                                          | no               |
| `InvoicePendingError`      | `invoice_pending`      | An earlier invoice of this order may still be paid, or is being confirmed on-chain: `error.invoice` (and `error.checkoutUrl` with `checkout: true`).   | after it expires |
| `OrderPaidError`           | `order_paid`           | An earlier invoice of this order was paid: `error.invoice`, `error.status`, `error.preimage` (null on-chain).                                          | no               |
| `UnsupportedCurrencyError` | `unsupported_currency` | The rate source has no price in this currency.                                                                                                         | no               |
| `RateError`                | `rate`                 | No usable price: invalid, too old, or your rate function failed.                                                                                       | yes              |
| `CheckoutUnavailableError` | `checkout_unavailable` | `checkout: true`, and the merchant's app gives no web app for checkout links.                                                                          | no               |
| `OnchainUnavailableError`  | `onchain_unavailable`  | The order can only be paid on-chain, and no address of the integration's lot could be leased.                                                          | yes              |

## What `createInvoice` does

1. Reads the integration's channel on the Nostr relays of the key (signed by the merchant's team,
   following up to 3 moves of the merchant's relays): the merchant's Lightning address, registry
   and relays, or `removed`. At every call: a removal stops the next invoice.
2. Checks that no earlier invoice of the order may still be paid (its payment checked: one already
   paid is never handed out again, `OrderPaidError`; one underpaid on-chain gets the invoice of its
   rest, as with `getStatus`, before `InvoicePendingError`). Meanwhile, reads the Lightning address
   and, for a price in a currency, the rate.
3. Converts the price to sats, when it is in a currency; its methods follow from the amount.
4. With Lightning, asks the merchant's Lightning address for the invoice (LUD-06/16), and checks
   it: Bitcoin mainnet, exactly the amount, the merchant's description hash, a verify URL (LUD-21)
   on the same host and port, no longer than asked, dated within 5 minutes.
5. With on-chain, leases an address of the integration's lot: publishes the lease on a majority
   of the merchant's relays, reads the address's leases again on every relay to confirm it, then
   marks it confirmed. A lease that was not confirmed is withdrawn, and the next address is tried.
   Without an address, Lightning only (or `OnchainUnavailableError`).
6. With `checkout: true`, publishes its checkout link on a majority of the merchant's relays.
   Without a majority, no invoice (nothing is declared).
7. With Lightning, declares it in the merchant's registry, on a majority of the merchant's relays:
   so that its payment counts for this order's sale and for no other. Without a majority, no
   invoice.

A confirmed lease is never withdrawn, whatever fails after it (its mark, the link, the
declaration): it holds its address until its end, and the order's next `createInvoice` may hand
its invoice out (`InvoicePendingError`).

`getStatus` asks the invoice's verify URL (LUD-21) and accepts a Lightning payment only with the
preimage of its payment hash, in an answer about this very invoice; with an address, it asks the
explorer at the same time and reads the witnesses of the order (see
[On-chain payments](#on-chain-payments)).

A call opens one connection per relay, used for all it reads and writes there, and closes them
when it is done. Reads and writes go on as soon as a majority of the relays answered (each
declaration is on a majority of them, and any two majorities share a relay): a slow or down relay
slows nothing. Three reads decide that a record is nobody else's and wait for every relay instead,
up to `relayTimeoutMs` after a majority answered: a lease's confirmation, the witnesses read again
after one is published, and the choice among several invoices of an order that may still be paid.
So does the read of the merchant's acceptance, which counts it only when a majority of the relays
hold it. A relay that failed earlier in the call is not waited for again. A write to the relays
past the majority goes on in the background, for `relayTimeoutMs` at most, then its connection
closes: a process that waits for its event loop to empty exits then.

HTTP requests (the merchant's Bitcoin node's included) follow no redirect, read at most 1 MiB of
an answer, and carry `User-Agent: sattleme-Checkout/1`, the same in every implementation of the
specification. The WebSocket handshake (of the relays and of the explorer) follows no redirect
either, carries the same User-Agent (relays behind a bot protection refuse a handshake without
one), and offers no compression. Of what a relay sends, a read keeps only what opens with its keys and, for a signed record, whose signature
checks out, once per event and without the members a relay may add to it (of a lease, only its id,
author, date, signature and end; of any other event, its id and its date): a relay cannot make the
server's memory grow.

## Outbound requests

Besides fixed hosts (the rate sources, mempool.space, BlockCypher), your server asks hosts that
others choose: the merchant's Lightning address and its provider (breez.tips), the merchant's
relays, and the merchant's Bitcoin node when its app names one. Their URLs are checked first:
`https` or `wss` only, no IP address, no `localhost` nor a name under it, no redirect followed;
but for the node, whose URL allows `http` to a host of a local network and an IPv4 address
([The merchant's Bitcoin node](#the-merchants-bitcoin-node)), never `localhost`. A name may still lead into your own network (an internal name, a public
name resolving to a private address), and the package does not resolve names itself (a name that
resolves again would bypass such a check). If your server holds the keys of several merchants, or
sits in a network with services of its own, restrict what it can reach to public addresses: in
your network (an egress proxy, a firewall), or in the `fetch` and `WebSocket` you give the client
(a merchant's node on a private address is then unreachable, and its fallback applies).

## Limits

- One hour at most per invoice; on-chain, about 30 minutes more to be `paid` (3 confirmations).
- Not measured: the limits of breez.tips, of mempool.space and of the relays for a shop that makes
  many invoices from one IP address. BlockCypher takes 100 requests an hour from an IP address
  without a token: it is asked only about a transaction no check saw while its lease ran.

Not in this version: refunds, webhooks, and showing open (unpaid) invoices in the merchant's app.

## Cryptography

Keys, BIP-340 signatures and the ECDH of NIP-44 are computed by `@noble/curves` 2.4.0, hashes and
HKDF by `@noble/hashes`, ChaCha20 by `@noble/ciphers`: JavaScript libraries without native code,
audited by independent security firms (their READMEs list the audits). `@noble/curves` aims at
algorithmic constant time: a multiplication by a secret scalar (signing, a public key, ECDH) runs
the same sequence of point operations whatever the scalar, scans its tables without branching on
it, and blinds the scalar with random bits first. In JavaScript the JIT compiler and the garbage
collector rule out a guarantee of constant time, as that README says ("Constant-timeness"). MACs
are compared in constant time (SPEC.md §27), and random bytes come from `crypto.getRandomValues`.

## Options

```ts
new Sattleme({
  key, // required
  rateSource, // optional: a source or a list of them (a name or a function); the default list
  coingeckoApiKey, // optional: CoinGecko's Demo key (visible ASCII), sent to CoinGecko only
  fetch, // the fetch implementation (global fetch by default)
  WebSocket, // the WebSocket class for the relays and the explorer (the `ws` package's by default)
  relayTimeoutMs: 10_000, // per relay request, connection included: 100 to 60 000
  httpTimeoutMs: 10_000, // per HTTP request, body included: 100 to 60 000
  logger: console // warnings only, never a secret
});
```

Every method takes `{ signal }`, an `AbortSignal`. An invalid option throws `InvalidOptionError`
at once. Once a call returned, nothing it started runs on: its reads end, and so do its HTTP
requests (the signal `fetch` gets with each aborts then); only a publication's relays past its
majority may still finish their own request, up to `relayTimeoutMs` (SPEC.md §13), with the
`WebSocket` class given.

## Other runtimes

Under Node, keep the default WebSocket (the `ws` package): it caps a relay's messages at 1 MiB and
bounds the handshake. Bun and Deno may pass their own:

```ts
new Sattleme({ key, WebSocket: globalThis.WebSocket });
```

## Other languages

The package's public API is `Sattleme`, its types and its errors: everything else is
internal. Implementations in other languages follow
[`SPEC.md`](https://github.com/sattleme/checkout-spec/blob/main/SPEC.md) and
pass its conformance vectors; the invoices they store are the same JSON.

## Development

```sh
npm ci
npm run check # the pinned specification, lint, format, typecheck, tests, build
```

The tests run local Nostr relays and fakes of breez.tips, of the rate sources, of the explorers
(mempool.space and a merchant's Bitcoin node, REST and WebSocket) and of BlockCypher: no network.

`spec/` is a copy of [sattleme/checkout-spec](https://github.com/sattleme/checkout-spec)
pinned to one commit (`spec/PIN.json`, checked file by file by `npm run spec:check` and the
tests), never edited here. Its vectors are what the tests check the package against: the
conformance vectors, the merchant's app's vectors (`spec/vectors/app/app.json`) and the vectors this
package makes for the app to read (`spec/vectors/app/implementation-declaration.json`,
`spec/vectors/app/checkout-link.json`, `spec/vectors/app/checkout-rest.json`). To change
the specification or a vector: in a clone of checkout-spec, on a branch, write `SPEC.md`, then make
the vectors on purpose with
`UPDATE_VECTORS=1 VECTORS_OUT=<clone> npx vitest run test/conformance.test.ts test/app-vector.test.ts test/checkout-vector.test.ts test/rest-vectors.test.ts test/checkout-rest-vector.test.ts`
(the expected values of the conformance vectors are written by hand in
`test/helpers/spec-vectors.ts` and `test/helpers/rest-vectors.ts`), open a pull request there, and once it is merged take that commit
here: `node scripts/spec.mjs import <clone>`.

Regenerate `package-lock.json` with npm 11 or later: npm 10.9 fails on Vite's optional peer
dependencies (`npm ci` with npm 10 works).

## License

[MIT](LICENSE)
