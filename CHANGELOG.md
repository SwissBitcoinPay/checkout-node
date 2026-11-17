# Changelog

All notable changes to `@sattleme/checkout`. Versions follow
[Semantic Versioning](https://semver.org/); tags are `vX.Y.Z`.

Released versions are staged on npm by CI and published once a maintainer approves them with
2FA (`npm stage approve`).

## 1.0.0

First version. Follows version 1.0.0 of the specification
([sattleme/checkout-spec](https://github.com/sattleme/checkout-spec)) and passes its
conformance vectors.

- **The client**, `Sattleme`: reads the integration key and the merchant (`merchant()`),
  makes the invoice of an order and declares it in the merchant's registry (`createInvoice()`),
  checks its payment (`getStatus()`, `waitForPayment()`), finds the invoices of an order again
  (`findInvoices()`). Made for a server that lives for one call: nothing is kept between calls.
- **One order, one invoice at a time**, checked against the registry (`InvoicePendingError`,
  `OrderPaidError`): the payment of an invoice that may still be paid is checked first, even when
  it is the only one, so that an invoice already paid is never handed out again; of several, the
  one a majority of the relays holds is handed out.
- **Orders in sats or in a currency** (the ISO 4217 currencies), converted exactly and rounded up
  to the sat, at the price of a list of rate sources asked in turn: CoinGecko, mempool.space,
  Coinbase, Kraken, OpenNode, or your own.
- **Lightning payments**: an invoice from the merchant's Lightning address (LUD-16, LUD-21 verify
  URL).
- **On-chain payments**: from 1 000 sats, a taproot deposit address of the merchant's wallet leased
  for the order, with a single `bitcoin:` QR code (`paymentUri`). A lease is published
  unconfirmed, read again on every relay of the merchant, then marked confirmed: only a confirmed
  lease gives the order its address, and no order leases an address another order holds or a
  witness names. Payment checked on one explorer (paid at 3 confirmations), with fee bumps (RBF)
  and the `unconfirmed` state; `waitForPayment` watches the address on the explorer's WebSocket.
- **The merchant's Bitcoin node**: the explorer is mempool.space, or the node the integration's
  channel names (`bitcoinNode`: its URL, `http` allowed for a local network, its `fallback`
  `"mempool"` or `"none"`, and `payers`), read over REST and WebSocket with its fallback, a node
  that failed less than 60 s ago in the same call being asked after mempool.space; with `"none"`,
  mempool.space is never asked, and a node that does not answer leases no address and gives
  `network`, never `expired`. With `payers` `true`, the checkout links' records name the node,
  whose page then reads it too. An invalid `bitcoinNode` is none.
- **Witnesses** of the transactions each check sees, which name the invoice they are of: a
  transaction a witness of another invoice names counts for nothing.
- **The rest of an on-chain underpayment**, payable in Lightning (and on-chain from 1 000 sats),
  shown on the order's checkout links; an order paid both ways is `paid` with `method: "mixed"`.
- **The merchant's tolerance of on-chain underpayments** (0 to 10 %), read in the integration's
  channel and kept in the lease of each order's address.
- **The merchant's acceptance** of an order underpaid on-chain at what it received, made by the
  merchant in its app: read by every check on every relay of the merchant, and counted only when a
  majority of them hold it; the order is then paid with `received` below its amount. A relay that
  holds it and fails at a check after the invoice's end may make that check give `expired`, and a
  later one `paid` (SPEC.md §3).
- **Checkout links**: `createInvoice({ …, checkout: true, redirectUrl })` gives a `checkoutUrl`,
  a page of the merchant's web app where the customer pays, then is sent to `redirectUrl`.
- **Outbound requests**: https URLs only (a lowercase host name, no IP address, no host under
  `localhost`), but for the merchant's Bitcoin node (`http` to a local network, an IPv4 address,
  never `localhost`), no redirect followed, at most 1 MiB read of an answer, and
  `User-Agent: sattleme-Checkout/1`. The relays' WebSocket handshake follows no redirect, carries
  the same User-Agent and offers no compression; a read keeps only what opens with its keys, once
  per event, so a relay cannot make the server's memory grow.
- **Typed errors** with a stable `code` and whether they are retryable.
